import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BACKFILL_GAP_MS,
  BACKFILL_MAX_PER_SESSION,
  FFN_SUMMARY_ATTEMPTED_KEY,
  FFN_SUMMARY_STATE_KEY,
  FfnSummaryFill,
  LOCAL_STATE_TTL_MS,
  PENDING_MAX,
  QUEUE_MAX,
  REQUEST_GAP_MS,
  SAVE_SETTLE_MS,
  STOP_MS,
  StoredAttempted,
  StoredFillState,
  classifyFfnAnswer,
  createFfnTabReader,
  ffnAuthorIdFromStoryHtml,
  ffnSummariesFromStoryListHtml,
  isChallengePage,
  isFfnStoryNotFoundPage,
} from "../../.trace-build/extension-runtime/ffn-summary-fill.mjs";
import { storyTrackCommandFromMessage } from "../../.trace-build/extension-runtime/story-command-sender.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const desktopStory = fixture("ffn_story.html");
const mobileStory = fixture("ffn_story_mobile.html");
const mobileList = fixture("ffn_listing_mobile.html");
const notFoundStory = fixture("ffn_story_not_found_mobile.html");
const mobileAuthor = fixture("ffn-author/mobile_author_stories.html");
const desktopAuthor = fixture("ffn-author/desktop_author_stories.html");

const CHALLENGE_PAGE =
  "<!DOCTYPE html><html><head><title>Just a moment...</title></head>" +
  "<body><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>";

const TAB = 3;
const HOST = "www.fanfiction.net";

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

// --- Pages, as a read in the reader's tab returns them ---------------------------

/** An author's story list in the mobile rows, as the site writes it. */
function authorPage(authorId, storyIds) {
  const rows = storyIds.map((id) =>
    `<div class='bs brb'><a class=pull-right href='/r/${id}/'>12</a>` +
    `<a  href="/s/${id}/1/Story-${id}">Story ${id}</a> <a href="/s/${id}/3/Story-${id}">&#187;</a> ` +
    `\n Summary for ${id} &amp; more, long enough to be a real one.` +
    `<div class=gray>T, English, chapters: 3, words: 9k+, updated: <span data-xutime='1'>Jan 1</span></div></div>`);
  return `<html><body><div id=content><b>Author ${authorId}</b> <a href='?a=s'>My Stories</a>` +
    `${rows.join("\n")}</div></body></html>`;
}

function storyPage(storyId, authorId) {
  return `<html><body><a href='/u/999/'>My profile</a><div id=content><div align=center><b>Story ${storyId}</b> by ` +
    `<a href='/u/${authorId}/'>Author</a></div>Chapter text.</div></body></html>`;
}

function answer(html, { status = 200, url, contentType = "text/html; charset=UTF-8", cfMitigated = null } = {}) {
  return { kind: "response", status, url, html, contentType, cfMitigated };
}

/** Every story is by author 7, whose list holds 101-103, 11-13 and 5000-5079. */
function siteAnswer(host, pathAsked) {
  const author = /^\/u\/(\d+)\//.exec(pathAsked);
  if (author) {
    const ids = author[1] === "7"
      ? ["101", "102", "103", "11", "12", "13", ...Array.from({ length: 80 }, (_, index) => String(5_000 + index))]
      : [];
    return answer(authorPage(author[1], ids), { url: `https://${host}${pathAsked}` });
  }
  const story = /^\/s\/(\d+)\//.exec(pathAsked)[1];
  return answer(storyPage(story, "7"), { url: `https://${host}/s/${story}/1/Story` });
}

/** A tab reader whose tabs and pages the test controls; records every read. */
function fakeTabs(respond = siteAnswer) {
  const reads = [];
  const tabs = new Map([[TAB, HOST]]);
  return {
    reads,
    tabs,
    allowed: true,
    async tabHost(tabId) {
      if (!tabs.has(tabId)) return { code: "tab_gone" };
      const host = tabs.get(tabId);
      if (!/^(?:www|m)\.fanfiction\.net$/.test(host)) return { code: "tab_not_ffn" };
      return this.allowed ? { host } : { code: "not_allowed" };
    },
    async readInTab(tabId, host, pathAsked) {
      reads.push({ tabId, host, path: pathAsked });
      return respond(host, pathAsked, reads.length);
    },
  };
}

// --- The filler with fake ports ----------------------------------------------

