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
    return value.slice(0, maxLength - 1).replace(/\s+$/, "") + "…";
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

  // Saved filters use Trace's page register: Story Ink
  // groups on the host tone, sentence-case labels, an ink check for the
  // active filter and teal text actions. No AO3 red, bars or serif.
  function pageTokens() {
    var light = {
      surface: "#FFFFFF", raised: "#E9EEF3", rule: "#D8E0E7", ink: "#18232D",
      secondary: "#5F6B76", tertiary: "#7B8792", teal: "#176E72", warning: "#9B4146",
    };
    var dark = {
      surface: "#19232D", raised: "#24323F", rule: "#344451", ink: "#F2F6FA",
      secondary: "#AEBBC5", tertiary: "#8D9AA5", teal: "#8BCDC8", warning: "#E7A19F",
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
    style.textContent = [
      "." + ROOT_ATTR + ", ." + ROOT_ATTR + " * { box-sizing: border-box; }",
      "." + ROOT_ATTR + " { container-type: inline-size; margin: 0 0 14px; color: var(--trace-page-ink); font-family: -apple-system, BlinkMacSystemFont, system-ui, \"Segoe UI\", Roboto, sans-serif; font-size: 14px; line-height: 1.4; -webkit-font-smoothing: antialiased; }",
      "." + ROOT_ATTR + " button, ." + ROOT_ATTR + " input { font: inherit; letter-spacing: 0; text-transform: none; text-shadow: none; }",
      "." + ROOT_ATTR + " button { -webkit-appearance: none; appearance: none; background: transparent; background-image: none; border: 0; border-radius: 8px; box-shadow: none; color: inherit; cursor: pointer; margin: 0; min-height: 0; }",
      "." + ROOT_ATTR + " :focus { outline: none; }",
      "." + ROOT_ATTR + " :focus-visible { outline: 3px solid var(--trace-page-teal) !important; outline-offset: 2px; }",
      "." + ROOT_ATTR + " .trace-sf-card { background: transparent; border: 0; border-bottom: 1px solid var(--trace-page-rule); border-radius: 0; box-shadow: none; overflow: visible; padding-bottom: 8px; }",
      "." + ROOT_ATTR + " .trace-sf-head { display: flex; align-items: center; gap: 8px; height: auto; min-height: 44px; padding: 4px 0; text-align: left; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-head-text { display: flex; align-items: baseline; gap: 8px; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-title-line { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-title { color: var(--trace-page-ink); font-size: 15px; font-weight: 600; line-height: 1.25; }",
      "." + ROOT_ATTR + " .trace-sf-head-actions { align-items: center; display: inline-flex; flex: 0 0 auto; gap: 6px; margin-left: auto; white-space: nowrap; }",
      "." + ROOT_ATTR + " .trace-sf-count { color: var(--trace-page-secondary); font-size: 12.5px; font-weight: 400; }",
      "." + ROOT_ATTR + " .trace-sf-head-meta { color: var(--trace-page-secondary); display: none; font-size: 13px; line-height: 1.3; min-width: 0; overflow-wrap: anywhere; }",
      "." + ROOT_ATTR + " .trace-sf-head-meta b { color: var(--trace-page-ink); font-weight: 500; }",
      "." + ROOT_ATTR + " .trace-sf-panel-caret { align-items: center; color: var(--trace-page-tertiary); display: none; flex: 0 0 auto; justify-content: center; width: 12px; }",
      "." + ROOT_ATTR + " .trace-sf-panel-caret svg { display: block; height: 12px; width: 12px; transition: transform 0.16s ease; }",
      "." + ROOT_ATTR + " .trace-sf-panel-caret[data-collapsed='false'] svg { transform: rotate(180deg); }",
      "." + ROOT_ATTR + " .trace-sf-spacer { flex: 1; }",
      "." + ROOT_ATTR + " .trace-sf-panel { min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-status { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 8px; padding: 2px 0 6px; color: var(--trace-page-secondary); font-size: 13px; line-height: 1.35; }",
      "." + ROOT_ATTR + " .trace-sf-check { color: var(--trace-page-ink); display: inline-flex; flex: 0 0 auto; height: 14px; width: 14px; }",
      "." + ROOT_ATTR + " .trace-sf-check svg { display: block; height: 14px; width: 14px; }",
      "." + ROOT_ATTR + " .trace-sf-status-main { flex: 1; min-width: 0; overflow-wrap: anywhere; }",
      "." + ROOT_ATTR + " .trace-sf-status-main b { color: var(--trace-page-ink); font-weight: 500; }",
      "." + ROOT_ATTR + " .trace-sf-status-actions { display: inline-flex; flex: 0 0 auto; gap: 0 12px; }",
      "." + ROOT_ATTR + " .trace-sf-btn { align-items: center; color: var(--trace-page-teal); display: inline-flex; font-size: 14px; font-weight: 500; gap: 4px; justify-content: center; line-height: 1.2; min-height: 44px; padding: 0 8px; text-decoration: none; }",
      "." + ROOT_ATTR + " .trace-sf-status-actions .trace-sf-btn { margin: 0 -8px; }",
      "." + ROOT_ATTR + " .trace-sf-btn-ghost { color: var(--trace-page-secondary); }",
      "." + ROOT_ATTR + " .trace-sf-btn-danger { color: var(--trace-page-warning); font-weight: 600; }",
      "." + ROOT_ATTR + " .trace-sf-btn:disabled { cursor: default; opacity: 0.55; }",
      "." + ROOT_ATTR + " .trace-sf-link { color: var(--trace-page-secondary); font-size: 14px; font-weight: 500; min-height: 44px; padding: 0 8px; }",
      "." + ROOT_ATTR + " .trace-sf-list { max-height: 22rem; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }",
      "." + ROOT_ATTR + " .trace-sf-group + .trace-sf-group { margin-top: 4px; }",
      "." + ROOT_ATTR + " .trace-sf-group-head { align-items: center; color: var(--trace-page-secondary); display: flex; gap: 6px; justify-content: flex-start; min-height: 44px; padding: 0; text-align: left; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-group-caret { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; flex: 0 0 auto; justify-content: center; width: 12px; }",
      "." + ROOT_ATTR + " .trace-sf-group-caret svg { display: block; height: 12px; width: 12px; transition: transform 0.14s ease; }",
      "." + ROOT_ATTR + " .trace-sf-group-caret[data-collapsed='false'] svg { transform: rotate(90deg); }",
      "." + ROOT_ATTR + " .trace-sf-group-title { color: var(--trace-page-secondary); flex: 1; font-size: 12px; font-weight: 600; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-group-count { color: var(--trace-page-secondary); flex: 0 0 auto; font-size: 12px; font-weight: 400; }",
      "." + ROOT_ATTR + " .trace-sf-group-body { background: var(--trace-page-surface); border-radius: 14px; box-shadow: inset 0 0 0 1px var(--trace-page-rule); padding: 0 4px 0 12px; }",
      "." + ROOT_ATTR + " .trace-sf-row { background: transparent; border-top: 1px solid var(--trace-page-rule); position: relative; }",
      "." + ROOT_ATTR + " .trace-sf-group-body .trace-sf-row:first-child { border-top: 0; }",
      "." + ROOT_ATTR + " .trace-sf-row-inner { display: grid; grid-template-columns: 22px minmax(0, 1fr) 44px; align-items: center; min-height: 52px; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-edge { align-self: center; color: var(--trace-page-ink); display: inline-flex; height: 14px; width: 14px; }",
      "." + ROOT_ATTR + " .trace-sf-edge svg { display: block; height: 14px; width: 14px; }",
      "." + ROOT_ATTR + " .trace-sf-main { display: block; min-width: 0; overflow: hidden; padding: 8px 6px 8px 0; text-align: left; white-space: normal; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-row-title { display: block; min-width: 0; }",
      "." + ROOT_ATTR + " .trace-sf-name { color: var(--trace-page-ink); display: block; font-size: 14px; font-weight: 500; line-height: 1.3; overflow-wrap: anywhere; }",
      "." + ROOT_ATTR + " .trace-sf-summary { color: var(--trace-page-secondary); display: block; font-size: 12.5px; line-height: 1.35; margin-top: 2px; overflow-wrap: anywhere; }",
      "." + ROOT_ATTR + " .trace-sf-menu-btn { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; height: 44px; justify-content: center; padding: 0; width: 44px; }",
      "." + ROOT_ATTR + " .trace-sf-menu-btn svg { display: block; height: 16px; width: 16px; }",
      "." + ROOT_ATTR + " .trace-sf-manage { align-items: center; border-top: 1px solid var(--trace-page-rule); display: flex; flex-wrap: wrap; gap: 0 14px; margin: 0 0 0 22px; animation: trace-sf-reveal 0.14s ease-out both; }",
      "." + ROOT_ATTR + " .trace-sf-manage button { color: var(--trace-page-teal); font-size: 13px; font-weight: 500; line-height: 1.2; margin: 0 -8px; min-height: 44px; padding: 0 8px; text-align: left; white-space: nowrap; }",
      "." + ROOT_ATTR + " .trace-sf-manage button:disabled { color: var(--trace-page-secondary); cursor: default; opacity: 0.55; }",
      "@keyframes trace-sf-reveal { from { opacity: 0; } to { opacity: 1; } }",
      "@media (prefers-reduced-motion: reduce) { ." + ROOT_ATTR + " .trace-sf-manage { animation: none; } ." + ROOT_ATTR + " .trace-sf-panel-caret svg, ." + ROOT_ATTR + " .trace-sf-group-caret svg { transition: none; } }",
      "." + ROOT_ATTR + " .trace-sf-form, ." + ROOT_ATTR + " .trace-sf-empty, ." + ROOT_ATTR + " .trace-sf-note, ." + ROOT_ATTR + " .trace-sf-error { padding: 8px 0; }",
      "." + ROOT_ATTR + " .trace-sf-label { color: var(--trace-page-secondary); font-size: 12px; font-weight: 600; margin-bottom: 6px; }",
      "." + ROOT_ATTR + " .trace-sf-input-row { display: block; position: relative; }",
      "." + ROOT_ATTR + " .trace-sf-input { background: var(--trace-page-surface); border: 0; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--trace-page-rule); color: var(--trace-page-ink); font-size: 14px; min-height: 44px; padding: 10px 12px; width: 100%; }",
      "." + ROOT_ATTR + " .trace-sf-input-row .trace-sf-input { padding-right: 44px; }",
      "." + ROOT_ATTR + " .trace-sf-input::placeholder { color: var(--trace-page-secondary); }",
      "." + ROOT_ATTR + " .trace-sf-clear-name { align-items: center; color: var(--trace-page-tertiary); display: inline-flex; font-size: 18px; font-weight: 500; height: 44px; justify-content: center; line-height: 1; padding: 0; position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 44px; }",
      "." + ROOT_ATTR + " .trace-sf-input:placeholder-shown + .trace-sf-clear-name { display: none; }",
      "." + ROOT_ATTR + " .trace-sf-preview { color: var(--trace-page-secondary); font-size: 12.5px; line-height: 1.4; margin-top: 6px; }",
      "." + ROOT_ATTR + " .trace-sf-capacity { color: var(--trace-page-secondary); font-size: 12.5px; line-height: 1.35; margin-top: 6px; }",
      "." + ROOT_ATTR + " .trace-sf-scope { display: grid; gap: 6px; grid-template-columns: 1fr; margin-top: 10px; }",
      "." + ROOT_ATTR + " .trace-sf-scope button { background: var(--trace-page-surface); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--trace-page-rule); color: var(--trace-page-ink); min-height: 44px; min-width: 0; overflow: visible; padding: 8px 12px; text-align: left; white-space: normal; }",
      "." + ROOT_ATTR + " .trace-sf-scope button[data-active='true'] { background: var(--trace-page-raised); box-shadow: inset 0 0 0 2px var(--trace-page-ink); }",
      "." + ROOT_ATTR + " .trace-sf-scope button:disabled { cursor: default; opacity: 0.55; }",
      "." + ROOT_ATTR + " .trace-sf-scope-title { display: block; font-size: 14px; font-weight: 500; }",
      "." + ROOT_ATTR + " .trace-sf-scope-desc { color: var(--trace-page-secondary); display: block; font-size: 12.5px; line-height: 1.35; margin-top: 2px; }",
      "." + ROOT_ATTR + " .trace-sf-actions { display: flex; flex-wrap: wrap; gap: 0 16px; margin-top: 4px; }",
      "." + ROOT_ATTR + " .trace-sf-actions .trace-sf-btn { margin: 0 -8px; }",
      "." + ROOT_ATTR + " .trace-sf-empty h4 { color: var(--trace-page-ink); font-size: 14px; font-weight: 600; margin: 0 0 2px; }",
      "." + ROOT_ATTR + " .trace-sf-empty p, ." + ROOT_ATTR + " .trace-sf-note { color: var(--trace-page-secondary); font-size: 13px; margin: 0; }",
      "." + ROOT_ATTR + " .trace-sf-error { align-items: flex-start; color: var(--trace-page-ink); display: flex; font-size: 13px; gap: 6px; margin: 0; }",
      "." + ROOT_ATTR + " .trace-sf-error-glyph { color: var(--trace-page-warning); display: inline-flex; flex: 0 0 auto; height: 14px; margin-top: 2px; width: 14px; }",
      "." + ROOT_ATTR + " .trace-sf-error-glyph svg { display: block; height: 14px; width: 14px; }",
      "." + ROOT_ATTR + " .trace-sf-error b { font-weight: 600; }",
      "." + ROOT_ATTR + " .trace-sf-confirm { border-top: 1px solid var(--trace-page-rule); margin-left: 22px; padding: 10px 0 0; }",
      "." + ROOT_ATTR + " .trace-sf-confirm-title { color: var(--trace-page-ink); display: block; font-size: 13px; font-weight: 500; }",
      "." + ROOT_ATTR + " .trace-sf-confirm-detail { color: var(--trace-page-secondary); display: block; font-size: 12.5px; margin-top: 2px; }",
      "." + ROOT_ATTR + " .trace-sf-confirm-actions { display: flex; gap: 0 16px; }",
      "." + ROOT_ATTR + " .trace-sf-confirm-actions button { margin: 0 -8px; }",
      "." + ROOT_ATTR + " .trace-sf-rename { padding: 10px 0; }",
      "@media (min-width: 520px) { ." + ROOT_ATTR + " .trace-sf-scope { grid-template-columns: 1fr 1fr; } }",
      "@container (max-width: 480px) { ." + ROOT_ATTR + " .trace-sf-panel-caret { display: inline-flex; justify-content: center; } ." + ROOT_ATTR + " .trace-sf-card[data-panel-collapsed='true'] .trace-sf-panel { display: none; } ." + ROOT_ATTR + " .trace-sf-head-meta { display: block; } ." + ROOT_ATTR + " .trace-sf-scope { grid-template-columns: 1fr; } }",
      "@media (max-width: 720px) { ." + ROOT_ATTR + " .trace-sf-head, ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; grid-template-rows: auto auto; column-gap: 8px; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] { grid-template-columns: minmax(0, 1fr) auto; } ." + ROOT_ATTR + " .trace-sf-panel-caret { display: inline-flex; grid-column: 1; grid-row: 1 / span 2; } ." + ROOT_ATTR + " .trace-sf-card[data-panel-collapsed='true'] .trace-sf-panel { display: none; } ." + ROOT_ATTR + " .trace-sf-head-text { display: block; grid-column: 2; grid-row: 1; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-head-text { grid-column: 1; } ." + ROOT_ATTR + " .trace-sf-spacer { display: none; } ." + ROOT_ATTR + " .trace-sf-head-meta { display: block; grid-column: 2 / 4; grid-row: 2; } ." + ROOT_ATTR + " .trace-sf-head[data-collapsible='false'] .trace-sf-head-meta { grid-column: 1 / 3; } ." + ROOT_ATTR + " .trace-sf-head-actions { display: none; } ." + ROOT_ATTR + " .trace-sf-status-actions { flex-wrap: wrap; } }",
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
      "</span>" +
      "</span>" +
      "<span class='trace-sf-spacer'></span>" +
      "<span class='trace-sf-head-actions'>" +
      "<span class='trace-sf-count'>" + count + " saved</span>" +
      "</span>" +
      "<span class='trace-sf-head-meta'>" + meta + "</span>" +
      "</" + tag + ">"
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
        "<span class='trace-sf-status-main'>No active AO3 filters to save</span>" +
        "</div>"
      );
    }
    if (relation.type === "active") {
      return (
        "<div class='trace-sf-status' data-kind='active'>" +
        "<span class='trace-sf-check'>" + renderCheckIcon() + "</span>" +
        "<span class='trace-sf-status-main'>Showing <b>" + escapeHtml(relation.preset.name) + "</b></span>" +
        "</div>"
      );
    }
    if (relation.type === "edited") {
      return (
        "<div class='trace-sf-status' data-kind='edited'>" +
        "<span class='trace-sf-status-main'><b>" + escapeHtml(relation.preset.name) + "</b> edited</span>" +
        (state.mode === "save" ? "" : "<span class='trace-sf-status-actions'>" +
        "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='update-current' data-id='" + escapeAttr(relation.preset.id) + "'>Update</button>" +
        (canSaveNew ? "<button type='button' class='trace-sf-btn' data-trace-sf-action='save-open'>Save new</button>" : "") +
        "</span>") +
        "</div>"
      );
    }
    return (
      "<div class='trace-sf-status' data-kind='unsaved'>" +
      "<span class='trace-sf-status-main'>" + escapeHtml(canSaveNew ? "These filters aren't saved" : "Saved filter limit reached") + "</span>" +
      (state.mode === "save" || !canSaveNew ? "" : "<span class='trace-sf-status-actions'>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-primary' data-trace-sf-action='save-open'>Save</button>" +
      "</span>") +
      "</div>"
    );
  }

  function renderError(message) {
    return "<div class='trace-sf-error'><span class='trace-sf-error-glyph'>" + renderAlertIcon() + "</span><span><b>Couldn’t save.</b> " + escapeHtml(message) + "</span></div>";
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
      "<span class='trace-sf-scope-title'>This tag</span>" +
      "<span class='trace-sf-scope-desc'>" + escapeHtml(contextAvailable ? contextText : "Open an AO3 tag page to use this option") + "</span>" +
      "</button>" +
      "<button type='button' data-trace-sf-action='scope-global' data-active='" + (scope === "global" ? "true" : "false") + "'>" +
      "<span class='trace-sf-scope-title'>All tags</span>" +
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
      renderPresetGroup("context", "This tag", groups.context, relation, groups) +
      renderPresetGroup("global", "All tags", groups.global, relation, groups) +
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
        "<span class='trace-sf-edge'>" + (isActive ? renderCheckIcon() : "") + "</span>" +
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
      "<span class='trace-sf-confirm-title'>Delete “" + escapeHtml(preset.name) + "”?</span>" +
      "<span class='trace-sf-confirm-detail'>It goes from every device. AO3 isn’t changed.</span>" +
      "<span class='trace-sf-confirm-actions'>" +
      "<button type='button' class='trace-sf-btn trace-sf-btn-danger' data-trace-sf-action='delete' data-id='" + escapeAttr(preset.id) + "'>Delete</button>" +
      "<button type='button' class='trace-sf-link' data-trace-sf-action='delete-cancel'>Cancel</button>" +
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
