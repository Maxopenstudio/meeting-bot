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
  const base = config.talkbaseApiBase;
  const key = config.internalApiKey;
  if (!base || !key) {
    console.warn('[speak] TALKBASE_API_BASE / INTERNAL_API_KEY not configured — cannot fetch TTS');
    return false;
  }
  if (!text || !text.trim()) return false;

  let audio: Buffer;
  try {
    const res = await axios.post(
      `${base}/api/bot/voice/tts`,
      { text, voice: opts.voice, cacheable: opts.cacheable ?? false },
      { headers: { 'X-Internal-API-Key': key }, responseType: 'arraybuffer', timeout: 30000 },
    );
    audio = Buffer.from(res.data);
  } catch (e: any) {
    console.error('[speak] TTS fetch failed:', e?.message || e);
    return false;
  }

  const tmp = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);
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
