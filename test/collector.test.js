const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createCollectorBindings } = require("./collector-functions.js");

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
  assert.equal(item.s, "wip", "chapters 17/? → wip via chapter-based fallback");
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
    storyMetadataFingerprint({ ...base, chn: 4 }),
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

test("sendAutoTrackForStory keeps dedupe marker for ignored senders", () => {
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

  assert.notEqual(dom.window.sessionStorage.getItem("trace:auto-track:last"), null);
  assert.deepEqual(plainJson(store.libraryOverlayCache.entries), {});
});

test("sendAutoTrackForStory updates overlay cache only after confirmed ack", () => {
  const item = {
    src: "ao3",
    ctx: "story",
    u: "https://archiveofourown.org/works/28534965",
    t: "Redivider",
    chn: 3,
    cht: 17,
  };
  const { dom, store, bindings } = createAutoTrackCollectorHarness({ ok: true });

  bindings.sendAutoTrackForStory(item);

  assert.notEqual(dom.window.sessionStorage.getItem("trace:auto-track:last"), null);
  assert.deepEqual(plainJson(store.libraryOverlayCache.entries["ao3:28534965"]), {
    status: "READING",
    chapters: { current: 3, total: 17 },
  });
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

test("FFN mobile story renders quick-add button for signed-in users", () => {
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

  dom.window.chrome = chrome;
  dom.window.browser = chrome;
  dom.window.eval(collectorSrc);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const btn = dom.window.document.querySelector("[data-trace-quick-add]");
  assert.ok(btn, "expected quick-add button on FFN mobile story page");
  assert.match(btn.textContent || "", /\+ ADD TO TRACE/i);
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
