// Which AO3 addresses are a work's page, and which work.
//
// Four things have to agree: the page script that collects a story, the
// background's work key (which decides what a tab may read and write), the
// background's classification of the active tab, and the popup's. This file
// holds one table of addresses and checks all four against it, then checks
// each place in the background that inherits the work key.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");
const { createCollectorBindings } = require("./collector-functions.js");

const ROOT = path.join(__dirname, "..");
const RESOURCES = path.join(ROOT, "Shared (Extension)", "Resources");
const RUNTIME = path.join(ROOT, ".trace-build", "extension-runtime");
const runtime = (name) => import(path.join(RUNTIME, name));

const AO3 = "https://archiveofourown.org";
const WEB_ORIGIN = "https://www.tracefiction.com";
const LONGEST_NAME = "a".repeat(255);

// `key`: the work the background binds the page to (null: none).
// `story`: whether the popup and the active-tab classifier call it a story page.
// `collects`: the work the page script's own address test finds (it then
// also needs the story on the page before it sends anything).
const PATHS = [
  // A work, as today.
  { path: "/works/123", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/works/123/", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/works/123/chapters/456", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/works/123?view_adult=true", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/works/123/chapters/456?view_full_work=true#workskin", key: "ao3:123", story: true, collects: "ao3:123" },
  // The same work reached through a collection.
  { path: "/collections/some_collection/works/123", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/collections/some_collection/works/123/", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/collections/some_collection/works/123/chapters/456", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/collections/some_collection/works/123/chapters/456?view_adult=true#comments", key: "ao3:123", story: true, collects: "ao3:123" },
  { path: "/collections/Yuletide2024/works/987654321", key: "ao3:987654321", story: true, collects: "ao3:987654321" },
  { path: "/collections/works/works/5", key: "ao3:5", story: true, collects: "ao3:5" },
  { path: `/collections/${LONGEST_NAME}/works/5`, key: "ao3:5", story: true, collects: "ao3:5" },
  // A work's sub-pages: bound to the work as today, never called a story page.
  { path: "/works/123/bookmarks", key: "ao3:123", story: false, collects: "ao3:123" },
  { path: "/works/123/comments", key: "ao3:123", story: false, collects: "ao3:123" },
  { path: "/works/123/navigate", key: "ao3:123", story: false, collects: "ao3:123" },
  { path: "/collections/some_collection/works/123/bookmarks", key: "ao3:123", story: false, collects: "ao3:123" },
  { path: "/collections/some_collection/works/123/comments", key: "ao3:123", story: false, collects: "ao3:123" },
  // Lists that merely contain /works/: not a work page, as today.
  { path: "/works", key: null, story: false, collects: null },
  { path: "/works/search", key: null, story: false, collects: null },
  { path: "/works/search?work_search%5Bquery%5D=%2Fworks%2F999", key: null, story: false, collects: null },
  { path: "/tags/Some%20Tag/works", key: null, story: false, collects: null },
  { path: "/tags/Some%20Tag/works?page=2#/works/999", key: null, story: false, collects: null },
  { path: "/users/someone/works", key: null, story: false, collects: null },
  { path: "/users/someone/pseuds/someone/works", key: null, story: false, collects: null },
  { path: "/collections/some_collection", key: null, story: false, collects: null },
  { path: "/collections/some_collection/works", key: null, story: false, collects: null },
  { path: "/collections/some_collection/works?page=2", key: null, story: false, collects: null },
  { path: "/collections/some_collection/works/new", key: null, story: false, collects: null },
  { path: "/collections/some_collection/bookmarks", key: null, story: false, collects: null },
  { path: "/series/123", key: null, story: false, collects: null },
  { path: "/", key: null, story: false, collects: null },
];

// Addresses the collection form must not let through. The page script's own
// test is looser than the background's (it looks for /works/<digits> anywhere
// in the address); the background is the one that decides, and it refuses.
const REFUSED = [
  // More or fewer segments than /collections/<name>/works/<id>.
  "/collections/a/b/works/999",
  "/collections//works/999",
  "/collections/works/999",
  "/collections/a/collections/b/works/999",
  "/tags/x/collections/a/works/999",
  "/users/someone/works/999",
  "/x/works/999",
  // A name that tries to carry a path: encoded slashes, dots, anything not a letter, digit or underscore.
  "/collections/a%2Fworks%2F999/works/123",
  "/collections/a%2F..%2F..%2Fworks%2F999/works/123",
  "/collections/a%5Cb/works/123",
  "/collections/a.b/works/123",
  "/collections/a-b/works/123",
  "/collections/a b/works/123",
  "/collections/a;b/works/123",
  "/collections/%61/works/123",
  "/collections/名前/works/123",
  `/collections/${LONGEST_NAME}a/works/123`,
  // Not the collection form at all.
  "/collections/a/works/",
  "/collections/a/work/123",
  "/collections/a/Works/123",
  "/Collections/a/works/123",
  "/collection/a/works/123",
];

// Ids the background has never accepted. Behind a collection they get the
// answer the same path gets without one, from every classifier.
const BAD_IDS = ["0123", "12a", "-1", "123456789012345678901", "1.5", "%31%32%33"];

function popupPage() {
  const dom = new JSDOM(fs.readFileSync(path.join(RESOURCES, "popup.html"), "utf8"), {
    url: "https://tracefiction.com",
    runScripts: "outside-only",
  });
  const ext = {
    runtime: { lastError: null, sendMessage() {}, getURL: (resource) => `chrome-extension://trace-test/${resource}` },
    storage: { local: { get(_keys, callback) { callback?.({}); }, set(_values, callback) { callback?.(); } }, onChanged: { addListener() {} } },
    tabs: { query(_query, callback) { callback?.([]); } },
  };
  const context = {
    console, URL, chrome: ext, document: dom.window.document, window: dom.window, self: dom.window,
    navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 },
    setTimeout() { return 0; }, clearTimeout() {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(RESOURCES, "popup.js"), "utf8"), context);
  return (source) => vm.runInContext(source, context);
}

