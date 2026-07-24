// library-overlay.js — Trace library lens on AO3/FFN listings.
// Reads story links from the current page and cached library status from extension storage.
// Sends quick-add metadata or hidden preference changes to background.js only from user clicks.
// Does not read cookies or credentials, and exits on pages with password fields.
(function () {
  "use strict";
  const ext = globalThis.browser ?? globalThis.chrome;
  const ATTR = "data-trace-library-overlay";
  const WRAP_ATTR = "data-trace-library-overlay-wrap";
  const CONNECT_NOTICE_ATTR = "data-trace-connect-notice";
  const CONNECT_NOTICE_DISMISS_KEY = "trace:connect-notice:dismissed";
  const LENS_ATTR = "data-trace-library-lens";
  const ACTION_SURFACE_ATTR = "data-trace-action-surface";
  const ACTION_SURFACE_CLOSE_ATTR = "data-trace-action-surface-close";
  const TRACE_SESSION_MODE = globalThis.TRACE_SESSION_MODE || "legacy";
  const KERNEL_SESSION_ACTIVE = TRACE_SESSION_MODE === "kernel";
  const TRACE_WEB_HOME_URL = configuredTraceWebHomeUrl();
  const ACCOUNT_PROJECTION_GET_MESSAGE = "TRACE_ACCOUNT_PROJECTION_GET";
  const MAX_PROJECTION_WORK_KEYS = 250;
  const TRACE_ACCOUNT_ID_KEY = "traceAccountId";
  const TRACE_API_BASE_STORAGE_KEY = "traceApiBase";
  var currentTraceAuthState = null;

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

  function usefulTraceUrl(rawUrl) {
    var fallback = TRACE_WEB_HOME_URL;
    if (!rawUrl) return fallback;
    try {
      var url = new URL(rawUrl, fallback);
      if (url.pathname === "/apps" || url.pathname === "/apps/") {
        return url.origin + "/";
      }
      return url.href;
    } catch (_) {
      return fallback;
    }
  }

  function traceOpenUrl() {
    return usefulTraceUrl(currentTraceAuthState && currentTraceAuthState.helpUrl);
  }

  function traceEntryOpenUrl(entry) {
    var base = traceOpenUrl();
    var entryId = entry && typeof entry.entryId === "string" ? entry.entryId.trim() : "";
    if (!entryId) return base;
    try {
      var url = new URL(base, TRACE_WEB_HOME_URL);
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      url.searchParams.set("panel", "details");
      url.searchParams.set("entryId", entryId);
      return url.href;
    } catch (_) {
      return base;
    }
  }

  function openTraceUrlInBrowserTab(url) {
    if (!url) return;
    try {
      ext.runtime.sendMessage({
        type: "TRACE_OPEN_TRACE_URL",
        payload: { url: url },
      });
    } catch {
      /* The background worker handles Trace tab creation when available. */
    }
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

  function authStateAllowsActions(authState, hasAuth) {
    if (!hasAuth) return false;
    var state = authState && authState.state ? authState.state : "connected";
    return state !== "signed_out" && state !== "reconnect_required";
  }

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

  function tracePageHasPasswordField() {
    if (traceIsCredentialPageUrl()) return true;
    try {
      var inputs = document.querySelectorAll("input");
      for (var i = 0; i < inputs.length; i++) {
        if (String(inputs[i] && inputs[i].type ? inputs[i].type : "").toLowerCase() === "password") {
          if (traceIsKnownHeaderPasswordField(inputs[i])) continue;
          return true;
        }
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  if (tracePageHasPasswordField()) return;

  const TRACE_UI = {
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
    gold: "#f1d58a",
    goldOn: "#594402",
    rust: "#9a3412",
    danger: "#ba1a1a",
    radiusXs: "7px",
    radiusSm: "8px",
    radiusMd: "10px",
    shadowLow: "0 1px 2px rgba(28,28,23,0.08)",
    shadowPopover: "0 18px 44px rgba(28,28,23,0.22)",
  };
  const TRACE_D1 = {
    font: "Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
    mono: "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    paper: "#f3efe4",
    paper2: "#ebe6d7",
    card: "#f7f3e9",
    card2: "#ede8d8",
    ink: "#1c2722",
    ink2: "#3a4339",
    ink3: "#6e6a5b",
    ink4: "#9a9583",
    ink5: "#c4bea8",
    line: "rgba(28,39,34,0.10)",
    lineStrong: "rgba(28,39,34,0.18)",
    forest: "#1f4d3f",
    forestDeep: "#133029",
    rust: "#b54a30",
    honey: "#8a6e2a",
    forestSoft: "#d8e3d5",
    honeySoft: "#ebdcab",
    forestLine: "rgba(31,77,63,0.35)",
    mutedLine: "rgba(110,106,91,0.3)",
    rustLine: "rgba(181,74,48,0.36)",
    honeyLine: "rgba(138,110,42,0.35)",
  };
  const PRIVATE_TAG_DISPLAY_LIMIT = 3;

  const STATUS_TOKENS = {
    SAVED:     { accent: "#5b7488", container: "#e4e9ed", onContainer: "#3a566b", border: "#bfccd6" },
    READING:   { accent: "#bf8a1f", container: "#f4e6c2", onContainer: "#7c5400", border: "#e1c886" },
    CAUGHT_UP: { accent: "#1f8a7d", container: "#d6ece6", onContainer: "#136257", border: "#a3d2c9" },
    PAUSED:    { accent: "#a8623a", container: "#efddcd", onContainer: "#79401f", border: "#dcbe9f" },
    FINISHED:  { accent: "#4a8157", container: "#dcecde", onContainer: "#33603f", border: "#aacdb0" },
    DROPPED:   { accent: "#83707b", container: "#e8e0e3", onContainer: "#574852", border: "#cdbfc5" },
  };
  STATUS_TOKENS.PLANNING = STATUS_TOKENS.SAVED;
  STATUS_TOKENS.COMPLETED = STATUS_TOKENS.FINISHED;

  /** Local extension UI tones, aligned to the current Trace archive palette. */
  const STATUS_THEME = {
    READING: {
      bg: STATUS_TOKENS.READING.container,
      fg: STATUS_TOKENS.READING.onContainer,
      border: STATUS_TOKENS.READING.border,
    },
    PLANNING: {
      bg: STATUS_TOKENS.PLANNING.container,
      fg: STATUS_TOKENS.PLANNING.onContainer,
      border: STATUS_TOKENS.PLANNING.border,
    },
    PAUSED: {
      bg: STATUS_TOKENS.PAUSED.container,
      fg: STATUS_TOKENS.PAUSED.onContainer,
      border: STATUS_TOKENS.PAUSED.border,
    },
    COMPLETED: {
      bg: STATUS_TOKENS.COMPLETED.container,
      fg: STATUS_TOKENS.COMPLETED.onContainer,
      border: STATUS_TOKENS.COMPLETED.border,
    },
    DROPPED: {
      bg: STATUS_TOKENS.DROPPED.container,
      fg: STATUS_TOKENS.DROPPED.onContainer,
      border: STATUS_TOKENS.DROPPED.border,
    },
    SAVED: {
      bg: STATUS_TOKENS.SAVED.container,
      fg: STATUS_TOKENS.SAVED.onContainer,
      border: STATUS_TOKENS.SAVED.border,
    },
    CAUGHT_UP: {
      bg: STATUS_TOKENS.CAUGHT_UP.container,
      fg: STATUS_TOKENS.CAUGHT_UP.onContainer,
      border: STATUS_TOKENS.CAUGHT_UP.border,
    },
    FINISHED: {
      bg: STATUS_TOKENS.FINISHED.container,
      fg: STATUS_TOKENS.FINISHED.onContainer,
      border: STATUS_TOKENS.FINISHED.border,
    },
  };

  const UPDATED_THEME = {
    bg: "#e8f4f2",
    fg: "#0b4f6c",
    border: "rgba(11, 79, 108, 0.22)",
  };

  const HIDDEN_THEME = {
    bg: "#eee7da",
    fg: "#5b5142",
    border: "rgba(91, 81, 66, 0.28)",
  };

  const CONTEXT_THEME = {
    bg: "#edf2ef",
    fg: "#41504c",
    border: "rgba(65, 80, 76, 0.18)",
  };

  const INLINE_STATUS_THEME = {
    READING: {
      bg: STATUS_TOKENS.READING.container,
      fg: STATUS_TOKENS.READING.onContainer,
      border: STATUS_TOKENS.READING.border,
      accent: STATUS_TOKENS.READING.accent,
    },
    PLANNING: {
      bg: STATUS_TOKENS.PLANNING.container,
      fg: STATUS_TOKENS.PLANNING.onContainer,
      border: STATUS_TOKENS.PLANNING.border,
      accent: STATUS_TOKENS.PLANNING.accent,
    },
    PAUSED: {
      bg: STATUS_TOKENS.PAUSED.container,
      fg: STATUS_TOKENS.PAUSED.onContainer,
      border: STATUS_TOKENS.PAUSED.border,
      accent: STATUS_TOKENS.PAUSED.accent,
    },
    COMPLETED: {
      bg: STATUS_TOKENS.COMPLETED.container,
      fg: STATUS_TOKENS.COMPLETED.onContainer,
      border: STATUS_TOKENS.COMPLETED.border,
      accent: STATUS_TOKENS.COMPLETED.accent,
    },
    DROPPED: {
      bg: STATUS_TOKENS.DROPPED.container,
      fg: STATUS_TOKENS.DROPPED.onContainer,
      border: STATUS_TOKENS.DROPPED.border,
      accent: STATUS_TOKENS.DROPPED.accent,
    },
    SAVED: {
      bg: STATUS_TOKENS.SAVED.container,
      fg: STATUS_TOKENS.SAVED.onContainer,
      border: STATUS_TOKENS.SAVED.border,
      accent: STATUS_TOKENS.SAVED.accent,
    },
    CAUGHT_UP: {
      bg: STATUS_TOKENS.CAUGHT_UP.container,
      fg: STATUS_TOKENS.CAUGHT_UP.onContainer,
      border: STATUS_TOKENS.CAUGHT_UP.border,
      accent: STATUS_TOKENS.CAUGHT_UP.accent,
    },
    FINISHED: {
      bg: STATUS_TOKENS.FINISHED.container,
      fg: STATUS_TOKENS.FINISHED.onContainer,
      border: STATUS_TOKENS.FINISHED.border,
      accent: STATUS_TOKENS.FINISHED.accent,
    },
  };

  const D1_STATUS_ACCENT = {
    READING: STATUS_TOKENS.READING.accent,
    PLANNING: STATUS_TOKENS.PLANNING.accent,
    PAUSED: STATUS_TOKENS.PAUSED.accent,
    COMPLETED: STATUS_TOKENS.COMPLETED.accent,
    DROPPED: STATUS_TOKENS.DROPPED.accent,
    SAVED: STATUS_TOKENS.SAVED.accent,
    CAUGHT_UP: STATUS_TOKENS.CAUGHT_UP.accent,
    FINISHED: STATUS_TOKENS.FINISHED.accent,
  };
  const D1_STATUS_SOFT = {
    READING: STATUS_TOKENS.READING.container,
    PLANNING: STATUS_TOKENS.PLANNING.container,
    PAUSED: STATUS_TOKENS.PAUSED.container,
    COMPLETED: STATUS_TOKENS.COMPLETED.container,
    DROPPED: STATUS_TOKENS.DROPPED.container,
    SAVED: STATUS_TOKENS.SAVED.container,
    CAUGHT_UP: STATUS_TOKENS.CAUGHT_UP.container,
    FINISHED: STATUS_TOKENS.FINISHED.container,
  };

  const INLINE_HIDDEN_THEME = {
    bg: "rgba(91, 81, 66, 0.055)",
    fg: "#5b5142",
    border: "rgba(91, 81, 66, 0.16)",
    accent: "#8a8171",
  };

  const INLINE_CONTEXT_THEME = {
    bg: "rgba(65, 80, 76, 0.045)",
    fg: "#41504c",
    border: "rgba(65, 80, 76, 0.14)",
    accent: "#647067",
  };

  const INLINE_ADD_THEME = {
    bg: "rgba(45, 75, 67, 0.08)",
    fg: TRACE_UI.forest,
    border: "rgba(45, 75, 67, 0.22)",
    hoverBg: "rgba(45, 75, 67, 0.12)",
  };

  const LABEL = {
    PLANNING: "Planning",
    READING: "Reading",
    PAUSED: "Paused",
    COMPLETED: "Finished",
    DROPPED: "Dropped",
  };
  const MANAGEMENT_STATUS_CHOICES = [
    "PLANNING",
    "READING",
    "PAUSED",
    "COMPLETED",
    "DROPPED",
  ];

  var ADD_THEME = {
    bg: INLINE_ADD_THEME.bg,
    fg: INLINE_ADD_THEME.fg,
    border: INLINE_ADD_THEME.border,
    hoverBg: INLINE_ADD_THEME.hoverBg,
  };
  var ADDING_THEME = {
    bg: TRACE_UI.paperSoft,
    fg: TRACE_UI.subtle,
    border: "rgba(148, 163, 184, 0.3)",
  };
  var ADDED_THEME = {
    bg: TRACE_UI.forest,
    fg: TRACE_UI.forestOn,
    border: "rgba(22, 52, 45, 0.35)",
  };
  var ERROR_THEME = {
    bg: "#fef2f2",
    fg: "#dc2626",
    border: "rgba(220, 38, 38, 0.25)",
  };
  var HIDE_ACTION_THEME = {
    bg: "rgba(186, 26, 26, 0.045)",
    fg: "#9f1d1d",
    border: "rgba(186, 26, 26, 0.16)",
    hoverBg: "rgba(186, 26, 26, 0.075)",
  };
  var SAVING_INLINE_THEME = {
    bg: "rgba(65, 80, 76, 0.045)",
    fg: TRACE_UI.subtle,
    border: "rgba(65, 80, 76, 0.14)",
    accent: TRACE_UI.subtle,
  };
  var FULL_THEME = {
    bg: "#fff7df",
    fg: "#b45309",
    border: "rgba(180, 83, 9, 0.25)",
  };

  var CHIP_CSS = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:flex-start",
    "box-sizing:border-box",
    "padding:4px 8px",
    "min-height:20px",
    "border-radius:" + TRACE_UI.radiusXs,
    "vertical-align:middle",
    "font:800 9px/1 " + TRACE_UI.font,
    "letter-spacing:0.04em",
    "text-transform:uppercase",
    "white-space:nowrap",
    "max-width:min(240px,100%)",
    "overflow:hidden",
    "text-overflow:ellipsis",
  ].join(";");

  function chipStyle(theme) {
    return CHIP_CSS + ";background:" + theme.bg + ";color:" + theme.fg + ";border:1px solid " + theme.border + compactChipOverrides();
  }

  function actionChipStyle(theme) {
    return (
      chipStyle(theme) +
      (isCompactOverlayLayout()
        ? ";padding:3px 9px;min-height:28px;font:800 11px/1 " + TRACE_UI.font
        : ";padding:2px 8px;min-height:22px;font:800 11px/1 " + TRACE_UI.font) +
      ";border-color:" + theme.border +
      ";letter-spacing:0" +
      ";text-transform:none" +
      ";box-shadow:none" +
      ";transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease,transform 120ms ease"
    );
  }

  function preferenceActionStyle(theme) {
    return d1TextActionStyle(theme);
  }

  function preferenceButtonStyle(btn, theme) {
    if (btn && btn.getAttribute("data-trace-surface-action") === "1") {
      return surfaceGhostButtonStyle(theme) + ";cursor:pointer";
    }
    return d1PreferenceStyle(btn, theme);
  }

  function d1TextActionStyle(theme, borderStyle) {
    var color = theme && theme.fg ? theme.fg : TRACE_D1.forest;
    var line = theme && theme.border ? theme.border : TRACE_D1.forestLine;
    return [
      "display:inline-flex",
      "align-items:center",
      "gap:5px",
      "box-sizing:border-box",
      "max-width:min(240px,100%)",
      "padding:2px 0",
      "border:0",
      "border-bottom:1px " + (borderStyle || "solid") + " " + line,
      "border-radius:0",
      "background:transparent",
      "color:" + color,
      "box-shadow:none",
      "font:500 12.5px/1.3 " + TRACE_D1.font,
      "letter-spacing:0",
      "text-transform:none",
      "text-decoration:none",
      "white-space:nowrap",
      "cursor:pointer",
      "vertical-align:middle",
    ].join(";");
  }

  function d1ActionTheme(kind) {
    if (kind === "hide") {
      return { fg: TRACE_D1.ink3, border: TRACE_D1.mutedLine };
    }
    if (kind === "busy") {
      return { fg: TRACE_D1.ink4, border: TRACE_D1.mutedLine };
    }
    if (kind === "error") {
      return { fg: TRACE_D1.rust, border: TRACE_D1.rustLine };
    }
    if (kind === "full") {
      return { fg: TRACE_D1.honey, border: TRACE_D1.honeyLine };
    }
    if (kind === "saved") {
      return { fg: TRACE_D1.forest, border: TRACE_D1.forestLine };
    }
    return { fg: TRACE_D1.forest, border: TRACE_D1.forestLine };
  }

  function d1QuickAddStyle(kind) {
    return d1TextActionStyle(d1ActionTheme(kind), kind === "busy" ? "dashed" : "solid");
  }

  function d1PreferenceStyle(btn, theme) {
    var action = btn && btn.getAttribute ? btn.getAttribute("data-trace-hidden-action") : "";
    if (theme === ADDING_THEME) return d1TextActionStyle(d1ActionTheme("busy"), "dashed");
    if (theme === ERROR_THEME) return d1TextActionStyle(d1ActionTheme("error"));
    if (theme === FULL_THEME) return d1TextActionStyle(d1ActionTheme("full"));
    if (action === "undo") return d1TextActionStyle(d1ActionTheme("saved"));
    return d1TextActionStyle(d1ActionTheme("hide"));
  }

  function traceIconEl(kind) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.style.cssText = "width:12px;height:12px;flex:0 0 auto";
    if (kind === "plus") {
      svg.setAttribute("stroke-width", "1.7");
      var v = document.createElementNS("http://www.w3.org/2000/svg", "path");
      v.setAttribute("d", "M7 2v10M2 7h10");
      svg.appendChild(v);
      return svg;
    }
    if (kind === "eyeoff") {
      svg.setAttribute("stroke-width", "1.4");
      var a = document.createElementNS("http://www.w3.org/2000/svg", "path");
      a.setAttribute("d", "M1 7s2.2-4 6-4c1 0 1.9.3 2.7.6M13 7s-2.2 4-6 4c-1 0-1.9-.3-2.7-.6M2 2l10 10");
      svg.appendChild(a);
      return svg;
    }
    if (kind === "note") {
      svg.setAttribute("stroke-width", "1.4");
      var n = document.createElementNS("http://www.w3.org/2000/svg", "path");
      n.setAttribute("d", "M4 2.5h5L12 5.5v6H4zM9 2.5v3h3M5.8 8h4.4M5.8 10h3.2");
      svg.appendChild(n);
      return svg;
    }
    if (kind === "tag") {
      svg.setAttribute("stroke-width", "1.4");
      var t = document.createElementNS("http://www.w3.org/2000/svg", "path");
      t.setAttribute("d", "M2.5 3.5v3.7c0 .4.1.7.4 1l4.2 4.2a1.2 1.2 0 0 0 1.8 0l3.5-3.5a1.2 1.2 0 0 0 0-1.8L8.2 2.9a1.4 1.4 0 0 0-1-.4H3.5a1 1 0 0 0-1 1Z");
      svg.appendChild(t);
      var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", "5.3");
      c.setAttribute("cy", "5.3");
      c.setAttribute("r", "0.7");
      svg.appendChild(c);
      return svg;
    }
    if (kind === "open") {
      svg.setAttribute("stroke-width", "1.5");
      var o = document.createElementNS("http://www.w3.org/2000/svg", "path");
      o.setAttribute("d", "M5.5 3h5.5v5.5M11 3 4 10M3 6.5V12h5.5");
      svg.appendChild(o);
      return svg;
    }
    svg.setAttribute("stroke-width", "1.5");
    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    var track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("cx", "7");
    track.setAttribute("cy", "7");
    track.setAttribute("r", "4.9");
    track.setAttribute("opacity", "0.22");
    g.appendChild(track);
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M7 2.1a4.9 4.9 0 0 1 4.6 3.1");
    p.setAttribute("opacity", "0.95");
    g.appendChild(p);
    var spin = document.createElementNS("http://www.w3.org/2000/svg", "animateTransform");
    spin.setAttribute("attributeName", "transform");
    spin.setAttribute("type", "rotate");
    spin.setAttribute("from", "0 7 7");
    spin.setAttribute("to", "360 7 7");
    spin.setAttribute("dur", "0.8s");
    spin.setAttribute("repeatCount", "indefinite");
    g.appendChild(spin);
    svg.appendChild(g);
    return svg;
  }

  function setButtonInlineContent(btn, icon, text) {
    removeWrapChildren(btn);
    if (icon) btn.appendChild(traceIconEl(icon));
    btn.appendChild(document.createTextNode(text));
  }

  function setInlineStatusContent(btn, status) {
    removeWrapChildren(btn);
    var dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    dot.style.cssText = [
      "width:7px",
      "height:7px",
      "border-radius:999px",
      "background:" + (D1_STATUS_ACCENT[status] || TRACE_D1.ink3),
      "flex:0 0 auto",
    ].join(";");
    var label = document.createElement("span");
    label.textContent = statusChoiceLabel(status);
    label.style.cssText = "color:" + TRACE_D1.ink2;
    btn.appendChild(dot);
    btn.appendChild(label);
  }

  function surfaceButtonStyle(theme, filled) {
    var bg = filled ? theme.bg : "transparent";
    var color = filled ? theme.fg : theme.fg;
    return [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "gap:8px",
      "box-sizing:border-box",
      "min-height:38px",
      "padding:0 13px",
      "border-radius:9px",
      "border:1px solid " + theme.border,
      "background:" + bg,
      "color:" + color,
      "font:600 12.5px/1 " + TRACE_D1.font,
      "letter-spacing:0",
      "text-transform:none",
      "text-decoration:none",
      "white-space:nowrap",
      "cursor:pointer",
    ].join(";");
  }

  function surfacePrimaryButtonStyle() {
    return surfaceButtonStyle(
      { bg: TRACE_D1.forestDeep, fg: TRACE_D1.paper, border: TRACE_D1.forestDeep },
      true,
    );
  }

  function surfaceGhostButtonStyle(theme) {
    var t = theme || { fg: TRACE_D1.ink2, border: TRACE_D1.lineStrong };
    return surfaceButtonStyle(
      { bg: "transparent", fg: t.fg || TRACE_D1.ink2, border: t.border || TRACE_D1.lineStrong },
      false,
    );
  }

  function surfaceIconButtonStyle(theme) {
    return [
      surfaceGhostButtonStyle(theme),
      "flex:0 0 auto",
      "width:44px",
      "padding:12px 0",
    ].join(";");
  }

  function isCompactOverlayLayout() {
    try {
      return !!(
        window.matchMedia &&
        window.matchMedia("(max-width: 640px)").matches
      );
    } catch {
      return false;
    }
  }

  function compactChipOverrides() {
    if (!isCompactOverlayLayout()) return "";
    return (
      ";padding:3px 7px" +
      ";min-height:18px" +
      ";font:700 8px/1 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif" +
      ";letter-spacing:0.05em"
    );
  }

  function compactAo3HeadingTarget(anchor) {
    var header = anchor && anchor.closest ? anchor.closest(".header.module") : null;
    if (!header) return anchor;
    return (
      header.querySelector('h4.heading a[rel="author"]') ||
      header.querySelector("h4.heading") ||
      anchor
    );
  }

  function noticeSignature(authState, hasAuth) {
    return JSON.stringify({
      state: authState && authState.state ? authState.state : hasAuth ? "connected" : "signed_out",
      updatedAt: authState && authState.updatedAt ? authState.updatedAt : null,
      message: authState && authState.message ? authState.message : null,
      hasAuth: !!hasAuth,
    });
  }

  function shouldShowConnectNotice(authState, hasAuth) {
    var state = authState && authState.state ? authState.state : hasAuth ? "connected" : "signed_out";
    if (state === "upgrade_required") return false;
    if (state === "connected" && hasAuth) return false;
    return state === "signed_out" || state === "reconnect_required" || state === "error" || !hasAuth;
  }

  function dismissConnectNotice(signature) {
    try {
      if (!window.sessionStorage) return;
      window.sessionStorage.setItem(CONNECT_NOTICE_DISMISS_KEY, signature);
    } catch (_) {
      /* ignore */
    }
  }

  function isConnectNoticeDismissed(signature) {
    try {
      if (!window.sessionStorage) return false;
      return window.sessionStorage.getItem(CONNECT_NOTICE_DISMISS_KEY) === signature;
    } catch (_) {
      return false;
    }
  }

  function removeConnectNotice() {
    var existing = document.querySelector("[" + CONNECT_NOTICE_ATTR + "]");
    if (existing) existing.remove();
  }

  function renderConnectNotice(authState, hasAuth) {
    var signature = noticeSignature(authState, hasAuth);
    if (!shouldShowConnectNotice(authState, hasAuth) || isConnectNoticeDismissed(signature)) {
      removeConnectNotice();
      return;
    }

    var state = authState && authState.state ? authState.state : hasAuth ? "connected" : "signed_out";
    var helpUrl = usefulTraceUrl(authState && authState.helpUrl);
    var heading =
      state === "reconnect_required"
        ? "Sign in again"
        : state === "error"
          ? "Check Trace connection"
          : "Connect Trace";
    var message =
      (authState && authState.message) ||
      "Open Trace and sign in once to connect the extension. Then refresh this AO3 or FFN tab to restore sync.";

    var existing = document.querySelector("[" + CONNECT_NOTICE_ATTR + "]");
    if (!existing) {
      existing = document.createElement("aside");
      existing.setAttribute(CONNECT_NOTICE_ATTR, "1");
      existing.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "box-sizing:border-box",
        "width:min(340px,calc(100vw - 32px))",
        "padding:16px",
        "border-radius:14px",
        "background:" + TRACE_D1.card,
        "color:" + TRACE_D1.ink,
        "border:1px solid " + TRACE_D1.lineStrong,
        "box-shadow:0 18px 44px rgba(28,28,23,0.22)",
        "font:500 13px/1.45 " + TRACE_D1.font,
      ].join(";");

      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Dismiss Trace notice");
      closeBtn.style.cssText = [
        "position:absolute",
        "top:8px",
        "right:8px",
        "width:28px",
        "height:28px",
        "border:1px solid " + TRACE_D1.line,
        "border-radius:8px",
        "background:" + TRACE_D1.card2,
        "color:" + TRACE_D1.ink3,
        "font:600 16px/1 " + TRACE_D1.font,
        "cursor:pointer",
      ].join(";");
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", function () {
        dismissConnectNotice(signature);
        removeConnectNotice();
      });

      var headingEl = document.createElement("div");
      headingEl.setAttribute("data-trace-connect-notice-heading", "1");
      headingEl.style.cssText = [
        "margin:0 32px 8px 0",
        "font:500 20px/1.15 Fraunces,Georgia,'Times New Roman',serif",
        "letter-spacing:0",
        "color:" + TRACE_D1.ink,
      ].join(";");

      var messageEl = document.createElement("div");
      messageEl.setAttribute("data-trace-connect-notice-message", "1");
      messageEl.style.cssText = [
        "margin:0 0 14px 0",
        "color:" + TRACE_D1.ink3,
        "font:400 13px/1.5 " + TRACE_D1.font,
      ].join(";");

      var cta = document.createElement("a");
      cta.setAttribute("data-trace-connect-notice-cta", "1");
      cta.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "box-sizing:border-box",
        "width:100%",
        "min-height:42px",
        "padding:10px 14px",
        "border-radius:11px",
        "background:" + TRACE_D1.forestDeep,
        "color:" + TRACE_D1.paper,
        "border:1px solid " + TRACE_D1.forestDeep,
        "text-decoration:none",
        "font:600 13.5px/1.15 " + TRACE_D1.font,
        "letter-spacing:0",
        "text-transform:none",
      ].join(";");
      cta.target = "_blank";
      cta.rel = "noopener noreferrer";

      existing.appendChild(closeBtn);
      existing.appendChild(headingEl);
      existing.appendChild(messageEl);
      existing.appendChild(cta);
      document.documentElement.appendChild(existing);
    }

    existing.querySelector("[data-trace-connect-notice-heading]").textContent = heading;
    existing.querySelector("[data-trace-connect-notice-heading]").style.color =
      state === "error" ? TRACE_D1.rust : state === "reconnect_required" ? TRACE_D1.honey : TRACE_D1.ink;
    existing.querySelector("[data-trace-connect-notice-message]").textContent = message;
    var ctaEl = existing.querySelector("[data-trace-connect-notice-cta]");
    ctaEl.href = helpUrl;
    ctaEl.textContent =
      state === "signed_out"
        ? "Open Trace to connect"
        : state === "error"
          ? "Open Trace for help"
          : "Open Trace to reconnect";

    var closeEl = existing.querySelector("button[aria-label='Dismiss Trace notice']");
    if (closeEl) {
      closeEl.onclick = function () {
        dismissConnectNotice(signature);
        removeConnectNotice();
      };
    }
  }

  /** Is this a single-work page (not a listing)? collector.js handles quick-add there. */
  function isSingleWorkPage() {
    var p = location.pathname;
    return /\/works\/\d+(\/|$)/.test(p) || /\/s\/\d+(\/|$)/.test(p);
  }

  /** Scrape minimal metadata from an AO3 listing row for quick-add. */
  function scrapeAO3ListingRow(anchor) {
    var row = anchor.closest('li.work.blurb, li.work[id^="work_"], .work.blurb');
    if (!row) return null;
    var title = (anchor.textContent || "").trim();
    var authorEl = row.querySelector('a[rel="author"]');
    var author = authorEl ? (authorEl.textContent || "").trim() : null;
    var ratingEl = row.querySelector(".required-tags .rating");
    var rating = ratingEl
      ? (ratingEl.getAttribute("title") || ((ratingEl.textContent || "").trim() || null))
      : null;
    var req = row.querySelector(".required-tags");
    var reqText = req ? req.textContent || "" : "";
    var status = /Complete Work/i.test(reqText)
      ? "complete"
      : /Work in Progress/i.test(reqText)
        ? "wip"
        : null;
    var stats = row.querySelector("dd.stats dl.stats") || row.querySelector("dl.stats");
    var langDd = stats && stats.querySelector("dd.language");
    var language = langDd ? (langDd.textContent || "").trim() : null;
    var wordsDd = stats && stats.querySelector("dd.words");
    var words = wordsDd ? parseInt((wordsDd.textContent || "").replace(/[\s,]/g, ""), 10) : null;
    var chDd = stats && stats.querySelector("dd.chapters");
    var chRaw = chDd ? (chDd.textContent || "").trim() : null;
    var chPub = null;
    var cht = null;
    if (chRaw) {
      var chMatch = chRaw.match(/(\d+)\s*\/\s*(\d+|\?)/);
      if (chMatch) {
        chPub = parseInt(chMatch[1], 10);
        cht = chMatch[2] === "?" ? null : parseInt(chMatch[2], 10);
      }
    }
    var kudosDd = stats && stats.querySelector("dd.kudos");
    var hitsDd = stats && stats.querySelector("dd.hits");
    var bookmarksDd = stats && stats.querySelector("dd.bookmarks");
    var commentsDd = stats && stats.querySelector("dd.comments");
    var kudos = kudosDd ? parseInt((kudosDd.textContent || "").replace(/[\s,]/g, ""), 10) : null;
    var hits = hitsDd ? parseInt((hitsDd.textContent || "").replace(/[\s,]/g, ""), 10) : null;
    var bookmarks = bookmarksDd ? parseInt((bookmarksDd.textContent || "").replace(/[\s,]/g, ""), 10) : null;
    var comments = commentsDd ? parseInt((commentsDd.textContent || "").replace(/[\s,]/g, ""), 10) : null;
    var pubDd = stats && stats.querySelector("dd.published");
    var updDd = stats && stats.querySelector("dd.status");
    var published = pubDd ? (pubDd.textContent || "").trim() : null;
    var updated = updDd ? (updDd.textContent || "").trim() : null;
    if (!updated) {
      var dt = row.querySelector(".header p.datetime, p.datetime");
      updated = dt ? (dt.textContent || "").trim() : null;
    }
    var fandoms = Array.from(
      row.querySelectorAll("h5.fandoms a.tag, .fandoms a.tag"),
      function (el) {
        return (el.textContent || "").trim();
      },
    ).filter(Boolean);
    fandoms = Array.from(new Set(fandoms)).slice(0, 20);
    var relationshipTags = Array.from(
      row.querySelectorAll("ul.tags.commas li.relationships a.tag"),
      function (el) {
        return (el.textContent || "").trim();
      },
    ).filter(Boolean);
    relationshipTags = Array.from(new Set(relationshipTags)).slice(0, 80);
    var rels = relationshipTags.filter(function (tag) {
      return tag.indexOf("/") >= 0;
    });
    var characters = Array.from(
      row.querySelectorAll("ul.tags.commas li.characters a.tag"),
      function (el) {
        return (el.textContent || "").trim();
      },
    ).filter(Boolean);
    characters = Array.from(new Set(characters));
    var relParts = [];
    var relSeen = new Set();
    relationshipTags.forEach(function (tag) {
      String(tag || "")
        .split(/\s*(?:\/|&\s*)\s*/)
        .map(function (part) {
          return part.trim();
        })
        .filter(Boolean)
        .forEach(function (part) {
          if (!relSeen.has(part)) {
            relSeen.add(part);
            relParts.push(part);
          }
        });
    });
    var charsUnion = Array.from(new Set(relParts.concat(characters))).slice(0, 120);
    var tags = Array.from(
      row.querySelectorAll("ul.tags.commas li.freeforms a.tag"),
      function (el) {
        return (el.textContent || "").trim();
      },
    ).filter(Boolean);
    tags = Array.from(new Set(tags)).slice(0, 200);
    var warnings = Array.from(
      row.querySelectorAll(
        "ul.tags.commas li.warnings a.tag, ul.tags.commas li[class*='warning'] a.tag, dd.warning.tags a.tag, .work .tags li.warnings a.tag",
      ),
      function (el) {
        return (el.textContent || "").trim();
      },
    ).filter(Boolean);
    if (!warnings.length && req) {
      Array.from(req.querySelectorAll("span.warnings[title], .warnings[title]")).forEach(function (el) {
        var raw = el.getAttribute("title") || "";
        raw.split(/\s*,\s*/).forEach(function (part) {
          if (part) warnings.push(part.trim());
        });
      });
    }
    warnings = Array.from(new Set(warnings)).slice(0, 20);
    var categories = Array.from(
      row.querySelectorAll("dd.category.tags a.tag"),
      function (el) {
        return (el.textContent || "").trim();
      },
    ).filter(Boolean);
    if (!categories.length) {
      var catEl = row.querySelector(".required-tags .category");
      var catTitle = catEl && catEl.getAttribute("title");
      if (catTitle) {
        categories = catTitle.split(/\s*,\s*/).map(function (part) {
          return part.trim();
        }).filter(Boolean);
      }
    }
    categories = Array.from(new Set(categories)).slice(0, 10);
    var summaryEl = row.querySelector("blockquote.userstuff.summary, .userstuff.summary");
    var summary = summaryEl ? (summaryEl.textContent || "").trim() : null;
    return {
      src: "ao3",
      ctx: "listing",
      u: new URL(anchor.getAttribute("href"), document.baseURI).href.replace(/\/chapters\/\d+.*$/, ""),
      t: title || "",
      a: author || "",
      r: rating,
      s: status,
      l: language,
      w: (words && Number.isFinite(words)) ? words : null,
      k: (kudos && Number.isFinite(kudos)) ? kudos : null,
      h: (hits && Number.isFinite(hits)) ? hits : null,
      bk: (bookmarks && Number.isFinite(bookmarks)) ? bookmarks : null,
      cc: (comments && Number.isFinite(comments)) ? comments : null,
      wrn: warnings,
      cat: categories,
      pub: published,
      upd: updated,
      chn: 1,
      cht: (cht && Number.isFinite(cht)) ? cht : null,
      chPub: (chPub && Number.isFinite(chPub)) ? chPub : null,
      fms: fandoms,
      rels: rels,
      ra: relationshipTags,
      chars: charsUnion,
      tags: tags,
      sm: summary,
    };
  }

  /** Scrape minimal metadata from an FFN listing row for quick-add. */
  function extractTextSummaryFromFfnListingRow(row) {
    if (!row) return null;
    var desktopSummaryNode = row.querySelector(".z-indent, .zindent");
    if (desktopSummaryNode) {
      var desktopSummary = (desktopSummaryNode.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (desktopSummary) return desktopSummary;
    }

    var authorEl = row.querySelector('a[href*="/u/"]');
    var grayMeta = row.querySelector("div.gray, .xgray");
    if (!authorEl) return null;

    var out = "";
    var node = authorEl.nextSibling;
    while (node) {
      if (grayMeta && node === grayMeta) break;
      if (node.nodeType === 3) {
        out += " " + (node.nodeValue || "");
      } else if (node.nodeType === 1) {
        out += " " + ((node.textContent || ""));
      }
      node = node.nextSibling;
    }

    var summary = out.replace(/\s+/g, " ").trim();
    return summary || null;
  }

  function scrapeFFNListingRow(anchor) {
    var row = anchor.closest(".z-list") || anchor.parentElement;
    if (!row) return null;
    var title = (anchor.textContent || "").trim();
    var authorEl = row.querySelector('a[href*="/u/"]');
    var author = authorEl ? (authorEl.textContent || "").trim() : null;
    var summary = extractTextSummaryFromFfnListingRow(row);
    return {
      src: "ffn",
      ctx: "listing",
      u: new URL(anchor.getAttribute("href"), document.baseURI).href,
      t: title || "",
      a: author || "",
      sm: summary,
      w: null,
      chn: 1,
      cht: null,
    };
  }

  function scrapeListingItem(platform, anchor) {
    var href = anchor && anchor.getAttribute ? anchor.getAttribute("href") : null;
    if (href) {
      try {
        var absUrl = new URL(href, document.baseURI).href;
        var targetInfo = keyFromAbsoluteUrl(absUrl);
        if (targetInfo && typeof globalThis.collect === "function") {
          var collected = globalThis.collect();
          var items = collected && Array.isArray(collected.items) ? collected.items : [];
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || !item.u) continue;
            var info = keyFromAbsoluteUrl(item.u);
            if (info && info.key === targetInfo.key) {
              return item;
            }
          }
        }
      } catch (_) {
        /* ignore and fall through to local scrape */
      }
    }
    if (platform === "ao3") return scrapeAO3ListingRow(anchor);
    if (platform === "ffn") return scrapeFFNListingRow(anchor);
    return null;
  }

  function fallbackKeyFromUrl(absUrl) {
    try {
      var u = new URL(absUrl);
      var host = (u.hostname || "").toLowerCase();
      var path = u.pathname || "";

      if (
        host === "archiveofourown.org" ||
        host.endsWith(".archiveofourown.org") ||
        host === "archiveofourown.gay" ||
        host.endsWith(".archiveofourown.gay") ||
        host === "archive.transformativeworks.org" ||
        host === "ao3.org" ||
        host.endsWith(".ao3.org")
      ) {
        var ao3Match = path.match(/\/works\/(\d+)/);
        if (ao3Match) {
          return {
            platform: "ao3",
            workId: ao3Match[1],
            key: "ao3:" + ao3Match[1],
          };
        }
      }

      if (/^(?:www\.|m\.)?fanfiction\.net$/.test(host)) {
        var ffnMatch = path.match(/\/s\/(\d+)/);
        if (ffnMatch) {
          return {
            platform: "ffn",
            workId: ffnMatch[1],
            key: "ffn:" + ffnMatch[1],
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  function keyFromAbsoluteUrl(absUrl) {
    const fn = globalThis.traceExternalStoryKeyFromUrl;
    if (typeof fn === "function") {
      try {
        return fn(absUrl);
      } catch {
        /* fall through */
      }
    }
    return fallbackKeyFromUrl(absUrl);
  }

  function normalizeChapters(raw) {
    if (!raw || typeof raw !== "object") return undefined;
    if (
      typeof raw.current !== "number" ||
      !Number.isFinite(raw.current)
    ) {
      return undefined;
    }
    var chapters = {
      current: raw.current,
      total:
        raw.total === null || raw.total === undefined
          ? null
          : Number(raw.total),
    };
    if (chapters.total !== null && !Number.isFinite(chapters.total)) {
      chapters.total = null;
    }
    return chapters;
  }

  function normalizeBrowsePreference(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.browsePreference && typeof raw.browsePreference === "object") {
      return { hidden: raw.browsePreference.hidden === true };
    }
    if (raw.hidden === true) return { hidden: true };
    return null;
  }

  function normalizeWorkMark(raw) {
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

  function normalizePrivateContext(raw) {
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

  function normalizeWorkStatus(raw) {
    if (typeof raw !== "string") return undefined;
    var normalized = raw.trim().toLowerCase();
    if (
      normalized === "complete" ||
      normalized === "wip" ||
      normalized === "abandoned" ||
      normalized === "unknown"
    ) {
      return normalized;
    }
    return undefined;
  }

  function normalizeCatchupState(raw) {
    if (typeof raw !== "string") return undefined;
    var normalized = raw.trim().toUpperCase();
    if (normalized === "UP" || normalized === "BEHIND" || normalized === "UNKNOWN") {
      return normalized;
    }
    return undefined;
  }

  function normalizeNewChapterCount(raw) {
    if (raw === undefined || raw === null) return undefined;
    var count = Number(raw);
    if (!Number.isFinite(count) || count < 0) return undefined;
    return Math.trunc(count);
  }

  function normalizeRating(raw) {
    if (raw === undefined || raw === null) return undefined;
    var rating = Number(raw);
    if (!Number.isFinite(rating)) return undefined;
    return Math.max(0, Math.min(5, Math.trunc(rating)));
  }

  /**
   * Legacy cache: plain status string.
   * Current contract: entries[key] carries library state; workPreferences[key]
   * carries browse-only state such as hidden for non-library works.
   */
  function normalizeOverlayEntry(raw, preferenceRaw) {
    var preference = normalizeBrowsePreference(preferenceRaw);
    if (raw == null) {
      return preference && preference.hidden
        ? { status: null, readerStatus: null, hidden: true }
        : null;
    }
    if (typeof raw === "string") {
      return {
        status: raw,
        readerStatus: raw,
        chapters: undefined,
        hidden: preference && preference.hidden === true,
      };
    }
    if (typeof raw === "object") {
      var entryPreference = normalizeBrowsePreference(raw);
      var hidden =
        (entryPreference && entryPreference.hidden === true) ||
        (preference && preference.hidden === true);
      var status = typeof raw.status === "string" ? raw.status : null;
      var readerStatus =
        typeof raw.readerStatus === "string" ? raw.readerStatus : status;
      if (!status && !readerStatus && !hidden) return null;
      return {
        status: status,
        readerStatus: readerStatus,
        entryId: typeof raw.entryId === "string" ? raw.entryId : undefined,
        chapters: normalizeChapters(raw.chapters),
        hidden: hidden,
        workMark: normalizeWorkMark(raw.workMark),
        privateContext: normalizePrivateContext(raw.privateContext),
        workStatus: normalizeWorkStatus(raw.workStatus),
        catchupState: normalizeCatchupState(raw.catchupState),
        newChapterCount: normalizeNewChapterCount(raw.newChapterCount),
        rating: normalizeRating(raw.rating),
        __traceStatusPending: raw.__traceStatusPending === true,
        __traceStatusTarget: typeof raw.__traceStatusTarget === "string" ? raw.__traceStatusTarget : undefined,
        __traceStatusError: raw.__traceStatusError || undefined,
      };
    }
    return null;
  }

  function chaptersForStatusDisplay(status, chapters) {
    if (!chapters || typeof chapters.current !== "number") return chapters;
    if (status === "READING" && chapters.current <= 0) {
      return {
        current: 1,
        total: chapters.total == null ? null : chapters.total,
      };
    }
    return chapters;
  }

  function chapterSuffix(status, chapters) {
    if (status === "PLANNING") return "";
    var displayChapters = chaptersForStatusDisplay(status, chapters);
    if (!displayChapters || typeof displayChapters.current !== "number") return "";
    var t = displayChapters.total;
    var frac = t == null ? displayChapters.current + "/?" : displayChapters.current + "/" + t;
    return " \u00b7 " + frac;
  }

  function progressClause(status, chapters) {
    if (status === "PLANNING") return "";
    var displayChapters = chaptersForStatusDisplay(status, chapters);
    if (!displayChapters || typeof displayChapters.current !== "number") return "";
    if (displayChapters.total == null) {
      return ", chapter " + displayChapters.current + " (total not set in Trace)";
    }
    return ", chapter " + displayChapters.current + " of " + displayChapters.total;
  }

  /**
   * AO3 listing blurb: first number in Chapters is published count (may be inside <a>).
   */
  function ao3PublishedChaptersNearAnchor(anchor) {
    var row = anchor.closest(
      'li.work.blurb, li.work[id^="work_"], .work.blurb',
    );
    if (!row) return null;
    var stats =
      row.querySelector("dd.stats dl.stats") || row.querySelector("dl.stats");
    var dd = stats && stats.querySelector("dd.chapters");
    if (!dd) return null;
    var raw = (dd.textContent || "").replace(/\s+/g, " ").trim();
    var m = raw.match(/(\d+)\s*\/\s*(\d+|\?)/);
    if (m) {
      var pub = parseInt(m[1], 10);
      return Number.isFinite(pub) ? pub : null;
    }
    var lone = raw.match(/^(\d+)/);
    if (lone) {
      var n = parseInt(lone[1], 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * FFN desktop listing: "Chapters: N" in gray meta line.
   */
  function ffnPublishedChaptersNearAnchor(anchor) {
    var row = anchor.closest(".z-list") || anchor.parentElement;
    if (!row) return null;
    var metaNode = row.querySelector(
      ".z-padtop2.xgray, .xgray.xcontrast_txt, .xgray",
    );
    var meta = metaNode ? metaNode.textContent || "" : "";
    var m = meta.replace(/\s+/g, " ").match(/Chapters:\s*(\d+)/i);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Listing pages: site shows more published chapters than Trace's max(current, total).
   * Matches plan: published > max(libraryTotal, libraryCurrent).
   */
  function siteChaptersAheadDelta(platform, anchor, entry) {
    if (!entry || !entry.chapters) return null;
    var pub =
      platform === "ao3"
        ? ao3PublishedChaptersNearAnchor(anchor)
        : platform === "ffn"
          ? ffnPublishedChaptersNearAnchor(anchor)
          : null;
    if (pub == null) return null;
    var cur = entry.chapters.current;
    var tot = entry.chapters.total;
    var cap = Math.max(
      typeof cur === "number" && Number.isFinite(cur) ? cur : 0,
      typeof tot === "number" && Number.isFinite(tot) ? tot : 0,
    );
    if (!(pub > cap)) return null;
    return pub - cap;
  }

  function siteAheadHintEl(delta) {
    if (delta == null || delta < 1) return null;
    var th = UPDATED_THEME;
    var span = document.createElement("span");
    span.setAttribute(ATTR, "1");
    span.setAttribute("data-trace-site-ahead", "1");
    span.textContent = delta === 1 ? "UPDATED" : "+" + String(delta);
    span.setAttribute(
      "title",
      delta === 1
        ? "This work has more published chapters than your Trace progress total."
        : "About " +
            delta +
            " more chapter(s) published on the site than reflected in your Trace total.",
    );
    span.setAttribute(
      "aria-label",
      delta === 1
        ? "Site has new chapters versus Trace library total"
        : String(delta) + " more chapters on site than Trace total",
    );
    span.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "box-sizing:border-box",
      "padding:2px 6px",
      "min-height:16px",
      "border-radius:6px",
      "vertical-align:middle",
      "font:700 8px/1 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif",
      "letter-spacing:0.05em",
      "text-transform:uppercase",
      "white-space:nowrap",
      "background:" + th.bg,
      "color:" + th.fg,
      "border:1px solid " + th.border,
    ].join(";");
    return span;
  }

  /**
   * Only decorate “main” story links — not AO3 chapters (/works/id/chapters/…), kudos,
   * comments, bookmarks, etc., and not every FFN chapter row for the same fic.
   */
  function isDecoratableWorkLink(absUrl, info) {
    try {
      const u = new URL(absUrl);
      let path = u.pathname;
      if (path.length > 1 && path.endsWith("/")) {
        path = path.slice(0, -1);
      }
      if (info.platform === "ao3") {
        return /^\/works\/\d+$/.test(path);
      }
      if (info.platform === "ffn") {
        return /^\/s\/\d+\/\d+(?:\/|$)/.test(u.pathname);
      }
      return false;
    } catch {
      return false;
    }
  }

  function statusDisplay(entry) {
    var status = entry && (entry.readerStatus || entry.status);
    if (!status) return null;
    var label = LABEL[status] || status;
    var suffix = chapterSuffix(status, entry.chapters);
    return label + suffix;
  }

  function statusOnlyDisplay(entry) {
    var status = entryStatusValue(entry);
    return status ? statusChoiceLabel(status) : null;
  }

  function progressOnlyDisplay(entry) {
    var status = entryStatusValue(entry);
    if (status === "PLANNING") return "Not started";
    var chapters = chaptersForStatusDisplay(status, entry && entry.chapters);
    if (!chapters || typeof chapters.current !== "number") return "Not started";
    return chapters.current + "/" + (chapters.total == null ? "?" : chapters.total);
  }

  function lensHeadline(entry) {
    if (!entry) return "Trace";
    if (entry.__traceStatusPending) return "Saving...";
    if (entry.__traceStatusError) return "Update failed";
    if (entry.hidden) return "Hidden";
    var display = statusDisplay(entry);
    if (display) return display;
    var newChapters = newChaptersDisplay(entry, false);
    if (newChapters) return newChapters;
    return "Saved";
  }

  function lensCaption(entry) {
    if (!entry) return "";
    if (entry.__traceStatusPending) {
      return entry.__traceStatusTarget
        ? "Saving " + statusChoiceLabel(entry.__traceStatusTarget)
        : "Saving reading status";
    }
    if (entry.__traceStatusError) return "Tap to retry";
    if (entry.hidden) return "Hidden from browsing";
    var newChapters = newChaptersDisplay(entry, false);
    if (newChapters) {
      var parts = [];
      var statusLabel = statusOnlyDisplay(entry);
      if (statusLabel) parts.push(statusLabel);
      return parts.length ? parts.join(" \u00b7 ") : "New chapters available";
    }
    if (entry.privateContext && (entry.privateContext.hasNotes || entry.privateContext.tagCount > 0)) {
      return "Private context saved";
    }
    return "In your library";
  }

  function entryStatusValue(entry) {
    return entry && (entry.readerStatus || entry.status) ? entry.readerStatus || entry.status : null;
  }

  function statusChoiceLabel(status) {
    return LABEL[status] || status;
  }

  function statusControlChoiceLabel(status) {
    if (status === "PLANNING") return "Plan";
    if (status === "COMPLETED") return "Done";
    return statusChoiceLabel(status);
  }

  function workStatusLabel(workStatus) {
    if (workStatus === "complete") return "Complete work";
    if (workStatus === "wip") return "Work in progress";
    if (workStatus === "abandoned") return "Abandoned work";
    return null;
  }

  function newChaptersDisplay(entry, compact) {
    if (!entry || entry.catchupState !== "BEHIND") return null;
    var count = entry.newChapterCount;
    if (typeof count === "number" && Number.isFinite(count)) {
      if (count <= 0) return null;
      if (compact) return "+" + String(count) + " new";
      return (
        "+" +
        String(count) +
        " new " +
        (count === 1 ? "chapter" : "chapters")
      );
    }
    return compact ? "New" : "New chapters";
  }

  function catchupLabel(entry) {
    var newChapters = newChaptersDisplay(entry, false);
    if (newChapters) return newChapters;
    if (entry && entry.catchupState === "UP") return "Caught up";
    return null;
  }

  function entryRatingValue(entry) {
    var rating = Number(entry && entry.rating);
    if (!Number.isFinite(rating)) return 0;
    return Math.max(0, Math.min(5, Math.trunc(rating)));
  }

  function catchupProgressPatch(entry) {
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

  function readerStatusProgressPatch(entry, nextStatus) {
    var currentStatus = entryStatusValue(entry);
    var chapters = entry && entry.chapters;
    if (
      nextStatus !== "READING" ||
      currentStatus !== "PLANNING" ||
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

  function lensTheme(entry) {
    if (!entry) return INLINE_CONTEXT_THEME;
    if (entry.__traceStatusPending) return SAVING_INLINE_THEME;
    if (entry.__traceStatusError) {
      return {
        bg: "rgba(254, 242, 242, 0.72)",
        fg: ERROR_THEME.fg,
        border: "rgba(220, 38, 38, 0.2)",
        accent: ERROR_THEME.fg,
      };
    }
    if (entry.hidden) return INLINE_HIDDEN_THEME;
    var status = entryStatusValue(entry);
    return (status && INLINE_STATUS_THEME[status]) || INLINE_CONTEXT_THEME;
  }

  function lensDotColor(entry, theme) {
    if (entry && entry.__traceStatusError) return TRACE_D1.rust;
    if (entry && entry.__traceStatusPending) return TRACE_D1.ink4;
    var status = entryStatusValue(entry);
    if (status && D1_STATUS_ACCENT[status]) return D1_STATUS_ACCENT[status];
    return theme && theme.accent ? theme.accent : TRACE_D1.ink3;
  }

  function lensLabelText(entry) {
    if (!entry) return "Trace";
    if (entry.__traceStatusPending) return "Saving...";
    if (entry.__traceStatusError) return "Update failed";
    if (entry.hidden) return "Hidden";
    var status = statusOnlyDisplay(entry);
    if (status) return status;
    var newChapters = newChaptersDisplay(entry, false);
    if (newChapters) return newChapters;
    return "Saved";
  }

  function lensProgressText(entry) {
    var status = entryStatusValue(entry);
    if (!status || status === "PLANNING") return "";
    var chapters = chaptersForStatusDisplay(status, entry && entry.chapters);
    if (!chapters || typeof chapters.current !== "number") return "";
    return chapters.current + "/" + (chapters.total == null ? "?" : chapters.total);
  }

  function badgeEl(entry) {
    var status = entry.readerStatus || entry.status;
    const theme = STATUS_THEME[status] || STATUS_THEME.PLANNING;
    const label = LABEL[status] || status;
    const suffix = chapterSuffix(status, entry.chapters);
    const display = (label + suffix).toUpperCase();
    const span = document.createElement("span");
    span.setAttribute(ATTR, "1");
    var titleBase = "In your Trace library: " + label + progressClause(status, entry.chapters);
    span.setAttribute("title", titleBase);
    span.setAttribute(
      "aria-label",
      "Trace library: " + label + progressClause(status, entry.chapters),
    );
    span.textContent = display;
    span.style.cssText = chipStyle(theme) + ";box-shadow:0 1px 2px rgba(28,28,23,0.06)";
    return span;
  }

  function smallBadgeEl(text, theme, title, attrName) {
    var span = document.createElement("span");
    span.setAttribute(ATTR, "1");
    if (attrName) span.setAttribute(attrName, "1");
    span.textContent = String(text || "").toUpperCase();
    if (title) {
      span.setAttribute("title", title);
      span.setAttribute("aria-label", title);
    }
    span.style.cssText = chipStyle(theme);
    return span;
  }

  function appendEntryBadges(wrap, entry) {
    if (entry.hidden) {
      wrap.appendChild(
        smallBadgeEl(
          "Hidden",
          HIDDEN_THEME,
          "Hidden in Trace browsing preferences",
          "data-trace-browse-hidden",
        ),
      );
    }
    if (entry.readerStatus || entry.status) {
      wrap.appendChild(badgeEl(entry));
    }
    var newChapterText = newChaptersDisplay(entry, true);
    if (newChapterText) {
      wrap.appendChild(
        smallBadgeEl(
          newChapterText,
          UPDATED_THEME,
          "New chapters available for this Trace library entry",
          "data-trace-new-chapters",
        ),
      );
    }
  }

  function appendWorkCatchupRows(surface, entry) {
    if (!entry) return;
    var catchup = catchupLabel(entry);
    if (catchup) {
      surface.appendChild(
        surfaceRowEl("Catch-up", catchup, entry.catchupState === "BEHIND"),
      );
    }
  }

  function ratingButtonStyle(active, disabled) {
    return [
      "appearance:none",
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "width:30px",
      "height:30px",
      "border:0",
      "border-radius:7px",
      "background:transparent",
      "color:" + (active ? TRACE_D1.honey : TRACE_D1.ink5),
      "font:600 20px/1 Georgia,serif",
      "cursor:" + (disabled ? "wait" : "pointer"),
      disabled ? "opacity:0.62" : "",
    ].join(";");
  }

  function appendRatingControls(surface, entry, workKey) {
    if (!entry || !entry.entryId) return;
    var current = entryRatingValue(entry);
    var wrap = document.createElement("div");
    wrap.setAttribute("data-trace-rating-control", "1");
    wrap.style.cssText = "display:grid;gap:8px;padding-top:12px;border-top:1px solid " + TRACE_D1.line;

    var label = document.createElement("div");
    label.className = "x-sheet-label";
    label.textContent = "Your rating";
    label.style.cssText = "font:500 9px/1 " + TRACE_D1.mono + ";letter-spacing:0.18em;text-transform:uppercase;color:" + TRACE_D1.ink4;
    wrap.appendChild(label);

    var row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:2px";
    var message = document.createElement("span");
    message.setAttribute("data-trace-rating-message", "1");
    message.style.cssText = "margin-left:8px;font:600 11.5px/1.3 " + TRACE_D1.font + ";color:" + TRACE_D1.ink3;

    function renderStars(disabled) {
      removeWrapChildren(row);
      for (var i = 1; i <= 5; i += 1) {
        var star = document.createElement("button");
        star.type = "button";
        star.setAttribute("data-trace-rating-choice", String(i));
        star.setAttribute("aria-label", current === i ? "Clear rating" : "Set rating to " + i);
        star.textContent = i <= current ? "\u2605" : "\u2606";
        star.style.cssText = ratingButtonStyle(i <= current, disabled);
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
          ext.runtime.sendMessage(
            {
              type: "TRACE_PATCH_LIBRARY_ENTRY",
              payload: {
                workKey: workKey,
                entryId: entry.entryId,
                patch: { rating: nextRating },
              },
            },
            function (response) {
              if (ext.runtime.lastError || !response || !response.ok) {
                current = previous;
                entry.rating = previous;
                message.textContent = "Could not save";
                renderStars(false);
                return;
              }
              current = nextRating;
              entry.rating = nextRating;
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
    surface.appendChild(wrap);
  }

  function appendCatchupAction(surface, entry, workKey, rerender, refreshSurface) {
    if (!entry || !entry.entryId) return;
    var patch = catchupProgressPatch(entry);
    if (!patch) return;
    var wrap = document.createElement("div");
    wrap.setAttribute("data-trace-catchup-action", "1");
    wrap.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0 0;border-top:1px solid " + TRACE_D1.line;
    var text = document.createElement("div");
    text.style.cssText = "min-width:0";
    var title = document.createElement("div");
    title.textContent = "Catch up";
    title.style.cssText = "font:600 12.5px/1.25 " + TRACE_D1.font + ";color:" + TRACE_D1.ink;
    var copy = document.createElement("div");
    copy.textContent = "Set progress to chapter " + patch.chapters.current + ".";
    copy.style.cssText = "margin-top:2px;font:500 11.5px/1.35 " + TRACE_D1.font + ";color:" + TRACE_D1.ink3;
    text.appendChild(title);
    text.appendChild(copy);
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Mark caught up";
    button.style.cssText = surfaceGhostButtonStyle(UPDATED_THEME) + ";flex:0 0 auto";
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      button.textContent = "Saving...";
      ext.runtime.sendMessage(
        {
          type: "TRACE_PATCH_LIBRARY_ENTRY",
          payload: {
            workKey: workKey,
            entryId: entry.entryId,
            patch: { progress: patch.progress },
          },
        },
        function (response) {
          if (ext.runtime.lastError || !response || !response.ok) {
            button.disabled = false;
            button.textContent = "Retry";
            return;
          }
          entry.chapters = patch.chapters;
          entry.catchupState = "UP";
          entry.newChapterCount = 0;
          rerender();
          if (typeof refreshSurface === "function") refreshSurface();
        },
      );
    });
    wrap.appendChild(text);
    wrap.appendChild(button);
    surface.appendChild(wrap);
  }

  function closeListingActionSurface() {
    var existing = document.querySelector("[" + ACTION_SURFACE_ATTR + "]");
    if (existing) existing.remove();
    unlockListingBottomSheetPageScroll();
    document.removeEventListener("click", outsideSurfaceClick, true);
    document.removeEventListener("keydown", surfaceKeydown, true);
  }

  var listingBottomSheetScrollLock = null;

  function lockListingBottomSheetPageScroll() {
    if (listingBottomSheetScrollLock) return;
    var html = document.documentElement;
    var body = document.body;
    listingBottomSheetScrollLock = {
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

  function unlockListingBottomSheetPageScroll() {
    if (!listingBottomSheetScrollLock) return;
    var html = document.documentElement;
    var body = document.body;
    if (html) {
      html.style.overflow = listingBottomSheetScrollLock.htmlOverflow;
      html.style.overscrollBehavior = listingBottomSheetScrollLock.htmlOverscroll;
    }
    if (body) {
      body.style.overflow = listingBottomSheetScrollLock.bodyOverflow;
      body.style.overscrollBehavior = listingBottomSheetScrollLock.bodyOverscroll;
    }
    listingBottomSheetScrollLock = null;
  }

  function createBottomSheetGrabber(color) {
    var zone = document.createElement("div");
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
    bar.style.cssText = "display:block;width:38px;height:4px;border-radius:999px;background:" + color;
    zone.appendChild(bar);
    return zone;
  }

  function bindBottomSheetDragClose(surface, handle, closeFn) {
    if (!surface || !handle || !closeFn) return;
    var startY = 0;
    var dragging = false;
    function pointerY(e) {
      if (e && e.touches && e.touches.length) return e.touches[0].clientY;
      if (e && e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY;
      return e && typeof e.clientY === "number" ? e.clientY : 0;
    }
    function resetDrag() {
      dragging = false;
      surface.style.transition = "";
      surface.style.transform = "";
    }
    function start(e) {
      dragging = true;
      startY = pointerY(e);
      if (e && e.cancelable) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      surface.style.transition = "none";
      if (handle.setPointerCapture && e && e.pointerId != null) {
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      }
    }
    function move(e) {
      if (!dragging) return;
      var delta = Math.max(0, pointerY(e) - startY);
      if (e && e.cancelable) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      surface.style.transform = "translateY(" + delta + "px)";
    }
    function end(e) {
      if (!dragging) return;
      if (e && e.cancelable) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      var delta = Math.max(0, pointerY(e) - startY);
      if (delta >= 56) {
        resetDrag();
        closeFn();
        return;
      }
      surface.style.transition = "transform 160ms ease";
      surface.style.transform = "translateY(0)";
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

  function outsideSurfaceClick(e) {
    var surface = document.querySelector("[" + ACTION_SURFACE_ATTR + "]");
    if (!surface) return;
    var target = e && e.target;
    if (
      surface.contains(target) ||
      (target && target.closest && target.closest("[" + LENS_ATTR + "]"))
    ) {
      return;
    }
    closeListingActionSurface();
  }

  function surfaceKeydown(e) {
    if (e && e.key === "Escape") closeListingActionSurface();
  }

  function surfaceRowEl(label, value, emphasis) {
    var row = document.createElement("div");
    row.setAttribute("data-trace-action-row", label);
    row.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "min-height:32px",
      "padding:8px 0",
      "border-top:1px solid " + TRACE_D1.line,
      "background:transparent",
    ].join(";");
    var labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.style.cssText = "font:500 9px/1 " + TRACE_D1.mono + ";letter-spacing:0.18em;text-transform:uppercase;color:" + TRACE_D1.ink4;
    var valueEl = document.createElement("span");
    valueEl.textContent = value;
    valueEl.style.cssText = "font:600 12.5px/1.3 " + TRACE_D1.font + ";color:" + (emphasis ? TRACE_D1.rust : TRACE_D1.ink2) + ";text-align:right";
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  function surfaceMetaRow(iconKind, child, label) {
    var row = document.createElement("div");
    row.className = "x-meta-row";
    if (label) row.setAttribute("data-trace-action-meta", label);
    row.style.cssText = "display:flex;gap:11px;align-items:flex-start";
    var icon = document.createElement("span");
    icon.className = "ic";
    icon.setAttribute("aria-hidden", "true");
    icon.style.cssText = "width:16px;height:16px;color:" + TRACE_D1.ink4 + ";flex-shrink:0;margin-top:1px";
    icon.appendChild(traceIconEl(iconKind));
    row.appendChild(icon);
    row.appendChild(child);
    return row;
  }

  function surfaceListingMeta(platform, anchor) {
    var item = scrapeListingItem(platform, anchor);
    if (!item) return { title: "", author: "" };
    return {
      title: item.t || "",
      author: item.a || "",
    };
  }

  function surfacePositionBlock(entry) {
    var status = entryStatusValue(entry);
    var chapters = chaptersForStatusDisplay(status, entry && entry.chapters);
    if (!chapters || typeof chapters.current !== "number") return null;
    var percent = null;
    if (typeof chapters.total === "number" && chapters.total > 0) {
      percent = Math.max(0, Math.min(100, Math.round((chapters.current / chapters.total) * 100)));
    }

    var position = document.createElement("section");
    position.className = "x-pos";
    position.setAttribute("data-trace-action-position", "1");
    position.style.cssText = "background:#f1d8c8;border:1px solid rgba(181,74,48,0.24);border-radius:12px;padding:13px 14px";

    var top = document.createElement("div");
    top.className = "top";
    top.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:10px";
    var value = document.createElement("span");
    value.className = "chap";
    value.style.cssText = "font:500 22px/1 'Fraunces',Georgia,serif;color:" + TRACE_D1.ink;
    var big = document.createElement("span");
    big.className = "big";
    big.textContent = "Ch " + chapters.current;
    var small = document.createElement("span");
    small.className = "sm";
    small.textContent = " / " + (chapters.total == null ? "?" : chapters.total);
    small.style.cssText = "font-size:15px;color:" + TRACE_D1.ink4;
    value.appendChild(big);
    value.appendChild(small);
    top.appendChild(value);

    var side = document.createElement("span");
    side.className = "pct";
    side.style.cssText = "font:500 10.5px/1.2 " + TRACE_D1.mono + ";color:" + TRACE_D1.ink3 + ";text-align:right";
    var catchup = catchupLabel(entry);
    side.textContent = catchup || (percent == null ? "" : percent + "%");
    if (side.textContent) top.appendChild(side);
    position.appendChild(top);

    if (percent != null) {
      var bar = document.createElement("div");
      bar.className = "bar";
      bar.style.cssText = "height:5px;border-radius:999px;background:rgba(28,39,34,0.12);overflow:hidden;margin:10px 0 0";
      var fill = document.createElement("i");
      fill.setAttribute("aria-hidden", "true");
      fill.style.cssText = "display:block;height:100%;border-radius:999px;background:" + TRACE_D1.rust + ";width:" + percent + "%";
      bar.appendChild(fill);
      position.appendChild(bar);
    }
    return position;
  }

  function surfaceNoteText(text) {
    var note = document.createElement("span");
    note.className = "note";
    note.textContent = text;
    note.style.cssText = "display:block;flex:1;min-width:0;text-align:left;font:italic 13.5px/1.45 'Fraunces',Georgia,serif;color:" + TRACE_D1.ink2;
    return note;
  }

  function surfaceTagPill(text, collectionTone) {
    var tag = document.createElement("span");
    tag.className = collectionTone ? "x-utag coll" : "x-utag";
    tag.textContent = text;
    if (text && String(text).length > 24) tag.title = text;
    tag.style.cssText = [
      "display:inline-block",
      "box-sizing:border-box",
      "max-width:150px",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "vertical-align:middle",
      "border-radius:999px",
      "padding:3px 10px",
      "font:500 11.5px/1.15 " + TRACE_D1.font,
      "white-space:nowrap",
      "background:" + (collectionTone ? TRACE_D1.honeySoft : TRACE_D1.forestSoft),
      "color:" + (collectionTone ? TRACE_D1.honey : TRACE_D1.forest),
    ].join(";");
    return tag;
  }

  function visiblePrivateTags(context) {
    if (!context || !context.tags || !context.tags.length) return [];
    return context.tags.slice(0, PRIVATE_TAG_DISPLAY_LIMIT);
  }

  function appendPrivateContextRows(surface, entry) {
    var context = entry && entry.privateContext;
    if (!context || (!context.hasNotes && !context.tagCount)) return;
    var meta = document.createElement("div");
    meta.className = "x-meta";
    meta.style.cssText = "display:flex;flex-direction:column;gap:9px;padding-top:12px;border-top:1px solid " + TRACE_D1.line;
    if (context.hasNotes) {
      meta.appendChild(surfaceMetaRow(
        "note",
        surfaceNoteText(context.notePreview || "Private note saved \u00b7 edit in Trace"),
        "Private note",
      ));
    }
    if (context.tagCount > 0) {
      var tags = document.createElement("span");
      tags.className = "tags";
      tags.style.cssText = "display:flex;flex:1;min-width:0;flex-wrap:wrap;gap:6px;text-align:left";
      if (context.tags && context.tags.length) {
        var visibleTags = visiblePrivateTags(context);
        visibleTags.forEach(function (tag) {
          tags.appendChild(surfaceTagPill(tag, false));
        });
        if (context.tagCount > visibleTags.length) {
          tags.appendChild(surfaceTagPill("+" + (context.tagCount - visibleTags.length), false));
        }
      } else {
        tags.appendChild(surfaceTagPill(
          context.tagCount === 1 ? "1 private tag" : context.tagCount + " private tags",
          false,
        ));
      }
      meta.appendChild(surfaceMetaRow("tag", tags, "Private tags"));
    }
    if (meta.childNodes.length > 0) surface.appendChild(meta);
  }

  function bindStatusChoice(choice, entry, workKey, status, rerender, refreshSurface) {
    choice.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!entry.entryId) return;
      var statusPatch = readerStatusProgressPatch(entry, status);
      var previousStatus = entry.status;
      var previousReaderStatus = entry.readerStatus;
      var previousChapters = entry.chapters
        ? {
            current: entry.chapters.current,
            total: entry.chapters.total,
          }
        : undefined;
      entry.__traceStatusPending = true;
      entry.__traceStatusTarget = status;
      delete entry.__traceStatusError;
      rerender();
      if (typeof refreshSurface === "function") refreshSurface();
      var payload = { workKey: workKey, entryId: entry.entryId, status: status };
      if (statusPatch && statusPatch.progress) payload.progress = statusPatch.progress;
      ext.runtime.sendMessage(
        {
          type: "TRACE_SET_READER_STATUS",
          payload: payload,
        },
        function (response) {
          if (ext.runtime.lastError || !response || !response.ok) {
            entry.status = previousStatus;
            entry.readerStatus = previousReaderStatus;
            if (previousChapters) {
              entry.chapters = previousChapters;
            } else {
              delete entry.chapters;
            }
            delete entry.__traceStatusPending;
            delete entry.__traceStatusTarget;
            entry.__traceStatusError = response && response.error ? response.error : "update_failed";
            rerender();
            if (typeof refreshSurface === "function") refreshSurface();
            return;
          }
          entry.status = status;
          entry.readerStatus = status;
          if (statusPatch && statusPatch.chapters) {
            entry.chapters = statusPatch.chapters;
          }
          delete entry.__traceStatusPending;
          delete entry.__traceStatusTarget;
          delete entry.__traceStatusError;
          rerender();
          if (typeof refreshSurface === "function") refreshSurface();
        },
      );
    });
  }

  function statusChoiceStyle(status, selected) {
    var accent = D1_STATUS_ACCENT[status] || STATUS_TOKENS.READING.accent;
    var soft = D1_STATUS_SOFT[status] || STATUS_TOKENS.READING.container;
    return [
      "flex:1",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:5px",
      "box-sizing:border-box",
      "min-width:0",
      "min-height:50px",
      "padding:8px 2px",
      "overflow:visible",
      "border-radius:8px",
      "border:1px solid " + (selected ? accent : TRACE_D1.lineStrong),
      "background:" + (selected ? soft : TRACE_D1.paper),
      "color:" + (selected ? TRACE_D1.ink : TRACE_D1.ink3),
      "font:500 11px/1 " + TRACE_D1.font,
      "letter-spacing:0",
      "text-transform:none",
      "cursor:pointer",
    ].join(";");
  }

  function appendStatusControls(surface, entry, workKey, rerender, showActions, refreshSurface) {
    if (!showActions) return;
    if (!entry || !entry.entryId) return;
    var wrap = document.createElement("div");
    wrap.setAttribute("data-trace-status-choices", "1");
    wrap.style.cssText = "display:grid;gap:8px;padding-top:12px;border-top:1px solid " + TRACE_D1.line;
    var label = document.createElement("div");
    label.className = "x-sheet-label";
    label.textContent = "Reading status";
    label.style.cssText = "font:500 9px/1 " + TRACE_D1.mono + ";letter-spacing:0.18em;text-transform:uppercase;color:" + TRACE_D1.ink4;
    var row = document.createElement("div");
    row.className = "x-seg";
    row.style.cssText = "display:flex;gap:5px";
    MANAGEMENT_STATUS_CHOICES.forEach(function (status) {
      var choice = document.createElement("button");
      choice.type = "button";
      choice.setAttribute("data-trace-status-choice", status);
      var selected = entryStatusValue(entry) === status;
      if (selected) {
        choice.setAttribute("data-trace-status-selected", "1");
        choice.setAttribute("aria-pressed", "true");
      } else {
        choice.setAttribute("aria-pressed", "false");
      }
      choice.style.cssText = statusChoiceStyle(status, selected);
      var dot = document.createElement("span");
      dot.setAttribute("aria-hidden", "true");
      dot.style.cssText = [
        "width:7px",
        "height:7px",
        "border-radius:999px",
        "background:" + (selected ? D1_STATUS_ACCENT[status] || STATUS_TOKENS.READING.accent : TRACE_D1.ink5),
        selected ? "box-shadow:0 0 0 3px " + (D1_STATUS_SOFT[status] || STATUS_TOKENS.READING.container) : "",
      ].join(";");
      choice.appendChild(dot);
      choice.appendChild(document.createTextNode(statusControlChoiceLabel(status)));
      bindStatusChoice(choice, entry, workKey, status, rerender, refreshSurface);
      row.appendChild(choice);
    });
    wrap.appendChild(label);
    wrap.appendChild(row);
    surface.appendChild(wrap);
  }

  function renderListingActionSurface(trigger, entry, workKey, showActions, rerender, platform, anchor) {
    closeListingActionSurface();
    var surface = document.createElement("aside");
    surface.className = "x x-sheet";
    surface.setAttribute(ACTION_SURFACE_ATTR, "1");
    surface.setAttribute("data-trace-action-surface-key", workKey);
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", "Trace actions for this work");

    var mobile = isCompactOverlayLayout();
    var css = [
      "position:fixed",
      "z-index:2147483647",
      "box-sizing:border-box",
      "display:block",
      "width:" + (mobile ? "100%" : "min(360px,calc(100vw - 24px))"),
      "max-width:" + (mobile ? "430px" : "360px"),
      "padding:0",
      "border-radius:" + (mobile ? "20px 20px 0 0" : "16px"),
      "border:1px solid " + TRACE_D1.lineStrong,
      "background:" + TRACE_D1.card,
      "color:" + TRACE_D1.ink,
      "box-shadow:0 1px 0 rgba(255,250,230,0.4) inset, 0 28px 60px -20px rgba(20,14,0,0.42), 0 0 0 1px " + TRACE_D1.lineStrong,
      "font:500 13px/1.4 " + TRACE_D1.font,
      "overflow:auto",
      "-webkit-font-smoothing:antialiased",
    ];
    if (mobile) {
      css.push("left:0", "right:0", "bottom:0", "margin:0 auto", "max-height:min(72vh,520px)");
    } else {
      var rect = trigger.getBoundingClientRect();
      var surfaceWidth = Math.min(360, Math.max(280, (window.innerWidth || 360) - 24));
      var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 640;
      var top = rect.bottom + 8;
      top = Math.min(Math.max(8, top), Math.max(8, viewportHeight - 120));
      var left = rect.left;
      left = Math.max(8, Math.min(left, (window.innerWidth || 320) - surfaceWidth - 8));
      css.push(
        "top:" + Math.max(8, top) + "px",
        "left:" + Math.max(8, left) + "px",
        "max-height:calc(100vh - " + (Math.max(8, top) + 8) + "px)",
      );
    }
    surface.style.cssText = css.join(";");

    if (mobile) {
      lockListingBottomSheetPageScroll();
      var grabber = createBottomSheetGrabber(TRACE_D1.ink5);
      surface.appendChild(grabber);
      bindBottomSheetDragClose(surface, grabber, closeListingActionSurface);
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
      "border-bottom:1px solid " + TRACE_D1.line,
    ].join(";");
    var text = document.createElement("div");
    text.style.cssText = "min-width:0";
    var source = document.createElement("div");
    source.className = "src";
    var sourcePlatform = platform || String(workKey || "").split(":")[0];
    var listingMeta = surfaceListingMeta(sourcePlatform, anchor);
    source.textContent = sourcePlatform === "ffn" ? "FFN" : "AO3";
    source.style.cssText = "font:500 9px/1 " + TRACE_D1.mono + ";letter-spacing:0.14em;text-transform:uppercase;color:" + TRACE_D1.rust;
    var title = document.createElement("div");
    title.className = "ti";
    title.textContent = listingMeta.title || lensHeadline(entry);
    title.style.cssText = "margin-top:3px;font:500 17px/1.2 'Fraunces',Georgia,serif;color:" + TRACE_D1.ink;
    var caption = document.createElement("div");
    caption.className = "au";
    caption.textContent = listingMeta.author
      ? (/^by\s+/i.test(listingMeta.author) ? listingMeta.author : "by " + listingMeta.author)
      : lensCaption(entry);
    caption.style.cssText = "margin-top:2px;color:" + TRACE_D1.ink3 + ";font:500 12px/1.35 " + TRACE_D1.font;
    text.appendChild(source);
    text.appendChild(title);
    text.appendChild(caption);
    header.appendChild(text);
    var close = document.createElement("button");
    close.className = "x-close";
    close.setAttribute(ACTION_SURFACE_CLOSE_ATTR, "1");
    close.setAttribute("aria-label", "Close Trace actions");
    close.type = "button";
    close.textContent = "\u00d7";
    close.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "width:26px",
      "height:26px",
      "border-radius:7px",
      "border:1px solid " + TRACE_D1.line,
      "background:" + TRACE_D1.paper2,
      "color:" + TRACE_D1.ink3,
      "font:600 16px/1 system-ui,-apple-system,'Segoe UI',sans-serif",
      "cursor:pointer",
    ].join(";");
    close.addEventListener("click", function (e) {
      e.preventDefault();
      closeListingActionSurface();
    });
    header.appendChild(close);
    surface.appendChild(header);

    var body = document.createElement("div");
    body.className = "x-sheet-body";
    body.setAttribute("data-trace-action-body", "1");
    body.style.cssText = "display:flex;flex-direction:column;gap:14px;padding:14px 16px 16px";
    function refreshSurface() {
      var latestTrigger = trigger;
      var lenses = document.querySelectorAll("[" + LENS_ATTR + "]");
      for (var i = 0; i < lenses.length; i += 1) {
        if (lenses[i].getAttribute(LENS_ATTR) === workKey) {
          latestTrigger = lenses[i];
          break;
        }
      }
      renderListingActionSurface(latestTrigger, entry, workKey, showActions, rerender, platform, anchor);
    }
    var status = entryStatusValue(entry);
    appendStatusControls(body, entry, workKey, rerender, showActions, refreshSurface);
    if (status && (!showActions || !(entry && entry.entryId))) {
      body.appendChild(surfaceRowEl("Reading status", statusChoiceLabel(status), false));
    }
    var position = status ? surfacePositionBlock(entry) : null;
    if (position) body.appendChild(position);
    appendCatchupAction(body, entry, workKey, rerender, refreshSurface);
    appendRatingControls(body, entry, workKey);
    appendPrivateContextRows(body, entry);
    surface.appendChild(body);

    var actions = document.createElement("div");
    actions.className = "x-sheet-foot";
    actions.style.cssText = "display:flex;gap:8px;padding:0 16px 16px";
    var open = document.createElement("a");
    open.href = traceEntryOpenUrl(entry);
    open.className = "x-pbtn x-pbtn-primary";
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.appendChild(traceIconEl("open"));
    open.appendChild(document.createTextNode("Open in Trace"));
    open.style.cssText = surfacePrimaryButtonStyle() + ";flex:1";
    bindTraceOpenLink(open);
    actions.appendChild(open);
    if (showActions) {
      var preference = preferenceBtnEl(workKey, entry && entry.hidden === true, function (nextHidden) {
        entry.hidden = nextHidden;
        closeListingActionSurface();
        rerender();
      }, true);
      preference.className = "x-pbtn x-pbtn-ghost";
      preference.style.cssText = surfaceGhostButtonStyle(entry && entry.hidden === true ? HIDDEN_THEME : HIDE_ACTION_THEME) + ";flex:0 0 auto;min-width:72px";
      if (!(entry && entry.hidden === true)) {
        removeWrapChildren(preference);
        preference.setAttribute("aria-label", "Hide this work");
        preference.appendChild(traceIconEl("eyeoff"));
        preference.appendChild(document.createTextNode("Hide"));
        preference.style.cssText = surfaceGhostButtonStyle(HIDE_ACTION_THEME) + ";flex:0 0 auto";
      }
      actions.appendChild(preference);
    }
    surface.appendChild(actions);

    document.documentElement.appendChild(surface);
    setTimeout(function () {
      document.addEventListener("click", outsideSurfaceClick, true);
      document.addEventListener("keydown", surfaceKeydown, true);
    }, 0);
  }

  function lensEl(entry, workKey, showActions, rerender, platform, anchor) {
    var theme = lensTheme(entry);
    var btn = document.createElement("button");
    btn.setAttribute(ATTR, "1");
    btn.setAttribute(LENS_ATTR, workKey);
    if (entry && entry.__traceStatusPending) btn.setAttribute("data-trace-status-saving", "1");
    if (entry && entry.__traceStatusError) btn.setAttribute("data-trace-status-error", "1");
    if (entry && entry.hidden) btn.setAttribute("data-trace-browse-hidden", "1");
    if (entry && entry.workStatus) btn.setAttribute("data-trace-work-status", entry.workStatus);
    if (newChaptersDisplay(entry, false)) btn.setAttribute("data-trace-new-chapters", "1");
    btn.type = "button";
    btn.title = "Open Trace actions";
    btn.setAttribute("aria-label", "Open Trace actions: " + lensHeadline(entry));
    btn.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "gap:7px",
      "box-sizing:border-box",
      "max-width:min(220px,100%)",
      "padding:2px 0",
      "border:0",
      "border-radius:0",
      "background:transparent",
      "color:" + TRACE_D1.ink2,
      "box-shadow:none",
      "font:500 12.5px/1.3 " + TRACE_D1.font,
      "letter-spacing:0",
      "cursor:pointer",
      "vertical-align:middle",
    ].join(";");
    var dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    dot.style.cssText = [
      "width:7px",
      "height:7px",
      "border-radius:999px",
      "background:" + lensDotColor(entry, theme),
      "flex:0 0 auto",
    ].join(";");
    btn.appendChild(dot);
    var label = document.createElement("span");
    label.textContent = lensLabelText(entry);
    label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:" + TRACE_D1.ink2;
    btn.appendChild(label);
    var progress = lensProgressText(entry);
    if (progress) {
      var progressEl = document.createElement("span");
      progressEl.textContent = progress;
      progressEl.style.cssText = "flex:0 0 auto;font:500 11px/1.3 " + TRACE_D1.mono + ";color:" + TRACE_D1.ink3;
      btn.appendChild(progressEl);
    }
    btn.addEventListener("mouseenter", function () {
      label.style.textDecoration = "underline";
      label.style.textDecorationColor = TRACE_D1.ink4;
    });
    btn.addEventListener("mouseleave", function () {
      label.style.textDecoration = "none";
    });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var existing = document.querySelector("[" + ACTION_SURFACE_ATTR + "]");
      if (
        existing &&
        existing.getAttribute("data-trace-action-surface-key") === workKey
      ) {
        closeListingActionSurface();
        return;
      }
      renderListingActionSurface(btn, entry, workKey, showActions, rerender, platform, anchor);
    });
    return btn;
  }

  function resetPreferenceBtn(btn, hidden) {
    btn.style.cssText = preferenceButtonStyle(btn, hidden ? HIDDEN_THEME : HIDE_ACTION_THEME);
    if (btn && btn.getAttribute("data-trace-surface-action") === "1") {
      btn.textContent = hidden ? "Unhide" : "Hide";
    } else {
      setButtonInlineContent(btn, hidden ? null : "eyeoff", hidden ? "Unhide" : "Hide");
    }
    btn.title = hidden
      ? "Show this work in Trace browsing overlays"
      : "Hide this work in Trace browsing overlays";
    btn.disabled = false;
  }

  function preferenceBtnEl(workKey, hidden, onSuccess, surfaceAction) {
    var btn = document.createElement("button");
    btn.setAttribute(ATTR, "1");
    btn.setAttribute("data-trace-hidden-action", hidden ? "undo" : "hide");
    if (surfaceAction) btn.setAttribute("data-trace-surface-action", "1");
    btn.type = "button";
    resetPreferenceBtn(btn, hidden);

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (btn.getAttribute("data-trace-connect-action") === "1") {
        setPreferenceCheckingAction(btn);
        openTraceUrlInBrowserTab(traceOpenUrl());
        scheduleRun(350);
        setTimeout(function () {
          if (btn.getAttribute("data-trace-connect-checking") === "1") {
            setPreferenceAuthAction(btn, btn.getAttribute("data-trace-connect-error") || "not_authenticated");
          }
        }, 3000);
        return;
      }

      var nextHidden = !hidden;
      btn.style.cssText = preferenceButtonStyle(btn, ADDING_THEME) + ";cursor:wait";
      if (btn.getAttribute("data-trace-surface-action") === "1") {
        btn.textContent = "Saving...";
      } else {
        setButtonInlineContent(btn, "spin", "Saving...");
      }
      btn.disabled = true;

      ext.runtime.sendMessage(
        {
          type: "TRACE_SET_HIDDEN_WORK",
          payload: { key: workKey, hidden: nextHidden },
        },
        function (response) {
          if (ext.runtime.lastError || !response) {
            btn.style.cssText = preferenceButtonStyle(btn, ERROR_THEME) + ";cursor:pointer";
            btn.textContent = "Error";
            btn.disabled = false;
            setTimeout(function () {
              resetPreferenceBtn(btn, hidden);
            }, 2500);
            return;
          }
          if (response.ok) {
            onSuccess(nextHidden);
            return;
          }
          if (response.error === "not_authenticated" || response.error === "auth_expired") {
            setPreferenceAuthAction(btn, response.error);
            return;
          }
          if (response.error === "rate_limited") {
            btn.style.cssText = preferenceButtonStyle(btn, FULL_THEME) + ";cursor:pointer";
            btn.textContent = "Wait";
          } else {
            btn.style.cssText = preferenceButtonStyle(btn, ERROR_THEME) + ";cursor:pointer";
            btn.textContent = "Error";
          }
          btn.disabled = false;
          setTimeout(function () {
            resetPreferenceBtn(btn, hidden);
          }, 2500);
        },
      );
    });

    return btn;
  }

  function setPreferenceAuthAction(btn, error) {
    var expired = error === "auth_expired";
    btn.style.cssText = preferenceButtonStyle(btn, ERROR_THEME) + ";cursor:pointer";
    btn.textContent = expired ? "Sign in" : "Connect";
    btn.title = expired ? "Open Trace to sign in again" : "Open Trace to connect the extension";
    btn.setAttribute("data-trace-connect-action", "1");
    btn.setAttribute("data-trace-connect-error", error || "not_authenticated");
    btn.removeAttribute("data-trace-connect-checking");
    btn.disabled = false;
  }

  function setPreferenceCheckingAction(btn) {
    btn.style.cssText = preferenceButtonStyle(btn, ADDING_THEME) + ";cursor:wait";
    if (btn.getAttribute("data-trace-surface-action") === "1") {
      btn.textContent = "Checking";
    } else {
      setButtonInlineContent(btn, "spin", "Checking");
    }
    btn.title = "Checking Trace connection";
    btn.setAttribute("data-trace-connect-checking", "1");
    btn.disabled = true;
  }

  function removeWrapChildren(wrap) {
    while (wrap.firstChild) {
      wrap.removeChild(wrap.firstChild);
    }
  }

  function listingRowForAnchor(platform, anchor) {
    if (!anchor || !anchor.closest) return null;
    if (platform === "ao3") {
      return anchor.closest('li.work.blurb, li.work[id^="work_"], .work.blurb');
    }
    if (platform === "ffn") {
      return anchor.closest(".z-list, div.bs.brb");
    }
    return null;
  }

  function removeExistingTraceWrapsInRow(row) {
    if (!row || !row.querySelectorAll) return;
    row.querySelectorAll("[" + WRAP_ATTR + "]").forEach(function (el) {
      el.remove();
    });
  }

  function restoreListingRow(row) {
    if (!row || row.getAttribute("data-trace-row-hidden") !== "1") return;
    var originalStyle = row.getAttribute("data-trace-row-original-style");
    if (originalStyle) {
      row.setAttribute("style", originalStyle);
    } else {
      row.removeAttribute("style");
    }
    row.removeAttribute("data-trace-row-hidden");
    row.removeAttribute("data-trace-row-original-style");
    Array.from(row.children).forEach(function (child) {
      if (child.getAttribute("data-trace-row-hidden-child") !== "1") return;
      var originalDisplay = child.getAttribute("data-trace-row-original-display");
      child.style.display = originalDisplay || "";
      child.removeAttribute("data-trace-row-hidden-child");
      child.removeAttribute("data-trace-row-original-display");
      if (child.getAttribute("data-trace-row-hidden-text") === "1") {
        child.replaceWith(document.createTextNode(child.textContent || ""));
      }
    });
  }

  function wrapDirectTextNodesForCollapse(row) {
    if (!row || !row.childNodes) return;
    Array.from(row.childNodes).forEach(function (node) {
      if (node.nodeType !== 3) return;
      if (!/\S/.test(node.nodeValue || "")) return;
      var span = document.createElement("span");
      span.setAttribute("data-trace-row-hidden-text", "1");
      span.textContent = node.nodeValue || "";
      row.insertBefore(span, node);
      node.remove();
    });
  }

  function collapseListingRow(row, placeholder) {
    if (!row || !placeholder) return;
    if (placeholder.parentElement !== row) row.appendChild(placeholder);
    if (row.getAttribute("data-trace-row-hidden") !== "1") {
      row.setAttribute("data-trace-row-original-style", row.getAttribute("style") || "");
    }
    row.setAttribute("data-trace-row-hidden", "1");
    wrapDirectTextNodesForCollapse(row);
    Array.from(row.children).forEach(function (child) {
      if (child === placeholder) return;
      if (child.getAttribute("data-trace-row-hidden-child") !== "1") {
        child.setAttribute("data-trace-row-original-display", child.style.display || "");
      }
      child.setAttribute("data-trace-row-hidden-child", "1");
      child.style.display = "none";
    });
    row.style.cssText = [
      "display:block",
      "box-sizing:border-box",
      "min-height:0",
      "margin:4px 0",
      "padding:4px 0",
      "border:0",
      "background:transparent",
      "list-style:none",
    ].join(";");
  }

  function hiddenPlaceholderEl(workKey, entry, showActions, onUndo) {
    var box = document.createElement("span");
    box.setAttribute(ATTR, "1");
    box.setAttribute("data-trace-hidden-placeholder", "1");
    box.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "gap:9px",
      "box-sizing:border-box",
      "max-width:100%",
      "padding:2px 0",
      "border:0",
      "background:transparent",
      "color:" + TRACE_D1.ink4,
      "font:500 12px/1.3 " + TRACE_D1.font,
      "letter-spacing:0",
      "white-space:nowrap",
    ].join(";");
    var label = document.createElement("span");
    label.textContent = "Hidden by Trace";
    label.style.cssText = "font-weight:500;color:" + TRACE_D1.ink3;
    box.appendChild(label);
    if (!showActions) return box;

    var undo = document.createElement("button");
    undo.type = "button";
    undo.setAttribute("data-trace-hidden-action", "undo");
    undo.textContent = "Unhide";
    undo.style.cssText = [
      "border:0",
      "border-bottom:1px solid " + TRACE_D1.forestLine,
      "border-radius:0",
      "background:transparent",
      "color:" + TRACE_D1.forest,
      "padding:2px 0",
      "font:500 12px/1.3 " + TRACE_D1.font,
      "cursor:pointer",
    ].join(";");
    undo.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      undo.disabled = true;
      undo.textContent = "...";
      ext.runtime.sendMessage(
        {
          type: "TRACE_SET_HIDDEN_WORK",
          payload: { key: workKey, hidden: false },
        },
        function (response) {
          if (ext.runtime.lastError || !response || !response.ok) {
            undo.disabled = false;
            undo.textContent = "Retry";
            return;
          }
          entry.hidden = false;
          onUndo();
        },
      );
    });
    box.appendChild(undo);
    return box;
  }

  function renderOverlayState(wrap, entry, platform, anchor, workKey, showActions) {
    removeWrapChildren(wrap);
    var row = listingRowForAnchor(platform, anchor);
    var canMutate = showActions;
    wrap.style.opacity = "";

    if (entry && entry.hidden) {
      if (row && wrap.isConnected && wrap.parentElement !== row) {
        row.appendChild(wrap);
      }
      wrap.appendChild(
        hiddenPlaceholderEl(workKey, entry, canMutate, function () {
          restoreListingRow(row);
          renderOverlayState(wrap, entry, platform, anchor, workKey, showActions);
        }),
      );
      if (row && wrap.isConnected) collapseListingRow(row, wrap);
      return true;
    }

    restoreListingRow(row);

    if (entry && (entry.readerStatus || entry.status)) {
      wrap.appendChild(
        lensEl(entry, workKey, canMutate, function () {
          renderOverlayState(wrap, entry, platform, anchor, workKey, showActions);
        }, platform, anchor),
      );
      return true;
    }

    if (showActions) {
      wrap.appendChild(quickAddBtnEl(platform, anchor, workKey));
      if (canMutate) {
        var hiddenEntry = entry || { status: null, readerStatus: null, hidden: false };
        wrap.appendChild(
          preferenceBtnEl(workKey, false, function (nextHidden) {
            hiddenEntry.hidden = nextHidden;
            renderOverlayState(wrap, hiddenEntry, platform, anchor, workKey, showActions);
          }),
        );
      }
      return true;
    }

    return false;
  }

  function quickAddBtnEl(platform, anchor, workKey) {
    var btn = document.createElement("button");
    btn.setAttribute(ATTR, "1");
    btn.setAttribute("data-trace-quick-add", workKey);
    btn.type = "button";
    setButtonInlineContent(btn, "plus", "Add to Trace");
    btn.title = "Add to your Trace library";
    btn.style.cssText = d1QuickAddStyle("add") + ";cursor:pointer";

    btn.addEventListener("mouseenter", function () {
      if (!btn.disabled) {
        btn.style.borderBottomColor = "rgba(31,77,63,0.55)";
      }
    });
    btn.addEventListener("mouseleave", function () {
      if (!btn.disabled) {
        btn.style.borderBottomColor = TRACE_D1.forestLine;
      }
    });

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;

      if (btn.getAttribute("data-trace-connect-action") === "1") {
        setQuickAddCheckingAction(btn);
        window.open(traceOpenUrl(), "_blank", "noopener,noreferrer");
        scheduleRun(350);
        setTimeout(function () {
          if (btn.getAttribute("data-trace-connect-checking") === "1") {
            setQuickAddAuthAction(btn, btn.getAttribute("data-trace-connect-error") || "not_authenticated");
          }
        }, 3000);
        return;
      }

      var item = scrapeListingItem(platform, anchor);
      if (!item) return;

      btn.style.cssText = d1QuickAddStyle("busy") + ";cursor:wait";
      setButtonInlineContent(btn, "spin", "Adding...");
      btn.disabled = true;

      var payload = { s: item.src, at: new Date().toISOString(), item: item };
      ext.runtime.sendMessage(
        { type: "TRACE_QUICK_ADD", payload: payload },
        function (response) {
          if (ext.runtime.lastError || !response) {
            btn.style.cssText = d1QuickAddStyle("error") + ";cursor:pointer";
            btn.textContent = "Error";
            btn.disabled = false;
            setTimeout(function () {
              btn.style.cssText = d1QuickAddStyle("add") + ";cursor:pointer";
              setButtonInlineContent(btn, "plus", "Add to Trace");
            }, 2500);
            return;
          }
          if (response.ok) {
            var confirmedEntry =
              response.state &&
              response.state.status === "saved" &&
              response.state.entry &&
              typeof response.state.entry === "object"
                ? normalizeOverlayEntry(response.state.entry)
                : null;
            if (!confirmedEntry || !(confirmedEntry.readerStatus || confirmedEntry.status)) {
              btn.style.cssText = d1QuickAddStyle("error") + ";cursor:pointer";
              btn.textContent = "Error";
              btn.title = "Trace did not confirm this story in your library. Try again.";
              btn.disabled = false;
              scheduleRun(250);
              return;
            }
            btn.style.cssText = [
              "display:inline-flex",
              "align-items:center",
              "gap:7px",
              "box-sizing:border-box",
              "max-width:min(220px,100%)",
              "padding:2px 0",
              "border:0",
              "border-radius:0",
              "background:transparent",
              "color:" + TRACE_D1.ink2,
              "box-shadow:none",
              "font:500 12.5px/1.3 " + TRACE_D1.font,
              "letter-spacing:0",
              "white-space:nowrap",
              "vertical-align:middle",
            ].join(";");
            setInlineStatusContent(btn, entryStatusValue(confirmedEntry) || "PLANNING");
            btn.title = "In your Trace library";
            btn.disabled = true;
            scheduleRun(250);
          } else if (response.error === "free_limit_reached") {
            btn.style.cssText = d1QuickAddStyle("full");
            btn.textContent = "Full";
            btn.title = "Free library limit reached \u2014 upgrade for unlimited";
            btn.disabled = true;
          } else if (response.error === "not_authenticated" || response.error === "auth_expired") {
            setQuickAddAuthAction(btn, response.error);
          } else {
            btn.style.cssText = d1QuickAddStyle("error") + ";cursor:pointer";
            btn.textContent = "Error";
            btn.disabled = false;
            setTimeout(function () {
              btn.style.cssText = d1QuickAddStyle("add") + ";cursor:pointer";
              setButtonInlineContent(btn, "plus", "Add to Trace");
            }, 2500);
          }
        },
      );
    });

    return btn;
  }

  function setQuickAddAuthAction(btn, error) {
    var expired = error === "auth_expired";
    btn.style.cssText = d1QuickAddStyle("error") + ";cursor:pointer";
    btn.textContent = expired ? "Sign in" : "Connect";
    btn.title = expired ? "Open Trace to sign in again" : "Open Trace to connect the extension";
    btn.setAttribute("data-trace-connect-action", "1");
    btn.setAttribute("data-trace-connect-error", error || "not_authenticated");
    btn.removeAttribute("data-trace-connect-checking");
    btn.disabled = false;
  }

  function setQuickAddCheckingAction(btn) {
    btn.style.cssText = d1QuickAddStyle("busy") + ";cursor:wait";
    setButtonInlineContent(btn, "spin", "Checking");
    btn.title = "Checking Trace connection";
    btn.setAttribute("data-trace-connect-checking", "1");
    btn.disabled = true;
  }

  function currentOpenActionSurfaceKey() {
    var surface = document.querySelector("[" + ACTION_SURFACE_ATTR + "]");
    return surface ? surface.getAttribute("data-trace-action-surface-key") : null;
  }

  function reopenActionSurface(workKey) {
    if (!workKey) return;
    var lenses = document.querySelectorAll("[" + LENS_ATTR + "]");
    for (var i = 0; i < lenses.length; i += 1) {
      if (lenses[i].getAttribute(LENS_ATTR) === workKey) {
        lenses[i].click();
        return;
      }
    }
  }

  function clearBadges() {
    try {
      closeListingActionSurface();
      document.querySelectorAll("[data-trace-row-hidden='1']").forEach(function (row) {
        restoreListingRow(row);
      });
      document.querySelectorAll("[" + WRAP_ATTR + "]").forEach(function (el) {
        el.remove();
      });
      document.querySelectorAll("span[" + ATTR + "]").forEach(function (el) {
        el.remove();
      });
      document.querySelectorAll("a[" + ATTR + "]").forEach(function (a) {
        a.removeAttribute(ATTR);
      });
    } catch {
      /* ignore */
    }
  }

  function ao3ActionRowTarget(row, anchor) {
    var header = row && row.querySelector ? row.querySelector(".header.module, .header") : null;
    if (header) return header;
    return compactAo3HeadingTarget(anchor);
  }

  function ao3ActionRowPlacement(row, anchor, kind) {
    return {
      kind: kind,
      target: ao3ActionRowTarget(row, anchor),
      position: "afterend",
      display: "display:flex",
      justify: "justify-content:flex-start",
      margin: "margin:8px 0 10px 0",
      maxWidth: "max-width:100%",
      width: "width:100%",
      clear: "clear:both",
    };
  }

  function ao3ListingPlacement(anchor) {
    var row = anchor && anchor.closest
      ? anchor.closest('li.work.blurb, li.work[id^="work_"], .work.blurb')
      : null;
    if (row) {
      return ao3ActionRowPlacement(row, anchor, "ao3-action-row");
    }
    return {
      kind: "ao3-heading-fallback",
      target: compactAo3HeadingTarget(anchor),
      position: "afterend",
      display: "display:flex",
      justify: "justify-content:flex-start",
      margin: "margin:4px 0 0 0",
      maxWidth: "max-width:100%",
    };
  }

  function ffnListingPlacement(anchor) {
    var row = anchor && anchor.closest
      ? anchor.closest(".z-list, div.bs.brb")
      : null;
    if (row) {
      var meta = row.querySelector(".z-padtop2.xgray, .xgray.xcontrast_txt, .xgray, div.gray");
      if (meta) {
        return {
          kind: "ffn-meta-row",
          target: meta,
          position: "afterend",
          display: "display:flex",
          justify: "justify-content:flex-start",
          margin: "margin:4px 0 0 0",
          maxWidth: "max-width:100%",
        };
      }
      return {
        kind: "ffn-row-end",
        target: row,
        position: "beforeend",
        display: "display:flex",
        justify: "justify-content:flex-start",
        margin: "margin:4px 0 0 0",
        maxWidth: "max-width:100%",
      };
    }
    return {
      kind: "ffn-title-fallback",
      target: anchor,
      position: "afterend",
      display: "display:inline-flex",
      justify: "justify-content:flex-start",
      margin: "margin-left:6px",
      maxWidth: "max-width:calc(100% - 6px)",
    };
  }

  function listingPlacementForAnchor(info, anchor) {
    if (info.platform === "ao3") return ao3ListingPlacement(anchor);
    if (info.platform === "ffn") return ffnListingPlacement(anchor);
    return {
      kind: "inline-fallback",
      target: anchor,
      position: "afterend",
      display: "display:inline-flex",
      justify: "justify-content:flex-start",
      margin: "margin-left:6px",
      maxWidth: "max-width:calc(100% - 6px)",
    };
  }

  function decorate(entries, workPreferences, showQuickAdd) {
    const anchors = document.querySelectorAll('a[href*="/works/"], a[href*="/s/"]');
    const decoratedKeys = new Set();
    const decoratedRows = new WeakSet();
    for (const a of anchors) {
      if (a.hasAttribute(ATTR)) continue;
      const href = a.getAttribute("href");
      if (!href) continue;
      let absUrl;
      try {
        absUrl = new URL(href, document.baseURI).href;
      } catch {
        continue;
      }
      const info = keyFromAbsoluteUrl(absUrl);
      if (!info) continue;
      if (!isDecoratableWorkLink(absUrl, info)) continue;
      if (decoratedKeys.has(info.key)) continue;

      const entry = normalizeOverlayEntry(
        entries[info.key],
        workPreferences[info.key],
      );

      var placement = listingPlacementForAnchor(info, a);
      var listingRow = listingRowForAnchor(info.platform, a);
      if (listingRow) {
        if (decoratedRows.has(listingRow)) continue;
        decoratedRows.add(listingRow);
        removeExistingTraceWrapsInRow(listingRow);
      }
      decoratedKeys.add(info.key);
      if (entry && entry.hidden && listingRow) {
        placement = {
          kind: "hidden-placeholder",
          target: listingRow,
          position: "beforeend",
          display: "display:flex",
          justify: "justify-content:flex-start",
          margin: "margin:0",
          maxWidth: "max-width:100%",
        };
      }
      const wrap = document.createElement("span");
      wrap.setAttribute(WRAP_ATTR, "1");
      wrap.setAttribute("data-trace-placement", placement.kind);
      wrap.style.cssText = [
        placement.display,
        "align-items:center",
        placement.justify,
        "flex-wrap:wrap",
        "gap:14px",
        placement.margin,
        placement.clear || "",
        "vertical-align:middle",
        placement.maxWidth,
        placement.width || "",
      ].join(";");

      if (!renderOverlayState(wrap, entry, info.platform, a, info.key, showQuickAdd)) {
        continue;
      }

      a.setAttribute(ATTR, info.key);
      try {
        placement.target.insertAdjacentElement(placement.position, wrap);
      } catch {
        a.appendChild(wrap);
      }
      if (entry && entry.hidden && listingRow) {
        collapseListingRow(listingRow, wrap);
      }
    }
  }

  function visibleWorkKeys() {
    var keys = [];
    var seen = new Set();
    var anchors = document.querySelectorAll('a[href*="/works/"], a[href*="/s/"]');
    for (var i = 0; i < anchors.length && keys.length < MAX_PROJECTION_WORK_KEYS; i += 1) {
      var anchor = anchors[i];
      var href = anchor.getAttribute("href");
      if (!href) continue;
      try {
        var absolute = new URL(href, document.baseURI).href;
        var info = keyFromAbsoluteUrl(absolute);
        if (!info || !isDecoratableWorkLink(absolute, info) || seen.has(info.key)) continue;
        seen.add(info.key);
        keys.push(info.key);
      } catch (_) {
        /* Ignore malformed archive links. */
      }
    }
    return keys;
  }

  var rerunTimer = null;
  var domObserver = null;

  function isUndecoratedWorkAnchor(anchor) {
    if (!anchor || anchor.nodeType !== 1) return false;
    if (anchor.hasAttribute(ATTR)) return false;
    if (anchor.closest && anchor.closest("[" + WRAP_ATTR + "]")) return false;
    var href = anchor.getAttribute ? anchor.getAttribute("href") : null;
    if (!href) return false;
    var absUrl;
    try {
      absUrl = new URL(href, document.baseURI).href;
    } catch {
      return false;
    }
    var info = keyFromAbsoluteUrl(absUrl);
    if (!info) return false;
    return isDecoratableWorkLink(absUrl, info);
  }

  function needsRerunFromNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var el = node;
    if (el.matches && el.matches("a[href]") && isUndecoratedWorkAnchor(el)) {
      return true;
    }
    if (!el.querySelectorAll) return false;
    var anchors = el.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      if (isUndecoratedWorkAnchor(anchors[i])) return true;
    }
    return false;
  }

  function scheduleRun(delayMs) {
    var delay = typeof delayMs === "number" ? delayMs : 120;
    if (rerunTimer) {
      clearTimeout(rerunTimer);
    }
    rerunTimer = setTimeout(function () {
      rerunTimer = null;
      run();
    }, delay);
  }

  function startDomObserver() {
    if (domObserver) return;
    if (typeof MutationObserver !== "function") return;
    if (!document.documentElement) return;
    domObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (!m || !m.addedNodes || m.addedNodes.length === 0) continue;
        for (var j = 0; j < m.addedNodes.length; j++) {
          if (needsRerunFromNode(m.addedNodes[j])) {
            scheduleRun(90);
            return;
          }
        }
      }
    });
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function renderProjection(res, cache) {
    var hasAuth = !!res.authToken;
    currentTraceAuthState = (res && res.traceAuthState) || null;
    if (isSingleWorkPage()) {
      removeConnectNotice();
      clearBadges();
      return;
    }
    renderConnectNotice(res && res.traceAuthState, hasAuth);
    if (res && res.prefLibraryInlayEnabled === false) {
      clearBadges();
      return;
    }
    var entries = (cache && cache.entries) || {};
    var workPreferences = (cache && cache.workPreferences) || {};
    var showQuickAdd =
      authStateAllowsActions(res && res.traceAuthState, hasAuth) &&
      !isSingleWorkPage();
    var openSurfaceKey = currentOpenActionSurfaceKey();
    clearBadges();
    if (
      Object.keys(entries).length === 0 &&
      Object.keys(workPreferences).length === 0 &&
      !showQuickAdd
    ) {
      return;
    }
    decorate(entries, workPreferences, showQuickAdd);
    reopenActionSurface(openSurfaceKey);
  }

  function run() {
    try {
      if (KERNEL_SESSION_ACTIVE) {
        ext.storage.local.get(["prefLibraryInlayEnabled"], function (preferences) {
          if (ext.runtime.lastError) return;
          ext.runtime.sendMessage(
            {
              type: ACCOUNT_PROJECTION_GET_MESSAGE,
              workKeys: visibleWorkKeys(),
            },
            function (response) {
              if (ext.runtime.lastError || !response || response.ok !== true) return;
              var snapshot = response.snapshot || { state: "signed_out" };
              renderProjection({
                prefLibraryInlayEnabled:
                  preferences && preferences.prefLibraryInlayEnabled,
                traceAuthState: snapshot,
                authToken: snapshot.state === "connected" ? "kernel-session" : null,
              }, response.projection);
            },
          );
        });
        return;
      }
      ext.storage.local.get(
        [
          "libraryOverlayCache",
          "prefLibraryInlayEnabled",
          "authToken",
          "traceAuthState",
          TRACE_ACCOUNT_ID_KEY,
          TRACE_API_BASE_STORAGE_KEY,
        ],
        function (res) {
          if (ext.runtime.lastError) return;
          renderProjection(
            res,
            overlayCacheForRuntimeContext(res && res.libraryOverlayCache, res),
          );
        },
      );
    } catch {
      /* ignore */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
  startDomObserver();

  try {
    window.addEventListener("pageshow", function () {
      scheduleRun(60);
    });
    window.addEventListener("focus", function () {
      scheduleRun(80);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) scheduleRun(80);
    });
  } catch {
    /* ignore */
  }

  try {
    if (ext.storage && ext.storage.onChanged) {
      ext.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local") return;
        if (
          !changes.libraryOverlayCache &&
          !changes.prefLibraryInlayEnabled &&
          !changes.traceAuthState &&
          !changes.authToken &&
          !changes[TRACE_ACCOUNT_ID_KEY] &&
          !changes[TRACE_API_BASE_STORAGE_KEY]
        ) {
          return;
        }
        scheduleRun(60);
      });
    }
  } catch {
    /* ignore */
  }
})();
