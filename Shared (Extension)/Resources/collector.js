// collector.js — AO3/FFN page metadata extractor.
// Reads story/listing metadata from the DOM the user is viewing; it does not fetch page HTML.
// Sends metadata/progress to background.js via extension messages for import, quick-add, and auto-track.
// Does not read cookies or credentials, and disables collection on pages with password fields.
const ext = globalThis.browser ?? globalThis.chrome;
const PRIVATE_TAG_DISPLAY_LIMIT = 3;
const TRACE_FIRST_STORY_FOCUS_ADD_MESSAGE = "TRACE_FIRST_STORY_FOCUS_ADD";
const TRACE_IOS_PENDING_FIRST_STORY_GET_MESSAGE = "TRACE_IOS_PENDING_FIRST_STORY_GET";
const TRACE_IOS_PENDING_FIRST_STORY_CLEAR_MESSAGE = "TRACE_IOS_PENDING_FIRST_STORY_CLEAR";
const TRACE_CONNECT_AND_SAVE_MESSAGE = "TRACE_CONNECT_AND_SAVE";
const TRACE_IOS_AUTH_REFRESH_REQUEST_MESSAGE = "TRACE_IOS_AUTH_REFRESH_REQUEST";
const TRACE_SESSION_MODE = globalThis.TRACE_SESSION_MODE || "legacy";
const KERNEL_SESSION_ACTIVE = TRACE_SESSION_MODE === "kernel";
const TRACE_ACTIVE_TAB_PROBE_MODE =
  globalThis.TRACE_IOS_ACTIVE_TAB_PROBE === true;
const TRACE_WEB_HOME_URL = configuredTraceWebHomeUrl();
const TRACE_WEB_UPGRADE_URL = traceUpgradeUrl();
const FIRST_STORY_FOCUS_MAX_ATTEMPTS = 30;
const FIRST_STORY_FOCUS_RETRY_MS = 150;
const FIRST_STORY_SAVE_TIMEOUT_MS = 18_000;
const COLLECTOR_MESSAGE_TIMEOUT_MS = 20_000;
const KERNEL_PROJECTION_RETRY_DELAYS_MS = [250, 750, 2_000];
const TRACE_CAPACITY_NOTICE_ATTR = "data-trace-capacity-notice";

function configuredTraceWebHomeUrl() {
  var configured =
    typeof globalThis.TRACE_EXTENSION_WEB_ORIGIN === "string"
      ? globalThis.TRACE_EXTENSION_WEB_ORIGIN.trim()
      : "";
  try {
    return new URL(configured || "https://tracefiction.com").origin + "/";
  } catch (_) {
    return "https://tracefiction.com/";
  }
}

function traceUpgradeUrl() {
  try {
    var url = new URL(TRACE_WEB_HOME_URL);
    url.searchParams.set("upgrade", "1");
    url.searchParams.set("source", "extension_cap");
    return url.href;
  } catch (_) {
    return TRACE_WEB_HOME_URL + "?upgrade=1&source=extension_cap";
  }
}

// Firefox/Safari expose Promise-based runtime messaging through `browser`,
// while Chromium and the Safari wrapper's compatibility surface may require a
// callback. Keep every collector command on this boundary so feature code
// never has to infer which API shape is active.
function sendCollectorMessage(message, onResponse, timeoutMs) {
  var expectsResponse = typeof onResponse === "function";
  var respond = expectsResponse ? onResponse : function () {};
  var timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = COLLECTOR_MESSAGE_TIMEOUT_MS;
  var settled = false;
  var timer = null;
  var finish = function (response) {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    respond(response == null ? null : response);
  };
  var armTimeout = function () {
    if (settled || !expectsResponse) return;
    timer = setTimeout(function () {
      finish(null);
    }, timeout);
  };
  if (typeof globalThis.browser !== "undefined" && ext === globalThis.browser) {
    try {
      var pending = ext.runtime.sendMessage(message);
      armTimeout();
      Promise.resolve(pending).then(finish, function () {
        finish(null);
      });
    } catch (_) {
      finish(null);
    }
    return;
  }
  try {
    ext.runtime.sendMessage(message, function (response) {
      finish(ext.runtime.lastError ? null : response);
    });
    armTimeout();
  } catch (_) {
    finish(null);
  }
}

function sendCollectorMessageBestEffort(message) {
  sendCollectorMessage(message);
}

var kernelPendingFirstStory = null;
var kernelFirstStoryLookupPending = KERNEL_SESSION_ACTIVE;
var kernelProjectionRetryTimer = null;
var kernelProjectionRetryWorkKey = null;

function traceIsCredentialPageUrl() {
  var path = String(location && location.pathname ? location.pathname : "").toLowerCase();
  var host = String(location && location.hostname ? location.hostname : "").toLowerCase();
  if (host.indexOf("archiveofourown.org") >= 0) {
    return /\/users\/(?:login|signup|password)/.test(path);
  }
  if (host.indexOf("fanfiction.net") >= 0) {
    return /(?:^|\/)(?:m\/)?(?:login|signup)(?:\.php)?(?:\/|$)/.test(path);
  }
  return false;
}

function traceIsKnownHeaderPasswordField(input) {
  var form = input && input.closest ? input.closest("form") : null;
  if (!form) return false;
  var id = String(form.id || "");
  var action = String(form.getAttribute("action") || "");
  return id === "new_user_session_small" && action.indexOf("/users/login") >= 0;
}

