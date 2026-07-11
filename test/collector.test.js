const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
  createCollectorBindings,
  withDefaultScopedStorageContext,
} = require("./collector-functions.js");

const FIXTURES = path.join(__dirname, "fixtures");

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
  dom.window.browser = scoped;
}

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
  const bindings = createCollectorBindings(dom, { chrome });
  return { dom, store, sentMessages, bindings };
}

test("sendAutoTrackForStory clears dedupe marker on failed acknowledgements", () => {
  const failures = [
    undefined,
    { ok: false, error: "auth_expired" },
    { ok: false, error: "free_limit_reached" },
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

    assert.equal(sentMessages.length, 1);
    assert.equal(dom.window.sessionStorage.getItem("trace:auto-track:last"), null);
    assert.deepEqual(plainJson(store.libraryOverlayCache.entries), {});
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
  dom.window.eval(collectorSrc);
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
  assert.match(handle.textContent || "", /Adding\.\.\./);
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

function createStoryAutoTrackPendingHarness(options = {}) {
  const dom = domFromFixture(
    "ffn_story_mobile.html",
    options.url || "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter",
  );
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  Object.defineProperty(dom.window.document, "hidden", {
    value: false,
    configurable: true,
  });
  dom.window.document.hasFocus = () => true;

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
  let autoTrackCallback;
  let runtimeMessageListener = null;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          runtimeMessageListener = fn;
        },
      },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (msg.type === "TRACE_WORK_STATE_GET") {
          if (typeof cb === "function") {
            cb(options.workStateResponse || { ok: true, state: null });
          }
          return;
        }
        if (msg.type === "TRACE_AUTO_TRACK") {
          autoTrackCallback = cb;
          if (!options.holdAutoTrack && typeof cb === "function") {
            cb(options.autoTrackResponse || { ok: true });
          }
          return;
        }
        if (msg.type === "TRACE_QUICK_ADD" && typeof cb === "function") {
          cb(options.quickAddResponse || { ok: true });
          return;
        }
        if (msg.type === "TRACE_IOS_PENDING_FIRST_STORY_GET") {
          if (typeof cb === "function") {
            cb(options.pendingFirstStoryResponse || { ok: true, url: "" });
          }
          return;
        }
        if (msg.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR") {
          if (typeof cb === "function") cb({ ok: true });
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

  if (options.scopedStorageContext === false) {
    dom.window.chrome = chrome;
    dom.window.browser = chrome;
  } else {
    installCollectorChrome(dom, chrome);
  }
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  return {
    dom,
    sent,
    store,
    autoTrackCallback(response) {
      autoTrackCallback(response);
    },
    sendRuntimeMessage(message) {
      return new Promise((resolve) => {
        assert.equal(typeof runtimeMessageListener, "function");
        const asyncResponse = runtimeMessageListener(message, {}, resolve);
        if (asyncResponse !== true) {
          Promise.resolve().then(() => resolve(undefined));
        }
      });
    },
  };
}

test("story page unknown work shows pending while auto-track is in flight and ignores manual add", () => {
  const { dom, sent } = createStoryAutoTrackPendingHarness({
    holdAutoTrack: true,
  });

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle, "expected Trace story handle");
  assert.equal(handle.disabled, true);
  assert.match(handle.textContent || "", /Adding\.\.\./);

  const sentBeforeClick = sent.length;
  handle.click();
  assert.equal(sent.length, sentBeforeClick);
  assert.equal(
    sent.filter((msg) => msg.type === "TRACE_QUICK_ADD").length,
    0,
    "manual quick-add must not fire while auto-track is pending",
  );
});

test("story page auto-track pending overrides stale saved cache", () => {
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
  assert.equal(handle.disabled, true);
  assert.match(handle.textContent || "", /Adding\.\.\./);
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
  assert.match(handle.textContent || "", /Adding\.\.\./);
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
  assert.match(handle.textContent || "", /Adding\.\.\./);
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
    // The native app currently creates this mode for AO3. FFN is used here to
    // exercise the collector's host-match guard with the existing story fixture.
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
  assert.match(handle.textContent || "", /Adding\.\.\./);

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
    { response: { ok: false, error: "free_limit_reached" }, expected: /Full/i, disabled: true },
    { response: { ok: false, error: "auth_expired" }, expected: /Sign in/i, disabled: true },
    { response: { ok: false, error: "http_503" }, expected: /ERROR/i, disabled: false },
  ];

  for (const item of cases) {
    const { dom, autoTrackCallback } = createStoryAutoTrackPendingHarness({
      holdAutoTrack: true,
    });
    const handle = dom.window.document.querySelector("[data-trace-story-handle]");
    assert.match(handle.textContent || "", /Adding\.\.\./);

    autoTrackCallback(item.response);

    assert.match(handle.textContent || "", item.expected);
    assert.equal(handle.disabled, item.disabled);
  }
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
  assert.match(handle.textContent || "", /Adding\.\.\./);

  autoTrackCallback({ ok: false, error: "confirmation_missing" });

  assert.match(handle.textContent || "", /Error/i);
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
  dom.window.eval(collectorSrc);
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
  assert.match(sheet.getAttribute("style") || "", /position:\s*fixed/i);
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
  dom.window.eval(collectorSrc);
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

test("FFN desktop story places compact Trace handle after profile header", () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='profile_top'><b class='xcontrast_txt'>Demo FFN Work</b> by <a href='/u/1/demo'>demo</a><div class='xcontrast_txt'>A long enough story summary for Trace collection to ignore title-only nodes.</div><span class='xgray xcontrast_txt'>Rated: Fiction T - English - Chapters: 3 - Words: 12,345</span></div></body></html>",
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
  dom.window.eval(collectorSrc);
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
  dom.window.eval(collectorSrc);
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
  dom.window.eval(collectorSrc);
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
    dom.window.eval(collectorSrc);
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
    assert.deepEqual(plainJson(sent.at(-1).payload), { entryId, status: choice.status });
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
    dom.window.eval(collectorSrc);
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
    assert.doesNotMatch(header.textContent || "", /\bTrace\b/i);
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
    assert.equal(selected.getAttribute("aria-pressed"), "true");
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
      payload: { entryId, status: "FINISHED" },
    });
  }
});