function memoryArea() {
  const values = {};
  const writes = [];
  return {
    values,
    writes,
    async get(key) {
      return key in values ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(items) {
      writes.push(JSON.stringify(items));
      Object.assign(values, structuredClone(items));
    },
    async remove(key) {
      delete values[key];
    },
  };
}

function harness({
  respond = siteAnswer,
  gaps = [],
  enabled = true,
  contribution = "accepted",
  random = () => 0.999999, // keeps the server's order unless a test shuffles
  area = memoryArea(),
  local = memoryArea(),
  clock = { at: 10_000_000 },
  site = fakeTabs(respond),
  durable = true,
} = {}) {
  const contributions = [];
  const gapReads = [];
  const ports = { account: "reader-1:1", enabled };
  const make = () => new FfnSummaryFill({
    clock: { now: () => clock.at },
    state: new StoredFillState(durable ? area : null),
    attempted: new StoredAttempted(local),
    tabs: site,
    random,
    account: () => ports.account,
    contributionsEnabled: async () => ports.enabled,
    listGaps: async () => {
      gapReads.push(ports.account);
      return typeof gaps === "function" ? gaps(ports.account) : gaps;
    },
    contribute: async (summaries) => {
      contributions.push(summaries.map(({ storyId, summary }) => ({ storyId, summary })));
      return contribution;
    },
  });
  const h = {
    fill: make(),
    clock,
    area,
    local,
    site,
    contributions,
    gapReads,
    ports,
    /** Safari unloaded the background: a new one starts with nothing in memory. */
    restart() {
      h.fill = make();
    },
    async advance(ms) {
      clock.at += ms;
      await settle();
    },
    /** A FanFiction.net page in the reader's tab speaks to Trace. */
    async page(tabId = TAB) {
      await h.fill.ffnPageActivity(tabId);
      await settle();
    },
  };
  return h;
}

function savedStory(storyId, { sm = null, ctx = "story", ffnAuthorId } = {}) {
  return {
    hostKind: "ffn",
    workKey: `ffn:${storyId}`,
    payload: {
      s: "ffn",
      at: "2026-10-15T00:00:00.000Z",
      item: { src: "ffn", ctx, u: `https://www.fanfiction.net/s/${storyId}/`, t: "A story", sm },
    },
    ...(ffnAuthorId === undefined ? {} : { ffnAuthorId }),
  };
}

const filledIds = (h) => h.contributions.flat().map(({ storyId }) => storyId);
const state = (h) => h.area.values[FFN_SUMMARY_STATE_KEY];
const readPaths = (h) => h.site.reads.map(({ path: asked }) => asked);

/** Lets the backfill take one step: a backfill gap passes, then a page speaks. */
async function backfillStep(h) {
  await h.advance(BACKFILL_GAP_MS);
  await h.page();
}

// --- Parsers -------------------------------------------------------------------

test("reads the author from the story's own block, quoted or not", () => {
  assert.equal(ffnAuthorIdFromStoryHtml(mobileStory), "2329859");
  assert.equal(ffnAuthorIdFromStoryHtml(desktopStory), "2329859");
  // The signed-in reader's own profile link before the story is never taken.
  assert.equal(ffnAuthorIdFromStoryHtml(storyPage("5", "42")), "42");
  assert.equal(ffnAuthorIdFromStoryHtml("<div id=content>by <a href=/u/43/Name>Name</a></div>"), "43");
  assert.equal(ffnAuthorIdFromStoryHtml("<a href='/u/9/'>x</a>"), null);
  assert.equal(ffnAuthorIdFromStoryHtml(CHALLENGE_PAGE), null);
});

test("reads every summary from FanFiction.net's mobile category rows", () => {
  const { rows, summaries } = ffnSummariesFromStoryListHtml(mobileList);
  assert.ok(rows >= 20, `rows read: ${rows}`);
  assert.equal(
    summaries.get("4240771"),
    "Summer before third year Harry has a life changing experience, and a close encounter " +
      "with a dementor ends with him absorbing the horcrux within him. Features Harry with a backbone.",
  );
});

test("reads an author's My Stories page in the mobile layout, with the site's unquoted attributes", () => {
  const { rows, summaries } = ffnSummariesFromStoryListHtml(mobileAuthor);
  assert.equal(rows, 4);
  assert.deepEqual(Object.fromEntries(summaries), {
    9900000101: "A lantern left burning in an empty wing & a letter nobody admits to writing. Elizabeth follows the light.",
    9900000102: "Holmes is asked to find a clockwork bird. Watson would rather find his breakfast.",
    9900000103: "\"Nothing happens at the parsonage,\" Charlotte writes. Everything happens at the parsonage.",
  });
  // A row with no summary counts as a row and gives none.
  assert.equal(summaries.has("9900000104"), false);
  assert.equal(ffnSummariesFromStoryListHtml(mobileStory).rows, 0);
  assert.equal(ffnSummariesFromStoryListHtml(CHALLENGE_PAGE).rows, 0);
});

test("reads only the author's own stories from the desktop profile, never their favourites", () => {
  const { rows, summaries } = ffnSummariesFromStoryListHtml(desktopAuthor);
  assert.equal(rows, 2);
  assert.deepEqual(Object.fromEntries(summaries), {
    9900000101: "A lantern left burning in an empty wing & a letter nobody admits to writing. Elizabeth follows the light.",
    9900000102: "Holmes is asked to find a clockwork bird. Watson would rather find his breakfast.",
  });
  assert.equal(summaries.has("9900000555"), false);
});

test("recognises a challenge page and FanFiction.net's page for a story that is gone", () => {
  assert.equal(isChallengePage(CHALLENGE_PAGE), true);
  assert.equal(isChallengePage(mobileAuthor), false);
  assert.equal(isChallengePage("", new Headers({ "cf-mitigated": "challenge" })), true);
  assert.equal(isFfnStoryNotFoundPage(notFoundStory), true);
  assert.equal(isFfnStoryNotFoundPage(mobileStory), false);
  const prose = '<div id="content"><p>Story Not Found is the title of chapter three.</p></div>';
  assert.equal(isFfnStoryNotFoundPage(prose), false);
});

// --- Classifying an answer from the tab ------------------------------------------

test("only an HTML 200 at the address asked for, on the tab's own host, is a page", () => {
  const at = `https://${HOST}/u/7/?a=s`;
  const author = (pathname) => pathname === "/u/7" || pathname.startsWith("/u/7/");
  const page = classifyFfnAnswer(answer(mobileAuthor, { url: at }), HOST, author, "author");
  assert.equal(page.kind, "page");
  assert.deepEqual(page.note, { status: 200, host: HOST, path: "author", cf: null });

  const cases = [
    [answer(mobileAuthor, { url: "https://m.fanfiction.net/u/7/?a=s" }), "redirect", { host: "m.fanfiction.net", path: "author" }],
    [answer(mobileAuthor, { url: `https://${HOST}/u/8/` }), "redirect", { path: "author" }],
    [answer(mobileAuthor, { url: `https://${HOST}/login.php` }), "redirect", { path: "other" }],
    [answer("gone", { status: 404, url: at }), "status", { status: 404 }],
    [answer(CHALLENGE_PAGE, { status: 403, url: at, cfMitigated: "challenge" }), "challenge", { status: 403, cf: "challenge" }],
    [answer(CHALLENGE_PAGE, { status: 503, url: at }), "challenge", { status: 503 }],
    [answer(CHALLENGE_PAGE, { url: at }), "challenge", {}],
    [answer("{}", { url: at, contentType: "application/json" }), "not_html", {}],
    [{ kind: "failed", code: "timeout" }, "error", { status: null, path: "author" }],
    [{ kind: "failed", code: "network" }, "error", {}],
  ];
  for (const [given, reason, note] of cases) {
    const read = classifyFfnAnswer(given, HOST, author, "author");
    assert.equal(read.kind, "stop", reason);
    assert.equal(read.reason, reason);
    for (const [key, value] of Object.entries(note)) assert.equal(read.note[key], value, `${reason}: ${key}`);
  }
  // The tab could not be used: nothing was asked of the site, so no stop.
  for (const code of ["tab_gone", "tab_not_ffn", "not_allowed", "no_result"]) {
    assert.equal(classifyFfnAnswer({ kind: "failed", code }, HOST, author, "author").kind, "tab");
  }
});

// --- Reading in the tab (scripting mocked) ---------------------------------------

function tabReaderHarness({ tab = { url: "https://www.fanfiction.net/s/101/1/A-Story" }, allowed = true, result } = {}) {
  const calls = { get: [], contains: [], scripts: [] };
  const reader = createFfnTabReader({
    hasScripting: true,
    async getTab(tabId) {
      calls.get.push(tabId);
      if (tab instanceof Error) throw tab;
      return tab;
    },
    async containsOrigin(origin) {
      calls.contains.push(origin);
      return allowed;
    },
    async executeScript(details) {
      calls.scripts.push(details);
      if (typeof result === "function") return result(details);
      return result;
    },
    timeoutMs: 50,
  });
  return { reader, calls };
}

test("a page is read only in a FanFiction.net tab the reader has allowed Trace on", async () => {
  const ok = tabReaderHarness();
  assert.deepEqual(await ok.reader.tabHost(TAB), { host: HOST });
  assert.deepEqual(ok.calls.contains, ["https://www.fanfiction.net/*"]);
  const mobile = tabReaderHarness({ tab: { url: "https://m.fanfiction.net/s/101/1/" } });
  assert.deepEqual(await mobile.reader.tabHost(TAB), { host: "m.fanfiction.net" });

  assert.deepEqual(await tabReaderHarness({ tab: new Error("No tab") }).reader.tabHost(TAB), { code: "tab_gone" });
  assert.deepEqual(await tabReaderHarness({ tab: { url: "https://archiveofourown.org/works/1" } }).reader.tabHost(TAB), { code: "tab_not_ffn" });
  assert.deepEqual(await tabReaderHarness({ tab: {} }).reader.tabHost(TAB), { code: "tab_not_ffn" });
  assert.deepEqual(await tabReaderHarness({ allowed: false }).reader.tabHost(TAB), { code: "not_allowed" });
  const none = createFfnTabReader({
    hasScripting: false, getTab: async () => ({}), containsOrigin: async () => true, executeScript: async () => [],
  });
  assert.deepEqual(await none.tabHost(TAB), { code: "no_result" });
});

test("the read runs in the tab's top frame and hands back only the answer's facts", async () => {
  const h = tabReaderHarness({
    result: () => [{ result: {
      ok: true, status: 200, url: `https://${HOST}/u/7/?a=s`, html: mobileAuthor,
      contentType: "text/html; charset=UTF-8", cfMitigated: null,
    } }],
  });
  const read = await h.reader.readInTab(TAB, HOST, "/u/7/?a=s");
  assert.equal(read.kind, "response");
  assert.equal(read.status, 200);
  assert.equal(read.html, mobileAuthor);
  assert.deepEqual(h.calls.scripts[0].target, { tabId: TAB, frameIds: [0] });
  assert.equal(typeof h.calls.scripts[0].func, "function");
  assert.deepEqual(h.calls.scripts[0].args.slice(0, 2), [HOST, "/u/7/?a=s"]);

  const failures = [
    [() => [{ result: { ok: false, error: "moved" } }], "tab_not_ffn"],
    [() => [{ result: { ok: false, error: "timeout" } }], "timeout"],
    [() => [{ result: { ok: false, error: "network" } }], "network"],
    [() => [{}], "no_result"],
    [() => { throw new Error("Cannot access contents of the page"); }, "no_result"],
    [() => new Promise(() => {}), "timeout"],
  ];
  for (const [result, code] of failures) {
    const failing = tabReaderHarness({ result });
    assert.deepEqual(await failing.reader.readInTab(TAB, HOST, "/u/7/?a=s"), { kind: "failed", code });
  }
});

test("in the page, the read is a same-site request with the tab's cookies, and stops for a tab that moved on", async () => {
  const h = tabReaderHarness({ result: () => [] });
  await h.reader.readInTab(TAB, HOST, "/u/7/?a=s");
  const inPage = h.calls.scripts[0].func;
  const saved = { location: globalThis.location, fetch: globalThis.fetch };
  const requests = [];
  try {
    globalThis.location = { protocol: "https:", hostname: HOST };
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      const response = new Response(desktopAuthor, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const result = await inPage(HOST, "/u/7/?a=s", 2 * 1024 * 1024, 256 * 1024);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `https://${HOST}/u/7/?a=s`);
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(requests[0].init.cache, "no-store");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    // The desktop profile comes back from the author's own stories on.
    assert.match(result.html, /^<div class="z-list mystories"/);
    assert.equal(ffnSummariesFromStoryListHtml(result.html).rows, 2);

    globalThis.location = { protocol: "https:", hostname: "archiveofourown.org" };
    assert.deepEqual(await inPage(HOST, "/u/7/?a=s", 1024, 1024), { ok: false, error: "moved" });
    assert.equal(requests.length, 1, "nothing asked of another site");
  } finally {
    if (saved.location === undefined) delete globalThis.location;
    else globalThis.location = saved.location;
    globalThis.fetch = saved.fetch;
  }
});

test("in the page on Firefox, the page's own content.fetch is used, so the reader's session goes with it", async () => {
  const h = tabReaderHarness({ result: () => [] });
  await h.reader.readInTab(TAB, HOST, "/u/7/?a=s");
  const inPage = h.calls.scripts[0].func;
  const saved = { location: globalThis.location, fetch: globalThis.fetch, content: globalThis.content };
  const requests = [];
  const answer = (url) => {
    const response = new Response(desktopAuthor, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  try {
    globalThis.location = { protocol: "https:", hostname: HOST };
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init, via: "fetch" });
      return answer(url);
    };
    globalThis.content = {
      fetch(url, init) {
        assert.equal(this, globalThis.content, "called on the page's window");
        requests.push({ url, init, via: "content.fetch" });
        return Promise.resolve(answer(url));
      },
    };
    const result = await inPage(HOST, "/u/7/?a=s", 2 * 1024 * 1024, 256 * 1024);
    assert.deepEqual(requests.map(({ via }) => via), ["content.fetch"]);
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(ffnSummariesFromStoryListHtml(result.html).rows, 2);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

// --- On save -------------------------------------------------------------------

test("a save naming its author reads the author's list once, in its own tab, and sends only the summary", async () => {
  const h = harness();

  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);

  assert.deepEqual(h.site.reads, [{ tabId: TAB, host: HOST, path: "/u/7/?a=s" }]);
  assert.deepEqual(h.contributions, [[
    { storyId: "101", summary: "Summary for 101 & more, long enough to be a real one." },
  ]]);
  assert.deepEqual(state(h).pending, []);
  assert.deepEqual(
    { ...state(h).last, at: undefined },
    {
      trigger: "save", stage: "send", outcome: "filled", status: 200, host: HOST, path: "author",
      cf: null, rows: 86, found: 1, send: "accepted", at: undefined,
    },
  );
});

test("a save with no tab of its own is read in the FanFiction.net tab that spoke last", async () => {
  const h = harness();
  await h.page(TAB);
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);
  assert.deepEqual(h.site.reads.map(({ tabId }) => tabId), [TAB]);
});

test("the read waits in storage while the background is gone, and is done when an FFN page next speaks", async () => {
  const h = harness();
  // Saved with no FanFiction.net tab to read in (and none spoke lately).
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);
  assert.equal(h.site.reads.length, 0);
  assert.deepEqual(state(h).pending, [{ s: "101", a: "7" }]);

  // Safari unloads the background; a new one starts much later.
  h.restart();
  await h.advance(10 * 60_000);
  await h.page();

  assert.deepEqual(readPaths(h), ["/u/7/?a=s"]);
  assert.deepEqual(filledIds(h), ["101"]);
  assert.deepEqual(state(h).pending, []);
});

