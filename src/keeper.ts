// Session-keeper entrypoint (BOT_ROLE=keeper).
//
// A single keeper instance owns the live persistent Chrome profile
// (GOOGLE_CHROME_USER_DATA_DIR), keeps the Google session "trusted" by exercising
// it on a timer, and republishes a fresh read-only storageState snapshot
// (GOOGLE_CHROME_STORAGE_STATE_PATH) that worker pods consume. It does NOT join
// meetings and does NOT consume the Redis job queue.
import './shims/crypto-polyfill';
import http from 'http';
import config from './config';
import { bootstrapGoogleProfileFromSnapshot } from './lib/chromium';
import { checkGoogleSessionHealth, SessionHealthResult } from './lib/sessionHealth';

const PORT = 3000;

let lastResult: (SessionHealthResult & { ts: string }) | null = null;
let cycleRunning = false;

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
