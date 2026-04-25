// collector.js — AO3/FFN page metadata extractor.
// Reads story/listing metadata from the DOM the user is viewing; it does not fetch page HTML.
// Sends metadata/progress to background.js via extension messages for import, quick-add, and auto-track.
// Does not read cookies or credentials, and disables collection on pages with password fields.
const ext = globalThis.browser ?? globalThis.chrome;

function tracePageHasPasswordField(root) {
  try {
    const inputs = (root || document).querySelectorAll("input");
    for (const input of inputs) {
      if (String(input && input.type ? input.type : "").toLowerCase() === "password") {
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

function txt(el) {
  return el ? (el.textContent || "").trim() : null;
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
  const match =
    normalized.match(/\bchapter\s+(\d+)\b/i) ||
    normalized.match(/^(\d+)\s*[.: -]/);
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

function detectAo3CurrentChapterNumber() {
  const path = location.pathname || "";
  if (!/\/chapters\/\d+/.test(path)) return 1;
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
var AUTO_TRACK_READY_RETRY_MS = 150;
var AUTO_TRACK_READY_MAX_ATTEMPTS = 12;
var OVERLAY_CACHE_KEY = "libraryOverlayCache";
var optimisticStoryPageEntries = Object.create(null);

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

function normalizeOverlayEntry(entry) {
  if (!entry) return {};
  if (typeof entry === "string") return { status: entry };
  return Object.assign({}, entry);
}

function autoTrackFingerprint(item) {
  return JSON.stringify({
    src: item && item.src ? item.src : null,
    url: item && item.u ? item.u : null,
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

function sendAutoTrackForStory(validStory) {
  rememberRecentAutoTrack(validStory);
  ext.runtime.sendMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: validStory.src,
        at: new Date().toISOString(),
        item: validStory,
      },
    },
    function (response) {
      if (ext.runtime.lastError) {
        forgetRecentAutoTrack(validStory);
        return;
      }
      if (!response || response.ok !== true) {
        // ignored_sender means the background never attempted a write
        // (subframe / prerender). Re-sending on the next dwell tick would
        // hit the same check, so keep the dedupe marker to avoid churn.
        if (!response || response.error !== "ignored_sender") {
          forgetRecentAutoTrack(validStory);
        }
        return;
      }
      applyConfirmedOverlayUpdateForStory(validStory);
    },
  );
}

function applyConfirmedOverlayUpdateForStory(item) {
  var workKey = overlayWorkKeyFromItem(item);
  if (!workKey) return;

  ext.storage.local.get(["authToken", OVERLAY_CACHE_KEY], function (res) {
    if (ext.runtime.lastError || !res || !res.authToken) return;

    var cache = res[OVERLAY_CACHE_KEY] || {};
    var entries = Object.assign({}, cache.entries || {});
    var existing = normalizeOverlayEntry(entries[workKey]);
    var existingCurrent =
      existing.chapters && typeof existing.chapters.current === "number"
        ? existing.chapters.current
        : null;
    var currentChapter =
      typeof item.chn === "number" && Number.isFinite(item.chn)
        ? existingCurrent != null
          ? Math.max(existingCurrent, item.chn)
          : item.chn
        : existingCurrent != null
          ? existingCurrent
          : null;
    var totalChapters =
      typeof item.cht === "number" && Number.isFinite(item.cht)
        ? item.cht
        : existing.chapters && typeof existing.chapters.total === "number"
          ? existing.chapters.total
          : null;

    // Match server extension auto-track: only PLANNING → READING; keep PAUSED etc.
    var prevStatus =
      typeof existing.status === "string" ? existing.status : null;
    var nextStatus =
      prevStatus === "PLANNING" ? "READING" : prevStatus || "READING";

    var next = Object.assign({}, existing, {
      status: nextStatus,
    });
    if (typeof currentChapter === "number" && Number.isFinite(currentChapter)) {
      next.chapters = {
        current: currentChapter,
        total: totalChapters == null ? null : totalChapters,
      };
    }
    optimisticStoryPageEntries[workKey] = next;

    entries[workKey] = next;
    ext.storage.local.set({
      [OVERLAY_CACHE_KEY]: Object.assign({}, cache, { entries: entries }),
    }, function () {
      if (ext.runtime.lastError) return;
      if (getWorkKeyFromUrl() === workKey) {
        var btn = document.querySelector("[" + QUICK_ADD_ATTR + "]");
        if (btn) {
          applyQuickAddLibraryState(btn, next);
        } else {
          renderQuickAddButton(workKey);
        }
      }
    });
  });
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
  if (!row || !authorLink) return null;
  let out = "";
  let n = authorLink.nextSibling;
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

  const fandom = extractFFNFandomMobile() || extractFFNFandom() || null;
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
  const chn = detectAo3CurrentChapterNumber();
  const chPub =
    typeof chp.n === "number" && Number.isFinite(chp.n) ? chp.n : null;

  const status = (() => {
    const req = one(document, ".required-tags");
    const t = req ? req.textContent || "" : "";
    if (/Complete Work/i.test(t)) return "complete";
    if (/Work in Progress/i.test(t)) return "wip";
    if (typeof chp.t === "number" && chp.n === chp.t) return "complete";
    if (chRaw) return "wip";
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
    const s = txt(d);
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
    txt(one(document, "#profile_top div.xcontrast_txt")) ||
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
    const n = node.cloneNode(true);
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

function quickAddStatusLabel(status) {
  var labels = { READING: "Reading", COMPLETED: "Completed", PAUSED: "Paused", DROPPED: "Dropped", PLANNING: "Plan to Read" };
  return labels[status] || status;
}

function quickAddStatusDisplay(info) {
  var status = info && typeof info.status === "string" ? info.status : null;
  var label = quickAddStatusLabel(status);
  if (!label) label = "In Library";
  if (
    status !== "PLANNING" &&
    info.chapters &&
    typeof info.chapters.current === "number"
  ) {
    var total = info.chapters.total;
    label += " \u00b7 " + info.chapters.current + "/" + (total == null ? "?" : total);
  }
  return String(label).toUpperCase();
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
  if (shouldDisableTraceContentScript()) {
    if (
      msg?.type === "TRACE_COLLECT" ||
      msg?.type === "TRACE_SCHEDULE_AUTO_TRACK"
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
    return collectAO3Work();
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
    ext.runtime.sendMessage({
      type: "TRACE_METADATA_BROADCAST",
      payload: {
        s: validStory.src,
        at: new Date().toISOString(),
        item: validStory,
      },
    });
  }
  ext.storage.local.get(
    ["prefAutoTrackEnabled"],
    (prefRes) => {
      if (ext.runtime.lastError) {
        if (shouldSkipRecentAutoTrack(validStory)) {
          return;
        }
        sendAutoTrackForStory(validStory);
        return;
      }
      if (prefRes.prefAutoTrackEnabled === false) {
        return;
      }
      if (shouldSkipRecentAutoTrack(validStory)) {
        return;
      }
      sendAutoTrackForStory(validStory);
    },
  );
}

function scheduleAutoTrackForCurrentPage(attempt) {
  if (shouldDisableTraceContentScript()) return;
  queueAutoTrackWhenVisible(attempt);
}

if (!shouldDisableTraceContentScript()) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      scheduleAutoTrackForCurrentPage();
    });
  } else {
    scheduleAutoTrackForCurrentPage();
  }

  window.addEventListener("pageshow", function () {
    scheduleAutoTrackForCurrentPage();
  });
}

// =======================================================
// INLINE QUICK-ADD BUTTON (single story pages)
// =======================================================

var QUICK_ADD_ATTR = "data-trace-quick-add";
var QUICK_ADD_WRAP_ATTR = "data-trace-quick-add-wrap";

// Trace chip styles — matches library-overlay.js badge design
var TRACE_FONT = "700 10px/1 Manrope,system-ui,-apple-system,'Segoe UI',sans-serif";
var TRACE_CHIP_BASE = [
  "display:inline-flex",
  "align-items:center",
  "justify-content:center",
  "box-sizing:border-box",
  "padding:5px 12px",
  "min-height:24px",
  "border-radius:8px",
  "font:" + TRACE_FONT,
  "letter-spacing:0.06em",
  "text-transform:uppercase",
  "white-space:nowrap",
].join(";");

var TRACE_THEMES = {
  add:     { bg: "transparent", fg: "#64748b", border: "rgba(100,116,139,0.35)", hover: "#f1f5f9" },
  adding:  { bg: "#f1f5f9",     fg: "#94a3b8", border: "rgba(148,163,184,0.3)" },
  status:  { bg: "#fddc8e",     fg: "#594402", border: "rgba(89,68,2,0.2)" },
  added:   { bg: "#2d4b43",     fg: "#c8eadf", border: "rgba(22,52,45,0.35)" },
  error:   { bg: "#fef2f2",     fg: "#dc2626", border: "rgba(220,38,38,0.25)" },
  full:    { bg: "#fffbeb",     fg: "#b45309", border: "rgba(180,83,9,0.25)" },
};

// Status themes reuse library-overlay badge palette
var TRACE_STATUS_THEMES = {
  READING:   { bg: "#fddc8e", fg: "#594402", border: "rgba(89,68,2,0.2)" },
  PLANNING:  { bg: "#ebe8df", fg: "#414846", border: "rgba(65,72,70,0.16)" },
  PAUSED:    { bg: "#7c2d12", fg: "#ffffff", border: "rgba(124,45,18,0.5)" },
  COMPLETED: { bg: "#2d4b43", fg: "#c8eadf", border: "rgba(22,52,45,0.35)" },
  DROPPED:   { bg: "#efe4e4", fg: "#ba1a1a", border: "rgba(186,26,26,0.22)" },
};

function traceChipCss(theme) {
  return TRACE_CHIP_BASE + ";background:" + theme.bg + ";color:" + theme.fg + ";border:1px solid " + theme.border;
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
      if (mobileHeader) {
        return (
          one(mobileHeader, "a[href*='/u/']") ||
          one(mobileHeader, "b") ||
          mobileHeader
        );
      }
      return (
        one(document, "#content a[href*='/u/']") ||
        one(document, "#content b")
      );
    }
    var authorLink = one(document, '#profile_top a[href*="/u/"]');
    return authorLink || one(document, "#profile_top b");
  }
  return null;
}

function ensureQuickAddElements(workKey, anchor) {
  var wrap = document.querySelector("[" + QUICK_ADD_WRAP_ATTR + "]");
  var btn = document.querySelector("[" + QUICK_ADD_ATTR + "]");

  if (!wrap) {
    wrap = document.createElement("div");
    wrap.setAttribute(QUICK_ADD_WRAP_ATTR, workKey);
    wrap.style.cssText = "margin:8px 0 6px 0;";
  }

  if (!btn) {
    btn = document.createElement("button");
    btn.setAttribute(QUICK_ADD_ATTR, workKey);
    btn.type = "button";
    wrap.appendChild(btn);
  } else if (btn.parentElement !== wrap) {
    wrap.appendChild(btn);
  }

  if (!wrap.isConnected) {
    try {
      anchor.insertAdjacentElement("afterend", wrap);
    } catch (_) {
      if (anchor.parentNode) anchor.parentNode.appendChild(wrap);
    }
  }

  return { wrap: wrap, btn: btn };
}

function removeQuickAddElements() {
  var wrap = document.querySelector("[" + QUICK_ADD_WRAP_ATTR + "]");
  if (wrap) {
    wrap.remove();
  }
}

function applyQuickAddLibraryState(btn, info) {
  var statusTheme = TRACE_STATUS_THEMES[info.status] || TRACE_STATUS_THEMES.READING;
  btn.style.cssText = traceChipCss(statusTheme);
  btn.textContent = quickAddStatusDisplay(info);
  btn.title = "This story is in your Trace library";
  btn.disabled = true;
}

function applyQuickAddActionState(btn, addTheme) {
  btn.style.cssText = traceChipCss(addTheme) + ";cursor:pointer";
  btn.textContent = "+ ADD TO TRACE";
  btn.title = "Add this story to your Trace library";
  btn.disabled = false;
}

function renderQuickAddButton(workKey) {
  var anchor = findQuickAddAnchor();
  if (!anchor) {
    removeQuickAddElements();
    return;
  }

  ext.storage.local.get([OVERLAY_CACHE_KEY, "authToken"], function (res) {
    if (ext.runtime.lastError) return;
    if (!res.authToken) {
      removeQuickAddElements();
      return;
    }

    var cache = res[OVERLAY_CACHE_KEY];
    var entries = cache && cache.entries;
    var entry = entries && entries[workKey];
    var optimisticEntry = optimisticStoryPageEntries[workKey];
    var els = ensureQuickAddElements(workKey, anchor);
    var btn = els.btn;

    if (entry || optimisticEntry) {
      var info = typeof entry === "string" ? { status: entry } : entry;
      if (!info && optimisticEntry) {
        info = optimisticEntry;
      } else if (
        info &&
        optimisticEntry &&
        optimisticEntry.chapters &&
        typeof optimisticEntry.chapters.current === "number"
      ) {
        var infoCurrent =
          info.chapters && typeof info.chapters.current === "number"
            ? info.chapters.current
            : null;
        if (infoCurrent == null || optimisticEntry.chapters.current > infoCurrent) {
          info = optimisticEntry;
        }
      }
      applyQuickAddLibraryState(btn, info);
    } else {
      var addTheme = TRACE_THEMES.add;
      applyQuickAddActionState(btn, addTheme);

      if (!btn.__traceQuickAddBound) {
        btn.__traceQuickAddBound = true;

        btn.addEventListener("mouseenter", function () {
          if (!btn.disabled) btn.style.background = addTheme.hover;
        });
        btn.addEventListener("mouseleave", function () {
          if (!btn.disabled) btn.style.background = addTheme.bg;
        });

        btn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();

          var collected = collect();
          if (!collected.items.length) return;

          var payload = {
            s: collected.source,
            at: new Date().toISOString(),
            item: collected.items[0],
          };

          btn.style.cssText = traceChipCss(TRACE_THEMES.adding) + ";cursor:wait";
          btn.textContent = "\u2026";
          btn.disabled = true;

          ext.runtime.sendMessage(
            { type: "TRACE_QUICK_ADD", payload: payload },
            function (response) {
              if (ext.runtime.lastError || !response) {
                btn.style.cssText = traceChipCss(TRACE_THEMES.error) + ";cursor:pointer";
                btn.textContent = "ERROR";
                btn.disabled = false;
                setTimeout(function () {
                  applyQuickAddActionState(btn, addTheme);
                }, 2500);
                return;
              }

              if (response.ok) {
                btn.style.cssText = traceChipCss(TRACE_THEMES.added);
                btn.textContent = "ADDED \u2713";
                btn.disabled = true;
                setTimeout(function () {
                  applyQuickAddLibraryState(btn, { status: "READING" });
                }, 1500);
              } else if (response.error === "free_limit_reached") {
                btn.style.cssText = traceChipCss(TRACE_THEMES.full);
                btn.textContent = "LIBRARY FULL";
                btn.title = "Free library limit reached \u2014 upgrade for unlimited";
                btn.disabled = true;
              } else if (response.error === "auth_expired") {
                btn.style.cssText = traceChipCss(TRACE_THEMES.error);
                btn.textContent = "SESSION EXPIRED";
                btn.disabled = true;
              } else {
                btn.style.cssText = traceChipCss(TRACE_THEMES.error) + ";cursor:pointer";
                btn.textContent = "ERROR";
                btn.disabled = false;
                setTimeout(function () {
                  applyQuickAddActionState(btn, addTheme);
                }, 2500);
              }
            },
          );
        });
      }
    }
  });
}

function initQuickAdd() {
  if (shouldDisableTraceContentScript()) return;
  var workKey = getWorkKeyFromUrl();
  if (!workKey) return;
  renderQuickAddButton(workKey);

  try {
    ext.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (!changes[OVERLAY_CACHE_KEY]) return;
      renderQuickAddButton(workKey);
    });
  } catch (_) {
    /* ignore */
  }
}

if (!shouldDisableTraceContentScript()) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initQuickAdd);
  } else {
    initQuickAdd();
  }
}
