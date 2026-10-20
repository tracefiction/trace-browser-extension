const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { JSDOM } = require("jsdom");
const {
  createCollectorBindings,
  withDefaultScopedStorageContext,
} = require("./collector-functions.js");

const FIXTURES = path.join(__dirname, "fixtures");

// Tests can inspect private collector helpers without publishing them in the content world.
function collectorTestSource(source) {
  return source.replace(/\n\}\)\(\);\s*$/, `
window.finishQualifyIsLastPostedChapter = finishQualifyIsLastPostedChapter;
window.removeQuickAddElements = removeQuickAddElements;
window.renderQuickAddButton = renderQuickAddButton;
window.renderKernelProjectionUnavailable = renderKernelProjectionUnavailable;
window.placeStorySheet = placeStorySheet;
window.__traceTestHooks = { sendAutoTrackForStory, storyHandlePresentation, applyStoryInlineHandleState, handleDisplay, storyHeadline, storyCaption };
})();`);
}

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function domFromFixture(name, url) {
  return new JSDOM(loadFixture(name), {
    url,
    contentType: "text/html",
    runScripts: "outside-only",
  });
}

function assertIncludesAll(arr, subs, msg) {
  const hay = (arr || []).join("\0");
  for (const s of subs) {
    assert.ok(hay.includes(s), msg ? `${msg}: missing ${s}` : `missing ${s}`);
  }
}

/** vm-sourced values may be String objects; JSON round-trips to plain primitives for deepStrictEqual */
function plainJson(v) {
  return JSON.parse(JSON.stringify(v));
}

function installCollectorChrome(dom, chrome) {
  const scoped = withDefaultScopedStorageContext(chrome);
  dom.window.chrome = scoped;
  delete dom.window.browser;
}

function installCollectorBrowser(dom, browser) {
  const scoped = withDefaultScopedStorageContext(browser);
  dom.window.browser = scoped;
  delete dom.window.chrome;
}

test("collector routes runtime messaging through the Promise/callback portability boundary", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const directRuntimeCalls = source.match(/ext\.runtime\.sendMessage\s*\(/g) || [];
  assert.equal(
    directRuntimeCalls.length,
    2,
    "only the Promise and callback branches inside sendCollectorMessage may call runtime.sendMessage",
  );

  const responseBearingOwners = [
    "sendListingMetadataRefreshForTrackedItems",
    "sendAutoTrackForStory",
    "queryBackgroundWorkStateForStory",
    "requestStoryAuthRefreshOnResume",
    "bindReaderStatusChoice",
    "appendStoryRatingControls",
    "appendStoryCatchupAction",
    "sendQuickAddAction",
    "processIosPendingFirstStoryAdd",
    "bindStoryHiddenPreferenceAction",
    "sendFinishQualifySignal",
    "renderQuickAddButton",
  ];
  for (const name of responseBearingOwners) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `expected ${name}`);
    const next = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.match(body, /sendCollectorMessage\s*\(/, `${name} must use the portable adapter`);
  }
  assert.match(source, /function sendCollectorMessageBestEffort\(/);
});

test("collector callback messaging settles when Safari never invokes its callback", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/1",
  });
  const { sendCollectorMessage } = createCollectorBindings(dom, {
    chrome: {
      runtime: {
        sendMessage() {},
        lastError: null,
      },
    },
  });

  const response = await Promise.race([
    new Promise((resolve) => sendCollectorMessage({ type: "TEST" }, resolve, 5)),
    delay(200, "test_hung"),
  ]);

  assert.equal(response, null);
});

test("collector Promise messaging settles when Safari never resolves its Promise", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/1",
  });
  const { sendCollectorMessage } = createCollectorBindings(dom, {
    browser: {
      runtime: {
        sendMessage() {
          return new Promise(() => {});
        },
      },
    },
  });

  const response = await Promise.race([
    new Promise((resolve) => sendCollectorMessage({ type: "TEST" }, resolve, 5)),
    delay(200, "test_hung"),
  ]);

  assert.equal(response, null);
});

test("collector messaging ignores callback and Promise settlements after timeout", async () => {
  let callback;
  let resolvePromise;
  const callbackResponses = [];
  const promiseResponses = [];
  const callbackDom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/1",
  });
  const callbackBindings = createCollectorBindings(callbackDom, {
    chrome: {
      runtime: {
        sendMessage(_message, next) {
          callback = next;
        },
        lastError: null,
      },
    },
  });
  const promiseDom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/1",
  });
  const promiseBindings = createCollectorBindings(promiseDom, {
    browser: {
      runtime: {
        sendMessage() {
          return new Promise((resolve) => {
            resolvePromise = resolve;
          });
        },
      },
    },
  });

  callbackBindings.sendCollectorMessage(
    { type: "TEST_CALLBACK" },
    (response) => callbackResponses.push(response),
    5,
  );
  promiseBindings.sendCollectorMessage(
    { type: "TEST_PROMISE" },
    (response) => promiseResponses.push(response),
    5,
  );
  await delay(20);
  callback({ ok: true });
  resolvePromise({ ok: true });
  await delay(0);

  assert.deepEqual(callbackResponses, [null]);
  assert.deepEqual(promiseResponses, [null]);
});

test("finish qualification requires the exact latest posted chapter", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/1",
    runScripts: "outside-only",
  });
  installCollectorChrome(dom, {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_message, callback) {
        if (callback) callback(null);
      },
      lastError: null,
    },
  });
  dom.window.eval(collectorTestSource(collectorSrc));

  assert.equal(dom.window.finishQualifyIsLastPostedChapter({ chn: 12, chPub: 12 }), true);
  assert.equal(dom.window.finishQualifyIsLastPostedChapter({ chn: 11, chPub: 12 }), false);
  assert.equal(dom.window.finishQualifyIsLastPostedChapter({ chn: 13, chPub: 12 }), false);
  assert.equal(dom.window.finishQualifyIsLastPostedChapter({ chn: 12.5, chPub: 12 }), false);
});

test("collectAO3Work (ao3_story.html) extracts full metadata", () => {
  const dom = domFromFixture(
    "ao3_story.html",
    "https://archiveofourown.org/works/28534965/chapters/69925506"
  );
  const { collectAO3Work } = createCollectorBindings(dom);
  const item = collectAO3Work();

  assert.equal(item.src, "ao3");
  assert.equal(item.ctx, "story");
  assert.equal(item.u, "https://archiveofourown.org/works/28534965");
  assert.equal(item.chu, "https://archiveofourown.org/works/28534965/chapters/69925506");
  assert.equal(item.t, "Redivider");
  assert.equal(item.a, "Vichan");
  assert.equal(item.r, "Mature");
  assert.equal(item.l, "English");
  assert.equal(item.w, 107493);
  assert.equal(item.k, 35626);
  assert.equal(item.h, 932952);
  assert.equal(item.bk, 7955);
  assert.equal(item.cc, 6909);
  assert.equal(item.chn, 1);
  assert.equal(item.chPub, 17, "AO3 first number = published chapters");
  assert.equal(item.cht, null, "17/? preserves unknown planned total");
  assert.equal(item.pub, "2021-01-03");
  assert.equal(item.upd, "2025-09-01");
  assertIncludesAll(item.fms, ["Harry Potter - J. K. Rowling"]);
  assertIncludesAll(item.wrn, [
    "Graphic Depictions Of Violence",
    "Major Character Death",
  ]);
  assertIncludesAll(item.cat, ["F/M", "M/M"]);
  assertIncludesAll(item.chars, ["Harry Potter", "Draco Malfoy"]);
  assertIncludesAll(item.rels, ["Draco Malfoy/Harry Potter"]);
  assertIncludesAll(item.tags, ["Slytherin Harry Potter"]);
  assert.ok(item.sm && item.sm.includes("Slytherin"));
  assert.deepEqual(plainJson(item.ser), {
    name: "Mutatum",
    pos: 2,
    url: "https://archiveofourown.org/series/1637290",
  });
  assert.equal(item.s, null, "bare chapters 17/? does not over-infer work status");
});

const WORK_SUMMARY = "A lamplighter keeps a ledger of every fog that crosses Baker Street.";

function collectSummaryFixture(name, url) {
  const dom = domFromFixture(path.join("ao3-work-summary", name), url);
  const { collectAO3Work } = createCollectorBindings(dom);
  return collectAO3Work();
}

test("collectAO3Work reads the work summary from the work preface on chapter 1", () => {
  const item = collectSummaryFixture(
    "chapter-1.html",
    "https://archiveofourown.org/works/7700201/chapters/9900001",
  );
  assert.equal(item.chn, 1);
  assert.equal(item.sm, WORK_SUMMARY);
});

test("collectAO3Work never reports a chapter 2+ summary as the work summary", () => {
  const item = collectSummaryFixture(
    "chapter-2.html",
    "https://archiveofourown.org/works/7700201/chapters/9900002",
  );
  assert.equal(item.chn, 2);
  assert.equal(item.sm, null, "the work preface has no summary on later chapters");
});

test("collectAO3Work keeps the work summary on the Entire Work view", () => {
  const item = collectSummaryFixture(
    "entire-work.html",
    "https://archiveofourown.org/works/7700201?view_full_work=true",
  );
  assert.equal(item.sm, WORK_SUMMARY, "chapter summaries further down are ignored");
});

test("collectAO3Work keeps a summary's paragraphs and line breaks apart", () => {
  const html = loadFixture(path.join("ao3-work-summary", "one-shot.html")).replace(
    "<p>One evening, one lamp, one detective.</p>",
    "<p>Set after the finale, canon-compliant.</p><p>1971 - 1995</p><p>This IS a <em>slow</em>\n   burn.<br>Mostly.</p>",
  );
  const dom = new JSDOM(html, { url: "https://archiveofourown.org/works/7700202", runScripts: "outside-only" });
  const { collectAO3Work } = createCollectorBindings(dom);
  assert.equal(
    collectAO3Work().sm,
    "Set after the finale, canon-compliant.\n\n1971 - 1995\n\nThis IS a slow burn.\nMostly.",
  );
});

test("collectAO3Work reads a one-shot's summary", () => {
  const item = collectSummaryFixture(
    "one-shot.html",
    "https://archiveofourown.org/works/7700202",
  );
  assert.equal(item.sm, "One evening, one lamp, one detective.");
});

const CHAPTER_2_URL = "https://archiveofourown.org/works/7700201/chapters/9900002";

function backfillHarness({ fetchImpl, prefs = {} } = {}) {
  const dom = domFromFixture(path.join("ao3-work-summary", "chapter-2.html"), CHAPTER_2_URL);
  const sent = [];
  const fetchCalls = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, cb) {
        sent.push(message);
        if (typeof cb === "function") cb({ ok: true });
      },
      lastError: null,
    },
    storage: { local: { get(keys, cb) { cb({ ...prefs }); } } },
  };
  const fetch = (url, init) => {
    fetchCalls.push({ url, init });
    return fetchImpl(url, init);
  };
  const bindings = createCollectorBindings(dom, { chrome, fetch, scopeStorageContext: false });
  return { ...bindings, sent, fetchCalls, item: bindings.collectAO3Work() };
}

function okHtml(name) {
  const html = loadFixture(path.join("ao3-work-summary", name));
  return () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
}

test("work summary backfill only targets AO3 chapter 2+ pages without a work summary", () => {
  const { workSummaryBackfillWorkId, item } = backfillHarness({ fetchImpl: okHtml("chapter-1.html") });
  assert.equal(workSummaryBackfillWorkId(item), "7700201");
  assert.equal(workSummaryBackfillWorkId({ ...item, sm: "Known" }), null, "a page with a work summary needs nothing");
  assert.equal(workSummaryBackfillWorkId({ ...item, chn: 1 }), null, "chapter 1 carries the summary itself");
  assert.equal(workSummaryBackfillWorkId({ ...item, chu: null }), null, "Entire Work has no chapter URL");
  assert.equal(
    workSummaryBackfillWorkId({ ...item, chu: "https://archiveofourown.org/works/1/chapters/2" }),
    null,
    "the chapter URL must belong to the same work",
  );
  assert.equal(workSummaryBackfillWorkId({ ...item, src: "ffn" }), null);
  assert.equal(workSummaryBackfillWorkId({ ...item, ctx: "listing" }), null);
});

test("work summary backfill parses only the work preface of a fetched page", () => {
  const { parseAo3WorkSummaryFromHtml } = backfillHarness({ fetchImpl: okHtml("chapter-1.html") });
  assert.equal(parseAo3WorkSummaryFromHtml(loadFixture(path.join("ao3-work-summary", "chapter-1.html"))), WORK_SUMMARY);
  assert.equal(parseAo3WorkSummaryFromHtml(loadFixture(path.join("ao3-work-summary", "chapter-2.html"))), null);
  assert.equal(parseAo3WorkSummaryFromHtml("<html><body>Retry later</body></html>"), null);
});

test("work summary backfill reports the summary as the work's first page", () => {
  const { workSummaryBackfillItem, item } = backfillHarness({ fetchImpl: okHtml("chapter-1.html") });
  const out = workSummaryBackfillItem(item, WORK_SUMMARY);
  assert.equal(out.sm, WORK_SUMMARY);
  assert.equal(out.chn, 1);
  assert.equal(out.chu, null);
  assert.equal(out.u, item.u);
  assert.equal(out.t, item.t);
  assert.equal(item.sm, null, "the collected item is not changed");
  assert.equal(item.chn, 2);
});

test("work summary backfill fetches chapter 1 once, past the adult notice, then broadcasts it", async () => {
  const h = backfillHarness({ fetchImpl: okHtml("chapter-1.html") });
  assert.equal(h.maybeBackfillWorkSummary(h.item), true);
  assert.equal(h.maybeBackfillWorkSummary(h.item), false, "a second save of the same work does not fetch again");
  await delay(1_800);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0].url, "https://archiveofourown.org/works/7700201?view_adult=true");
  assert.equal(h.fetchCalls[0].init.credentials, "include");
  const broadcasts = h.sent.filter((m) => m && m.type === "TRACE_METADATA_BROADCAST");
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].payload.item.sm, WORK_SUMMARY);
  assert.equal(broadcasts[0].payload.item.chn, 1);
  assert.equal(broadcasts[0].payload.item.chu, null);
  assert.equal(h.maybeBackfillWorkSummary(h.item), false, "remembered for the rest of the day");
});

test("work summary backfill respects the reader's metadata setting", async () => {
  const h = backfillHarness({
    fetchImpl: okHtml("chapter-1.html"),
    prefs: { prefMetadataImproveEnabled: false },
  });
  h.maybeBackfillWorkSummary(h.item);
  await delay(1_800);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.sent.filter((m) => m && m.type === "TRACE_METADATA_BROADCAST").length, 0);
});

test("work summary backfill stays silent and backs off when AO3 refuses", async () => {
  const h = backfillHarness({
    fetchImpl: () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("") }),
  });
  assert.equal(h.maybeBackfillWorkSummary(h.item), true);
  await delay(1_800);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.sent.filter((m) => m && m.type === "TRACE_METADATA_BROADCAST").length, 0);
  const another = { ...h.item, u: "https://archiveofourown.org/works/7700299", chu: "https://archiveofourown.org/works/7700299/chapters/5" };
  assert.equal(h.maybeBackfillWorkSummary(another), false, "no new requests during the back-off");
});

test("work summary backfill fails silently when the request throws", async () => {
  const h = backfillHarness({ fetchImpl: () => Promise.reject(new Error("offline")) });
  assert.equal(h.maybeBackfillWorkSummary(h.item), true);
  await delay(1_800);
  assert.equal(h.sent.filter((m) => m && m.type === "TRACE_METADATA_BROADCAST").length, 0);
});

function authorFixtureDom(name, url) {
  return domFromFixture(path.join("ao3-author", name), url);
}

test("collectAO3Work gives an anonymous work no author, never a commenter or translator", () => {
  const dom = authorFixtureDom("anonymous-work-comments.html", "https://archiveofourown.org/works/41000010");
  const item = createCollectorBindings(dom).collectAO3Work();
  assert.equal(item.t, "The Lamplighter's Ledger");
  assert.equal(item.a, null, "the plain-text Anonymous byline has no author link");
});

test("collectAO3Work reads the first creator of a co-authored work, including a pseud", () => {
  const dom = authorFixtureDom("co-authored-work.html", "https://archiveofourown.org/works/41000012");
  assert.equal(createCollectorBindings(dom).collectAO3Work().a, "Quill Fennimore");
});

test("AO3 bookmark blurbs never report the bookmarker or a gift recipient as the author", () => {
  const dom = authorFixtureDom("anonymous-bookmarks.html", "https://archiveofourown.org/users/Ink_Reader_Test/bookmarks");
  const items = plainJson(createCollectorBindings(dom).collect().items);
  const anonymous = items.find((i) => i.u.includes("/works/41000011"));
  const coAuthored = items.find((i) => i.u.includes("/works/41000012"));
  assert.equal(anonymous.ctx, "bookmark");
  assert.equal(anonymous.a, null);
  assert.equal(coAuthored.a, "Quill Fennimore");
  assert.ok(items.every((i) => i.a !== "Ink_Reader_Test" && i.a !== "Hollis_Wren"));
});

test("existing AO3 bookmark fixture keeps blurb authors, not the bookmarker", () => {
  const dom = domFromFixture("ao3_bookmarks.html", "https://archiveofourown.org/users/Ink_Reader_Test/bookmarks");
  const items = plainJson(createCollectorBindings(dom).collect().items);
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.a !== "Whimsy_FF"));
});

test("collectAO3Work emits current chapter URL without query or hash", () => {
  const dom = domFromFixture(
    "ao3_story.html",
    "https://archiveofourown.org/works/28534965/chapters/69925506?show_comments=true#workskin"
  );
  const { collectAO3Work } = createCollectorBindings(dom);
  const item = collectAO3Work();

  assert.equal(item.u, "https://archiveofourown.org/works/28534965");
  assert.equal(item.chu, "https://archiveofourown.org/works/28534965/chapters/69925506");
});

test("collectAO3Work treats a fully rendered AO3 Entire Work page as the latest chapter", () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">Entire Work</h2>
      <h3 class="byline heading"><a rel="author">Author</a></h3>
      <ul class="required-tags"><li><span title="Complete Work">Complete Work</span></li></ul>
      <dl class="work meta group"><dd class="chapters">3/3</dd></dl>
      <div id="chapters">
        <div class="chapter" id="chapter-101"><div class="userstuff module" role="article">One</div></div>
        <div class="chapter" id="chapter-205"><div class="userstuff module" role="article">Two</div></div>
        <div class="chapter" id="chapter-999"><div class="userstuff module" role="article">Three</div></div>
      </div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/123?view_full_work=true",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const { collectAO3Work } = createCollectorBindings(dom);
  const item = collectAO3Work();

  assert.equal(item.chn, 3);
  assert.equal(item.chPub, 3);
  assert.equal(item.cht, 3);
  assert.equal(item.chu, null, "Entire Work does not invent a single-chapter URL");

  dom.window.document.querySelector("#chapter-999").remove();
  assert.equal(
    collectAO3Work().chn,
    2,
    "a partially rendered Entire Work page must not claim the final published chapter",
  );
});

test("collector disables Trace collection on pages with password fields", () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><input type='password' name='password'></body></html>",
    {
      url: "https://archiveofourown.org/users/login",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const { shouldDisableTraceContentScript } = createCollectorBindings(dom);
  assert.equal(shouldDisableTraceContentScript(), true);
});

test("detectAo3CurrentChapterNumber prefers selected chapter over next-chapter nav link", () => {
  const html = `<!doctype html><html><body>
    <select id="selected_id">
      <option value="111">1. Beginning</option>
      <option value="222">2. Middle</option>
      <option value="456" selected>3. Current chapter</option>
      <option value="999">4. Next chapter</option>
    </select>
    <div class="chapter navigation actions">
      <a href="/works/123/chapters/999">Chapter 4</a>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(detectAo3CurrentChapterNumber(), 3);
});

test("detectAo3CurrentChapterNumber prefers selected option label over dropdown index", () => {
  const html = `<!doctype html><html><body>
    <select id="selected_id">
      <option value="all">Entire Work</option>
      <option value="456" selected>10. Current chapter</option>
      <option value="789">11. Next chapter</option>
    </select>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(detectAo3CurrentChapterNumber(), 10);
});

test("detectAo3CurrentChapterNumber prefers AO3 ordinal over chapter number in title", () => {
  const html = `<!doctype html><html><body>
    <select id="selected_id">
      <option value="111">11. Chapter 10 - Previous</option>
      <option value="456" selected>12. Chapter 11 - Please Move On Good Lord</option>
    </select>
    <div id="chapters">
      <div class="chapter" id="chapter-12">
        <div class="chapter preface group">
          <h3 class="title"><a href="/works/123/chapters/456">Chapter 12</a>: Chapter 11 - Please Move On Good Lord</h3>
        </div>
      </div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(detectAo3CurrentChapterNumber(), 12);
});

test("detectAo3CurrentChapterNumber prefers chapter container id over ambiguous jump menu", () => {
  const html = `<!doctype html><html><body>
    <div id="chapters">
      <div class="chapter" id="chapter-10">
        <div class="chapter preface group">
          <h3 class="title"><a href="/works/123/chapters/456">Chapter 10</a>: Current</h3>
        </div>
      </div>
    </div>
    <select id="selected_id">
      <option value="all">Entire Work</option>
      <option value="10" selected>Current chapter title only</option>
      <option value="11">Next chapter title only</option>
    </select>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(detectAo3CurrentChapterNumber(), 10);
});

test("detectAo3CurrentChapterNumber matches the URL chapter id before a wrong selected option", () => {
  const html = `<!doctype html><html><body>
    <select id="selected_id">
      <option value="all">Entire Work</option>
      <option value="456">43. Current chapter</option>
      <option value="789" selected>44. Next chapter</option>
    </select>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(detectAo3CurrentChapterNumber(), 43);
});

test("detectAo3CurrentChapterNumber infers chapter ordinal from the matching AO3 chapter id", () => {
  const html = `<!doctype html><html><body>
    <select id="selected_id">
      <option value="all">Entire Work</option>
      <option value="111">Earlier chapter</option>
      <option value="456">Current chapter title only</option>
      <option value="789" selected>44. Next chapter</option>
    </select>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(detectAo3CurrentChapterNumber(), 2);
});

test("hasStableAo3ChapterSignal is false when only next-chapter selected state is present", () => {
  const html = `<!doctype html><html><body>
    <select id="selected_id">
      <option value="all">Entire Work</option>
      <option value="opaque-current-id">43. Current chapter</option>
      <option value="opaque-next-id" selected>44. Next chapter</option>
    </select>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { hasStableAo3ChapterSignal } = createCollectorBindings(dom);
  assert.equal(hasStableAo3ChapterSignal(), false);
});

test("hasStableAo3ChapterSignal becomes true once the chapter title link matches the URL chapter id", () => {
  const html = `<!doctype html><html><body>
    <select id="selected_id">
      <option value="opaque-current-id">43. Current chapter</option>
      <option value="opaque-next-id" selected>44. Next chapter</option>
    </select>
    <div class="chapter preface group">
      <h3 class="title"><a href="/works/123/chapters/456">Chapter 43</a>: Current</h3>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { hasStableAo3ChapterSignal, detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(hasStableAo3ChapterSignal(), true);
  assert.equal(detectAo3CurrentChapterNumber(), 43);
});

test("shouldDelayAutoTrackUntilVisible waits for hidden or prerendered documents", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { shouldDelayAutoTrackUntilVisible } = createCollectorBindings(dom);

  dom.window.document.hasFocus = () => false;
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    get() {
      return "hidden";
    },
  });
  assert.equal(shouldDelayAutoTrackUntilVisible(), true);

  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    get() {
      return "visible";
    },
  });
  Object.defineProperty(dom.window.document, "prerendering", {
    configurable: true,
    get() {
      return true;
    },
  });
  assert.equal(shouldDelayAutoTrackUntilVisible(), true);

  Object.defineProperty(dom.window.document, "prerendering", {
    configurable: true,
    get() {
      return false;
    },
  });
  assert.equal(shouldDelayAutoTrackUntilVisible(), false);

  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    get() {
      return "hidden";
    },
  });
  dom.window.document.hasFocus = () => true;
  assert.equal(shouldDelayAutoTrackUntilVisible(), false);
});

test("storyMetadataFingerprint ignores current chapter progress", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { storyMetadataFingerprint } = createCollectorBindings(dom);

  const base = {
    src: "ao3",
    u: "https://archiveofourown.org/works/123",
    t: "Example",
    a: "Author",
    chn: 3,
    cht: 20,
    chPub: 18,
    chars: ["B", "A"],
    tags: ["Slow Burn"],
    sm: "Summary",
  };

  assert.equal(
    storyMetadataFingerprint(base),
    storyMetadataFingerprint({
      ...base,
      chn: 4,
      chu: "https://archiveofourown.org/works/123/chapters/789",
    }),
  );
});

test("successful story updates can clear stale auto-track pending state", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/9001/15/Corrected-Total",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { clearStoryOverlayTransientState } = createCollectorBindings(dom);
  const entry = clearStoryOverlayTransientState({
    entryId: "00000000-0000-4000-8000-000000009001",
    status: "READING",
    readerStatus: "READING",
    chapters: { current: 15, total: 15 },
    __traceAutoTrackPending: true,
  });

  assert.equal(entry.__traceAutoTrackPending, undefined);
  assert.equal(entry.status, "READING");
  assert.deepEqual(plainJson(entry.chapters), { current: 15, total: 15 });
});

test("auto-track dedupe does not suppress upgraded AO3 chapter URL payloads", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { rememberRecentAutoTrack, shouldSkipRecentAutoTrack } =
    createCollectorBindings(dom);
  const base = {
    src: "ao3",
    u: "https://archiveofourown.org/works/123",
    t: "Example",
    a: "Author",
    chn: 52,
    cht: 70,
  };

  rememberRecentAutoTrack(base);

  assert.equal(shouldSkipRecentAutoTrack(base), true);
  assert.equal(
    shouldSkipRecentAutoTrack({
      ...base,
      chu: "https://archiveofourown.org/works/123/chapters/789",
    }),
    false,
  );
});

test("shouldBroadcastMetadata skips repeat chapter navigation for unchanged story metadata", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { shouldBroadcastMetadata, rememberMetadataBroadcast } = createCollectorBindings(dom);

  const chapter3 = {
    src: "ao3",
    u: "https://archiveofourown.org/works/123",
    t: "Example",
    a: "Author",
    chn: 3,
    cht: 20,
    chPub: 18,
    chars: ["A", "B"],
    tags: ["Slow Burn"],
    sm: "Summary",
  };
  const chapter4 = { ...chapter3, chn: 4 };

  assert.equal(shouldBroadcastMetadata(chapter3), true);
  rememberMetadataBroadcast(chapter3);
  assert.equal(shouldBroadcastMetadata(chapter4), false);
});

test("shouldBroadcastMetadata allows rebroadcast when story-level metadata changes", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { shouldBroadcastMetadata, rememberMetadataBroadcast } = createCollectorBindings(dom);

  const initial = {
    src: "ao3",
    u: "https://archiveofourown.org/works/123",
    t: "Example",
    a: "Author",
    chn: 3,
    cht: 20,
    chPub: 18,
    chars: ["A", "B"],
    tags: ["Slow Burn"],
    sm: "Summary",
  };
  const updated = { ...initial, chn: 4, chPub: 19 };

  rememberMetadataBroadcast(initial);
  assert.equal(shouldBroadcastMetadata(updated), true);
});

function createAutoTrackCollectorHarness(response, options = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/28534965",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const store = {
    authToken: "test-token",
    libraryOverlayCache: { entries: {}, syncVersion: "v0" },
  };
  const sentMessages = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(message, cb) {
        sentMessages.push(message);
        if (message.type === "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE") {
          if (typeof cb === "function") cb({ ok: true });
          return;
        }
        if (options.lastError) {
          chrome.runtime.lastError = { message: options.lastError };
          cb();
          chrome.runtime.lastError = null;
          return;
        }
        cb(response);
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
              out[key] = store[key];
            }
          }
          cb(out);
        },
        set(value, cb) {
          Object.assign(store, value || {});
          if (options.runStorageSetCallback && typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };
  if (options.userAgent) {
    Object.defineProperty(dom.window.navigator, "userAgent", {
      value: options.userAgent,
      configurable: true,
    });
  }
  const bindings = createCollectorBindings(dom, { chrome });
  return { dom, store, sentMessages, bindings };
}

test("sendAutoTrackForStory clears retryable failures but retains a capacity-block marker", () => {
  const failures = [
    undefined,
    { ok: false, error: "auth_expired" },
    { ok: false, error: "free_limit_reached", capacity: { blocked: true, prompt: true } },
    { ok: false, error: "http_503" },
    { ok: false, error: "network_error" },
    { ok: false, error: "auto_track_disabled" },
  ];
  const item = {
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/28534965",
    t: "Redivider",
    chn: 3,
    cht: 17,
  };

  for (const response of failures) {
    const { dom, store, sentMessages, bindings } =
      createAutoTrackCollectorHarness(response);
    bindings.sendAutoTrackForStory(item);

    assert.equal(
      dom.window.sessionStorage.getItem("trace:auto-track:last") !== null,
      response?.error === "free_limit_reached",
    );
    assert.equal(
      sentMessages.filter((message) => message.type === "TRACE_AUTO_TRACK").length,
      1,
    );
    assert.deepEqual(plainJson(store.libraryOverlayCache.entries), {});
    if (response?.error === "free_limit_reached") {
      const notice = dom.window.document.querySelector("[data-trace-capacity-notice]");
      assert.ok(notice);
      const upgrade = Array.from(notice.querySelectorAll("a")).find((link) =>
        /See Trace Unlimited/i.test(link.textContent || "")
      );
      assert.equal(
        upgrade?.href,
        "https://tracefiction.com/?upgrade=1&source=extension_cap",
      );
      assert.deepEqual(
        plainJson(sentMessages.find((message) =>
          message.type === "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE"
        )),
        {
          type: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE",
          action: "shown",
          surface: "story",
        },
      );
    }
  }
});

test("an automatic save at the Free limit shows the notice only when the background's spacing allows it", () => {
  const item = {
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/28534965",
    t: "Redivider",
    chn: 3,
    cht: 17,
  };
  for (const [capacity, shown] of [
    [{ blocked: true, prompt: true }, true],
    // Shown within the last day, or "Not now" within the last week.
    [{ blocked: true, prompt: false }, false],
    // No capacity state: nothing to space the notice by, so it stays quiet.
    [undefined, false],
  ]) {
    const { dom, sentMessages, bindings } = createAutoTrackCollectorHarness({
      ok: false,
      error: "free_limit_reached",
      ...(capacity ? { capacity } : {}),
    });
    bindings.sendAutoTrackForStory(item);
    const notice = dom.window.document.querySelector("[data-trace-capacity-notice]");
    assert.equal(Boolean(notice), shown, JSON.stringify(capacity));
    assert.equal(
      sentMessages.some((message) => message.type === "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE"),
      shown,
    );
  }
});

test("Not now on the Library full notice is acknowledged as a dismissal", () => {
  const { dom, sentMessages, bindings } = createAutoTrackCollectorHarness({
    ok: false,
    error: "free_limit_reached",
    capacity: { blocked: true, prompt: true },
  });
  bindings.sendAutoTrackForStory({
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/28534965",
    t: "Redivider",
    chn: 3,
    cht: 17,
  });
  const notice = dom.window.document.querySelector("[data-trace-capacity-notice]");
  const dismiss = Array.from(notice.querySelectorAll("button")).find((button) =>
    button.textContent === "Not now"
  );
  dismiss.click();
  assert.equal(dom.window.document.querySelector("[data-trace-capacity-notice]"), null);
  assert.deepEqual(
    plainJson(sentMessages.filter((message) => message.type === "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE")),
    [
      { type: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE", action: "shown", surface: "story" },
      { type: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE", action: "dismissed", surface: "story" },
    ],
  );
});

test("the Library full notice opens the Trace app on iPhone and iPad, and the website elsewhere", () => {
  for (const [userAgent, upgradeUrl, manageUrl, target] of [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      "traceauth://open?destination=unlimited",
      "traceauth://open?destination=library",
      null,
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      "https://tracefiction.com/?upgrade=1&source=extension_cap",
      "https://tracefiction.com/",
      "_blank",
    ],
  ]) {
    const { dom, bindings } = createAutoTrackCollectorHarness(
      { ok: false, error: "free_limit_reached", capacity: { blocked: true, prompt: true } },
      { userAgent },
    );
    bindings.sendAutoTrackForStory({
      src: "ao3",
      ctx: "story",
      u: "https://archiveofourown.org/works/28534965",
      t: "Redivider",
      chn: 3,
      cht: 17,
    });
    const links = Array.from(
      dom.window.document.querySelectorAll("[data-trace-capacity-notice] a"),
    );
    const upgrade = links.find((link) => link.textContent === "See Trace Unlimited");
    const manage = links.find((link) => link.textContent === "Manage library");
    assert.equal(upgrade.getAttribute("href"), upgradeUrl);
    assert.equal(manage.getAttribute("href"), manageUrl);
    assert.equal(upgrade.getAttribute("target"), target);
  }
});

test("sendAutoTrackForStory clears dedupe marker when runtime messaging fails", () => {
  const item = {
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/28534965",
    t: "Redivider",
    chn: 3,
    cht: 17,
  };
  const { dom, store, sentMessages, bindings } =
    createAutoTrackCollectorHarness(undefined, { lastError: "message port closed" });

  bindings.sendAutoTrackForStory(item);

  assert.equal(sentMessages.length, 1);
  assert.equal(dom.window.sessionStorage.getItem("trace:auto-track:last"), null);
  assert.deepEqual(plainJson(store.libraryOverlayCache.entries), {});
});

test("sendAutoTrackForStory clears dedupe marker for ignored senders so activated pages can retry", () => {
  const item = {
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/28534965",
    t: "Redivider",
    chn: 3,
    cht: 17,
  };
  const { dom, store, bindings } = createAutoTrackCollectorHarness({
    ok: false,
    error: "ignored_sender",
  });

  bindings.sendAutoTrackForStory(item);

  assert.equal(dom.window.sessionStorage.getItem("trace:auto-track:last"), null);
  assert.deepEqual(plainJson(store.libraryOverlayCache.entries), {});
});

test("sendAutoTrackForStory does not synthesize saved state from entryId-only ack", () => {
  const item = {
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/28534965",
    t: "Redivider",
    chn: 3,
    cht: 17,
  };
  const { dom, store, bindings } = createAutoTrackCollectorHarness({
    ok: true,
    entryId: "00000000-0000-4000-8000-000000285349",
  });

  bindings.sendAutoTrackForStory(item);

  assert.notEqual(dom.window.sessionStorage.getItem("trace:auto-track:last"), null);
  assert.deepEqual(plainJson(store.libraryOverlayCache.entries), {});
});

function createScriptedAutoTrackHarness(replies) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/28534965",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const store = { authToken: "test-token", libraryOverlayCache: { entries: {}, syncVersion: "v0" } };
  const sentMessages = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(message, cb) {
        sentMessages.push(message);
        const reply = replies[message.type];
        const next = Array.isArray(reply) ? reply.shift() : reply;
        if (typeof cb === "function") cb(next);
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          cb(out);
        },
        set(value, cb) {
          Object.assign(store, value || {});
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };
  const bindings = createCollectorBindings(dom, { chrome });
  return { dom, sentMessages, bindings };
}

const SCRIPTED_STORY = Object.freeze({
  src: "ao3",
  ctx: "story",
  u: "https://archiveofourown.org/works/28534965",
  t: "Redivider",
  chn: 1,
  cht: 1,
});
const SCRIPTED_ENTRY_ID = "00000000-0000-4000-8000-000000285349";
const SCRIPTED_SAVED_STATE = Object.freeze({
  workKey: "ao3:28534965",
  status: "saved",
  entryId: SCRIPTED_ENTRY_ID,
  entry: {
    status: "PLANNING",
    readerStatus: "PLANNING",
    canonicalReaderStatus: "SAVED",
    entryId: SCRIPTED_ENTRY_ID,
    chapters: { current: 1, total: 1 },
  },
});

