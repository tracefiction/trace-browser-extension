// sync.js — Trace web/app bridge.
// Runs only on Trace origins so the signed-in web app can pass the Trace API token to the extension.
// Forwards library invalidation messages back to the Trace page so the app can refresh local views.
// Does not run on AO3/FFN and does not receive AO3/FFN credentials or cookies.
const ext = typeof browser !== "undefined" ? browser : chrome;
const STATUS_REQUEST_MESSAGE = "TRACE_EXTENSION_STATUS_REQUEST";
const STATUS_QUERY_MESSAGE = "TRACE_EXTENSION_STATUS_QUERY";
const STATUS_RESPONSE_MESSAGE = "TRACE_EXTENSION_STATUS_RESPONSE";
// Announces this content script to the page. The web app requests status on
// mount, which can happen before this script is injected; the announce lets it
// re-request instead of concluding the extension is missing.
const STATUS_READY_MESSAGE = "TRACE_EXTENSION_STATUS_READY";
// Background -> content script push when auth state settles.
const STATUS_PUSH_MESSAGE = "TRACE_EXTENSION_STATUS_PUSH";
// Content script -> page forward of a pushed status.
const STATUS_UPDATE_MESSAGE = "TRACE_EXTENSION_STATUS_UPDATE";
const TOKEN_MESSAGE = "TRACE_FICTION_TOKEN";
const TOKEN_REQUEST_MESSAGE = "TRACE_FICTION_TOKEN_REQUEST";
const FIRST_STORY_ADD_REQUEST_MESSAGE = "TRACE_FIRST_STORY_ADD_REQUEST";
const FIRST_STORY_ADD_MESSAGE = "TRACE_FIRST_STORY_ADD";
const FIRST_STORY_ADD_RESPONSE_MESSAGE = "TRACE_FIRST_STORY_ADD_RESPONSE";
const CREDENTIAL_GRANT_REQUEST_MESSAGE = "TRACE_CREDENTIAL_GRANT_REQUEST";
const SESSION_ACTION_MESSAGE = "TRACE_SESSION_ACTION";
// Content-free hint that this Trace page is signed in. The background uses
// it only to finish a connect the reader already asked for.
const TRACE_WEB_READY_MESSAGE = "TRACE_WEB_READY";
const FIRST_INSTALL_READY_MESSAGE = "TRACE_EXTENSION_FIRST_INSTALL_READY";
// Trace's setup page asks a small fixed set of questions about story-site
// access and open story tabs. See the setup section below.
const SETUP_REQUEST_MESSAGE = "TRACE_SETUP_REQUEST";
const SETUP_RESPONSE_MESSAGE = "TRACE_SETUP_RESPONSE";
const SETUP_ACCESS_CHANGED_MESSAGE = "TRACE_SETUP_ACCESS_CHANGED";
// Content script <-> background forms of the same.
const SETUP_PAGE_MESSAGE = "TRACE_SETUP_PAGE_REQUEST";
const SETUP_ACCESS_PUSH_MESSAGE = "TRACE_SETUP_ACCESS_PUSH";
const SETUP_REQUESTS = new Set(["access", "story-tabs", "switch-to-tab"]);
const SETUP_SCOPES = new Set(["all", "story-sites", "this-site"]);
const SETUP_SITES = new Set(["ao3", "ffn"]);
const SETUP_ERRORS = new Set([
  "forbidden",
  "invalid_request",
  "unknown_request",
  "rate_limited",
  "unavailable",
  "not_listed",
  "not_allowed",
  "not_a_story",
  "switch_failed",
]);
const SETUP_ID_MAX_LENGTH = 64;
const SETUP_STORY_TAB_LIMIT = 5;
const SETUP_TAB_TITLE_MAX_LENGTH = 120;
// A page that asks faster than this is answered here, without waking the background.
const SETUP_REQUEST_LIMIT = 20;
const SETUP_REQUEST_WINDOW_MS = 10_000;
const setupRequestTimes = [];
const FIRST_INSTALL_ACTIVATION = "extension-installed";
const SESSION_MODE = globalThis.TRACE_SESSION_MODE || "legacy";
const KERNEL_SESSION_ACTIVE = SESSION_MODE === "kernel";
const pendingCredentialGrants = new Map();
let activationSessionRequest = null;
let activationSessionConnected = false;
let activationNonceSequence = 0;
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
const FIRST_STORY_ADD_STATES = new Set(["opened", "saved", "already_saved"]);
const FIRST_STORY_ADD_ERRORS = new Set([
  "not_authenticated",
  "invalid_url",
  "no_active_tab",
  "unsupported_page",
  "permission_required",
  "collect_failed",
  "open_failed",
  "save_failed",
  "free_limit_reached",
  "auth_expired",
  "rate_limited",
  "unavailable",
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

function requestTraceToken(reason, requestId) {
  window.postMessage(
    {
      type: TOKEN_REQUEST_MESSAGE,
      reason,
      at: Date.now(),
      ...(requestId
        ? { protocolVersion: 1, requestId }
        : {}),
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

function isFirstInstallActivationPage() {
  try {
    const url = new window.URL(window.location.href);
    return (
      url.pathname === "/" &&
      url.searchParams.get("activation") === FIRST_INSTALL_ACTIVATION
    );
  } catch {
    return false;
  }
}

// A kernel session is command-led: the Trace page never pushes an ambient
// credential into it. The authenticated activation page's first status
// handshake is the readiness signal for one explicit Connect/Reconnect action.
async function ensureFirstInstallSession(state) {
  if (
    !KERNEL_SESSION_ACTIVE ||
    activationSessionConnected ||
    activationSessionRequest ||
    !isFirstInstallActivationPage()
  ) {
    return;
  }
  const action =
    state?.authState === "signed_out"
      ? "connect"
      : state?.authState === "reconnect_required"
        ? "reconnect"
        : null;
  if (!action) return;

  const request = requestRuntimeMessage(
    { type: SESSION_ACTION_MESSAGE, action },
    "[Trace Sync] Failed to activate the first-install session",
  );
  activationSessionRequest = request;
  const response = await request;
  if (activationSessionRequest !== request) return;
  activationSessionRequest = null;
  activationSessionConnected = response?.snapshot?.state === "connected";
}

async function handleFirstInstallReady(data) {
  if (
    !KERNEL_SESSION_ACTIVE ||
    !isFirstInstallActivationPage() ||
    data.protocolVersion !== 1 ||
    Object.keys(data).length !== 2
  ) {
    return;
  }
  activationNonceSequence += 1;
  const nonce = `first-install-${Date.now().toString(36)}-${activationNonceSequence.toString(36)}`;
  const response = await requestRuntimeMessage(
    {
      type: STATUS_QUERY_MESSAGE,
      nonce,
    },
    "[Trace Sync] Failed to query first-install session status",
  );
  await ensureFirstInstallSession(sanitizeStatusState(response));
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
    input.capabilities &&
    typeof input.capabilities === "object" &&
    input.capabilities.firstStoryAdd === true
  ) {
    state.capabilities = { firstStoryAdd: true };
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

function sanitizeFirstStoryAddResponse(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "extension_unavailable" };
  }
  if (raw.ok === true) {
    const state = FIRST_STORY_ADD_STATES.has(raw.state) ? raw.state : "saved";
    return { ok: true, state };
  }
  const error = FIRST_STORY_ADD_ERRORS.has(raw.error)
    ? raw.error
    : "unknown_error";
  return { ok: false, error };
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
  const state = sanitizeStatusState(response);
  window.postMessage(
    {
      type: STATUS_RESPONSE_MESSAGE,
      nonce,
      state,
    },
    window.location.origin,
  );
  void ensureFirstInstallSession(state);
}

async function handleFirstStoryAddRequest(data) {
  const nonce = typeof data.nonce === "string" ? data.nonce : "";
  const url = typeof data.url === "string" ? data.url : "";
  if (!nonce.trim() || !url.trim()) return;

  const response = await requestRuntimeMessage(
    {
      type: FIRST_STORY_ADD_MESSAGE,
      nonce,
      url,
    },
    "[Trace Sync] Failed to add first story",
  );
  window.postMessage(
    {
      type: FIRST_STORY_ADD_RESPONSE_MESSAGE,
      nonce,
      ...sanitizeFirstStoryAddResponse(response),
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
  if (event.data?.type === FIRST_STORY_ADD_REQUEST_MESSAGE) {
    void handleFirstStoryAddRequest(event.data);
    return;
  }
  if (event.data?.type === FIRST_INSTALL_READY_MESSAGE) {
    void handleFirstInstallReady(event.data);
    return;
  }
  if (event.data?.type !== TOKEN_MESSAGE) return;

  const token = typeof event.data.token === "string" ? event.data.token : null;
  if (KERNEL_SESSION_ACTIVE) {
    const requestId =
      event.data.protocolVersion === 1 && typeof event.data.requestId === "string"
        ? event.data.requestId
        : "";
    if (!requestId) {
      if (token && token.trim()) handleTracePageSignedIn();
      return;
    }
    const pending = requestId ? pendingCredentialGrants.get(requestId) : null;
    if (!pending) return;
    pendingCredentialGrants.delete(requestId);
    window.clearTimeout(pending.timeout);
    pending.sendResponse({
      ok: Boolean(token && token.trim()),
      requestId,
      token: token && token.trim() ? token.trim() : null,
    });
    return;
  }

  sendRuntimeMessage(
    {
      type: "TRACE_AUTH_UPDATE",
      token,
    },
    "[Trace Sync] Failed to update auth state",
  );
});

// ---- Setup page ----
//
// Trace's own setup page may ask three things, and nothing else:
//   access         are the story sites allowed, and how broadly
//   story-tabs     the reader's open story pages (tab id, title, site)
//   switch-to-tab  bring one of those tabs to the front
// The page is an ordinary web page, so every request is checked here and
// again in the background, and every answer is rebuilt field by field. The
// page never learns an address, or anything about a tab that is not a story
// page, and it cannot make Safari ask for access.

function isTopLevelPage() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function sanitizeSetupAccess(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.storySitesAllowed !== "boolean" || !SETUP_SCOPES.has(raw.scope)) return null;
  // The two fields cannot disagree.
  if (raw.storySitesAllowed !== (raw.scope !== "this-site")) return null;
  return { storySitesAllowed: raw.storySitesAllowed, scope: raw.scope };
}

function sanitizeSetupStoryTabs(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tabs)) return null;
  const tabs = [];
  for (const tab of raw.tabs.slice(0, SETUP_STORY_TAB_LIMIT)) {
    if (
      !tab || typeof tab !== "object" ||
      !Number.isSafeInteger(tab.tabId) || tab.tabId < 0 ||
      typeof tab.title !== "string" ||
      !SETUP_SITES.has(tab.site)
    ) {
      return null;
    }
    tabs.push({
      tabId: tab.tabId,
      title: Array.from(tab.title).slice(0, SETUP_TAB_TITLE_MAX_LENGTH).join(""),
      site: tab.site,
    });
  }
  return { tabs };
}

function setupResult(request, response) {
  if (!response || typeof response !== "object" || response.ok !== true) {
    const error = response && SETUP_ERRORS.has(response.error) ? response.error : "unavailable";
    return { ok: false, error };
  }
  if (request === "switch-to-tab") return { ok: true };
  const result = request === "access"
    ? sanitizeSetupAccess(response.result)
    : sanitizeSetupStoryTabs(response.result);
  return result ? { ok: true, result } : { ok: false, error: "unavailable" };
}

function admitSetupRequest() {
  const now = Date.now();
  while (setupRequestTimes.length > 0 && now - setupRequestTimes[0] >= SETUP_REQUEST_WINDOW_MS) {
    setupRequestTimes.shift();
  }
  if (setupRequestTimes.length >= SETUP_REQUEST_LIMIT) return false;
  setupRequestTimes.push(now);
  return true;
}

async function handleSetupRequest(data) {
  // A request that cannot be addressed gets no answer.
  const id = typeof data.id === "string" ? data.id : "";
  if (!id || id.length > SETUP_ID_MAX_LENGTH) return;
  const answer = (body) => {
    window.postMessage({ type: SETUP_RESPONSE_MESSAGE, id, ...body }, window.location.origin);
  };
  const request = data.request;
  if (typeof request !== "string" || !SETUP_REQUESTS.has(request)) {
    answer({ ok: false, error: typeof request === "string" ? "unknown_request" : "invalid_request" });
    return;
  }
  const message = { type: SETUP_PAGE_MESSAGE, request };
  if (request === "switch-to-tab") {
    if (!Number.isSafeInteger(data.tabId) || data.tabId < 0) {
      answer({ ok: false, error: "invalid_request" });
      return;
    }
    message.tabId = data.tabId;
  }
  if (!admitSetupRequest()) {
    answer({ ok: false, error: "rate_limited" });
    return;
  }
  if (!KERNEL_SESSION_ACTIVE) {
    answer({ ok: false, error: "unavailable" });
    return;
  }
  const response = await requestRuntimeMessage(
    message,
    "[Trace Sync] Failed to ask about setup",
  );
  answer(setupResult(request, response));
}

window.addEventListener("message", (event) => {
  // Stricter than the listener above: only this page's own top-level window,
  // speaking to itself. A frame, an opener or another origin is not heard.
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isTopLevelPage()) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== SETUP_REQUEST_MESSAGE) return;
  void handleSetupRequest(data);
});

