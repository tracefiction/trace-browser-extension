import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BACKFILL_GAP_MS,
  BACKFILL_MAX_PER_SESSION,
  BACKFILL_SETTLE_MS,
  FFN_SUMMARY_STATE_KEY,
  FfnSummaryFill,
  QUEUE_MAX,
  SessionFillState,
  ffnAuthorIdFromStoryHtml,
  ffnSummariesFromStoryListHtml,
  isChallengePage,
  lookUpFfnAuthorId,
  readFfnAuthorSummaries,
} from "../../.trace-build/extension-runtime/ffn-summary-fill.mjs";
import { storyTrackCommandFromMessage } from "../../.trace-build/extension-runtime/story-command-sender.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const desktopStory = fixture("ffn_story.html");
const mobileStory = fixture("ffn_story_mobile.html");
const mobileList = fixture("ffn_listing_mobile.html");

const CHALLENGE_PAGE =
  "<!DOCTYPE html><html><head><title>Just a moment...</title></head>" +
  "<body><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>";

// --- A clock whose timers the test controls ----------------------------------

function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.has(id)) {
          timers.delete(id);
          timer.callback();
        }
      }
      await settle();
    },
  };
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

// --- Story-site responses ----------------------------------------------------

function pageResponse(html, { status = 200, url, headers = {} } = {}) {
  const response = new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/** An author's story list in FanFiction.net's mobile rows (no "by" link on an author's own page). */
function authorPage(authorId, storyIds) {
  const rows = storyIds.map((id) =>
    `<div class="bs brb"><a class="pull-right" href="/r/${id}/">12</a>` +
    `<a href="/s/${id}/1/Story-${id}">Story ${id}</a> <a href="/s/${id}/3/Story-${id}">»</a> ` +
    `\n Summary for ${id} &amp; more, long enough to be a real one.` +
    `<div class="gray">T, English, chapters: 3, words: 9k+, updated: <span data-xutime="1">Jan 1</span></div></div>`);
  return `<html><body><div id="content"><b>Author ${authorId}</b> <a href="/u/${authorId}/?a=s">Stories</a>` +
    `${rows.join("\n")}</div>${"<p>filler</p>".repeat(500)}</body></html>`;
}

function storyPage(storyId, authorId) {
  return `<html><body><a href="/u/999/">My profile</a><div id="content"><div align="center"><b>Story ${storyId}</b> by ` +
    `<a href="https://m.fanfiction.net/u/${authorId}/">Author</a></div>${"Chapter text. ".repeat(4000)}</div></body></html>`;
}

/** A story-site fetch that records each request and answers from `answer`. */
function siteFetch(answer) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return answer(url, requests.length);
  };
  return { fetchImpl, requests };
}