test("reads are at least 30 s apart, by the stored time, even across a background restart", async () => {
  const h = harness();
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);
  await h.fill.storySaved(savedStory("201", { ffnAuthorId: "8" }), false, TAB);
  assert.equal(h.site.reads.length, 1, "the second save waits");
  assert.deepEqual(state(h).pending, [{ s: "201", a: "8" }]);

  h.restart();
  await h.advance(REQUEST_GAP_MS - 1);
  await h.page();
  assert.equal(h.site.reads.length, 1, "not before 30 s");
  await h.advance(1);
  await h.page();
  assert.deepEqual(readPaths(h), ["/u/7/?a=s", "/u/8/?a=s"]);
});

test("a save that did not name its author reads the story's page, then the list at a later turn", async () => {
  const h = harness();
  await h.fill.storySaved(savedStory("102"), false, TAB);
  assert.deepEqual(readPaths(h), ["/s/102/1/"]);
  assert.deepEqual(state(h).pending, [{ s: "102", a: "7" }]);
  assert.equal(state(h).last.outcome, "author_found");

  h.restart();
  await h.advance(REQUEST_GAP_MS);
  await h.page();
  assert.deepEqual(readPaths(h), ["/s/102/1/", "/u/7/?a=s"]);
  assert.deepEqual(filledIds(h), ["102"]);
});

