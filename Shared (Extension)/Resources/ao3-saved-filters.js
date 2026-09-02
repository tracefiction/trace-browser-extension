// ao3-saved-filters.js - local AO3 saved filter presets.
// Stores AO3 filter query params in extension-local storage and applies them by URL navigation.
(function () {
  "use strict";

  const ext = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "traceAo3SavedFiltersV1";
  const ACTIVE_KEY = "traceAo3SavedFiltersActiveV1";
  const DELETED_KEY = "traceAo3SavedFiltersDeletedV1";
  const PANEL_COLLAPSED_KEY = "traceAo3SavedFiltersPanelCollapsedV1";
  const PREF_AO3_SAVED_FILTERS_KEY = "prefAo3SavedFiltersEnabled";
  const SYNC_REQUEST_MESSAGE = "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST";
  const ROOT_ATTR = "data-trace-ao3-saved-filters";
  const STYLE_ID = "trace-ao3-saved-filters-style";
  const TEST_NAVIGATE_KEY = "__traceAo3SavedFiltersNavigate";
  const MAX_NAME_LENGTH = 96;
  const MAX_CONTEXT_LABEL_LENGTH = 120;
  const MAX_SUMMARY_PARTS = 4;
  const MAX_SUMMARY_PART_LENGTH = 48;
  const MAX_SUMMARY_TEXT_LENGTH = 240;
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
    confirmDeleteId: null,
    draftName: "",
    draftScope: "context",
    collapsedGroups: {},
    panelCollapsed: true,
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
    var summary = Array.isArray(raw.summary)
      ? compactSummaryParts(raw.summary)
      : [];
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
      panelCollapsed: res[PANEL_COLLAPSED_KEY] === false ? false : true,
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

  function cleanDisplayText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\s+\([\d,]+\)$/g, "")
      .trim();
  }

  function truncateText(text, maxLength) {
    var value = cleanDisplayText(text);
    if (!maxLength || value.length <= maxLength) return value;
    if (maxLength <= 3) return value.slice(0, maxLength);
    return value.slice(0, maxLength - 3).replace(/\s+$/, "") + "...";
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

  function selectOptionLabel(form, key, value) {
    var control = findControlForPair(form, key, value);
    if (!control || !control.options) return "";
    for (var i = 0; i < control.options.length; i++) {
      var option = control.options[i];
      if (String(option.value || "") === String(value || "")) {
        return cleanDisplayText(option.textContent || option.label || "");
      }
    }
    return "";
  }

  function keyLabel(key) {
    var labels = {
      "work_search[sort_column]": "Sort",
      "work_search[words_from]": "Words from",
      "work_search[words_to]": "Words to",
      "work_search[date_from]": "Updated from",
      "work_search[date_to]": "Updated to",
      "work_search[query]": "Search",
      "work_search[language_id]": "Language",
      "work_search[other_tag_names]": "Include",
      "work_search[excluded_tag_names]": "Exclude",
      "work_search[crossover]": "Crossovers",
      "work_search[complete]": "Status",
    };
    if (labels[key]) return labels[key];
    if (key.indexOf("include_work_search[") === 0) return "Include";
    if (key.indexOf("exclude_work_search[") === 0) return "Exclude";
    return "Filter";
  }

  function readableValueForPair(form, key, value) {
    if (key === "work_search[sort_column]" || key === "work_search[language_id]") {
      return selectOptionLabel(form, key, value) || value;
    }
    var control = findControlForPair(form, key, value);
    var label = elementLabel(control);
    if (label) return label;
    if (key === "work_search[complete]") {
      if (value === "T") return "Complete works only";
      if (value === "F") return "Works in progress only";
    }
    if (key === "work_search[crossover]") {
      if (value === "F") return "Exclude crossovers";
      if (value === "T") return "Show only crossovers";
    }
    return value;
  }

  function summaryForPairs(pairs) {
    var form = findFilterForm();
    var parts = [];
    for (var i = 0; i < pairs.length; i++) {
      var key = pairs[i][0];
      var value = pairs[i][1];
      var label = keyLabel(key);
      var readable = readableValueForPair(form, key, value);
      if (!readable) continue;
      if (label === "Filter") parts.push(readable);
      else parts.push(label + ": " + readable);
    }
    return compactSummaryParts(parts);
  }

  function compactSummaryParts(parts) {
    var cleaned = (parts || []).map(function (part) {
      return truncateText(part, MAX_SUMMARY_PART_LENGTH);
    }).filter(Boolean);
    var visible = cleaned.slice(0, MAX_SUMMARY_PARTS);
    if (cleaned.length > MAX_SUMMARY_PARTS) {
      visible.push("+" + (cleaned.length - MAX_SUMMARY_PARTS) + " more");
    }
    return visible;
  }

  function summaryTextFromParts(parts, fallback) {
    return truncateText((parts || []).join(" | ") || fallback || "AO3 filter", MAX_SUMMARY_TEXT_LENGTH);
  }

  function suggestedNameForSummary(summary) {
    var parts = (summary || []).map(function (part) {
      return String(part || "").replace(/^[^:]+:\s*/, "");
    }).filter(Boolean).slice(0, 3);
    return (parts.join(" - ") || "AO3 filter").slice(0, MAX_NAME_LENGTH);
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

  function contextMatchesPreset(preset, current) {
    if (preset.scope === "global") return true;
    if (!preset.contextKey) return true;
    if (!current || !current.contextKey) return false;
    if (preset.contextKey === current.contextKey) return true;
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
    if (activeMeta && activeMeta.contextKey === current.contextKey) {
      var applied = presets.find(function (preset) {
        return preset.id === activeMeta.id;
      });
      if (applied) return { type: "edited", preset: applied };
    }
    return { type: "unsaved" };
  }

  function insertStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "." + ROOT_ATTR + ", ." + ROOT_ATTR + " * { box-sizing: border-box; }",
      "." + ROOT_ATTR + " { container-type: inline-size; margin: 0 0 0.85rem; color: #2a2a2a; font-family: 'Lucida Grande', 'Helvetica Neue', Arial, sans-serif; font-size: 15px; line-height: 1.45; }",
      "." + ROOT_ATTR + " button, ." + ROOT_ATTR + " input { font: inherit; }",
      "." + ROOT_ATTR + " .trace-sf-card { background: transparent; border: 0; border-bottom: 1px solid #cfcec9; border-radius: 0; box-shadow: none; overflow: visible; }",
      "." + ROOT_ATTR + " .trace-sf-head { appearance: none; background: transparent; background-image: none; border: 0; box-shadow: none; color: inherit; display: flex; align-items: center; gap: 0.52rem; height: auto; margin: 0; min-height: 0; padding: 0.68rem 0.86rem; text-align: left; text-shadow: none; width: 100%; }",
      "." + ROOT_ATTR + " button.trace-sf-head { cursor: pointer; }",
      "." + ROOT_ATTR + " button.trace-sf-head:focus, ." + ROOT_ATTR + " .trace-sf-group-head:focus, ." + ROOT_ATTR + " .trace-sf-main:focus { outline: 0; }",
      "." + ROOT_ATTR + " button.trace-sf-head:focus-visible, ." + ROOT_ATTR + " .trace-sf-group-head:focus-visible, ." + ROOT_ATTR + " .trace-sf-main:focus-visible { box-shadow: inset 0 0 0 2px rgba(31,92,69,0.32); outline: 0; }",
      "." + ROOT_ATTR + " .trace-sf-mark { width: 1.32rem; height: 1.32rem; border-radius: 0.34rem; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; line-height: 1; overflow: hidden; }",
      "." + ROOT_ATTR + " .trace-sf-mark svg { display: block; height: 100%; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-title { font-family: Georgia, serif; font-size: 1.02rem; font-weight: 700; letter-spacing: -0.005em; line-height: 1.1; color: #2a2a2a; }",
      "." + ROOT_ATTR + " .trace-sf-count { align-items: center; background: #dededa; border: 1px solid #cbcac5; border-radius: 999px; color: #6d6c67; display: inline-flex; flex: 0 0 auto; font-size: 0.68rem; font-weight: 700; justify-content: center; line-height: 1; min-width: 1.25rem; padding: 0.12rem 0.36rem; }",
      "." + ROOT_ATTR + " .trace-sf-head-text { display: flex; align-items: baseline; gap: 0.45rem; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-title-line { display: inline-flex; align-items: center; gap: 0.45rem; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-head-actions { align-items: center; display: inline-flex; flex: 0 0 auto; gap: 0.36rem; margin-left: auto; white-space: nowrap; }",
      "." + ROOT_ATTR + " .trace-sf-head-meta { color: #6d6c67; display: none; font-size: 0.72rem; line-height: 1.25; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      "." + ROOT_ATTR + " .trace-sf-head-meta b { color: #2a2a2a; font-weight: 700; }",
      "." + ROOT_ATTR + " .trace-sf-panel-caret { align-items: center; color: #8a897f; display: none; flex: 0 0 auto; justify-content: center; width: 0.72rem; }",
      "." + ROOT_ATTR + " .trace-sf-panel-caret svg { display: block; height: 0.7rem; width: 0.7rem; transition: transform 0.16s ease; }",
      "." + ROOT_ATTR + " .trace-sf-panel-caret[data-collapsed='false'] svg { transform: rotate(180deg); }",
      "." + ROOT_ATTR + " .trace-sf-spacer { flex: 1; }",
      "." + ROOT_ATTR + " .trace-sf-panel { min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-status { display: flex; align-items: center; gap: 0.5rem; padding: 0.56rem 0.86rem; border-top: 1px solid #dcdbd6; font-size: 0.78rem; color: #6d6c67; }",
      "." + ROOT_ATTR + " .trace-sf-dot { width: 0.44rem; height: 0.44rem; border-radius: 999px; flex: 0 0 auto; background: #6d6c67; }",
      "." + ROOT_ATTR + " .trace-sf-status[data-kind='unsaved'] { background: #f8efe8; }",
      "." + ROOT_ATTR + " .trace-sf-status[data-kind='unsaved'] .trace-sf-dot { background: #b07d2a; }",
      "." + ROOT_ATTR + " .trace-sf-status[data-kind='active'] { background: #e9f2ec; }",
      "." + ROOT_ATTR + " .trace-sf-status[data-kind='active'] .trace-sf-dot { background: #1f5c45; }",
      "." + ROOT_ATTR + " .trace-sf-status[data-kind='edited'] { background: #f8efe8; }",
      "." + ROOT_ATTR + " .trace-sf-status[data-kind='edited'] .trace-sf-dot { background: #b07d2a; }",
      "." + ROOT_ATTR + " .trace-sf-status-main { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      "." + ROOT_ATTR + " .trace-sf-status-main b { color: #2a2a2a; font-weight: 700; }",
      "." + ROOT_ATTR + " .trace-sf-status-actions { display: inline-flex; gap: 0.38rem; flex: 0 0 auto; }",
      "." + ROOT_ATTR + " .trace-sf-btn { appearance: none; background: linear-gradient(#fbfbfb, #e0e0dd); background-image: linear-gradient(#fbfbfb, #e0e0dd); border: 1px solid #b0afa9; border-radius: 0.32rem; box-shadow: inset 0 1px 0 #fff; color: #2a2a2a; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; font-size: 0.74rem; font-weight: 700; line-height: 1.15; margin: 0; min-height: 2.05rem; padding: 0.42rem 0.64rem; text-decoration: none; text-shadow: none; }",
      "." + ROOT_ATTR + " .trace-sf-status-actions .trace-sf-btn { font-size: 0.7rem; min-height: 1.68rem; padding: 0.26rem 0.54rem; }",
      "." + ROOT_ATTR + " .trace-sf-btn-primary { background: #1f5c45; background-image: none; border-color: #163d2e; box-shadow: none; color: #fffdf8; }",
      "." + ROOT_ATTR + " .trace-sf-btn-danger { background: #9a3412; border-color: #9a3412; color: #fffdf8; }",
      "." + ROOT_ATTR + " .trace-sf-btn-ghost { background: linear-gradient(#fbfbfb, #e0e0dd); border-color: #b0afa9; color: #2a2a2a; }",
      "." + ROOT_ATTR + " .trace-sf-btn:disabled { opacity: 0.48; cursor: default; }",
      "." + ROOT_ATTR + " .trace-sf-link { appearance: none; border: 0; border-bottom: 1px solid rgba(45,75,67,0.35); background: transparent; color: #2d4b43; cursor: pointer; padding: 0; font-size: 0.75rem; font-weight: 650; }",
      "." + ROOT_ATTR + " .trace-sf-list { border-top: 1px solid rgba(65,72,70,0.14); max-height: 22rem; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }",
      "." + ROOT_ATTR + " .trace-sf-group + .trace-sf-group { border-top: 1px solid rgba(65,72,70,0.12); }",
      "." + ROOT_ATTR + " .trace-sf-group-head { appearance: none; align-items: center; background: transparent; border: 0; box-shadow: none; color: #6d6c67; cursor: pointer; display: flex; gap: 0.45rem; height: auto; justify-content: flex-start; margin: 0; min-height: 2.05rem; padding: 0.4rem 0.86rem; text-align: left; text-shadow: none; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-group[data-group='context'] .trace-sf-group-head { background: transparent; }",
      "." + ROOT_ATTR + " .trace-sf-group-caret { align-items: center; color: #8a897f; display: inline-flex; flex: 0 0 auto; justify-content: center; line-height: 1; width: 0.62rem; }",
      "." + ROOT_ATTR + " .trace-sf-group-caret svg { display: block; height: 0.58rem; width: 0.58rem; transition: transform 0.14s ease; }",
      "." + ROOT_ATTR + " .trace-sf-group-caret[data-collapsed='false'] svg { transform: rotate(90deg); }",
      "." + ROOT_ATTR + " .trace-sf-group-title { flex: 1; font-size: 0.64rem; font-weight: 700; letter-spacing: 0.1em; min-width: 0; text-transform: uppercase; }",
      "." + ROOT_ATTR + " .trace-sf-group[data-group='context'] .trace-sf-group-title { color: #1f5c45; }",
      "." + ROOT_ATTR + " .trace-sf-group-count { border: 1px solid rgba(65,72,70,0.16); border-radius: 999px; color: #647067; flex: 0 0 auto; font-size: 0.66rem; line-height: 1; padding: 0.13rem 0.38rem; }",
      "." + ROOT_ATTR + " .trace-sf-row { background: transparent; border-top: 1px solid rgba(65,72,70,0.12); position: relative; }",
      "." + ROOT_ATTR + " .trace-sf-group-body .trace-sf-row:first-child { border-top: 0; }",
      "." + ROOT_ATTR + " .trace-sf-row:hover { background: #e7e6e1; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-active='true'] { background: #e9f2ec; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-active='true']:hover { background: #dcebe1; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-menu-open='true'] { background: #f7f6f1; }",
      "." + ROOT_ATTR + " .trace-sf-row-inner { display: grid; grid-template-columns: 3px minmax(0, 1fr) 2.2rem; align-items: stretch; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-edge { width: 3px; flex: 0 0 auto; background: transparent; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-active='true'] .trace-sf-edge { background: #2f7d5b; }",
      "." + ROOT_ATTR + " .trace-sf-main { appearance: none; background: transparent; border: 0; border-radius: 0; box-shadow: none; color: inherit; cursor: pointer; display: block; height: auto; line-height: 1.35; margin: 0; min-height: 0; min-width: 0; overflow: hidden; padding: 0.56rem 0.5rem 0.6rem 0.72rem; text-align: left; text-shadow: none; white-space: normal; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-main:hover { background: transparent; }",
      "." + ROOT_ATTR + " .trace-sf-row-title { display: block; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-name { color: #2a2a2a; display: block; font-family: Georgia, serif; font-size: 0.96rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-active='true'] .trace-sf-name { color: #1f5c45; }",
      "." + ROOT_ATTR + " .trace-sf-summary { color: #6d6c67; display: -webkit-box; font-size: 0.72rem; line-height: 1.35; margin-top: 0.14rem; max-width: 100%; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; }",
      "." + ROOT_ATTR + " .trace-sf-menu-btn { -webkit-appearance: none; appearance: none; align-self: center; background: transparent; background-image: none; border: 0; border-radius: 0.28rem; box-shadow: none; color: #8a8984; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; height: 1.9rem; margin: 0; min-height: 0; opacity: 0.58; outline: 0; padding: 0; text-shadow: none; width: 1.9rem; }",
      "." + ROOT_ATTR + " .trace-sf-menu-btn svg { display: block; height: 0.86rem; width: 0.86rem; }",
      "." + ROOT_ATTR + " .trace-sf-menu-btn:focus, ." + ROOT_ATTR + " .trace-sf-menu-btn:active { outline: 0; }",
      "." + ROOT_ATTR + " .trace-sf-row:hover .trace-sf-menu-btn, ." + ROOT_ATTR + " .trace-sf-menu-btn:hover, ." + ROOT_ATTR + " .trace-sf-menu-btn:focus-visible, ." + ROOT_ATTR + " .trace-sf-row[data-menu-open='true'] .trace-sf-menu-btn { opacity: 1; }",
      "." + ROOT_ATTR + " .trace-sf-menu-btn:hover, ." + ROOT_ATTR + " .trace-sf-menu-btn:focus-visible, ." + ROOT_ATTR + " .trace-sf-row[data-menu-open='true'] .trace-sf-menu-btn { background: rgba(42,42,42,0.045); box-shadow: none; color: #5a5950; }",
      "." + ROOT_ATTR + " .trace-sf-manage { align-items: center; background: #efeee9; border-top: 1px solid #d8d6cf; display: flex; flex-wrap: wrap; gap: 0; margin: 0; padding: 0.38rem 0.62rem 0.42rem calc(3px + 0.72rem); animation: trace-sf-reveal 0.14s ease-out both; }",
      "." + ROOT_ATTR + " .trace-sf-manage button { -webkit-appearance: none; appearance: none; background: transparent; background-image: none; border: 0; border-left: 1px solid #cbc9c1; border-radius: 0; box-shadow: none; color: #46524a; cursor: pointer; display: inline-flex; align-items: center; font-family: inherit; font-size: 0.7rem; font-weight: 650; height: auto; line-height: 1.2; margin: 0; min-height: 1.9rem; padding: 0.34rem 0.58rem; text-align: left; text-shadow: none; text-transform: none; white-space: nowrap; }",
      "." + ROOT_ATTR + " .trace-sf-manage button:first-child { border-left: 0; padding-left: 0; }",
      "." + ROOT_ATTR + " .trace-sf-manage button:hover, ." + ROOT_ATTR + " .trace-sf-manage button:focus-visible { color: #1f5c45; outline: 0; text-decoration: underline; text-underline-offset: 0.16rem; }",
      "." + ROOT_ATTR + " .trace-sf-manage button:disabled { color: #8f958f; cursor: default; opacity: 0.62; text-decoration: none; }",
      "." + ROOT_ATTR + " .trace-sf-manage button[data-danger='true'] { color: #9a3412; }",
      "@keyframes trace-sf-reveal { from { opacity: 0; transform: translateY(-0.18rem); } to { opacity: 1; transform: translateY(0); } }",
      "@media (prefers-reduced-motion: reduce) { ." + ROOT_ATTR + " .trace-sf-manage { animation: none; } }",
      "." + ROOT_ATTR + " .trace-sf-form, ." + ROOT_ATTR + " .trace-sf-empty, ." + ROOT_ATTR + " .trace-sf-note, ." + ROOT_ATTR + " .trace-sf-error { border-top: 1px solid rgba(65,72,70,0.14); padding: 0.78rem 0.82rem; }",
      "." + ROOT_ATTR + " .trace-sf-label { color: #647067; font-size: 0.66rem; font-weight: 750; letter-spacing: 0.08em; margin-bottom: 0.42rem; text-transform: uppercase; }",
      "." + ROOT_ATTR + " .trace-sf-input-row { display: block; position: relative; }",
      "." + ROOT_ATTR + " .trace-sf-input { background: #fffdf8; border: 1px solid rgba(65,72,70,0.22); border-radius: 0.52rem; color: #1f2933; font-family: Georgia, serif; font-size: 0.95rem; padding: 0.52rem 0.62rem; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-input-row .trace-sf-input { padding-right: 2.3rem; }",
      "." + ROOT_ATTR + " .trace-sf-input:focus { border-color: #8a6e2a; box-shadow: 0 0 0 3px rgba(138,110,42,0.18); outline: 0; }",
      "." + ROOT_ATTR + " .trace-sf-clear-name { -webkit-appearance: none; appearance: none; align-items: center; background: transparent; border: 0; border-radius: 0.32rem; box-shadow: none; color: #647067; cursor: pointer; display: inline-flex; font-size: 1.2rem; font-weight: 700; height: 1.65rem; justify-content: center; line-height: 1; margin: 0; min-height: 0; padding: 0; position: absolute; right: 0.32rem; text-shadow: none; top: 50%; transform: translateY(-50%); width: 1.65rem; }",
      "." + ROOT_ATTR + " .trace-sf-clear-name:hover, ." + ROOT_ATTR + " .trace-sf-clear-name:focus-visible { background: rgba(31,77,63,0.08); color: #1f4d3f; outline: 0; }",
      "." + ROOT_ATTR + " .trace-sf-input:placeholder-shown + .trace-sf-clear-name { display: none; }",
      "." + ROOT_ATTR + " .trace-sf-preview { background: #fbf7ee; border: 1px solid rgba(65,72,70,0.12); border-radius: 0.55rem; color: #46524a; font-size: 0.72rem; line-height: 1.45; margin-top: 0.55rem; padding: 0.55rem 0.62rem; }",
      "." + ROOT_ATTR + " .trace-sf-capacity { color: #8a6e2a; font-size: 0.7rem; line-height: 1.35; margin-top: 0.5rem; }",
      "." + ROOT_ATTR + " .trace-sf-scope { display: grid; gap: 0.42rem; grid-template-columns: 1fr; margin-top: 0.62rem; }",
      "." + ROOT_ATTR + " .trace-sf-scope button { appearance: none; background: #fffdf8; border: 1px solid rgba(65,72,70,0.2); border-radius: 0.55rem; color: #46524a; cursor: pointer; height: auto; min-height: 3.55rem; min-width: 0; overflow: visible; padding: 0.55rem 0.6rem; text-align: left; white-space: normal; }",
      "." + ROOT_ATTR + " .trace-sf-scope button[data-active='true'] { background: #edf7f1; border-color: rgba(31,77,63,0.42); color: #1f4d3f; }",
      "." + ROOT_ATTR + " .trace-sf-scope-title { display: block; font-size: 0.75rem; font-weight: 700; }",
      "." + ROOT_ATTR + " .trace-sf-scope-desc { color: #647067; display: block; font-size: 0.65rem; line-height: 1.3; margin-top: 0.18rem; }",
      "." + ROOT_ATTR + " .trace-sf-actions { display: flex; gap: 0.45rem; margin-top: 0.65rem; }",
      "." + ROOT_ATTR + " .trace-sf-actions .trace-sf-btn { height: auto; min-height: 2.2rem; }",
      "." + ROOT_ATTR + " .trace-sf-actions .trace-sf-btn { flex: 1; }",
      "." + ROOT_ATTR + " .trace-sf-foot { align-items: center; border-top: 1px solid rgba(65,72,70,0.14); display: flex; gap: 0.5rem; padding: 0.65rem 0.82rem; }",
      "." + ROOT_ATTR + " .trace-sf-empty h4 { color: #1f2933; font-family: Georgia, serif; font-size: 1rem; font-weight: 500; margin: 0 0 0.22rem; }",
      "." + ROOT_ATTR + " .trace-sf-empty p, ." + ROOT_ATTR + " .trace-sf-note, ." + ROOT_ATTR + " .trace-sf-error { color: #647067; font-size: 0.76rem; margin: 0; }",
      "." + ROOT_ATTR + " .trace-sf-error { background: #fff4ed; color: #7c2d12; }",
      "." + ROOT_ATTR + " .trace-sf-confirm { align-items: center; background: #fff4ed; border-top: 1px solid rgba(65,72,70,0.12); display: flex; gap: 0.5rem; padding: 0.62rem 0.72rem; }",
      "." + ROOT_ATTR + " .trace-sf-confirm span { color: #46524a; flex: 1; font-size: 0.75rem; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-rename { padding: 0.65rem 0.72rem; }",
      "@media (min-width: 520px) { ." + ROOT_ATTR + " .trace-sf-scope { grid-template-columns: 1fr 1fr; } }",
      "@media (max-width: 720px) { ." + ROOT_ATTR + " .trace-sf-status[data-kind='unsaved'], ." + ROOT_ATTR + " .trace-sf-status[data-kind='edited'] { box-shadow: -0.86rem 0 0 #f8efe8, 0.86rem 0 0 #f8efe8; } ." + ROOT_ATTR + " .trace-sf-status[data-kind='active'] { box-shadow: -0.86rem 0 0 #e9f2ec, 0.86rem 0 0 #e9f2ec; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true'] { box-shadow: -0.86rem 0 0 #e9f2ec, 0.86rem 0 0 #e9f2ec; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true']:hover { box-shadow: -0.86rem 0 0 #dcebe1, 0.86rem 0 0 #dcebe1; } ." + ROOT_ATTR + " .trace-sf-row[data-menu-open='true'] { box-shadow: -0.86rem 0 0 #f7f6f1, 0.86rem 0 0 #f7f6f1; } }",
      "@container (max-width: 480px) { ." + ROOT_ATTR + " { font-size: 14px; } ." + ROOT_ATTR + " .trace-sf-card { background: transparent; border: 0; border-bottom: 1px solid #cfcec9; border-radius: 0; box-shadow: none; overflow: visible; } ." + ROOT_ATTR + " .trace-sf-head { gap: 0.45rem; padding: 0.56rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-mark { border-radius: 0.3rem; height: 1.18rem; width: 1.18rem; } ." + ROOT_ATTR + " .trace-sf-head-text { align-items: flex-start; display: grid; flex: 1; gap: 0.08rem; } ." + ROOT_ATTR + " .trace-sf-title { font-size: 0.92rem; line-height: 1.08; } ." + ROOT_ATTR + " .trace-sf-count { background: #dededa; border-color: #cbcac5; font-size: 0.64rem; } ." + ROOT_ATTR + " .trace-sf-head-meta { display: block; font-size: 0.66rem; } ." + ROOT_ATTR + " .trace-sf-panel-caret { display: inline-flex; justify-content: center; } ." + ROOT_ATTR + " .trace-sf-card[data-panel-collapsed='true'] .trace-sf-panel { display: none; } ." + ROOT_ATTR + " .trace-sf-status { border-top: 1px solid #dcdbd6; flex-wrap: wrap; padding: 0.5rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-status[data-kind='unsaved'], ." + ROOT_ATTR + " .trace-sf-status[data-kind='edited'] { background: #f8efe8; } ." + ROOT_ATTR + " .trace-sf-status[data-kind='active'] { background: #e9f2ec; } ." + ROOT_ATTR + " .trace-sf-status-actions { width: 100%; } ." + ROOT_ATTR + " .trace-sf-status-actions .trace-sf-btn { flex: 1; } ." + ROOT_ATTR + " .trace-sf-btn { border-radius: 0.32rem; font-size: 0.72rem; padding: 0.42rem 0.64rem; } ." + ROOT_ATTR + " .trace-sf-list { background: transparent; border-top: 1px solid #dcdbd6; max-height: min(18.5rem, 44vh); } ." + ROOT_ATTR + " .trace-sf-group + .trace-sf-group { border-top: 1px solid #dcdbd6; } ." + ROOT_ATTR + " .trace-sf-group-head { background: transparent; min-height: 1.85rem; padding: 0.34rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-group[data-group='context'] .trace-sf-group-head { background: transparent; } ." + ROOT_ATTR + " .trace-sf-group-title { color: #5c5b54; font-size: 0.58rem; letter-spacing: 0.1em; } ." + ROOT_ATTR + " .trace-sf-group[data-group='context'] .trace-sf-group-title { color: #1f5c45; } ." + ROOT_ATTR + " .trace-sf-group-count { background: transparent; border-color: #cfcec9; font-size: 0.6rem; } ." + ROOT_ATTR + " .trace-sf-row { background: transparent; border-top: 1px solid #dcdbd6; } ." + ROOT_ATTR + " .trace-sf-row:hover { background: #e7e6e1; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true'] { background: #e9f2ec; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true']:hover { background: #dcebe1; } ." + ROOT_ATTR + " .trace-sf-row[data-menu-open='true'] { background: #f7f6f1; } ." + ROOT_ATTR + " .trace-sf-row-inner { grid-template-columns: 3px minmax(0, 1fr) 1.8rem; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true'] .trace-sf-edge { background: #2f7d5b; } ." + ROOT_ATTR + " .trace-sf-main { padding: 0.5rem 0.42rem 0.52rem 0.62rem; } ." + ROOT_ATTR + " .trace-sf-main:hover { background: transparent; } ." + ROOT_ATTR + " .trace-sf-name { display: -webkit-box; font-size: 0.82rem; line-height: 1.2; overflow: hidden; text-overflow: clip; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; } ." + ROOT_ATTR + " .trace-sf-summary { color: #6d6c67; font-size: 0.66rem; -webkit-line-clamp: 2; } ." + ROOT_ATTR + " .trace-sf-menu-btn { border-radius: 0.3rem; height: 1.8rem; width: 1.8rem; } ." + ROOT_ATTR + " .trace-sf-form, ." + ROOT_ATTR + " .trace-sf-empty, ." + ROOT_ATTR + " .trace-sf-note, ." + ROOT_ATTR + " .trace-sf-error { border-top: 1px solid #dcdbd6; padding: 0.72rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-input, ." + ROOT_ATTR + " .trace-sf-preview, ." + ROOT_ATTR + " .trace-sf-scope button { border-radius: 0.32rem; } ." + ROOT_ATTR + " .trace-sf-scope { grid-template-columns: 1fr; } }",
      "@media (max-width: 720px) { ." + ROOT_ATTR + " { font-size: 14px; margin: 0.1rem 0 0.75rem; position: relative; z-index: 1; } ." + ROOT_ATTR + " .trace-sf-card { background: transparent; border: 0; border-bottom: 1px solid #cfcec9; border-radius: 0; box-shadow: none; overflow: visible; } ." + ROOT_ATTR + " .trace-sf-head { gap: 0.45rem; padding: 0.56rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-mark { border-radius: 0.3rem; height: 1.18rem; width: 1.18rem; } ." + ROOT_ATTR + " .trace-sf-head-text { align-items: flex-start; display: grid; flex: 1; gap: 0.08rem; } ." + ROOT_ATTR + " .trace-sf-title { font-size: 0.92rem; line-height: 1.08; } ." + ROOT_ATTR + " .trace-sf-count { background: #dededa; border-color: #cbcac5; font-size: 0.64rem; } ." + ROOT_ATTR + " .trace-sf-head-meta { display: block; font-size: 0.66rem; } ." + ROOT_ATTR + " .trace-sf-panel-caret { display: inline-flex; justify-content: center; } ." + ROOT_ATTR + " .trace-sf-card[data-panel-collapsed='true'] .trace-sf-panel { display: none; } ." + ROOT_ATTR + " .trace-sf-status { border-top: 1px solid #dcdbd6; flex-wrap: wrap; padding: 0.5rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-status[data-kind='unsaved'], ." + ROOT_ATTR + " .trace-sf-status[data-kind='edited'] { background: #f8efe8; } ." + ROOT_ATTR + " .trace-sf-status[data-kind='active'] { background: #e9f2ec; } ." + ROOT_ATTR + " .trace-sf-status-actions { width: 100%; } ." + ROOT_ATTR + " .trace-sf-status-actions .trace-sf-btn { flex: 1; } ." + ROOT_ATTR + " .trace-sf-btn { border-radius: 0.32rem; font-size: 0.72rem; padding: 0.42rem 0.64rem; } ." + ROOT_ATTR + " .trace-sf-list { background: transparent; border-top: 1px solid #dcdbd6; max-height: min(18.5rem, 44vh); } ." + ROOT_ATTR + " .trace-sf-group + .trace-sf-group { border-top: 1px solid #dcdbd6; } ." + ROOT_ATTR + " .trace-sf-group-head { background: transparent; min-height: 1.85rem; padding: 0.34rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-group[data-group='context'] .trace-sf-group-head { background: transparent; } ." + ROOT_ATTR + " .trace-sf-group-title { color: #5c5b54; font-size: 0.58rem; letter-spacing: 0.1em; } ." + ROOT_ATTR + " .trace-sf-group[data-group='context'] .trace-sf-group-title { color: #1f5c45; } ." + ROOT_ATTR + " .trace-sf-group-count { background: transparent; border-color: #cfcec9; font-size: 0.6rem; } ." + ROOT_ATTR + " .trace-sf-row { background: transparent; border-top: 1px solid #dcdbd6; } ." + ROOT_ATTR + " .trace-sf-row:hover { background: #e7e6e1; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true'] { background: #e9f2ec; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true']:hover { background: #dcebe1; } ." + ROOT_ATTR + " .trace-sf-row[data-menu-open='true'] { background: #f7f6f1; } ." + ROOT_ATTR + " .trace-sf-row-inner { grid-template-columns: 3px minmax(0, 1fr) 1.8rem; } ." + ROOT_ATTR + " .trace-sf-row[data-active='true'] .trace-sf-edge { background: #2f7d5b; } ." + ROOT_ATTR + " .trace-sf-main { padding: 0.5rem 0.42rem 0.52rem 0.62rem; } ." + ROOT_ATTR + " .trace-sf-main:hover { background: transparent; } ." + ROOT_ATTR + " .trace-sf-name { display: -webkit-box; font-size: 0.82rem; line-height: 1.2; overflow: hidden; text-overflow: clip; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; } ." + ROOT_ATTR + " .trace-sf-summary { color: #6d6c67; font-size: 0.66rem; -webkit-line-clamp: 2; } ." + ROOT_ATTR + " .trace-sf-menu-btn { border-radius: 0.3rem; height: 1.8rem; width: 1.8rem; } ." + ROOT_ATTR + " .trace-sf-form, ." + ROOT_ATTR + " .trace-sf-empty, ." + ROOT_ATTR + " .trace-sf-note, ." + ROOT_ATTR + " .trace-sf-error { border-top: 1px solid #dcdbd6; padding: 0.72rem 0.74rem; } ." + ROOT_ATTR + " .trace-sf-input, ." + ROOT_ATTR + " .trace-sf-preview, ." + ROOT_ATTR + " .trace-sf-scope button { border-radius: 0.32rem; } ." + ROOT_ATTR + " .trace-sf-scope { grid-template-columns: 1fr; } }",
      "@container (max-width: 480px) { ." + ROOT_ATTR + " .trace-sf-head { display: grid; grid-template-columns: 0.62rem 1.18rem max-content minmax(0, 1fr); grid-template-rows: auto auto; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] { grid-template-columns: 1.18rem max-content minmax(0, 1fr); } ." + ROOT_ATTR + " .trace-sf-panel-caret { display: inline-flex; grid-column: 1; grid-row: 1 / span 2; justify-content: center; } ." + ROOT_ATTR + " .trace-sf-mark { grid-column: 2; grid-row: 1 / span 2; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-mark { grid-column: 1; } ." + ROOT_ATTR + " .trace-sf-spacer { display: block; grid-column: 4; grid-row: 1; min-width: 0; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-spacer { grid-column: 3; } ." + ROOT_ATTR + " .trace-sf-head-text { display: contents; } ." + ROOT_ATTR + " .trace-sf-title-line { grid-column: 3; grid-row: 1; min-width: max-content; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-title-line { grid-column: 2; } ." + ROOT_ATTR + " .trace-sf-title { overflow: visible; text-overflow: clip; white-space: nowrap; } ." + ROOT_ATTR + " .trace-sf-head-actions { display: none; } ." + ROOT_ATTR + " .trace-sf-head-meta { display: block; grid-column: 3 / 5; grid-row: 2; min-width: 0; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-head-meta { grid-column: 2 / 4; } ." + ROOT_ATTR + " .trace-sf-status-main { white-space: normal; line-height: 1.35; } ." + ROOT_ATTR + " .trace-sf-status-actions { display: grid; gap: 0.42rem; grid-template-columns: repeat(auto-fit, minmax(7.25rem, 1fr)); } ." + ROOT_ATTR + " .trace-sf-status-actions .trace-sf-btn { font-size: 0.78rem; min-height: 2.55rem; min-width: 0; padding: 0.52rem 0.7rem; width: 100%; } ." + ROOT_ATTR + " .trace-sf-actions { flex-wrap: wrap; } ." + ROOT_ATTR + " .trace-sf-actions .trace-sf-btn { min-width: 6rem; } }",
      "@media (max-width: 720px) { ." + ROOT_ATTR + " .trace-sf-head { display: grid; grid-template-columns: 0.62rem 1.18rem max-content minmax(0, 1fr); grid-template-rows: auto auto; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] { grid-template-columns: 1.18rem max-content minmax(0, 1fr); } ." + ROOT_ATTR + " .trace-sf-panel-caret { display: inline-flex; grid-column: 1; grid-row: 1 / span 2; justify-content: center; } ." + ROOT_ATTR + " .trace-sf-mark { grid-column: 2; grid-row: 1 / span 2; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-mark { grid-column: 1; } ." + ROOT_ATTR + " .trace-sf-spacer { display: block; grid-column: 4; grid-row: 1; min-width: 0; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-spacer { grid-column: 3; } ." + ROOT_ATTR + " .trace-sf-head-text { display: contents; } ." + ROOT_ATTR + " .trace-sf-title-line { grid-column: 3; grid-row: 1; min-width: max-content; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-title-line { grid-column: 2; } ." + ROOT_ATTR + " .trace-sf-title { overflow: visible; text-overflow: clip; white-space: nowrap; } ." + ROOT_ATTR + " .trace-sf-head-actions { display: none; } ." + ROOT_ATTR + " .trace-sf-head-meta { display: block; grid-column: 3 / 5; grid-row: 2; min-width: 0; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-head-meta { grid-column: 2 / 4; } ." + ROOT_ATTR + " .trace-sf-status-main { white-space: normal; line-height: 1.35; } ." + ROOT_ATTR + " .trace-sf-status-actions { display: grid; gap: 0.42rem; grid-template-columns: repeat(auto-fit, minmax(7.25rem, 1fr)); } ." + ROOT_ATTR + " .trace-sf-status-actions .trace-sf-btn { font-size: 0.78rem; min-height: 2.55rem; min-width: 0; padding: 0.52rem 0.7rem; width: 100%; } ." + ROOT_ATTR + " .trace-sf-actions { flex-wrap: wrap; } ." + ROOT_ATTR + " .trace-sf-actions .trace-sf-btn { min-width: 6rem; } }",
      "." + ROOT_ATTR + " .trace-sf-title { font-family: 'Lucida Grande', 'Helvetica Neue', Arial, sans-serif; font-size: 0.9rem; letter-spacing: 0; }",
      "." + ROOT_ATTR + " .trace-sf-by { color: #6d6c67; font-size: 0.68rem; font-weight: 400; }",
      "." + ROOT_ATTR + " .trace-sf-head { gap: 0.42rem; padding-left: 0.72rem; padding-right: 0.72rem; }",
      "." + ROOT_ATTR + " .trace-sf-row-inner { grid-template-columns: 2px minmax(0, 1fr) 2.2rem; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-active='true'] .trace-sf-edge { background: #990000; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-active='true'], ." + ROOT_ATTR + " .trace-sf-status[data-kind='active'] { background: #f3efef; }",
      "." + ROOT_ATTR + " .trace-sf-row[data-active='true'] .trace-sf-name, ." + ROOT_ATTR + " .trace-sf-group[data-group='context'] .trace-sf-group-title { color: #700; }",
      "." + ROOT_ATTR + " .trace-sf-btn-primary { background: #900; border-color: #700; color: #fff; }",
      "@media (max-width: 720px) { ." + ROOT_ATTR + " .trace-sf-head, ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] { display:grid; grid-template-columns:0.62rem minmax(0,1fr) auto; grid-template-rows:auto auto; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] { grid-template-columns:minmax(0,1fr) auto; } ." + ROOT_ATTR + " .trace-sf-panel-caret { grid-column:1; grid-row:1 / span 2; } ." + ROOT_ATTR + " .trace-sf-head-text { display:block; grid-column:2; grid-row:1; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-head-text { grid-column:1; } ." + ROOT_ATTR + " .trace-sf-spacer { display:none; } ." + ROOT_ATTR + " .trace-sf-head-meta { display:block; grid-column:2 / 4; grid-row:2; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-head-meta { grid-column:1 / 3; } ." + ROOT_ATTR + " .trace-sf-head-actions { display:none; } }",
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
    var collapsible = canCollapsePanel(relation, visiblePresets);
    var collapsed = collapsible && state.panelCollapsed;
    var html = "";
    html += "<div class='trace-sf-card' data-panel-collapsible='" + (collapsible ? "true" : "false") + "' data-panel-collapsed='" + (collapsed ? "true" : "false") + "'>";
    html += renderHeader(visiblePresets.length, relation, collapsible, collapsed);
    html += "<div class='trace-sf-panel'>";
    if (state.error) html += renderError(state.error);
    if (state.notice) html += renderNote(state.notice);
    html += renderStatus(relation);
    if (state.mode === "save") html += renderSaveForm();
    if (state.mode !== "save" || visiblePresets.length > 0) html += renderList(relation, visiblePresets);
    html += "</div>";
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

  function canCollapsePanel(relation, presets) {
    if (state.mode !== "list") return false;
    if (state.error || state.notice) return false;
    if (state.menuId || state.renameId || state.confirmDeleteId) return false;
    if (!presets || !presets.length) return false;
    return relation.type === "active" || relation.type === "none";
  }

  function renderHeader(count, relation, collapsible, collapsed) {
    var tag = collapsible ? "button" : "div";
    var collapsibleAttr = " data-collapsible='" + (collapsible ? "true" : "false") + "'";
    var action = collapsible
      ? " type='button' data-trace-sf-action='toggle-panel' aria-expanded='" + (collapsed ? "false" : "true") + "'"
      : "";
    var meta = collapsed ? headerSummaryText(relation, count) : savedFilterCountText(count);
    return (
      "<" + tag + " class='trace-sf-head'" + collapsibleAttr + action + ">" +
      (collapsible ? renderChevron("trace-sf-panel-caret", collapsed) : "") +
      "<span class='trace-sf-head-text'>" +
      "<span class='trace-sf-title-line'>" +
      "<span class='trace-sf-title'>Saved filters</span>" +
      "<span class='trace-sf-by'>by Trace</span>" +
      "</span>" +
      "</span>" +
      "<span class='trace-sf-spacer'></span>" +
      "<span class='trace-sf-head-actions'>" +
      "<span class='trace-sf-count'>" + count + "</span>" +
      "</span>" +
      "<span class='trace-sf-head-meta'>" + meta + "</span>" +
      "</" + tag + ">"
    );
  }

  function renderTraceMark() {
    return (
      "<span class='trace-sf-mark' aria-hidden='true'>" +
      "<svg width='64' height='64' viewBox='0 0 64 64' fill='none' xmlns='http://www.w3.org/2000/svg' focusable='false'>" +
      "<rect width='64' height='64' rx='12' fill='#16342D'/>" +
      "<path d='M31.5972 43.782C31.5972 45.706 32.1952 47.162 33.3912 48.15C34.6132 49.112 36.2122 49.593 38.1882 49.593C39.3322 49.593 40.5282 49.489 41.7762 49.281C43.0242 49.073 44.4802 48.722 46.1442 48.228V49.32C43.7262 50.75 41.7632 51.868 40.2552 52.674C38.7732 53.454 37.4992 54 36.4332 54.312C35.3672 54.65 34.2492 54.819 33.0792 54.819C31.5972 54.819 30.1932 54.481 28.8672 53.805C27.5672 53.129 26.5012 52.05 25.6692 50.568C24.8372 49.086 24.4212 47.136 24.4212 44.718V19.056L19.4682 16.014V15.468C19.7282 15.286 20.1182 15.039 20.6382 14.727C21.1582 14.389 21.7692 13.986 22.4712 13.518C23.1992 13.05 24.0182 12.517 24.9282 11.919C25.8382 11.321 26.8262 10.684 27.8922 10.008C28.9582 9.306 30.0762 8.578 31.2462 7.824H31.5972V15.468V43.782ZM29.1792 18.276V14.064H45.0522L44.4282 18.276H29.1792Z' fill='#FCF9F0'/>" +
      "</svg>" +
      "</span>"
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

  function renderGroupChevron(collapsed) {
    return (
      "<span class='trace-sf-group-caret' data-collapsed='" + (collapsed ? "true" : "false") + "' aria-hidden='true'>" +
      "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' focusable='false'>" +
      "<path d='M6 4l4 4-4 4'/>" +
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

  function headerSummaryText(relation, count) {
    if (relation && relation.type === "active" && relation.preset) {
      return "Showing <b>" + escapeHtml(relation.preset.name) + "</b>";
    }
    if (relation && relation.type === "edited" && relation.preset) {
      return "<b>" + escapeHtml(relation.preset.name) + "</b> edited";
    }
    if (relation && relation.type === "unsaved") return "Current filters aren't saved";
    if (count > 0) return "Choose a saved AO3 filter";
    return "Save reusable AO3 filters";
  }

  function savedFilterCountText(count) {
    return count === 1 ? "1 saved filter" : count + " saved filters";
  }

  function renderStatus(relation) {
    var canSaveNew = !isAtSavedFilterLimit();
    if (!state.current || !state.current.hasFilters) {
      return (
        "<div class='trace-sf-status' data-kind='none'>" +
        "<span class='trace-sf-dot'></span>" +
        "<span class='trace-sf-status-main'>No active AO3 filters to save</span>" +
        "</div>"
      );
    }
    if (relation.type === "active") {
      return (
        "<div class='trace-sf-status' data-kind='active'>" +
        "<span class='trace-sf-dot'></span>" +
        "<span class='trace-sf-status-main'>Showing <b>" + escapeHtml(relation.preset.name) + "</b></span>" +
        "</div>"
      );
    }
    if (relation.type === "edited") {
      return (
        "<div class='trace-sf-status' data-kind='edited'>" +
        "<span class='trace-sf-dot'></span>" +
        "<span class='trace-sf-status-main'><b>" + escapeHtml(relation.preset.name) + "</b> edited</span>" +
        (state.mode === "save" ? "" : "<span class='trace-sf-status-actions'>" +
        "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='update-current' data-id='" + escapeAttr(relation.preset.id) + "'>Update</button>" +
        (canSaveNew ? "<button type='button' class='trace-sf-btn trace-sf-btn-ghost' data-trace-sf-action='save-open'>Save new</button>" : "") +
        "</span>") +
        "</div>"
      );
    }
    return (
      "<div class='trace-sf-status' data-kind='unsaved'>" +
      "<span class='trace-sf-dot'></span>" +
      "<span class='trace-sf-status-main'>" + escapeHtml(canSaveNew ? "These filters aren't saved" : "Saved filter limit reached") + "</span>" +
      (state.mode === "save" || !canSaveNew ? "" : "<span class='trace-sf-status-actions'>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='save-open'>Save</button>" +
      "</span>") +
      "</div>"
    );
  }

  function renderError(message) {
    return "<div class='trace-sf-error'><b>Couldn't save.</b> " + escapeHtml(message) + "</div>";
  }

  function renderNote(message) {
    return "<div class='trace-sf-note'>" + escapeHtml(message) + "</div>";
  }

  function renderSaveForm() {
    var currentSummary = summaryForPairs(state.current ? state.current.pairs : []);
    var suggested = suggestedNameForSummary(currentSummary);
    var draftName = state.draftName || "";
    var contextAvailable = hasReusableContext();
    var scope = state.draftScope === "global" || !contextAvailable ? "global" : "context";
    var contextText = "Only show on this AO3 tag page";
    if (state.current && state.current.contextLabel) {
      contextText = "Only show on " + state.current.contextLabel;
    }
    return (
      "<div class='trace-sf-form' data-trace-sf-save-form>" +
      "<div class='trace-sf-label'>Name this filter</div>" +
      "<span class='trace-sf-input-row'>" +
      "<input class='trace-sf-input' data-trace-sf-name maxlength='" + MAX_NAME_LENGTH + "' autocomplete='off' autocapitalize='sentences' placeholder='" + escapeAttr(suggested) + "' value='" + escapeAttr(draftName) + "'>" +
      "<button type='button' class='trace-sf-clear-name' data-trace-sf-action='name-clear' aria-label='Clear filter name' title='Clear filter name'>&times;</button>" +
      "</span>" +
      "<div class='trace-sf-preview'>" + escapeHtml(summaryTextFromParts(currentSummary, "No active filters detected.")) + "</div>" +
      renderCapacityWarning() +
      "<div class='trace-sf-scope'>" +
      "<button type='button' data-trace-sf-action='scope-context' data-active='" + (scope === "context" ? "true" : "false") + "'" + (contextAvailable ? "" : " disabled") + ">" +
      "<span class='trace-sf-scope-title'>Current tag</span>" +
      "<span class='trace-sf-scope-desc'>" + escapeHtml(contextAvailable ? contextText : "Open an AO3 tag page to use this option") + "</span>" +
      "</button>" +
      "<button type='button' data-trace-sf-action='scope-global' data-active='" + (scope === "global" ? "true" : "false") + "'>" +
      "<span class='trace-sf-scope-title'>Global</span>" +
      "<span class='trace-sf-scope-desc'>Show on all AO3 filter pages; apply to the page you're on</span>" +
      "</button>" +
      "</div>" +
      "<div class='trace-sf-actions'>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-ghost' data-trace-sf-action='save-cancel'>Cancel</button>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='save-confirm'" + (state.current && state.current.canSave ? "" : " disabled") + ">Save filter</button>" +
      "</div>" +
      "</div>"
    );
  }

  function renderList(relation, presets) {
    if (!presets.length) {
      var hasOtherPresets = state.presets.length > 0;
      return (
        "<div class='trace-sf-empty'>" +
        "<h4>" + (hasOtherPresets ? "No saved filters for this page" : "Save a filter to reuse it") + "</h4>" +
        "<p>" + (hasOtherPresets ? "Save one here or use Global when a preset should appear across fandoms and tags." : "Save the current AO3 filter URL and Trace will reapply it in one click.") + "</p>" +
        "</div>"
      );
    }
    var groups = groupedPresetsForCurrent(presets);
    return (
      "<div class='trace-sf-list'>" +
      renderPresetGroup("context", "Current tag", groups.context, relation, groups) +
      renderPresetGroup("global", "Global", groups.global, relation, groups) +
      "</div>"
    );
  }

  function renderPresetGroup(groupKey, label, presets, relation, groups) {
    if (!presets.length) return "";
    var collapsed = isGroupCollapsed(groupKey, presets, relation, groups);
    var html = (
      "<div class='trace-sf-group' data-group='" + escapeAttr(groupKey) + "' data-collapsed='" + (collapsed ? "true" : "false") + "'>" +
      "<button type='button' class='trace-sf-group-head' data-trace-sf-action='toggle-group' data-group='" + escapeAttr(groupKey) + "' aria-expanded='" + (collapsed ? "false" : "true") + "'>" +
      renderGroupChevron(collapsed) +
      "<span class='trace-sf-group-title'>" + escapeHtml(label) + "</span>" +
      "<span class='trace-sf-group-count'>" + presets.length + "</span>" +
      "</button>"
    );
    if (!collapsed) {
      html += (
        "<div class='trace-sf-group-body'>" +
        presets.map(function (preset) {
          return renderPresetRow(preset, relation);
        }).join("") +
        "</div>"
      );
    }
    html += "</div>";
    return html;
  }

  function isGroupCollapsed(groupKey, presets, relation, groups) {
    if (Object.prototype.hasOwnProperty.call(state.collapsedGroups, groupKey)) {
      return Boolean(state.collapsedGroups[groupKey]);
    }
    if (groupHasRelationPreset(presets, relation)) return false;
    if (groupKey === "global" && groups.context.length > 0) return true;
    return false;
  }

  function groupHasRelationPreset(presets, relation) {
    if (!relation || !relation.preset || !relation.preset.id) return false;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === relation.preset.id) return true;
    }
    return false;
  }

  function renderPresetRow(preset, relation) {
    var isActive = relation.type === "active" && relation.preset && relation.preset.id === preset.id;
    var isRenaming = state.renameId === preset.id;
    var summaryParts = preset.summary && preset.summary.length
      ? preset.summary
      : summaryForPairs(preset.params);
    var summaryText = summaryTextFromParts(summaryParts, "AO3 filter");
    var summaryTitle = summaryText;
    var html = "<div class='trace-sf-row' data-id='" + escapeAttr(preset.id) + "' data-scope='" + escapeAttr(preset.scope === "global" ? "global" : "context") + "' data-active='" + (isActive ? "true" : "false") + "' data-menu-open='" + (state.menuId === preset.id ? "true" : "false") + "'>";
    if (isRenaming) {
      html += (
        "<div class='trace-sf-rename'>" +
        "<div class='trace-sf-label'>Rename</div>" +
        "<input class='trace-sf-input' data-trace-sf-rename-input maxlength='" + MAX_NAME_LENGTH + "' value='" + escapeAttr(preset.name) + "'>" +
        "<div class='trace-sf-actions'>" +
        "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='rename-save' data-id='" + escapeAttr(preset.id) + "'>Save name</button>" +
        "<button type='button' class='trace-sf-btn trace-sf-btn-ghost' data-trace-sf-action='rename-cancel'>Cancel</button>" +
        "</div>" +
        "</div>"
      );
    } else {
      html += (
        "<div class='trace-sf-row-inner'>" +
        "<span class='trace-sf-edge'></span>" +
        "<button type='button' class='trace-sf-main' data-trace-sf-action='apply' data-id='" + escapeAttr(preset.id) + "' title='Apply " + escapeAttr(preset.name) + "'>" +
        "<span class='trace-sf-row-title'>" +
        "<span class='trace-sf-name'>" + escapeHtml(preset.name) + "</span>" +
        "</span>" +
        "<span class='trace-sf-summary' title='" + escapeAttr(summaryTitle) + "'>" +
        escapeHtml(summaryText) +
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
      "<button type='button' data-trace-sf-action='update-current' data-id='" + escapeAttr(preset.id) + "'" + (canUpdate ? "" : " disabled title='Choose filters on this page before replacing this preset'") + ">Replace with current filters</button>" +
      "<button type='button' data-danger='true' data-trace-sf-action='delete-confirm' data-id='" + escapeAttr(preset.id) + "'>Delete</button>" +
      "</div>"
    );
  }

  function renderDeleteConfirm(preset) {
    return (
      "<div class='trace-sf-confirm'>" +
      "<span>Delete <b>" + escapeHtml(preset.name) + "</b>?</span>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-danger' data-trace-sf-action='delete' data-id='" + escapeAttr(preset.id) + "'>Delete</button>" +
      "<button type='button' class='trace-sf-link' data-trace-sf-action='delete-cancel'>Cancel</button>" +
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
    }
    if (event.key !== "Enter") {
      stopTracePropagation(event);
      return;
    }
    var saveForm = event.target && event.target.closest ? event.target.closest("[data-trace-sf-save-form]") : null;
    if (saveForm) {
      stopTraceEvent(event);
      saveCurrentPreset();
      return;
    }
    var renameInput = event.target && event.target.matches && event.target.matches("[data-trace-sf-rename-input]");
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
  }

  function dispatchAction(el) {
    var action = el.getAttribute("data-trace-sf-action");
    var id = el.getAttribute("data-id") || "";
    var group = el.getAttribute("data-group") || "";
    if (action === "save-open") return openSaveForm();
    if (action === "save-cancel") return cancelInlineModes();
    if (action === "save-confirm") return saveCurrentPreset();
    if (action === "name-clear") return clearDraftName();
    if (action === "scope-context") return setDraftScope("context");
    if (action === "scope-global") return setDraftScope("global");
    if (action === "toggle-panel") return togglePanel();
    if (action === "toggle-group") return toggleGroup(group, el);
    if (action === "apply") return applyPreset(id);
    if (action === "menu") return toggleMenu(id);
    if (action === "rename-open") return openRename(id);
    if (action === "rename-save") return renamePreset(id);
    if (action === "rename-cancel") return cancelInlineModes();
    if (action === "delete-confirm") return confirmDelete(id);
    if (action === "delete") return deletePreset(id);
    if (action === "delete-cancel") return cancelInlineModes();
    if (action === "update-current") return updatePresetToCurrent(id);
  }

  function openSaveForm() {
    state.current = getCurrentFilterState();
    if (isAtSavedFilterLimit()) {
      state.mode = "list";
      state.menuId = null;
      state.renameId = null;
      state.confirmDeleteId = null;
      state.error = savedFilterLimitMessage();
      state.notice = "";
      render();
      return;
    }
    state.mode = "save";
    state.panelCollapsed = false;
    state.menuId = null;
    state.renameId = null;
    state.confirmDeleteId = null;
    state.draftName = "";
    state.draftScope = hasReusableContext() ? "context" : "global";
    state.error = "";
    state.notice = "";
    render();
    focusSoon("[data-trace-sf-name]");
  }

  function setDraftScope(scope) {
    if (scope === "context" && !hasReusableContext()) return;
    state.draftScope = scope === "global" ? "global" : "context";
    render();
  }

  function clearDraftName() {
    state.draftName = "";
    render();
    focusSoon("[data-trace-sf-name]");
  }

  function toggleGroup(group, el) {
    if (group !== "context" && group !== "global") return;
    state.collapsedGroups[group] = el.getAttribute("aria-expanded") === "true";
    render();
  }

  function togglePanel() {
    state.panelCollapsed = !state.panelCollapsed;
    persistPanelCollapsed(state.panelCollapsed);
    render();
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
    state.confirmDeleteId = null;
    state.error = "";
    render();
  }

  function toggleMenu(id) {
    state.menuId = state.menuId === id ? null : id;
    if (state.menuId) state.panelCollapsed = false;
    state.renameId = null;
    state.confirmDeleteId = null;
    render();
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
    state.menuId = null;
    state.renameId = id;
    state.panelCollapsed = false;
    state.confirmDeleteId = null;
    state.error = "";
    render();
    focusSoon("[data-trace-sf-rename-input]");
  }

  function confirmDelete(id) {
    state.menuId = null;
    state.renameId = null;
    state.confirmDeleteId = id;
    state.panelCollapsed = false;
    state.error = "";
    render();
  }

  function focusSoon(selector) {
    setTimeout(function () {
      try {
        var input = state.root && state.root.querySelector(selector);
        if (input) input.focus();
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

  async function saveCurrentPreset() {
    state.current = getCurrentFilterState();
    if (!state.current.canSave) return;
    if (isAtSavedFilterLimit()) {
      state.mode = "list";
      state.error = savedFilterLimitMessage();
      render();
      return;
    }
    var name = currentNameInputValue("[data-trace-sf-name]") || suggestedNameForSummary(summaryForPairs(state.current.pairs));
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
      summary: summaryForPairs(state.current.pairs),
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
      state.notice = "";
      state.error = "";
    });
  }

  async function renamePreset(id) {
    var name = currentNameInputValue("[data-trace-sf-rename-input]");
    if (!name) return;
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
      state.menuId = null;
    });
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
        summary: summaryForPairs(state.current.pairs),
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
    });
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
    }, deleted);
  }

  async function commitStorage(presets, activeMeta, onSuccess, deleted) {
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
      if (typeof onSuccess === "function") onSuccess();
      render();
      requestSavedFiltersSync();
    } catch (err) {
      state.error = err && err.message ? err.message : "Local storage is unavailable. Try again.";
      render();
    }
  }

  function isAtSavedFilterLimit() {
    return state.presets.length >= SAVED_FILTER_ACTIVE_LIMIT;
  }

  function savedFilterLimitMessage() {
    return "You can keep up to " + SAVED_FILTER_ACTIVE_LIMIT + " AO3 saved filters. Delete one before saving another.";
  }

  function renderCapacityWarning() {
    if (state.presets.length < SAVED_FILTER_LIMIT_WARNING_THRESHOLD) return "";
    return (
      "<div class='trace-sf-capacity'>" +
      state.presets.length + " of " + SAVED_FILTER_ACTIVE_LIMIT + " saved filters used" +
      "</div>"
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
      state.notice = "No current fandom or tag context was detected. Applying on global works search.";
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
