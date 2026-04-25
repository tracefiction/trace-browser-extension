const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const FIXTURES = path.join(__dirname, "fixtures");

/** Mirrors overlay: published count from AO3 blurb row. */
function ao3PublishedChaptersNearAnchor(anchor) {
  const row = anchor.closest(
    'li.work.blurb, li.work[id^="work_"], .work.blurb',
  );
  if (!row) return null;
  const stats =
    row.querySelector("dd.stats dl.stats") || row.querySelector("dl.stats");
  const dd = stats && stats.querySelector("dd.chapters");
  if (!dd) return null;
  const raw = (dd.textContent || "").replace(/\s+/g, " ").trim();
  const m = raw.match(/(\d+)\s*\/\s*(\d+|\?)/);
  if (m) {
    const pub = parseInt(m[1], 10);
    return Number.isFinite(pub) ? pub : null;
  }
  const lone = raw.match(/^(\d+)/);
  if (lone) {
    const n = parseInt(lone[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function siteChaptersAheadDelta(platform, anchor, entry) {
  if (!entry || !entry.chapters) return null;
  const pub =
    platform === "ao3" ? ao3PublishedChaptersNearAnchor(anchor) : null;
  if (pub == null) return null;
  const cur = entry.chapters.current;
  const tot = entry.chapters.total;
  const cap = Math.max(
    typeof cur === "number" && Number.isFinite(cur) ? cur : 0,
    typeof tot === "number" && Number.isFinite(tot) ? tot : 0,
  );
  if (!(pub > cap)) return null;
  return pub - cap;
}

test("AO3 fixture: 49/60 row parses published 49 (Heir Apparent style)", () => {
  const html = fs.readFileSync(
    path.join(FIXTURES, "ao3_listing.html"),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/tags/Harry%20Potter/works",
    contentType: "text/html",
  });
  const a = dom.window.document.querySelector(
    'a[href="https://archiveofourown.org/works/26453452"]',
  );
  assert.ok(a);
  assert.equal(ao3PublishedChaptersNearAnchor(a), 49);
});

test("site hint: no badge when Trace cap already matches published", () => {
  const html = fs.readFileSync(
    path.join(FIXTURES, "ao3_listing.html"),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/tags/Harry%20Potter/works",
    contentType: "text/html",
  });
  const a = dom.window.document.querySelector(
    'a[href="https://archiveofourown.org/works/10404927"]',
  );
  assert.ok(a);
  assert.equal(ao3PublishedChaptersNearAnchor(a), 51);
  const delta = siteChaptersAheadDelta("ao3", a, {
    status: "READING",
    chapters: { current: 51, total: 52 },
  });
  assert.equal(delta, null);
});

test("site hint: +1 when site published ahead of Trace max(current,total)", () => {
  const html = fs.readFileSync(
    path.join(FIXTURES, "ao3_listing.html"),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/tags/Harry%20Potter/works",
    contentType: "text/html",
  });
  const a = dom.window.document.querySelector(
    'a[href="https://archiveofourown.org/works/10404927"]',
  );
  assert.ok(a);
  const delta = siteChaptersAheadDelta("ao3", a, {
    status: "READING",
    chapters: { current: 50, total: 50 },
  });
  assert.equal(delta, 1);
});

test("COMPLETED 60/60 vs site 49/60: no false Updated badge (pub not ahead of cap)", () => {
  const html = fs.readFileSync(
    path.join(FIXTURES, "ao3_listing.html"),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/tags/Harry%20Potter/works",
    contentType: "text/html",
  });
  const a = dom.window.document.querySelector(
    'a[href="https://archiveofourown.org/works/26453452"]',
  );
  assert.ok(a);
  const delta = siteChaptersAheadDelta("ao3", a, {
    status: "COMPLETED",
    chapters: { current: 60, total: 60 },
  });
  assert.equal(delta, null);
});
