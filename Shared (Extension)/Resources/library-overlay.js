// library-overlay.js — Trace library status chips on AO3/FFN listings.
// Reads story links from the current page and cached library status from extension storage.
// Sends quick-add metadata to background.js only when the user clicks an inline add button.
// Does not read cookies or credentials, and exits on pages with password fields.
(function () {
  "use strict";
  const ext = globalThis.browser ?? globalThis.chrome;
  const ATTR = "data-trace-library-overlay";
  const WRAP_ATTR = "data-trace-library-overlay-wrap";
  const CONNECT_NOTICE_ATTR = "data-trace-connect-notice";
  const CONNECT_NOTICE_DISMISS_KEY = "trace:connect-notice:dismissed";

  function tracePageHasPasswordField() {
    try {
      var inputs = document.querySelectorAll("input");
      for (var i = 0; i < inputs.length; i++) {
        if (String(inputs[i] && inputs[i].type ? inputs[i].type : "").toLowerCase() === "password") {
          return true;
        }
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  if (tracePageHasPasswordField()) return;

  /** Match Trace library story-card status chips (archive palette, library-app.css). */
  const STATUS_THEME = {
    READING: {
      bg: "#fddc8e",
      fg: "#594402",
      border: "rgba(89, 68, 2, 0.2)",
    },
    PLANNING: {
      bg: "#ebe8df",
      fg: "#414846",
      border: "rgba(65, 72, 70, 0.16)",
    },
    PAUSED: {
      bg: "#7c2d12",
      fg: "#ffffff",
      border: "rgba(124, 45, 18, 0.5)",
    },
    COMPLETED: {
      bg: "#2d4b43",
      fg: "#c8eadf",
      border: "rgba(22, 52, 45, 0.35)",
    },
    DROPPED: {
      bg: "#efe4e4",
      fg: "#ba1a1a",
      border: "rgba(186, 26, 26, 0.22)",
    },
  };

  const UPDATED_THEME = {
    bg: "#e8f4fc",
    fg: "#0b4f6c",
    border: "rgba(11, 79, 108, 0.25)",
  };

  const LABEL = {
    PLANNING: "Planning",
    READING: "Reading",
    PAUSED: "Paused",
    COMPLETED: "Completed",
    DROPPED: "Dropped",
  };

  var ADD_THEME = {
    bg: "#f5ead0",
    fg: "#5f4708",
    border: "rgba(115, 91, 26, 0.34)",
    hoverBg: "#efdfb3",
  };
  var ADDING_THEME = {
    bg: "#f1f5f9",
    fg: "#94a3b8",
    border: "rgba(148, 163, 184, 0.3)",
  };
  var ADDED_THEME = {
    bg: "#2d4b43",
    fg: "#c8eadf",
    border: "rgba(22, 52, 45, 0.35)",
  };
  var ERROR_THEME = {
    bg: "#fef2f2",
    fg: "#dc2626",
    border: "rgba(220, 38, 38, 0.25)",
  };
  var FULL_THEME = {
    bg: "#fffbeb",
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
    "border-radius:8px",
    "vertical-align:middle",
    "font:700 9px/1 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif",
    "letter-spacing:0.06em",
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
        ? ";padding:4px 8px;min-height:20px;font:800 9px/1 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif"
        : ";padding:5px 10px;min-height:22px;font:800 10px/1 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif") +
      ";letter-spacing:0.04em" +
      ";box-shadow:0 1px 2px rgba(28,28,23,0.08)" +
      ";transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease,transform 120ms ease"
    );
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
    var helpUrl = (authState && authState.helpUrl) || "https://tracefiction.com/apps";
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

  /**
   * API v2: { status, chapters? }; legacy cache: plain status string.
   */
  function normalizeOverlayEntry(raw) {
    if (raw == null) return null;
    if (typeof raw === "string") {
      return { status: raw, chapters: undefined };
    }
    if (typeof raw === "object" && raw.status) {
      var ch = raw.chapters;
      var chapters;
      if (
        ch &&
        typeof ch === "object" &&
        typeof ch.current === "number" &&
        Number.isFinite(ch.current)
      ) {
        chapters = {
          current: ch.current,
          total:
            ch.total === null || ch.total === undefined
              ? null
              : Number(ch.total),
        };
        if (chapters.total !== null && !Number.isFinite(chapters.total)) {
          chapters.total = null;
        }
      }
      return { status: raw.status, chapters: chapters };
    }
    return null;
  }

  function chapterSuffix(status, chapters) {
    if (status === "PLANNING") return "";
    if (!chapters || typeof chapters.current !== "number") return "";
    var t = chapters.total;
    var frac = t == null ? chapters.current + "/?" : chapters.current + "/" + t;
    return " \u00b7 " + frac;
  }

  function progressClause(status, chapters) {
    if (status === "PLANNING") return "";
    if (!chapters || typeof chapters.current !== "number") return "";
    if (chapters.total == null) {
      return ", chapter " + chapters.current + " (total not set in Trace)";
    }
    return ", chapter " + chapters.current + " of " + chapters.total;
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

  function badgeEl(status, chapters) {
    const theme = STATUS_THEME[status] || STATUS_THEME.PLANNING;
    const label = LABEL[status] || status;
    const suffix = chapterSuffix(status, chapters);
    const display = (label + suffix).toUpperCase();
    const span = document.createElement("span");
    span.setAttribute(ATTR, "1");
    var titleBase = "In your Trace library: " + label + progressClause(status, chapters);
    span.setAttribute("title", titleBase);
    span.setAttribute(
      "aria-label",
      "Trace library: " + label + progressClause(status, chapters),
    );
    span.textContent = display;
    span.style.cssText = chipStyle(theme) + ";box-shadow:0 1px 2px rgba(28,28,23,0.06)";
    return span;
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
        btn.style.boxShadow = "0 2px 5px rgba(95, 71, 8, 0.16)";
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

      var item = scrapeListingItem(platform, anchor);
      if (!item) return;

      btn.style.cssText = actionChipStyle(ADDING_THEME) + ";cursor:wait";
      btn.textContent = "\u2026";
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
            btn.style.cssText = actionChipStyle(ERROR_THEME);
            btn.textContent = "SIGN IN";
            btn.disabled = true;
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

  function clearBadges() {
    try {
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

  function decorate(entries, showQuickAdd) {
    const anchors = document.querySelectorAll('a[href*="/works/"], a[href*="/s/"]');
    const decoratedKeys = new Set();
    const compactLayout = isCompactOverlayLayout();
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
      decoratedKeys.add(info.key);

      const entry = normalizeOverlayEntry(entries[info.key]);

      const wrap = document.createElement("span");
      wrap.setAttribute(WRAP_ATTR, "1");
      const useStackedAo3Layout = compactLayout && info.platform === "ao3";
      wrap.style.cssText = [
        useStackedAo3Layout ? "display:flex" : "display:inline-flex",
        "align-items:center",
        "justify-content:flex-start",
        "flex-wrap:wrap",
        "gap:4px",
        useStackedAo3Layout ? "margin:6px 0 0 0" : "margin-left:8px",
        "vertical-align:middle",
        useStackedAo3Layout ? "max-width:100%" : "max-width:calc(100% - 8px)",
      ].join(";");

      if (entry && entry.status) {
        wrap.appendChild(badgeEl(entry.status, entry.chapters));
        var delta = siteChaptersAheadDelta(info.platform, a, entry);
        var hint = siteAheadHintEl(delta);
        if (hint) wrap.appendChild(hint);
      } else if (showQuickAdd) {
        wrap.appendChild(quickAddBtnEl(info.platform, a, info.key));
      } else {
        continue;
      }

      a.setAttribute(ATTR, info.key);
      try {
        const target = useStackedAo3Layout
          ? compactAo3HeadingTarget(a)
          : a;
        target.insertAdjacentElement("afterend", wrap);
      } catch {
        a.appendChild(wrap);
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
          var showQuickAdd = hasAuth && !isSingleWorkPage();
          clearBadges();
          if (Object.keys(entries).length === 0 && !showQuickAdd) return;
          decorate(entries, showQuickAdd);
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
