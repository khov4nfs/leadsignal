if (typeof lsGetConfig === 'undefined' || typeof lsEnsureKeyPair === 'undefined') {
  importScripts('crypto.js', 'api.js');
}

let redditSyncTimer;

chrome.runtime.onInstalled.addListener(() => {
  lsEnsureKeyPair().catch(() => undefined);
  lsGetConfig().then((config) => lsRegisterAppOrigin(config.appOrigin)).catch(() => undefined);
  scheduleRedditSessionSync(1_000);
});

chrome.runtime.onStartup.addListener(() => {
  lsGetConfig().then((config) => lsRegisterAppOrigin(config.appOrigin)).catch(() => undefined);
  scheduleRedditSessionSync(1_000);
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  const domain = String(changeInfo.cookie?.domain || '').replace(/^\./, '');
  if (domain === 'reddit.com' || domain.endsWith('.reddit.com')) {
    scheduleRedditSessionSync(1_500);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case 'AUTH_PING':
      return getState();
    case 'PAIR_DEVICE':
      return pairDevice(message.payload || {});
    case 'AUTHENTICATE':
      return authenticateDevice();
    case 'SYNC_REDDIT_SESSION':
      return syncRedditSession();
    case 'GET_STATE':
      return { ok: true, state: (await getState()).state, config: await lsGetConfig() };
    case 'SAVE_CONFIG':
      return { ok: true, config: await lsSaveConfig(message.payload || {}) };
    default:
      return { ok: false, error: 'Unsupported extension message' };
  }
}

async function getState() {
  const stored = await chrome.storage.local.get([
    LS_KEYS.deviceId,
    LS_KEYS.workspaceId,
    LS_KEYS.publicKey,
    'redditSessionSyncedAt',
    'redditSessionSyncError',
  ]);
  return {
    ok: true,
    state: {
      installed: true,
      paired: Boolean(stored[LS_KEYS.deviceId]),
      deviceId: stored[LS_KEYS.deviceId],
      workspaceId: stored[LS_KEYS.workspaceId],
      hasKey: Boolean(stored[LS_KEYS.publicKey]),
      redditSessionSyncedAt: stored.redditSessionSyncedAt,
      redditSessionSyncError: stored.redditSessionSyncError,
      version: chrome.runtime.getManifest().version,
      executionMode: 'BACKEND_ONLY',
    },
  };
}

async function pairDevice(payload) {
  const pairingCode = String(payload.pairingCode || '').trim();
  if (!pairingCode) throw new Error('Pairing code is required');
  const { publicKeyJwk } = await lsEnsureKeyPair();
  const config = await lsGetConfig();
  const result = await lsApiFetch(config, '/auth/extension/pair', {
    method: 'POST',
    body: JSON.stringify({
      pairingCode,
      publicKeyJwk,
      deviceLabel: String(payload.deviceLabel || 'LeadSignal Extension').slice(0, 120),
      displayName: payload.displayName
        ? String(payload.displayName).slice(0, 100)
        : undefined,
    }),
  });
  await chrome.storage.local.set({
    [LS_KEYS.deviceId]: result.deviceId,
    [LS_KEYS.workspaceId]: result.workspaceId,
  });
  const redditSession = await syncRedditSession().catch(async (error) => {
    const message = error.message || String(error);
    console.error('[LeadSignal] Reddit session sync failed after pairing', error);
    await chrome.storage.local.set({ redditSessionSyncError: message });
    return { ok: false, error: message };
  });
  return {
    ok: true,
    deviceId: result.deviceId,
    workspaceId: result.workspaceId,
    redditSession,
  };
}

async function createDeviceTicket() {
  const stored = await chrome.storage.local.get(LS_KEYS.deviceId);
  const deviceId = stored[LS_KEYS.deviceId];
  if (!deviceId) throw new Error('Extension has not been paired');
  const config = await lsGetConfig();
  const challenge = await lsApiFetch(config, '/auth/extension/challenge', {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  });
  const proof = await lsSignText(challenge.message);
  const verified = await lsApiFetch(config, '/auth/extension/verify', {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      proof,
    }),
  });
  return verified.ticket;
}

async function authenticateDevice() {
  const ticket = await createDeviceTicket();
  const redditSession = await syncRedditSession().catch(async (error) => {
    const message = error.message || String(error);
    console.error('[LeadSignal] Reddit session sync failed during authentication', error);
    await chrome.storage.local.set({ redditSessionSyncError: message });
    return { ok: false, error: message };
  });
  return { ok: true, ticket, redditSession };
}

async function getRedditCookies() {
  if (!chrome.cookies || typeof chrome.cookies.getAll !== 'function') {
    throw new Error(
      'Reddit cookie permission is unavailable. Reload LeadSignal Extension 1.3.2 and accept access to reddit.com.',
    );
  }

  const byDomain = await chrome.cookies.getAll({ domain: 'reddit.com' });
  const byUrl = await chrome.cookies.getAll({ url: 'https://www.reddit.com/' });
  const unique = new Map();
  for (const cookie of [...byDomain, ...byUrl]) {
    unique.set(`${cookie.storeId || '0'}:${cookie.domain}:${cookie.path}:${cookie.name}`, cookie);
  }
  return [...unique.values()];
}

function getBrowserMetadata() {
  const userAgent = String(globalThis.navigator?.userAgent || '');
  const engine = /firefox\//i.test(userAgent) ? 'firefox' : 'chromium';
  return {
    engine,
    userAgent,
    language: String(globalThis.navigator?.language || ''),
    platform: String(globalThis.navigator?.platform || ''),
  };
}

async function syncRedditSession() {
  const stored = await chrome.storage.local.get(LS_KEYS.deviceId);
  if (!stored[LS_KEYS.deviceId]) {
    const error = 'Extension has not been paired';
    await chrome.storage.local.set({ redditSessionSyncError: error });
    return { ok: false, skipped: true, error };
  }

  const cookies = await getRedditCookies();
  const authenticated = cookies.filter((cookie) => cookie.value && cookie.name);
  if (authenticated.length === 0) {
    const error = 'No existing Reddit browser session was found';
    await chrome.storage.local.set({ redditSessionSyncError: error });
    return { ok: false, skipped: true, error };
  }

  const ticket = await createDeviceTicket();
  const config = await lsGetConfig();
  const browser = getBrowserMetadata();
  const result = await lsApiFetch(config, '/auth/extension/reddit-session', {
    method: 'POST',
    body: JSON.stringify({
      ticket,
      browser,
      cookies: authenticated.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expires: cookie.expirationDate,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      })),
    }),
  });

  await chrome.storage.local.set({
    redditSessionSyncedAt: result.syncedAt,
    redditSessionSyncError: null,
  });
  console.info('[LeadSignal] Reddit session synchronized', {
    cookieCount: result.cookieCount,
    browserEngine: result.browserEngine || browser.engine,
    syncedAt: result.syncedAt,
  });
  return result;
}

function scheduleRedditSessionSync(delayMs = 1_000) {
  clearTimeout(redditSyncTimer);
  redditSyncTimer = setTimeout(() => {
    syncRedditSession().catch(async (error) => {
      console.error('[LeadSignal] Scheduled Reddit session sync failed', error);
      await chrome.storage.local.set({
        redditSessionSyncError: error.message || String(error),
      });
    });
  }, delayMs);
}
