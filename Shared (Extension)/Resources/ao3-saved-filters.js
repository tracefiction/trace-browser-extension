// ao3-saved-filters.js - local AO3 saved filter presets.
// Stores AO3 filter query params in extension-local storage and applies them by URL navigation.
(function () {
  "use strict";
  if (globalThis.__traceSavedFiltersInitialized) return;
  globalThis.__traceSavedFiltersInitialized = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "traceAo3SavedFiltersV1";
  const ACTIVE_KEY = "traceAo3SavedFiltersActiveV1";
  const DELETED_KEY = "traceAo3SavedFiltersDeletedV1";
  const SYNC_META_KEY = "traceAo3SavedFiltersSyncV1";
  // A filter page asks for a pull when this device hasn't had one this long,
  // the same period as the background's alarm, which Safari may not wake for.
  const SYNC_STALE_MS = 30 * 60 * 1000;
  const PANEL_COLLAPSED_KEY = "traceAo3SavedFiltersPanelCollapsedV1";
  // When each filter was last used, here and on which tag. This device only:
  // it is never synced.
  const LAST_USED_KEY = "traceAo3SavedFiltersLastUsedV1";
  const LAST_USED_CONTEXT_LIMIT = 100;
  const PREF_AO3_SAVED_FILTERS_KEY = "prefAo3SavedFiltersEnabled";
  const SYNC_REQUEST_MESSAGE = "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST";
  const ROOT_ATTR = "data-trace-ao3-saved-filters";
  const STYLE_ID = "trace-ao3-saved-filters-style";
  const PHONE_STYLE_ID = "trace-ao3-saved-filters-phone-style";
  const LINE_ATTR = "data-trace-ao3-saved-filters-line";
  const SHEET_ATTR = "data-trace-ao3-saved-filters-sheet";
  // AO3's own narrow breakpoint: below it, Filters is a 16em column that
  // slides in beside the listing.
  const NARROW_QUERY = "(max-width: 42em)";
  const COLUMN_QUICK_COUNT = 3;
  const TEST_NAVIGATE_KEY = "__traceAo3SavedFiltersNavigate";
  const MAX_NAME_LENGTH = 96;
  const MAX_CONTEXT_LABEL_LENGTH = 120;
  // The stored summary is only a fallback for values the page's form can't
  // label; what a filter keeps is otherwise read from its params at render
  // time and shown in full. These bounds match what the sync service accepts.
  const STORED_SUMMARY_PARTS = 5;
  const STORED_SUMMARY_PART_LENGTH = 64;
  const LIST_PREVIEW_COUNT = 8;
  const SAVED_FILTER_ACTIVE_LIMIT = 250;
  const SAVED_FILTER_LIMIT_WARNING_THRESHOLD = 200;
  const TRACE_EARNED_PERMISSION_GATE_ACTIVE =
    globalThis.TRACE_IOS_EARNED_PERMISSION_ONBOARDING?.registrationMode ===
    "static";
  const IGNORED_QUERY_KEYS = new Set([
    "authenticity_token",
    "commit",
    "page",
    "utf8",
  ]);

  const state = {
    root: null,
    renderTimer: null,
    mode: "list",
    menuId: null,
    renameId: null,
    renameDraft: "",
    confirmDeleteId: null,
    draftName: "",
    draftScope: "context",
    showAll: false,
    panelCollapsed: false,
    retry: null,
    error: "",
    notice: "",
    presets: [],
    activeMeta: null,
    current: null,
    // Phone layout: the column, the Showing line and the sheet.
    narrow: false,
    lastUsed: { byId: {}, byContext: {} },
    line: null,
    sheet: null,
    sheetFrom: null,
    sheetHost: null,
    sheetPanel: null,
    sheetOpener: "",
    editId: null,
    editName: "",
    editScope: "context",
    fromStorage: false,
  };

  function isAo3Host(hostname) {
    var h = String(hostname || "").toLowerCase();
    return (
      h === "archiveofourown.org" ||
      h.endsWith(".archiveofourown.org") ||
      h === "archiveofourown.gay" ||
      h.endsWith(".archiveofourown.gay") ||
      h === "archive.transformativeworks.org" ||
      h === "ao3.org" ||
      h.endsWith(".ao3.org")
    );
  }

  function isCredentialPageUrl() {
    var path = String(location && location.pathname ? location.pathname : "").toLowerCase();
    return /\/users\/(?:login|sign_up|signup|password|auth|logout)(?:\/|$)/.test(path);
  }

  function isKnownHeaderPasswordField(input) {
    var form = input && input.closest ? input.closest("form") : null;
    if (!form) return false;
    var id = String(form.id || "");
    var action = String(form.getAttribute("action") || "");
    return id === "new_user_session_small" && action.indexOf("/users/login") >= 0;
  }

  function pageHasPasswordField() {
    if (isCredentialPageUrl()) return true;
    try {
      var inputs = document.querySelectorAll("input");
      for (var i = 0; i < inputs.length; i++) {
        if (String(inputs[i] && inputs[i].type ? inputs[i].type : "").toLowerCase() === "password") {
          if (isKnownHeaderPasswordField(inputs[i])) continue;
          return true;
        }
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function isFilterParamName(name) {
    var key = String(name || "");
    return (
      key.indexOf("work_search[") === 0 ||
      key.indexOf("include_work_search[") === 0 ||
      key.indexOf("exclude_work_search[") === 0
    );
  }

  function normalizePairsFromSearch(search) {
    var params = new URLSearchParams(search || "");
    var pairs = [];
    params.forEach(function (value, key) {
      var cleanKey = String(key || "").trim();
      var cleanValue = String(value || "").trim();
      if (!cleanKey || !cleanValue) return;
      if (IGNORED_QUERY_KEYS.has(cleanKey)) return;
      if (cleanKey === "tag_id") return;
      if (!isFilterParamName(cleanKey)) return;
      pairs.push([cleanKey, cleanValue]);
    });
    pairs.sort(function (a, b) {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      if (a[1] < b[1]) return -1;
      if (a[1] > b[1]) return 1;
      return 0;
    });
    return pairs;
  }

  function signatureForPairs(pairs) {
    return JSON.stringify((pairs || []).map(function (pair) {
      return [String(pair[0] || ""), String(pair[1] || "")];
    }));
  }

  function samePairSet(left, right) {
    return signatureForPairs(left) === signatureForPairs(right);
  }

  function normalizePath(pathname) {
    var path = String(pathname || "/");
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return path || "/";
  }

  function getPageContextFromUrl(url) {
    var path = normalizePath(url.pathname);
    var tagPathMatch = path.match(/^\/tags\/[^/]+\/works$/);
    if (tagPathMatch) {
      return {
        type: "tagPath",
        key: "tagPath:" + path,
        path: path,
        label: decodeTagPathLabel(path),
      };
    }
    var tagId = String(url.searchParams.get("tag_id") || "").trim();
    if (tagId) {
      return {
        type: "tagId",
        key: "tagId:" + tagId,
        tagId: tagId,
        label: tagId,
      };
    }
    return null;
  }

  function getPageContext() {
    try {
      return getPageContextFromUrl(new URL(location.href));
    } catch (_) {
      return null;
    }
  }

  function decodeTagPathLabel(path) {
    var match = String(path || "").match(/^\/tags\/([^/]+)\/works$/);
    if (!match) return "this tag";
    try {
      return decodeURIComponent(match[1]).replace(/\*/g, " ");
    } catch (_) {
      return match[1].replace(/\*/g, " ");
    }
  }

  // AO3 writes "." "/" "&" "?" "#" in tag URLs as *d* *s* *a* *q* *h*.
  function decodeAo3TagName(value) {
    var map = { d: ".", s: "/", a: "&", q: "?", h: "#" };
    return cleanDisplayText(String(value || "").replace(/\*([dsaqh])\*/g, function (_, code) {
      return map[code];
    }));
  }

  // The tag as a reader would write it, for "{tag} only" and list labels.
  function displayContextLabel() {
    var ctx = getPageContext();
    if (ctx && ctx.type === "tagPath") {
      var match = ctx.path.match(/^\/tags\/([^/]+)\/works$/);
      var raw = match ? match[1] : "";
      try {
        raw = decodeURIComponent(raw);
      } catch (_) {
        /* Keep the encoded name. */
      }
      return decodeAo3TagName(raw) || contextLabel();
    }
    if (ctx && ctx.type === "tagId") return decodeAo3TagName(ctx.tagId) || contextLabel();
    return contextLabel();
  }

  function contextLabel() {
    var ctx = getPageContext();
    if (ctx && ctx.label) return cleanDisplayText(ctx.label);
    var heading = document.querySelector(".works-index .heading, h2.heading, h1.heading, #main h2, #main h1");
    var text = heading ? cleanDisplayText(heading.textContent || "") : "";
    if (text) {
      text = text.replace(/^\s*\d+\s*(?:-|to|\u2013)\s*\d+\s+of\s+[\d,]+\s+Works\s+in\s+/i, "");
      return text || "this page";
    }
    return "this page";
  }

  function currentContextKey() {
    var ctx = getPageContext();
    return ctx ? ctx.key : "global:" + normalizePath(location.pathname);
  }

  function hasReusableContext() {
    return Boolean(getPageContext());
  }

  function isSupportedFilterPath() {
    var path = normalizePath(location.pathname);
    return path === "/works" || path === "/works/search" || /^\/tags\/[^/]+\/works$/.test(path);
  }

  function findFilterForm() {
    if (!isSupportedFilterPath()) return null;
    var byId = document.getElementById("work-filters");
    if (byId && byId.tagName && byId.tagName.toLowerCase() === "form") return byId;
    var forms = document.querySelectorAll("form.filters");
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      if (formHasWorkSearchControls(form)) return form;
    }
    return null;
  }

  function formHasWorkSearchControls(form) {
    if (!form || !form.elements) return false;
    for (var i = 0; i < form.elements.length; i++) {
      if (String(form.elements[i] && form.elements[i].name ? form.elements[i].name : "").indexOf("work_search[") === 0) {
        return true;
      }
    }
    return false;
  }

  function isSupportedFilterPage() {
    return isSupportedFilterPath() && Boolean(findFilterForm());
  }

  function currentPairs() {
    return normalizePairsFromSearch(location.search);
  }

  function getCurrentFilterState() {
    var pairs = currentPairs();
    return {
      pairs: pairs,
      signature: signatureForPairs(pairs),
      hasFilters: pairs.length > 0,
      contextKey: currentContextKey(),
      contextLabel: contextLabel(),
      canSave: isSupportedFilterPage() && pairs.length > 0,
    };
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try {
        ext.storage.local.get(keys, function (res) {
          if (ext.runtime && ext.runtime.lastError) {
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

  function storageSet(patch) {
    return new Promise(function (resolve, reject) {
      try {
        ext.storage.local.set(patch, function () {
          var lastError = ext.runtime && ext.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || "Extension storage failed."));
            return;
          }
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function sanitizePairs(value) {
    if (!Array.isArray(value)) return [];
    var pairs = [];
    for (var i = 0; i < value.length; i++) {
      var pair = value[i];
      if (!Array.isArray(pair) || pair.length < 2) continue;
      var key = String(pair[0] || "").trim();
      var val = String(pair[1] || "").trim();
      if (!key || !val || !isFilterParamName(key)) continue;
      pairs.push([key, val]);
    }
    pairs.sort(function (a, b) {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      if (a[1] < b[1]) return -1;
      if (a[1] > b[1]) return 1;
      return 0;
    });
    return pairs;
  }

  function sanitizePreset(raw) {
    if (!raw || typeof raw !== "object") return null;
    var pairs = sanitizePairs(raw.params);
    if (!pairs.length) return null;
    var id = String(raw.id || "").trim() || makeId();
    var clientId = String(raw.clientId || id).trim().slice(0, 80) || id;
    var serverId = String(raw.serverId || "").trim();
    var name = String(raw.name || "").trim().slice(0, MAX_NAME_LENGTH) || "AO3 filter";
    var scope = raw.scope === "global" ? "global" : "context";
    var contextKey = String(raw.contextKey || "").trim();
    var contextLabel = cleanDisplayText(raw.contextLabel || "").slice(0, MAX_CONTEXT_LABEL_LENGTH);
    var summary = storedSummaryParts(raw.summary);
    var updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString();
    return {
      id: id,
      clientId: clientId,
      serverId: serverId,
      name: name,
      params: pairs,
      scope: scope,
      contextKey: scope === "context" ? contextKey : "",
      contextLabel: scope === "context" ? contextLabel : "",
      summary: summary,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: updatedAt,
      clientUpdatedAt: typeof raw.clientUpdatedAt === "string" ? raw.clientUpdatedAt : updatedAt,
      dirty: raw.dirty === true,
    };
  }

  function sanitizePresets(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seen = new Set();
    for (var i = 0; i < raw.length; i++) {
      var preset = sanitizePreset(raw[i]);
      if (!preset || seen.has(preset.id)) continue;
      seen.add(preset.id);
      out.push(preset);
    }
    return out;
  }

  function sanitizeActiveMeta(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = String(raw.id || "").trim();
    var signature = String(raw.signature || "").trim();
    var contextKey = String(raw.contextKey || "").trim();
    if (!id || !signature || !contextKey) return null;
    return {
      id: id,
      signature: signature,
      contextKey: contextKey,
      appliedAt: typeof raw.appliedAt === "string" ? raw.appliedAt : "",
    };
  }

  function sanitizeDeletedPreset(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = String(raw.id || "").trim();
    var clientId = String(raw.clientId || id).trim().slice(0, 80);
    if (!clientId) return null;
    var clientUpdatedAt = typeof raw.clientUpdatedAt === "string"
      ? raw.clientUpdatedAt
      : new Date().toISOString();
    return {
      id: id || clientId,
      clientId: clientId,
      serverId: String(raw.serverId || "").trim(),
      clientUpdatedAt: clientUpdatedAt,
    };
  }

  function sanitizeDeletedPresets(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seen = new Set();
    for (var i = 0; i < raw.length; i++) {
      var deleted = sanitizeDeletedPreset(raw[i]);
      if (!deleted || seen.has(deleted.clientId)) continue;
      seen.add(deleted.clientId);
      out.push(deleted);
    }
    return out;
  }

  async function readStorageState() {
    var res = await storageGet([STORAGE_KEY, ACTIVE_KEY, PANEL_COLLAPSED_KEY, LAST_USED_KEY]);
    return {
      presets: sanitizePresets(res[STORAGE_KEY]),
      activeMeta: sanitizeActiveMeta(res[ACTIVE_KEY]),
      panelCollapsed: res[PANEL_COLLAPSED_KEY] === true,
      lastUsed: sanitizeLastUsed(res[LAST_USED_KEY]),
    };
  }

  async function readUiEnabled() {
    var res = await storageGet([PREF_AO3_SAVED_FILTERS_KEY]);
    return res[PREF_AO3_SAVED_FILTERS_KEY] !== false;
  }

  function makeId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return "sf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function requestSavedFiltersSync() {
    try {
      if (!ext.runtime || typeof ext.runtime.sendMessage !== "function") return;
      var message = { type: SYNC_REQUEST_MESSAGE };
      if (globalThis.browser) {
        Promise.resolve(ext.runtime.sendMessage(message)).catch(function () {
          /* Best-effort background sync; local save has already succeeded. */
        });
        return;
      }
      ext.runtime.sendMessage(message, function () {
        /* Best-effort background sync; local save has already succeeded. */
      });
    } catch (_) {
      /* ignore */
    }
  }

  async function requestSyncIfStale() {
    if (!isSupportedFilterPage()) return;
    if (!(await readUiEnabled())) return;
    var res = await storageGet([SYNC_META_KEY]);
    var meta = res[SYNC_META_KEY];
    var lastSyncedAt = meta && typeof meta.lastSyncedAt === "string"
      ? Date.parse(meta.lastSyncedAt)
      : NaN;
    var age = Date.now() - lastSyncedAt;
    if (Number.isFinite(age) && age >= 0 && age < SYNC_STALE_MS) return;
    // The pull lands in storage, and the storage listener re-renders the panel.
    requestSavedFiltersSync();
  }

  function cleanDisplayText(text) {
    // AO3 labels end with a work count, "Fluff (12,636)", often followed by
    // markup whitespace; trim first so the count is always dropped.
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+\([\d,]+\)$/, "");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function elementLabel(control) {
    if (!control) return "";
    var form = control.form || findFilterForm();
    var id = String(control.id || "");
    var label = null;
    if (id && form) {
      label = form.querySelector("label[for='" + cssString(id) + "']");
    }
    if (!label && control.closest) label = control.closest("label");
    return cleanDisplayText(label ? label.textContent || "" : "");
  }

  function cssString(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function findControlForPair(form, key, value) {
    if (!form || !form.elements) return null;
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      if (!el || String(el.name || "") !== key) continue;
      if (String(el.value || "") === String(value || "")) return el;
    }
    return null;
  }

  // A select's option text for a value, whatever the select currently shows.
  function selectOptionLabel(form, key, value) {
    if (!form || !form.elements) return "";
    var control = null;
    for (var e = 0; e < form.elements.length; e++) {
      var el = form.elements[e];
      if (el && el.options && String(el.name || "") === key) {
        control = el;
        break;
      }
    }
    if (!control) return "";
    for (var i = 0; i < control.options.length; i++) {
      var option = control.options[i];
      if (String(option.value || "") === String(value || "")) {
        return cleanDisplayText(option.textContent || option.label || "");
      }
    }
    return "";
  }

  // What a filter keeps, grouped in a fixed reading order. Every value is
  // kept; nothing here shortens or drops a part.
  var FILTER_GROUPS = [
    { key: "include", label: "Include" },
    { key: "exclude", label: "Exclude" },
    { key: "rating", label: "Rating" },
    { key: "warnings", label: "Warnings" },
    { key: "category", label: "Category" },
    { key: "status", label: "Status" },
    { key: "crossovers", label: "Crossovers" },
    { key: "words", label: "Words" },
    { key: "updated", label: "Updated" },
    { key: "language", label: "Language" },
    { key: "search", label: "Search" },
    { key: "sort", label: "Sort" },
  ];

  var SORT_LABELS = {
    _score: "Best Match",
    authors_to_sort_on: "Creator",
    title_to_sort_on: "Title",
    created_at: "Date Posted",
    revised_at: "Date Updated",
    word_count: "Word Count",
    hits: "Hits",
    kudos_count: "Kudos",
    comments_count: "Comments",
    bookmarks_count: "Bookmarks",
  };

  function fieldName(key) {
    var match = String(key || "").match(/\[([^\]]+)\]/);
    return match ? match[1] : "";
  }

  function groupForKey(key) {
    var field = fieldName(key);
    if (key.indexOf("exclude_work_search[") === 0 || field === "excluded_tag_names") return "exclude";
    if (field === "rating_ids") return "rating";
    if (field === "archive_warning_ids") return "warnings";
    if (field === "category_ids") return "category";
    if (key.indexOf("include_work_search[") === 0) return "include";
    if (/^(?:other_tag_names|fandom_names|character_names|relationship_names|freeform_names)$/.test(field)) return "include";
    if (field === "complete") return "status";
    if (field === "crossover") return "crossovers";
    if (field === "words_from" || field === "words_to" || field === "word_count") return "words";
    if (field === "date_from" || field === "date_to" || field === "revised_at") return "updated";
    if (field === "language_id") return "language";
    if (field === "query") return "search";
    if (field === "sort_column" || field === "sort_direction") return "sort";
    return "other";
  }

  function otherFieldLabel(field) {
    var text = String(field || "filter").replace(/_ids?$/, "").replace(/_/g, " ").trim() || "filter";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function formatCount(value) {
    var text = String(value || "").trim();
    if (!/^\d+$/.test(text)) return text;
    return Number(text).toLocaleString("en-US");
  }

  function lowerFirst(text) {
    var value = String(text || "");
    return value.charAt(0).toLowerCase() + value.slice(1);
  }

  // Returns the readable values for one pair and whether the page could
  // label it. Tag ids the page's form doesn't list stay unlabelled.
  function valuesForPair(form, key, field, group, value) {
    if (/_ids$/.test(field)) {
      var label = elementLabel(findControlForPair(form, key, value));
      return label ? { values: [label], labelled: true } : { values: [value], labelled: false };
    }
    if (group === "include" || group === "exclude") {
      var names = String(value).split(",").map(cleanDisplayText).filter(Boolean);
      return { values: names.length ? names : [value], labelled: true };
    }
    if (group === "status") {
      if (value === "T") return { values: ["Complete only"], labelled: true };
      if (value === "F") return { values: ["In progress only"], labelled: true };
    }
    if (group === "crossovers") {
      if (value === "F") return { values: ["No crossovers"], labelled: true };
      if (value === "T") return { values: ["Crossovers only"], labelled: true };
    }
    if (field === "language_id") {
      var language = selectOptionLabel(form, key, value);
      return language ? { values: [language], labelled: true } : { values: [value], labelled: false };
    }
    if (field === "sort_column") {
      return { values: [selectOptionLabel(form, key, value) || SORT_LABELS[value] || value.replace(/_/g, " ")], labelled: true };
    }
    if (field === "sort_direction") {
      if (value === "asc") return { values: ["ascending"], labelled: true };
      if (value === "desc") return { values: ["descending"], labelled: true };
    }
    if (group === "other") {
      var control = findControlForPair(form, key, value);
      var type = String(control && control.type ? control.type : "").toLowerCase();
      var controlLabel = type === "checkbox" || type === "radio" ? elementLabel(control) : "";
      return { values: [controlLabel || cleanDisplayText(value)], labelled: true };
    }
    return { values: [cleanDisplayText(value)], labelled: true };
  }

  function wordsText(from, to) {
    if (from && to) return formatCount(from) + "–" + formatCount(to) + " words";
    if (from) return "At least " + formatCount(from) + " words";
    return "Up to " + formatCount(to) + " words";
  }

  function datesText(from, to) {
    if (from && to) return from + " to " + to;
    if (from) return "Since " + from;
    return "Until " + to;
  }

  // { groups: [{ key, label, values }], labelled } for a set of params.
  function describePairs(pairs) {
    var form = findFilterForm();
    var buckets = {};
    var others = [];
    var words = {};
    var dates = {};
    var labelled = true;
    function add(groupKey, label, values, valuesLabelled) {
      if (!buckets[groupKey]) {
        buckets[groupKey] = { key: groupKey.indexOf("other:") === 0 ? "other" : groupKey, label: label, values: [], labelled: true };
        if (groupKey.indexOf("other:") === 0) others.push(buckets[groupKey]);
      }
      if (valuesLabelled === false) buckets[groupKey].labelled = false;
      for (var v = 0; v < values.length; v++) {
        if (values[v] && buckets[groupKey].values.indexOf(values[v]) < 0) buckets[groupKey].values.push(values[v]);
      }
    }
    for (var i = 0; i < (pairs || []).length; i++) {
      var key = String(pairs[i][0] || "");
      var value = String(pairs[i][1] || "");
      var field = fieldName(key);
      var group = groupForKey(key);
      if (field === "words_from" || field === "words_to") {
        words[field] = value;
        continue;
      }
      if (field === "date_from" || field === "date_to") {
        dates[field] = value;
        continue;
      }
      var result = valuesForPair(form, key, field, group, value);
      if (!result.labelled) labelled = false;
      if (group === "other") {
        var bucket = "other:" + field;
        add(bucket, otherFieldLabel(field), result.values, result.labelled);
      } else {
        add(group, "", result.values, result.labelled);
      }
    }
    if (words.words_from || words.words_to) add("words", "", [wordsText(words.words_from, words.words_to)]);
    if (dates.date_from || dates.date_to) add("updated", "", [datesText(dates.date_from, dates.date_to)]);
    var groups = [];
    for (var g = 0; g < FILTER_GROUPS.length; g++) {
      var entry = buckets[FILTER_GROUPS[g].key];
      if (entry && entry.values.length) {
        groups.push({ key: FILTER_GROUPS[g].key, label: FILTER_GROUPS[g].label, values: entry.values, labelled: entry.labelled });
      }
    }
    for (var o = 0; o < others.length; o++) {
      if (others[o].values.length) groups.push(others[o]);
    }
    return { groups: groups, labelled: labelled };
  }

  // The compact row grammar: "Include Fluff, Hurt/Comfort · Complete only".
  function compactPartForGroup(group) {
    var joined = group.values.join(", ");
    if (group.key === "include") return "Include " + joined;
    if (group.key === "exclude") return "Exclude " + joined;
    if (group.key === "updated") return "Updated " + lowerFirst(joined);
    if (group.key === "language") return "In " + joined;
    if (group.key === "search") return "Search: " + joined;
    if (group.key === "sort") return "Sorted by " + joined.toLowerCase();
    if (group.key === "other") return group.label + ": " + joined;
    return joined;
  }

  function summaryForPairs(pairs) {
    return describePairs(pairs).groups.map(compactPartForGroup);
  }

  // Every part the page can name comes from the filter's own values. A part
  // it can't name (a tag id from another fandom, say) takes the matching part
  // of the summary stored at save time; parts past the stored cap are counted
  // as "+N more".
  function presetContentsText(preset) {
    var description = describePairs(preset.params);
    var groups = description.groups;
    var stored = Array.isArray(preset.summary) ? preset.summary : [];
    if (!description.labelled && stored.length) {
      // The stored parts line up with the groups only when they were saved
      // in the same grammar; an older save's summary is shown whole.
      if (stored.length !== Math.min(groups.length, STORED_SUMMARY_PARTS)) return stored.join(" · ");
      var parts = [];
      var dropped = 0;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].labelled) parts.push(compactPartForGroup(groups[i]));
        else if (i < stored.length) parts.push(stored[i]);
        else dropped += 1;
      }
      if (dropped) parts.push("+" + dropped + " more");
      return parts.join(" · ");
    }
    return groups.map(compactPartForGroup).join(" · ") || "AO3 filter";
  }

  function boundedPart(text) {
    var value = cleanDisplayText(text);
    if (value.length <= STORED_SUMMARY_PART_LENGTH) return value;
    return value.slice(0, STORED_SUMMARY_PART_LENGTH - 1).replace(/\s+$/, "") + "…";
  }

  function storedSummaryParts(parts) {
    if (!Array.isArray(parts)) return [];
    return parts.map(boundedPart).filter(Boolean).slice(0, STORED_SUMMARY_PARTS);
  }

  // A short starting name from the first few things the filter keeps.
  function suggestedNameForPairs(pairs) {
    var parts = [];
    describePairs(pairs).groups.forEach(function (group) {
      if (group.key === "include" || group.key === "rating" || group.key === "warnings" || group.key === "category") {
        parts = parts.concat(group.values);
      } else if (group.key === "exclude") {
        parts = parts.concat(group.values.map(function (value) { return "Exclude " + value; }));
      } else {
        parts.push(compactPartForGroup(group));
      }
    });
    return (parts.slice(0, 3).join(" · ") || "AO3 filter").slice(0, MAX_NAME_LENGTH).replace(/[\s·]+$/, "");
  }

  function buildApplyUrl(preset) {
    var target = new URL(location.origin + "/works");
    var currentContext = getPageContext();

    if (currentContext) {
      if (currentContext.type === "tagPath") {
        target.pathname = currentContext.path;
      } else if (currentContext.type === "tagId") {
        target.searchParams.set("tag_id", currentContext.tagId);
      }
    }

    var pairs = sanitizePairs(preset.params);
    for (var i = 0; i < pairs.length; i++) {
      target.searchParams.append(pairs[i][0], pairs[i][1]);
    }
    return target.href;
  }

  function contextKeyFromHref(href) {
    try {
      var url = new URL(href);
      var ctx = getPageContextFromUrl(url);
      return ctx ? ctx.key : "global:" + normalizePath(url.pathname);
    } catch (_) {
      return currentContextKey();
    }
  }

  // AO3's filter form submits to /works?tag_id=<tag>, while the tag's own
  // listing is /tags/<tag>/works. Both name the tag in AO3's URL form, so a
  // filter saved on one shows on the other.
  function tagNameFromContextKey(key) {
    var value = String(key || "");
    var raw = "";
    if (value.indexOf("tagId:") === 0) {
      raw = value.slice("tagId:".length);
    } else if (value.indexOf("tagPath:") === 0) {
      var match = value.slice("tagPath:".length).match(/^\/tags\/([^/]+)\/works$/);
      if (!match) return "";
      try {
        raw = decodeURIComponent(match[1]);
      } catch (_) {
        raw = match[1];
      }
    } else {
      return "";
    }
    return decodeAo3TagName(raw).toLowerCase();
  }

  function sameContextKey(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    var tag = tagNameFromContextKey(left);
    return tag !== "" && tag === tagNameFromContextKey(right);
  }

  function contextMatchesPreset(preset, current) {
    if (preset.scope === "global") return true;
    if (!preset.contextKey) return true;
    if (!current || !current.contextKey) return false;
    if (sameContextKey(preset.contextKey, current.contextKey)) return true;
    if (!preset.contextLabel || !current.contextLabel) return false;
    return cleanDisplayText(preset.contextLabel).toLowerCase() === cleanDisplayText(current.contextLabel).toLowerCase();
  }

  function visiblePresetsForCurrent(presets, current) {
    return (presets || []).filter(function (preset) {
      return contextMatchesPreset(preset, current);
    });
  }

  function groupedPresetsForCurrent(presets) {
    var groups = {
      context: [],
      global: [],
    };
    for (var i = 0; i < presets.length; i++) {
      var preset = presets[i];
      if (preset.scope === "global") groups.global.push(preset);
      else groups.context.push(preset);
    }
    return groups;
  }

  function relationForCurrent(presets, activeMeta, current) {
    if (!current || !current.hasFilters) return { type: "none" };
    for (var i = 0; i < presets.length; i++) {
      if (samePairSet(presets[i].params, current.pairs)) {
        return { type: "active", preset: presets[i] };
      }
    }
    if (activeMeta && sameContextKey(activeMeta.contextKey, current.contextKey)) {
      var applied = presets.find(function (preset) {
        return preset.id === activeMeta.id;
      });
      if (applied) return { type: "edited", preset: applied };
    }
    return { type: "unsaved" };
  }

  // Saved filters use Trace's page register: Story Ink
  // groups on the host tone, sentence-case labels, an ink check for the
  // active filter and teal text actions. No AO3 red, bars or serif.
  function pageTokens() {
    var light = {
      surface: "#FFFFFF", raised: "#E9EEF3", rule: "#D8E0E7", control: "#D8E0E7", ink: "#18232D",
      secondary: "#5F6B76", tertiary: "#7B8792", teal: "#176E72", warning: "#9B4146",
      scrim: "rgba(13, 20, 26, 0.32)",
    };
    var dark = {
      surface: "#121418", raised: "#1D1F23", rule: "#212429", control: "#686D75", ink: "#F2F5F8",
      secondary: "#B4BCC6", tertiary: "#9AA3AE", teal: "#8BCDC8", warning: "#E7A19F",
      scrim: "rgba(0, 0, 0, 0.5)",
    };
    function background(element) {
      if (!element || typeof window.getComputedStyle !== "function") return null;
      var value = window.getComputedStyle(element).backgroundColor;
      var channels = value && value.match(/rgba?\(([^)]+)\)/i);
      if (!channels) return null;
      var parts = channels[1].split(",").map(Number);
      if (parts.length > 3 && parts[3] === 0) return null;
      return parts.slice(0, 3);
    }
    var rgb = background(document.body) || background(document.documentElement) || [255, 255, 255];
    var linear = rgb.map(function (channel) {
      var value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    var luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    return luminance < 0.18 ? dark : light;
  }

  function applyPageTokens(root) {
    if (!root || !root.style) return;
    var tokens = pageTokens();
    Object.keys(tokens).forEach(function (name) {
      root.style.setProperty("--trace-page-" + name, tokens[name]);
    });
  }

  function insertStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    // The root's class and attribute together outrank AO3's form rules such as
    // form.filters input[type="text"], so none of them reach the panel.
    var R = "." + ROOT_ATTR + "[" + ROOT_ATTR + "]";
    style.textContent = [
      R + ", " + R + " * { box-sizing: border-box; }",
      R + " { margin: 0 0 14px; color: var(--trace-page-ink); font-family: -apple-system, BlinkMacSystemFont, system-ui, \"Segoe UI\", Roboto, sans-serif; font-size: 14px; line-height: 1.4; -webkit-font-smoothing: antialiased; }",
      R + " button, " + R + " input { font: inherit; letter-spacing: 0; text-transform: none; text-shadow: none; }",
      // AO3's skin gives buttons a fixed em height, nowrap and padding; none of
      // it may clip or squeeze what the panel shows.
      R + " button { -webkit-appearance: none; appearance: none; background: transparent; background-image: none; border: 0; border-radius: 8px; box-shadow: none; color: inherit; cursor: pointer; float: none; height: auto; line-height: inherit; margin: 0; max-height: none; min-height: 0; overflow: visible; padding: 0; text-align: left; text-overflow: clip; vertical-align: baseline; white-space: normal; width: auto; }",
      R + " :focus { outline: none; }",
      R + " :focus-visible { outline: 3px solid var(--trace-page-teal) !important; outline-offset: 2px; }",
      R + " p { margin: 0; }",
      R + " .trace-sf-card { background: transparent; border: 0; border-bottom: 1px solid var(--trace-page-rule); border-radius: 0; box-shadow: none; overflow: visible; padding-bottom: 8px; }",
      R + " .trace-sf-head { display: block; min-height: 44px; padding: 8px 0; width: 100%; }",
      R + " .trace-sf-head-line { align-items: center; display: flex; gap: 8px; min-height: 28px; }",
      R + " .trace-sf-title { color: var(--trace-page-ink); flex: 1 1 auto; font-size: 15px; font-weight: 600; line-height: 1.25; min-width: 0; }",
      R + " .trace-sf-count { color: var(--trace-page-secondary); flex: 0 0 auto; font-size: 13px; font-weight: 400; }",
      R + " .trace-sf-caret { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; flex: 0 0 auto; justify-content: center; width: 16px; }",
      R + " .trace-sf-caret svg { display: block; height: 12px; width: 12px; transition: transform 0.16s ease; }",
      R + " .trace-sf-caret[data-collapsed='false'] svg { transform: rotate(180deg); }",
      R + " .trace-sf-head-meta { color: var(--trace-page-secondary); display: block; font-size: 13px; line-height: 1.35; margin-top: 2px; overflow-wrap: anywhere; }",
      R + " .trace-sf-head-meta b, " + R + " .trace-sf-status-main b { color: var(--trace-page-ink); font-weight: 500; }",
      R + " .trace-sf-panel { min-width: 0; }",
      R + " .trace-sf-status { align-items: center; color: var(--trace-page-secondary); display: flex; flex-wrap: wrap; font-size: 13px; gap: 0 16px; line-height: 1.35; min-height: 44px; padding: 0 0 4px; }",
      R + " .trace-sf-status-main { align-items: flex-start; display: flex; flex: 1 1 10rem; gap: 6px; min-width: 0; overflow-wrap: anywhere; padding: 6px 0; }",
      R + " .trace-sf-check { color: var(--trace-page-ink); display: inline-flex; flex: 0 0 auto; height: 14px; margin-top: 2px; width: 14px; }",
      R + " .trace-sf-check svg, " + R + " .trace-sf-edge svg { display: block; height: 14px; width: 14px; }",
      R + " .trace-sf-status-actions { display: flex; flex-wrap: wrap; gap: 0 16px; }",
      // Trailing actions keep their text flush with the panel's edge.
      R + " .trace-sf-status-actions .trace-sf-btn { margin: 0 0 0 -8px; min-width: 44px; padding: 0 0 0 8px; }",
      R + " .trace-sf-status-actions .trace-sf-btn:last-child { justify-content: flex-end; }",
      R + " .trace-sf-btn { align-items: center; color: var(--trace-page-teal); display: inline-flex; font-size: 14px; font-weight: 500; gap: 4px; line-height: 1.25; margin: 0 -8px; min-height: 44px; padding: 0 8px; text-decoration: none; }",
      R + " .trace-sf-btn-primary { font-weight: 600; }",
      R + " .trace-sf-btn-ghost { color: var(--trace-page-secondary); }",
      R + " .trace-sf-btn-danger { color: var(--trace-page-warning); font-weight: 600; }",
      R + " .trace-sf-btn:disabled { cursor: default; opacity: 0.55; }",
      R + " .trace-sf-list { margin-top: 2px; }",
      R + " .trace-sf-section-label { color: var(--trace-page-secondary); font-size: 12.5px; font-weight: 500; line-height: 1.35; overflow-wrap: anywhere; padding: 10px 0 6px; }",
      R + " .trace-sf-rows { background: var(--trace-page-surface); border-radius: 14px; box-shadow: inset 0 0 0 1px var(--trace-page-rule); padding: 0 4px 0 12px; }",
      R + " .trace-sf-row { background: transparent; position: relative; }",
      R + " .trace-sf-row + .trace-sf-row { border-top: 1px solid var(--trace-page-rule); }",
      R + " .trace-sf-row-inner { align-items: center; display: grid; grid-template-columns: minmax(0, 1fr) 44px; min-height: 52px; min-width: 0; }",
      R + " .trace-sf-main { align-items: start; display: grid; grid-template-columns: 22px minmax(0, 1fr); min-width: 0; padding: 9px 6px 9px 0; width: 100%; }",
      R + " .trace-sf-edge { color: var(--trace-page-ink); display: inline-flex; height: 14px; margin-top: 2px; width: 14px; }",
      R + " .trace-sf-row-text { display: block; min-width: 0; }",
      R + " .trace-sf-name { color: var(--trace-page-ink); display: block; font-size: 14px; font-weight: 500; line-height: 1.3; overflow-wrap: anywhere; }",
      R + " .trace-sf-summary { color: var(--trace-page-secondary); display: block; font-size: 12.5px; line-height: 1.35; margin-top: 2px; overflow-wrap: anywhere; }",
      R + " .trace-sf-menu-btn { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; height: 44px; justify-content: center; width: 44px; }",
      R + " .trace-sf-menu-btn svg { display: block; height: 16px; width: 16px; }",
      R + " .trace-sf-more { color: var(--trace-page-teal); display: inline-flex; align-items: center; font-size: 14px; font-weight: 500; margin: 2px -8px 0; min-height: 44px; padding: 0 8px; }",
      R + " .trace-sf-manage { align-items: center; animation: trace-sf-reveal 0.14s ease-out both; border-top: 1px solid var(--trace-page-rule); display: flex; flex-wrap: wrap; gap: 0 14px; margin: 0 0 0 22px; }",
      R + " .trace-sf-manage button { color: var(--trace-page-teal); font-size: 13px; font-weight: 500; line-height: 1.25; margin: 0 -8px; min-height: 44px; padding: 0 8px; }",
      R + " .trace-sf-manage button[data-danger='true'] { color: var(--trace-page-warning); }",
      R + " .trace-sf-manage button:disabled { color: var(--trace-page-secondary); cursor: default; opacity: 0.55; }",
      "@keyframes trace-sf-reveal { from { opacity: 0; } to { opacity: 1; } }",
      "@media (prefers-reduced-motion: reduce) { " + R + " .trace-sf-manage { animation: none; } " + R + " .trace-sf-caret svg { transition: none; } }",
      R + " .trace-sf-form { padding: 4px 0 8px; }",
      R + " .trace-sf-label { color: var(--trace-page-secondary); display: block; font-size: 12.5px; font-weight: 600; line-height: 1.35; margin: 10px 0 6px; }",
      R + " .trace-sf-form > .trace-sf-label:first-child { margin-top: 4px; }",
      R + " .trace-sf-input-row { display: block; position: relative; }",
      R + " .trace-sf-input { background: var(--trace-page-surface); border: 0; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--trace-page-control); color: var(--trace-page-ink); font-size: 14px; height: auto; margin: 0; min-height: 44px; padding: 10px 12px; width: 100%; }",
      R + " .trace-sf-input-row .trace-sf-input { padding-right: 44px; }",
      R + " .trace-sf-input::placeholder { color: var(--trace-page-secondary); }",
      R + " .trace-sf-clear-name { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; font-size: 18px; font-weight: 500; height: 44px; justify-content: center; line-height: 1; position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 44px; }",
      R + " .trace-sf-input:placeholder-shown + .trace-sf-clear-name { display: none; }",
      // AO3 styles the filter form's own dl/dt/dd; reset them for this list.
      R + " .trace-sf-keeps, " + R + " .trace-sf-keeps > dt, " + R + " .trace-sf-keeps > dd { background: none; border: 0; box-shadow: none; clear: none; color: inherit; float: none; font: inherit; height: auto; margin: 0; max-height: none; overflow: visible; padding: 0; text-align: left; width: auto; }",
      R + " .trace-sf-keeps { display: grid; gap: 6px 12px; grid-template-columns: minmax(0, 30%) minmax(0, 1fr); }",
      R + " .trace-sf-keeps > dt { color: var(--trace-page-secondary); display: block; font-size: 12.5px; line-height: 1.4; overflow-wrap: anywhere; padding-top: 1px; }",
      R + " .trace-sf-keeps > dd { color: var(--trace-page-ink); display: block; font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }",
      R + " .trace-sf-capacity, " + R + " .trace-sf-scope-note { color: var(--trace-page-secondary); font-size: 12.5px; line-height: 1.35; margin-top: 10px; }",
      R + " .trace-sf-scope { display: block; }",
      R + " .trace-sf-radio { align-items: center; color: var(--trace-page-ink); display: flex; font-size: 14px; gap: 10px; min-height: 44px; overflow-wrap: anywhere; padding: 6px 0; width: 100%; }",
      R + " .trace-sf-radio-mark { align-items: center; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--trace-page-secondary); display: inline-flex; flex: 0 0 auto; height: 18px; justify-content: center; width: 18px; }",
      R + " .trace-sf-radio[aria-checked='true'] .trace-sf-radio-mark { box-shadow: inset 0 0 0 1.5px var(--trace-page-ink); }",
      R + " .trace-sf-radio[aria-checked='true'] .trace-sf-radio-mark::after { background: var(--trace-page-ink); border-radius: 50%; content: ''; height: 8px; width: 8px; }",
      R + " .trace-sf-actions { display: flex; flex-wrap: wrap; gap: 0 16px; margin-top: 6px; }",
      R + " .trace-sf-empty, " + R + " .trace-sf-note { color: var(--trace-page-secondary); font-size: 13px; line-height: 1.4; padding: 2px 0 8px; }",
      R + " .trace-sf-error { align-items: center; color: var(--trace-page-ink); display: flex; flex-wrap: wrap; font-size: 13px; gap: 0 16px; line-height: 1.4; min-height: 44px; }",
      R + " .trace-sf-error-text { align-items: center; display: flex; flex: 1 1 10rem; gap: 6px; min-width: 0; }",
      R + " .trace-sf-error-glyph { color: var(--trace-page-warning); display: inline-flex; flex: 0 0 auto; height: 14px; width: 14px; }",
      R + " .trace-sf-error-glyph svg { display: block; height: 14px; width: 14px; }",
      R + " .trace-sf-error b { font-weight: 600; }",
      R + " .trace-sf-confirm { border-top: 1px solid var(--trace-page-rule); margin-left: 22px; padding: 10px 0 0; }",
      R + " .trace-sf-confirm-title { color: var(--trace-page-ink); display: block; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }",
      R + " .trace-sf-confirm-detail { color: var(--trace-page-secondary); display: block; font-size: 12.5px; margin-top: 2px; }",
      R + " .trace-sf-confirm-actions { display: flex; flex-wrap: wrap; gap: 0 16px; }",
      R + " .trace-sf-rename { padding: 4px 0 10px; }",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureRoot() {
    var form = findFilterForm();
    if (!form) return null;
    var mount = filterMountPoint(form);
    var existing = form.querySelector("[" + ROOT_ATTR + "]");
    if (existing) {
      placeRoot(existing, mount);
      return existing;
    }
    var root = document.createElement("div");
    root.setAttribute(ROOT_ATTR, "");
    root.className = ROOT_ATTR;
    placeRoot(root, mount);
    root.addEventListener("click", handleClick, true);
    root.addEventListener("pointerdown", handlePointerDown, true);
    root.addEventListener("pointerup", handlePointerDown, true);
    root.addEventListener("mousedown", handlePointerDown, true);
    root.addEventListener("mouseup", handlePointerDown, true);
    root.addEventListener("touchstart", handlePointerDown, true);
    root.addEventListener("touchend", handlePointerDown, true);
    root.addEventListener("keydown", handleKeyDown, true);
    root.addEventListener("input", handleInput, true);
    root.addEventListener("submit", stopTraceEvent, true);
    return root;
  }

  function filterMountPoint(form) {
    var fieldset = null;
    var children = form && form.children ? form.children : [];
    for (var i = 0; i < children.length; i++) {
      if (String(children[i].tagName || "").toLowerCase() === "fieldset") {
        fieldset = children[i];
        break;
      }
    }
    if (!fieldset) return { parent: form, before: form.firstChild || null };
    var before = fieldset.firstChild || null;
    if (before && String(before.tagName || "").toLowerCase() === "legend") {
      before = before.nextSibling || null;
    }
    return { parent: fieldset, before: before };
  }

  function placeRoot(root, mount) {
    if (!root || !mount || !mount.parent) return;
    if (root.parentNode === mount.parent) {
      if (mount.before === root) return;
      if (mount.before && root.nextSibling === mount.before) return;
      if (!mount.before && !root.nextSibling) return;
    }
    mount.parent.insertBefore(root, mount.before || null);
  }

  function removeRoot() {
    closeSheet(false);
    removeLine();
    if (state.root && state.root.parentNode) {
      state.root.parentNode.removeChild(state.root);
    }
    state.root = null;
  }

  function renderSoon(delay) {
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(function () {
      state.renderTimer = null;
      renderFromStorage();
    }, typeof delay === "number" ? delay : 40);
  }

  async function renderFromStorage() {
    if (!isAo3Host(location.hostname) || pageHasPasswordField()) return;
    if (!isSupportedFilterPage()) return;
    if (!(await readUiEnabled())) {
      removeRoot();
      return;
    }
    insertStyle();
    state.narrow = isNarrowLayout();
    if (state.narrow) insertPhoneStyle();
    var root = ensureRoot();
    if (!root) return;
    applyPageTokens(root);
    state.root = root;
    var stored = await readStorageState();
    state.presets = stored.presets;
    state.activeMeta = stored.activeMeta;
    state.panelCollapsed = stored.panelCollapsed;
    state.lastUsed = stored.lastUsed;
    state.current = getCurrentFilterState();
    state.fromStorage = true;
    try {
      render();
    } finally {
      state.fromStorage = false;
    }
  }

  function render() {
    if (!state.root) return;
    var visiblePresets = visiblePresetsForCurrent(state.presets, state.current);
    var relation = relationForCurrent(visiblePresets, state.activeMeta, state.current);
    if (state.narrow) {
      renderPhone(visiblePresets, relation);
      return;
    }
    closeSheet(false);
    removeLine();
    var collapsed = Boolean(state.panelCollapsed);
    var html = "";
    html += "<div class='trace-sf-card' data-panel-collapsed='" + (collapsed ? "true" : "false") + "'>";
    html += renderHeader(visiblePresets.length, relation, collapsed);
    if (!collapsed) {
      html += "<div class='trace-sf-panel'>";
      if (state.error) html += renderError(state.error);
      if (state.notice) html += renderNote(state.notice);
      if (state.mode === "save") html += renderSaveForm();
      else html += renderStatus(relation);
      if (visiblePresets.length > 0) html += renderList(relation, visiblePresets);
      else if (state.mode !== "save" && !(state.current && state.current.hasFilters)) html += renderEmpty();
      html += "</div>";
    }
    html += "</div>";
    replaceRootWithUiMarkup(state.root, html);
  }

  function replaceRootWithUiMarkup(root, html) {
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    var parser = new DOMParser();
    var doc = parser.parseFromString(
      "<!doctype html><html><body>" + String(html || "") + "</body></html>",
      "text/html",
    );
    sanitizeParsedUiMarkup(doc.body);
    var fragment = document.createDocumentFragment();
    while (doc.body.firstChild) {
      fragment.appendChild(document.importNode(doc.body.firstChild, true));
      doc.body.removeChild(doc.body.firstChild);
    }
    root.appendChild(fragment);
  }

  function sanitizeParsedUiMarkup(container) {
    if (!container || !container.querySelectorAll) return;
    var blocked = container.querySelectorAll("script, iframe, object, embed, link, meta");
    for (var i = 0; i < blocked.length; i++) {
      if (blocked[i].parentNode) blocked[i].parentNode.removeChild(blocked[i]);
    }
    var nodes = container.querySelectorAll("*");
    for (var j = 0; j < nodes.length; j++) {
      var attrs = Array.prototype.slice.call(nodes[j].attributes || []);
      for (var k = 0; k < attrs.length; k++) {
        var name = String(attrs[k].name || "").toLowerCase();
        var value = String(attrs[k].value || "");
        if (
          name.indexOf("on") === 0 ||
          name === "srcdoc" ||
          ((name === "href" || name === "src" || name === "xlink:href") && /^\s*javascript:/i.test(value))
        ) {
          nodes[j].removeAttribute(attrs[k].name);
        }
      }
    }
  }

  // One full-width header button: the title, a count and one caret. When the
  // panel is collapsed a second line says where the current filters stand.
  function renderHeader(count, relation, collapsed) {
    var meta = collapsed ? headerStateText(relation) : "";
    return (
      "<button type='button' class='trace-sf-head' data-trace-sf-action='toggle-panel' aria-expanded='" + (collapsed ? "false" : "true") + "'>" +
      "<span class='trace-sf-head-line'>" +
      "<span class='trace-sf-title'>Saved filters</span>" +
      (count > 0 ? "<span class='trace-sf-count'>" + count + "</span>" : "") +
      renderChevron("trace-sf-caret", collapsed) +
      "</span>" +
      (meta ? "<span class='trace-sf-head-meta'>" + meta + "</span>" : "") +
      "</button>"
    );
  }

  // The active filter is marked with an ink check, never a coloured bar.
  function renderCheckIcon() {
    return (
      "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' focusable='false' aria-hidden='true'>" +
      "<path d='M3 8.5l3.2 3.2L13 4.8'/>" +
      "</svg>"
    );
  }

  function renderAlertIcon() {
    return (
      "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' focusable='false' aria-hidden='true'>" +
      "<path d='M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.7v.2'/>" +
      "</svg>"
    );
  }

  function renderChevron(className, collapsed) {
    return (
      "<span class='" + className + "' data-collapsed='" + (collapsed ? "true" : "false") + "' aria-hidden='true'>" +
      "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' focusable='false'>" +
      "<path d='M4 6l4 4 4-4'/>" +
      "</svg>" +
      "</span>"
    );
  }

  function renderKebabIcon() {
    return (
      "<svg viewBox='0 0 16 16' fill='currentColor' focusable='false' aria-hidden='true'>" +
      "<circle cx='8' cy='3.25' r='1.35'/>" +
      "<circle cx='8' cy='8' r='1.35'/>" +
      "<circle cx='8' cy='12.75' r='1.35'/>" +
      "</svg>"
    );
  }

  function headerStateText(relation) {
    if (relation && relation.type === "active" && relation.preset) {
      return "Showing <b>" + escapeHtml(relation.preset.name) + "</b>";
    }
    if (relation && relation.type === "edited" && relation.preset) {
      return "<b>" + escapeHtml(relation.preset.name) + "</b>, changed";
    }
    if (relation && relation.type === "unsaved") return "Current filters aren't saved";
    return "";
  }

  function renderStatus(relation) {
    if (!state.current || !state.current.hasFilters || !relation || relation.type === "none") return "";
    var canSaveNew = !isAtSavedFilterLimit();
    if (relation.type === "active") {
      return (
        "<div class='trace-sf-status' data-kind='active'>" +
        "<span class='trace-sf-status-main'>" +
        "<span class='trace-sf-check'>" + renderCheckIcon() + "</span>" +
        "<span>Showing <b>" + escapeHtml(relation.preset.name) + "</b></span>" +
        "</span>" +
        "</div>"
      );
    }
    if (relation.type === "edited") {
      return (
        "<div class='trace-sf-status' data-kind='edited'>" +
        "<span class='trace-sf-status-main'><span><b>" + escapeHtml(relation.preset.name) + "</b>, changed</span></span>" +
        "<span class='trace-sf-status-actions'>" +
        "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='update-current' data-id='" + escapeAttr(relation.preset.id) + "'>Update " + escapeHtml(relation.preset.name) + "</button>" +
        (canSaveNew ? "<button type='button' class='trace-sf-btn' data-trace-sf-action='save-open'>Save as new</button>" : "") +
        "</span>" +
        "</div>" +
        (canSaveNew ? "" : renderNote(savedFilterLimitMessage()))
      );
    }
    return (
      "<div class='trace-sf-status' data-kind='unsaved'>" +
      "<span class='trace-sf-status-main'><span>These filters aren't saved</span></span>" +
      (canSaveNew
        ? "<span class='trace-sf-status-actions'><button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='save-open'>Save</button></span>"
        : "") +
      "</div>" +
      (canSaveNew ? "" : renderNote(savedFilterLimitMessage()))
    );
  }

  function renderError(message) {
    return (
      "<div class='trace-sf-error' role='alert'>" +
      "<span class='trace-sf-error-text'><span class='trace-sf-error-glyph'>" + renderAlertIcon() + "</span><span>" + escapeHtml(message) + "</span></span>" +
      (state.retry ? "<button type='button' class='trace-sf-btn' data-trace-sf-action='retry'>Try again</button>" : "") +
      "</div>"
    );
  }

  function renderNote(message) {
    return "<p class='trace-sf-note'>" + escapeHtml(message) + "</p>";
  }

  function renderEmpty() {
    return "<p class='trace-sf-empty'>Choose filters below, then save them here to reuse in one tap.</p>";
  }

  // Every current filter, grouped, every value shown and wrapping.
  function renderKeepsList(pairs) {
    var groups = describePairs(pairs).groups;
    if (!groups.length) return "";
    return (
      "<div class='trace-sf-label' id='trace-sf-keeps-label'>What it keeps</div>" +
      "<dl class='trace-sf-keeps' aria-labelledby='trace-sf-keeps-label'>" +
      groups.map(function (group) {
        return "<dt>" + escapeHtml(group.label) + "</dt><dd>" + escapeHtml(group.values.join(", ")) + "</dd>";
      }).join("") +
      "</dl>"
    );
  }

  function renderScopeChoice() {
    if (!hasReusableContext()) {
      return "<p class='trace-sf-scope-note'>Shows on every AO3 search.</p>";
    }
    var scope = state.draftScope === "global" ? "global" : "context";
    function radio(value, action, label) {
      var checked = scope === value;
      return (
        "<button type='button' class='trace-sf-radio' role='radio' data-trace-sf-action='" + action + "' aria-checked='" + (checked ? "true" : "false") + "' tabindex='" + (checked ? "0" : "-1") + "'>" +
        "<span class='trace-sf-radio-mark' aria-hidden='true'></span>" +
        "<span>" + escapeHtml(label) + "</span>" +
        "</button>"
      );
    }
    return (
      "<div class='trace-sf-label' id='trace-sf-scope-label'>Show it on</div>" +
      "<div class='trace-sf-scope' role='radiogroup' aria-labelledby='trace-sf-scope-label'>" +
      radio("context", "scope-context", displayContextLabel() + " only") +
      radio("global", "scope-global", "Every AO3 search") +
      "</div>"
    );
  }

  function renderSaveForm() {
    var pairs = state.current ? state.current.pairs : [];
    var suggested = suggestedNameForPairs(pairs);
    return (
      "<div class='trace-sf-form' data-trace-sf-save-form>" +
      "<label class='trace-sf-label' for='trace-sf-name-input'>Name</label>" +
      "<span class='trace-sf-input-row'>" +
      "<input id='trace-sf-name-input' class='trace-sf-input' type='text' data-trace-sf-name maxlength='" + MAX_NAME_LENGTH + "' autocomplete='off' autocapitalize='sentences' placeholder='" + escapeAttr(suggested) + "' value='" + escapeAttr(state.draftName || "") + "'>" +
      "<button type='button' class='trace-sf-clear-name' data-trace-sf-action='name-clear' aria-label='Clear name' title='Clear name'>&times;</button>" +
      "</span>" +
      renderKeepsList(pairs) +
      renderCapacityWarning() +
      renderScopeChoice() +
      "<div class='trace-sf-actions'>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='save-confirm'" + (state.current && state.current.canSave ? "" : " disabled") + ">Save filter</button>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-ghost' data-trace-sf-action='save-cancel'>Cancel</button>" +
      "</div>" +
      "</div>"
    );
  }

  // One list: filters for this tag first, then those for every search, with
  // plain labels only when both kinds are present. Past eight rows the rest
  // wait behind "Show all n"; nothing scrolls inside the panel.
  function renderList(relation, presets) {
    var groups = groupedPresetsForCurrent(presets);
    var both = groups.context.length > 0 && groups.global.length > 0;
    var limit = state.showAll || presets.length <= LIST_PREVIEW_COUNT ? Infinity : LIST_PREVIEW_COUNT;
    var shown = 0;
    var html = "<div class='trace-sf-list'>";
    function section(list, label, scope) {
      if (!list.length || shown >= limit) return;
      var visible = list.slice(0, limit - shown);
      shown += visible.length;
      if (both) html += "<div class='trace-sf-section-label' data-scope='" + scope + "'>" + escapeHtml(label) + "</div>";
      html += "<div class='trace-sf-rows'>" + visible.map(function (preset) {
        return renderPresetRow(preset, relation);
      }).join("") + "</div>";
    }
    section(groups.context, displayContextLabel(), "context");
    section(groups.global, "Every search", "global");
    if (shown < presets.length) {
      html += "<button type='button' class='trace-sf-more' data-trace-sf-action='show-all'>Show all " + presets.length + "</button>";
    }
    html += "</div>";
    return html;
  }

  function renderPresetRow(preset, relation) {
    var isActive = relation.type === "active" && relation.preset && relation.preset.id === preset.id;
    var isRenaming = state.renameId === preset.id;
    var contents = presetContentsText(preset);
    var html = "<div class='trace-sf-row' data-id='" + escapeAttr(preset.id) + "' data-scope='" + escapeAttr(preset.scope === "global" ? "global" : "context") + "' data-active='" + (isActive ? "true" : "false") + "' data-menu-open='" + (state.menuId === preset.id ? "true" : "false") + "'>";
    if (isRenaming) {
      html += (
        "<div class='trace-sf-rename'>" +
        "<label class='trace-sf-label' for='trace-sf-rename-input'>Rename</label>" +
        "<input id='trace-sf-rename-input' class='trace-sf-input' type='text' data-trace-sf-rename-input maxlength='" + MAX_NAME_LENGTH + "' value='" + escapeAttr(state.renameDraft || preset.name) + "'>" +
        "<div class='trace-sf-actions'>" +
        "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='rename-save' data-id='" + escapeAttr(preset.id) + "'>Save name</button>" +
        "<button type='button' class='trace-sf-btn trace-sf-btn-ghost' data-trace-sf-action='rename-cancel'>Cancel</button>" +
        "</div>" +
        "</div>"
      );
    } else {
      html += (
        "<div class='trace-sf-row-inner'>" +
        "<button type='button' class='trace-sf-main' data-trace-sf-action='apply' data-id='" + escapeAttr(preset.id) + "' aria-label='" + escapeAttr(preset.name + ". " + contents + ". Apply.") + "'" + (isActive ? " aria-current='true'" : "") + ">" +
        "<span class='trace-sf-edge'>" + (isActive ? renderCheckIcon() : "") + "</span>" +
        "<span class='trace-sf-row-text'>" +
        "<span class='trace-sf-name'>" + escapeHtml(preset.name) + "</span>" +
        "<span class='trace-sf-summary'>" + escapeHtml(contents) + "</span>" +
        "</span>" +
        "</button>" +
        "<button type='button' class='trace-sf-menu-btn' data-trace-sf-action='menu' data-id='" + escapeAttr(preset.id) + "' aria-expanded='" + (state.menuId === preset.id ? "true" : "false") + "' aria-controls='trace-sf-manage-" + escapeAttr(preset.id) + "' aria-label='Manage " + escapeAttr(preset.name) + "'>" + renderKebabIcon() + "</button>" +
        "</div>"
      );
      if (state.menuId === preset.id) {
        html += renderManagementActions(preset);
      }
      if (state.confirmDeleteId === preset.id) {
        html += renderDeleteConfirm(preset);
      }
    }
    html += "</div>";
    return html;
  }

  function renderManagementActions(preset) {
    var canUpdate = state.current && state.current.canSave;
    return (
      "<div class='trace-sf-manage' id='trace-sf-manage-" + escapeAttr(preset.id) + "' role='group' aria-label='Manage " + escapeAttr(preset.name) + "'>" +
      "<button type='button' data-trace-sf-action='rename-open' data-id='" + escapeAttr(preset.id) + "'>Rename</button>" +
      "<button type='button' data-trace-sf-action='update-current' data-id='" + escapeAttr(preset.id) + "'" + (canUpdate ? "" : " disabled title='Choose filters on this page first'") + ">Update with current filters</button>" +
      "<button type='button' data-danger='true' data-trace-sf-action='delete-confirm' data-id='" + escapeAttr(preset.id) + "'>Delete</button>" +
      "</div>"
    );
  }

  function renderDeleteConfirm(preset) {
    return (
      "<div class='trace-sf-confirm'>" +
      "<span class='trace-sf-confirm-title'>Delete “" + escapeHtml(preset.name) + "”?</span>" +
      "<span class='trace-sf-confirm-detail'>It's deleted on every device. Nothing on AO3 changes.</span>" +
      "<span class='trace-sf-confirm-actions'>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-danger' data-trace-sf-action='delete' data-id='" + escapeAttr(preset.id) + "'>Delete</button>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-ghost' data-trace-sf-action='delete-cancel'>Cancel</button>" +
      "</span>" +
      "</div>"
    );
  }

  // ---------------------------------------------------------------- phone
  // On AO3's narrow layout the filter form is a 16em column beside the
  // listing. The column keeps quick access only: three names, Save these
  // filters and All saved filters. Everything else lives in Trace's sheet,
  // and a line above the works says which saved filter is showing.

  function isNarrowLayout() {
    try {
      return Boolean(window.matchMedia && window.matchMedia(NARROW_QUERY).matches);
    } catch (_) {
      return false;
    }
  }

  function sanitizeLastUsed(raw) {
    var out = { byId: {}, byContext: {} };
    if (!raw || typeof raw !== "object") return out;
    var byId = raw.byId && typeof raw.byId === "object" ? raw.byId : {};
    Object.keys(byId).forEach(function (id) {
      if (typeof byId[id] === "string") out.byId[id] = byId[id];
    });
    var byContext = raw.byContext && typeof raw.byContext === "object" ? raw.byContext : {};
    Object.keys(byContext).forEach(function (key) {
      var entry = byContext[key];
      if (entry && typeof entry.id === "string" && typeof entry.at === "string") {
        out.byContext[key] = { id: entry.id, at: entry.at };
      }
    });
    return out;
  }

  // A tag's two addresses (/tags/<tag>/works and /works?tag_id=<tag>) share
  // one record, so "last used on this tag" holds on both.
  function lastUsedContextKey() {
    var key = currentContextKey();
    var tag = tagNameFromContextKey(key);
    return tag ? "tag:" + tag : key;
  }

  function nextLastUsed(id) {
    var now = new Date().toISOString();
    var known = {};
    state.presets.forEach(function (preset) {
      known[preset.id] = true;
    });
    known[id] = true;
    var next = { byId: {}, byContext: {} };
    Object.keys(state.lastUsed.byId).forEach(function (key) {
      if (known[key]) next.byId[key] = state.lastUsed.byId[key];
    });
    next.byId[id] = now;
    var contexts = Object.keys(state.lastUsed.byContext)
      .map(function (key) { return [key, state.lastUsed.byContext[key]]; })
      .filter(function (entry) { return known[entry[1].id]; });
    contexts.push([lastUsedContextKey(), { id: id, at: now }]);
    contexts.sort(function (a, b) { return a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0; });
    contexts.slice(0, LAST_USED_CONTEXT_LIMIT).forEach(function (entry) {
      if (!next.byContext[entry[0]]) next.byContext[entry[0]] = entry[1];
    });
    return next;
  }

  function persistLastUsed(id) {
    state.lastUsed = nextLastUsed(id);
    var patch = {};
    patch[LAST_USED_KEY] = state.lastUsed;
    storageSet(patch).catch(function () {
      /* Only the order of the quick list depends on this. */
    });
  }

  // Most relevant first: the filter showing now, the one last used on this
  // tag, this tag's others, then every-search filters; recent use breaks ties.
  function orderedPresets(presets, relation) {
    var lastHere = state.lastUsed.byContext[lastUsedContextKey()];
    var activeId = relation && relation.type === "active" && relation.preset ? relation.preset.id : "";
    function rank(preset) {
      if (preset.id === activeId) return 0;
      if (lastHere && lastHere.id === preset.id) return 1;
      return preset.scope === "global" ? 3 : 2;
    }
    function usedAt(preset) {
      return state.lastUsed.byId[preset.id] || "";
    }
    return presets
      .map(function (preset, index) { return { preset: preset, index: index }; })
      .sort(function (a, b) {
        var byRank = rank(a.preset) - rank(b.preset);
        if (byRank) return byRank;
        var left = usedAt(a.preset);
        var right = usedAt(b.preset);
        if (left !== right) return left < right ? 1 : -1;
        return a.index - b.index;
      })
      .map(function (entry) { return entry.preset; });
  }

  // ------------------------------------------------- short tokens per filter
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function shortCount(text) {
    var digits = String(text || "").replace(/,/g, "");
    if (!/^\d+$/.test(digits)) return String(text || "");
    var value = Number(digits);
    if (value < 1000) return String(value);
    return String(Math.round(value / 100) / 10).replace(/\.0$/, "") + "k";
  }

  function shortWords(text) {
    var range = String(text).match(/^([\d,]+)–([\d,]+) words$/);
    if (range) return shortCount(range[1]) + "–" + shortCount(range[2]) + " words";
    var min = String(text).match(/^At least ([\d,]+) words$/);
    if (min) return shortCount(min[1]) + "+ words";
    var max = String(text).match(/^Up to ([\d,]+) words$/);
    if (max) return "Under " + shortCount(max[1]) + " words";
    return String(text);
  }

  function shortDate(text) {
    var match = String(text || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return String(text || "");
    var day = Number(match[3]) + " " + MONTHS[Number(match[2]) - 1];
    return Number(match[1]) === new Date().getFullYear() ? day : day + " " + match[1];
  }

  function shortUpdated(text) {
    var value = String(text || "");
    var since = value.match(/^Since (.+)$/);
    if (since) return "Updated since " + shortDate(since[1]);
    var until = value.match(/^Until (.+)$/);
    if (until) return "Updated until " + shortDate(until[1]);
    var range = value.match(/^(.+) to (.+)$/);
    if (range) return "Updated " + shortDate(range[1]) + "–" + shortDate(range[2]);
    return "Updated " + lowerFirst(value);
  }

  var TOKEN_ORDER = ["include", "rating", "warnings", "category", "status", "words", "exclude", "language", "crossovers", "updated", "search", "sort", "other"];

  function tokensForGroup(group) {
    var values = group.values || [];
    if (group.stored) return [group.stored];
    if (group.key === "status") return values.map(function (value) { return value.replace(/ only$/, ""); });
    if (group.key === "words") return values.map(shortWords);
    if (group.key === "exclude") return [values.length === 1 ? "Not " + values[0] : "Excludes " + values.length + " tags"];
    if (group.key === "updated") return values.map(shortUpdated);
    if (group.key === "search") return ["“" + values.join(", ") + "”"];
    if (group.key === "sort") return values.length ? ["By " + values[0].toLowerCase()] : [];
    if (group.key === "other") return [group.label + ": " + values.join(", ")];
    return values.slice();
  }

  // The groups a filter keeps, with a part the page can't name taken from
  // the summary stored at save time when that summary lines up.
  function presetGroups(pairs, summary) {
    var description = describePairs(pairs);
    var stored = Array.isArray(summary) ? summary : [];
    var aligned = stored.length > 0 && stored.length === Math.min(description.groups.length, STORED_SUMMARY_PARTS);
    var hidden = 0;
    var groups = [];
    description.groups.forEach(function (group, index) {
      if (group.labelled) {
        groups.push(group);
      } else if (aligned && index < stored.length) {
        groups.push(Object.assign({}, group, { stored: stored[index] }));
      } else {
        hidden += 1;
      }
    });
    return { groups: groups, hidden: hidden, stored: stored };
  }

  function tokensForPairs(pairs, summary) {
    var described = presetGroups(pairs, summary);
    var tokens = [];
    TOKEN_ORDER.forEach(function (key) {
      described.groups.forEach(function (group) {
        if (group.key === key) tokens = tokens.concat(tokensForGroup(group));
      });
    });
    if (!tokens.length && described.stored.length) return { tokens: described.stored.slice(), hidden: 0 };
    return { tokens: tokens.filter(Boolean), hidden: described.hidden };
  }

  function tokenText(tokens, shown, hidden) {
    var rest = tokens.length - shown + (hidden || 0);
    var text = tokens.slice(0, shown).join(" · ");
    if (rest > 0) text += (text ? " " : "") + "+" + rest;
    return text || "AO3 filter";
  }

  // Each token line shows as many tokens as fit on one line, then "+n".
  function fitTokenLines(container) {
    if (!container) return;
    var lines = container.querySelectorAll("[data-trace-sf-tokens]");
    for (var i = 0; i < lines.length; i++) {
      var el = lines[i];
      var tokens = [];
      try {
        tokens = JSON.parse(el.getAttribute("data-trace-sf-tokens") || "[]");
      } catch (_) {
        tokens = [];
      }
      var hidden = Number(el.getAttribute("data-trace-sf-hidden") || 0);
      for (var shown = tokens.length; shown >= 1; shown--) {
        el.textContent = tokenText(tokens, shown, hidden);
        if (el.scrollWidth <= el.clientWidth + 1) break;
      }
    }
  }

  function suggestedNameForCurrent() {
    var pairs = state.current ? state.current.pairs : [];
    if (!state.narrow) return suggestedNameForPairs(pairs);
    var tokens = tokensForPairs(pairs, []).tokens.slice(0, 2);
    return (tokens.join(" · ") || "AO3 filter").slice(0, MAX_NAME_LENGTH);
  }

  // ---------------------------------------------------------------- styles
  function insertPhoneStyle() {
    if (document.getElementById(PHONE_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = PHONE_STYLE_ID;
    var R = "." + ROOT_ATTR + "[" + ROOT_ATTR + "]";
    var L = ".trace-sf-line[" + LINE_ATTR + "]";
    var S = ".trace-sf-sheet-host[" + SHEET_ATTR + "]";
    var font = "-apple-system, BlinkMacSystemFont, system-ui, \"Segoe UI\", Roboto, sans-serif";
    var buttonReset = "-webkit-appearance: none; appearance: none; background: transparent; background-image: none; border: 0; border-radius: 0; box-shadow: none; color: inherit; cursor: pointer; float: none; font: inherit; height: auto; letter-spacing: 0; line-height: inherit; margin: 0; max-height: none; min-height: 0; padding: 0; text-align: left; text-shadow: none; text-transform: none; vertical-align: baseline; width: auto;";
    var ellipsis = "display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    style.textContent = [
      // The column: quick access at the top of AO3's filter form.
      R + " .trace-sf-col { border-bottom: 1px solid var(--trace-page-rule); padding: 0 0 6px; }",
      R + " .trace-sf-col-title { color: var(--trace-page-ink); font-size: 15px; font-weight: 600; line-height: 1.25; padding: 6px 0 8px; }",
      R + " .trace-sf-col-rows { background: var(--trace-page-surface); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--trace-page-rule); overflow: hidden; }",
      R + " .trace-sf-col-row { align-items: center; display: grid; gap: 6px; grid-template-columns: 14px minmax(0, 1fr); min-height: 44px; padding: 0 10px 0 8px; width: 100%; border-radius: 0; }",
      R + " .trace-sf-col-row + .trace-sf-col-row { border-top: 1px solid var(--trace-page-rule); }",
      R + " .trace-sf-col-name { color: var(--trace-page-ink); font-size: 14px; font-weight: 500; line-height: 1.3; " + ellipsis + " }",
      R + " .trace-sf-col-row[aria-current='true'] .trace-sf-col-name { font-weight: 600; }",
      R + " .trace-sf-col-link { align-items: center; color: var(--trace-page-teal); display: flex; font-size: 14px; font-weight: 500; gap: 6px; line-height: 1.25; min-height: 44px; width: 100%; }",
      R + " .trace-sf-col-link[data-kind='save'] { font-weight: 600; }",
      R + " .trace-sf-col-link svg { display: block; flex: 0 0 auto; height: 12px; width: 12px; }",
      R + " .trace-sf-col-link-text { " + ellipsis + " }",
      R + " .trace-sf-col .trace-sf-note { padding: 0 0 6px; }",

      // The Showing line, outside AO3's button row.
      L + ", " + L + " * { box-sizing: border-box; }",
      L + " { clear: both; color: var(--trace-page-secondary); display: block; font-family: " + font + "; font-size: 15px; line-height: 1.35; margin: 8px 0 12px; -webkit-font-smoothing: antialiased; }",
      L + " button { " + buttonReset + " align-items: center; border-bottom: 1px solid var(--trace-page-rule); border-top: 1px solid var(--trace-page-rule); display: flex; gap: 8px; min-height: 44px; width: 100%; }",
      L + " :focus { outline: none; }",
      L + " :focus-visible { outline: 3px solid var(--trace-page-teal) !important; outline-offset: 2px; }",
      L + " .trace-sf-line-text { flex: 1 1 auto; " + ellipsis + " }",
      L + " b { color: var(--trace-page-ink); font-weight: 600; }",
      L + " .trace-sf-check { color: var(--trace-page-ink); display: inline-flex; flex: 0 0 auto; height: 16px; width: 16px; }",
      L + " .trace-sf-line-more { color: var(--trace-page-tertiary); display: inline-flex; flex: 0 0 auto; height: 12px; width: 12px; }",
      L + " svg { display: block; height: 100%; width: 100%; }",

      // The sheet: the listing sheet's anatomy on Trace's page tokens.
      S + ", " + S + " * { box-sizing: border-box; }",
      S + " { color: var(--trace-page-ink); font-family: " + font + "; font-size: 15px; font-weight: 400; inset: 0; letter-spacing: 0; line-height: 1.35; position: fixed; text-align: left; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; z-index: 2147483646; }",
      S + " button { " + buttonReset + " }",
      S + " h2, " + S + " p, " + S + " dl, " + S + " dt, " + S + " dd, " + S + " label { background: none; border: 0; color: inherit; float: none; font: inherit; margin: 0; padding: 0; text-align: left; text-transform: none; }",
      S + " svg { display: block; }",
      S + " :focus { outline: none; }",
      S + " :focus-visible { outline: 3px solid var(--trace-page-teal) !important; outline-offset: 2px; }",
      // Headings and the delete question take focus only to be read out.
      S + " [tabindex='-1']:focus-visible { outline: none !important; }",
      S + " .trace-sf-scrim { background: var(--trace-page-scrim); inset: 0; position: absolute; }",
      S + " .trace-sf-sheet { background: var(--trace-page-surface); border-radius: 20px 20px 0 0; bottom: 0; box-shadow: 0 0 0 1px var(--trace-page-rule), 0 14px 30px -12px rgba(0, 0, 0, 0.35); display: flex; flex-direction: column; left: 0; margin: 0 auto; max-height: calc(100% - 8px); max-width: 430px; position: absolute; right: 0; width: 100%; }",
      S + " .trace-sf-grabber { align-items: center; cursor: grab; display: flex; flex: 0 0 auto; height: 24px; justify-content: center; touch-action: none; user-select: none; }",
      S + " .trace-sf-grabber span { background: var(--trace-page-secondary); border-radius: 999px; display: block; height: 4px; opacity: 0.6; width: 38px; }",
      S + " .trace-sf-sheet-content { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }",
      S + " .trace-sf-sheet-head { align-items: center; display: grid; flex: 0 0 auto; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; min-height: 52px; padding: 0 9px 4px 16px; }",
      S + " .trace-sf-sheet-head[data-kind='editor'] { grid-template-columns: minmax(64px, 1fr) auto minmax(64px, 1fr); padding: 0 8px 4px; }",
      S + " .trace-sf-sheet-title { color: var(--trace-page-ink); font-size: 17px; font-weight: 600; line-height: 1.25; " + ellipsis + " }",
      S + " .trace-sf-sheet-close { align-items: center; color: var(--trace-page-secondary); display: inline-flex; height: 44px; justify-content: center; width: 44px; }",
      S + " .trace-sf-sheet-close span { align-items: center; background: var(--trace-page-raised); border-radius: 15px; display: inline-flex; height: 30px; justify-content: center; width: 30px; }",
      S + " .trace-sf-sheet-close svg { height: 10px; width: 10px; }",
      S + " .trace-sf-sheet-hbtn { align-items: center; color: var(--trace-page-teal); display: inline-flex; font-size: 16px; min-height: 44px; padding: 0 8px; }",
      S + " .trace-sf-sheet-hbtn[data-side='start'] { color: var(--trace-page-secondary); justify-self: start; }",
      S + " .trace-sf-sheet-hbtn[data-side='end'] { font-weight: 600; justify-self: end; }",
      S + " .trace-sf-sheet-hbtn:disabled { cursor: default; opacity: 0.45; }",
      // Safari's floating toolbar covers the page's bottom edge.
      S + " .trace-sf-sheet-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px calc(80px + env(safe-area-inset-bottom, 0px)); -webkit-overflow-scrolling: touch; }",
      S + " .trace-sf-sheet-label { color: var(--trace-page-secondary); display: block; font-size: 13px; font-weight: 500; line-height: 1.35; padding: 14px 4px 6px; }",
      S + " .trace-sf-sheet-body > .trace-sf-sheet-label:first-child { padding-top: 4px; }",
      S + " .trace-sf-sheet-group { border-radius: 14px; box-shadow: inset 0 0 0 1px var(--trace-page-rule); }",
      S + " .trace-sf-sheet-row { align-items: center; display: grid; grid-template-columns: minmax(0, 1fr) 44px; min-height: 56px; position: relative; }",
      S + " .trace-sf-sheet-row + .trace-sf-sheet-row::before, " + S + " .trace-sf-sheet-opt + .trace-sf-sheet-opt::before, " + S + " .trace-sf-sheet-keep + .trace-sf-sheet-keep::before { border-top: 1px solid var(--trace-page-rule); content: ''; left: 12px; position: absolute; right: 0; top: 0; }",
      S + " .trace-sf-sheet-main { align-items: start; display: grid; grid-template-columns: 26px minmax(0, 1fr); min-height: 56px; min-width: 0; padding: 10px 0 10px 10px; width: 100%; }",
      S + " .trace-sf-sheet-check { color: var(--trace-page-ink); height: 16px; margin-top: 2px; width: 16px; }",
      S + " .trace-sf-sheet-check svg { height: 16px; width: 16px; }",
      S + " .trace-sf-sheet-text { min-width: 0; }",
      S + " .trace-sf-sheet-name { color: var(--trace-page-ink); font-size: 16px; font-weight: 500; line-height: 1.3; " + ellipsis + " }",
      S + " .trace-sf-sheet-main[aria-current='true'] .trace-sf-sheet-name { font-weight: 600; }",
      S + " .trace-sf-tokens { color: var(--trace-page-secondary); font-size: 13px; line-height: 1.4; margin-top: 2px; " + ellipsis + " }",
      S + " .trace-sf-sheet-more { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; height: 44px; justify-content: center; width: 44px; }",
      S + " .trace-sf-sheet-more svg { height: 18px; width: 18px; }",
      S + " .trace-sf-sheet-action { align-items: center; color: var(--trace-page-teal); display: flex; font-size: 15px; font-weight: 600; gap: 8px; min-height: 48px; padding: 0 12px; width: 100%; }",
      S + " .trace-sf-sheet-action + .trace-sf-sheet-action { border-top: 1px solid var(--trace-page-rule); }",
      S + " .trace-sf-sheet-action svg { flex: 0 0 auto; height: 14px; width: 14px; }",
      S + " .trace-sf-sheet-action[data-danger='true'] { color: var(--trace-page-warning); }",
      S + " .trace-sf-sheet-changed { color: var(--trace-page-secondary); font-size: 14px; line-height: 1.4; padding: 12px 12px 0; overflow-wrap: anywhere; }",
      S + " .trace-sf-sheet-changed b { color: var(--trace-page-ink); font-weight: 600; }",
      S + " .trace-sf-sheet-input-row { display: block; position: relative; }",
      S + " .trace-sf-sheet-input { -webkit-appearance: none; appearance: none; background: var(--trace-page-surface); border: 0; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--trace-page-control); color: var(--trace-page-ink); font: 16px/1.3 " + font + "; height: auto; margin: 0; min-height: 48px; padding: 12px 44px 12px 14px; width: 100%; }",
      S + " .trace-sf-sheet-input::placeholder { color: var(--trace-page-secondary); }",
      S + " .trace-sf-sheet-clear { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; height: 44px; justify-content: center; position: absolute; right: 2px; top: 2px; width: 44px; }",
      S + " .trace-sf-sheet-clear span { align-items: center; background: var(--trace-page-raised); border-radius: 9px; display: inline-flex; height: 18px; justify-content: center; width: 18px; }",
      S + " .trace-sf-sheet-clear svg { height: 8px; width: 8px; }",
      S + " .trace-sf-sheet-input:placeholder-shown + .trace-sf-sheet-clear { display: none; }",
      S + " .trace-sf-sheet-opt { align-items: center; display: grid; gap: 12px; grid-template-columns: 22px minmax(0, 1fr); min-height: 56px; padding: 9px 12px; position: relative; width: 100%; }",
      S + " .trace-sf-sheet-radio { border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--trace-page-tertiary); height: 22px; position: relative; width: 22px; }",
      S + " .trace-sf-sheet-opt[aria-checked='true'] .trace-sf-sheet-radio { box-shadow: inset 0 0 0 1.5px var(--trace-page-teal); }",
      S + " .trace-sf-sheet-opt[aria-checked='true'] .trace-sf-sheet-radio::after { background: var(--trace-page-teal); border-radius: 50%; content: ''; inset: 6px; position: absolute; }",
      S + " .trace-sf-sheet-opt-text { min-width: 0; }",
      S + " .trace-sf-sheet-opt-title { display: block; font-size: 16px; line-height: 1.3; overflow-wrap: anywhere; }",
      S + " .trace-sf-sheet-opt-cap { color: var(--trace-page-secondary); display: block; font-size: 13px; line-height: 1.35; }",
      S + " .trace-sf-sheet-keep { display: grid; gap: 12px; grid-template-columns: 84px minmax(0, 1fr); padding: 10px 12px; position: relative; }",
      S + " .trace-sf-sheet-keep dt { color: var(--trace-page-secondary); font-size: 13px; line-height: 1.4; padding-top: 1px; }",
      S + " .trace-sf-sheet-keep dd { color: var(--trace-page-ink); font-size: 15px; line-height: 1.4; overflow-wrap: anywhere; }",
      S + " .trace-sf-sheet-note { color: var(--trace-page-secondary); font-size: 14px; line-height: 1.4; padding: 10px 4px 0; }",
      S + " .trace-sf-sheet-confirm { padding: 12px 12px 4px; }",
      S + " .trace-sf-sheet-confirm-title { color: var(--trace-page-ink); display: block; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }",
      S + " .trace-sf-sheet-confirm-detail { color: var(--trace-page-secondary); display: block; font-size: 13px; line-height: 1.4; margin-top: 2px; }",
      S + " .trace-sf-sheet-confirm-actions { display: flex; flex-wrap: wrap; gap: 0 16px; margin-top: 4px; }",
      S + " .trace-sf-sheet-confirm-actions button { align-items: center; color: var(--trace-page-secondary); display: inline-flex; font-size: 15px; font-weight: 500; min-height: 44px; min-width: 44px; padding: 0 4px; }",
      S + " .trace-sf-sheet-confirm-actions button[data-danger='true'] { color: var(--trace-page-warning); font-weight: 600; }",
      S + " .trace-sf-sheet-error { align-items: center; color: var(--trace-page-ink); display: flex; flex-wrap: wrap; font-size: 14px; gap: 0 16px; line-height: 1.4; min-height: 44px; padding: 4px 4px 0; }",
      S + " .trace-sf-sheet-error-text { align-items: center; display: flex; flex: 1 1 10rem; gap: 6px; min-width: 0; }",
      S + " .trace-sf-sheet-error svg { color: var(--trace-page-warning); flex: 0 0 auto; height: 14px; width: 14px; }",
      S + " .trace-sf-sheet-error button { color: var(--trace-page-teal); font-weight: 500; min-height: 44px; }",
      "@media (prefers-reduced-motion: reduce) { " + S + " .trace-sf-sheet { transition: none !important; } }",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------- render
  // A redraw (a pull, a save) keeps focus on the same control.
  function focusKey(element) {
    if (!element || !element.getAttribute) return "";
    var action = element.getAttribute("data-trace-sf-action");
    if (action) {
      var id = element.getAttribute("data-id");
      return "[data-trace-sf-action='" + action + "']" + (id ? "[data-id='" + cssEscape(id) + "']" : "");
    }
    if (element.id) return "#" + cssEscape(element.id);
    return element.classList && element.classList.contains("trace-sf-sheet-title") ? ".trace-sf-sheet-title" : "";
  }

  function replaceKeepingFocus(container, html) {
    var active = document.activeElement;
    var key = active && container.contains(active) ? focusKey(active) : "";
    replaceRootWithUiMarkup(container, html);
    if (!key) return;
    var next = container.querySelector(key);
    if (!next) return;
    try {
      next.focus({ preventScroll: true });
    } catch (_) {
      next.focus();
    }
  }

  function renderPhone(presets, relation) {
    replaceKeepingFocus(state.root, renderColumn(presets, relation));
    renderLine(relation);
    renderSheet();
  }

  function renderColumn(presets, relation) {
    var quick = orderedPresets(presets, relation).slice(0, COLUMN_QUICK_COUNT);
    var activeId = relation.type === "active" && relation.preset ? relation.preset.id : "";
    var unsaved = relation.type === "unsaved" || relation.type === "edited";
    var html = "<div class='trace-sf-col' role='group' aria-labelledby='trace-sf-col-title'>";
    html += "<div class='trace-sf-col-title' id='trace-sf-col-title'>Saved filters</div>";
    if (state.notice) html += renderNote(state.notice);
    if (quick.length) {
      html += "<div class='trace-sf-col-rows'>" + quick.map(function (preset) {
        var isActive = preset.id === activeId;
        return (
          "<button type='button' class='trace-sf-col-row' data-trace-sf-action='apply' data-id='" + escapeAttr(preset.id) + "'" +
          (isActive ? " aria-current='true' aria-label='" + escapeAttr(preset.name + ". Showing now.") + "'" : "") + ">" +
          "<span class='trace-sf-edge'>" + (isActive ? renderCheckIcon() : "") + "</span>" +
          "<span class='trace-sf-col-name'>" + escapeHtml(preset.name) + "</span>" +
          "</button>"
        );
      }).join("") + "</div>";
    }
    if (unsaved && !isAtSavedFilterLimit()) {
      html += "<button type='button' class='trace-sf-col-link' data-kind='save' data-trace-sf-action='sheet-save' aria-haspopup='dialog'>" + renderPlusIcon() + "<span class='trace-sf-col-link-text'>Save these filters</span></button>";
    }
    if (presets.length) {
      html += "<button type='button' class='trace-sf-col-link' data-trace-sf-action='sheet-open' aria-haspopup='dialog'><span class='trace-sf-col-link-text'>All saved filters (" + presets.length + ")</span>" + renderChevronRight() + "</button>";
    } else if (!unsaved) {
      html += renderNote("Choose filters below, then save them here after Sort and Filter.");
    }
    return html + "</div>";
  }

  function renderPlusIcon() {
    return "<svg viewBox='0 0 14 14' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' focusable='false' aria-hidden='true'><path d='M7 2v10M2 7h10'/></svg>";
  }

  function renderChevronRight() {
    return "<svg viewBox='0 0 12 12' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' focusable='false' aria-hidden='true'><path d='M4.5 2.5L8 6l-3.5 3.5'/></svg>";
  }

  function renderCloseIcon() {
    return "<svg viewBox='0 0 12 12' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' focusable='false' aria-hidden='true'><path d='M1.5 1.5l9 9M10.5 1.5l-9 9'/></svg>";
  }

  function renderMoreIcon() {
    return "<svg viewBox='0 0 18 18' fill='currentColor' focusable='false' aria-hidden='true'><circle cx='3.5' cy='9' r='1.5'/><circle cx='9' cy='9' r='1.5'/><circle cx='14.5' cy='9' r='1.5'/></svg>";
  }

  // "✓ Showing {name}" above the works, only while a saved filter is applied.
  function lineMountPoint() {
    var go = document.getElementById("go_to_filters");
    if (!go || !go.closest) return null;
    var row = go.closest("div.navigation") || go.closest("ul");
    return row && row.parentNode ? row : null;
  }

  function renderLine(relation) {
    var row = relation.type === "active" && relation.preset ? lineMountPoint() : null;
    if (!row) {
      removeLine();
      return;
    }
    if (!state.line || !state.line.isConnected) {
      var line = document.createElement("div");
      line.className = "trace-sf-line";
      line.setAttribute(LINE_ATTR, "");
      bindTraceEvents(line, true);
      state.line = line;
    }
    if (state.line.previousSibling !== row || state.line.parentNode !== row.parentNode) {
      row.parentNode.insertBefore(state.line, row.nextSibling);
    }
    applyPageTokens(state.line);
    var name = relation.preset.name;
    replaceKeepingFocus(state.line,
      "<button type='button' data-trace-sf-action='sheet-open' aria-haspopup='dialog' aria-label='" + escapeAttr("Showing " + name + ". Saved filters") + "'>" +
      "<span class='trace-sf-check'>" + renderCheckIcon() + "</span>" +
      "<span class='trace-sf-line-text'>Showing <b>" + escapeHtml(name) + "</b></span>" +
      "<span class='trace-sf-line-more'>" + renderChevronRight() + "</span>" +
      "</button>");
  }

  function removeLine() {
    if (state.line && state.line.parentNode) state.line.parentNode.removeChild(state.line);
    state.line = null;
  }

  function bindTraceEvents(element, capture) {
    element.addEventListener("click", handleClick, capture);
    ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"].forEach(function (type) {
      element.addEventListener(type, handlePointerDown, capture);
    });
    element.addEventListener("keydown", handleKeyDown, capture);
    element.addEventListener("input", handleInput, capture);
    element.addEventListener("submit", stopTraceEvent, capture);
  }

  // ----------------------------------------------------------------- sheet
  function openSheet(kind, opener) {
    if (!state.narrow) return;
    if (opener && opener.getAttribute) {
      var action = opener.getAttribute("data-trace-sf-action");
      state.sheetOpener = state.line && state.line.contains(opener)
        ? ".trace-sf-line [data-trace-sf-action='" + action + "']"
        : "[data-trace-sf-action='" + action + "']";
    }
    state.sheet = kind;
    state.sheetFrom = null;
    state.confirmDeleteId = null;
    clearMessages();
    render();
    focusSheetTitle();
  }

  function openSheetSave(opener) {
    state.current = getCurrentFilterState();
    var fromList = state.sheet === "list";
    if (!state.sheet) openSheet("list", opener);
    clearMessages();
    if (isAtSavedFilterLimit() || !state.current.canSave) {
      state.sheet = "list";
      render();
      return;
    }
    state.sheet = "save";
    state.sheetFrom = fromList ? "list" : null;
    state.draftName = suggestedNameForCurrent();
    state.draftScope = hasReusableContext() ? "context" : "global";
    render();
    focusSheetTitle();
  }

  function openSheetEdit(id) {
    var preset = findPreset(id);
    if (!preset) return;
    state.sheet = "edit";
    state.sheetFrom = "list";
    state.editId = id;
    state.editName = preset.name;
    state.editScope = preset.scope === "global" ? "global" : "context";
    state.confirmDeleteId = null;
    clearMessages();
    render();
    focusSheetTitle();
  }

  function showSheetList(focusSelector) {
    state.sheet = "list";
    state.sheetFrom = null;
    state.editId = null;
    state.confirmDeleteId = null;
    clearMessages();
    render();
    if (focusSelector && queryTrace(focusSelector)) focusSoon(focusSelector);
    else focusSheetTitle();
  }

  function sheetBack() {
    var editedId = state.sheet === "edit" ? state.editId : null;
    if (state.sheetFrom === "list") {
      showSheetList(editedId ? "[data-trace-sf-action='sheet-edit'][data-id='" + cssEscape(editedId) + "']" : "");
    } else {
      closeSheet(true);
    }
  }

  function focusSheetTitle() {
    focusSoon(".trace-sf-sheet-title");
  }

  function ensureSheetHost() {
    if (state.sheetHost && state.sheetHost.isConnected) return;
    var host = document.createElement("div");
    host.className = "trace-sf-sheet-host";
    host.setAttribute(SHEET_ATTR, "");
    var scrim = document.createElement("div");
    scrim.className = "trace-sf-scrim";
    scrim.setAttribute("data-trace-sf-action", "sheet-close");
    var sheet = document.createElement("section");
    sheet.className = "trace-sf-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "trace-sf-sheet-title");
    var grabber = document.createElement("div");
    grabber.className = "trace-sf-grabber";
    grabber.setAttribute("aria-hidden", "true");
    grabber.appendChild(document.createElement("span"));
    var content = document.createElement("div");
    content.className = "trace-sf-sheet-content";
    sheet.appendChild(grabber);
    sheet.appendChild(content);
    host.appendChild(scrim);
    host.appendChild(sheet);
    // Bubble phase, so the grabber's own drag handlers run first.
    bindTraceEvents(host, false);
    bindDragClose(sheet, grabber);
    document.documentElement.appendChild(host);
    state.sheetHost = host;
    state.sheetPanel = content;
    lockPageScroll();
    addViewportListeners();
  }

  function renderSheet() {
    if (!state.sheet || !state.narrow) {
      closeSheet(false);
      return;
    }
    // A pull landing while the reader types must not take the field away.
    if (state.fromStorage && state.sheet !== "list" && state.sheetHost && state.sheetHost.contains(document.activeElement) &&
      document.activeElement.tagName === "INPUT") {
      return;
    }
    ensureSheetHost();
    applyPageTokens(state.sheetHost);
    var html = state.sheet === "save" ? renderSheetSave() : state.sheet === "edit" ? renderSheetEdit() : renderSheetList();
    replaceKeepingFocus(state.sheetPanel, html);
    fitTokenLines(state.sheetPanel);
    positionSheet();
  }

  function closeSheet(restoreFocus, preferLine) {
    if (!state.sheetHost && !state.sheet) return;
    state.sheet = null;
    state.sheetFrom = null;
    state.editId = null;
    state.confirmDeleteId = null;
    if (state.sheetHost && state.sheetHost.parentNode) state.sheetHost.parentNode.removeChild(state.sheetHost);
    state.sheetHost = null;
    state.sheetPanel = null;
    removeViewportListeners();
    unlockPageScroll();
    var opener = state.sheetOpener;
    state.sheetOpener = "";
    if (!restoreFocus) return;
    // After a save the page redraws first, so choose the target once it has.
    setTimeout(function () {
      var lineButton = ".trace-sf-line [data-trace-sf-action='sheet-open']";
      var target = (preferLine && queryTrace(lineButton)) ||
        (opener && queryTrace(opener)) ||
        queryTrace(lineButton) ||
        queryTrace("[data-trace-sf-action='sheet-open']");
      if (target) target.focus();
    }, 0);
  }

  function sheetHeader(title) {
    return (
      "<header class='trace-sf-sheet-head'>" +
      "<h2 class='trace-sf-sheet-title' id='trace-sf-sheet-title' tabindex='-1'>" + escapeHtml(title) + "</h2>" +
      "<button type='button' class='trace-sf-sheet-close' data-trace-sf-action='sheet-close' aria-label='Close saved filters'><span>" + renderCloseIcon() + "</span></button>" +
      "</header>"
    );
  }

  function editorHeader(title, endLabel, endAction, endDisabled) {
    return (
      "<header class='trace-sf-sheet-head' data-kind='editor'>" +
      "<button type='button' class='trace-sf-sheet-hbtn' data-side='start' data-trace-sf-action='sheet-back'>Cancel</button>" +
      "<h2 class='trace-sf-sheet-title' id='trace-sf-sheet-title' tabindex='-1'>" + escapeHtml(title) + "</h2>" +
      "<button type='button' class='trace-sf-sheet-hbtn' data-side='end' data-trace-sf-action='" + endAction + "'" + (endDisabled ? " disabled" : "") + ">" + escapeHtml(endLabel) + "</button>" +
      "</header>"
    );
  }

  function renderSheetError() {
    if (!state.error) return "";
    return (
      "<div class='trace-sf-sheet-error' role='alert'>" +
      "<span class='trace-sf-sheet-error-text'>" + renderAlertIcon() + "<span>" + escapeHtml(state.error) + "</span></span>" +
      (state.retry ? "<button type='button' data-trace-sf-action='retry'>Try again</button>" : "") +
      "</div>"
    );
  }

  function renderSheetList() {
    var presets = visiblePresetsForCurrent(state.presets, state.current);
    var relation = relationForCurrent(presets, state.activeMeta, state.current);
    var ordered = orderedPresets(presets, relation);
    var atLimit = isAtSavedFilterLimit();
    var body = renderSheetError();
    if (relation.type === "edited" && relation.preset) {
      body += (
        "<div class='trace-sf-sheet-group' style='margin-top: 4px'>" +
        "<p class='trace-sf-sheet-changed'><b>" + escapeHtml(relation.preset.name) + "</b>, changed</p>" +
        "<button type='button' class='trace-sf-sheet-action' data-trace-sf-action='update-current' data-id='" + escapeAttr(relation.preset.id) + "'>Update filter</button>" +
        (atLimit ? "" : "<button type='button' class='trace-sf-sheet-action' data-trace-sf-action='sheet-save'>Save as new</button>") +
        "</div>"
      );
    } else if (relation.type === "unsaved" && !atLimit) {
      body += "<div class='trace-sf-sheet-group' style='margin-top: 4px'><button type='button' class='trace-sf-sheet-action' data-trace-sf-action='sheet-save'>" + renderPlusIcon() + "Save the filters on this page</button></div>";
    }
    if (atLimit && (relation.type === "unsaved" || relation.type === "edited")) {
      body += "<p class='trace-sf-sheet-note'>" + escapeHtml(savedFilterLimitMessage()) + "</p>";
    }
    function section(list, label, scope) {
      if (!list.length) return;
      body += "<div class='trace-sf-sheet-label' id='trace-sf-section-" + scope + "'>" + escapeHtml(label) + "</div>";
      body += "<div class='trace-sf-sheet-group' role='list' aria-labelledby='trace-sf-section-" + scope + "'>" + list.map(function (preset) {
        return renderSheetRow(preset, relation);
      }).join("") + "</div>";
    }
    section(ordered.filter(function (preset) { return preset.scope !== "global"; }), hasReusableContext() ? "This tag" : "This page", "context");
    section(ordered.filter(function (preset) { return preset.scope === "global"; }), "Every AO3 search", "global");
    if (!ordered.length) body += "<p class='trace-sf-sheet-note'>No saved filters show here yet.</p>";
    return sheetHeader("Saved filters") + "<div class='trace-sf-sheet-body'>" + body + "</div>";
  }

  function renderSheetRow(preset, relation) {
    var isActive = relation.type === "active" && relation.preset && relation.preset.id === preset.id;
    var short = tokensForPairs(preset.params, preset.summary);
    var full = tokenText(short.tokens, short.tokens.length, short.hidden);
    var label = preset.name + (isActive ? ". Showing now" : "") + ". " + full + ". Apply.";
    return (
      "<div class='trace-sf-sheet-row' role='listitem' data-id='" + escapeAttr(preset.id) + "' data-scope='" + (preset.scope === "global" ? "global" : "context") + "'>" +
      "<button type='button' class='trace-sf-sheet-main' data-trace-sf-action='apply' data-id='" + escapeAttr(preset.id) + "' aria-label='" + escapeAttr(label) + "'" + (isActive ? " aria-current='true'" : "") + ">" +
      "<span class='trace-sf-sheet-check'>" + (isActive ? renderCheckIcon() : "") + "</span>" +
      "<span class='trace-sf-sheet-text'>" +
      "<span class='trace-sf-sheet-name'>" + escapeHtml(preset.name) + "</span>" +
      "<span class='trace-sf-tokens' data-trace-sf-tokens='" + escapeAttr(JSON.stringify(short.tokens)) + "' data-trace-sf-hidden='" + short.hidden + "'>" + escapeHtml(full) + "</span>" +
      "</span>" +
      "</button>" +
      "<button type='button' class='trace-sf-sheet-more' data-trace-sf-action='sheet-edit' data-id='" + escapeAttr(preset.id) + "' aria-label='" + escapeAttr("Edit " + preset.name) + "'>" + renderMoreIcon() + "</button>" +
      "</div>"
    );
  }

  function renderSheetName(id, value, placeholder, dataAttr, clearAction) {
    return (
      "<label class='trace-sf-sheet-label' for='" + id + "'>Name</label>" +
      "<span class='trace-sf-sheet-input-row'>" +
      "<input id='" + id + "' class='trace-sf-sheet-input' type='text' " + dataAttr + " maxlength='" + MAX_NAME_LENGTH + "' autocomplete='off' autocapitalize='sentences' enterkeyhint='done' placeholder='" + escapeAttr(placeholder) + "' value='" + escapeAttr(value) + "'>" +
      "<button type='button' class='trace-sf-sheet-clear' data-trace-sf-action='" + clearAction + "' aria-label='Clear name'><span>" + renderCloseIcon() + "</span></button>" +
      "</span>"
    );
  }

  function renderSheetScope(value, prefix) {
    if (!hasReusableContext()) {
      return "<div class='trace-sf-sheet-label'>Use it on</div><p class='trace-sf-sheet-note' style='padding-top: 0'>Every AO3 search. This page has no tag.</p>";
    }
    function option(scope, title, caption) {
      var checked = value === scope;
      return (
        "<button type='button' class='trace-sf-sheet-opt' role='radio' data-trace-sf-action='" + prefix + scope + "' aria-checked='" + (checked ? "true" : "false") + "' tabindex='" + (checked ? "0" : "-1") + "'>" +
        "<span class='trace-sf-sheet-radio' aria-hidden='true'></span>" +
        "<span class='trace-sf-sheet-opt-text'><span class='trace-sf-sheet-opt-title'>" + escapeHtml(title) + "</span><span class='trace-sf-sheet-opt-cap'>" + escapeHtml(caption) + "</span></span>" +
        "</button>"
      );
    }
    return (
      "<div class='trace-sf-sheet-label' id='trace-sf-scope-label'>Use it on</div>" +
      "<div class='trace-sf-sheet-group' role='radiogroup' aria-labelledby='trace-sf-scope-label'>" +
      option("context", displayContextLabel(), "Only this tag") +
      option("global", "Every AO3 search", "Any tag or search") +
      "</div>"
    );
  }

  function renderSheetKeeps(pairs, summary) {
    var groups = presetGroups(pairs, summary).groups;
    if (!groups.length) return "";
    return (
      "<div class='trace-sf-sheet-label' id='trace-sf-keeps-label'>What it keeps</div>" +
      "<dl class='trace-sf-sheet-group' aria-labelledby='trace-sf-keeps-label'>" +
      groups.map(function (group) {
        var value = group.stored ? group.stored.replace(/^(?:Include|Exclude) /, "") : group.values.join(", ");
        return "<div class='trace-sf-sheet-keep'><dt>" + escapeHtml(group.label) + "</dt><dd>" + escapeHtml(value) + "</dd></div>";
      }).join("") +
      "</dl>"
    );
  }

  function renderSheetSave() {
    var pairs = state.current ? state.current.pairs : [];
    var canSave = Boolean(state.current && state.current.canSave);
    return (
      editorHeader("Save filters", "Save", "save-confirm", !canSave) +
      "<div class='trace-sf-sheet-body' data-trace-sf-save-form>" +
      renderSheetError() +
      renderSheetName("trace-sf-name-input", state.draftName || "", suggestedNameForCurrent(), "data-trace-sf-name", "name-clear") +
      renderSheetScope(state.draftScope === "global" ? "global" : "context", "scope-") +
      renderSheetKeeps(pairs, []) +
      (state.presets.length >= SAVED_FILTER_LIMIT_WARNING_THRESHOLD
        ? "<p class='trace-sf-sheet-note'>" + state.presets.length + " of " + SAVED_FILTER_ACTIVE_LIMIT + " saved filters used</p>"
        : "") +
      "</div>"
    );
  }

  // Update is offered only when this page's filters would change the filter.
  function canUpdateWithCurrent(preset) {
    return Boolean(state.current && state.current.canSave && preset && !samePairSet(preset.params, state.current.pairs));
  }

  function renderSheetEdit() {
    var preset = findPreset(state.editId);
    if (!preset) {
      state.sheet = "list";
      return renderSheetList();
    }
    var html = editorHeader("Edit filter", "Done", "edit-done", false) + "<div class='trace-sf-sheet-body'>" + renderSheetError();
    html += renderSheetName("trace-sf-edit-name-input", state.editName, preset.name, "data-trace-sf-edit-name", "edit-name-clear");
    html += renderSheetKeeps(preset.params, preset.summary);
    html += renderSheetScope(state.editScope, "edit-scope-");
    if (canUpdateWithCurrent(preset)) {
      html += "<div class='trace-sf-sheet-label'>This page</div><div class='trace-sf-sheet-group'><button type='button' class='trace-sf-sheet-action' data-trace-sf-action='update-current' data-id='" + escapeAttr(preset.id) + "'>Update with this page's filters</button></div>";
    }
    html += "<div class='trace-sf-sheet-label' aria-hidden='true'>&nbsp;</div><div class='trace-sf-sheet-group'>";
    if (state.confirmDeleteId === preset.id) {
      html += (
        "<div class='trace-sf-sheet-confirm' role='group' tabindex='-1' aria-labelledby='trace-sf-delete-title'>" +
        "<span class='trace-sf-sheet-confirm-title' id='trace-sf-delete-title'>Delete “" + escapeHtml(preset.name) + "”?</span>" +
        "<span class='trace-sf-sheet-confirm-detail'>It's deleted on every device. Nothing on AO3 changes.</span>" +
        "<span class='trace-sf-sheet-confirm-actions'>" +
        "<button type='button' data-danger='true' data-trace-sf-action='delete' data-id='" + escapeAttr(preset.id) + "'>Delete</button>" +
        "<button type='button' data-trace-sf-action='delete-cancel'>Cancel</button>" +
        "</span>" +
        "</div>"
      );
    } else {
      html += "<button type='button' class='trace-sf-sheet-action' data-danger='true' data-trace-sf-action='delete-confirm' data-id='" + escapeAttr(preset.id) + "'>Delete filter</button>";
    }
    return html + "</div></div>";
  }

  function setEditScope(scope, keepFocus) {
    if (scope === "context" && !hasReusableContext()) return;
    state.editScope = scope === "global" ? "global" : "context";
    render();
    if (keepFocus !== false) focusSoon("[role='radio'][aria-checked='true']");
  }

  function clearEditName() {
    state.editName = "";
    render();
    focusSoon("[data-trace-sf-edit-name]");
  }

  // Done keeps a new name and where the filter shows; nothing else changes.
  async function finishEdit() {
    var preset = findPreset(state.editId);
    if (!preset) return showSheetList();
    var name = currentNameInputValue("[data-trace-sf-edit-name]") || preset.name;
    state.editName = name;
    var scope = hasReusableContext() ? (state.editScope === "global" ? "global" : "context") : preset.scope;
    if (name === preset.name && scope === preset.scope) {
      return showSheetList("[data-trace-sf-action='sheet-edit'][data-id='" + cssEscape(preset.id) + "']");
    }
    var now = new Date().toISOString();
    var keepContext = preset.scope === "context" && preset.contextKey;
    var presets = state.presets.map(function (item) {
      if (item.id !== preset.id) return item;
      return Object.assign({}, item, {
        name: name,
        scope: scope,
        contextKey: scope === "context" ? (keepContext ? item.contextKey : state.current.contextKey) : "",
        contextLabel: scope === "context" ? (keepContext ? item.contextLabel : state.current.contextLabel) : "",
        updatedAt: now,
        clientUpdatedAt: now,
        dirty: true,
      });
    });
    var id = preset.id;
    await commitStorage(presets, state.activeMeta, function () {
      showSheetList("[data-trace-sf-action='sheet-edit'][data-id='" + cssEscape(id) + "']");
    }, null, { kind: "edit", id: id });
  }

  // Escape steps back one level; Tab stays inside the sheet.
  function handleSheetKeyDown(event) {
    if (!state.sheetHost || !state.sheetHost.contains(event.target)) return false;
    if (event.key === "Escape" || event.key === "Esc") {
      stopTraceEvent(event);
      if (state.confirmDeleteId) cancelRowMode();
      else if (state.sheet !== "list" && state.sheetFrom === "list") sheetBack();
      else closeSheet(true);
      return true;
    }
    if (event.key !== "Tab") return false;
    var focusable = Array.prototype.slice.call(state.sheetHost.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )).filter(function (el) {
      return el.getAttribute("tabindex") !== "-1";
    });
    if (!focusable.length) return false;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    var active = document.activeElement;
    if (event.shiftKey && (active === first || !state.sheetHost.contains(active) || active.classList.contains("trace-sf-sheet-title"))) {
      stopTraceEvent(event);
      last.focus();
      return true;
    }
    if (!event.shiftKey && active === last) {
      stopTraceEvent(event);
      first.focus();
      return true;
    }
    stopTracePropagation(event);
    return true;
  }

  // ------------------------------------------- the listing sheet's mechanics
  var pageScrollLock = null;

  function lockPageScroll() {
    if (pageScrollLock) return;
    var html = document.documentElement;
    var body = document.body;
    pageScrollLock = {
      x: window.scrollX || 0,
      y: window.scrollY || 0,
      html: html ? html.style.overflow : "",
      body: body ? body.style.cssText : "",
      inert: body ? body.hasAttribute("inert") : false,
    };
    if (html) html.style.overflow = "hidden";
    if (body) {
      body.style.overflow = "hidden";
      body.style.position = "fixed";
      body.style.top = -pageScrollLock.y + "px";
      body.style.left = -pageScrollLock.x + "px";
      body.style.right = "0";
      body.style.width = "100%";
      body.setAttribute("inert", "");
    }
  }

  function unlockPageScroll() {
    if (!pageScrollLock) return;
    var lock = pageScrollLock;
    pageScrollLock = null;
    if (document.documentElement) document.documentElement.style.overflow = lock.html;
    if (document.body) {
      document.body.style.cssText = lock.body;
      if (!lock.inert) document.body.removeAttribute("inert");
    }
    try {
      if ((window.scrollX || 0) !== lock.x || (window.scrollY || 0) !== lock.y) window.scrollTo(lock.x, lock.y);
    } catch (_) {
      /* jsdom and old engines */
    }
  }

  // Drag the grabber down to close; short drags settle back.
  function bindDragClose(surface, handle) {
    var startY = 0;
    var dragging = false;
    function y(event) {
      if (event.touches && event.touches.length) return event.touches[0].clientY;
      if (event.changedTouches && event.changedTouches.length) return event.changedTouches[0].clientY;
      return typeof event.clientY === "number" ? event.clientY : 0;
    }
    function reset() {
      dragging = false;
      surface.style.transition = "";
      surface.style.transform = "";
    }
    function start(event) {
      dragging = true;
      startY = y(event);
      if (event.cancelable) event.preventDefault();
      surface.style.transition = "none";
    }
    function move(event) {
      if (!dragging) return;
      if (event.cancelable) event.preventDefault();
      surface.style.transform = "translateY(" + Math.max(0, y(event) - startY) + "px)";
    }
    function end(event) {
      if (!dragging) return;
      if (event.cancelable) event.preventDefault();
      if (y(event) - startY >= 56) {
        reset();
        closeSheet(true);
        return;
      }
      if (prefersReducedMotion()) {
        reset();
        return;
      }
      surface.style.transition = "transform 160ms ease";
      surface.style.transform = "translateY(0)";
      setTimeout(reset, 180);
    }
    handle.addEventListener("pointerdown", start);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", reset);
    handle.addEventListener("touchstart", start, { passive: false });
    handle.addEventListener("touchmove", move, { passive: false });
    handle.addEventListener("touchend", end);
    handle.addEventListener("touchcancel", reset);
  }

  function prefersReducedMotion() {
    try {
      return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  // Safari lays the keyboard over fixed content: the sheet's bottom and
  // height follow the visual viewport so Save and the field stay above it.
  function positionSheet() {
    var sheet = state.sheetHost && state.sheetHost.querySelector(".trace-sf-sheet");
    var viewport = window.visualViewport;
    if (!sheet || !viewport) return;
    var covered = Math.max(0, (window.innerHeight || 0) - viewport.height - viewport.offsetTop);
    sheet.style.bottom = covered + "px";
    sheet.style.maxHeight = Math.max(160, viewport.height - 8) + "px";
  }

  function addViewportListeners() {
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", positionSheet);
      window.visualViewport.addEventListener("scroll", positionSheet);
    }
    window.addEventListener("resize", positionSheet);
  }

  function removeViewportListeners() {
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", positionSheet);
      window.visualViewport.removeEventListener("scroll", positionSheet);
    }
    window.removeEventListener("resize", positionSheet);
  }

  // Trace's own surfaces: the sheet while open, the panel or column, and
  // the Showing line.
  function traceContainers() {
    return [state.sheetPanel, state.root, state.line].filter(Boolean);
  }

  function insideTrace(node) {
    if (!node) return false;
    if (state.sheetHost && state.sheetHost.contains(node)) return true;
    if (state.root && state.root.contains(node)) return true;
    return Boolean(state.line && state.line.contains(node));
  }

  function queryTraceAll(selector) {
    var out = [];
    traceContainers().forEach(function (container) {
      out = out.concat(Array.prototype.slice.call(container.querySelectorAll(selector)));
    });
    return out;
  }

  function queryTrace(selector) {
    return queryTraceAll(selector)[0] || null;
  }

  function buttonActionFromEvent(event) {
    var target = event.target;
    if (!target || !target.closest) return null;
    var el = target.closest("[data-trace-sf-action]");
    if (!el || !insideTrace(el)) return null;
    return el;
  }

  function isTraceEvent(event) {
    return insideTrace(event && event.target);
  }

  function stopTraceEvent(event) {
    if (!event) return;
    event.preventDefault();
    stopTracePropagation(event);
  }

  function stopTracePropagation(event) {
    if (!event) return;
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function handlePointerDown(event) {
    if (!isTraceEvent(event)) return;
    stopTracePropagation(event);
  }

  function handleClick(event) {
    if (!isTraceEvent(event)) return;
    var el = buttonActionFromEvent(event);
    if (!el) {
      stopTracePropagation(event);
      return;
    }
    stopTraceEvent(event);
    dispatchAction(el);
  }

  function handleKeyDown(event) {
    if (!isTraceEvent(event)) return;
    if (state.sheet && handleSheetKeyDown(event)) return;
    if (event.key === "Escape" || event.key === "Esc") {
      if (state.menuId) {
        stopTraceEvent(event);
        closeMenu(true);
        return;
      }
      if (state.mode === "save") {
        stopTraceEvent(event);
        cancelSaveForm();
        return;
      }
    }
    var target = event.target;
    if (target && target.matches && target.matches("[role='radio']") && /^Arrow(?:Up|Down|Left|Right)$/.test(event.key)) {
      stopTraceEvent(event);
      if (String(target.getAttribute("data-trace-sf-action") || "").indexOf("edit-scope") === 0) {
        setEditScope(state.editScope === "global" ? "context" : "global");
        return;
      }
      setDraftScope(state.draftScope === "global" ? "context" : "global");
      focusSoon("[role='radio'][aria-checked='true']");
      return;
    }
    if (event.key !== "Enter") {
      stopTracePropagation(event);
      return;
    }
    if (target && target.matches && target.matches("[data-trace-sf-name]")) {
      stopTraceEvent(event);
      saveCurrentPreset();
      return;
    }
    if (target && target.matches && target.matches("[data-trace-sf-edit-name]")) {
      stopTraceEvent(event);
      finishEdit();
      return;
    }
    var renameInput = target && target.matches && target.matches("[data-trace-sf-rename-input]");
    if (renameInput && state.renameId) {
      stopTraceEvent(event);
      renamePreset(state.renameId);
      return;
    }
    stopTracePropagation(event);
  }

  function handleInput(event) {
    if (!isTraceEvent(event)) return;
    stopTracePropagation(event);
    var target = event.target;
    if (target && target.matches && target.matches("[data-trace-sf-name]")) {
      state.draftName = String(target.value || "").slice(0, MAX_NAME_LENGTH);
    }
    if (target && target.matches && target.matches("[data-trace-sf-rename-input]")) {
      state.renameDraft = String(target.value || "").slice(0, MAX_NAME_LENGTH);
    }
    if (target && target.matches && target.matches("[data-trace-sf-edit-name]")) {
      state.editName = String(target.value || "").slice(0, MAX_NAME_LENGTH);
    }
  }

  function dispatchAction(el) {
    var action = el.getAttribute("data-trace-sf-action");
    var id = el.getAttribute("data-id") || "";
    if (action === "save-open") return openSaveForm();
    if (action === "save-cancel") return cancelSaveForm();
    if (action === "save-confirm") return saveCurrentPreset();
    if (action === "name-clear") return clearDraftName();
    if (action === "scope-context") return setDraftScope("context", true);
    if (action === "scope-global") return setDraftScope("global", true);
    if (action === "toggle-panel") return togglePanel();
    if (action === "show-all") return showAllPresets();
    if (action === "retry") return retryLastChange();
    if (action === "apply") return applyPreset(id);
    if (action === "menu") return toggleMenu(id);
    if (action === "rename-open") return openRename(id);
    if (action === "rename-save") return renamePreset(id);
    if (action === "rename-cancel") return cancelRowMode();
    if (action === "delete-confirm") return confirmDelete(id);
    if (action === "delete") return deletePreset(id);
    if (action === "delete-cancel") return cancelRowMode();
    if (action === "update-current") return updatePresetToCurrent(id);
    if (action === "sheet-open") return openSheet("list", el);
    if (action === "sheet-save") return openSheetSave(el);
    if (action === "sheet-close") return closeSheet(true);
    if (action === "sheet-back") return sheetBack();
    if (action === "sheet-edit") return openSheetEdit(id);
    if (action === "edit-done") return finishEdit();
    if (action === "edit-name-clear") return clearEditName();
    if (action === "edit-scope-context") return setEditScope("context", true);
    if (action === "edit-scope-global") return setEditScope("global", true);
  }

  function clearMessages() {
    state.error = "";
    state.notice = "";
    state.retry = null;
  }

  function openSaveForm() {
    state.current = getCurrentFilterState();
    state.menuId = null;
    state.renameId = null;
    state.confirmDeleteId = null;
    clearMessages();
    if (isAtSavedFilterLimit()) {
      state.mode = "list";
      render();
      return;
    }
    state.mode = "save";
    state.panelCollapsed = false;
    // The suggested name is filled in and selected, so typing replaces it.
    state.draftName = suggestedNameForPairs(state.current.pairs);
    state.draftScope = hasReusableContext() ? "context" : "global";
    render();
    focusSoon("[data-trace-sf-name]", true);
  }

  function cancelSaveForm() {
    cancelInlineModes();
    focusSoon("[data-trace-sf-action='save-open']");
  }

  function setDraftScope(scope, keepFocus) {
    if (scope === "context" && !hasReusableContext()) return;
    state.draftScope = scope === "global" ? "global" : "context";
    render();
    if (keepFocus) focusSoon("[role='radio'][aria-checked='true']");
  }

  function clearDraftName() {
    state.draftName = "";
    render();
    focusSoon("[data-trace-sf-name]");
  }

  function togglePanel() {
    state.panelCollapsed = !state.panelCollapsed;
    persistPanelCollapsed(state.panelCollapsed);
    render();
    focusSoon("[data-trace-sf-action='toggle-panel']");
  }

  function showAllPresets() {
    state.showAll = true;
    render();
    focusSoon(".trace-sf-main", false, LIST_PREVIEW_COUNT);
  }

  function persistPanelCollapsed(collapsed) {
    var patch = {};
    patch[PANEL_COLLAPSED_KEY] = Boolean(collapsed);
    storageSet(patch).catch(function () {
      /* The panel still updates for this page if local preference storage fails. */
    });
  }

  function cancelInlineModes() {
    state.mode = "list";
    state.menuId = null;
    state.renameId = null;
    state.renameDraft = "";
    state.confirmDeleteId = null;
    state.error = "";
    state.retry = null;
    render();
  }

  // Leaving Rename or Delete puts focus back on the row's menu button.
  function cancelRowMode() {
    if (state.sheet === "edit") {
      state.confirmDeleteId = null;
      render();
      focusSoon("[data-trace-sf-action='delete-confirm']");
      return;
    }
    var id = state.renameId || state.confirmDeleteId;
    cancelInlineModes();
    if (id) focusSoon("[data-trace-sf-action='menu'][data-id='" + cssEscape(id) + "']");
  }

  function toggleMenu(id) {
    state.menuId = state.menuId === id ? null : id;
    if (state.menuId) state.panelCollapsed = false;
    state.renameId = null;
    state.confirmDeleteId = null;
    render();
    focusSoon("[data-trace-sf-action='menu'][data-id='" + cssEscape(id) + "']");
    if (state.menuId) revealManagementSoon(id);
  }

  function revealManagementSoon(id) {
    setTimeout(function () {
      try {
        var row = state.root && state.root.querySelector(".trace-sf-row[data-id='" + cssEscape(id) + "']");
        if (row && typeof row.scrollIntoView === "function") {
          row.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      } catch (_) {
        /* The action tray remains in flow even when scrollIntoView is unavailable. */
      }
    }, 0);
  }

  function closeMenu(restoreFocus) {
    if (!state.menuId) return;
    var previousId = state.menuId;
    state.menuId = null;
    render();
    if (restoreFocus) {
      focusSoon("[data-trace-sf-action='menu'][data-id='" + cssEscape(previousId) + "']");
    }
  }

  function openRename(id) {
    var preset = findPreset(id);
    state.menuId = null;
    state.renameId = id;
    state.renameDraft = preset ? preset.name : "";
    state.panelCollapsed = false;
    state.confirmDeleteId = null;
    state.error = "";
    state.retry = null;
    render();
    focusSoon("[data-trace-sf-rename-input]", true);
  }

  function confirmDelete(id) {
    state.menuId = null;
    state.renameId = null;
    state.confirmDeleteId = id;
    state.panelCollapsed = false;
    state.error = "";
    state.retry = null;
    render();
    if (state.sheet) focusSoon(".trace-sf-sheet-confirm");
  }

  function focusSoon(selector, select, index) {
    setTimeout(function () {
      try {
        var matches = queryTraceAll(selector);
        var el = matches[index || 0] || matches[0];
        if (!el) return;
        el.focus();
        if (select && typeof el.select === "function") el.select();
      } catch (_) {
        /* ignore */
      }
    }, 0);
  }

  function cssEscape(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
      return globalThis.CSS.escape(String(value || ""));
    }
    return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function findPreset(id) {
    return state.presets.find(function (preset) {
      return preset.id === id;
    }) || null;
  }

  function currentNameInputValue(selector) {
    var input = queryTrace(selector);
    return String(input && input.value ? input.value : "").trim().slice(0, MAX_NAME_LENGTH);
  }

  function retryLastChange() {
    var retry = state.retry;
    if (!retry) return;
    if (retry.kind === "save") return saveCurrentPreset();
    if (retry.kind === "rename") return renamePreset(retry.id);
    if (retry.kind === "update") return updatePresetToCurrent(retry.id);
    if (retry.kind === "delete") return deletePreset(retry.id);
    if (retry.kind === "edit") return finishEdit();
  }

  async function saveCurrentPreset() {
    state.current = getCurrentFilterState();
    if (!state.current.canSave) return;
    if (isAtSavedFilterLimit()) {
      state.mode = "list";
      render();
      return;
    }
    var name = currentNameInputValue("[data-trace-sf-name]") || suggestedNameForCurrent();
    state.draftName = name;
    var scope = state.draftScope === "global" || !hasReusableContext() ? "global" : "context";
    var now = new Date().toISOString();
    var id = makeId();
    var preset = {
      id: id,
      clientId: id,
      serverId: "",
      name: name,
      params: state.current.pairs,
      scope: scope,
      contextKey: scope === "context" ? state.current.contextKey : "",
      contextLabel: scope === "context" ? state.current.contextLabel : "",
      summary: storedSummaryParts(summaryForPairs(state.current.pairs)),
      createdAt: now,
      updatedAt: now,
      clientUpdatedAt: now,
      dirty: true,
    };
    var presets = state.presets.concat([preset]);
    var activeMeta = {
      id: preset.id,
      signature: state.current.signature,
      contextKey: state.current.contextKey,
      appliedAt: now,
    };
    await commitStorage(presets, activeMeta, function () {
      state.mode = "list";
      state.draftName = "";
      state.notice = "";
      persistLastUsed(id);
      if (state.sheet) closeSheet(true, true);
    }, null, { kind: "save" });
  }

  async function renamePreset(id) {
    var name = currentNameInputValue("[data-trace-sf-rename-input]");
    if (!name) return;
    state.renameDraft = name;
    var now = new Date().toISOString();
    var presets = state.presets.map(function (preset) {
      if (preset.id !== id) return preset;
      return Object.assign({}, preset, {
        name: name,
        updatedAt: now,
        clientUpdatedAt: now,
        dirty: true,
      });
    });
    await commitStorage(presets, state.activeMeta, function () {
      state.renameId = null;
      state.renameDraft = "";
      state.menuId = null;
    }, null, { kind: "rename", id: id });
  }

  async function updatePresetToCurrent(id) {
    state.current = getCurrentFilterState();
    if (!state.current.canSave) return;
    var now = new Date().toISOString();
    var presets = state.presets.map(function (preset) {
      if (preset.id !== id) return preset;
      return Object.assign({}, preset, {
        params: state.current.pairs,
        contextKey: preset.scope === "context" ? state.current.contextKey : "",
        contextLabel: preset.scope === "context" ? state.current.contextLabel : "",
        summary: storedSummaryParts(summaryForPairs(state.current.pairs)),
        updatedAt: now,
        clientUpdatedAt: now,
        dirty: true,
      });
    });
    var activeMeta = {
      id: id,
      signature: state.current.signature,
      contextKey: state.current.contextKey,
      appliedAt: now,
    };
    await commitStorage(presets, activeMeta, function () {
      state.mode = "list";
      state.menuId = null;
      state.renameId = null;
      state.confirmDeleteId = null;
      persistLastUsed(id);
      if (state.sheet) showSheetList("[data-trace-sf-action='sheet-edit'][data-id='" + cssEscape(id) + "']");
    }, null, { kind: "update", id: id });
  }

  async function deletePreset(id) {
    var preset = findPreset(id);
    var now = new Date().toISOString();
    var presets = state.presets.filter(function (preset) {
      return preset.id !== id;
    });
    var activeMeta = state.activeMeta && state.activeMeta.id === id ? null : state.activeMeta;
    var deleted = null;
    if (preset) {
      var res = await storageGet([DELETED_KEY]);
      deleted = sanitizeDeletedPresets(res[DELETED_KEY]);
      deleted.push({
        id: preset.id,
        clientId: preset.clientId || preset.id,
        serverId: preset.serverId || "",
        clientUpdatedAt: now,
      });
    }
    await commitStorage(presets, activeMeta, function () {
      state.menuId = null;
      state.renameId = null;
      state.confirmDeleteId = null;
      if (state.sheet) showSheetList();
    }, deleted, { kind: "delete", id: id });
  }

  async function commitStorage(presets, activeMeta, onSuccess, deleted, retry) {
    try {
      var patch = {};
      patch[STORAGE_KEY] = presets;
      patch[ACTIVE_KEY] = activeMeta;
      if (Array.isArray(deleted)) patch[DELETED_KEY] = sanitizeDeletedPresets(deleted);
      await storageSet(patch);
      state.presets = sanitizePresets(presets);
      state.activeMeta = sanitizeActiveMeta(activeMeta);
      state.current = getCurrentFilterState();
      state.error = "";
      state.retry = null;
      if (typeof onSuccess === "function") onSuccess();
      render();
      requestSavedFiltersSync();
    } catch (_) {
      // Nothing was written; keep any open form or draft as it was.
      state.error = "Couldn't save. Nothing changed.";
      state.retry = retry || null;
      render();
    }
  }

  function isAtSavedFilterLimit() {
    return state.presets.length >= SAVED_FILTER_ACTIVE_LIMIT;
  }

  function savedFilterLimitMessage() {
    return "You've saved " + SAVED_FILTER_ACTIVE_LIMIT + " filters, the most Trace keeps. Delete one to save another.";
  }

  function renderCapacityWarning() {
    if (state.presets.length < SAVED_FILTER_LIMIT_WARNING_THRESHOLD) return "";
    return (
      "<p class='trace-sf-capacity'>" +
      state.presets.length + " of " + SAVED_FILTER_ACTIVE_LIMIT + " saved filters used" +
      "</p>"
    );
  }

  async function applyPreset(id) {
    var preset = findPreset(id);
    if (!preset) return;
    var href = buildApplyUrl(preset);
    var activeMeta = {
      id: preset.id,
      signature: signatureForPairs(preset.params),
      contextKey: contextKeyFromHref(href),
      appliedAt: new Date().toISOString(),
    };
    try {
      var patch = {};
      patch[ACTIVE_KEY] = activeMeta;
      state.lastUsed = nextLastUsed(preset.id);
      patch[LAST_USED_KEY] = state.lastUsed;
      await storageSet(patch);
    } catch (_) {
      /* Apply should still work if only the active marker fails. */
    }
    if (state.sheet) closeSheet(false);
    if (preset.scope === "context" && !getPageContext()) {
      state.notice = "This page isn't a tag page, so the filter is applied across all of AO3.";
      render();
    }
    navigateTo(href);
  }

  function navigateTo(href) {
    var testNavigate = globalThis[TEST_NAVIGATE_KEY];
    if (typeof testNavigate === "function") {
      testNavigate(href);
      return;
    }
    location.assign(href);
  }

  function startObservers() {
    if (ext.storage && ext.storage.onChanged) {
      try {
        ext.storage.onChanged.addListener(function (changes, area) {
          if (area !== "local") return;
          if (
            !changes[STORAGE_KEY] &&
            !changes[ACTIVE_KEY] &&
            !changes[PREF_AO3_SAVED_FILTERS_KEY]
          ) {
            return;
          }
          renderSoon(40);
        });
      } catch (_) {
        /* ignore */
      }
    }
    try {
      // Rotating or resizing across AO3's breakpoint switches layouts.
      var narrowQuery = window.matchMedia ? window.matchMedia(NARROW_QUERY) : null;
      if (narrowQuery) {
        var onLayoutChange = function () { renderSoon(0); };
        if (typeof narrowQuery.addEventListener === "function") narrowQuery.addEventListener("change", onLayoutChange);
        else if (typeof narrowQuery.addListener === "function") narrowQuery.addListener(onLayoutChange);
      }
    } catch (_) {
      /* ignore */
    }
    try {
      window.addEventListener("pageshow", function () {
        renderSoon(60);
      });
      window.addEventListener("popstate", function () {
        renderSoon(60);
      });
      document.addEventListener("pointerdown", function (event) {
        if (!state.menuId || !state.root) return;
        var target = event.target;
        if (target && target.closest) {
          if (target.closest("." + ROOT_ATTR + " .trace-sf-manage")) return;
          if (target.closest("." + ROOT_ATTR + " .trace-sf-menu-btn")) return;
        }
        closeMenu(false);
      });
    } catch (_) {
      /* ignore */
    }
  }

  function exposeTestHooks() {
    if (!globalThis.__TRACE_AO3_SAVED_FILTERS_TESTS__) return;
    globalThis.__traceAo3SavedFiltersTestHooks = {
      STORAGE_KEY: STORAGE_KEY,
      ACTIVE_KEY: ACTIVE_KEY,
      DELETED_KEY: DELETED_KEY,
      normalizePairsFromSearch: normalizePairsFromSearch,
      signatureForPairs: signatureForPairs,
      getPageContextFromUrl: getPageContextFromUrl,
      buildApplyUrl: buildApplyUrl,
      sanitizePresets: sanitizePresets,
      summaryForPairs: summaryForPairs,
      renderFromStorage: renderFromStorage,
    };
  }

  function boot() {
    exposeTestHooks();
    if (!ext || !ext.storage || !ext.storage.local) return;
    if (!isAo3Host(location.hostname)) return;
    if (pageHasPasswordField()) return;
    renderFromStorage();
    startObservers();
    requestSyncIfStale().catch(function () {
      /* Best-effort pull; the panel already shows what this device has. */
    });
  }

  if (
    TRACE_EARNED_PERMISSION_GATE_ACTIVE &&
    globalThis.TRACE_EARNED_PERMISSION_COMPLETE !== true
  ) {
    document.addEventListener(
      "trace-earned-permission-ready",
      function () {
        if (globalThis.TRACE_EARNED_PERMISSION_COMPLETE !== true) return;
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", boot, { once: true });
        } else {
          boot();
        }
      },
      { once: true },
    );
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
