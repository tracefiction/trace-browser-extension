import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  SETUP_ACCESS_PUSH_MESSAGE,
  SETUP_PAGE_MESSAGE,
  SETUP_REQUEST_LIMIT,
  SETUP_REQUEST_WINDOW_MS,
  SETUP_STORY_LIST_LIFE_MS,
  SETUP_STORY_TAB_LIMIT,
  SETUP_TAB_TITLE_MAX_LENGTH,
  STORY_SITE_ORIGINS,
  SetupPageController,
  installSetupPageRuntime,
  isSetupPagePath,
  storyPageSite,
} from "../../.trace-build/extension-runtime/setup-page.mjs";
import { workKeyFromArchiveUrl } from "../../.trace-build/extension-runtime/archive-sender.mjs";
import { classifyActiveTabUrl } from "../../.trace-build/extension-runtime/first-story-initiation.mjs";

const WEB = "https://www.tracefiction.com";
const SETUP_URL = `${WEB}/safari-setup`;
const EXTENSION_ID = "trace-extension";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const AO3 = "https://archiveofourown.org";
const FFN = "https://www.fanfiction.net";

/** The setup page in tab 1 of window 1, unless told otherwise. A tab given here is in window 1 unless it says. */
const pageSender = ({ tab, ...overrides } = {}) => ({
  id: EXTENSION_ID,
  url: SETUP_URL,
  tab: tab === undefined ? { id: 1, url: SETUP_URL, windowId: 1 } : { windowId: 1, ...tab },
  frameId: 0,
  documentLifecycle: "active",
  ...overrides,
});
const popupSender = { id: EXTENSION_ID, url: "safari-web-extension://trace/popup.html" };

const ask = (request, extra = {}) => ({ type: SETUP_PAGE_MESSAGE, request, ...extra });
/** The popup has no tab of its own: it names the tab it is open over. */
const askFromPopup = (overTab = 1) => ask("story-tabs", { overTab });
const SETUP_TAB = { id: 1, url: SETUP_URL, title: "Set up Trace", lastAccessed: 900 };

/** Whether an address is covered by any of these match patterns. */
function matchesAny(patterns, address) {
  return patterns.some((pattern) => {
    if (pattern === "*://*/*" || pattern === "<all_urls>") return /^https?:\/\//.test(address);
    const parts = /^(\*|https?):\/\/(\*\.)?([^/]+)(\/.*)$/.exec(pattern);
    if (!parts) return false;
    const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const scheme = parts[1] === "*" ? "https?" : parts[1];
    const host = `${parts[2] ? "(?:[^/]+\\.)?" : ""}${escape(parts[3])}`;
    const path = parts[4].split("*").map(escape).join(".*");
    return new RegExp(`^${scheme}://${host}(?::\\d+)?${path}$`).test(address);
  });
}

const STORY_TAB_PATTERNS = [...STORY_SITE_ORIGINS, "https://*.ao3.org/*"];
/** The one question asked about a window's tabs: its story-site tabs, by address. */
const storyTabQuery = (windowId) => ["query", { windowId, url: STORY_TAB_PATTERNS }];

/**
 * The background's view of the browser. `granted` is what Safari allows;
 * `tabs` is every open tab, as the tabs API would return it.
 */
function createHarness(options = {}) {
  let now = 1_000_000;
  let granted = options.granted ?? [...STORY_SITE_ORIGINS, `${WEB}/*`];
  // Every tab is in window 1 unless it says otherwise, and the setup page is
  // open in tab 1 unless that id is taken.
  const inWindows = (list) => (list.some((tab) => tab.id === 1) ? list : [SETUP_TAB, ...list])
    .map((tab) => (Object.hasOwn(tab, "windowId") ? { ...tab } : { windowId: 1, ...tab }));
  let tabs = inWindows(options.tabs ?? []);
  let silent = options.permissionsSilent === true;
  const calls = [];
  const sent = [];
  const added = [];
  const removed = [];
  const listeners = [];
  const platformAsked = [];
  const runtime = {
    ...(options.withoutRuntimeId ? {} : { id: EXTENSION_ID }),
    onMessage: { addListener: (listener) => listeners.push(listener) },
    // Present wherever Trace ships beside its app. The setup surface never uses it.
    ...(options.withoutNativeMessaging ? {} : {
      sendNativeMessage() {
        assert.fail("the setup surface sends nothing to the app");
      },
    }),
    ...(options.os === undefined ? {} : {
      getPlatformInfo() {
        platformAsked.push(true);
        if (options.os === "unreadable") return Promise.reject(new Error("no answer"));
        return options.platformAnswer ?? Promise.resolve({ os: options.os });
      },
    }),
  };
  const tabsApi = {
    async query(filter) {
      calls.push(["query", filter]);
      if (options.queryFails) throw new Error("tabs unavailable");
      // Safari treats a query with no address filter as a wish to read every
      // tab it covers, and may ask the reader about any of them.
      assert.ok(Array.isArray(filter?.url) && filter.url.length > 0, "every tab query names the addresses it is for");
      if (options.queryIgnoresFilter) return tabs.map((tab) => ({ ...tab }));
      // As Safari answers: with an address filter, only tabs the extension may
      // already read can match.
      return tabs
        .filter((tab) => (filter.windowId === undefined || tab.windowId === filter.windowId) &&
          typeof tab.url === "string" && matchesAny(granted, tab.url) && matchesAny(filter.url, tab.url))
        .map((tab) => ({ ...tab }));
    },
    async get(tabId) {
      calls.push(["get", tabId]);
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error("No tab with that id");
      return { ...tab };
    },
    async update(tabId, properties) {
      calls.push(["update", tabId, properties]);
      if (options.updateFails) throw new Error("cannot switch");
      return { id: tabId };
    },
    async sendMessage(tabId, message) {
      sent.push({ tabId, message });
      return undefined;
    },
    async create() {
      calls.push(["create"]);
      assert.fail("the setup surface never opens a tab");
    },
  };
  const permissions = {
    async getAll() {
      calls.push(["getAll"]);
      if (silent) throw new Error("no answer");
      return { origins: [...granted] };
    },
    async contains({ origins }) {
      calls.push(["contains"]);
      if (silent) throw new Error("no answer");
      if (options.traceAccessUnknown && origins.includes(`${WEB}/*`)) {
        if (options.traceAccessUnknown === "silent") return undefined;
        throw new Error("no answer");
      }
      return granted.includes("*://*/*") || origins.every((origin) => granted.includes(origin));
    },
    request() {
      calls.push(["request"]);
      assert.fail("the setup surface never raises a permission request");
    },
    onAdded: { addListener: (listener) => added.push(listener) },
    onRemoved: { addListener: (listener) => removed.push(listener) },
  };
  const environment = {
    runtime,
    tabs: tabsApi,
    permissions,
    mode: "promise",
    webOrigin: WEB,
    storyOrigins: STORY_SITE_ORIGINS,
    clock: { now: () => now },
    platform: { userAgent: options.userAgent ?? IPHONE_UA },
  };
  const controller = options.install ? installSetupPageRuntime(environment) : new SetupPageController(environment);
  return {
    controller, calls, sent, added, removed, listeners, platformAsked,
    browserCalls: () => calls.filter(([name]) => name !== "contains" && name !== "getAll"),
    setGranted(value) { granted = value; },
    setTabs(value) { tabs = inWindows(value); },
    setPermissionsSilent(value) { silent = value; },
    advance(ms) { now += ms; },
  };
}

const STORY_TABS = [
  { id: 11, url: `${AO3}/works/123/chapters/456`, title: "The Long Way Round - Chapter 3 - quillfeather [Archive of Our Own]", lastAccessed: 300 },
  { id: 12, url: `${FFN}/s/4821/2/The-Other-Road`, title: "The Other Road Chapter 2, a fanfic | FanFiction", lastAccessed: 500 },
  { id: 13, url: `${AO3}/works/777`, title: "A Third Thing [Archive of Our Own]", lastAccessed: 100 },
];
const OTHER_TABS = [
  { id: 1, url: SETUP_URL, title: "Set up Trace", lastAccessed: 900 },
  { id: 21, url: "https://bank.example/accounts/12345", title: "My accounts: 12345 balance", lastAccessed: 800 },
  { id: 22, url: `${AO3}/tags/Some%20Tag/works`, title: "Some Tag works [Archive of Our Own]", lastAccessed: 700 },
  { id: 23, url: `${AO3}/users/login`, title: "Log In [Archive of Our Own]", lastAccessed: 650 },
  { id: 24, url: `${AO3}/works/123/bookmarks`, title: "Bookmarks of The Long Way Round", lastAccessed: 640 },
  { id: 25, url: `${FFN}/book/Some-Fandom/`, title: "Some Fandom | FanFiction", lastAccessed: 630 },
  { id: 26, title: "A tab Safari tells Trace nothing about", lastAccessed: 620 },
  { id: 27, url: `${WEB}/library`, title: "Library", lastAccessed: 610 },
  { id: 29, url: `${WEB}/safari-setup-old`, title: "An older page", lastAccessed: 590 },
  { id: 30, url: `${WEB}/safari-setup/x`, title: "A page under it", lastAccessed: 580 },
  { id: 31, url: `${WEB}/safari-setup/?from=app#step-2`, title: "Set up Trace", lastAccessed: 570 },
  { id: 32, url: `${WEB}/`, title: "Trace", lastAccessed: 560 },
  { id: 28, url: "https://archiveofourown.org.example.com/works/123", title: "Not AO3", lastAccessed: 600 },
];