test("an automatic save the background couldn't check is sent once more before the page says it wasn't saved", async () => {
  const { sentMessages, bindings } = createScriptedAutoTrackHarness({
    TRACE_AUTO_TRACK: [
      { ok: false, error: "unavailable" },
      { ok: true, entryId: SCRIPTED_ENTRY_ID, state: SCRIPTED_SAVED_STATE },
    ],
  });
  bindings.sendAutoTrackForStory({ ...SCRIPTED_STORY });
  const autoTracks = () => sentMessages.filter((message) => message.type === "TRACE_AUTO_TRACK").length;
  assert.equal(autoTracks(), 1);
  const pending = bindings.optimisticStoryPageEntries()["ao3:28534965"];
  assert.equal(pending.__traceAutoTrackError ?? null, null, "no failure is shown before the retry");
  assert.equal(pending.__traceAutoTrackPending, true);
  await delay(1_700);
  assert.equal(autoTracks(), 2);
  const saved = bindings.optimisticStoryPageEntries()["ao3:28534965"];
  assert.equal(saved.__traceAutoTrackError, null);
  assert.equal(saved.entryId, SCRIPTED_ENTRY_ID);
});

test("an automatic save is retried at most once for a background that couldn't check", async () => {
  const { sentMessages, bindings } = createScriptedAutoTrackHarness({
    TRACE_AUTO_TRACK: [{ ok: false, error: "unavailable" }, { ok: false, error: "unavailable" }],
  });
  bindings.sendAutoTrackForStory({ ...SCRIPTED_STORY });
  await delay(1_700);
  assert.equal(sentMessages.filter((message) => message.type === "TRACE_AUTO_TRACK").length, 2);
  assert.equal(bindings.optimisticStoryPageEntries()["ao3:28534965"].__traceAutoTrackError, "unavailable");
});

test("a failed automatic save gives way to the story's saved state when it is checked again", () => {
  const { sentMessages, bindings } = createScriptedAutoTrackHarness({
    TRACE_AUTO_TRACK: [{ ok: false, error: "http_503" }],
    TRACE_WORK_STATE_GET: [{ ok: true, state: SCRIPTED_SAVED_STATE }],
  });
  bindings.sendAutoTrackForStory({ ...SCRIPTED_STORY });
  assert.equal(bindings.optimisticStoryPageEntries()["ao3:28534965"].__traceAutoTrackError, "http_503");
  bindings.recheckAutoTrackFailureForStory("ao3:28534965");
  assert.equal(sentMessages.filter((message) => message.type === "TRACE_WORK_STATE_GET").length, 1);
  const entry = bindings.optimisticStoryPageEntries()["ao3:28534965"];
  assert.equal(entry.__traceAutoTrackError, null);
  assert.equal(entry.entryId, SCRIPTED_ENTRY_ID);
  bindings.recheckAutoTrackFailureForStory("ao3:28534965");
  assert.equal(
    sentMessages.filter((message) => message.type === "TRACE_WORK_STATE_GET").length,
    1,
    "a page without a failure doesn't ask again",
  );
});

test("the story handle asks only a reader who was connected before to reconnect", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/28534965",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  installCollectorChrome(dom, createChromeMockForHooks());
  dom.window.eval(collectorTestSource(fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"), "utf8")));
  const hooks = dom.window.__traceTestHooks;
  const returning = { hasAuth: false, authState: { state: "reconnect_required", reason: "credential_rejected" } };
  const firstTime = { hasAuth: false, authState: { ...returning.authState, neverConnected: true } };

  assert.equal(hooks.storyHeadline(returning), "Reconnect Trace");
  assert.equal(hooks.handleDisplay(returning), "Reconnect Trace");
  assert.equal(hooks.storyCaption(returning), "Your session needs a refresh.");

  assert.equal(hooks.storyHeadline(firstTime), "Connect Trace");
  assert.equal(hooks.handleDisplay(firstTime), "Connect Trace");
  assert.doesNotMatch(hooks.storyCaption(firstTime), /reconnect|refresh/i);
  dom.window.close();
});

test("the Library-full page notices use the Trace app's words", () => {
  const sentence = "Your Library is full. Everything saved stays. See Trace Unlimited, or remove a story to make room.";
  for (const [file, count] of [["collector.js", 2], ["library-overlay.js", 1]]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", file), "utf8");
    assert.equal(source.split(sentence).length - 1, count, file);
    assert.doesNotMatch(source, /Make room in Trace, or see Trace Unlimited/, file);
  }
});

test("the story handle never shows a bare Error", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/28534965",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  installCollectorChrome(dom, createChromeMockForHooks());
  dom.window.eval(collectorTestSource(fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"), "utf8")));
  const hooks = dom.window.__traceTestHooks;
  for (const error of ["network_error", "unavailable", "http_503", "reconnect_required"]) {
    const view = { hasAuth: true, entry: { __traceAutoTrackError: error } };
    assert.equal(hooks.storyHandlePresentation(view).label, "Not saved");
    assert.equal(hooks.handleDisplay(view), "Not saved");
  }
  assert.notEqual(hooks.handleDisplay({ hasAuth: false, authState: { state: "error" } }), "Error");
  for (const file of ["collector.js", "library-overlay.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", file), "utf8");
    assert.doesNotMatch(source, /(?:textContent = |label: |return )"Error"/, file);
  }
  dom.window.close();
});

test("a saved story's handle names its chapter as the popup's sheet does", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/28534965",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  installCollectorChrome(dom, createChromeMockForHooks());
  dom.window.eval(collectorTestSource(fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"), "utf8")));
  const hooks = dom.window.__traceTestHooks;
  const saved = (chapters) => ({
    hasAuth: true,
    entry: { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", chapters },
  });
  const drawn = (view) => {
    const handle = dom.window.document.createElement("button");
    hooks.applyStoryInlineHandleState(handle, hooks.storyHandlePresentation(view));
    return handle;
  };

  // Chapter known: the same words and middle dot as the popup's record label.
  for (const [chapters, label, spoken] of [
    [{ current: 31, total: null }, "Saved · Chapter 31", "Trace: Saved to your Library, chapter 31"],
    [{ current: 31, total: 40 }, "Saved · Chapter 31 of 40", "Trace: Saved to your Library, chapter 31 of 40"],
  ]) {
    const view = saved(chapters);
    assert.equal(hooks.storyHandlePresentation(view).label, label);
    assert.equal(hooks.handleDisplay(view), label);
    const handle = drawn(view);
    assert.equal(handle.textContent, label);
    assert.equal(handle.getAttribute("aria-label"), spoken);
    assert.equal(handle.getAttribute("data-trace-story-handle-state"), "status");
    assert.equal(handle.getAttribute("data-trace-story-status"), "SAVED");
    assert.ok(handle.querySelector("svg"), "the chevron still follows the label");
  }

  // Chapter unknown: plain Saved, as before.
  for (const chapters of [undefined, null, { current: null, total: 12 }, { current: 0, total: 12 }]) {
    const view = saved(chapters);
    assert.equal(hooks.storyHandlePresentation(view).label, "Saved");
    assert.equal(hooks.handleDisplay(view), "Saved");
    const handle = drawn(view);
    assert.equal(handle.textContent, "Saved");
    assert.equal(handle.getAttribute("aria-label"), "Trace: Saved to your Library");
  }

  // Other statuses keep their compact progress.
  const reading = { hasAuth: true, entry: { canonicalReaderStatus: "READING", chapters: { current: 2, total: 28 } } };
  assert.equal(hooks.storyHandlePresentation(reading).label, "Reading");
  assert.equal(hooks.storyHandlePresentation(reading).progress, "2/28");
  dom.window.close();
});

function createChromeMockForHooks() {
  return {
    runtime: { onMessage: { addListener() {} }, lastError: null, sendMessage() {} },
    storage: {
      local: { get(_keys, cb) { cb({}); }, set(_value, cb) { if (typeof cb === "function") cb(); } },
      onChanged: { addListener() {} },
    },
  };
}

test("detectAo3CurrentChapterNumber prefers the visible chapter heading text", () => {
  const html = `<!doctype html><html><body>
    <div id="chapters">
      <div class="chapter preface group">
        <h3 class="title">Chapter 42: Chapter 42</h3>
      </div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/works/123/chapters/456",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { detectAo3CurrentChapterNumber } = createCollectorBindings(dom);
  assert.equal(detectAo3CurrentChapterNumber(), 42);
});

test("collectAO3Listings keeps a blurb summary's paragraphs apart", () => {
  const html = `<!doctype html><html><body>
  <li id="work_999992" class="work blurb group" role="article">
    <div class="header module">
      <h4 class="heading"><a href="/works/999992">Two paragraphs</a></h4>
    </div>
    <blockquote class="userstuff summary"><p>canon-compliant.</p><p>1971 - 1995</p></blockquote>
  </li></body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/tags/Example/works",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { collectAO3Listings } = createCollectorBindings(dom);
  assert.equal(collectAO3Listings()[0].sm, "canon-compliant.\n\n1971 - 1995");
});

test("collectAO3Listings: warnings from required-tags symbol titles when tag ul absent", () => {
  const html = `<!doctype html><html><body>
  <li id="work_999991" class="work blurb group" role="article">
    <div class="header module">
      <h4 class="heading"><a href="/works/999991">Symbol-only blurbs</a></h4>
    </div>
    <ul class="required-tags">
      <li><span class="rating-explicit rating" title="Explicit"><span class="text">Explicit</span></span></li>
      <li><span class="warning-yes warnings" title="Graphic Depictions Of Violence, Major Character Death"><span class="text">Graphic Depictions Of Violence, Major Character Death</span></span></li>
    </ul>
  </li></body></html>`;
  const dom = new JSDOM(html, {
    url: "https://archiveofourown.org/tags/Example/works",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { collectAO3Listings } = createCollectorBindings(dom);
  const items = collectAO3Listings();
  assert.equal(items.length, 1);
  assert.equal(items[0].u, "https://archiveofourown.org/works/999991");
  assertIncludesAll(items[0].wrn, [
    "Graphic Depictions Of Violence",
    "Major Character Death",
  ]);
});

test("collectAO3Listings (ao3_listing.html): first blurb + Redivider row", () => {
  const dom = domFromFixture(
    "ao3_listing.html",
    "https://archiveofourown.org/tags/Harry%20Potter/works"
  );
  const { collectAO3Listings } = createCollectorBindings(dom);
  const items = collectAO3Listings();
  assert.ok(items.length >= 3);

  const first = items.find((r) => r.u.includes("/works/10404927"));
  assert.ok(first);
  assert.equal(first.t, "Harry Potter and the Shadowed Light");
  assert.equal(first.ctx, "listing");
  assert.equal(first.a, "WritingbyAnnie");
  assert.equal(first.r, "Mature");
  assert.equal(first.s, "wip");
  assert.equal(first.l, "English");
  assert.equal(first.w, 319220);
  assert.equal(first.k, 43918);
  assert.equal(first.h, 1873034);
  assert.equal(first.bk, 13292);
  assert.equal(first.cc, 5581);
  assert.equal(first.chn, 1, "legacy chn stays 1 for auto-track compat");
  assert.equal(first.chPub, 51, "AO3 published count for import UI");
  assert.equal(first.cht, 52);
  assert.equal(first.pub, null);
  assert.equal(first.upd, "29 Mar 2026");
  assertIncludesAll(first.wrn, ["No Archive Warnings Apply"]);
  assertIncludesAll(first.cat, ["M/M"]);
  assert.ok(first.sm && first.sm.includes("Harry learns"));

  const red = items.find((r) => r.u.includes("/works/28534965"));
  assert.ok(red);
  assert.equal(red.t, "Redivider");
  assert.equal(red.ctx, "listing");
  assert.equal(red.a, "Vichan");
  assert.equal(red.k, 35626);
  assert.equal(red.h, 932952);
  assert.equal(red.bk, 7955);
  assert.equal(red.cc, 6909);
  assert.equal(red.w, 107493);
  assert.equal(red.chn, 1, "legacy chn stays 1");
  assert.equal(red.chPub, 17);
  assert.equal(red.cht, null, "17/? preserves unknown planned total");
  assertIncludesAll(red.wrn, [
    "Graphic Depictions Of Violence",
    "Major Character Death",
  ]);
  assertIncludesAll(red.cat, ["F/M", "M/M"]);
  assert.deepEqual(plainJson(red.ser), {
    name: "Mutatum",
    pos: 2,
    url: "https://archiveofourown.org/series/1637290",
  });
});

test("collectFFNStory desktop (ffn_story.html)", () => {
  const dom = domFromFixture(
    "ffn_story.html",
    "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const { collectFFNStory } = createCollectorBindings(dom);
  const item = collectFFNStory();

  assert.equal(item.src, "ffn");
  assert.equal(item.ctx, "story");
  assert.equal(item.u, "https://www.fanfiction.net/s/7038840/");
  assert.equal(item.t, "A Chance Encounter");
  assert.equal(item.a, "spectre4hire");
  assert.equal(item.r, "T");
  assert.equal(item.l, "English");
  assert.equal(item.w, 226162);
  assert.equal(item.chn, 1);
  assert.equal(item.cht, 28);
  assert.equal(item.rev, 2922);
  assert.equal(item.fav, 12274);
  assert.equal(item.fol, 10528);
  assert.equal(item.gen, "Drama/Friendship");
  assert.equal(item.pub, "1306877211");
  assert.equal(item.upd, "1489509331");
  assert.equal(item.cmp, "complete");
  assert.deepEqual(plainJson(item.fms), ["Harry Potter"]);
  assert.deepEqual(plainJson(item.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(item.rels), ["Harry P./Daphne G."]);
  assert.ok(item.sm && item.sm.includes("Slytherin!Harry"));
});

test("collectFFNStory desktop: fandom fallback strips decorated title pattern", () => {
  const html = `<!doctype html><html><head>
    <title>Fanfic: A New Player In The Force Ch 1, Star Wars | FanFiction</title>
  </head><body>
    <div id="profile_top">
      <b class="xcontrast_txt">A New Player In The Force</b>
      <a href="/u/1/tester">tester</a>
      <span class="xgray xcontrast_txt">
        Rated: Fiction T - English - Adventure - Chapters: 5 - Words: 12,345
      </span>
      <div class="xcontrast_txt">A summary that is definitely long enough for extraction.</div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://www.fanfiction.net/s/1234567/1/A-New-Player-In-The-Force",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { collectFFNStory } = createCollectorBindings(dom);
  const item = collectFFNStory();

  assert.equal(item.t, "A New Player In The Force");
  assert.deepEqual(plainJson(item.fms), ["Star Wars"]);
});

test("collectFFNStory desktop strips Trace controls from story summary", () => {
  const html = `<!doctype html><html><body>
    <div id="profile_top">
      <b class="xcontrast_txt">Button Spillover</b>
      <a href="/u/1/tester">tester</a>
      <div class="xcontrast_txt">
        This is the actual FanFiction.net story description and it should remain clean.
        <button data-trace-story-handle="1">Add to Trace</button>
        <button data-trace-hidden-action="hide">Hide</button>
      </div>
      <span class="xgray xcontrast_txt">
        Rated: Fiction T - English - Adventure - Chapters: 5 - Words: 12,345
      </span>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://www.fanfiction.net/s/1234567/1/Button-Spillover",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { collectFFNStory } = createCollectorBindings(dom);
  const item = collectFFNStory();

  assert.equal(
    item.sm,
    "This is the actual FanFiction.net story description and it should remain clean."
  );
  assert.ok(!item.sm.includes("Add to Trace"));
  assert.ok(!item.sm.includes("Hide"));
});

test("collectFFNListings desktop (ffn_listing.html): Prince of Slytherin row", () => {
  const dom = domFromFixture(
    "ffn_listing.html",
    "https://www.fanfiction.net/book/Harry-Potter/"
  );
  const { collectFFNListings } = createCollectorBindings(dom);
  const items = collectFFNListings();
  assert.ok(items.length >= 1);
  const row = items[0];
  assert.equal(row.src, "ffn");
  assert.equal(row.ctx, "listing");
  assert.equal(
    row.u,
    "https://www.fanfiction.net/s/11191235/1/Harry-Potter-and-the-Prince-of-Slytherin"
  );
  assert.equal(row.t, "Harry Potter and the Prince of Slytherin");
  assert.equal(row.a, "The Sinister Man");
  assert.equal(row.r, "T");
  assert.equal(row.l, "English");
  assert.equal(row.w, 1509826);
  assert.equal(row.chn, 1);
  assert.equal(row.cht, 171);
  assert.equal(row.rev, 20410);
  assert.equal(row.fav, 22059);
  assert.equal(row.fol, 23649);
  assert.equal(row.gen, "Adventure/Mystery");
  assert.equal(row.pub, "1429295272");
  assert.equal(row.upd, "1770098872");
  assert.equal(row.cmp, null, "no 'Status: Complete' in meta → null");
  assert.deepEqual(plainJson(row.fms), ["Harry Potter"]);
  assert.ok(row.sm && row.sm.includes("Slytherin"));
  assert.deepEqual(plainJson(row.chars), [
    "Harry P.",
    "Hermione G.",
    "Neville L.",
    "Theodore N.",
  ]);
  assert.deepEqual(plainJson(row.rels), []);
});

test("collectFFNListings desktop (ffn_listing.html): Harry Crow pairing in gray line", () => {
  const dom = domFromFixture(
    "ffn_listing.html",
    "https://www.fanfiction.net/book/Harry-Potter/"
  );
  const { collectFFNListings } = createCollectorBindings(dom);
  const items = collectFFNListings();
  const row = items.find((i) => i.t === "Harry Crow");
  assert.ok(row);
  assert.deepEqual(plainJson(row.chars), ["Harry P.", "Hermione G."]);
  assert.deepEqual(plainJson(row.rels), ["Harry P./Hermione G."]);
});

test("collectFFNListings desktop strips Trace controls from row summary", () => {
  const html = `<!doctype html><html><body>
    <div id="content_wrapper_inner">
      <div class="z-list zhover zpointer">
        <a class="stitle" href="/s/7654321/1/Button-Spillover">Button Spillover</a>
        by <a href="/u/1/tester">tester</a>
        <div class="z-indent">
          This is the real listing description that should be imported without controls.
          <span data-trace-quick-add-wrap="1"><button data-trace-quick-add="ffn:7654321">Add to Trace</button></span>
          <button data-trace-hidden-action="hide">Hide</button>
          <div class="z-padtop2 xgray">Rated: Fiction T - English - Adventure - Words: 12,345</div>
        </div>
      </div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://www.fanfiction.net/book/Example/",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { collectFFNListings } = createCollectorBindings(dom);
  const [item] = collectFFNListings();

  assert.equal(
    item.sm,
    "This is the real listing description that should be imported without controls."
  );
  assert.ok(!item.sm.includes("Add to Trace"));
  assert.ok(!item.sm.includes("Hide"));
});

test("collectTrackedListingMetadataRefreshItems keeps only tracked FFN listing rows", () => {
  const html = `<!doctype html><html><body>
    <div id="content_wrapper_inner">
      <div class="z-list zhover zpointer">
        <a class="stitle" href="/s/7654321/1/Tracked-Story">Tracked Story</a>
        by <a href="/u/1/tester">tester</a>
        <div class="z-indent">
          The listing summary that should enrich an existing library entry.
          <div class="z-padtop2 xgray">
            Rated: Fiction T - English - Adventure - Chapters: 7 - Words: 12,345 - Updated: Jan 2 - Published: Jan 1 - [Harry P., Hermione G.] - Complete
          </div>
        </div>
      </div>
      <div class="z-list zhover zpointer">
        <a class="stitle" href="/s/1111111/1/Untracked-Story">Untracked Story</a>
        by <a href="/u/2/other">other</a>
        <div class="z-indent">
          This untracked listing row must not be submitted.
          <div class="z-padtop2 xgray">Rated: Fiction K - English - Words: 999</div>
        </div>
      </div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://www.fanfiction.net/book/Example/",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { collectTrackedListingMetadataRefreshItems } = createCollectorBindings(dom);

  const items = collectTrackedListingMetadataRefreshItems({
    "ffn:7654321": { status: "READING" },
  });

  assert.equal(items.length, 1);
  assert.deepEqual(plainJson(items[0]), {
    source: "ffn",
    sourceStoryId: "7654321",
    url: "https://www.fanfiction.net/s/7654321/1/Tracked-Story",
    title: "Tracked Story",
    author: "tester",
    summary: "The listing summary that should enrich an existing library entry.",
    chapters: 7,
    words: 12345,
    status: "complete",
    updatedAt: "Jan 2",
    publishedAt: "Jan 1",
    rating: "T",
    language: "English",
    characters: ["Harry P.", "Hermione G."],
    relationships: ["Harry P./Hermione G."],
    genre: "Adventure",
  });
});

test("sendListingMetadataRefreshForTrackedItems dedupes repeated listing submissions", () => {
  const html = `<!doctype html><html><body>
    <div id="content_wrapper_inner">
      <div class="z-list zhover zpointer">
        <a class="stitle" href="/s/7654321/1/Tracked-Story">Tracked Story</a>
        by <a href="/u/1/tester">tester</a>
        <div class="z-indent">
          The listing summary that should be sent once per page fingerprint.
          <div class="z-padtop2 xgray">Rated: Fiction T - English - Words: 12,345</div>
        </div>
      </div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://www.fanfiction.net/book/Example/",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const sentMessages = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message) {
        sentMessages.push(message);
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:7654321": { status: "READING" },
              },
            },
          });
        },
      },
      onChanged: { addListener() {} },
    },
  };
  const { sendListingMetadataRefreshForTrackedItems } = createCollectorBindings(dom, { chrome });

  sendListingMetadataRefreshForTrackedItems(0);
  sendListingMetadataRefreshForTrackedItems(0);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, "TRACE_LIBRARY_METADATA_REFRESH");
  assert.deepEqual(plainJson(sentMessages[0].payload.items), [
    {
      source: "ffn",
      sourceStoryId: "7654321",
      url: "https://www.fanfiction.net/s/7654321/1/Tracked-Story",
      title: "Tracked Story",
      author: "tester",
      summary: "The listing summary that should be sent once per page fingerprint.",
      words: 12345,
      rating: "T",
      language: "English",
    },
  ]);
});

test("kernel listing metadata selects tracked rows through the bounded account projection", () => {
  const html = `<!doctype html><html><body>
    <div id="content_wrapper_inner">
      <div class="z-list zhover zpointer">
        <a class="stitle" href="/s/7654321/1/Tracked-Story">Tracked Story</a>
        by <a href="/u/1/tester">tester</a>
        <div class="z-indent">
          Tracked summary.
          <div class="z-padtop2 xgray">Rated: Fiction T - English - Words: 12,345</div>
        </div>
      </div>
      <div class="z-list zhover zpointer">
        <a class="stitle" href="/s/9999999/1/Untracked-Story">Untracked Story</a>
        by <a href="/u/2/tester">tester</a>
        <div class="z-indent">Untracked summary.</div>
      </div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://www.fanfiction.net/book/Example/",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const sentMessages = [];
  let storageReads = 0;
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        sentMessages.push(message);
        if (message.type === "TRACE_ACCOUNT_PROJECTION_GET") {
          callback({
            ok: true,
            projection: {
              entries: {
                "ffn:7654321": { status: "READING" },
              },
              workPreferences: {},
              syncVersion: "2026-07-20T12:00:00.000Z",
            },
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get() {
          storageReads += 1;
        },
      },
      onChanged: { addListener() {} },
    },
  };
  const { sendListingMetadataRefreshForTrackedItems } = createCollectorBindings(
    dom,
    { chrome, sessionMode: "kernel" },
  );

  sendListingMetadataRefreshForTrackedItems(0);

  assert.equal(storageReads, 0);
  assert.equal(sentMessages.length, 2);
  assert.deepEqual(plainJson(sentMessages[0]), {
    type: "TRACE_ACCOUNT_PROJECTION_GET",
    workKeys: ["ffn:7654321", "ffn:9999999"],
  });
  assert.equal(sentMessages[1].type, "TRACE_LIBRARY_METADATA_REFRESH");
  assert.deepEqual(
    plainJson(sentMessages[1].payload.items.map((item) => item.sourceStoryId)),
    ["7654321"],
  );
});

test("parseFFNMeta: listing row — characters after Published", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/book/Harry-Potter/",
  });
  const { parseFFNMeta } = createCollectorBindings(dom);
  const meta =
    "Rated: T - English - Adventure/Mystery - Chapters: 171 - Words: 1,509,826 - Reviews: 20410 - Favs: 22,059 - Follows: 23,649 - Updated: Feb 3 - Published: Apr 17, 2015 - Harry P., Hermione G., Neville L., Theodore N.";
  const p = parseFFNMeta(meta, "");
  assert.deepEqual(plainJson(p.chars), [
    "Harry P.",
    "Hermione G.",
    "Neville L.",
    "Theodore N.",
  ]);
  assert.deepEqual(plainJson(p.rels), []);
});

test("parseFFNMeta: listing row — bracket pairing after Published", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/1/1/x",
  });
  const { parseFFNMeta } = createCollectorBindings(dom);
  const meta =
    "Rated: T - English - Chapters: 106 - Words: 737,006 - Published: Jun 5, 2012 - [Harry P., Hermione G.] - Complete";
  const p = parseFFNMeta(meta, "");
  assert.deepEqual(plainJson(p.chars), ["Harry P.", "Hermione G."]);
  assert.deepEqual(plainJson(p.rels), ["Harry P./Hermione G."]);
});

test("collectFFNStory mobile (ffn_story_mobile.html) — delegates to collectFFNStoryMobile", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const { collectFFNStory } = createCollectorBindings(dom);
  const item = collectFFNStory();

  assert.equal(item.src, "ffn");
  assert.equal(item.u, "https://www.fanfiction.net/s/7038840/");
  assert.equal(item.t, "A Chance Encounter");
  assert.equal(item.a, "spectre4hire");
  assert.equal(item.r, "T");
  assert.equal(item.l, "English");
  assert.equal(item.w, 226000);
  assert.equal(item.chn, 1);
  assert.equal(item.cht, 28, "inferred from 'Ch 1 of 28' on page");
  assert.equal(item.rev, 2922, "from review link");
  assert.equal(item.fav, 12000);
  assert.equal(item.fol, 10000);
  assert.equal(item.gen, "Drama/Friendship");
  assert.equal(item.pub, "1306877211");
  assert.equal(item.upd, "1489509331");
  assert.deepEqual(plainJson(item.fms), ["Harry Potter"]);
  assert.deepEqual(plainJson(item.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(item.rels), ["Harry P./Daphne G."]);
});

test("FFN mobile story Add saves immediately without opening the sheet", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const sent = [];
  let pendingCallback;
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        pendingCallback = cb;
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: { entries: {} },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace handle on FFN mobile story page");
  assert.equal(handle.textContent || "", "+ Add to Trace");
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "add");
  assert.match(handle.getAttribute("style") || "", /display:\s*inline-flex/i);
  assert.match(handle.getAttribute("style") || "", /background:\s*transparent/i);
  const sentBeforeClick = sent.length;
  handle.click();

  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  assert.ok(sheet, "expected Trace story sheet");
  assert.notEqual(sheet.getAttribute("aria-hidden"), "false");
  assert.equal(handle.disabled, true);
  assert.match(handle.textContent || "", /Adding…/);
  const spinnerSvg = handle.querySelector("svg");
  assert.ok(spinnerSvg, "expected pending story handle to render a spinner icon");
  assert.ok(spinnerSvg.querySelector("circle"), "expected spinner to include a centered ring");
  const spinnerAnimation = spinnerSvg.getElementsByTagName("animateTransform")[0];
  assert.ok(spinnerAnimation, "expected spinner to animate");
  assert.equal(spinnerAnimation.parentElement.tagName.toLowerCase(), "g");
  assert.equal(spinnerAnimation.getAttribute("from"), "0 7 7");
  assert.equal(spinnerAnimation.getAttribute("to"), "360 7 7");
  handle.click();
  assert.equal(sent.length, sentBeforeClick + 1);
  assert.equal(sent.at(-1).type, "TRACE_QUICK_ADD");
  assert.equal(sent.at(-1).payload.item.src, "ffn");
  pendingCallback({ ok: true });
});

test("iOS story label points to the Trace app while the extension is not linked", async () => {
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: { ok: true, url: "" },
    mutateDom(dom) {
      Object.defineProperty(dom.window.navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        configurable: true,
      });
    },
    projectionResponse() {
      return {
        ok: true,
        snapshot: { state: "signed_out", reason: "credential_absent", canExecuteAuthenticated: false },
        projection: { entries: {}, workPreferences: {}, syncVersion: null },
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Finish setup in Trace/);
  assert.doesNotMatch(handle.textContent || "", /^Connect$/);
});

test("a save that failed before linking retries when the reader returns to the page", async () => {
  const harness = createStoryAutoTrackPendingHarness({ holdAutoTrack: true });
  const autoTracks = () => harness.sent.filter((message) => message.type === "TRACE_AUTO_TRACK").length;
  // Every load-time attempt fails because Trace is not linked yet.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    harness.autoTrackCallback({ ok: false, error: "not_authenticated" });
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const before = autoTracks();
  assert.ok(before >= 1, "the page tries on load");

  // Reader finishes setup in the Trace app, then comes back to Safari.
  harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(autoTracks(), before + 1, "the page retries once without a reload");

  // A later return does not keep retrying once the failure is handled.
  harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(autoTracks(), before + 1);
});

test("a story saved by the time linking happens mid-visit counts as new: one handle emphasis, no note", async () => {
  const entryId = "00000000-0000-4000-8000-000000000123";
  let linked = false;
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: { ok: true, url: "" },
    projectionResponse() {
      return linked
        ? {
            ok: true,
            snapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
            projection: {
              entries: { "ffn:7038840": { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", entryId } },
              workPreferences: {},
              syncVersion: "v-linked",
            },
          }
        : {
            ok: true,
            snapshot: { state: "signed_out", reason: "credential_absent", canExecuteAuthenticated: false },
            projection: { entries: {}, workPreferences: {}, syncVersion: null },
          };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  // By the first linked read, the story has already been saved.
  linked = true;
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.dom.window.document.querySelector("trace-saved-note"), null, "no page note");
  assert.equal(h.handleAnimations().length, 1, "linking mid-visit still counts the save as new to this page");
});

test("an unavailable FanFiction.net story page is never saved automatically", async () => {
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: true },
    pendingFirstStoryResponse: { ok: true, url: "" },
    mutateDom(dom) {
      // "Story Not Found" keeps the /s/ URL but has no chapter text.
      dom.window.document.getElementById("storycontent")?.remove();
      dom.window.document.title = "FanFiction Mobile";
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    h.sent.some((message) => message.type === "TRACE_AUTO_TRACK"),
    false,
    "no automatic save without story text",
  );
  Object.defineProperty(h.dom.window.document, "readyState", {
    configurable: true,
    value: "complete",
  });
  const identity = await h.sendRuntimeMessage(
    { type: "TRACE_STORY_IDENTITY_GET" },
    { id: "trace-extension" },
  );
  assert.equal(identity.ok, false);
  assert.equal(identity.unavailable, true, "the popup can distinguish an unavailable page from a save still in flight");
});

function createStoryAutoTrackPendingHarness(options = {}) {
  const dom = domFromFixture(
    options.fixture || "ffn_story_mobile.html",
    options.url || "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  );
  if (typeof options.mutateDom === "function") options.mutateDom(dom);
  const handleAnimations = [];
  dom.window.HTMLElement.prototype.animate = function (keyframes, timing) {
    if (this.hasAttribute("data-trace-story-handle")) handleAnimations.push({ keyframes, timing });
    return { cancel() {}, finished: Promise.resolve() };
  };
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  Object.defineProperty(dom.window.document, "hidden", {
    value: false,
    configurable: true,
  });
  dom.window.document.hasFocus = () => true;
  const scrolledTargets = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolledTargets.push(this);
  };

  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const store = Object.assign(
    {
      authToken: "test-token",
      libraryOverlayCache: { entries: {} },
    },
    options.store || {},
  );
  const sent = [];
  const projectionResponses = Array.isArray(options.projectionResponses)
    ? options.projectionResponses.slice()
    : null;
  let autoTrackCallback;
  let connectAndSaveCallback;
  let pendingFirstStoryCallback;
  let deferredAutoTrackPreferenceRead;
  let deferredWorkStateRead;
  let runtimeMessageListener = null;
  const storageChangeListeners = [];
  const chrome = {
    runtime: {
      id: "trace-extension",
      connect: options.connectPort,
      onMessage: {
        addListener(fn) {
          runtimeMessageListener = fn;
        },
      },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (
          typeof options.onSendMessage === "function" &&
          options.onSendMessage(msg, cb) === true
        ) {
          return;
        }
        if (msg.type === "TRACE_WORK_STATE_GET") {
          if (options.holdWorkStateRead) {
            deferredWorkStateRead = cb;
            return;
          }
          if (typeof cb === "function") {
            cb(options.workStateResponse || { ok: true, state: null });
          }
          return;
        }
        if (msg.type === "TRACE_ACCOUNT_PROJECTION_GET") {
          if (typeof cb === "function") {
            const configuredResponse =
              typeof options.projectionResponse === "function"
                ? options.projectionResponse(msg)
                : options.projectionResponse;
            cb((projectionResponses && projectionResponses.length > 0
              ? projectionResponses.shift()
              : configuredResponse) || {
              ok: true,
              snapshot: {
                state: "connected",
                reason: "none",
                canExecuteAuthenticated: true,
              },
              projection: {
                entries: {},
                workPreferences: {},
                syncVersion: null,
              },
            });
          }
          return;
        }
        if (msg.type === "TRACE_AUTO_TRACK") {
          autoTrackCallback = cb;
          if (typeof cb !== "function" && Array.isArray(options.autoTrackPromiseReplies)) {
            const reply = options.autoTrackPromiseReplies.shift();
            if (reply && reply.throw) throw new Error(reply.throw);
            if (reply && reply.reject) return Promise.reject(new Error(reply.reject));
            if (reply && Object.hasOwn(reply, "resolve")) return Promise.resolve(reply.resolve);
            return Promise.resolve(options.autoTrackResponse || { ok: true });
          }
          if (Array.isArray(options.autoTrackLastErrors) && options.autoTrackLastErrors.length > 0) {
            chrome.runtime.lastError = { message: options.autoTrackLastErrors.shift() };
            cb();
            chrome.runtime.lastError = null;
            return;
          }
          if (!options.holdAutoTrack && typeof cb === "function") {
            cb(options.autoTrackResponse || { ok: true });
          }
          return;
        }
        if (msg.type === "TRACE_QUICK_ADD" && typeof cb === "function") {
          cb(options.quickAddResponse || { ok: true });
          return;
        }
        if (msg.type === "TRACE_SET_READER_STATUS" && typeof cb === "function") {
          cb(options.setReaderStatusResponse || { ok: true });
          return;
        }
        if (msg.type === "TRACE_IOS_PENDING_FIRST_STORY_GET") {
          const response = options.pendingFirstStoryResponse || { ok: true, url: "" };
          if (options.holdPendingFirstStoryRead) {
            pendingFirstStoryCallback = cb;
            return;
          }
          if (typeof cb === "function") {
            cb(response);
            return;
          }
          return Promise.resolve(response);
        }
        if (msg.type === "TRACE_CONNECT_AND_SAVE") {
          const response = options.connectAndSaveResponse || {
            ok: true,
            snapshot: {
              state: "connected",
              reason: "none",
              canExecuteAuthenticated: true,
            },
            error: "commands_unavailable",
          };
          if (options.holdConnectAndSave) {
            if (typeof cb === "function") {
              connectAndSaveCallback = cb;
              return;
            }
            return new Promise((resolve) => {
              connectAndSaveCallback = resolve;
            });
          }
          if (typeof cb === "function") {
            cb(response);
            return;
          }
          return Promise.resolve(response);
        }
        if (msg.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR") {
          if (typeof cb === "function") cb({ ok: true });
          return;
        }
        if (msg.type === "TRACE_IOS_AUTH_REFRESH_REQUEST") {
          Object.assign(store, options.authRefreshStorePatch || {});
          if (typeof cb === "function") {
            cb(options.authRefreshResponse || { ok: false });
          }
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
              out[key] = store[key];
            }
          }
          if (
            options.holdAutoTrackPreferenceRead &&
            list.length === 1 &&
            list[0] === "prefAutoTrackEnabled"
          ) {
            deferredAutoTrackPreferenceRead = function () {
              cb(out);
            };
            return;
          }
          cb(out);
        },
        set(value, cb) {
          Object.assign(store, value || {});
          if (typeof cb === "function") cb();
        },
      },
      onChanged: {
        addListener(fn) {
          storageChangeListeners.push(fn);
        },
      },
    },
  };

  if (options.scopedStorageContext === false) {
    dom.window.chrome = chrome;
    dom.window.browser = chrome;
  } else {
    installCollectorChrome(dom, chrome);
  }
  dom.window.TRACE_SESSION_MODE = options.sessionMode || "legacy";
  dom.window.eval(collectorTestSource(collectorSrc));
  if (!options.skipDomContentLoaded) {
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );
  }

  return {
    dom,
    sent,
    scrolledTargets,
    store,
    handleAnimations() {
      return handleAnimations.slice();
    },
    dispatchStorageChange(key, value) {
      const oldValue = store[key];
      store[key] = value;
      const changes = { [key]: { oldValue, newValue: value } };
      storageChangeListeners.forEach((listener) => listener(changes, "local"));
    },
    autoTrackCallback(response) {
      autoTrackCallback(response);
    },
    resolveAutoTrackPreferenceRead() {
      assert.equal(typeof deferredAutoTrackPreferenceRead, "function");
      const resolve = deferredAutoTrackPreferenceRead;
      deferredAutoTrackPreferenceRead = null;
      resolve();
    },
    resolveWorkStateRead(response) {
      assert.equal(typeof deferredWorkStateRead, "function");
      const resolve = deferredWorkStateRead;
      deferredWorkStateRead = null;
      resolve(response || options.workStateResponse || { ok: true, state: null });
    },
    resolveConnectAndSave(response) {
      connectAndSaveCallback(response);
    },
    resolvePendingFirstStory(response) {
      assert.equal(typeof pendingFirstStoryCallback, "function");
      const resolve = pendingFirstStoryCallback;
      pendingFirstStoryCallback = null;
      resolve(response || options.pendingFirstStoryResponse || { ok: true, url: "" });
    },
    sendRuntimeMessage(message, sender = {}) {
      return new Promise((resolve) => {
        assert.equal(typeof runtimeMessageListener, "function");
        const asyncResponse = runtimeMessageListener(message, sender, resolve);
        if (asyncResponse !== true) {
          Promise.resolve().then(() => resolve(undefined));
        }
      });
    },
  };
}