test("no read when the save carried a summary, the story was already saved, or it is not an FFN story page", async () => {
  const h = harness();
  await h.fill.storySaved(savedStory("201", { sm: "The page showed this summary.", ffnAuthorId: "7" }), false, TAB);
  await h.fill.storySaved(savedStory("202", { ffnAuthorId: "7" }), true, TAB);
  await h.fill.storySaved(savedStory("203", { ctx: "listing" }), false, TAB);
  await h.fill.storySaved({ ...savedStory("204"), hostKind: "ao3", workKey: "ao3:204" }, false, TAB);
  assert.equal(h.site.reads.length, 0);
  assert.equal(h.contributions.length, 0);
});

test("with contributions turned off nothing is read, and nothing is kept to read later", async () => {
  const h = harness({ enabled: false });
  await h.fill.storySaved(savedStory("301", { ffnAuthorId: "7" }), false, TAB);
  assert.equal(h.site.reads.length, 0);
  assert.deepEqual(state(h).pending, []);
  assert.equal(state(h).last.outcome, "off");
});

test("a tab that cannot be read asks nothing of the site and keeps the work, without stopping", async () => {
  const h = harness();
  h.site.allowed = false;
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);
  assert.equal(h.site.reads.length, 0);
  assert.equal(state(h).stop, null);
  assert.equal(state(h).last.outcome, "not_allowed");
  assert.deepEqual(state(h).pending, [{ s: "101", a: "7" }]);

  h.site.allowed = true;
  await h.page();
  assert.deepEqual(filledIds(h), ["101"]);
});