function tracePageHasPasswordField(root) {
  if (traceIsCredentialPageUrl()) return true;
  try {
    const inputs = (root || document).querySelectorAll("input");
    for (const input of inputs) {
      if (String(input && input.type ? input.type : "").toLowerCase() === "password") {
        if (traceIsKnownHeaderPasswordField(input)) continue;
        return true;
      }
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

function shouldDisableTraceContentScript() {
  return tracePageHasPasswordField(document);
}

function authStateAllowsActions(authState, hasAuth) {
  if (!hasAuth) return false;
  var state = authState && authState.state ? authState.state : "connected";
  return state !== "signed_out" && state !== "reconnect_required";
}

function acknowledgeCapacityRecovery(action) {
  sendCollectorMessageBestEffort({
    type: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE",
    action: action,
    surface: "story",
  });
}

function showCapacityRecoveryNotice(capacity, force) {
  if (!force && !(capacity && capacity.blocked === true && capacity.prompt === true)) {
    return;
  }
  if (document.querySelector("[" + TRACE_CAPACITY_NOTICE_ATTR + "]")) return;

  var notice = document.createElement("section");
  notice.setAttribute(TRACE_CAPACITY_NOTICE_ATTR, "1");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-label", "Trace library full");
  notice.style.cssText = [
    "position:fixed",
    "right:max(16px,env(safe-area-inset-right))",
    "bottom:max(16px,env(safe-area-inset-bottom))",
    "z-index:2147483646",
    "box-sizing:border-box",
    "width:min(360px,calc(100vw - 32px))",
    "padding:16px",
    "border:1px solid rgba(28,39,34,0.16)",
    "border-radius:14px",
    "background:#f6f1e4",
    "box-shadow:0 18px 46px rgba(28,39,34,0.22)",
    "color:#1c2722",
  ].join(";");

  var eyebrow = document.createElement("div");
  eyebrow.textContent = "TRACE";
  eyebrow.style.cssText = "font:600 9px/1 'Geist Mono',ui-monospace,monospace;letter-spacing:0.16em;color:#b54a30";
  var title = document.createElement("h2");
  title.textContent = "This story wasn’t added";
  title.style.cssText = "margin:8px 0 0;font:500 20px/1.15 Georgia,'Times New Roman',serif;color:#1c2722";
  var copy = document.createElement("p");
  copy.textContent = "Your Trace library is full. Make room or get Trace Unlimited to keep adding stories.";
  copy.style.cssText = "margin:8px 0 14px;font:500 13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#5f665f";
  var actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:10px";
  actions.style.flexWrap = "wrap";
  var upgrade = document.createElement("a");
  upgrade.setAttribute("data-trace-open-trace", "1");
  upgrade.href = TRACE_WEB_UPGRADE_URL;
  upgrade.target = "_blank";
  upgrade.rel = "noopener noreferrer";
  upgrade.textContent = "Get Trace Unlimited";
  upgrade.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border-radius:9px;background:#1c2722;color:#fff;text-decoration:none;font:650 12.5px/1 system-ui,-apple-system,'Segoe UI',sans-serif";
  upgrade.addEventListener("click", function (event) {
    event.stopPropagation();
  });
  var manage = document.createElement("a");
  manage.setAttribute("data-trace-open-trace", "1");
  manage.href = TRACE_WEB_HOME_URL;
  manage.target = "_blank";
  manage.rel = "noopener noreferrer";
  manage.textContent = "Manage library";
  manage.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 12px;border-radius:9px;border:1px solid rgba(28,39,34,0.2);color:#1c2722;text-decoration:none;font:650 12.5px/1 system-ui,-apple-system,'Segoe UI',sans-serif";
  manage.addEventListener("click", function (event) {
    event.stopPropagation();
  });
  var dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  dismiss.style.cssText = "min-height:44px;padding:0 8px;border:0;background:transparent;color:#5f665f;font:650 12.5px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer";
  dismiss.addEventListener("click", function () {
    acknowledgeCapacityRecovery("dismissed");
    notice.remove();
  });
  actions.appendChild(upgrade);
  actions.appendChild(manage);
  actions.appendChild(dismiss);
  notice.appendChild(eyebrow);
  notice.appendChild(title);
  notice.appendChild(copy);
  notice.appendChild(actions);
  (document.body || document.documentElement).appendChild(notice);
  acknowledgeCapacityRecovery("shown");
}

function txt(el) {
  return el ? (el.textContent || "").trim() : null;
}
function stripTraceUiFromClone(el) {
  if (!el || !el.cloneNode) return null;
  const clone = el.cloneNode(true);
  for (const node of qsa(
    clone,
    [
      "[data-trace-quick-add]",
      "[data-trace-quick-add-wrap]",
      "[data-trace-story-handle]",
      "[data-trace-story-sheet]",
      "[data-trace-status-choices]",
      "[data-trace-hidden-action]",
      "[data-trace-management-header]",
      "[data-trace-open-trace]",
      "[data-trace-bottom-sheet-grabber]",
      "[data-trace-finish-qualify]",
      "[data-trace-finish-toast]",
      "[data-trace-capacity-notice]"
    ].join(",")
  )) {
    node.remove();
  }
  return clone;
}
function txtWithoutTraceUi(el) {
  const clone = stripTraceUiFromClone(el);
  return clone ? (clone.textContent || "").trim() : txt(el);
}
function qsa(root, sel) {
  return Array.from((root || document).querySelectorAll(sel));
}
function one(root, sel) {
  return (root || document).querySelector(sel);
}
function num(s) {
  if (!s) return null;
  const n = parseInt(String(s).replace(/[\s,]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function parseCh(s) {
  if (!s) return { n: null, t: null };
  const m = String(s).match(/(\d+)\s*\/\s*(\d+|\?)/);
  return m ? { n: num(m[1]), t: m[2] === "?" ? "?" : num(m[2]) } : { n: num(s), t: null };
}

/**
 * Library import: `chn` stays 1 for legacy/extension consumers that assumed “start at 1”.
 * **Published** count (first number in `51/52`) is sent as `chPub` for web import so Trace
 * can show `51/?` vs `51/52` correctly and seed the library denominator separately.
 */
function ao3ImportChapters(chp) {
  const t = chp.t;
  const cht = typeof t === "number" ? t : null;
  return { chn: 1, cht };
}

function extractAo3ChapterNumber(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return null;
  const leadingOrdinal = normalized.match(/^(\d+)\s*[.: -]/);
  if (leadingOrdinal) {
    const n = Number(leadingOrdinal[1]);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }
  const match =
    normalized.match(/\bchapter\s+(\d+)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function detectAo3CurrentChapterFromSelect(chapterId) {
  if (!chapterId) return null;

  const selects = qsa(document, "#selected_id, #chapter_index select, select#selected_id");
  for (const select of selects) {
    const options = Array.from(select && select.options ? select.options : []);
    if (!options.length) continue;

    const matchIndex = options.findIndex((option) => String(option.value || "").trim() === chapterId);
    if (matchIndex < 0) continue;

    const matchedOption = options[matchIndex];
    const explicit = extractAo3ChapterNumber(txt(matchedOption));
    if (explicit != null) return explicit;

    let chapterOrdinal = 0;
    for (let i = 0; i <= matchIndex; i += 1) {
      const option = options[i];
      const value = String(option.value || "").trim().toLowerCase();
      if (!value || value === "all") continue;
      chapterOrdinal += 1;
    }
    if (chapterOrdinal >= 1) return chapterOrdinal;
  }

  return null;
}

function detectAo3CurrentChapterFromHeading(chapterId) {
  const selectors = chapterId
    ? [
        "#chapters .chapter.preface.group h3.title a[href*='/chapters/" + chapterId + "']",
        ".chapter.preface.group h3.title a[href*='/chapters/" + chapterId + "']",
        "#chapters .chapter.preface.group h3.title",
        ".chapter.preface.group h3.title",
      ]
    : [
        "#chapters .chapter.preface.group h3.title",
        ".chapter.preface.group h3.title",
      ];

  for (const selector of selectors) {
    const value = extractAo3ChapterNumber(txt(one(document, selector)));
    if (value != null) return value;
  }

  return null;
}

function hasStableAo3ChapterSignal() {
  const path = location.pathname || "";
  const currentChapterIdMatch = path.match(/\/chapters\/(\d+)/);
  const currentChapterId = currentChapterIdMatch ? currentChapterIdMatch[1] : null;
  if (!currentChapterId) return true;

  if (detectAo3CurrentChapterFromSelect(currentChapterId) != null) {
    return true;
  }

  if (detectAo3CurrentChapterFromHeading(currentChapterId) != null) {
    return true;
  }

  if (
    one(document, "#chapters .chapter[id^='chapter-']") ||
    one(document, ".chapter[id^='chapter-']")
  ) {
    return true;
  }

  if (
    one(document, "#chapters .chapter.preface.group h3.title a[href*='/chapters/" + currentChapterId + "']") ||
    one(document, ".chapter.preface.group h3.title a[href*='/chapters/" + currentChapterId + "']")
  ) {
    return true;
  }

  if (
    one(document, "#chapter_index form[action*='/chapters/" + currentChapterId + "']") ||
    one(document, "form[action*='/chapters/" + currentChapterId + "']")
  ) {
    return true;
  }

  return false;
}

function isAo3EntireWorkView() {
  var isEntireWork = false;
  try {
    isEntireWork = new URL(location.href).searchParams.get("view_full_work") === "true";
  } catch (_) {
    isEntireWork = /(?:\?|&)view_full_work=true(?:&|$)/.test(location.search || "");
  }
  return isEntireWork;
}

function ao3EntireWorkRenderedChapterCount() {
  if (!isAo3EntireWorkView()) return null;

  var articles = qsa(
    document,
    [
      "#chapters .userstuff.module[role='article']",
      "#chapters .userstuff[role='article']",
      "#chapters [role='article'].userstuff",
    ].join(",")
  );
  if (articles.length > 0) return articles.length;

  var chapterContainers = qsa(document, "#chapters .chapter[id^='chapter-']");
  return chapterContainers.length > 0 ? chapterContainers.length : null;
}

function detectAo3CurrentChapterNumber(publishedChapterCount) {
  const path = location.pathname || "";
  if (!/\/chapters\/\d+/.test(path)) {
    var renderedEntireWorkCount = ao3EntireWorkRenderedChapterCount();
    if (renderedEntireWorkCount != null) {
      var published = Number(publishedChapterCount);
      if (Number.isFinite(published) && published > 0) {
        return Math.min(Math.trunc(published), renderedEntireWorkCount);
      }
      return renderedEntireWorkCount;
    }
    return 1;
  }
  const currentChapterIdMatch = path.match(/\/chapters\/(\d+)/);
  const currentChapterId = currentChapterIdMatch ? currentChapterIdMatch[1] : null;

  const selectMatch = detectAo3CurrentChapterFromSelect(currentChapterId);
  if (typeof selectMatch === "number" && Number.isFinite(selectMatch) && selectMatch >= 1) {
    return selectMatch;
  }

  const headingMatch = detectAo3CurrentChapterFromHeading(currentChapterId);
  if (typeof headingMatch === "number" && Number.isFinite(headingMatch) && headingMatch >= 1) {
    return headingMatch;
  }

  const chapterContainer = one(document, "#chapters .chapter[id^='chapter-']") ||
    one(document, ".chapter[id^='chapter-']");
  if (chapterContainer && chapterContainer.id) {
    const idMatch = chapterContainer.id.match(/^chapter-(\d+)$/);
    if (idMatch) {
      const n = Number(idMatch[1]);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  }

  const chapterTextSources = [
    txt(one(document, "#chapters .chapter.preface.group h3.title")),
    txt(one(document, ".chapter.preface.group h3.title")),
  ];

  for (const source of chapterTextSources) {
    const n = extractAo3ChapterNumber(source);
    if (n != null) return n;
  }

  return 1;
}

function currentAo3ChapterUrl(workId) {
  try {
    const url = new URL(location.href);
    const match = url.pathname.match(/^\/works\/(\d+)\/chapters\/(\d+)\/?$/);
    if (!match || match[1] !== String(workId || "")) return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch (_) {
    return null;
  }
}
function dedup(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr || []) {
    const k = (v || "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
// relationship participants (AO3): split on '/' or '&' only (not '|')
function relPartsFromAO3(rels) {
  const out = [];
  const seen = new Set();
  for (const r of rels || []) {
    const parts = String(r || "").split(/\s*(?:\/|&\s*)\s*/);
    for (const p0 of parts) {
      const p = (p0 || "").trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
/** Normalize FFN genre: mobile uses " & " between genres, desktop uses "/". Standardize to "/". */
function normalizeGenre(g) {
  if (!g) return null;
  return g.replace(/\s+&\s+/g, "/").trim() || null;
}

/**
 * FFN exposes a concrete total chapter count, not AO3-style published/planned.
 * Story pages can carry the current chapter from the URL; listing imports default to chapter 1.
 */
function ffnImportChapters(currentChapter, totalChapters) {
  const current =
    typeof currentChapter === "number" && Number.isFinite(currentChapter)
      ? currentChapter
      : null;
  const total =
    typeof totalChapters === "number" && Number.isFinite(totalChapters)
      ? totalChapters
      : null;
  return { chn: current, cht: total };
}

var AUTO_TRACK_DEDUPE_KEY = "trace:auto-track:last";
var AUTO_TRACK_DEDUPE_WINDOW_MS = 90 * 1000;
var METADATA_BROADCAST_DEDUPE_KEY = "trace:metadata-broadcast:last";
var LISTING_METADATA_REFRESH_DEDUPE_KEY = "trace:listing-metadata-refresh:last";
var LISTING_METADATA_REFRESH_ITEM_LIMIT = 100;
var LISTING_METADATA_REFRESH_RETRY_MS = 500;
var LISTING_METADATA_REFRESH_MAX_ATTEMPTS = 6;
var AUTO_TRACK_READY_RETRY_MS = 150;
var AUTO_TRACK_READY_MAX_ATTEMPTS = 12;
var OVERLAY_CACHE_KEY = "libraryOverlayCache";
var TRACE_ACCOUNT_ID_KEY = "traceAccountId";
var TRACE_API_BASE_STORAGE_KEY = "traceApiBase";
var WORK_STATE_STORAGE_KEY = "traceWorkStatesV1";
var ACCOUNT_PROJECTION_REVISION_KEY = "traceAccountProjectionRevisionV1";
var WORK_STATE_GET_MESSAGE = "TRACE_WORK_STATE_GET";
var ACCOUNT_PROJECTION_GET_MESSAGE = "TRACE_ACCOUNT_PROJECTION_GET";
var optimisticStoryPageEntries = Object.create(null);
var storyQuickAddUiReady = false;
var storyAuthRecoveryNeeded = false;
var storyAuthRefreshInFlight = false;
var storyAuthRefreshLastAttemptAt = 0;
var TRACE_READER_STATUS_CHOICES = [
  "SAVED",
  "READING",
  "CAUGHT_UP",
  "PAUSED",
  "FINISHED",
  "DROPPED",
];
var FINISH_QUALIFY_DISMISS_KEY = "trace:finish-qualify:dismissed";
var finishQualifyWatchState = Object.create(null);
var finishQualifyBandState = Object.create(null);
var finishQualifyGeneration = 0;

function count(s) {
  // Handles: "12,148" -> 12148, "127k+" -> 127000, "1.2m" -> 1200000
  if (!s) return null;
  const str = String(s).trim().toLowerCase();
  const m = str.match(/([\d.,]+)\s*([km])?\s*\+?/i);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
  return Math.round(base * mult);
}

function normalizeStorageString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStoredApiBase(value) {
  return normalizeStorageString(value).replace(/\/$/, "");
}

function overlayCacheMatchesRuntimeContext(cache, storage) {
  if (!cache || typeof cache !== "object") return false;
  var expectedApiBase = normalizeStoredApiBase(storage && storage[TRACE_API_BASE_STORAGE_KEY]);
  var cacheApiBase = normalizeStoredApiBase(cache.apiBase);
  if (!expectedApiBase || !cacheApiBase || expectedApiBase !== cacheApiBase) {
    return false;
  }
  var expectedAccountId = normalizeStorageString(storage && storage[TRACE_ACCOUNT_ID_KEY]);
  var cacheAccountId = normalizeStorageString(cache.accountId);
  if (expectedAccountId && cacheAccountId !== expectedAccountId) {
    return false;
  }
  if (!expectedAccountId && !cacheAccountId) {
    return false;
  }
  return true;
}

function overlayCacheForRuntimeContext(cache, storage) {
  return overlayCacheMatchesRuntimeContext(cache, storage) ? cache : null;
}

function overlayCacheContextPatch(storage) {
  var patch = {
    apiBase: normalizeStoredApiBase(storage && storage[TRACE_API_BASE_STORAGE_KEY]),
    accountId: normalizeStorageString(storage && storage[TRACE_ACCOUNT_ID_KEY]),
    contextVersion: 1,
  };
  if (!patch.apiBase) delete patch.apiBase;
  if (!patch.accountId) delete patch.accountId;
  return patch;
}

function overlayWorkKeyFromItem(item) {
  if (!item || !item.src || !item.u) return null;
  var url = String(item.u || "");
  if (item.src === "ao3") {
    var ao3 = url.match(/\/works\/(\d+)/);
    return ao3 ? "ao3:" + ao3[1] : null;
  }
  if (item.src === "ffn") {
    var ffn = url.match(/\/s\/(\d+)/);
    return ffn ? "ffn:" + ffn[1] : null;
  }
  return null;
}

function normalizeOverlayPreference(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.browsePreference && typeof raw.browsePreference === "object") {
    return { hidden: raw.browsePreference.hidden === true };
  }
  if (raw.hidden === true) return { hidden: true };
  return null;
}

function normalizeOverlayChapters(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.current !== "number" || !Number.isFinite(raw.current)) {
    return undefined;
  }
  var total =
    raw.total === null || raw.total === undefined ? null : Number(raw.total);
  return {
    current: raw.current,
    total: total !== null && Number.isFinite(total) ? total : null,
  };
}

function normalizeOverlayWorkMark(raw) {
  if (!raw || typeof raw !== "object") return null;
  var kind = typeof raw.kind === "string" ? raw.kind : null;
  if (kind !== "abandoned" && kind !== "hiatus") return null;
  var mark = { kind: kind };
  if (raw.challenge && typeof raw.challenge === "object") {
    var challengeKind =
      typeof raw.challenge.kind === "string" ? raw.challenge.kind : null;
    if (
      challengeKind === "source-updated" ||
      challengeKind === "chapter-count-changed"
    ) {
      mark.challenge = { kind: challengeKind };
      var chapterDelta = Number(raw.challenge.chapterDelta);
      if (Number.isFinite(chapterDelta) && chapterDelta > 0) {
        mark.challenge.chapterDelta = Math.trunc(chapterDelta);
      }
    }
  }
  return mark;
}

function normalizeOverlayPrivateContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  var notePreview =
    typeof raw.notePreview === "string"
      ? raw.notePreview.replace(/\s+/g, " ").trim()
      : "";
  if (notePreview.length > 180) {
    notePreview = notePreview.slice(0, 177).trimEnd() + "...";
  }
  var tags = [];
  if (Array.isArray(raw.tags)) {
    var seen = new Set();
    raw.tags.forEach(function (value) {
      if (tags.length >= 5) return;
      if (typeof value !== "string") return;
      var tag = value.replace(/\s+/g, " ").trim();
      if (!tag) return;
      if (tag.length > 100) tag = tag.slice(0, 100).trimEnd();
      var key = tag.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      tags.push(tag);
    });
  }
  var hasNotes = raw.hasNotes === true || notePreview.length > 0;
  var tagCount = Number(raw.tagCount);
  if (!Number.isFinite(tagCount) || tagCount < 0) tagCount = 0;
  tagCount = Math.trunc(tagCount);
  if (tagCount === 0 && tags.length > 0) tagCount = tags.length;
  if (!hasNotes && tagCount === 0 && tags.length === 0) return null;
  return {
    hasNotes: hasNotes,
    tagCount: tagCount,
    notePreview: notePreview || undefined,
    tags: tags.length ? tags : undefined,
  };
}

function normalizeOverlayEntry(entry, preferenceRaw) {
  var preference = normalizeOverlayPreference(preferenceRaw);
  if (!entry) {
    return preference && preference.hidden
      ? { status: null, readerStatus: null, hidden: true }
      : {};
  }
  if (typeof entry === "string") {
    return {
      status: entry,
      readerStatus: entry,
      hidden: preference && preference.hidden === true,
    };
  }
  var entryPreference = normalizeOverlayPreference(entry);
  var status = typeof entry.status === "string" ? entry.status : null;
  var readerStatus =
    typeof entry.readerStatus === "string" ? entry.readerStatus : status;
  return Object.assign({}, entry, {
    status: status,
    readerStatus: readerStatus,
    chapters: normalizeOverlayChapters(entry.chapters),
    hidden:
      (entryPreference && entryPreference.hidden === true) ||
      (preference && preference.hidden === true),
    workMark: normalizeOverlayWorkMark(entry.workMark),
    privateContext: normalizeOverlayPrivateContext(entry.privateContext),
  });
}

function storyEntryChapterCurrent(entry) {
  var current = entry && entry.chapters && entry.chapters.current;
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function storyEntrySyncTime(value) {
  var time = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(time) ? time : null;
}

function storyOverlayTransientPatch(entry) {
  var patch = {};
  [
    "__traceStatusPending",
    "__traceStatusTarget",
    "__traceStatusError",
    "__traceAutoTrackPending",
    "__traceAutoTrackError",
    "__traceObservedChapters",
  ].forEach(function (key) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, key)) {
      patch[key] = entry[key];
    }
  });
  return patch;
}

function clearStoryOverlayTransientState(entry) {
  var next = Object.assign({}, entry || {});
  delete next.__traceAutoTrackPending;
  delete next.__traceAutoTrackError;
  delete next.__traceObservedChapters;
  delete next.__traceStatusPending;
  delete next.__traceStatusTarget;
  delete next.__traceStatusError;
  return next;
}

function mergeStoryOverlayEntries(cachedEntry, optimisticEntry, cacheSyncVersion) {
  if (!cachedEntry) return optimisticEntry || {};
  if (!optimisticEntry) return cachedEntry;

  var cachedCurrent = storyEntryChapterCurrent(cachedEntry);
  var optimisticCurrent = storyEntryChapterCurrent({
    chapters:
      optimisticEntry.__traceObservedChapters || optimisticEntry.chapters,
  });
  var optimisticIsFresher = false;
  if (optimisticCurrent != null && cachedCurrent != null) {
    if (optimisticCurrent > cachedCurrent) {
      optimisticIsFresher = true;
    } else if (optimisticCurrent === cachedCurrent) {
      var equalChapterCacheTime = storyEntrySyncTime(cacheSyncVersion);
      var equalChapterOptimisticTime = storyEntrySyncTime(
        optimisticEntry.__traceSyncVersion,
      );
      optimisticIsFresher =
        equalChapterOptimisticTime != null &&
        (equalChapterCacheTime == null ||
          equalChapterOptimisticTime > equalChapterCacheTime);
    }
  } else if (optimisticCurrent != null && cachedCurrent == null) {
    optimisticIsFresher = true;
  } else if (optimisticCurrent === cachedCurrent) {
    var cacheTime = storyEntrySyncTime(cacheSyncVersion);
    var optimisticTime = storyEntrySyncTime(optimisticEntry.__traceSyncVersion);
    optimisticIsFresher =
      optimisticTime != null &&
      (cacheTime == null || optimisticTime > cacheTime);
  }

  if (optimisticIsFresher) {
    return Object.assign({}, cachedEntry, optimisticEntry, {
      chapters:
        optimisticEntry.__traceAutoTrackPending &&
        optimisticEntry.__traceObservedChapters
          ? cachedEntry.chapters || optimisticEntry.chapters
          : optimisticEntry.chapters || cachedEntry.chapters,
      entryId: optimisticEntry.entryId || cachedEntry.entryId,
    });
  }

  return Object.assign(
    {},
    cachedEntry,
    storyOverlayTransientPatch(optimisticEntry),
    {
      entryId: cachedEntry.entryId || optimisticEntry.entryId,
      statusChoicesAvailable:
        cachedEntry.statusChoicesAvailable === true ||
        optimisticEntry.statusChoicesAvailable === true,
    },
  );
}

function autoTrackFingerprint(item) {
  return JSON.stringify({
    src: item && item.src ? item.src : null,
    url: item && item.u ? item.u : null,
    chapterUrl: item && item.chu ? item.chu : null,
    chapter:
      item && typeof item.chn === "number" && Number.isFinite(item.chn)
        ? item.chn
        : null,
  });
}

function storyMetadataFingerprint(item) {
  var normalizeList = function (list) {
    return Array.isArray(list) ? list.slice().sort() : [];
  };

  return JSON.stringify({
    src: item && item.src ? item.src : null,
    url: item && item.u ? item.u : null,
    title: item && item.t ? item.t : null,
    author: item && item.a ? item.a : null,
    rating: item && item.r ? item.r : null,
    status: item && item.s ? item.s : null,
    language: item && item.l ? item.l : null,
    words:
      item && typeof item.w === "number" && Number.isFinite(item.w) ? item.w : null,
    kudos:
      item && typeof item.k === "number" && Number.isFinite(item.k) ? item.k : null,
    hits:
      item && typeof item.h === "number" && Number.isFinite(item.h) ? item.h : null,
    bookmarks:
      item && typeof item.bk === "number" && Number.isFinite(item.bk) ? item.bk : null,
    comments:
      item && typeof item.cc === "number" && Number.isFinite(item.cc) ? item.cc : null,
    published: item && item.pub ? item.pub : null,
    updated: item && item.upd ? item.upd : null,
    chapterTotal:
      item && typeof item.cht === "number" && Number.isFinite(item.cht)
        ? item.cht
        : null,
    chaptersPublished:
      item && typeof item.chPub === "number" && Number.isFinite(item.chPub)
        ? item.chPub
        : null,
    series:
      item && item.ser
        ? {
            name: item.ser.name || null,
            pos:
              typeof item.ser.pos === "number" && Number.isFinite(item.ser.pos)
                ? item.ser.pos
                : null,
            url: item.ser.url || null,
          }
        : null,
    fandoms: normalizeList(item && item.fms),
    warnings: normalizeList(item && item.wrn),
    categories: normalizeList(item && item.cat),
    relationships: normalizeList(item && item.ra),
    romanticRelationships: normalizeList(item && item.rels),
    characters: normalizeList(item && item.chars),
    tags: normalizeList(item && item.tags),
    summary: item && item.sm ? item.sm : null,
  });
}

function shouldBroadcastMetadata(item) {
  try {
    if (!window.sessionStorage) return true;
    var workKey = overlayWorkKeyFromItem(item);
    if (!workKey) return true;
    var raw = window.sessionStorage.getItem(METADATA_BROADCAST_DEDUPE_KEY);
    if (!raw) return true;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return true;
    return parsed[workKey] !== storyMetadataFingerprint(item);
  } catch (_) {
    return true;
  }
}

function rememberMetadataBroadcast(item) {
  try {
    if (!window.sessionStorage) return;
    var workKey = overlayWorkKeyFromItem(item);
    if (!workKey) return;
    var raw = window.sessionStorage.getItem(METADATA_BROADCAST_DEDUPE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") {
      parsed = {};
    }
    parsed[workKey] = storyMetadataFingerprint(item);
    window.sessionStorage.setItem(
      METADATA_BROADCAST_DEDUPE_KEY,
      JSON.stringify(parsed),
    );
  } catch (_) {
    /* ignore */
  }
}

function sourceStoryIdFromItem(item) {
  var workKey = overlayWorkKeyFromItem(item);
  if (!workKey) return null;
  var parts = workKey.split(":");
  return parts.length === 2 ? parts[1] : null;
}

function listingMetadataRefreshItemFromImportItem(item) {
  var sourceStoryId = sourceStoryIdFromItem(item);
  if (!sourceStoryId || item.src !== "ffn") return null;
  return {
    source: "ffn",
    sourceStoryId: sourceStoryId,
    url: item.u || undefined,
    title: item.t || undefined,
    author: item.a || undefined,
    summary: item.sm || undefined,
    chapters:
      typeof item.cht === "number" && Number.isFinite(item.cht)
        ? item.cht
        : undefined,
    words:
      typeof item.w === "number" && Number.isFinite(item.w)
        ? item.w
        : undefined,
    status: item.cmp || undefined,
    updatedAt: item.upd || undefined,
    publishedAt: item.pub || undefined,
    rating: item.r || undefined,
    language: item.l || undefined,
    fandoms: Array.isArray(item.fms) && item.fms.length ? item.fms : undefined,
    characters:
      Array.isArray(item.chars) && item.chars.length ? item.chars : undefined,
    relationships:
      Array.isArray(item.ra) && item.ra.length
        ? item.ra
        : Array.isArray(item.rels) && item.rels.length
          ? item.rels
          : undefined,
    genre: item.gen || undefined,
  };
}

function listingMetadataRefreshFingerprint(items) {
  return JSON.stringify(
    (items || []).map(function (item) {
      return {
        source: item.source,
        sourceStoryId: item.sourceStoryId,
        url: item.url || null,
        title: item.title || null,
        author: item.author || null,
        summary: item.summary || null,
        chapters:
          typeof item.chapters === "number" && Number.isFinite(item.chapters)
            ? item.chapters
            : null,
        words:
          typeof item.words === "number" && Number.isFinite(item.words)
            ? item.words
            : null,
        status: item.status || null,
        updatedAt: item.updatedAt || null,
        publishedAt: item.publishedAt || null,
        rating: item.rating || null,
        language: item.language || null,
        fandoms: Array.isArray(item.fandoms) ? item.fandoms.slice().sort() : [],
        characters: Array.isArray(item.characters)
          ? item.characters.slice().sort()
          : [],
        relationships: Array.isArray(item.relationships)
          ? item.relationships.slice().sort()
          : [],
        genre: item.genre || null,
      };
    }),
  );
}

function shouldSendListingMetadataRefresh(items) {
  try {
    if (!window.sessionStorage) return true;
    var fingerprint = listingMetadataRefreshFingerprint(items);
    var raw = window.sessionStorage.getItem(LISTING_METADATA_REFRESH_DEDUPE_KEY);
    if (raw === fingerprint) return false;
    window.sessionStorage.setItem(LISTING_METADATA_REFRESH_DEDUPE_KEY, fingerprint);
    return true;
  } catch (_) {
    return true;
  }
}

function collectTrackedListingMetadataRefreshItems(cacheEntries) {
  if (!isFFN()) return [];
  if (/\/s\/\d+(?:\/|$)/.test(location.pathname || "")) return [];
  if (!cacheEntries || typeof cacheEntries !== "object") return [];

  var rows = collectFFNListings();
  if (!rows.length) return [];

  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    var item = rows[i];
    var workKey = overlayWorkKeyFromItem(item);
    if (!workKey || !cacheEntries[workKey] || seen[workKey]) continue;
    var refreshItem = listingMetadataRefreshItemFromImportItem(item);
    if (!refreshItem) continue;
    seen[workKey] = true;
    out.push(refreshItem);
    if (out.length >= LISTING_METADATA_REFRESH_ITEM_LIMIT) break;
  }
  return out;
}

function visibleListingWorkKeysForMetadataRefresh() {
  var seen = Object.create(null);
  return collectFFNListings()
    .map(function (item) {
      return overlayWorkKeyFromItem(item);
    })
    .filter(function (workKey) {
      if (!workKey || seen[workKey]) return false;
      seen[workKey] = true;
      return true;
    })
    .slice(0, 250);
}

function submitListingMetadataRefresh(cacheEntries) {
  var items = collectTrackedListingMetadataRefreshItems(cacheEntries);
  if (!items.length || !shouldSendListingMetadataRefresh(items)) return;
  sendCollectorMessageBestEffort({
    type: "TRACE_LIBRARY_METADATA_REFRESH",
    payload: { items: items },
  });
}

function sendListingMetadataRefreshForTrackedItems(attempt) {
  var retryCount =
    typeof attempt === "number" && Number.isFinite(attempt) ? attempt : 0;

  if (KERNEL_SESSION_ACTIVE) {
    var workKeys = visibleListingWorkKeysForMetadataRefresh();
    if (!workKeys.length) return;
    sendCollectorMessage(
      { type: ACCOUNT_PROJECTION_GET_MESSAGE, workKeys: workKeys },
      function (response) {
        if (!response || response.ok !== true) {
          if (retryCount < LISTING_METADATA_REFRESH_MAX_ATTEMPTS) {
            setTimeout(function () {
              sendListingMetadataRefreshForTrackedItems(retryCount + 1);
            }, LISTING_METADATA_REFRESH_RETRY_MS);
          }
          return;
        }
        var entries =
          response.projection &&
          response.projection.entries &&
          typeof response.projection.entries === "object"
            ? response.projection.entries
            : null;
        if (!entries) return;
        submitListingMetadataRefresh(entries);
      },
    );
    return;
  }

  try {
    ext.storage.local.get(
      [
        "authToken",
        OVERLAY_CACHE_KEY,
        TRACE_ACCOUNT_ID_KEY,
        TRACE_API_BASE_STORAGE_KEY,
      ],
      function (res) {
      if (ext.runtime.lastError || !res || !res.authToken) return;

      var cache = overlayCacheForRuntimeContext(res[OVERLAY_CACHE_KEY], res);
      var entries = cache && cache.entries;
      if (!entries || typeof entries !== "object") {
        if (retryCount < LISTING_METADATA_REFRESH_MAX_ATTEMPTS) {
          setTimeout(function () {
            sendListingMetadataRefreshForTrackedItems(retryCount + 1);
          }, LISTING_METADATA_REFRESH_RETRY_MS);
        }
        return;
      }

      submitListingMetadataRefresh(entries);
      },
    );
  } catch (_) {
    /* best-effort passive enrichment */
  }
}

function scheduleListingMetadataRefreshForCurrentPage() {
  if (shouldDisableTraceContentScript()) return;
  if (!isFFN()) return;
  if (/\/s\/\d+(?:\/|$)/.test(location.pathname || "")) return;
  setTimeout(function () {
    sendListingMetadataRefreshForTrackedItems(0);
  }, 250);
}

function shouldSkipRecentAutoTrack(item) {
  try {
    if (!window.sessionStorage) return false;
    var raw = window.sessionStorage.getItem(AUTO_TRACK_DEDUPE_KEY);
    if (!raw) return false;
    var parsed = JSON.parse(raw);
    if (!parsed || parsed.key !== autoTrackFingerprint(item)) return false;
    var at = Number(parsed.at || 0);
    return Number.isFinite(at) && Date.now() - at < AUTO_TRACK_DEDUPE_WINDOW_MS;
  } catch (_) {
    return false;
  }
}

function rememberRecentAutoTrack(item) {
  try {
    if (!window.sessionStorage) return;
    window.sessionStorage.setItem(
      AUTO_TRACK_DEDUPE_KEY,
      JSON.stringify({
        key: autoTrackFingerprint(item),
        at: Date.now(),
      }),
    );
  } catch (_) {
    /* ignore */
  }
}

function forgetRecentAutoTrack(item) {
  try {
    if (!window.sessionStorage) return;
    var raw = window.sessionStorage.getItem(AUTO_TRACK_DEDUPE_KEY);
    if (!raw) return;
    var parsed = JSON.parse(raw);
    if (!parsed || parsed.key !== autoTrackFingerprint(item)) return;
    window.sessionStorage.removeItem(AUTO_TRACK_DEDUPE_KEY);
  } catch (_) {
    /* ignore */
  }
}

function sendAutoTrackForStory(validStory, options) {
  rememberRecentAutoTrack(validStory);
  if (!options || options.pendingAlreadySet !== true) {
    updateAutoTrackPendingForStory(validStory);
  }
  sendCollectorMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: validStory.src,
        at: new Date().toISOString(),
        item: validStory,
      },
    },
    function (response) {
      if (!response) {
        forgetRecentAutoTrack(validStory);
        updateAutoTrackFailureForStory(validStory, "network_error");
        return;
      }
      if (!response || response.ok !== true) {
        // The background rejects prerender/pending-deletion senders before it
        // attempts a write. Clear the dedupe marker so an activated page can
        // retry from pageshow/visibilitychange.
        if (!(response && response.error === "free_limit_reached")) {
          forgetRecentAutoTrack(validStory);
        }
        updateAutoTrackFailureForStory(validStory, response && response.error);
        if (response && response.error === "free_limit_reached") {
          showCapacityRecoveryNotice(response.capacity, true);
        }
        return;
      }
      applyConfirmedOverlayUpdateForStory(validStory, response);
    },
  );
}

function applyConfirmedOverlayUpdateForStory(item, response) {
  var workKey = overlayWorkKeyFromItem(item);
  if (!workKey) return;

  if (response && response.state && response.state.status === "saved") {
    applyBackgroundWorkStateForStory(workKey, response.state);
    if (response.state.entry && typeof response.state.entry === "object") {
      writeConfirmedOverlayEntryForStory(workKey, response.state.entry, function () {
        if (getWorkKeyFromUrl() === workKey) {
          renderQuickAddButton(workKey);
        }
      });
      return;
    }
    queryBackgroundWorkStateForStory(workKey);
    return;
  }

  queryBackgroundWorkStateForStory(workKey);
}

function rerenderStoryHandleForWorkKey(workKey) {
  if (!storyQuickAddUiReady) return;
  if (!workKey || getWorkKeyFromUrl() !== workKey) return;
  renderQuickAddButton(workKey);
}

function optimisticStoryEntryHasLibraryState(entry) {
  return !!(entry && (entry.readerStatus || entry.status || entry.hidden));
}

function pendingAutoTrackPatchForStaleEntry(entry, optimisticEntry) {
  if (
    !optimisticEntry ||
    optimisticEntry.__traceAutoTrackPending !== true ||
    !optimisticEntry.__traceObservedChapters
  ) {
    return {};
  }
  var observedChapter = storyEntryChapterCurrent({
    chapters: optimisticEntry.__traceObservedChapters,
  });
  var confirmedChapter = storyEntryChapterCurrent(entry);
  if (
    observedChapter == null ||
    (confirmedChapter != null && confirmedChapter >= observedChapter)
  ) {
    return {};
  }
  return {
    __traceAutoTrackPending: true,
    __traceAutoTrackError: null,
    __traceObservedChapters: optimisticEntry.__traceObservedChapters,
  };
}

function applyBackgroundWorkStateForStory(workKey, state, options) {
  if (!workKey || !state || state.workKey !== workKey) return false;
  if (state.status === "pending") {
    var prevPending = optimisticStoryPageEntries[workKey] || {};
    if (optimisticStoryEntryHasLibraryState(prevPending)) return false;
    optimisticStoryPageEntries[workKey] = Object.assign({}, prevPending, {
      __traceAutoTrackPending: true,
      __traceAutoTrackError: null,
    });
    return true;
  }

  if (state.status === "saved") {
    var previousEntry = optimisticStoryPageEntries[workKey] || {};
    var entry =
      state.entry && typeof state.entry === "object"
        ? normalizeOverlayEntry(state.entry)
        : {};
    var pendingPatch =
      options && options.preservePendingIfUnacknowledged === true
        ? pendingAutoTrackPatchForStaleEntry(entry, previousEntry)
        : {};
    optimisticStoryPageEntries[workKey] = Object.assign(
      {},
      entry,
      {
        entryId: state.entryId || entry.entryId,
        statusChoicesAvailable: !!(state.entryId || entry.entryId),
        __traceSyncVersion:
          typeof state.syncVersion === "string" ? state.syncVersion : null,
        __traceAutoTrackPending: false,
        __traceAutoTrackError: null,
      },
      pendingPatch,
    );
    return true;
  }

  if (state.status === "error") {
    var prevError = optimisticStoryPageEntries[workKey] || {};
    if (optimisticStoryEntryHasLibraryState(prevError)) return false;
    optimisticStoryPageEntries[workKey] = Object.assign({}, prevError, {
      __traceAutoTrackPending: false,
      __traceAutoTrackError: state.error || "network_error",
    });
    return true;
  }

  return false;
}

function writeConfirmedOverlayEntryForStory(workKey, entry, cb, expectedAccountId) {
  if (!workKey || !entry || typeof entry !== "object") {
    if (typeof cb === "function") cb(false);
    return;
  }
  if (KERNEL_SESSION_ACTIVE) {
    if (typeof cb === "function") cb(true);
    return;
  }

  ext.storage.local.get(
    [
      "authToken",
      OVERLAY_CACHE_KEY,
      TRACE_ACCOUNT_ID_KEY,
      TRACE_API_BASE_STORAGE_KEY,
    ],
    function (res) {
    if (ext.runtime.lastError || !res || !res.authToken) {
      if (typeof cb === "function") cb(false);
      return;
    }

    var activeAccountId = normalizeStorageString(res[TRACE_ACCOUNT_ID_KEY]);
    if (
      expectedAccountId &&
      (!activeAccountId || activeAccountId !== normalizeStorageString(expectedAccountId))
    ) {
      if (typeof cb === "function") cb(false);
      return;
    }

    var cache = overlayCacheForRuntimeContext(res[OVERLAY_CACHE_KEY], res) || {};
    var entries = Object.assign({}, cache.entries || {});
    entries[workKey] = entry;
    ext.storage.local.set(
      {
        [OVERLAY_CACHE_KEY]: Object.assign(
          {},
          cache,
          overlayCacheContextPatch(res),
          { entries: entries },
        ),
      },
      function () {
        if (typeof cb === "function") cb(!ext.runtime.lastError);
      },
    );
    },
  );
}

function queryBackgroundWorkStateForStory(workKey) {
  if (!workKey) return;
  sendCollectorMessage(
    { type: WORK_STATE_GET_MESSAGE, workKey: workKey },
    function (response) {
      if (!response || response.ok !== true || !response.state) return;
      if (
        applyBackgroundWorkStateForStory(workKey, response.state, {
          preservePendingIfUnacknowledged: true,
        })
      ) {
        rerenderStoryHandleForWorkKey(workKey);
      }
    },
  );
}

function clearStoryAuthError(workKey) {
  var entry = optimisticStoryPageEntries[workKey];
  if (
    !entry ||
    (entry.__traceAutoTrackError !== "auth_expired" &&
      entry.__traceAutoTrackError !== "not_authenticated")
  ) {
    return;
  }
  if (!optimisticStoryEntryHasLibraryState(entry)) {
    delete optimisticStoryPageEntries[workKey];
    return;
  }
  optimisticStoryPageEntries[workKey] = Object.assign({}, entry, {
    __traceAutoTrackError: null,
  });
}

function requestStoryAuthRefreshOnResume(workKey) {
  // Kernel mode deliberately requires an explicit Connect/Retry action and
  // owns native account adoption inside the background controller.
  if (KERNEL_SESSION_ACTIVE) return;
  if (!storyAuthRecoveryNeeded || storyAuthRefreshInFlight) return;
  var now = Date.now();
  if (now - storyAuthRefreshLastAttemptAt < 1500) return;
  storyAuthRefreshLastAttemptAt = now;
  storyAuthRefreshInFlight = true;
  sendCollectorMessage(
    { type: TRACE_IOS_AUTH_REFRESH_REQUEST_MESSAGE },
    function (response) {
      storyAuthRefreshInFlight = false;
      if (!response || response.ok !== true) return;
      clearStoryAuthError(workKey);
      renderQuickAddButton(workKey);
    },
  );
}

function updateAutoTrackPendingForStory(item) {
  var workKey = overlayWorkKeyFromItem(item);
  if (!workKey) return;
  var prev = optimisticStoryPageEntries[workKey] || {};
  var observedChapter =
    item && typeof item.chn === "number" && Number.isFinite(item.chn)
      ? Math.max(1, Math.trunc(item.chn))
      : null;
  var observedTotal =
    item && typeof item.cht === "number" && Number.isFinite(item.cht)
      ? Math.max(observedChapter || 1, Math.trunc(item.cht))
      : null;
  var pending = Object.assign({}, prev, {
    __traceAutoTrackPending: true,
    __traceAutoTrackError: null,
  });
  if (observedChapter != null) {
    pending.__traceObservedChapters = {
      current: observedChapter,
      total: observedTotal,
    };
  }
  optimisticStoryPageEntries[workKey] = pending;
  rerenderStoryHandleForWorkKey(workKey);
}

function clearAutoTrackPendingForStory(item) {
  var workKey = overlayWorkKeyFromItem(item);
  if (!workKey) return;
  var prev = optimisticStoryPageEntries[workKey];
  if (!prev || prev.__traceAutoTrackPending !== true) return;
  var next = Object.assign({}, prev);
  delete next.__traceAutoTrackPending;
  delete next.__traceAutoTrackError;
  delete next.__traceObservedChapters;
  if (Object.keys(next).length === 0) {
    delete optimisticStoryPageEntries[workKey];
  } else {
    optimisticStoryPageEntries[workKey] = next;
  }
  rerenderStoryHandleForWorkKey(workKey);
}

function updateAutoTrackFailureForStory(item, error) {
  var workKey = overlayWorkKeyFromItem(item);
  if (!workKey) return;
  var prev = optimisticStoryPageEntries[workKey] || {};
  if (error === "ignored_sender") {
    delete optimisticStoryPageEntries[workKey];
    rerenderStoryHandleForWorkKey(workKey);
    return;
  }
  var failed = Object.assign({}, prev, {
    __traceAutoTrackPending: false,
    __traceAutoTrackError: error || "network_error",
  });
  if (failed.__traceObservedChapters) {
    delete failed.__traceObservedChapters;
  }
  optimisticStoryPageEntries[workKey] = failed;
  rerenderStoryHandleForWorkKey(workKey);
}

function isAO3() {
  const h = location.hostname.toLowerCase();
  return (
    h === "archiveofourown.org" || h.endsWith(".archiveofourown.org") ||
    h === "archiveofourown.gay" || h.endsWith(".archiveofourown.gay") ||
    h === "archive.transformativeworks.org" ||
    h === "ao3.org"
  );
}
function isFFN() {
  return /(^|\.)fanfiction\.net$/i.test(location.hostname);
}
function isFFNMobile() {
  return /^m\.fanfiction\.net$/i.test(location.hostname);
}
function isFFNDesktop() {
  return /(^|\.)fanfiction\.net$/i.test(location.hostname) && !isFFNMobile();
}

function absAo3Url(href) {
  const h = String(href || "").trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return h;
  const path = h.startsWith("/") ? h : `/${h}`;
  try {
    return new URL(path, location.origin).href;
  } catch {
    return null;
  }
}

/** AO3 work meta `dl` contains nested `dl.stats`; blurbs use `dl.stats` on the row. */
function ao3StatsRoot(scope) {
  return one(scope, "dd.stats dl.stats") || one(scope, "dl.stats");
}

function parseAO3Series(scope) {
  if (!scope) return null;
  const ddSeries = one(scope, "dd.series");
  if (ddSeries) {
    const posSpan = one(ddSeries, "span.position");
    const seriesA =
      (posSpan && one(posSpan, "a[href*='/series/']")) || one(ddSeries, "a[href*='/series/']");
    if (seriesA) {
      const name = txt(seriesA);
      const url = absAo3Url(seriesA.getAttribute("href"));
      let pos = null;
      const probe = (posSpan && posSpan.textContent) || ddSeries.textContent || "";
      const m = probe.match(/Part\s+(\d+)\s+of/i);
      if (m) pos = parseInt(m[1], 10);
      return { name, pos, url };
    }
  }
  const liSer = one(scope, "ul.series li");
  if (liSer) {
    const seriesA = one(liSer, "a[href*='/series/']");
    if (seriesA) {
      const name = txt(seriesA);
      const url = absAo3Url(seriesA.getAttribute("href"));
      const strong = one(liSer, "strong");
      const pos = strong ? num(txt(strong)) : null;
      return { name, pos, url };
    }
  }
  return null;
}

function ao3ListingWarnings(row) {
  const selectors = [
    "ul.tags.commas li.warnings a.tag",
    "ul.tags.commas li[class*='warning'] a.tag",
    "dd.warning.tags a.tag",
    ".work .tags li.warnings a.tag",
  ];
  const out = [];
  for (const sel of selectors) {
    for (const t of qsa(row, sel).map(txt).filter(Boolean)) out.push(t);
  }
  if (out.length) return dedup(out);
  // Some skins / collapsed blurbs only expose warnings on the symbol row (title="A, B, C")
  const req = one(row, "ul.required-tags");
  if (!req) return [];
  for (const span of qsa(req, "span.warnings[title], .warnings[title]")) {
    const title = span.getAttribute("title");
    if (!title) continue;
    for (const part of title.split(/\s*,\s*/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return dedup(out);
}

function ao3ListingCategories(row) {
  const fromDd = dedup(qsa(row, "dd.category.tags a.tag").map(txt).filter(Boolean));
  if (fromDd.length) return fromDd;
  const sym = one(row, ".required-tags .category");
  const title = sym && sym.getAttribute("title");
  if (title) return dedup(title.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean));
  return [];
}

// --- FFN Helper Functions ---

function extractFFNFandomMobile() {
  const root = one(document, "#content") || document;
  const links = qsa(root, 'a[href*="/book/"]');
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    if (/\/book\/?$/.test(href)) continue;
    if (/\/(communities|forums|crossovers)\//.test(href)) continue;
    if (/[?&]/.test(href)) continue;
    const t = (link.textContent || "").trim();
    if (t) return t;
  }
  // On listing pages the fandom is text after the "Books" breadcrumb link, not a link itself
  const booksLink = links.find(l => /\/book\/?$/.test(l.getAttribute("href") || ""));
  if (booksLink) {
    let n = booksLink.nextSibling;
    while (n) {
      if (n.nodeType === 3) {
        const raw = (n.nodeValue || "").replace(/[»]/g, "").trim();
        if (raw && raw.length >= 2) return raw;
      }
      n = n.nextSibling;
    }
  }
  return null;
}

function extractFFNXutimes(html) {
  if (!html) return { pub: null, upd: null };
  const pubM = html.match(/Published:\s*<span[^>]*\bdata-xutime="(\d+)"/i);
  const updM = html.match(/Updated:\s*<span[^>]*\bdata-xutime="(\d+)"/i);
  return {
    pub: pubM ? pubM[1] : null,
    upd: updM ? updM[1] : null,
  };
}

function parseFFNMetaMobile(text, html) {
  // Example: "Rated: K+, English, ... Words: 893, Chapters: 43"
  const meta = String(text || "").replace(/\s+/g, " ").trim();
  const out = {};
  let m;

  m = meta.match(/Rated:\s*([^,]+)/i);
  if (m) {
    const rt = m[1].trim().replace(/^Fiction\s+/i, "").trim();
    const rm = rt.match(/^([A-Z]\+?)\b/i);
    out.r = rm ? rm[1] : rt;
  }

  const lang = extractFFNLanguageFromMeta(meta);
  if (lang) out.l = lang;

  m = meta.match(/Words:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.w = count(m[1]);

  m = meta.match(/Favs:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.fav = count(m[1]);

  m = meta.match(/Follows:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.fol = count(m[1]);

  m = meta.match(/Reviews:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.rev = count(m[1]);

  const commaStyle = parseFFNCommaGenreAndChars(meta);
  if (commaStyle.genre) out.gen = commaStyle.genre;

  m = meta.match(/Chapters:\s*(\d+)/i);
  if (m) out.chn = num(m[1]);

  const xu = extractFFNXutimes(html || "");
  if (xu.pub) out.pub = xu.pub;
  else {
    m = meta.match(/Published:\s*([A-Za-z]{3}\s+\d{1,2},\s*\d{4}[^,]*)/i);
    if (m) out.pub = m[1].trim();
  }
  if (xu.upd) out.upd = xu.upd;
  else {
    m = meta.match(/Updated:\s*([A-Za-z]{3}\s+\d{1,2},\s*\d{4}[^,]*)/i);
    if (m) out.upd = m[1].trim();
  }

  if (/Status:\s*Complete\b/i.test(meta) || /\s-\sComplete\b/i.test(meta)) {
    out.cmp = "complete";
  }

  if (looksLikeFFNCommaSeparatedMeta(meta)) {
    out.chars = commaStyle.chars;
    out.rels = commaStyle.rels;
  } else {
    const cr = extractFFNDesktopCharsAndRels(meta);
    out.chars = cr.chars;
    out.rels = cr.rels;
  }

  return out;
}

function parseFFNMobileListingMeta(text, html) {
  const meta = String(text || "").replace(/\s+/g, " ").trim();
  const out = {};

  const parts = splitFFNCommaMetaTokens(meta);
  if (parts.length >= 1) {
    const ratingToken = String(parts[0] || "").replace(/^Rated:\s*/i, "");
    const rm = ratingToken.match(/(?:Fiction\s*)?([A-Z]\+?)/i);
    out.r = rm ? rm[1] : ratingToken || null;
  }

  const lang = extractFFNLanguageFromMeta(meta);
  if (lang) out.l = lang;

  let m;
  const commaStyle = parseFFNCommaGenreAndChars(meta);
  if (commaStyle.genre) out.gen = commaStyle.genre;

  m = meta.match(/chapters:\s*(\d+)/i);
  if (m) out.chn = num(m[1]); // This is total

  m = meta.match(/words:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.w = count(m[1]);

  m = meta.match(/favs:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.fav = count(m[1]);

  m = meta.match(/follows:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.fol = count(m[1]);

  const xu = extractFFNXutimes(html || "");
  if (xu.upd) out.upd = xu.upd;
  else {
    m = meta.match(/updated:\s*([^,]+?)(?=\s+published:|\s*,\s*[A-Za-z]|$)/i);
    if (m) out.upd = m[1].trim();
  }
  if (xu.pub) out.pub = xu.pub;
  else {
    m = meta.match(/published:\s*([^,]+?)(?=\s*,\s*[A-Za-z]|$)/i);
    if (m) out.pub = m[1].trim();
  }

  if (/status:\s*complete\b/i.test(meta) || /,\s*complete\s*$/i.test(meta)) {
    out.cmp = "complete";
  }

  const lineChars = parseFFNCommaCharsFromWholeLine(meta);
  out.chars = lineChars.chars;
  out.rels = lineChars.rels;

  return out;
}

function extractMobileRowSummary(row, authorLink, grayDiv) {
  if (!row) return null;
  var startNode = authorLink || null;
  if (!startNode) {
    var storyLinks = qsa(row, 'a[href*="/s/"]');
    startNode = storyLinks.length ? storyLinks[storyLinks.length - 1] : null;
  }
  if (!startNode) return null;
  let out = "";
  let n = startNode.nextSibling;
  while (n) {
    if (grayDiv && n === grayDiv) break;
    if (n.nodeType === 3) {
      out += " " + (n.nodeValue || "");
    } else if (n.nodeType === 1) {
      const el = n;
      out += " " + (el.textContent || "");
    }
    n = n.nextSibling;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out || null;
}

function canonicalFFN(href) {
  const h = String(href || "").trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      return `https://www.fanfiction.net${u.pathname}`;
    } catch { }
  }
  const path = h.startsWith("/") ? h : `/${h}`;
  return `https://www.fanfiction.net${path}`;
}

// --- FFN Collectors ---

function collectFFNListingsMobile() {
  const root = one(document, "#content") || document;
  const rows = qsa(root, "div.bs.brb");
  if (!rows.length) return [];

  const isAuthorPage = /\/u\/\d+(?:\/|$)/.test(location.pathname || "");
  const fandom = isAuthorPage
    ? null
    : extractFFNFandomMobile() || extractFFNFandom() || null;
  const items = [];

  for (const row of rows) {
    const storyLinks = qsa(row, 'a[href*="/s/"]');
    const titleA = storyLinks[0] || null;
    if (!titleA) continue;

    const href = titleA.getAttribute("href") || "";
    const idm = href.match(/\/s\/(\d+)/);
    if (!idm) continue;

    const title = (titleA.textContent || "").trim();
    const authorA = one(row, 'a[href*="/u/"]');
    const author = txt(authorA);

    const gray = one(row, "div.gray");
    const metaText = txt(gray) || "";
    const metaHtml = gray ? gray.innerHTML || "" : "";
    const p = parseFFNMobileListingMeta(metaText, metaHtml);
    const summary = extractMobileRowSummary(row, authorA, gray);
    const revA = one(row, 'a[href*="/r/"]');
    const rev = count(txt(revA));

    const chapters = ffnImportChapters(1, p.chn ?? null);

    items.push({
      src: "ffn",
      ctx: "listing",
      u: canonicalFFN(href)?.split("#")[0],
      t: title,
      a: author,
      sm: summary,
      w: p.w ?? null,
      chn: chapters.chn,
      cht: chapters.cht,
      l: p.l ?? null,
      upd: p.upd ?? null,
      pub: p.pub ?? null,
      rev: rev ?? p.rev ?? null,
      fav: p.fav ?? null,
      fol: p.fol ?? null,
      gen: normalizeGenre(p.gen) ?? null,
      cmp: p.cmp ?? null,
      fms: fandom ? [fandom] : [],
      chars: p.chars ?? [],
      rels: p.rels ?? [],
      ra: p.rels ?? [],
      r: p.r ?? null
    });
  }

  return items;
}

function collectFFNStoryMobile() {
  const urlMatch = (location.pathname || "").match(/\/s\/(\d+)(?:\/(\d+))?/);
  if (!urlMatch) return null;
  const id = urlMatch[1];
  const currentChapter = urlMatch[2] ? parseInt(urlMatch[2], 10) : 1;

  const root = one(document, "#content") || document;
  const title = (document.title || "")
    .replace(/\s*[-|]\s*FanFiction(?:\.net)?\s*$/i, "")
    .replace(/^Fanfic:\s*/i, "")
    .replace(/\s+Ch\s+\d+,.*$/i, "")
    .trim();
  const author = txt(root.querySelector('a[href*="/u/"]')) || null;
  let summary = null;
  let summaryLen = 0;
  const tn = (title || "").trim();
  const an = (author || "").trim();
  for (const el of qsa(root, "div.xcontrast_txt")) {
    if (el.closest && el.closest("#storycontent, .storycontent, #storytext, .storytext")) continue;
    const s = txt(el);
    if (!s || s.length < 40) continue;
    if (tn && s === tn) continue;
    if (an && s === an) continue;
    if (/^Rated:\s*/i.test(s)) continue;
    if (s.length > summaryLen) {
      summary = s;
      summaryLen = s.length;
    }
  }
  if (!summary) {
    const oneTxt = txt(root.querySelector(".xcontrast_txt"));
    if (
      oneTxt &&
      oneTxt.length >= 40 &&
      oneTxt !== tn &&
      oneTxt !== an &&
      !/^Rated:\s*/i.test(oneTxt)
    ) {
      summary = oneTxt;
    }
  }

  const text = (root.textContent || "").replace(/\s+/g, " ").trim();
  const ratedIdx = text.toLowerCase().indexOf("rated:");
  const metaStr = ratedIdx >= 0 ? text.slice(ratedIdx) : "";
  const metaHtml = root.innerHTML || "";
  const p = parseFFNMetaMobile(metaStr, metaHtml);

  const fandom = extractFFNFandomMobile() || extractFFNFandom();

  // "Ch X of Y" nav may be outside #content; search full page
  const bodyText = (document.body.textContent || "").replace(/\s+/g, " ");
  const chOfMatch = bodyText.match(/Ch\s+\d+\s+of\s+(\d+)/i);
  const totalFromChOf = chOfMatch ? parseInt(chOfMatch[1], 10) : null;
  const totalChapters = p.chn || totalFromChOf || (p.w ? 1 : null);

  const revLink = one(root, 'a[href*="/r/"]');
  const rev = p.rev ?? (revLink ? count(txt(revLink)) : null);

  const chapters = ffnImportChapters(currentChapter, totalChapters);

  return {
    src: "ffn",
    ctx: "story",
    u: `https://www.fanfiction.net/s/${id}/`,
    t: title || "",
    a: author,
    sm: summary,
    w: p.w ?? null,
    chn: chapters.chn,
    cht: chapters.cht,
    l: p.l ?? null,
    upd: p.upd ?? null,
    pub: p.pub ?? null,
    rev: rev,
    fav: p.fav ?? null,
    fol: p.fol ?? null,
    gen: normalizeGenre(p.gen) ?? null,
    cmp: p.cmp ?? extractFFNCompletionFromContext(root) ?? null,
    fms: fandom ? [fandom] : [],
    chars: p.chars ?? [],
    rels: p.rels ?? [],
    ra: p.rels ?? [],
    r: p.r ?? null
  };
}

// --- AO3 Collectors ---

function collectAO3Work() {
  const m = (location.pathname || "").match(/\/works\/(\d+)/);
  if (!m) return null;
  const id = m[1];

  const meta = one(document, "dl.work.meta.group, dl.meta.group");
  const ddTags = (sel) => dedup(qsa(meta, sel + " a.tag").map(txt).filter(Boolean));

  let title = txt(one(document, "h2.title.heading")) || txt(one(document, "#workskin h2.title")) || txt(one(document, "h2.title")) || "";
  const author = txt(one(document, 'a[rel="author"], .byline a'));
  const ratingEl = one(document, ".required-tags .rating");
  const rating =
    (ratingEl && ratingEl.getAttribute("title")) ||
    txt(one(ratingEl, ".text")) ||
    txt(one(document, "dd.rating.tags a.tag, dd.rating.tags .tag"));

  const language = txt(one(meta, "dd.language")) || txt(one(document, "dd.language"));
  const words = num(txt(one(meta, "dd.words")) || txt(one(document, "dd.words")));

  const chRaw = txt(one(meta, "dd.chapters")) || txt(one(document, "dd.chapters"));
  const chp = parseCh(chRaw);
  const { cht } = ao3ImportChapters(chp);
  const chPub =
    typeof chp.n === "number" && Number.isFinite(chp.n) ? chp.n : null;
  const chn = detectAo3CurrentChapterNumber(chPub);

  const status = (() => {
    const req = one(document, ".required-tags");
    const t = req ? req.textContent || "" : "";
    if (/Complete Work/i.test(t)) return "complete";
    if (/Work in Progress/i.test(t)) return "wip";
    if (typeof chp.t === "number" && chp.n === chp.t) return "complete";
    if (typeof chp.t === "number" && typeof chp.n === "number" && chp.n < chp.t) return "wip";
    return null;
  })();

  let fandoms = ddTags("dd.fandom.tags");
  let relationships = ddTags("dd.relationship.tags");
  let characters = ddTags("dd.character.tags");
  let tags = ddTags("dd.freeform.tags");

  if (!fandoms.length) fandoms = dedup(qsa(document, "h5.fandoms a.tag, .fandoms a.tag").map(txt).filter(Boolean));
  if (!relationships.length) relationships = dedup(qsa(document, "li.relationships a.tag, .relationships a.tag").map(txt).filter(Boolean));
  if (!characters.length) characters = dedup(qsa(document, "li.characters a.tag, .characters a.tag").map(txt).filter(Boolean));
  if (!tags.length) tags = dedup(qsa(document, "li.freeforms a.tag, .freeforms a.tag, ul.tags li a.tag").map(txt).filter(Boolean));

  const stats = ao3StatsRoot(meta);
  const statDd = (cls) => {
    const el = stats ? one(stats, `dd.${cls}`) : one(meta, `dd.${cls}`);
    return el;
  };
  const kudos = num(txt(statDd("kudos")) || txt(one(document, "dd.kudos")));
  const hits = num(txt(statDd("hits")));
  const bookmarks = num(txt(statDd("bookmarks")));
  const comments = num(txt(statDd("comments")));
  const published = txt(statDd("published")) || null;
  const updated = txt(statDd("status")) || null;
  const warnings = ddTags("dd.warning.tags");
  const categories = ddTags("dd.category.tags");
  const series = parseAO3Series(meta);

  const summary = txt(one(document, ".summary blockquote.userstuff")) || null;
  const relParts = relPartsFromAO3(relationships);
  const charsUnion = dedup((characters || []).concat(relParts || []));
  const romanticRels = relationships.filter(r => r.includes("/"));

  return {
    src: "ao3",
    ctx: "story",
    u: `${location.origin}/works/${id}`,
    chu: currentAo3ChapterUrl(id),
    t: title,
    a: author,
    r: rating,
    s: status,
    l: language,
    w: words,
    k: kudos,
    h: hits,
    bk: bookmarks,
    cc: comments,
    wrn: warnings,
    cat: categories,
    pub: published,
    upd: updated,
    ser: series,
    chn,
    cht,
    chPub,
    fms: fandoms,
    rels: romanticRels,
    ra: relationships,
    chars: charsUnion,
    tags,
    sm: summary
  };
}

/** Shared extraction of metadata from an AO3 blurb row (works listing or bookmark). */
function extractAO3BlurbData(row, id, ctx) {
  const titleA = one(row, 'h4.heading a[href*="/works/"]');
  const title = txt(titleA) || "";
  const author = txt(one(row, 'a[rel="author"], .byline a'));
  const rating = (one(row, ".required-tags .rating")?.getAttribute("title")) || txt(one(row, ".required-tags .rating .text")) || null;

  const status = (() => {
    const rt = one(row, ".required-tags");
    const t = rt ? rt.textContent || "" : "";
    if (/Complete Work/i.test(t)) return "complete";
    if (/Work in Progress/i.test(t)) return "wip";
    return null;
  })();

  const fandoms = dedup(qsa(row, "h5.fandoms a.tag, .fandoms a.tag").map(txt).filter(Boolean)).slice(0, 20);
  const relationships = dedup(qsa(row, "ul.tags.commas li.relationships a.tag").map(txt).filter(Boolean)).slice(0, 20);
  const characters = dedup(qsa(row, "ul.tags.commas li.characters a.tag").map(txt).filter(Boolean));
  const tags = dedup(qsa(row, "ul.tags.commas li.freeforms a.tag").map(txt).filter(Boolean)).slice(0, 20);
  const stats = ao3StatsRoot(row);
  const statDd = (cls) => (stats ? one(stats, `dd.${cls}`) : one(row, `dl.stats dd.${cls}, dd.${cls}`));
  const language = txt(statDd("language")) || null;
  const words = num(txt(statDd("words")));
  const chRaw = txt(statDd("chapters"));
  const chp = parseCh(chRaw);
  const { chn, cht } = ao3ImportChapters(chp);
  const chPub =
    typeof chp.n === "number" && Number.isFinite(chp.n) ? chp.n : null;
  const kudos = num(txt(statDd("kudos")));
  const hits = num(txt(statDd("hits")));
  const bookmarks = num(txt(statDd("bookmarks")));
  const comments = num(txt(statDd("comments")));
  const published = txt(statDd("published")) || null;
  let updated = txt(statDd("status")) || null;
  if (!updated) updated = txt(one(row, ".header p.datetime, p.datetime")) || null;
  const warnings = ao3ListingWarnings(row);
  const categories = ao3ListingCategories(row);
  const series = parseAO3Series(row);
  const summary = txt(one(row, "blockquote.userstuff.summary, .userstuff.summary")) || null;

  const relParts = relPartsFromAO3(relationships);
  const extra = characters.filter((c) => !relParts.includes(c));
  const cap = 20;
  const charsFinal = relParts.length > cap ? relParts : dedup(relParts.concat(extra)).slice(0, cap);
  const romanticRels = relationships.filter(r => r.includes("/"));

  return {
    src: "ao3",
    ctx,
    u: `${location.origin}/works/${id}`,
    t: title,
    a: author,
    r: rating,
    s: status,
    l: language,
    w: words,
    k: kudos,
    h: hits,
    bk: bookmarks,
    cc: comments,
    wrn: warnings,
    cat: categories,
    pub: published,
    upd: updated,
    ser: series,
    chn,
    cht,
    chPub,
    fms: fandoms,
    rels: romanticRels,
    ra: relationships,
    chars: charsFinal,
    tags,
    sm: summary
  };
}

function collectAO3Listings() {
  const rows = qsa(document, 'li.work.blurb[id^="work_"], li.work[id^="work_"], .work.blurb[id^="work_"]');
  if (!rows.length) return [];
  const items = [];
  for (const row of rows) {
    const idm = (row.id || "").match(/work_(\d+)/);
    const id = idm ? idm[1] : null;
    if (!id) continue;
    items.push(extractAO3BlurbData(row, id, "listing"));
  }
  return items;
}

function collectAO3Bookmarks() {
  const rows = qsa(document, "li.bookmark.blurb");
  if (!rows.length) return [];
  const items = [];
  for (const row of rows) {
    // Bookmarks use id="bookmark_N" — extract work ID from class or title link
    let id = null;
    const classMatch = (row.className || "").match(/\bwork-(\d+)\b/);
    if (classMatch) {
      id = classMatch[1];
    } else {
      const titleA = one(row, 'h4.heading a[href*="/works/"]');
      const hrefMatch = titleA && (titleA.getAttribute("href") || "").match(/\/works\/(\d+)/);
      if (hrefMatch) id = hrefMatch[1];
    }
    // Skip external bookmarks (no /works/ link)
    if (!id) continue;
    items.push(extractAO3BlurbData(row, id, "bookmark"));
  }
  return items;
}

// --- FFN Helper Utils (Originals) ---

/** Longest synopsis div in profile header; avoids first .xcontrast_txt matching title only. */
function extractFFNDesktopStorySummary(profileTop, title) {
  if (!profileTop) return null;
  const tnorm = (title || "").trim();
  let best = null;
  let bestLen = 0;
  for (const d of qsa(profileTop, "div.xcontrast_txt")) {
    const s = txtWithoutTraceUi(d);
    if (!s || s.length < 40) continue;
    if (tnorm && s === tnorm) continue;
    if (/^Rated:\s*/i.test(s)) continue;
    if (s.length > bestLen) {
      best = s;
      bestLen = s.length;
    }
  }
  return best;
}

/** Gray line sometimes omits status; still present elsewhere in the same block. */
function extractFFNCompletionFromContext(container) {
  if (!container) return null;
  if (/Status:\s*Complete\b/i.test(container.textContent || "")) return "complete";
  return null;
}

function extractFFNFandomFromStoryBreadcrumb() {
  const root = document.querySelector("#pre_story_links .lc-left") || document.querySelector("#pre_story_links") || document.querySelector(".lc-left");
  if (!root) return null;
  const links = Array.from(root.querySelectorAll("a"));
  if (links.length >= 2) {
    const t = (links[links.length - 1].textContent || "").trim();
    return t || null;
  }
  return null;
}

function extractFFNFandomFromListingBreadcrumb() {
  const chevron = document.querySelector(".xicon-section-arrow, .icon-chevron-right");
  if (!chevron) return null;
  let n = chevron.nextSibling;
  while (n) {
    if (n.nodeType === 3) {
      const t = String(n.nodeValue || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    } else if (n.nodeType === 1) {
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    n = n.nextSibling;
  }
  return null;
}

function extractFFNFandom() {
  return (
    extractFFNFandomFromStoryBreadcrumb() ||
    extractFFNFandomFromListingBreadcrumb() ||
    extractFFNFandomFromTitle() ||
    null
  );
}

function extractFFNFandomFromTitle() {
  const raw = (document.title || "")
    .replace(/\s*\|\s*FanFiction(\.net)?\s*$/i, "")
    .trim();
  if (!raw) return null;

  const noPrefix = raw.replace(/^Fanfic:\s*/i, "").trim();
  const chapterFandom = noPrefix.match(
    /\bCh(?:apter)?\s*\d+\b[^,]*,\s*([^,|]+)$/i,
  );
  if (chapterFandom) {
    const fandom = (chapterFandom[1] || "").trim();
    if (fandom && fandom.length < 80) return fandom;
  }

  if (/\bCh(?:apter)?\s*\d+\b/i.test(noPrefix)) return null;
  return noPrefix && noPrefix.length < 80 ? noPrefix : null;
}

const FFN_META_LANGS = new Set([
  "English", "Spanish", "French", "German", "Italian", "Portuguese",
  "Dutch", "Russian", "Polish", "Chinese", "Japanese", "Korean",
]);
const FFN_META_LANG_LOOKUP = new Map(
  [...FFN_META_LANGS].map((language) => [language.toLowerCase(), language]),
);

function canonicalFFNLanguage(value) {
  const next = String(value || "").trim().toLowerCase();
  if (!next) return null;
  return FFN_META_LANG_LOOKUP.get(next) || null;
}

function extractFFNLanguageFromMeta(meta) {
  const normalized = String(meta || "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const langPattern = [...FFN_META_LANGS].join("|");
  let m = normalized.match(
    new RegExp(
      `^Rated:\\s*(?:Fiction\\s*)?[^,]+,\\s*(${langPattern})\\b`,
      "i",
    ),
  );
  if (m) return canonicalFFNLanguage(m[1]);

  m = normalized.match(new RegExp(`^[A-Z]\\+?\\s*,\\s*(${langPattern})\\b`, "i"));
  if (m) return canonicalFFNLanguage(m[1]);

  const dashSegs = normalized.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  for (const seg of dashSegs) {
    const lang = canonicalFFNLanguage(seg);
    if (lang) return lang;
  }

  m = normalized.match(new RegExp(`\\b(${langPattern})\\b`, "i"));
  return m ? canonicalFFNLanguage(m[1]) : null;
}

function parseFFNCharSegments(charSegments) {
  const chars = [];
  const rels = [];
  const raw = charSegments.join(", ");
  const bracketRe = /\[([^\]]+)\]/g;
  let m;
  while ((m = bracketRe.exec(raw)) !== null) {
    const inside = m[1].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
    chars.push(...inside);
    if (inside.length >= 2) rels.push(inside.join("/"));
  }
  const remainder = raw.replace(/\[[^\]]*\]/g, "");
  for (const piece of remainder.split(/\s*,\s*|\s+&\s+/)) {
    const t = piece.trim();
    if (t) chars.push(t);
  }
  return { chars: dedup(chars), rels: dedup(rels) };
}

function extractFFNDesktopCharsAndRelsFromDashes(meta) {
  const normalized = String(meta || "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized) return { chars: [], rels: [] };

  const segments = normalized.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const cut = segments.findIndex((s) => /^(Chapters|Words):/i.test(s));
  const endIdx = cut < 0 ? segments.length : cut;

  let start = 0;
  if (segments[start] && /^Rated:/i.test(segments[start])) start++;
  if (start < endIdx && segments[start] && FFN_META_LANGS.has(segments[start])) start++;

  if (start >= endIdx) return { chars: [], rels: [] };
  if (endIdx - start < 2) return { chars: [], rels: [] };

  return parseFFNCharSegments(segments.slice(start + 1, endIdx));
}

/**
 * Book/category listing rows put focus characters (or [pairing]) after the date line, e.g.
 * "... - Published: Apr 17, 2015 - Harry P., Hermione G., Neville L."
 * or "... - Published: ... - [Harry P., Hermione G.] - Complete"
 */
function extractFFNCharsAfterPublished(meta) {
  const normalized = String(meta || "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized) return { chars: [], rels: [] };

  const segments = normalized.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const pubIdx = segments.findIndex((s) => /^Published:/i.test(s));
  if (pubIdx < 0 || pubIdx >= segments.length - 1) return { chars: [], rels: [] };

  let tail = segments.slice(pubIdx + 1);
  tail = tail.filter((s) => {
    if (/^id:\s*\d+/i.test(s)) return false;
    if (/^Status:/i.test(s)) return false;
    if (/^Complete$/i.test(s)) return false;
    return true;
  });
  if (!tail.length) return { chars: [], rels: [] };

  return parseFFNCharSegments(tail);
}

function looksLikeFFNCommaSeparatedMeta(meta) {
  return /^(?:Rated:\s*(?:Fiction\s*)?[^,]+|[A-Z]\+?)\s*,\s*(English|Spanish|French|German|Italian|Portuguese|Dutch|Russian|Polish|Chinese|Japanese|Korean)\b/i.test(
    String(meta || "").trim(),
  );
}

function splitFFNCommaMetaTokens(input) {
  const text = String(input || "").trim();
  if (!text) return [];

  const out = [];
  let start = 0;
  let bracketDepth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "[") bracketDepth += 1;
    if (ch === "]" && bracketDepth > 0) bracketDepth -= 1;
    if (ch === "," && bracketDepth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());

  return out.filter(Boolean);
}

function isLikelyFFNCharacterToken(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  if (/\[[^\]]+\]/.test(t)) return true;
  if (/\./.test(t)) return true;
  if (/^(?:OC|OOC|SI|Self-Insert|Reader)$/i.test(t)) return true;
  return false;
}

function parseFFNCommaGenreAndChars(meta) {
  const normalized = String(meta || "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!looksLikeFFNCommaSeparatedMeta(normalized)) {
    return { genre: null, chars: [], rels: [] };
  }

  let body = normalized.replace(
    /^(?:Rated:\s*(?:Fiction\s*)?[^,]+|[A-Z]\+?)\s*,\s*/i,
    "",
  );

  const lang = extractFFNLanguageFromMeta(normalized);
  if (lang) {
    const escapedLang = lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    body = body.replace(new RegExp(`^${escapedLang}\\s*,\\s*`, "i"), "");
  }

  const statsStart = body.match(
    /(?:^|,\s*)(Words|Chapters|Reviews|Favs|Follows|Published|Updated|Status)\s*:/i,
  );
  if (statsStart && statsStart.index != null && statsStart.index >= 0) {
    body = body.slice(0, statsStart.index).trim();
  }

  body = body.replace(/,\s*$/, "").trim();
  if (!body) return { genre: null, chars: [], rels: [] };

  const tokens = splitFFNCommaMetaTokens(body);
  if (!tokens.length) return { genre: null, chars: [], rels: [] };

  const genreParts = [];
  const charTokens = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (i === 0 && !isLikelyFFNCharacterToken(token)) {
      genreParts.push(token);
      continue;
    }
    if (isLikelyFFNCharacterToken(token)) {
      charTokens.push(token);
    } else if (genreParts.length > 0) {
      genreParts.push(token);
    } else {
      charTokens.push(token);
    }
  }

  const cr = parseFFNCharSegments(charTokens);
  const genre = genreParts.join(", ").trim() || null;
  return { genre, chars: cr.chars, rels: cr.rels };
}

function parseFFNCommaCharsFromWholeLine(meta) {
  const tokens = splitFFNCommaMetaTokens(meta);
  const charTokens = tokens.filter((token) => {
    const t = String(token || "").trim();
    if (!t) return false;
    if (/^Rated:/i.test(t)) return false;
    if (/^[A-Z]\+?$/i.test(t)) return false;
    if (canonicalFFNLanguage(t)) return false;
    if (/:/.test(t)) return false;
    return isLikelyFFNCharacterToken(t);
  });
  return parseFFNCharSegments(charTokens);
}

/**
 * FFN often uses comma-separated meta on desktop now, e.g.
 * "Rated: T, English, Drama & Friendship, [A, B] C., D., Words: …"
 * (dash-splitting yields a single segment and hides the character block).
 */
function extractFFNCommaStyleCharsAndRels(meta) {
  const parsed = parseFFNCommaGenreAndChars(meta);
  return { chars: parsed.chars, rels: parsed.rels };
}

function extractFFNDesktopCharsAndRels(meta) {
  const normalized = String(meta || "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized) return { chars: [], rels: [] };

  const fromDash = extractFFNDesktopCharsAndRelsFromDashes(normalized);
  if (fromDash.chars.length || fromDash.rels.length) return fromDash;

  const fromComma = extractFFNCommaStyleCharsAndRels(normalized);
  if (fromComma.chars.length || fromComma.rels.length) return fromComma;

  return extractFFNCharsAfterPublished(normalized);
}

function extractFFNDesktopCharacters(meta) {
  return extractFFNDesktopCharsAndRels(meta).chars;
}

function extractFFNDesktopGenre(meta) {
  const normalized = String(meta || "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const segments = normalized.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const cut = segments.findIndex((s) => /^(Chapters|Words):/i.test(s));
  const endIdx = cut < 0 ? segments.length : cut;
  let start = 0;
  if (segments[start] && /^Rated:/i.test(segments[start])) start++;
  if (start >= endIdx) {
    return extractFFNDesktopGenreCommaBeforeBracket(normalized);
  }
  if (segments[start] && FFN_META_LANGS.has(segments[start])) start++;
  if (start >= endIdx) {
    return extractFFNDesktopGenreCommaBeforeBracket(normalized);
  }
  const g = segments[start];
  if (!g || /^(Chapters|Words|Reviews|Favs|Follows|Updated|Published|Status):/i.test(g)) {
    return extractFFNDesktopGenreCommaBeforeBracket(normalized);
  }
  return g;
}

/** Comma meta: "… English, Drama & Friendship, [Harry P., …]" */
function extractFFNDesktopGenreCommaBeforeBracket(meta) {
  return parseFFNCommaGenreAndChars(meta).genre;
}

function parseFFNMeta(meta, metaHtml) {
  meta = String(meta || "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  const out = {};
  let m;

  m = meta.match(/Rated:\s*(?:Fiction\s*)?([A-Z]\+?)/i);
  if (m) out.r = m[1];

  m = meta.match(/Words:\s*([\d.,]+\s*[km]?\+?)/i);
  if (m) out.w = count(m[1]);

  m = meta.match(/Chapters:\s*(\d+)/i);
  if (m) out.chn = num(m[1]);

  m = meta.match(/Reviews:\s*([\d,]+)/i);
  if (m) out.rev = num(m[1]);

  m = meta.match(/Favs:\s*([\d,]+)/i);
  if (m) out.fav = num(m[1]);

  m = meta.match(/Follows:\s*([\d,]+)/i);
  if (m) out.fol = num(m[1]);

  const gen = extractFFNDesktopGenre(meta);
  if (gen) out.gen = gen;

  if (/Status:\s*Complete\b/i.test(meta) || /\s-\sComplete\b/i.test(meta)) {
    out.cmp = "complete";
  }

  const xu = extractFFNXutimes(metaHtml || "");
  if (xu.upd) {
    out.upd = xu.upd;
  } else {
    m = meta.match(/Updated:\s*([^ -][^-]*?)(?=\s+-\s+Published:|\s+-\s+id:|$)/i);
    if (m) out.upd = m[1].trim();
  }
  if (xu.pub) {
    out.pub = xu.pub;
  } else {
    m = meta.match(
      /Published:\s*(.+?)(?=\s+-\s*(?:Status:|Updated:|id:|\[|[A-Za-z])|$)/i
    );
    if (m) out.pub = m[1].trim();
  }

  out.l = extractFFNLanguageFromMeta(meta);

  const cr = extractFFNDesktopCharsAndRels(meta);
  out.chars = cr.chars;
  out.rels = cr.rels;

  return out;
}

function collectFFNStory() {
  const urlMatch = (location.pathname || "").match(/\/s\/(\d+)(?:\/(\d+))?/);
  if (!urlMatch) return null;
  if (isFFNMobile()) return collectFFNStoryMobile();

  const id = urlMatch[1];
  const currentChapter = urlMatch[2] ? parseInt(urlMatch[2], 10) : 1;

  const metaNode = one(document, "#profile_top span.xgray.xcontrast_txt, #profile_top .xgray.xcontrast_txt, #profile_top .xgray");
  const meta = metaNode ? metaNode.textContent || "" : "";
  const metaHtml = metaNode ? metaNode.innerHTML || "" : "";
  const p = parseFFNMeta(meta, metaHtml);

  const title =
    txt(one(document, "#profile_top b.xcontrast_txt")) ||
    txt(one(document, "#profile_top .xcontrast_txt")) ||
    (document.title || "").replace(/\s*[-|].*?FanFiction(?:\.net)?\s*$/i, "").trim();
  const author =
    txt(one(document, '#profile_top a[href*="/u/"]')) ||
    txt(one(document, 'a[href*="/u/"]')) ||
    null;
  const profileTop = one(document, "#profile_top");
  const summary =
    extractFFNDesktopStorySummary(profileTop, title) ||
    txtWithoutTraceUi(one(document, "#profile_top div.xcontrast_txt")) ||
    null;
  const fandom = extractFFNFandom();
  const totalChapters = p.chn ?? null;

  const chapters = ffnImportChapters(currentChapter, totalChapters);

  return {
    src: "ffn",
    ctx: "story",
    u: `https://www.fanfiction.net/s/${id}/`,
    t: title || "",
    a: author,
    sm: summary,
    w: p.w ?? null,
    chn: chapters.chn,
    cht: chapters.cht,
    l: p.l ?? null,
    upd: p.upd ?? null,
    pub: p.pub ?? null,
    rev: p.rev ?? null,
    fav: p.fav ?? null,
    fol: p.fol ?? null,
    gen: normalizeGenre(p.gen) ?? null,
    cmp: p.cmp ?? extractFFNCompletionFromContext(profileTop) ?? null,
    fms: fandom ? [fandom] : [],
    chars: p.chars ?? [],
    rels: p.rels ?? [],
    ra: p.rels ?? [],
    r: p.r ?? null
  };
}
function collectFFNListings() {
  if (isFFNMobile()) return collectFFNListingsMobile();
  
  const anchors = qsa(document, 'a.stitle[href*="/s/"]');
  if (!anchors.length) return [];
  const fandom = extractFFNFandom();
  const items = [];

  const containerOf = (a) => (a.closest && a.closest(".z-list")) || (a.parentElement && a.parentElement.closest && a.parentElement.closest(".z-list")) || a.parentElement || document;
  const summaryText = (node) => {
    if (!node) return null;
    const n = stripTraceUiFromClone(node);
    const m = n.querySelector(".z-padtop2.xgray, .xgray.xcontrast_txt, .xgray");
    if (m) m.remove();
    return (n.textContent || "").trim() || null;
  };

  for (const a of anchors) {
    const h = a.getAttribute("href") || "";
    const m = h.match(/\/s\/(\d+)/);
    if (!m) continue;

    const row = containerOf(a);
    const title = (a.textContent || "").trim();
    const author = txt(one(row, 'a[href*="/u/"]'));
    const metaNode = one(row, ".z-padtop2.xgray, .xgray.xcontrast_txt, .xgray");
    const rawMeta = metaNode ? metaNode.textContent || "" : "";
    const rawHtml = metaNode ? metaNode.innerHTML || "" : "";
    const p = parseFFNMeta(rawMeta, rawHtml);
    const summary = summaryText(one(row, ".z-indent, .zindent"));

    const chapters = ffnImportChapters(1, p.chn ?? null);

    items.push({
      src: "ffn",
      ctx: "listing",
      u: canonicalFFN(h)?.split("#")[0],
      t: title,
      a: author,
      sm: summary,
      w: p.w ?? null,
      chn: chapters.chn,
      cht: chapters.cht,
      l: p.l ?? null,
      upd: p.upd ?? null,
      pub: p.pub ?? null,
      rev: p.rev ?? null,
      fav: p.fav ?? null,
      fol: p.fol ?? null,
      gen: normalizeGenre(p.gen) ?? null,
      cmp: p.cmp ?? null,
      fms: fandom ? [fandom] : [],
      chars: p.chars ?? [],
      rels: p.rels ?? [],
      ra: p.rels ?? [],
      r: p.r ?? null
    });
  }
  return items;
}

function collect() {
  if (isAO3()) {
    const work = collectAO3Work();
    if (work) return { source: "ao3", items: [work] };
    const bookmarks = collectAO3Bookmarks();
    if (bookmarks.length) return { source: "ao3", items: bookmarks };
    const list = collectAO3Listings();
    return { source: "ao3", items: list };
  }
  if (isFFN()) {
    const story = collectFFNStory();
    if (story) return { source: "ffn", items: [story] };
    const list = collectFFNListings();
    return { source: "ffn", items: list };
  }
  return { source: "ao3", items: [] };
}

function canonicalReaderStatus(status) {
  if (
    typeof status !== "string" &&
    typeof status !== "number" &&
    typeof status !== "boolean"
  ) {
    return null;
  }
  var raw = String(status).trim().toUpperCase();
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

function legacyReaderStatus(status) {
  var canonical = canonicalReaderStatus(status);
  if (canonical === "SAVED") return "PLANNING";
  if (canonical === "CAUGHT_UP") return "READING";
  if (canonical === "FINISHED") return "COMPLETED";
  return canonical;
}

function quickAddStatusLabel(status) {
  var canonical = canonicalReaderStatus(status);
  var labels = {
    SAVED: "Saved",
    READING: "Reading",
    CAUGHT_UP: "Caught up",
    PAUSED: "Paused",
    FINISHED: "Finished",
    DROPPED: "Dropped",
  };
  return labels[canonical] || status;
}

function displayChaptersForStatus(status, chapters) {
  if (!chapters || typeof chapters.current !== "number") return chapters;
  var canonical = canonicalReaderStatus(status);
  if (canonical === "SAVED") return null;
  if (canonical === "READING" && chapters.current <= 0) {
    return {
      current: 1,
      total: chapters.total == null ? null : chapters.total,
    };
  }
  return chapters;
}

function quickAddStatusDisplay(info) {
  var status =
    info && typeof info.readerStatus === "string"
      ? info.readerStatus
      : info && typeof info.status === "string"
        ? info.status
        : null;
  var label = quickAddStatusLabel(status);
  if (!label) label = "In Library";
  if (
    canonicalReaderStatus(status) !== "SAVED" &&
    displayChaptersForStatus(status, info && info.chapters) &&
    typeof displayChaptersForStatus(status, info && info.chapters).current === "number"
  ) {
    var chapters = displayChaptersForStatus(status, info && info.chapters);
    var total = chapters.total;
    label += " \u00b7 " + chapters.current + "/" + (total == null ? "?" : total);
  }
  return String(label).toUpperCase();
}

function storyInlineStatusDisplay(info) {
  var status =
    info && typeof info.readerStatus === "string"
      ? info.readerStatus
      : info && typeof info.status === "string"
        ? info.status
        : null;
  var label = quickAddStatusLabel(status);
  if (!label) label = "Saved";
  var progress = storyInlineProgressDisplay(info);
  return progress ? label + " " + progress : label;
}

function storyInlineDisplayChapters(info, status) {
  var chapters =
    info && info.__traceAutoTrackPending && info.__traceObservedChapters
      ? info.__traceObservedChapters
      : info && info.chapters;
  return displayChaptersForStatus(status, chapters);
}

function storyInlineProgressDisplay(info, statusOverride) {
  var status =
    canonicalReaderStatus(statusOverride) ||
    (info && typeof info.readerStatus === "string"
      ? info.readerStatus
      : info && typeof info.status === "string"
        ? info.status
        : null);
  var chapters = info && storyInlineDisplayChapters(info, status);
  if (
    canonicalReaderStatus(status) !== "SAVED" &&
    chapters &&
    typeof chapters.current === "number"
  ) {
    var total = chapters.total;
    return chapters.current + "/" + (total == null ? "?" : total);
  }
  return null;
}

function storyPendingAutoTrackStatus(entry) {
  var status = entryStatus(entry);
  if (status !== "SAVED" || !entry || !entry.__traceObservedChapters) {
    return status;
  }
  var observedChapter = storyEntryChapterCurrent({
    chapters: entry.__traceObservedChapters,
  });
  return observedChapter != null && observedChapter > 1 ? "READING" : status;
}

function shouldDelayAutoTrackUntilVisible() {
  try {
    if (document.prerendering === true) return true;
  } catch (_) {
    /* ignore */
  }

  try {
    if (document.visibilityState !== "hidden") return false;
  } catch (_) {
    return false;
  }

  try {
    if (typeof document.hasFocus === "function" && document.hasFocus()) {
      return false;
    }
  } catch (_) {
    /* ignore */
  }

  return true;
}

// Listen for background requests
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (TRACE_ACTIVE_TAB_PROBE_MODE) {
    if (msg?.type === "TRACE_ACTIVE_TAB_PROBE_PING") {
      if (shouldDisableTraceContentScript()) {
        sendResponse({ ok: false, probe: true, error: "blocked_page" });
      } else {
        sendResponse({ ok: true, probe: true });
      }
      return false;
    }
    if (msg?.type !== "TRACE_ACTIVE_TAB_PROBE_SAVE") return false;
    if (shouldDisableTraceContentScript()) {
      sendResponse({ ok: false, error: "blocked_page" });
      return false;
    }
    var probeCollected;
    var probeWorkKey;
    try {
      probeCollected = collect();
      probeWorkKey = getWorkKeyFromUrl();
    } catch (_) {
      probeCollected = null;
      probeWorkKey = null;
    }
    var probeItem = probeCollected && probeCollected.items
      ? probeCollected.items[0]
      : null;
    if (
      !probeWorkKey ||
      !probeItem ||
      probeItem.ctx !== "story" ||
      probeCollected.items.length !== 1
    ) {
      sendResponse({ ok: false, error: "unsupported_page" });
      return false;
    }
    sendCollectorMessage({
      type: TRACE_CONNECT_AND_SAVE_MESSAGE,
      workKey: probeWorkKey,
      payload: {
        s: probeCollected.source,
        at: new Date().toISOString(),
        item: probeItem,
      },
    }, function (response) {
      if (
        response &&
        response.ok === true &&
        response.command &&
        response.command.kind === "confirmed"
      ) {
        sendResponse({
          ok: true,
          state: "saved",
          site: probeItem.src === "ffn" ? "ffn" : "ao3",
          serverConfirmed: true,
        });
        return;
      }
      var reason = response && response.command && response.command.reason
        ? response.command.reason
        : response && response.error
          ? response.error
          : "save_failed";
      var publicReason = [
        "not_authenticated",
        "auth_expired",
        "free_limit_reached",
        "rate_limited",
        "unavailable",
      ].includes(reason)
        ? reason
        : "save_failed";
      sendResponse({ ok: false, error: publicReason });
    });
    return true;
  }

  if (shouldDisableTraceContentScript()) {
    if (
      msg?.type === "TRACE_COLLECT" ||
      msg?.type === "TRACE_SCHEDULE_AUTO_TRACK" ||
      msg?.type === TRACE_FIRST_STORY_FOCUS_ADD_MESSAGE
    ) {
      sendResponse({ ok: false, error: "page_contains_password_field" });
    }
    return false;
  }

  if (msg?.type === "TRACE_SCHEDULE_AUTO_TRACK") {
    try {
      scheduleAutoTrackForCurrentPage();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return false;
  }
  if (msg?.type === TRACE_FIRST_STORY_FOCUS_ADD_MESSAGE) {
    handleFirstStoryFocusAdd(sendResponse);
    return true;
  }
  if (msg?.type !== "TRACE_COLLECT") return false;
  try {
    const res = collect();
    const payload = {
      s: res.source,
      at: new Date().toISOString(),
      items: res.items
    };
    sendResponse({ ok: true, payload });
  } catch (e) {
    sendResponse({ ok: false, error: String(e?.message || e) });
  }
  // Synchronous sendResponse: must not return true (Chrome can drop the reply).
  return false;
});

/// =======================================================
// AUTOMATIC TRACKING LOGIC
// Story-page navigation is a strong enough signal that we track immediately.
// =======================================================

function collectStoryForAutoTrack() {
  if (isAO3()) {
    if (!/\/works\/\d+/.test(location.href)) return null;
    if (!hasStableAo3ChapterSignal()) return null;
    var ao3Story = collectAO3Work();
    if (ao3Story && isAo3EntireWorkView()) {
      // Rendering every chapter is not evidence that the reader has reached the
      // last one. Preserve normal save/metadata behavior while the dedicated
      // end detector owns the final progress transition.
      return Object.assign({}, ao3Story, { chn: 1, chu: null });
    }
    return ao3Story;
  }
  if (isFFN()) {
    if (!/\/s\/\d+/.test(location.href)) return null;
    return collectFFNStory();
  }
  return null;
}

var autoTrackVisibilityWaitAttached = false;

function queueAutoTrackWhenVisible(attempt) {
  if (!shouldDelayAutoTrackUntilVisible()) {
    startDwellTimer(attempt);
    return;
  }

  if (autoTrackVisibilityWaitAttached) return;
  autoTrackVisibilityWaitAttached = true;

  const resume = function () {
    if (shouldDelayAutoTrackUntilVisible()) return;
    autoTrackVisibilityWaitAttached = false;
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", resume);
    startDwellTimer(attempt);
  };

  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);
}

function startDwellTimer(attempt) {
  const retryCount =
    typeof attempt === "number" && Number.isFinite(attempt) ? attempt : 0;
  let validStory = null;

  validStory = collectStoryForAutoTrack();

  if (!validStory || !validStory.t || !validStory.u) {
    if (
      isAO3() &&
      /\/works\/\d+/.test(location.href) &&
      retryCount < AUTO_TRACK_READY_MAX_ATTEMPTS
    ) {
      setTimeout(function () {
        queueAutoTrackWhenVisible(retryCount + 1);
      }, AUTO_TRACK_READY_RETRY_MS);
    }
    return;
  }
  if (shouldBroadcastMetadata(validStory)) {
    rememberMetadataBroadcast(validStory);
    sendCollectorMessageBestEffort({
      type: "TRACE_METADATA_BROADCAST",
      payload: {
        s: validStory.src,
        at: new Date().toISOString(),
        item: validStory,
      },
    });
  }
  if (shouldSkipRecentAutoTrack(validStory)) {
    return;
  }
  var preferenceReadSettled = false;
  var pendingAlreadySet = false;
  ext.storage.local.get(
    ["prefAutoTrackEnabled"],
    (prefRes) => {
      preferenceReadSettled = true;
      if (ext.runtime.lastError) {
        if (shouldSkipRecentAutoTrack(validStory)) {
          return;
        }
        sendAutoTrackForStory(validStory, {
          pendingAlreadySet: pendingAlreadySet,
        });
        return;
      }
      if (prefRes.prefAutoTrackEnabled === false) {
        clearAutoTrackPendingForStory(validStory);
        return;
      }
      if (shouldSkipRecentAutoTrack(validStory)) {
        return;
      }
      sendAutoTrackForStory(validStory, {
        pendingAlreadySet: pendingAlreadySet,
      });
    },
  );
  if (!preferenceReadSettled) {
    // Safari resolves extension storage asynchronously. Project the observed
    // chapter while that read is pending so stale progress is never the first
    // story-handle state. Synchronous browser/test adapters skip this branch.
    pendingAlreadySet = true;
    updateAutoTrackPendingForStory(validStory);
  }
}

function scheduleAutoTrackForCurrentPage(attempt) {
  if (shouldDisableTraceContentScript()) return;
  queueAutoTrackWhenVisible(attempt);
}

if (!TRACE_ACTIVE_TAB_PROBE_MODE && !shouldDisableTraceContentScript()) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      scheduleAutoTrackForCurrentPage();
      scheduleListingMetadataRefreshForCurrentPage();
    });
  } else {
    scheduleAutoTrackForCurrentPage();
    scheduleListingMetadataRefreshForCurrentPage();
  }

  window.addEventListener("pageshow", function () {
    scheduleAutoTrackForCurrentPage();
    scheduleListingMetadataRefreshForCurrentPage();
  });
}

// =======================================================
// INLINE QUICK-ADD BUTTON (single story pages)
// =======================================================

var QUICK_ADD_ATTR = "data-trace-quick-add";
var QUICK_ADD_WRAP_ATTR = "data-trace-quick-add-wrap";
var TRACE_STORY_HANDLE_ATTR = "data-trace-story-handle";
var TRACE_STORY_SHEET_ATTR = "data-trace-story-sheet";
var TRACE_STORY_SHEET_CLOSE_ATTR = "data-trace-story-sheet-close";
var TRACE_STATUS_CHOICE_ATTR = "data-trace-status-choice";
var TRACE_STATUS_CHOICE_ERROR_ATTR = "data-trace-status-choice-error";

var TRACE_UI = {
  font: "Manrope,system-ui,-apple-system,'Segoe UI',sans-serif",
  paper: "#fffdf8",
  paperRaised: "#fbf7ee",
  paperSoft: "#f6f1e7",
  ink: "#1f2933",
  muted: "#647067",
  subtle: "#8a8171",
  border: "rgba(65,72,70,0.16)",
  borderStrong: "rgba(65,72,70,0.24)",
  forest: "#2d4b43",
  forestOn: "#c8eadf",
  gold: "#f7e6b6",
  goldOn: "#594402",
  rust: "#9a3412",
  danger: "#ba1a1a",
  radiusXs: "7px",
  radiusSm: "8px",
  radiusMd: "10px",
  shadowLow: "0 1px 2px rgba(28,28,23,0.08)",
  shadowSheet: "0 18px 48px rgba(28,28,23,0.24)",
};

// Local Trace extension UI tokens; keep this independent from the web app bundle.
var TRACE_FONT = "700 10px/1 " + TRACE_UI.font;
var TRACE_CHIP_BASE = [
  "display:inline-flex",
  "align-items:center",
  "justify-content:center",
  "box-sizing:border-box",
  "padding:5px 10px",
  "min-height:28px",
  "border-radius:" + TRACE_UI.radiusSm,
  "font:" + TRACE_FONT,
  "letter-spacing:0.04em",
  "text-transform:uppercase",
  "white-space:nowrap",
].join(";");

var TRACE_THEMES = {
  add:     { bg: TRACE_UI.forest, fg: TRACE_UI.forestOn, border: "rgba(22,52,45,0.35)", hover: "#385d52" },
  adding:  { bg: TRACE_UI.paperSoft, fg: TRACE_UI.subtle, border: "rgba(148,163,184,0.3)" },
  status:  { bg: TRACE_UI.gold, fg: TRACE_UI.goldOn, border: "rgba(89,68,2,0.2)" },
  added:   { bg: TRACE_UI.forest, fg: TRACE_UI.forestOn, border: "rgba(22,52,45,0.35)" },
  error:   { bg: "#fef2f2",     fg: "#dc2626", border: "rgba(220,38,38,0.25)" },
  full:    { bg: "#fff7df",     fg: "#b45309", border: "rgba(180,83,9,0.25)" },
  hidden:  { bg: "#eee7da",     fg: "#5b5142", border: "rgba(91,81,66,0.28)" },
  muted:   { bg: "#edf2ef",     fg: "#41504c", border: "rgba(65,80,76,0.18)" },
  mark:    { bg: "#f0e9dc",     fg: "#6f4d1f", border: "rgba(111,77,31,0.24)" },
};

// App-aligned light archive status tokens from library-app.css.
var TRACE_STATUS_TOKENS = {
  SAVED:     { accent: "#5b7488", container: "#e4e9ed", onContainer: "#3a566b", border: "#bfccd6" },
  READING:   { accent: "#bf8a1f", container: "#f4e6c2", onContainer: "#7c5400", border: "#e1c886" },
  CAUGHT_UP: { accent: "#1f8a7d", container: "#d6ece6", onContainer: "#136257", border: "#a3d2c9" },
  PAUSED:    { accent: "#a8623a", container: "#efddcd", onContainer: "#79401f", border: "#dcbe9f" },
  FINISHED:  { accent: "#4a8157", container: "#dcecde", onContainer: "#33603f", border: "#aacdb0" },
  DROPPED:   { accent: "#83707b", container: "#e8e0e3", onContainer: "#574852", border: "#cdbfc5" },
};
TRACE_STATUS_TOKENS.PLANNING = TRACE_STATUS_TOKENS.SAVED;
TRACE_STATUS_TOKENS.COMPLETED = TRACE_STATUS_TOKENS.FINISHED;

function traceStatusToken(status) {
  return TRACE_STATUS_TOKENS[canonicalReaderStatus(status) || status] || TRACE_STATUS_TOKENS.READING;
}

var TRACE_STATUS_THEMES = {
  READING:   { bg: TRACE_STATUS_TOKENS.READING.container, fg: TRACE_STATUS_TOKENS.READING.onContainer, border: TRACE_STATUS_TOKENS.READING.border },
  PLANNING:  { bg: TRACE_STATUS_TOKENS.PLANNING.container, fg: TRACE_STATUS_TOKENS.PLANNING.onContainer, border: TRACE_STATUS_TOKENS.PLANNING.border },
  PAUSED:    { bg: TRACE_STATUS_TOKENS.PAUSED.container, fg: TRACE_STATUS_TOKENS.PAUSED.onContainer, border: TRACE_STATUS_TOKENS.PAUSED.border },
  COMPLETED: { bg: TRACE_STATUS_TOKENS.COMPLETED.container, fg: TRACE_STATUS_TOKENS.COMPLETED.onContainer, border: TRACE_STATUS_TOKENS.COMPLETED.border },
  DROPPED:   { bg: TRACE_STATUS_TOKENS.DROPPED.container, fg: TRACE_STATUS_TOKENS.DROPPED.onContainer, border: TRACE_STATUS_TOKENS.DROPPED.border },
  SAVED:     { bg: TRACE_STATUS_TOKENS.SAVED.container, fg: TRACE_STATUS_TOKENS.SAVED.onContainer, border: TRACE_STATUS_TOKENS.SAVED.border },
  CAUGHT_UP: { bg: TRACE_STATUS_TOKENS.CAUGHT_UP.container, fg: TRACE_STATUS_TOKENS.CAUGHT_UP.onContainer, border: TRACE_STATUS_TOKENS.CAUGHT_UP.border },
  FINISHED:  { bg: TRACE_STATUS_TOKENS.FINISHED.container, fg: TRACE_STATUS_TOKENS.FINISHED.onContainer, border: TRACE_STATUS_TOKENS.FINISHED.border },
};

var TRACE_INLINE_THEMES = {
  add: { fg: "#1f4d3f", label: "#1f4d3f", border: "rgba(31,77,63,0.35)", accent: "#1f4d3f", weight: 600 },
  added: { fg: "#1f4d3f", label: "#1f4d3f", border: "transparent", accent: "#1f4d3f", weight: 500 },
  muted: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: "#9a9583", weight: 500 },
  hidden: { fg: "#6e6a5b", label: "#6e6a5b", border: "transparent", accent: "#9a9583", weight: 500 },
  saving: { fg: "#6e6a5b", label: "#6e6a5b", border: "rgba(110,106,91,0.28)", accent: "#9a9583", weight: 500 },
  error: { fg: "#b54a30", label: "#b54a30", border: "transparent", accent: "#b54a30", weight: 500 },
  full: { fg: "#8a6e2a", label: "#8a6e2a", border: "transparent", accent: "#8a6e2a", weight: 500 },
  READING: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.READING.accent, weight: 500 },
  PLANNING: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.PLANNING.accent, weight: 500 },
  PAUSED: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.PAUSED.accent, weight: 500 },
  COMPLETED: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.COMPLETED.accent, weight: 500 },
  DROPPED: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.DROPPED.accent, weight: 500 },
  SAVED: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.SAVED.accent, weight: 500 },
  CAUGHT_UP: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.CAUGHT_UP.accent, weight: 500 },
  FINISHED: { fg: "#3a4339", label: "#3a4339", border: "transparent", accent: TRACE_STATUS_TOKENS.FINISHED.accent, weight: 500 },
};

function traceChipCss(theme) {
  return TRACE_CHIP_BASE + ";background:" + theme.bg + ";color:" + theme.fg + ";border:1px solid " + theme.border;
}

function traceActionCss(theme) {
  return traceChipCss(theme) + ";min-height:42px;padding:0 14px;font:800 11px/1 " + TRACE_UI.font + ";cursor:pointer;box-shadow:" + TRACE_UI.shadowLow + ";transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease";
}

function isCompactTraceInline() {
  try {
    return !!(
      window.matchMedia &&
      window.matchMedia("(max-width: 640px)").matches
    );
  } catch (_) {
    return false;
  }
}

function isMobileStorySheet() {
  try {
    return !!(
      window.matchMedia &&
      window.matchMedia("(max-width: 640px)").matches
    );
  } catch (_) {
    return false;
  }
}

function traceInlineHandleCss(theme) {
  return [
    "display:inline-flex",
    "align-items:center",
    "justify-content:flex-start",
    "gap:8px",
    "box-sizing:border-box",
    "min-height:18px",
    "padding:2px 0",
    "border:0",
    "border-radius:0",
    "border-bottom:1px solid " + theme.border,
    "background:transparent",
    "color:" + theme.fg,
    "font:" + (theme.weight || 500) + " 13px/1.25 " + TRACE_UI.font,
    "letter-spacing:0",
    "text-transform:none",
    "white-space:nowrap",
    "cursor:pointer",
    "appearance:none",
    "-webkit-appearance:none",
    "vertical-align:baseline",
  ].join(";");
}

function traceStoryHandleDotCss(theme) {
  return [
    "display:inline-block",
    "width:8px",
    "height:8px",
    "border-radius:999px",
    "background:" + theme.accent,
    "flex:0 0 auto",
  ].join(";");
}

function traceStoryHandleLabelCss(theme) {
  return [
    "display:inline-block",
    "color:" + theme.label,
    "font:inherit",
    "line-height:1.25",
  ].join(";");
}

function traceStoryHandleProgressCss() {
  return [
    "display:inline-block",
    "color:#6e6a5b",
    "font:500 11.5px/1.2 'Geist Mono',ui-monospace,monospace",
  ].join(";");
}

function traceStoryHandleChevronCss() {
  return [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "width:11px",
    "height:11px",
    "color:#9a9583",
    "flex:0 0 auto",
  ].join(";");
}

function traceStoryHandleSpinnerCss(theme) {
  return [
    traceStoryHandleChevronCss(),
    "color:" + theme.accent,
  ].join(";");
}

function createTraceChevronSvg() {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 4l4 4 4-4");
  svg.appendChild(path);
  svg.style.cssText = "display:block;width:11px;height:11px";
  return svg;
}

function createTraceSpinnerSvg() {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  var group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  var track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  track.setAttribute("cx", "7");
  track.setAttribute("cy", "7");
  track.setAttribute("r", "4.9");
  track.setAttribute("opacity", "0.22");
  group.appendChild(track);
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M7 2.1a4.9 4.9 0 0 1 4.6 3.1");
  path.setAttribute("opacity", "0.95");
  group.appendChild(path);
  var spin = document.createElementNS("http://www.w3.org/2000/svg", "animateTransform");
  spin.setAttribute("attributeName", "transform");
  spin.setAttribute("type", "rotate");
  spin.setAttribute("from", "0 7 7");
  spin.setAttribute("to", "360 7 7");
  spin.setAttribute("dur", "0.8s");
  spin.setAttribute("repeatCount", "indefinite");
  group.appendChild(spin);
  svg.appendChild(group);
  svg.style.cssText = "display:block;width:12px;height:12px";
  return svg;
}

function getWorkKeyFromUrl() {
  if (isAO3()) {
    var m = location.pathname.match(/\/works\/(\d+)/);
    return m ? "ao3:" + m[1] : null;
  }
  if (isFFN()) {
    var m = location.pathname.match(/\/s\/(\d+)/);
    return m ? "ffn:" + m[1] : null;
  }
  return null;
}

function findQuickAddAnchor() {
  if (isAO3()) {
    return one(document, "h3.byline.heading") ||
           one(document, "h2.title.heading");
  }
  if (isFFN()) {
    if (isFFNMobile()) {
      var mobileHeader = one(document, "#content > div[align='center']");
      if (mobileHeader) return mobileHeader;
      return (
        one(document, "#content .xcontrast_txt") ||
        one(document, "#content")
      );
    }
    return one(document, "#profile_top") || one(document, "#content_wrapper_inner");
  }
  return null;
}

function storyTraceOpenUrl(authState, entry) {
  var fallback = TRACE_WEB_HOME_URL;
  var raw = authState && authState.helpUrl ? authState.helpUrl : fallback;
  try {
    var url = new URL(raw, fallback);
    if (url.pathname === "/apps" || url.pathname === "/apps/") {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
    }
    var entryId = entry && typeof entry.entryId === "string" ? entry.entryId.trim() : "";
    if (entryId) {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      url.searchParams.set("panel", "details");
      url.searchParams.set("entryId", entryId);
    }
    return url.href;
  } catch (_) {
    return fallback;
  }
}

function openTraceUrlInBrowserTab(url) {
  if (!url) return;
  sendCollectorMessageBestEffort({
    type: "TRACE_OPEN_TRACE_URL",
    payload: { url: url },
  });
}

function bindTraceOpenLink(link) {
  if (!link) return;
  link.addEventListener("click", function (event) {
    // Keep AO3/FFN page handlers out of injected UI clicks, but deliberately
    // preserve the anchor's normal target=_blank navigation. If Safari's
    // extension worker is suspended, the link must still open Trace.
    event.stopPropagation();
  });
}

function entryStatus(entry) {
  if (!entry) return null;
  return (
    canonicalReaderStatus(entry.canonicalReaderStatus) ||
    canonicalReaderStatus(entry.readerStatus) ||
    canonicalReaderStatus(entry.status)
  );
}

function progressDisplay(entry) {
  var status = entryStatus(entry);
  var chapters = displayChaptersForStatus(status, entry && entry.chapters);
  if (!chapters || typeof chapters.current !== "number") return null;
  return chapters.current + "/" + (chapters.total == null ? "?" : chapters.total);
}

function storyHeadline(view) {
  if (!view.hasAuth) {
    if (view.authState && view.authState.state === "reconnect_required") return "Reconnect Trace";
    if (view.authState && view.authState.state === "error") return "Trace unavailable";
    return "Connect Trace";
  }
  if (view.entry && view.entry.__traceStatusPending) return "Saving...";
  if (view.entry && view.entry.__traceStatusError) return "Update failed";
  if (view.entry && view.entry.hidden) return "Hidden";
  var status = entryStatus(view.entry);
  if (status) return quickAddStatusLabel(status);
  return "Not in Trace";
}

function storyCaption(view) {
  if (!view.hasAuth) {
    if (view.authState && view.authState.state === "reconnect_required") {
      return "Your session needs a refresh.";
    }
    if (view.authState && view.authState.state === "error") {
      return "Last sync failed. Source reading stays usable.";
    }
    return "Sign in to show your library lens here.";
  }
  if (view.entry && view.entry.__traceStatusPending) {
    return view.entry.__traceStatusTarget
      ? "Saving " + quickAddStatusLabel(view.entry.__traceStatusTarget)
      : "Saving reading status";
  }
  if (view.entry && view.entry.__traceStatusError) return view.entry.__traceStatusError;
  if (!entryStatus(view.entry) && !(view.entry && view.entry.hidden)) {
    return "One tap saves this to your Trace library.";
  }
  if (view.entry && view.entry.hidden) return "Hidden from browsing";
  var progress = progressDisplay(view.entry);
  if (progress) return "Chapter " + progress;
  return "In your library";
}

function handleDisplay(view) {
  if (!view.hasAuth) {
    if (view.authState && view.authState.state === "reconnect_required") return "Reconnect Trace";
    if (view.authState && view.authState.state === "error") return "Error";
    return "Connect";
  }
  if (view.entry && view.entry.__traceAutoTrackPending) return "Adding...";
  if (view.entry && view.entry.__traceAutoTrackError === "free_limit_reached") return "Full";
  if (
    view.entry &&
    (view.entry.__traceAutoTrackError === "auth_expired" ||
      view.entry.__traceAutoTrackError === "not_authenticated")
  ) {
    return "Reconnect";
  }
  if (view.entry && view.entry.__traceAutoTrackError) return "Error";
  if (view.entry && view.entry.__traceStatusPending) return "Saving...";
  if (view.entry && view.entry.__traceStatusError) return "Update failed";
  if (view.entry && view.entry.hidden) return "Hidden";
  var status = entryStatus(view.entry);
  if (status) return storyInlineStatusDisplay(view.entry);
  return "+ Add to Trace";
}

function storyHandlePresentation(view) {
  var entry = view && view.entry;
  if (!view || !view.hasAuth) {
    var authTheme =
      view && view.authState && view.authState.state === "error"
        ? TRACE_INLINE_THEMES.error
        : TRACE_INLINE_THEMES.muted;
    return {
      kind: "auth",
      label: handleDisplay(view || {}),
      theme: authTheme,
      dot: false,
      spinner: false,
      status: null,
      progress: null,
    };
  }
  if (entry && entry.__traceAutoTrackPending) {
    var pendingStatus = storyPendingAutoTrackStatus(entry);
    var pendingProgress = storyInlineProgressDisplay(entry, pendingStatus);
    if (pendingStatus && pendingProgress) {
      return {
        kind: "tracking",
        label: quickAddStatusLabel(pendingStatus) || "Reading",
        theme: TRACE_INLINE_THEMES[pendingStatus] || TRACE_INLINE_THEMES.saving,
        dot: false,
        spinner: true,
        status: pendingStatus,
        progress: pendingProgress,
      };
    }
    return {
      kind: "adding",
      label: "Adding...",
      theme: TRACE_INLINE_THEMES.saving,
      dot: false,
      spinner: true,
      status: null,
      progress: null,
    };
  }
  if (entry && entry.__traceAutoTrackError === "free_limit_reached") {
    return { kind: "full", label: "Full", theme: TRACE_INLINE_THEMES.full, dot: true, spinner: false, status: null, progress: null };
  }
  if (
    entry &&
    (entry.__traceAutoTrackError === "auth_expired" ||
      entry.__traceAutoTrackError === "not_authenticated")
  ) {
    return { kind: "auth-expired", label: "Reconnect", theme: TRACE_INLINE_THEMES.error, dot: true, spinner: false, status: null, progress: null };
  }
  if (entry && entry.__traceAutoTrackError) {
    return { kind: "error", label: "Error", theme: TRACE_INLINE_THEMES.error, dot: true, spinner: false, status: null, progress: null };
  }
  if (entry && entry.__traceStatusPending) {
    return { kind: "saving", label: "Saving...", theme: TRACE_INLINE_THEMES.saving, dot: false, spinner: true, status: null, progress: null };
  }
  if (entry && entry.__traceStatusError) {
    return { kind: "update-error", label: "Update failed", theme: TRACE_INLINE_THEMES.error, dot: true, spinner: false, status: null, progress: null };
  }
  if (entry && entry.hidden) {
    return { kind: "hidden", label: "Hidden", theme: TRACE_INLINE_THEMES.hidden, dot: true, spinner: false, status: null, progress: null };
  }
  var status = entryStatus(entry);
  if (status) {
    return {
      kind: "status",
      label: quickAddStatusLabel(status) || "Saved",
      theme: TRACE_INLINE_THEMES[status] || TRACE_INLINE_THEMES.muted,
      dot: true,
      spinner: false,
      status: status,
      progress: storyInlineProgressDisplay(entry),
    };
  }
  return {
    kind: "add",
    label: "+ Add to Trace",
    theme: TRACE_INLINE_THEMES.add,
    dot: false,
    spinner: false,
    status: null,
    progress: null,
  };
}

function applyStoryInlineHandleState(handle, presentation) {
  var theme = (presentation && presentation.theme) || TRACE_INLINE_THEMES.muted;
  clearElement(handle);
  handle.style.cssText = traceInlineHandleCss(theme);
  handle.setAttribute("data-trace-story-handle-state", presentation && presentation.kind ? presentation.kind : "unknown");
  if (presentation && presentation.status) {
    handle.setAttribute("data-trace-story-status", presentation.status);
  } else {
    handle.removeAttribute("data-trace-story-status");
  }

  if (presentation && presentation.spinner) {
    var spin = document.createElement("span");
    spin.setAttribute("aria-hidden", "true");
    spin.style.cssText = traceStoryHandleSpinnerCss(theme);
    spin.appendChild(createTraceSpinnerSvg());
    handle.appendChild(spin);
  } else if (presentation && presentation.dot) {
    var dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    dot.style.cssText = traceStoryHandleDotCss(theme);
    handle.appendChild(dot);
  }

  var label = document.createElement("span");
  label.textContent = (presentation && presentation.label) || "";
  label.style.cssText = traceStoryHandleLabelCss(theme);
  handle.appendChild(label);

  if (presentation && presentation.progress) {
    var progress = document.createElement("span");
    progress.textContent = presentation.progress;
    progress.style.cssText = traceStoryHandleProgressCss();
    handle.appendChild(progress);
  }

  var chev = document.createElement("span");
  chev.setAttribute("aria-hidden", "true");
  chev.style.cssText = traceStoryHandleChevronCss();
  chev.appendChild(createTraceChevronSvg());
  handle.appendChild(chev);
}

function autoTrackHandleDisabled(entry) {
  if (!entry) return false;
  return entry.__traceAutoTrackPending === true;
}

function applySheetVisibility(sheet, open) {
  if (!sheet) return;
  if (
    open &&
    sheet.getAttribute("data-trace-story-sheet-placement") === "popover"
  ) {
    positionDesktopStorySheet(
      sheet,
      document.querySelector("[" + TRACE_STORY_HANDLE_ATTR + "]"),
    );
  }
  sheet.style.display = open ? "block" : "none";
  sheet.setAttribute("aria-hidden", open ? "false" : "true");
  sheet.setAttribute("data-trace-open", open ? "1" : "0");
  if (open && sheet.getAttribute("data-trace-story-sheet-placement") === "bottom") {
    lockStoryBottomSheetPageScroll();
  } else {
    unlockStoryBottomSheetPageScroll();
  }
}

var storyBottomSheetScrollLock = null;

function lockStoryBottomSheetPageScroll() {
  if (storyBottomSheetScrollLock) return;
  var html = document.documentElement;
  var body = document.body;
  storyBottomSheetScrollLock = {
    htmlOverflow: html ? html.style.overflow : "",
    htmlOverscroll: html ? html.style.overscrollBehavior : "",
    bodyOverflow: body ? body.style.overflow : "",
    bodyOverscroll: body ? body.style.overscrollBehavior : "",
  };
  if (html) {
    html.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
  }
  if (body) {
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
  }
}

function unlockStoryBottomSheetPageScroll() {
  if (!storyBottomSheetScrollLock) return;
  var html = document.documentElement;
  var body = document.body;
  if (html) {
    html.style.overflow = storyBottomSheetScrollLock.htmlOverflow;
    html.style.overscrollBehavior = storyBottomSheetScrollLock.htmlOverscroll;
  }
  if (body) {
    body.style.overflow = storyBottomSheetScrollLock.bodyOverflow;
    body.style.overscrollBehavior = storyBottomSheetScrollLock.bodyOverscroll;
  }
  storyBottomSheetScrollLock = null;
}

function createStoryBottomSheetGrabber() {
  var zone = document.createElement("div");
  zone.className = "grab";
  zone.setAttribute("data-trace-bottom-sheet-grabber", "1");
  zone.setAttribute("aria-hidden", "true");
  zone.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "height:28px",
    "margin:0",
    "touch-action:none",
    "cursor:grab",
    "user-select:none",
  ].join(";");
  var bar = document.createElement("span");
  bar.style.cssText = "display:block;width:38px;height:4px;border-radius:999px;background:#c4bea8";
  zone.appendChild(bar);
  return zone;
}

function bindStoryBottomSheetDragClose(sheet, handle) {
  if (!sheet || !handle) return;
  var startY = 0;
  var dragging = false;
  var restingTransform = "translateX(-50%)";
  function pointerY(e) {
    if (e && e.touches && e.touches.length) return e.touches[0].clientY;
    if (e && e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY;
    return e && typeof e.clientY === "number" ? e.clientY : 0;
  }
  function resetDrag() {
    dragging = false;
    sheet.style.transition = "";
    sheet.style.transform = restingTransform;
  }
  function start(e) {
    dragging = true;
    startY = pointerY(e);
    if (e && e.cancelable) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    sheet.style.transition = "none";
    if (handle.setPointerCapture && e && e.pointerId != null) {
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }
  function move(e) {
    if (!dragging) return;
    var delta = Math.max(0, pointerY(e) - startY);
    if (e && e.cancelable) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    sheet.style.transform = restingTransform + " translateY(" + delta + "px)";
  }
  function end(e) {
    if (!dragging) return;
    if (e && e.cancelable) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    var delta = Math.max(0, pointerY(e) - startY);
    if (delta >= 56) {
      resetDrag();
      applySheetVisibility(sheet, false);
      return;
    }
    sheet.style.transition = "transform 160ms ease";
    sheet.style.transform = restingTransform + " translateY(0)";
    window.setTimeout(resetDrag, 180);
  }
  handle.style.cursor = "grab";
  handle.style.touchAction = "none";
  handle.addEventListener("pointerdown", start);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", resetDrag);
  handle.addEventListener("touchstart", start, { passive: false });
  handle.addEventListener("touchmove", move, { passive: false });
  handle.addEventListener("touchend", end);
  handle.addEventListener("touchcancel", resetDrag);
}

function storySheetCss(mobile) {
  var mobileWidth = Math.max(
    320,
    Math.min(500, (window.innerWidth || document.documentElement.clientWidth || 430) - 8),
  );
  var base = [
    "z-index:2147483646",
    "box-sizing:border-box",
    "max-height:" + (mobile ? "calc(100dvh - 8px)" : "min(68vh,520px)"),
    "overflow:auto",
    "overscroll-behavior:contain",
    "padding:0",
    "border-radius:" + (mobile ? "20px 20px 0 0" : "16px"),
    "border:1px solid rgba(28,39,34,0.18)",
    "background:#f7f3e9",
    "color:#1c2722",
    "box-shadow:" + (mobile
      ? "0 -18px 50px -16px rgba(20,14,0,0.4),0 0 0 1px rgba(28,39,34,0.10)"
      : "0 1px 0 rgba(255,250,230,0.4) inset,0 28px 60px -20px rgba(20,14,0,0.42),0 0 0 1px rgba(28,39,34,0.10)"),
    "font:500 13px/1.4 " + TRACE_UI.font,
    "-webkit-font-smoothing:antialiased",
  ];
  if (mobile) {
    return [
      "position:fixed",
      "left:50%",
      "right:auto",
      "bottom:0",
      "width:" + mobileWidth + "px",
      "transform:translateX(-50%)",
      "margin:0 auto",
      "max-width:calc(100vw - 8px)",
      "padding-bottom:env(safe-area-inset-bottom,0px)",
    ].concat(base).join(";");
  }
  return [
    "position:fixed",
    "margin:0",
    "max-width:360px",
    "text-align:left",
  ].concat(base).join(";");
}

function positionDesktopStorySheet(sheet, handle) {
  if (!sheet || !handle || !handle.getBoundingClientRect) return;
  var rect = handle.getBoundingClientRect();
  var viewportWidth = Math.max(
    320,
    window.innerWidth || document.documentElement.clientWidth || 430,
  );
  var panelWidth = Math.min(360, Math.max(280, viewportWidth - 20));
  var left = rect.left + rect.width / 2 - panelWidth / 2;
  left = Math.max(10, Math.min(left, viewportWidth - panelWidth - 10));
  var top = Math.max(10, rect.bottom + 8);

  sheet.style.width = panelWidth + "px";
  sheet.style.left = left + "px";
  sheet.style.top = top + "px";
  sheet.style.right = "auto";
  sheet.style.bottom = "auto";
}

function placeStorySheet(sheet, wrap, handle) {
  if (!sheet) return;
  var mobile = isMobileStorySheet();
  var parent = document.documentElement;
  if (parent && sheet.parentElement !== parent) {
    parent.appendChild(sheet);
  }
  sheet.style.cssText = storySheetCss(mobile);
  if (!mobile) positionDesktopStorySheet(sheet, handle);
  sheet.setAttribute("data-trace-story-sheet-placement", mobile ? "bottom" : "popover");
}

function storySheetSourceLine() {
  return (isAO3() ? "AO3" : "FFN");
}

function storySheetCurrentItem() {
  try {
    var collected = collect();
    return collected && collected.items && collected.items[0] ? collected.items[0] : null;
  } catch (_) {
    return null;
  }
}

function storySheetAuthorLine(item) {
  if (!item || !item.a) return "";
  return /^by\s+/i.test(String(item.a)) ? String(item.a) : "by " + item.a;
}

function storySheetLabelCss() {
  return "font:500 9px/1 'Geist Mono',ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:#9a9583";
}

function storySheetSerifFont() {
  return "'Fraunces',Georgia,'Times New Roman',serif";
}

function storySheetPrimaryButtonCss() {
  return [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "gap:8px",
    "box-sizing:border-box",
    "min-height:42px",
    "padding:12px 16px",
    "border-radius:11px",
    "border:1px solid #133029",
    "background:#133029",
    "color:#f3efe4",
    "font:600 13.5px/1 " + TRACE_UI.font,
    "text-decoration:none",
    "white-space:nowrap",
    "cursor:pointer",
  ].join(";");
}

function storySheetGhostButtonCss() {
  return [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "gap:8px",
    "box-sizing:border-box",
    "min-height:42px",
    "padding:12px 14px",
    "border-radius:11px",
    "border:1px solid rgba(28,39,34,0.18)",
    "background:transparent",
    "color:#3a4339",
    "font:600 13px/1 " + TRACE_UI.font,
    "text-decoration:none",
    "white-space:nowrap",
    "cursor:pointer",
  ].join(";");
}

function storySheetIconButtonCss() {
  return [
    storySheetGhostButtonCss(),
    "flex:0 0 auto",
    "width:44px",
    "padding:12px 0",
  ].join(";");
}

function storyStatusAccent(status) {
  return traceStatusToken(status).accent;
}

function storyStatusSoft(status) {
  return traceStatusToken(status).container;
}

function storySheetSvgIcon(kind) {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.style.cssText = "display:block;width:16px;height:16px";
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  if (kind === "tag") {
    path.setAttribute("d", "M2.5 3.5v4.2c0 .4.2.8.5 1.1l4.8 4.8a1.4 1.4 0 0 0 2 0l3.8-3.8a1.4 1.4 0 0 0 0-2L8.8 3a1.6 1.6 0 0 0-1.1-.5H3.5a1 1 0 0 0-1 1Z");
    svg.appendChild(path);
    var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", "5.7");
    dot.setAttribute("cy", "5.7");
    dot.setAttribute("r", "0.8");
    svg.appendChild(dot);
    return svg;
  }
  if (kind === "eyeoff") {
    path.setAttribute("d", "M2 2l12 12M6.4 6.4A2.3 2.3 0 0 0 9.6 9.6M4.8 4.3C3.5 5 2.5 6.2 1.8 8c1.2 3 3.3 4.5 6.2 4.5 1.1 0 2.1-.2 2.9-.7M8 3.5c2.9 0 5 1.5 6.2 4.5-.3.8-.8 1.5-1.3 2.1");
    svg.appendChild(path);
    return svg;
  }
  if (kind === "open") {
    path.setAttribute("d", "M6 4h6v6M12 4 5 11M3.5 6.5v6h6");
    svg.appendChild(path);
    return svg;
  }
  path.setAttribute("d", "M4 2.5h5.5L12 5v8.5H4zM6 7h4M6 10h4");
  svg.appendChild(path);
  return svg;
}

function storySheetMetaRow(iconKind, child) {
  var row = document.createElement("div");
  row.className = "x-meta-row";
  row.style.cssText = "display:flex;gap:11px;align-items:flex-start";
  var icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.className = "ic";
  icon.style.cssText = "width:16px;height:16px;color:#9a9583;flex-shrink:0;margin-top:1px";
  icon.appendChild(storySheetSvgIcon(iconKind));
  row.appendChild(icon);
  row.appendChild(child);
  return row;
}

function storySheetNoteText(text) {
  var note = document.createElement("span");
  note.className = "note";
  note.textContent = text;
  note.style.cssText = "display:block;flex:1;min-width:0;text-align:left;font:italic 15px/1.45 " + storySheetSerifFont() + ";color:#3a4339";
  return note;
}

function storySheetTagPill(text, collectionTone) {
  var tag = document.createElement("span");
  tag.className = collectionTone ? "x-utag coll" : "x-utag";
  tag.textContent = text;
  if (text && String(text).length > 24) tag.title = text;
  tag.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "gap:5px",
    "box-sizing:border-box",
    "max-width:150px",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "border-radius:999px",
    "padding:5px 14px",
    "font:600 14px/1.15 " + TRACE_UI.font,
    "white-space:nowrap",
    "background:" + (collectionTone ? "#ebdcab" : "#d8e3d5"),
    "color:" + (collectionTone ? "#8a6e2a" : "#1f4d3f"),
  ].join(";");
  return tag;
}

function visiblePrivateTags(context) {
  if (!context || !context.tags || !context.tags.length) return [];
  return context.tags.slice(0, PRIVATE_TAG_DISPLAY_LIMIT);
}

function sheetRowEl(label, value, emphasis) {
  var row = document.createElement("div");
  row.setAttribute("data-trace-story-sheet-row", label);
  row.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    "gap:12px",
    "box-sizing:border-box",
    "min-height:32px",
    "padding:8px 0",
    "border-top:1px solid rgba(28,39,34,0.10)",
    "background:transparent",
  ].join(";");
  var labelEl = document.createElement("span");
  labelEl.textContent = label;
  labelEl.style.cssText = storySheetLabelCss();
  var valueEl = document.createElement("span");
  valueEl.textContent = value;
  valueEl.style.cssText = "font:600 12.5px/1.3 " + TRACE_UI.font + ";color:" + (emphasis ? "#b54a30" : "#3a4339") + ";text-align:right";
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

function readerStatusChoiceLabel(status) {
  return quickAddStatusLabel(status);
}

function readerStatusChoiceErrorCopy(error) {
  if (error === "auth_expired" || error === "not_authenticated") {
    return "Reconnect Trace, then try again.";
  }
  if (error === "rate_limited") return "Trace is rate limiting updates. Try again soon.";
  if (error === "free_limit_reached") return "Library limit reached.";
  if (error === "finish_qualification_disabled") {
    return "Automatic finish updates are temporarily unavailable. Open Trace to update this work.";
  }
  return "Could not update. Try again.";
}

function readerStatusProgressPatch(entry, nextStatus) {
  var currentStatus = entryStatus(entry);
  var chapters = entry && entry.chapters;
  if (
    nextStatus !== "READING" ||
    canonicalReaderStatus(currentStatus) !== "SAVED" ||
    !chapters ||
    typeof chapters.current !== "number" ||
    chapters.current > 0
  ) {
    return null;
  }
  var total = chapters.total == null ? null : chapters.total;
  return {
    progress: { unit: "CHAPTER", value: 1, total: total },
    chapters: { current: 1, total: total },
  };
}

function storyEntryRatingValue(entry) {
  var rating = Number(entry && entry.rating);
  if (!Number.isFinite(rating)) return 0;
  return Math.max(0, Math.min(5, Math.trunc(rating)));
}

function storyCatchupProgressPatch(entry) {
  if (!entry || entry.catchupState !== "BEHIND") return null;
  var count = Number(entry.newChapterCount);
  if (!Number.isFinite(count) || count <= 0) return null;
  var chapters = entry.chapters;
  if (!chapters || typeof chapters.current !== "number") return null;
  var target = Math.trunc(chapters.current + count);
  if (!Number.isFinite(target) || target < 0) return null;
  var total =
    typeof chapters.total === "number" && Number.isFinite(chapters.total)
      ? Math.max(Math.trunc(chapters.total), target)
      : target;
  return {
    progress: { unit: "CHAPTER", value: target, total: total },
    chapters: { current: target, total: total },
  };
}

function storyRatingButtonStyle(active, disabled) {
  return [
    "appearance:none",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "width:32px",
    "height:32px",
    "border:0",
    "border-radius:7px",
    "background:transparent",
    "color:" + (active ? "#8a6e2a" : "#9a9583"),
    "font:600 21px/1 Georgia,serif",
    "cursor:" + (disabled ? "wait" : "pointer"),
    disabled ? "opacity:0.62" : "",
  ].join(";");
}

function applyOptimisticLibraryEntryPatch(workKey, entry, patch, nextChapters) {
  var next = snapshotStoryEntry(entry);
  if (Object.prototype.hasOwnProperty.call(patch, "rating")) {
    next.rating = patch.rating;
  }
  if (patch.status) {
    next.status = legacyReaderStatus(patch.status);
    next.readerStatus = legacyReaderStatus(patch.status);
    next.canonicalReaderStatus = canonicalReaderStatus(patch.status);
    next.statusChoicesAvailable = true;
  }
  if (nextChapters) {
    next.chapters = nextChapters;
    next.catchupState = "UP";
    next.newChapterCount = 0;
  }
  optimisticStoryPageEntries[workKey] = next;
}

function updateOptimisticReaderStatus(workKey, status, chapters) {
  var prev = optimisticStoryPageEntries[workKey] || {};
  var next = Object.assign({}, prev, {
    status: legacyReaderStatus(status),
    readerStatus: legacyReaderStatus(status),
    canonicalReaderStatus: canonicalReaderStatus(status),
    statusChoicesAvailable: true,
  });
  if (chapters) next.chapters = chapters;
  delete next.__traceStatusPending;
  delete next.__traceStatusTarget;
  delete next.__traceStatusError;
  delete next.__traceAutoTrackPending;
  delete next.__traceAutoTrackError;
  delete next.__traceObservedChapters;
  optimisticStoryPageEntries[workKey] = next;
}

function snapshotStoryEntry(entry) {
  return Object.assign({}, entry || {}, {
    chapters: entry && entry.chapters
      ? {
          current: entry.chapters.current,
          total: entry.chapters.total,
        }
      : undefined,
  });
}

function updateOptimisticReaderStatusPending(workKey, entry, status) {
  var next = snapshotStoryEntry(entry);
  next.__traceStatusPending = true;
  next.__traceStatusTarget = status;
  delete next.__traceStatusError;
  optimisticStoryPageEntries[workKey] = next;
}

function updateOptimisticReaderStatusError(workKey, entry, error) {
  var next = snapshotStoryEntry(entry);
  delete next.__traceStatusPending;
  delete next.__traceStatusTarget;
  next.__traceStatusError = error || "update_failed";
  optimisticStoryPageEntries[workKey] = next;
}

function bindReaderStatusChoice(btn, workKey, entry, status, errorEl) {
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    var entryId = entry && entry.entryId;
    if (!entryId) return;
    var statusPatch = readerStatusProgressPatch(entry, status);
    var previousEntry = snapshotStoryEntry(entry);
    if (errorEl) errorEl.textContent = "";
    updateOptimisticReaderStatusPending(workKey, entry, status);
    renderQuickAddButton(workKey);

    sendCollectorMessage(
      {
        type: "TRACE_SET_READER_STATUS",
        payload: Object.assign(
          { workKey: workKey, entryId: entryId, status: status },
          statusPatch && statusPatch.progress ? { progress: statusPatch.progress } : {},
        ),
      },
      function (response) {
        if (!response || !response.ok) {
          updateOptimisticReaderStatusError(workKey, previousEntry, readerStatusChoiceErrorCopy(response && response.error));
          renderQuickAddButton(workKey);
          return;
        }
        updateOptimisticReaderStatus(workKey, status, statusPatch && statusPatch.chapters);
        renderQuickAddButton(workKey);
      },
    );
  });
}

function appendStoryRatingControls(body, view, workKey) {
  var entry = view.entry || {};
  if (!view.hasAuth || !view.canMutate || !entry.entryId) return;
  var current = storyEntryRatingValue(entry);
  var wrap = document.createElement("div");
  wrap.setAttribute("data-trace-rating-control", "1");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;border-top:1px solid rgba(28,39,34,0.10);padding-top:12px";

  var label = document.createElement("div");
  label.className = "x-sheet-label";
  label.textContent = "Your rating";
  label.style.cssText = storySheetLabelCss();
  wrap.appendChild(label);

  var row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:2px";
  var message = document.createElement("span");
  message.setAttribute("data-trace-rating-message", "1");
  message.style.cssText = "margin-left:8px;font:600 11.5px/1.3 " + TRACE_UI.font + ";color:#6e6a5b";

  function renderStars(disabled) {
    clearElement(row);
    for (var i = 1; i <= 5; i += 1) {
      var star = document.createElement("button");
      star.type = "button";
      star.setAttribute("data-trace-rating-choice", String(i));
      star.setAttribute("aria-label", current === i ? "Clear rating" : "Set rating to " + i);
      star.textContent = i <= current ? "\u2605" : "\u2606";
      star.style.cssText = storyRatingButtonStyle(i <= current, disabled);
      star.disabled = disabled === true;
      star.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (this.disabled) return;
        var selected = Number(this.getAttribute("data-trace-rating-choice"));
        if (!Number.isFinite(selected)) return;
        var previous = current;
        var nextRating = current === selected ? 0 : selected;
        current = nextRating;
        entry.rating = nextRating;
        message.textContent = "Saving...";
        renderStars(true);
        sendCollectorMessage(
          {
            type: "TRACE_PATCH_LIBRARY_ENTRY",
            payload: {
              workKey: workKey,
              entryId: entry.entryId,
              patch: { rating: nextRating },
            },
          },
          function (response) {
            if (!response || !response.ok) {
              current = previous;
              entry.rating = previous;
              message.textContent = "Could not save";
              renderStars(false);
              return;
            }
            current = nextRating;
            applyOptimisticLibraryEntryPatch(workKey, entry, { rating: nextRating });
            message.textContent = nextRating > 0 ? "Saved" : "Cleared";
            renderStars(false);
          },
        );
      });
      row.appendChild(star);
    }
    row.appendChild(message);
  }

  renderStars(false);
  wrap.appendChild(row);
  body.appendChild(wrap);
}

function appendStoryCatchupAction(body, view, workKey) {
  var entry = view.entry || {};
  if (!view.hasAuth || !view.canMutate || !entry.entryId) return;
  var patch = storyCatchupProgressPatch(entry);
  if (!patch) return;
  var wrap = document.createElement("div");
  wrap.setAttribute("data-trace-catchup-action", "1");
  wrap.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid rgba(28,39,34,0.10);padding-top:12px";
  var text = document.createElement("div");
  text.style.cssText = "min-width:0";
  var title = document.createElement("div");
  title.textContent = "Catch up";
  title.style.cssText = "font:600 12.5px/1.25 " + TRACE_UI.font + ";color:#1c2722";
  var copy = document.createElement("div");
  copy.textContent = "Set progress to chapter " + patch.chapters.current + ".";
  copy.style.cssText = "margin-top:2px;font:500 11.5px/1.35 " + TRACE_UI.font + ";color:#6e6a5b";
  text.appendChild(title);
  text.appendChild(copy);

  var button = document.createElement("button");
  button.type = "button";
  button.textContent = "Mark caught up";
  button.style.cssText = storySheetGhostButtonCss() + ";flex:0 0 auto";
  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    button.textContent = "Saving...";
    sendCollectorMessage(
      {
        type: "TRACE_PATCH_LIBRARY_ENTRY",
        payload: {
          workKey: workKey,
          entryId: entry.entryId,
          patch: { status: "CAUGHT_UP", progress: patch.progress },
        },
      },
      function (response) {
        if (!response || !response.ok) {
          button.disabled = false;
          button.textContent = "Retry";
          return;
        }
        applyOptimisticLibraryEntryPatch(workKey, entry, { status: "CAUGHT_UP", progress: patch.progress }, patch.chapters);
        renderQuickAddButton(workKey);
      },
    );
  });

  wrap.appendChild(text);
  wrap.appendChild(button);
  body.appendChild(wrap);
}

