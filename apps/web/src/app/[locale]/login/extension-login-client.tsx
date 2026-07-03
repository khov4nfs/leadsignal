'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  createExtensionPairingCodeAction,
  getExtensionSessionStateAction,
} from '../auth-actions';
import { exchangeExtensionTicketAction } from './extension-login-actions';

const FLOW_LOCK_KEY = 'ls_extension_login_flow_started_at';
const FLOW_LOCK_TTL_MS = 15_000;
const MIN_EXTENSION_VERSION = '1.3.1';

type ExtensionState = {
  installed: boolean;
  paired: boolean;
  deviceId?: string;
  workspaceId?: string;
  version?: string;
  redditSessionSyncedAt?: string;
  redditSessionSyncError?: string;
};

type SessionState = {
  authenticated: boolean;
  workspaceId: string | null;
};

type RedditSessionResult = {
  ok?: boolean;
  skipped?: boolean;
  error?: string;
  syncedAt?: string;
  cookieCount?: number;
};

type ExtensionMessage = {
  type?: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  ticket?: string;
  state?: ExtensionState;
  deviceId?: string;
  workspaceId?: string;
  redditSession?: RedditSessionResult;
  syncedAt?: string;
  cookieCount?: number;
};

function versionAtLeast(current: string | undefined, minimum: string): boolean {
  if (!current) return false;
  const left = current.split('.').map((part) => Number(part) || 0);
  const right = minimum.split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function acquireFlowLock() {
  const now = Date.now();
  const startedAt = Number(sessionStorage.getItem(FLOW_LOCK_KEY) ?? 0);
  if (startedAt && now - startedAt < FLOW_LOCK_TTL_MS) return false;
  sessionStorage.setItem(FLOW_LOCK_KEY, String(now));
  return true;
}

function releaseFlowLock() {
  sessionStorage.removeItem(FLOW_LOCK_KEY);
}

function requestRedditSync(): Promise<RedditSessionResult> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve({ ok: false, error: 'Extension did not respond to Reddit session sync.' });
    }, 10_000);

    function onMessage(event: MessageEvent<ExtensionMessage>) {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        event.data?.type !== 'LEADSIGNAL_EXTENSION_REDDIT_SYNC_RESULT' ||
        event.data.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      resolve({
        ok: event.data.ok,
        error: event.data.error,
        syncedAt: event.data.syncedAt,
        cookieCount: event.data.cookieCount,
      });
    }

    window.addEventListener('message', onMessage);
    window.postMessage(
      { type: 'LEADSIGNAL_EXTENSION_REDDIT_SYNC', requestId },
      window.location.origin,
    );
  });
}

