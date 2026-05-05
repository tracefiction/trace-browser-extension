const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const KEYS_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "library-overlay-keys.js",
);
const OVERLAY_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "library-overlay.js",
);
const FIXTURES = path.join(__dirname, "fixtures");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function precedes(left, right) {
  if (!left || !right) return false;
  return Boolean(
    left.compareDocumentPosition(right) &
      left.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

async function renderOverlayListing({
  html,
  url = "https://archiveofourown.org/works?tag_id=Harry+Potter",
  cache = { entries: {} },
  authToken = "test-token",
  authState,
  sendMessage,
  mobile = false,
}) {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    contentType: "text/html",
  });

  const { window } = dom;
  const storageChangeListeners = [];
  const storageState = {
    authToken,
    prefLibraryInlayEnabled: true,
    traceAuthState: authState || (authToken ? { state: "connected" } : { state: "signed_out" }),
    libraryOverlayCache: cache,
  };
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb(Object.assign({}, storageState));
        },
      },
      onChanged: {
        addListener(fn) {
          storageChangeListeners.push(fn);
        },
      },
    },
    runtime: {
      lastError: null,
      sendMessage:
        sendMessage ||
        ((_msg, cb) => {
          if (typeof cb === "function") cb({ ok: true });
        }),
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.__traceSetStorage = function (next) {
    const changes = {};
    for (const [key, value] of Object.entries(next || {})) {
      changes[key] = {
        oldValue: storageState[key],
        newValue: value,
      };
      storageState[key] = value;
    }
    storageChangeListeners.forEach((fn) => fn(changes, "local"));
  };
  window.__traceMutateStorage = function (next) {
    Object.assign(storageState, next || {});
  };
  window.matchMedia = (query) => ({
    matches: mobile && String(query).includes("max-width: 640px"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
  window.eval(keysSrc);
  window.eval(overlaySrc);
  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  await sleep(120);
  return window;
}

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function openTraceLens(window) {
  const lens = window.document.querySelector("[data-trace-library-lens]");
  assert.ok(lens, "expected compact Trace lens");
  lens.click();
  const surface = window.document.querySelector("[data-trace-action-surface]");
  assert.ok(surface, "expected Trace action surface");
  return { lens, surface };
}

test("library-overlay reruns when listing links are inserted after initial render", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://m.fanfiction.net/book/Harry-Potter/",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  assert.equal(
    window.document.querySelectorAll("[data-trace-library-overlay-wrap]").length,
    0,
  );

  const root = window.document.getElementById("root");
  root.innerHTML =
    '<div class="bs brb"><a href="/s/123/1/Test-Story">Test Story</a> by <a href="/u/1/TestAuthor">TestAuthor</a></div>';

  await sleep(180);

  const wraps = window.document.querySelectorAll(
    "[data-trace-library-overlay-wrap]",
  );
  assert.equal(wraps.length, 1);
  assert.match(wraps[0].textContent || "", /\+ ADD/);
});

test("library-overlay renders legacy entry status shape", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/12345'>Demo Work</a></h4></li></ol></body></html>",
    cache: { entries: { "ao3:12345": "READING" }, syncVersion: "v-legacy" },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.match(wrap.textContent || "", /Reading/);
  assert.equal(wrap.querySelector("button[data-trace-quick-add]"), null);
});

test("library-overlay places AO3 listing controls in the action row without touching the date", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li id='work_12345' class='work blurb group'><div class='header module'><h4 class='heading'><a href='/works/12345'>Demo Work</a> by <a rel='author' href='/users/a/pseuds/a'>Author</a></h4><ul class='required-tags'></ul><p class='datetime'>12 Oct 2025</p></div><dl class='stats'><dd class='chapters'>23/?</dd></dl><blockquote class='summary'>Summary</blockquote></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:12345": {
          status: "READING",
          chapters: { current: 17, total: null },
          privateContext: { hasNotes: true, tagCount: 6 },
        },
      },
      syncVersion: "v-placement",
    },
  });

  const row = window.document.querySelector("#work_12345");
  const header = row.querySelector(".header.module");
  const heading = row.querySelector("h4.heading");
  const date = row.querySelector("p.datetime");
  const stats = row.querySelector("dl.stats");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");

  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ao3-action-row");
  assert.equal(date.firstChild.nodeValue.trim(), "12 Oct 2025");
  assert.equal(wrap.parentElement, row);
  assert.equal(header.nextElementSibling, wrap);
  assert.equal(date.contains(wrap), false);
  assert.notEqual(date.nextElementSibling, wrap);
  assert.ok(precedes(wrap, stats));
  assert.match(wrap.getAttribute("style") || "", /width:\s*100%/i);
  assert.match(wrap.getAttribute("style") || "", /justify-content:\s*flex-start/i);
  assert.match(wrap.getAttribute("style") || "", /clear:\s*both/i);
  assert.equal(heading.querySelector("[data-trace-library-overlay-wrap]"), null);
  assert.equal(heading.nextElementSibling && heading.nextElementSibling.matches("[data-trace-library-overlay-wrap]"), false);
  assert.equal(wrap.querySelector("[data-trace-site-ahead]"), null);
  assert.doesNotMatch(wrap.textContent || "", /\+6|Private note|6 saved/i);
});

