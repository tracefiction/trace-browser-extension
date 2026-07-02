// Trace MV3 background service worker.
// Receives metadata/progress messages from content scripts and sends them to the Trace API.
// Stores only Trace extension prefs, overlay cache, and the Trace auth token used for API calls.
// It never receives AO3/FFN passwords or cookies; URLs are injected by `npm run build`.
const ext = typeof browser !== "undefined" ? browser : chrome;

const TRACE_API_BASE = "__TRACE_API_BASE__";
const TRACE_WEB_ORIGIN = "__TRACE_WEB_ORIGIN__";

const API_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/track`;
const METADATA_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/metadata`;
const LIBRARY_METADATA_REFRESH_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/library/metadata-refresh`;
const FINISH_QUALIFICATION_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/finish-qualification`;
const LIBRARY_OVERLAY_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/library-overlay`;
const WORK_PREFERENCES_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/work-preferences`;
const AO3_SAVED_FILTERS_SYNC_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/ao3-saved-filters/sync`;
const LIBRARY_ENTRY_ENDPOINT_BASE = `${TRACE_API_BASE.replace(/\/$/, "")}/api/library`;
const ACCOUNT_ME_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/account/me`;
const IMPORT_BASE = `${TRACE_WEB_ORIGIN.replace(/\/$/, "")}/import`;
const TRACE_HOME_URL = `${TRACE_WEB_ORIGIN.replace(/\/$/, "")}/`;
const AUTH_TOKEN_KEY = "authToken";
const AUTH_STATE_KEY = "traceAuthState";
const OVERLAY_STORAGE_KEY = "libraryOverlayCache";
const AO3_SAVED_FILTERS_STORAGE_KEY = "traceAo3SavedFiltersV1";
const AO3_SAVED_FILTERS_DELETED_KEY = "traceAo3SavedFiltersDeletedV1";
const AO3_SAVED_FILTERS_SYNC_META_KEY = "traceAo3SavedFiltersSyncV1";
const AO3_SAVED_FILTERS_CLIENT_ID_KEY = "traceAo3SavedFiltersClientIdV1";
const LIBRARY_INVALIDATED_MESSAGE = "TRACE_LIBRARY_INVALIDATED";
const EXTENSION_STATUS_QUERY_MESSAGE = "TRACE_EXTENSION_STATUS_QUERY";
const AO3_SAVED_FILTERS_SYNC_REQUEST_MESSAGE = "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST";
const ARCHIVE_READINESS_KEY = "traceArchiveReadiness";
const OPTIMISTIC_CHAPTER_FLOORS_MS = 20_000;
const ARCHIVE_READINESS_ERROR_RECENT_MS = 24 * 60 * 60 * 1_000;
const TRACE_FIRST_SAVE_SEEN_KEY = "traceFirstSaveSeen";
const TRACE_LIBRARY_COUNT_KEY = "traceLibraryCount";
// OVERLAY_PRO_KEY removed — overlay is available to all users
const TRACE_USER_PRO_KEY = "traceUserPro";
const PREF_AUTO_TRACK_KEY = "prefAutoTrackEnabled";
const PREF_LIBRARY_INLAY_KEY = "prefLibraryInlayEnabled";
const PREF_AO3_SAVED_FILTERS_KEY = "prefAo3SavedFiltersEnabled";
const PREF_METADATA_IMPROVE_KEY = "prefMetadataImproveEnabled";
const AUTH_STATE_VERIFICATION_VERSION = 1;
const AO3_STORY_URL_RE =
  /^https:\/\/(?:[^/]+\.)?(?:archiveofourown\.org|archiveofourown\.gay|archive\.transformativeworks\.org|ao3\.org)\/works\/\d+(?:\/chapters\/\d+)?(?:[?#].*)?$/i;
const FFN_STORY_PATH_RE = /^\/s\/\d+(?:\/\d+)?(?:\/.*)?$/i;
const AO3_SAVED_FILTER_CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const AO3_SAVED_FILTER_PARAM_KEY_RE =
  /^(?:work_search|include_work_search|exclude_work_search)\[[a-z0-9_]+\](?:\[\])?$/;
const AO3_SAVED_FILTER_MAX_NAME_LENGTH = 96;
const AO3_SAVED_FILTER_MAX_CONTEXT_KEY_LENGTH = 240;
const AO3_SAVED_FILTER_MAX_CONTEXT_LABEL_LENGTH = 120;
const AO3_SAVED_FILTER_MAX_SUMMARY_PARTS = 5;
const AO3_SAVED_FILTER_MAX_SUMMARY_PART_LENGTH = 64;
const AO3_SAVED_FILTER_MAX_PARAMS = 80;
const AO3_SAVED_FILTER_ACTIVE_LIMIT = 250;
const AO3_SAVED_FILTER_SYNC_BATCH_LIMIT = 100;
const AO3_SAVED_FILTER_SYNC_MAX_ITERATIONS = 10;

// 1. Token Management
let bearerToken = null;
let verifiedBearerToken = null;
let authVerificationSeq = 0;
const optimisticChapterFloors = new Map();
let ao3SavedFiltersSyncTimer = null;
let ao3SavedFiltersSyncInFlight = false;

function shouldIgnoreSenderForAutoTrack(sender) {
  if (!sender || typeof sender !== "object") return false;
  if (typeof sender.frameId === "number" && sender.frameId !== 0) {
    return true;
  }
  const lifecycle =
    typeof sender.documentLifecycle === "string"
      ? sender.documentLifecycle.toLowerCase()
      : "";
  return lifecycle === "prerender" || lifecycle === "pending_deletion";
}

function setBadge(tabId, text, color) {
  if (!tabId) return;
  ext.action.setBadgeText({ text, tabId });
  if (color) {
    ext.action.setBadgeBackgroundColor({ color, tabId });
  }
}

function clearBadge(tabId) {
  if (!tabId) return;
  ext.action.setBadgeText({ text: "", tabId });
}

function persistAuthState(nextState) {
  const write = (previousState = null) => {
    const preserved =
      nextState?.state === "connected"
        ? preservedConnectedAuthStateFields(previousState)
        : {};
    const state = {
      updatedAt: new Date().toISOString(),
      ...preserved,
      ...nextState,
    };
    ext.storage.local.set({ [AUTH_STATE_KEY]: state });
  };

  try {
    ext.storage.local.get([AUTH_STATE_KEY], (res) => {
      const previousState =
        res?.[AUTH_STATE_KEY] && typeof res[AUTH_STATE_KEY] === "object"
          ? res[AUTH_STATE_KEY]
          : null;
      write(previousState);
    });
  } catch (_) {
    write();
  }
}

function preservedConnectedAuthStateFields(previousState) {
  if (!previousState || typeof previousState !== "object") return {};
  const preserved = {};
  if (previousState.firstSaveSeen === true) preserved.firstSaveSeen = true;
  for (const key of [
    "lastQuickAddAt",
    "lastTrackSuccessAt",
    "lastReaderStatusAt",
    "lastWorkPreferenceAt",
  ]) {
    if (typeof previousState[key] === "string") preserved[key] = previousState[key];
  }
  return preserved;
}

function setConnectedState(extra = {}) {
  persistAuthState({
    state: "connected",
    message: "Extension connected to your Trace account.",
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

function setVerifiedConnectedState(extra = {}) {
  setConnectedState({
    ...extra,
    authVerificationVersion: AUTH_STATE_VERIFICATION_VERSION,
    accountVerifiedAt: new Date().toISOString(),
  });
}

function setCheckingState(extra = {}) {
  persistAuthState({
    state: "unknown",
    message: "Checking your Trace account connection.",
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

function setSignedOutState(extra = {}) {
  persistAuthState({
    state: "signed_out",
    message:
      "Open Trace in this browser and sign in. Already signed in? Open any Trace page and we’ll connect automatically.",
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

function setReconnectState(message, extra = {}) {
  persistAuthState({
    state: "reconnect_required",
    message,
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

function setErrorState(message, extra = {}) {
  persistAuthState({
    state: "error",
    message,
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

function setUpgradeState(message, extra = {}) {
  persistAuthState({
    state: "upgrade_required",
    message,
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

/** Auto-track failed but session token may still be valid; manual import does not use this POST. */
function setConnectedWithSyncWarning(message, extra = {}) {
  persistAuthState({
    state: "connected",
    message,
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

function clearToken() {
  authVerificationSeq += 1;
  bearerToken = null;
  verifiedBearerToken = null;
  optimisticChapterFloors.clear();
  try {
    ext.storage.local.remove([
      AUTH_TOKEN_KEY,
      TRACE_USER_PRO_KEY,
      OVERLAY_STORAGE_KEY,
      TRACE_FIRST_SAVE_SEEN_KEY,
      TRACE_LIBRARY_COUNT_KEY,
    ]);
  } catch (_) {
    /* ignore */
  }
}

function detectBrowserKind() {
  try {
    const url =
      ext.runtime && typeof ext.runtime.getURL === "function"
        ? ext.runtime.getURL("")
        : "";
    if (/^chrome-extension:\/\//i.test(url)) return "chrome";
    if (/^moz-extension:\/\//i.test(url)) return "firefox";
    if (/^safari-web-extension:\/\//i.test(url)) return "safari";
  } catch (_) {
    /* ignore */
  }
  return "unknown";
}

function hasCurrentSessionVerifiedToken(authState, token) {
  return (
    Boolean(token) &&
    verifiedBearerToken === token &&
    authState?.authVerificationVersion === AUTH_STATE_VERIFICATION_VERSION &&
    toEpochMillis(authState?.accountVerifiedAt) != null
  );
}

function normalizeStatusAuthState(authState, token) {
  const rawState = authState?.state;
  const hasToken = Boolean(token);
  if (rawState === "connected" && hasCurrentSessionVerifiedToken(authState, token)) {
    return "connected";
  }
  if (rawState === "connected" && hasToken) return "unknown";
  if (rawState === "signed_out") return "signed_out";
  if (rawState === "reconnect_required") return "reconnect_required";
  if (rawState === "error") return "error";
  if (rawState === "unknown") return "unknown";
  if (hasToken) return "unknown";
  return "signed_out";
}

function toEpochMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeArchiveHostKind(value) {
  if (value === "ao3" || value === "ffn" || value === "unknown") {
    return value;
  }
  return null;
}

function normalizeArchiveActionKind(value) {
  if (
    value === "track" ||
    value === "quick_add" ||
    value === "import" ||
    value === "metadata" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function normalizeArchiveErrorKind(value) {
  if (
    value === "permission" ||
    value === "unsupported_page" ||
    value === "auth" ||
    value === "parser" ||
    value === "network" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function archiveHostKindFromPayload(payload) {
  let source = "";
  if (payload && typeof payload.s === "string") {
    source = payload.s;
  } else if (payload?.item && typeof payload.item.src === "string") {
    source = payload.item.src;
  } else if (Array.isArray(payload?.items) && typeof payload.items[0]?.src === "string") {
    source = payload.items[0].src;
  } else if (Array.isArray(payload?.items) && typeof payload.items[0]?.source === "string") {
    source = payload.items[0].source;
  }
  if (source === "ao3" || source === "ffn") return source;
  return "unknown";
}

function archiveHostKindFromTabContext(tabContext) {
  const site = tabContext && typeof tabContext.site === "string" ? tabContext.site : "";
  if (site === "ao3" || site === "ffn") return site;
  return "unknown";
}

function tabContextLooksLikeArchive(tabContext) {
  return (
    tabContext?.kind === "supported_story" ||
    tabContext?.kind === "supported_archive" ||
    tabContext?.kind === "blocked_archive"
  );
}

function sanitizeArchiveReadiness(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  const lastArchiveSeenAt = toEpochMillis(raw.lastArchiveSeenAt);
  const lastArchiveHostKind = normalizeArchiveHostKind(raw.lastArchiveHostKind);
  const lastArchiveActionAt = toEpochMillis(raw.lastArchiveActionAt);
  const lastArchiveActionKind = normalizeArchiveActionKind(
    raw.lastArchiveActionKind,
  );
  const lastArchiveErrorAt = toEpochMillis(raw.lastArchiveErrorAt);
  const lastArchiveErrorKind = normalizeArchiveErrorKind(raw.lastArchiveErrorKind);

  if (lastArchiveSeenAt != null) {
    out.lastArchiveSeenAt = lastArchiveSeenAt;
  }
  if (lastArchiveHostKind) {
    out.lastArchiveHostKind = lastArchiveHostKind;
  }
  if (lastArchiveActionAt != null) {
    out.lastArchiveActionAt = lastArchiveActionAt;
  }
  if (lastArchiveActionKind) {
    out.lastArchiveActionKind = lastArchiveActionKind;
  }
  if (
    lastArchiveErrorKind &&
    lastArchiveErrorAt != null &&
    Date.now() - lastArchiveErrorAt <= ARCHIVE_READINESS_ERROR_RECENT_MS
  ) {
    out.lastArchiveErrorKind = lastArchiveErrorKind;
  }

  return out;
}

function archiveReadinessFromLegacyAuthState(authState) {
  if (!authState || typeof authState !== "object") return {};
  const quickAddAt = toEpochMillis(authState.lastQuickAddAt);
  const trackAt = toEpochMillis(authState.lastTrackSuccessAt);
  if (quickAddAt == null && trackAt == null) return {};

  if (quickAddAt != null && (trackAt == null || quickAddAt >= trackAt)) {
    return {
      lastArchiveActionAt: quickAddAt,
      lastArchiveActionKind: "quick_add",
    };
  }

  return {
    lastArchiveActionAt: trackAt,
    lastArchiveActionKind: "track",
  };
}

function applyArchiveReadiness(status, archiveReadiness, authState) {
  const legacy = archiveReadinessFromLegacyAuthState(authState);
  const merged = { ...legacy, ...archiveReadiness };

  if (typeof merged.lastArchiveSeenAt === "number") {
    status.lastArchiveSeenAt = merged.lastArchiveSeenAt;
  }
  if (normalizeArchiveHostKind(merged.lastArchiveHostKind)) {
    status.lastArchiveHostKind = merged.lastArchiveHostKind;
  }
  if (typeof merged.lastArchiveActionAt === "number") {
    status.lastArchiveActionAt = merged.lastArchiveActionAt;
  }
  if (normalizeArchiveActionKind(merged.lastArchiveActionKind)) {
    status.lastArchiveActionKind = merged.lastArchiveActionKind;
  }
  if (normalizeArchiveErrorKind(merged.lastArchiveErrorKind)) {
    status.lastArchiveErrorKind = merged.lastArchiveErrorKind;
  }
}

function recordArchiveReadiness(event = {}) {
  const now = Date.now();
  const hostKind = normalizeArchiveHostKind(event.hostKind) || "unknown";
  const actionKind = normalizeArchiveActionKind(event.actionKind);
  const errorKind = normalizeArchiveErrorKind(event.errorKind);
  const patch = {};

  if (event.seen !== false) {
    patch.lastArchiveSeenAt = now;
    patch.lastArchiveHostKind = hostKind;
  }
  if (actionKind) {
    patch.lastArchiveActionAt = now;
    patch.lastArchiveActionKind = actionKind;
    patch.lastArchiveErrorKind = null;
    patch.lastArchiveErrorAt = null;
  }
  if (errorKind) {
    patch.lastArchiveErrorKind = errorKind;
    patch.lastArchiveErrorAt = now;
  }
  if (Object.keys(patch).length === 0) return;

  try {
    ext.storage.local.get([ARCHIVE_READINESS_KEY], (res) => {
      if (ext.runtime.lastError) return;
      const prev =
        res && res[ARCHIVE_READINESS_KEY] && typeof res[ARCHIVE_READINESS_KEY] === "object"
          ? res[ARCHIVE_READINESS_KEY]
          : {};
      const next = { ...prev };
      for (const [key, value] of Object.entries(patch)) {
        if (value == null) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      ext.storage.local.set({ [ARCHIVE_READINESS_KEY]: next });
    });
  } catch (_) {
    /* best-effort local readiness only */
  }
}

function recordArchiveActionFromPayload(payload, actionKind) {
  recordArchiveReadiness({
    hostKind: archiveHostKindFromPayload(payload),
    actionKind,
  });
}

function recordArchiveIssueFromPayload(payload, errorKind) {
  recordArchiveReadiness({
    hostKind: archiveHostKindFromPayload(payload),
    errorKind,
  });
}

function hasFirstSaveSignal(authState, firstSaveSeen) {
  return (
    firstSaveSeen === true ||
    authState?.firstSaveSeen === true ||
    Boolean(authState?.lastQuickAddAt) ||
    Boolean(authState?.lastTrackSuccessAt) ||
    Boolean(authState?.lastReaderStatusAt)
  );
}

function safeUnknownExtensionStatus() {
  return {
    installed: true,
    connected: false,
    authState: "unknown",
    browserKind: detectBrowserKind(),
  };
}

function buildExtensionStatus(snapshot = {}) {
  const authState =
    snapshot[AUTH_STATE_KEY] && typeof snapshot[AUTH_STATE_KEY] === "object"
      ? snapshot[AUTH_STATE_KEY]
      : null;
  const storedToken =
    typeof snapshot[AUTH_TOKEN_KEY] === "string"
      ? snapshot[AUTH_TOKEN_KEY].trim()
      : "";
  const tokenForStatus = storedToken || bearerToken || "";
  const normalizedAuthState = normalizeStatusAuthState(authState, tokenForStatus);
  const status = {
    installed: true,
    connected: normalizedAuthState === "connected",
    authState: normalizedAuthState,
    firstSaveSeen: hasFirstSaveSignal(
      authState,
      snapshot[TRACE_FIRST_SAVE_SEEN_KEY] === true,
    ),
    browserKind: detectBrowserKind(),
  };
  const lastTokenSyncAt = toEpochMillis(authState?.lastTokenSyncAt);
  if (lastTokenSyncAt != null) {
    status.lastTokenSyncAt = lastTokenSyncAt;
  }
  applyArchiveReadiness(
    status,
    sanitizeArchiveReadiness(snapshot[ARCHIVE_READINESS_KEY]),
    authState,
  );
  return status;
}

function markFirstSaveSeen() {
  try {
    ext.storage.local.set({ [TRACE_FIRST_SAVE_SEEN_KEY]: true });
  } catch (_) {
    /* ignore */
  }
}

function externalStoryKeyFromItem(item) {
  if (!item || !item.src || !item.u) return null;
  const url = String(item.u || "");
  if (item.src === "ao3") {
    const ao3 = url.match(/\/works\/(\d+)/);
    return ao3 ? `ao3:${ao3[1]}` : null;
  }
  if (item.src === "ffn") {
    const ffn = url.match(/\/s\/(\d+)/);
    return ffn ? `ffn:${ffn[1]}` : null;
  }
  return null;
}

function recordOptimisticChapterFloor(item) {
  const key = externalStoryKeyFromItem(item);
  const chapter = item && typeof item.chn === "number" ? item.chn : null;
  if (!key || chapter == null || !Number.isFinite(chapter) || chapter < 1) {
    return;
  }
  const prev = optimisticChapterFloors.get(key);
  const nextCurrent = prev
    ? Math.max(prev.current || 0, Math.trunc(chapter))
    : Math.trunc(chapter);
  optimisticChapterFloors.set(key, {
    current: nextCurrent,
    total:
      item && typeof item.cht === "number" && Number.isFinite(item.cht)
        ? Math.trunc(item.cht)
        : prev && typeof prev.total === "number"
          ? prev.total
          : null,
    at: Date.now(),
  });
}

function applyOptimisticChapterFloors(entries) {
  const now = Date.now();
  for (const [key, floor] of optimisticChapterFloors.entries()) {
    if (!floor || now - floor.at > OPTIMISTIC_CHAPTER_FLOORS_MS) {
      optimisticChapterFloors.delete(key);
      continue;
    }
    const existing = entries[key];
    if (!existing || !existing.chapters) continue;
    const current =
      typeof existing.chapters.current === "number"
        ? existing.chapters.current
        : null;
    if (current == null) continue;
    if (current >= floor.current) {
      optimisticChapterFloors.delete(key);
      continue;
    }
    entries[key] = {
      ...existing,
      chapters: {
        current: floor.current,
        total:
          existing.chapters.total != null
            ? existing.chapters.total
            : floor.total,
      },
    };
  }
  return entries;
}

function readOverlayEntryForItem(item) {
  return new Promise((resolve) => {
    const key = externalStoryKeyFromItem(item);
    if (!key) {
      resolve(null);
      return;
    }
    try {
      ext.storage.local.get([OVERLAY_STORAGE_KEY], (res) => {
        if (ext.runtime.lastError) {
          resolve(null);
          return;
        }
        const cache = res && res[OVERLAY_STORAGE_KEY];
        resolve(cache && cache.entries ? cache.entries[key] ?? null : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/** Best-effort Pro flag for gating Pro-only prefs (synced from GET /api/account/me). */
function accountStoragePatch(json) {
  const patch = {};
  if (json && typeof json.pro === "boolean") {
    patch[TRACE_USER_PRO_KEY] = json.pro;
  }
  if (json && typeof json.library_count === "number" && Number.isFinite(json.library_count)) {
    patch[TRACE_LIBRARY_COUNT_KEY] = Math.max(0, Math.trunc(json.library_count));
  }
  return patch;
}

async function readResponseJson(response) {
  if (!response || typeof response !== "object") return null;
  try {
    if (typeof response.clone === "function") {
      return await response.clone().json();
    }
  } catch (_) {
    /* fall through */
  }
  try {
    if (typeof response.json === "function") {
      return await response.json();
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function responsePayloadCode(payload) {
  return payload && typeof payload.code === "string" ? payload.code : null;
}

function authFailureExtra(extra = {}) {
  const out = {
    lastHttpStatus: extra.status,
  };
  if (extra.code) out.lastAuthErrorCode = extra.code;
  if (extra.actionAtKey) out[extra.actionAtKey] = new Date().toISOString();
  return out;
}

async function applyAuthFailureResponse(response, extra = {}) {
  if (!response || (response.status !== 401 && response.status !== 409)) {
    return null;
  }

  const payload = await readResponseJson(response);
  const code = responsePayloadCode(payload);
  if (response.status === 409 && code !== "ACCOUNT_BOOTSTRAP_REQUIRED") {
    return null;
  }

  clearToken();

  if (response.status === 409) {
    setReconnectState(
      "Open Trace to finish account setup before using the extension.",
      authFailureExtra({ ...extra, status: response.status, code }),
    );
    return "account_bootstrap_required";
  }

  if (code === "ACCOUNT_DELETED_STALE_TOKEN") {
    setReconnectState(
      "This Trace session belongs to a deleted account. Open Trace and sign in again.",
      authFailureExtra({ ...extra, status: response.status, code }),
    );
    return "account_deleted_stale_token";
  }

  setReconnectState(
    "Your Trace session expired. Open Trace and sign in again.",
    authFailureExtra({ ...extra, status: response.status, code }),
  );
  return "auth_expired";
}

async function verifyTraceAccountToken(token, extra = {}) {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) return { success: false, state: "signed_out" };

  const verificationSeq = ++authVerificationSeq;
  const lastTokenSyncAt = extra.lastTokenSyncAt || new Date().toISOString();
  bearerToken = trimmed;
  verifiedBearerToken = null;
  ext.storage.local.set({ [AUTH_TOKEN_KEY]: trimmed });
  setCheckingState({ lastTokenSyncAt });

  try {
    const response = await fetch(ACCOUNT_ME_ENDPOINT, {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    if (verificationSeq !== authVerificationSeq || bearerToken !== trimmed) {
      return { success: false, state: "unknown", stale: true };
    }

    if (response.ok) {
      const json = await readResponseJson(response);
      const patch = {
        [AUTH_TOKEN_KEY]: trimmed,
        ...accountStoragePatch(json),
      };
      ext.storage.local.set(patch);
      verifiedBearerToken = trimmed;
      setVerifiedConnectedState({ lastTokenSyncAt });
      void refreshLibraryOverlay();
      scheduleAo3SavedFiltersSync(250);
      return { success: true, state: "connected" };
    }

    const authError = await applyAuthFailureResponse(response, {
      actionAtKey: "lastTokenSyncAt",
    });
    if (authError) {
      return { success: false, state: "reconnect_required", error: authError };
    }

    setErrorState(
      "Trace could not verify your account. Try again shortly, or open Trace to reconnect.",
      { lastHttpStatus: response.status, lastTokenSyncAt },
    );
    return {
      success: false,
      state: "error",
      error: "account_check_failed",
      status: response.status,
    };
  } catch (_) {
    if (verificationSeq !== authVerificationSeq || bearerToken !== trimmed) {
      return { success: false, state: "unknown", stale: true };
    }
    setErrorState(
      "Trace could not reach the API to verify your account. Try again shortly.",
      { lastTokenSyncAt },
    );
    return { success: false, state: "error", error: "network_error" };
  }
}

function refreshTraceUserPro() {
  if (!bearerToken) return;
  fetch(ACCOUNT_ME_ENDPOINT, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })
    .then(async (r) => {
      if (r.ok) return readResponseJson(r);
      await applyAuthFailureResponse(r);
      return null;
    })
    .then((j) => {
      const patch = accountStoragePatch(j);
      if (Object.keys(patch).length > 0) {
        ext.storage.local.set(patch);
      }
    })
    .catch(() => {});
}

function fetchTraceUserProPromise() {
  return new Promise((resolve) => {
    if (!bearerToken) {
      resolve();
      return;
    }
    fetch(ACCOUNT_ME_ENDPOINT, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    })
      .then(async (r) => {
        if (r.ok) return readResponseJson(r);
        await applyAuthFailureResponse(r);
        return null;
      })
      .then((j) => {
        const patch = accountStoragePatch(j);
        if (Object.keys(patch).length > 0) {
          ext.storage.local.set(patch, () => resolve());
        } else {
          resolve();
        }
      })
      .catch(() => resolve());
  });
}

function storageGetLocal(keys) {
  return new Promise((resolve) => {
    try {
      ext.storage.local.get(keys, (res) => {
        if (ext.runtime.lastError) {
          resolve({});
          return;
        }
        resolve(res || {});
      });
    } catch (_) {
      resolve({});
    }
  });
}

function storageSetLocal(patch) {
  return new Promise((resolve) => {
    try {
      ext.storage.local.set(patch, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function makeAo3SavedFilterLocalId(prefix = "sf") {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch (_) {
    /* ignore */
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isUsefulIsoDateTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function boundedCleanText(value, maxLength) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, maxLength);
}

function validAo3SavedFilterClientId(value) {
  const id = String(value || "").trim();
  return AO3_SAVED_FILTER_CLIENT_ID_RE.test(id) ? id : "";
}

function sanitizeAo3SavedFilterPairs(raw) {
  if (!Array.isArray(raw)) return [];
  const pairs = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const key = String(pair[0] || "").trim();
    const value = String(pair[1] || "").trim();
    if (!AO3_SAVED_FILTER_PARAM_KEY_RE.test(key) || !value) continue;
    pairs.push([key, value.slice(0, 300)]);
    if (pairs.length >= AO3_SAVED_FILTER_MAX_PARAMS) break;
  }
  pairs.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return pairs;
}

function sanitizeAo3SavedFilterSummary(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((part) =>
      boundedCleanText(part, AO3_SAVED_FILTER_MAX_SUMMARY_PART_LENGTH),
    )
    .filter(Boolean)
    .slice(0, AO3_SAVED_FILTER_MAX_SUMMARY_PARTS);
}

function sanitizeAo3SavedFilterPreset(raw) {
  if (!raw || typeof raw !== "object") return null;
  const params = sanitizeAo3SavedFilterPairs(raw.params);
  if (params.length === 0) return null;
  const fallbackId = makeAo3SavedFilterLocalId();
  const id = String(raw.id || "").trim() || fallbackId;
  const clientId =
    validAo3SavedFilterClientId(raw.clientId) ||
    validAo3SavedFilterClientId(id) ||
    fallbackId;
  const serverId = isValidUuid(raw.serverId) ? String(raw.serverId).trim() : "";
  const now = new Date().toISOString();
  const updatedAt = isUsefulIsoDateTime(raw.updatedAt) ? raw.updatedAt : now;
  const clientUpdatedAt = isUsefulIsoDateTime(raw.clientUpdatedAt)
    ? raw.clientUpdatedAt
    : updatedAt;
  const scope = raw.scope === "global" ? "global" : "context";
  return {
    id,
    clientId,
    serverId,
    name: boundedCleanText(raw.name, AO3_SAVED_FILTER_MAX_NAME_LENGTH) || "AO3 filter",
    params,
    scope,
    contextKey:
      scope === "context"
        ? boundedCleanText(raw.contextKey, AO3_SAVED_FILTER_MAX_CONTEXT_KEY_LENGTH)
        : "",
    contextLabel:
      scope === "context"
        ? boundedCleanText(raw.contextLabel, AO3_SAVED_FILTER_MAX_CONTEXT_LABEL_LENGTH)
        : "",
    summary: sanitizeAo3SavedFilterSummary(raw.summary),
    createdAt: isUsefulIsoDateTime(raw.createdAt) ? raw.createdAt : now,
    updatedAt,
    clientUpdatedAt,
    dirty: raw.dirty === true,
  };
}

function sanitizeAo3SavedFilterPresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const preset = sanitizeAo3SavedFilterPreset(item);
    if (!preset || seen.has(preset.clientId)) continue;
    seen.add(preset.clientId);
    out.push(preset);
  }
  return out;
}

function sanitizeAo3DeletedSavedFilter(raw) {
  if (!raw || typeof raw !== "object") return null;
  const clientId =
    validAo3SavedFilterClientId(raw.clientId) ||
    validAo3SavedFilterClientId(raw.id);
  if (!clientId) return null;
  const now = new Date().toISOString();
  return {
    id: String(raw.id || clientId).trim(),
    clientId,
    serverId: isValidUuid(raw.serverId) ? String(raw.serverId).trim() : "",
    clientUpdatedAt: isUsefulIsoDateTime(raw.clientUpdatedAt)
      ? raw.clientUpdatedAt
      : now,
  };
}

function sanitizeAo3DeletedSavedFilters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const deleted = sanitizeAo3DeletedSavedFilter(item);
    if (!deleted || seen.has(deleted.clientId)) continue;
    seen.add(deleted.clientId);
    out.push(deleted);
  }
  return out;
}

function sanitizeAo3SavedFilterSyncMeta(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  if (isUsefulIsoDateTime(raw.syncVersion)) out.syncVersion = raw.syncVersion;
  if (isUsefulIsoDateTime(raw.lastSyncedAt)) out.lastSyncedAt = raw.lastSyncedAt;
  return out;
}

async function ensureAo3SavedFiltersClientId(snapshot) {
  const existing = validAo3SavedFilterClientId(
    snapshot && snapshot[AO3_SAVED_FILTERS_CLIENT_ID_KEY],
  );
  if (existing) return existing;
  const clientId = makeAo3SavedFilterLocalId("device").slice(0, 80);
  await storageSetLocal({ [AO3_SAVED_FILTERS_CLIENT_ID_KEY]: clientId });
  return clientId;
}

function ao3SavedFilterNeedsSync(preset) {
  return preset?.dirty === true || !isValidUuid(preset?.serverId);
}

function ao3SavedFilterUpsertPayload(preset) {
  const body = {
    clientId: preset.clientId,
    name: preset.name,
    scope: preset.scope === "global" ? "global" : "context",
    contextKey: preset.scope === "context" ? preset.contextKey || null : null,
    contextLabel: preset.scope === "context" ? preset.contextLabel || null : null,
    params: preset.params,
    summary: preset.summary,
    createdAt: preset.createdAt,
    clientUpdatedAt: preset.clientUpdatedAt,
  };
  if (isValidUuid(preset.serverId)) body.id = preset.serverId;
  return body;
}

function ao3SavedFilterDeletePayload(deleted) {
  const body = {
    clientId: deleted.clientId,
    clientUpdatedAt: deleted.clientUpdatedAt,
  };
  if (isValidUuid(deleted.serverId)) body.id = deleted.serverId;
  return body;
}

function isLocalAo3SavedFilterNewer(local, remoteClientUpdatedAt) {
  if (!local || local.dirty !== true) return false;
  const localTime = Date.parse(local.clientUpdatedAt || "");
  const remoteTime = Date.parse(remoteClientUpdatedAt || "");
  return Number.isFinite(localTime) && Number.isFinite(remoteTime) && localTime > remoteTime;
}

function localPresetFromRemoteAo3SavedFilter(remote, existing) {
  const id = existing?.id || remote.clientId || remote.id;
  return {
    id,
    clientId: remote.clientId,
    serverId: remote.id,
    name: remote.name,
    params: sanitizeAo3SavedFilterPairs(remote.params),
    scope: remote.scope === "global" ? "global" : "context",
    contextKey: remote.scope === "context" ? String(remote.contextKey || "") : "",
    contextLabel: remote.scope === "context" ? String(remote.contextLabel || "") : "",
    summary: sanitizeAo3SavedFilterSummary(remote.summary),
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    clientUpdatedAt: remote.clientUpdatedAt,
    dirty: false,
  };
}

function mergeAo3SavedFiltersAfterSync({
  presets,
  deleted,
  activeMeta,
  response,
  sentDeleteClientIds,
}) {
  const byClientId = new Map();
  const localIdByClientId = new Map();
  for (const preset of presets) {
    byClientId.set(preset.clientId, preset);
    localIdByClientId.set(preset.clientId, preset.id);
  }

  const deletedByClientId = new Map();
  for (const item of deleted) {
    deletedByClientId.set(item.clientId, item);
  }
  for (const clientId of sentDeleteClientIds) {
    deletedByClientId.delete(clientId);
  }

  for (const remote of Array.isArray(response?.presets) ? response.presets : []) {
    const existing = byClientId.get(remote.clientId);
    if (isLocalAo3SavedFilterNewer(existing, remote.clientUpdatedAt)) continue;
    const next = localPresetFromRemoteAo3SavedFilter(remote, existing);
    if (next.params.length === 0) continue;
    byClientId.set(remote.clientId, next);
    deletedByClientId.delete(remote.clientId);
  }

  for (const remote of Array.isArray(response?.deleted) ? response.deleted : []) {
    const existing = byClientId.get(remote.clientId);
    if (isLocalAo3SavedFilterNewer(existing, remote.clientUpdatedAt)) continue;
    byClientId.delete(remote.clientId);
    deletedByClientId.delete(remote.clientId);
  }

  const nextPresets = Array.from(byClientId.values()).sort((a, b) => {
    const at = Date.parse(a.updatedAt || a.clientUpdatedAt || "") || 0;
    const bt = Date.parse(b.updatedAt || b.clientUpdatedAt || "") || 0;
    return at - bt;
  });

  let nextActiveMeta = activeMeta || null;
  if (nextActiveMeta && nextActiveMeta.id) {
    const stillActive = nextPresets.some((preset) => preset.id === nextActiveMeta.id);
    if (!stillActive) {
      const clientId = Array.from(localIdByClientId.entries()).find(
        ([, localId]) => localId === nextActiveMeta.id,
      )?.[0];
      const replacement = clientId
        ? nextPresets.find((preset) => preset.clientId === clientId)
        : null;
      nextActiveMeta = replacement
        ? { ...nextActiveMeta, id: replacement.id }
        : null;
    }
  }

  return {
    presets: nextPresets,
    deleted: Array.from(deletedByClientId.values()),
    activeMeta: nextActiveMeta,
  };
}

function snapshotHasPendingAo3SavedFilterSync(snapshot) {
  const presets = sanitizeAo3SavedFilterPresets(
    snapshot && snapshot[AO3_SAVED_FILTERS_STORAGE_KEY],
  );
  const deleted = sanitizeAo3DeletedSavedFilters(
    snapshot && snapshot[AO3_SAVED_FILTERS_DELETED_KEY],
  );
  return presets.some(ao3SavedFilterNeedsSync) || deleted.length > 0;
}

function scheduleAo3SavedFiltersSync(delayMs = 750) {
  if (!bearerToken) return;
  if (ao3SavedFiltersSyncTimer) clearTimeout(ao3SavedFiltersSyncTimer);
  ao3SavedFiltersSyncTimer = setTimeout(() => {
    ao3SavedFiltersSyncTimer = null;
    void syncAo3SavedFilters();
  }, delayMs);
}

async function syncAo3SavedFilters() {
  if (!bearerToken) return { ok: false, error: "not_authenticated" };
  if (ao3SavedFiltersSyncInFlight) return { ok: false, error: "sync_in_flight" };
  ao3SavedFiltersSyncInFlight = true;

  try {
    let snapshot = await storageGetLocal([
      AO3_SAVED_FILTERS_STORAGE_KEY,
      AO3_SAVED_FILTERS_DELETED_KEY,
      AO3_SAVED_FILTERS_SYNC_META_KEY,
      AO3_SAVED_FILTERS_CLIENT_ID_KEY,
      "traceAo3SavedFiltersActiveV1",
    ]);
    const clientId = await ensureAo3SavedFiltersClientId(snapshot);
    let lastSyncVersion = null;
    let didSync = false;
    let hasMorePending = false;

    for (let i = 0; i < AO3_SAVED_FILTER_SYNC_MAX_ITERATIONS; i += 1) {
      const presets = sanitizeAo3SavedFilterPresets(
        snapshot[AO3_SAVED_FILTERS_STORAGE_KEY],
      );
      const deleted = sanitizeAo3DeletedSavedFilters(
        snapshot[AO3_SAVED_FILTERS_DELETED_KEY],
      );
      const syncMeta = sanitizeAo3SavedFilterSyncMeta(
        snapshot[AO3_SAVED_FILTERS_SYNC_META_KEY],
      );
      const upserts = presets
        .filter(ao3SavedFilterNeedsSync)
        .map(ao3SavedFilterUpsertPayload);
      const deletes = deleted.map(ao3SavedFilterDeletePayload);
      const batchUpserts = upserts.slice(0, AO3_SAVED_FILTER_SYNC_BATCH_LIMIT);
      const batchDeletes = deletes.slice(0, AO3_SAVED_FILTER_SYNC_BATCH_LIMIT);

      if (didSync && batchUpserts.length === 0 && batchDeletes.length === 0) {
        hasMorePending = false;
        break;
      }

      const response = await fetch(AO3_SAVED_FILTERS_SYNC_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({
          clientId,
          since: syncMeta.syncVersion || null,
          upserts: batchUpserts,
          deletes: batchDeletes,
        }),
      });

      const authError = await applyAuthFailureResponse(response);
      if (authError) return { ok: false, error: authError };
      if (!response.ok) {
        if (response.status === 429) {
          setConnectedWithSyncWarning(
            "Trace is rate limiting saved filter sync. Your filters are still saved locally.",
            { lastHttpStatus: response.status },
          );
          return { ok: false, error: "rate_limited" };
        }
        if (response.status === 422) {
          const body = await response.json().catch(() => null);
          if (body?.code === "AO3_SAVED_FILTER_LIMIT_REACHED") {
            const limit = Number(body.limit || AO3_SAVED_FILTER_ACTIVE_LIMIT);
            setConnectedWithSyncWarning(
              `Trace can sync up to ${limit} AO3 saved filters. Delete one before saving another.`,
              { ao3SavedFilterLimit: limit, lastHttpStatus: response.status },
            );
            return {
              ok: false,
              error: "limit_reached",
              limit,
            };
          }
        }
        return { ok: false, error: "http_" + response.status };
      }

      const json = await response.json().catch(() => null);
      const data = json && json.data && typeof json.data === "object" ? json.data : null;
      if (!data || !isUsefulIsoDateTime(data.syncVersion)) {
        return { ok: false, error: "invalid_response" };
      }

      const merged = mergeAo3SavedFiltersAfterSync({
        presets,
        deleted,
        activeMeta: snapshot.traceAo3SavedFiltersActiveV1 || null,
        response: data,
        sentDeleteClientIds: new Set(batchDeletes.map((item) => item.clientId)),
      });
      const patch = {
        [AO3_SAVED_FILTERS_STORAGE_KEY]: merged.presets,
        [AO3_SAVED_FILTERS_DELETED_KEY]: merged.deleted,
        traceAo3SavedFiltersActiveV1: merged.activeMeta,
        [AO3_SAVED_FILTERS_SYNC_META_KEY]: {
          syncVersion: data.syncVersion,
          lastSyncedAt: new Date().toISOString(),
        },
        [AO3_SAVED_FILTERS_CLIENT_ID_KEY]: clientId,
      };
      await storageSetLocal(patch);
      snapshot = { ...snapshot, ...patch };
      lastSyncVersion = data.syncVersion;
      didSync = true;
      hasMorePending =
        upserts.length > batchUpserts.length ||
        deletes.length > batchDeletes.length;
      if (!hasMorePending) break;
    }

    if (!didSync) {
      return { ok: false, error: "not_synced" };
    }
    setConnectedState({ lastAo3SavedFiltersSyncAt: new Date().toISOString() });
    if (hasMorePending) scheduleAo3SavedFiltersSync(250);
    const result = { ok: true, syncVersion: lastSyncVersion };
    if (hasMorePending) result.partial = true;
    return result;
  } catch (error) {
    console.warn("[Trace] AO3 saved filters sync failed:", error);
    return { ok: false, error: "network_error" };
  } finally {
    ao3SavedFiltersSyncInFlight = false;
  }
}

/** Cache AO3/FFN work id → library status for content-script overlay. */
function refreshLibraryOverlay() {
  if (!bearerToken) return Promise.resolve();
  return new Promise((resolve) => {
    ext.storage.local.get([PREF_LIBRARY_INLAY_KEY], (prefRes) => {
      if (ext.runtime.lastError) {
        resolve();
        return;
      }
      if (prefRes[PREF_LIBRARY_INLAY_KEY] === false) {
        ext.storage.local.remove(OVERLAY_STORAGE_KEY, () => resolve());
        return;
      }
      void fetchLibraryOverlayFromApi().finally(resolve);
    });
  });
}

async function fetchLibraryOverlayFromApi() {
  if (!bearerToken) return;
  try {
    const response = await fetch(LIBRARY_OVERLAY_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    });
    const authError = await applyAuthFailureResponse(response);
    if (authError) {
      return;
    }
    if (!response.ok) {
      console.warn("[Trace] library overlay fetch failed:", response.status);
      return;
    }
    const json = await response.json();
    const data = json && json.data;
    if (data && data.entries && typeof data.syncVersion === "string") {
      const entries = applyOptimisticChapterFloors({ ...data.entries });
      await new Promise((resolve) => {
        ext.storage.local.set(
          {
            [OVERLAY_STORAGE_KEY]: {
              ...data,
              entries,
            },
            libraryOverlayFetchedAt: new Date().toISOString(),
          },
          resolve,
        );
      });
    }
  } catch (e) {
    console.warn("[Trace] library overlay network error:", e);
  }
}

function isTraceWebUrl(url) {
  if (!url) return false;
  const origin = TRACE_WEB_ORIGIN.replace(/\/$/, "");
  return String(url) === origin || String(url).startsWith(origin + "/");
}

function normalizeTraceWebOpenUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    const configuredOrigin = new URL(TRACE_WEB_ORIGIN).origin;
    const url = new URL(rawUrl, configuredOrigin);
    const allowedOrigins = new Set([
      configuredOrigin,
      "https://tracefiction.com",
      "https://www.tracefiction.com",
    ]);
    if (!allowedOrigins.has(url.origin)) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

async function handleOpenTraceUrl(payload, sendResponse) {
  const url = normalizeTraceWebOpenUrl(payload?.url);
  if (!url) {
    if (sendResponse) sendResponse({ ok: false, error: "invalid_trace_url" });
    return;
  }
  try {
    await ext.tabs.create({ url });
    if (sendResponse) sendResponse({ ok: true });
  } catch (error) {
    console.warn("[Trace] Failed to open Trace tab:", error);
    if (sendResponse) sendResponse({ ok: false, error: "open_failed" });
  }
}

/** Match patterns for `tabs.query({ url })` so we do not enumerate unrelated tabs (Chrome review / privacy). */
function traceWebTabQueryPatterns() {
  const origin = TRACE_WEB_ORIGIN.replace(/\/$/, "");
  const patterns = new Set([`${origin}/*`]);
  try {
    const host = new URL(origin).hostname;
    if (host === "tracefiction.com") {
      patterns.add("https://www.tracefiction.com/*");
    } else if (host === "www.tracefiction.com") {
      patterns.add("https://tracefiction.com/*");
    }
  } catch {
    /* ignore invalid TRACE_WEB_ORIGIN in edge builds */
  }
  return Array.from(patterns);
}

async function notifyTraceWebTabs(message) {
  if (!ext.tabs?.query || !ext.tabs?.sendMessage) return;
  try {
    const tabs = await ext.tabs.query({ url: traceWebTabQueryPatterns() });
    for (const tab of tabs || []) {
      if (!tab?.id || !isTraceWebUrl(tab.url)) continue;
      try {
        await ext.tabs.sendMessage(tab.id, message);
      } catch (error) {
        if (!isMissingTabReceiverError(error)) {
          console.warn("[Trace] Failed to notify Trace web tab:", error);
        }
      }
    }
  } catch (error) {
    console.warn("[Trace] Failed to enumerate Trace web tabs:", error);
  }
}

function signalLibraryInvalidated(reason) {
  return notifyTraceWebTabs({
    type: LIBRARY_INVALIDATED_MESSAGE,
    reason,
    at: new Date().toISOString(),
  });
}

function isAo3StoryUrl(url) {
  return AO3_STORY_URL_RE.test(String(url || ""));
}

function isAo3Host(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "archiveofourown.org" ||
    host.endsWith(".archiveofourown.org") ||
    host === "archiveofourown.gay" ||
    host.endsWith(".archiveofourown.gay") ||
    host === "archive.transformativeworks.org" ||
    host === "ao3.org" ||
    host.endsWith(".ao3.org")
  );
}

function isFfnHost(hostname) {
  return /(^|\.)fanfiction\.net$/i.test(String(hostname || ""));
}

function isAo3CredentialPath(pathname) {
  return /^\/users\/(?:login|sign_up|password|auth\/|logout)/i.test(String(pathname || ""));
}

function isFfnCredentialPath(pathname) {
  return /^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(String(pathname || ""));
}

function classifyActiveTabUrl(rawUrl) {
  if (!rawUrl) return { kind: "unknown" };
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (_) {
    return { kind: "unsupported" };
  }

  if (isTraceWebUrl(url.href)) return { kind: "trace" };

  if (isAo3Host(url.hostname)) {
    if (isAo3CredentialPath(url.pathname)) {
      return { kind: "blocked_archive", site: "ao3", canImport: false };
    }
    return {
      kind: /^\/works\/\d+(?:\/chapters\/\d+)?\/?$/i.test(url.pathname)
        ? "supported_story"
        : "supported_archive",
      site: "ao3",
      canImport: true,
    };
  }

  if (isFfnHost(url.hostname)) {
    if (isFfnCredentialPath(url.pathname)) {
      return { kind: "blocked_archive", site: "ffn", canImport: false };
    }
    return {
      kind: FFN_STORY_PATH_RE.test(url.pathname)
        ? "supported_story"
        : "supported_archive",
      site: "ffn",
      canImport: true,
    };
  }

  return { kind: "unsupported" };
}

async function getActiveTabContext() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    return classifyActiveTabUrl(tab && tab.url);
  } catch (_) {
    return { kind: "unknown" };
  }
}

function pingAo3TabForAutoTrack(tabId) {
  if (!tabId || !ext.tabs?.sendMessage) return;
  setTimeout(() => {
    ext.tabs
      .sendMessage(tabId, {
        type: "TRACE_SCHEDULE_AUTO_TRACK",
        trigger: "background_tab_complete",
      })
      .catch((error) => {
        if (!isMissingTabReceiverError(error)) {
          console.warn("[Trace] Failed to ping AO3 tab for auto-track:", error);
        }
      });
  }, 200);
}

try {
  ext.storage.local.get([AUTH_TOKEN_KEY, AUTH_STATE_KEY], (res) => {
    const storedToken =
      typeof res?.authToken === "string" ? res.authToken.trim() : "";
    if (storedToken) {
      const storedState =
        res[AUTH_STATE_KEY] && typeof res[AUTH_STATE_KEY] === "object"
          ? res[AUTH_STATE_KEY]
          : null;
      void verifyTraceAccountToken(storedToken, {
        lastTokenSyncAt: storedState?.lastTokenSyncAt || new Date().toISOString(),
      });
    } else {
      setSignedOutState();
    }
  });
} catch (e) {
  console.error("[Trace] Failed to read storage on boot:", e);
  setErrorState("Trace could not load extension storage.");
}

try {
  ext.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (!tabId) return;
    if (changeInfo?.status !== "complete") return;
    if (!isAo3StoryUrl(tab?.url)) return;
    pingAo3TabForAutoTrack(tabId);
  });
} catch (e) {
  console.warn("[Trace] Failed to attach tabs.onUpdated listener:", e);
}

// Listen for messages
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // -------------------------------------------------
  // A. Token update from sync.js
  // -------------------------------------------------
  if (msg.type === "TRACE_AUTH_UPDATE") {
    const token = typeof msg.token === "string" ? msg.token.trim() : "";

    if (!token) {
      clearToken();
      setSignedOutState();
      clearBadge(sender?.tab?.id);
      if (sendResponse) sendResponse({ success: true, state: "signed_out" });
      return;
    }

    setBadge(sender?.tab?.id, "SYNC", "#2196F3");
    setTimeout(() => clearBadge(sender?.tab?.id), 2000);

    void verifyTraceAccountToken(token, {
      lastTokenSyncAt: new Date().toISOString(),
    }).then((result) => {
      if (sendResponse) sendResponse(result);
    });
    return true;
  }

  // -------------------------------------------------
  // A2. Trace-origin extension status handshake
  // -------------------------------------------------
  if (msg.type === EXTENSION_STATUS_QUERY_MESSAGE) {
    const nonce = typeof msg.nonce === "string" ? msg.nonce : "";
    if (!nonce.trim()) return false;

    try {
      ext.storage.local.get(
        [
          AUTH_TOKEN_KEY,
          AUTH_STATE_KEY,
          TRACE_FIRST_SAVE_SEEN_KEY,
          ARCHIVE_READINESS_KEY,
        ],
        (res) => {
          if (ext.runtime.lastError) {
            if (sendResponse) sendResponse(safeUnknownExtensionStatus());
            return;
          }
          if (sendResponse) sendResponse(buildExtensionStatus(res || {}));
        },
      );
    } catch (_) {
      if (sendResponse) sendResponse(safeUnknownExtensionStatus());
    }
    return true;
  }

  // -------------------------------------------------
  // B. Auto-track request from collector.js
  // -------------------------------------------------
  if (msg.type === "TRACE_AUTO_TRACK") {
    handleAutoTrack(msg.payload, sender, sendResponse);
    return true;
  }

  // -------------------------------------------------
  // F. Popup: Pro + prefs for Trace Pro toggles
  // -------------------------------------------------
  if (msg.type === "TRACE_POPUP_GET_STATE") {
    (async () => {
      await fetchTraceUserProPromise();
      ext.storage.local.get(
        [
          AUTH_STATE_KEY,
          TRACE_FIRST_SAVE_SEEN_KEY,
          TRACE_LIBRARY_COUNT_KEY,
          PREF_AUTO_TRACK_KEY,
          PREF_LIBRARY_INLAY_KEY,
          PREF_AO3_SAVED_FILTERS_KEY,
          PREF_METADATA_IMPROVE_KEY,
          TRACE_USER_PRO_KEY,
        ],
        async (r) => {
          const activeTab = await getActiveTabContext();
          if (sendResponse) {
            sendResponse({
              authState: r[AUTH_STATE_KEY] || null,
              firstSaveSeen: r[TRACE_FIRST_SAVE_SEEN_KEY] === true,
              libraryCount:
                typeof r[TRACE_LIBRARY_COUNT_KEY] === "number"
                  ? r[TRACE_LIBRARY_COUNT_KEY]
                  : null,
              activeTab,
              pro: r[TRACE_USER_PRO_KEY] === true,
              autoTrackEnabled: r[PREF_AUTO_TRACK_KEY] !== false,
              libraryInlayEnabled: r[PREF_LIBRARY_INLAY_KEY] !== false,
              ao3SavedFiltersEnabled: r[PREF_AO3_SAVED_FILTERS_KEY] !== false,
              metadataImproveEnabled: r[PREF_METADATA_IMPROVE_KEY] !== false,
            });
          }
        },
      );
    })();
    return true;
  }

  // -------------------------------------------------
  // C. Manual import trigger from popup
  // -------------------------------------------------
  if (msg.type === "TRACE_IMPORT_TRIGGER") {
    handleImportTrigger(sendResponse);
    return true;
  }

  // -------------------------------------------------
  // C2. Open Trace from content scripts in a browser tab
  // -------------------------------------------------
  if (msg.type === "TRACE_OPEN_TRACE_URL") {
    handleOpenTraceUrl(msg.payload, sendResponse);
    return true;
  }

  // -------------------------------------------------
  // E. Popup opened — heal stale error state if token still present
  // -------------------------------------------------
  if (msg.type === "TRACE_POPUP_OPEN") {
    void (async () => {
      const res = await storageGetLocal([AUTH_TOKEN_KEY, AUTH_STATE_KEY]);
      const token = res?.[AUTH_TOKEN_KEY];
      const prev = res?.[AUTH_STATE_KEY];
      if (token) {
        bearerToken = token;
        if (prev?.state === "error" || prev?.state === "unknown") {
          await verifyTraceAccountToken(token);
        } else {
          await fetchTraceUserProPromise();
        }
        scheduleAo3SavedFiltersSync(500);
      }
      if (sendResponse) sendResponse({ ok: true });
    })();
    return true;
  }

  // -------------------------------------------------
  // D. Metadata broadcast from collector.js
  // -------------------------------------------------
  if (msg.type === "TRACE_METADATA_BROADCAST") {
    handleMetadataBroadcast(msg.payload, sender);
    return false;
  }

  if (msg.type === "TRACE_LIBRARY_METADATA_REFRESH") {
    handleLibraryMetadataRefresh(msg.payload, sender);
    return false;
  }

  // -------------------------------------------------
  // D2. AO3 saved filter local changes need background sync
  // -------------------------------------------------
  if (msg.type === AO3_SAVED_FILTERS_SYNC_REQUEST_MESSAGE) {
    scheduleAo3SavedFiltersSync(150);
    if (sendResponse) sendResponse({ ok: true, queued: Boolean(bearerToken) });
    return false;
  }

  // -------------------------------------------------
  // G. Quick-add from inline button on story pages
  // -------------------------------------------------
  if (msg.type === "TRACE_QUICK_ADD") {
    handleQuickAdd(msg.payload, sender, sendResponse);
    return true; // async response
  }

  // -------------------------------------------------
  // H. Hidden work preference from listing overlay
  // -------------------------------------------------
  if (msg.type === "TRACE_SET_HIDDEN_WORK") {
    handleSetHiddenWork(msg.payload, sender, sendResponse);
    return true; // async response
  }

  // -------------------------------------------------
  // I. Reading status update from story sheet
  // -------------------------------------------------
  if (msg.type === "TRACE_SET_READER_STATUS") {
    handleSetReaderStatus(msg.payload, sender, sendResponse);
    return true; // async response
  }

  // -------------------------------------------------
  // J. Library entry patch from extension reader actions
  // -------------------------------------------------
  if (msg.type === "TRACE_PATCH_LIBRARY_ENTRY") {
    handlePatchLibraryEntry(msg.payload, sender, sendResponse);
    return true; // async response
  }

  // -------------------------------------------------
  // K. Finish-qualification signal for Check-in fallback
  // -------------------------------------------------
  if (msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL") {
    handleFinishQualificationSignal(msg.payload, sender, sendResponse);
    return true; // async response
  }
});

// =======================================================
// 2. MANUAL IMPORT
// =======================================================

/** tabs.sendMessage when no content script is listening (chrome://, PDF, post-reload tab, etc.). */
function isMissingTabReceiverError(e) {
  const parts = [
    typeof e === "string" ? e : "",
    e?.message,
    typeof e?.toString === "function" && e.toString !== Object.prototype.toString
      ? e.toString()
      : "",
    e?.stack,
    ext.runtime.lastError?.message,
  ];
  const msg = parts.filter(Boolean).join("\n");
  return /receiving end does not exist/i.test(msg);
}

function toBase64Json(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function handleImportTrigger(sendResponse) {
  let activeTabContext = null;
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    activeTabContext = classifyActiveTabUrl(tab && tab.url);
    if (!tab?.id) {
      if (sendResponse) sendResponse({ ok: false, error: "no_active_tab" });
      return;
    }

    const res = await ext.tabs.sendMessage(tab.id, { type: "TRACE_COLLECT" });
    if (!res?.ok || !res.payload) {
      setBadge(tab.id, "ERR", "#B3261E");
      recordArchiveReadiness({
        hostKind: archiveHostKindFromTabContext(activeTabContext),
        errorKind:
          res?.error === "page_contains_password_field"
            ? "unsupported_page"
            : tabContextLooksLikeArchive(activeTabContext)
              ? "parser"
              : "unsupported_page",
      });
      if (sendResponse) sendResponse({ ok: false, error: res?.error || "collect_failed" });
      return;
    }

    const b64 = toBase64Json(res.payload);
    const url = `${IMPORT_BASE}#U${encodeURIComponent(b64)}`;
    await ext.tabs.create({ url });
    if (Array.isArray(res.payload.items) && res.payload.items.length > 0) {
      recordArchiveActionFromPayload(res.payload, "import");
    } else {
      recordArchiveReadiness({
        hostKind: archiveHostKindFromTabContext(activeTabContext),
        errorKind: "unsupported_page",
      });
    }
    if (sendResponse) sendResponse({ ok: true });
  } catch (e) {
    if (isMissingTabReceiverError(e)) {
      console.debug("[Trace] Import skipped (no collector on this tab)");
      recordArchiveReadiness({
        hostKind: archiveHostKindFromTabContext(activeTabContext),
        errorKind: tabContextLooksLikeArchive(activeTabContext)
          ? "permission"
          : "unsupported_page",
      });
    } else {
      console.error("[Trace] Import trigger failed:", e);
      recordArchiveReadiness({
        hostKind: archiveHostKindFromTabContext(activeTabContext),
        errorKind: tabContextLooksLikeArchive(activeTabContext)
          ? "unknown"
          : "unsupported_page",
      });
    }
    if (sendResponse) sendResponse({ ok: false, error: String(e?.message || e) });
  }
}

// =======================================================
// 3. AUTOMATIC TRACKING
// =======================================================

function handleAutoTrack(payload, sender, sendResponse) {
  if (!bearerToken) {
    recordArchiveIssueFromPayload(payload, "auth");
    setSignedOutState({
      message: "Open Trace in this browser and sign in, then automatic sync will work.",
      lastTrackAttemptAt: new Date().toISOString(),
    });
    setBadge(sender?.tab?.id, "LOG", "#9C6B00");
    if (sendResponse) sendResponse({ ok: false, error: "not_authenticated" });
    return;
  }

  if (shouldIgnoreSenderForAutoTrack(sender)) {
    if (sendResponse) sendResponse({ ok: false, error: "ignored_sender" });
    return;
  }

  ext.storage.local.get(
    [PREF_AUTO_TRACK_KEY],
    (prefRes) => {
      if (ext.runtime.lastError) {
        void executeAutoTrack(payload, sender)
          .then((result) => {
            if (sendResponse) sendResponse(result);
          })
          .catch((error) => {
            if (sendResponse) sendResponse({ ok: false, error: String(error?.message || error) });
          });
        return;
      }
      if (prefRes[PREF_AUTO_TRACK_KEY] === false) {
        if (sendResponse) sendResponse({ ok: false, error: "auto_track_disabled" });
        return;
      }
      void executeAutoTrack(payload, sender)
        .then((result) => {
          if (sendResponse) sendResponse(result);
        })
        .catch((error) => {
          if (sendResponse) sendResponse({ ok: false, error: String(error?.message || error) });
        });
    },
  );
}

async function executeAutoTrack(payload, sender) {
  if (!bearerToken) return;
  recordOptimisticChapterFloor(payload && payload.item);
  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const authError = await applyAuthFailureResponse(response, {
        actionAtKey: "lastTrackAttemptAt",
      });
      if (authError) {
        recordArchiveIssueFromPayload(payload, "auth");
        setBadge(sender?.tab?.id, "LOG", "#9C6B00");
        return { ok: false, error: authError };
      } else if (response.status === 402) {
        await refreshLibraryOverlay();
        setUpgradeState(
          "You've reached the free library limit. Upgrade to Pro for unlimited stories.",
          {
            lastTrackAttemptAt: new Date().toISOString(),
            lastHttpStatus: response.status,
          },
        );
        setBadge(sender?.tab?.id, "FULL", "#735B1A");
        return { ok: false, error: "free_limit_reached" };
      } else {
        recordArchiveIssueFromPayload(
          payload,
          response.status === 400 ? "parser" : "network",
        );
        await refreshLibraryOverlay();
        setConnectedWithSyncWarning(
          `Automatic sync didn’t go through (${response.status}). Manual import from this menu still works.`,
          {
            lastTrackAttemptAt: new Date().toISOString(),
            lastHttpStatus: response.status,
          },
        );
        setBadge(sender?.tab?.id, "!", "#9C6B00");
        return { ok: false, error: "http_" + response.status };
      }
    } else {
      recordArchiveActionFromPayload(payload, "track");
      markFirstSaveSeen();
      setConnectedState({
        firstSaveSeen: true,
        lastTrackSuccessAt: new Date().toISOString(),
      });
      const json = await response.json().catch(() => null);
      const entryId =
        json && json.data && typeof json.data.entry_id === "string"
          ? json.data.entry_id
          : null;
      await refreshLibraryOverlay();
      await signalLibraryInvalidated("track");
      setBadge(sender?.tab?.id, "OK", "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      return entryId ? { ok: true, entryId } : { ok: true };
    }
  } catch (error) {
    console.error("[Trace] Network error:", error);
    recordArchiveIssueFromPayload(payload, "network");
    await refreshLibraryOverlay();
    setConnectedWithSyncWarning(
      "Couldn’t reach Trace for automatic sync. Manual import still works — try again later for sync.",
      {
        lastTrackAttemptAt: new Date().toISOString(),
      },
    );
    setBadge(sender?.tab?.id, "!", "#9C6B00");
    return { ok: false, error: "network_error" };
  }
}

// =======================================================
// 4. METADATA BROADCAST
// =======================================================

async function handleMetadataBroadcast(payload, sender) {
  if (!bearerToken) return;

  const shouldBroadcast = await new Promise((resolve) => {
    ext.storage.local.get([PREF_METADATA_IMPROVE_KEY], (prefRes) => {
      if (ext.runtime.lastError) {
        resolve(true);
        return;
      }
      resolve(prefRes[PREF_METADATA_IMPROVE_KEY] !== false);
    });
  });
  if (!shouldBroadcast) return;

  try {
    const response = await fetch(METADATA_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload),
    });

    const authError = await applyAuthFailureResponse(response);
    if (authError) {
      recordArchiveIssueFromPayload(payload, "auth");
    } else if (response.ok) {
      recordArchiveActionFromPayload(payload, "metadata");
      await signalLibraryInvalidated("metadata");
    } else {
      recordArchiveIssueFromPayload(
        payload,
        response.status === 400 ? "parser" : "network",
      );
    }
  } catch (error) {
    console.error("[Trace] Metadata broadcast error:", error);
    recordArchiveIssueFromPayload(payload, "network");
  }
}

async function handleLibraryMetadataRefresh(payload, sender) {
  if (!bearerToken) return;

  const shouldBroadcast = await new Promise((resolve) => {
    ext.storage.local.get([PREF_METADATA_IMPROVE_KEY], (prefRes) => {
      if (ext.runtime.lastError) {
        resolve(true);
        return;
      }
      resolve(prefRes[PREF_METADATA_IMPROVE_KEY] !== false);
    });
  });
  if (!shouldBroadcast) return;

  try {
    const response = await fetch(LIBRARY_METADATA_REFRESH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload),
    });

    const authError = await applyAuthFailureResponse(response);
    if (authError) {
      recordArchiveIssueFromPayload(payload, "auth");
      return;
    }
    if (!response.ok) {
      recordArchiveIssueFromPayload(
        payload,
        response.status === 400 ? "parser" : "network",
      );
      return;
    }

    const json = await response.json().catch(() => null);
    const updated =
      json && json.data && typeof json.data.updated === "number"
        ? json.data.updated
        : 0;
    if (updated > 0) {
      recordArchiveActionFromPayload(payload, "metadata");
      await signalLibraryInvalidated("metadata");
    }
  } catch (error) {
    console.error("[Trace] Library metadata refresh error:", error);
    recordArchiveIssueFromPayload(payload, "network");
  }
}

// =======================================================
// 5. QUICK-ADD (inline button on story pages)
// =======================================================

async function handleQuickAdd(payload, sender, sendResponse) {
  if (!bearerToken) {
    recordArchiveIssueFromPayload(payload, "auth");
    if (sendResponse) sendResponse({ ok: false, error: "not_authenticated" });
    return;
  }

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      recordArchiveActionFromPayload(payload, "quick_add");
      const json = await response.json().catch(() => null);
      const entryId =
        json && json.data && typeof json.data.entry_id === "string"
          ? json.data.entry_id
          : null;
      markFirstSaveSeen();
      setConnectedState({
        firstSaveSeen: true,
        lastQuickAddAt: new Date().toISOString(),
      });
      setBadge(sender?.tab?.id, "OK", "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      await refreshLibraryOverlay();
      await signalLibraryInvalidated("quick_add");
      if (sendResponse) {
        const payload = { ok: true };
        if (entryId) payload.entryId = entryId;
        sendResponse(payload);
      }
    } else {
      const authError = await applyAuthFailureResponse(response, {
        actionAtKey: "lastQuickAddAt",
      });
      if (authError) {
        recordArchiveIssueFromPayload(payload, "auth");
        if (sendResponse) sendResponse({ ok: false, error: authError });
      } else if (response.status === 402) {
        if (sendResponse) sendResponse({ ok: false, error: "free_limit_reached" });
      } else {
        recordArchiveIssueFromPayload(
          payload,
          response.status === 400 ? "parser" : "network",
        );
        if (sendResponse) sendResponse({ ok: false, error: "http_" + response.status });
      }
    }
  } catch (e) {
    console.error("[Trace] Quick-add error:", e);
    recordArchiveIssueFromPayload(payload, "network");
    if (sendResponse) sendResponse({ ok: false, error: String(e?.message || e) });
  }
}

// =======================================================
// 6. WORK PREFERENCES (listing overlay hide/unhide)
// =======================================================

function isValidExternalWorkKey(key) {
  return /^(?:ao3|ffn):\d+$/.test(String(key || ""));
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function normalizeReaderStatusForPatch(value) {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return null;
  }
  const raw = String(value).trim().toUpperCase();
  if (!raw) return null;
  if (raw === "PLANNING") return "SAVED";
  if (raw === "COMPLETED") return "FINISHED";
  if (
    raw === "SAVED" ||
    raw === "READING" ||
    raw === "CAUGHT_UP" ||
    raw === "PAUSED" ||
    raw === "FINISHED" ||
    raw === "DROPPED"
  ) {
    return raw;
  }
  return null;
}

function legacyReaderStatusForOverlay(status) {
  const normalized = normalizeReaderStatusForPatch(status);
  if (normalized === "SAVED") return "PLANNING";
  if (normalized === "CAUGHT_UP") return "READING";
  if (normalized === "FINISHED") return "COMPLETED";
  return normalized;
}

function isStorySheetReaderStatus(status) {
  return normalizeReaderStatusForPatch(status) !== null;
}

function normalizeWorkStatusOverride(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return undefined;
  if (normalized === "complete") return "complete";
  if (normalized === "wip" || normalized === "ongoing") return "wip";
  if (normalized === "hiatus" || normalized === "on_hiatus" || normalized === "paused") return "hiatus";
  if (normalized === "abandoned") return "abandoned";
  return undefined;
}

function normalizePatchStorySnapshot(rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) return null;
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(rawSnapshot, "work_status_override")) {
    const workStatusOverride = normalizeWorkStatusOverride(rawSnapshot.work_status_override);
    if (workStatusOverride === undefined) return null;
    patch.work_status_override = workStatusOverride;
  }
  if (Object.prototype.hasOwnProperty.call(rawSnapshot, "abandoned_at_chapters_published")) {
    if (rawSnapshot.abandoned_at_chapters_published === null) {
      patch.abandoned_at_chapters_published = null;
    } else {
      const value = Number(rawSnapshot.abandoned_at_chapters_published);
      if (!Number.isInteger(value) || value < 0 || value > 10_000_000) return null;
      patch.abandoned_at_chapters_published = value;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function patchOverlayHiddenPreference(key, hidden) {
  return new Promise((resolve) => {
    try {
      ext.storage.local.get([OVERLAY_STORAGE_KEY], (res) => {
        if (ext.runtime.lastError) {
          resolve();
          return;
        }

        const prev =
          res && res[OVERLAY_STORAGE_KEY] && typeof res[OVERLAY_STORAGE_KEY] === "object"
            ? res[OVERLAY_STORAGE_KEY]
            : {};
        const entries =
          prev.entries && typeof prev.entries === "object"
            ? { ...prev.entries }
            : {};
        const workPreferences =
          prev.workPreferences && typeof prev.workPreferences === "object"
            ? { ...prev.workPreferences }
            : {};

        const existingEntry = entries[key];
        if (existingEntry && typeof existingEntry === "object") {
          const nextEntry = { ...existingEntry };
          if (hidden) {
            nextEntry.browsePreference = {
              ...(existingEntry.browsePreference || {}),
              hidden: true,
            };
          } else if (nextEntry.browsePreference) {
            nextEntry.browsePreference = { ...nextEntry.browsePreference };
            delete nextEntry.browsePreference.hidden;
            if (Object.keys(nextEntry.browsePreference).length === 0) {
              delete nextEntry.browsePreference;
            }
          }
          entries[key] = nextEntry;
        }

        if (hidden) {
          workPreferences[key] = { browsePreference: { hidden: true } };
        } else {
          delete workPreferences[key];
        }

        ext.storage.local.set(
          {
            [OVERLAY_STORAGE_KEY]: {
              ...prev,
              entries,
              workPreferences,
              syncVersion: new Date().toISOString(),
            },
          },
          () => resolve(),
        );
      });
    } catch (_) {
      resolve();
    }
  });
}

async function handleSetHiddenWork(payload, sender, sendResponse) {
  if (!bearerToken) {
    if (sendResponse) sendResponse({ ok: false, error: "not_authenticated" });
    return;
  }

  const key = payload && typeof payload.key === "string" ? payload.key.trim() : "";
  const hidden = payload && payload.hidden === true;
  if (!isValidExternalWorkKey(key) || typeof payload?.hidden !== "boolean") {
    if (sendResponse) sendResponse({ ok: false, error: "invalid_request" });
    return;
  }

  try {
    const response = await fetch(WORK_PREFERENCES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ key, hidden }),
    });

    if (response.ok) {
      setConnectedState({ lastWorkPreferenceAt: new Date().toISOString() });
      setBadge(sender?.tab?.id, hidden ? "HID" : "OK", hidden ? "#5B5142" : "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      await patchOverlayHiddenPreference(key, hidden);
      await signalLibraryInvalidated("work_preference");
      if (sendResponse) sendResponse({ ok: true, key, hidden });
    } else {
      const authError = await applyAuthFailureResponse(response, {
        actionAtKey: "lastWorkPreferenceAt",
      });
      if (authError) {
        if (sendResponse) sendResponse({ ok: false, error: authError });
      } else if (response.status === 402) {
        setUpgradeState(
          "You've reached the free library limit. Upgrade to Pro for unlimited stories.",
          { lastHttpStatus: response.status },
        );
        if (sendResponse) sendResponse({ ok: false, error: "free_limit_reached" });
      } else if (response.status === 429) {
        setConnectedWithSyncWarning(
          "Trace is rate limiting preference changes. Try again in a few minutes.",
          { lastHttpStatus: response.status },
        );
        if (sendResponse) sendResponse({ ok: false, error: "rate_limited" });
      } else {
        if (sendResponse) sendResponse({ ok: false, error: "http_" + response.status });
      }
    }
  } catch (e) {
    console.error("[Trace] Work preference error:", e);
    if (sendResponse) sendResponse({ ok: false, error: "network_error" });
  }
}

// =======================================================
// 7. READER STATUS (story sheet post-add choices)
// =======================================================

function normalizeReaderProgress(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.unit !== "CHAPTER") return null;
  const value = Number(raw.value);
  if (!Number.isFinite(value) || value < 0) return null;
  const progress = { unit: "CHAPTER", value: Math.trunc(value) };
  if (raw.total === null || raw.total === undefined) {
    progress.total = null;
  } else {
    const total = Number(raw.total);
    if (!Number.isFinite(total) || total < 0) return null;
    progress.total = Math.trunc(total);
  }
  return progress;
}

function chaptersFromReaderProgress(progress) {
  if (!progress || progress.unit !== "CHAPTER") return null;
  return {
    current: progress.value,
    total: progress.total == null ? null : progress.total,
  };
}

function normalizeLibraryEntryPatch(rawPatch) {
  if (!rawPatch || typeof rawPatch !== "object") return null;
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(rawPatch, "rating")) {
    const rating = Number(rawPatch.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) return null;
    patch.rating = rating;
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "progress")) {
    const progress = normalizeReaderProgress(rawPatch.progress);
    if (!progress) return null;
    patch.progress = progress;
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "status")) {
    const status = normalizeReaderStatusForPatch(rawPatch.status);
    if (!status) return null;
    patch.status = status;
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "story_snapshot")) {
    const storySnapshot = normalizePatchStorySnapshot(rawPatch.story_snapshot);
    if (!storySnapshot) return null;
    patch.story_snapshot = storySnapshot;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function normalizeFinishQualificationSignal(rawSignal) {
  if (!rawSignal || typeof rawSignal !== "object") return null;
  const entryId =
    typeof rawSignal.entryId === "string" ? rawSignal.entryId.trim() : "";
  if (!isValidUuid(entryId)) return null;

  const source = String(rawSignal.source || "").trim().toLowerCase();
  if (source !== "ao3" && source !== "ffn") return null;

  const chapter = Number(rawSignal.chapter);
  const total = Number(rawSignal.total);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 10_000_000) return null;
  if (!Number.isInteger(total) || total < 1 || total > 10_000_000) return null;

  const state = String(rawSignal.state || "").trim().toLowerCase();
  if (state !== "open" && state !== "resolved") return null;

  const payload = {
    entryId,
    source,
    chapter,
    total,
    state,
  };

  if (typeof rawSignal.workKey === "string") {
    const workKey = rawSignal.workKey.trim();
    if (workKey && isValidExternalWorkKey(workKey)) payload.workKey = workKey;
  }

  if (state === "resolved") {
    const workStatus = normalizeWorkStatusOverride(rawSignal.workStatus);
    const readerStatus = normalizeReaderStatusForPatch(rawSignal.readerStatus);
    if (!workStatus || !readerStatus) return null;
    payload.workStatus = workStatus;
    payload.readerStatus = readerStatus;
  }

  return payload;
}

function patchOverlayReaderStatus(entryId, status, progress) {
  return new Promise((resolve) => {
    try {
      ext.storage.local.get([OVERLAY_STORAGE_KEY], (res) => {
        if (ext.runtime.lastError) {
          resolve(null);
          return;
        }

        const prev =
          res && res[OVERLAY_STORAGE_KEY] && typeof res[OVERLAY_STORAGE_KEY] === "object"
            ? res[OVERLAY_STORAGE_KEY]
            : {};
        const entries =
          prev.entries && typeof prev.entries === "object"
            ? { ...prev.entries }
            : {};
        let patchedKey = null;

        for (const [key, rawEntry] of Object.entries(entries)) {
          if (!rawEntry || typeof rawEntry !== "object") continue;
          if (rawEntry.entryId !== entryId) continue;
          const canonicalStatus = normalizeReaderStatusForPatch(status);
          const legacyStatus = legacyReaderStatusForOverlay(canonicalStatus);
          entries[key] = {
            ...rawEntry,
            status: legacyStatus,
            readerStatus: legacyStatus,
            canonicalReaderStatus: canonicalStatus,
            ...(chaptersFromReaderProgress(progress)
              ? { chapters: chaptersFromReaderProgress(progress) }
              : {}),
          };
          patchedKey = key;
          break;
        }

        if (!patchedKey) {
          resolve(null);
          return;
        }

        ext.storage.local.set(
          {
            [OVERLAY_STORAGE_KEY]: {
              ...prev,
              entries,
              syncVersion: new Date().toISOString(),
            },
          },
          () => resolve(patchedKey),
        );
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function patchOverlayLibraryEntry(entryId, patch) {
  return new Promise((resolve) => {
    try {
      ext.storage.local.get([OVERLAY_STORAGE_KEY], (res) => {
        if (ext.runtime.lastError) {
          resolve(null);
          return;
        }

        const prev =
          res && res[OVERLAY_STORAGE_KEY] && typeof res[OVERLAY_STORAGE_KEY] === "object"
            ? res[OVERLAY_STORAGE_KEY]
            : {};
        const entries =
          prev.entries && typeof prev.entries === "object"
            ? { ...prev.entries }
            : {};
        let patchedKey = null;

        for (const [key, rawEntry] of Object.entries(entries)) {
          if (!rawEntry || typeof rawEntry !== "object") continue;
          if (rawEntry.entryId !== entryId) continue;

          const nextEntry = { ...rawEntry };
          if (patch.status) {
            const legacyStatus = legacyReaderStatusForOverlay(patch.status);
            nextEntry.status = legacyStatus;
            nextEntry.readerStatus = legacyStatus;
            nextEntry.canonicalReaderStatus = patch.status;
          }
          if (patch.progress) {
            const nextChapters = chaptersFromReaderProgress(patch.progress);
            if (nextChapters) {
              const previousCurrent =
                rawEntry.chapters && typeof rawEntry.chapters.current === "number"
                  ? rawEntry.chapters.current
                  : null;
              const previousNew =
                typeof rawEntry.newChapterCount === "number" &&
                Number.isFinite(rawEntry.newChapterCount)
                  ? rawEntry.newChapterCount
                  : null;
              const inferredPublished =
                previousCurrent == null || previousNew == null
                  ? null
                  : previousCurrent + previousNew;
              nextEntry.chapters = nextChapters;
              if (inferredPublished != null) {
                const nextNewChapterCount = Math.max(
                  0,
                  inferredPublished - nextChapters.current,
                );
                nextEntry.newChapterCount = nextNewChapterCount;
                nextEntry.catchupState =
                  nextNewChapterCount > 0 ? "BEHIND" : "UP";
              }
            }
          }
          if (Object.prototype.hasOwnProperty.call(patch, "rating")) {
            nextEntry.rating = patch.rating;
          }
          if (patch.story_snapshot && Object.prototype.hasOwnProperty.call(patch.story_snapshot, "work_status_override")) {
            const override = patch.story_snapshot.work_status_override;
            if (override === null) {
              nextEntry.workStatus = "unknown";
              nextEntry.workStatusProvenance = "unknown";
              if (nextEntry.workMark && nextEntry.workMark.kind === "abandoned") delete nextEntry.workMark;
            } else {
              nextEntry.workStatus = override;
              nextEntry.workStatusProvenance = "override";
              if (override === "abandoned") {
                nextEntry.workMark = { kind: "abandoned" };
              } else if (nextEntry.workMark && nextEntry.workMark.kind === "abandoned") {
                delete nextEntry.workMark;
              }
            }
          }

          entries[key] = nextEntry;
          patchedKey = key;
          break;
        }

        if (!patchedKey) {
          resolve(null);
          return;
        }

        ext.storage.local.set(
          {
            [OVERLAY_STORAGE_KEY]: {
              ...prev,
              entries,
              syncVersion: new Date().toISOString(),
            },
          },
          () => resolve(patchedKey),
        );
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function handlePatchLibraryEntry(payload, sender, sendResponse) {
  if (!bearerToken) {
    if (sendResponse) sendResponse({ ok: false, error: "not_authenticated" });
    return;
  }

  const entryId = payload && typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  const patch = normalizeLibraryEntryPatch(payload && payload.patch);
  if (!isValidUuid(entryId) || !patch) {
    if (sendResponse) sendResponse({ ok: false, error: "invalid_request" });
    return;
  }

  try {
    const response = await fetch(`${LIBRARY_ENTRY_ENDPOINT_BASE}/${encodeURIComponent(entryId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(patch),
    });

    if (response.ok) {
      markFirstSaveSeen();
      setConnectedState({
        firstSaveSeen: true,
        lastLibraryEntryPatchAt: new Date().toISOString(),
      });
      setBadge(sender?.tab?.id, "OK", "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      const workKey = await patchOverlayLibraryEntry(entryId, patch);
      await signalLibraryInvalidated("library_entry_patch");
      if (sendResponse) sendResponse({ ok: true, entryId, patch, workKey });
    } else {
      const authError = await applyAuthFailureResponse(response, {
        actionAtKey: "lastLibraryEntryPatchAt",
      });
      if (authError) {
        if (sendResponse) sendResponse({ ok: false, error: authError });
      } else if (response.status === 402) {
        setUpgradeState(
          "You've reached the free library limit. Upgrade to Pro for unlimited stories.",
          { lastHttpStatus: response.status },
        );
        if (sendResponse) sendResponse({ ok: false, error: "free_limit_reached" });
      } else if (response.status === 429) {
        setConnectedWithSyncWarning(
          "Trace is rate limiting library updates. Try again in a few minutes.",
          { lastHttpStatus: response.status },
        );
        if (sendResponse) sendResponse({ ok: false, error: "rate_limited" });
      } else {
        if (sendResponse) sendResponse({ ok: false, error: "http_" + response.status });
      }
    }
  } catch (e) {
    console.error("[Trace] Library entry patch error:", e);
    if (sendResponse) sendResponse({ ok: false, error: "network_error" });
  }
}

async function handleFinishQualificationSignal(payload, sender, sendResponse) {
  if (!bearerToken) {
    if (sendResponse) sendResponse({ ok: false, error: "not_authenticated" });
    return;
  }

  const signal = normalizeFinishQualificationSignal(payload);
  if (!signal) {
    if (sendResponse) sendResponse({ ok: false, error: "invalid_request" });
    return;
  }

  try {
    const response = await fetch(FINISH_QUALIFICATION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(signal),
    });

    if (response.ok) {
      setConnectedState({ lastFinishQualificationAt: new Date().toISOString() });
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      if (sendResponse) sendResponse({ ok: true, data: data && data.data });
    } else {
      const authError = await applyAuthFailureResponse(response, {
        actionAtKey: "lastFinishQualificationAt",
      });
      if (authError) {
        if (sendResponse) sendResponse({ ok: false, error: authError });
      } else if (response.status === 429) {
        setConnectedWithSyncWarning(
          "Trace is rate limiting finish updates. Try again in a few minutes.",
          { lastHttpStatus: response.status },
        );
        if (sendResponse) sendResponse({ ok: false, error: "rate_limited" });
      } else {
        if (sendResponse) sendResponse({ ok: false, error: "http_" + response.status });
      }
    }
  } catch (e) {
    console.error("[Trace] Finish qualification signal error:", e);
    if (sendResponse) sendResponse({ ok: false, error: "network_error" });
  }
}

async function handleSetReaderStatus(payload, sender, sendResponse) {
  if (!bearerToken) {
    if (sendResponse) sendResponse({ ok: false, error: "not_authenticated" });
    return;
  }

  const entryId = payload && typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  const status = normalizeReaderStatusForPatch(payload && payload.status);
  const progress = normalizeReaderProgress(payload && payload.progress);
  if (!isValidUuid(entryId) || !status || ((payload && payload.progress) && !progress)) {
    if (sendResponse) sendResponse({ ok: false, error: "invalid_request" });
    return;
  }

  try {
    const response = await fetch(`${LIBRARY_ENTRY_ENDPOINT_BASE}/${encodeURIComponent(entryId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(progress ? { status, progress } : { status }),
    });

    if (response.ok) {
      markFirstSaveSeen();
      setConnectedState({
        firstSaveSeen: true,
        lastReaderStatusAt: new Date().toISOString(),
      });
      setBadge(sender?.tab?.id, "OK", "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      const workKey = await patchOverlayReaderStatus(entryId, status, progress);
      await signalLibraryInvalidated("reader_status");
      if (sendResponse) sendResponse({ ok: true, entryId, status, workKey });
    } else {
      const authError = await applyAuthFailureResponse(response, {
        actionAtKey: "lastReaderStatusAt",
      });
      if (authError) {
        if (sendResponse) sendResponse({ ok: false, error: authError });
      } else if (response.status === 402) {
        setUpgradeState(
          "You've reached the free library limit. Upgrade to Pro for unlimited stories.",
          { lastHttpStatus: response.status },
        );
        if (sendResponse) sendResponse({ ok: false, error: "free_limit_reached" });
      } else if (response.status === 429) {
        setConnectedWithSyncWarning(
          "Trace is rate limiting library updates. Try again in a few minutes.",
          { lastHttpStatus: response.status },
        );
        if (sendResponse) sendResponse({ ok: false, error: "rate_limited" });
      } else {
        if (sendResponse) sendResponse({ ok: false, error: "http_" + response.status });
      }
    }
  } catch (e) {
    console.error("[Trace] Reading status error:", e);
    if (sendResponse) sendResponse({ ok: false, error: "network_error" });
  }
}

// =======================================================
// 8. LIBRARY OVERLAY CACHE (periodic refresh)
// =======================================================

try {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PREF_LIBRARY_INLAY_KEY]) {
      void refreshLibraryOverlay();
    }
    if (
      changes[AO3_SAVED_FILTERS_STORAGE_KEY] ||
      changes[AO3_SAVED_FILTERS_DELETED_KEY]
    ) {
      const snapshot = {};
      if (changes[AO3_SAVED_FILTERS_STORAGE_KEY]) {
        snapshot[AO3_SAVED_FILTERS_STORAGE_KEY] =
          changes[AO3_SAVED_FILTERS_STORAGE_KEY].newValue;
      }
      if (changes[AO3_SAVED_FILTERS_DELETED_KEY]) {
        snapshot[AO3_SAVED_FILTERS_DELETED_KEY] =
          changes[AO3_SAVED_FILTERS_DELETED_KEY].newValue;
      }
      if (snapshotHasPendingAo3SavedFilterSync(snapshot)) {
        scheduleAo3SavedFiltersSync(750);
      }
    }
  });
} catch (_) {
  /* ignore */
}

try {
  if (ext.alarms && ext.alarms.onAlarm) {
    ext.runtime.onInstalled.addListener(() => {
      try {
        ext.alarms.create("traceLibraryOverlay", { periodInMinutes: 30 });
        ext.alarms.create("traceAo3SavedFiltersSync", { periodInMinutes: 30 });
      } catch (_) {
        /* ignore */
      }
    });
    ext.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "traceLibraryOverlay") {
        void refreshLibraryOverlay();
      }
      if (alarm.name === "traceAo3SavedFiltersSync") {
        void syncAo3SavedFilters();
      }
    });
    try {
      ext.alarms.get("traceLibraryOverlay", (a) => {
        if (ext.runtime.lastError) return;
        if (!a) {
          ext.alarms.create("traceLibraryOverlay", { periodInMinutes: 30 });
        }
      });
      ext.alarms.get("traceAo3SavedFiltersSync", (a) => {
        if (ext.runtime.lastError) return;
        if (!a) {
          ext.alarms.create("traceAo3SavedFiltersSync", { periodInMinutes: 30 });
        }
      });
    } catch (_) {
      /* ignore */
    }
  }
} catch (_) {
  /* alarms optional */
}