test("story page reserves the Trace slot before DOMContentLoaded", () => {
  const { dom } = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    skipDomContentLoaded: true,
  });

  const wrap = dom.window.document.querySelector("[data-trace-quick-add-wrap]");
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(wrap, "expected Trace story slot before DOMContentLoaded");
  assert.ok(handle, "expected Trace story handle before DOMContentLoaded");
  assert.match(wrap.getAttribute("style") || "", /min-height:\s*26px/i);
});

test("story page unknown work shows pending while auto-track is in flight and ignores manual add", () => {
  const { dom, sent } = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, true);
  assert.match(handle.textContent || "", /Adding…/);

  const sentBeforeClick = sent.length;
  handle.click();
  assert.equal(sent.length, sentBeforeClick);
  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_QUICK_ADD").length,
    0,
    "manual quick-add must not fire while auto-track is pending",
  );
});

test("story page keeps a confirmed cached saved state while auto-track reconciles", () => {
  const { dom } = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    store: {
      libraryOverlayCache: {
        entries: {
          "ffn:7038840": {
            status: "PLANNING",
            readerStatus: "PLANNING",
            canonicalReaderStatus: "SAVED",
            entryId: "00000000-0000-4000-8000-000000703884",
            statusChoicesAvailable: true,
          },
        },
        syncVersion: "stale-synthetic-cache",
      },
    },
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, false);
  assert.match(handle.textContent || "", /Saved/i);
  assert.doesNotMatch(handle.textContent || "", /Adding…/);
});

test("story page confirmed overlay entry clears an older auto-track pending handle", () => {
  const { dom } = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    store: {
      libraryOverlayCache: {
        entries: {
          "ffn:7038840": {
            status: "READING",
            readerStatus: "READING",
            canonicalReaderStatus: "READING",
            entryId: "00000000-0000-4000-8000-000000703884",
            chapters: { current: 3, total: 28 },
          },
        },
        syncVersion: "confirmed-overlay-entry",
      },
    },
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, false);
  assert.match(handle.textContent || "", /Reading\s*3\/28/i);
  assert.doesNotMatch(handle.textContent || "", /Adding…/);
});

test("story page projects a newly viewed chapter while auto-track confirms it", () => {
  const harness = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    url: "https://m.fanfiction.net/s/7038840/4/A-Chance-Encounter",
    store: {
      libraryOverlayCache: {
        entries: {
          "ffn:7038840": {
            status: "READING",
            readerStatus: "READING",
            canonicalReaderStatus: "READING",
            entryId: "00000000-0000-4000-8000-000000703884",
            chapters: { current: 3, total: 28 },
          },
        },
        syncVersion: "chapter-three-projection",
      },
    },
  });

  const handle = harness.dom.window.document.querySelector(
    "[data-trace-story-handle]",
  );
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, true);
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "tracking");
  assert.match(handle.textContent || "", /Reading\s*4\/28/i);
  assert.doesNotMatch(handle.textContent || "", /3\/28/);
  assert.ok(handle.querySelector("svg"), "expected pending progress to retain a spinner");

  harness.autoTrackCallback({ ok: false, error: "network_error" });
  assert.match(handle.textContent || "", /^Not saved$/);
  assert.doesNotMatch(handle.textContent || "", /4\/28/);
});

test("story page projects Saved to Reading on chapter two while auto-track confirms it", () => {
  const harness = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    sessionMode: "kernel",
    url: "https://m.fanfiction.net/s/7038840/2/A-Chance-Encounter",
    projectionResponse: {
      ok: true,
      snapshot: {
        state: "connected",
        reason: "none",
        canExecuteAuthenticated: true,
      },
      projection: {
        entries: {
          "ffn:7038840": {
            status: "PLANNING",
            readerStatus: "PLANNING",
            canonicalReaderStatus: "SAVED",
            entryId: "00000000-0000-4000-8000-000000703884",
            chapters: { current: 1, total: 28 },
          },
        },
        workPreferences: {},
        syncVersion: "saved-chapter-one-projection",
      },
    },
  });

  const handle = harness.dom.window.document.querySelector(
    "[data-trace-story-handle]",
  );
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, true);
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "tracking");
  assert.match(handle.textContent || "", /Reading\s*2\/28/i);
  assert.doesNotMatch(handle.textContent || "", /^Saved$/);
  assert.ok(handle.querySelector("svg"), "expected pending transition to retain a spinner");

  harness.autoTrackCallback({ ok: false, error: "network_error" });
  assert.match(handle.textContent || "", /^Not saved$/);
  assert.doesNotMatch(handle.textContent || "", /Reading\s*2\/28/i);
});

test("story page projects pending progress before the auto-track preference read settles", () => {
  const harness = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    holdAutoTrackPreferenceRead: true,
    sessionMode: "kernel",
    url: "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter",
    workStateResponse: {
      ok: true,
      state: {
        workKey: "ffn:7038840",
        status: "saved",
        entryId: "00000000-0000-4000-8000-000000703884",
        entry: {
          status: "READING",
          readerStatus: "READING",
          canonicalReaderStatus: "READING",
          entryId: "00000000-0000-4000-8000-000000703884",
          chapters: { current: 2, total: 28 },
        },
        syncVersion: "chapter-two-work-state",
      },
    },
  });

  const handle = harness.dom.window.document.querySelector(
    "[data-trace-story-handle]",
  );
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "tracking");
  assert.match(handle.textContent || "", /Reading\s*3\/28/i);
  assert.ok(handle.querySelector("svg"), "expected immediate pending progress to show a spinner");

  harness.resolveAutoTrackPreferenceRead();
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "tracking");
  assert.match(handle.textContent || "", /Reading\s*3\/28/i);
  assert.ok(handle.querySelector("svg"), "expected pending progress to show a spinner");

  harness.autoTrackCallback({ ok: false, error: "network_error" });
  assert.match(handle.textContent || "", /^Not saved$/);
  assert.doesNotMatch(handle.textContent || "", /Reading\s*3\/28/i);
});

test("story page removes provisional progress when auto-track is disabled", () => {
  const harness = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    holdAutoTrackPreferenceRead: true,
    sessionMode: "kernel",
    url: "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter",
    store: { prefAutoTrackEnabled: false },
    workStateResponse: {
      ok: true,
      state: {
        workKey: "ffn:7038840",
        status: "saved",
        entryId: "00000000-0000-4000-8000-000000703884",
        entry: {
          status: "READING",
          readerStatus: "READING",
          canonicalReaderStatus: "READING",
          entryId: "00000000-0000-4000-8000-000000703884",
          chapters: { current: 2, total: 28 },
        },
        syncVersion: "chapter-two-auto-track-disabled",
      },
    },
  });

  const handle = harness.dom.window.document.querySelector(
    "[data-trace-story-handle]",
  );
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "tracking");
  assert.match(handle.textContent || "", /Reading\s*3\/28/i);

  harness.resolveAutoTrackPreferenceRead();
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "status");
  assert.match(handle.textContent || "", /Reading\s*2\/28/i);
  assert.equal(handle.querySelector("animateTransform"), null);
  assert.equal(
    harness.sent.some((message) => message.type === "TRACE_AUTO_TRACK"),
    false,
  );
});

test("story page keeps pending progress over a later stale work-state read", () => {
  const harness = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    holdWorkStateRead: true,
    sessionMode: "kernel",
    url: "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter",
    projectionResponse: {
      ok: true,
      snapshot: {
        state: "connected",
        reason: "none",
        canExecuteAuthenticated: true,
      },
      projection: {
        entries: {
          "ffn:7038840": {
            status: "READING",
            readerStatus: "READING",
            canonicalReaderStatus: "READING",
            entryId: "00000000-0000-4000-8000-000000703884",
            chapters: { current: 2, total: 28 },
          },
        },
        workPreferences: {},
        syncVersion: "chapter-two-projection",
      },
    },
  });

  const handle = harness.dom.window.document.querySelector(
    "[data-trace-story-handle]",
  );
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "tracking");
  assert.match(handle.textContent || "", /Reading\s*3\/28/i);

  harness.resolveWorkStateRead({
    ok: true,
    state: {
      workKey: "ffn:7038840",
      status: "saved",
      entryId: "00000000-0000-4000-8000-000000703884",
      entry: {
        status: "READING",
        readerStatus: "READING",
        canonicalReaderStatus: "READING",
        entryId: "00000000-0000-4000-8000-000000703884",
        chapters: { current: 2, total: 28 },
      },
      syncVersion: "stale-chapter-two-work-state",
    },
  });

  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "tracking");
  assert.match(handle.textContent || "", /Reading\s*3\/28/i);
  assert.ok(handle.querySelector("svg"), "expected pending progress to retain its spinner");
});

test("story page ignores unscoped cached saved state", () => {
  const { dom } = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    scopedStorageContext: false,
    store: {
      authToken: "test-token",
      traceAuthState: { state: "connected" },
      libraryOverlayCache: {
        entries: {
          "ffn:7038840": {
            entryId: "stale-entry",
            status: "READING",
            readerStatus: "READING",
            chapters: { current: 4, total: 28 },
          },
        },
        syncVersion: "stale-unscoped",
      },
    },
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.notEqual(handle.getAttribute("data-trace-story-handle-state"), "saved");
  assert.doesNotMatch(handle.textContent || "", /Reading/i);
});

test("story page rehydrates pending work state from the background on load", () => {
  const { dom, sent } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
    workStateResponse: {
      ok: true,
      state: {
        accountId: "acct-story",
        workKey: "ffn:7038840",
        operation: "auto_track",
        status: "pending",
      },
    },
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, true);
  assert.match(handle.textContent || "", /Adding…/);
  assert.equal(sent.some((msg) => msg.type === "TRACE_WORK_STATE_GET"), true);
});

test("story page renders saved when background state has the authoritative entry", () => {
  const entryId = "00000000-0000-4000-8000-000000000703";
  const { dom, store } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
    workStateResponse: {
      ok: true,
      state: {
        accountId: "acct-story",
        workKey: "ffn:7038840",
        operation: "auto_track",
        status: "saved",
        entryId,
        entry: {
          status: "PLANNING",
          readerStatus: "PLANNING",
          canonicalReaderStatus: "SAVED",
          entryId,
        },
      },
    },
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, false);
  assert.match(handle.textContent || "", /Saved/i);
  assert.equal(store.libraryOverlayCache.entries["ffn:7038840"], undefined);
});

test("story page does not synthesize saved from an unconfirmed auto-track ack", async () => {
  const { dom, sent, store } = createStoryAutoTrackPendingHarness({
    autoTrackResponse: { ok: true },
    workStateResponse: { ok: true, state: null },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.match(handle.textContent || "", /Adding…/);
  assert.equal(store.libraryOverlayCache.entries["ffn:7038840"], undefined);
  assert.equal(sent.some((msg) => msg.type === "TRACE_WORK_STATE_GET"), true);
});

test("first-story focus-add command triggers existing quick-add path", async () => {
  const { sent, sendRuntimeMessage } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
  });
  const quickAddBefore = sent.filter((msg) => msg.type === "TRACE_QUICK_ADD").length;

  const response = await sendRuntimeMessage({
    type: "TRACE_FIRST_STORY_FOCUS_ADD",
  });

  assert.deepEqual(plainJson(response), { ok: true, state: "saved" });
  const quickAdds = sent.filter((msg) => msg.type === "TRACE_QUICK_ADD");
  assert.equal(quickAdds.length, quickAddBefore + 1);
  assert.equal(quickAdds.at(-1).payload.item.src, "ffn");
  assert.equal(
    quickAdds.at(-1).payload.item.u,
    "https://www.fanfiction.net/s/7038840/",
  );
});

test("matching iOS pending first-story URL triggers quick-add and clears pending state", async () => {
  const { sent } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: {
      ok: true,
      url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));

  const quickAdds = sent.filter((msg) => msg.type === "TRACE_QUICK_ADD");
  const pendingClears = sent.filter(
    (msg) => msg.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR",
  );
  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_IOS_PENDING_FIRST_STORY_GET").length,
    1,
  );
  assert.equal(quickAdds.length, 1);
  assert.equal(quickAdds[0].payload.item.src, "ffn");
  assert.equal(quickAdds[0].payload.item.u, "https://www.fanfiction.net/s/7038840/");
  assert.equal(pendingClears.length, 1);
});

test("kernel pending first story automatically sends one bounded command and focuses the confirmed story control", async () => {
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    holdConnectAndSave: true,
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: {
      ok: true,
      mode: "story",
      hostKind: "ffn",
      handoffId: "handoff_kernel_7038840",
      url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Connecting/i);
  assert.equal(handle.disabled, true);
  assert.equal(h.dom.window.document.activeElement, handle);
  assert.ok(h.scrolledTargets.length >= 1);
  assert.equal(h.sent.filter((message) => message.type === "TRACE_QUICK_ADD").length, 0);
  assert.equal(
    h.sent.filter((message) => message.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR").length,
    0,
  );

  h.dom.window.dispatchEvent(new h.dom.window.Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const commands = h.sent.filter((message) => message.type === "TRACE_CONNECT_AND_SAVE");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].workKey, "ffn:7038840");
  assert.equal(commands[0].handoffId, "handoff_kernel_7038840");
  assert.equal(commands[0].payload.s, "ffn");
  assert.equal(commands[0].payload.item.ctx, "story");
  assert.equal(commands[0].payload.item.u, "https://www.fanfiction.net/s/7038840/");
  assert.equal(h.sent.filter((message) => message.type === "TRACE_QUICK_ADD").length, 0);

  const entryId = "00000000-0000-4000-8000-000000000123";
  h.resolveConnectAndSave({
    ok: true,
    snapshot: {
      state: "connected",
      reason: "none",
      canExecuteAuthenticated: true,
    },
    entryId,
    command: {
      kind: "confirmed",
      intent: "ensure_saved",
      confirmation: {
        workKey: "ffn:7038840",
        entryId,
        entry: {
          status: "PLANNING",
          readerStatus: "PLANNING",
          canonicalReaderStatus: "SAVED",
          entryId,
        },
        syncVersion: "2026-07-19T12:00:00.000Z",
      },
      source: "mutation",
      projection: "published",
      receipt: "published",
      handoff: "cleared",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(handle.textContent || "", /Saved/i);
  assert.equal(handle.disabled, false);
  assert.equal(h.dom.window.document.activeElement, handle);
  assert.ok(h.scrolledTargets.length >= 2);
  assert.equal(h.sent.filter((message) => message.type === "TRACE_QUICK_ADD").length, 0);
  assert.equal(
    h.sent.filter((message) => message.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR").length,
    0,
  );
});

test("kernel story control leaves Checking when Trace never answers, and a tap looks again", async () => {
  let answering = false;
  let unanswered = 0;
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    // Every wait in the page passes at once, so the retries run out quickly.
    mutateDom(dom) {
      const quick = dom.window.setTimeout.bind(dom.window);
      dom.window.setTimeout = (callback, _ms, ...args) => quick(callback, 0, ...args);
    },
    onSendMessage(message, cb) {
      if (message.type !== "TRACE_ACCOUNT_PROJECTION_GET" || answering) return false;
      // A background that took the message and never replied.
      unanswered += 1;
      void cb;
      return true;
    },
  });

  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  for (let i = 0; i < 50 && handle.getAttribute("data-trace-story-handle-state") !== "unavailable"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "unavailable");
  assert.match(handle.textContent || "", /Try again/);
  assert.doesNotMatch(handle.textContent || "", /Checking/);
  assert.equal(handle.disabled, false);
  assert.ok(unanswered >= 1);

  answering = true;
  handle.click();
  for (let i = 0; i < 50 && handle.getAttribute("data-trace-story-handle-state") === "unavailable"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(handle.getAttribute("data-trace-story-handle-state"), "unavailable");
  assert.notEqual(handle.getAttribute("data-trace-story-handle-state"), "checking");
});

test("kernel story control replaces the hidden placeholder when the last look-up fails", async () => {
  let document = null;
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    mutateDom(dom) {
      document = dom.window.document;
      const quick = dom.window.setTimeout.bind(dom.window);
      dom.window.setTimeout = (callback, _ms, ...args) => quick(callback, 0, ...args);
    },
    // The slot still holds its hidden placeholder each time the look-up fails.
    projectionResponse: () => {
      const handle = document.querySelector("[data-trace-story-handle]");
      handle.setAttribute("data-trace-story-handle-state", "loading");
      handle.style.visibility = "hidden";
      return { ok: false, error: "runtime_unavailable" };
    },
  });
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  for (let i = 0; i < 50 && handle.getAttribute("data-trace-story-handle-state") !== "unavailable"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "unavailable");
  assert.notEqual(handle.style.visibility, "hidden");
});

test("kernel story control keeps a shown state when a later look-up fails", async () => {
  let fail = false;
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    projectionResponse: () => (fail ? { ok: false, error: "runtime_unavailable" } : {
      ok: true,
      snapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
      projection: {
        entries: { "ffn:7038840": { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED" } },
        workPreferences: {},
        syncVersion: null,
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "status");

  fail = true;
  h.dom.window.renderQuickAddButton("ffn:7038840", 4);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "status");
  assert.match(handle.textContent || "", /Saved/);
});

test("kernel story control never offers Add before the onboarding handoff lookup settles", async () => {
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    holdPendingFirstStoryRead: true,
    holdConnectAndSave: true,
    store: { prefAutoTrackEnabled: false },
  });

  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.equal(handle.disabled, true);
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "checking");
  assert.match(handle.textContent || "", /Checking/i);
  assert.doesNotMatch(handle.textContent || "", /Add to Trace/i);

  h.resolvePendingFirstStory({
    ok: true,
    mode: "story",
    hostKind: "ffn",
    handoffId: "handoff_kernel_no_false_add",
    url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.match(handle.textContent || "", /Connecting/i);
  assert.doesNotMatch(handle.textContent || "", /Add to Trace/i);

  const entryId = "00000000-0000-4000-8000-000000000124";
  h.resolveConnectAndSave({
    ok: true,
    snapshot: {
      state: "connected",
      reason: "none",
      canExecuteAuthenticated: true,
    },
    entryId,
    command: {
      kind: "confirmed",
      intent: "ensure_saved",
      confirmation: {
        workKey: "ffn:7038840",
        entryId,
        entry: {
          status: "PLANNING",
          readerStatus: "PLANNING",
          canonicalReaderStatus: "SAVED",
          entryId,
        },
        syncVersion: "2026-08-22T07:30:00.000Z",
      },
      source: "mutation",
      projection: "published",
      receipt: "published",
      handoff: "cleared",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(handle.disabled, false);
  assert.match(handle.textContent || "", /Saved/i);
  assert.doesNotMatch(handle.textContent || "", /Add to Trace/i);
});

test("kernel pending first-story automatic failure stays bounded and offers an explicit retry", async () => {
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: {
      ok: true,
      mode: "browse",
      hostKind: "ffn",
      handoffId: "handoff_kernel_retry_7038840",
      url: "",
    },
    connectAndSaveResponse: {
      ok: false,
      snapshot: {
        state: "connected",
        reason: "none",
        canExecuteAuthenticated: true,
      },
      error: "confirmation_missing",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Retry save/i);
  assert.equal(handle.disabled, false);
  assert.equal(
    h.sent.filter((message) => message.type === "TRACE_CONNECT_AND_SAVE").length,
    1,
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    h.sent.filter((message) => message.type === "TRACE_CONNECT_AND_SAVE").length,
    1,
  );

  handle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    h.sent.filter((message) => message.type === "TRACE_CONNECT_AND_SAVE").length,
    2,
  );
});

test("kernel pending first story without an opaque app handoff remains explicit", async () => {
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: {
      ok: true,
      mode: "story",
      hostKind: "ffn",
      url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Connect and save/i);
  assert.equal(handle.disabled, false);
  assert.equal(
    h.sent.filter((message) => message.type === "TRACE_CONNECT_AND_SAVE").length,
    0,
  );
});

test("kernel story projection renders known state with migrated mutation controls", async () => {
  const entryId = "00000000-0000-4000-8000-000000000123";
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: { ok: true, url: "" },
    projectionResponse: {
      ok: true,
      snapshot: {
        state: "connected",
        reason: "none",
        canExecuteAuthenticated: true,
      },
      projection: {
        entries: {
          "ffn:7038840": {
            status: "READING",
            readerStatus: "READING",
            canonicalReaderStatus: "READING",
            entryId,
            chapters: { current: 2, total: 12 },
            rating: 4,
          },
        },
        workPreferences: {},
        syncVersion: "2026-07-20T12:00:00.000Z",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));
  const projectionRequest = h.sent.find(
    (message) => message.type === "TRACE_ACCOUNT_PROJECTION_GET",
  );
  assert.deepEqual(plainJson(projectionRequest.workKeys), ["ffn:7038840"]);

  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Reading/i);
  handle.click();
  const sheet = h.dom.window.document.querySelector("[data-trace-story-sheet]");
  assert.equal(sheet.getAttribute("aria-hidden"), "false");
  assert.ok(sheet.querySelector("[data-trace-status-choices]"));
  assert.ok(sheet.querySelector("[data-trace-rating-control]"));
  assert.equal(sheet.querySelector("[data-trace-catchup-action]"), null);
  assert.ok(sheet.querySelector("[data-trace-hidden-action]"));
});

test("kernel story page re-queries its private projection after a confirmed-save revision", async () => {
  const entryId = "00000000-0000-4000-8000-000000000123";
  let confirmed = false;
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: { ok: true, url: "" },
    projectionResponse() {
      return {
        ok: true,
        snapshot: {
          state: "connected",
          reason: "none",
          canExecuteAuthenticated: true,
        },
        projection: {
          entries: confirmed
            ? {
                "ffn:7038840": {
                  status: "PLANNING",
                  readerStatus: "PLANNING",
                  canonicalReaderStatus: "SAVED",
                  entryId,
                },
              }
            : {},
          workPreferences: {},
          syncVersion: confirmed ? "2026-08-22T08:30:00.000Z" : null,
        },
      };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Add to Trace/i);

  const projectionsBeforeRevision = h.sent.filter(
    (message) => message.type === "TRACE_ACCOUNT_PROJECTION_GET",
  ).length;
  confirmed = true;
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    h.sent.filter((message) => message.type === "TRACE_ACCOUNT_PROJECTION_GET").length >
      projectionsBeforeRevision,
  );
  assert.match(handle.textContent || "", /Saved/i);
  assert.doesNotMatch(handle.textContent || "", /Add to Trace/i);
});

function savedNoteHarness(initiallyConfirmed, extraStore = {}) {
  const entryId = "00000000-0000-4000-8000-000000000123";
  const state = { confirmed: initiallyConfirmed };
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false, ...extraStore },
    pendingFirstStoryResponse: { ok: true, url: "" },
    projectionResponse() {
      return {
        ok: true,
        snapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
        projection: {
          entries: state.confirmed
            ? { "ffn:7038840": { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", entryId } }
            : {},
          workPreferences: {},
          syncVersion: state.confirmed ? "2026-08-22T08:30:00.000Z" : null,
        },
      };
    },
  });
  return { h, state };
}

function useReducedMotion(h) {
  h.dom.window.matchMedia = (query) => ({
    matches: String(query).includes("prefers-reduced-motion"),
    media: String(query),
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  });
}

test("a story newly saved on this page gets no notice; the handle settles in once", async () => {
  const { h, state } = savedNoteHarness(false);
  await delay(180);
  const doc = h.dom.window.document;
  assert.equal(h.handleAnimations().length, 0);

  state.confirmed = true;
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 1);
  await delay(20);

  assert.equal(doc.querySelector("trace-saved-note"), null, "no page note");
  assert.equal(doc.querySelector("[data-trace-saved-note]"), null);
  const live = doc.querySelector("[data-trace-page-live-region]");
  assert.doesNotMatch(live ? live.textContent : "", /Saved to your Library/);
  assert.equal(h.dom.window.sessionStorage.getItem("trace:saved-note:v1"), null, "no marker carries a note to the next page");
  const handle = doc.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent, /Saved/);
  const animations = h.handleAnimations();
  assert.equal(animations.length, 1, "one brief emphasis on the handle itself");
  assert.equal(animations[0].keyframes.at(-1).opacity, 1, "it ends fully visible");
  assert.ok(animations[0].timing.duration <= 500, "it is brief");
  assert.equal(doc.activeElement === handle, false, "it never takes focus");

  // A later revision for the same story does not repeat it.
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 2);
  await delay(20);
  assert.equal(h.handleAnimations().length, 1);
  h.dom.window.close();
});

test("Reduce Motion: a newly saved story gets no emphasis and no notice", async () => {
  const { h, state } = savedNoteHarness(false);
  useReducedMotion(h);
  await delay(180);
  state.confirmed = true;
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 1);
  await delay(20);
  assert.equal(h.handleAnimations().length, 0);
  assert.equal(h.dom.window.document.querySelector("trace-saved-note"), null);
  h.dom.window.close();
});

test("a story already in the Library when the page loaded gets no emphasis and no notice", async () => {
  const { h } = savedNoteHarness(true);
  await delay(180);
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 1);
  await delay(20);
  assert.equal(h.handleAnimations().length, 0);
  assert.equal(h.dom.window.document.querySelector("trace-saved-note"), null);
  h.dom.window.close();
});

test("the popup's saved-note dismiss is still answered for the popup only", async () => {
  const { h } = savedNoteHarness(false);
  await delay(180);
  assert.equal((await h.sendRuntimeMessage({ type: "TRACE_SAVED_NOTE_DISMISS" }, { id: "trace-extension" })).ok, true);
  assert.equal((await h.sendRuntimeMessage({ type: "TRACE_SAVED_NOTE_DISMISS" }, {})).ok, false);
  h.dom.window.close();
});

test("a failed automatic save is still shown on the page", async () => {
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: true },
    pendingFirstStoryResponse: { ok: true, url: "" },
    autoTrackResponse: { ok: false, error: "http_503" },
    projectionResponse: {
      ok: true,
      snapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
      projection: { entries: {}, workPreferences: {}, syncVersion: null },
    },
  });
  await delay(300);
  assert.ok(h.sent.some((message) => message.type === "TRACE_AUTO_TRACK"));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent, /Not saved/, "the handle says the save failed");
  h.dom.window.close();
});

test("kernel story projection retries a transient cold-worker read without retrying mutations", async () => {
  const entryId = "00000000-0000-4000-8000-000000000123";
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: { ok: true, url: "" },
    projectionResponses: [
      { ok: false },
      {
        ok: true,
        snapshot: {
          state: "connected",
          reason: "none",
          canExecuteAuthenticated: true,
        },
        projection: {
          entries: {
            "ffn:7038840": {
              status: "READING",
              readerStatus: "READING",
              canonicalReaderStatus: "READING",
              entryId,
              chapters: { current: 3, total: 12 },
            },
          },
          workPreferences: {},
          syncVersion: "2026-07-20T12:00:00.000Z",
        },
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(
    h.sent.filter((message) => message.type === "TRACE_ACCOUNT_PROJECTION_GET").length,
    2,
  );
  assert.equal(
    h.sent.filter((message) =>
      message.type === "TRACE_AUTO_TRACK" ||
      message.type === "TRACE_QUICK_ADD"
    ).length,
    0,
  );
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Reading/i);
});

test("matching iOS pending story handoff relays its scoped run receipt", async () => {
  const { sent } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: {
      ok: true,
      mode: "story",
      hostKind: "ffn",
      handoffId: "handoff_7038840",
      url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));

  const receipts = sent.filter(
    (message) =>
      message.type === "TRACE_ARCHIVE_SEEN" &&
      message.handoffId === "handoff_7038840",
  );
  assert.equal(receipts.length, 1);
  assert.equal(sent.filter((message) => message.type === "TRACE_QUICK_ADD").length, 1);
  assert.equal(
    sent.filter((message) => message.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR").length,
    1,
  );
});

test("matching iOS browse handoff waits for a story then relays its receipt", async () => {
  const { sent } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
    // FFN browse is a first-class native handoff. The existing FFN fixture also
    // exercises the collector's host-match guard.
    pendingFirstStoryResponse: {
      ok: true,
      mode: "browse",
      hostKind: "ffn",
      handoffId: "browse_7038840",
      url: "",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal(
    sent.filter(
      (message) =>
        message.type === "TRACE_ARCHIVE_SEEN" &&
        message.handoffId === "browse_7038840",
    ).length,
    1,
  );
  assert.equal(sent.filter((message) => message.type === "TRACE_QUICK_ADD").length, 1);
  assert.equal(
    sent.filter((message) => message.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR").length,
    1,
  );
});

test("mismatched iOS browse handoff stays pending without a receipt", async () => {
  const { sent } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: {
      ok: true,
      mode: "browse",
      hostKind: "ao3",
      handoffId: "browse_waiting",
      url: "",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal(
    sent.filter(
      (message) =>
        message.type === "TRACE_ARCHIVE_SEEN" &&
        message.handoffId === "browse_waiting",
    ).length,
    0,
  );
  assert.equal(sent.filter((message) => message.type === "TRACE_QUICK_ADD").length, 0);
  assert.equal(
    sent.filter((message) => message.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR").length,
    0,
  );
});

test("matching iOS pending first-story URL tries quick-add when rendered auth state is stale", async () => {
  const { sent } = createStoryAutoTrackPendingHarness({
    store: {
      authToken: null,
      traceAuthState: { state: "signed_out" },
      prefAutoTrackEnabled: false,
    },
    pendingFirstStoryResponse: {
      ok: true,
      url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));

  const quickAdds = sent.filter((msg) => msg.type === "TRACE_QUICK_ADD");
  const pendingClears = sent.filter(
    (msg) => msg.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR",
  );
  assert.equal(quickAdds.length, 1);
  assert.equal(quickAdds[0].payload.item.src, "ffn");
  assert.equal(pendingClears.length, 1);
});

test("mismatched iOS pending first-story URL clears without quick-add", async () => {
  const { sent } = createStoryAutoTrackPendingHarness({
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: {
      ok: true,
      url: "https://m.fanfiction.net/s/9999999/1/Other-Story",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_IOS_PENDING_FIRST_STORY_GET").length,
    1,
  );
  assert.equal(sent.filter((msg) => msg.type === "TRACE_QUICK_ADD").length, 0);
  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR").length,
    1,
  );
});

test("story page auto-track success updates the pending handle to Reading progress", () => {
  const { dom, autoTrackCallback } = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    url: "https://m.fanfiction.net/s/7038840/2/A-Chance-Encounter",
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent || "", /Adding…/);

  autoTrackCallback({
    ok: true,
    entryId: "00000000-0000-4000-8000-000000703884",
    state: {
      accountId: "acct-story",
      workKey: "ffn:7038840",
      operation: "auto_track",
      status: "saved",
      entryId: "00000000-0000-4000-8000-000000703884",
      entry: {
        status: "READING",
        readerStatus: "READING",
        canonicalReaderStatus: "READING",
        entryId: "00000000-0000-4000-8000-000000703884",
        chapters: { current: 2, total: 28 },
      },
    },
  });

  assert.equal(handle.disabled, false);
  assert.match(handle.textContent || "", /Reading.*2\/28/i);
});

test("story page auto-track failure uses existing compact error states", () => {
  const cases = [
    {
      response: {
        ok: false,
        error: "free_limit_reached",
        capacity: { blocked: true, prompt: true },
      },
      expected: /Full/i,
      disabled: false,
    },
    { response: { ok: false, error: "auth_expired" }, expected: /Reconnect/i, disabled: false },
    { response: { ok: false, error: "http_503" }, expected: /^Not saved$/, disabled: false },
  ];

  for (const item of cases) {
    const { dom, autoTrackCallback } = createStoryAutoTrackPendingHarness({
      holdAutoTrack: true,
    });
    const handle = dom.window.document.querySelector("[data-trace-story-handle]");
    assert.match(handle.textContent || "", /Adding…/);

    autoTrackCallback(item.response);

    assert.match(handle.textContent || "", item.expected);
    assert.equal(handle.disabled, item.disabled);
    if (item.response.error === "free_limit_reached") {
      assert.ok(dom.window.document.querySelector("[data-trace-capacity-notice]"));
      handle.click();
      const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
      assert.equal(sheet.getAttribute("data-trace-open"), "1");
      assert.match(sheet.textContent || "", /wasn’t added/i);
      assert.match(sheet.textContent || "", /See Trace Unlimited/i);
      assert.match(sheet.textContent || "", /Manage library/i);
    }
    if (item.response.error === "auth_expired") {
      handle.click();
      const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
      assert.equal(sheet.getAttribute("data-trace-open"), "1");
    }
  }
});

test("story page reconnect state asks Safari to refresh native auth on resume", () => {
  const { dom, sent } = createStoryAutoTrackPendingHarness({
    store: {
      authToken: undefined,
      traceAuthState: { state: "reconnect_required" },
      prefAutoTrackEnabled: false,
    },
    authRefreshResponse: { ok: true },
    authRefreshStorePatch: {
      authToken: "refreshed-token",
      traceAuthState: { state: "connected" },
    },
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent || "", /Reconnect/i);

  dom.window.dispatchEvent(new dom.window.Event("focus"));

  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_IOS_AUTH_REFRESH_REQUEST").length,
    1,
  );
  assert.match(handle.textContent || "", /Add to Trace/i);
});

test("kernel reconnect state never invokes the retired legacy auth-refresh route", () => {
  const { dom, sent } = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    projectionResponse: {
      ok: true,
      snapshot: {
        state: "reconnect_required",
        reason: "credential_missing",
        canExecuteAuthenticated: false,
      },
      projection: {
        entries: {},
        workPreferences: {},
        syncVersion: null,
      },
    },
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent || "", /Reconnect/i);
  dom.window.dispatchEvent(new dom.window.Event("focus"));

  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_IOS_AUTH_REFRESH_REQUEST").length,
    0,
  );
  assert.match(handle.textContent || "", /Reconnect/i);
});

test("first-story focus-add retries explicit quick-add after retryable auto-track failure", async () => {
  const entryId = "00000000-0000-4000-8000-000000703884";
  const { dom, sent, autoTrackCallback, sendRuntimeMessage } =
    createStoryAutoTrackPendingHarness({
      holdAutoTrack: true,
      quickAddResponse: {
        ok: true,
        entryId,
        state: {
          accountId: "acct-story",
          workKey: "ffn:7038840",
          operation: "quick_add",
          status: "saved",
          entryId,
          entry: {
            status: "PLANNING",
            readerStatus: "PLANNING",
            canonicalReaderStatus: "SAVED",
            entryId,
          },
        },
      },
    });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent || "", /Adding…/);

  autoTrackCallback({ ok: false, error: "confirmation_missing" });

  assert.match(handle.textContent || "", /^Not saved$/);
  assert.equal(handle.disabled, false);

  const response = await sendRuntimeMessage({
    type: "TRACE_FIRST_STORY_FOCUS_ADD",
  });

  assert.deepEqual(plainJson(response), { ok: true, state: "saved" });
  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_QUICK_ADD").length,
    1,
  );
});

test("AO3 story places compact Trace handle centered below title and byline", () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><h2 class='title heading'>Demo AO3 Work</h2><h3 class='byline heading'><a rel='author' href='/users/demo/pseuds/demo'>demo</a></h3><dl class='work meta group'><dt class='chapters'>Chapters:</dt><dd class='chapters'>1/1</dd></dl></body></html>",
    {
      url: "https://archiveofourown.org/works/12345",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: { entries: {} },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const byline = dom.window.document.querySelector("h3.byline.heading");
  const wrap = dom.window.document.querySelector("[data-trace-quick-add-wrap]");
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");

  assert.ok(wrap);
  assert.equal(byline.nextElementSibling, wrap);
  assert.match(wrap.getAttribute("style") || "", /justify-content:\s*center/i);
  assert.ok(sheet);
  assert.equal(sheet.parentElement, dom.window.document.documentElement);
  assert.equal(sheet.getAttribute("data-trace-story-sheet-placement"), "popover");
  assert.match(sheet.getAttribute("style") || "", /position:\s*absolute/i);
  assert.match(sheet.getAttribute("style") || "", /top:/i);
  assert.match(sheet.getAttribute("style") || "", /left:/i);
  assert.match(sheet.getAttribute("style") || "", /bottom:\s*auto/i);
  assert.equal(handle.textContent || "", "+ Add to Trace");
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "add");
});

test("mobile story keeps Trace sheet as fixed bottom sheet", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  );
  dom.window.matchMedia = (query) => ({
    matches: String(query).includes("max-width: 640px"),
    media: String(query),
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: {
              entries: {
                "ffn:7038840": {
                  entryId: "entry-mobile-bottom-sheet",
                  status: "READING",
                  readerStatus: "READING",
                  chapters: { current: 1, total: 28 },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  assert.ok(sheet);
  assert.equal(sheet.parentElement, dom.window.document.documentElement);
  assert.equal(sheet.getAttribute("data-trace-story-sheet-placement"), "bottom");
  assert.match(sheet.getAttribute("style") || "", /position:\s*fixed/i);
  assert.match(sheet.getAttribute("style") || "", /bottom:/i);
  assert.match(sheet.getAttribute("style") || "", /max-height:\s*calc\(100dvh - 8px\)/i);
  assert.doesNotMatch(sheet.getAttribute("style") || "", /max-height:\s*min\(70vh,\s*460px\)/i);
  assert.doesNotMatch(sheet.getAttribute("style") || "", /width:\s*100%/i);

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  handle.click();
  assert.equal(sheet.getAttribute("aria-hidden"), "false");
  assert.equal(dom.window.document.body.style.overflow, "hidden");
  const grabber = sheet.querySelector("[data-trace-bottom-sheet-grabber]");
  assert.ok(grabber, "expected bottom sheet grabber");
  assert.match(grabber.getAttribute("style") || "", /height:\s*28px/i);
  assert.match(grabber.getAttribute("style") || "", /cursor:\s*grab/i);
  grabber.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientY: 100 }));
  grabber.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientY: 172 }));
  grabber.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientY: 172 }));
  assert.equal(sheet.getAttribute("aria-hidden"), "true");
  assert.equal(dom.window.document.body.style.overflow, "");
});