test("library-overlay decorates real AO3 listing fixture without displacing the date on desktop and mobile", async () => {
  for (const mobile of [false, true]) {
    const window = await renderOverlayListing({
      html: loadFixture("ao3_listing.html"),
      mobile,
      cache: {
        entries: {
          "ao3:10404927": {
            status: "READING",
            readerStatus: "READING",
            entryId: "00000000-0000-4000-8000-000000104927",
            chapters: { current: 17, total: 52 },
            privateContext: { hasNotes: true, tagCount: 4 },
          },
        },
        syncVersion: mobile ? "v-ao3-mobile-fixture" : "v-ao3-desktop-fixture",
      },
    });

    const row = window.document.querySelector("#work_10404927");
    const heading = row.querySelector("h4.heading");
    const header = row.querySelector(".header.module, .header");
    const date = row.querySelector("p.datetime");
    const tagCloud = row.querySelector("ul.tags");
    const summary = row.querySelector("blockquote.summary");
    const wrap = row.querySelector("[data-trace-library-overlay-wrap]");
    const lens = wrap && wrap.querySelector("[data-trace-library-lens]");

    assert.ok(wrap, mobile ? "expected mobile AO3 fixture overlay" : "expected desktop AO3 fixture overlay");
    assert.ok(header, mobile ? "expected mobile AO3 fixture header target" : "expected desktop AO3 fixture header target");
    assert.equal(date.firstChild.nodeValue.trim(), "29 Mar 2026");
    assert.equal(wrap.getAttribute("data-trace-placement"), "ao3-action-row");
    assert.equal(wrap.parentElement, row);
    assert.equal(header.nextElementSibling, wrap);
    assert.equal(date.contains(wrap), false);
    assert.notEqual(date.nextElementSibling, wrap);
    assert.equal(heading.contains(wrap), false);
    assert.ok(!tagCloud || precedes(wrap, tagCloud), "Trace row should appear before AO3 tag cloud");
    assert.ok(!summary || precedes(wrap, summary), "Trace row should appear before AO3 summary");
    assert.match(wrap.getAttribute("style") || "", /clear:\s*both/i);
    assert.match(wrap.getAttribute("style") || "", /width:\s*100%/i);
    assert.match(wrap.getAttribute("style") || "", /justify-content:\s*flex-start/i);
    assert.doesNotMatch(wrap.getAttribute("style") || "", /justify-content:\s*flex-end/i);
    assert.equal(heading.querySelector("[data-trace-library-overlay-wrap]"), null);
    assert.ok(lens);
    assert.doesNotMatch(lens.getAttribute("style") || "", /inset 2px 0 0/i);
  }
});

test("library-overlay AO3 mobile long title places lens in an action row below header metadata", async () => {
  const window = await renderOverlayListing({
    mobile: true,
    html:
      "<!doctype html><html><body><ol><li id='work_424242' class='work blurb group'><div class='header module'><h4 class='heading'><a href='/works/424242'>A Very Long Title That Wraps Across Several Lines on Mobile and Would Otherwise Run Under the Date Lens</a> by <a rel='author' href='/users/long/pseuds/name'>A Very Long Author Name</a></h4><h5 class='fandoms heading'><a class='tag' href='/tags/A%20Very%20Long%20Fandom/works'>A Very Long Fandom Name That Also Wraps On Narrow AO3 Screens</a></h5><ul class='required-tags'><li><a href='/tags/Mature/works'>Mature</a></li></ul><p class='datetime'>04 May 2026</p></div><blockquote class='summary'>Summary</blockquote></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:424242": {
          status: "READING",
          readerStatus: "READING",
          entryId: "00000000-0000-4000-8000-000000424242",
          chapters: { current: 1, total: 9 },
        },
      },
      syncVersion: "v-ao3-mobile-long-title",
    },
  });

  const row = window.document.querySelector("#work_424242");
  const header = row.querySelector(".header.module");
  const heading = row.querySelector("h4.heading");
  const fandom = row.querySelector("h5.fandoms");
  const requiredTags = row.querySelector("ul.required-tags");
  const date = row.querySelector("p.datetime");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");

  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ao3-action-row");
  assert.equal(date.firstChild.nodeValue.trim(), "04 May 2026");
  assert.equal(wrap.parentElement, row);
  assert.equal(header.nextElementSibling, wrap);
  assert.notEqual(date.nextElementSibling, wrap);
  assert.equal(date.contains(wrap), false);
  assert.equal(heading.querySelector("[data-trace-library-overlay-wrap]"), null);
  assert.equal(fandom.querySelector("[data-trace-library-overlay-wrap]"), null);
  assert.equal(requiredTags.querySelector("[data-trace-library-overlay-wrap]"), null);
  assert.ok(precedes(requiredTags, wrap), "mobile Trace row should come after required tag icons in header");
  assert.ok(precedes(wrap, row.querySelector("blockquote.summary")), "mobile Trace row should come before summary");
  assert.match(wrap.getAttribute("style") || "", /justify-content:\s*flex-start/i);
  assert.match(wrap.getAttribute("style") || "", /max-width:\s*100%/i);
  assert.match(wrap.getAttribute("style") || "", /clear:\s*both/i);
  assert.doesNotMatch(wrap.getAttribute("style") || "", /justify-content:\s*flex-end/i);
});

test("library-overlay places FFN listing controls after metadata without changing title line", async () => {
  const window = await renderOverlayListing({
    url: "https://www.fanfiction.net/book/Harry-Potter/",
    html:
      "<!doctype html><html><body><div class='z-list'><a class='stitle' href='/s/3659524/1/A-Shadowed-Soul'>A Shadowed Soul</a> by <a href='/u/593152/devilblondie'>devilblondie</a><div class='z-indent'>Summary<div class='xgray'>Rated: Fiction T - English - Chapters: 26</div></div></div></body></html>",
    cache: {
      entries: {
        "ffn:3659524": {
          status: "READING",
          privateContext: { hasNotes: true, tagCount: 6 },
        },
      },
      syncVersion: "v-ffn-placement",
    },
  });

  const row = window.document.querySelector(".z-list");
  const title = row.querySelector("a.stitle");
  const meta = row.querySelector(".xgray");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");

  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ffn-meta-row");
  assert.equal(meta.nextElementSibling, wrap);
  assert.notEqual(title.nextElementSibling, wrap);
  assert.doesNotMatch(wrap.textContent || "", /\+6|Private note|6 saved/i);
});

