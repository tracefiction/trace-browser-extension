import assert from "node:assert/strict";
import test from "node:test";

import {
  SETUP_ACCESS_PUSH_MESSAGE,
  SETUP_PAGE_MESSAGE,
  SETUP_REQUEST_LIMIT,
  SETUP_REQUEST_WINDOW_MS,
  SETUP_STORY_TAB_LIMIT,
  SETUP_TAB_TITLE_MAX_LENGTH,
  STORY_SITE_ORIGINS,
  SetupPageController,
  installSetupPageRuntime,
  storyPageSite,
} from "../../.trace-build/extension-runtime/setup-page.mjs";
import { workKeyFromArchiveUrl } from "../../.trace-build/extension-runtime/archive-sender.mjs";
import { classifyActiveTabUrl } from "../../.trace-build/extension-runtime/first-story-initiation.mjs";

const WEB = "https://www.tracefiction.com";
const SETUP_URL = `${WEB}/safari-setup`;
const EXTENSION_ID = "trace-extension";
const AO3 = "https://archiveofourown.org";
const FFN = "https://www.fanfiction.net";

const pageSender = (overrides = {}) => ({
  id: EXTENSION_ID,
  url: SETUP_URL,
  tab: { id: 1, url: SETUP_URL },
  frameId: 0,
  documentLifecycle: "active",
  ...overrides,
});
const popupSender = { id: EXTENSION_ID, url: "safari-web-extension://trace/popup.html" };

const ask = (request, extra = {}) => ({ type: SETUP_PAGE_MESSAGE, request, ...extra });

/**
 * The background's view of the browser. `granted` is what Safari allows;
 * `tabs` is every open tab, as the tabs API would return it.
 */
function createHarness(options = {}) {
  let now = 1_000_000;
  let granted = options.granted ?? [...STORY_SITE_ORIGINS, `${WEB}/*`];
  let tabs = options.tabs ?? [];
  let silent = options.permissionsSilent === true;
  const calls = [];
  const sent = [];
  const added = [];
  const removed = [];
  const listeners = [];
  const runtime = {
    id: EXTENSION_ID,
    onMessage: { addListener: (listener) => listeners.push(listener) },
  };
  const tabsApi = {
    async query(filter) {
      calls.push(["query", filter]);
      if (options.queryFails) throw new Error("tabs unavailable");
      const patterns = filter?.url;
      if (!patterns || options.queryIgnoresFilter) return tabs.map((tab) => ({ ...tab }));
      return tabs.filter((tab) => typeof tab.url === "string" && tab.url.startsWith(`${WEB}/`)).map((tab) => ({ ...tab }));
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
  };
  const controller = options.install ? installSetupPageRuntime(environment) : new SetupPageController(environment);
  return {
    controller, calls, sent, added, removed, listeners,
    browserCalls: () => calls.filter(([name]) => name !== "contains" && name !== "getAll"),
    setGranted(value) { granted = value; },
    setTabs(value) { tabs = value; },
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

test("only a top-level page on Trace's own origin, or the popup, is answered", async () => {
  const refusedSenders = {
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
    "no sender at all": undefined,
  };
  for (const [name, sender] of Object.entries(refusedSenders)) {
    const h = createHarness({ tabs: [...STORY_TABS, ...OTHER_TABS] });
    for (const message of [ask("access"), ask("story-tabs"), ask("switch-to-tab", { tabId: 11 })]) {
      assert.deepEqual(await h.controller.handle(message, sender), { ok: false, error: "forbidden" }, `${name}: ${message.request}`);
    }
    assert.deepEqual(h.calls, [], `${name}: nothing was read on its behalf`);
  }
  // The same questions from Trace's own page and from the popup are answered.
  const h = createHarness({ tabs: [...STORY_TABS, ...OTHER_TABS] });
  for (const sender of [pageSender(), pageSender({ url: `${WEB}/library`, tab: { id: 2, url: `${WEB}/library` } }), popupSender]) {
    assert.equal((await h.controller.handle(ask("story-tabs"), sender)).ok, true);
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
  assert.deepEqual(h.browserCalls(), [["query", {}]], "one look at the open tabs; nothing is changed");
});

test("story tabs: at most five, titles kept to one capped line, order settled without a last-used time", async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    id: 100 + index, url: `${AO3}/works/${index + 1}`, title: `Story ${index + 1}`, active: index === 6,
  }));
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

  // Another Trace page, and the popup, have their own lists.
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), second), { ok: false, error: "not_listed" });
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), popupSender), { ok: false, error: "not_listed" });
  await h.controller.handle(ask("story-tabs"), popupSender);
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), popupSender), { ok: true });

  // The same tab showing a different Trace page starts again.
  const moved = pageSender({ url: `${WEB}/library`, tab: { id: 1, url: `${WEB}/library` } });
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), moved), { ok: false, error: "not_listed" });
  assert.deepEqual(await h.controller.handle(ask("switch-to-tab", { tabId: 11 }), first), { ok: true }, "the page that asked still can");

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

test("when access changes, every open Trace page is told, and no other tab", async () => {
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
    { tabId: 27, message: { type: SETUP_ACCESS_PUSH_MESSAGE, storySitesAllowed: true, scope: "story-sites" } },
  ]);

  // Access ends.
  h.sent.length = 0;
  h.setGranted([`${WEB}/*`]);
  h.removed[0]();
  await settled();
  assert.deepEqual(h.sent.map(({ tabId, message }) => [tabId, message.storySitesAllowed, message.scope]), [
    [1, false, "this-site"],
    [27, false, "this-site"],
  ]);

  // A burst of changes is one look and one message per page, plus one more for whatever came last.
  h.sent.length = 0;
  h.setGranted(["*://*/*"]);
  for (let event = 0; event < 10; event += 1) h.added[0]();
  await settled();
  assert.ok(h.sent.length <= 4, `a burst of ten is at most two rounds, not ten (${h.sent.length})`);
  assert.deepEqual(h.sent.at(-1).message, { type: SETUP_ACCESS_PUSH_MESSAGE, storySitesAllowed: true, scope: "all" });
  assert.equal(h.calls.some(([name]) => name === "update" || name === "get" || name === "create"), false);

  // Should the browser hand back more tabs than were asked for, still only Trace's are told.
  const loose = createHarness({ install: true, queryIgnoresFilter: true, tabs: [...OTHER_TABS, ...STORY_TABS] });
  loose.added[0]();
  await settled();
  assert.deepEqual(loose.sent.map(({ tabId }) => tabId), [1, 27]);
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
      return { id: index + 1, url, title: `tab ${index + 1}`, lastAccessed: Math.floor(random() * 1000) };
    });
    const h = createHarness({ tabs });
    const answer = await h.controller.handle(ask("story-tabs"), pageSender());
    assert.equal(answer.ok, true);
    const listed = answer.result.tabs;
    assert.ok(listed.length <= SETUP_STORY_TAB_LIMIT);
    assert.doesNotMatch(JSON.stringify(answer), /:\/\//, "an answer never carries an address");
    consideredTotal += tabs.length;
    listedTotal += listed.length;

    const eligible = tabs.filter((tab) => {
      // Stated on its own, not through the function under test: a story host,
      // a work key, and a story-page classification, for the same site.
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
  assert.ok(consideredTotal === 4800 && listedTotal > 100, `the fuzz reached story pages (${listedTotal} listed of ${consideredTotal})`);
});