function createStorySheetModalHarness(options = {}) {
  const dom = new JSDOM(
    "<!doctype html><html><body style='position:relative'><a id='before' href='#before'>Before</a><h2 class='title heading'>Accessible AO3 Work</h2><h3 class='byline heading'><a rel='author' href='/users/demo/pseuds/demo'>demo</a></h3><dl class='work meta group'><dt class='chapters'>Chapters:</dt><dd class='chapters'>4/12</dd></dl><div id='chapters'><div class='chapter' id='chapter-4'><p>Test chapter.</p></div></div></body></html>",
    {
      url: "https://archiveofourown.org/works/77890/chapters/4",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  dom.window.matchMedia = (query) => ({
    matches:
      (options.mobile === true && String(query).includes("max-width: 640px")) ||
      (options.reducedMotion === true && String(query).includes("prefers-reduced-motion")),
    media: String(query),
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const entry = {
    entryId: "entry-story-modal",
    status: "READING",
    readerStatus: "READING",
    chapters: { current: 4, total: 12 },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        if (
          typeof options.onSendMessage === "function" &&
          options.onSendMessage(message, callback) === true
        ) {
          return;
        }
        if (typeof callback === "function") callback({ ok: true });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: {
              entries: { "ao3:77890": entry },
            },
          });
        },
        set(_value, callback) {
          if (typeof callback === "function") callback();
        },
      },
      onChanged: { addListener() {} },
    },
  };
  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );
  return { dom, entry };
}

test("story bottom sheet contains focus and restores the archive after Escape or outside click", async () => {
  const { dom } = createStorySheetModalHarness({ mobile: true });
  Object.defineProperty(dom.window, "scrollX", { value: 8, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 360, configurable: true });
  const restoredScroll = [];
  dom.window.scrollTo = (x, y) => restoredScroll.push([x, y]);
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");

  handle.focus();
  handle.click();
  await delay(20);
  assert.equal(handle.getAttribute("aria-haspopup"), "dialog");
  assert.equal(handle.getAttribute("aria-controls"), sheet.id);
  assert.equal(handle.getAttribute("aria-expanded"), "true");
  assert.equal(sheet.getAttribute("role"), "dialog");
  assert.equal(sheet.getAttribute("aria-modal"), "true");
  const title = dom.window.document.getElementById(sheet.getAttribute("aria-labelledby"));
  const description = dom.window.document.getElementById(sheet.getAttribute("aria-describedby"));
  assert.ok(title);
  assert.match(title.textContent || "", /Accessible AO3 Work/i);
  assert.ok(description);
  assert.match(description.textContent || "", /reading status and private Trace actions/i);
  const statusGroup = sheet.querySelector("[data-trace-status-choices] [role='radiogroup']");
  const ratingGroup = sheet.querySelector("[data-trace-rating-control] [role='group']");
  assert.equal(
    dom.window.document.getElementById(statusGroup.getAttribute("aria-labelledby")).textContent,
    "Reading status",
  );
  assert.equal(
    dom.window.document.getElementById(ratingGroup.getAttribute("aria-labelledby")).textContent,
    "Your rating",
  );
  const firstRating = sheet.querySelector("[data-trace-rating-choice='1']");
  assert.equal(firstRating.getAttribute("aria-label"), "Set rating to 1 out of 5");
  assert.equal(firstRating.getAttribute("aria-pressed"), "false");
  assert.equal(dom.window.document.body.hasAttribute("inert"), true);
  assert.equal(dom.window.document.body.style.position, "fixed");
  assert.equal(dom.window.document.body.style.top, "-360px");
  assert.equal(dom.window.document.activeElement.getAttribute("data-trace-status-choice"), "READING");

  const focusables = Array.from(sheet.querySelectorAll("button:not([disabled]), a[href]"));
  focusables.at(-1).focus();
  sheet.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(dom.window.document.activeElement, focusables[0]);
  focusables[0].focus();
  sheet.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
  );
  assert.equal(dom.window.document.activeElement, focusables.at(-1));

  Object.defineProperty(dom.window, "scrollY", { value: 0, configurable: true });
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(sheet.getAttribute("aria-hidden"), "true");
  assert.equal(sheet.getAttribute("aria-modal"), "false");
  assert.equal(handle.getAttribute("aria-expanded"), "false");
  assert.equal(dom.window.document.body.hasAttribute("inert"), false);
  assert.equal(dom.window.document.body.style.position, "relative");
  assert.deepEqual(restoredScroll, [[8, 360]]);
  assert.equal(dom.window.document.activeElement, handle);

  handle.click();
  await delay(20);
  const outsideClick = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  const outsideDispatched = dom.window.document.body.dispatchEvent(outsideClick);
  assert.equal(outsideDispatched, false);
  assert.equal(outsideClick.defaultPrevented, true);
  assert.equal(sheet.getAttribute("aria-hidden"), "true");
  assert.equal(dom.window.document.activeElement, handle);
});

test("story sheet teardown restores the host page when its anchor disappears", async () => {
  const { dom } = createStorySheetModalHarness({ mobile: true });
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  handle.click();
  await delay(20);
  assert.equal(dom.window.document.body.hasAttribute("inert"), true);

  dom.window.eval("removeQuickAddElements()");

  assert.equal(dom.window.document.querySelector("[data-trace-story-sheet]"), null);
  assert.equal(dom.window.document.querySelector("[data-trace-story-handle]"), null);
  assert.equal(dom.window.document.body.hasAttribute("inert"), false);
  assert.equal(dom.window.document.body.style.position, "relative");
  assert.equal(dom.window.document.documentElement.style.overflow, "");
});

test("story desktop popover scrolls with the page and closes when its handle leaves view", async () => {
  const { dom } = createStorySheetModalHarness();
  Object.defineProperty(dom.window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 700, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 600, configurable: true });
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  let handleTop = 100;
  handle.getBoundingClientRect = () => ({
    top: handleTop, bottom: handleTop + 30, left: 460, right: 540, width: 80, height: 30,
  });
  handle.focus();
  handle.click();
  await delay(20);

  assert.equal(sheet.getAttribute("data-trace-story-sheet-placement"), "popover");
  assert.equal(sheet.getAttribute("aria-modal"), "false");
  assert.match(sheet.getAttribute("style") || "", /position:\s*absolute/i);
  assert.equal(sheet.style.top, "738px", "placed in document coordinates below the handle");
  const body = dom.window.document.body;
  assert.equal(body.hasAttribute("inert"), false);
  assert.equal(body.style.overflow, "");
  assert.equal(body.style.position, "relative");
  assert.equal(dom.window.document.documentElement.style.overflow, "");
  assert.ok(sheet.contains(dom.window.document.activeElement), "focus moves into the popover");

  handleTop = -10;
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(sheet.getAttribute("aria-hidden"), "false", "a partly visible handle keeps it open");

  handleTop = 720;
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(sheet.getAttribute("aria-hidden"), "true");
  assert.equal(handle.getAttribute("aria-expanded"), "false");
  assert.equal(dom.window.document.activeElement, handle);

  handleTop = 100;
  handle.click();
  await delay(20);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(sheet.getAttribute("aria-hidden"), "true");
  handle.click();
  await delay(20);
  dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(sheet.getAttribute("aria-hidden"), "true");
});

test("story desktop popover chooses the visible side of its trigger", () => {
  const { dom } = createStorySheetModalHarness();
  Object.defineProperty(dom.window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 640, configurable: true });
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  handle.getBoundingClientRect = () => ({
    top: 590,
    right: 790,
    bottom: 620,
    left: 710,
    width: 80,
    height: 30,
  });
  sheet.getBoundingClientRect = () => ({
    top: 0,
    right: 360,
    bottom: 420,
    left: 0,
    width: 360,
    height: 420,
  });

  handle.click();
  assert.equal(sheet.getAttribute("data-trace-popover-side"), "above");
  assert.equal(sheet.style.top, "162px");
  assert.equal(sheet.style.left, "430px");
  assert.equal(sheet.style.maxHeight, "620px");
});

test("story sheet keeps a pending mutation open and announces its result", async () => {
  let pendingCallback = null;
  const { dom } = createStorySheetModalHarness({
    onSendMessage(message, callback) {
      if (message.type !== "TRACE_SET_READER_STATUS") return false;
      pendingCallback = callback;
      return true;
    },
  });
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  handle.click();
  dom.window.document
    .querySelector("[data-trace-story-sheet] [data-trace-status-choice='FINISHED']")
    .click();
  await delay(20);

  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const live = dom.window.document.querySelector("[data-trace-story-live-region]");
  assert.ok(live);
  assert.equal(sheet.getAttribute("data-trace-modal-pending"), "1");
  assert.equal(sheet.getAttribute("aria-busy"), "true");
  assert.match(live.textContent || "", /Saving reading status as Finished/i);
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(sheet.getAttribute("aria-hidden"), "false");
  await delay(20);
  assert.match(live.textContent || "", /still in progress/i);

  pendingCallback({ ok: true, status: "FINISHED" });
  await delay(30);
  assert.match(live.textContent || "", /Reading status saved as Finished/i);
  assert.notEqual(sheet.getAttribute("data-trace-modal-pending"), "1");
  assert.equal(sheet.hasAttribute("aria-busy"), false);
});

test("story sheet prevents overlapping mutations while a save is pending", async () => {
  let ratingCallback = null;
  let statusRequests = 0;
  const { dom } = createStorySheetModalHarness({
    onSendMessage(message, callback) {
      if (message.type === "TRACE_PATCH_LIBRARY_ENTRY") {
        ratingCallback = callback;
        return true;
      }
      if (message.type === "TRACE_SET_READER_STATUS") {
        statusRequests += 1;
        return true;
      }
      return false;
    },
  });
  dom.window.document.querySelector("[data-trace-story-handle]").click();
  await delay(20);
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  sheet.querySelector("[data-trace-rating-choice='4']").click();
  sheet.querySelector("[data-trace-status-choice='FINISHED']").click();
  await delay(20);

  assert.equal(typeof ratingCallback, "function");
  assert.equal(statusRequests, 0);
  assert.equal(sheet.getAttribute("aria-busy"), "true");
  assert.match(
    dom.window.document.querySelector("[data-trace-story-live-region]").textContent || "",
    /still in progress/i,
  );

  ratingCallback({ ok: true });
  await delay(20);
  assert.equal(sheet.hasAttribute("aria-busy"), false);
});

test("story bottom sheet removes drag recovery motion when reduced motion is requested", () => {
  const { dom } = createStorySheetModalHarness({ mobile: true, reducedMotion: true });
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  handle.click();
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const grabber = sheet.querySelector("[data-trace-bottom-sheet-grabber]");
  grabber.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientY: 100 }));
  grabber.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientY: 120 }));
  grabber.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientY: 120 }));
  assert.equal(sheet.style.transition, "");
  assert.equal(sheet.style.transform, "translateX(-50%)");
});

test("FFN desktop story places compact Trace handle after profile header", () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='profile_top'><b class='xcontrast_txt'>Demo FFN Work</b> by <a href='/u/1/demo'>demo</a><div class='xcontrast_txt'>A long enough story summary for Trace collection to ignore title-only nodes.</div><span class='xgray xcontrast_txt'>Rated: Fiction T - English - Chapters: 3 - Words: 12,345</span></div><div id='storytext'>Test chapter.</div></body></html>",
    {
      url: "https://www.fanfiction.net/s/67890/1/Demo-FFN-Work",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: { entries: {} },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const profileTop = dom.window.document.querySelector("#profile_top");
  const wrap = dom.window.document.querySelector("[data-trace-quick-add-wrap]");
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");

  assert.ok(wrap);
  assert.equal(profileTop.nextElementSibling, wrap);
  assert.equal(profileTop.querySelector("[data-trace-story-handle]"), null);
  assert.equal(handle.textContent || "", "+ Add to Trace");
  assert.equal(handle.getAttribute("data-trace-story-handle-state"), "add");
});

test("FFN mobile story quick-add shows planning after chapter-one success", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const sent = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (typeof cb === "function") cb({ ok: true, data: { entryId: "entry-1" } });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: { entries: {} },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  dom.window.setTimeout = (fn) => {
    fn();
    return 1;
  };
  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected quick-add handle on FFN mobile story page");
  handle.click();

  const quickAdd1 = sent.find((msg) => msg && msg.payload && msg.payload.item);
  assert.ok(quickAdd1, "expected a quick-add message with a payload item");
  assert.equal(quickAdd1.payload.item.chn, 1);
  assert.match(handle.textContent || "", /Saved/i);
  assert.equal(dom.window.document.querySelector("[data-trace-status-choice]"), null);
});

test("FFN mobile story quick-add shows reading progress after later-chapter success", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/2/A-Chance-Encounter"
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const sent = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (typeof cb === "function") cb({ ok: true });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: { entries: {} },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  dom.window.setTimeout = (fn) => {
    fn();
    return 1;
  };
  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected quick-add handle on FFN mobile story page");
  handle.click();

  const quickAdd2 = sent.find((msg) => msg && msg.payload && msg.payload.item);
  assert.ok(quickAdd2, "expected a quick-add message with a payload item");
  assert.equal(quickAdd2.payload.item.chn, 2);
  assert.match(handle.textContent || "", /Reading.*2\/28/i);
});

test("FFN mobile story quick-add shows optional post-add status choices when entryId exists", () => {
  const entryId = "00000000-0000-4000-8000-000000000321";
  const choices = [
    { label: "Saved", status: "SAVED", expected: /Saved/i },
    { label: "Reading", status: "READING", expected: /Reading/i },
    { label: "Caught up", status: "CAUGHT_UP", expected: /Caught up/i },
    { label: "Paused", status: "PAUSED", expected: /Paused/i },
    { label: "Finished", status: "FINISHED", expected: /Finished/i },
    { label: "Dropped", status: "DROPPED", expected: /Dropped/i },
  ];

  for (const choice of choices) {
    const dom = domFromFixture(
      "ffn_story_mobile.html",
      "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
    );
    const collectorSrc = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "Shared (Extension)",
        "Resources",
        "collector.js",
      ),
      "utf8",
    );

    const sent = [];
    const chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(msg, cb) {
          sent.push(msg);
          if (msg.type === "TRACE_QUICK_ADD" && typeof cb === "function") {
            cb({ ok: true, entryId });
          } else if (msg.type === "TRACE_SET_READER_STATUS" && typeof cb === "function") {
            cb({ ok: true, entryId, status: msg.payload.status });
          }
        },
        lastError: null,
      },
      storage: {
        local: {
          get(_keys, cb) {
            cb({
              authToken: "test-token",
              prefAutoTrackEnabled: false,
              libraryOverlayCache: { entries: {} },
            });
          },
          set(_value, cb) {
            if (typeof cb === "function") cb();
          },
        },
        onChanged: { addListener() {} },
      },
    };

    dom.window.setTimeout = (fn) => {
      fn();
      return 1;
    };
    installCollectorChrome(dom, chrome);
    dom.window.eval(collectorTestSource(collectorSrc));
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );

    const handle = dom.window.document.querySelector("[data-trace-story-handle]");
    handle.click();
    handle.click();

    const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
    assert.match(sheet.textContent || "", /Reading status/i);
    assert.deepEqual(
      Array.from(sheet.querySelectorAll("[data-trace-status-choice]")).map((button) => button.textContent),
      ["Saved", "Reading", "Caught up", "Paused", "Finished", "Dropped"],
    );
    const choiceBtn = sheet.querySelector(
      `[data-trace-status-choice='${choice.status}']`,
    );
    assert.ok(choiceBtn, `expected ${choice.label} status choice`);
    choiceBtn.click();

    assert.equal(sent.at(-1).type, "TRACE_SET_READER_STATUS");
    assert.deepEqual(plainJson(sent.at(-1).payload), {
      workKey: "ffn:7038840",
      entryId,
      status: choice.status,
    });
    assert.equal(sheet.getAttribute("data-trace-open"), "1");
    assert.equal(sheet.getAttribute("aria-hidden"), "false");
    assert.match(sheet.textContent || "", choice.expected);
  }
});

test("story sheet shows status editing for cached entries with entryId and hides it without entryId", () => {
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000703884";

  for (const includeEntryId of [true, false]) {
    const dom = domFromFixture(
      "ffn_story_mobile.html",
      "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
    );
    const sent = [];
    const entry = {
      status: "READING",
      readerStatus: "READING",
      chapters: { current: 3, total: 28 },
    };
    if (includeEntryId) entry.entryId = entryId;

    const chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(msg, cb) {
          sent.push(msg);
          if (msg.type === "TRACE_SET_READER_STATUS" && typeof cb === "function") {
            cb({ ok: true, entryId, status: msg.payload.status });
          }
        },
        lastError: null,
      },
      storage: {
        local: {
          get(_keys, cb) {
            cb({
              authToken: "test-token",
              libraryOverlayCache: {
                entries: {
                  "ffn:7038840": entry,
                },
              },
            });
          },
          set(_value, cb) {
            if (typeof cb === "function") cb();
          },
        },
        onChanged: { addListener() {} },
      },
    };

    installCollectorChrome(dom, chrome);
    dom.window.eval(collectorTestSource(collectorSrc));
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );

    const handle = dom.window.document.querySelector("[data-trace-story-handle]");
    assert.ok(handle);
    assert.doesNotMatch(handle.getAttribute("style") || "", /inset 2px 0 0/i);
    handle.getBoundingClientRect = () => ({
      left: 120,
      top: 100,
      right: 200,
      bottom: 140,
      width: 80,
      height: 40,
    });
    handle.click();

    const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
    assert.equal(sheet.getAttribute("aria-hidden"), "false");
    assert.match(sheet.className || "", /\bx\b/);
    assert.match(sheet.className || "", /\bx-sheet\b/);
    assert.match(sheet.getAttribute("style") || "", /top:\s*148px/i);
    handle.click();
    assert.equal(sheet.getAttribute("aria-hidden"), "true");
    handle.click();
    assert.equal(sheet.getAttribute("aria-hidden"), "false");
    const header = sheet.querySelector("[data-trace-management-header]");
    assert.ok(header);
    assert.match(header.className || "", /\bx-sheet-head\b/);
    // The site sits in the byline; the sheet has no "Trace ·" eyebrow.
    assert.match(header.textContent || "", /·\s*FFN/i);
    assert.doesNotMatch(header.textContent || "", /Trace\s*·/i);
    assert.ok(sheet.querySelector(".x-sheet-body"));
    assert.ok(sheet.querySelector(".x-sheet-foot"));
    const choices = sheet.querySelector("[data-trace-status-choices]");
    if (!includeEntryId) {
      assert.equal(choices, null);
      continue;
    }

    assert.ok(choices);
    assert.ok(choices.querySelector(".x-sheet-label"));
    assert.ok(choices.querySelector(".x-seg"));
    const selected = choices.querySelector("[data-trace-status-selected='1']");
    assert.ok(selected);
    assert.equal(selected.getAttribute("data-trace-status-choice"), "READING");
    assert.equal(selected.getAttribute("role"), "radio");
    assert.equal(selected.getAttribute("aria-checked"), "true");
    assert.match(selected.className || "", /\bon\b/);
    assert.equal(sheet.querySelector("button[data-trace-quick-add]"), null);
    const hideBtn = sheet.querySelector("button[data-trace-hidden-action='hide']");
    assert.ok(hideBtn);
    assert.doesNotMatch(hideBtn.className || "", /\bicon-only\b/);
    assert.match(hideBtn.textContent || "", /Hide/i);
    assert.equal(hideBtn.getAttribute("aria-label"), "Hide this work");
    assert.deepEqual(
      Array.from(choices.querySelectorAll("[data-trace-status-choice]")).map((button) => button.textContent),
      ["Saved", "Reading", "Caught up", "Paused", "Finished", "Dropped"],
    );
    const finished = choices.querySelector("[data-trace-status-choice='FINISHED']");
    assert.ok(finished);
    finished.click();
    assert.deepEqual(plainJson(sent.at(-1)), {
      type: "TRACE_SET_READER_STATUS",
      payload: { workKey: "ffn:7038840", entryId, status: "FINISHED" },
    });
  }
});

test("story sheet selected status choice uses the B2 raised cell with an ink ring and status accent", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() {},
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:7038840": {
                  entryId: "00000000-0000-4000-8000-000000703884",
                  status: "PAUSED",
                  readerStatus: "PAUSED",
                  chapters: { current: 3, total: 28 },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  handle.click();

  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const selected = sheet.querySelector("[data-trace-status-selected='1']");
  assert.equal(selected.getAttribute("data-trace-status-choice"), "PAUSED");
  assert.match(selected.getAttribute("style") || "", /background:\s*var\(--trace-page-raised\)/i);
  assert.match(selected.getAttribute("style") || "", /box-shadow:\s*inset 0 0 0 2px var\(--trace-page-ink\)/i);
  assert.match(selected.getAttribute("style") || "", /border-radius:\s*12px/i);
  assert.match(
    selected.getAttribute("style") || "",
    /--sc:\s*var\(--trace-page-status-paused\)/i,
  );
  assert.doesNotMatch(
    selected.getAttribute("style") || "",
    /background:\s*rgba\(154,\s*149,\s*131,\s*0\.12\)/,
  );
});

test("story sheet Planning to Reading sends chapter progress 1 and displays 1/? for unknown total", () => {
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000703885";
  const sent = [];
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (msg.type === "TRACE_AUTO_TRACK" && typeof cb === "function") {
          cb({
            ok: true,
            state: {
              workKey: "ffn:7038840",
              status: "saved",
              entryId,
              entry: {
                entryId,
                status: "PLANNING",
                readerStatus: "PLANNING",
                canonicalReaderStatus: "SAVED",
                chapters: { current: 0, total: null },
              },
            },
          });
          return;
        }
        if (msg.type === "TRACE_SET_READER_STATUS" && typeof cb === "function") {
          cb({ ok: true, entryId, status: msg.payload.status });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:7038840": {
                  entryId,
                  status: "PLANNING",
                  readerStatus: "PLANNING",
                  chapters: { current: 0, total: null },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  handle.click();
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const reading = sheet.querySelector("[data-trace-status-choice='READING']");
  assert.ok(reading);
  reading.click();

  assert.deepEqual(plainJson(sent.at(-1)), {
    type: "TRACE_SET_READER_STATUS",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      status: "READING",
      progress: { unit: "CHAPTER", value: 1, total: null },
    },
  });
  assert.match(handle.textContent || "", /Reading\s*1\/\?/i);
  assert.equal(sheet.getAttribute("data-trace-open"), "1");
  assert.equal(sheet.getAttribute("aria-hidden"), "false");
  assert.doesNotMatch(handle.textContent || "", /·/i);
  assert.doesNotMatch(handle.textContent || "", /Reading\s*0\/\?/i);
});


test("finish qualify watches AO3 chapter text and routes resolution through the finish endpoint", async () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000777";
  const sent = [];
  let watchedBody = null;
  let toastShown = false;
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">AO3 Notes Boundary</h2>
      <h3 class="byline heading"><a rel="author" href="/users/demo/pseuds/demo">demo</a></h3>
      <ul class="required-tags"><li><span class="rating" title="Teen And Up Audiences"><span class="text">Teen</span></span><span title="Complete Work">Complete Work</span></li></ul>
      <dl class="work meta group"><dd class="chapters">1/1</dd><dd class="words">100</dd></dl>
      <div id="chapters">
        <div class="chapter" id="chapter-1">
          <div class="chapter preface group"><h3 class="title">Chapter 1</h3></div>
          <div class="userstuff module" role="article" data-test-id="chapter-text">
            <p>This is the actual story body.</p>
          </div>
          <div class="chapter preface group">
            <div class="end notes module" id="chapter_1_endnotes">
              <h3 class="heading">Notes:</h3>
              <blockquote class="userstuff"><p>Long end notes should not delay finish evidence.</p></blockquote>
            </div>
          </div>
        </div>
      </div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/777/chapters/888",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (
          msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" &&
          msg.payload.state === "resolved" &&
          typeof cb === "function"
        ) {
          cb({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "resolved",
              eventId: null,
              entry: {
                entryId,
                status: "FINISHED",
                readerStatus: "FINISHED",
                canonicalReaderStatus: "FINISHED",
                chapters: { current: 1, total: 1 },
              },
            },
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ao3:777": {
                  entryId,
                  status: "READING",
                  readerStatus: "READING",
                  chapters: { current: 1, total: 1 },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  dom.window.TraceFinishQualify = {
    onReachEnd(bodyEl, cb) {
      watchedBody = bodyEl;
      cb();
      return function () {};
    },
    toast() {
      toastShown = true;
    },
  };
  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(watchedBody, dom.window.document.querySelector("[data-test-id='chapter-text']"));
  assert.notEqual(watchedBody, dom.window.document.querySelector("#chapters"));
  assert.equal(toastShown, true);
  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL").length,
    1,
  );
  assert.equal(sent.some((msg) => msg.type === "TRACE_PATCH_LIBRARY_ENTRY"), false);
  assert.deepEqual(plainJson(sent.find((msg) => msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL").payload), {
    entryId,
    workKey: "ao3:777",
    source: "ao3",
    chapter: 1,
    total: 1,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
});

test("one-shot finish evidence survives the initial Saved round-trip", async () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000779";
  const sent = [];
  const endCallbacks = [];
  let autoTrackCallback = null;
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">Fast one-shot</h2>
      <h3 class="byline heading"><a rel="author">Author</a></h3>
      <ul class="required-tags"><li><span title="Complete Work">Complete Work</span></li></ul>
      <dl class="work meta group"><dd class="chapters">1/1</dd></dl>
      <div id="chapters"><div class="chapter" id="chapter-1">
        <div class="userstuff module" role="article"><p>A short story.</p></div>
      </div></div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/779/chapters/880",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const store = {
    authToken: "test-token",
    prefAutoTrackEnabled: true,
    libraryOverlayCache: { entries: {} },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === "TRACE_AUTO_TRACK") {
          autoTrackCallback = callback;
          return;
        }
        if (message.type === "TRACE_WORK_STATE_GET") {
          callback?.({ ok: false });
          return;
        }
        if (message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL") {
          callback?.({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "resolved",
              eventId: null,
              workKey: "ao3:779",
              entry: {
                entryId,
                status: "FINISHED",
                readerStatus: "FINISHED",
                canonicalReaderStatus: "FINISHED",
                chapters: { current: 1, total: 1 },
              },
            },
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback(store);
        },
        set(value, callback) {
          Object.assign(store, value);
          callback?.();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  dom.window.TraceFinishQualify = {
    onReachEnd(_body, callback) {
      endCallbacks.push(callback);
      return function () {};
    },
    toast() {},
  };
  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );
  await delay(0);

  assert.ok(endCallbacks.length > 0, "reading evidence should be armed before save confirmation");
  assert.equal(typeof autoTrackCallback, "function");
  endCallbacks[0]();
  assert.equal(
    sent.some((message) => message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL"),
    false,
    "end evidence alone must not invent an entry",
  );

  autoTrackCallback({
    ok: true,
    entryId,
    state: {
      accountId: "acct-story",
      workKey: "ao3:779",
      operation: "auto_track",
      status: "saved",
      entryId,
      entry: {
        entryId,
        status: "SAVED",
        readerStatus: "SAVED",
        canonicalReaderStatus: "SAVED",
        chapters: { current: 0, total: 1 },
      },
    },
  });
  await delay(0);

  const finish = sent.find(
    (message) => message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL",
  );
  assert.ok(finish, "confirmed Saved entry should consume retained end evidence");
  assert.deepEqual(plainJson(finish.payload), {
    entryId,
    workKey: "ao3:779",
    source: "ao3",
    chapter: 1,
    total: 1,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
});

test("finish qualify on AO3 Entire Work waits for crossing the final rendered chapter end", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000778";
  const sent = [];
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">Entire Work Finish</h2>
      <h3 class="byline heading"><a rel="author">Author</a></h3>
      <ul class="required-tags"><li><span title="Complete Work">Complete Work</span></li></ul>
      <dl class="work meta group"><dd class="chapters">3/3</dd></dl>
      <div id="chapters">
        <div class="chapter" id="chapter-101"><div class="userstuff module" role="article">One</div></div>
        <div class="chapter" id="chapter-205"><div class="userstuff module" role="article">Two</div></div>
        <div class="chapter" id="chapter-999"><div data-final-body class="userstuff module" role="article">Three</div></div>
      </div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/778?view_full_work=true",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  let finalRect = { top: 750, bottom: 1_250 };
  const finalBody = dom.window.document.querySelector("[data-final-body]");
  finalBody.getBoundingClientRect = () => finalRect;
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" && callback) {
          callback({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "resolved",
              eventId: null,
              workKey: "ao3:778",
              entry: {
                entryId,
                status: "COMPLETED",
                readerStatus: "COMPLETED",
                canonicalReaderStatus: "FINISHED",
                chapters: { current: 3, total: 3 },
              },
            },
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ao3:778": {
                  entryId,
                  status: "READING",
                  readerStatus: "READING",
                  canonicalReaderStatus: "READING",
                  chapters: { current: 3, total: 3 },
                },
              },
            },
          });
        },
        set(_value, callback) {
          if (callback) callback();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(finishSrc);
  // The dwell itself is covered in end-of-story.test.js.
  const onReachEnd = dom.window.TraceFinishQualify.onReachEnd;
  dom.window.TraceFinishQualify.onReachEnd = (body, callback) =>
    onReachEnd(body, callback, { dwellMs: 0 });
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

  assert.equal(
    sent.filter((message) => message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL").length,
    0,
    "rendering the full work must not finish it on page load",
  );
  const autoTrack = sent.find((message) => message.type === "TRACE_AUTO_TRACK");
  assert.equal(
    autoTrack?.payload?.item?.chn,
    1,
    "rendering all chapters alone must not auto-track final-chapter progress",
  );
  finalBody.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true }));
  finalRect = { top: 350, bottom: 850 };
  dom.window.dispatchEvent(new dom.window.Event("scroll"));

  const finishSignals = sent.filter(
    (message) => message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL",
  );
  assert.equal(finishSignals.length, 1);
  assert.equal(finishSignals[0].payload.chapter, 3);
  assert.equal(finishSignals[0].payload.total, 3);
});

test("finish qualify band marks an unknown ongoing FFN final chapter caught up through the finish endpoint", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000901";
  const sent = [];
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/28/A-Chance-Encounter"
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" && typeof cb === "function") {
          if (msg.payload.state === "open") {
            cb({
              ok: true,
              command: {
                kind: "acknowledged",
                state: "open",
                eventId: null,
                entry: {
                  entryId,
                  status: "READING",
                  readerStatus: "READING",
                  canonicalReaderStatus: "READING",
                  chapters: { current: 28, total: 28 },
                },
              },
            });
            return;
          }
          cb({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "resolved",
              eventId: null,
              entry: {
                entryId,
                status: "CAUGHT_UP",
                readerStatus: "CAUGHT_UP",
                canonicalReaderStatus: "CAUGHT_UP",
                chapters: { current: 28, total: 28 },
                workStatus: "wip",
                workStatusProvenance: "override",
              },
            },
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:7038840": {
                  entryId,
                  status: "READING",
                  readerStatus: "READING",
                  chapters: { current: 28, total: 28 },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  dom.window.eval(finishSrc);
  const onReachEnd = dom.window.TraceFinishQualify.onReachEnd;
  dom.window.TraceFinishQualify.onReachEnd = (body, callback) =>
    onReachEnd(body, callback, { dwellMs: 0 });
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );
  dom.window.document.querySelector("#storycontent").dispatchEvent(
    new dom.window.Event("touchend", { bubbles: true }),
  );

  const band = dom.window.document.querySelector("[data-trace-finish-qualify]");
  assert.ok(band);
  assert.match(band.textContent || "", /reached the latest chapter/i);
  const openSignal = sent.find(
    (msg) => msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" && msg.payload.state === "open",
  );
  assert.deepEqual(plainJson(openSignal.payload), {
    entryId,
    workKey: "ffn:7038840",
    source: "ffn",
    chapter: 28,
    total: 28,
    state: "open",
  });
  assert.deepEqual(
    Array.from(band.querySelectorAll("[data-trace-work-choice]")).map((button) => button.textContent),
    ["It’s complete", "Still ongoing", "On hiatus", "Looks abandoned"],
  );
  const ongoing = band.querySelector("[data-trace-work-choice='wip']");
  assert.ok(ongoing);
  ongoing.click();

  assert.equal(sent.some((msg) => msg.type === "TRACE_PATCH_LIBRARY_ENTRY"), false);
  const resolvedSignal = sent.find(
    (msg) => msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" && msg.payload.state === "resolved",
  );
  assert.deepEqual(plainJson(resolvedSignal.payload), {
    entryId,
    workKey: "ffn:7038840",
    source: "ffn",
    chapter: 28,
    total: 28,
    state: "resolved",
    workStatus: "wip",
    resolutionSource: "reader",
  });
  assert.match(band.textContent || "", /Caught up/i);
  assert.match(band.textContent || "", /Marked ongoing/i);
  // Work-status choices are words; the resolved state confirms with an ink check.
  assert.equal(band.querySelector("[data-trace-work-choice]"), null);
  assert.doesNotMatch(band.getAttribute("style") || "", /Geist|Manrope|rgb\(255,\s*253,\s*248\)/);
});