test("library-overlay decorates real FFN listing fixture below metadata without touching title line", async () => {
  const window = await renderOverlayListing({
    url: "https://www.fanfiction.net/book/Harry-Potter/",
    html: loadFixture("ffn_listing.html"),
    cache: {
      entries: {
        "ffn:10709411": {
          status: "READING",
          readerStatus: "READING",
          entryId: "00000000-0000-4000-8000-000107094110",
          chapters: { current: 12, total: 72 },
          privateContext: { hasNotes: true, tagCount: 2 },
        },
      },
      syncVersion: "v-ffn-real-fixture",
    },
  });

  const title = window.document.querySelector("a.stitle[href*='/s/10709411/']");
  const row = title.closest(".z-list");
  const meta = row.querySelector(".z-padtop2.xgray");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");
  const lens = wrap && wrap.querySelector("[data-trace-library-lens]");

  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ffn-meta-row");
  assert.equal(meta.nextElementSibling, wrap);
  assert.notEqual(title.nextElementSibling, wrap);
  assert.ok(lens);
  assert.doesNotMatch(lens.getAttribute("style") || "", /inset 2px 0 0/i);
});

test("library-overlay places FFN mobile listing controls below the gray metadata row", async () => {
  const window = await renderOverlayListing({
    url: "https://m.fanfiction.net/book/Harry-Potter/",
    html:
      "<!doctype html><html><body><div class='bs brb'><a href='/s/7038840/1/A-Chance-Encounter'>A Chance Encounter</a> by <a href='/u/593152/devilblondie'>devilblondie</a> Summary<div class='gray'>T, English, Drama, chapters: 28, words: 226k+</div></div></body></html>",
    cache: {
      entries: {
        "ffn:7038840": {
          status: "PLANNING",
          privateContext: { hasNotes: true, tagCount: 6 },
        },
      },
      syncVersion: "v-ffn-mobile-placement",
    },
  });

  const row = window.document.querySelector(".bs.brb");
  const title = row.querySelector("a[href*='/s/']");
  const meta = row.querySelector(".gray");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");

  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ffn-meta-row");
  assert.equal(meta.nextElementSibling, wrap);
  assert.notEqual(title.nextElementSibling, wrap);
  assert.doesNotMatch(wrap.textContent || "", /\+6|Private note|6 saved/i);
});

test("library-overlay decorates real FFN mobile fixture below metadata without touching title line", async () => {
  const window = await renderOverlayListing({
    url: "https://m.fanfiction.net/book/Harry-Potter/",
    html: loadFixture("ffn_listing_mobile.html"),
    mobile: true,
    cache: {
      entries: {
        "ffn:7038840": {
          status: "PLANNING",
          readerStatus: "PLANNING",
          entryId: "00000000-0000-4000-8000-000000703884",
          privateContext: { hasNotes: true, tagCount: 2 },
        },
      },
      syncVersion: "v-ffn-mobile-real-fixture",
    },
  });

  const title = window.document.querySelector("a[href*='/s/7038840/1/']");
  const row = title.closest(".bs.brb");
  const meta = row.querySelector(".gray");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");

  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ffn-meta-row");
  assert.equal(meta.nextElementSibling, wrap);
  assert.notEqual(title.nextElementSibling, wrap);
});

test("library-overlay prefers readerStatus and entryId-era optional fields", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/12345'>Demo Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:12345": {
          status: "READING",
          readerStatus: "PAUSED",
          entryId: "entry-123",
          chapters: { current: 3, total: 17 },
          privateContext: { hasNotes: true, tagCount: 2 },
        },
      },
      syncVersion: "v-new",
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.match(wrap.textContent || "", /Paused\s*·\s*3\/17/);
  assert.doesNotMatch(wrap.textContent || "", /Reading\s*·/);
  assert.doesNotMatch(wrap.textContent || "", /Private note|2 saved|tag/i);
  assert.equal(wrap.querySelector("[aria-hidden='true']"), null);
  const { surface } = openTraceLens(window);
  assert.match(surface.textContent || "", /Private note/i);
  assert.match(surface.textContent || "", /Edit notes in Trace/i);
  assert.match(surface.textContent || "", /2 saved\s*·\s*Open in Trace/i);
});

test("library-overlay opened surface shows status editing only when entryId exists", async () => {
  const entryId = "00000000-0000-4000-8000-000000012345";
  const messages = [];
  const withEntryId = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/12345'>Editable Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:12345": {
          status: "READING",
          readerStatus: "READING",
          entryId,
          chapters: { current: 3, total: 17 },
        },
      },
      syncVersion: "v-entryid-status",
    },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: true, entryId, status: msg.payload.status });
    },
  });

  const surface = openTraceLens(withEntryId).surface;
  assert.match(surface.getAttribute("style") || "", /position:\s*fixed/i);
  assert.match(surface.getAttribute("style") || "", /max-height:\s*calc\(100vh/i);
  const header = surface.querySelector("[data-trace-management-header]");
  assert.ok(header);
  assert.doesNotMatch(header.textContent || "", /\bTrace\b/i);
  assert.equal(
    surface.querySelector("a").getAttribute("href"),
    "https://tracefiction.com/?panel=details&entryId=00000000-0000-4000-8000-000000012345",
  );
  const choices = surface.querySelector("[data-trace-status-choices]");
  assert.ok(choices);
  const selected = choices.querySelector("[data-trace-status-selected='1']");
  assert.ok(selected);
  assert.equal(selected.getAttribute("data-trace-status-choice"), "READING");
  assert.equal(selected.getAttribute("aria-pressed"), "true");
  const progressRow = surface.querySelector("[data-trace-action-row='Progress']");
  assert.ok(progressRow);
  assert.match(progressRow.textContent || "", /3\/17/);
  assert.doesNotMatch(progressRow.textContent || "", /Reading\s*·\s*3\/17/i);
  assert.deepEqual(
    Array.from(choices.querySelectorAll("[data-trace-status-choice]")).map((button) => button.textContent),
    ["Planning", "Reading", "Paused", "Finished", "Dropped"],
  );
  const completed = choices.querySelector("[data-trace-status-choice='COMPLETED']");
  assert.ok(completed);
  completed.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "TRACE_SET_READER_STATUS",
    payload: { entryId, status: "COMPLETED" },
  });
  assert.equal(withEntryId.document.querySelector("[data-trace-action-surface]"), null);
  assert.match(withEntryId.document.querySelector("[data-trace-library-overlay-wrap]").textContent || "", /Finished/i);

  const withoutEntryId = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/54321'>Readonly Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:54321": {
          status: "READING",
          readerStatus: "READING",
          chapters: { current: 2, total: 9 },
        },
      },
      syncVersion: "v-no-entryid-status",
    },
  });

  const readonlySurface = openTraceLens(withoutEntryId).surface;
  assert.equal(readonlySurface.querySelector("[data-trace-status-choices]"), null);
  assert.equal(readonlySurface.querySelector("a").getAttribute("href"), "https://tracefiction.com/");
});

