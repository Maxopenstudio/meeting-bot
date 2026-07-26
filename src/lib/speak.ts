import axios from 'axios';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../config';

/**
 * Make the bot speak in the meeting: fetch synthesized audio from TalkBase
 * (grok-voice-tts) and play it into the virtual microphone PulseAudio sink,
 * which Chrome uses as its mic input — so participants hear it.
 *
 * Requires: the botmic null-sink loaded (start.sh) and the bot joined WITH the
 * microphone enabled (voice mode). No-op-safe: logs and returns on any failure.
 */
export async function speak(text: string, opts: { voice?: string; cacheable?: boolean } = {}): Promise<boolean> {
  if (!text || !text.trim()) return false;
  const audio = await fetchTts(text, opts);
  if (!audio) return false;
  return playBuffer(audio);
}

/**
 * Speak a longer answer with sentence-level pipelining: synthesize the FIRST
 * sentence and start playing it immediately while the rest of the answer is
 * synthesized in the background. Cuts first-audio latency from TTS(whole
 * answer) — 3-5s on grok — down to TTS(first sentence).
 */
export async function speakPipelined(text: string, opts: { voice?: string } = {}): Promise<boolean> {
  if (!text || !text.trim()) return false;
  const chunks = splitForTts(text);
  if (chunks.length <= 1) return speak(text, opts);

  let spoke = false;
  let next: Promise<Buffer | null> = fetchTts(chunks[0], opts);
  for (let i = 0; i < chunks.length; i++) {
    const audio = await next;
    if (i + 1 < chunks.length) next = fetchTts(chunks[i + 1], opts); // prefetch while we play
    if (audio && (await playBuffer(audio))) spoke = true;
  }
  return spoke;
}

/**
 * Sentence-ish chunks for pipelined TTS. The first chunk is a single sentence
 * (smallest possible first-audio latency); the rest are merged to ~120 chars so
 * we don't spam the TTS API with tiny fragments.
 */
function splitForTts(text: string): string[] {
  const sentences = text.trim().split(/(?<=[.!?…])\s+/u).filter((s) => s.trim());
  if (sentences.length <= 1) return sentences;

  const chunks: string[] = [sentences[0]];
  let cur = '';
  for (const s of sentences.slice(1)) {
    cur = cur ? `${cur} ${s}` : s;
    if (cur.length >= 120) {
      chunks.push(cur);
      cur = '';
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function fetchTts(text: string, opts: { voice?: string; cacheable?: boolean }): Promise<Buffer | null> {
  const base = config.talkbaseApiBase;
  const key = config.internalApiKey;
  if (!base || !key) {
    console.warn('[speak] TALKBASE_API_BASE / INTERNAL_API_KEY not configured — cannot fetch TTS');
    return null;
  }
  try {
    const res = await axios.post(
      `${base}/api/bot/voice/tts`,
      { text, voice: opts.voice, cacheable: opts.cacheable ?? false },
      { headers: { 'X-Internal-API-Key': key }, responseType: 'arraybuffer', timeout: 30000 },
    );
    return Buffer.from(res.data);
  } catch (e: any) {
    console.error('[speak] TTS fetch failed:', e?.message || e);
    return null;
  }
}

async function playBuffer(audio: Buffer): Promise<boolean> {
  const tmp = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  fs.writeFileSync(tmp, audio);
  try {
    await playToMic(tmp);
    return true;
  } catch (e: any) {
    console.error('[speak] playback failed:', e?.message || e);
    return false;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

/**
 * Decode the mp3 and stream PCM into the botmic sink via ffmpeg → pacat.
 * (paplay can't read mp3 directly; ffmpeg decodes to s16le and pacat writes it
 * to the sink whose monitor Chrome reads as the microphone.)
 */
function playToMic(mp3Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sink = config.botMicSink;
    // ffmpeg mp3 → raw s16le 48k mono → pacat into the sink.
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', mp3Path, '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1']);
    const pacat = spawn('pacat', ['--playback', `--device=${sink}`, '--rate=48000', '--channels=1', '--format=s16le']);

    ff.stdout.pipe(pacat.stdin);

    let err = '';
    ff.stderr.on('data', (d) => (err += d.toString()));
    pacat.stderr.on('data', (d) => (err += d.toString()));

    pacat.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pacat exit ${code}: ${err.slice(-300)}`));
    });
    ff.on('error', reject);
    pacat.on('error', reject);
  });
}
