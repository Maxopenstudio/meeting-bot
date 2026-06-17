import fs from 'fs';
import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import config from '../config';
import { getCorrelationIdLog } from '../util/logger';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

export type BotType = 'microsoft' | 'google' | 'zoom';

// Google binds its signed-in session partly to the User-Agent the session was
// captured under. tools/bot-session/capture-session.js pins this exact string,
// so the bot MUST replay the same UA — otherwise Google sees a different device
// than the one that logged in, invalidates the bound session faster, and the
// join silently degrades to anonymous guest. Keep this in sync with the capture
// tool's BOT_USER_AGENT.
export const GOOGLE_SESSION_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

// Minimal Google launch args, kept in sync with the google branch of
// createBrowserContext(). Used by the keeper's persistent-profile launch.
const GOOGLE_PERSISTENT_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--window-size=1280,720',
  '--auto-accept-this-tab-capture',
  '--autoplay-policy=no-user-gesture-required',
];

const externalBrowserContexts = new WeakSet<BrowserContext>();

export function isExternalBrowserContext(context?: BrowserContext | null): boolean {
  return Boolean(context && externalBrowserContexts.has(context));
}

/**
 * Write the context's current cookies back to the storage state file.
 *
 * Google binds its session to rotating __Secure-*PSIDTS cookies: every time the
 * bot (or the session-health probe) navigates with state.json, Google rotates
 * them server-side. If the rotated values are discarded — which is what happens
 * when the context is simply closed — the file keeps the OLD cookie chain and
 * the session dies after a use or two (observed: signed_in → signed_out within
 * ~30 min, one health-probe cycle). Persisting after every signed-in use keeps
 * the cookie chain alive indefinitely.
 *
 * Callers must only invoke this when the session was actually signed in —
 * persisting a bounced/guest state would clobber a freshly uploaded session.
 */
export async function persistGoogleSessionState(context: BrowserContext | null | undefined, correlationId: string): Promise<void> {
  const log = getCorrelationIdLog(correlationId);

  // Workers in a keeper+workers deploy must NOT write back: they share one
  // state.json and concurrent write-back clobbers the keeper's rotated cookies.
  // Default is on, so the legacy single-instance deploy is unaffected.
  if (!config.sessionWriteback) {
    console.log(`${log} session write-back disabled (worker mode) — skipping`);
    return;
  }

  const statePath = config.googleChromeStorageStatePath;
  if (!statePath || !context || isExternalBrowserContext(context)) return;

  try {
    // Write to a temp file and rename so a worker reading the snapshot never
    // sees a half-written file (rename is atomic within the same directory).
    const tmpPath = `${statePath}.tmp-${process.pid}`;
    await context.storageState({ path: tmpPath });
    fs.renameSync(tmpPath, statePath);
    console.log(`${log} Persisted rotated Google session cookies to storage state file (atomic)`);
  } catch (err) {
    console.warn(`${log} Failed to persist Google session storage state (non-fatal)`, err);
  }
}

/**
 * Launch the keeper's persistent Google Chrome profile (GOOGLE_CHROME_USER_DATA_DIR).
 * A persistent profile keeps Google treating the bot as a trusted device, so the
 * bound session survives far longer than a re-imported storageState. Single-writer
 * only: a user-data-dir can be opened by exactly one Chrome at a time.
 */
export async function launchGooglePersistentContext(correlationId: string): Promise<BrowserContext> {
  if (!config.googleChromeUserDataDir) {
    throw new Error('GOOGLE_CHROME_USER_DATA_DIR is not configured');
  }

  return launchPersistentContextWithTimeout(
    async () => await chromium.launchPersistentContext(config.googleChromeUserDataDir!, {
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      userAgent: GOOGLE_SESSION_USER_AGENT,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      args: GOOGLE_PERSISTENT_BROWSER_ARGS,
      ignoreDefaultArgs: ['--mute-audio', '--enable-automation'],
      executablePath: config.chromeExecutablePath,
    }),
    60000,
    correlationId,
  );
}

/**
 * One-time seed: if the persistent profile has no Google cookies yet, import them
 * from the admin-uploaded snapshot (GOOGLE_CHROME_STORAGE_STATE_PATH) so the
 * keeper inherits the existing logged-in session instead of needing a fresh
 * manual login into the profile dir. No-op once the profile is populated.
 */