test("library-overlay lens click toggles same surface and switches to another lens", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/10001'>First Work</a></h4></li><li class='work blurb group'><h4 class='heading'><a href='/works/10002'>Second Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:10001": { status: "READING", readerStatus: "READING", chapters: { current: 1, total: 2 } },
        "ao3:10002": { status: "PAUSED", readerStatus: "PAUSED", chapters: { current: 2, total: 5 } },
      },
      syncVersion: "v-toggle-surfaces",
    },
  });

  const lenses = window.document.querySelectorAll("[data-trace-library-lens]");
  assert.equal(lenses.length, 2);

  lenses[0].click();
  let surface = window.document.querySelector("[data-trace-action-surface]");
  assert.ok(surface);
  assert.equal(surface.getAttribute("data-trace-action-surface-key"), "ao3:10001");

  lenses[0].click();
  assert.equal(window.document.querySelector("[data-trace-action-surface]"), null);

  lenses[0].click();
  surface = window.document.querySelector("[data-trace-action-surface]");
  assert.ok(surface);
  assert.equal(surface.getAttribute("data-trace-action-surface-key"), "ao3:10001");

  lenses[1].click();
  surface = window.document.querySelector("[data-trace-action-surface]");
  assert.ok(surface);
  assert.equal(surface.getAttribute("data-trace-action-surface-key"), "ao3:10002");
  assert.match(surface.textContent || "", /Paused/i);
});

test("library-overlay status selection closes surface immediately and shows inline saving", async () => {
  const entryId = "00000000-0000-4000-8000-000000012347";
  let pendingCallback = null;
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/12347'>Saving Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:12347": {
          status: "PLANNING",
          readerStatus: "PLANNING",
          entryId,
          chapters: { current: 0, total: 12 },
        },
      },
      syncVersion: "v-saving-status",
    },
    sendMessage(_msg, cb) {
      pendingCallback = cb;
    },
  });

  const { surface } = openTraceLens(window);
  surface.querySelector("[data-trace-status-choice='READING']").click();

  assert.equal(window.document.querySelector("[data-trace-action-surface]"), null);
  let lens = window.document.querySelector("[data-trace-library-lens]");
  assert.ok(lens);
  assert.equal(lens.getAttribute("data-trace-status-saving"), "1");
  assert.match(lens.textContent || "", /Saving/i);

  pendingCallback({ ok: true, entryId, status: "READING" });
  await sleep(20);
  lens = window.document.querySelector("[data-trace-library-lens]");
  assert.equal(lens.getAttribute("data-trace-status-saving"), null);
  assert.match(lens.textContent || "", /Reading\s*·\s*1\/12/i);
  assert.doesNotMatch(lens.textContent || "", /0\/12/);
});

test("library-overlay status failure restores previous state and exposes compact error", async () => {
  const entryId = "00000000-0000-4000-8000-000000012348";
  let pendingCallback = null;
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/12348'>Failure Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:12348": {
          status: "PAUSED",
          readerStatus: "PAUSED",
          entryId,
          chapters: { current: 3, total: 12 },
        },
      },
      syncVersion: "v-failure-status",
    },
    sendMessage(_msg, cb) {
      pendingCallback = cb;
    },
  });

  const { surface } = openTraceLens(window);
  surface.querySelector("[data-trace-status-choice='COMPLETED']").click();
  assert.equal(window.document.querySelector("[data-trace-action-surface]"), null);
  assert.match(window.document.querySelector("[data-trace-library-lens]").textContent || "", /Saving/i);

  pendingCallback({ ok: false, error: "rate_limited" });
  await sleep(20);
  const lens = window.document.querySelector("[data-trace-library-lens]");
  assert.equal(lens.getAttribute("data-trace-status-error"), "1");
  assert.match(lens.textContent || "", /Update failed/i);
  lens.click();
  const retrySurface = window.document.querySelector("[data-trace-action-surface]");
  assert.ok(retrySurface);
  assert.match(retrySurface.textContent || "", /Paused/i);
  assert.match(retrySurface.querySelector("[data-trace-action-row='Progress']").textContent || "", /3\/12/i);
  assert.doesNotMatch(retrySurface.querySelector("[data-trace-action-row='Progress']").textContent || "", /Paused\s*·\s*3\/12/i);
  assert.equal(
    retrySurface.querySelector("[data-trace-status-selected='1']").getAttribute("data-trace-status-choice"),
    "PAUSED",
  );
});

test("library-overlay Planning to Reading sends chapter progress 1 and never displays Reading 0/N", async () => {
  const entryId = "00000000-0000-4000-8000-000000012346";
  const messages = [];
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/12346'>Planning Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:12346": {
          status: "PLANNING",
          readerStatus: "PLANNING",
          entryId,
          chapters: { current: 0, total: 17 },
        },
      },
      syncVersion: "v-planning-reading",
    },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: true, entryId, status: msg.payload.status });
    },
  });

  const { surface } = openTraceLens(window);
  const reading = surface.querySelector("[data-trace-status-choice='READING']");
  assert.ok(reading);
  reading.click();

  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "TRACE_SET_READER_STATUS",
    payload: {
      entryId,
      status: "READING",
      progress: { unit: "CHAPTER", value: 1, total: 17 },
    },
  });
  const wrapText = window.document.querySelector("[data-trace-library-overlay-wrap]").textContent || "";
  assert.match(wrapText, /Reading\s*·\s*1\/17/i);
  assert.doesNotMatch(wrapText, /Reading\s*·\s*0\/17/i);
});