// The signed-in page posts its token on its own when it finishes signing in.
// The token itself is ignored here: a credential grant still needs the
// background's request ID. A grant asked before sign-in finished is asked
// again, so the page can answer it now.
function handleTracePageSignedIn() {
  for (const requestId of pendingCredentialGrants.keys()) {
    requestTraceToken("credential_grant", requestId);
  }
  announceTracePageReady();
}

function announceTracePageReady() {
  sendRuntimeMessage(
    { type: TRACE_WEB_READY_MESSAGE },
    "[Trace Sync] Failed to announce the Trace page",
  );
}

if (!KERNEL_SESSION_ACTIVE) {
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
}

try {
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === CREDENTIAL_GRANT_REQUEST_MESSAGE) {
      if (
        !KERNEL_SESSION_ACTIVE ||
        message.protocolVersion !== 1 ||
        typeof message.requestId !== "string" ||
        !message.requestId.trim() ||
        (message.purpose !== "connect" && message.purpose !== "refresh")
      ) {
        return false;
      }
      const requestId = message.requestId;
      const previous = pendingCredentialGrants.get(requestId);
      if (previous) {
        window.clearTimeout(previous.timeout);
        previous.sendResponse({ ok: false, requestId, token: null });
      }
      const timeout = window.setTimeout(() => {
        const pending = pendingCredentialGrants.get(requestId);
        if (!pending) return;
        pendingCredentialGrants.delete(requestId);
        pending.sendResponse({ ok: false, requestId, token: null });
      }, 10_000);
      pendingCredentialGrants.set(requestId, { timeout, sendResponse });
      requestTraceToken("credential_grant", requestId);
      return true;
    }
    if (message?.type === SETUP_ACCESS_PUSH_MESSAGE) {
      const access = sanitizeSetupAccess(message);
      if (access && isTopLevelPage()) {
        window.postMessage(
          { type: SETUP_ACCESS_CHANGED_MESSAGE, ...access },
          window.location.origin,
        );
      }
      return false;
    }
    if (message?.type === STATUS_PUSH_MESSAGE) {
      window.postMessage(
        {
          type: STATUS_UPDATE_MESSAGE,
          state: sanitizeStatusState(message.state),
          at: Date.now(),
        },
        window.location.origin,
      );
      return false;
    }
    if (message?.type !== "TRACE_LIBRARY_INVALIDATED") return false;
    window.postMessage(
      {
        type: "TRACE_LIBRARY_INVALIDATED",
        reason: message.reason || null,
        at: message.at || null,
      },
      window.location.origin,
    );
    return false;
  });
} catch (error) {
  console.error("[Trace Sync] Failed to bind library invalidation bridge", error);
}

// A page that signed in before this script loaded has already posted its
// token. Ask once, so a signed-in page says so again; a signed-out page has
// nothing to answer. The reply only triggers the readiness hint above.
function isAppleMobileBrowser() {
  const nav = globalThis.navigator || {};
  const ua = nav.userAgent || "";
  // iPadOS Safari reports a Mac user agent; only touch tells them apart.
  return /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1);
}

if (KERNEL_SESSION_ACTIVE && !isAppleMobileBrowser()) {
  requestTraceToken("sync_ready");
}

// Announce after listeners are bound so a page that already gave up on its
// mount-time status request can immediately re-request through this script.
window.postMessage(
  { type: STATUS_READY_MESSAGE, at: Date.now() },
  window.location.origin,
);
