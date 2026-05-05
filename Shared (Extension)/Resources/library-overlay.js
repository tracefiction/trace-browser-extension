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
  const TRACE_WEB_HOME_URL = "https://tracefiction.com/";
  var currentTraceAuthState = null;

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

  /** Local extension UI tones, aligned to the current Trace archive palette. */
  const STATUS_THEME = {
    READING: {
      bg: "#f7e6b6",
      fg: TRACE_UI.goldOn,
      border: "rgba(89, 68, 2, 0.2)",
    },
    PLANNING: {
      bg: TRACE_UI.paperSoft,
      fg: "#414846",
      border: TRACE_UI.border,
    },
    PAUSED: {
      bg: "#7c2d12",
      fg: "#ffffff",
      border: "rgba(124, 45, 18, 0.5)",
    },
    COMPLETED: {
      bg: TRACE_UI.forest,
      fg: TRACE_UI.forestOn,
      border: "rgba(22, 52, 45, 0.35)",
    },
    DROPPED: {
      bg: "#efe4e4",
      fg: "#ba1a1a",
      border: "rgba(186, 26, 26, 0.22)",
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

  const MARK_THEME = {
    bg: "#f0e9dc",
    fg: "#6f4d1f",
    border: "rgba(111, 77, 31, 0.24)",
  };

  const CHALLENGE_THEME = {
    bg: "#fff7ed",
    fg: "#9a3412",
    border: "rgba(154, 52, 18, 0.26)",
  };

  const CONTEXT_THEME = {
    bg: "#edf2ef",
    fg: "#41504c",
    border: "rgba(65, 80, 76, 0.18)",
  };

  const INLINE_STATUS_THEME = {
    READING: {
      bg: "rgba(241, 213, 138, 0.16)",
      fg: TRACE_UI.goldOn,
      border: "rgba(89, 68, 2, 0.16)",
      accent: "#b88a16",
    },
    PLANNING: {
      bg: "rgba(65, 72, 70, 0.035)",
      fg: "#414846",
      border: "rgba(65, 72, 70, 0.14)",
      accent: "#7d857c",
    },
    PAUSED: {
      bg: "rgba(124, 45, 18, 0.07)",
      fg: "#7c2d12",
      border: "rgba(124, 45, 18, 0.18)",
      accent: "#9a3412",
    },
    COMPLETED: {
      bg: "rgba(45, 75, 67, 0.07)",
      fg: TRACE_UI.forest,
      border: "rgba(45, 75, 67, 0.18)",
      accent: TRACE_UI.forest,
    },
    DROPPED: {
      bg: "rgba(186, 26, 26, 0.055)",
      fg: "#9f1d1d",
      border: "rgba(186, 26, 26, 0.16)",
      accent: "#ba1a1a",
    },
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
    return (
      actionChipStyle(theme) +
      ";cursor:pointer" +
      ";box-shadow:none" +
      ";transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease"
    );
  }

  function preferenceButtonStyle(btn, theme) {
    if (btn && btn.getAttribute("data-trace-surface-action") === "1") {
      return surfaceButtonStyle(theme, false) + ";cursor:pointer";
    }
    return preferenceActionStyle(theme);
  }

  function surfaceButtonStyle(theme, filled) {
    var bg = filled ? theme.bg : "transparent";
    return [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "box-sizing:border-box",
      "min-height:40px",
      "padding:0 12px",
      "border-radius:" + TRACE_UI.radiusSm,
      "border:1px solid " + theme.border,
      "background:" + bg,
      "color:" + theme.fg,
      "font:800 10px/1 " + TRACE_UI.font,
      "letter-spacing:0.04em",
      "text-transform:uppercase",
      "text-decoration:none",
      "white-space:nowrap",
      "cursor:pointer",
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
        "width:min(320px,calc(100vw - 32px))",
        "padding:12px 14px 12px 14px",
        "border-radius:14px",
        "background:#fffaf0",
        "color:#422006",
        "border:1px solid rgba(180,83,9,0.2)",
        "box-shadow:0 14px 34px rgba(28,28,23,0.18)",
        "font:500 13px/1.45 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif",
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
        "border:0",
        "border-radius:999px",
        "background:transparent",
        "color:#8b5e34",
        "font:700 16px/1 system-ui,-apple-system,'Segoe UI',sans-serif",
        "cursor:pointer",
      ].join(";");
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", function () {
        dismissConnectNotice(signature);
        removeConnectNotice();
      });

      var headingEl = document.createElement("div");
      headingEl.setAttribute("data-trace-connect-notice-heading", "1");
      headingEl.style.cssText = "margin:0 28px 4px 0;font:800 12px/1.2 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.06em;text-transform:uppercase;color:#9a3412;";

      var messageEl = document.createElement("div");
      messageEl.setAttribute("data-trace-connect-notice-message", "1");
      messageEl.style.cssText = "margin:0 0 10px 0;";

      var cta = document.createElement("a");
      cta.setAttribute("data-trace-connect-notice-cta", "1");
      cta.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "min-height:34px",
        "padding:0 12px",
        "border-radius:10px",
        "background:#8a4b15",
        "color:#fffdf8",
        "text-decoration:none",
        "font:800 11px/1 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif",
        "letter-spacing:0.05em",
        "text-transform:uppercase",
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
    var hasNotes = raw.hasNotes === true;
    var tagCount = Number(raw.tagCount);
    if (!Number.isFinite(tagCount) || tagCount < 0) tagCount = 0;
    tagCount = Math.trunc(tagCount);
    if (!hasNotes && tagCount === 0) return null;
    return { hasNotes: hasNotes, tagCount: tagCount };
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
    if (entry.workMark && entry.workMark.challenge) return "Review mark";
    var display = statusDisplay(entry);
    if (display) return display;
    return "Saved";
  }

  function lensCaption(entry) {
    if (!entry) return "";
    if (entry.__traceStatusPending) {
      return entry.__traceStatusTarget
        ? "Saving " + statusChoiceLabel(entry.__traceStatusTarget)
        : "Saving reader status";
    }
    if (entry.__traceStatusError) return "Tap to retry";
    if (entry.hidden) return "Hidden from browsing";
    if (entry.workMark && entry.workMark.challenge) {
      var challenge = entry.workMark.challenge;
      if (typeof challenge.chapterDelta === "number" && challenge.chapterDelta > 0) {
        return "+" + challenge.chapterDelta + " chapters since mark";
      }
      return "Needs review";
    }
    if (entry.workMark) return workMarkLabel(entry.workMark);
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
    if (entry.workMark && entry.workMark.challenge) {
      return {
        bg: "rgba(255, 247, 237, 0.58)",
        fg: CHALLENGE_THEME.fg,
        border: "rgba(154, 52, 18, 0.18)",
        accent: CHALLENGE_THEME.fg,
      };
    }
    var status = entryStatusValue(entry);
    return (status && INLINE_STATUS_THEME[status]) || INLINE_CONTEXT_THEME;
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

  function workMarkLabel(mark) {
    if (!mark) return null;
    if (mark.kind === "abandoned") return "Abandoned";
    if (mark.kind === "hiatus") return "Hiatus";
    return null;
  }

  function challengeLabel(challenge) {
    if (!challenge) return null;
    if (typeof challenge.chapterDelta === "number" && challenge.chapterDelta > 0) {
      return "+" + String(challenge.chapterDelta);
    }
    return "Review";
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
    var markLabelText = workMarkLabel(entry.workMark);
    if (markLabelText) {
      wrap.appendChild(
        smallBadgeEl(
          markLabelText,
          MARK_THEME,
          "Trace work mark: " + markLabelText.toLowerCase(),
          "data-trace-work-mark",
        ),
      );
    }
    var challengeText = challengeLabel(entry.workMark && entry.workMark.challenge);
    if (challengeText) {
      var challengeTitle = "Trace work mark needs review";
      if (
        entry.workMark.challenge.kind === "chapter-count-changed" &&
        typeof entry.workMark.challenge.chapterDelta === "number"
      ) {
        challengeTitle =
          String(entry.workMark.challenge.chapterDelta) +
          " chapter(s) published since your Trace mark";
      }
      wrap.appendChild(
        smallBadgeEl(
          challengeText,
          CHALLENGE_THEME,
          challengeTitle,
          "data-trace-work-mark-challenge",
        ),
      );
    }
  }

  function closeListingActionSurface() {
    var existing = document.querySelector("[" + ACTION_SURFACE_ATTR + "]");
    if (existing) existing.remove();
    document.removeEventListener("click", outsideSurfaceClick, true);
    document.removeEventListener("keydown", surfaceKeydown, true);
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
      "min-height:38px",
      "padding:8px 9px",
      "border-radius:" + TRACE_UI.radiusSm,
      "border:1px solid " + (emphasis ? CHALLENGE_THEME.border : TRACE_UI.border),
      "background:" + (emphasis ? CHALLENGE_THEME.bg : TRACE_UI.paperRaised),
    ].join(";");
    var labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.style.cssText = "font:800 9px/1 " + TRACE_UI.font + ";letter-spacing:0.06em;text-transform:uppercase;color:" + TRACE_UI.muted;
    var valueEl = document.createElement("span");
    valueEl.textContent = value;
    valueEl.style.cssText = "font:700 12px/1.25 " + TRACE_UI.font + ";color:" + TRACE_UI.ink + ";text-align:right";
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  function appendPrivateContextRows(surface, entry) {
    var context = entry && entry.privateContext;
    if (!context || (!context.hasNotes && !context.tagCount)) return;
    surface.appendChild(
      surfaceRowEl(
        "Private note",
        context.hasNotes ? "Saved \u00b7 Edit notes in Trace" : "None",
        false,
      ),
    );
    if (context.tagCount > 0) {
      surface.appendChild(
        surfaceRowEl(
          "Private tags",
          context.tagCount === 1
            ? "1 saved \u00b7 Open in Trace"
            : context.tagCount + " saved \u00b7 Open in Trace",
          false,
        ),
      );
    }
  }

  function bindStatusChoice(choice, entry, status, rerender) {
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
      closeListingActionSurface();
      rerender();
      var payload = { entryId: entry.entryId, status: status };
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
        },
      );
    });
  }

  function appendStatusControls(surface, entry, rerender, showActions) {
    if (!showActions) return;
    if (!entry || !entry.entryId) return;
    var wrap = document.createElement("div");
    wrap.setAttribute("data-trace-status-choices", "1");
    wrap.style.cssText = "display:grid;gap:7px;margin-top:2px";
    var label = document.createElement("div");
    label.textContent = "Reader status";
    label.style.cssText = "font:800 9px/1 " + TRACE_UI.font + ";letter-spacing:0.07em;text-transform:uppercase;color:" + TRACE_UI.muted;
    var row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:6px";
    MANAGEMENT_STATUS_CHOICES.forEach(function (status) {
      var choice = document.createElement("button");
      choice.type = "button";
      choice.setAttribute("data-trace-status-choice", status);
      if (entryStatusValue(entry) === status) {
        choice.setAttribute("data-trace-status-selected", "1");
        choice.setAttribute("aria-pressed", "true");
      } else {
        choice.setAttribute("aria-pressed", "false");
      }
      choice.textContent = statusChoiceLabel(status);
      choice.style.cssText = surfaceButtonStyle(
        entryStatusValue(entry) === status ? STATUS_THEME[status] : CONTEXT_THEME,
        entryStatusValue(entry) === status,
      );
      bindStatusChoice(choice, entry, status, rerender);
      row.appendChild(choice);
    });
    wrap.appendChild(label);
    wrap.appendChild(row);
    surface.appendChild(wrap);
  }

  function renderListingActionSurface(trigger, entry, workKey, showActions, rerender) {
    closeListingActionSurface();
    var surface = document.createElement("aside");
    surface.setAttribute(ACTION_SURFACE_ATTR, "1");
    surface.setAttribute("data-trace-action-surface-key", workKey);
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", "Trace actions for this work");

    var mobile = isCompactOverlayLayout();
    var css = [
      "position:fixed",
      "z-index:2147483647",
      "box-sizing:border-box",
      "display:grid",
      "gap:10px",
      "width:" + (mobile ? "auto" : "min(320px,calc(100vw - 24px))"),
      "max-width:" + (mobile ? "430px" : "320px"),
      "padding:12px",
      "border-radius:" + (mobile ? "14px 14px 10px 10px" : TRACE_UI.radiusMd),
      "border:1px solid " + TRACE_UI.borderStrong,
      "background:" + TRACE_UI.paper,
      "color:" + TRACE_UI.ink,
      "box-shadow:" + TRACE_UI.shadowPopover,
      "font:500 13px/1.4 " + TRACE_UI.font,
      "overflow:auto",
    ];
    if (mobile) {
      css.push("left:10px", "right:10px", "bottom:calc(10px + env(safe-area-inset-bottom,0px))", "margin:0 auto", "max-height:min(72vh,520px)");
    } else {
      var rect = trigger.getBoundingClientRect();
      var surfaceWidth = Math.min(320, Math.max(280, (window.innerWidth || 320) - 24));
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

    var close = document.createElement("button");
    close.setAttribute(ACTION_SURFACE_CLOSE_ATTR, "1");
    close.setAttribute("aria-label", "Close Trace actions");
    close.type = "button";
    close.textContent = "\u00d7";
    close.style.cssText = "position:absolute;right:10px;top:8px;width:30px;height:30px;border:0;border-radius:999px;background:transparent;color:" + TRACE_UI.muted + ";font:800 18px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer";
    close.addEventListener("click", function (e) {
      e.preventDefault();
      closeListingActionSurface();
    });
    surface.appendChild(close);

    if (mobile) {
      var grabber = document.createElement("div");
      grabber.style.cssText = "width:48px;height:4px;border-radius:999px;background:#d6d3cc;margin:0 auto";
      surface.appendChild(grabber);
    }

    var header = document.createElement("div");
    header.setAttribute("data-trace-management-header", "1");
    header.style.cssText = "display:block;padding-right:34px";
    var text = document.createElement("div");
    text.style.cssText = "min-width:0";
    var title = document.createElement("div");
    title.textContent = statusOnlyDisplay(entry) || lensHeadline(entry);
    title.style.cssText = "font:800 17px/1.15 " + TRACE_UI.font + ";color:" + TRACE_UI.ink;
    var caption = document.createElement("div");
    caption.textContent = lensCaption(entry);
    caption.style.cssText = "margin-top:4px;color:" + TRACE_UI.muted + ";font:600 12px/1.35 " + TRACE_UI.font;
    text.appendChild(title);
    text.appendChild(caption);
    header.appendChild(text);
    surface.appendChild(header);

    var status = entryStatusValue(entry);
    if (status) {
      surface.appendChild(
        surfaceRowEl(
          "Progress",
          progressOnlyDisplay(entry),
          false,
        ),
      );
    }
    var markLabelText = workMarkLabel(entry && entry.workMark);
    if (markLabelText) surface.appendChild(surfaceRowEl("Work mark", markLabelText, true));
    if (entry && entry.workMark && entry.workMark.challenge) {
      surface.appendChild(surfaceRowEl("Attention", challengeLabel(entry.workMark.challenge), true));
    }
    appendPrivateContextRows(surface, entry);
    appendStatusControls(surface, entry, rerender, showActions);

    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;padding-top:10px;border-top:1px solid " + TRACE_UI.border;
    if (showActions) {
      actions.appendChild(
        preferenceBtnEl(workKey, entry && entry.hidden === true, function (nextHidden) {
          entry.hidden = nextHidden;
          closeListingActionSurface();
          rerender();
        }, true),
      );
    }
    var open = document.createElement("a");
    open.href = traceEntryOpenUrl(entry);
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "OPEN IN TRACE";
    open.style.cssText = surfaceButtonStyle(CONTEXT_THEME, true);
    actions.appendChild(open);
    surface.appendChild(actions);

    document.documentElement.appendChild(surface);
    setTimeout(function () {
      document.addEventListener("click", outsideSurfaceClick, true);
      document.addEventListener("keydown", surfaceKeydown, true);
    }, 0);
  }

  function lensEl(entry, workKey, showActions, rerender) {
    var theme = lensTheme(entry);
    var btn = document.createElement("button");
    btn.setAttribute(ATTR, "1");
    btn.setAttribute(LENS_ATTR, workKey);
    if (entry && entry.__traceStatusPending) btn.setAttribute("data-trace-status-saving", "1");
    if (entry && entry.__traceStatusError) btn.setAttribute("data-trace-status-error", "1");
    if (entry && entry.hidden) btn.setAttribute("data-trace-browse-hidden", "1");
    if (entry && entry.workMark) btn.setAttribute("data-trace-work-mark", "1");
    if (entry && entry.workMark && entry.workMark.challenge) {
      btn.setAttribute("data-trace-work-mark-challenge", "1");
    }
    btn.type = "button";
    btn.title = "Open Trace actions";
    btn.setAttribute("aria-label", "Open Trace actions: " + lensHeadline(entry));
    btn.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "gap:6px",
      "box-sizing:border-box",
      "max-width:min(220px,100%)",
      "min-height:" + (isCompactOverlayLayout() ? "28px" : "22px"),
      "padding:" + (isCompactOverlayLayout() ? "3px 9px" : "2px 8px"),
      "border-radius:" + TRACE_UI.radiusXs,
      "border:1px solid " + theme.border,
      "background:" + theme.bg,
      "color:" + theme.fg,
      "box-shadow:none",
      "font:" + (isCompactOverlayLayout() ? "800 10px/1 " : "700 11px/1 ") + TRACE_UI.font,
      "letter-spacing:0",
      "cursor:pointer",
      "vertical-align:middle",
    ].join(";");
    var label = document.createElement("span");
    label.textContent = lensHeadline(entry);
    label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    btn.appendChild(label);
    if (entry && entry.workMark && entry.workMark.challenge) {
      var review = document.createElement("span");
      review.textContent = challengeLabel(entry.workMark.challenge);
      review.style.cssText = "flex:0 0 auto;border-left:1px solid " + theme.border + ";padding-left:7px;font:800 10px/1 " + TRACE_UI.font;
      btn.appendChild(review);
    }
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
      renderListingActionSurface(btn, entry, workKey, showActions, rerender);
    });
    return btn;
  }

  function resetPreferenceBtn(btn, hidden) {
    btn.style.cssText = preferenceButtonStyle(btn, hidden ? HIDDEN_THEME : HIDE_ACTION_THEME);
    btn.textContent = hidden ? "UNDO" : "HIDE";
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
        window.open(traceOpenUrl(), "_blank", "noopener,noreferrer");
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
      btn.textContent = "\u2026";
      btn.disabled = true;

      ext.runtime.sendMessage(
        {
          type: "TRACE_SET_HIDDEN_WORK",
          payload: { key: workKey, hidden: nextHidden },
        },
        function (response) {
          if (ext.runtime.lastError || !response) {
            btn.style.cssText = preferenceButtonStyle(btn, ERROR_THEME) + ";cursor:pointer";
            btn.textContent = "ERROR";
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
            btn.textContent = "WAIT";
          } else {
            btn.style.cssText = preferenceButtonStyle(btn, ERROR_THEME) + ";cursor:pointer";
            btn.textContent = "ERROR";
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
    btn.textContent = expired ? "SIGN IN" : "CONNECT";
    btn.title = expired ? "Open Trace to sign in again" : "Open Trace to connect the extension";
    btn.setAttribute("data-trace-connect-action", "1");
    btn.setAttribute("data-trace-connect-error", error || "not_authenticated");
    btn.removeAttribute("data-trace-connect-checking");
    btn.disabled = false;
  }

  function setPreferenceCheckingAction(btn) {
    btn.style.cssText = preferenceButtonStyle(btn, ADDING_THEME) + ";cursor:wait";
    btn.textContent = "CHECKING";
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
      "gap:6px",
      "box-sizing:border-box",
      "max-width:100%",
      "min-height:24px",
      "padding:3px 8px",
      "border-radius:" + TRACE_UI.radiusXs,
      "border:1px solid rgba(91,81,66,0.16)",
      "background:rgba(91,81,66,0.055)",
      "color:#5b5142",
      "font:700 11px/1 " + TRACE_UI.font,
      "letter-spacing:0",
      "white-space:nowrap",
    ].join(";");
    var label = document.createElement("span");
    label.textContent = "Hidden by Trace";
    box.appendChild(label);
    if (!showActions) return box;

    var undo = document.createElement("button");
    undo.type = "button";
    undo.setAttribute("data-trace-hidden-action", "undo");
    undo.textContent = "Undo";
    undo.style.cssText = [
      "border:0",
      "border-left:1px solid rgba(91,81,66,0.18)",
      "background:transparent",
      "color:#2d4b43",
      "padding:0 0 0 7px",
      "font:800 11px/1 " + TRACE_UI.font,
      "cursor:pointer",
    ].join(";");
    undo.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      undo.disabled = true;
      undo.textContent = "\u2026";
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
    wrap.style.opacity = "";

    if (entry && entry.hidden) {
      if (row && wrap.isConnected && wrap.parentElement !== row) {
        row.appendChild(wrap);
      }
      wrap.appendChild(
        hiddenPlaceholderEl(workKey, entry, showActions, function () {
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
        lensEl(entry, workKey, showActions, function () {
          renderOverlayState(wrap, entry, platform, anchor, workKey, showActions);
        }),
      );
      return true;
    }

    if (showActions) {
      wrap.appendChild(quickAddBtnEl(platform, anchor, workKey));
      var hiddenEntry = entry || { status: null, readerStatus: null, hidden: false };
      wrap.appendChild(
        preferenceBtnEl(workKey, false, function (nextHidden) {
          hiddenEntry.hidden = nextHidden;
          renderOverlayState(wrap, hiddenEntry, platform, anchor, workKey, showActions);
        }),
      );
      return true;
    }

    return false;
  }

  function quickAddBtnEl(platform, anchor, workKey) {
    var btn = document.createElement("button");
    btn.setAttribute(ATTR, "1");
    btn.setAttribute("data-trace-quick-add", workKey);
    btn.type = "button";
    btn.textContent = "+ ADD";
    btn.title = "Add to your Trace library";
    btn.style.cssText = actionChipStyle(ADD_THEME) + ";cursor:pointer";

    btn.addEventListener("mouseenter", function () {
      if (!btn.disabled) {
        btn.style.background = ADD_THEME.hoverBg;
        btn.style.boxShadow = "none";
      }
    });
    btn.addEventListener("mouseleave", function () {
      if (!btn.disabled) {
        btn.style.background = ADD_THEME.bg;
        btn.style.boxShadow = "0 1px 2px rgba(28,28,23,0.08)";
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

      btn.style.cssText = actionChipStyle(ADDING_THEME) + ";cursor:wait";
      btn.textContent = "ADDING...";
      btn.disabled = true;

      var payload = { s: item.src, at: new Date().toISOString(), item: item };
      ext.runtime.sendMessage(
        { type: "TRACE_QUICK_ADD", payload: payload },
        function (response) {
          if (ext.runtime.lastError || !response) {
            btn.style.cssText = actionChipStyle(ERROR_THEME) + ";cursor:pointer";
            btn.textContent = "ERROR";
            btn.disabled = false;
            setTimeout(function () {
              btn.style.cssText = actionChipStyle(ADD_THEME) + ";cursor:pointer";
              btn.textContent = "+ ADD";
            }, 2500);
            return;
          }
          if (response.ok) {
            btn.style.cssText = actionChipStyle(ADDED_THEME);
            btn.textContent = "PLANNING";
            btn.title = "In your Trace library";
            btn.disabled = true;
          } else if (response.error === "free_limit_reached") {
            btn.style.cssText = actionChipStyle(FULL_THEME);
            btn.textContent = "FULL";
            btn.title = "Free library limit reached \u2014 upgrade for unlimited";
            btn.disabled = true;
          } else if (response.error === "not_authenticated" || response.error === "auth_expired") {
            setQuickAddAuthAction(btn, response.error);
          } else {
            btn.style.cssText = actionChipStyle(ERROR_THEME) + ";cursor:pointer";
            btn.textContent = "ERROR";
            btn.disabled = false;
            setTimeout(function () {
              btn.style.cssText = actionChipStyle(ADD_THEME) + ";cursor:pointer";
              btn.textContent = "+ ADD";
            }, 2500);
          }
        },
      );
    });

    return btn;
  }

  function setQuickAddAuthAction(btn, error) {
    var expired = error === "auth_expired";
    btn.style.cssText = actionChipStyle(ERROR_THEME) + ";cursor:pointer";
    btn.textContent = expired ? "Sign in" : "Connect";
    btn.title = expired ? "Open Trace to sign in again" : "Open Trace to connect the extension";
    btn.setAttribute("data-trace-connect-action", "1");
    btn.setAttribute("data-trace-connect-error", error || "not_authenticated");
    btn.removeAttribute("data-trace-connect-checking");
    btn.disabled = false;
  }

  function setQuickAddCheckingAction(btn) {
    btn.style.cssText = actionChipStyle(ADDING_THEME) + ";cursor:wait";
    btn.textContent = "Checking";
    btn.title = "Checking Trace connection";
    btn.setAttribute("data-trace-connect-checking", "1");
    btn.disabled = true;
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
        "gap:6px",
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

  function run() {
    try {
      ext.storage.local.get(
        [
          "libraryOverlayCache",
          "prefLibraryInlayEnabled",
          "authToken",
          "traceAuthState",
        ],
        function (res) {
          if (ext.runtime.lastError) return;
          var hasAuth = !!res.authToken;
          currentTraceAuthState = (res && res.traceAuthState) || null;
          renderConnectNotice(res && res.traceAuthState, hasAuth);
          if (res && res.prefLibraryInlayEnabled === false) {
            clearBadges();
            return;
          }
          if (isSingleWorkPage()) {
            clearBadges();
            return;
          }
          var cache = res && res.libraryOverlayCache;
          var entries = (cache && cache.entries) || {};
          var workPreferences = (cache && cache.workPreferences) || {};
          var showQuickAdd = authStateAllowsActions(res && res.traceAuthState, hasAuth) && !isSingleWorkPage();
          clearBadges();
          if (
            Object.keys(entries).length === 0 &&
            Object.keys(workPreferences).length === 0 &&
            !showQuickAdd
          ) {
            return;
          }
          decorate(entries, workPreferences, showQuickAdd);
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
          !changes.authToken
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