test("access: whether the story sites are allowed, and how broadly", async () => {
  for (const [granted, expected] of [
    [[...STORY_SITE_ORIGINS, `${WEB}/*`], { storySitesAllowed: true, scope: "story-sites" }],
    [["*://*/*"], { storySitesAllowed: true, scope: "all" }],
    [[...STORY_SITE_ORIGINS, "<all_urls>"], { storySitesAllowed: true, scope: "all" }],
    [[`${WEB}/*`], { storySitesAllowed: false, scope: "this-site" }],
    [[`${WEB}/*`, ...STORY_SITE_ORIGINS.slice(0, 4)], { storySitesAllowed: false, scope: "this-site" }],
    [[], { storySitesAllowed: false, scope: "this-site" }],
  ]) {
    const h = createHarness({ granted });
    assert.deepEqual(await h.controller.handle(ask("access"), pageSender()), { ok: true, result: expected }, JSON.stringify(granted));
    assert.deepEqual(await h.controller.handle(ask("access"), popupSender), { ok: true, result: expected });
    assert.deepEqual(h.browserCalls(), [], "it reads permissions and nothing else");
  }
  // Safari did not answer: say so, rather than "not allowed".
  const silent = createHarness({ permissionsSilent: true });
  assert.deepEqual(await silent.controller.handle(ask("access"), pageSender()), { ok: false, error: "unavailable" });
});

const at = (url, tabUrl = url) => pageSender({ url, tab: { id: 1, url: tabUrl } });

test("only the setup page itself, top-level on Trace's own origin, or the popup, is answered", async () => {
  const refusedSenders = {
    "Trace's home page": at(`${WEB}/`),
    "the signed-in Trace app": at(`${WEB}/library`),
    "a Trace page whose path only starts the same": at(`${WEB}/safari-setup-old`),
    "a Trace page under the setup path": at(`${WEB}/safari-setup/x`),
    "a Trace page under the setup path, with a slash": at(`${WEB}/safari-setup/x/`),
    "a Trace page with the setup path further in": at(`${WEB}/x/safari-setup`),
    "a Trace page naming the setup path in its query": at(`${WEB}/library?next=/safari-setup`),
    "a Trace page naming the setup path in its fragment": at(`${WEB}/library#/safari-setup`),
    "the setup path in another case": at(`${WEB}/Safari-Setup`),
    "the setup path with a file ending": at(`${WEB}/safari-setup.html`),
    "the setup page in a frame of another Trace page": pageSender({ frameId: 3, tab: { id: 1, url: `${WEB}/library` } }),
    "the setup page reported as top-level inside another Trace page's tab": at(SETUP_URL, `${WEB}/library`),
    "another Trace page reported as top-level inside the setup page's tab": at(`${WEB}/library`, SETUP_URL),
    "the setup page in a frame of the setup page": pageSender({ frameId: 2 }),
    "an AO3 page": pageSender({ url: `${AO3}/works/123`, tab: { id: 11, url: `${AO3}/works/123` } }),
    "a FanFiction.net page": pageSender({ url: `${FFN}/s/4821/1/`, tab: { id: 12, url: `${FFN}/s/4821/1/` } }),
    "any other site": pageSender({ url: "https://example.com/safari-setup", tab: { id: 3, url: "https://example.com/safari-setup" } }),
    "a look-alike origin": pageSender({ url: "https://www.tracefiction.com.example.com/safari-setup", tab: { id: 3, url: "https://www.tracefiction.com.example.com/safari-setup" } }),
    "another subdomain": pageSender({ url: "https://app.tracefiction.com/safari-setup", tab: { id: 3, url: "https://app.tracefiction.com/safari-setup" } }),
    "plain http": pageSender({ url: "http://www.tracefiction.com/safari-setup", tab: { id: 3, url: "http://www.tracefiction.com/safari-setup" } }),
    "a Trace frame inside another site's tab": pageSender({ frameId: 4, tab: { id: 3, url: "https://example.com/" } }),
    "a Trace frame reported as top-level inside another site's tab": pageSender({ tab: { id: 3, url: "https://example.com/" } }),
    "a Trace frame reported as top-level inside a look-alike's tab": pageSender({ tab: { id: 3, url: "https://nottracefiction.com/safari-setup" } }),
    "a Trace frame reported as top-level inside a tab on another port": pageSender({ tab: { id: 3, url: "https://www.tracefiction.com:8443/safari-setup" } }),
    "a Trace frame reported as top-level inside a plain-http tab": pageSender({ tab: { id: 3, url: "http://www.tracefiction.com/safari-setup" } }),
    "a Trace frame reported as top-level inside a tab with no usable address": pageSender({ tab: { id: 3, url: "not an address" } }),
    "another site's frame inside a Trace tab": pageSender({ url: "https://example.com/widget", frameId: 2 }),
    "another site's frame claiming to be top-level in a Trace tab": pageSender({ url: "https://example.com/widget" }),
    "a Trace frame inside a Trace page": pageSender({ frameId: 1 }),
    "a page that is being prerendered": pageSender({ documentLifecycle: "prerender" }),
    "another extension": pageSender({ id: "another-extension" }),
    "a sender with no tab": { id: EXTENSION_ID, url: SETUP_URL, frameId: 0 },
    "a sender with no address": { id: EXTENSION_ID, tab: { id: 1 }, frameId: 0 },
    "a sender whose tab has no id": { id: EXTENSION_ID, url: SETUP_URL, tab: { url: SETUP_URL }, frameId: 0 },
    "no sender at all": undefined,
  };
  for (const [name, sender] of Object.entries(refusedSenders)) {
    const h = createHarness({ tabs: [...STORY_TABS, ...OTHER_TABS] });
    for (const message of [ask("access"), ask("story-tabs"), ask("switch-to-tab", { tabId: 11 })]) {
      assert.deepEqual(await h.controller.handle(message, sender), { ok: false, error: "forbidden" }, `${name}: ${message.request}`);
    }
    assert.deepEqual(h.calls, [], `${name}: nothing was read on its behalf`);
  }
  // The same questions from the setup page, however it was reached, and from the popup are answered.
  const h = createHarness({ tabs: [...STORY_TABS, ...OTHER_TABS] });
  for (const sender of [
    pageSender(),
    at(`${SETUP_URL}/`),
    at(`${SETUP_URL}?from=app`),
    at(`${SETUP_URL}/?from=app#step-2`),
    at(`${SETUP_URL}#step-2`, SETUP_URL),
    { id: EXTENSION_ID, url: SETUP_URL, tab: { id: 4 }, frameId: 0 },
    { id: EXTENSION_ID, tab: { id: 5, url: SETUP_URL }, frameId: 0 },
  ]) {
    assert.equal((await h.controller.handle(ask("story-tabs"), sender)).ok, true, sender.url ?? sender.tab.url);
  }
  assert.equal((await h.controller.handle(askFromPopup(), popupSender)).result.tabs.length, 3);
});

test("the popup is this extension's own, by id as well as by address", async () => {
  const address = popupSender.url;
  const refusedSenders = {
    "another extension's popup": { id: "another-extension", url: address },
    "another extension's popup at this extension's address": { id: "another-extension", url: `safari-web-extension://${EXTENSION_ID}/popup.html` },
    "a popup address with no id": { url: address },
    "a popup address with an empty id": { id: "", url: address },
    "another extension with no address": { id: "another-extension" },
  };
  for (const [name, sender] of Object.entries(refusedSenders)) {
    const h = createHarness({ tabs: [...STORY_TABS] });
    for (const message of [ask("access"), askFromPopup(), ask("switch-to-tab", { tabId: 11 })]) {
      assert.deepEqual(await h.controller.handle(message, sender), { ok: false, error: "forbidden" }, `${name}: ${message.request}`);
    }
    assert.deepEqual(h.calls, [], `${name}: nothing was read on its behalf`);
  }
  // A background that does not know its own id answers no popup at all.
  const unnamed = createHarness({ tabs: [...STORY_TABS], withoutRuntimeId: true });
  for (const sender of [popupSender, { url: address }, { id: undefined, url: address }]) {
    assert.deepEqual(await unnamed.controller.handle(askFromPopup(), sender), { ok: false, error: "forbidden" });
  }
  assert.deepEqual(unnamed.calls, []);
  // This extension's popup, with or without an address, is answered.
  const h = createHarness({ tabs: [...STORY_TABS] });
  for (const sender of [popupSender, { id: EXTENSION_ID }]) {
    assert.equal((await h.controller.handle(askFromPopup(), sender)).result.tabs.length, 3);
  }
});