test("library-overlay collapses hidden library entries to a minimal placeholder", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/22222'>Hidden Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:22222": {
          status: "READING",
          readerStatus: "READING",
          chapters: { current: 7, total: null },
          browsePreference: { hidden: true },
        },
      },
      syncVersion: "v-hidden-entry",
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  const row = window.document.querySelector("li.work");
  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "hidden-placeholder");
  assert.equal(row.getAttribute("data-trace-row-hidden"), "1");
  assert.match(wrap.textContent || "", /Hidden by Trace\s*Undo/i);
  assert.equal(wrap.querySelector("[data-trace-hidden-placeholder]") !== null, true);
  assert.equal(row.querySelector("h4.heading").style.display, "none");
  assert.doesNotMatch(wrap.textContent || "", /Reading\s*·\s*7\/\?/);
});

test("library-overlay renders hidden-only workPreferences collapsed without status", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/33333'>Hidden Only</a></h4></li></ol></body></html>",
    cache: {
      entries: {},
      workPreferences: {
        "ao3:33333": { browsePreference: { hidden: true } },
      },
      syncVersion: "v-hidden-only",
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  const row = window.document.querySelector("li.work");
  assert.ok(wrap);
  assert.equal(row.getAttribute("data-trace-row-hidden"), "1");
  assert.match(wrap.textContent || "", /Hidden by Trace\s*Undo/i);
  assert.doesNotMatch(wrap.textContent || "", /Reading|Planning|Paused|Finished|Dropped/);
  assert.equal(wrap.querySelector("button[data-trace-quick-add]"), null);
});

test("library-overlay restores hidden host rows when auth and cache clear", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/44444'>Hidden Clear</a></h4></li></ol></body></html>",
    cache: {
      entries: {},
      workPreferences: {
        "ao3:44444": { browsePreference: { hidden: true } },
      },
      syncVersion: "v-hidden-clear",
    },
  });

  const row = window.document.querySelector("li.work");
  const heading = row.querySelector("h4.heading");
  assert.equal(row.getAttribute("data-trace-row-hidden"), "1");
  assert.equal(heading.style.display, "none");
  assert.ok(window.document.querySelector("[data-trace-hidden-placeholder]"));

  window.__traceSetStorage({
    authToken: null,
    traceAuthState: { state: "signed_out" },
    libraryOverlayCache: undefined,
  });
  await sleep(140);

  assert.equal(row.getAttribute("data-trace-row-hidden"), null);
  assert.notEqual(heading.style.display, "none");
  assert.equal(window.document.querySelector("[data-trace-library-overlay-wrap]"), null);
  assert.equal(window.document.querySelector("[data-trace-hidden-placeholder]"), null);
});

test("library-overlay restores hidden host rows when inlay preference is disabled", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/55555'>Hidden Pref</a></h4></li></ol></body></html>",
    cache: {
      entries: {},
      workPreferences: {
        "ao3:55555": { browsePreference: { hidden: true } },
      },
      syncVersion: "v-hidden-pref",
    },
  });

  const row = window.document.querySelector("li.work");
  const heading = row.querySelector("h4.heading");
  assert.equal(row.getAttribute("data-trace-row-hidden"), "1");
  assert.equal(heading.style.display, "none");
  assert.ok(window.document.querySelector("[data-trace-hidden-placeholder]"));

  window.__traceSetStorage({ prefLibraryInlayEnabled: false });
  await sleep(140);

  assert.equal(row.getAttribute("data-trace-row-hidden"), null);
  assert.notEqual(heading.style.display, "none");
  assert.equal(window.document.querySelector("[data-trace-library-overlay-wrap]"), null);
  assert.equal(window.document.querySelector("[data-trace-hidden-placeholder]"), null);
});

test("library-overlay unknown signed-in works show Add and Hide inline", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/77777'>Unknown Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-empty" },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  const add = wrap.querySelector("button[data-trace-quick-add]");
  const hide = wrap.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(add);
  assert.ok(hide);
  assert.match(add.getAttribute("style") || "", /min-height:\s*22px/i);
  assert.match(hide.getAttribute("style") || "", /min-height:\s*22px/i);
  assert.doesNotMatch(hide.getAttribute("style") || "", /min-height:\s*38px|42px/i);
  assert.equal(wrap.querySelector("[data-trace-library-lens]"), null);
});

test("library-overlay decorates each AO3 blurb once when the row contains extra work links", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li id='work_77777' class='work blurb group'><div class='header module'><h4 class='heading'><a href='/works/77777'>Unknown Work</a> by <a rel='author' href='/users/a/pseuds/a'>Author</a></h4><p class='datetime'>04 May 2026</p></div><blockquote class='summary'>Mentions <a href='/works/88888'>another AO3 work</a> in the summary.</blockquote></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-ao3-extra-work-link" },
  });

  const row = window.document.querySelector("#work_77777");
  const wraps = row.querySelectorAll("[data-trace-library-overlay-wrap]");
  assert.equal(wraps.length, 1);
  assert.equal(wraps[0].getAttribute("data-trace-placement"), "ao3-action-row");
  assert.equal(wraps[0].querySelectorAll("button[data-trace-quick-add]").length, 1);
  assert.equal(wraps[0].querySelectorAll("button[data-trace-hidden-action='hide']").length, 1);
});

test("library-overlay AO3 desktop unknown works use action row without touching the date", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li id='work_77776' class='work blurb group'><div class='header module'><h4 class='heading'><a href='/works/77776'>Unknown Desktop Work With A Long Header</a> by <a rel='author' href='/users/a/pseuds/a'>Author</a></h4><h5 class='fandoms heading'><a class='tag' href='/tags/Very%20Long%20Fandom/works'>A Very Long Fandom Name That Can Occupy The Metadata Row On Desktop</a></h5><ul class='required-tags'><li><a href='/tags/Mature/works'>Mature</a></li></ul><p class='datetime'>04 May 2026</p></div><ul class='tags'><li><a href='/tags/Long/works'>Long tag</a></li></ul><blockquote class='summary'>Summary</blockquote></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-ao3-desktop-unknown-row" },
  });

  const row = window.document.querySelector("#work_77776");
  const header = row.querySelector(".header.module");
  const date = row.querySelector("p.datetime");
  const tagCloud = row.querySelector("ul.tags");
  const summary = row.querySelector("blockquote.summary");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");

  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ao3-action-row");
  assert.equal(wrap.parentElement, row);
  assert.equal(header.nextElementSibling, wrap);
  assert.equal(date.firstChild.nodeValue.trim(), "04 May 2026");
  assert.equal(date.contains(wrap), false);
  assert.notEqual(date.nextElementSibling, wrap);
  assert.ok(precedes(wrap, tagCloud));
  assert.ok(precedes(wrap, summary));
  assert.match(wrap.getAttribute("style") || "", /clear:\s*both/i);

  const add = wrap.querySelector("button[data-trace-quick-add]");
  const hide = wrap.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(add);
  assert.ok(hide);
  assert.match(add.getAttribute("style") || "", /min-height:\s*22px/i);
  assert.match(hide.getAttribute("style") || "", /min-height:\s*22px/i);
});

