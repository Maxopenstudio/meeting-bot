/**
 * Speaker timeline — "who was talking when" recorded inside the Meet page.
 *
 * The recording is one mixed stream, so the backend's diarizer only knows
 * anonymous clusters (Speaker 0/1/…). This timeline lets it put real names on
 * them by time overlap. Two in-page signals:
 *
 *  - rtc: RTCRtpReceiver.getContributingSources() audio levels. Meet mixes
 *    remote audio into a few virtual tracks but keeps each participant as a
 *    CSRC, so this sees every speaker regardless of the tile layout. CSRCs are
 *    anonymous — they get names by voting against the dom signal.
 *  - dom: the "speaking" indicator inside [data-participant-id] tiles
 *    (obfuscated classes, config.meetSpeakingClasses). Named, but only for
 *    tiles on screen and breaks whenever Meet renames its classes.
 *
 * All times are epoch ms; the collector rebases them onto the recording start
 * (t0 = MediaRecorder.start), the same zero as the uploaded file.
 */

export type SpeakerSource = 'rtc' | 'dom';

export interface RawSpeakerInterval {
  key: string;
  name?: string;
  source: SpeakerSource;
  start: number;
  end: number;
}

export type SpeakerTrackerMessage =
  | { kind: 't0'; at: number }
  | { kind: 'intervals'; intervals: RawSpeakerInterval[] }
  | { kind: 'diag'; toggling: [string, number][]; tiles: number; rtcSources: number };

export interface SpeakerTimelineSegment {
  name: string;
  start_ms: number;
  end_ms: number;
  source: SpeakerSource;
}

export interface SpeakerTimelinePayload {
  version: 1;
  platform: 'google_meet';
  t0_epoch_ms: number;
  participants: string[];
  segments: SpeakerTimelineSegment[];
  stats: { rtc_sources: number; rtc_mapped: number; dom_names: number };
}

export interface SpeakerTrackerOptions {
  speakingClasses: string[];
  pollMs: number;
  // A speaker counts as stopped after this much continuous silence.
  hangMs: number;
  // Minimum CSRC audioLevel (0..1, linear) treated as speech.
  rtcLevel: number;
}

export const DEFAULT_TRACKER_OPTIONS: Omit<SpeakerTrackerOptions, 'speakingClasses'> = {
  pollMs: 250,
  hangMs: 1000,
  rtcLevel: 0.01,
};

/**
 * Runs in the page (page.addInitScript) BEFORE Meet's own scripts, so the
 * RTCPeerConnection wrapper sees every connection Meet opens. Closed intervals
 * are pushed to window.talkbaseSpeakerEvents once Node exposes it; until then
 * they stay buffered in the page (lobby time is clipped away by t0 anyway).
 */