function appendReaderStatusChoices(actions, view, workKey) {
  var entry = view.entry || {};
  if (!view.hasAuth || !view.canMutate) return;
  if (!entry.entryId) return;

  var wrap = document.createElement("div");
  wrap.setAttribute("data-trace-status-choices", "1");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";

  var label = document.createElement("div");
  label.className = "x-sheet-label";
  label.textContent = "Reading status";
  label.style.cssText = storySheetLabelCss();
  wrap.appendChild(label);

  var row = document.createElement("div");
  row.className = "x-seg";
  row.style.cssText = "display:flex;gap:5px";
  var error = document.createElement("div");
  error.setAttribute(TRACE_STATUS_CHOICE_ERROR_ATTR, "1");
  error.style.cssText = "min-height:16px;color:#b54a30;font:600 11.5px/1.3 " + TRACE_UI.font;

  TRACE_READER_STATUS_CHOICES.forEach(function (status) {
    var choice = document.createElement("button");
    choice.type = "button";
    choice.setAttribute(TRACE_STATUS_CHOICE_ATTR, status);
    var selected = entryStatus(entry) === status;
    choice.className = selected ? "on" : "";
    if (entryStatus(entry) === status) {
      choice.setAttribute("data-trace-status-selected", "1");
      choice.setAttribute("aria-pressed", "true");
    } else {
      choice.setAttribute("aria-pressed", "false");
    }
    choice.style.cssText = [
      "flex:1",
      "--sc:" + storyStatusAccent(status),
      "box-sizing:border-box",
      "min-width:0",
      "min-height:48px",
      "border:1px solid " + (selected ? storyStatusAccent(status) : "rgba(28,39,34,0.18)"),
      "background:" + (selected ? storyStatusSoft(status) : "#f3efe4"),
      "border-radius:8px",
      "padding:8px 2px",
      "overflow:visible",
      "font:500 11px/1 " + TRACE_UI.font,
      "color:" + (selected ? "#1c2722" : "#6e6a5b"),
      "cursor:pointer",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:5px",
    ].join(";");
    var dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    dot.className = "d";
    dot.style.cssText = [
      "display:block",
      "width:7px",
      "height:7px",
      "border-radius:999px",
      "background:" + (selected ? storyStatusAccent(status) : "#c4bea8"),
      "box-shadow:" + (selected ? "0 0 0 3px " + storyStatusSoft(status) : "none"),
    ].join(";");
    var text = document.createElement("span");
    text.textContent = readerStatusChoiceLabel(status);
    choice.appendChild(dot);
    choice.appendChild(text);
    bindReaderStatusChoice(choice, workKey, entry, status, error);
    row.appendChild(choice);
  });
  wrap.appendChild(row);
  wrap.appendChild(error);
  actions.appendChild(wrap);
}