test("the setup page's path is exactly that, with or without a trailing slash", () => {
  for (const path of ["/safari-setup", "/safari-setup/"]) assert.equal(isSetupPagePath(path), true, path);
  for (const path of [
    "", "/", "/library", "/safari-setup-old", "/safari-setup/x", "/safari-setup//", "/safari-setup.html", "/x/safari-setup",
    "/Safari-Setup", "/safari-setu", "safari-setup", "/safari-setup\n", "/safari-setup?x", "/safari-setup#x", " /safari-setup",
  ]) {
    assert.equal(isSetupPagePath(path), false, JSON.stringify(path));
  }
});

test("a request it does not know, or one that is malformed, is refused by name", async () => {
  const h = createHarness({ tabs: STORY_TABS });
  for (const [message, error] of [
    [ask("request-access"), "unknown_request"],
    [ask("open-tab", { url: `${AO3}/works/1` }), "unknown_request"],
    [ask(""), "unknown_request"],
    [{ type: SETUP_PAGE_MESSAGE }, "invalid_request"],
    [ask(7), "invalid_request"],
    [ask("access", { origins: ["*://*/*"] }), "invalid_request"],
    [ask("story-tabs", { url: "*" }), "invalid_request"],
    [ask("story-tabs", { overTab: 1 }), "invalid_request"],
    [ask("story-tabs", { windowId: 2 }), "invalid_request"],
    [ask("switch-to-tab"), "invalid_request"],
    [ask("switch-to-tab", { tabId: "11" }), "invalid_request"],
    [ask("switch-to-tab", { tabId: 1.5 }), "invalid_request"],
    [ask("switch-to-tab", { tabId: -1 }), "invalid_request"],
    [ask("switch-to-tab", { tabId: 11, url: `${AO3}/works/1` }), "invalid_request"],
  ]) {
    assert.deepEqual(await h.controller.handle(message, pageSender()), { ok: false, error }, JSON.stringify(message));
  }
  assert.deepEqual(h.browserCalls(), []);
  // Another message type is not this controller's at all.
  assert.equal(await h.controller.handle({ type: "TRACE_SOMETHING_ELSE", request: "access" }, pageSender()), null);
  assert.equal(await h.controller.handle("TRACE_SETUP_PAGE_REQUEST", pageSender()), null);

  // The popup must name the tab it is open over, and nothing more.
  for (const message of [
    ask("story-tabs"), askFromPopup("1"), askFromPopup(1.5), askFromPopup(-1), askFromPopup(null),
    ask("story-tabs", { overTab: 1, windowId: 2 }), ask("story-tabs", { tabId: 1 }),
  ]) {
    assert.deepEqual(await h.controller.handle(message, popupSender), { ok: false, error: "invalid_request" }, JSON.stringify(message));
  }
  assert.deepEqual(h.browserCalls(), []);
});

test("story tabs: only story pages, most recently used first, by title, never by address", async () => {
  const h = createHarness({ tabs: [...OTHER_TABS, ...STORY_TABS] });
  const answer = await h.controller.handle(ask("story-tabs"), pageSender());
  assert.deepEqual(answer, {
    ok: true,
    result: {
      tabs: [
        { tabId: 12, title: "The Other Road Chapter 2, a fanfic | FanFiction", site: "ffn" },
        { tabId: 11, title: "The Long Way Round - Chapter 3 - quillfeather [Archive of Our Own]", site: "ao3" },
        { tabId: 13, title: "A Third Thing [Archive of Our Own]", site: "ao3" },
      ],
    },
  });
  const text = JSON.stringify(answer);
  assert.doesNotMatch(text, /https?:|archiveofourown\.org|fanfiction\.net|bank|12345|Library|Log In|Bookmarks/, "no address, and nothing about any other tab");
  assert.deepEqual(Object.keys(answer.result.tabs[0]).sort(), ["site", "tabId", "title"]);
  assert.deepEqual(h.browserCalls(), [storyTabQuery(1)], "one look at this window's story-site tabs; nothing is changed");
});

test("story tabs: at most five, titles kept to one capped line, order settled without a last-used time", async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    id: 100 + index, url: `${AO3}/works/${index + 1}`, title: `Story ${index + 1}`, active: index === 6,
  }));
  assert.equal(SETUP_STORY_TAB_LIMIT, 5);
  assert.equal(SETUP_TAB_TITLE_MAX_LENGTH, 120);
  const h = createHarness({ tabs: many });
  const listed = (await h.controller.handle(ask("story-tabs"), pageSender())).result.tabs;
  assert.equal(listed.length, SETUP_STORY_TAB_LIMIT);
  assert.deepEqual(listed.map(({ tabId }) => tabId), [106, 100, 101, 102, 103], "the tab in front first, then Safari's own order");
  // A story tab that did not make the list was not given to the page, so it cannot be switched to.
  for (const tabId of [104, 105, 107, 108]) {
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId }), pageSender()), { ok: false, error: "not_listed" });
  }
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 103 }), pageSender()), { ok: true });

  const odd = createHarness({
    tabs: [
      { id: 1, url: `${AO3}/works/1`, title: `  A\ttitle\nover\u2028two lines \u0000 ${"x".repeat(400)}` },
      { id: 2, url: `${AO3}/works/2` },
      { id: 3, url: `${AO3}/works/3`, title: { toString: () => `${AO3}/works/3` } },
      { id: "4", url: `${AO3}/works/4`, title: "A tab with no usable id" },
      { id: 5.5, url: `${AO3}/works/5`, title: "Nor this" },
    ],
  });
  const titles = (await odd.controller.handle(ask("story-tabs"), pageSender())).result.tabs;
  assert.deepEqual(titles.map(({ tabId }) => tabId), [1, 2, 3]);
  assert.equal(titles[0].title.length, SETUP_TAB_TITLE_MAX_LENGTH);
  assert.match(titles[0].title, /^A title over two lines x+$/);
  assert.equal(titles[1].title, "", "a tab with no title has none; its address is not used instead");
  assert.equal(titles[2].title, "");
});

test("story tabs: nothing is listed, or even looked at, while the story sites are not allowed", async () => {
  for (const granted of [[`${WEB}/*`], [`${WEB}/*`, ...STORY_SITE_ORIGINS.slice(0, 4)], []]) {
    const h = createHarness({ granted, tabs: [...STORY_TABS, ...OTHER_TABS] });
    assert.deepEqual(await h.controller.handle(ask("story-tabs"), pageSender()), { ok: true, result: { tabs: [] } });
    assert.deepEqual(h.browserCalls(), [], "the tabs are not read");
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), pageSender()), { ok: false, error: "not_listed" });
  }
  const silent = createHarness({ permissionsSilent: true, tabs: STORY_TABS });
  assert.deepEqual(await silent.controller.handle(ask("story-tabs"), pageSender()), { ok: false, error: "unavailable" });
  const broken = createHarness({ queryFails: true, tabs: STORY_TABS });
  assert.deepEqual(await broken.controller.handle(ask("story-tabs"), pageSender()), { ok: false, error: "unavailable" });
});

test("switch to tab: only a story tab this page was just given, checked again at that moment", async () => {
  const h = createHarness({ tabs: [...OTHER_TABS, ...STORY_TABS] });
  const page = pageSender();

  // Nothing has been listed yet.
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), page), { ok: false, error: "not_listed" });
  await h.controller.handle(ask("story-tabs"), page);

  // A tab that was not in the list: another site's, a list page, or a made-up id.
  for (const tabId of [21, 22, 24, 27, 1, 999]) {
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId }), page), { ok: false, error: "not_listed" }, String(tabId));
  }
  assert.equal(h.calls.some(([name]) => name === "update" || name === "get"), false, "an unlisted tab is not even looked up");

  // A listed tab comes to the front, and that is all that happens to it.
  h.calls.length = 0;
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 12 }), page), { ok: true });
  assert.deepEqual(h.browserCalls(), [["get", 12], ["update", 12, { active: true }]]);
});

