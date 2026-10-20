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
  const PREF_AO3_SAVED_FILTERS_KEY = "prefAo3SavedFiltersEnabled";
  const SYNC_REQUEST_MESSAGE = "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST";
  const ROOT_ATTR = "data-trace-ao3-saved-filters";
  const STYLE_ID = "trace-ao3-saved-filters-style";
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
    var res = await storageGet([STORAGE_KEY, ACTIVE_KEY, PANEL_COLLAPSED_KEY]);
    return {
      presets: sanitizePresets(res[STORAGE_KEY]),
      activeMeta: sanitizeActiveMeta(res[ACTIVE_KEY]),
      panelCollapsed: res[PANEL_COLLAPSED_KEY] === true,
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
    };
    var dark = {
      surface: "#121418", raised: "#1D1F23", rule: "#212429", control: "#686D75", ink: "#F2F5F8",
      secondary: "#B4BCC6", tertiary: "#9AA3AE", teal: "#8BCDC8", warning: "#E7A19F",
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
    var root = ensureRoot();
    if (!root) return;
    applyPageTokens(root);
    state.root = root;
    var stored = await readStorageState();
    state.presets = stored.presets;
    state.activeMeta = stored.activeMeta;
    state.panelCollapsed = stored.panelCollapsed;
    state.current = getCurrentFilterState();
    render();
  }

  function render() {
    if (!state.root) return;
    var visiblePresets = visiblePresetsForCurrent(state.presets, state.current);
    var relation = relationForCurrent(visiblePresets, state.activeMeta, state.current);
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

  function buttonActionFromEvent(event) {
    var target = event.target;
    if (!target || !target.closest || !state.root) return null;
    var el = target.closest("[data-trace-sf-action]");
    if (!el || !state.root.contains(el)) return null;
    return el;
  }

  function isTraceEvent(event) {
    var target = event && event.target;
    return Boolean(target && state.root && state.root.contains(target));
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
  }

  function focusSoon(selector, select, index) {
    setTimeout(function () {
      try {
        var matches = state.root ? state.root.querySelectorAll(selector) : [];
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
    var input = state.root ? state.root.querySelector(selector) : null;
    return String(input && input.value ? input.value : "").trim().slice(0, MAX_NAME_LENGTH);
  }

  function retryLastChange() {
    var retry = state.retry;
    if (!retry) return;
    if (retry.kind === "save") return saveCurrentPreset();
    if (retry.kind === "rename") return renamePreset(retry.id);
    if (retry.kind === "update") return updatePresetToCurrent(retry.id);
    if (retry.kind === "delete") return deletePreset(retry.id);
  }

  async function saveCurrentPreset() {
    state.current = getCurrentFilterState();
    if (!state.current.canSave) return;
    if (isAtSavedFilterLimit()) {
      state.mode = "list";
      render();
      return;
    }
    var name = currentNameInputValue("[data-trace-sf-name]") || suggestedNameForPairs(state.current.pairs);
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
      await storageSet(patch);
    } catch (_) {
      /* Apply should still work if only the active marker fails. */
    }
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