test("at most five saves wait at once", async () => {
  const h = harness();
  h.site.allowed = false;
  for (let index = 0; index < PENDING_MAX + 2; index += 1) {
    await h.fill.storySaved(savedStory(String(600 + index), { ffnAuthorId: "7" }), false, TAB);
  }
  assert.equal(state(h).pending.length, PENDING_MAX);
});

test("a story not on its author's first page is dropped, and recorded, without stopping", async () => {
  const h = harness();
  await h.fill.storySaved(savedStory("555", { ffnAuthorId: "7" }), false, TAB);
  assert.equal(h.site.reads.length, 1);
  assert.equal(h.contributions.length, 0);
  assert.equal(state(h).stop, null);
  assert.deepEqual(state(h).pending, []);
  assert.equal(state(h).last.outcome, "not_listed");
  assert.equal(state(h).last.rows, 86);
});

test("a story that is gone is skipped and the work carries on", async () => {
  const h = harness({
    respond: (host, asked) => (asked.startsWith("/s/66/")
      ? answer(notFoundStory, { url: `https://${host}/s/66/1/` })
      : siteAnswer(host, asked)),
  });
  await h.fill.storySaved(savedStory("66"), false, TAB);
  assert.equal(state(h).stop, null);
  assert.deepEqual(state(h).pending, []);
  assert.equal(state(h).last.outcome, "gone");
});

// --- Stops that expire ---------------------------------------------------------------

const challenged = (host, asked) =>
  answer(CHALLENGE_PAGE, { status: 403, url: `https://${host}${asked}`, cfMitigated: "challenge" });

test("a challenge pauses the fill for an hour with what stopped it recorded, then allows one more try", async () => {
  let respond = challenged;
  const h = harness({ respond: (...args) => respond(...args), gaps: ["900"] });
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);

  const stopped = state(h).stop;
  assert.deepEqual({ ...stopped, at: undefined, until: undefined }, {
    reason: "challenge", status: 403, host: HOST, path: "author", cf: "challenge", at: undefined, until: undefined,
  });
  assert.equal(stopped.until - stopped.at, STOP_MS);
  assert.deepEqual(state(h).pending, [{ s: "101", a: "7", n: 1 }], "the save is kept for the next try");

  // Pages speak all through the hour: nothing is read, not even the backfill.
  for (let minute = 3; minute < 60; minute += 3) {
    await h.advance(3 * 60_000);
    await h.page();
  }
  assert.equal(h.site.reads.length, 1);
  assert.equal(h.gapReads.length, 0);

  respond = siteAnswer;
  await h.advance(3 * 60_000);
  h.restart();
  await h.page();
  assert.equal(h.site.reads.length, 2, "one more try after the hour");
  assert.deepEqual(filledIds(h), ["101"]);
});