test("switch to tab: a listed tab that has since left its story is not switched to", async () => {
  for (const [name, change, error] of [
    ["navigated to another site", (tabs) => tabs.map((tab) => (tab.id === 11 ? { ...tab, url: "https://bank.example/accounts" } : tab)), "not_a_story"],
    ["navigated to a list on the same site", (tabs) => tabs.map((tab) => (tab.id === 11 ? { ...tab, url: `${AO3}/tags/x/works` } : tab)), "not_a_story"],
    ["navigated to the site's sign-in page", (tabs) => tabs.map((tab) => (tab.id === 11 ? { ...tab, url: `${AO3}/users/login` } : tab)), "not_a_story"],
    ["no longer readable", (tabs) => tabs.map((tab) => (tab.id === 11 ? { id: 11, title: tab.title } : tab)), "not_a_story"],
    ["closed", (tabs) => tabs.filter((tab) => tab.id !== 11), "not_a_story"],
  ]) {
    const h = createHarness({ tabs: [...STORY_TABS] });
    await h.controller.handle(ask("story-tabs"), pageSender());
    h.setTabs(change([...STORY_TABS]));
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), pageSender()), { ok: false, error }, name);
    assert.equal(h.calls.some(([call]) => call === "update"), false, `${name}: the tab is left alone`);
  }

  // Access taken away between the list and the tap.
  const lapsed = createHarness({ tabs: [...STORY_TABS] });
  await lapsed.controller.handle(ask("story-tabs"), pageSender());
  lapsed.setGranted([`${WEB}/*`]);
  assert.deepEqual(await lapsed.controller.handle(ask("switch-to-tab", { tabId: 11 }), pageSender()), { ok: false, error: "not_allowed" });
  assert.equal(lapsed.calls.some(([call]) => call === "update" || call === "get"), false);

  const stuck = createHarness({ tabs: [...STORY_TABS], updateFails: true });
  await stuck.controller.handle(ask("story-tabs"), pageSender());
  assert.deepEqual(await stuck.controller.handle(ask("switch-to-tab", { tabId: 11 }), pageSender()), { ok: false, error: "switch_failed" });
});

test("switch to tab: the list belongs to the page that asked, and only its most recent one counts", async () => {
  const h = createHarness({ tabs: [...STORY_TABS] });
  const first = pageSender();
  const second = pageSender({ tab: { id: 2, url: SETUP_URL } });
  await h.controller.handle(ask("story-tabs"), first);

  // A setup page in any other tab, and the popup, have their own lists.
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), second), { ok: false, error: "not_listed" });
  for (const id of [0, 3, 21, 101]) {
    const other = pageSender({ tab: { id, url: SETUP_URL } });
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), other), { ok: false, error: "not_listed" }, `tab ${id}`);
  }
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), popupSender), { ok: false, error: "not_listed" });
  await h.controller.handle(askFromPopup(), popupSender);
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), popupSender), { ok: true });

  // A setup page that has navigated away since it was given its list is no
  // longer the setup page: the same tab, now elsewhere on Trace, is refused.
  h.calls.length = 0;
  for (const elsewhere of [`${WEB}/library`, `${WEB}/safari-setup/x`, `${WEB}/safari-setup-old`, `${WEB}/`]) {
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), at(elsewhere)), { ok: false, error: "forbidden" }, elsewhere);
    assert.deepEqual(await h.controller.handle(ask("story-tabs"), at(elsewhere)), { ok: false, error: "forbidden" }, elsewhere);
  }
  assert.deepEqual(h.calls, [], "and no tab was looked at or touched for it");
  // Having been seen elsewhere, that tab has no list left when it comes back.
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), first), { ok: false, error: "not_listed" });
  assert.deepEqual(h.browserCalls(), []);
  await h.controller.handle(ask("story-tabs"), first);
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), first), { ok: true }, "until it asks again");

  // Another tab seen elsewhere, or a sender with no tab, costs this tab nothing.
  for (const stranger of [
    pageSender({ url: `${WEB}/library`, tab: { id: 2, url: `${WEB}/library` } }),
    pageSender({ url: `${AO3}/works/123`, tab: { id: 11, url: `${AO3}/works/123` } }),
    { id: "another-extension" },
    { id: EXTENSION_ID, url: `${WEB}/library`, frameId: 0 },
    undefined,
  ]) {
    assert.deepEqual(await h.controller.handle(ask("access"), stranger), { ok: false, error: "forbidden" });
  }
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), first), { ok: true });

  // A newer list replaces the older one, even when it is shorter.
  h.setTabs(STORY_TABS.filter((tab) => tab.id !== 13));
  await h.controller.handle(ask("story-tabs"), first);
  h.setTabs([...STORY_TABS]);
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 13 }), first), { ok: false, error: "not_listed" });
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 12 }), first), { ok: true });

  // A list that could not be made leaves nothing behind to switch to.
  h.setGranted([`${WEB}/*`]);
  await h.controller.handle(ask("story-tabs"), first);
  h.setGranted([...STORY_SITE_ORIGINS]);
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 12 }), first), { ok: false, error: "not_listed" });

  // Nor does a list Safari would not answer for: the one before it is gone too.
  assert.equal((await h.controller.handle(ask("story-tabs"), first)).result.tabs.length, 3);
  h.setPermissionsSilent(true);
  assert.deepEqual(await h.controller.handle(ask("story-tabs"), first), { ok: false, error: "unavailable" });
  h.setPermissionsSilent(false);
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 12 }), first), { ok: false, error: "not_listed" });
});

test("switch to tab: a list is good for two minutes", async () => {
  assert.equal(SETUP_STORY_LIST_LIFE_MS, 120_000);
  for (const [sender, list] of [[pageSender(), ask("story-tabs")], [popupSender, askFromPopup()]]) {
    const h = createHarness({ tabs: [...STORY_TABS] });
    await h.controller.handle(list, sender);
    h.advance(SETUP_STORY_LIST_LIFE_MS);
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), sender), { ok: true }, "still good at two minutes");
    h.advance(1);
    h.calls.length = 0;
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), sender), { ok: false, error: "not_listed" });
    assert.deepEqual(h.calls, [], "an old list is not even checked against the tabs");
    // It is gone, not waiting: a clock set back does not bring it back.
    h.advance(-1);
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), sender), { ok: false, error: "not_listed" });
    await h.controller.handle(list, sender);
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), sender), { ok: true }, "a new list starts a new two minutes");

    // A list dated in the future (the clock went back) is not trusted either.
    h.advance(-5_000);
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), sender), { ok: false, error: "not_listed" });
  }
});

// ---- Private Browsing and other windows ----

const WINDOW_TABS = [
  { id: 41, url: `${AO3}/works/1`, title: "Private story [Archive of Our Own]", incognito: true, windowId: 9, lastAccessed: 900 },
  { id: 42, url: `${AO3}/works/2`, title: "Other-window story", windowId: 2, lastAccessed: 800 },
  { id: 43, url: `${FFN}/s/3/1/x`, title: "Grouped story", groupId: 7, windowId: 1, lastAccessed: 700 },
  { id: 44, url: `${AO3}/works/4`, title: "Discarded story", discarded: true, windowId: 1, incognito: false, lastAccessed: 600 },
  { id: 45, url: `${AO3}/works/5`, title: "Private story said to be in this window", incognito: true, windowId: 1, lastAccessed: 950 },
  { id: 46, url: `${AO3}/works/6`, title: "A story whose window is not known", windowId: undefined, lastAccessed: 940 },
  { id: 47, url: `${AO3}/works/7`, title: "A story whose window is not a number", windowId: "1", lastAccessed: 930 },
  { id: 2, url: SETUP_URL, title: "Set up Trace", windowId: 2 },
  { id: 9, url: SETUP_URL, title: "Set up Trace", windowId: 9, incognito: true },
];
const listedIds = (answer) => answer.result.tabs.map(({ tabId }) => tabId);

test("story tabs: only the asking tab's own window, and never Private Browsing", async () => {
  for (const queryIgnoresFilter of [false, true]) {
    const h = createHarness({ tabs: WINDOW_TABS, queryIgnoresFilter });
    const page = pageSender();
    const answer = await h.controller.handle(ask("story-tabs"), page);
    assert.deepEqual(listedIds(answer), [43, 44]);
    assert.doesNotMatch(JSON.stringify(answer), /Private|Other-window|not known|not a number/);
    assert.deepEqual(h.browserCalls(), [storyTabQuery(1)]);
    // The others were not listed, so they cannot be switched to.
    h.calls.length = 0;
    for (const tabId of [41, 42, 45, 46, 47]) {
      assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId }), page), { ok: false, error: "not_listed" }, String(tabId));
    }
    assert.deepEqual(h.calls, []);

    // The setup page in another window sees that window's stories, and only those.
    const elsewhere = pageSender({ tab: { id: 2, url: SETUP_URL, windowId: 2 } });
    assert.deepEqual(listedIds(await h.controller.handle(ask("story-tabs"), elsewhere)), [42]);
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 43 }), elsewhere), { ok: false, error: "not_listed" });
  }
});