test("story sheet selected status choice uses status-specific D1 tint", () => {
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
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  assert.ok(handle);
  handle.click();

  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const selected = sheet.querySelector("[data-trace-status-selected='1']");
  assert.equal(selected.getAttribute("data-trace-status-choice"), "PAUSED");
  assert.match(
    selected.getAttribute("style") || "",
    /background:\s*(?:#efddcd|rgb\(239,\s*221,\s*205\))/i,
  );
  assert.match(
    selected.getAttribute("style") || "",
    /--sc:\s*#a8623a/i,
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
  dom.window.eval(collectorSrc);
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


test("finish qualify watches AO3 chapter text before end notes", () => {
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
        if (msg.type === "TRACE_PATCH_LIBRARY_ENTRY" && typeof cb === "function") {
          cb({ ok: true, entryId, patch: msg.payload.patch });
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
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  assert.equal(watchedBody, dom.window.document.querySelector("[data-test-id='chapter-text']"));
  assert.notEqual(watchedBody, dom.window.document.querySelector("#chapters"));
  assert.equal(toastShown, true);
  assert.deepEqual(plainJson(sent.find((msg) => msg.type === "TRACE_PATCH_LIBRARY_ENTRY").payload), {
    entryId,
    patch: {
      status: "FINISHED",
      progress: { unit: "CHAPTER", value: 1, total: 1 },
    },
  });
});

test("finish qualify band prompts on unknown FFN final chapter and writes finished for abandoned work override", () => {
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
        if (msg.type === "TRACE_PATCH_LIBRARY_ENTRY" && typeof cb === "function") {
          cb({ ok: true, entryId, patch: msg.payload.patch });
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
  dom.window.eval(finishSrc);
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const band = dom.window.document.querySelector("[data-trace-finish-qualify]");
  assert.ok(band);
  assert.match(band.textContent || "", /reached the end/i);
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
  const abandoned = band.querySelector("[data-trace-work-choice='abandoned']");
  assert.ok(abandoned);
  abandoned.click();

  const patchMsg = sent.find((msg) => msg.type === "TRACE_PATCH_LIBRARY_ENTRY");
  assert.ok(patchMsg);
  assert.deepEqual(plainJson(patchMsg.payload), {
    entryId,
    patch: {
      status: "FINISHED",
      progress: { unit: "CHAPTER", value: 28, total: 28 },
      story_snapshot: { work_status_override: "abandoned" },
    },
  });
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
    workStatus: "abandoned",
    readerStatus: "FINISHED",
  });
  assert.match(band.textContent || "", /Finished/i);
  assert.match(band.textContent || "", /Work looks abandoned/i);
});

test("finish qualify inserts AO3 prompt after the final end notes and aligns to content column", () => {
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
        if (typeof cb === "function") cb({ ok: true, entryId });
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
  dom.window.eval(finishSrc);
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const band = dom.window.document.querySelector("[data-trace-finish-qualify]");
  const workEndNotes = dom.window.document.querySelector("#work_endnotes");
  assert.ok(band);
  assert.equal(workEndNotes.nextElementSibling, band);
  assert.match(band.getAttribute("style") || "", /max-width:\s*520px/);
  assert.match(band.getAttribute("style") || "", /margin:\s*22px 0/);
});

test("finish qualify silently marks known-complete final chapter as finished", () => {
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
      sendMessage(msg, cb) {
        sent.push(msg);
        if (msg.type === "TRACE_PATCH_LIBRARY_ENTRY" && typeof cb === "function") {
          cb({ ok: true, entryId, patch: msg.payload.patch });
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
                "ffn:9001": {
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
  dom.window.eval(finishSrc);
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  assert.equal(dom.window.document.querySelector("[data-trace-finish-qualify]"), null);
  const patchMsg = sent.find((msg) => msg.type === "TRACE_PATCH_LIBRARY_ENTRY");
  assert.ok(patchMsg);
  assert.deepEqual(plainJson(patchMsg.payload), {
    entryId,
    patch: {
      status: "FINISHED",
      progress: { unit: "CHAPTER", value: 1, total: 1 },
    },
  });
  assert.ok(dom.window.document.querySelector("[data-trace-finish-toast]"));
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
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const handle = dom.window.document.querySelector("[data-trace-story-handle]");
  handle.click();
  const sheet = dom.window.document.querySelector("[data-trace-story-sheet]");
  const position = sheet.querySelector("[data-trace-story-position]");
  assert.ok(position);
  assert.match(position.className || "", /\bx-pos\b/);
  assert.match(position.textContent || "", /Ch 3\s*\/\s*\?/);
  assert.equal(position.querySelector(".bar"), null);
  assert.equal(position.querySelector(".step"), null);
  assert.doesNotMatch(sheet.textContent || "", /(?:chapter|Set to current)/i);
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
  dom.window.eval(collectorSrc);
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
  dom.window.eval(collectorSrc);
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
  assert.match(sheet.textContent || "", /Ch 3\s*\/\s*28/);
  assert.match(sheet.textContent || "", /11%/);
  assert.match(sheet.textContent || "", /Set progress to chapter 5/i);
  assert.ok(sheet.querySelector(".x-pos .bar i"));
  assert.equal(sheet.querySelector(".x-pos .step"), null);
  assert.match(sheet.textContent || "", /Reading/i);
  assert.match(sheet.textContent || "", /My actual private note for this story\./i);
  assert.doesNotMatch(sheet.textContent || "", /Private note saved\s*·\s*edit in Trace/i);
  assert.ok(sheet.querySelector(".x-meta-row .note"));
  assert.match(sheet.textContent || "", /comfort/i);
  assert.match(sheet.textContent || "", /reread/i);
  assert.match(sheet.textContent || "", /favorite/i);
  assert.match(sheet.textContent || "", /\+1/i);
  assert.doesNotMatch(sheet.textContent || "", /long/i);
  assert.doesNotMatch(sheet.textContent || "", /4 private tags/i);
  const privateTagRow = Array.from(sheet.querySelectorAll(".x-meta-row")).find((row) =>
    /comfort/i.test(row.textContent || ""),
  );
  assert.ok(privateTagRow);
  assert.equal(privateTagRow.querySelectorAll(".x-utag").length, 4);
  for (const tag of privateTagRow.querySelectorAll(".x-utag")) {
    assert.match(tag.getAttribute("style") || "", /border-radius:\s*999px/i);
    assert.match(tag.getAttribute("style") || "", /background:\s*(?:#d8e3d5|rgb\(216,\s*227,\s*213\))/i);
    assert.match(tag.getAttribute("style") || "", /padding:\s*5px 14px/i);
    assert.match(tag.getAttribute("style") || "", /max-width:\s*150px/i);
    assert.match(tag.getAttribute("style") || "", /text-overflow:\s*ellipsis/i);
  }
  assert.doesNotMatch(sheet.textContent || "", /Marked abandoned/i);
  assert.match(sheet.textContent || "", /Hidden from future listings/i);
  const undoBtn = sheet.querySelector("button[data-trace-hidden-action='undo']");
  assert.ok(undoBtn);
  assert.equal(undoBtn.textContent || "", "Unhide");
  assert.doesNotMatch(undoBtn.className || "", /\bicon-only\b/);
  const ratingControl = sheet.querySelector("[data-trace-rating-control]");
  assert.ok(ratingControl);
  assert.equal(
    Array.from(ratingControl.querySelectorAll("[data-trace-rating-choice]"))
      .map((button) => button.textContent)
      .join(""),
    "★★★☆☆",
  );
  ratingControl.querySelector("[data-trace-rating-choice='5']").click();
  assert.deepEqual(plainJson(sent.at(-1)), {
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: {
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
      entryId: "00000000-0000-4000-8000-000000703884",
      patch: {
        status: "CAUGHT_UP",
        progress: { unit: "CHAPTER", value: 5, total: 28 },
      },
    },
  });
  assert.equal(sheet.getAttribute("data-trace-open"), "1");
  assert.equal(sheet.getAttribute("aria-hidden"), "false");
  assert.equal(
    sheet.querySelector("[data-trace-open-trace]").getAttribute("href"),
    "https://tracefiction.com/?panel=details&entryId=00000000-0000-4000-8000-000000703884",
  );
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
    dom.window.eval(collectorSrc);
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
    dom.window.eval(collectorSrc);
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
    { response: { ok: false, error: "http_500" }, text: /ERROR/i },
    { response: { ok: false, error: "auth_expired" }, text: /Sign in/i },
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
    dom.window.eval(collectorSrc);
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
  dom.window.eval(collectorSrc);
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
    collectorSrc + "\nwindow.__traceTestHooks = { sendAutoTrackForStory };",
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
    collectorSrc + "\nwindow.__traceTestHooks = { sendAutoTrackForStory };",
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
