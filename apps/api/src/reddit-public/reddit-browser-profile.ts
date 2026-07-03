import { mkdir } from 'node:fs/promises';
import {
  chromium,
  firefox,
  type BrowserContext,
  type Page,
} from 'playwright';
import { navigateRedditPage } from './reddit-navigation';
import { resolveRedditRuntimePath } from './reddit-runtime-path';
import {
  applySyncedRedditSession,
  readSyncedRedditBrowserMetadata,
  type RedditBrowserMetadata,
} from './reddit-session-store';

const REDDIT_LOGIN_CONTROL_SELECTOR = [
  'a[href*="/login"]',
  'button:has-text("Log In")',
  'button:has-text("Đăng nhập")',
].join(',');

function envBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;

  return ['1', 'true', 'yes', 'on'].includes(
    value.trim().toLowerCase(),
  );
}

function selectedBrowserEngine(
  metadata: RedditBrowserMetadata | undefined,
): 'chromium' | 'firefox' {
  const configured = process.env.REDDIT_BROWSER_ENGINE?.trim().toLowerCase();
  if (configured === 'firefox' || configured === 'chromium') {
    return configured;
  }
  return metadata?.engine === 'firefox' ? 'firefox' : 'chromium';
}

export function redditProfileDirectory(
  engine: 'chromium' | 'firefox' = 'chromium',
): string {
  if (engine === 'firefox' && process.env.REDDIT_BACKEND_FIREFOX_PROFILE_DIR) {
    return resolveRedditRuntimePath(
      process.env.REDDIT_BACKEND_FIREFOX_PROFILE_DIR,
      '.runtime/reddit-browser-profile-firefox',
    );
  }

  const base = resolveRedditRuntimePath(
    process.env.REDDIT_BACKEND_PROFILE_DIR,
    '.runtime/reddit-browser-profile',
  );
  return engine === 'firefox' ? `${base}-firefox` : base;
}

export async function launchRedditBackendContext(): Promise<BrowserContext> {
  const metadata = await readSyncedRedditBrowserMetadata();
  const engine = selectedBrowserEngine(metadata);
  const profileDirectory = redditProfileDirectory(engine);

  await mkdir(profileDirectory, { recursive: true });
  console.info('[reddit] launching backend browser profile', {
    profileDirectory,
    browserEngine: engine,
    pairedBrowserEngine: metadata?.engine,
    cwd: process.cwd(),
  });

  const requestedUserAgent =
    process.env.REDDIT_CRAWLER_USER_AGENT?.trim() || metadata?.userAgent || undefined;
  const userAgent =
    requestedUserAgent === 'LeadSignalBackendCollector/1.0'
      ? metadata?.userAgent
      : requestedUserAgent;
  const locale =
    metadata?.language || process.env.REDDIT_CRAWLER_LOCALE || 'en-US';
  const commonOptions = {
    headless: !envBoolean(process.env.REDDIT_SHOW_BROWSER, false),
    locale,
    timezoneId:
      process.env.REDDIT_CRAWLER_TIMEZONE ?? 'Asia/Ho_Chi_Minh',
    viewport: {
      width: 1440,
      height: 1000,
    },
    ...(userAgent ? { userAgent } : {}),
  };

  if (engine === 'firefox') {
    try {
      return await firefox.launchPersistentContext(
        profileDirectory,
        commonOptions,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/executable|browser.*not found|playwright install/i.test(message)) {
        throw new Error(
          'REDDIT_PLAYWRIGHT_FIREFOX_REQUIRED: the paired Reddit session came from Firefox; run `pnpm exec playwright install firefox` once',
        );
      }
      throw error;
    }
  }

  const channel =
    process.env.REDDIT_BROWSER_CHANNEL?.trim() || undefined;
  try {
    return await chromium.launchPersistentContext(profileDirectory, {
      ...commonOptions,
      channel,
    });
  } catch (error) {
    if (!channel) throw error;

    return chromium.launchPersistentContext(profileDirectory, commonOptions);
  }
}

async function redditSessionMissing(page: Page): Promise<boolean> {
  const redirectedToLogin =
    /\/login(?:\/|\?|$)/i.test(page.url());

  const loginControlVisible = await page
    .locator(REDDIT_LOGIN_CONTROL_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false);

  return redirectedToLogin || loginControlVisible;
}

async function navigateRedditHome(page: Page): Promise<void> {
  await navigateRedditPage(page, 'https://www.reddit.com/', {
    log: (message) => console.warn(`[reddit-session] ${message}`),
  });
}

export async function assertRedditSession(
  context: BrowserContext,
): Promise<void> {
  const hydrated = await applySyncedRedditSession(context);
  const page =
    context.pages()[0] ?? (await context.newPage());

  await navigateRedditHome(page);
  if (!(await redditSessionMissing(page))) {
    if (hydrated) {
      console.info(
        '[reddit] Backend browser authenticated from the paired extension session.',
      );
    }
    return;
  }

  throw new Error(
    hydrated
      ? 'REDDIT_SESSION_REJECTED: synchronized Reddit session is no longer accepted; open Reddit in the paired browser to refresh it'
      : 'REDDIT_SESSION_SYNC_REQUIRED: open Reddit in the paired browser so the extension can synchronize the existing session',
  );
}
