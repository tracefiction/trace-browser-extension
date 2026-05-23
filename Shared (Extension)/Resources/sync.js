// sync.js — Trace web/app bridge.
// Runs only on Trace origins so the signed-in web app can pass the Trace API token to the extension.
// Forwards library invalidation messages back to the Trace page so the app can refresh local views.
// Does not run on AO3/FFN and does not receive AO3/FFN credentials or cookies.
const ext = typeof browser !== "undefined" ? browser : chrome;
const STATUS_REQUEST_MESSAGE = "TRACE_EXTENSION_STATUS_REQUEST";
const STATUS_QUERY_MESSAGE = "TRACE_EXTENSION_STATUS_QUERY";
const STATUS_RESPONSE_MESSAGE = "TRACE_EXTENSION_STATUS_RESPONSE";
const STATUS_AUTH_STATES = new Set([
  "connected",
  "signed_out",
  "reconnect_required",
  "error",
  "unknown",
]);
const BROWSER_KINDS = new Set(["chrome", "firefox", "safari", "unknown"]);

function isTransientRuntimeMessageError(error) {
  const parts = [
    typeof error === "string" ? error : "",
    error && error.message,
    error && typeof error.toString === "function" ? error.toString() : "",
    ext && ext.runtime && ext.runtime.lastError && ext.runtime.lastError.message,
  ];
  const message = parts.filter(Boolean).join("\n");
  return /tab not found|receiving end does not exist|extension context invalidated|message port closed/i.test(
    message,
  );
}

function reportRuntimeMessageError(label, error) {
  if (isTransientRuntimeMessageError(error)) return;
  console.error(label, error);
}

function sendRuntimeMessage(message, errorLabel) {
  try {
    const maybePromise = ext.runtime.sendMessage(message);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch((error) => reportRuntimeMessageError(errorLabel, error));
    }
  } catch (error) {
    reportRuntimeMessageError(errorLabel, error);
  }
}

function safeStatusState() {
  return {
    installed: true,
    connected: false,
    authState: "unknown",
  };
}

function sanitizeStatusState(raw) {
  const input =
    raw && raw.state && typeof raw.state === "object" ? raw.state : raw;
  if (!input || typeof input !== "object") {
    return safeStatusState();
  }

  const authState = STATUS_AUTH_STATES.has(input.authState)
    ? input.authState
    : "unknown";
  const state = {
    installed: true,
    connected: input.connected === true && authState === "connected",
    authState,
  };
  if (typeof input.lastTokenSyncAt === "number" && Number.isFinite(input.lastTokenSyncAt)) {
    state.lastTokenSyncAt = Math.trunc(input.lastTokenSyncAt);
  }
  if (typeof input.firstSaveSeen === "boolean") {
    state.firstSaveSeen = input.firstSaveSeen;
  }
  if (BROWSER_KINDS.has(input.browserKind)) {
    state.browserKind = input.browserKind;
  }
  return state;
}

function requestRuntimeMessage(message, errorLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      if (typeof browser !== "undefined" && ext === browser) {
        const maybePromise = ext.runtime.sendMessage(message);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(finish).catch((error) => {
            reportRuntimeMessageError(errorLabel, error);
            finish(null);
          });
        } else {
          finish(maybePromise || null);
        }
        return;
      }

      const maybePromise = ext.runtime.sendMessage(message, (response) => {
        if (ext.runtime.lastError) {
          reportRuntimeMessageError(errorLabel, ext.runtime.lastError);
          finish(null);
          return;
        }
        finish(response);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(finish).catch((error) => {
          reportRuntimeMessageError(errorLabel, error);
          finish(null);
        });
      }
    } catch (error) {
      reportRuntimeMessageError(errorLabel, error);
      finish(null);
    }
  });
}

async function handleStatusRequest(data) {
  const nonce = typeof data.nonce === "string" ? data.nonce : "";
  if (!nonce.trim()) return;

  const response = await requestRuntimeMessage(
    {
      type: STATUS_QUERY_MESSAGE,
      nonce,
    },
    "[Trace Sync] Failed to query extension status",
  );
  window.postMessage(
    {
      type: STATUS_RESPONSE_MESSAGE,
      nonce,
      state: sanitizeStatusState(response),
    },
    window.location.origin,
  );
}

window.addEventListener("message", (event) => {
  // Do not require `event.source === window`. Safari Web Extension content scripts
  // can see a different `window` identity than `MessageEvent.source` for same-tab
  // `window.postMessage(...)` from the page, which would drop the token silently.
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === STATUS_REQUEST_MESSAGE) {
    void handleStatusRequest(event.data);
    return;
  }
  if (event.data?.type !== "TRACE_FICTION_TOKEN") return;

  const token = typeof event.data.token === "string" ? event.data.token : null;

  sendRuntimeMessage(
    {
      type: "TRACE_AUTH_UPDATE",
      token,
    },
    "[Trace Sync] Failed to update auth state",
  );
});

try {
  ext.runtime.onMessage.addListener((message) => {
    if (message?.type !== "TRACE_LIBRARY_INVALIDATED") return;
    window.postMessage(
      {
        type: "TRACE_LIBRARY_INVALIDATED",
        reason: message.reason || null,
        at: message.at || null,
      },
      window.location.origin,
    );
  });
} catch (error) {
  console.error("[Trace Sync] Failed to bind library invalidation bridge", error);
}
