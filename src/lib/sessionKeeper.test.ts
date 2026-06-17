import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../config';
import { detectSignedIn } from './sessionHealth';
import { persistGoogleSessionState } from './chromium';

// A fake Playwright Page whose evaluate() returns a controlled "sign-in CTA
// present?" boolean, so we can exercise detectSignedIn's branch logic without a
// real browser.
const fakePage = (ctaPresent: boolean) => ({ evaluate: async () => ctaPresent } as any);

test('detectSignedIn: account-chooser bounce → signed out', async () => {
  const r = await detectSignedIn(fakePage(false), 'https://accounts.google.com/AccountChooser');
  assert.equal(r.signedIn, false);
  assert.match(r.reason, /account chooser/);
});

test('detectSignedIn: unexpected host → signed out', async () => {
  const r = await detectSignedIn(fakePage(false), 'https://sso.example.com/login');
  assert.equal(r.signedIn, false);
  assert.match(r.reason, /unexpected host/);
});

test('detectSignedIn: meet host with sign-in CTA → signed out (the old false-negative)', async () => {
  const r = await detectSignedIn(fakePage(true), 'https://meet.google.com/new?hl=en');
  assert.equal(r.signedIn, false);
  assert.match(r.reason, /sign-in CTA/);
});

test('detectSignedIn: meet host, no CTA → signed in', async () => {
  const r = await detectSignedIn(fakePage(false), 'https://meet.google.com/abc-defg-hij');
  assert.equal(r.signedIn, true);
});

// A fake BrowserContext whose storageState() writes a minimal valid snapshot.
const fakeContext = () => ({
  storageState: async ({ path: p }: { path: string }) => {
    fs.writeFileSync(p, JSON.stringify({ cookies: [{ name: 'SID' }], origins: [] }));
  },
} as any);

test('persistGoogleSessionState: worker (SESSION_WRITEBACK=false) does NOT write', async () => {
  const statePath = path.join(os.tmpdir(), `tb-state-worker-${process.pid}.json`);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  config.googleChromeStorageStatePath = statePath;
  config.sessionWriteback = false;

  await persistGoogleSessionState(fakeContext(), 'test');

  assert.equal(fs.existsSync(statePath), false, 'workers must never write the shared snapshot');
});

test('persistGoogleSessionState: keeper writes an atomic, valid snapshot', async () => {
  const statePath = path.join(os.tmpdir(), `tb-state-keeper-${process.pid}.json`);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  config.googleChromeStorageStatePath = statePath;
  config.sessionWriteback = true;

  await persistGoogleSessionState(fakeContext(), 'test');

  assert.equal(fs.existsSync(statePath), true, 'keeper must publish the snapshot');
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(Array.isArray(parsed.cookies) && parsed.cookies.length > 0);
  // no leftover temp file
  assert.equal(fs.existsSync(`${statePath}.tmp-${process.pid}`), false);
  fs.unlinkSync(statePath);
});