export async function bootstrapGoogleProfileFromSnapshot(correlationId: string): Promise<void> {
  const log = getCorrelationIdLog(correlationId);
  const snapshotPath = config.googleChromeStorageStatePath;

  const context = await launchGooglePersistentContext(correlationId);
  try {
    const existing = await context.cookies();
    if (existing.some((c) => c.domain.includes('google.com'))) {
      console.log(`${log} keeper: persistent profile already has Google cookies — skip bootstrap`);
      return;
    }
    if (!snapshotPath || !fs.existsSync(snapshotPath)) {
      console.warn(`${log} keeper: empty profile and no snapshot at "${snapshotPath}" — upload a session in admin to seed it`);
      return;
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const cookies = Array.isArray(snapshot?.cookies) ? snapshot.cookies : [];
    if (!cookies.length) {
      console.warn(`${log} keeper: snapshot has no cookies (guest session) — nothing to bootstrap`);
      return;
    }
    await context.addCookies(cookies);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://meet.google.com/new?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    console.log(`${log} keeper: bootstrapped persistent profile from snapshot (${cookies.length} cookies)`);
  } finally {
    // close() flushes the profile (cookies/localStorage) to disk.
    await context.close().catch(() => {});
  }
}

function attachBrowserErrorHandlers(browser: Browser | null, context: BrowserContext, page: Page, correlationId: string) {
  const log = getCorrelationIdLog(correlationId);

  browser?.on('disconnected', () => {
    console.log(`${log} Browser has disconnected!`);
  });

  context.on('close', () => {
    console.log(`${log} Browser has closed!`);
  });

  page.on('crash', (page) => {
    console.error(`${log} Page has crashed! ${page?.url()}`);
  });

  page.on('close', (page) => {
    console.log(`${log} Page has closed! ${page?.url()}`);
  });
}

async function launchBrowserWithTimeout(launchFn: () => Promise<Browser>, timeoutMs: number, correlationId: string): Promise<Browser> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Browser launch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Start launch
    launchFn()
      .then(result => {
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          console.log(`${getCorrelationIdLog(correlationId)} Browser launch function success!`);
          resolve(result);
        }
      })
      .catch(err => {
        console.error(`${getCorrelationIdLog(correlationId)} Error launching browser`, err);
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
}

async function launchPersistentContextWithTimeout(launchFn: () => Promise<BrowserContext>, timeoutMs: number, correlationId: string): Promise<BrowserContext> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Persistent browser launch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    launchFn()
      .then(result => {
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          console.log(`${getCorrelationIdLog(correlationId)} Persistent browser launch function success!`);
          resolve(result);
        }
      })
      .catch(err => {
        console.error(`${getCorrelationIdLog(correlationId)} Error launching persistent browser`, err);
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
}

async function createBrowserContext(url: string, correlationId: string, botType: BotType = 'google'): Promise<Page> {
  const size = { width: 1280, height: 720 };

  // Google Meet is sensitive to browser fingerprinting before admission. Keep
  // its launch close to normal Chrome and reserve recording-heavy flags for
  // platforms that need them.
  const googleBrowserArgs: string[] = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    `--window-size=${size.width},${size.height}`,
    '--auto-accept-this-tab-capture',
    '--autoplay-policy=no-user-gesture-required',
  ];

  const recordingBrowserArgs: string[] = [
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--window-size=${size.width},${size.height}`,
    '--auto-accept-this-tab-capture',
    '--enable-features=MediaRecorder',
    '--enable-audio-service-out-of-process',
    '--autoplay-policy=no-user-gesture-required',
  ];

  // Fake device args - only for Microsoft Teams
  // Teams needs fake devices to interact with pre-join screen toggles,
  // but actual recording is done via ffmpeg (X11 + PulseAudio)
  const fakeDeviceArgs: string[] = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ];

  // Google Meet and Zoom use browser-based recording (getDisplayMedia + MediaRecorder)
  // and don't need fake devices:
  // - Google Meet: clicks "Continue without microphone and camera"
  // - Zoom: expects "Cannot detect your camera/microphone" notifications
  const browserArgs = botType === 'google'
    ? googleBrowserArgs
    : botType === 'microsoft'
      ? [...recordingBrowserArgs, ...fakeDeviceArgs]
      : recordingBrowserArgs;
  const ignoreDefaultArgs = botType === 'google'
    ? ['--mute-audio', '--enable-automation']
    : ['--mute-audio'];

  // Teams-specific display args: kiosk mode prevents address bar from showing in ffmpeg recording
  // Google Meet and Zoom don't need this since they use tab capture (getDisplayMedia)
  const displayArgs = botType === 'microsoft'
    ? ['--kiosk', '--start-maximized']
    : [];

  console.log(`${getCorrelationIdLog(correlationId)} Launching browser for ${botType} bot (fake devices: ${botType === 'microsoft'})`);

  const contextOptions = {
    ...(botType !== 'google' ? {
      permissions: ['camera', 'microphone'],
    } : {
      // Match the UA the signed-in session was captured under (see above), so
      // Google keeps the bound session valid instead of treating each join as a
      // new device and dropping the bot to guest.
      userAgent: GOOGLE_SESSION_USER_AGENT,
    }),
    viewport: size,
    ignoreHTTPSErrors: true,
    // Record video only in development for debugging. Keep Google Meet's
    // anonymous admission context close to a regular incognito tab.
    ...(process.env.NODE_ENV === 'development' && botType !== 'google' && {
      recordVideo: {
        dir: './debug-videos/',
        size: size,
      },
    }),
  };

  if (botType === 'google' && config.googleChromeCdpUrl) {
    console.log(`${getCorrelationIdLog(correlationId)} Connecting Google bot to external Chrome`, {
      cdpUrl: config.googleChromeCdpUrl,
    });

    const browser = await launchBrowserWithTimeout(
      async () => await chromium.connectOverCDP(config.googleChromeCdpUrl!),
      60000,
      correlationId
    );

    const context = browser.contexts()[0] ?? await browser.newContext({
      ...contextOptions,
      ...(config.googleChromeStorageStatePath ? {
        storageState: config.googleChromeStorageStatePath,
      } : {}),
    });
    externalBrowserContexts.add(context);

    const page = await context.newPage();
    await page.setViewportSize(size);
    attachBrowserErrorHandlers(browser, context, page, correlationId);

    console.log(`${getCorrelationIdLog(correlationId)} External Chrome connected successfully!`);

    return page;
  }

  if (botType === 'google' && config.googleChromeUserDataDir) {
    console.log(`${getCorrelationIdLog(correlationId)} Launching Google bot with persistent Chrome profile`, {
      userDataDir: config.googleChromeUserDataDir,
    });

    const context = await launchGooglePersistentContext(correlationId);

    const page = context.pages()[0] ?? await context.newPage();
    attachBrowserErrorHandlers(context.browser(), context, page, correlationId);

    console.log(`${getCorrelationIdLog(correlationId)} Persistent browser launched successfully!`);

    return page;
  }

  const browser = await launchBrowserWithTimeout(
    async () => await chromium.launch({
      headless: false,
      // Don't let Playwright install its own SIGTERM/SIGINT/SIGHUP handlers — they
      // close the browser immediately when the node process receives a signal, which
      // breaks our graceful shutdown (we want the in-flight recording to finish).
      // The app explicitly calls browser.close() when the recording is done.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        ...browserArgs,
        ...displayArgs,
      ],
      ignoreDefaultArgs,
      executablePath: config.chromeExecutablePath,
    }),
    60000,
    correlationId
  );

  const context = await browser.newContext({
    ...contextOptions,
    ...(config.googleChromeStorageStatePath && botType === 'google' ? {
      storageState: config.googleChromeStorageStatePath,
    } : {}),
  });

  // Grant permissions so Teams will play audio (Teams requires this unlike Google Meet)
  if (botType !== 'google') {
    await context.grantPermissions(['microphone', 'camera'], { origin: url });
  }

  const page = await context.newPage();

  // Attach common error handlers
  attachBrowserErrorHandlers(browser, context, page, correlationId);

  console.log(`${getCorrelationIdLog(correlationId)} Browser launched successfully!`);

  return page;
}

export default createBrowserContext;
