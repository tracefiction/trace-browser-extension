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
  ffnSummaryFromStoryHtml,
  isChallengePage,
  readFfnStorySummary,
} from "../../.trace-build/extension-runtime/ffn-summary-fill.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const desktopStory = fs.readFileSync(path.join(FIXTURES, "ffn_story.html"), "utf8");
const mobileStory = fs.readFileSync(path.join(FIXTURES, "ffn_story_mobile.html"), "utf8");

const FIXTURE_SUMMARY =
  "What if Harry didn't bump into the Weasleys at Kings Cross on his first day? " +
  "What if he met another family? A family that knew his parents. This simple " +
  "encounter will set him on a different path including new friends and new " +
  "ambitions. Includes: Slytherin!Harry, Good!Dumbledore, Conflicted!Snape, & " +
  "Supportive!Remus. Future HP/DG & HG/TN. Years 1-2. Complete! The Sequel is posted.";

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

function storyPage(storyId, summary = "A ferryman keeps a ledger of every soul he refuses.") {
  return (
    "<html><body><div id=content_wrapper><div id='profile_top' style='min-height:112px;'>" +
    "<b class='xcontrast_txt'>The Ferryman's Ledger</b> By: <a class='xcontrast_txt' href='/u/1/'>Oar</a>" +
    `<div style='margin-top:2px' class='xcontrast_txt'>${summary}</div>` +
    "<span class='xgray xcontrast_txt'>Rated: Fiction T - English</span></div>" +
    `<div id='storytext'>${"Chapter text. ".repeat(2000)}</div></body></html>`
  );
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

function storyAnswer(url) {
  const id = /\/s\/(\d+)\//.exec(url)[1];
  return pageResponse(storyPage(id, `Summary for ${id}, long enough to be a real one.`), {
    url: `https://www.fanfiction.net/s/${id}/1/`,
  });
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
  answer = storyAnswer,
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
  const ports = {
    account: "reader-1:1",
    enabled,
    allowed,
  };
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
    contribute: async (storyId, summary) => {
      contributions.push({ storyId, summary });
      return contribution;
    },
  });
  return { fill, clock, area, site, contributions, gapReads, ports };
}

function savedStory(storyId, sm = null, ctx = "story") {
  return {
    hostKind: "ffn",
    workKey: `ffn:${storyId}`,
    payload: {
      s: "ffn",
      at: "2026-10-15T00:00:00.000Z",
      item: { src: "ffn", ctx, u: `https://www.fanfiction.net/s/${storyId}/`, t: "A story", sm },
    },
  };
}

/** Lets the backfill take one step: pages go quiet, then the settle wait ends. */
async function quietStep(h, gap = BACKFILL_GAP_MS) {
  await h.clock.advance(gap);
  h.fill.ffnPageActivity();
  await h.clock.advance(BACKFILL_SETTLE_MS);
}

// --- Parser ------------------------------------------------------------------

test("reads the summary from the desktop story page fixture", () => {
  assert.equal(ffnSummaryFromStoryHtml(desktopStory), FIXTURE_SUMMARY);
});

test("reads FanFiction.net's own single-quoted markup and decodes entities", () => {
  const html =
    "<div id=profile_top><b class='xcontrast_txt'>T</b>" +
    "<div style='margin-top:2px' class='xcontrast_txt'>Harry &amp; Draco&#39;s <i>long</i>   year &#x2014; again.</div>" +
    "<span class='xgray xcontrast_txt'>Rated: K</span></div>";
  assert.equal(ffnSummaryFromStoryHtml(html), "Harry & Draco's long year — again.");
});

test("finds nothing on the mobile story page, a challenge page, or a page without the block", () => {
  assert.equal(ffnSummaryFromStoryHtml(mobileStory), null);
  assert.equal(ffnSummaryFromStoryHtml(CHALLENGE_PAGE), null);
  assert.equal(ffnSummaryFromStoryHtml("<div id='profile_top'><span class='xgray xcontrast_txt'>Rated: T</span></div>"), null);
  assert.equal(ffnSummaryFromStoryHtml(""), null);
});

test("recognises a challenge page", () => {
  assert.equal(isChallengePage(CHALLENGE_PAGE), true);
  assert.equal(isChallengePage(desktopStory), false);
  assert.equal(isChallengePage("", new Headers({ "cf-mitigated": "challenge" })), true);
});

// --- Reading one page ----------------------------------------------------------

