import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext, Cookie } from 'playwright';
import { CryptoService } from '../crypto/crypto.service';
import { resolveRedditRuntimePath } from './reddit-runtime-path';

export interface RedditSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface RedditBrowserMetadata {
  engine?: 'chromium' | 'firefox';
  userAgent?: string;
  language?: string;
  platform?: string;
}

interface StoredRedditSession {
  version: 1 | 2;
  workspaceId: string;
  deviceId: string;
  syncedAt: string;
  encrypted: string;
  iv: string;
  authTag: string;
}

interface RedditSessionPayload {
  cookies: RedditSessionCookie[];
  browser?: RedditBrowserMetadata;
}

export function redditSessionFilePath(): string {
  return resolveRedditRuntimePath(
    process.env.REDDIT_SESSION_FILE,
    '.runtime/reddit-session.json',
  );
}

function normalizePayload(value: unknown): RedditSessionPayload {
  if (Array.isArray(value)) {
    return { cookies: value as RedditSessionCookie[] };
  }

  if (value && typeof value === 'object') {
    const candidate = value as Partial<RedditSessionPayload>;
    return {
      cookies: Array.isArray(candidate.cookies) ? candidate.cookies : [],
      browser:
        candidate.browser && typeof candidate.browser === 'object'
          ? candidate.browser
          : undefined,
    };
  }

  return { cookies: [] };
}

async function readStoredSession(
  crypto: CryptoService,
): Promise<{
  record: StoredRedditSession;
  payload: RedditSessionPayload;
} | null> {
  const path = redditSessionFilePath();
  let record: StoredRedditSession;
  try {
    record = JSON.parse(await readFile(path, 'utf8')) as StoredRedditSession;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[reddit-session] synchronized session file not found', {
        path,
        cwd: process.cwd(),
      });
      return null;
    }
    throw error;
  }

  const decrypted = JSON.parse(
    crypto.decrypt(record.encrypted, record.iv, record.authTag),
  ) as unknown;
  return { record, payload: normalizePayload(decrypted) };
}

export async function saveRedditSession(
  crypto: CryptoService,
  input: {
    workspaceId: string;
    deviceId: string;
    cookies: RedditSessionCookie[];
    browser?: RedditBrowserMetadata;
  },
): Promise<{ syncedAt: string; cookieCount: number }> {
  const syncedAt = new Date().toISOString();
  const payload = crypto.encrypt(
    JSON.stringify({
      cookies: input.cookies,
      browser: input.browser,
    } satisfies RedditSessionPayload),
  );
  const record: StoredRedditSession = {
    version: 2,
    workspaceId: input.workspaceId,
    deviceId: input.deviceId,
    syncedAt,
    ...payload,
  };
  const path = redditSessionFilePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
  console.info('[reddit-session] synchronized session saved', {
    path,
    workspaceId: input.workspaceId,
    cookieCount: input.cookies.length,
    browserEngine: input.browser?.engine,
    syncedAt,
  });
  return { syncedAt, cookieCount: input.cookies.length };
}

export async function readSyncedRedditBrowserMetadata(
  crypto = new CryptoService(),
): Promise<RedditBrowserMetadata | undefined> {
  const session = await readStoredSession(crypto);
  return session?.payload.browser;
}

export async function applySyncedRedditSession(
  context: BrowserContext,
  crypto = new CryptoService(),
): Promise<boolean> {
  const path = redditSessionFilePath();
  const session = await readStoredSession(crypto);
  if (!session) return false;

  const { record, payload } = session;
  const nowSeconds = Date.now() / 1000;
  const usable = payload.cookies
    .filter((cookie) => cookie.name && cookie.value)
    .filter((cookie) => !cookie.expires || cookie.expires > nowSeconds)
    .map((cookie): Cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '.reddit.com',
      path: cookie.path || '/',
      expires: cookie.expires ?? -1,
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false,
      sameSite: cookie.sameSite ?? 'Lax',
    }));

  if (usable.length === 0) {
    console.warn('[reddit-session] synchronized session has no usable cookies', {
      path,
      syncedAt: record.syncedAt,
    });
    return false;
  }

  await context.addCookies(usable);
  console.info('[reddit-session] synchronized session loaded', {
    path,
    workspaceId: record.workspaceId,
    cookieCount: usable.length,
    browserEngine: payload.browser?.engine,
    syncedAt: record.syncedAt,
  });
  return true;
}