test("library-overlay unknown AO3 mobile works show Add and Hide in the action row", async () => {
  const window = await renderOverlayListing({
    mobile: true,
    html:
      "<!doctype html><html><body><ol><li id='work_77777' class='work blurb group'><div class='header module'><h4 class='heading'><a href='/works/77777'>Unknown Mobile Work</a> by <a rel='author' href='/users/a/pseuds/a'>Author</a></h4><h5 class='fandoms heading'><a class='tag' href='/tags/Fandom/works'>Fandom</a></h5><ul class='required-tags'><li><a href='/tags/Mature/works'>Mature</a></li></ul><p class='datetime'>04 May 2026</p></div><ul class='tags'><li><a href='/tags/Long/works'>Long tag</a></li></ul><blockquote class='summary'>Summary</blockquote></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-ao3-mobile-unknown-row" },
  });

  const row = window.document.querySelector("#work_77777");
  const header = row.querySelector(".header.module");
  const date = row.querySelector("p.datetime");
  const tagCloud = row.querySelector("ul.tags");
  const wrap = row.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ao3-action-row");
  assert.equal(wrap.parentElement, row);
  assert.equal(header.nextElementSibling, wrap);
  assert.equal(date.contains(wrap), false);
  assert.ok(precedes(wrap, tagCloud));

  const add = wrap.querySelector("button[data-trace-quick-add]");
  const hide = wrap.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(add);
  assert.ok(hide);
  assert.match(add.getAttribute("style") || "", /min-height:\s*28px/i);
  assert.match(hide.getAttribute("style") || "", /min-height:\s*28px/i);
  assert.doesNotMatch(hide.getAttribute("style") || "", /min-height:\s*38px|42px/i);
});

test("library-overlay unknown FFN signed-in works show same-height Add and Hide inline", async () => {
  const window = await renderOverlayListing({
    url: "https://www.fanfiction.net/book/Harry-Potter/",
    html:
      "<!doctype html><html><body><div class='z-list'><a class='stitle' href='/s/77777/1/Unknown-FFN'>Unknown FFN</a><div class='z-indent'>Summary<div class='xgray'>Rated: Fiction T - English - Chapters: 4</div></div></div></body></html>",
    cache: { entries: {}, syncVersion: "v-ffn-empty" },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.equal(wrap.getAttribute("data-trace-placement"), "ffn-meta-row");
  const add = wrap.querySelector("button[data-trace-quick-add]");
  const hide = wrap.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(add);
  assert.ok(hide);
  assert.match(add.getAttribute("style") || "", /min-height:\s*22px/i);
  assert.match(hide.getAttribute("style") || "", /min-height:\s*22px/i);
  assert.doesNotMatch(hide.getAttribute("style") || "", /min-height:\s*38px|42px/i);
});

test("library-overlay unknown Hide calls hidden endpoint and collapses the row", async () => {
  const messages = [];
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/77779'>Unknown Hide Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-empty" },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: true, key: msg.payload.key, hidden: msg.payload.hidden });
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  const hide = wrap.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(hide);
  hide.click();

  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ao3:77779", hidden: true },
  });
  assert.match(wrap.textContent || "", /Hidden by Trace\s*Undo/i);
  assert.equal(window.document.querySelector("li.work").getAttribute("data-trace-row-hidden"), "1");
  assert.equal(wrap.querySelector("button[data-trace-quick-add]"), null);
});

test("library-overlay Hide auth failure becomes a clickable Connect action", async () => {
  const messages = [];
  const opened = [];
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/77780'>Auth Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-empty" },
    authState: { state: "connected", helpUrl: "https://tracefiction.com/apps" },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: false, error: "not_authenticated" });
    },
  });
  window.open = function (url, target, features) {
    opened.push({ url, target, features });
    return null;
  };

  const hide = window.document.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(hide);
  hide.click();

  assert.equal(messages.at(-1).type, "TRACE_SET_HIDDEN_WORK");
  assert.equal(hide.disabled, false);
  assert.equal(hide.getAttribute("data-trace-connect-action"), "1");
  assert.match(hide.textContent || "", /CONNECT/i);

  hide.click();
  assert.deepEqual(opened.at(-1), {
    url: "https://tracefiction.com/",
    target: "_blank",
    features: "noopener,noreferrer",
  });
  assert.equal(messages.length, 1, "connect click must not retry hidden endpoint");
});

test("library-overlay Connect after auth failure checks and rerenders on focus when auth returns", async () => {
  const messages = [];
  const opened = [];
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/77782'>Reconnect Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-empty" },
    authState: { state: "connected", helpUrl: "https://tracefiction.com/apps" },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: false, error: "not_authenticated" });
    },
  });
  window.open = function (url, target, features) {
    opened.push({ url, target, features });
    return null;
  };

  const hide = window.document.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(hide);
  hide.click();
  assert.equal(hide.getAttribute("data-trace-connect-action"), "1");

  hide.click();
  assert.deepEqual(opened.at(-1), {
    url: "https://tracefiction.com/",
    target: "_blank",
    features: "noopener,noreferrer",
  });
  assert.equal(hide.disabled, true);
  assert.equal(hide.getAttribute("data-trace-connect-checking"), "1");
  assert.match(hide.textContent || "", /CHECKING/i);

  window.__traceMutateStorage({
    authToken: "fresh-token",
    traceAuthState: { state: "connected", helpUrl: "https://tracefiction.com/" },
  });
  window.dispatchEvent(new window.Event("focus"));
  await sleep(140);

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap.querySelector("button[data-trace-quick-add]"));
  const restoredHide = wrap.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(restoredHide);
  assert.equal(restoredHide.getAttribute("data-trace-connect-action"), null);
  assert.match(restoredHide.textContent || "", /HIDE/i);
});