test("finish qualify inserts AO3 prompt right after the chapter text, before end notes, aligned to the text column", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000903";
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">AO3 Two Notes</h2>
      <h3 class="byline heading"><a rel="author" href="/users/demo/pseuds/demo">demo</a></h3>
      <dl class="work meta group"><dd class="chapters">1/?</dd><dd class="words">100</dd></dl>
      <div id="chapters">
        <div class="chapter" id="chapter-1">
          <div class="chapter preface group"><h3 class="title">Chapter 1</h3></div>
          <div class="userstuff module" role="article"><p>This is the actual story body.</p></div>
          <div class="chapter preface group">
            <div class="end notes module" id="chapter_1_endnotes">
              <h3 class="heading">Notes:</h3>
              <blockquote class="userstuff"><p>Chapter notes.</p></blockquote>
            </div>
          </div>
        </div>
      </div>
      <div class="afterword preface group">
        <div id="work_endnotes" class="end notes module">
          <h3 class="heading">Notes:</h3>
          <blockquote class="userstuff"><p>Work notes.</p></blockquote>
        </div>
      </div>
      <div id="feedback" class="feedback"></div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/903/chapters/904",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) {
        if (typeof cb === "function") {
          cb({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "open",
              eventId: null,
              entry: {
                entryId,
                status: "READING",
                readerStatus: "READING",
                canonicalReaderStatus: "READING",
                chapters: { current: 1, total: 1 },
              },
            },
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ao3:903": {
                  entryId,
                  status: "READING",
                  readerStatus: "READING",
                  chapters: { current: 1, total: 1 },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  dom.window.eval(finishSrc);
  const onReachEnd = dom.window.TraceFinishQualify.onReachEnd;
  dom.window.TraceFinishQualify.onReachEnd = (body, callback) =>
    onReachEnd(body, callback, { dwellMs: 0 });
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );
  dom.window.document.querySelector("[role='article']").dispatchEvent(
    new dom.window.Event("touchend", { bubbles: true }),
  );

  const band = dom.window.document.querySelector("[data-trace-finish-qualify]");
  const article = dom.window.document.querySelector("[role='article']");
  const chapterEndNotes = dom.window.document.querySelector("#chapter_1_endnotes");
  const workEndNotes = dom.window.document.querySelector("#work_endnotes");
  assert.ok(band);
  assert.equal(article.nextElementSibling, band);
  assert.ok(band.compareDocumentPosition(chapterEndNotes) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(band.compareDocumentPosition(workEndNotes) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(band.getAttribute("style") || "", /max-width:\s*520px/);
  assert.match(band.getAttribute("style") || "", /margin:\s*16px 0/);
});

test("finish qualify falls back to the AO3 chapters boundary when a work skin distorts article geometry", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000768805";
  const sent = [];
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">Unknown two-chapter work</h2>
      <h3 class="byline heading"><a rel="author">Author</a></h3>
      <dl class="work meta group"><dd class="chapters">2/?</dd></dl>
      <select id="selected_id">
        <option value="201225900">1. First chapter</option>
        <option selected value="201225961">2. Final posted chapter</option>
      </select>
      <div id="chapters"><div class="chapter" id="chapter-2">
        <div class="userstuff module" role="article"><p>Story body.</p></div>
      </div></div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/76880511/chapters/201225961",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const body = dom.window.document.querySelector("[role='article']");
  const chapters = dom.window.document.querySelector("#chapters");
  let chaptersRect = { top: 100, bottom: 1_400 };
  body.getBoundingClientRect = () => ({ top: 100, bottom: 1_400 });
  chapters.getBoundingClientRect = () => chaptersRect;
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });

  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(message, callback) {
        sent.push(message);
        if (
          message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" &&
          message.payload.state === "open" &&
          typeof callback === "function"
        ) {
          callback({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "open",
              eventId: null,
              workKey: "ao3:76880511",
              entry: {
                entryId,
                status: "READING",
                readerStatus: "READING",
                canonicalReaderStatus: "READING",
                chapters: { current: 2, total: 2 },
              },
            },
          });
        }
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ao3:76880511": {
                  entryId,
                  status: "READING",
                  readerStatus: "READING",
                  canonicalReaderStatus: "READING",
                  chapters: { current: 2, total: 2 },
                },
              },
            },
          });
        },
        set(_value, callback) {
          if (callback) callback();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(finishSrc);
  const onReachEnd = dom.window.TraceFinishQualify.onReachEnd;
  dom.window.TraceFinishQualify.onReachEnd = (endElement, callback) =>
    onReachEnd(endElement, callback, { dwellMs: 0 });
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  body.dispatchEvent(new dom.window.Event("touchstart", { bubbles: true }));
  chaptersRect = { top: -500, bottom: 850 };
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  dom.window.dispatchEvent(new dom.window.Event("scroll"));

  const openSignals = sent.filter(
    (message) =>
      message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" &&
      message.payload.state === "open",
  );
  assert.equal(openSignals.length, 1, "the fallback should settle only once");
  const openSignal = openSignals[0];
  assert.ok(openSignal, "the stable #chapters boundary should open qualification");
  assert.deepEqual(plainJson(openSignal.payload), {
    entryId,
    workKey: "ao3:76880511",
    source: "ao3",
    chapter: 2,
    total: 2,
    state: "open",
  });
  assert.ok(dom.window.document.querySelector("[data-trace-finish-qualify]"));
});

test("finish qualify promotes caught-up known-complete work with promise runtime messaging", async () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000902";
  const sent = [];
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="profile_top">
        <b class="xcontrast_txt">Complete Signal</b>
        <a href="/u/1/demo">Demo</a>
        <span class="xgray xcontrast_txt">Rated: T - English - Chapters: 1 - Status: Complete - Words: 100</span>
      </div>
      <div id="storytextp">Short synthetic chapter body.</div>
    </body></html>`,
    {
      url: "https://www.fanfiction.net/s/9001/1/Complete-Signal",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg) {
        sent.push(msg);
        if (
          msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" &&
          msg.payload.state === "resolved"
        ) {
          return Promise.resolve({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "resolved",
              eventId: null,
              entry: {
                entryId,
                status: "FINISHED",
                readerStatus: "FINISHED",
                canonicalReaderStatus: "FINISHED",
                chapters: { current: 1, total: 1 },
                workStatus: "complete",
                workStatusProvenance: "source",
              },
            },
          });
        }
        return Promise.resolve({ ok: true });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:9001": {
                  entryId,
                  status: "CAUGHT_UP",
                  readerStatus: "CAUGHT_UP",
                  canonicalReaderStatus: "CAUGHT_UP",
                  chapters: { current: 1, total: 1 },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorBrowser(dom, chrome);
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  dom.window.eval(finishSrc);
  const onReachEnd = dom.window.TraceFinishQualify.onReachEnd;
  dom.window.TraceFinishQualify.onReachEnd = (body, callback) =>
    onReachEnd(body, callback, { dwellMs: 0 });
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );
  dom.window.document.querySelector("#storytextp").dispatchEvent(
    new dom.window.Event("touchend", { bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(dom.window.document.querySelector("[data-trace-finish-qualify]"), null);
  assert.equal(sent.some((msg) => msg.type === "TRACE_PATCH_LIBRARY_ENTRY"), false);
  const finishSignal = sent.find((msg) => msg.type === "TRACE_FINISH_QUALIFICATION_SIGNAL");
  assert.ok(finishSignal);
  assert.deepEqual(plainJson(finishSignal.payload), {
    entryId,
    workKey: "ffn:9001",
    source: "ffn",
    chapter: 1,
    total: 1,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
  const done = dom.window.document.querySelector("[data-trace-finish-done]");
  assert.ok(done, "the automatic finish is confirmed inline after the text");
  assert.equal(dom.window.document.querySelector("#storytextp").nextElementSibling, done);
  assert.equal(dom.window.document.querySelector("[data-trace-finish-toast]"), null);
});

test("finish qualify open acknowledgement controls whether the manual prompt mounts", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000904";
  const cases = [
    { name: "ignored with authoritative terminal entry", response: "ignored", expectedMounts: 0 },
    { name: "transport unavailable", response: "unavailable", expectedMounts: 1 },
  ];

  for (const item of cases) {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <h2 class="title heading">Open signal ${item.name}</h2>
        <h3 class="byline heading"><a rel="author" href="/users/demo/pseuds/demo">demo</a></h3>
        <dl class="work meta group"><dd class="chapters">1/?</dd><dd class="words">100</dd></dl>
        <div id="chapters"><div class="chapter" id="chapter-1">
          <div class="userstuff module" role="article"><p>Story body.</p></div>
        </div></div>
      </body></html>`,
      {
        url: "https://archiveofourown.org/works/904/chapters/905",
        contentType: "text/html",
        runScripts: "outside-only",
      },
    );
    let mounts = 0;
    let removals = 0;
    let storedAuthToken = "test-token";
    let storedAccountId = "account-a";
    let storedAuthState = { state: "connected", accountId: "account-a" };
    let storedEntry = {
      entryId,
      status: "READING",
      readerStatus: "READING",
      canonicalReaderStatus: "READING",
      chapters: { current: 1, total: 1 },
    };
    const finishedEntry = {
      entryId,
      status: "FINISHED",
      readerStatus: "FINISHED",
      canonicalReaderStatus: "FINISHED",
      chapters: { current: 1, total: 1 },
    };
    const chrome = {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(message, callback) {
          if (
            message.type !== "TRACE_FINISH_QUALIFICATION_SIGNAL" ||
            message.payload.state !== "open" ||
            typeof callback !== "function"
          ) {
            return;
          }
          if (item.response === "unavailable") {
            this.lastError = { message: "worker suspended" };
            callback(undefined);
            this.lastError = null;
            return;
          }
          callback({
            ok: true,
            command: {
              kind: "acknowledged",
              state: "ignored",
              eventId: null,
              entry: finishedEntry,
            },
          });
        },
      },
      storage: {
        local: {
          get(_keys, callback) {
            callback({
              authToken: storedAuthToken,
              traceAccountId: storedAccountId,
              traceAuthState: storedAuthState,
              libraryOverlayCache: {
                accountId: storedAccountId,
                entries: {
                  "ao3:904": storedEntry,
                },
              },
            });
          },
          set(value, callback) {
            const projected = value?.libraryOverlayCache?.entries?.["ao3:904"];
            if (projected) storedEntry = projected;
            if (typeof callback === "function") callback();
          },
        },
        onChanged: { addListener() {} },
      },
    };
    dom.window.TraceFinishQualify = {
      onReachEnd(_body, callback) {
        callback();
        return function () {};
      },
      mount() {
        mounts += 1;
        return { remove() { removals += 1; } };
      },
    };

    installCollectorChrome(dom, chrome);
    dom.window.eval(collectorTestSource(collectorSrc));
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );

    assert.equal(mounts, item.expectedMounts, item.name);
    if (item.response === "unavailable") {
      storedEntry = finishedEntry;
      dom.window.renderQuickAddButton("ao3:904");
      assert.equal(removals, 1, "a terminal projection removes the obsolete prompt");
    }
    if (item.response === "ignored") {
      assert.match(
        dom.window.document.querySelector("[data-trace-story-handle]").textContent || "",
        /Finished/i,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(dom.window, "confirmedStoryPageEntries"),
        false,
        "finish responses do not create a second page-global library authority",
      );
    }
  }
});

test("finish qualify ignores a delayed open response after the projection becomes terminal", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000905";
  let storedEntry = {
    entryId,
    status: "READING",
    readerStatus: "READING",
    canonicalReaderStatus: "READING",
    chapters: { current: 1, total: 1 },
  };
  let openCallback = null;
  let mounts = 0;
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">Delayed Open</h2>
      <h3 class="byline heading"><a rel="author">Author</a></h3>
      <dl class="work meta group"><dd class="chapters">1/?</dd></dl>
      <div id="chapters"><div class="chapter" id="chapter-1">
        <div class="userstuff module" role="article">Story.</div>
      </div></div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/905/chapters/906",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(message, callback) {
        if (
          message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" &&
          message.payload.state === "open"
        ) {
          openCallback = callback;
        }
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            authToken: "test-token",
            libraryOverlayCache: { entries: { "ao3:905": storedEntry } },
          });
        },
        set(_value, callback) {
          if (callback) callback();
        },
      },
      onChanged: { addListener() {} },
    },
  };
  dom.window.TraceFinishQualify = {
    onReachEnd(_body, callback) {
      callback();
      return function () {};
    },
    mount() {
      mounts += 1;
      return { remove() {} };
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
  assert.equal(typeof openCallback, "function");

  storedEntry = {
    ...storedEntry,
    status: "COMPLETED",
    readerStatus: "COMPLETED",
    canonicalReaderStatus: "FINISHED",
  };
  dom.window.renderQuickAddButton("ao3:905");
  openCallback({
    ok: true,
    command: {
      kind: "acknowledged",
      state: "open",
      eventId: "00000000-0000-4000-8000-000000000001",
      workKey: "ao3:905",
      entry: storedEntry,
    },
  });

  assert.equal(mounts, 0);
});

test("known-source finish failures show a durable retry affordance and recover", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000907";
  let storedEntry = {
    entryId,
    status: "READING",
    readerStatus: "READING",
    canonicalReaderStatus: "READING",
    chapters: { current: 1, total: 1 },
  };
  let attempts = 0;
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">Retry Finish</h2>
      <h3 class="byline heading"><a rel="author">Author</a></h3>
      <ul class="required-tags"><li><span title="Complete Work">Complete Work</span></li></ul>
      <dl class="work meta group"><dd class="chapters">1/1</dd></dl>
      <div id="chapters"><div class="chapter" id="chapter-1">
        <div class="userstuff module" role="article">Story.</div>
      </div></div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/907/chapters/908",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(message, callback) {
        if (message.type !== "TRACE_FINISH_QUALIFICATION_SIGNAL" || !callback) return;
        attempts += 1;
        if (attempts === 1) {
          callback({ ok: false, error: "network_error" });
          return;
        }
        callback({
          ok: true,
          command: {
            kind: "acknowledged",
            state: "resolved",
            eventId: null,
            workKey: "ao3:907",
            entry: {
              entryId,
              status: "COMPLETED",
              readerStatus: "COMPLETED",
              canonicalReaderStatus: "FINISHED",
              chapters: { current: 1, total: 1 },
            },
          },
        });
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            authToken: "test-token",
            libraryOverlayCache: { entries: { "ao3:907": storedEntry } },
          });
        },
        set(value, callback) {
          const projected = value?.libraryOverlayCache?.entries?.["ao3:907"];
          if (projected) storedEntry = projected;
          if (callback) callback();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  dom.window.eval(finishSrc);
  dom.window.TraceFinishQualify.onReachEnd = (_body, callback) => {
    callback();
    return function () {};
  };
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

  const recovery = dom.window.document.querySelector("[data-trace-finish-recovery]");
  assert.ok(recovery);
  assert.match(recovery.textContent || "", /couldn.t .*update/i);
  assert.ok(recovery.querySelector("[data-trace-finish-open]"));
  recovery.querySelector("[data-trace-finish-retry]").click();

  assert.equal(attempts, 2);
  assert.ok(dom.window.document.querySelector("[data-trace-finish-done]"));
  assert.ok(dom.window.document.querySelector("[data-trace-finish-undo]"));
});

test("terminal finish replay after deletion settles without recovery or stale projection", () => {
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const entryId = "00000000-0000-4000-8000-000000000908";
  let deleted = false;
  let attempts = 0;
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <h2 class="title heading">Deleted Finish</h2>
      <h3 class="byline heading"><a rel="author">Author</a></h3>
      <ul class="required-tags"><li><span title="Complete Work">Complete Work</span></li></ul>
      <dl class="work meta group"><dd class="chapters">1/1</dd></dl>
      <div id="chapters"><div class="chapter" id="chapter-1">
        <div class="userstuff module" role="article">Story.</div>
      </div></div>
    </body></html>`,
    {
      url: "https://archiveofourown.org/works/908/chapters/909",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(message, callback) {
        if (message.type !== "TRACE_FINISH_QUALIFICATION_SIGNAL" || !callback) return;
        attempts += 1;
        deleted = true;
        callback({
          ok: true,
          command: {
            kind: "acknowledged",
            state: "resolved",
            eventId: "00000000-0000-4000-8000-000000000999",
            workKey: null,
            entry: null,
          },
        });
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: deleted
                ? {}
                : {
                    "ao3:908": {
                      entryId,
                      status: "READING",
                      readerStatus: "READING",
                      canonicalReaderStatus: "READING",
                      chapters: { current: 1, total: 1 },
                    },
                  },
            },
          });
        },
        set(_value, callback) {
          if (callback) callback();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  dom.window.eval(finishSrc);
  dom.window.TraceFinishQualify.onReachEnd = (_body, callback) => {
    callback();
    return function () {};
  };
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

  assert.equal(attempts, 1);
  assert.equal(dom.window.document.querySelector("[data-trace-finish-recovery]"), null);
  assert.equal(dom.window.document.querySelector("[data-trace-finish-toast]"), null);
});

test("finish end detection requires visible story-targeted interaction and dwell for a short story", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'>Short story.</div></body></html>",
    { url: "https://archiveofourown.org/works/1", runScripts: "outside-only" },
  );
  const body = dom.window.document.querySelector("#story");
  body.getBoundingClientRect = () => ({ top: 100, bottom: 400 });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 0, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  let fired = 0;
  let now = 1_000;
  let timer = null;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, {
    dwellMs: 2_000,
    now: () => now,
    setTimer(fn) {
      timer = fn;
      return 1;
    },
    clearTimer() {
      timer = null;
    },
  });

  assert.equal(fired, 0);
  dom.window.dispatchEvent(new dom.window.Event("touchend", { bubbles: true }));
  dom.window.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "End", bubbles: true }));
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(fired, 0, "window-level and programmatic events are not reading evidence");
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  assert.equal(fired, 0);

  body.dispatchEvent(new dom.window.Event("touchend", { bubbles: true }));
  assert.equal(fired, 0, "interaction alone does not bypass the dwell requirement");
  assert.equal(typeof timer, "function");
  now = 2_999;
  timer();
  assert.equal(fired, 0);
  body.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
  assert.equal(fired, 0, "ordinary typing is not reading navigation evidence");
  now = 3_000;
  body.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "PageDown", bubbles: true }));
  assert.equal(fired, 1);
  cleanup();
});

test("finish end detection treats fully visible short stories as short at nonzero page scroll", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'><p id='text'>Short restored story.</p></div></body></html>",
    { url: "https://archiveofourown.org/works/5", runScripts: "outside-only" },
  );
  const body = dom.window.document.querySelector("#story");
  const text = dom.window.document.querySelector("#text");
  body.getBoundingClientRect = () => ({ top: 120, bottom: 420 });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 640, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  let fired = 0;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, { dwellMs: 0 });

  assert.equal(fired, 0, "page scroll offset alone does not bypass short-story evidence");
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(fired, 0);
  text.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(fired, 1);
  cleanup();
});

test("finish end detection waits for visibility and excludes interactive story controls", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'><button id='control'>Bookmark</button><p id='text'>Story.</p></div></body></html>",
    { url: "https://archiveofourown.org/works/2", runScripts: "outside-only" },
  );
  const body = dom.window.document.querySelector("#story");
  const control = dom.window.document.querySelector("#control");
  const text = dom.window.document.querySelector("#text");
  body.getBoundingClientRect = () => ({ top: 100, bottom: 400 });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 0, configurable: true });
  let visibility = "hidden";
  Object.defineProperty(dom.window.document, "visibilityState", {
    get: () => visibility,
    configurable: true,
  });
  let fired = 0;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, { dwellMs: 0 });

  control.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(fired, 0, "a button inside the story is not reading evidence");
  text.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(fired, 0, "hidden documents cannot finish");
  visibility = "visible";
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(fired, 0, "hidden interactions are not retained as reading evidence");
  text.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(fired, 1);
  cleanup();
});

test("finish end detection pauses short-story dwell while the document is hidden", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'><p id='text'>Story.</p></div></body></html>",
    { url: "https://archiveofourown.org/works/4", runScripts: "outside-only" },
  );
  const body = dom.window.document.querySelector("#story");
  const text = dom.window.document.querySelector("#text");
  body.getBoundingClientRect = () => ({ top: 100, bottom: 400 });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 0, configurable: true });
  let visibility = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", {
    get: () => visibility,
    configurable: true,
  });
  let now = 0;
  let fired = 0;
  let timer = null;
  let scheduledDelay = null;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, {
    dwellMs: 2_000,
    now: () => now,
    setTimer(fn, delay) {
      timer = fn;
      scheduledDelay = delay;
      return 1;
    },
    clearTimer() {
      timer = null;
      scheduledDelay = null;
    },
  });

  now = 500;
  text.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(scheduledDelay, 1_500);
  now = 1_000;
  visibility = "hidden";
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(timer, null, "hiding pauses the dwell timer");

  now = 5_000;
  visibility = "visible";
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(fired, 0, "hidden wall-clock time does not satisfy dwell");
  assert.equal(scheduledDelay, 1_000, "only the remaining visible dwell is scheduled");

  now = 6_000;
  timer();
  assert.equal(fired, 1);
  cleanup();
});

test("finish end detection qualifies a long story once its last lines stay in view for the dwell", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'>Long story.</div></body></html>",
    { url: "https://archiveofourown.org/works/3", runScripts: "outside-only" },
  );
  const body = dom.window.document.querySelector("#story");
  let bottom = 1_400;
  body.getBoundingClientRect = () => ({ top: 100, bottom });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 0, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  let fired = 0;
  let now = 0;
  let timer = null;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, {
    now: () => now,
    setTimer(fn) {
      timer = fn;
      return 1;
    },
    clearTimer() {
      timer = null;
    },
  });
  assert.equal(fired, 0);
  body.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true }));
  bottom = 850;
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(fired, 0, "arriving at the end starts the dwell");
  assert.equal(typeof timer, "function");
  now = 2_000;
  timer();
  assert.equal(fired, 1);
  cleanup();
});

test("finish end detection does not mistake delayed browser scroll restoration for reading", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'>Restored story.</div></body></html>",
    { url: "https://archiveofourown.org/works/31", runScripts: "outside-only" },
  );
  const body = dom.window.document.querySelector("#story");
  let bottom = 1_400;
  body.getBoundingClientRect = () => ({ top: 100, bottom });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  let fired = 0;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, { dwellMs: 0 });

  bottom = 850;
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(fired, 0, "an unattributed restoration scroll is not reading evidence");

  body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(fired, 1, "explicit story interaction can qualify the restored end state");
  cleanup();
});

test("finish end detection does not treat a deep link below the story as reaching its end", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'>Story.</div><div id='comments'>Comments.</div></body></html>",
    {
      url: "https://archiveofourown.org/works/6#comments",
      runScripts: "outside-only",
    },
  );
  const body = dom.window.document.querySelector("#story");
  body.getBoundingClientRect = () => ({ top: -700, bottom: -120 });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  let fired = 0;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, { dwellMs: 0 });

  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  dom.window.document.body.dispatchEvent(
    new dom.window.KeyboardEvent("keyup", { key: "End", bubbles: true }),
  );
  body.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(fired, 0);
  cleanup();
});

test("finish end detection accepts guarded document-level keyboard evidence for a restored short story", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='story'>Short story.</div></body></html>",
    { url: "https://archiveofourown.org/works/7", runScripts: "outside-only" },
  );
  const body = dom.window.document.querySelector("#story");
  body.getBoundingClientRect = () => ({ top: 100, bottom: 500 });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  let fired = 0;

  dom.window.eval(finishSrc);
  const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
    fired += 1;
  }, { dwellMs: 0 });

  dom.window.document.body.dispatchEvent(
    new dom.window.KeyboardEvent("keyup", { key: "PageDown", bubbles: true }),
  );
  assert.equal(fired, 1);
  cleanup();
});

test("finish end detection never treats a large scroll step past the end as reading it", () => {
  const finishSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"),
    "utf8",
  );
  const makeDom = () => new JSDOM(
    "<!doctype html><html><body><div id='story'>Long story.</div></body></html>",
    { url: "https://archiveofourown.org/works/8", runScripts: "outside-only" },
  );

  for (const withEvidence of [false, true]) {
    const dom = makeDom();
    const body = dom.window.document.querySelector("#story");
    let rect = { top: 100, bottom: 1_400 };
    body.getBoundingClientRect = () => rect;
    Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    let fired = 0;
    dom.window.eval(finishSrc);
    const cleanup = dom.window.TraceFinishQualify.onReachEnd(body, () => {
      fired += 1;
    }, { dwellMs: 0 });

    if (withEvidence) {
      dom.window.document.body.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
      );
    }
    rect = { top: -900, bottom: -100 };
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(fired, 0, "scrolling past the last lines does not count, with or without evidence");
    cleanup();
  }
});

test("story sheet position block shows unknown total without chapter stepper controls", () => {
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter"
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() {},
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:7038840": {
                  entryId: "00000000-0000-4000-8000-000000703884",
                  status: "READING",
                  readerStatus: "READING",
                  chapters: { current: 3, total: null },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  handle.click();
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const position = sheet.querySelector("[data-trace-story-position]");
  assert.ok(position);
  assert.match(position.className || "", /\bx-pos\b/);
  assert.match(position.textContent || "", /Chapter 3\s*of\s*\?/);
  assert.equal(position.querySelector(".bar"), null);
  assert.equal(position.querySelector(".step"), null);
  assert.doesNotMatch(sheet.textContent || "", /Set to current/i);
});

test("FFN mobile story post-add status mutation failure keeps saved state", () => {
  const entryId = "00000000-0000-4000-8000-000000000322";
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const sent = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (msg.type === "TRACE_QUICK_ADD" && typeof cb === "function") {
          cb({ ok: true, entryId });
        } else if (msg.type === "TRACE_SET_READER_STATUS" && typeof cb === "function") {
          cb({ ok: false, error: "http_500" });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefAutoTrackEnabled: false,
            libraryOverlayCache: { entries: {} },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  dom.window.setTimeout = (fn) => {
    fn();
    return 1;
  };
  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  handle.click();
  handle.click();
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const reading = sheet.querySelector("[data-trace-status-choice='READING']");
  assert.ok(reading);
  reading.click();

  assert.equal(sent.at(-1).type, "TRACE_SET_READER_STATUS");
  assert.equal(sheet.getAttribute("data-trace-open"), "1");
  assert.equal(sheet.getAttribute("aria-hidden"), "false");
  assert.match(sheet.textContent || "", /Saved/i);
  assert.match(sheet.textContent || "", /Could not update. Try again./i);
});

test("FFN mobile story sheet shows known status, progress, private context, and hidden state", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter"
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const sent = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (typeof cb === "function") cb({ ok: true });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:7038840": {
                  entryId: "00000000-0000-4000-8000-000000703884",
                  status: "READING",
                  readerStatus: "READING",
                  chapters: { current: 3, total: 28 },
                  rating: 3,
                  catchupState: "BEHIND",
                  newChapterCount: 2,
                  browsePreference: { hidden: true },
                  privateContext: {
                    hasNotes: true,
                    tagCount: 4,
                    notePreview: "  My actual private note\nfor this story.  ",
                    tags: ["comfort", "reread", "favorite", "long"],
                  },
                  workMark: { kind: "abandoned" },
                },
              },
            },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  assert.match(handle.textContent || "", /Hidden/i);
  handle.click();

  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  assert.ok(sheet.querySelector(".x-sheet-head"));
  assert.ok(sheet.querySelector(".x-sheet-body"));
  assert.ok(sheet.querySelector(".x-seg"));
  assert.ok(sheet.querySelector(".x-pos"));
  assert.ok(sheet.querySelector(".x-meta"));
  assert.ok(sheet.querySelector(".x-sheet-foot"));
  assert.match(sheet.textContent || "", /Hidden/i);
  assert.match(sheet.textContent || "", /Chapter 3\s*of\s*28/);
  assert.match(sheet.textContent || "", /11%/);
  assert.match(sheet.textContent || "", /Catch up to 5/i);
  assert.equal(sheet.querySelector(".x-pos .bar"), null);
  assert.equal(sheet.querySelector(".x-pos .step"), null);
  assert.match(sheet.textContent || "", /Reading/i);
  assert.match(sheet.textContent || "", /My actual private note for this story\./i);
  assert.doesNotMatch(sheet.textContent || "", /Private note saved\s*·\s*edit in Trace/i);
  assert.ok(sheet.querySelector(".x-meta .note"));
  assert.match(sheet.textContent || "", /comfort/i);
  assert.match(sheet.textContent || "", /reread/i);
  assert.match(sheet.textContent || "", /favorite/i);
  assert.match(sheet.textContent || "", /\+1/i);
  assert.doesNotMatch(sheet.textContent || "", /long/i);
  assert.doesNotMatch(sheet.textContent || "", /4 private tags/i);
  const privateTagRow = sheet.querySelector(".x-meta");
  assert.ok(privateTagRow);
  assert.equal(privateTagRow.querySelectorAll(".x-utag").length, 3);
  assert.equal(privateTagRow.querySelector(".x-utag-more")?.textContent, "+1");
  // Private tags are ink text with a brass # inside the Your record well.
  assert.equal(privateTagRow.getAttribute("data-trace-record-well"), "1");
  assert.match(privateTagRow.textContent || "", /Your record/);
  assert.doesNotMatch(sheet.textContent || "", /Private context/);
  for (const tag of privateTagRow.querySelectorAll(".x-utag")) {
    assert.doesNotMatch(tag.getAttribute("style") || "", /border-bottom:\s*1px dotted/i);
    assert.match(tag.getAttribute("style") || "", /background:\s*transparent/i);
    assert.match(tag.getAttribute("style") || "", /color:\s*var\(--trace-page-ink\)/i);
    assert.doesNotMatch(tag.getAttribute("style") || "", /text-overflow:\s*ellipsis/i);
    assert.equal(tag.firstChild.textContent, "#");
    assert.match(tag.firstChild.getAttribute("style") || "", /var\(--trace-page-authored\)/);
  }
  assert.match(sheet.textContent || "", /Marked abandoned/i);
  assert.ok(sheet.querySelector("[data-trace-work-mark='abandoned']"));
  assert.match(sheet.textContent || "", /Hidden from future listings/i);
  const undoBtn = sheet.querySelector("button[data-trace-hidden-action='undo']");
  assert.ok(undoBtn);
  assert.equal(undoBtn.textContent || "", "Unhide");
  assert.doesNotMatch(undoBtn.className || "", /\bicon-only\b/);
  const ratingControl = sheet.querySelector("[data-trace-rating-control]");
  assert.ok(ratingControl);
  assert.deepEqual(
    Array.from(ratingControl.querySelectorAll("[data-trace-rating-choice] svg"))
      .map((star) => star.getAttribute("fill")),
    ["currentColor", "currentColor", "currentColor", "none", "none"],
  );
  assert.ok(ratingControl.closest("[data-trace-record-well]"));
  ratingControl.querySelector("[data-trace-rating-choice='5']").click();
  assert.deepEqual(plainJson(sent.at(-1)), {
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: {
      workKey: "ffn:7038840",
      entryId: "00000000-0000-4000-8000-000000703884",
      patch: { rating: 5 },
    },
  });
  const catchup = sheet.querySelector("[data-trace-catchup-action]");
  assert.ok(catchup);
  catchup.querySelector("button").click();
  assert.deepEqual(plainJson(sent.at(-1)), {
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: {
      workKey: "ffn:7038840",
      entryId: "00000000-0000-4000-8000-000000703884",
      patch: {
        status: "CAUGHT_UP",
        progress: { unit: "CHAPTER", value: 5, total: 28 },
      },
    },
  });
  assert.equal(sheet.getAttribute("data-trace-open"), "1");
  assert.equal(sheet.getAttribute("aria-hidden"), "false");
  const openInTrace = sheet.querySelector("[data-trace-open-trace]");
  assert.equal(
    openInTrace.getAttribute("href"),
    "https://tracefiction.com/?panel=details&entryId=00000000-0000-4000-8000-000000703884",
  );
  let preventedBeforeBrowserFallback = null;
  openInTrace.addEventListener("click", (event) => {
    preventedBeforeBrowserFallback = event.defaultPrevented;
    event.preventDefault();
  });
  openInTrace.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  assert.equal(
    preventedBeforeBrowserFallback,
    false,
    "the anchor must retain normal browser navigation if runtime messaging stalls",
  );
  assert.equal(
    sent.some((message) => message.type === "TRACE_OPEN_TRACE_URL"),
    false,
  );
});

test("the story sheet's Open in Trace opens the story in the Trace app on iPhone and iPad", () => {
  const entryId = "00000000-0000-4000-8000-000000703884";
  for (const [userAgent, maxTouchPoints, href, target] of [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      5,
      `traceauth://open?destination=story&entryId=${entryId}`,
      null,
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      5,
      `traceauth://open?destination=story&entryId=${entryId}`,
      null,
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      0,
      `https://tracefiction.com/?panel=details&entryId=${entryId}`,
      "_blank",
    ],
  ]) {
    const dom = domFromFixture(
      "ffn_story_mobile.html",
      "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter"
    );
    Object.defineProperty(dom.window.navigator, "userAgent", { value: userAgent, configurable: true });
    Object.defineProperty(dom.window.navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
    const collectorSrc = fs.readFileSync(
      path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
      "utf8",
    );
    const sent = [];
    installCollectorChrome(dom, {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(msg, cb) {
          sent.push(msg);
          if (typeof cb === "function") cb({ ok: true });
        },
        lastError: null,
      },
      storage: {
        local: {
          get(_keys, cb) {
            cb({
              authToken: "test-token",
              libraryOverlayCache: {
                entries: {
                  "ffn:7038840": {
                    entryId: entryId.toUpperCase(),
                    status: "READING",
                    readerStatus: "READING",
                    chapters: { current: 3, total: 28 },
                  },
                },
              },
            });
          },
          set(_value, cb) {
            if (typeof cb === "function") cb();
          },
        },
        onChanged: { addListener() {} },
      },
    });
    dom.window.eval(collectorTestSource(collectorSrc));
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );
    dom.window.document.querySelector("[data-trace-story-handle]").click();
    const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
    const openInTrace = sheet.querySelector(".x-sheet-foot [data-trace-open-trace]");
    assert.equal(openInTrace.getAttribute("href"), href, userAgent);
    assert.equal(openInTrace.getAttribute("target"), target, userAgent);
    assert.equal(sent.some((message) => message.type === "TRACE_OPEN_TRACE_URL"), false);
  }
});

test("a redraw while reading never shows the closed story sheet", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter"
  );
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  installCollectorChrome(dom, {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) { if (typeof cb === "function") cb({ ok: true }); },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: {
              entries: {
                "ffn:7038840": {
                  entryId: "00000000-0000-4000-8000-000000703884",
                  status: "READING",
                  readerStatus: "READING",
                  chapters: { current: 3, total: 28 },
                },
              },
            },
          });
        },
        set(_value, cb) { if (typeof cb === "function") cb(); },
      },
      onChanged: { addListener() {} },
    },
  });
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.equal(sheet.getAttribute("data-trace-open"), "0");
  assert.equal(sheet.style.display, "none");
  // The look-up Trace didn't answer: its redraw re-places the sheet and
  // returns early, because the handle already shows the story's state.
  dom.window.renderKernelProjectionUnavailable("ffn:7038840", handle.parentElement);
  dom.window.placeStorySheet(sheet, handle.parentElement, handle);
  assert.equal(sheet.style.display, "none", "a closed sheet stays closed");
  handle.click();
  assert.equal(sheet.getAttribute("data-trace-open"), "1");
  dom.window.placeStorySheet(sheet, handle.parentElement, handle);
  assert.equal(sheet.style.display, "block", "an open sheet stays open");
});