/** The page script's own answer for an address: the work it would collect. */
function pageScriptWorkKey(url) {
  const dom = new JSDOM("<!doctype html><html><body><h2 class=\"title heading\">A Story</h2></body></html>", { url });
  const item = createCollectorBindings(dom).collectAO3Work();
  if (!item) return null;
  assert.equal(item.ctx, "story");
  return `ao3:${new URL(item.u).pathname.match(/^\/works\/(\d+)$/)[1]}`;
}

test("the page script, the background and the popup agree on which AO3 addresses are a work's page", async () => {
  const { workKeyFromArchiveUrl } = await runtime("archive-sender.mjs");
  const { classifyActiveTabUrl } = await runtime("first-story-initiation.mjs");
  const popup = popupPage();
  for (const { path: pagePath, key, story, collects } of PATHS) {
    const url = AO3 + pagePath;
    const row = {
      "page script": pageScriptWorkKey(url),
      "work key": workKeyFromArchiveUrl(url, "ao3"),
      "active tab": classifyActiveTabUrl(url, WEB_ORIGIN).kind,
      popup: popup(`classifyEarnedPage(${JSON.stringify(url)}).kind`),
    };
    assert.equal(row["page script"], collects, `page script: ${pagePath}`);
    assert.equal(row["work key"], key, `work key: ${pagePath}`);
    assert.equal(row["active tab"], story ? "supported_story" : "supported_archive", `active tab: ${pagePath}`);
    assert.equal(row.popup, story ? "story" : "archive", `popup: ${pagePath}`);
    assert.equal(popup(`classifyProbeStory(${JSON.stringify(url)}).ok`), story, `popup probe: ${pagePath}`);
    // A story page is always bound to the work the page script collects.
    if (story) {
      assert.equal(row["work key"], row["page script"], `one work: ${pagePath}`);
      assert.equal(popup(`earnedWorkKey(${JSON.stringify(url)})`), key, `popup key: ${pagePath}`);
    }
    // A page the background binds to no work is never called a story page.
    if (row["work key"] === null) assert.equal(story, false, pagePath);
  }
});

