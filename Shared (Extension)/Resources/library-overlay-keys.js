// library-overlay-keys.js
// Keep in sync with @trace/shared `externalStoryKeyFromUrl` (Trace monorepo).
(function (g) {
  "use strict";

  function normalizeStoryUrl(raw) {
    try {
      const u = new URL(raw.trim());
      u.hash = "";
      u.search = "";
      if (u.pathname.endsWith("/") && u.pathname !== "/") {
        u.pathname = u.pathname.replace(/\/+$/, "");
      }
      u.hostname = u.hostname.toLowerCase();
      return u.toString();
    } catch {
      return raw.trim();
    }
  }

  function parseAo3Path(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/works\/(\d+)/);
      if (!m) return null;
      return { workId: m[1] };
    } catch {
      return null;
    }
  }

  function parseFFN(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.toLowerCase();
      if (!/^(?:www\.|m\.)?fanfiction\.net$/.test(h)) return null;
      const m = u.pathname.match(/\/s\/(\d+)/);
      if (!m) return null;
      return { workId: m[1] };
    } catch {
      return null;
    }
  }

  function externalStoryKeyFromUrl(raw) {
    const normUrl = normalizeStoryUrl(raw);
    const ao3 = parseAo3Path(normUrl);
    if (ao3) {
      return { platform: "ao3", workId: ao3.workId, key: "ao3:" + ao3.workId };
    }
    const ffn = parseFFN(normUrl);
    if (ffn) {
      return { platform: "ffn", workId: ffn.workId, key: "ffn:" + ffn.workId };
    }
    return null;
  }

  g.traceExternalStoryKeyFromUrl = externalStoryKeyFromUrl;
})(typeof globalThis !== "undefined" ? globalThis : self);