test("library-overlay known signed-out auth state does not offer fake Hide", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/77781'>Signed Out Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-empty" },
    authToken: "stale-token",
    authState: { state: "signed_out", helpUrl: "https://tracefiction.com/apps" },
  });

  assert.equal(window.document.querySelector("button[data-trace-hidden-action]"), null);
  assert.equal(window.document.querySelector("button[data-trace-quick-add]"), null);
  const connect = window.document.querySelector("[data-trace-connect-notice-cta]");
  assert.ok(connect);
  assert.equal(connect.getAttribute("href"), "https://tracefiction.com/");
});

test("library-overlay Add saves in place without opening the management surface", async () => {
  const messages = [];
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/77778'>Quick Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-empty" },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: true });
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  const button = wrap.querySelector("button[data-trace-quick-add]");
  assert.ok(button);
  button.click();

  assert.equal(messages.at(-1).type, "TRACE_QUICK_ADD");
  assert.match(button.textContent || "", /PLANNING/i);
  assert.equal(window.document.querySelector("[data-trace-action-surface]"), null);
});

test("library-overlay quick add immediately shows pending and ignores duplicate clicks", async () => {
  const messages = [];
  let pendingCallback;
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/77783'>Pending Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-pending-add" },
    sendMessage(msg, cb) {
      messages.push(msg);
      pendingCallback = cb;
    },
  });

  const button = window.document.querySelector(
    "[data-trace-library-overlay-wrap] button[data-trace-quick-add]",
  );
  assert.ok(button);
  assert.match(button.textContent || "", /\+ ADD/);
  button.click();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "TRACE_QUICK_ADD");
  assert.equal(button.disabled, true);
  assert.match(button.textContent || "", /ADDING\.\.\./);
  button.click();
  assert.equal(messages.length, 1);

  pendingCallback({ ok: true });
  assert.match(button.textContent || "", /PLANNING/i);
});

test("library-overlay known works expose hide without changing reader status", async () => {
  const messages = [];
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/88888'>Known Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:88888": {
          status: "READING",
          readerStatus: "READING",
          chapters: { current: 5, total: 10 },
        },
      },
      syncVersion: "v-known",
    },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: true });
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.match(wrap.textContent || "", /Reading\s*·\s*5\/10/);
  const { surface } = openTraceLens(window);
  const hide = surface.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(hide);
  assert.match(hide.getAttribute("style") || "", /min-height:\s*40px/i);
  assert.match(hide.getAttribute("style") || "", /padding:\s*0px 12px/i);

  hide.click();

  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ao3:88888", hidden: true },
  });
  assert.match(wrap.textContent || "", /Hidden by Trace\s*Undo/i);
  assert.equal(window.document.querySelector("li.work").getAttribute("data-trace-row-hidden"), "1");
  assert.equal(window.document.querySelector("[data-trace-library-lens]"), null);
});

test("library-overlay hidden-only undo sends hidden false and restores unknown actions", async () => {
  const messages = [];
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/99999'>Hidden Only</a></h4></li></ol></body></html>",
    cache: {
      entries: {},
      workPreferences: {
        "ao3:99999": { browsePreference: { hidden: true } },
      },
      syncVersion: "v-hidden-only",
    },
    sendMessage(msg, cb) {
      messages.push(msg);
      if (typeof cb === "function") cb({ ok: true, key: msg.payload.key, hidden: msg.payload.hidden });
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  const row = window.document.querySelector("li.work");
  assert.ok(wrap);
  assert.equal(row.getAttribute("data-trace-row-hidden"), "1");
  const undo = wrap.querySelector("button[data-trace-hidden-action='undo']");
  assert.ok(undo);

  undo.click();

  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ao3:99999", hidden: false },
  });
  assert.equal(row.getAttribute("data-trace-row-hidden"), null);
  assert.notEqual(row.querySelector("h4.heading").style.display, "none");
  assert.doesNotMatch(wrap.textContent || "", /Hidden/);
  assert.ok(wrap.querySelector("button[data-trace-quick-add]"));
  assert.ok(wrap.querySelector("button[data-trace-hidden-action='hide']"));
});

test("library-overlay does not show hide controls when signed out", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/10101'>Signed Out Hidden</a></h4></li></ol></body></html>",
    authToken: null,
    cache: {
      entries: {},
      workPreferences: {
        "ao3:10101": { browsePreference: { hidden: true } },
      },
      syncVersion: "v-signed-out",
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.match(wrap.textContent || "", /Hidden by Trace/i);
  assert.equal(wrap.querySelector("button[data-trace-hidden-action]"), null);
  assert.ok(window.document.querySelector("[data-trace-connect-notice]"));
});

test("library-overlay hides status mutation controls when signed out with stale cached entry", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/10102'>Signed Out Known</a></h4></li></ol></body></html>",
    authToken: null,
    cache: {
      entries: {
        "ao3:10102": {
          entryId: "00000000-0000-4000-8000-000000010102",
          status: "READING",
          readerStatus: "READING",
          chapters: { current: 4, total: 12 },
        },
      },
      syncVersion: "v-signed-out-known",
    },
  });

  const { surface } = openTraceLens(window);

  assert.match(surface.textContent || "", /Reading/i);
  assert.equal(surface.querySelector("[data-trace-status-choices]"), null);
  assert.equal(surface.querySelector("button[data-trace-hidden-action]"), null);
  assert.ok(window.document.querySelector("[data-trace-connect-notice]"));
});

