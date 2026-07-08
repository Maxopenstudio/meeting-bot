// Session-keeper entrypoint (BOT_ROLE=keeper).
//
// A single keeper instance owns the live persistent Chrome profile
// (GOOGLE_CHROME_USER_DATA_DIR), keeps the Google session "trusted" by exercising
// it on a timer, and republishes a fresh read-only storageState snapshot
// (GOOGLE_CHROME_STORAGE_STATE_PATH) that worker pods consume. It does NOT join
// meetings and does NOT consume the Redis job queue.
import './shims/crypto-polyfill';
import fs from 'fs';
import http from 'http';
import config from './config';
import { bootstrapGoogleProfileFromSnapshot } from './lib/chromium';
import { checkGoogleSessionHealth, SessionHealthResult } from './lib/sessionHealth';

const PORT = 3000;

let lastResult: (SessionHealthResult & { ts: string }) | null = null;
let cycleRunning = false;
// mtime (ms) of the snapshot we last imported into the profile. A signed-out
// cycle only triggers a re-seed when the admin has uploaded a NEWER snapshot —
// otherwise we'd pointlessly re-import the same dead cookies every cycle.
let lastSeededSnapshotMtimeMs = 0;

function snapshotMtimeMs(): number {
  const p = config.googleChromeStorageStatePath;
  if (!p) return 0;
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

async function runCycle(): Promise<void> {
  // A user-data-dir is single-Chrome-at-a-time; never overlap cycles.
  if (cycleRunning) {
    console.log('keeper: previous cycle still running — skipping this tick');
    return;
  }
  cycleRunning = true;
  try {
    const result = await checkGoogleSessionHealth('keeper');
    lastResult = { ...result, ts: new Date().toISOString() };
    console.log(`keeper: cycle done signedIn=${result.signedIn} reason="${result.reason}"`);

    // Self-heal: the live profile is signed out but a fresh state.json was
    // uploaded in admin (newer than what we last seeded). Re-seed the profile
    // from it and re-probe, so an admin upload recovers a dead profile within
    // one cycle instead of being silently ignored forever.
    if (!result.signedIn) {
      const mtime = snapshotMtimeMs();
      if (mtime > lastSeededSnapshotMtimeMs) {
        console.log(`keeper: signed-out + newer snapshot (mtime ${new Date(mtime).toISOString()}) — re-seeding profile`);
        const seeded = await bootstrapGoogleProfileFromSnapshot('keeper', { force: true }).catch((err) => {
          console.error('keeper: re-seed failed', err);
          return false;
        });
        lastSeededSnapshotMtimeMs = mtime;
        if (seeded) {
          const recheck = await checkGoogleSessionHealth('keeper');
          lastResult = { ...recheck, ts: new Date().toISOString() };
          console.log(`keeper: post-reseed signedIn=${recheck.signedIn} reason="${recheck.reason}"`);
        }
      }
    }
  } catch (err) {
    console.error('keeper: cycle failed', err);
  } finally {
    cycleRunning = false;
  }
}

async function main(): Promise<void> {
  if (config.botRole !== 'keeper') {
    console.error('keeper entrypoint started but BOT_ROLE != "keeper" — exiting');
    process.exit(1);
  }
  if (!config.googleChromeUserDataDir) {
    console.error('keeper requires GOOGLE_CHROME_USER_DATA_DIR — exiting');
    process.exit(1);
  }

  // Health server so the container HEALTHCHECK + backend probe have an endpoint.
  // /session-health reports the LAST cycle result (the keeper runs its own loop;
  // it does not launch a browser per HTTP hit). Before the first cycle completes,
  // report busy so a transient null never trips a false signed_out alert.
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', role: 'keeper', uptime: process.uptime() }));
      return;
    }
    // Same bearer guard as the worker API (BOT_API_TOKEN) — the keeper's
    // /session-health is exposed to the backend over the internet on fleet nodes.
    if (config.apiToken && req.headers.authorization !== `Bearer ${config.apiToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'unauthorized' }));
      return;
    }
    if (req.url && req.url.startsWith('/session-health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const body = lastResult
        ? { success: true, busy: false, ...lastResult }
        : { success: true, busy: true, signedIn: true, pending: true };
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(PORT, () => console.log(`keeper: health server listening on :${PORT}`));

  // Seed the profile from the admin-uploaded snapshot if it has never been
  // logged in, then run the first keep-alive immediately and on an interval.
  await bootstrapGoogleProfileFromSnapshot('keeper').catch((err) => {
    console.error('keeper: profile bootstrap failed (continuing — loop will retry)', err);
  });
  // Record what the startup bootstrap saw so the loop only re-seeds on a
  // genuinely newer admin upload, not on the snapshot we already have.
  lastSeededSnapshotMtimeMs = snapshotMtimeMs();
  await runCycle();

  const intervalMs = Math.max(5, config.sessionKeeperIntervalMinutes) * 60_000;
  setInterval(() => { void runCycle(); }, intervalMs);
  console.log(`keeper: keep-alive loop every ${config.sessionKeeperIntervalMinutes} min`);

  const shutdown = () => {
    console.log('keeper: signal received — shutting down');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('keeper: fatal startup error', err);
  process.exit(1);
});