// A reader mid-chapter leaves Safari and comes back. Everything a return runs
// (pageshow from the back-forward cache, visibility, focus, storage changes,
// look-ups answered late, timed out or refused, the scripts injected again
// when the background wakes, an automatic save) redraws the story control,
// and none of it may show the story sheet. Only the reader's tap opens it.
const RETURN_WORK_KEY = "ao3:28534965";
const RETURN_ENTRY = {
  entryId: "00000000-0000-4000-8000-000000285349",
  status: "READING",
  readerStatus: "READING",
  canonicalReaderStatus: "READING",
  chapters: { current: 3, total: 28 },
};

function connectedProjection(entries) {
  return {
    ok: true,
    snapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
    projection: { entries: entries || {}, workPreferences: {}, syncVersion: null },
  };
}

function createStoryReturnHarness(options = {}) {
  const held = [];
  let projection = "answer";
  const h = createStoryAutoTrackPendingHarness(Object.assign({
    sessionMode: "kernel",
    fixture: "ao3_story.html",
    url: "https://archiveofourown.org/works/28534965/chapters/69925506",
    store: { prefAutoTrackEnabled: false },
    mutateDom(dom) {
      // A phone-width page: the sheet is the modal bottom sheet.
      dom.window.matchMedia = (query) => ({
        matches: /max-width:\s*640px/.test(query),
        media: query,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      });
      // Waits keep their order but pass in milliseconds.
      const quick = dom.window.setTimeout.bind(dom.window);
      dom.window.setTimeout = (callback, ms, ...args) =>
        quick(callback, Math.min(Number(ms) || 0, 4), ...args);
    },
    onSendMessage(message, cb) {
      if (message.type !== "TRACE_ACCOUNT_PROJECTION_GET") return false;
      if (projection === "hold") {
        held.push(cb);
        return true;
      }
      if (projection === "refuse") {
        cb({ ok: false, error: "runtime_unavailable" });
        return true;
      }
      cb(connectedProjection(options.entries || { [RETURN_WORK_KEY]: RETURN_ENTRY }));
      return true;
    },
  }, options.harness || {}));

  const { window } = h.dom;
  const document = window.document;
  // Every state the page can paint: a mutation observer runs once the task
  // that changed the sheet has finished, so a closed sheet momentarily
  // restyled inside one redraw is not a state the reader could see.
  const shown = [];
  const observer = new window.MutationObserver(() => {
    const sheet = document.querySelector("[data-trace-story-sheet]");
    if (!sheet || !sheet.isConnected) return;
    if (sheet.getAttribute("data-trace-open") === "1" || sheet.style.display !== "none") {
      shown.push({
        step: h.step,
        open: sheet.getAttribute("data-trace-open"),
        display: sheet.style.display,
      });
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "data-trace-open"],
  });

  function setVisible(visible) {
    Object.defineProperty(document, "visibilityState", {
      value: visible ? "visible" : "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "hidden", { value: !visible, configurable: true });
  }

  return Object.assign(h, {
    step: "load",
    shown,
    held,
    setProjection(next) {
      projection = next;
    },
    answerHeld(response) {
      while (held.length) held.shift()(response);
    },
    leave() {
      h.step = "leave";
      const pagehide = new window.Event("pagehide");
      pagehide.persisted = true;
      window.dispatchEvent(pagehide);
      setVisible(false);
      document.dispatchEvent(new window.Event("visibilitychange"));
      window.dispatchEvent(new window.Event("blur"));
    },
    arrive() {
      h.step = "arrive";
      const pageshow = new window.Event("pageshow");
      pageshow.persisted = true;
      window.dispatchEvent(pageshow);
      setVisible(true);
      document.dispatchEvent(new window.Event("visibilitychange"));
      window.dispatchEvent(new window.Event("focus"));
    },
    sheet() {
      return document.querySelector("[data-trace-story-sheet]");
    },
    handle() {
      return document.querySelector("[data-trace-story-handle]");
    },
    assertClosed(message) {
      const sheet = document.querySelector("[data-trace-story-sheet]");
      assert.ok(sheet, "the story sheet exists");
      assert.notEqual(sheet.getAttribute("data-trace-open"), "1", message);
      assert.equal(sheet.style.display, "none", message);
      assert.deepEqual(shown, [], message);
    },
  });
}

function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHandleState(h, state) {
  for (let i = 0; i < 100 && h.handle().getAttribute("data-trace-story-handle-state") !== state; i += 1) {
    await settle(5);
  }
  assert.equal(h.handle().getAttribute("data-trace-story-handle-state"), state);
}

test("returning to a story mid-chapter never shows the closed story sheet", async () => {
  const h = createStoryReturnHarness();
  await waitForHandleState(h, "status");
  assert.match(h.handle().textContent || "", /3\/28/);
  h.assertClosed("loaded mid-chapter");

  // Safari keeps the page while the reader is away. A look-up sent as they
  // left never gets its answer; it times out once the page runs again.
  h.setProjection("hold");
  h.leave();
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 1);
  await settle();
  h.assertClosed("after leaving");

  // Back in Safari, the background is still asleep: look-ups go unanswered
  // and time out, so the control says Trace didn't answer.
  h.arrive();
  await settle(60);
  h.assertClosed("look-ups unanswered on arrival");

  // A look-up refused outright, retried, then answered seconds later.
  h.setProjection("refuse");
  h.arrive();
  await settle(60);
  h.assertClosed("look-ups refused and retried");

  h.setProjection("answer");
  h.answerHeld(connectedProjection({ [RETURN_WORK_KEY]: RETURN_ENTRY }));
  h.arrive();
  await waitForHandleState(h, "status");
  await settle(60);
  h.assertClosed("answered after the retries");

  // The Library and the session change while the reader is back.
  h.step = "storage";
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 2);
  h.dispatchStorageChange("libraryOverlayCache", { entries: {} });
  h.dispatchStorageChange("traceAuthState", { state: "connected" });
  h.dispatchStorageChange("traceWorkStatesV1", {});
  await settle(60);
  h.assertClosed("storage changes");

  // The background wakes and injects the story scripts into the open tab
  // again; the page keeps its one collector.
  h.step = "reinject";
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  h.dom.window.eval(collectorTestSource(collectorSrc));
  await settle(60);
  h.assertClosed("scripts injected again");

  // The reader's tap still opens it.
  h.step = "tap";
  h.handle().click();
  await settle();
  assert.equal(h.sheet().getAttribute("data-trace-open"), "1");
  assert.equal(h.sheet().style.display, "block");
  assert.ok(h.shown.length > 0, "the observer sees an open sheet");
});

test("a look-up answered after the reader returns, while others time out, keeps the sheet closed", async () => {
  // Arrival sends several look-ups. An answer redraws the control between
  // look-ups that time out, and later retries are refused until none are
  // left. The sheet stays shut through each redraw.
  const h = createStoryReturnHarness();
  await waitForHandleState(h, "status");
  h.leave();
  h.setProjection("hold");
  h.arrive();
  await settle(2);
  h.answerHeld(connectedProjection({ [RETURN_WORK_KEY]: RETURN_ENTRY }));
  await settle(60);
  h.assertClosed("an answer between timeouts");
  h.dom.window.renderQuickAddButton(RETURN_WORK_KEY);
  await settle(60);
  h.setProjection("refuse");
  h.dom.window.renderQuickAddButton(RETURN_WORK_KEY);
  await settle(80);
  h.assertClosed("retries run out");
  assert.equal(h.handle().getAttribute("data-trace-story-handle-state"), "status");
});

test("an automatic save at the Free limit never opens the story sheet", async () => {
  // Automatic saves report a full Library on the control and in the notice;
  // only the reader's own add opens the sheet to explain it. An account
  // that is Unlimited gets no prompt from the background, and still the
  // sheet stays shut.
  for (const capacity of [
    { blocked: true, prompt: true },
    { blocked: false, prompt: false },
    undefined,
  ]) {
    const h = createStoryReturnHarness({
      entries: {},
      harness: {
        store: { prefAutoTrackEnabled: true },
        autoTrackResponse: { ok: false, error: "free_limit_reached", capacity },
      },
    });
    await waitForHandleState(h, "full");
    assert.ok(h.sent.some((message) => message.type === "TRACE_AUTO_TRACK"));
    h.assertClosed(`automatic save at the limit (${JSON.stringify(capacity)})`);
    h.leave();

    h.arrive();
    await settle(60);
    h.assertClosed("return after an automatic save at the limit");

    h.step = "tap";
    h.handle().click();
    await settle();
    assert.equal(h.sheet().getAttribute("data-trace-open"), "1", "a tap opens it");
  }
});

test("the reader's own add at the Free limit opens the sheet to explain it", async () => {
  const h = createStoryReturnHarness({
    entries: {},
    harness: {
      quickAddResponse: { ok: false, error: "free_limit_reached", capacity: { blocked: true, prompt: true } },
    },
  });
  await waitForHandleState(h, "add");
  h.assertClosed("before the add");
  h.step = "tap";
  h.handle().click();
  await settle(40);
  assert.equal(h.sheet().getAttribute("data-trace-open"), "1");
  assert.match(h.sheet().textContent || "", /wasn’t added/i);
});

test("FFN mobile story sheet hidden preference auth failures become connect actions", () => {
  const cases = [
    { error: "auth_expired", label: /Sign in/i },
    { error: "not_authenticated", label: /Connect/i },
  ];
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  for (const item of cases) {
    const dom = domFromFixture(
      "ffn_story_mobile.html",
      "https://m.fanfiction.net/s/7038840/3/A-Chance-Encounter",
    );
    const sent = [];
    const chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(msg, cb) {
          sent.push(msg);
          if (msg.type === "TRACE_SET_HIDDEN_WORK" && typeof cb === "function") {
            cb({ ok: false, error: item.error });
          }
        },
        lastError: null,
      },
      storage: {
        local: {
          get(_keys, cb) {
            cb({
              authToken: "test-token",
              libraryOverlayCache: {
                entries: {
                  "ffn:7038840": {
                    entryId: "00000000-0000-4000-8000-000000703884",
                    status: "READING",
                    readerStatus: "READING",
                    chapters: { current: 3, total: 28 },
                  },
                },
              },
            });
          },
          set(_value, cb) {
            if (typeof cb === "function") cb();
          },
        },
        onChanged: { addListener() {} },
      },
    };

    dom.window.setTimeout = () => 1;
    installCollectorChrome(dom, chrome);
    dom.window.eval(collectorTestSource(collectorSrc));
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );

    const handle = dom.window.document.querySelector("[data-trace-story-handle]");
    handle.click();
    const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
    const hiddenBtn = sheet.querySelector("button[data-trace-hidden-action='hide']");
    assert.ok(hiddenBtn);

    hiddenBtn.click();

    assert.equal(sent.at(-1).type, "TRACE_SET_HIDDEN_WORK");
    assert.deepEqual(plainJson(sent.at(-1).payload), {
      key: "ffn:7038840",
      hidden: true,
    });
    assert.match(hiddenBtn.textContent || "", item.label);
    assert.doesNotMatch(hiddenBtn.textContent || "", /Error/i);
    assert.equal(hiddenBtn.getAttribute("data-trace-connect-action"), "1");
    assert.equal(hiddenBtn.getAttribute("data-trace-connect-error"), item.error);
    assert.equal(hiddenBtn.disabled, false);
  }
});

test("FFN mobile story sheet hides mutation controls with stale token when auth is not connected", () => {
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  for (const authStateName of ["signed_out", "reconnect_required"]) {
    const dom = domFromFixture(
      "ffn_story_mobile.html",
      "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
    );
    const chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() {},
        lastError: null,
      },
      storage: {
        local: {
          get(_keys, cb) {
            cb({
              authToken: "stale-token",
              traceAuthState: {
                state: authStateName,
                helpUrl: "https://tracefiction.com/apps",
              },
              libraryOverlayCache: {
                entries: {
                  "ffn:7038840": {
                    entryId: "00000000-0000-4000-8000-000000703884",
                    status: "READING",
                    readerStatus: "READING",
                    chapters: { current: 3, total: 28 },
                  },
                },
              },
            });
          },
          set(_value, cb) {
            if (typeof cb === "function") cb();
          },
        },
        onChanged: { addListener() {} },
      },
    };

    installCollectorChrome(dom, chrome);
    dom.window.eval(collectorTestSource(collectorSrc));
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );

    const handle = dom.window.document.querySelector("[data-trace-story-handle]");
    assert.ok(handle);
    handle.click();
    const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
    assert.match(sheet.textContent || "", /(?:Connect|Reconnect) Trace/i);
    assert.equal(sheet.querySelector("[data-trace-quick-add]"), null);
    assert.equal(sheet.querySelector("[data-trace-status-choices]"), null);
    assert.match(sheet.querySelector("[data-trace-open-trace]").textContent || "", /OPEN TRACE/i);
  }
});

test("FFN mobile story sheet quick-add preserves free-limit and error states", () => {
  const responses = [
    { response: { ok: false, error: "free_limit_reached" }, text: /Full/i },
    { response: { ok: false, error: "http_500" }, text: /Couldn’t add/ },
    { response: { ok: false, error: "auth_expired" }, text: /Reconnect/i },
  ];

  for (const item of responses) {
    const dom = domFromFixture(
      "ffn_story_mobile.html",
      "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
    );
    const collectorSrc = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "Shared (Extension)",
        "Resources",
        "collector.js",
      ),
      "utf8",
    );

    const chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(_msg, cb) {
          if (typeof cb === "function") cb(item.response);
        },
        lastError: null,
      },
      storage: {
        local: {
          get(_keys, cb) {
            cb({
              authToken: "test-token",
              libraryOverlayCache: { entries: {} },
            });
          },
          set(_value, cb) {
            if (typeof cb === "function") cb();
          },
        },
        onChanged: { addListener() {} },
      },
    };

    dom.window.setTimeout = () => 1;
    installCollectorChrome(dom, chrome);
    dom.window.eval(collectorTestSource(collectorSrc));
    dom.window.document.dispatchEvent(
      new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );

    const handle = dom.window.document.querySelector("[data-trace-story-handle]");
    handle.click();
    assert.match(handle.textContent || "", item.text);
  }
});

test("collector story Trace sheet is not rendered on password pages", () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><input type='password'><div id='content'><b>Private</b></div></body></html>",
    {
      url: "https://m.fanfiction.net/login.php",
      contentType: "text/html",
      runScripts: "outside-only",
    },
  );
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() {},
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            libraryOverlayCache: { entries: {} },
          });
        },
        set(_value, cb) {
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(collectorTestSource(collectorSrc));
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  assert.equal(dom.window.document.querySelector("[data-trace-story-handle]"), null);
  assert.equal(dom.window.document.querySelector("[data-trace-story-sheet]"), null);
});

test("auto-track confirmed state keeps chapter-one stories as planning", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://tracefiction.test/",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const store = {
    authToken: "test-token",
    libraryOverlayCache: { entries: {} },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) {
        const entryId = "00000000-0000-4000-8000-000000000123";
        cb({
          ok: true,
          entryId,
          state: {
            accountId: "acct-story",
            workKey: "ao3:123",
            operation: "auto_track",
            status: "saved",
            entryId,
            entry: {
              status: "PLANNING",
              readerStatus: "PLANNING",
              canonicalReaderStatus: "SAVED",
              entryId,
              chapters: { current: 0, total: 10 },
            },
          },
        });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb(store);
        },
        set(value, cb) {
          Object.assign(store, value);
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(
    collectorTestSource(collectorSrc),
  );

  dom.window.__traceTestHooks.sendAutoTrackForStory({
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/123",
    t: "Chapter One",
    chn: 1,
    cht: 10,
  });

  assert.equal(store.libraryOverlayCache.entries["ao3:123"].status, "PLANNING");
});

test("auto-track confirmed state promotes planning only after later chapters", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://tracefiction.test/",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const collectorSrc = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Shared (Extension)",
      "Resources",
      "collector.js",
    ),
    "utf8",
  );

  const store = {
    authToken: "test-token",
    libraryOverlayCache: {
      entries: {
        "ao3:124": { status: "PLANNING", chapters: { current: 0, total: 10 } },
      },
    },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) {
        const entryId = "00000000-0000-4000-8000-000000000124";
        cb({
          ok: true,
          entryId,
          state: {
            accountId: "acct-story",
            workKey: "ao3:124",
            operation: "auto_track",
            status: "saved",
            entryId,
            entry: {
              status: "READING",
              readerStatus: "READING",
              canonicalReaderStatus: "READING",
              entryId,
              chapters: { current: 2, total: 10 },
            },
          },
        });
      },
      lastError: null,
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb(store);
        },
        set(value, cb) {
          Object.assign(store, value);
          if (typeof cb === "function") cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  installCollectorChrome(dom, chrome);
  dom.window.eval(
    collectorTestSource(collectorSrc),
  );

  dom.window.__traceTestHooks.sendAutoTrackForStory({
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/124",
    t: "Chapter Two",
    chn: 2,
    cht: 10,
  });

  assert.equal(store.libraryOverlayCache.entries["ao3:124"].status, "READING");
  assert.deepEqual(
    plainJson(store.libraryOverlayCache.entries["ao3:124"].chapters),
    { current: 2, total: 10 },
  );
});

test("story overlay keeps authoritative Reading state over a stale Saved work receipt", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/125/chapters/3",
    runScripts: "outside-only",
  });
  const { mergeStoryOverlayEntries } = createCollectorBindings(dom);
  const merged = mergeStoryOverlayEntries(
    {
      status: "READING",
      readerStatus: "READING",
      canonicalReaderStatus: "READING",
      entryId: "00000000-0000-4000-8000-000000000125",
      chapters: { current: 3, total: 10 },
    },
    {
      status: "PLANNING",
      readerStatus: "PLANNING",
      canonicalReaderStatus: "SAVED",
      entryId: "00000000-0000-4000-8000-000000000125",
      chapters: { current: 1, total: 10 },
      statusChoicesAvailable: true,
      __traceStatusPending: true,
      __traceSyncVersion: "2026-07-14T07:00:00.000Z",
    },
    "2026-07-14T07:02:00.000Z",
  );

  assert.equal(merged.canonicalReaderStatus, "READING");
  assert.equal(merged.status, "READING");
  assert.deepEqual(plainJson(merged.chapters), { current: 3, total: 10 });
  assert.equal(merged.statusChoicesAvailable, true);
  assert.equal(merged.__traceStatusPending, true);
  dom.window.close();
});

test("story overlay accepts a genuinely newer work receipt", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://archiveofourown.org/works/126/chapters/3",
    runScripts: "outside-only",
  });
  const { mergeStoryOverlayEntries } = createCollectorBindings(dom);
  const merged = mergeStoryOverlayEntries(
    {
      status: "PLANNING",
      readerStatus: "PLANNING",
      canonicalReaderStatus: "SAVED",
      chapters: { current: 1, total: 10 },
    },
    {
      status: "READING",
      readerStatus: "READING",
      canonicalReaderStatus: "READING",
      chapters: { current: 2, total: 10 },
      __traceSyncVersion: "2026-07-14T07:03:00.000Z",
    },
    "2026-07-14T07:02:00.000Z",
  );

  assert.equal(merged.canonicalReaderStatus, "READING");
  assert.deepEqual(plainJson(merged.chapters), { current: 2, total: 10 });
  dom.window.close();
});