test("story tabs: only story-site tabs are asked for, so no other open site is ever touched", async () => {
  const tabs = [
    ...STORY_TABS,
    { id: 21, url: "https://bank.example/accounts/12345", title: "My accounts" },
    { id: 22, url: "https://unrelated.example/", title: "Something else" },
    { id: 27, url: `${WEB}/library`, title: "Library" },
    { id: 60, url: "https://ao3.org/works/60", title: "By the short address", lastAccessed: 50 },
  ];
  // Safari allows the story sites and nothing else.
  const h = createHarness({ tabs, granted: [...STORY_SITE_ORIGINS] });
  assert.deepEqual(listedIds(await h.controller.handle(ask("story-tabs"), pageSender())), [12, 11, 13]);
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 12 }), pageSender()), { ok: true });
  const queries = h.calls.filter(([name]) => name === "query").map(([, filter]) => filter);
  assert.deepEqual(queries, [{ windowId: 1, url: STORY_TAB_PATTERNS }]);
  for (const filter of queries) {
    for (const pattern of filter.url) assert.match(pattern, /archiveofourown|transformativeworks|fanfiction\.net|ao3\.org/, pattern);
  }
  assert.deepEqual(STORY_TAB_PATTERNS, [
    "https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*",
    "https://www.fanfiction.net/*", "https://m.fanfiction.net/*", "https://*.ao3.org/*",
  ]);

  // The filter loses nothing: every story host is covered, AO3's short address included.
  const every = createHarness({ tabs, granted: ["*://*/*"] });
  assert.deepEqual(listedIds(await every.controller.handle(ask("story-tabs"), pageSender())), [12, 11, 13, 60]);
  for (const [url] of ALWAYS_STORY) assert.equal(matchesAny(STORY_TAB_PATTERNS, url), true, url);
});

test("story tabs: a setup page in Private Browsing, or in a window Safari does not name, is given nothing", async () => {
  for (const [name, tab] of Object.entries({
    "a private tab": { id: 9, url: SETUP_URL, windowId: 9, incognito: true },
    "a private tab said to be in the ordinary window": { id: 9, url: SETUP_URL, windowId: 1, incognito: true },
    "a tab with no window": { id: 1, url: SETUP_URL, windowId: undefined },
    "a tab whose window is not a number": { id: 1, url: SETUP_URL, windowId: "1" },
    "a tab whose window is not a whole number": { id: 1, url: SETUP_URL, windowId: 1.5 },
  })) {
    const h = createHarness({ tabs: WINDOW_TABS, queryIgnoresFilter: true });
    const page = pageSender({ tab });
    assert.deepEqual(await h.controller.handle(ask("story-tabs"), page), { ok: true, result: { tabs: [] } }, name);
    assert.deepEqual(h.browserCalls(), [], `${name}: no tab is looked at`);
    for (const tabId of [41, 43, 45]) {
      assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId }), page), { ok: false, error: "not_listed" }, name);
    }
    // It can still learn whether the story sites are allowed.
    assert.equal((await h.controller.handle(ask("access"), page)).ok, true, name);
  }
});

test("switch to tab: a listed tab that has since gone private or to another window is left alone", async () => {
  for (const [name, change] of Object.entries({
    "now in Private Browsing": { incognito: true },
    "now in another window": { windowId: 2 },
    "now in a private window": { windowId: 9, incognito: true },
    "its window no longer known": { windowId: undefined },
  })) {
    const h = createHarness({ tabs: WINDOW_TABS });
    await h.controller.handle(ask("story-tabs"), pageSender());
    h.setTabs(WINDOW_TABS.map((tab) => (tab.id === 43 ? { ...tab, ...change } : tab)));
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 43 }), pageSender()), { ok: false, error: "not_a_story" }, name);
    assert.equal(h.calls.some(([call]) => call === "update"), false, `${name}: the tab is left alone`);
  }

  // The asking tab itself has moved: its list was for the window it was in.
  for (const [name, tab] of Object.entries({
    "to another window": { id: 1, url: SETUP_URL, windowId: 2 },
    "to Private Browsing": { id: 1, url: SETUP_URL, windowId: 1, incognito: true },
    "to a window Safari does not name": { id: 1, url: SETUP_URL, windowId: undefined },
  })) {
    const h = createHarness({ tabs: WINDOW_TABS });
    await h.controller.handle(ask("story-tabs"), pageSender());
    h.calls.length = 0;
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 43 }), pageSender({ tab })), { ok: false, error: "not_listed" }, name);
    assert.deepEqual(h.calls, [], name);
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 43 }), pageSender()), { ok: false, error: "not_listed" }, `${name}: and the list is gone`);
  }
});

test("the popup's rows follow the same rule, from the tab it is open over", async () => {
  const h = createHarness({ tabs: [...WINDOW_TABS, { id: 27, url: `${WEB}/library`, windowId: 1 }], queryIgnoresFilter: true });
  assert.deepEqual(listedIds(await h.controller.handle(askFromPopup(1), popupSender)), [43, 44]);
  assert.deepEqual(h.browserCalls(), [["get", 1], storyTabQuery(1)]);
  assert.deepEqual(listedIds(await h.controller.handle(askFromPopup(2), popupSender)), [42]);

  // Open over anything but an ordinary setup page, it is given nothing, and no window is read.
  for (const [name, overTab] of Object.entries({
    "the setup page in Private Browsing": 9,
    "a story": 43,
    "another Trace page": 27,
    "a private story": 41,
    "a tab that is not there": 999,
  })) {
    h.calls.length = 0;
    assert.deepEqual(await h.controller.handle(askFromPopup(overTab), popupSender), { ok: true, result: { tabs: [] } }, name);
    assert.deepEqual(h.browserCalls(), [["get", overTab]], name);
    assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 43 }), popupSender), { ok: false, error: "not_listed" }, name);
  }

  // A listed tab that has gone private by the time of the tap is left alone.
  await h.controller.handle(askFromPopup(1), popupSender);
  h.setTabs(WINDOW_TABS.map((tab) => (tab.id === 43 ? { ...tab, incognito: true } : tab)));
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 43 }), popupSender), { ok: false, error: "not_a_story" });
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 44 }), popupSender), { ok: true });
});

// ---- titles ----

test("story tabs: a title that is an address, or shaped like one, is sent as no title", async () => {
  const story = `${AO3}/works/123/chapters/456?view_adult=true#workskin`;
  const titleFor = async (title, url = story) => {
    const h = createHarness({ tabs: [{ id: 50, url, title }] });
    return (await h.controller.handle(ask("story-tabs"), pageSender())).result.tabs[0].title;
  };
  for (const title of [
    story, ` ${story} `, story.toUpperCase(), `${AO3}/works/123`, "https://archiveofourown.org", "http://archiveofourown.org/works/123",
    "https://archiveofourown.org/works/123?secret=1", "https://bank.example/accounts/12345", "https://archiveofourown.org/works/1 2 3",
    "archiveofourown.org", "archiveofourown.org/works/123", "www.archiveofourown.org/works/123/chapters/456", "ARCHIVEOFOUROWN.ORG/works/123",
    "archiveofourown.org:443/works/123", "download.archiveofourown.org/x", "www.fanfiction.net/s/4821/2/", "m.fanfiction.net",
    "javascript:alert(1)", "data:text/html,<b>x</b>", "about:blank", "blob:https://archiveofourown.org/1", "file:///works/123",
    "safari-web-extension://trace/popup.html", "view-source:https://archiveofourown.org/works/123",
    "​https://archiveofourown.org/works/123", "https://archiveofourown.org/‮works/123", "archiveofourown.org​/works/123",
  ]) {
    assert.equal(await titleFor(title), "", JSON.stringify(title));
  }
  assert.equal(await titleFor("m.fanfiction.net/s/4821/2/", "https://m.fanfiction.net/s/4821/2/"), "");

  // A longer title with the tab's own host and path in it, as a loading tab shows.
  for (const [title, url] of [
    ["Loading https://archiveofourown.org/works/123/chapters/456", story],
    ["archiveofourown.org/works/123/chapters/456 - Loading", story],
    ["Loading archiveofourown.org/works/123/chapters/456…", story],
    ["Loading ARCHIVEOFOUROWN.ORG/Works/123/chapters/456", story],
    ["Opening archiveofourown.org/works/123/chapters/456?view_adult=true", story],
    ["Loading archiveofourown.org/works/9", "https://www.archiveofourown.org/works/9/"],
    ["Loading www.archiveofourown.org/works/9", "https://www.archiveofourown.org/works/9"],
    ["fanfiction.net/s/4821/2/The-Other-Road is loading", "https://m.fanfiction.net/s/4821/2/The-Other-Road"],
    ["Loading m.fanfiction.net/s/4821/2/The-Other-Road", "https://m.fanfiction.net/s/4821/2/The-Other-Road"],
    ["Loading fanfiction.net/s/4821", "https://www.fanfiction.net/s/4821"],
  ]) {
    assert.equal(await titleFor(title, url), "", title);
  }
  // The site's name in a title's usual ending, or a path with no host, is not the tab's address.
  for (const [title, url] of [
    ["The Long Way Round - Chapter 3 - quillfeather [Archive of Our Own]", story],
    ["The Other Road Chapter 2, a fanfic | FanFiction", "https://www.fanfiction.net/s/4821/2/The-Other-Road"],
    ["The Other Road Chapter 2, a fanfic | FanFiction.net", "https://m.fanfiction.net/s/4821/2/The-Other-Road"],
    ["archiveofourown.org is down again - Chapter 1", story],
    ["A story about /works/123/chapters/456", story],
    ["Works 123 chapters 456 [archiveofourown.org]", story],
  ]) {
    assert.equal(await titleFor(title, url), title, title);
  }

  // Ordinary titles are left as they are, colons, dots and slashes included.
  for (const title of [
    "The Long Way Round - Chapter 3 - quillfeather [Archive of Our Own]",
    "Re:Zero - Chapter 1 - someone [Archive of Our Own]",
    "Fate: Stay the Night Chapter 2, a fanfic | FanFiction",
    "archiveofourown.org is down again - Chapter 1",
    "Why https://example.com is not a title",
    "Untitled", "Chapter1", "12.5", "and/or", "a.b", "Draft v1.2", "Q&A", "100%", "[Archive of Our Own]",
  ]) {
    assert.equal(await titleFor(title), title, title);
  }
});