test("a save that fails twice is given up; the next failure pauses another hour", async () => {
  const h = harness({ respond: challenged });
  await h.fill.storySaved(savedStory("402", { ffnAuthorId: "7" }), false, TAB);
  await h.advance(STOP_MS);
  await h.page();
  assert.equal(h.site.reads.length, 2);
  assert.deepEqual(state(h).pending, []);
  assert.ok(state(h).stop.until > h.clock.at);
});

test("an error, a redirect or a refused contribution pauses it too, each with its reason", async () => {
  for (const [options, reason] of [
    [{ respond: () => ({ kind: "failed", code: "network" }) }, "error"],
    [{ respond: (host) => answer(authorPage("7", ["101"]), { url: `https://${host}/login.php` }) }, "redirect"],
    [{ respond: (host, asked) => answer("busy", { status: 503, url: `https://${host}${asked}` }) }, "status"],
    [{ contribution: "failed" }, "send"],
  ]) {
    const h = harness(options);
    await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);
    await h.fill.storySaved(savedStory("102", { ffnAuthorId: "7" }), false, TAB);
    await h.advance(REQUEST_GAP_MS);
    await h.page();
    assert.equal(h.site.reads.length, 1, reason);
    assert.equal(state(h).stop.reason, reason);
  }
});

// --- Backfill ------------------------------------------------------------------

test("the backfill lists gaps once, then reads one page per backfill gap while FFN pages speak", async () => {
  const h = harness({ gaps: ["11", "12"] });

  await h.page();
  assert.equal(h.gapReads.length, 1);
  assert.equal(h.site.reads.length, 0, "the list is that step's only call");

  await h.advance(REQUEST_GAP_MS);
  await h.page();
  assert.equal(h.site.reads.length, 0, "too soon after the list");

  await backfillStep(h); // story 11's page, for its author
  assert.deepEqual(readPaths(h), ["/s/11/1/"]);
  assert.deepEqual(state(h).queue[0], { s: "11", a: "7" });
  await backfillStep(h); // author 7's list
  assert.equal(readPaths(h)[1], "/u/7/?a=s");
  assert.deepEqual(filledIds(h), ["11"]);

  await backfillStep(h);
  await backfillStep(h);
  assert.deepEqual(filledIds(h), ["11", "12"]);
  assert.equal(h.gapReads.length, 1);

  // Done: later pages read nothing.
  await backfillStep(h);
  assert.equal(h.site.reads.length, 4);
});

test("waiting stories whose author is known are filled from the same list", async () => {
  const h = harness({ gaps: ["11", "12"] });
  await h.page();
  h.area.values[FFN_SUMMARY_STATE_KEY] = { ...state(h), queue: [{ s: "11", a: "7" }, { s: "12", a: "7" }] };
  await backfillStep(h);
  assert.equal(h.site.reads.length, 1);
  assert.deepEqual(filledIds(h), ["11", "12"]);
  assert.deepEqual(state(h).queue, []);
});

test("the backfill waits during and just after a save, and without lasting state never runs", async () => {
  const h = harness({ gaps: ["21"] });
  await h.page(); // list
  await h.advance(BACKFILL_GAP_MS);
  h.fill.saveStarted();
  await h.page();
  assert.equal(h.site.reads.length, 0);
  h.fill.saveEnded();
  await h.advance(SAVE_SETTLE_MS - 1);
  await h.page();
  assert.equal(h.site.reads.length, 0);
  await h.advance(1);
  await h.page();
  assert.equal(h.site.reads.length, 1);

  const memoryOnly = harness({ gaps: ["21"], durable: false });
  await memoryOnly.page();
  await backfillStep(memoryOnly);
  assert.equal(memoryOnly.gapReads.length, 0);
  await memoryOnly.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);
  assert.deepEqual(filledIds(memoryOnly), ["101"], "a save is still read");
});

test("the queue is capped and backfill requests per session are capped", async () => {
  const many = Array.from({ length: 80 }, (_, index) => String(8_000 + index));
  const h = harness({ gaps: many });
  await h.page();
  assert.equal(state(h).queue.length, QUEUE_MAX);
  for (let index = 0; index < BACKFILL_MAX_PER_SESSION + 5; index += 1) await backfillStep(h);
  assert.equal(h.site.reads.length, BACKFILL_MAX_PER_SESSION);
});

test("stories already tried come last and fresh ones are shuffled, so each session tries others", async () => {
  const h = harness({ gaps: ["11", "12", "13", "14"], random: () => 0 });
  await h.local.set({ [FFN_SUMMARY_ATTEMPTED_KEY]: { account: "reader-1:1", ids: ["12", "11"] } });
  await h.page();
  const order = state(h).queue.map(({ s: id }) => id);
  assert.deepEqual(order.slice(2), ["12", "11"], "tried stories last, oldest try first");
  assert.deepEqual(order.slice(0, 2), ["14", "13"], "fresh stories shuffled");
});

