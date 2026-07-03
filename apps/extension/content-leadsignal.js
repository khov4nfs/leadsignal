const REQUEST_TYPES = new Map([
  ['LEADSIGNAL_EXTENSION_PING', 'AUTH_PING'],
  ['LEADSIGNAL_EXTENSION_PAIR', 'PAIR_DEVICE'],
  ['LEADSIGNAL_EXTENSION_AUTH', 'AUTHENTICATE'],
  ['LEADSIGNAL_EXTENSION_REDDIT_SYNC', 'SYNC_REDDIT_SESSION'],
]);

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const requestType = REQUEST_TYPES.get(event.data?.type);
  if (!requestType) return;

  chrome.runtime.sendMessage(
    {
      type: requestType,
      requestId: event.data.requestId,
      payload: event.data.payload,
      pageOrigin: window.location.origin,
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError;
      const result = runtimeError
        ? { ok: false, error: runtimeError.message }
        : response ?? { ok: false, error: 'Extension did not respond' };
      const responseType =
        requestType === 'AUTH_PING'
          ? 'LEADSIGNAL_EXTENSION_PONG'
          : requestType === 'PAIR_DEVICE'
            ? 'LEADSIGNAL_EXTENSION_PAIR_RESULT'
            : requestType === 'SYNC_REDDIT_SESSION'
              ? 'LEADSIGNAL_EXTENSION_REDDIT_SYNC_RESULT'
              : 'LEADSIGNAL_EXTENSION_AUTH_RESULT';
      window.postMessage(
        {
          type: responseType,
          requestId: event.data.requestId,
          ...result,
        },
        window.location.origin,
      );
    },
  );
});