test("reads one page with the reader's session, no cache, and stops reading at the summary", async () => {
  const clock = fakeClock();
  let pulled = 0;
  let cancelled = false;
  const encoder = new TextEncoder();
  const chunks = [storyPage("77").slice(0, 600), storyPage("77").slice(600, 2_000), "x".repeat(50_000)];
  const body = new ReadableStream({
    pull(controller) {
      if (pulled < chunks.length) controller.enqueue(encoder.encode(chunks[pulled++]));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const site = siteFetch(() => pageResponse(body, { url: "https://www.fanfiction.net/s/77/1/" }));

  const read = await readFfnStorySummary(site.fetchImpl, "77", clock);
  await settle();

  assert.deepEqual(read, { kind: "found", summary: "A ferryman keeps a ledger of every soul he refuses." });
  assert.equal(site.requests.length, 1);
  assert.equal(site.requests[0].url, "https://www.fanfiction.net/s/77/1/");
  assert.equal(site.requests[0].init.credentials, "include");
  assert.equal(site.requests[0].init.cache, "no-store");
  assert.equal(site.requests[0].init.method, "GET");
  assert.ok(pulled < chunks.length, "the rest of the page is not read");
  assert.equal(cancelled, true);
  assert.equal(clock.pending(), 0, "the time limit is cleared");
});

test("stops on a redirect elsewhere, a refusal, a challenge, a missing summary or an error", async () => {
  const cases = [
    [() => pageResponse(storyPage("5"), { url: "https://m.fanfiction.net/s/5/1/" }), "redirect"],
    [() => pageResponse(storyPage("5"), { url: "https://www.fanfiction.net/" }), "redirect"],
    [() => pageResponse("gone", { status: 404, url: "https://www.fanfiction.net/s/5/1/" }), "status"],
    [() => pageResponse(CHALLENGE_PAGE, { status: 403, url: "https://www.fanfiction.net/s/5/1/", headers: { "cf-mitigated": "challenge" } }), "challenge"],
    [() => pageResponse(CHALLENGE_PAGE, { url: "https://www.fanfiction.net/s/5/1/" }), "challenge"],
    [() => pageResponse(mobileStory, { url: "https://www.fanfiction.net/s/5/1/" }), "missing"],
    [() => { throw new TypeError("Load failed"); }, "error"],
  ];
  for (const [answer, reason] of cases) {
    const clock = fakeClock();
    const site = siteFetch(answer);
    assert.deepEqual(await readFfnStorySummary(site.fetchImpl, "5", clock), { kind: "stop", reason });
    assert.equal(clock.pending(), 0);
  }
});

// --- On save -------------------------------------------------------------------

test("a new story saved with no summary is read once, straight away, and only its summary is sent", async () => {
  const h = harness();

  await h.fill.storySaved(savedStory("101"), false);
  await h.fill.storySaved(savedStory("101"), false);

  assert.equal(h.site.requests.length, 1);
  assert.deepEqual(h.contributions, [
    { storyId: "101", summary: "Summary for 101, long enough to be a real one." },
  ]);
  assert.equal(h.clock.pending(), 0);
});

test("no read when the save carried a summary, the story was already saved, or it is not an FFN story page", async () => {
  const h = harness();

  await h.fill.storySaved(savedStory("201", "The page showed this summary."), false);
  await h.fill.storySaved(savedStory("202"), true);
  await h.fill.storySaved(savedStory("203", null, "listing"), false);
  await h.fill.storySaved({ ...savedStory("204"), hostKind: "ao3", workKey: "ao3:204" }, false);

  assert.equal(h.site.requests.length, 0);
  assert.equal(h.contributions.length, 0);
});

test("no read when contributions are turned off or the site is not allowed", async () => {
  const off = harness({ enabled: false });
  await off.fill.storySaved(savedStory("301"), false);
  await off.fill.storySaved(savedStory("302"), false);
  assert.equal(off.site.requests.length, 0);

  const blocked = harness({ allowed: false });
  await blocked.fill.storySaved(savedStory("303"), false);
  assert.equal(blocked.site.requests.length, 0);
});

test("a challenge stops it for the session: no retry and no later reads", async () => {
  const h = harness({
    answer: () => pageResponse(CHALLENGE_PAGE, { status: 403, url: "https://www.fanfiction.net/s/401/1/" }),
    gaps: ["900", "901"],
  });

  await h.fill.storySaved(savedStory("401"), false);
  await h.fill.storySaved(savedStory("402"), false);
  h.fill.ffnPageActivity();
  await quietStep(h);
  await quietStep(h);

  assert.equal(h.site.requests.length, 1);
  assert.equal(h.contributions.length, 0);
  assert.equal(h.gapReads.length, 0);
  assert.equal(h.area.values[FFN_SUMMARY_STATE_KEY].stopped, true);
  assert.equal(h.clock.pending(), 0);
});

test("an error, a redirect or a refused contribution stops it too", async () => {
  for (const options of [
    { answer: () => { throw new TypeError("offline"); } },
    { answer: () => pageResponse(storyPage("1"), { url: "https://m.fanfiction.net/s/501/1/" }) },
    { contribution: "failed" },
  ]) {
    const h = harness(options);
    await h.fill.storySaved(savedStory("501"), false);
    await h.fill.storySaved(savedStory("502"), false);
    assert.equal(h.site.requests.length, 1);
    assert.equal(h.area.values[FFN_SUMMARY_STATE_KEY].stopped, true);
  }
});

// --- Backfill ------------------------------------------------------------------

test("the backfill lists gaps once, then reads one story per gap, only after the pages go quiet", async () => {
  const h = harness({ gaps: ["11", "12", "13"] });

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

  await quietStep(h);
  assert.deepEqual(h.contributions.map(({ storyId }) => storyId), ["11"]);
  await quietStep(h);
  await quietStep(h);
  assert.deepEqual(h.contributions.map(({ storyId }) => storyId), ["11", "12", "13"]);
  assert.equal(h.gapReads.length, 1);

  // Done: later page activity sets no timer and makes no request.
  h.fill.ffnPageActivity();
  assert.equal(h.clock.pending(), 0);
  await quietStep(h);
  assert.equal(h.site.requests.length, 3);
  assert.equal(h.clock.pending(), 0);
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

test("the queue is capped, reads per session are capped, and nothing runs with no timer left", async () => {
  const many = Array.from({ length: 80 }, (_, index) => String(1_000 + index));
  const h = harness({ gaps: many });
  await quietStep(h);
  assert.equal(h.area.values[FFN_SUMMARY_STATE_KEY].queue.length, QUEUE_MAX);

  for (let index = 0; index < BACKFILL_MAX_PER_SESSION + 5; index += 1) await quietStep(h);

  assert.equal(h.site.requests.length, BACKFILL_MAX_PER_SESSION);
  assert.equal(h.clock.pending(), 0);
});

test("sign-out clears the queue and stops waiting; another account starts fresh", async () => {
  const h = harness({ gaps: (account) => (account === "reader-1:1" ? ["31", "32"] : ["51"]) });
  await quietStep(h);
  assert.deepEqual(h.area.values[FFN_SUMMARY_STATE_KEY].queue, ["31", "32"]);

  h.fill.ffnPageActivity();
  await h.fill.clear();
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(h.clock.pending(), 0);

  // Another account: the previous account's list is never used, even when
  // it is still in session storage.
  h.area.values[FFN_SUMMARY_STATE_KEY] = {
    v: 1, account: "reader-1:1", queue: ["31", "32"], listed: true,
    stopped: false, backfills: 0, saves: 0, lastStepAt: 0,
  };
  h.ports.account = "reader-2:1";
  await quietStep(h);
  assert.equal(h.area.values[FFN_SUMMARY_STATE_KEY].account, "reader-2:1");
  assert.deepEqual(h.area.values[FFN_SUMMARY_STATE_KEY].queue, ["51"]);
  assert.deepEqual(h.gapReads, ["reader-1:1", "reader-2:1"]);

  // Signed out: the state is removed and nothing is read.
  h.ports.account = null;
  await quietStep(h);
  assert.equal(FFN_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(h.site.requests.length, 0);
});

test("only story ids and counters are stored, never page text", async () => {
  const h = harness({ gaps: ["41", "42"] });
  await h.fill.storySaved(savedStory("40"), false);
  await quietStep(h);
  await quietStep(h);

  assert.ok(h.area.writes.length > 0);
  for (const write of h.area.writes) {
    assert.doesNotMatch(write, /[<>]/);
    assert.doesNotMatch(write, /Summary for/);
    const state = JSON.parse(write)[FFN_SUMMARY_STATE_KEY];
    assert.deepEqual(Object.keys(state).sort(), [
      "account", "backfills", "lastStepAt", "listed", "queue", "saves", "stopped", "v",
    ]);
  }
});

// --- Wired into the session runtime ------------------------------------------

test("a save from the mobile story page reads the summary once and sends only identity and summary", async () => {
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
      } });
    }
    if (route === "/api/extension/library/metadata-refresh") {
      return json({ success: true, data: { updated: 1, ignored: 0 } });
    }
    return assert.fail(`unexpected ${route}`);
  };
  const site = siteFetch(storyAnswer);
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

  assert.deepEqual(site.requests.map(({ url }) => url), ["https://www.fanfiction.net/s/7038840/1/"]);
  assert.deepEqual(contains, [{ origins: ["https://www.fanfiction.net/*"] }]);
  const refreshes = apiCalls.filter(({ route }) => route === "/api/extension/library/metadata-refresh");
  assert.deepEqual(refreshes.map(({ body }) => body), [{
    items: [{
      source: "ffn",
      sourceStoryId: "7038840",
      url: "https://www.fanfiction.net/s/7038840/",
      summary: "Summary for 7038840, long enough to be a real one.",
    }],
  }]);
  assert.equal(JSON.stringify(session.values).includes("<"), false);
});
