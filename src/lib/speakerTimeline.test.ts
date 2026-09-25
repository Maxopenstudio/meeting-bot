import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawSpeakerInterval, resolveSpeakerTimeline, SpeakerTimelineCollector } from './speakerTimeline';

const T0 = 1_700_000_000_000;
const dom = (name: string, s: number, e: number): RawSpeakerInterval =>
  ({ key: 'dom:' + name, name, source: 'dom', start: T0 + s, end: T0 + e });
const rtc = (csrc: number, s: number, e: number): RawSpeakerInterval =>
  ({ key: 'csrc:' + csrc, source: 'rtc', start: T0 + s, end: T0 + e });

test('csrc gets the name it overlaps most, rtc intervals replace dom ones', () => {
  const p = resolveSpeakerTimeline([
    dom('Ivan', 1000, 6000), rtc(11, 700, 5800),
    dom('Olga', 8000, 12000), rtc(22, 7600, 11800),
    // Ivan speaks again while his tile is off screen: only rtc sees it.
    rtc(11, 20000, 24000),
  ], T0);

  assert.equal(p.stats.rtc_mapped, 2);
  assert.deepEqual(p.segments.map((s) => [s.name, s.start_ms, s.end_ms, s.source]), [
    ['Ivan', 700, 5800, 'rtc'],
    ['Olga', 7600, 11800, 'rtc'],
    ['Ivan', 20000, 24000, 'rtc'],
  ]);
});

test('ambiguous csrc stays unnamed, dom fallback is used', () => {
  const p = resolveSpeakerTimeline([
    dom('Ivan', 0, 3000), dom('Olga', 0, 3000), rtc(5, 0, 3000),
  ], T0);
  assert.equal(p.stats.rtc_mapped, 0);
  assert.deepEqual(p.segments.map((s) => [s.name, s.source]), [['Ivan', 'dom'], ['Olga', 'dom']]);
});

test('too little evidence does not name a csrc', () => {
  const p = resolveSpeakerTimeline([dom('Ivan', 0, 1000), rtc(5, 0, 1000)], T0);
  assert.equal(p.stats.rtc_mapped, 0);
});

test('lobby speech before t0 is clipped, small gaps merge', () => {
  const p = resolveSpeakerTimeline([
    dom('Ivan', -5000, -1000), dom('Ivan', -500, 2000), dom('Ivan', 2200, 4000),
  ], T0);
  assert.deepEqual(p.segments.map((s) => [s.start_ms, s.end_ms]), [[0, 4000]]);
});

test('collector needs t0 and merges roster into participants', () => {
  const c = new SpeakerTimelineCollector();
  c.handle({ kind: 'intervals', intervals: [dom('Ivan', 0, 3000)] });
  assert.equal(c.build(), null);
  c.handle({ kind: 't0', at: T0 });
  c.addParticipants(['Olga', 'Ivan']);
  const p = c.build()!;
  assert.deepEqual(p.participants, ['Ivan', 'Olga']);
  assert.equal(p.segments.length, 1);
});