export function ExtensionLoginClient({
  locale,
  initialError,
}: {
  locale: string;
  initialError?: string;
}) {
  const [state, setState] = useState<ExtensionState>({ installed: false, paired: false });
  const [session, setSession] = useState<SessionState | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [error, setError] = useState(initialError ? decodeURIComponent(initialError) : '');
  const autoStartedRef = useRef(false);
  const exchangeInFlightRef = useRef(false);

  function handleFlowError(message: string) {
    autoStartedRef.current = false;
    exchangeInFlightRef.current = false;
    releaseFlowLock();
    setBusy(false);

    if (message.toLowerCase().includes('rate limit')) {
      setError('Đã gửi quá nhiều yêu cầu. Hãy chờ khoảng 60 giây rồi thử lại.');
      setCooldown(true);
      window.setTimeout(() => setCooldown(false), 60_000);
      return;
    }

    setError(message);
  }

  function requestAuthentication() {
    setBusy(true);
    setError('');
    window.postMessage(
      { type: 'LEADSIGNAL_EXTENSION_AUTH', requestId: crypto.randomUUID() },
      window.location.origin,
    );
  }

  async function pairFromCurrentSession() {
    setBusy(true);
    setError('');
    const result = await createExtensionPairingCodeAction();
    if (!result.ok || !result.pairingCode) {
      handleFlowError(result.error ?? 'Không thể ghép nối extension.');
      return;
    }

    window.postMessage(
      {
        type: 'LEADSIGNAL_EXTENSION_PAIR',
        requestId: crypto.randomUUID(),
        payload: {
          pairingCode: result.pairingCode,
          deviceLabel: `${navigator.platform || 'Browser'} LeadSignal Extension`,
        },
      },
      window.location.origin,
    );
  }

  function startAutomaticFlow(current: ExtensionState, currentSession: SessionState) {
    if (autoStartedRef.current) return;
    if (!currentSession.authenticated || !currentSession.workspaceId) return;
    if (!versionAtLeast(current.version, MIN_EXTENSION_VERSION)) return;
    if (!acquireFlowLock()) return;

    autoStartedRef.current = true;
    if (current.paired) requestAuthentication();
    else void pairFromCurrentSession();
  }

  useEffect(() => {
    let detected = false;
    let currentSession: SessionState | null = null;

    const onMessage = async (event: MessageEvent<ExtensionMessage>) => {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        !event.data?.type
      ) {
        return;
      }
      const message = event.data;

      if (message.type === 'LEADSIGNAL_EXTENSION_PONG') {
        detected = true;
        const nextState = {
          installed: true,
          paired: Boolean(message.state?.paired),
          ...message.state,
        } as ExtensionState;
        setState(nextState);
        setChecking(false);

        if (!versionAtLeast(nextState.version, MIN_EXTENSION_VERSION)) {
          setError(
            `LeadSignal Extension ${nextState.version ?? 'không xác định'} đã cũ. Hãy reload extension ${MIN_EXTENSION_VERSION} tại chrome://extensions rồi reload trang này.`,
          );
          return;
        }
        if (nextState.redditSessionSyncError) {
          setError(`Reddit session chưa đồng bộ: ${nextState.redditSessionSyncError}`);
        }
        if (currentSession) startAutomaticFlow(nextState, currentSession);
        return;
      }

      if (message.type === 'LEADSIGNAL_EXTENSION_PAIR_RESULT') {
        if (!message.ok) {
          handleFlowError(message.error ?? 'Không thể ghép nối extension.');
          return;
        }
        setState((current) => ({
          ...current,
          installed: true,
          paired: true,
          deviceId: message.deviceId,
          workspaceId: message.workspaceId,
        }));
        requestAuthentication();
        return;
      }

      if (message.type === 'LEADSIGNAL_EXTENSION_AUTH_RESULT') {
        if (!message.ok || !message.ticket) {
          handleFlowError(message.error ?? 'Extension không thể xác thực thiết bị.');
          return;
        }
        if (exchangeInFlightRef.current) return;

        exchangeInFlightRef.current = true;
        setBusy(true);
        const result = await exchangeExtensionTicketAction(message.ticket);
        if (!result.ok) {
          handleFlowError(result.error);
          return;
        }

        let redditSession = message.redditSession;
        if (!redditSession?.ok) {
          redditSession = await requestRedditSync();
        }
        if (!redditSession.ok) {
          handleFlowError(
            `Reddit session chưa đồng bộ: ${redditSession.error ?? 'Không đọc được phiên đăng nhập Reddit hiện tại.'}`,
          );
          return;
        }

        setState((current) => ({
          ...current,
          redditSessionSyncedAt: redditSession.syncedAt,
          redditSessionSyncError: undefined,
        }));
        releaseFlowLock();
        window.location.replace(`/${locale}`);
      }
    };

    window.addEventListener('message', onMessage);

    void getExtensionSessionStateAction().then((value) => {
      currentSession = value;
      setSession(value);
      window.postMessage(
        { type: 'LEADSIGNAL_EXTENSION_PING', requestId: crypto.randomUUID() },
        window.location.origin,
      );
    });

    const timeout = window.setTimeout(() => {
      if (!detected) {
        setChecking(false);
        setState({ installed: false, paired: false });
      }
    }, 2500);

    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
  }, [locale]);

  function retry() {
    if (!session?.authenticated || !session.workspaceId || cooldown || busy) return;
    releaseFlowLock();
    autoStartedRef.current = false;
    exchangeInFlightRef.current = false;
    startAutomaticFlow(state, session);
  }

  const needsAccount = session !== null && !session.authenticated;
  const needsWorkspace = session?.authenticated && !session.workspaceId;

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Kết nối LeadSignal Extension</h1>
        <p className="mt-2 text-slate-400">
          Tạo hoặc đăng nhập tài khoản LeadSignal trước. Sau đó hệ thống sẽ tự ghép nối extension bằng phiên đăng nhập hiện tại.
        </p>
      </div>

      {error && !needsAccount && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="panel space-y-4 p-6">
        {checking || session === null ? (
          <p className="text-sm text-slate-300">Đang kiểm tra tài khoản và extension…</p>
        ) : needsAccount ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4">
              <p className="font-medium text-amber-200">Bạn chưa có phiên đăng nhập LeadSignal</p>
              <p className="mt-2 text-sm text-amber-100/80">
                Extension không tạo tài khoản độc lập. Hãy tạo tài khoản trước, hệ thống sẽ quay lại đây và tự động ghép nối.
              </p>
            </div>
            <Link
              href={`/${locale}/register`}
              className="block w-full rounded-lg bg-violet-600 px-4 py-2 text-center font-medium hover:bg-violet-500"
            >
              Tạo tài khoản
            </Link>
          </div>
        ) : needsWorkspace ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4 text-sm text-amber-100">
              Tài khoản đã đăng nhập nhưng chưa có workspace. Hãy hoàn tất đăng ký workspace hoặc tham gia bằng lời mời trước khi ghép nối extension.
            </div>
          </div>
        ) : !state.installed ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4">
              <p className="font-medium text-amber-200">Chưa phát hiện LeadSignal Extension</p>
              <p className="mt-2 text-sm text-amber-100/80">
                Cài hoặc reload extension, sau đó reload lại trang này.
              </p>
            </div>
            <Link
              href={`/${locale}/extension`}
              className="block w-full rounded-lg bg-violet-600 px-4 py-2 text-center font-medium"
            >
              Mở hướng dẫn extension
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 p-4 text-sm text-emerald-200">
              {state.paired
                ? 'Extension đã ghép nối. Đang xác thực thiết bị và đồng bộ Reddit session…'
                : 'Đã phát hiện extension. Đang tự động ghép nối với tài khoản hiện tại…'}
            </div>
            <p className="text-xs text-slate-500">
              Extension {state.version ?? 'unknown'} · yêu cầu tối thiểu {MIN_EXTENSION_VERSION}
            </p>
            <button
              type="button"
              disabled={busy || cooldown || !versionAtLeast(state.version, MIN_EXTENSION_VERSION)}
              onClick={retry}
              className="w-full rounded-lg bg-violet-600 px-4 py-2 font-medium disabled:opacity-50"
            >
              {busy ? 'Đang xử lý…' : cooldown ? 'Chờ 60 giây' : 'Thử lại'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