function ensureQuickAddElements(workKey, anchor) {
  var wrap = document.querySelector("[" + QUICK_ADD_WRAP_ATTR + "]");
  var handle = document.querySelector("[" + TRACE_STORY_HANDLE_ATTR + "]");
  var sheet = document.querySelector("[" + TRACE_STORY_SHEET_ATTR + "]");

  if (!wrap) {
    wrap = document.createElement("div");
    wrap.setAttribute(QUICK_ADD_WRAP_ATTR, workKey);
  }
  wrap.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "box-sizing:border-box",
    "clear:both",
    "margin:" + (isAO3() ? "4px auto 8px auto" : "6px 0 8px 0"),
    "min-height:26px",
    "text-align:center",
  ].join(";");

  if (!handle) {
    handle = document.createElement("button");
    handle.setAttribute(TRACE_STORY_HANDLE_ATTR, workKey);
    handle.type = "button";
    wrap.appendChild(handle);
  } else if (handle.parentElement !== wrap) {
    wrap.appendChild(handle);
  }

  if (!sheet) {
    sheet = document.createElement("aside");
    sheet.setAttribute(TRACE_STORY_SHEET_ATTR, workKey);
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Trace story sheet");
  }

  if (!wrap.isConnected) {
    try {
      anchor.insertAdjacentElement("afterend", wrap);
    } catch (_) {
      if (anchor.parentNode) anchor.parentNode.appendChild(wrap);
    }
  }
  placeStorySheet(sheet, wrap, handle);

  return { wrap: wrap, handle: handle, sheet: sheet };
}