test("a query string or fragment never changes which work an address belongs to", async () => {
  const { workKeyFromArchiveUrl } = await runtime("archive-sender.mjs");
  const { classifyActiveTabUrl } = await runtime("first-story-initiation.mjs");
  const popup = popupPage();
  const decorations = ["", "?view_adult=true", "?next=/works/999", "#/works/999", "?a=/collections/x/works/999#/collections/y/works/998"];
  for (const { path: pagePath, key, story } of PATHS.filter(({ path: p }) => !/[?#]/.test(p))) {
    for (const decoration of decorations) {
      const url = AO3 + pagePath + decoration;
      assert.equal(workKeyFromArchiveUrl(url, "ao3"), key, url);
      assert.equal(classifyActiveTabUrl(url, WEB_ORIGIN).kind, story ? "supported_story" : "supported_archive", url);
      assert.equal(popup(`classifyProbeStory(${JSON.stringify(url)}).ok`), story, url);
    }
  }
});

test("the collection form admits exactly /collections/<name>/works/<id> and nothing shaped like it", async () => {
  const { workKeyFromArchiveUrl } = await runtime("archive-sender.mjs");
  const { classifyActiveTabUrl } = await runtime("first-story-initiation.mjs");
  const popup = popupPage();
  for (const pagePath of REFUSED) {
    const url = AO3 + pagePath;
    assert.equal(workKeyFromArchiveUrl(url, "ao3"), null, `work key: ${pagePath}`);
    assert.equal(classifyActiveTabUrl(url, WEB_ORIGIN).kind, "supported_archive", `active tab: ${pagePath}`);
    assert.equal(popup(`classifyProbeStory(${JSON.stringify(url)}).ok`), false, `popup: ${pagePath}`);
  }

  for (const id of BAD_IDS) {
    const plain = `${AO3}/works/${id}`;
    const collected = `${AO3}/collections/some_collection/works/${id}`;
    assert.equal(workKeyFromArchiveUrl(collected, "ao3"), null, `work key: ${id}`);
    assert.equal(workKeyFromArchiveUrl(plain, "ao3"), null, `work key: ${id}`);
    assert.equal(classifyActiveTabUrl(collected, WEB_ORIGIN).kind, classifyActiveTabUrl(plain, WEB_ORIGIN).kind, `active tab: ${id}`);
    assert.equal(
      popup(`classifyProbeStory(${JSON.stringify(collected)}).ok`),
      popup(`classifyProbeStory(${JSON.stringify(plain)}).ok`),
      `popup: ${id}`,
    );
  }

  // Dot segments are resolved by the address parser before anything is
  // matched, exactly as the browser resolves them. The answer is always the
  // one for the address the tab is really on, never an id hidden behind them.
  for (const [written, real] of [
    ["/collections/a/works/999/../../works/123", "/collections/a/works/123"],
    ["/collections/a/../works/123", "/collections/works/123"],
    ["/collections/a/works/999/../123", "/collections/a/works/123"],
    ["/collections/a/%2e%2e/works/123", "/collections/works/123"],
    ["/works/999/../../collections/a/works/123", "/collections/a/works/123"],
  ]) {
    assert.equal(new URL(AO3 + written).pathname, real);
    assert.equal(workKeyFromArchiveUrl(AO3 + written, "ao3"), workKeyFromArchiveUrl(AO3 + real, "ao3"), written);
    assert.notEqual(workKeyFromArchiveUrl(AO3 + written, "ao3"), "ao3:999", written);
  }

  // Extra segments after the id never change the id (as for /works/<id>/…).
  assert.equal(workKeyFromArchiveUrl(`${AO3}/collections/a/works/123/works/999`, "ao3"), "ao3:123");
  assert.equal(workKeyFromArchiveUrl(`${AO3}/works/123/works/999`, "ao3"), "ao3:123");
  assert.equal(workKeyFromArchiveUrl(`${AO3}/collections/a/works/123/collections/b/works/999`, "ao3"), "ao3:123");

  // Other hosts and schemes are as they were.
  for (const url of [
    "http://archiveofourown.org/collections/a/works/123",
    "https://archiveofourown.org.example.com/collections/a/works/123",
    "https://example.com/collections/a/works/123",
    "https://www.fanfiction.net/collections/a/works/123",
  ]) {
    assert.equal(workKeyFromArchiveUrl(url, "ao3"), null, url);
  }
  for (const host of ["archiveofourown.org", "www.archiveofourown.org", "archiveofourown.gay", "archive.transformativeworks.org", "ao3.org"]) {
    assert.equal(workKeyFromArchiveUrl(`https://${host}/collections/a/works/123`, "ao3"), "ao3:123", host);
  }
});

test("FanFiction.net addresses are read exactly as before", async () => {
  const { workKeyFromArchiveUrl } = await runtime("archive-sender.mjs");
  const { classifyActiveTabUrl } = await runtime("first-story-initiation.mjs");
  const popup = popupPage();
  for (const [pagePath, key, story] of [
    ["/s/123", "ffn:123", true],
    ["/s/123/4/A-Story", "ffn:123", true],
    ["/s/123/4/A-Story?x=/works/9", "ffn:123", true],
    ["/collections/a/works/123", null, false],
    ["/collections/a/s/123", null, false],
    ["/works/123", null, false],
    ["/book/Some-Fandom/", null, false],
  ]) {
    for (const host of ["www.fanfiction.net", "m.fanfiction.net"]) {
      const url = `https://${host}${pagePath}`;
      assert.equal(workKeyFromArchiveUrl(url, "ffn"), key, url);
      assert.equal(workKeyFromArchiveUrl(url, "ao3"), null, url);
      assert.equal(classifyActiveTabUrl(url, WEB_ORIGIN).kind, story ? "supported_story" : "supported_archive", url);
      assert.equal(popup(`classifyProbeStory(${JSON.stringify(url)}).ok`), story, url);
    }
  }
});

// ---- the places in the background that inherit the work key ----

const PLAIN = `${AO3}/works/123/chapters/456`;
const THROUGH_COLLECTION = `${AO3}/collections/some_collection/works/123/chapters/456`;
const CANONICAL = `${AO3}/works/123`;
const LISTS = [
  `${AO3}/collections/some_collection/works`,
  `${AO3}/tags/Some%20Tag/works`,
  `${AO3}/users/someone/works`,
  `${AO3}/series/123`,
  `${AO3}/works/search`,
];
const tab = (url) => ({ tab: { id: 7, url }, frameId: 0 });
const storyItem = (url, extra = {}) => ({ src: "ao3", ctx: "story", u: url, t: "A Story", chn: 2, cht: 12, ...extra });
const saveMessage = (type, itemUrl, extra = {}) => ({
  type,
  workKey: "ao3:123",
  payload: { s: "ao3", at: "2026-07-19T12:00:00.000Z", item: storyItem(itemUrl, extra) },
});
const ENTRY_ID = "00000000-0000-4000-8000-000000000123";

test("saving: a story read through a collection is bound to its work like any other story page", async () => {
  const { storyTrackCommandFromMessage } = await runtime("story-command-sender.mjs");
  for (const sender of [PLAIN, THROUGH_COLLECTION]) {
    // The page script sends the work's own address; a collection-scoped one names the same work.
    for (const itemUrl of [CANONICAL, THROUGH_COLLECTION]) {
      const auto = storyTrackCommandFromMessage(saveMessage("TRACE_AUTO_TRACK", itemUrl), tab(sender));
      assert.equal(auto?.workKey, "ao3:123", `automatic save from ${sender}`);
      assert.equal(auto?.intent, "record_progress");
      assert.deepEqual({ ...auto.progress }, { current: 2, total: 12 });
      assert.equal(storyTrackCommandFromMessage(saveMessage("TRACE_QUICK_ADD", itemUrl), tab(sender))?.intent, "ensure_saved");
      assert.equal(storyTrackCommandFromMessage(saveMessage("TRACE_CONNECT_AND_SAVE", itemUrl), tab(sender))?.intent, "ensure_saved");
    }
    // It may write for its own work only.
    for (const other of [`${AO3}/works/999`, `${AO3}/collections/some_collection/works/999`]) {
      for (const type of ["TRACE_AUTO_TRACK", "TRACE_QUICK_ADD", "TRACE_CONNECT_AND_SAVE"]) {
        assert.equal(storyTrackCommandFromMessage({ ...saveMessage(type, other), workKey: "ao3:999" }, tab(sender)), null, `${type} for another work from ${sender}`);
      }
    }
    // And, being a work page, it has no list page's authority to add works by their links.
    for (const context of ["listing", "bookmark"]) {
      assert.equal(
        storyTrackCommandFromMessage({ ...saveMessage("TRACE_QUICK_ADD", `${AO3}/works/999`, { ctx: context }), workKey: "ao3:999" }, tab(sender)),
        null,
        `${context} add from ${sender}`,
      );
    }
  }
});

test("saving: every list page is refused a story save exactly as before, and keeps its list adds", async () => {
  const { storyTrackCommandFromMessage } = await runtime("story-command-sender.mjs");
  for (const list of LISTS) {
    for (const type of ["TRACE_AUTO_TRACK", "TRACE_CONNECT_AND_SAVE", "TRACE_QUICK_ADD"]) {
      assert.equal(storyTrackCommandFromMessage(saveMessage(type, CANONICAL), tab(list)), null, `${type} from ${list}`);
    }
    const listed = storyTrackCommandFromMessage(saveMessage("TRACE_QUICK_ADD", CANONICAL, { ctx: "listing" }), tab(list));
    assert.equal(listed?.workKey, "ao3:123", `a list still adds a work it lists: ${list}`);
    // A work listed with its collection-scoped link is the same work.
    assert.equal(
      storyTrackCommandFromMessage(saveMessage("TRACE_QUICK_ADD", `${AO3}/collections/some_collection/works/123`, { ctx: "listing" }), tab(list))?.workKey,
      "ao3:123",
    );
  }
  // An item address that is not a work is refused from anywhere.
  for (const itemUrl of [`${AO3}/collections/a/b/works/123`, `${AO3}/collections/a%2Fb/works/123`, `${AO3}/collections/some_collection/works`]) {
    for (const sender of [PLAIN, THROUGH_COLLECTION, LISTS[0]]) {
      assert.equal(storyTrackCommandFromMessage(saveMessage("TRACE_QUICK_ADD", itemUrl, { ctx: "listing" }), tab(sender)), null, itemUrl);
      assert.equal(storyTrackCommandFromMessage(saveMessage("TRACE_AUTO_TRACK", itemUrl), tab(sender)), null, itemUrl);
    }
  }
});

test("story details: a collection-scoped story page may describe its own work, and only that", async () => {
  const { metadataContributionCommandFromMessage } = await runtime("metadata-contribution-sender.mjs");
  const broadcast = (itemUrl) => ({ type: "TRACE_METADATA_BROADCAST", payload: { s: "ao3", at: "2026-07-19T12:00:00.000Z", item: storyItem(itemUrl) } });
  const refresh = (items) => ({ type: "TRACE_LIBRARY_METADATA_REFRESH", payload: { items } });
  for (const sender of [PLAIN, THROUGH_COLLECTION]) {
    for (const itemUrl of [CANONICAL, THROUGH_COLLECTION]) {
      const command = metadataContributionCommandFromMessage(broadcast(itemUrl), tab(sender));
      assert.equal(command?.kind, "story_metadata", `${itemUrl} from ${sender}`);
      assert.deepEqual([...command.workKeys], ["ao3:123"]);
    }
    assert.equal(metadataContributionCommandFromMessage(broadcast(`${AO3}/works/999`), tab(sender)), null);
    // A work page is not a list: it cannot refresh other works' details.
    assert.equal(metadataContributionCommandFromMessage(refresh([{ source: "ao3", url: `${AO3}/works/999` }]), tab(sender)), null);
  }
  for (const list of LISTS) {
    assert.equal(metadataContributionCommandFromMessage(broadcast(CANONICAL), tab(list)), null, `story details from ${list}`);
    const listed = metadataContributionCommandFromMessage(
      refresh([{ source: "ao3", url: CANONICAL }, { source: "ao3", url: `${AO3}/collections/some_collection/works/124` }]),
      tab(list),
    );
    assert.deepEqual([...listed.workKeys], ["ao3:123", "ao3:124"], `a list still refreshes the works it lists: ${list}`);
    assert.equal(metadataContributionCommandFromMessage(refresh([{ source: "ao3", url: `${AO3}/collections/a/b/works/124` }]), tab(list)), null);
    assert.equal(
      metadataContributionCommandFromMessage(refresh([{ source: "ao3", sourceStoryId: "999", url: `${AO3}/collections/some_collection/works/124` }]), tab(list)),
      null,
      "an id that disagrees with the address is refused",
    );
  }
});

test("status changes: a collection-scoped story page may change its own work, and only that", async () => {
  const { libraryMutationCommandFromMessage, finishQualificationCommandFromMessage } = await runtime("library-command-sender.mjs");
  const setStatus = (workKey) => ({ type: "TRACE_SET_READER_STATUS", payload: { workKey, entryId: ENTRY_ID, status: "READING" } });
  const hide = (key) => ({ type: "TRACE_SET_HIDDEN_WORK", payload: { key, hidden: true } });
  for (const sender of [PLAIN, THROUGH_COLLECTION]) {
    assert.equal(libraryMutationCommandFromMessage(setStatus("ao3:123"), tab(sender))?.workKey, "ao3:123", sender);
    assert.equal(libraryMutationCommandFromMessage(hide("ao3:123"), tab(sender))?.workKey, "ao3:123", sender);
    assert.equal(libraryMutationCommandFromMessage(setStatus("ao3:999"), tab(sender)), null, `another work from ${sender}`);
    assert.equal(libraryMutationCommandFromMessage(hide("ao3:999"), tab(sender)), null, `another work from ${sender}`);
  }
  // A list page acts on the works it lists, as before.
  for (const list of LISTS) {
    assert.equal(libraryMutationCommandFromMessage(setStatus("ao3:999"), tab(list))?.workKey, "ao3:999", list);
    assert.equal(libraryMutationCommandFromMessage(hide("ao3:123"), tab(list))?.workKey, "ao3:123", list);
  }
  assert.equal(typeof finishQualificationCommandFromMessage, "function");
});

function backgroundWith({ activeTabUrl }) {
  const writes = [];
  const values = {};
  const loaded = runtime("controller.mjs").then(({ installSessionRuntime }) => installSessionRuntime({
    alarms: { async clear() { return true; } },
    databaseFactory: new IDBFactory(),
    mode: "kernel",
    runtime: {
      id: "trace-extension-id",
      onMessage: { addListener() {} },
      async getPlatformInfo() { return { os: "ios" }; },
      async sendNativeMessage(message) {
        if (message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST") {
          return { ok: true, protocolVersion: 3, credential: "token", credentialKind: "access_token" };
        }
        return { ok: true };
      },
    },
    tabs: { async query() { return [{ id: 7, url: activeTabUrl }]; }, async sendMessage() { return null; } },
    storageArea: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
      },
      async set(patch) { Object.assign(values, patch); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    },
    storageMode: "promise",
    fetch: async (url) => {
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({ account_id: "account-a", pro: false, library_count: 1 }), { status: 200 });
      }
      if (url.endsWith("/api/extension/library-overlay")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: { "ao3:123": { entryId: ENTRY_ID, status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", chapters: { current: 1, total: 12 } } },
            workPreferences: {},
            syncVersion: "2026-07-19T12:00:00.000Z",
          },
        }), { status: 200 });
      }
      writes.push(url.replace("https://api.tracefiction.com", ""));
      return new Response(JSON.stringify({
        success: true,
        data: {
          entry_id: ENTRY_ID,
          type: "updated",
          work_key: "ao3:123",
          entry: { entryId: ENTRY_ID, status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", chapters: { current: 2, total: 12 } },
          syncVersion: "2026-07-19T12:00:01.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: WEB_ORIGIN,
    randomId: (() => { let next = 0; return () => `id-${(next += 1)}`; })(),
  }));
  return { loaded, writes };
}

const popupSender = { id: "trace-extension-id", url: "chrome-extension://trace-extension-id/popup.html" };

test("the background: a story read through a collection is saved, read back and shown to the popup", async () => {
  for (const pageUrl of [PLAIN, THROUGH_COLLECTION]) {
    const { loaded, writes } = backgroundWith({ activeTabUrl: pageUrl });
    const controller = await loaded;
    await controller.start();

    const saved = await controller.handle(saveMessage("TRACE_AUTO_TRACK", CANONICAL), tab(pageUrl));
    assert.equal(saved?.ok, true, `automatic save from ${pageUrl}`);
    assert.equal(writes.length, 1, "one write to the API");

    const state = await controller.handle({ type: "TRACE_WORK_STATE_GET", workKey: "ao3:123" }, tab(pageUrl));
    assert.equal(state?.ok, true, `work state from ${pageUrl}`);
    assert.equal(state.state?.status, "saved");
    assert.equal(await controller.handle({ type: "TRACE_WORK_STATE_GET", workKey: "ao3:999" }, tab(pageUrl)), null, "another work's state is not readable from here");

    const popupState = await controller.handle({ type: "TRACE_POPUP_GET_STATE" }, popupSender);
    assert.equal(popupState.activeTab.kind, "supported_story", `popup's view of ${pageUrl}`);
    assert.equal(popupState.activeWork?.workKey, "ao3:123");
    assert.equal(popupState.activeWork?.status, "saved");
  }
});

test("the background: list pages get no save, no work state and no active work, as before", async () => {
  for (const list of LISTS) {
    const { loaded, writes } = backgroundWith({ activeTabUrl: list });
    const controller = await loaded;
    await controller.start();
    assert.equal(await controller.handle(saveMessage("TRACE_AUTO_TRACK", CANONICAL), tab(list)), null, `automatic save from ${list}`);
    assert.equal(await controller.handle(saveMessage("TRACE_CONNECT_AND_SAVE", CANONICAL), tab(list)), null);
    assert.equal(await controller.handle({ type: "TRACE_WORK_STATE_GET", workKey: "ao3:123" }, tab(list)), null, `work state from ${list}`);
    assert.deepEqual(writes, [], "nothing was written");
    const popupState = await controller.handle({ type: "TRACE_POPUP_GET_STATE" }, popupSender);
    assert.equal(popupState.activeTab.kind, "supported_archive", list);
    assert.equal(popupState.activeWork, null, list);
  }
});
