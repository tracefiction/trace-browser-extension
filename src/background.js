// Trace MV3 background service worker.
// Receives metadata/progress messages from content scripts and sends them to the Trace API.
// Stores only Trace extension prefs, overlay cache, and the Trace auth token used for API calls.
// It never receives AO3/FFN passwords or cookies; URLs are injected by `npm run build`.
const ext = typeof browser !== "undefined" ? browser : chrome;

const TRACE_API_BASE = "__TRACE_API_BASE__";
const TRACE_WEB_ORIGIN = "__TRACE_WEB_ORIGIN__";

const API_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/track`;
const METADATA_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/metadata`;
const LIBRARY_OVERLAY_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/library-overlay`;
const WORK_PREFERENCES_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/extension/work-preferences`;
const LIBRARY_ENTRY_ENDPOINT_BASE = `${TRACE_API_BASE.replace(/\/$/, "")}/api/library`;
const ACCOUNT_ME_ENDPOINT = `${TRACE_API_BASE.replace(/\/$/, "")}/api/account/me`;
const IMPORT_BASE = `${TRACE_WEB_ORIGIN.replace(/\/$/, "")}/import`;
const TRACE_HOME_URL = `${TRACE_WEB_ORIGIN.replace(/\/$/, "")}/`;
const AUTH_TOKEN_KEY = "authToken";
const AUTH_STATE_KEY = "traceAuthState";
const OVERLAY_STORAGE_KEY = "libraryOverlayCache";
const LIBRARY_INVALIDATED_MESSAGE = "TRACE_LIBRARY_INVALIDATED";
const OPTIMISTIC_CHAPTER_FLOORS_MS = 20_000;
// OVERLAY_PRO_KEY removed — overlay is available to all users
const TRACE_USER_PRO_KEY = "traceUserPro";
const PREF_AUTO_TRACK_KEY = "prefAutoTrackEnabled";
const PREF_LIBRARY_INLAY_KEY = "prefLibraryInlayEnabled";
const PREF_METADATA_IMPROVE_KEY = "prefMetadataImproveEnabled";
const AO3_STORY_URL_RE =
  /^https:\/\/(?:[^/]+\.)?(?:archiveofourown\.org|archiveofourown\.gay|archive\.transformativeworks\.org|ao3\.org)\/works\/\d+(?:\/chapters\/\d+)?(?:[?#].*)?$/i;

// 1. Token Management
let bearerToken = null;
const optimisticChapterFloors = new Map();

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
  const state = {
    updatedAt: new Date().toISOString(),
    ...nextState,
  };
  ext.storage.local.set({ [AUTH_STATE_KEY]: state });
}

function setConnectedState(extra = {}) {
  persistAuthState({
    state: "connected",
    message: "Extension connected to your Trace account.",
    helpUrl: TRACE_HOME_URL,
    ...extra,
  });
}

function setSignedOutState(extra = {}) {
  persistAuthState({
    state: "signed_out",
    message:
      "Open Trace in Safari once to link the extension. Already signed in? Open any Trace page and we’ll connect automatically.",
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
  bearerToken = null;
  optimisticChapterFloors.clear();
  try {
    ext.storage.local.remove([
      AUTH_TOKEN_KEY,
      TRACE_USER_PRO_KEY,
      OVERLAY_STORAGE_KEY,
    ]);
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
function refreshTraceUserPro() {
  if (!bearerToken) return;
  fetch(ACCOUNT_ME_ENDPOINT, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j && typeof j.pro === "boolean") {
        ext.storage.local.set({ [TRACE_USER_PRO_KEY]: j.pro });
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
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && typeof j.pro === "boolean") {
          ext.storage.local.set({ [TRACE_USER_PRO_KEY]: j.pro }, () => resolve());
        } else {
          resolve();
        }
      })
      .catch(() => resolve());
  });
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
    if (response.status === 401) {
      clearToken();
      setReconnectState("Your Trace session expired. Open Trace and sign in again.");
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
  ext.storage.local.get(AUTH_TOKEN_KEY, (res) => {
    if (res?.authToken) {
      bearerToken = res.authToken;
      setConnectedState();
      refreshTraceUserPro();
      void refreshLibraryOverlay();
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

    bearerToken = token;
    ext.storage.local.set({ [AUTH_TOKEN_KEY]: token });
    setConnectedState({ lastTokenSyncAt: new Date().toISOString() });

    setBadge(sender?.tab?.id, "SYNC", "#2196F3");
    setTimeout(() => clearBadge(sender?.tab?.id), 2000);

    refreshTraceUserPro();
    void refreshLibraryOverlay();

    if (sendResponse) sendResponse({ success: true, state: "connected" });
    return;
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
          PREF_AUTO_TRACK_KEY,
          PREF_LIBRARY_INLAY_KEY,
          PREF_METADATA_IMPROVE_KEY,
          TRACE_USER_PRO_KEY,
        ],
        (r) => {
          if (sendResponse) {
            sendResponse({
              pro: r[TRACE_USER_PRO_KEY] === true,
              autoTrackEnabled: r[PREF_AUTO_TRACK_KEY] !== false,
              libraryInlayEnabled: r[PREF_LIBRARY_INLAY_KEY] !== false,
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
  // E. Popup opened — heal stale error state if token still present
  // -------------------------------------------------
  if (msg.type === "TRACE_POPUP_OPEN") {
    ext.storage.local.get([AUTH_TOKEN_KEY, AUTH_STATE_KEY], (res) => {
      const token = res?.[AUTH_TOKEN_KEY];
      const prev = res?.[AUTH_STATE_KEY];
      if (token) {
        bearerToken = token;
        refreshTraceUserPro();
        if (prev?.state === "error") {
          setConnectedState();
        }
      }
      if (sendResponse) sendResponse({ ok: true });
    });
    return true;
  }

  // -------------------------------------------------
  // D. Metadata broadcast from collector.js
  // -------------------------------------------------
  if (msg.type === "TRACE_METADATA_BROADCAST") {
    handleMetadataBroadcast(msg.payload, sender);
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
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      if (sendResponse) sendResponse({ ok: false, error: "no_active_tab" });
      return;
    }

    const res = await ext.tabs.sendMessage(tab.id, { type: "TRACE_COLLECT" });
    if (!res?.ok || !res.payload) {
      setBadge(tab.id, "ERR", "#B3261E");
      if (sendResponse) sendResponse({ ok: false, error: res?.error || "collect_failed" });
      return;
    }

    const b64 = toBase64Json(res.payload);
    const url = `${IMPORT_BASE}#U${encodeURIComponent(b64)}`;
    await ext.tabs.create({ url });
    if (sendResponse) sendResponse({ ok: true });
  } catch (e) {
    if (isMissingTabReceiverError(e)) {
      console.debug("[Trace] Import skipped (no collector on this tab)");
    } else {
      console.error("[Trace] Import trigger failed:", e);
    }
    if (sendResponse) sendResponse({ ok: false, error: String(e?.message || e) });
  }
}

// =======================================================
// 3. AUTOMATIC TRACKING
// =======================================================

function handleAutoTrack(payload, sender, sendResponse) {
  if (!bearerToken) {
    setReconnectState("Open Trace in Safari to link your session, then automatic sync will work.", {
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
      if (response.status === 401) {
        clearToken();
        setReconnectState("Your Trace session expired. Open Trace and sign in again.", {
          lastTrackAttemptAt: new Date().toISOString(),
          lastHttpStatus: response.status,
        });
        setBadge(sender?.tab?.id, "LOG", "#9C6B00");
        return { ok: false, error: "auth_expired" };
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
      setConnectedState({
        lastTrackSuccessAt: new Date().toISOString(),
      });
      await refreshLibraryOverlay();
      await signalLibraryInvalidated("track");
      setBadge(sender?.tab?.id, "OK", "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      return { ok: true };
    }
  } catch (error) {
    console.error("[Trace] Network error:", error);
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

    if (response.status === 401) {
      clearToken();
      setReconnectState("Your Trace session expired. Open Trace and sign in again.");
    } else if (response.ok) {
      await signalLibraryInvalidated("metadata");
    }
  } catch (error) {
    console.error("[Trace] Metadata broadcast error:", error);
  }
}

// =======================================================
// 5. QUICK-ADD (inline button on story pages)
// =======================================================

async function handleQuickAdd(payload, sender, sendResponse) {
  if (!bearerToken) {
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
      const json = await response.json().catch(() => null);
      const entryId =
        json && json.data && typeof json.data.entry_id === "string"
          ? json.data.entry_id
          : null;
      setConnectedState({ lastQuickAddAt: new Date().toISOString() });
      setBadge(sender?.tab?.id, "OK", "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      await refreshLibraryOverlay();
      await signalLibraryInvalidated("quick_add");
      if (sendResponse) {
        const payload = { ok: true };
        if (entryId) payload.entryId = entryId;
        sendResponse(payload);
      }
    } else if (response.status === 401) {
      clearToken();
      setReconnectState("Your Trace session expired. Open Trace and sign in again.");
      if (sendResponse) sendResponse({ ok: false, error: "auth_expired" });
    } else if (response.status === 402) {
      if (sendResponse) sendResponse({ ok: false, error: "free_limit_reached" });
    } else {
      if (sendResponse) sendResponse({ ok: false, error: "http_" + response.status });
    }
  } catch (e) {
    console.error("[Trace] Quick-add error:", e);
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

function isStorySheetReaderStatus(status) {
  return (
    status === "PLANNING" ||
    status === "READING" ||
    status === "PAUSED" ||
    status === "COMPLETED" ||
    status === "DROPPED"
  );
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
    } else if (response.status === 401) {
      clearToken();
      setReconnectState("Your Trace session expired. Open Trace and sign in again.");
      if (sendResponse) sendResponse({ ok: false, error: "auth_expired" });
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
          entries[key] = {
            ...rawEntry,
            status,
            readerStatus: status,
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

async function handleSetReaderStatus(payload, sender, sendResponse) {
  if (!bearerToken) {
    if (sendResponse) sendResponse({ ok: false, error: "not_authenticated" });
    return;
  }

  const entryId = payload && typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  const status = payload && typeof payload.status === "string" ? payload.status.trim().toUpperCase() : "";
  const progress = normalizeReaderProgress(payload && payload.progress);
  if (!isValidUuid(entryId) || !isStorySheetReaderStatus(status) || ((payload && payload.progress) && !progress)) {
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
      setConnectedState({ lastReaderStatusAt: new Date().toISOString() });
      setBadge(sender?.tab?.id, "OK", "#0D7A5F");
      setTimeout(() => clearBadge(sender?.tab?.id), 2000);
      const workKey = await patchOverlayReaderStatus(entryId, status, progress);
      await signalLibraryInvalidated("reader_status");
      if (sendResponse) sendResponse({ ok: true, entryId, status, workKey });
    } else if (response.status === 401) {
      clearToken();
      setReconnectState("Your Trace session expired. Open Trace and sign in again.");
      if (sendResponse) sendResponse({ ok: false, error: "auth_expired" });
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
    if (area !== "local" || !changes[PREF_LIBRARY_INLAY_KEY]) return;
    void refreshLibraryOverlay();
  });
} catch (_) {
  /* ignore */
}

try {
  if (ext.alarms && ext.alarms.onAlarm) {
    ext.runtime.onInstalled.addListener(() => {
      try {
        ext.alarms.create("traceLibraryOverlay", { periodInMinutes: 30 });
      } catch (_) {
        /* ignore */
      }
    });
    ext.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "traceLibraryOverlay") {
        void refreshLibraryOverlay();
      }
    });
    try {
      ext.alarms.get("traceLibraryOverlay", (a) => {
        if (ext.runtime.lastError) return;
        if (!a) {
          ext.alarms.create("traceLibraryOverlay", { periodInMinutes: 30 });
        }
      });
    } catch (_) {
      /* ignore */
    }
  }
} catch (_) {
  /* alarms optional */
}