function reserveQuickAddSlot(workKey) {
  var anchor = findQuickAddAnchor();
  if (!anchor) return false;
  var els = ensureQuickAddElements(workKey, anchor);
  els.handle.setAttribute("data-trace-story-handle-state", "loading");
  els.handle.style.cssText = traceInlineHandleCss(TRACE_INLINE_THEMES.muted) +
    ";visibility:hidden;pointer-events:none";
  els.handle.textContent = "Trace";
  els.handle.disabled = true;
  applySheetVisibility(els.sheet, false);
  return true;
}

function removeQuickAddElements() {
  var wrap = document.querySelector("[" + QUICK_ADD_WRAP_ATTR + "]");
  if (wrap) {
    wrap.remove();
  }
  var sheet = document.querySelector("[" + TRACE_STORY_SHEET_ATTR + "]");
  if (sheet) {
    sheet.remove();
  }
}

function applyQuickAddLibraryState(btn, info) {
  var status = entryStatus(info) || "READING";
  var statusTheme = TRACE_STATUS_THEMES[status] || TRACE_STATUS_THEMES.READING;
  btn.style.cssText = traceActionCss(statusTheme);
  btn.textContent = quickAddStatusDisplay(info);
  btn.title = "This story is in your Trace library";
  btn.disabled = true;
}