test("collectFFNStoryMobile (ffn_story_mobile.html)", () => {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const { collectFFNStoryMobile } = createCollectorBindings(dom);
  const item = collectFFNStoryMobile();

  assert.equal(item.src, "ffn");
  assert.equal(item.u, "https://www.fanfiction.net/s/7038840/");
  assert.equal(item.t, "A Chance Encounter");
  assert.equal(item.a, "spectre4hire");
  assert.equal(item.w, 226000);
  assert.equal(item.chn, 1);
  assert.equal(item.cht, 28, "inferred from 'Ch 1 of 28' on page");
  assert.equal(item.rev, 2922, "from review link");
  assert.equal(item.fav, 12000);
  assert.equal(item.fol, 10000);
  assert.equal(item.pub, "1306877211");
  assert.equal(item.upd, "1489509331");
  assert.deepEqual(plainJson(item.fms), ["Harry Potter"]);
  assert.deepEqual(plainJson(item.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(item.rels), ["Harry P./Daphne G."]);
});

test("collectFFNListingsMobile (ffn_listing_mobile.html): A Chance Encounter row", () => {
  const dom = domFromFixture(
    "ffn_listing_mobile.html",
    "https://m.fanfiction.net/book/Harry-Potter/"
  );
  const { collectFFNListingsMobile } = createCollectorBindings(dom);
  const items = collectFFNListingsMobile();
  const row = items.find((i) => i.t === "A Chance Encounter");
  assert.ok(row);
  assert.equal(row.src, "ffn");
  assert.ok(row.u.includes("7038840"));
  assert.equal(row.a, "spectre4hire");
  assert.equal(row.w, 226000);
  assert.equal(row.chn, 1);
  assert.equal(row.cht, 28);
  assert.equal(row.rev, 2000);
  assert.equal(row.fav, 12000);
  assert.equal(row.fol, 10000);
  assert.equal(row.gen, "Drama/Friendship");
  assert.equal(row.pub, "1306877211");
  assert.equal(row.upd, "1489509331");
  assert.ok(row.sm && row.sm.includes("Kings Cross"));
  assert.deepEqual(plainJson(row.fms), ["Harry Potter"]);
  assert.deepEqual(plainJson(row.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(row.rels), ["Harry P./Daphne G."]);
});

test("collectFFNListingsMobile extracts author-page rows without per-row author links", () => {
  const html = `<!doctype html><html><head>
    <title>Author: Epicocity | FanFiction</title>
  </head><body>
    <div id="content">
      <div class="bs brb">
        <a href="https://m.fanfiction.net/s/11810169/1/Love-in-the-Time-of-Teamwork">Love in the Time of Teamwork</a>
        <a href="https://m.fanfiction.net/s/11810169/24/Love-in-the-Time-of-Teamwork">»</a>
        Ancienverse Book One. Once every seven years, the Kalos League hosts its annual Summit
        in order to show the past, present and future of their region. As Ash and his friends
        make their way for the exhibition, Team Neo proves to be even more dangerous than
        anticipated as they threaten the entire group. Ancienverse. Amourshipping.
        <div class="gray">
          Pokémon, K+, English, Romance &amp; Adventure, chapters: 24, words: 172k+, favs: 724,
          follows: 389, updated: <span data-xutime="1475588489">Oct 4, 2016</span>
          published: <span data-xutime="1456434386">Feb 25, 2016</span>,
          [Ash K./Satoshi, Serena] Clemont/Citron, Bonnie/Eureka
        </div>
      </div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: "https://m.fanfiction.net/u/123456/Epicocity",
    contentType: "text/html",
    runScripts: "outside-only",
  });
  const { collectFFNListingsMobile } = createCollectorBindings(dom);
  const [row] = collectFFNListingsMobile();

  assert.ok(row);
  assert.equal(row.src, "ffn");
  assert.equal(row.ctx, "listing");
  assert.equal(row.u, "https://www.fanfiction.net/s/11810169/1/Love-in-the-Time-of-Teamwork");
  assert.equal(row.a, null);
  assert.match(row.sm || "", /Once every seven years/);
  assert.doesNotMatch(row.sm || "", /Pokémon, K\+/);
  assert.equal(row.w, 172000);
  assert.equal(row.cht, 24);
  assert.equal(row.upd, "1475588489");
  assert.equal(row.pub, "1456434386");
  assert.deepEqual(plainJson(row.fms), []);
});

test("parseFFNMeta: genre-only segment before Chapters yields empty chars", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/1/1/x",
  });
  const { parseFFNMeta } = createCollectorBindings(dom);
  const p = parseFFNMeta(
    "Rated: Fiction K+ - English - General - Chapters: 1 - Words: 500"
  );
  assert.equal(Array.isArray(p.chars), true);
  assert.equal(p.chars.length, 0);
});

test("parseFFNMeta: desktop meta line with xutime spans (fixture excerpt)", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/7038840/1/x",
  });
  const { parseFFNMeta } = createCollectorBindings(dom);
  const meta =
    "Rated: Fiction T - English - Drama/Friendship - [Harry P., Daphne G.] Theodore N., Tracey D. - Chapters: 28 - Words: 226,162 - Reviews: 2,922 - Favs: 12,274 - Follows: 10,528 - Updated: Mar 14, 2017 - Published: May 31, 2011 - Status: Complete - id: 7038840";
  const metaHtml =
    'Updated: <span data-xutime="1489509331">Mar 14, 2017</span> - Published: <span data-xutime="1306877211">May 31, 2011</span>';
  const p = parseFFNMeta(meta, metaHtml);
  assert.equal(p.r, "T");
  assert.equal(p.l, "English");
  assert.equal(p.chn, 28);
  assert.equal(p.w, 226162);
  assert.equal(p.rev, 2922);
  assert.equal(p.fav, 12274);
  assert.equal(p.fol, 10528);
  assert.equal(p.gen, "Drama/Friendship");
  assert.equal(p.cmp, "complete");
  assert.equal(p.pub, "1306877211");
  assert.equal(p.upd, "1489509331");
  assert.deepEqual(plainJson(p.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(p.rels), ["Harry P./Daphne G."]);
});

test("parseFFNMeta: typical desktop meta line (genre then characters)", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/99/1/x",
  });
  const { parseFFNMeta } = createCollectorBindings(dom);
  const line =
    "Rated: Fiction K+ - English - Adventure/Romance - Morgan Q., Sam T. - Chapters: 12 - Words: 45,000";
  const p = parseFFNMeta(line);
  assert.equal(p.r, "K+");
  assert.equal(p.l, "English");
  assert.equal(p.chn, 12);
  assert.equal(p.w, 45000);
  assert.deepEqual(plainJson(p.chars), ["Morgan Q.", "Sam T."]);
});

test("parseFFNMeta: comma-separated desktop line (current FFN)", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/7038840/1/x",
  });
  const { parseFFNMeta } = createCollectorBindings(dom);
  const line =
    "Rated: T, English, Drama & Friendship, [Harry P., Daphne G.] Theodore N., Tracey D., Words: 226k+, Favs: 12k+, Follows: 10k+, Published: May 31, 2011 Updated: Mar 14, 2017";
  const p = parseFFNMeta(line, "");
  assert.equal(p.r, "T");
  assert.equal(p.l, "English");
  assert.equal(p.gen, "Drama & Friendship");
  assert.equal(p.w, 226000);
  assert.deepEqual(plainJson(p.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(p.rels), ["Harry P./Daphne G."]);
});

test("parseFFNMeta: comma-separated line keeps genre and characters separate", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/123456/1/x",
  });
  const { parseFFNMeta } = createCollectorBindings(dom);
  const line =
    "Rated: T, English, Adventure, OC, Chapters: 12, Words: 45,000";
  const p = parseFFNMeta(line, "");
  assert.equal(p.gen, "Adventure");
  assert.deepEqual(plainJson(p.chars), ["OC"]);
  assert.deepEqual(plainJson(p.rels), []);
});

test("parseFFNMetaMobile: abbreviated counts + xutime dates", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://m.fanfiction.net/s/7038840/1/x",
  });
  const { parseFFNMetaMobile } = createCollectorBindings(dom);
  const text =
    "Rated: T, English, Drama & Friendship,  [Harry P., Daphne G.] Theodore N., Tracey D., Words: 226k+, Favs: 12k+, Follows: 10k+, Published: May 31, 2011 Updated: Mar 14, 2017";
  const html =
    'Published: <span data-xutime="1306877211">May 31, 2011</span> Updated: <span data-xutime="1489509331">Mar 14, 2017</span>';
  const p = parseFFNMetaMobile(text, html);
  assert.equal(p.r, "T");
  assert.equal(p.l, "English");
  assert.equal(p.w, 226000);
  assert.equal(p.fav, 12000);
  assert.equal(p.fol, 10000);
  assert.equal(p.pub, "1306877211");
  assert.equal(p.upd, "1489509331");
  assert.deepEqual(plainJson(p.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(p.rels), ["Harry P./Daphne G."]);
});

test("parseFFNMetaMobile: comma line keeps genre and characters separate", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://m.fanfiction.net/s/123456/1/x",
  });
  const { parseFFNMetaMobile } = createCollectorBindings(dom);
  const text =
    "Rated: T, English, Adventure, OC, Chapters: 12, Words: 45k+";
  const p = parseFFNMetaMobile(text, "");
  assert.equal(p.gen, "Adventure");
  assert.deepEqual(plainJson(p.chars), ["OC"]);
  assert.deepEqual(plainJson(p.rels), []);
});

test("parseFFNMobileListingMeta: gray line + xutime html", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://m.fanfiction.net/book/Harry-Potter/",
  });
  const { parseFFNMobileListingMeta } = createCollectorBindings(dom);
  const text =
    "T, English, Drama & Friendship, chapters: 28, words: 226k+, favs: 12k+, follows: 10k+, updated: Mar 14, 2017 published: May 31, 2011, [Harry P., Daphne G.] Theodore N., Tracey D.";
  const html =
    'updated: <span data-xutime="1489509331">Mar 14, 2017</span> published: <span data-xutime="1306877211">May 31, 2011</span>';
  const p = parseFFNMobileListingMeta(text, html);
  assert.equal(p.l, "English");
  assert.equal(p.chn, 28);
  assert.equal(p.w, 226000);
  assert.equal(p.fav, 12000);
  assert.equal(p.fol, 10000);
  assert.equal(p.gen, "Drama & Friendship");
  assert.equal(p.pub, "1306877211");
  assert.equal(p.upd, "1489509331");
  assert.deepEqual(plainJson(p.chars), [
    "Harry P.",
    "Daphne G.",
    "Theodore N.",
    "Tracey D.",
  ]);
  assert.deepEqual(plainJson(p.rels), ["Harry P./Daphne G."]);
});

test("parseFFNMobileListingMeta: comma line keeps genre and characters separate", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://m.fanfiction.net/book/Harry-Potter/",
  });
  const { parseFFNMobileListingMeta } = createCollectorBindings(dom);
  const text =
    "T, English, Adventure, OC, chapters: 12, words: 45k+";
  const p = parseFFNMobileListingMeta(text, "");
  assert.equal(p.gen, "Adventure");
  assert.deepEqual(plainJson(p.chars), ["OC"]);
  assert.deepEqual(plainJson(p.rels), []);
});

test("extractFFNDesktopCharacters splits on ampersand between names", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.fanfiction.net/s/1/1/x",
  });
  const { extractFFNDesktopCharacters } = createCollectorBindings(dom);
  const meta =
    "Rated: T - English - Drama - Jordan A. & Riley B. - Chapters: 2 - Words: 900";
  assert.deepEqual([...extractFFNDesktopCharacters(meta)], [
    "Jordan A.",
    "Riley B.",
  ]);
});

test("collect() routes AO3 work vs listing", () => {
  const domWork = domFromFixture(
    "ao3_story.html",
    "https://archiveofourown.org/works/28534965/chapters/69925506"
  );
  const { collect: collectWork } = createCollectorBindings(domWork);
  const w = collectWork();
  assert.equal(w.source, "ao3");
  assert.equal(w.items.length, 1);
  assert.equal(w.items[0].t, "Redivider");

  const domList = domFromFixture(
    "ao3_listing.html",
    "https://archiveofourown.org/tags/Harry%20Potter/works"
  );
  const { collect: collectList } = createCollectorBindings(domList);
  const L = collectList();
  assert.equal(L.source, "ao3");
  assert.ok(L.items.length >= 2);
  assert.ok(L.items.some((i) => i.t === "Harry Potter and the Shadowed Light"));
});

test("collect() routes FFN story URL to single item", () => {
  const dom = domFromFixture(
    "ffn_story.html",
    "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter"
  );
  const { collect } = createCollectorBindings(dom);
  const res = collect();
  assert.equal(res.source, "ffn");
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].t, "A Chance Encounter");
  assert.ok(res.items[0].chars && res.items[0].chars.length >= 1);
});

function createActiveTabProbeCollectorHarness(fixture, url, response) {
  const dom = domFromFixture(fixture, url);
  const sent = [];
  let listener = null;
  dom.window.TRACE_IOS_ACTIVE_TAB_PROBE = true;
  dom.window.TRACE_SESSION_MODE = "kernel";
  installCollectorChrome(dom, {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
      sendMessage(message, callback) {
        sent.push(message);
        callback?.(response);
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback?.({});
        },
        set(_values, callback) {
          callback?.();
        },
      },
      onChanged: { addListener() {} },
    },
  });
  const collectorSource = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  dom.window.eval(collectorSource);
  assert.equal(typeof listener, "function");
  return { dom, sent, listener };
}

function createStaticEarnedPermissionCollectorHarness() {
  const dom = domFromFixture(
    "ao3_story.html",
    "https://archiveofourown.org/works/28534965/chapters/69925506",
  );
  const sent = [];
  let listener = null;
  dom.window.TRACE_IOS_EARNED_PERMISSION_ONBOARDING = {
    registrationMode: "static",
  };
  dom.window.TRACE_EARNED_PERMISSION_COMPLETE = false;
  dom.window.TRACE_SESSION_MODE = "kernel";
  installCollectorChrome(dom, {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
      sendMessage(message, callback) {
        sent.push(message);
        callback?.({ ok: true });
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback?.({
            prefAutoTrackEnabled: true,
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
          });
        },
        set(_values, callback) {
          callback?.();
        },
      },
      onChanged: { addListener() {} },
    },
  });
  const collectorSource = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  dom.window.eval(collectorSource);
  assert.equal(typeof listener, "function");
  return { dom, sent, listener };
}

test("static earned-permission collector cannot read or save before the complete grant", async () => {
  const harness = createStaticEarnedPermissionCollectorHarness();
  const response = await new Promise((resolve) => {
    const keepsWorkerAlive = harness.listener(
      { type: "TRACE_COLLECT" },
      {},
      resolve,
    );
    assert.equal(keepsWorkerAlive, false);
  });
  assert.deepEqual(plainJson(response), {
    ok: false,
    error: "website_access_incomplete",
  });
  assert.deepEqual(harness.sent, []);
  assert.equal(
    harness.dom.window.document.querySelector("[data-trace-quick-add-wrap]"),
    null,
  );

  harness.dom.window.TRACE_EARNED_PERMISSION_COMPLETE = true;
  harness.dom.window.document.dispatchEvent(
    new harness.dom.window.CustomEvent("trace-earned-permission-ready"),
  );
  harness.dom.window.document.dispatchEvent(
    new harness.dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );
  await delay(80);

  assert.ok(
    harness.sent.some((message) => message.type === "TRACE_ARCHIVE_SEEN"),
  );
  assert.ok(
    harness.dom.window.document.querySelector("[data-trace-quick-add-wrap]"),
  );
});

for (const fixture of [
  {
    name: "AO3",
    file: "ao3_story.html",
    url: "https://archiveofourown.org/works/28534965/chapters/69925506",
    site: "ao3",
    workKey: "ao3:28534965",
  },
  {
    name: "FFN",
    file: "ffn_story.html",
    url: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    site: "ffn",
    workKey: "ffn:7038840",
  },
]) {
  test(`active-tab probe saves one ${fixture.name} story without ambient behavior`, async () => {
    const h = createActiveTabProbeCollectorHarness(fixture.file, fixture.url, {
      ok: true,
      command: { kind: "confirmed" },
    });
    const ping = await new Promise((resolve) => {
      const keepAlive = h.listener(
        { type: "TRACE_ACTIVE_TAB_PROBE_PING" },
        {},
        resolve,
      );
      assert.equal(keepAlive, false);
    });
    assert.deepEqual(plainJson(ping), { ok: true, probe: true });

    const saved = await new Promise((resolve) => {
      const keepAlive = h.listener(
        { type: "TRACE_ACTIVE_TAB_PROBE_SAVE" },
        {},
        resolve,
      );
      assert.equal(keepAlive, true);
    });
    assert.deepEqual(plainJson(saved), {
      ok: true,
      state: "saved",
      site: fixture.site,
      serverConfirmed: true,
    });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].type, "TRACE_CONNECT_AND_SAVE");
    assert.equal(h.sent[0].workKey, fixture.workKey);
    assert.equal(h.sent[0].payload.item.ctx, "story");
    assert.equal(
      h.sent.some((message) =>
        ["TRACE_ARCHIVE_SEEN", "TRACE_AUTO_TRACK", "TRACE_METADATA_BROADCAST"].includes(message.type),
      ),
      false,
    );
    assert.equal(h.dom.window.document.querySelector("[data-trace-quick-add]"), null);
  });
}


// --- Manual mode: the reader opened Trace before lasting access ---------------

function createManualModeCollectorHarness(fixture, url, { manual = true, html = null, reply = null, privateTab } = {}) {
  // A reload is the one thing a test page cannot do; asking for one is seen here.
  const reloads = [];
  const virtualConsole = new (require("jsdom").VirtualConsole)();
  virtualConsole.on("jsdomError", (error) => {
    if (/navigation/i.test(String(error && error.message))) reloads.push(error.message);
  });
  const dom = new JSDOM(html === null ? loadFixture(fixture) : html, {
    url, contentType: "text/html", runScripts: "outside-only", virtualConsole,
  });
  const sent = [];
  let listener = null;
  if (manual) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "src", "page-manual-mode.js"), "utf8"));
  }
  dom.window.TRACE_SESSION_MODE = "kernel";
  installCollectorChrome(dom, {
    runtime: {
      id: "trace-test",
      lastError: null,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage(message, callback) {
        sent.push(message);
        callback?.((reply && reply(message)) ?? { ok: true });
      },
    },
    ...(privateTab === undefined ? {} : { extension: { inIncognitoContext: privateTab } }),
    storage: {
      local: {
        get(_keys, callback) {
          callback?.({
            prefAutoTrackEnabled: true,
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
          });
        },
        set(_values, callback) { callback?.(); },
      },
      onChanged: { addListener() {} },
    },
  });
  dom.window.eval(fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  ));
  assert.equal(typeof listener, "function");
  const background = { id: "trace-test" };
  const ask = (message, sender = background) => new Promise((resolve) => {
    assert.equal(listener(message, sender, resolve), false);
  });
  const stir = async () => {
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    dom.window.dispatchEvent(new dom.window.Event("pageshow"));
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await delay(120);
  };
  /** The reader comes back to the page: each way a browser may say so. */
  const wake = async (how) => {
    if (how === "visibilitychange") {
      Object.defineProperty(dom.window.document, "hidden", { value: false, configurable: true });
      dom.window.document.dispatchEvent(new dom.window.Event(how));
    } else {
      dom.window.dispatchEvent(new dom.window.Event(how));
    }
    await delay(20);
  };
  const of = (type) => sent.filter((message) => message.type === type);
  return { dom, sent, listener, ask, stir, wake, of, reloads, background, currentListener: () => listener };
}

const SENT_BY_ITSELF = [
  "TRACE_AUTO_TRACK",
  "TRACE_ARCHIVE_SEEN",
  "TRACE_METADATA_BROADCAST",
  "TRACE_LIBRARY_METADATA_REFRESH",
  "TRACE_FINISH_QUALIFICATION_SIGNAL",
  "TRACE_CONNECT_AND_SAVE",
  "TRACE_QUICK_ADD",
];

for (const fixture of [
  {
    name: "AO3",
    file: "ao3_story.html",
    url: "https://archiveofourown.org/works/28534965/chapters/69925506",
    source: "ao3",
    workKey: "ao3:28534965",
  },
  {
    name: "FFN",
    file: "ffn_story.html",
    url: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    source: "ffn",
    workKey: "ffn:7038840",
  },
]) {
  test(`in manual mode an ${fixture.name} story page starts nothing, hands over the story when asked, and shows its mark when told`, async () => {
    const h = createManualModeCollectorHarness(fixture.file, fixture.url);
    await h.stir();
    assert.deepEqual(h.sent.filter(({ type }) => SENT_BY_ITSELF.includes(type)), [], "nothing is sent by itself");
    assert.equal(h.dom.window.document.querySelector("[data-trace-quick-add-wrap]"), null, "no mark yet");

    const collected = plainJson(await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" }));
    assert.equal(collected.ok, true);
    assert.equal(collected.workKey, fixture.workKey);
    assert.equal(typeof collected.title, "string");
    assert.equal(collected.payload.s, fixture.source);
    assert.equal(collected.payload.item.ctx, "story");
    assert.equal(collected.payload.item.src, fixture.source);
    assert.deepEqual(h.sent.filter(({ type }) => SENT_BY_ITSELF.includes(type)), [], "reading the story sends nothing to Trace");
    assert.equal(h.dom.window.document.querySelector("[data-trace-quick-add-wrap]"), null, "and draws nothing");

    assert.deepEqual(
      plainJson(await h.ask({ type: "TRACE_FIRST_TAP_MARK", workKey: "ao3:1" })),
      { ok: false, error: "refused" },
      "a mark for another story is refused",
    );
    assert.deepEqual(plainJson(await h.ask({ type: "TRACE_FIRST_TAP_MARK", workKey: fixture.workKey })), { ok: true });
    await h.stir();
    assert.ok(h.dom.window.document.querySelector("[data-trace-quick-add-wrap]"), "the mark is on the page");
    assert.deepEqual(
      h.sent.filter(({ type }) => ["TRACE_AUTO_TRACK", "TRACE_ARCHIVE_SEEN", "TRACE_METADATA_BROADCAST",
        "TRACE_LIBRARY_METADATA_REFRESH", "TRACE_FINISH_QUALIFICATION_SIGNAL"].includes(type)),
      [],
      "the page still saves and reports nothing by itself",
    );
  });
}

test("the manual-mode messages are answered only to the extension's own background, and only in manual mode", async () => {
  const url = "https://archiveofourown.org/works/28534965/chapters/69925506";
  const manual = createManualModeCollectorHarness("ao3_story.html", url);
  for (const sender of [
    {},
    { id: "another-extension" },
    { id: "trace-test", tab: { id: 4, url } },
  ]) {
    for (const type of ["TRACE_FIRST_TAP_COLLECT", "TRACE_FIRST_TAP_MARK"]) {
      assert.deepEqual(
        plainJson(await manual.ask({ type, workKey: "ao3:28534965" }, sender)),
        { ok: false, error: "refused" },
      );
    }
  }
  assert.equal(manual.dom.window.document.querySelector("[data-trace-quick-add-wrap]"), null);

  const normal = createManualModeCollectorHarness("ao3_story.html", url, { manual: false });
  assert.deepEqual(plainJson(await normal.ask({ type: "TRACE_FIRST_TAP_COLLECT" })), { ok: false, error: "refused" });
});

test("the sheet's read of an FFN phone story page names the author beside the payload, so its summary is one request", async () => {
  const h = createManualModeCollectorHarness(
    "ffn_story_mobile.html",
    "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  );
  const collected = plainJson(await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" }));
  assert.equal(collected.ok, true);
  assert.equal(collected.payload.item.src, "ffn");
  assert.equal(collected.ffnAuthorId, "2329859");
  assert.equal("ffnAuthorId" in collected.payload.item, false, "never inside what goes to Trace");

  // A page that shows its summary needs no author.
  const desktop = createManualModeCollectorHarness(
    "ffn_story.html",
    "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  );
  assert.equal("ffnAuthorId" in plainJson(await desktop.ask({ type: "TRACE_FIRST_TAP_COLLECT" })), false);
});

test("a page with no readable story says so instead of handing over something else", async () => {
  for (const [url, html] of [
    ["https://archiveofourown.org/works/28534965", "<!doctype html><html><body><h2>Error 404</h2><p>The page you were looking for doesn't exist.</p></body></html>"],
    ["https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter", "<!doctype html><html><body><span>Story Not Found</span></body></html>"],
  ]) {
    const h = createManualModeCollectorHarness(null, url, { html });
    assert.deepEqual(plainJson(await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" })), { ok: false, error: "story_unavailable" });
    assert.deepEqual(h.sent.filter(({ type }) => SENT_BY_ITSELF.includes(type)), []);
  }
});

test("AO3's adult-content notice is not a story to save: nothing is handed over and nothing is sent", async () => {
  // The notice stands where the story will be, and carries a summary of the
  // work. The reader has not opened the story, so there is nothing to read.
  const h = createManualModeCollectorHarness(
    "ao3_adult_content_notice.html",
    "https://archiveofourown.org/works/28534965",
  );
  await h.stir();
  assert.deepEqual(plainJson(await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" })), { ok: false, error: "story_unavailable" });
  assert.deepEqual(h.sent.filter(({ type }) => SENT_BY_ITSELF.includes(type)), []);
  assert.equal(h.dom.window.document.querySelector("[data-trace-quick-add-wrap]"), null);
});

test("when the story sites are allowed, the same page script carries on: one script, one mark, nothing sent twice", async () => {
  const url = "https://archiveofourown.org/works/28534965/chapters/69925506";
  const h = createManualModeCollectorHarness("ao3_story.html", url);
  const collectorSource = fs.readFileSync(
    path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
    "utf8",
  );
  const listenerBefore = h.listener;
  await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" });
  assert.deepEqual(plainJson(await h.ask({ type: "TRACE_FIRST_TAP_MARK", workKey: "ao3:28534965" })), { ok: true });
  await h.stir();
  assert.deepEqual(h.sent.filter(({ type }) => SENT_BY_ITSELF.includes(type)), [], "manual mode: nothing by itself");

  // The background says the sites are allowed, and puts the registered
  // scripts into the open tab as it does after any grant.
  assert.deepEqual(plainJson(await h.ask({ type: "TRACE_PAGE_MANUAL_MODE_END" })), { ok: true });
  h.dom.window.eval(collectorSource);
  h.dom.window.eval(collectorSource);
  await h.stir();
  await h.stir();

  assert.equal(h.dom.window.TRACE_PAGE_MANUAL_MODE, false);
  assert.equal(h.currentListener(), listenerBefore, "the same script answers: no second one was started");
  assert.equal(h.dom.window.document.querySelectorAll("[data-trace-quick-add-wrap]").length, 1, "one mark");
  const seen = h.sent.filter(({ type }) => type === "TRACE_ARCHIVE_SEEN");
  assert.ok(seen.length >= 1, "the page now reports itself");
  assert.equal(
    h.sent.filter(({ type }) => type === "TRACE_CONNECT_AND_SAVE" || type === "TRACE_QUICK_ADD").length,
    0,
    "the story is not saved a second time",
  );
  assert.equal(
    h.sent.filter(({ type }) => type === "TRACE_AUTO_TRACK").length,
    1,
    "its place in the story goes out once, as on any story page",
  );
  assert.deepEqual(h.reloads, [], "nothing was reloaded");
  assert.deepEqual(
    plainJson(await h.ask({ type: "TRACE_PAGE_MANUAL_MODE_END" })),
    { ok: false, error: "refused" },
    "and the page is no longer in manual mode to be told twice",
  );
});

test("a page in manual mode asks, when the reader comes back to it, whether the story sites are allowed, and carries on when they are", async () => {
  const url = "https://archiveofourown.org/works/28534965/chapters/69925506";
  for (const how of ["pageshow", "focus", "visibilitychange"]) {
    let allowed = false;
    const h = createManualModeCollectorHarness("ao3_story.html", url, {
      reply: (message) => message.type === "TRACE_PAGE_MANUAL_MODE_QUERY"
        ? { ok: true, manual: !allowed, reload: false }
        : null,
    });
    const listenerBefore = h.listener;
    await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" });
    await h.ask({ type: "TRACE_FIRST_TAP_MARK", workKey: "ao3:28534965" });

    await h.wake(how);
    assert.deepEqual(plainJson(h.of("TRACE_PAGE_MANUAL_MODE_QUERY")), [{ type: "TRACE_PAGE_MANUAL_MODE_QUERY" }],
      `${how}: it asks, and says nothing of the page or the story`);
    assert.equal(h.dom.window.TRACE_PAGE_MANUAL_MODE, true, "not allowed yet: it stays as it was");
    assert.deepEqual(h.sent.filter(({ type }) => SENT_BY_ITSELF.includes(type)), []);

    // Coming back again at once does not ask again.
    await h.wake(how);
    assert.equal(h.of("TRACE_PAGE_MANUAL_MODE_QUERY").length, 1);

    // The reader allows the story sites in Safari's settings. No background
    // was awake to be told, and none remembers this page.
    allowed = true;
    h.dom.window.Date.now = () => Date.now() + 60_000;
    await h.wake(how);
    await h.stir();
    assert.equal(h.dom.window.TRACE_PAGE_MANUAL_MODE, false, `${how}: the page carries on by itself`);
    assert.equal(h.currentListener(), listenerBefore, "the same script: no second one was started");
    assert.equal(h.dom.window.document.querySelectorAll("[data-trace-quick-add-wrap]").length, 1, "one mark");
    assert.ok(h.of("TRACE_ARCHIVE_SEEN").length >= 1, "the page now reports itself");
    assert.equal(h.of("TRACE_AUTO_TRACK").length, 1, "its place in the story goes out, once");
    assert.equal(h.of("TRACE_CONNECT_AND_SAVE").length + h.of("TRACE_QUICK_ADD").length, 0, "the story is not saved a second time");
    assert.deepEqual(h.reloads, [], "and nothing was reloaded");

    // No longer in manual mode, it no longer asks.
    const asked = h.of("TRACE_PAGE_MANUAL_MODE_QUERY").length;
    h.dom.window.Date.now = () => Date.now() + 120_000;
    await h.wake(how);
    assert.equal(h.of("TRACE_PAGE_MANUAL_MODE_QUERY").length, asked);
  }
});

test("a page that was never in manual mode never asks about it", async () => {
  const h = createManualModeCollectorHarness(
    "ao3_story.html",
    "https://archiveofourown.org/works/28534965/chapters/69925506",
    { manual: false },
  );
  await h.stir();
  for (const how of ["pageshow", "focus", "visibilitychange"]) await h.wake(how);
  assert.deepEqual(h.of("TRACE_PAGE_MANUAL_MODE_QUERY"), []);
});

test("told to reload instead, a page in manual mode reloads once and starts nothing in the old document", async () => {
  const url = "https://archiveofourown.org/works/28534965/chapters/69925506";
  // Told by the background, and told in answer to its own question.
  const pushed = createManualModeCollectorHarness("ao3_story.html", url);
  assert.deepEqual(plainJson(await pushed.ask({ type: "TRACE_PAGE_MANUAL_MODE_END", reload: true })), { ok: true });
  const asked = createManualModeCollectorHarness("ao3_story.html", url, {
    reply: (message) => message.type === "TRACE_PAGE_MANUAL_MODE_QUERY" ? { ok: true, manual: false, reload: true } : null,
  });
  await asked.wake("pageshow");
  for (const h of [pushed, asked]) {
    await delay(20);
    assert.equal(h.reloads.length, 1, "the reload was asked for");
    assert.equal(h.dom.window.TRACE_PAGE_MANUAL_MODE, true, "the old document stays as it was");
    assert.deepEqual(h.sent.filter(({ type }) => SENT_BY_ITSELF.includes(type)), [], "and sends nothing by itself");
  }
});

test("the page says whether its tab is private when it hands the story over, where the browser tells it", async () => {
  const url = "https://archiveofourown.org/works/28534965/chapters/69925506";
  for (const [privateTab, expected] of [[true, true], [false, false], [undefined, null]]) {
    const h = createManualModeCollectorHarness("ao3_story.html", url, { privateTab });
    assert.equal(plainJson(await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" })).private, expected);
  }
});

test("the mode is read when something is about to be sent: lifting it lets the same page script carry on", async () => {
  const h = createManualModeCollectorHarness(
    "ao3_story.html",
    "https://archiveofourown.org/works/28534965/chapters/69925506",
  );
  await h.stir();
  assert.equal(h.sent.some(({ type }) => type === "TRACE_ARCHIVE_SEEN"), false);

  h.dom.window.TRACE_PAGE_MANUAL_MODE = false;
  h.dom.window.document.dispatchEvent(new h.dom.window.CustomEvent("trace-earned-permission-ready"));
  await h.stir();

  assert.ok(h.sent.some(({ type }) => type === "TRACE_ARCHIVE_SEEN"), "the page reports itself once the mode is lifted");
  assert.ok(h.dom.window.document.querySelector("[data-trace-quick-add-wrap]"), "and draws its mark as on any story");
  assert.deepEqual(
    plainJson(await h.ask({ type: "TRACE_FIRST_TAP_COLLECT" })),
    { ok: false, error: "refused" },
    "and no longer answers the manual-mode messages",
  );
});

test("page theme follows host body, html fallback, and a dark body", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const { traceHostPageTokens, traceRefreshPageTokens } = createCollectorBindings(dom);
  assert.equal(traceHostPageTokens().teal, "#176E72");
  dom.window.document.documentElement.style.backgroundColor = "rgb(17, 17, 17)";
  assert.equal(traceHostPageTokens().teal, "#8BCDC8");
  dom.window.document.body.style.backgroundColor = "white";
  assert.equal(traceHostPageTokens().teal, "#176E72");
  dom.window.document.body.style.backgroundColor = "#111";
  traceRefreshPageTokens();
  assert.equal(dom.window.document.body.style.getPropertyValue("--trace-page-surface"), "#121418");
});


function chapterKeptHarness(count, { firstNote = true, autoTrack = true, hidden = false } = {}) {
  const state = { chapter: 1 };
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: autoTrack,
      traceSavedNoteFirstStoryShownV1: firstNote, traceChapterKeptNotesShownV1: count },
    pendingFirstStoryResponse: { ok: true, url: "" },
    projectionResponse() {
      return { ok: true,
        snapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
        projection: { entries: { "ffn:7038840": { entryId: "00000000-0000-4000-8000-000000000123",
          status: "READING", canonicalReaderStatus: "READING",
          chapters: { current: state.chapter, total: 12 } } },
          workPreferences: hidden ? { "ffn:7038840": { hidden: true } } : {},
          syncVersion: "2026-08-22T08:30:00.000Z" } };
    },
  });
  return { h, state };
}

test("chapter progress shows no notice: the handle carries the new chapter", async () => {
  for (const prior of [0, 1, 2]) {
    const { h, state } = chapterKeptHarness(prior);
    await delay(180);
    state.chapter = 2;
    h.dispatchStorageChange("traceAccountProjectionRevisionV1", 1);
    await delay(20);
    const doc = h.dom.window.document;
    assert.equal(doc.querySelector("trace-saved-note"), null, "no page note");
    const live = doc.querySelector("[data-trace-page-live-region]");
    assert.doesNotMatch(live ? live.textContent : "", /kept/);
    assert.equal(h.handleAnimations().length, 0, "progress is not emphasized");
    assert.equal(h.store.traceChapterKeptNotesShownV1, prior, "nothing is counted");
    assert.match(doc.querySelector("[data-trace-story-handle]").textContent, /2/);
    h.dom.window.close();
  }
});

test("popup quick-add and status messages use the page's existing commands", async () => {
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    pendingFirstStoryResponse: { ok: true, url: "" } });
  await delay(180);
  const sender = { id: "trace-extension" };
  const saved = await h.sendRuntimeMessage({ type: "TRACE_POPUP_QUICK_ADD" }, sender);
  assert.equal(saved.ok, true);
  const quickAdds = h.sent.filter((message) => message.type === "TRACE_QUICK_ADD");
  assert.equal(quickAdds.length, 1);
  assert.equal(quickAdds[0].payload.s, "ffn");
  assert.equal(quickAdds[0].payload.item.t, "A Chance Encounter");
  const changed = await h.sendRuntimeMessage({ type: "TRACE_POPUP_SET_READER_STATUS",
    status: "READING", entry: { entryId: "00000000-0000-4000-8000-000000000123",
      canonicalReaderStatus: "SAVED", chapters: { current: 0, total: 12 } } }, sender);
  assert.equal(changed.ok, true);
  const updates = h.sent.filter((message) => message.type === "TRACE_SET_READER_STATUS");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.workKey, "ffn:7038840");
  assert.equal(updates[0].payload.status, "READING");
  h.dom.window.close();
});


test("page UI sources have no Quiet Margin literals or sub-12px text", () => {
  for (const name of ["collector.js", "library-overlay.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", name), "utf8");
    assert.doesNotMatch(source, /#2d4b43|#2a5d53|#bf8a1f|#fffdf8|Manrope|Geist/i, name);
    for (const match of source.matchAll(/\bfont(?:-size)?\s*:\s*[^;"']*?\b(\d+(?:\.\d+)?)px\b/g)) {
      assert.ok(Number(match[1]) >= 12, `${name}: ${match[0]}`);
    }
  }
});


test("unavailable FFN cannot offer or execute manual Add", async () => {
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    mutateDom(dom) { dom.window.document.querySelectorAll("#storytext, #storytextp, #storycontent").forEach(n => n.remove()); }
  });
  await delay(180);
  assert.doesNotMatch(h.dom.window.document.querySelector("[data-trace-quick-add-wrap]")?.textContent || "", /Add to Trace/);
  const response = await h.sendRuntimeMessage({ type: "TRACE_POPUP_QUICK_ADD" }, { id: "trace-extension" });
  assert.equal(response.ok, false);
  assert.equal(h.sent.filter(m => m.type === "TRACE_QUICK_ADD").length, 0);
  h.dom.window.close();
});


test("enabling automatic saving collects the already open page", async () => {
 const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false } });
 await delay(180);
 assert.equal(h.sent.filter(m => m.type === "TRACE_AUTO_TRACK").length, 0);
 h.store.prefAutoTrackEnabled = true;
 h.dispatchStorageChange("prefAutoTrackEnabled", true);
 await delay(180);
 assert.equal(h.sent.filter(m => m.type === "TRACE_AUTO_TRACK").length, 1);
 h.dom.window.close();
});


test("a chapter advance confirmed before the next page opens shows no notice there", async () => {
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel",
    store: { traceSavedNoteFirstStoryShownV1: true, traceChapterKeptNotesShownV1: 1 },
    mutateDom(dom) { dom.window.sessionStorage.setItem("trace:confirmed-chapter:v1", JSON.stringify({ workKey: "ffn:7038840", chapter: 2 })); },
    projectionResponse: { ok: true, snapshot: { state: "connected" }, projection: { entries: {
      "ffn:7038840": { entryId: "00000000-0000-4000-8000-000000000123", canonicalReaderStatus: "READING", chapters: { current: 3, total: 12 } }
    } } }
  });
  await delay(180);
  assert.equal(h.dom.window.document.querySelector("trace-saved-note"), null);
  assert.equal(h.handleAnimations().length, 0);
  h.dom.window.close();
});


test("content script opens and reconnects its popup relay port after an extension reload", async () => {
  const ports = [];
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false },
    connectPort(options) {
      assert.equal(options.name, "trace-popup-page-v1");
      const page = { sent: [], postMessage(message) { this.sent.push(message); },
        onMessage: { addListener(fn) { page.receive = fn; } },
        onDisconnect: { addListener(fn) { page.disconnected = fn; } }, disconnect() {} };
      ports.push(page); return page;
    },
  });
  assert.equal(ports.length, 1);
  let extraListeners = 0;
  h.dom.window.chrome.runtime.onMessage.addListener = () => { extraListeners++; };
  h.dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"), "utf8"));
  assert.equal(extraListeners, 0, "reinjection must not initialize another collector");
  assert.equal(ports.length, 2, "reinjection replaces only the relay port");
  ports[1].receive({ kind: "request", id: 1, command: { type: "TRACE_STORY_IDENTITY_GET" } });
  assert.equal(ports[1].sent[0].response.ok, true);
  assert.ok(ports[1].sent[0].response.title);
  ports[1].disconnected();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.equal(ports.length, 3);
  ports[2].receive({ kind: "request", id: 2, command: { type: "TRACE_POPUP_SET_READER_STATUS", status: "PAUSED", entry: { entryId: "entry" } } });
  assert.equal(ports[2].sent[0].kind, "command");
  assert.equal(ports[2].sent[0].command.type, "TRACE_SET_READER_STATUS");
  assert.equal(h.sent.some(message => message.type === "TRACE_SET_READER_STATUS"), false, "relay mutations remain bound to the pending account-scoped request");
  ports[2].receive({ kind: "commandResult", id: 2, response: { ok: true } });
  assert.equal(ports[2].sent.at(-1).response.ok, true);
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

function relayPortRecorder(ports) {
  return function connectPort(options) {
    assert.equal(options.name, "trace-popup-page-v1");
    const page = { sent: [], disconnectCalls: 0, postMessage(message) { this.sent.push(message); },
      onMessage: { addListener(fn) { page.receive = fn; } },
      onDisconnect: { addListener(fn) { page.disconnected = fn; } }, disconnect() { page.disconnectCalls++; } };
    ports.push(page); return page;
  };
}

function pageshowEvent(window, persisted) {
  const event = new window.Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

test("back-forward cache restore replaces a relay port that outlived the page and re-runs story work", async () => {
  const ports = [];
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false },
    connectPort: relayPortRecorder(ports) });
  assert.equal(ports.length, 1);
  const projectionReadsBefore = h.sent.filter(message => message.type === "TRACE_ACCOUNT_PROJECTION_GET").length;

  // Safari restored the page from memory without delivering pagehide, and the
  // background that owned the old port is gone. The port never reported it.
  h.dom.window.dispatchEvent(pageshowEvent(h.dom.window, true));
  assert.equal(ports.length, 2, "a restored page opens a fresh relay port");
  assert.equal(ports[0].disconnectCalls, 1, "the stale port is released, never reused");
  ports[1].receive({ kind: "request", id: 1, command: { type: "TRACE_STORY_IDENTITY_GET" } });
  assert.equal(ports[1].sent[0].response.ok, true);
  ports[0].receive({ kind: "request", id: 2, command: { type: "TRACE_STORY_IDENTITY_GET" } });
  assert.equal(ports[0].sent.length, 0, "the replaced port no longer answers");
  await delay(20);
  assert.ok(
    h.sent.filter(message => message.type === "TRACE_ACCOUNT_PROJECTION_GET").length > projectionReadsBefore,
    "the story handle asks the background again after the restore",
  );

  // An ordinary first pageshow keeps a healthy port.
  h.dom.window.dispatchEvent(pageshowEvent(h.dom.window, false));
  assert.equal(ports.length, 2);
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

test("a relay port Safari keeps dropping reconnects with growing backoff, reset by traffic", async () => {
  const ports = [];
  const delays = [];
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false },
    connectPort: relayPortRecorder(ports),
    mutateDom(dom) {
      const original = dom.window.setTimeout.bind(dom.window);
      dom.window.setTimeout = (callback, ms, ...args) => { delays.push(ms); return original(callback, ms, ...args); };
    },
  });
  delays.length = 0;
  ports[0].disconnected();
  assert.deepEqual(delays, [1_000]);
  await delay(1_050);
  assert.equal(ports.length, 2);
  delays.length = 0;
  ports[1].disconnected();
  assert.deepEqual(delays, [2_000], "a second immediate drop waits longer");
  h.dom.window.dispatchEvent(pageshowEvent(h.dom.window, false));
  assert.equal(ports.length, 3, "pageshow reconnects at once");
  ports[2].receive({ kind: "request", id: 1, command: { type: "TRACE_STORY_IDENTITY_GET" } });
  delays.length = 0;
  ports[2].disconnected();
  assert.deepEqual(delays, [1_000], "a port that carried traffic starts over at the base delay");
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

test("a story save refused while the background wakes is re-sent and saved", async () => {
  const entryId = "00000000-0000-4000-8000-000000000704";
  const savedState = { accountId: "acct-story", workKey: "ffn:7038840", operation: "auto_track", status: "saved", entryId,
    entry: { status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", entryId } };
  const h = createStoryAutoTrackPendingHarness({
    autoTrackLastErrors: ["Could not establish connection. Receiving end does not exist."],
    autoTrackResponse: { ok: true, state: savedState },
    workStateResponse: { ok: true, state: savedState },
  });
  await delay(20);
  assert.equal(h.sent.filter(message => message.type === "TRACE_AUTO_TRACK").length, 1);
  const pending = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.doesNotMatch(pending.textContent || "", /Error/, "an undelivered save is not reported as failed yet");
  await delay(1_100);
  const saves = h.sent.filter(message => message.type === "TRACE_AUTO_TRACK");
  assert.equal(saves.length, 2, "the save is sent once more after the background wakes");
  assert.deepEqual(plainJson(saves[1].payload.item), plainJson(saves[0].payload.item));
  const handle = h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent || "", /Reading|Saved/);
  h.dom.window.close();
});

test("a story save with an unknown outcome is never re-sent automatically", async () => {
  const h = createStoryAutoTrackPendingHarness({
    autoTrackLastErrors: Array(4).fill("The message port closed before a response was received."),
  });
  await delay(20);
  const saves = () => h.sent.filter(message => message.type === "TRACE_AUTO_TRACK").length;
  const initial = saves();
  assert.ok(initial >= 1);
  await delay(1_100);
  assert.equal(saves(), initial, "no delayed re-send of a save that may have landed");
  assert.match(h.dom.window.document.querySelector("[data-trace-story-handle]").textContent || "", /Not saved|Reconnect|Try/i);
  h.dom.window.close();
});

const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";

function autoTrackSends(h) {
  return h.sent.filter(message => message.type === "TRACE_AUTO_TRACK").length;
}

test("browser.* promise path: a save the browser provably never dispatched is re-sent", async () => {
  for (const refusal of [{ throw: "sendMessage unavailable" }, { reject: NO_RECEIVER }]) {
    const h = createStoryAutoTrackPendingHarness({
      scopedStorageContext: false,
      autoTrackPromiseReplies: [refusal],
    });
    await delay(50);
    assert.equal(autoTrackSends(h), 1, JSON.stringify(refusal));
    await delay(1_100);
    assert.equal(autoTrackSends(h), 2, `${JSON.stringify(refusal)} is re-sent once the wait passes`);
    h.dom.window.close();
  }
});

test("browser.* promise path: an empty reply or an unrecognised rejection is never re-sent", async () => {
  // WebKit resolves with no value both when nothing listens and when a
  // listener never replied, so an empty reply is not proof nothing ran.
  for (const outcome of [{ resolve: undefined }, { reject: "The operation couldn't be completed." }]) {
    const h = createStoryAutoTrackPendingHarness({
      scopedStorageContext: false,
      autoTrackPromiseReplies: [outcome, outcome, outcome, outcome],
    });
    await delay(50);
    const initial = autoTrackSends(h);
    assert.ok(initial >= 1);
    await delay(1_100);
    assert.equal(autoTrackSends(h), initial, `${JSON.stringify(outcome)} is not re-sent`);
    h.dom.window.close();
  }
});

test("a timed-out story save is never re-sent", async () => {
  const h = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
    mutateDom(dom) {
      // Shorten only the collector's reply deadline.
      const original = dom.window.setTimeout.bind(dom.window);
      dom.window.setTimeout = (callback, ms, ...args) => original(callback, ms === 20_000 ? 10 : ms, ...args);
    },
  });
  await delay(1_200);
  assert.equal(autoTrackSends(h), 1);
  assert.match(h.dom.window.document.querySelector("[data-trace-story-handle]").textContent || "", /Not saved|Reconnect|Try/i);
  h.dom.window.close();
});

test("re-sends of a refused story save stop at the cap", async () => {
  const h = createStoryAutoTrackPendingHarness({ autoTrackLastErrors: Array(6).fill(NO_RECEIVER) });
  await delay(4_300);
  assert.equal(autoTrackSends(h), 3, "the first send plus two re-sends");
  await delay(3_200);
  assert.equal(autoTrackSends(h), 3, "no further re-send after the cap");
  h.dom.window.close();
});

// Chrome prerenders the next chapter when AO3 asks for it. The extension
// ignores a prerendered page; opening it makes the page visible while it is
// still prerendering, and only then fires prerenderingchange.
function setPrerendering(window, prerendering) {
  Object.defineProperty(window.document, "prerendering", { value: prerendering, configurable: true });
}

test("a prerendered chapter records progress as soon as the reader opens it", async () => {
  const ports = [];
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    connectPort: relayPortRecorder(ports),
    mutateDom(dom) { setPrerendering(dom.window, true); },
  });
  await delay(50);
  assert.equal(autoTrackSends(h), 0, "nothing is saved while the page is only prerendered");
  assert.equal(ports.length, 0, "no relay port from a prerendered page");
  const seenBefore = h.sent.filter(message => message.type === "TRACE_ARCHIVE_SEEN").length;
  const lookupsBefore = h.sent.filter(message => message.type === "TRACE_WORK_STATE_GET").length;

  // Opening it: visible first, still prerendering.
  h.dom.window.document.dispatchEvent(new h.dom.window.Event("visibilitychange"));
  await delay(20);
  assert.equal(autoTrackSends(h), 0);

  setPrerendering(h.dom.window, false);
  h.dom.window.document.dispatchEvent(new h.dom.window.Event("prerenderingchange"));
  await delay(50);
  assert.equal(autoTrackSends(h), 1, "the chapter is recorded without the reader leaving the tab");
  assert.equal(ports.length, 1, "the relay port opens once the page is opened");
  assert.ok(h.sent.filter(message => message.type === "TRACE_ARCHIVE_SEEN").length > seenBefore);
  assert.ok(h.sent.filter(message => message.type === "TRACE_WORK_STATE_GET").length > lookupsBefore);

  // Later visibility changes do not record it again.
  h.dom.window.document.dispatchEvent(new h.dom.window.Event("visibilitychange"));
  h.dom.window.dispatchEvent(new h.dom.window.Event("focus"));
  await delay(20);
  assert.equal(autoTrackSends(h), 1);
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

test("an ordinary page load records progress without waiting for any event", async () => {
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel" });
  await delay(50);
  assert.equal(autoTrackSends(h), 1);
  h.dom.window.close();
});

function setHidden(window, hidden) {
  Object.defineProperty(window.document, "hidden", { value: hidden, configurable: true });
  Object.defineProperty(window.document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
}

test("relay port reconnects stop at a cap and resume when the reader returns", async () => {
  const ports = [];
  const scheduled = [];
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false },
    connectPort: relayPortRecorder(ports),
    mutateDom(dom) {
      const original = dom.window.setTimeout.bind(dom.window);
      // Run reconnect waits at once so the whole round fits in the test.
      dom.window.setTimeout = (callback, ms, ...args) => {
        if (ms >= 1_000 && ms <= 30_000 && ms !== 20_000) { scheduled.push(ms); return original(callback, 0, ...args); }
        return original(callback, ms, ...args);
      };
    },
  });
  scheduled.length = 0;
  for (let index = 0; index < 10; index += 1) {
    ports.at(-1).disconnected();
    await delay(5);
  }
  assert.deepEqual(scheduled, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  assert.equal(ports.length, 7, "one initial port plus six capped reconnects");
  h.dom.window.dispatchEvent(new h.dom.window.Event("focus"));
  assert.equal(ports.length, 8, "the reader returning starts a fresh round");
  ports.at(-1).disconnected();
  assert.equal(scheduled.at(-1), 1_000);
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

test("a hidden page does not reconnect its relay port until it is visible again", async () => {
  const ports = [];
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false },
    connectPort: relayPortRecorder(ports) });
  setHidden(h.dom.window, true);
  ports[0].disconnected();
  await delay(1_100);
  assert.equal(ports.length, 1, "no reconnect while hidden");
  h.dom.window.document.dispatchEvent(new h.dom.window.Event("visibilitychange"));
  assert.equal(ports.length, 1);
  setHidden(h.dom.window, false);
  h.dom.window.document.dispatchEvent(new h.dom.window.Event("visibilitychange"));
  assert.equal(ports.length, 2, "visible again: reconnect at once");
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

test("a relay port that stayed up resets the reconnect backoff", async () => {
  const ports = [];
  const delays = [];
  let now = 1_000_000;
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false },
    connectPort: relayPortRecorder(ports),
    mutateDom(dom) {
      dom.window.Date.now = () => now;
      const original = dom.window.setTimeout.bind(dom.window);
      dom.window.setTimeout = (callback, ms, ...args) => {
        if (ms >= 1_000 && ms <= 30_000 && ms !== 20_000) { delays.push(ms); return original(callback, 0, ...args); }
        return original(callback, ms, ...args);
      };
    },
  });
  delays.length = 0;
  ports.at(-1).disconnected();
  await delay(5);
  ports.at(-1).disconnected();
  await delay(5);
  assert.deepEqual(delays, [1_000, 2_000]);
  now += 6_000; // the reconnected port stays up
  ports.at(-1).disconnected();
  assert.equal(delays.at(-1), 1_000, "a successful reconnect starts over at the base delay");
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

test("page scripts stay on the page register: amber brass, no bars, no AO3 red, no ASCII ellipsis", () => {
  const files = ["collector.js", "library-overlay.js", "trace-finish-qualify.js", "ao3-saved-filters.js"];
  for (const file of files) {
    const src = fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", file), "utf8");
    assert.doesNotMatch(src, /#8A6420|#DCB976/i, `${file}: the retired brass`);
    assert.doesNotMatch(src, /border-left:\s*(?:[2-9]|\d{2,})px/i, `${file}: coloured bars`);
    assert.doesNotMatch(src, /text-transform:\s*uppercase/i, `${file}: uppercase labels`);
    assert.doesNotMatch(src, /(?:textContent\s*=|return)\s*[^;\n]*\.\.\.["']/, `${file}: ASCII ellipsis in copy`);
    assert.doesNotMatch(src, /#900\b|#990000|#700\b/i, `${file}: AO3-red fills`);
    assert.doesNotMatch(src, /Georgia|Geist|Manrope/, `${file}: off-system faces`);
    assert.doesNotMatch(src, /Get Trace Unlimited|Private context"/, `${file}: retired lexicon`);
    for (const [, size] of src.matchAll(/font:\s*\d{3}\s+([\d.]+)px/g)) {
      assert.ok(Number(size) >= 12, `${file}: ${size}px text is below the 12 px page floor`);
    }
  }
  const collector = fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"), "utf8");
  assert.match(collector, /authored: "#9C6212"/);
  assert.match(collector, /authored: "#DDA74E"/);
  assert.match(collector, /"record-well": "#F1F4F7"/);
  assert.match(collector, /"record-well": "#0D0F12"/);
});

test("finish band work-status choices are words in B2 cells, never status dots", () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='end'></div></body></html>", { runScripts: "outside-only" });
  dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-finish-qualify.js"), "utf8"));
  const band = dom.window.TraceFinishQualify.mount({
    anchorEl: dom.window.document.getElementById("end"), placement: "inline", story: { src: "AO3" },
    onQualify() { return false; },
  }).node;
  const choices = Array.from(band.querySelectorAll("[data-trace-work-choice]"));
  assert.equal(choices.length, 4);
  for (const choice of choices) {
    assert.equal(choice.children.length, 0, "no dot or glyph inside a work-status choice");
    assert.match(choice.getAttribute("style") || "", /border-radius:\s*12px/);
    assert.match(choice.getAttribute("style") || "", /min-height:\s*44px/);
  }
  assert.notEqual(band.getAttribute("role"), "alert");
  assert.match(band.getAttribute("style") || "", /--trace-page-surface:\s*#FFFFFF/i);
  assert.doesNotMatch(band.getAttribute("style") || "", /rgb\(255,\s*253,\s*248\)|Geist|Manrope/);
});

test("kernel story Connect runs the extension's connect, then the story can be saved", async () => {
  let state = "signed_out";
  const harness = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    projectionResponse: () => ({
      ok: true,
      snapshot: { state, reason: "none", canExecuteAuthenticated: state === "connected" },
      projection: { entries: {}, workPreferences: {}, syncVersion: null },
    }),
    onSendMessage(msg, cb) {
      if (msg.type !== "TRACE_ARCHIVE_CONNECT") return false;
      state = "connected";
      setTimeout(() => cb({
        ok: true,
        snapshot: { state, reason: "none", canExecuteAuthenticated: true },
        action: { kind: "completed", state: "connected" },
      }), 5);
      return true;
    },
  });
  const document = harness.dom.window.document;
  await delay(30);
  const handle = document.querySelector("[data-trace-story-handle]");
  assert.match(handle.textContent || "", /Connect/);
  handle.click();
  await delay(20);
  const connect = document.querySelector("[data-trace-story-connect]");
  assert.ok(connect, "the story sheet offers Connect, not only a Trace link");
  assert.equal(connect.tagName, "BUTTON");
  assert.equal(connect.textContent, "Connect");
  connect.click();
  assert.deepEqual(
    plainJson(harness.sent.filter((msg) => msg.type === "TRACE_ARCHIVE_CONNECT")),
    [{ type: "TRACE_ARCHIVE_CONNECT" }],
  );
  await delay(60);
  assert.match(handle.textContent || "", /Add to Trace/i);
  handle.click();
  assert.equal(harness.sent.at(-1).type, "TRACE_QUICK_ADD");
});

test("kernel story Connect says where to sign in when it opened Trace", async () => {
  const harness = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    store: { prefAutoTrackEnabled: false },
    projectionResponse: () => ({
      ok: true,
      snapshot: { state: "signed_out", reason: "none", canExecuteAuthenticated: false },
      projection: { entries: {}, workPreferences: {}, syncVersion: null },
    }),
    onSendMessage(msg, cb) {
      if (msg.type !== "TRACE_ARCHIVE_CONNECT") return false;
      setTimeout(() => cb({
        ok: true,
        snapshot: { state: "signed_out", reason: "provider_unavailable", canExecuteAuthenticated: false },
        action: { kind: "unavailable" },
        traceOpened: true,
      }), 5);
      return true;
    },
  });
  const document = harness.dom.window.document;
  await delay(30);
  document.querySelector("[data-trace-story-handle]").click();
  await delay(20);
  document.querySelector("[data-trace-story-connect]").click();
  await delay(60);
  const sheet = document.querySelector("[data-trace-story-sheet]");
  assert.match(sheet.textContent || "", /Sign in to Trace in the tab that opened/);
});

test("AO3 History rows carry the last-visited date and visit count", () => {
  const dom = domFromFixture(
    "ao3_history.html",
    "https://archiveofourown.org/users/Ink_Reader_Test/readings",
  );
  const { collect } = createCollectorBindings(dom);
  const res = plainJson(collect());
  assert.equal(res.source, "ao3");
  // The deleted-work row has no work id and is skipped.
  assert.deepEqual(res.items.map((i) => i.u), [
    "https://archiveofourown.org/works/41000001",
    "https://archiveofourown.org/works/41000002",
    "https://archiveofourown.org/works/41000003",
    "https://archiveofourown.org/works/41000004",
  ]);
  const [ledger, letter, fog, rain] = res.items;
  assert.equal(ledger.ctx, "listing");
  assert.equal(ledger.t, "The Lamplighter's Ledger");
  assert.equal(ledger.lv, "2026-10-08");
  assert.equal(ledger.vc, 3);
  assert.equal(ledger.s, "complete");
  assert.equal(letter.lv, "2024-02-29");
  assert.equal(letter.vc, 1);
  // Marked for Later records an intent to read, not a read.
  assert.equal("lv" in fog, false);
  assert.equal("vc" in fog, false);
  assert.equal(rain.lv, "2019-03-17");
  assert.equal(rain.vc, 1204);
});

test("AO3 Marked for Later and ordinary listings carry no visit fields", () => {
  const later = domFromFixture(
    "ao3_history.html",
    "https://archiveofourown.org/users/Ink_Reader_Test/readings?show=to-read",
  );
  const laterItems = plainJson(createCollectorBindings(later).collect().items);
  assert.equal(laterItems.length, 4);
  assert.ok(laterItems.every((i) => !("lv" in i) && !("vc" in i)));

  const listing = domFromFixture(
    "ao3_history.html",
    "https://archiveofourown.org/tags/Sherlock%20Holmes/works",
  );
  const listingItems = plainJson(createCollectorBindings(listing).collect().items);
  assert.equal(listingItems.length, 4);
  assert.ok(listingItems.every((i) => !("lv" in i) && !("vc" in i)));

  const bookmarks = domFromFixture(
    "ao3_bookmarks.html",
    "https://archiveofourown.org/users/Ink_Reader_Test/bookmarks",
  );
  const bookmarkItems = plainJson(createCollectorBindings(bookmarks).collect().items);
  assert.ok(bookmarkItems.length > 0);
  assert.ok(bookmarkItems.every((i) => !("lv" in i) && !("vc" in i)));
});

test("AO3 History dates normalise to YYYY-MM-DD and reject impossible dates", () => {
  const dom = domFromFixture("ao3_history.html", "https://archiveofourown.org/users/Ink_Reader_Test/readings");
  const { parseAO3HistoryDate } = createCollectorBindings(dom);
  assert.equal(parseAO3HistoryDate("08 Oct 2026"), "2026-10-08");
  assert.equal(parseAO3HistoryDate("8 Oct 2026"), "2026-10-08");
  assert.equal(parseAO3HistoryDate(" 01 Sept 2025 "), "2025-09-01");
  assert.equal(parseAO3HistoryDate("29 Feb 2024"), "2024-02-29");
  assert.equal(parseAO3HistoryDate("29 Feb 2025"), null);
  assert.equal(parseAO3HistoryDate("31 Apr 2025"), null);
  assert.equal(parseAO3HistoryDate("08 Foo 2026"), null);
  assert.equal(parseAO3HistoryDate("08 Oct 1999"), null);
  assert.equal(parseAO3HistoryDate(""), null);
  assert.equal(parseAO3HistoryDate(null), null);
});

test("the page answers the background's Import request over its own channel", async () => {
  const ports = [];
  const h = createStoryAutoTrackPendingHarness({ sessionMode: "kernel", store: { prefAutoTrackEnabled: false },
    connectPort: relayPortRecorder(ports) });
  assert.equal(ports.length, 1);
  ports[0].receive({ kind: "request", id: 1, command: { type: "TRACE_COLLECT" } });
  const reply = ports[0].sent.at(-1);
  assert.equal(reply.kind, "response");
  assert.equal(reply.id, 1);
  assert.equal(reply.response.ok, true);
  assert.equal(reply.response.payload.s, "ffn");
  assert.equal(reply.response.payload.items.length, 1);
  assert.equal(reply.response.payload.items[0].u, "https://www.fanfiction.net/s/7038840/");
  // Anything else is still ignored.
  ports[0].receive({ kind: "request", id: 2, command: { type: "TRACE_AUTO_TRACK" } });
  assert.equal(ports[0].sent.at(-1), reply);
  h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
  h.dom.window.close();
});

function accountSwitchHarness(options = {}) {
  const account = { binding: "1.first", entries: {} };
  const reply = (extra) => ({ ok: true, binding: account.binding,
    snapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true }, ...extra });
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    pendingFirstStoryResponse: { ok: true, url: "" },
    projectionResponse: () => reply({ projection: { entries: account.entries, workPreferences: {},
      syncVersion: "2026-10-09T12:00:00.000Z" } }),
    workStateResponse: reply({ state: null }),
    ...options,
  });
  return { h, account };
}

test("a save refused while the background wakes is not re-sent once another account is connected", async () => {
  const { h, account } = accountSwitchHarness({ autoTrackLastErrors: [NO_RECEIVER], holdAutoTrack: true });
  await delay(50);
  assert.equal(autoTrackSends(h), 1);
  // Another reader's account is connected before the retry is due.
  account.binding = "2.second";
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 2);
  await delay(1_200);
  assert.equal(autoTrackSends(h), 1, "the first account's pending save is not carried to the second");
  h.dom.window.close();

  // The same account keeps its retry.
  const same = accountSwitchHarness({ autoTrackLastErrors: [NO_RECEIVER], holdAutoTrack: true });
  await delay(50);
  same.h.dispatchStorageChange("traceAccountProjectionRevisionV1", 2);
  await delay(1_200);
  assert.equal(autoTrackSends(same.h), 2);
  same.h.dom.window.close();
});

// A page that is already open when website access is allowed asks for its
// first save at once, before the background has an account to save it for.
// The harness lets a test choose which account the background answers for,
// hold the replies that would tell the page about it, and answer each save.
function owedSaveHarness({ binding = null, tab = null, storyTextLater = false, stateReplyMs = 0 } = {}) {
  // What outlives a page in its tab: the account the background answers for,
  // the account the story is saved in, and the tab's session storage.
  const world = tab || { binding, savedFor: null, marker: null };
  const held = [];
  const neverLeaves = [];
  let holding = false;
  let storyText = null;
  const entryId = "00000000-0000-4000-8000-0000000a0002";
  const snapshot = () => world.binding === null
    ? { state: "signed_out", reason: "provider_unavailable", canExecuteAuthenticated: false }
    : { state: "connected", reason: "none", canExecuteAuthenticated: true };
  const reply = (extra) => ({ ok: true, binding: world.binding, snapshot: snapshot(), ...extra });
  const projection = () => reply({ projection: { entries: {}, workPreferences: {},
    syncVersion: "2026-10-09T12:00:00.000Z" } });
  const savedState = () => ({ workKey: "ffn:7038840", status: "saved", entryId,
    entry: { entryId, status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED",
      chapters: { current: 1, total: 12 } },
    syncVersion: "2026-10-09T12:00:00.000Z" });
  const workState = () => reply({
    state: world.binding !== null && world.savedFor === world.binding ? savedState() : null,
  });
  const h = createStoryAutoTrackPendingHarness({
    sessionMode: "kernel",
    holdAutoTrack: true,
    autoTrackLastErrors: neverLeaves,
    pendingFirstStoryResponse: { ok: true, url: "" },
    mutateDom(dom) {
      if (world.marker !== null) dom.window.sessionStorage.setItem(AUTO_TRACK_MARKER, world.marker);
      if (storyTextLater) {
        const node = dom.window.document.querySelector("#storytext, #storytextp, #storycontent");
        storyText = { node, parent: node.parentNode, next: node.nextSibling };
        node.remove();
      }
    },
    onSendMessage(message, respond) {
      if (message.type === "TRACE_WORK_STATE_GET") {
        if (holding) held.push(() => respond(workState()));
        else if (typeof respond !== "function") return true;
        else if (stateReplyMs > 0) setTimeout(() => respond(workState()), stateReplyMs);
        else respond(workState());
        return true;
      }
      if (message.type === "TRACE_ACCOUNT_PROJECTION_GET") {
        if (holding) held.push(() => respond(projection()));
        else if (typeof respond === "function") respond(projection());
        return true;
      }
      return false;
    },
  });
  return {
    h,
    sends: () => autoTrackSends(h),
    stateReads: () => h.sent.filter((message) => message.type === "TRACE_WORK_STATE_GET").length,
    // The background's next answers come from this account (null: none).
    answerAs(next) { world.binding = next; },
    // The storage change that tells an open page to read the account again.
    announce() { h.dispatchStorageChange("traceAccountProjectionRevisionV1", Date.now()); },
    hold() { holding = true; },
    release() { holding = false; held.splice(0).forEach((send) => send()); },
    refuse(error = "unavailable") {
      h.autoTrackCallback({ ok: false, error, binding: world.binding, snapshot: snapshot() });
    },
    confirm() {
      world.savedFor = world.binding;
      h.autoTrackCallback(reply({ state: savedState() }));
    },
    // The background wrote a request whose page was gone before the answer.
    savedWithoutAnswer() { world.savedFor = world.binding; },
    // The next save request fails before it reaches the background.
    nextSaveNeverLeaves() { neverLeaves.push(NO_RECEIVER); },
    show(visible) {
      const doc = h.dom.window.document;
      Object.defineProperty(doc, "visibilityState", { value: visible ? "visible" : "hidden", configurable: true });
      Object.defineProperty(doc, "hidden", { value: !visible, configurable: true });
      doc.hasFocus = () => visible;
      doc.dispatchEvent(new h.dom.window.Event("visibilitychange"));
    },
    // The reader goes to another tab or app and comes back.
    returnToTab() {
      this.show(false);
      this.show(true);
      h.dom.window.dispatchEvent(new h.dom.window.Event("focus"));
    },
    // The chapter text arrives after the page first looked for it.
    storyTextArrives() {
      storyText.parent.insertBefore(storyText.node, storyText.next);
      this.pageshow();
    },
    // The page is shown again without being loaded again.
    pageshow() { h.dom.window.dispatchEvent(new h.dom.window.Event("pageshow")); },
    marker() { return JSON.parse(h.dom.window.sessionStorage.getItem(AUTO_TRACK_MARKER) || "null"); },
    // The tab is reloaded: this page is gone and a new one takes its place.
    reload(options = {}) {
      world.marker = h.dom.window.sessionStorage.getItem(AUTO_TRACK_MARKER);
      h.dom.window.close();
      return owedSaveHarness({ tab: world, ...options });
    },
    handle: () => h.dom.window.document.querySelector("[data-trace-story-handle]").textContent || "",
    close() { h.dom.window.close(); },
  };
}
const AUTO_TRACK_MARKER = "trace:auto-track:last";

// However the page comes to learn that an account has connected, a save that
// was refused for want of one ends as one confirmed save and no further
// request. Each row replays one order of the three things that race: the
// storage change, a reply naming the account, and the page's own quiet retry
// (due 1.5 s after the refusal). `sends` is the total once the account is known.
const OWED_SAVE_ORDERINGS = [
  { name: "a reply names the account before the quiet retry is due", sends: 2,
    async run(p) { p.refuse(); await delay(300); p.answerAs("1.first"); p.announce(); await delay(400); } },
  { name: "the storage change comes first and the reply late, still before the quiet retry", sends: 2,
    async run(p) {
      p.refuse(); await delay(300); p.hold(); p.answerAs("1.first"); p.announce();
      await delay(900); p.release(); await delay(300);
    } },
  { name: "the storage change comes first and the reply after the quiet retry has gone out", sends: 2,
    async run(p) {
      p.refuse(); await delay(300); p.hold(); p.answerAs("1.first"); p.announce();
      await delay(1_500); p.release(); await delay(400);
    } },
  { name: "the quiet retry goes out first and a reply names the account while it is unanswered", sends: 2,
    async run(p) { p.refuse(); await delay(1_700); p.answerAs("1.first"); p.announce(); await delay(400); } },
  { name: "the quiet retry's own answer is the first reply to name the account", sends: 2,
    async run(p) { p.refuse(); await delay(1_700); p.answerAs("1.first"); } },
  { name: "the quiet retry is refused too, and the account connects later", sends: 3,
    async run(p) {
      p.refuse(); await delay(1_700); p.refuse(); await delay(200);
      p.answerAs("1.first"); p.announce(); await delay(400);
    } },
  { name: "the account is named while the quiet retry is unanswered, and that retry is then refused", sends: 3,
    async run(p) {
      p.refuse(); await delay(1_700); p.answerAs("1.first"); p.announce(); await delay(300);
      p.refuse(); await delay(400);
    } },
  { name: "the refusal itself is the first reply to name the account", sends: 2,
    async run(p) { p.answerAs("1.first"); p.refuse(); await delay(400); } },
];

test.describe("a save refused before any account connected", { concurrency: true }, () => {
for (const ordering of OWED_SAVE_ORDERINGS) {
  test(`a save refused before any account connected is made once: ${ordering.name}`, async () => {
    const p = owedSaveHarness();
    await delay(50);
    assert.equal(p.sends(), 1, "the page asks once on load");
    await ordering.run(p);
    assert.equal(p.sends(), ordering.sends, "one save is outstanding for the connected account");
    p.confirm();
    // Past the quiet retry, a repeated announcement and a return to the tab.
    await delay(1_800);
    p.announce();
    p.returnToTab();
    await delay(1_200);
    assert.equal(p.sends(), ordering.sends, "nothing more is asked once that save is confirmed");
    const handle = p.h.dom.window.document.querySelector("[data-trace-story-handle]");
    assert.match(handle.textContent || "", /Saved/, "the page shows the story as saved");
    p.close();
  });
}
});

test("a reader with no account is not asked for again on returning to the tab", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(1_700);
  assert.equal(p.sends(), 2, "the one quiet retry");
  p.refuse();
  for (let visit = 0; visit < 3; visit += 1) {
    await delay(400);
    p.returnToTab();
    p.announce();
    await delay(1_200);
  }
  assert.equal(p.sends(), 2, "no account has connected, so nothing more is sent");
  p.close();
});

test("a transient refusal while an account is connected is not asked for again on returning to the tab", async () => {
  const p = owedSaveHarness({ binding: "1.first" });
  await delay(50);
  p.refuse();
  await delay(1_700);
  p.refuse();
  await delay(300);
  p.returnToTab();
  await delay(1_200);
  assert.equal(p.sends(), 2);
  p.close();
});

test("a save refused under one account is not asked for again when another account replaces it", async () => {
  const p = owedSaveHarness({ binding: "1.first" });
  await delay(50);
  p.refuse();
  await delay(300);
  p.answerAs("2.second");
  p.announce();
  await delay(2_500);
  assert.equal(p.sends(), 1, "neither the quiet retry nor a new request is sent for the second account");
  p.close();
});

test("a save re-asked for the account that connected is not carried to the account that replaces it", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(200);
  p.answerAs("1.first");
  p.announce();
  await delay(1_000);
  assert.equal(p.sends(), 2, "asked again for the first account");
  // That request is refused in turn, and then another account takes over.
  p.refuse();
  await delay(200);
  p.answerAs("2.second");
  p.announce();
  await delay(2_500);
  assert.equal(p.sends(), 2);
  p.close();
});

test("a save sent for a known account is never owed to the account that replaces it", async () => {
  const p = owedSaveHarness({ binding: "1.first" });
  await delay(50);
  // The first answer tells the page which account it has; its quiet retry
  // therefore goes out for that account.
  p.refuse();
  await delay(1_700);
  assert.equal(p.sends(), 2);
  // The second account's first word to the page is a refusal of that retry.
  p.answerAs("2.second");
  p.refuse();
  await delay(2_500);
  assert.equal(p.sends(), 2);
  p.close();
});

test("an account that connects and leaves again does not pass the save on to the next account", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(1_700);
  assert.equal(p.sends(), 2, "the quiet retry is out, unanswered");
  p.answerAs("1.first");
  p.announce();
  await delay(300);
  p.answerAs(null);
  p.announce();
  await delay(300);
  p.answerAs("2.second");
  p.announce();
  await delay(300);
  p.refuse();
  await delay(2_500);
  assert.equal(p.sends(), 2);
  p.close();
});

test("an account that connects while the page is hidden gets its save when the reader comes back", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(100);
  p.show(false);
  p.answerAs("1.first");
  p.announce();
  await delay(2_500);
  assert.equal(p.sends(), 1, "nothing is sent from a hidden page");
  p.show(true);
  await delay(1_200);
  assert.equal(p.sends(), 2);
  p.close();
});

test("an account that connects and is replaced while the page is hidden leaves nothing to send", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(100);
  p.show(false);
  p.answerAs("1.first");
  p.announce();
  await delay(300);
  p.answerAs("2.second");
  p.announce();
  await delay(300);
  p.show(true);
  await delay(2_000);
  assert.equal(p.sends(), 1);
  p.close();
});

test("once the save has gone out for the connected account, its refusal is handled like any other", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(200);
  p.answerAs("1.first");
  p.announce();
  await delay(600);
  assert.equal(p.sends(), 2, "asked again for the account that connected");
  p.refuse();
  await delay(1_700);
  assert.equal(p.sends(), 3, "the usual single quiet retry");
  p.refuse();
  await delay(300);
  p.returnToTab();
  p.announce();
  await delay(1_500);
  assert.equal(p.sends(), 3, "and nothing after it, however often the reader returns");
  p.close();
});

test("only an answer that nothing was written is owed: an unknown outcome is not asked for again", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse("http_503");
  await delay(300);
  p.answerAs("1.first");
  p.announce();
  await delay(2_500);
  assert.equal(p.sends(), 1);
  p.close();
});

test("an owed save is dropped when a later request ends with an unknown outcome", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(1_700);
  assert.equal(p.sends(), 2, "the quiet retry is out");
  // The account connects while that retry is unanswered, and the retry then
  // ends in an answer that may mean a write went out.
  p.answerAs("1.first");
  p.announce();
  await delay(300);
  p.refuse("http_503");
  await delay(2_500);
  p.returnToTab();
  await delay(1_200);
  assert.equal(p.sends(), 2, "a save that may have landed is not asked for again");
  p.close();
});

test("an owed save outlives a request that never reached the background", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  p.nextSaveNeverLeaves();
  await delay(1_700);
  assert.equal(p.sends(), 2, "the quiet retry was tried and never left the page");
  p.answerAs("1.first");
  p.announce();
  await delay(600);
  assert.equal(p.sends(), 3, "the account that connected is asked");
  p.confirm();
  await delay(3_500);
  assert.equal(p.sends(), 3, "and the earlier attempt is not repeated as well");
  p.close();
});

// The popup reloads the story tab when it opens before the page has reported
// in, and always on the route that allows one website first. The page that
// asked for the first save is gone; the page that takes its place must still
// end with one confirmed save, and must not send a second if the first one
// was written after all. `sends` counts what the reloaded page itself sends.
const INHERITED_GRACE_MS = 4_000;
const RELOAD_ORDERINGS = [
  { name: "reloaded after the refusal, and the account connects later", sends: 1,
    async run(p) {
      p.refuse(); await delay(100);
      const q = p.reload(); await delay(300);
      assert.equal(q.sends(), 0, "nothing is asked while no account is connected");
      q.answerAs("1.first"); q.announce(); await delay(INHERITED_GRACE_MS + 800);
      return q;
    } },
  { name: "reloaded while the first request is unanswered (the reload that follows allowing one website), and the account connects later",
    sends: 1,
    async run(p) {
      const q = p.reload(); await delay(300);
      assert.equal(q.sends(), 0);
      assert.doesNotMatch(q.handle(), /Adding/, "nothing is being saved while no account is connected");
      q.answerAs("1.first"); q.announce(); await delay(1_000);
      assert.equal(q.sends(), 0, "the earlier request is given time to show up as saved");
      assert.match(q.handle(), /Adding/, "the page shows the save as under way during the wait");
      await delay(INHERITED_GRACE_MS);
      return q;
    } },
  { name: "reloaded twice before the account connects", sends: 1,
    async run(p) {
      let q = p.reload(); await delay(200);
      q = q.reload(); await delay(200);
      q.answerAs("1.first"); q.announce(); await delay(INHERITED_GRACE_MS + 800);
      return q;
    } },
  { name: "reloaded while unanswered, and the account connects in time to write the first request", sends: 0,
    async run(p) {
      const q = p.reload(); await delay(300);
      q.answerAs("1.first"); q.announce(); await delay(1_500);
      q.pageshow(); await delay(300);
      // The background finishes the first request; the page that sent it is
      // gone, and nothing tells this page before it asks.
      q.savedWithoutAnswer();
      await delay(INHERITED_GRACE_MS);
      return q;
    } },
  { name: "the account connected before the reloaded page heard anything, after the first request was refused", sends: 1,
    async run(p) {
      p.refuse(); await delay(100);
      p.answerAs("1.first");
      const q = p.reload(); await delay(1_000);
      assert.equal(q.sends(), 0);
      await delay(INHERITED_GRACE_MS);
      return q;
    } },
  { name: "the account connected before the reloaded page heard anything, and wrote the first request", sends: 0,
    async run(p) {
      p.answerAs("1.first"); p.savedWithoutAnswer();
      const q = p.reload(); await delay(INHERITED_GRACE_MS + 800);
      return q;
    } },
  { name: "the reloaded page learns of the account before it can read the story", sends: 1,
    async run(p) {
      p.refuse(); await delay(100);
      p.answerAs("1.first");
      const q = p.reload({ storyTextLater: true }); await delay(500);
      q.storyTextArrives(); await delay(INHERITED_GRACE_MS + 800);
      return q;
    } },
  { name: "the account connects while the reloaded page is hidden", sends: 1,
    async run(p) {
      const q = p.reload(); await delay(300);
      q.show(false);
      q.answerAs("1.first"); q.announce(); await delay(INHERITED_GRACE_MS + 800);
      assert.equal(q.sends(), 0, "nothing is sent from a hidden page");
      q.show(true); await delay(INHERITED_GRACE_MS + 800);
      return q;
    } },
];

test.describe("a first save left open by a reloaded page", { concurrency: true }, () => {
for (const ordering of RELOAD_ORDERINGS) {
  test(`a first save left open by a reloaded page is made once: ${ordering.name}`, async () => {
    const p = owedSaveHarness();
    await delay(50);
    assert.equal(p.sends(), 1, "the first page asks once on load");
    assert.equal(p.marker().open, true, "and leaves its request marked as open");
    const q = await ordering.run(p);
    assert.equal(q.sends(), ordering.sends, "what the reloaded page sends for the connected account");
    if (ordering.sends > 0) q.confirm();
    else assert.match(q.handle(), /Saved/, "the first request's save shows on the page");
    // Past the quiet retry and the wait, with a repeated announcement, a
    // return to the tab and the page being shown again.
    await delay(1_800);
    q.announce();
    q.returnToTab();
    q.pageshow();
    await delay(INHERITED_GRACE_MS + 1_200);
    assert.equal(q.sends(), ordering.sends, "nothing more is asked");
    assert.match(q.handle(), /Saved/, "the page shows the story as saved");
    q.close();
  });
}
});

test("a reloaded page asks for nothing while no account connects", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(100);
  const q = p.reload();
  for (let visit = 0; visit < 3; visit += 1) {
    await delay(400);
    q.returnToTab();
    q.pageshow();
    q.announce();
    await delay(1_600);
  }
  assert.equal(q.sends(), 0);
  q.close();
});

test("a save inherited by a reloaded page is not sent for an account that replaces the first one it hears of", async () => {
  const p = owedSaveHarness();
  await delay(50);
  const q = p.reload();
  await delay(300);
  q.answerAs("1.first");
  q.announce();
  await delay(1_000);
  q.answerAs("2.second");
  q.announce();
  await delay(INHERITED_GRACE_MS + 1_500);
  q.returnToTab();
  await delay(INHERITED_GRACE_MS + 1_500);
  assert.equal(q.sends(), 0);
  assert.doesNotMatch(q.handle(), /Adding/, "and the page does not go on showing a save under way");
  q.close();
});

test("a save inherited by a reloaded page is dropped when the first account it hears of leaves", async () => {
  const p = owedSaveHarness();
  await delay(50);
  const q = p.reload();
  await delay(300);
  q.answerAs("1.first");
  q.announce();
  await delay(1_000);
  q.answerAs(null);
  q.announce();
  await delay(500);
  q.answerAs("2.second");
  q.announce();
  await delay(INHERITED_GRACE_MS + 1_500);
  q.returnToTab();
  await delay(INHERITED_GRACE_MS + 1_500);
  assert.equal(q.sends(), 0);
  q.close();
});

test("a save sent for an account the page knows is not inherited by a reloaded page", async () => {
  await Promise.all([[true, false], [false, false], [true, true]].map(async ([confirmed, viaNone]) => {
    const p = owedSaveHarness();
    await delay(50);
    p.refuse();
    await delay(100);
    p.answerAs("1.first");
    p.announce();
    await delay(500);
    assert.equal(p.sends(), 2, "the save that is owed goes out, and the page knows which account it is for");
    assert.equal(p.marker().open, undefined, "so it is not marked open");
    if (confirmed) p.confirm();
    await delay(100);
    // Another account is connected by the time the tab is reloaded.
    p.answerAs(viaNone ? null : "2.second");
    const q = p.reload();
    await delay(500);
    q.answerAs("2.second");
    q.announce();
    await delay(INHERITED_GRACE_MS + 1_500);
    q.returnToTab();
    await delay(INHERITED_GRACE_MS + 1_500);
    const how = `${confirmed ? "confirmed" : "unanswered"}, ${viaNone ? "through no account" : "directly"}`;
    assert.equal(q.sends(), 0, how);
    assert.doesNotMatch(q.handle(), /Adding/, how);
    q.close();
  }));
});

test("a save sent just before the page heard which account it has is not inherited once it has heard", async () => {
  for (const viaNone of [false, true]) {
    const p = owedSaveHarness({ binding: "1.first" });
    await delay(50);
    assert.equal(p.marker().open, undefined, "the first answer named the account, so the request is no longer open");
    p.refuse();
    await delay(100);
    // Another account is connected by the time the tab is reloaded.
    p.answerAs(viaNone ? null : "2.second");
    const q = p.reload();
    await delay(500);
    q.answerAs("2.second");
    q.announce();
    await delay(INHERITED_GRACE_MS + 1_500);
    q.returnToTab();
    await delay(INHERITED_GRACE_MS + 1_500);
    assert.equal(q.sends(), 0, viaNone ? "through no account" : "directly");
    q.close();
  }
});

test("the wait for an inherited save is armed once, however often the page is shown during it", async () => {
  const p = owedSaveHarness();
  await delay(50);
  // The background answers a question about the story a moment later, as it does outside a test.
  const q = p.reload({ stateReplyMs: 300 });
  await delay(300);
  q.answerAs("1.first");
  q.announce();
  for (let visit = 0; visit < 5; visit += 1) {
    await delay(200);
    q.returnToTab();
    q.pageshow();
  }
  await delay(1_500);
  const readsBefore = q.stateReads();
  assert.equal(q.sends(), 0);
  await delay(INHERITED_GRACE_MS);
  assert.equal(q.stateReads() - readsBefore, 1, "the background is asked once whether the story is saved");
  assert.equal(q.sends(), 1, "and one save is sent");
  q.confirm();
  await delay(1_800);
  assert.equal(q.sends(), 1);
  assert.match(q.handle(), /Saved/);
  q.close();
});

test("a page shown again without a reload does not ask a second time while its first request is open", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.pageshow();
  await delay(300);
  assert.equal(p.sends(), 1, "unanswered");
  p.refuse();
  await delay(300);
  p.pageshow();
  await delay(300);
  assert.equal(p.sends(), 1, "refused, before the quiet retry");
  p.answerAs("1.first");
  p.announce();
  await delay(600);
  assert.equal(p.sends(), 2, "one save once the account connects, without the wait a reloaded page needs");
  p.confirm();
  await delay(INHERITED_GRACE_MS + 2_000);
  assert.equal(p.sends(), 2);
  p.close();
});

test("a save owed for one page is not sent after the page has moved on", async () => {
  const p = owedSaveHarness();
  await delay(50);
  p.refuse();
  await delay(100);
  p.h.dom.window.history.pushState({}, "", "/s/7038840/2/A-Chance-Encounter");
  p.answerAs("1.first");
  p.announce();
  await delay(2_500);
  assert.equal(p.sends(), 1);
  p.close();
});

test("a story page drops what it showed for the previous account when the account changes", async () => {
  const firstEntry = { entryId: "00000000-0000-4000-8000-0000000a0001", status: "READING",
    readerStatus: "READING", canonicalReaderStatus: "READING", chapters: { current: 1, total: 12 } };
  const { h, account } = accountSwitchHarness({
    // The first reader's automatic save is confirmed to the page directly.
    autoTrackResponse: { ok: true, binding: "1.first", snapshot: { state: "connected" },
      state: { workKey: "ffn:7038840", status: "saved", entryId: firstEntry.entryId, entry: firstEntry,
        syncVersion: "2026-10-09T12:00:00.000Z" } },
  });
  await delay(100);
  assert.equal(autoTrackSends(h), 1);
  const handle = () => h.dom.window.document.querySelector("[data-trace-story-handle]");
  assert.match(handle().textContent || "", /Reading/, "the first reader sees their saved story");

  // The second reader has not saved this story.
  account.binding = "2.second";
  h.dispatchStorageChange("traceAccountProjectionRevisionV1", 2);
  await delay(50);
  assert.doesNotMatch(handle().textContent || "", /Reading/,
    "the first reader's status is not shown to the second reader");
  h.dom.window.close();
});

test("an FFN story save with no summary names the story's author beside the payload", () => {
  const save = (item) => ({ type: "TRACE_AUTO_TRACK", payload: { s: "ffn", at: "2026-10-15T00:00:00.000Z", item } });
  const mobileItem = { src: "ffn", ctx: "story", u: "https://www.fanfiction.net/s/7038840/", sm: null };

  const mobile = createCollectorBindings(domFromFixture(
    "ffn_story_mobile.html",
    "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  ));
  const hinted = mobile.withFfnAuthorHint(save(mobileItem));
  assert.equal(hinted.ffnAuthorId, "2329859");
  assert.deepEqual(plainJson(hinted.payload), plainJson(save(mobileItem).payload));
  assert.equal("ffnAuthorId" in hinted.payload.item, false);

  const desktop = createCollectorBindings(domFromFixture(
    "ffn_story.html",
    "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  ));
  assert.equal(desktop.withFfnAuthorHint(save(mobileItem)).ffnAuthorId, "2329859");
  // A save that carries its summary, a listing row or another message is left alone.
  assert.equal(desktop.withFfnAuthorHint(save({ ...mobileItem, sm: "A summary." })).ffnAuthorId, undefined);
  assert.equal(desktop.withFfnAuthorHint(save({ ...mobileItem, ctx: "listing" })).ffnAuthorId, undefined);
  assert.equal(desktop.withFfnAuthorHint({ type: "TRACE_METADATA_BROADCAST", payload: save(mobileItem).payload }).ffnAuthorId, undefined);
});