export function speakerTrackerInit(opts: SpeakerTrackerOptions): void {
  const w = window as any;
  if (w.__tbSpeakers || window.top !== window) return;

  const pcs: any[] = [];
  const Orig = w.RTCPeerConnection;
  if (typeof Orig === 'function') {
    try {
      const Wrapped: any = function (this: any, ...args: any[]) {
        const pc = new Orig(...args);
        pcs.push(pc);
        return pc;
      };
      Wrapped.prototype = Orig.prototype;
      Object.setPrototypeOf(Wrapped, Orig);
      w.RTCPeerConnection = Wrapped;
      if (w.webkitRTCPeerConnection) w.webkitRTCPeerConnection = Wrapped;
    } catch (e) {
      console.warn('SpeakerTimeline: RTCPeerConnection wrap failed', e);
    }
  }

  const open = new Map<string, { name?: string; source: 'rtc' | 'dom'; start: number; last: number }>();
  const pending: any[] = [];
  const MAX_PENDING = 20000;
  const speakingSelector = opts.speakingClasses.map((c) => '.' + c).join(',');

  const isJunk = (t: string) =>
    /^[a-z0-9_]+$/.test(t) || /^\d+[:.]?\d*$/.test(t) || t.length < 2 || t.length > 60;
  const nameCache = new Map<string, { name: string | null; at: number }>();
  const tileName = (tile: HTMLElement, pid: string): string | null => {
    const cached = nameCache.get(pid);
    const now = Date.now();
    if (cached && now - cached.at < 5000) return cached.name;
    let name: string | null = null;
    const span = tile.querySelector('span.notranslate') as HTMLElement | null;
    const spanText = (span?.textContent ?? '').trim();
    if (spanText && !isJunk(spanText)) name = spanText;
    if (!name) {
      const lines = (tile.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      name = lines.find((l) => !isJunk(l)) ?? null;
    }
    nameCache.set(pid, { name, at: now });
    return name;
  };

  const closeInterval = (key: string, end: number) => {
    const iv = open.get(key);
    if (!iv) return;
    open.delete(key);
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push({ key, name: iv.name, source: iv.source, start: iv.start, end });
  };

  const mark = (key: string, source: 'rtc' | 'dom', now: number, name?: string) => {
    const iv = open.get(key);
    if (iv) {
      iv.last = now;
      if (name) iv.name = name;
    } else {
      open.set(key, { name, source, start: now, last: now });
    }
  };

  // Diagnostics: which descendant classes of tiles toggle over time. When Meet
  // renames its speaking classes, the new ones show up at the top of this list.
  const prevClasses = new Map<string, Set<string>>();
  let toggles = new Map<string, number>();
  let lastDiagAt = Date.now();
  let rtcSourcesSeen = new Set<string>();

  const tick = () => {
    const now = Date.now();
    const perfNow = performance.now();

    // rtc: per-participant CSRC audio levels.
    for (let i = pcs.length - 1; i >= 0; i--) {
      const pc = pcs[i];
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') {
        pcs.splice(i, 1);
        continue;
      }
      let receivers: any[] = [];
      try { receivers = pc.getReceivers(); } catch { continue; }
      for (const r of receivers) {
        if (r.track?.kind !== 'audio' || typeof r.getContributingSources !== 'function') continue;
        let sources: any[] = [];
        try { sources = r.getContributingSources(); } catch { continue; }
        for (const s of sources) {
          const ts = Number(s.timestamp ?? 0);
          const age = ts > 1e12 ? now - ts : perfNow - ts;
          const key = 'csrc:' + s.source;
          rtcSourcesSeen.add(key);
          if (age < opts.pollMs * 3 && Number(s.audioLevel ?? 0) >= opts.rtcLevel) {
            mark(key, 'rtc', now);
          }
        }
      }
    }

    // dom: speaking indicator inside participant tiles, keyed by display name.
    const tiles = document.querySelectorAll('[data-participant-id]');
    const seenPids = new Set<string>();
    tiles.forEach((el) => {
      const tile = el as HTMLElement;
      const pid = tile.getAttribute('data-participant-id') ?? '';
      if (!pid || seenPids.has(pid)) return;
      seenPids.add(pid);
      const name = tileName(tile, pid);
      if (name && speakingSelector && tile.querySelector(speakingSelector)) {
        mark('dom:' + name, 'dom', now, name);
      }

      const classes = new Set<string>();
      tile.querySelectorAll('[class]').forEach((d, idx) => {
        if (idx > 400) return;
        d.classList.forEach((c) => classes.add(c));
      });
      const prev = prevClasses.get(pid);
      if (prev) {
        classes.forEach((c) => { if (!prev.has(c)) toggles.set(c, (toggles.get(c) ?? 0) + 1); });
        prev.forEach((c) => { if (!classes.has(c)) toggles.set(c, (toggles.get(c) ?? 0) + 1); });
      }
      prevClasses.set(pid, classes);
    });

    // Close everything that has been silent longer than hangMs.
    open.forEach((iv, key) => {
      if (now - iv.last > opts.hangMs) closeInterval(key, iv.last + opts.pollMs);
    });

    if (now - lastDiagAt > 60000) {
      lastDiagAt = now;
      const top = Array.from(toggles.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15);
      send({ kind: 'diag', toggling: top, tiles: seenPids.size, rtcSources: rtcSourcesSeen.size });
      toggles = new Map();
      rtcSourcesSeen = new Set();
    }
  };

  const send = (msg: any) => {
    const fn = w.talkbaseSpeakerEvents;
    if (typeof fn !== 'function') return false;
    try { fn(msg); } catch { return false; }
    return true;
  };

  const flush = () => {
    if (!pending.length) return;
    if (typeof w.talkbaseSpeakerEvents !== 'function') return;
    const batch = pending.splice(0, pending.length);
    if (!send({ kind: 'intervals', intervals: batch })) pending.unshift(...batch);
  };

  setInterval(() => { try { tick(); } catch (e) { /* never break the page */ } }, opts.pollMs);
  setInterval(flush, 2000);

  w.__tbSpeakers = {
    markRecordingStart(at: number) { send({ kind: 't0', at }); },
    // Close every open interval and push the rest — called when recording stops.
    async flushNow() {
      const now = Date.now();
      Array.from(open.keys()).forEach((k) => closeInterval(k, now));
      if (!pending.length || typeof w.talkbaseSpeakerEvents !== 'function') return;
      const batch = pending.splice(0, pending.length);
      try { await w.talkbaseSpeakerEvents({ kind: 'intervals', intervals: batch }); } catch { /* page closing */ }
    },
  };
}