function applyQuickAddActionState(btn, addTheme, compact) {
  btn.style.cssText = traceActionCss(addTheme);
  btn.textContent = "Add to Trace";
  btn.title = "Add this story to your Trace library";
  btn.disabled = false;
}

function sendQuickAddAction(btn, workKey, addTheme, compact, done) {
  var notifyDone = function (result) {
    if (typeof done === "function") done(result);
  };
  var collected;
  try {
    collected = collect();
  } catch (e) {
    notifyDone({ ok: false, error: String(e && e.message ? e.message : e) });
    return;
  }
  if (!collected.items.length) {
    notifyDone({ ok: false, error: "collect_failed" });
    return;
  }

  var payload = {
    s: collected.source,
    at: new Date().toISOString(),
    item: collected.items[0],
  };

  if (compact) {
    applyStoryInlineHandleState(btn, storyHandlePresentation({ hasAuth: true, entry: { __traceAutoTrackPending: true } }));
    btn.style.cursor = "wait";
  } else {
    btn.style.cssText = traceActionCss(TRACE_THEMES.adding) + ";cursor:wait";
    btn.textContent = "Adding...";
  }
  btn.disabled = true;

  sendCollectorMessage(
    { type: "TRACE_QUICK_ADD", payload: payload },
    function (response) {
      if (!response) {
        if (compact) {
          applyStoryInlineHandleState(btn, {
            kind: "error",
            label: "Error",
            theme: TRACE_INLINE_THEMES.error,
            dot: true,
            spinner: false,
          });
          btn.style.cursor = "pointer";
        } else {
          btn.style.cssText = traceActionCss(TRACE_THEMES.error) + ";cursor:pointer";
          btn.textContent = "ERROR";
        }
        btn.disabled = false;
        setTimeout(function () {
          if (compact) {
            applyStoryInlineHandleState(btn, storyHandlePresentation({ hasAuth: true, entry: null }));
          } else {
            applyQuickAddActionState(btn, addTheme, compact);
          }
        }, 2500);
        notifyDone({ ok: false, error: "runtime_error" });
        return;
      }

      if (response.ok) {
        if (compact) {
          applyStoryInlineHandleState(btn, {
            kind: "saved",
            label: "Saved",
            theme: TRACE_INLINE_THEMES.added,
            dot: true,
            spinner: false,
          });
        } else {
          btn.style.cssText = traceActionCss(TRACE_THEMES.added);
          btn.textContent = "ADDED \u2713";
        }
        btn.disabled = true;
        setTimeout(function () {
          var item = payload.item || {};
          var startedStoryPage =
            item.ctx === "story" &&
            typeof item.chn === "number" &&
            Number.isFinite(item.chn) &&
            item.chn > 1;
          var nextCanonical = startedStoryPage ? "READING" : "SAVED";
          var nextLegacy = legacyReaderStatus(nextCanonical);
          var next = { status: nextLegacy, readerStatus: nextLegacy, canonicalReaderStatus: nextCanonical };
          if (response.entryId) {
            next.entryId = response.entryId;
            next.statusChoicesAvailable = true;
          }
          if (startedStoryPage) {
            next.chapters = {
              current: item.chn,
              total:
                typeof item.cht === "number" && Number.isFinite(item.cht)
                  ? item.cht
                  : null,
            };
          }
          optimisticStoryPageEntries[workKey] = next;
          renderQuickAddButton(workKey);
        }, compact ? 450 : 1500);
        notifyDone({
          ok: true,
          state: "saved",
          entryId: response.entryId || null,
        });
      } else if (response.error === "free_limit_reached") {
        var capacityEntry = optimisticStoryPageEntries[workKey] || {};
        if (!optimisticStoryEntryHasLibraryState(capacityEntry)) {
          optimisticStoryPageEntries[workKey] = Object.assign({}, capacityEntry, {
            __traceAutoTrackPending: false,
            __traceAutoTrackError: "free_limit_reached",
          });
        }
        if (compact) {
          applyStoryInlineHandleState(btn, storyHandlePresentation({ hasAuth: true, entry: { __traceAutoTrackError: "free_limit_reached" } }));
        } else {
          btn.style.cssText = traceActionCss(TRACE_THEMES.full);
          btn.textContent = "Library full";
        }
        btn.title = "Free library limit reached \u2014 upgrade for unlimited";
        btn.disabled = false;
        showCapacityRecoveryNotice(response.capacity, true);
        renderQuickAddButton(workKey);
        setTimeout(function () {
          var capacitySheet = document.querySelector("[" + TRACE_STORY_SHEET_ATTR + "]");
          if (capacitySheet) applySheetVisibility(capacitySheet, true);
        }, 0);
        notifyDone({ ok: false, error: "free_limit_reached" });
      } else if (
        response.error === "auth_expired" ||
        response.error === "not_authenticated"
      ) {
        var authErrorEntry = optimisticStoryPageEntries[workKey] || {};
        optimisticStoryPageEntries[workKey] = Object.assign({}, authErrorEntry, {
          __traceAutoTrackPending: false,
          __traceAutoTrackError: response.error,
        });
        if (compact) {
          applyStoryInlineHandleState(btn, storyHandlePresentation({ hasAuth: true, entry: { __traceAutoTrackError: response.error } }));
        } else {
          btn.style.cssText = traceActionCss(TRACE_THEMES.error);
          btn.textContent = "Reconnect";
        }
        btn.disabled = false;
        renderQuickAddButton(workKey);
        notifyDone({ ok: false, error: response.error });
      } else {
        if (compact) {
          applyStoryInlineHandleState(btn, {
            kind: "error",
            label: "Error",
            theme: TRACE_INLINE_THEMES.error,
            dot: true,
            spinner: false,
          });
          btn.style.cursor = "pointer";
        } else {
          btn.style.cssText = traceActionCss(TRACE_THEMES.error) + ";cursor:pointer";
          btn.textContent = "Error";
        }
        btn.disabled = false;
        setTimeout(function () {
          if (compact) {
            applyStoryInlineHandleState(btn, storyHandlePresentation({ hasAuth: true, entry: null }));
          } else {
            applyQuickAddActionState(btn, addTheme, compact);
          }
        }, 2500);
        notifyDone({ ok: false, error: response.error || "quick_add_failed" });
      }
    },
  );
}

function findTraceStoryHandle(workKey) {
  var handle = document.querySelector("[" + TRACE_STORY_HANDLE_ATTR + "]");
  if (!handle) return null;
  var handleWorkKey = handle.getAttribute(TRACE_STORY_HANDLE_ATTR);
  return !handleWorkKey || handleWorkKey === workKey ? handle : null;
}

function focusFirstStoryTraceControl(handle) {
  if (!handle) return;
  var target = handle.closest("[" + QUICK_ADD_WRAP_ATTR + "]") || handle;
  try {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_) {
    try {
      target.scrollIntoView();
    } catch (_) {
      /* ignore */
    }
  }
  try {
    handle.focus({ preventScroll: true });
  } catch (_) {
    try {
      handle.focus();
    } catch (_) {
      /* ignore */
    }
  }
}

function firstStoryControlErrorForState(state) {
  if (state === "auth" || state === "auth-expired") return "not_authenticated";
  if (state === "full") return "free_limit_reached";
  return "save_failed";
}

function firstStoryStateAllowsQuickAddRetry(state) {
  return state === "add" || state === "auth" || state === "auth-expired" || state === "error";
}

function parseFirstStoryUrlForMatch(rawUrl) {
  var url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return null;
  }
  if (String(url.protocol).toLowerCase() !== "https:") return null;
  var host = String(url.hostname || "").toLowerCase();
  var parts = String(url.pathname || "")
    .split("/")
    .filter(Boolean);

  var isAo3Host =
    host === "archiveofourown.org" ||
    /\.archiveofourown\.org$/.test(host) ||
    host === "archiveofourown.gay" ||
    /\.archiveofourown\.gay$/.test(host) ||
    host === "archive.transformativeworks.org" ||
    host === "ao3.org" ||
    /\.ao3\.org$/.test(host);
  if (isAo3Host && parts[0] === "works" && /^\d+$/.test(parts[1] || "")) {
    if (parts.length === 2) {
      return { source: "ao3", storyId: parts[1], chapterId: null, chapterNumber: null };
    }
    if (
      parts.length === 4 &&
      parts[2] === "chapters" &&
      /^\d+$/.test(parts[3] || "")
    ) {
      return { source: "ao3", storyId: parts[1], chapterId: parts[3], chapterNumber: null };
    }
  }

  if (
    (host === "www.fanfiction.net" || host === "m.fanfiction.net") &&
    parts[0] === "s" &&
    /^\d+$/.test(parts[1] || "")
  ) {
    var chapterNumber =
      parts.length >= 3 && /^\d+$/.test(parts[2] || "")
        ? Number(parts[2])
        : null;
    return { source: "ffn", storyId: parts[1], chapterId: null, chapterNumber: chapterNumber };
  }

  return null;
}

function pendingFirstStoryMatchesCurrentPage(pendingUrl) {
  var pending = parseFirstStoryUrlForMatch(pendingUrl);
  var current = parseFirstStoryUrlForMatch(location.href);
  if (!pending || !current) return false;
  if (pending.source !== current.source || pending.storyId !== current.storyId) {
    return false;
  }
  if (pending.chapterId) {
    return current.chapterId === pending.chapterId;
  }
  if (typeof pending.chapterNumber === "number" && pending.chapterNumber > 1) {
    return current.chapterNumber === pending.chapterNumber;
  }

  try {
    var collected = collect();
    var item = collected && collected.items && collected.items[0];
    if (
      item &&
      typeof item.chn === "number" &&
      Number.isFinite(item.chn) &&
      item.chn > 1
    ) {
      return false;
    }
  } catch (_) {
    if (typeof current.chapterNumber === "number" && current.chapterNumber > 1) {
      return false;
    }
  }

  return true;
}

function sendIosPendingFirstStoryClear() {
  sendCollectorMessageBestEffort({
    type: TRACE_IOS_PENDING_FIRST_STORY_CLEAR_MESSAGE,
  });
}

