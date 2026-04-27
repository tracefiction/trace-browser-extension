// sync.js — Trace web/app bridge.
// Runs only on Trace origins so the signed-in web app can pass the Trace API token to the extension.
// Forwards library invalidation messages back to the Trace page so the app can refresh local views.
// Does not run on AO3/FFN and does not receive AO3/FFN credentials or cookies.
const ext = typeof browser !== "undefined" ? browser : chrome;

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

window.addEventListener("message", (event) => {
  // Do not require `event.source === window`. Safari Web Extension content scripts
  // can see a different `window` identity than `MessageEvent.source` for same-tab
  // `window.postMessage(...)` from the page, which would drop the token silently.
  if (event.origin !== window.location.origin) return;
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
