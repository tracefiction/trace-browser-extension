// sync.js — Trace web/app bridge.
// Runs only on Trace origins so the signed-in web app can pass the Trace API token to the extension.
// Forwards library invalidation messages back to the Trace page so the app can refresh local views.
// Does not run on AO3/FFN and does not receive AO3/FFN credentials or cookies.
const ext = typeof browser !== "undefined" ? browser : chrome;
const STATUS_REQUEST_MESSAGE = "TRACE_EXTENSION_STATUS_REQUEST";
const STATUS_QUERY_MESSAGE = "TRACE_EXTENSION_STATUS_QUERY";
const STATUS_RESPONSE_MESSAGE = "TRACE_EXTENSION_STATUS_RESPONSE";
const TOKEN_MESSAGE = "TRACE_FICTION_TOKEN";
const TOKEN_REQUEST_MESSAGE = "TRACE_FICTION_TOKEN_REQUEST";
const STATUS_AUTH_STATES = new Set([
  "connected",
  "signed_out",
  "reconnect_required",
  "error",
  "unknown",
]);
const BROWSER_KINDS = new Set(["chrome", "firefox", "safari", "unknown"]);
const ARCHIVE_HOST_KINDS = new Set(["ao3", "ffn", "unknown"]);
const ARCHIVE_ACTION_KINDS = new Set([
  "track",
  "quick_add",
  "import",
  "metadata",
  "unknown",
]);
const ARCHIVE_ERROR_KINDS = new Set([
  "permission",
  "unsupported_page",
  "auth",
  "parser",
  "network",
  "unknown",
]);

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

function requestTraceToken(reason) {
  window.postMessage(
    {
      type: TOKEN_REQUEST_MESSAGE,
      reason,
      at: Date.now(),
    },
    window.location.origin,
  );
}

function requestTraceTokenIfVisible(reason) {
  if (document.visibilityState === "hidden") return;
  requestTraceToken(reason);
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
  if (
    typeof input.lastArchiveSeenAt === "number" &&
    Number.isFinite(input.lastArchiveSeenAt)
  ) {
    state.lastArchiveSeenAt = Math.trunc(input.lastArchiveSeenAt);
  }
  if (ARCHIVE_HOST_KINDS.has(input.lastArchiveHostKind)) {
    state.lastArchiveHostKind = input.lastArchiveHostKind;
  }
  if (
    typeof input.lastArchiveActionAt === "number" &&
    Number.isFinite(input.lastArchiveActionAt)
  ) {
    state.lastArchiveActionAt = Math.trunc(input.lastArchiveActionAt);
  }
  if (ARCHIVE_ACTION_KINDS.has(input.lastArchiveActionKind)) {
    state.lastArchiveActionKind = input.lastArchiveActionKind;
  }
  if (ARCHIVE_ERROR_KINDS.has(input.lastArchiveErrorKind)) {
    state.lastArchiveErrorKind = input.lastArchiveErrorKind;
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
  if (event.data?.type !== TOKEN_MESSAGE) return;

  const token = typeof event.data.token === "string" ? event.data.token : null;

  sendRuntimeMessage(
    {
      type: "TRACE_AUTH_UPDATE",
      token,
    },
    "[Trace Sync] Failed to update auth state",
  );
});

requestTraceTokenIfVisible("sync_ready");
window.addEventListener("pageshow", () => {
  requestTraceTokenIfVisible("pageshow");
});
window.addEventListener("focus", () => {
  requestTraceTokenIfVisible("focus");
});
document.addEventListener("visibilitychange", () => {
  requestTraceTokenIfVisible("visibilitychange");
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