test("library-overlay hide failure keeps existing badge and offers retry", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/12121'>Retry Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:12121": {
          status: "READING",
          readerStatus: "READING",
          chapters: { current: 2, total: 9 },
        },
      },
      syncVersion: "v-failure",
    },
    sendMessage(_msg, cb) {
      if (typeof cb === "function") cb({ ok: false, error: "http_500" });
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  const { surface } = openTraceLens(window);
  const hide = surface.querySelector("button[data-trace-hidden-action='hide']");
  assert.ok(hide);

  hide.click();

  assert.match(wrap.textContent || "", /Reading\s*·\s*2\/9/);
  assert.doesNotMatch(wrap.textContent || "", /Hidden/);
  assert.match(hide.textContent || "", /ERROR/);
  assert.equal(hide.disabled, false);
});

test("library-overlay renders abandoned marks from workMark", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/44444'>Marked Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:44444": {
          status: "DROPPED",
          readerStatus: "DROPPED",
          workMark: { kind: "abandoned" },
        },
      },
      syncVersion: "v-mark",
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.match(wrap.textContent || "", /Dropped/);
  assert.ok(wrap.querySelector("[data-trace-work-mark]"));
  const { surface } = openTraceLens(window);
  assert.match(surface.textContent || "", /Abandoned/i);
});

test("library-overlay renders challenge only from server-supplied workMark challenge", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/55555'>Challenge Work</a></h4></li></ol></body></html>",
    cache: {
      entries: {
        "ao3:55555": {
          status: "READING",
          readerStatus: "READING",
          workMark: {
            kind: "abandoned",
            challenge: { kind: "chapter-count-changed", chapterDelta: 4 },
          },
        },
      },
      syncVersion: "v-challenge",
    },
  });

  const wrap = window.document.querySelector("[data-trace-library-overlay-wrap]");
  assert.ok(wrap);
  assert.match(wrap.textContent || "", /\+4/);
  assert.ok(wrap.querySelector("[data-trace-work-mark-challenge]"));
  const { surface } = openTraceLens(window);
  assert.match(surface.textContent || "", /Attention/i);
});

test("library-overlay quick-add still maps free-limit response to FULL", async () => {
  const window = await renderOverlayListing({
    html:
      "<!doctype html><html><body><ol><li class='work blurb group'><h4 class='heading'><a href='/works/66666'>Unknown Work</a></h4></li></ol></body></html>",
    cache: { entries: {}, syncVersion: "v-empty" },
    sendMessage(_msg, cb) {
      if (typeof cb === "function") cb({ ok: false, error: "free_limit_reached" });
    },
  });

  const button = window.document.querySelector(
    "[data-trace-library-overlay-wrap] button[data-trace-quick-add]",
  );
  assert.ok(button);
  assert.match(button.textContent || "", /\+ ADD/);
  button.click();
  assert.match(button.textContent || "", /FULL/);
  assert.equal(button.disabled, true);
});

test("library-overlay exits on pages with password fields", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><input type='password'><main id='root'><a href='/works/12345'>Demo Work</a></main></body></html>",
    {
      url: "https://archiveofourown.org/users/login",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  let storageReadCount = 0;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          storageReadCount += 1;
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  await sleep(180);

  assert.equal(storageReadCount, 0);
  assert.equal(
    window.document.querySelectorAll("[data-trace-library-overlay-wrap]").length,
    0,
  );
});

test("library-overlay decorates listing links even without overlay-keys global", async () => {
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  const root = window.document.getElementById("root");
  root.innerHTML =
    '<ol class="work index group"><li class="work blurb group"><h4 class="heading"><a href="/works/12345">Demo Work</a></h4></li></ol>';

  await sleep(180);

  const wraps = window.document.querySelectorAll(
    "[data-trace-library-overlay-wrap]",
  );
  assert.equal(wraps.length, 1);
  assert.match(wraps[0].textContent || "", /\+ ADD/);
});

test("library-overlay FFN fallback quick-add includes mobile row summary text", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://m.fanfiction.net/book/Harry-Potter/",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  let sentPayload = null;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sentPayload = msg && msg.payload ? msg.payload : null;
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  const root = window.document.getElementById("root");
  root.innerHTML =
    '<div class="bs brb"><a href="/s/7038840/1/A-Chance-Encounter">A Chance Encounter</a> by <a href="/u/593152/devilblondie">devilblondie</a> WIP. Harry makes a different choice in King\\\'s Cross and is given a second chance.<div class="gray">T, English, Drama, chapters: 28, words: 226k+</div></div>';

  await sleep(220);

  const button = window.document.querySelector(
    "[data-trace-library-overlay-wrap] button[data-trace-quick-add]",
  );
  assert.ok(button, "expected quick-add button for FFN mobile listing row");
  button.click();

  assert.ok(sentPayload && sentPayload.item, "expected TRACE_QUICK_ADD payload");
  assert.equal(sentPayload.item.src, "ffn");
  assert.equal(sentPayload.item.ctx, "listing");
  assert.match(sentPayload.item.sm || "", /King\\'s Cross/i);
});

test("library-overlay FFN fallback quick-add includes desktop listing summary", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://www.fanfiction.net/book/Harry-Potter/",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  let sentPayload = null;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sentPayload = msg && msg.payload ? msg.payload : null;
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  const root = window.document.getElementById("root");
  root.innerHTML =
    '<div class="z-list"><a class="stitle" href="/s/3659524/1/A-Shadowed-Soul">A Shadowed Soul</a> by <a href="/u/593152/devilblondie">devilblondie</a><div class="z-indent">He was abandoned at a young age, the world believed him dead.</div><div class="xgray">Rated: Fiction T - English - Chapters: 26</div></div>';

  await sleep(220);

  const button = window.document.querySelector(
    "[data-trace-library-overlay-wrap] button[data-trace-quick-add]",
  );
  assert.ok(button, "expected quick-add button for FFN desktop listing row");
  button.click();

  assert.ok(sentPayload && sentPayload.item, "expected TRACE_QUICK_ADD payload");
  assert.equal(sentPayload.item.src, "ffn");
  assert.equal(sentPayload.item.ctx, "listing");
  assert.match(sentPayload.item.sm || "", /abandoned at a young age/i);
});
