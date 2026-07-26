import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordingObjectKey } from './recordingName';

// Regression guard for the cross-meeting clobber bug: the object key MUST be
// unique per meeting. Previously the key was
// `meeting-bot/{userId}/{provider prefix} {time-to-the-minute}{ext}` with no
// session id, so two recordings of the same user in the same minute resolved to
// the same key and overwrote each other in the bucket.

const base = {
  userId: 'user-123',
  namePrefix: 'Google Meet Recording',
  time: '3:45pm Jun 17 2026',
  fileExtension: '.webm',
};

test('key includes the botId segment', () => {
  const key = buildRecordingObjectKey({ ...base, botId: 'session-abc' });
  assert.equal(key, 'meeting-bot/user-123/session-abc/Google Meet Recording 3:45pm Jun 17 2026.webm');
  assert.ok(key.includes('/session-abc/'), 'key must contain the botId as a path segment');
});

test('two sessions with identical user/provider/minute produce different keys', () => {
  const a = buildRecordingObjectKey({ ...base, botId: 'session-aaa' });
  const b = buildRecordingObjectKey({ ...base, botId: 'session-bbb' });
  assert.notEqual(a, b, 'distinct meetings must never share an object key');
});

test('same session is deterministic (idempotent re-upload reuses the key)', () => {
  const a = buildRecordingObjectKey({ ...base, botId: 'session-aaa' });
  const b = buildRecordingObjectKey({ ...base, botId: 'session-aaa' });
  assert.equal(a, b);
});