/** Every story is by author 7, whose list holds 101-103, 11-13 and 5000-5079. */
function siteAnswer(url) {
  const author = /\/u\/(\d+)\//.exec(url);
  if (author) {
    const ids = author[1] === "7"
      ? ["101", "102", "103", "11", "12", "13", ...Array.from({ length: 80 }, (_, index) => String(5_000 + index))]
      : [];
    return pageResponse(authorPage(author[1], ids), { url: `https://m.fanfiction.net/u/${author[1]}/?a=s` });
  }
  const story = /\/s\/(\d+)\//.exec(url)[1];
  return pageResponse(storyPage(story, "7"), { url: `https://m.fanfiction.net/s/${story}/1/` });
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
  answer = siteAnswer,
  gaps = [],
  enabled = true,
  allowed = true,
  contribution = "accepted",
} = {}) {
  const clock = fakeClock();
  const area = memoryArea();
  const site = siteFetch(answer);
  const contributions = [];
  const gapReads = [];
  const ports = { account: "reader-1:1", enabled, allowed };
  const fill = new FfnSummaryFill({
    fetch: site.fetchImpl,
    clock,
    state: new SessionFillState(area),
    account: () => ports.account,
    contributionsEnabled: async () => ports.enabled,
    hostAllowed: async () => ports.allowed,
    listGaps: async () => {
      gapReads.push(ports.account);
      return typeof gaps === "function" ? gaps(ports.account) : gaps;
    },
    contribute: async (summaries) => {
      contributions.push(summaries.map(({ storyId, summary }) => ({ storyId, summary })));
      return contribution;
    },
  });
  return { fill, clock, area, site, contributions, gapReads, ports };
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

/** Lets the backfill take one step: pages go quiet, then the settle wait ends. */
async function quietStep(h, gap = BACKFILL_GAP_MS) {
  await h.clock.advance(gap);
  h.fill.ffnPageActivity();
  await h.clock.advance(BACKFILL_SETTLE_MS);
}

// --- Parsers -------------------------------------------------------------------

test("reads the author from the story's own block on the mobile and desktop story pages", () => {
  assert.equal(ffnAuthorIdFromStoryHtml(mobileStory), "2329859");
  assert.equal(ffnAuthorIdFromStoryHtml(desktopStory), "2329859");
  // The signed-in reader's own profile link before the story is never taken.
  assert.equal(ffnAuthorIdFromStoryHtml(storyPage("5", "42")), "42");
  assert.equal(ffnAuthorIdFromStoryHtml("<a href='/u/9/'>x</a>"), null);
  assert.equal(ffnAuthorIdFromStoryHtml(CHALLENGE_PAGE), null);
});

test("reads every summary from FanFiction.net's mobile story-list rows", () => {
  const { rows, summaries } = ffnSummariesFromStoryListHtml(mobileList);
  assert.ok(rows >= 20, `rows read: ${rows}`);
  assert.equal(
    summaries.get("3659524"),
    "He was abandoned at a young age, the world believing him dead. They were wrong. " +
      "Death Eaters believed untouchable are dying. Who is this assassin? Will he join " +
      "Dumbledore or take the war into his own hands? Not typical powerful!politic!Harry.",
  );
  assert.equal(
    summaries.get("4240771"),
    "Summer before third year Harry has a life changing experience, and a close encounter " +
      "with a dementor ends with him absorbing the horcrux within him. Features Harry with a backbone.",
  );
});

test("reads an author's own list, where rows have no author link", () => {
  const { rows, summaries } = ffnSummariesFromStoryListHtml(authorPage("7", ["101", "102"]));
  assert.equal(rows, 2);
  assert.equal(summaries.get("101"), "Summary for 101 & more, long enough to be a real one.");
  assert.equal(ffnSummariesFromStoryListHtml(mobileStory).rows, 0);
  assert.equal(ffnSummariesFromStoryListHtml(CHALLENGE_PAGE).rows, 0);
});

test("recognises a challenge page", () => {
  assert.equal(isChallengePage(CHALLENGE_PAGE), true);
  assert.equal(isChallengePage(mobileList), false);
  assert.equal(isChallengePage("", new Headers({ "cf-mitigated": "challenge" })), true);
});

// --- Reading one page ----------------------------------------------------------

test("reads the author list with the reader's session, no cache, and stops once the wanted rows are in", async () => {
  const clock = fakeClock();
  let pulled = 0;
  let cancelled = false;
  const encoder = new TextEncoder();
  const html = authorPage("7", ["101", "102"]);
  const cut = html.indexOf("</div></div>", html.indexOf("Summary for 101")) + 12;
  const chunks = [html.slice(0, cut), html.slice(cut), "x".repeat(50_000)];
  const body = new ReadableStream({
    pull(controller) {
      if (pulled < chunks.length) controller.enqueue(encoder.encode(chunks[pulled++]));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const site = siteFetch(() => pageResponse(body, { url: "https://m.fanfiction.net/u/7/?a=s" }));

  const read = await readFfnAuthorSummaries(site.fetchImpl, "7", ["101"], clock);
  await settle();

  assert.equal(read.kind, "found");
  assert.deepEqual([...read.summaries.keys()], ["101"]);
  assert.equal(site.requests.length, 1);
  assert.equal(site.requests[0].url, "https://m.fanfiction.net/u/7/?a=s");
  assert.equal(site.requests[0].init.credentials, "include");
  assert.equal(site.requests[0].init.cache, "no-store");
  assert.equal(site.requests[0].init.method, "GET");
  assert.ok(pulled < chunks.length, "the rest of the page is not read");
  assert.equal(cancelled, true);
  assert.equal(clock.pending(), 0, "the time limit is cleared");
});

test("a story missing from the author's first page is left out, and no other page is read", async () => {
  const clock = fakeClock();
  const site = siteFetch(siteAnswer);
  const read = await readFfnAuthorSummaries(site.fetchImpl, "7", ["101", "555"], clock);
  assert.deepEqual([...read.summaries.keys()], ["101"]);
  assert.equal(site.requests.length, 1);
});

test("stops on another address, a refusal, a challenge, an unreadable page or an error", async () => {
  const listAt = "https://m.fanfiction.net/u/7/?a=s";
  const cases = [
    [() => pageResponse(authorPage("7", ["1"]), { url: "https://www.fanfiction.net/u/7/?a=s" }), "redirect"],
    [() => pageResponse(authorPage("7", ["1"]), { url: "https://m.fanfiction.net/u/8/" }), "redirect"],
    [() => pageResponse(authorPage("7", ["1"]), { url: "https://m.fanfiction.net/login.php" }), "redirect"],
    [() => pageResponse("gone", { status: 404, url: listAt }), "status"],
    [() => pageResponse(CHALLENGE_PAGE, { status: 403, url: listAt, headers: { "cf-mitigated": "challenge" } }), "challenge"],
    [() => pageResponse(CHALLENGE_PAGE, { url: listAt }), "challenge"],
    [() => pageResponse(mobileStory, { url: listAt }), "missing"],
    [() => { throw new TypeError("Load failed"); }, "error"],
  ];
  for (const [answer, reason] of cases) {
    const clock = fakeClock();
    const site = siteFetch(answer);
    assert.deepEqual(await readFfnAuthorSummaries(site.fetchImpl, "7", ["1"], clock), { kind: "stop", reason });
    assert.equal(clock.pending(), 0);
  }

  const clock = fakeClock();
  const elsewhere = siteFetch(() => pageResponse(mobileStory, { url: "https://www.fanfiction.net/s/5/1/" }));
  assert.deepEqual(await lookUpFfnAuthorId(elsewhere.fetchImpl, "5", clock), { kind: "stop", reason: "redirect" });
  const found = siteFetch(() => pageResponse(mobileStory, { url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter" }));
  assert.deepEqual(await lookUpFfnAuthorId(found.fetchImpl, "7038840", clock), { kind: "found", authorId: "2329859" });
  assert.equal(found.requests[0].url, "https://m.fanfiction.net/s/7038840/1/");
});

// --- On save -------------------------------------------------------------------

test("a page save naming its author reads the author's list once and sends only the summary", async () => {
  const h = harness();

  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);

  assert.deepEqual(h.site.requests.map(({ url }) => url), ["https://m.fanfiction.net/u/7/?a=s"]);
  assert.deepEqual(h.contributions, [[
    { storyId: "101", summary: "Summary for 101 & more, long enough to be a real one." },
  ]]);
  assert.equal(h.clock.pending(), 0);
});

test("a save that did not name the author reads the story's page for it first", async () => {
  const h = harness();

  await h.fill.storySaved(savedStory("102"), false);

  assert.deepEqual(h.site.requests.map(({ url }) => url), [
    "https://m.fanfiction.net/s/102/1/",
    "https://m.fanfiction.net/u/7/?a=s",
  ]);
  assert.deepEqual(filledIds(h), ["102"]);
});

test("no read when the save carried a summary, the story was already saved, or it is not an FFN story page", async () => {
  const h = harness();

  await h.fill.storySaved(savedStory("201", { sm: "The page showed this summary.", ffnAuthorId: "7" }), false);
  await h.fill.storySaved(savedStory("202", { ffnAuthorId: "7" }), true);
  await h.fill.storySaved(savedStory("203", { ctx: "listing" }), false);
  await h.fill.storySaved({ ...savedStory("204"), hostKind: "ao3", workKey: "ao3:204" }, false);

  assert.equal(h.site.requests.length, 0);
  assert.equal(h.contributions.length, 0);
});

test("no read when contributions are turned off or m.fanfiction.net is not allowed", async () => {
  const off = harness({ enabled: false });
  await off.fill.storySaved(savedStory("301", { ffnAuthorId: "7" }), false);
  await off.fill.storySaved(savedStory("302", { ffnAuthorId: "7" }), false);
  assert.equal(off.site.requests.length, 0);

  const blocked = harness({ allowed: false });
  await blocked.fill.storySaved(savedStory("303", { ffnAuthorId: "7" }), false);
  assert.equal(blocked.site.requests.length, 0);
});

test("a story not on its author's first page is dropped without stopping", async () => {
  const h = harness();
  await h.fill.storySaved(savedStory("555", { ffnAuthorId: "7" }), false);
  await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);
  assert.equal(h.site.requests.length, 2);
  assert.deepEqual(filledIds(h), ["101"]);
  assert.equal(state(h).stopped, false);
});

test("a challenge stops it for the session: no retry and no later reads", async () => {
  const h = harness({
    answer: () => pageResponse(CHALLENGE_PAGE, { status: 403, url: "https://m.fanfiction.net/u/7/?a=s" }),
    gaps: ["900", "901"],
  });

  await h.fill.storySaved(savedStory("401", { ffnAuthorId: "7" }), false);
  await h.fill.storySaved(savedStory("402", { ffnAuthorId: "7" }), false);
  h.fill.ffnPageActivity();
  await quietStep(h);
  await quietStep(h);

  assert.equal(h.site.requests.length, 1);
  assert.equal(h.contributions.length, 0);
  assert.equal(h.gapReads.length, 0);
  assert.equal(state(h).stopped, true);
  assert.equal(h.clock.pending(), 0);
});

test("an error, a redirect or a refused contribution stops it too", async () => {
  for (const options of [
    { answer: () => { throw new TypeError("offline"); } },
    { answer: () => pageResponse(authorPage("7", ["101"]), { url: "https://www.fanfiction.net/u/7/" }) },
    { contribution: "failed" },
  ]) {
    const h = harness(options);
    await h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);
    await h.fill.storySaved(savedStory("102", { ffnAuthorId: "7" }), false);
    assert.equal(h.site.requests.length, 1);
    assert.equal(state(h).stopped, true);
  }
});

// --- Backfill ------------------------------------------------------------------

test("the backfill lists gaps once, then makes one request per quiet gap", async () => {
  const h = harness({ gaps: ["11", "12"] });

  h.fill.ffnPageActivity();
  await h.clock.advance(BACKFILL_SETTLE_MS - 1);
  assert.equal(h.gapReads.length, 0, "not while a page is still loading");
  await h.clock.advance(1);
  assert.equal(h.gapReads.length, 1);
  assert.equal(h.site.requests.length, 0, "the list is that step's only request");

  // Too soon after the list: nothing.
  h.fill.ffnPageActivity();
  await h.clock.advance(BACKFILL_SETTLE_MS);
  assert.equal(h.site.requests.length, 0);

  await quietStep(h); // story 11's page, for its author
  assert.deepEqual(h.site.requests.map(({ url }) => url), ["https://m.fanfiction.net/s/11/1/"]);
  assert.deepEqual(state(h).queue[0], { s: "11", a: "7" });
  await quietStep(h); // author 7's list
  assert.equal(h.site.requests[1].url, "https://m.fanfiction.net/u/7/?a=s");
  assert.deepEqual(filledIds(h), ["11"]);

  await quietStep(h);
  await quietStep(h);
  assert.deepEqual(filledIds(h), ["11", "12"]);
  assert.equal(h.gapReads.length, 1);

  // Done: later page activity sets no timer and makes no request.
  h.fill.ffnPageActivity();
  assert.equal(h.clock.pending(), 0);
  await quietStep(h);
  assert.equal(h.site.requests.length, 4);
  assert.equal(h.clock.pending(), 0);
});

test("waiting stories whose author is known are filled from the same list", async () => {
  const h = harness({ gaps: ["11", "12"] });
  await quietStep(h);
  h.area.values[FFN_SUMMARY_STATE_KEY] = { ...state(h), queue: [{ s: "11", a: "7" }, { s: "12", a: "7" }] };
  await quietStep(h);
  assert.equal(h.site.requests.length, 1);
  assert.deepEqual(h.contributions, [[
    { storyId: "11", summary: "Summary for 11 & more, long enough to be a real one." },
    { storyId: "12", summary: "Summary for 12 & more, long enough to be a real one." },
  ]]);
  assert.deepEqual(state(h).queue, []);
});

test("the backfill waits while a save is under way and while the reader is elsewhere", async () => {
  const h = harness({ gaps: ["21"] });
  await quietStep(h); // list

  h.fill.saveStarted();
  await quietStep(h);
  assert.equal(h.site.requests.length, 0);
  h.fill.saveEnded();

  // No FanFiction.net page has spoken: the reader is elsewhere, so nothing runs.
  await h.clock.advance(BACKFILL_GAP_MS * 5);
  assert.equal(h.site.requests.length, 0);
  assert.equal(h.clock.pending(), 0);

  await quietStep(h);
  assert.equal(h.site.requests.length, 1);
});

test("the queue is capped, requests per session are capped, and nothing runs with no timer left", async () => {
  const many = Array.from({ length: 80 }, (_, index) => String(8_000 + index));
  const h = harness({ gaps: many });
  await quietStep(h);
  assert.equal(state(h).queue.length, QUEUE_MAX);

  for (let index = 0; index < BACKFILL_MAX_PER_SESSION + 5; index += 1) await quietStep(h);

  assert.equal(h.site.requests.length, BACKFILL_MAX_PER_SESSION);
  assert.equal(h.clock.pending(), 0);
});

test("sign-out clears the queue and stops waiting; another account starts fresh", async () => {
  const h = harness({ gaps: (account) => (account === "reader-1:1" ? ["31", "32"] : ["51"]) });
  await quietStep(h);
  assert.deepEqual(state(h).queue, [{ s: "31" }, { s: "32" }]);

  h.fill.ffnPageActivity();
  await h.fill.clear();
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(h.clock.pending(), 0);

  // Another account: the previous account's list is never used, even when
  // it is still in session storage.
  h.area.values[FFN_SUMMARY_STATE_KEY] = {
    v: 2, account: "reader-1:1", queue: [{ s: "31" }, { s: "32" }], listed: true,
    stopped: false, backfills: 0, saves: 0, lastStepAt: 0,
  };
  h.ports.account = "reader-2:1";
  await quietStep(h);
  assert.equal(state(h).account, "reader-2:1");
  assert.deepEqual(state(h).queue, [{ s: "51" }]);
  assert.deepEqual(h.gapReads, ["reader-1:1", "reader-2:1"]);

  // Signed out: the state is removed and nothing is read.
  h.ports.account = null;
  await quietStep(h);
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(h.site.requests.length, 0);
});

test("only story and author ids and counters are stored, never page text", async () => {
  const h = harness({ gaps: ["11", "12"] });
  await h.fill.storySaved(savedStory("101"), false);
  await quietStep(h);
  await quietStep(h);
  await quietStep(h);

  assert.ok(h.area.writes.length > 0);
  for (const write of h.area.writes) {
    assert.doesNotMatch(write, /[<>]/);
    assert.doesNotMatch(write, /Summary for/);
    const stored = JSON.parse(write)[FFN_SUMMARY_STATE_KEY];
    assert.deepEqual(Object.keys(stored).sort(), [
      "account", "backfills", "lastStepAt", "listed", "queue", "saves", "stopped", "v",
    ]);
    for (const entry of stored.queue) {
      assert.deepEqual(Object.keys(entry).filter((key) => key !== "s" && key !== "a"), []);
    }
  }
});

test("the author named beside a save is kept off the payload sent to Trace", () => {
  const sender = { frameId: 0, tab: { url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter" } };
  const payload = {
    s: "ffn",
    at: "2026-10-15T00:00:00.000Z",
    item: { src: "ffn", ctx: "story", u: "https://www.fanfiction.net/s/7038840/", t: "A Chance Encounter", chn: 1, sm: null },
  };
  const command = storyTrackCommandFromMessage({ type: "TRACE_AUTO_TRACK", payload, ffnAuthorId: "2329859" }, sender);
  assert.equal(command.ffnAuthorId, "2329859");
  assert.deepEqual(command.payload, payload);
  const bad = storyTrackCommandFromMessage({ type: "TRACE_AUTO_TRACK", payload, ffnAuthorId: "../u/1" }, sender);
  assert.equal("ffnAuthorId" in bad, false);
});

// --- Review fixes ------------------------------------------------------------

test("a page on another site since the last FanFiction.net page stops the backfill step", async () => {
  const h = harness({ gaps: ["11"] });
  await quietStep(h); // list
  await h.clock.advance(BACKFILL_GAP_MS);
  h.fill.ffnPageActivity();
  await h.clock.advance(5_000);
  h.fill.elsewherePageActivity();
  assert.equal(h.clock.pending(), 0, "the waiting step is called off");
  await h.clock.advance(BACKFILL_SETTLE_MS);
  assert.equal(h.site.requests.length, 0);

  // Back on FanFiction.net: it carries on.
  h.fill.ffnPageActivity();
  await h.clock.advance(BACKFILL_SETTLE_MS);
  assert.equal(h.site.requests.length, 1);
});

test("a sign-out during a step writes nothing back and sends nothing", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ answer: async (url) => { await gate; return siteAnswer(url); } });
  const saving = h.fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);
  await settle();
  assert.equal(h.site.requests.length, 1);

  await h.fill.clear();
  release();
  await saving;
  await settle();

  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(h.contributions.length, 0);
  // Not marked finished: the next sign-in's backfill can still run.
  h.fill.ffnPageActivity();
  assert.equal(h.clock.pending(), 1);
});

test("without session storage the backfill never runs, and a save is still read", async () => {
  const clock = fakeClock();
  const site = siteFetch(siteAnswer);
  const contributions = [];
  const gapReads = [];
  const fill = new FfnSummaryFill({
    fetch: site.fetchImpl,
    clock,
    state: new SessionFillState(null),
    account: () => "reader-1:1",
    contributionsEnabled: async () => true,
    hostAllowed: async () => true,
    listGaps: async () => { gapReads.push(1); return ["11"]; },
    contribute: async (summaries) => { contributions.push(summaries); return "accepted"; },
  });
  fill.ffnPageActivity();
  assert.equal(clock.pending(), 0);
  await clock.advance(BACKFILL_GAP_MS);
  assert.equal(gapReads.length, 0);

  await fill.storySaved(savedStory("101", { ffnAuthorId: "7" }), false);
  assert.equal(site.requests.length, 1);
  assert.equal(contributions.length, 1);
});

test("a page with no readable stream is not read at all", async () => {
  const clock = fakeClock();
  let texted = false;
  const response = {
    url: "https://m.fanfiction.net/u/7/?a=s",
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body: null,
    async text() { texted = true; return authorPage("7", ["101"]); },
  };
  const read = await readFfnAuthorSummaries(async () => response, "7", ["101"], clock);
  assert.deepEqual(read, { kind: "stop", reason: "missing" });
  assert.equal(texted, false);
});

test("the save reply says whether Trace already knows the summary", async () => {
  const { StoryCommandApi } = await import("../../.trace-build/extension-runtime/story-command.mjs");
  const entry = {
    status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED",
    entryId: "00000000-0000-4000-8000-000000000456", rating: 0,
    privateContext: { hasNotes: false, tagCount: 0 }, chapters: { current: 0, total: 12 },
  };
  const reply = (extra) => async () => new Response(JSON.stringify({ success: true, data: {
    entry_id: entry.entryId, type: "created", work_key: "ffn:7038840", entry,
    syncVersion: "2026-10-15T00:00:01.000Z", ...extra,
  } }), { status: 200 });
  const command = {
    intent: "ensure_saved", hostKind: "ffn", workKey: "ffn:7038840",
    payload: { s: "ffn", at: "2026-10-15T00:00:00.000Z", item: { src: "ffn", ctx: "story", u: "https://www.fanfiction.net/s/7038840/" } },
  };
  for (const [extra, expected] of [[{ summary_known: true }, true], [{ summary_known: false }, false], [{}, undefined]]) {
    const api = new StoryCommandApi(reply(extra), "https://api.tracefiction.com");
    const result = await api.track("token", command);
    assert.equal(result.value.kind, "confirmed");
    assert.equal(result.value.confirmation.summaryKnown, expected);
  }
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
    return assert.fail(`unexpected ${route}`);
  };
  const site = siteFetch((url) => pageResponse(authorPage("2329859", ["7038840"]), { url }));
  const session = memoryArea();
  const contains = [];
  const controller = installSessionRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} }, async getPlatformInfo() { return { os: "mac" }; } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
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
    ffnSummaryFill: { storySiteFetch: site.fetchImpl, sessionArea: session },
  });
  await controller.start();
  const mobileSender = { frameId: 0, tab: { id: 3, url: "https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter" } };
  const save = () => controller.handle({
    type: "TRACE_QUICK_ADD",
    ffnAuthorId: "2329859",
    payload: {
      s: "ffn",
      at: "2026-10-15T00:00:00.000Z",
      item: { src: "ffn", ctx: "story", u: "https://www.fanfiction.net/s/7038840/", t: "A Chance Encounter", chn: 1, cht: 12, sm: null },
    },
  }, mobileSender);

  const saved = await save();
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await settle();
  await save();
  await settle();
  return { site, apiCalls, contains, session };
}

test("a save from the mobile story page reads the summary once and sends only identity and summary", async () => {
  const { site, apiCalls, contains, session } = await wiredSave({ summaryKnown: false });

  assert.deepEqual(site.requests.map(({ url }) => url), ["https://m.fanfiction.net/u/2329859/?a=s"]);
  assert.deepEqual(contains, [{ origins: ["https://m.fanfiction.net/*"] }]);
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
  const { site, apiCalls } = await wiredSave({ summaryKnown: true });
  assert.equal(site.requests.length, 0);
  assert.equal(apiCalls.some(({ route }) => route === "/api/extension/library/metadata-refresh"), false);
});
