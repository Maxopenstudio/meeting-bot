import { Browser, BrowserContext, Page, chromium } from 'playwright';
import config from '../config';
import { getCorrelationIdLog } from '../util/logger';
import { launchGooglePersistentContext, persistGoogleSessionState } from './chromium';

export interface SessionHealthResult {
  signedIn: boolean;
  account: string | null;
  finalUrl: string;
  htmlLang: string | null;
  reason: string;
  checkedAt: string;
}

// A signed-in session lands on meet.google.com; a dead/stale session is bounced
// to the account chooser on accounts.google.com.
const PROBE_URL = 'https://meet.google.com/new?hl=en';
const NAV_TIMEOUT_MS = 45000;

/**
 * Decide whether the probed page reflects a signed-in Google session.
 *
 * The old check (`!finalUrl.includes('accounts.google.com')`) was too narrow:
 * a logged-out session that does NOT bounce to the account chooser (stays on a
 * sign-in CTA, or lands on some other host) read as signed-in, so a real logout
 * never produced a signed_out result and never alerted. Now we require the final
 * host to be meet.google.com AND the page to lack a sign-in call-to-action.
 */
export async function detectSignedIn(page: Page, finalUrl: string): Promise<{ signedIn: boolean; reason: string }> {
  let host = '';
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    // leave host empty → treated as unexpected below
  }

  if (host.includes('accounts.google.com')) {
    return { signedIn: false, reason: 'bounced to account chooser' };
  }
  if (host !== 'meet.google.com') {
    return { signedIn: false, reason: `unexpected host: ${host || '(unparseable)'}` };
  }

  // On meet.google.com a logged-out view shows a "Sign in" CTA and lacks the
  // "New meeting" / instant-meeting UI a signed-in landing has.
  const hasSignInCta = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const lower = text.toLowerCase();
    const signInHint = /\bsign in\b|войти|увійти|sign in to/.test(lower);
    const signedInHint = /new meeting|start an instant meeting|новая встреча|нова зустріч/i.test(text);
    return signInHint && !signedInHint;
  }).catch(() => false);

  if (hasSignInCta) {
    return { signedIn: false, reason: 'sign-in CTA present on meet.google.com' };
  }
  return { signedIn: true, reason: 'meet.google.com, no sign-in CTA' };
}

/**
 * Best-effort liveness probe for the bot's Google session, and — in keeper mode —
 * the keep-alive itself.
 *
 * When GOOGLE_CHROME_USER_DATA_DIR is set (the keeper) the probe drives the real
 * persistent profile and, on a signed-in result, republishes a fresh storageState
 * snapshot via persistGoogleSessionState() (atomic; workers read it). Otherwise it
 * falls back to the legacy storageState (state.json) launch.
 *
 * Cookie expiry alone is NOT a reliable signal — Google rotates the
 * __Secure-*PSIDTS bound-session cookies server-side, so a restored session can
 * carry cookies that look valid by `expires` yet are already rejected. Only a real
 * navigation reveals that, which is why this launches a browser.
 */
export async function checkGoogleSessionHealth(correlationId: string): Promise<SessionHealthResult> {
  const log = getCorrelationIdLog(correlationId);
  const usePersistentProfile = Boolean(config.googleChromeUserDataDir);
  const storageState = config.googleChromeStorageStatePath;

  if (!usePersistentProfile && !storageState) {
    throw new Error('Neither GOOGLE_CHROME_USER_DATA_DIR nor GOOGLE_CHROME_STORAGE_STATE_PATH is configured');
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    if (usePersistentProfile) {
      console.log(`${log} session-health: probing persistent profile ${config.googleChromeUserDataDir}`);
      context = await launchGooglePersistentContext(correlationId);
    } else {
      browser = await chromium.launch({
        headless: false,
        executablePath: config.chromeExecutablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720'],
      });
      context = await browser.newContext({ storageState });
    }

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const htmlLang = await page.evaluate(() => document.documentElement.lang).catch(() => null);

    // Surface which account the page reflects — confirms the right bot account is
    // in the session (and shows in the alert when it goes dead).
    const account = await page.evaluate(() => {
      const m = (document.body.innerText || '').match(/[\w.+-]+@[\w.-]+\.\w+/);
      return m ? m[0] : null;
    }).catch(() => null);

    const { signedIn, reason } = await detectSignedIn(page, finalUrl);

    console.log(`${log} session-health: signedIn=${signedIn} reason="${reason}" account=${account ?? '?'} url=${finalUrl}`);

    // The probe navigation itself makes Google rotate the bound-session cookies.
    // Persisting (keeper only — gated inside persistGoogleSessionState) writes the
    // rotated chain back so the static snapshot doesn't die. Persist only when
    // signed-in — a bounced state must not overwrite a freshly uploaded session.
    if (signedIn) {
      await persistGoogleSessionState(context, correlationId);
    }

    return { signedIn, account, finalUrl, htmlLang, reason, checkedAt: new Date().toISOString() };
  } finally {
    // Close the persistent context (flushes profile + frees the SingletonLock) or
    // the throwaway browser, depending on which path ran.
    if (usePersistentProfile && context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