// --- Sign-out, accounts and what is stored ------------------------------------

test("sign-out removes the state and the tried list; another account starts fresh", async () => {
  const h = harness({ gaps: (account) => (account === "reader-1:1" ? ["31", "32"] : ["51"]) });
  await h.fill.storySaved(savedStory("555", { ffnAuthorId: "7" }), false, TAB);
  await h.page();
  assert.ok(FFN_SUMMARY_ATTEMPTED_KEY in h.local.values);

  await h.fill.clear();
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(FFN_SUMMARY_ATTEMPTED_KEY in h.local.values, false);

  // Another account: the previous account's work is never used, even when
  // it is still in storage.
  h.area.values[FFN_SUMMARY_STATE_KEY] = {
    ...structuredClone(h.area.writes.map((write) => JSON.parse(write)[FFN_SUMMARY_STATE_KEY]).filter(Boolean).at(-1)),
    queue: [{ s: "31" }, { s: "32" }],
  };
  h.ports.account = "reader-2:1";
  await h.advance(BACKFILL_GAP_MS);
  await h.page();
  assert.equal(state(h).account, "reader-2:1");
  assert.deepEqual(state(h).queue, [{ s: "51" }]);

  // Signed out: the state is removed and nothing is read.
  h.ports.account = null;
  const reads = h.site.reads.length;
  await backfillStep(h);
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(h.site.reads.length, reads);
});

test("a sign-out during a read writes nothing back and sends nothing", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ respond: async (...args) => { await gate; return siteAnswer(...args); } });
  const saving = h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false, TAB);
  await settle();
  assert.equal(h.site.reads.length, 1);
  await h.fill.clear();
  release();
  await saving;
  await settle();
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(h.contributions.length, 0);
});

test("reset clears the session's state but keeps the tried list", async () => {
  const h = harness({ respond: challenged });
  await h.fill.storySaved(savedStory("401", { ffnAuthorId: "7" }), false, TAB);
  assert.ok(state(h).stop);
  await h.fill.reset();
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.ok(FFN_SUMMARY_ATTEMPTED_KEY in h.local.values);
  assert.equal(await h.fill.status(), null);
});

test("only ids, counters and answer facts are stored, never page text", async () => {
  const h = harness({ gaps: ["11", "12"] });
  await h.fill.storySaved(savedStory("101"), false, TAB);
  await backfillStep(h);
  await backfillStep(h);
  await backfillStep(h);
  assert.ok(h.area.writes.length > 0);
  for (const write of h.area.writes) {
    assert.doesNotMatch(write, /[<>]/);
    assert.doesNotMatch(write, /Summary for|Chapter text/);
    const stored = JSON.parse(write)[FFN_SUMMARY_STATE_KEY];
    assert.deepEqual(Object.keys(stored).sort(), [
      "account", "backfills", "last", "lastBackfillAt", "lastRequestAt", "listed", "pending", "queue", "saves", "stop", "v",
    ]);
  }
});

test("without session storage the state lives in local storage and expires", async () => {
  const local = memoryArea();
  let now = 1_000;
  const store = new StoredFillState(local, { ttlMs: LOCAL_STATE_TTL_MS, now: () => now });
  assert.equal(store.durable, true);
  const fresh = {
    v: 3, account: "a:1", pending: [{ s: "1", a: "2" }], queue: [], listed: false, backfills: 0, saves: 0,
    lastRequestAt: 0, lastBackfillAt: 0, stop: null, last: null,
  };
  await store.write(fresh);
  assert.equal(local.values[FFN_SUMMARY_STATE_KEY].exp, 1_000 + LOCAL_STATE_TTL_MS);
  assert.deepEqual((await store.read()).pending, [{ s: "1", a: "2" }]);
  now += LOCAL_STATE_TTL_MS;
  assert.equal(await store.read(), null);
  assert.equal(FFN_SUMMARY_STATE_KEY in local.values, false);
});

