import express from 'express';
import client from 'prom-client';
import config, { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import googleRouter from './google';
import microsoftRouter from './microsoft';
import zoomRouter from './zoom';
import { globalJobStore } from '../lib/globalJobStore';
import { RedisConsumerService } from '../connect/RedisConsumerService';
import { checkGoogleSessionHealth, SessionHealthResult } from '../lib/sessionHealth';

const app = express();

app.use(express.json());

// Initialize Redis consumer service
export const redisConsumerService = new RedisConsumerService();

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/isbusy', async (req, res) => {
  // Use the job store's isBusy status
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  return res.status(200).json({ success: true, data: jobStoreBusy });
});

app.get('/health', async (req, res) => {
  // Simple health check endpoint for Docker
  return res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Liveness probe for the Google session (state.json). Launches a browser and
// navigates to Meet to see whether the restored session is still signed in —
// the backend polls this on a schedule and alerts (Telegram) when it goes dead,
// so a stale session is caught BEFORE scheduled meetings silently fail to record.
let lastSessionHealthAt = 0;
let lastSessionHealth: SessionHealthResult | null = null;
const SESSION_HEALTH_MIN_INTERVAL_MS = 60_000;

app.get('/session-health', async (req, res) => {
  // Single-concurrency bot: never launch a probe browser while a recording is
  // in flight. A busy bot is, by definition, signed in and working.
  if (globalJobStore.isBusy()) {
    return res.status(200).json({ success: true, busy: true, signedIn: true, skipped: 'busy' });
  }

  // Cheap rate-limit so the endpoint can't be hammered into launching browsers.
  const now = Date.now();
  if (lastSessionHealth && now - lastSessionHealthAt < SESSION_HEALTH_MIN_INTERVAL_MS) {
    return res.status(200).json({ success: true, busy: false, cached: true, ...lastSessionHealth });
  }

  try {
    const result = await checkGoogleSessionHealth('session-health');
    lastSessionHealthAt = now;
    lastSessionHealth = result;
    return res.status(200).json({ success: true, busy: false, cached: false, ...result });
  } catch (e: any) {
    return res.status(200).json({ success: false, error: e?.message || String(e) });
  }
});

// Create a Gauge metric for busy status (0 or 1)
const busyStatus = new client.Gauge({
  name: 'isbusy',
  help: 'busy status of the pod (1 = busy, 0 = available)'
});

const isavailable = new client.Gauge({
  name: 'isavailable',
  help: 'available status of the pod (1 = available, 0 = busy)'
});

app.get('/metrics', async (req, res) => {
  // Use the job store's isBusy status for metrics
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  busyStatus.set(jobStoreBusy);
  isavailable.set(1 - jobStoreBusy);
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/debug', async (req, res, next) => {
  if (NODE_ENV === 'development') {
    next();
  }
  else {
    res.status(500).send({});
  }
}, async (req, res) => {
  await mainDebug('baf14', 'https://www.github.com');
  res.status(200).send({});
});

app.use('/google', googleRouter);
app.use('/microsoft', microsoftRouter);
app.use('/zoom', zoomRouter);

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

export const getGracefulShutdown = () => gracefulShutdown;

export const setIsBusy = (val: number) =>
  isbusy = val;

export const getIsBusy = () => isbusy;

// Start Redis consumer service only if Redis is enabled
if (config.isRedisEnabled) {
  redisConsumerService.start().catch((error) => {
    console.error('Failed to start Redis consumer service:', error);
  });
} else {
  console.info('Redis consumer service not started - Redis is disabled');
}

export default app;