function applyKernelConnectAndSavePresentation(handle, label, kind, disabled) {
  applyStoryInlineHandleState(handle, {
    kind: kind,
    label: label,
    theme: disabled ? TRACE_INLINE_THEMES.saving : TRACE_INLINE_THEMES.add,
    dot: false,
    spinner: kind === "connecting-and-saving",
    status: null,
    progress: null,
  });
  handle.disabled = disabled;
}

function runKernelConnectAndSave(handle, workKey) {
  if (!kernelPendingFirstStory || kernelPendingFirstStory.workKey !== workKey) return;
  if (kernelPendingFirstStory.commandInFlight) return;
  kernelPendingFirstStory.commandInFlight = true;
  var collected;
  try {
    collected = collect();
  } catch (_) {
    collected = null;
  }
  if (!collected || !collected.items || !collected.items.length) {
    kernelPendingFirstStory.commandInFlight = false;
    applyKernelConnectAndSavePresentation(handle, "Try again", "connect-and-save", false);
    handle.title = "Trace could not read this story yet. Reload the page and try again.";
    return;
  }
  var payload = {
    s: collected.source,
    at: new Date().toISOString(),
    item: collected.items[0],
  };
  var pendingHandoffId = kernelPendingFirstStory.handoffId;
  applyKernelConnectAndSavePresentation(
    handle,
    "Connecting…",
    "connecting-and-saving",
    true,
  );
  sendCollectorMessage({
    type: TRACE_CONNECT_AND_SAVE_MESSAGE,
    workKey: workKey,
    handoffId: pendingHandoffId,
    payload: payload,
  }, function (response) {
    if (response && response.ok === true) {
      var item = payload.item || {};
      var startedStoryPage =
        item.ctx === "story" &&
        typeof item.chn === "number" &&
        Number.isFinite(item.chn) &&
        item.chn > 1;
      var canonicalStatus = startedStoryPage ? "READING" : "SAVED";
      var legacyStatus = legacyReaderStatus(canonicalStatus);
      var entry = response.command && response.command.confirmation
        ? response.command.confirmation.entry
        : null;
      optimisticStoryPageEntries[workKey] = entry || {
        status: legacyStatus,
        readerStatus: legacyStatus,
        canonicalReaderStatus: canonicalStatus,
        entryId: response.entryId || undefined,
      };
      kernelPendingFirstStory = null;
      var anchor = findQuickAddAnchor();
      if (anchor) {
        renderQuickAddFromSnapshot(workKey, anchor, {
          libraryOverlayCache: {
            entries: {},
            workPreferences: {},
            syncVersion:
              response.command && response.command.confirmation
                ? response.command.confirmation.syncVersion || null
                : null,
          },
          traceAuthState: response.snapshot || {
            state: "connected",
            reason: "none",
            canExecuteAuthenticated: true,
          },
          authToken: "kernel-session",
        });
      }
      focusFirstStoryTraceControl(findTraceStoryHandle(workKey) || handle);
      return;
    }
    if (kernelPendingFirstStory && kernelPendingFirstStory.workKey === workKey) {
      kernelPendingFirstStory.commandInFlight = false;
    }
    var connected = response && response.snapshot && response.snapshot.state === "connected";
    applyKernelConnectAndSavePresentation(
      handle,
      connected ? "Retry save" : "Connect and save",
      "connect-and-save",
      false,
    );
    handle.title = connected
      ? "Trace did not confirm this save. Try again."
      : "Connect this extension session before saving the pending story.";
  });
}

function processIosPendingFirstStoryAdd() {
  var processResponse = function (response) {
    try {
      if (
        (!KERNEL_SESSION_ACTIVE && ext.runtime.lastError) ||
        !response ||
        response.ok !== true
      ) return;
      var pendingUrl = typeof response.url === "string" ? response.url.trim() : "";
      var mode = response.mode === "browse" ? "browse" : "story";
      var handoffId =
        typeof response.handoffId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(response.handoffId.trim())
          ? response.handoffId.trim()
          : "";

      if (mode === "browse") {
        var current = parseFirstStoryUrlForMatch(location.href);
        var expectedHost =
          response.hostKind === "ao3" || response.hostKind === "ffn"
            ? response.hostKind
            : "";
        // The AO3 home handoff intentionally survives navigation through
        // listing/search pages. Only a matching supported story page may
        // consume it, so a reader can browse normally before choosing one.
        if (!current || !expectedHost || current.source !== expectedHost) {
          return;
        }
      } else if (!pendingUrl || !pendingFirstStoryMatchesCurrentPage(pendingUrl)) {
        // Kernel retrieval is read-only. The later command owner decides
        // when a pending handoff has been consumed or should be cleared.
        if (!KERNEL_SESSION_ACTIVE) sendIosPendingFirstStoryClear();
        return;
      }
      if (handoffId) {
        announceArchivePageToBackground(handoffId);
      }
      if (KERNEL_SESSION_ACTIVE) {
        var workKey = getWorkKeyFromUrl();
        if (!workKey) return;
        if (
          !kernelPendingFirstStory ||
          kernelPendingFirstStory.workKey !== workKey ||
          kernelPendingFirstStory.handoffId !== handoffId
        ) {
          kernelPendingFirstStory = {
            workKey: workKey,
            handoffId: handoffId,
            automaticAttempted: false,
            commandInFlight: false,
          };
        }
        renderQuickAddButton(workKey);
        return;
      }
      handleFirstStoryFocusAdd(function (result) {
        if (result && result.ok) {
          sendIosPendingFirstStoryClear();
        }
      });
    } finally {
      if (KERNEL_SESSION_ACTIVE) {
        kernelFirstStoryLookupPending = false;
        var currentWorkKey = getWorkKeyFromUrl();
        if (currentWorkKey) renderQuickAddButton(currentWorkKey);
      }
    }
  };
  sendCollectorMessage(
    { type: TRACE_IOS_PENDING_FIRST_STORY_GET_MESSAGE },
    processResponse,
  );
}

function handleFirstStoryFocusAdd(sendResponse, attempt) {
  var workKey = getWorkKeyFromUrl();
  if (!workKey) {
    sendResponse({ ok: false, error: "unsupported_page" });
    return;
  }

  renderQuickAddButton(workKey);
  setTimeout(function () {
    var handle = findTraceStoryHandle(workKey);
    if (!handle) {
      if ((attempt || 0) < FIRST_STORY_FOCUS_MAX_ATTEMPTS) {
        handleFirstStoryFocusAdd(sendResponse, (attempt || 0) + 1);
        return;
      }
      sendResponse({ ok: false, error: "trace_control_not_found" });
      return;
    }

    focusFirstStoryTraceControl(handle);
    var state = handle.getAttribute("data-trace-story-handle-state");
    if (state === "status") {
      sendResponse({ ok: true, state: "already_saved" });
      return;
    }
    if (state === "adding") {
      if ((attempt || 0) < FIRST_STORY_FOCUS_MAX_ATTEMPTS) {
        handleFirstStoryFocusAdd(sendResponse, (attempt || 0) + 1);
        return;
      }
      // The first-story activation owns this save attempt. If ambient
      // auto-track stays pending too long, issue an explicit quick-add; the
      // server endpoint is idempotent and this avoids a dead onboarding state.
    }
    if (state !== "adding" && !firstStoryStateAllowsQuickAddRetry(state)) {
      sendResponse({
        ok: false,
        error: firstStoryControlErrorForState(state),
      });
      return;
    }

    var finished = false;
    var timeout = setTimeout(function () {
      if (finished) return;
      finished = true;
      sendResponse({ ok: false, error: "save_failed" });
    }, FIRST_STORY_SAVE_TIMEOUT_MS);
    sendQuickAddAction(handle, workKey, TRACE_THEMES.add, true, function (result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (result && result.ok) {
        focusFirstStoryTraceControl(handle);
        sendResponse({ ok: true, state: result.state || "saved" });
        return;
      }
      sendResponse({
        ok: false,
        error: (result && result.error) || "save_failed",
      });
    });
  }, FIRST_STORY_FOCUS_RETRY_MS);
}

function bindQuickAddAction(btn, workKey, addTheme, compact) {
  btn.addEventListener("mouseenter", function () {
    if (!btn.disabled) btn.style.background = addTheme.hover;
  });
  btn.addEventListener("mouseleave", function () {
    if (!btn.disabled) btn.style.background = addTheme.bg;
  });

  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    sendQuickAddAction(btn, workKey, addTheme, compact);
  });
}

function resetStoryHiddenPreferenceBtn(btn, hidden) {
  clearElement(btn);
  btn.className = "x-pbtn x-pbtn-ghost";
  btn.style.cssText = storySheetGhostButtonCss() + ";flex:0 0 auto";
  btn.title = hidden
    ? "Show this work in Trace browsing overlays"
    : "Hide this work in Trace browsing overlays";
  if (hidden) {
    btn.textContent = "Unhide";
  } else {
    btn.setAttribute("aria-label", "Hide this work");
    btn.appendChild(storySheetSvgIcon("eyeoff"));
    btn.appendChild(document.createTextNode("Hide"));
  }
  btn.disabled = false;
  btn.setAttribute("data-trace-hidden-action", hidden ? "undo" : "hide");
  btn.removeAttribute("data-trace-connect-action");
  btn.removeAttribute("data-trace-connect-error");
  btn.removeAttribute("data-trace-connect-checking");
}

function updateOptimisticStoryHiddenPreference(workKey, entry, hidden) {
  var next = snapshotStoryEntry(entry);
  next.hidden = hidden === true;
  next.browsePreference = { hidden: hidden === true };
  next.status = entry && typeof entry.status === "string" ? entry.status : next.status;
  next.readerStatus = entry && typeof entry.readerStatus === "string" ? entry.readerStatus : next.readerStatus;
  if (entry && entry.entryId) next.entryId = entry.entryId;
  if (entry && entry.privateContext) next.privateContext = entry.privateContext;
  if (entry && entry.workMark) next.workMark = entry.workMark;
  optimisticStoryPageEntries[workKey] = next;
}

function bindStoryHiddenPreferenceAction(btn, workKey, entry) {
  var hidden = entry && entry.hidden === true;
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (btn.getAttribute("data-trace-connect-action") === "1") {
      setStoryHiddenPreferenceCheckingAction(btn);
      openTraceUrlInBrowserTab(storyTraceOpenUrl(null, entry));
      setTimeout(function () {
        if (btn.getAttribute("data-trace-connect-checking") === "1") {
          setStoryHiddenPreferenceAuthAction(btn, btn.getAttribute("data-trace-connect-error") || "not_authenticated");
        }
      }, 3000);
      return;
    }

    var nextHidden = !hidden;
    btn.style.cssText = storySheetGhostButtonCss() + ";cursor:wait;color:#6e6a5b";
    btn.textContent = "Saving...";
    btn.disabled = true;
    sendCollectorMessage(
      {
        type: "TRACE_SET_HIDDEN_WORK",
        payload: { key: workKey, hidden: nextHidden },
      },
      function (response) {
        if (!response) {
          btn.style.cssText = storySheetGhostButtonCss() + ";cursor:pointer;color:#b54a30";
          btn.textContent = "Error";
          btn.disabled = false;
          setTimeout(function () {
            resetStoryHiddenPreferenceBtn(btn, hidden);
          }, 2500);
          return;
        }
        if (!response.ok) {
          if (response.error === "auth_expired" || response.error === "not_authenticated") {
            setStoryHiddenPreferenceAuthAction(btn, response.error);
            return;
          }
          btn.style.cssText = storySheetGhostButtonCss() + ";cursor:pointer;color:#b54a30";
          btn.textContent = response.error === "rate_limited" ? "Wait" : "Error";
          btn.disabled = false;
          setTimeout(function () {
            resetStoryHiddenPreferenceBtn(btn, hidden);
          }, 2500);
          return;
        }
        updateOptimisticStoryHiddenPreference(workKey, entry, nextHidden);
        renderQuickAddButton(workKey);
      },
    );
  });
}

function setStoryHiddenPreferenceAuthAction(btn, error) {
  var expired = error === "auth_expired";
  btn.style.cssText = storySheetGhostButtonCss() + ";cursor:pointer;color:#b54a30";
  btn.textContent = expired ? "Sign in" : "Connect";
  btn.title = expired ? "Open Trace to sign in again" : "Open Trace to connect the extension";
  btn.setAttribute("data-trace-connect-action", "1");
  btn.setAttribute("data-trace-connect-error", error || "not_authenticated");
  btn.removeAttribute("data-trace-connect-checking");
  btn.disabled = false;
}

function setStoryHiddenPreferenceCheckingAction(btn) {
  btn.style.cssText = storySheetGhostButtonCss() + ";cursor:wait;color:#6e6a5b";
  btn.textContent = "Checking";
  btn.title = "Checking Trace connection";
  btn.setAttribute("data-trace-connect-checking", "1");
  btn.disabled = true;
}

function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderStorySheet(sheet, view, workKey) {
  var wasOpen = sheet.getAttribute("data-trace-open") === "1";
  var placement = sheet.getAttribute("data-trace-story-sheet-placement");
  var item = storySheetCurrentItem();
  sheet.className = "x x-sheet" + (placement === "bottom" ? " is-bottom" : "");
  clearElement(sheet);

  if (placement === "bottom") {
    var grab = createStoryBottomSheetGrabber();
    sheet.appendChild(grab);
    bindStoryBottomSheetDragClose(sheet, grab);
  }

  var header = document.createElement("div");
  header.className = "x-sheet-head";
  header.setAttribute("data-trace-management-header", "1");
  header.style.cssText = [
    "display:grid",
    "grid-template-columns:1fr auto",
    "gap:10px",
    "align-items:start",
    "padding:16px 16px 13px",
    "border-bottom:1px solid rgba(28,39,34,0.10)",
  ].join(";");
  var headText = document.createElement("div");
  headText.style.cssText = "min-width:0";
  var source = document.createElement("div");
  source.className = "src";
  source.textContent = storySheetSourceLine();
  source.style.cssText = "font:500 9px/1 'Geist Mono',ui-monospace,monospace;letter-spacing:0.14em;text-transform:uppercase;color:#b54a30";
  var title = document.createElement("div");
  title.className = "ti";
  title.textContent = (item && item.t) || storyHeadline(view);
  title.style.cssText = "margin-top:3px;font:500 17px/1.2 " + storySheetSerifFont() + ";letter-spacing:0;color:#1c2722;overflow:hidden;text-overflow:ellipsis";
  var author = document.createElement("div");
  author.className = "au";
  author.textContent = storySheetAuthorLine(item);
  author.style.cssText = "margin-top:2px;font:500 12px/1.3 " + TRACE_UI.font + ";color:#6e6a5b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  headText.appendChild(source);
  headText.appendChild(title);
  if (author.textContent) headText.appendChild(author);
  var close = document.createElement("button");
  close.setAttribute(TRACE_STORY_SHEET_CLOSE_ATTR, "1");
  close.setAttribute("aria-label", "Close Trace sheet");
  close.className = "x-close";
  close.type = "button";
  close.textContent = "\u00d7";
  close.style.cssText = "width:26px;height:26px;border-radius:7px;border:1px solid rgba(28,39,34,0.10);background:#ebe6d7;color:#6e6a5b;font:600 16px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer";
  close.addEventListener("click", function () {
    applySheetVisibility(sheet, false);
  });
  header.appendChild(headText);
  header.appendChild(close);
  sheet.appendChild(header);

  var status = entryStatus(view.entry);
  var progress = progressDisplay(view.entry);
  if (!view.hasAuth) {
    var connect = document.createElement("div");
    connect.className = "x-sheet-connect";
    connect.style.cssText = "padding:18px 16px;display:flex;flex-direction:column;gap:10px";
    var connectTitle = document.createElement("h4");
    connectTitle.textContent = storyHeadline(view);
    connectTitle.style.cssText = "margin:0;font:500 18px/1.2 " + storySheetSerifFont() + ";color:#1c2722";
    var connectCopy = document.createElement("p");
    connectCopy.textContent = storyCaption(view);
    connectCopy.style.cssText = "margin:0 0 4px;font:500 12.5px/1.5 " + TRACE_UI.font + ";color:#6e6a5b";
    var connectOpen = document.createElement("a");
    connectOpen.className = "x-pbtn x-pbtn-primary";
    connectOpen.setAttribute("data-trace-open-trace", "1");
    connectOpen.href = storyTraceOpenUrl(view.authState, view.entry);
    connectOpen.target = "_blank";
    connectOpen.rel = "noopener noreferrer";
    connectOpen.textContent = "Open Trace";
    connectOpen.style.cssText = storySheetPrimaryButtonCss();
    bindTraceOpenLink(connectOpen);
    connect.appendChild(connectTitle);
    connect.appendChild(connectCopy);
    connect.appendChild(connectOpen);
    sheet.appendChild(connect);
    applySheetVisibility(sheet, wasOpen);
    return;
  }

  var body = document.createElement("div");
  body.className = "x-sheet-body";
  body.style.cssText = "padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px";
  if (view.entry && view.entry.__traceAutoTrackError === "free_limit_reached") {
    var capacityTitle = document.createElement("h4");
    capacityTitle.textContent = "This story wasn’t added";
    capacityTitle.style.cssText = "margin:0;font:500 19px/1.2 " + storySheetSerifFont() + ";color:#1c2722";
    var capacityCopy = document.createElement("p");
    capacityCopy.textContent = "Your Trace library is full. Make room or get Trace Unlimited to keep adding stories.";
    capacityCopy.style.cssText = "margin:0;font:500 12.5px/1.5 " + TRACE_UI.font + ";color:#6e6a5b";
    body.appendChild(capacityTitle);
    body.appendChild(capacityCopy);
    sheet.appendChild(body);

    var capacityActions = document.createElement("div");
    capacityActions.className = "x-sheet-foot";
    capacityActions.style.cssText = "display:flex;gap:8px;padding:0 16px 16px";
    var capacityUpgrade = document.createElement("a");
    capacityUpgrade.className = "x-pbtn x-pbtn-primary";
    capacityUpgrade.setAttribute("data-trace-open-trace", "1");
    capacityUpgrade.href = TRACE_WEB_UPGRADE_URL;
    capacityUpgrade.target = "_blank";
    capacityUpgrade.rel = "noopener noreferrer";
    capacityUpgrade.textContent = "Get Trace Unlimited";
    capacityUpgrade.style.cssText = storySheetPrimaryButtonCss() + ";flex:1";
    bindTraceOpenLink(capacityUpgrade);
    capacityActions.appendChild(capacityUpgrade);
    var capacityManage = document.createElement("a");
    capacityManage.className = "x-pbtn";
    capacityManage.setAttribute("data-trace-open-trace", "1");
    capacityManage.href = TRACE_WEB_HOME_URL;
    capacityManage.target = "_blank";
    capacityManage.rel = "noopener noreferrer";
    capacityManage.textContent = "Manage library";
    capacityManage.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 12px;border:1px solid rgba(28,39,34,.22);border-radius:9px;color:#1c2722;text-decoration:none;font:650 12px/1 " + TRACE_UI.font + ";flex:1";
    bindTraceOpenLink(capacityManage);
    capacityActions.appendChild(capacityManage);
    sheet.appendChild(capacityActions);
    applySheetVisibility(sheet, wasOpen);
    return;
  }
  appendReaderStatusChoices(body, view, workKey);
  if (view.entry && (view.entry.__traceStatusPending || view.entry.__traceStatusError || view.entry.__traceAutoTrackError)) {
    var notice = document.createElement("div");
    notice.style.cssText = "border-top:1px solid rgba(28,39,34,0.10);padding-top:12px";
    var noticeLabel = document.createElement("div");
    noticeLabel.textContent = storyHeadline(view);
    noticeLabel.style.cssText = "font:600 12.5px/1.3 " + TRACE_UI.font + ";color:" + (view.entry.__traceStatusError || view.entry.__traceAutoTrackError ? "#b54a30" : "#3a4339");
    var noticeCopy = document.createElement("div");
    noticeCopy.textContent = storyCaption(view);
    noticeCopy.style.cssText = "margin-top:3px;font:500 12px/1.4 " + TRACE_UI.font + ";color:#6e6a5b";
    notice.appendChild(noticeLabel);
    notice.appendChild(noticeCopy);
    body.appendChild(notice);
  }

  var position = document.createElement("section");
  position.className = "x-pos";
  position.setAttribute("data-trace-story-position", "1");
  position.style.cssText = "background:#f1d8c8;border:1px solid rgba(181,74,48,0.24);border-radius:12px;padding:13px 14px";
  var chapters = displayChaptersForStatus(status, view.entry && view.entry.chapters);
  var positionPercent = null;
  if (
    chapters &&
    typeof chapters.current === "number" &&
    typeof chapters.total === "number" &&
    chapters.total > 0
  ) {
    positionPercent = Math.max(0, Math.min(100, Math.round((chapters.current / chapters.total) * 100)));
  }
  var positionTop = document.createElement("div");
  positionTop.className = "top";
  positionTop.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:10px";
  var positionValue = document.createElement("span");
  positionValue.className = "chap";
  positionValue.style.cssText = "font:500 22px/1 " + storySheetSerifFont() + ";letter-spacing:0;color:#1c2722";
  var positionSmall = document.createElement("span");
  positionSmall.className = "sm";
  positionSmall.style.cssText = "font-size:15px;color:#9a9583";
  var positionStatus = document.createElement("span");
  positionStatus.className = "pct";
  positionStatus.style.cssText = "font:500 10.5px/1.2 'Geist Mono',ui-monospace,monospace;color:#6e6a5b;text-align:right";
  if (chapters && typeof chapters.current === "number") {
    var positionBig = document.createElement("span");
    positionBig.className = "big";
    positionBig.textContent = "Ch " + chapters.current;
    positionValue.appendChild(positionBig);
    positionValue.appendChild(document.createTextNode(" "));
    positionSmall.textContent = "/ " + (chapters.total == null ? "?" : chapters.total);
    positionValue.appendChild(positionSmall);
  } else {
    positionValue.textContent = progress || "Not started";
  }
  positionStatus.textContent = positionPercent == null ? "" : positionPercent + "%";
  positionTop.appendChild(positionValue);
  if (positionStatus.textContent) positionTop.appendChild(positionStatus);
  position.appendChild(positionTop);
  if (positionPercent != null) {
    var bar = document.createElement("div");
    bar.className = "bar";
    bar.style.cssText = "height:5px;border-radius:999px;background:rgba(28,39,34,0.12);overflow:hidden;margin:10px 0 0";
    var fill = document.createElement("i");
    fill.setAttribute("aria-hidden", "true");
    fill.style.cssText = "display:block;height:100%;border-radius:999px;background:#b54a30;width:" + positionPercent + "%";
    bar.appendChild(fill);
    position.appendChild(bar);
  }
  body.appendChild(position);
  appendStoryCatchupAction(body, view, workKey);
  appendStoryRatingControls(body, view, workKey);

  var meta = document.createElement("div");
  meta.className = "x-meta";
  meta.style.cssText = "display:flex;flex-direction:column;gap:12px";
  var privateContext = view.entry && view.entry.privateContext;
  if (privateContext && privateContext.hasNotes) {
    meta.appendChild(storySheetMetaRow(
      "note",
      storySheetNoteText(privateContext.notePreview || "Private note saved \u00b7 edit in Trace"),
    ));
  }
  if (privateContext && privateContext.tagCount) {
    var tags = document.createElement("span");
    tags.style.cssText = "display:flex;flex:1;min-width:0;flex-wrap:wrap;gap:8px;text-align:left";
    if (privateContext.tags && privateContext.tags.length) {
      var visibleTags = visiblePrivateTags(privateContext);
      visibleTags.forEach(function (tag) {
        tags.appendChild(storySheetTagPill(tag, false));
      });
      if (privateContext.tagCount > visibleTags.length) {
        tags.appendChild(storySheetTagPill("+" + (privateContext.tagCount - visibleTags.length), false));
      }
    } else {
      tags.appendChild(storySheetTagPill(
        privateContext.tagCount === 1 ? "1 private tag" : privateContext.tagCount + " private tags",
        false,
      ));
    }
    meta.appendChild(storySheetMetaRow("tag", tags));
  }
  if (view.entry && view.entry.hidden) {
    meta.appendChild(storySheetMetaRow("eyeoff", storySheetNoteText("Hidden from future listings")));
  }
  if (meta.childNodes.length > 0) body.appendChild(meta);
  sheet.appendChild(body);

  var actions = document.createElement("div");
  actions.className = "x-sheet-foot";
  actions.style.cssText = "display:flex;gap:8px;padding:0 16px 16px";
  var open = document.createElement("a");
  open.className = "x-pbtn x-pbtn-primary";
  open.setAttribute("data-trace-open-trace", "1");
  open.href = storyTraceOpenUrl(view.authState, view.entry);
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.appendChild(storySheetSvgIcon("open"));
  open.appendChild(document.createTextNode("Open in Trace"));
  open.style.cssText = storySheetPrimaryButtonCss() + ";flex:1";
  bindTraceOpenLink(open);
  actions.appendChild(open);

  if (view.hasAuth && !status && !(view.entry && view.entry.hidden)) {
    var addBtn = document.createElement("button");
    addBtn.className = "x-pbtn x-pbtn-ghost";
    addBtn.setAttribute(QUICK_ADD_ATTR, workKey);
    addBtn.type = "button";
    addBtn.textContent = "Add";
    addBtn.title = "Add this story to your Trace library";
    addBtn.style.cssText = storySheetGhostButtonCss() + ";flex:0 0 auto";
    addBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (addBtn.disabled) return;
      sendQuickAddAction(addBtn, workKey, TRACE_THEMES.add, false);
    });
    actions.appendChild(addBtn);
  }
  if (view.canMutate) {
    var hiddenBtn = document.createElement("button");
    hiddenBtn.type = "button";
    resetStoryHiddenPreferenceBtn(hiddenBtn, view.entry && view.entry.hidden === true);
    bindStoryHiddenPreferenceAction(hiddenBtn, workKey, view.entry || {});
    actions.appendChild(hiddenBtn);
  }
  sheet.appendChild(actions);

  applySheetVisibility(sheet, wasOpen);
}


function finishQualifyAo3BodyElement() {
  var articles = qsa(
    document,
    [
      "#chapters .userstuff.module[role='article']",
      "#chapters .userstuff[role='article']",
      "#chapters [role='article'].userstuff",
    ].join(",")
  );
  if (articles.length) return articles[articles.length - 1];
  return one(document, "#chapters") || one(document, ".chapter[id^='chapter-']") || one(document, ".chapter");
}

function finishQualifyAo3AnchorElement() {
  var endNotes = qsa(
    document,
    [
      "#work_endnotes",
      ".afterword .end.notes.module",
      "#chapters .end.notes.module",
    ].join(",")
  );
  if (endNotes.length) return endNotes[endNotes.length - 1];
  return one(document, "#chapters") || finishQualifyAo3BodyElement();
}

function finishQualifyBodyElement() {
  if (isAO3()) return finishQualifyAo3BodyElement();
  if (isFFN()) {
    return one(document, "#storytextp") || one(document, "#storycontent");
  }
  return null;
}

function finishQualifyAnchorElement() {
  if (isAO3()) return finishQualifyAo3AnchorElement();
  if (isFFNDesktop()) return one(document, "#storytextp") || finishQualifyBodyElement();
  if (isFFNMobile()) {
    var content = one(document, "#storycontent");
    return (content && content.parentElement) || content || finishQualifyBodyElement();
  }
  return null;
}