test("the author named beside a save is kept off the payload sent to Trace", () => {
  const sender = { frameId: 0, tab: { url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter" } };
  const payload = {
    s: "ffn",
    at: "2026-10-15T00:00:00.000Z",
    item: { src: "ffn", ctx: "story", u: "https://www.fanfiction.net/s/7038840/", t: "A Chance Encounter", chn: 1, sm: null },
  };
  for (const type of ["TRACE_AUTO_TRACK", "TRACE_CONNECT_AND_SAVE"]) {
    const command = storyTrackCommandFromMessage({ type, payload, ffnAuthorId: "2329859" }, sender);
    assert.equal(command.ffnAuthorId, "2329859");
    assert.deepEqual(command.payload, payload);
  }
  const bad = storyTrackCommandFromMessage({ type: "TRACE_AUTO_TRACK", payload, ffnAuthorId: "../u/1" }, sender);
  assert.equal("ffnAuthorId" in bad, false);
});

// --- Wired into the session runtime ------------------------------------------

async function wiredSave({ summaryKnown } = {}) {
  const { IDBFactory } = await import("fake-indexeddb");
  const { installSessionRuntime } = await import("../../.trace-build/extension-runtime/controller.mjs");
  const { BrowserPrivateRecordDatabase, PRIVATE_RECORD_KEYS } = await import(
    "../../.trace-build/extension-runtime/private-database.mjs"
  );
  const databaseFactory = new IDBFactory();
  const database = new BrowserPrivateRecordDatabase(databaseFactory);
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, {
    version: 1, epoch: 1, desired: "connected", accountId: "account-a", credentialRef: "credential-a",
  });
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, {
    version: 1, entries: { "credential-a": "private-token" },
  });
  const apiCalls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const entry = {
    status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED",
    entryId: "00000000-0000-4000-8000-000000000456", rating: 0,
    privateContext: { hasNotes: false, tagCount: 0 }, chapters: { current: 0, total: 12 },
  };
  const api = async (url, options = {}) => {
    const route = new URL(url).pathname;
    apiCalls.push({ route, body: options.body ? JSON.parse(options.body) : undefined });
    if (route === "/api/extension/account") return json({ account_id: "account-a", pro: true, library_count: 0 });
    if (route === "/api/extension/library-overlay") {
      return json({ success: true, data: { entries: {}, syncVersion: "2026-10-15T00:00:00.000Z" } });
    }
    if (route === "/api/extension/track") {
      return json({ success: true, data: {
        entry_id: entry.entryId, type: "created", work_key: "ffn:7038840", entry,
        syncVersion: "2026-10-15T00:00:01.000Z",
        ...(summaryKnown === undefined ? {} : { summary_known: summaryKnown }),
      } });
    }
    if (route === "/api/extension/library/metadata-refresh") {
      return json({ success: true, data: { updated: 1, ignored: 0 } });
    }
    if (route === "/api/extension/library/summary-gaps") {
      return json({ success: true, data: { sourceStoryIds: [] } });
    }
    return assert.fail(`unexpected ${route}`);
  };
  const scripts = [];
  const session = memoryArea();
  const contains = [];
  const controller = installSessionRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} }, async getPlatformInfo() { return { os: "mac" }; } },
    tabs: {
      async query() { return []; },
      async sendMessage() { return null; },
      async get(tabId) { return { id: tabId, url: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter" }; },
    },
    scripting: {
      async executeScript(details) {
        scripts.push({ target: details.target, args: details.args.slice(0, 2) });
        const [host, asked] = details.args;
        return [{ result: {
          ok: true, status: 200, url: `https://${host}${asked}`, html: authorPage("2329859", ["7038840"]),
          contentType: "text/html; charset=UTF-8", cfMitigated: null,
        } }];
      },
    },
    permissions: { async getAll() { return { origins: [] }; }, async contains(request) { contains.push(request); return true; } },
    alarms: { async clear() { return true; } },
    storageArea: { async get() { return {}; }, async set() {}, async remove() {} },
    databaseFactory,
    privateDatabase: database,
    storageMode: "promise",
    fetch: api,
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
    ffnSummaryFill: { sessionArea: session },
  });
  await controller.start();
  const sender = { frameId: 0, tab: { id: 3, url: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter" } };
  const save = () => controller.handle({
    type: "TRACE_QUICK_ADD",
    ffnAuthorId: "2329859",
    payload: {
      s: "ffn",
      at: "2026-10-15T00:00:00.000Z",
      item: { src: "ffn", ctx: "story", u: "https://www.fanfiction.net/s/7038840/", t: "A Chance Encounter", chn: 1, cht: 12, sm: null },
    },
  }, sender);

  const saved = await save();
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await settle();
  await save();
  await settle();
  return { scripts, apiCalls, contains, session };
}

test("a save from the story page on a phone reads the summary in that tab once and sends only identity and summary", async () => {
  const { scripts, apiCalls, contains, session } = await wiredSave({ summaryKnown: false });

  assert.deepEqual(scripts, [{ target: { tabId: 3, frameIds: [0] }, args: ["www.fanfiction.net", "/u/2329859/?a=s"] }]);
  assert.deepEqual(contains, [{ origins: ["https://www.fanfiction.net/*"] }]);
  const refreshes = apiCalls.filter(({ route }) => route === "/api/extension/library/metadata-refresh");
  assert.deepEqual(refreshes.map(({ body }) => body), [{
    items: [{
      source: "ffn",
      sourceStoryId: "7038840",
      url: "https://www.fanfiction.net/s/7038840/",
      summary: "Summary for 7038840 & more, long enough to be a real one.",
    }],
  }]);
  assert.equal(JSON.stringify(session.values).includes("<"), false);
});

test("no read when Trace says the saved story already has its summary", async () => {
  const { scripts, apiCalls } = await wiredSave({ summaryKnown: true });
  assert.deepEqual(scripts.filter(({ args }) => args[1].startsWith("/u/") || args[1].startsWith("/s/")), []);
  assert.equal(apiCalls.some(({ route }) => route === "/api/extension/library/metadata-refresh"), false);
});
