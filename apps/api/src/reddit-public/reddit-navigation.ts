import type { Page, Response } from 'playwright';

let nextNavigationAt = 0;

function positiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toOldRedditUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname !== 'www.reddit.com' &&
      parsed.hostname !== 'reddit.com'
    ) {
      return undefined;
    }
    parsed.hostname = 'old.reddit.com';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function isRetryableRedditNavigationError(error: unknown): boolean {
  const message = errorMessage(error);
  return [
    'ERR_HTTP_RESPONSE_CODE_FAILURE',
    'ERR_HTTP2_PROTOCOL_ERROR',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_CLOSED',
    'ERR_NETWORK_CHANGED',
    'ERR_TIMED_OUT',
    'Timeout',
  ].some((token) => message.includes(token));
}

async function reserveNavigationSlot(page: Page): Promise<void> {
  const intervalMs = Math.min(
    positiveInteger(
      process.env.REDDIT_CRAWLER_MIN_NAVIGATION_INTERVAL_MS,
      1_500,
    ),
    30_000,
  );
  const now = Date.now();
  const waitMs = Math.max(0, nextNavigationAt - now);
  nextNavigationAt = Math.max(now, nextNavigationAt) + intervalMs;
  if (waitMs > 0) await page.waitForTimeout(waitMs);
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(15_000, 1_000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 500);
}

async function gotoWithRetry(
  page: Page,
  url: string,
  log: (message: string) => void,
): Promise<Response | null> {
  const maxAttempts = Math.min(
    positiveInteger(process.env.REDDIT_CRAWLER_NAVIGATION_RETRIES, 3),
    6,
  );
  const timeout = positiveInteger(
    process.env.REDDIT_CRAWLER_NAVIGATION_TIMEOUT_MS,
    30_000,
  );
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await reserveNavigationSlot(page);
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      const status = response?.status();

      if (status === 403 || status === 429 || (status && status >= 500)) {
        const retryable = attempt < maxAttempts;
        if (!retryable) {
          throw new Error(`Reddit returned HTTP ${status} for ${url}`);
        }
        const delayMs = retryDelayMs(attempt - 1);
        log(
          `Reddit returned HTTP ${status} for ${url}; retrying in ${delayMs}ms (${attempt}/${maxAttempts})`,
        );
        await page.waitForTimeout(delayMs);
        continue;
      }

      if (status && status >= 400) {
        throw new Error(`Reddit returned HTTP ${status} for ${url}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (
        attempt >= maxAttempts ||
        !isRetryableRedditNavigationError(error)
      ) {
        throw error;
      }
      const delayMs = retryDelayMs(attempt - 1);
      log(
        `Reddit navigation failed for ${url}: ${errorMessage(error)}; retrying in ${delayMs}ms (${attempt}/${maxAttempts})`,
      );
      await page.waitForTimeout(delayMs);
    }
  }

  throw lastError;
}

export async function navigateRedditPage(
  page: Page,
  url: string,
  options: {
    allowOldRedditFallback?: boolean;
    log?: (message: string) => void;
  } = {},
): Promise<Response | null> {
  const log = options.log ?? (() => undefined);

  try {
    return await gotoWithRetry(page, url, log);
  } catch (error) {
    if (options.allowOldRedditFallback === false) throw error;
    const fallbackUrl = toOldRedditUrl(url);
    if (!fallbackUrl || fallbackUrl === url) throw error;

    log(
      `Modern Reddit navigation failed for ${url}; falling back to ${fallbackUrl}`,
    );
    return gotoWithRetry(page, fallbackUrl, log);
  }
}