/** Node side: accumulates tracker messages and resolves the final timeline. */
export class SpeakerTimelineCollector {
  private t0?: number;
  private intervals: RawSpeakerInterval[] = [];
  private roster = new Set<string>();
  private static readonly MAX_INTERVALS = 100000;

  constructor(private readonly onDiag?: (d: Extract<SpeakerTrackerMessage, { kind: 'diag' }>) => void) {}

  handle(msg: SpeakerTrackerMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 't0' && typeof msg.at === 'number') {
      this.t0 = msg.at;
    } else if (msg.kind === 'intervals' && Array.isArray(msg.intervals)) {
      for (const iv of msg.intervals) {
        if (this.intervals.length >= SpeakerTimelineCollector.MAX_INTERVALS) break;
        if (typeof iv?.start === 'number' && typeof iv?.end === 'number' && iv.end > iv.start) {
          this.intervals.push(iv);
        }
      }
    } else if (msg.kind === 'diag') {
      this.onDiag?.(msg);
    }
  }

  addParticipants(names: string[]): void {
    for (const n of names) if (n) this.roster.add(n);
  }

  build(): SpeakerTimelinePayload | null {
    if (this.t0 === undefined) return null;
    const payload = resolveSpeakerTimeline(this.intervals, this.t0);
    payload.participants = Array.from(new Set([...payload.participants, ...this.roster])).sort();
    return payload;
  }
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * Names the anonymous CSRCs by overlap with named dom intervals, then emits a
 * named timeline: rtc intervals for every participant whose CSRC got a name
 * (accurate, layout-independent), dom intervals for everyone else.
 */
export function resolveSpeakerTimeline(
  raw: RawSpeakerInterval[],
  t0: number,
  { minVoteMs = 2000, minShare = 0.6, mergeGapMs = 300 } = {},
): SpeakerTimelinePayload {
  const dom = raw.filter((i) => i.source === 'dom' && i.name);
  const rtc = raw.filter((i) => i.source === 'rtc');

  const rtcByKey = new Map<string, RawSpeakerInterval[]>();
  for (const iv of rtc) {
    const list = rtcByKey.get(iv.key) ?? [];
    list.push(iv);
    rtcByKey.set(iv.key, list);
  }

  const csrcName = new Map<string, string>();
  rtcByKey.forEach((ivs, key) => {
    const votes = new Map<string, number>();
    for (const r of ivs) {
      for (const d of dom) {
        const o = overlap(r, d);
        if (o > 0) votes.set(d.name!, (votes.get(d.name!) ?? 0) + o);
      }
    }
    let best: string | null = null;
    let bestMs = 0;
    let total = 0;
    votes.forEach((ms, name) => {
      total += ms;
      if (ms > bestMs) { best = name; bestMs = ms; }
    });
    if (best && bestMs >= minVoteMs && bestMs / total >= minShare) csrcName.set(key, best);
  });

  const rtcNamed = new Set(csrcName.values());
  const named: { name: string; start: number; end: number; source: SpeakerSource }[] = [];
  rtcByKey.forEach((ivs, key) => {
    const name = csrcName.get(key);
    if (!name) return;
    for (const r of ivs) named.push({ name, start: r.start, end: r.end, source: 'rtc' });
  });
  for (const d of dom) {
    if (!rtcNamed.has(d.name!)) named.push({ name: d.name!, start: d.start, end: d.end, source: 'dom' });
  }

  // Rebase onto the recording start, drop pre-recording (lobby) speech.
  const rebased = named
    .map((s) => ({ ...s, start: Math.max(0, s.start - t0), end: s.end - t0 }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.name.localeCompare(b.name) || a.start - b.start);

  // Merge per-name fragments separated by tiny gaps (two CSRCs of a rejoin, jitter).
  const segments: SpeakerTimelineSegment[] = [];
  for (const s of rebased) {
    const last = segments[segments.length - 1];
    if (last && last.name === s.name && s.start - last.end_ms <= mergeGapMs) {
      last.end_ms = Math.max(last.end_ms, Math.round(s.end));
      continue;
    }
    segments.push({ name: s.name, start_ms: Math.round(s.start), end_ms: Math.round(s.end), source: s.source });
  }
  segments.sort((a, b) => a.start_ms - b.start_ms || a.name.localeCompare(b.name));

  return {
    version: 1,
    platform: 'google_meet',
    t0_epoch_ms: t0,
    participants: Array.from(new Set(dom.map((d) => d.name!))).sort(),
    segments,
    stats: { rtc_sources: rtcByKey.size, rtc_mapped: csrcName.size, dom_names: new Set(dom.map((d) => d.name)).size },
  };
}