test("story tabs: characters that hide or reorder text are taken out of titles", async () => {
  const titleFor = async (title) => {
    const h = createHarness({ tabs: [{ id: 50, url: `${AO3}/works/123`, title }] });
    return (await h.controller.handle(ask("story-tabs"), pageSender())).result.tabs[0].title;
  };
  for (const [given, sent] of [
    ["a‮b reversed", "ab reversed"],
    ["‪one‫ two‬ ‭three‮", "one two three"],
    ["⁦iso⁧lat⁨es⁩", "isolates"],
    ["left‎right‏mark؜", "leftrightmark"],
    ["zero​width​space⁠joiner﻿", "zerowidthspacejoiner"],
    ["in⁡vis⁢ib⁣le⁤", "invisible"],
    ["​​", ""],
    ["‎ ‏", ""],
    ["c1\u0085control\u009f", "c1 control"],
    ["line one\nline two\ttab sep arated", "line one line two tab sep arated"],
  ]) {
    assert.equal(await titleFor(given), sent, JSON.stringify(given));
  }
  // The zero-width joiner and non-joiner stay: emoji are built with the first, and
  // Persian and Indic spelling needs both. So do accents and other scripts.
  for (const title of [
    "می‌خواهم خانه‌ها - Chapter 1 [Archive of Our Own]",
    "क्‌ष and क्‍ष","family \u{1f468}‍\u{1f469}‍\u{1f467} time", "\u{1f3f3}️‍\u{1f308} flag", "café über naïve", "物語 مرحبا שלום"]) {
    assert.equal(await titleFor(title), title, JSON.stringify(title));
  }
  // The cap counts what is left, in whole characters.
  assert.equal(Array.from(await titleFor("‮" + "\u{1f600}".repeat(200))).length, SETUP_TAB_TITLE_MAX_LENGTH);
  assert.equal(await titleFor("​".repeat(500) + "kept"), "kept");
});

test("a flood of requests is refused without reaching the browser", async () => {
  const h = createHarness({ tabs: [...STORY_TABS] });
  const page = pageSender();
  assert.equal(SETUP_REQUEST_LIMIT, 20);
  assert.equal(SETUP_REQUEST_WINDOW_MS, 10_000);
  for (let request = 0; request < SETUP_REQUEST_LIMIT; request += 1) {
    assert.equal((await h.controller.handle(ask("access"), page)).ok, true);
  }
  h.calls.length = 0;
  for (const message of [ask("access"), ask("story-tabs"), ask("switch-to-tab", { tabId: 11 }), ask("nonsense")]) {
    for (let again = 0; again < 50; again += 1) {
      assert.deepEqual(await h.controller.handle(message, page), { ok: false, error: "rate_limited" });
    }
  }
  assert.deepEqual(h.calls, [], "two hundred more requests cost the browser nothing");

  // Another page, and the popup, are counted on their own.
  assert.equal((await h.controller.handle(ask("access"), pageSender({ tab: { id: 2, url: SETUP_URL } }))).ok, true);
  assert.equal((await h.controller.handle(ask("access"), popupSender)).ok, true);

  // The limit is a window, not a ban.
  h.advance(SETUP_REQUEST_WINDOW_MS - 1);
  assert.deepEqual(await h.controller.handle(ask("access"), page), { ok: false, error: "rate_limited" });
  h.advance(1);
  assert.equal((await h.controller.handle(ask("access"), page)).ok, true);

  // Refused senders are not counted against anyone, and cost nothing either.
  const quiet = createHarness({ tabs: [...STORY_TABS] });
  for (let request = 0; request < 500; request += 1) {
    await quiet.controller.handle(ask("story-tabs"), pageSender({ url: `${AO3}/works/1`, tab: { id: 1, url: `${AO3}/works/1` } }));
  }
  assert.deepEqual(quiet.calls, []);
  assert.equal((await quiet.controller.handle(ask("access"), pageSender())).ok, true);
});

