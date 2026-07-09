import axios from 'axios';
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';
import config from '../config';
import { speak, speakPipelined } from './speak';

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
  // Don't answer the moment Soniox flags an endpoint — people pause mid-question
  // to think. Wait for TURN_PAUSE_MS of continued silence first; any new speech
  // cancels the pending finalize and the segments merge into one utterance.
  private finalizeTimer: NodeJS.Timeout | null = null;
  private static readonly TURN_PAUSE_MS = 1200;
  private tokensSeen = false;
  private tokenWatchdog: NodeJS.Timeout | null = null;

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
    if (this.tokenWatchdog) { clearTimeout(this.tokenWatchdog); this.tokenWatchdog = null; }
    if (this.finalizeTimer) { clearTimeout(this.finalizeTimer); this.finalizeTimer = null; }
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
      // The June deaf-session had an open ws and zero tokens for the whole
      // meeting with no trace in the logs. Flag that state loudly.
      this.tokensSeen = false;
      if (this.tokenWatchdog) clearTimeout(this.tokenWatchdog);
      this.tokenWatchdog = setTimeout(() => {
        if (!this.tokensSeen && !this.stopped) {
          this.opts.log('[voice] WARNING: no Soniox tokens 30s after connect — audio path or STT key may be broken');
        }
      }, 30000);
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
    if (msg.error_code || msg.error_message) {
      this.opts.log('[voice] Soniox error', { code: msg.error_code, message: msg.error_message });
      return;
    }
    if (!Array.isArray(msg.tokens)) return;
    if (msg.tokens.length > 0) this.tokensSeen = true;

    for (const token of msg.tokens) {
      const text: string = token.text ?? '';
      if (!text) continue;
      if (token.language) this.lastLang = token.language;

      // Soniox emits an endpoint marker (<end>) when a speaker pauses. Don't
      // finalize right away — give them TURN_PAUSE_MS to continue (dictating a
      // long question, thinking mid-sentence) before we treat it as done.
      if (text === '<end>' || text === '<fin>') {
        this.scheduleFinalize();
        continue;
      }
      // Fresh speech (even non-final) — the speaker isn't done, keep listening.
      if (this.finalizeTimer) {
        clearTimeout(this.finalizeTimer);
        this.finalizeTimer = null;
      }
      if (token.is_final) this.utterance += text;
    }
  }

  private scheduleFinalize(): void {
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      this.finalizeUtterance();
    }, VoiceListener.TURN_PAUSE_MS);
  }

  private finalizeUtterance(): void {
    const utter = this.utterance.trim();
    this.utterance = '';
    if (!utter) return;

    const now = this.nowMs();
    const lower = utter.toLowerCase();
    // Primary wake words (толкбейз/talkbase) match anywhere in the utterance.
    // Slang nicknames (братан, кентуха, Глэк, голова оранжевая) only count in
    // address position — within the first few characters — so the bot doesn't
    // hijack a «братан» said between people mid-conversation.
    const hit =
      config.wakeWords.map((w) => w.trim().toLowerCase()).find((w) => w && lower.includes(w))
      ?? config.nicknameWakeWords.map((w) => w.trim().toLowerCase()).find((w) => {
        if (!w) return false;
        const idx = lower.indexOf(w);
        return idx >= 0 && idx <= 12;
      });
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
        // Acknowledge instantly (cached TTS) so the user knows we heard them.
        // Deliberately NOT gated via answerWith: it's ~0.3s and our own voice
        // doesn't loop back, so we keep listening for the question meanwhile.
        this.awaitingUntil = now + VoiceListener.FOLLOWUP_WINDOW_MS;
        void speak(this.ackPhrase(lang), { cacheable: true });
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
    // The RAG pipeline regularly runs 1-3 minutes on long-context projects.
    // Keep the user informed with a cached "ещё секунду" every ~25s while we
    // wait, and don't give up before the answer has a real chance to arrive.
    const reassure = setInterval(() => {
      if (!this.speaking && !this.stopped) void speak(this.stillLooking(lang), { cacheable: true });
    }, 25000);
    try {
      const res = await axios.post(
        `${base}/api/bot/voice/ask`,
        { utterance: question, language: lang, session_id: this.opts.sessionId },
        { headers: { 'X-Internal-API-Key': key }, timeout: 180000 },
      );
      const text = res.data?.text;
      if (text) {
        this.opts.log('[voice] rag answer', { project: res.data?.project, chars: text.length });
        clearInterval(reassure);
        await this.answerWith(text, lang, false);
      }
    } catch (e: any) {
      this.opts.log('[voice] ask failed', { error: e?.message });
    } finally {
      clearInterval(reassure);
    }
  }

  /** Cached "still looking" reassurance while a slow RAG answer is in flight. */
  private stillLooking(lang: string): string {
    const phrases: Record<string, string> = { ru: 'Ещё секунду.', uk: 'Ще секунду.', en: 'One moment.' };
    return phrases[lang] ?? 'Ещё секунду.';
  }

  private async answerWith(text: string, lang: string, cacheable: boolean): Promise<void> {
    this.speaking = true; // gate the mic/STT while the bot talks
    try {
      // Cacheable = short filler (exact-text TTS cache hit). Real answers go
      // through the sentence pipeline: first sentence plays while the rest
      // synthesizes, cutting first-audio latency to TTS(one sentence).
      if (cacheable) await speak(text, { cacheable: true });
      else await speakPipelined(text);
    } finally {
      this.speaking = false;
      this.utterance = ''; // drop anything captured during our own speech
    }
  }

  /** Short "yes?" ack after a bare wake word, per language (pre-warmed in TTS cache). */
  private ackPhrase(lang: string): string {
    const acks: Record<string, string> = { ru: 'Да?', uk: 'Так?', en: 'Yes?' };
    return acks[lang] ?? 'Да?';
  }

  private normalizeLang(l: string | null): string {
    if (!l) return 'ru';
    const s = l.toLowerCase();
    if (s.startsWith('uk')) return 'uk';
    if (s.startsWith('en')) return 'en';
    return 'ru';
  }
}
