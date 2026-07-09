import axios from 'axios';
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';
import config from '../config';
import { speak } from './speak';

/**
 * Voice agent wake-word listener (Phase 2). Captures the meeting audio from the
 * PulseAudio monitor, streams it to Soniox realtime STT, and when someone says
 * a wake phrase ("Эй, толкбейз …") asks TalkBase for a short answer and speaks
 * it back into the meeting.
 *
 * Meeting audio (others' voices) comes from virtual_output.monitor; the bot's
 * own speech goes to a different sink (botmic), and Meet doesn't echo your own
 * voice — so the bot won't trigger on itself. While it's speaking we also gate
 * the listener to be safe.
 */
export class VoiceListener {
  private ws: WebSocket | null = null;
  private parec: ChildProcess | null = null;
  private stopped = false;
  private speaking = false;
  private utterance = '';
  private lastLang: string | null = null;
  // Soniox often finalizes "Эй толкбейз" and the actual question as SEPARATE
  // utterances. After a bare wake word we open a short window during which the
  // next utterance is taken as the question (no wake word needed).
  private awaitingUntil = 0;
  private static readonly FOLLOWUP_WINDOW_MS = 12000;

  constructor(
    private readonly opts: {
      sessionId: string;
      projectId?: string;
      correlationId: string;
      sampleRate?: number;
      log: (msg: string, meta?: any) => void;
    },
  ) {}

  start(): void {
    if (!config.sonioxApiKey) {
      this.opts.log('[voice] SONIOX_API_KEY not set — wake-word listener disabled');
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    try { this.ws?.close(); } catch { /* noop */ }
    try { this.parec?.kill('SIGKILL'); } catch { /* noop */ }
    this.ws = null;
    this.parec = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const rate = this.opts.sampleRate ?? 16000;
    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
    this.ws = ws;

    ws.on('open', () => {
      this.opts.log('[voice] Soniox connected, streaming meeting audio');
      ws.send(JSON.stringify({
        api_key: config.sonioxApiKey,
        model: 'stt-rt-v4',
        audio_format: 'pcm_s16le',
        sample_rate: rate,
        num_channels: 1,
        language_hints: ['ru', 'uk', 'en'],
        enable_endpoint_detection: true,
        enable_language_identification: true,
      }));

      // parec captures the meeting audio (monitor of the default sink) as PCM.
      this.parec = spawn('parec', [
        `--device=${config.meetingAudioSource}`,
        '--format=s16le', `--rate=${rate}`, '--channels=1', '--raw',
      ]);
      this.parec.stdout?.on('data', (chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN && !this.speaking) ws.send(chunk);
      });
      this.parec.on('error', (e) => this.opts.log('[voice] parec error', { error: (e as Error).message }));
    });

    ws.on('message', (data) => this.onSoniox(data.toString()));
    ws.on('error', (e) => this.opts.log('[voice] Soniox ws error', { error: (e as Error).message }));
    ws.on('close', () => {
      try { this.parec?.kill('SIGKILL'); } catch { /* noop */ }
      this.parec = null;
      if (!this.stopped) {
        this.opts.log('[voice] Soniox closed — reconnecting in 2s');
        setTimeout(() => this.connect(), 2000);
      }
    });
  }

  private onSoniox(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg.tokens)) return;

    for (const token of msg.tokens) {
      const text: string = token.text ?? '';
      if (!text) continue;
      if (token.language) this.lastLang = token.language;

      // Soniox emits an endpoint marker (<end>) when a speaker finishes an
      // utterance — that's when we evaluate the wake phrase.
      if (text === '<end>' || text === '<fin>') {
        this.finalizeUtterance();
        continue;
      }
      if (token.is_final) this.utterance += text;
    }
  }

  private finalizeUtterance(): void {
    const utter = this.utterance.trim();
    this.utterance = '';
    if (!utter) return;

    const now = this.nowMs();
    const lower = utter.toLowerCase();
    const hit = config.wakeWords.map((w) => w.trim().toLowerCase()).find((w) => w && lower.includes(w));
    const lang = this.normalizeLang(this.lastLang);

    if (hit) {
      // Take the text AFTER the wake phrase as the question.
      const idx = lower.indexOf(hit);
      const question = utter.slice(idx + hit.length).replace(/^[\s,.:!?—-]+/, '').trim();
      this.opts.log('[voice] wake word detected', { question, lang });
      if (question) {
        this.awaitingUntil = 0;
        void this.handleQuestion(question, lang);
      } else {
        // Bare wake word — the question likely comes in the NEXT utterance.
        this.awaitingUntil = now + VoiceListener.FOLLOWUP_WINDOW_MS;
      }
      return;
    }

    // No wake word, but we're within the follow-up window → this utterance IS
    // the question the user asked right after saying the bot's name.
    if (this.awaitingUntil > now) {
      this.awaitingUntil = 0;
      this.opts.log('[voice] follow-up question', { question: utter, lang });
      void this.handleQuestion(utter, lang);
    }
  }

  private nowMs(): number {
    return Date.now();
  }

  private async handleQuestion(question: string, lang: string): Promise<void> {
    const base = config.talkbaseApiBase;
    const key = config.internalApiKey;
    if (!base || !key) return;
    try {
      // Phase 1: fast classify-or-answer. Backend either answers directly
      // (smalltalk/general) or tells us the question needs a data lookup.
      const res = await axios.post(
        `${base}/api/bot/voice/respond`,
        { utterance: question, language: lang, session_id: this.opts.sessionId },
        { headers: { 'X-Internal-API-Key': key }, timeout: 20000 },
      );
      const mode = res.data?.mode;
      const text = res.data?.text;

      if (mode === 'search') {
        // Speak the "минуточку" filler right away (cached TTS), then run the
        // slow RAG lookup and speak the real answer.
        if (text) await this.answerWith(text, lang, true);
        await this.askRag(question, lang);
        return;
      }

      if (text) await this.answerWith(text, lang, false);
    } catch (e: any) {
      this.opts.log('[voice] respond failed', { error: e?.message });
    }
  }

  /**
   * The complex-question path: TalkBase resolves our session → user + project,
   * runs RAG, and returns a short spoken answer. Longer timeout because the
   * pipeline does vector search + generation.
   */
  private async askRag(question: string, lang: string): Promise<void> {
    const base = config.talkbaseApiBase;
    const key = config.internalApiKey;
    if (!base || !key) return;
    try {
      const res = await axios.post(
        `${base}/api/bot/voice/ask`,
        { utterance: question, language: lang, session_id: this.opts.sessionId },
        { headers: { 'X-Internal-API-Key': key }, timeout: 60000 },
      );
      const text = res.data?.text;
      if (text) {
        this.opts.log('[voice] rag answer', { project: res.data?.project, chars: text.length });
        await this.answerWith(text, lang, false);
      }
    } catch (e: any) {
      this.opts.log('[voice] ask failed', { error: e?.message });
    }
  }

  private async answerWith(text: string, lang: string, cacheable: boolean): Promise<void> {
    this.speaking = true; // gate the mic/STT while the bot talks
    try {
      await speak(text, { cacheable });
    } finally {
      this.speaking = false;
      this.utterance = ''; // drop anything captured during our own speech
    }
  }

  private normalizeLang(l: string | null): string {
    if (!l) return 'ru';
    const s = l.toLowerCase();
    if (s.startsWith('uk')) return 'uk';
    if (s.startsWith('en')) return 'en';
    return 'ru';
  }
}