function finishQualifyPostedChapterCount(item) {
  if (!item) return null;
  var published = Number(item.chPub);
  if (Number.isSafeInteger(published) && published > 0) return published;
  var total = Number(item.cht);
  if (Number.isSafeInteger(total) && total > 0) return total;
  return null;
}

function finishQualifyCurrentChapterCount(item) {
  var current = Number(item && item.chn);
  if (!Number.isSafeInteger(current) || current <= 0) return null;
  return current;
}

function finishQualifyIsLastPostedChapter(item) {
  var current = finishQualifyCurrentChapterCount(item);
  var posted = finishQualifyPostedChapterCount(item);
  return current != null && posted != null && current === posted;
}

function finishQualifySourceWorkState(item) {
  var raw = String((item && (item.s || item.cmp)) || "").trim().toLowerCase();
  if (raw === "complete") return "complete";
  if (raw === "wip") return "wip";
  if (raw === "hiatus" || raw === "on_hiatus" || raw === "paused") return "hiatus";
  return null;
}

function finishQualifySessionKey(workKey, entryId, item) {
  return [
    workKey,
    entryId || "no-entry",
    finishQualifyCurrentChapterCount(item) || "x",
    finishQualifyPostedChapterCount(item) || "x",
  ].join(":");
}

function finishQualifyWasDismissed(key) {
  try {
    var raw = window.sessionStorage && window.sessionStorage.getItem(FINISH_QUALIFY_DISMISS_KEY);
    if (!raw) return false;
    var parsed = JSON.parse(raw);
    return !!(parsed && parsed[key]);
  } catch (_) {
    return false;
  }
}

function finishQualifyRememberDismissed(key) {
  try {
    if (!window.sessionStorage) return;
    var raw = window.sessionStorage.getItem(FINISH_QUALIFY_DISMISS_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    parsed[key] = Date.now();
    window.sessionStorage.setItem(FINISH_QUALIFY_DISMISS_KEY, JSON.stringify(parsed));
  } catch (_) {
    /* ignore */
  }
}

function finishQualifySignalPayload(decision, state, workState) {
  var entryId = decision && decision.entry && decision.entry.entryId;
  var chapter = finishQualifyCurrentChapterCount(decision && decision.item);
  var total = finishQualifyPostedChapterCount(decision && decision.item);
  if (!entryId || chapter == null || total == null) return null;
  var payload = {
    entryId: entryId,
    workKey: decision.workKey,
    source: isAO3() ? "ao3" : "ffn",
    chapter: chapter,
    total: total,
    state: state,
  };
  if (state === "resolved") {
    payload.workStatus = workState;
    payload.resolutionSource = decision.requiresWorkStateChoice ? "reader" : "source";
  }
  return payload;
}

function finishQualifySignalResult(response) {
  var result = null;
  if (
    response &&
    response.command &&
    response.command.kind === "acknowledged" &&
    typeof response.command.state === "string"
  ) {
    result = response.command;
  } else if (response && response.data && typeof response.data.state === "string") {
    result = response.data;
  }
  if (
    !result ||
    (result.state !== "open" && result.state !== "resolved" && result.state !== "ignored")
  ) {
    return null;
  }
  return {
    state: result.state,
    eventId: typeof result.eventId === "string" ? result.eventId : null,
    workKey:
      result.workKey === null
        ? null
        : typeof result.workKey === "string"
          ? result.workKey
          : undefined,
    entry:
      result.entry === null
        ? null
        : result.entry && typeof result.entry === "object"
          ? result.entry
          : undefined,
  };
}

function sendFinishQualifySignal(decision, state, workState, done) {
  var payload = finishQualifySignalPayload(decision, state, workState);
  if (!payload) {
    if (typeof done === "function") done(false, "invalid_request");
    return;
  }
  sendCollectorMessage({
      type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
      payload: payload,
    }, function (response) {
      if (typeof done !== "function") return;
      if (!response || response.ok !== true) {
        done(false, response && response.error);
        return;
      }
      var result = finishQualifySignalResult(response);
      if (!result) {
        done(false, "confirmation_missing");
        return;
      }
      done(true, result);
    },
  );
}

function finishQualifyResultMatchesDecision(decision, result) {
  var entry = result && result.entry;
  var expectedEntryId = decision && decision.entry && decision.entry.entryId;
  if (!expectedEntryId) return false;
  if (
    result &&
    (result.state === "resolved" || result.state === "ignored") &&
    result.workKey === null &&
    result.entry === null
  ) {
    return true;
  }
  if (!entry || typeof entry !== "object") return false;
  if (entry.entryId !== expectedEntryId) return false;
  return !result.workKey || result.workKey === decision.workKey;
}

function refreshFinishQualifyProjection(decision, result) {
  if (!finishQualifyResultMatchesDecision(decision, result)) return false;
  var entry = result.entry;

  if (entry === null && result.workKey === null) {
    // The background owner already removed the exact account/work/entry
    // projection. A terminal replay after server-side deletion is settled; it
    // must not reopen recovery or manufacture a replacement entry in-page.
    renderQuickAddButton(decision.workKey);
    return true;
  }

  if (KERNEL_SESSION_ACTIVE) {
    // The kernel publishes the acknowledged entry into its account-scoped
    // projection before replying. Read that projection instead of creating a
    // second content-script authority for private library state.
    renderQuickAddButton(decision.workKey);
    return true;
  }

  // The explicit legacy rollback still uses the account-scoped storage
  // projection. Never hold the response in a page-global cache; publish it only
  // when the active legacy account still matches the decision that sent it.
  writeConfirmedOverlayEntryForStory(
    decision.workKey,
    clearStoryOverlayTransientState(snapshotStoryEntry(entry)),
    function () {
      if (getWorkKeyFromUrl() === decision.workKey) {
        renderQuickAddButton(decision.workKey);
      }
    },
    decision.accountId || null,
  );
  return true;
}

function sendFinishQualifyResolution(decision, workState, done) {
  if (!decision.entry || !decision.entry.entryId) {
    done(false, "Could not save. Try again.");
    return;
  }
  sendFinishQualifySignal(
    decision,
    "resolved",
    workState,
    function (ok, result) {
      if (!ok || !result || (result.state !== "resolved" && result.state !== "ignored")) {
        done(false, readerStatusChoiceErrorCopy(ok ? "confirmation_missing" : result));
        return;
      }
      if (!finishQualifyResultMatchesDecision(decision, result)) {
        done(false, readerStatusChoiceErrorCopy("confirmation_missing"));
        return;
      }
      done(true, null, result);
    },
  );
}

function finishQualifyDecision(view, workKey) {
  var entry = view && view.entry;
  if (!view || !view.hasAuth || !view.canMutate || !entry || !entry.entryId) return null;
  var status = canonicalReaderStatus(entryStatus(entry));
  var item = storySheetCurrentItem();
  if (!item || item.ctx !== "story" || !finishQualifyIsLastPostedChapter(item)) return null;
  var sourceWorkState = finishQualifySourceWorkState(item);
  if (status === "FINISHED" || status === "DROPPED") return null;
  if (status === "CAUGHT_UP" && sourceWorkState !== "complete") return null;
  var anchorEl = finishQualifyAnchorElement();
  var bodyEl = finishQualifyBodyElement();
  if (!anchorEl || !bodyEl) return null;
  return {
    workKey: workKey,
    entry: entry,
    item: item,
    sourceWorkState: sourceWorkState,
    requiresWorkStateChoice: !sourceWorkState,
    anchorEl: anchorEl,
    bodyEl: bodyEl,
    accountId: view.accountId || null,
    sessionKey: finishQualifySessionKey(workKey, entry.entryId, item),
  };
}

function finishQualifyRemoveBand(workKey) {
  if (finishQualifyBandState[workKey] && typeof finishQualifyBandState[workKey].remove === "function") {
    finishQualifyBandState[workKey].remove();
  }
  finishQualifyBandState[workKey] = null;
}

function finishQualifyClearFlow(workKey, removeBand) {
  var current = finishQualifyWatchState[workKey];
  if (current && typeof current.cleanup === "function") current.cleanup();
  finishQualifyWatchState[workKey] = null;
  if (removeBand !== false) finishQualifyRemoveBand(workKey);
}

function finishQualifySettleFlow(workKey, flowState, removeBand) {
  if (!finishQualifyFlowIsCurrent(workKey, flowState)) return false;
  if (typeof flowState.cleanup === "function") flowState.cleanup();
  flowState.cleanup = null;
  flowState.settled = true;
  if (removeBand !== false) finishQualifyRemoveBand(workKey);
  return true;
}

function finishQualifyFlowIsCurrent(workKey, flowState) {
  return (
    !!flowState &&
    finishQualifyWatchState[workKey] === flowState &&
    getWorkKeyFromUrl() === workKey
  );
}

function finishQualifyStoryDescriptor(decision) {
  return {
    src: storySheetSourceLine(),
    title: decision.item.t,
    chapter: finishQualifyCurrentChapterCount(decision.item),
    total: finishQualifyPostedChapterCount(decision.item),
  };
}

function showFinishQualifyToast(decision, view, result) {
  if (!window.TraceFinishQualify || typeof window.TraceFinishQualify.toast !== "function") return;
  var authoritativeStatus = entryStatus(result && result.entry);
  window.TraceFinishQualify.toast({
    kind: authoritativeStatus === "FINISHED" ? "finished" : "caughtup",
    story: finishQualifyStoryDescriptor(decision),
    onOpenInTrace: function () {
      openTraceUrlInBrowserTab(storyTraceOpenUrl(view.authState, decision.entry));
    },
  });
}

function mountFinishQualifyBand(decision, view, workKey, flowState) {
  if (!finishQualifyFlowIsCurrent(workKey, flowState)) return;
  finishQualifyRemoveBand(workKey);
  finishQualifyBandState[workKey] = window.TraceFinishQualify.mount({
    anchorEl: decision.anchorEl,
    placement: "inline",
    align: isAO3() ? "start" : "center",
    story: finishQualifyStoryDescriptor(decision),
    onQualify: function (workState, controls) {
      if (!finishQualifyFlowIsCurrent(workKey, flowState)) {
        if (controls && typeof controls.fail === "function") {
          controls.fail("This page state changed. Reopen the story to try again.");
        }
        return false;
      }
      sendFinishQualifyResolution(decision, workState, function (ok, message, result) {
        if (!finishQualifyFlowIsCurrent(workKey, flowState)) return;
        if (ok) {
          finishQualifyRememberDismissed(decision.sessionKey);
          if (result && result.state === "resolved" && result.entry && controls && typeof controls.resolve === "function") {
            controls.resolve();
          } else {
            finishQualifyRemoveBand(workKey);
          }
          finishQualifySettleFlow(workKey, flowState, false);
          refreshFinishQualifyProjection(decision, result);
        } else if (controls && typeof controls.fail === "function") {
          controls.fail(message);
        }
      });
      return false;
    },
    onDismiss: function () {
      finishQualifyRememberDismissed(decision.sessionKey);
      finishQualifyClearFlow(workKey, false);
      finishQualifyBandState[workKey] = null;
    },
    onOpenInTrace: function () {
      openTraceUrlInBrowserTab(storyTraceOpenUrl(view.authState, decision.entry));
    },
  });
}

function mountFinishQualifyRecovery(decision, view, workKey, flowState, message) {
  if (
    !finishQualifyFlowIsCurrent(workKey, flowState) ||
    !window.TraceFinishQualify ||
    typeof window.TraceFinishQualify.recovery !== "function"
  ) return;
  finishQualifyRemoveBand(workKey);
  finishQualifyBandState[workKey] = window.TraceFinishQualify.recovery({
    anchorEl: decision.anchorEl,
    align: isAO3() ? "start" : "center",
    story: finishQualifyStoryDescriptor(decision),
    message: message || "Could not update. Retry here or open Trace.",
    onRetry: function (controls) {
      if (!finishQualifyFlowIsCurrent(workKey, flowState)) {
        controls.fail("This page state changed. Reopen the story to try again.");
        return;
      }
      sendFinishQualifyResolution(
        decision,
        decision.sourceWorkState,
        function (ok, nextMessage, result) {
          if (!finishQualifyFlowIsCurrent(workKey, flowState)) return;
          if (!ok || !result) {
            controls.fail(nextMessage || "Could not update. Try again or open Trace.");
            return;
          }
          controls.resolve();
          finishQualifyBandState[workKey] = null;
          finishQualifySettleFlow(workKey, flowState, false);
          refreshFinishQualifyProjection(decision, result);
          if (result.state === "resolved" && result.entry) showFinishQualifyToast(decision, view, result);
        },
      );
    },
    onOpenInTrace: function () {
      openTraceUrlInBrowserTab(storyTraceOpenUrl(view.authState, decision.entry));
    },
  });
}

function setupFinishQualify(view, workKey) {
  var decision = finishQualifyDecision(view, workKey);
  var signature = decision
    ? [
        decision.sessionKey,
        decision.sourceWorkState || "unknown",
        decision.accountId || "account-scoped",
      ].join(":")
    : "";
  if (finishQualifyWatchState[workKey] && finishQualifyWatchState[workKey].signature === signature) return;
  finishQualifyClearFlow(workKey, true);
  if (!decision || finishQualifyWasDismissed(decision.sessionKey)) return;
  if (!window.TraceFinishQualify || typeof window.TraceFinishQualify.onReachEnd !== "function") return;

  // `onReachEnd` checks the current viewport immediately and may invoke its
  // callback before returning. Install the guard first so a successful
  // synchronous finish resolution cannot re-enter render -> setup recursively.
  finishQualifyGeneration += 1;
  var watchState = {
    signature: signature,
    generation: finishQualifyGeneration,
    cleanup: null,
  };
  finishQualifyWatchState[workKey] = watchState;
  var cleanup = window.TraceFinishQualify.onReachEnd(decision.bodyEl, function () {
    if (
      !finishQualifyFlowIsCurrent(workKey, watchState) ||
      finishQualifyWasDismissed(decision.sessionKey)
    ) return;
    if (decision.sourceWorkState) {
      sendFinishQualifyResolution(decision, decision.sourceWorkState, function (ok, message, result) {
        if (!finishQualifyFlowIsCurrent(workKey, watchState)) return;
        if (!ok || !result) {
          mountFinishQualifyRecovery(decision, view, workKey, watchState, message);
          return;
        }
        finishQualifySettleFlow(workKey, watchState, true);
        refreshFinishQualifyProjection(decision, result);
        if (result.state === "resolved" && result.entry) showFinishQualifyToast(decision, view, result);
      });
      return;
    }
    sendFinishQualifySignal(decision, "open", null, function (ok, result) {
      if (!finishQualifyFlowIsCurrent(workKey, watchState)) return;
      if (!ok || !result || result.state === "open") {
        // The open signal is observational. A suspended worker or malformed
        // response must not hide the reader's explicit qualification control.
        mountFinishQualifyBand(decision, view, workKey, watchState);
        return;
      }
      if (result.state !== "open" && refreshFinishQualifyProjection(decision, result)) {
        finishQualifySettleFlow(workKey, watchState, true);
        return;
      }
      // An unexpected acknowledgement is treated like an unavailable open
      // signal: keep manual resolution possible without inventing local state.
      mountFinishQualifyBand(decision, view, workKey, watchState);
    });
  });
  if (finishQualifyWatchState[workKey] === watchState) {
    watchState.cleanup = cleanup;
  } else if (typeof cleanup === "function") {
    // The synchronous callback may have resolved the entry and cleared this
    // watcher during its nested render. Do not restore the obsolete watcher.
    cleanup();
  }
}

function renderQuickAddFromSnapshot(workKey, anchor, res) {
    var cache = KERNEL_SESSION_ACTIVE
      ? res[OVERLAY_CACHE_KEY]
      : overlayCacheForRuntimeContext(res[OVERLAY_CACHE_KEY], res);
    var entries = cache && cache.entries;
    var workPreferences = cache && cache.workPreferences;
    var entry = entries && entries[workKey];
    var preference = workPreferences && workPreferences[workKey];
    var optimisticEntry = optimisticStoryPageEntries[workKey];
    var els = ensureQuickAddElements(workKey, anchor);
    var handle = els.handle;
    var sheet = els.sheet;
    var authState = res.traceAuthState || { state: res.authToken ? "connected" : "signed_out" };
    var accountId = normalizeStorageString(
      res[TRACE_ACCOUNT_ID_KEY] ||
      (cache && cache.accountId) ||
      (authState && authState.accountId),
    );
    var info = normalizeOverlayEntry(entry, preference);

    if (entry || optimisticEntry) {
      if (!entry && optimisticEntry) {
        info = optimisticEntry;
      } else if (info && optimisticEntry) {
        var optimisticEntryForMerge = optimisticEntry;
        if (
          optimisticStoryEntryHasLibraryState(info) &&
          optimisticEntry.__traceAutoTrackPending
        ) {
          // Keep a spinner only when the page has genuinely observed progress
          // beyond the confirmed entry. A confirmed Saved entry represents
          // chapter one even when the compact cache omits chapter metadata.
          var projectedChapter = storyEntryChapterCurrent(info);
          var observedChapter = storyEntryChapterCurrent({
            chapters:
              optimisticEntry.__traceObservedChapters || optimisticEntry.chapters,
          });
          if (projectedChapter == null && entryStatus(info) === "SAVED") {
            projectedChapter = 1;
          }
          if (
            observedChapter == null ||
            (projectedChapter != null && projectedChapter >= observedChapter)
          ) {
            optimisticEntryForMerge = Object.assign({}, optimisticEntry);
            delete optimisticEntryForMerge.__traceAutoTrackPending;
            delete optimisticEntryForMerge.__traceObservedChapters;
          }
        }
        info = mergeStoryOverlayEntries(
          info,
          optimisticEntryForMerge,
          cache && cache.syncVersion,
        );
      }
    }

    var view = {
      hasAuth: authStateAllowsActions(authState, !!res.authToken),
      authState: authState,
      entry: info,
      canMutate: true,
      accountId: accountId,
    };
    var hasEntryAuthError = !!(
      info &&
      (info.__traceAutoTrackError === "auth_expired" ||
        info.__traceAutoTrackError === "not_authenticated")
    );
    storyAuthRecoveryNeeded = !view.hasAuth || hasEntryAuthError;

    if (KERNEL_SESSION_ACTIVE && kernelFirstStoryLookupPending) {
      applyStoryInlineHandleState(handle, {
        kind: "checking",
        label: "Checking…",
        theme: TRACE_INLINE_THEMES.saving,
        dot: false,
        spinner: true,
        status: null,
        progress: null,
      });
      handle.title = "Checking this story in Trace";
      handle.disabled = true;
      applySheetVisibility(sheet, false);
      return;
    }

    if (
      KERNEL_SESSION_ACTIVE &&
      kernelPendingFirstStory &&
      kernelPendingFirstStory.workKey === workKey
    ) {
      var pendingFirstStory = kernelPendingFirstStory;
      applyKernelConnectAndSavePresentation(
        handle,
        pendingFirstStory.commandInFlight ? "Connecting…" : "Connect and save",
        pendingFirstStory.commandInFlight
          ? "connecting-and-saving"
          : "connect-and-save",
        pendingFirstStory.commandInFlight,
      );
      handle.title = pendingFirstStory.commandInFlight
        ? "Trace is connecting and saving this story."
        : "Connect this extension session before saving the pending story.";
      if (!handle.__traceStoryHandleBound) {
        handle.__traceStoryHandleBound = true;
        handle.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (handle.disabled) return;
          if (typeof handle.__traceStoryHandleAction === "function") {
            handle.__traceStoryHandleAction();
          }
        });
      }
      handle.__traceStoryHandleAction = function () {
        runKernelConnectAndSave(handle, workKey);
      };
      applySheetVisibility(sheet, false);
      if (
        !pendingFirstStory.automaticAttempted &&
        typeof pendingFirstStory.handoffId === "string" &&
        pendingFirstStory.handoffId.length > 0
      ) {
        pendingFirstStory.automaticAttempted = true;
        focusFirstStoryTraceControl(handle);
        setTimeout(function () {
          if (
            kernelPendingFirstStory === pendingFirstStory &&
            !pendingFirstStory.commandInFlight
          ) {
            runKernelConnectAndSave(handle, workKey);
          }
        }, 0);
      }
      return;
    }

    applyStoryInlineHandleState(handle, storyHandlePresentation(view));
    handle.title = "Open Trace story sheet";
    handle.disabled = autoTrackHandleDisabled(info);
    if (!handle.__traceStoryHandleBound) {
      handle.__traceStoryHandleBound = true;
      handle.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (handle.disabled) return;
        if (typeof handle.__traceStoryHandleAction === "function") {
          handle.__traceStoryHandleAction();
        }
      });
    }
    handle.__traceStoryHandleAction = function () {
      if (info && info.__traceAutoTrackPending) return;
      if (info && info.__traceAutoTrackError === "free_limit_reached") {
        applySheetVisibility(sheet, sheet.getAttribute("data-trace-open") !== "1");
        return;
      }
      if (
        view.hasAuth &&
        !hasEntryAuthError &&
        !entryStatus(info) &&
        !(info && info.hidden)
      ) {
        applySheetVisibility(sheet, false);
        sendQuickAddAction(handle, workKey, TRACE_THEMES.add, true);
        return;
      }
      applySheetVisibility(sheet, sheet.getAttribute("data-trace-open") !== "1");
    };

    renderStorySheet(sheet, view, workKey);
    setupFinishQualify(view, workKey);
}

function clearKernelProjectionRetry(workKey) {
  if (
    kernelProjectionRetryTimer === null ||
    (kernelProjectionRetryWorkKey !== null &&
      kernelProjectionRetryWorkKey !== workKey)
  ) {
    return;
  }
  clearTimeout(kernelProjectionRetryTimer);
  kernelProjectionRetryTimer = null;
  kernelProjectionRetryWorkKey = null;
}

function scheduleKernelProjectionRetry(workKey, attempt) {
  if (
    attempt >= KERNEL_PROJECTION_RETRY_DELAYS_MS.length ||
    kernelProjectionRetryTimer !== null ||
    getWorkKeyFromUrl() !== workKey
  ) {
    return;
  }
  kernelProjectionRetryWorkKey = workKey;
  kernelProjectionRetryTimer = setTimeout(function () {
    kernelProjectionRetryTimer = null;
    kernelProjectionRetryWorkKey = null;
    if (getWorkKeyFromUrl() === workKey) {
      renderQuickAddButton(workKey, attempt + 1);
    }
  }, KERNEL_PROJECTION_RETRY_DELAYS_MS[attempt]);
}

function renderQuickAddButton(workKey, projectionAttempt) {
  var anchor = findQuickAddAnchor();
  if (!anchor) {
    clearKernelProjectionRetry(workKey);
    removeQuickAddElements();
    return;
  }

  if (KERNEL_SESSION_ACTIVE && kernelFirstStoryLookupPending) {
    renderQuickAddFromSnapshot(workKey, anchor, {
      libraryOverlayCache: {
        entries: {},
        workPreferences: {},
        syncVersion: null,
      },
      traceAuthState: {
        state: "signed_out",
        reason: "credential_missing",
        canExecuteAuthenticated: false,
      },
      authToken: null,
    });
    return;
  }

  if (KERNEL_SESSION_ACTIVE) {
    var attempt = Number.isInteger(projectionAttempt) && projectionAttempt >= 0
      ? projectionAttempt
      : 0;
    sendCollectorMessage(
      { type: ACCOUNT_PROJECTION_GET_MESSAGE, workKeys: [workKey] },
      function (response) {
        if (!response || response.ok !== true) {
          scheduleKernelProjectionRetry(workKey, attempt);
          return;
        }
        clearKernelProjectionRetry(workKey);
        var snapshot = response.snapshot || { state: "signed_out" };
        showCapacityRecoveryNotice(
          response.projection && response.projection.capacity,
          false,
        );
        renderQuickAddFromSnapshot(workKey, anchor, {
          libraryOverlayCache: response.projection || {
            entries: {},
            workPreferences: {},
            syncVersion: null,
          },
          traceAuthState: snapshot,
          authToken: snapshot.state === "connected" ? "kernel-session" : null,
        });
      },
    );
    return;
  }

  ext.storage.local.get(
    [
      OVERLAY_CACHE_KEY,
      "authToken",
      "traceAuthState",
      TRACE_ACCOUNT_ID_KEY,
      TRACE_API_BASE_STORAGE_KEY,
    ],
    function (res) {
      if (ext.runtime.lastError) return;
      renderQuickAddFromSnapshot(workKey, anchor, res);
    },
  );
}

function initQuickAdd() {
  if (shouldDisableTraceContentScript()) return;
  var workKey = getWorkKeyFromUrl();
  if (!workKey) return;
  if (storyQuickAddUiReady) {
    renderQuickAddButton(workKey);
    return;
  }
  reserveQuickAddSlot(workKey);
  storyQuickAddUiReady = true;
  queryBackgroundWorkStateForStory(workKey);
  renderQuickAddButton(workKey);
  processIosPendingFirstStoryAdd();

  try {
    ext.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (
        !changes[OVERLAY_CACHE_KEY] &&
        !changes[WORK_STATE_STORAGE_KEY] &&
        !changes[ACCOUNT_PROJECTION_REVISION_KEY] &&
        !changes.authToken &&
        !changes.traceAuthState &&
        !changes[TRACE_ACCOUNT_ID_KEY] &&
        !changes[TRACE_API_BASE_STORAGE_KEY]
      ) return;
      if (changes[WORK_STATE_STORAGE_KEY]) {
        queryBackgroundWorkStateForStory(workKey);
      }
      renderQuickAddButton(workKey);
    });
  } catch (_) {
    /* ignore */
  }

  try {
    window.addEventListener("focus", function () {
      requestStoryAuthRefreshOnResume(workKey);
      queryBackgroundWorkStateForStory(workKey);
      renderQuickAddButton(workKey);
    });
    window.addEventListener("pageshow", function () {
      requestStoryAuthRefreshOnResume(workKey);
      queryBackgroundWorkStateForStory(workKey);
      renderQuickAddButton(workKey);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        requestStoryAuthRefreshOnResume(workKey);
        queryBackgroundWorkStateForStory(workKey);
        renderQuickAddButton(workKey);
      }
    });
  } catch (_) {
    /* ignore */
  }
}

if (!TRACE_ACTIVE_TAB_PROBE_MODE && !shouldDisableTraceContentScript()) {
  // The content script runs at document_end, so the story header is normally
  // available before DOMContentLoaded. Reserve the Trace row immediately to
  // avoid shifting the archive content when storage hydration completes.
  if (document.readyState === "loading") {
    var initialQuickAddWorkKey = getWorkKeyFromUrl();
    if (initialQuickAddWorkKey) reserveQuickAddSlot(initialQuickAddWorkKey);
    document.addEventListener("DOMContentLoaded", initQuickAdd);
  } else {
    initQuickAdd();
  }
}

// Immediate "content script is running" ping. The iOS app uses it to verify
// Safari's site permission, so it must not wait on DOM readiness, prefs, or
// any network work.
function announceArchivePageToBackground(handoffId) {
  var message = { type: "TRACE_ARCHIVE_SEEN" };
  if (
    typeof handoffId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(handoffId)
  ) {
    message.handoffId = handoffId;
  }
  sendCollectorMessageBestEffort(message);
}

if (!TRACE_ACTIVE_TAB_PROBE_MODE && !shouldDisableTraceContentScript()) {
  announceArchivePageToBackground();
}
