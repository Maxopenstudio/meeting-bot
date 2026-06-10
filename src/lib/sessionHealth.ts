import { chromium } from 'playwright';
import config from '../config';
import { getCorrelationIdLog } from '../util/logger';
import { persistGoogleSessionState } from './chromium';

export interface SessionHealthResult {
  signedIn: boolean;
  account: string | null;
  finalUrl: string;
  htmlLang: string | null;
  checkedAt: string;
}

// A signed-in session lands on meet.google.com; a dead/stale session is bounced
// to the account chooser on accounts.google.com.
const PROBE_URL = 'https://meet.google.com/new?hl=en';
const NAV_TIMEOUT_MS = 45000;

/**
 * Best-effort liveness probe for the bot's Google session. Loads the same
 * storageState (state.json) the join flow uses and navigates to a Meet page.
 * A live signed-in session stays on meet.google.com; a dead/stale session is
 * bounced to accounts.google.com ("Choose an account / Signed out").
 *
 * Cookie expiry alone is NOT a reliable signal — Google rotates the
 * __Secure-*PSIDTS bound-session cookies server-side, so a restored state.json
 * can carry cookies that look valid by `expires` yet are already rejected. Only
 * a real navigation reveals that, which is why this launches a browser.
 */
export async function checkGoogleSessionHealth(correlationId: string): Promise<SessionHealthResult> {
  const log = getCorrelationIdLog(correlationId);
  const storageState = config.googleChromeStorageStatePath;
  if (!storageState) {
    throw new Error('GOOGLE_CHROME_STORAGE_STATE_PATH is not configured');
  }

  const browser = await chromium.launch({
    headless: false,
    executablePath: config.chromeExecutablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720'],
  });

  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const signedIn = !finalUrl.includes('accounts.google.com');
    const htmlLang = await page.evaluate(() => document.documentElement.lang).catch(() => null);

    // Surface which account the page reflects — confirms the right bot account
    // is in the state.json (and shows in the alert when the session is dead).
    const account = await page.evaluate(() => {
      const m = (document.body.innerText || '').match(/[\w.+-]+@[\w.-]+\.\w+/);
      return m ? m[0] : null;
    }).catch(() => null);

    console.log(`${log} session-health: signedIn=${signedIn} account=${account ?? '?'} url=${finalUrl}`);

    // The probe navigation itself makes Google rotate the bound-session
    // cookies. Without writing them back, every probe burns one rotation and
    // the static state.json dies within an hour. Persist only on signed-in —
    // a bounced state must not overwrite a freshly uploaded session.
    if (signedIn) {
      await persistGoogleSessionState(context, correlationId);
    }

    return { signedIn, account, finalUrl, htmlLang, checkedAt: new Date().toISOString() };
  } finally {
    await browser.close().catch(() => {});
  }
}
