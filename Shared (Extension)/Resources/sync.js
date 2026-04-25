// sync.js — Trace web/app bridge.
// Runs only on Trace origins so the signed-in web app can pass the Trace API token to the extension.
// Forwards library invalidation messages back to the Trace page so the app can refresh local views.
// Does not run on AO3/FFN and does not receive AO3/FFN credentials or cookies.
const ext = typeof browser !== "undefined" ? browser : chrome;

window.addEventListener("message", (event) => {
  // Do not require `event.source === window`. Safari Web Extension content scripts
  // can see a different `window` identity than `MessageEvent.source` for same-tab
  // `window.postMessage(...)` from the page, which would drop the token silently.
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "TRACE_FICTION_TOKEN") return;

  const token = typeof event.data.token === "string" ? event.data.token : null;

  try {
    ext.runtime.sendMessage({
      type: "TRACE_AUTH_UPDATE",
      token,
    });
  } catch (error) {
    console.error("[Trace Sync] Failed to update auth state", error);
  }
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