async function settled() {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("when access changes, every open setup page is told, and no other tab", async () => {
  const h = createHarness({ install: true, granted: [`${WEB}/*`], tabs: [...OTHER_TABS, ...STORY_TABS] });
  assert.equal(h.added.length, 1);
  assert.equal(h.removed.length, 1);
  await settled();
  assert.deepEqual(h.sent, [], "nothing is pushed until something changes");

  // The reader allows the story sites.
  h.setGranted([...STORY_SITE_ORIGINS, `${WEB}/*`]);
  h.added[0]();
  await settled();
  assert.deepEqual(h.sent, [
    { tabId: 1, message: { type: SETUP_ACCESS_PUSH_MESSAGE, storySitesAllowed: true, scope: "story-sites" } },
    { tabId: 31, message: { type: SETUP_ACCESS_PUSH_MESSAGE, storySitesAllowed: true, scope: "story-sites" } },
  ]);
  assert.deepEqual(h.calls.filter(([name]) => name === "query"), [["query", { url: [`${WEB}/safari-setup*`] }]],
    "only tabs at the setup page's address are asked for");

  // Access ends.
  h.sent.length = 0;
  h.setGranted([`${WEB}/*`]);
  h.removed[0]();
  await settled();
  assert.deepEqual(h.sent.map(({ tabId, message }) => [tabId, message.storySitesAllowed, message.scope]), [
    [1, false, "this-site"],
    [31, false, "this-site"],
  ]);

  // A burst of changes is one look and one message per page, plus one more for whatever came last.
  h.sent.length = 0;
  h.setGranted(["*://*/*"]);
  for (let event = 0; event < 10; event += 1) h.added[0]();
  await settled();
  assert.ok(h.sent.length <= 4, `a burst of ten is at most two rounds, not ten (${h.sent.length})`);
  assert.deepEqual(h.sent.at(-1).message, { type: SETUP_ACCESS_PUSH_MESSAGE, storySitesAllowed: true, scope: "all" });
  assert.equal(h.calls.some(([name]) => name === "update" || name === "get" || name === "create"), false);

  // Should the browser hand back more tabs than were asked for, still only setup pages are told:
  // not the Trace app, not a path that merely starts the same, not a story.
  const loose = createHarness({ install: true, queryIgnoresFilter: true, tabs: [...OTHER_TABS, ...STORY_TABS] });
  loose.added[0]();
  await settled();
  assert.deepEqual(loose.sent.map(({ tabId }) => tabId), [1, 31]);
});

test("without access to Trace's own site, a change in access touches nothing of Trace's", async () => {
  const setupTabs = [...OTHER_TABS, ...STORY_TABS];
  const namesTrace = (h) => JSON.stringify([h.browserCalls(), h.sent]).includes("tracefiction");
  for (const [name, granted] of Object.entries({
    "one story site only, from Safari's menu": ["https://*.archiveofourown.org/*"],
    "that site by its own address": ["https://archiveofourown.org/*"],
    "all five story sites": [...STORY_SITE_ORIGINS],
    "another Trace host": [...STORY_SITE_ORIGINS, "https://app.tracefiction.com/*"],
    "Trace's site over plain http": [...STORY_SITE_ORIGINS, "http://www.tracefiction.com/*"],
    "nothing at all": [],
  })) {
    const h = createHarness({ install: true, granted: [], tabs: setupTabs });
    h.setGranted(granted);
    h.added[0]();
    h.removed[0]();
    for (let event = 0; event < 5; event += 1) h.added[0]();
    await settled();
    assert.deepEqual(h.browserCalls(), [], `${name}: no tab is looked for, by address or at all`);
    assert.deepEqual(h.sent, [], `${name}: and none is messaged`);
    assert.equal(namesTrace(h), false, name);
  }

  // Not knowing is not holding: Safari gives no answer about Trace's site.
  for (const traceAccessUnknown of [true, "silent"]) {
    const h = createHarness({ install: true, traceAccessUnknown, tabs: setupTabs });
    h.added[0]();
    await settled();
    assert.deepEqual([h.browserCalls(), h.sent], [[], []], String(traceAccessUnknown));
  }

  // With Trace's site allowed, the same partial grant is told to the open setup pages.
  const h = createHarness({ install: true, granted: [`${WEB}/*`], tabs: setupTabs });
  h.setGranted(["https://*.archiveofourown.org/*", `${WEB}/*`]);
  h.added[0]();
  await settled();
  assert.deepEqual(h.sent.map(({ tabId, message }) => [tabId, message.storySitesAllowed, message.scope]), [
    [1, false, "this-site"],
    [31, false, "this-site"],
  ]);
  assert.deepEqual(h.browserCalls(), [["query", { url: [`${WEB}/safari-setup*`] }]]);

  // Access to Trace's site is asked about first, before any tab is named.
  const order = h.calls.map(([call]) => call);
  assert.equal(order[0], "contains");
  assert.ok(order.indexOf("contains") < order.indexOf("query"));
});

test("a change Safari will not describe is not pushed", async () => {
  const h = createHarness({ install: true, permissionsSilent: true, tabs: [...OTHER_TABS] });
  h.added[0]();
  h.removed[0]();
  await settled();
  assert.deepEqual(h.sent, []);
});

test("the installed listener answers its own message and leaves every other one alone", async () => {
  const h = createHarness({ install: true, tabs: [...STORY_TABS] });
  const deliver = (message, sender) => new Promise((resolve) => {
    let kept = false;
    for (const listener of h.listeners) kept = listener(message, sender, resolve) === true || kept;
    if (!kept) setImmediate(() => resolve("not handled"));
  });
  assert.equal(await deliver({ type: "TRACE_ARCHIVE_SEEN" }, pageSender()), "not handled");
  assert.equal(await deliver({ type: "TRACE_SESSION_GET_SNAPSHOT" }, popupSender), "not handled");
  assert.deepEqual(await deliver(ask("access"), pageSender()), { ok: true, result: { storySitesAllowed: true, scope: "story-sites" } });
  assert.deepEqual(await deliver(ask("access"), pageSender({ url: `${AO3}/works/1`, tab: { id: 9, url: `${AO3}/works/1` } })), { ok: false, error: "forbidden" });
});

test("the page script, the popup and the background name the setup page's path the same way", () => {
  const matcher = String.raw`/^\/safari-setup\/?$/`;
  for (const file of [
    "../../Shared (Extension)/Resources/sync.js",
    "../../Shared (Extension)/Resources/popup.js",
    "../../src/extension-runtime/setup-page.mts",
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.split(matcher).length - 1, 1, file);
  }
});

// ---- where it runs ----

const deliverTo = (h) => (message, sender) => new Promise((resolve) => {
  let kept = false;
  for (const listener of h.listeners) kept = listener(message, sender, resolve) === true || kept;
  if (!kept) setImmediate(() => resolve("not handled"));
});

test("platform: where Trace is known not to be beside its app, nothing is installed at all", async () => {
  for (const [name, options] of Object.entries({
    "a browser without the app's channel (Chrome, Firefox)": { withoutNativeMessaging: true },
    "a browser without it that looks like an iPhone": { withoutNativeMessaging: true, userAgent: IPHONE_UA },
    "a browser without it that would answer ios": { withoutNativeMessaging: true, userAgent: MAC_UA, os: "ios" },
    "Windows": { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", os: "ios" },
    "Android": { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0", os: "ios" },
    "a Mac that cannot be asked what it is": { userAgent: MAC_UA },
    "no user agent": { userAgent: "", os: "ios" },
  })) {
    const h = createHarness({ install: true, tabs: [...STORY_TABS, ...OTHER_TABS], ...options });
    assert.equal(h.controller, null, name);
    assert.deepEqual([h.listeners.length, h.added.length, h.removed.length], [0, 0, 0], name);
    assert.equal(await deliverTo(h)(ask("access"), pageSender()), "not handled", name);
    assert.deepEqual([h.calls, h.sent, h.platformAsked], [[], [], []], name);
  }
});

test("platform: Safari on a Mac registers at once, then does nothing", async () => {
  for (const os of ["mac", "unreadable", "linux", "IOS", ""]) {
    const h = createHarness({ install: true, userAgent: MAC_UA, os, granted: ["*://*/*"], tabs: [...STORY_TABS, ...OTHER_TABS] });
    assert.deepEqual([h.listeners.length, h.added.length, h.removed.length], [1, 1, 1], "registered in the first turn");
    for (const [message, sender] of [
      [ask("access"), pageSender()],
      [ask("story-tabs"), pageSender()],
      [ask("switch-to-tab", { tabId: 11 }), pageSender()],
      [askFromPopup(), popupSender],
      [ask("access"), at(`${AO3}/works/1`)],
    ]) {
      assert.deepEqual(await deliverTo(h)(message, sender), { ok: false, error: "unavailable" }, `${os}: ${message.request}`);
    }
    assert.equal(await deliverTo(h)({ type: "TRACE_ARCHIVE_SEEN" }, pageSender()), "not handled");
    h.added[0]();
    h.removed[0]();
    await settled();
    assert.deepEqual(h.calls, [], `${os}: access was not read and no tab was looked at`);
    assert.deepEqual(h.sent, [], `${os}: and nothing was pushed`);
    assert.equal(h.platformAsked.length, 1, "the platform is asked once");
  }
});

test("platform: an iPad that calls itself a Mac is served, and an early event is not lost", async () => {
  let answerPlatform;
  const platformAnswer = new Promise((resolve) => { answerPlatform = resolve; });
  const h = createHarness({
    install: true, userAgent: MAC_UA, os: "ios", platformAnswer,
    granted: [`${WEB}/*`], tabs: [...STORY_TABS, ...OTHER_TABS],
  });
  assert.deepEqual([h.listeners.length, h.added.length, h.removed.length], [1, 1, 1], "registered before the platform is known");

  // A request and a permission change arrive before Safari has said what this is.
  const early = deliverTo(h)(ask("access"), pageSender());
  h.setGranted([...STORY_SITE_ORIGINS, `${WEB}/*`]);
  h.added[0]();
  await settled();
  assert.deepEqual([h.calls, h.sent], [[], []], "nothing is done until it is known");

  answerPlatform({ os: "ios" });
  assert.deepEqual(await early, { ok: true, result: { storySitesAllowed: true, scope: "story-sites" } });
  await settled();
  assert.deepEqual(h.sent.map(({ tabId, message }) => [tabId, message.scope]), [[1, "story-sites"], [31, "story-sites"]]);
  assert.equal((await deliverTo(h)(ask("story-tabs"), pageSender())).result.tabs.length, 3);
  assert.equal(h.platformAsked.length, 1);

  // An iPhone, and an iPad that says so, are served without asking.
  for (const userAgent of [IPHONE_UA, IPHONE_UA.replace("iPhone;", "iPad;")]) {
    const named = createHarness({ install: true, userAgent, os: "mac", tabs: [...STORY_TABS] });
    assert.equal((await deliverTo(named)(ask("access"), pageSender())).ok, true);
    assert.deepEqual(named.platformAsked, []);
  }
});

// ---- which addresses count as a story page ----

// Rows whose answer does not depend on anything but today's rules.
const ALWAYS_STORY = [
  [`${AO3}/works/123`, "ao3"],
  [`${AO3}/works/123/`, "ao3"],
  [`${AO3}/works/123/chapters/456`, "ao3"],
  [`${AO3}/works/123?view_adult=true#workskin`, "ao3"],
  ["https://www.archiveofourown.org/works/9", "ao3"],
  ["https://archiveofourown.gay/works/9", "ao3"],
  ["https://archive.transformativeworks.org/works/9", "ao3"],
  [`${FFN}/s/4821`, "ffn"],
  [`${FFN}/s/4821/2/The-Other-Road`, "ffn"],
  ["https://m.fanfiction.net/s/4821/2/", "ffn"],
];
const NEVER_STORY = [
  `${AO3}/`, `${AO3}/works`, `${AO3}/works/search`, `${AO3}/works/search?work_search%5Bquery%5D=%2Fworks%2F999`,
  `${AO3}/tags/Some%20Tag/works`, `${AO3}/tags/Some%20Tag/works?page=2#/works/999`, `${AO3}/tags/x/works/999`,
  `${AO3}/users/someone/works`, `${AO3}/users/someone/works/999`, `${AO3}/users/someone/pseuds/someone/works`,
  `${AO3}/collections/some_collection`, `${AO3}/collections/some_collection/works`, `${AO3}/collections/some_collection/works/new`,
  `${AO3}/collections/some_collection/bookmarks`, `${AO3}/collections/a/tags/x/works`, `${AO3}/collections/a/tags/x/works/999`,
  `${AO3}/collections/a/b/works/999`, `${AO3}/collections/a%2Fworks%2F999/works/123`, `${AO3}/collections/a.b/works/123`,
  `${AO3}/series/123`, `${AO3}/works/123/bookmarks`, `${AO3}/works/123/comments`, `${AO3}/works/123/navigate`,
  `${AO3}/collections/some_collection/works/123/bookmarks`, `${AO3}/works/0123x`, `${AO3}/works/12a`,
  // Called a story page by one of the two rules and not the other: both must agree.
  `${AO3}/works/0123`, `${AO3}/works/0123/chapters/1`, `${AO3}/works/123456789012345678901`,
  `${AO3}/users/login`, `${AO3}/users/login?return_to=/works/123`, `${AO3}/users/password/new`,
  `${FFN}/`, `${FFN}/book/Some-Fandom/`, `${FFN}/u/123/someone`, `${FFN}/login.php`, `${FFN}/collections/a/works/123`, `${FFN}/works/123`,
  "http://archiveofourown.org/works/123", "https://archiveofourown.org.example.com/works/123", "https://example.com/works/123",
  "https://example.com/s/4821/1/", `${WEB}/safari-setup`, `${WEB}/works/123`, `${WEB}/s/4821`, "about:blank", "", "not an address",
  "safari-web-extension://trace/popup.html", "file:///works/123", "javascript:alert(1)//works/123",
];

test("the story-page test: the fixed table", () => {
  for (const [url, site] of ALWAYS_STORY) assert.equal(storyPageSite(url, WEB), site, url);
  for (const url of NEVER_STORY) assert.equal(storyPageSite(url, WEB), null, url);
  for (const notAnAddress of [undefined, null, 7, {}, [], true]) assert.equal(storyPageSite(notAnAddress, WEB), null);
});

/** A small deterministic generator, so a failure can be run again. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("fuzz: whatever the open tabs are, only story pages are ever listed, and never an address", async () => {
  const random = seeded(20261010);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const hosts = [
    "archiveofourown.org", "www.archiveofourown.org", "archiveofourown.gay", "archive.transformativeworks.org",
    "www.fanfiction.net", "m.fanfiction.net", "www.tracefiction.com", "example.com", "bank.example",
    "archiveofourown.org.example.com", "fanfiction.net.example.com", "xarchiveofourown.org",
  ];
  const segments = [
    "works", "collections", "tags", "users", "series", "chapters", "bookmarks", "comments", "search", "s", "u", "book",
    "login", "some_collection", "Some%20Tag", "someone", "a%2Fb", "..", ".", "", "123", "456", "0123", "12a", "999",
    "1", "works%2F999", "%2e%2e", "navigate", "new", "pseuds", "A-Story",
  ];
  const suffixes = ["", "/", "?view_adult=true", "#/works/999", "?next=/works/999", "?a=/collections/x/works/999#/s/1"];
  const ids = ["1", "123", "456", "987654321", "0123", "12a", ""];
  const shapes = [
    () => `works/${pick(ids)}`,
    () => `works/${pick(ids)}/chapters/${pick(ids)}`,
    () => `works/${pick(ids)}/${pick(["bookmarks", "comments", "navigate", "chapters"])}`,
    () => `collections/${pick(["some_collection", "a%2Fb", "a.b", "a/b"])}/works/${pick(ids)}`,
    () => `collections/${pick(["some_collection", "x"])}/works/${pick(ids)}/chapters/${pick(ids)}`,
    () => `${pick(["tags", "users", "collections"])}/${pick(["Some%20Tag", "someone", "x"])}/works${pick(["", "/999"])}`,
    () => `s/${pick(ids)}`,
    () => `s/${pick(ids)}/${pick(["1", "2", "x"])}/A-Story`,
    () => `${pick(["users/login", "login.php", "series/123", "u/123/someone", "works/search"])}`,
  ];
  const address = () => {
    const scheme = random() < 0.92 ? "https" : pick(["http", "ftp"]);
    // Half are near a real shape, so story pages and their near misses both
    // turn up; half are arbitrary segments.
    const pathname = random() < 0.5
      ? pick(shapes)()
      : Array.from({ length: Math.floor(random() * 7) }, () => pick(segments)).join("/");
    return `${scheme}://${pick(hosts)}/${pathname}${pick(suffixes)}`;
  };

  let listedTotal = 0;
  let consideredTotal = 0;
  for (let round = 0; round < 400; round += 1) {
    const tabs = Array.from({ length: 12 }, (_, index) => {
      const url = address();
      return {
        id: index + 1,
        url,
        // Some tabs have no title yet, and Safari shows their address instead.
        title: random() < 0.15 ? url : `tab ${index + 1}`,
        lastAccessed: Math.floor(random() * 1000),
        // Most are in the asking tab's window; some are elsewhere, private, or do not say.
        windowId: pick([1, 1, 1, 1, 2, undefined]),
        ...(random() < 0.15 ? { incognito: true } : random() < 0.2 ? { incognito: false } : {}),
      };
    });
    const h = createHarness({ tabs, queryIgnoresFilter: round % 2 === 1 });
    const answer = await h.controller.handle(ask("story-tabs"), pageSender());
    assert.equal(answer.ok, true);
    const listed = answer.result.tabs;
    assert.ok(listed.length <= SETUP_STORY_TAB_LIMIT);
    assert.doesNotMatch(JSON.stringify(answer), /:\/\//, "an answer never carries an address");
    consideredTotal += tabs.length;
    listedTotal += listed.length;

    const eligible = tabs.filter((tab) => {
      // Stated on its own, not through the function under test: in the asking
      // tab's window and not private; a story host, a work key, and a
      // story-page classification, for the same site.
      if (tab.windowId !== 1 || tab.incognito === true) return false;
      let host;
      try { host = new URL(tab.url); } catch { return false; }
      if (host.protocol !== "https:") return false;
      const ao3 = ["archiveofourown.org", "www.archiveofourown.org", "archiveofourown.gay", "archive.transformativeworks.org"].includes(host.hostname);
      const ffn = ["www.fanfiction.net", "m.fanfiction.net"].includes(host.hostname);
      if (!ao3 && !ffn) return false;
      return workKeyFromArchiveUrl(tab.url, ao3 ? "ao3" : "ffn") !== null &&
        classifyActiveTabUrl(tab.url, WEB).kind === "supported_story";
    });
    const eligibleIds = new Set(eligible.map(({ id }) => id));
    for (const { tabId, site } of listed) {
      assert.ok(eligibleIds.has(tabId), `listed a tab that is not a story page: ${tabs.find((tab) => tab.id === tabId).url}`);
      const url = new URL(tabs.find((tab) => tab.id === tabId).url);
      assert.equal(site, url.hostname.includes("fanfiction") ? "ffn" : "ao3");
    }
    assert.equal(listed.length, Math.min(eligible.length, SETUP_STORY_TAB_LIMIT), "and it lists every story page there is room for");

    // Switching follows the same rule: any tab it did not list is refused.
    for (const tab of tabs) {
      if (listed.some(({ tabId }) => tabId === tab.id)) continue;
      assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: tab.id }), pageSender({ tab: { id: 50 + (round % 5), url: SETUP_URL } })), { ok: false, error: "not_listed" });
    }
    assert.equal(h.calls.some(([name]) => name === "update"), false);
  }
  assert.ok(consideredTotal === 4800 && listedTotal > 60, `the fuzz reached story pages (${listedTotal} listed of ${consideredTotal})`);
});
