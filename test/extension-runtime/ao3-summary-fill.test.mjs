import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import {
  AO3_SUMMARY_ATTEMPTED_KEY,
  AO3_SUMMARY_STATE_KEY,
  Ao3SummaryFill,
  BACKFILL_GAP_MS,
  LOCAL_STATE_TTL_MS,
  MISSES_MAX,
  QUEUE_MAX,
  RELIST_MIN_MS,
  RELIST_MS,
  REQUEST_GAP_MS,
  SAVE_SETTLE_MS,
  STOP_MAX_MS,
  STOP_MS,
  StoredAttempted,
  StoredFillState,
  WINDOW_MAX_READS,
  WINDOW_MS,
  classifyAo3Answer,
  createAo3TabReader,
  retryAfterMs,
} from "../../.trace-build/extension-runtime/ao3-summary-fill.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ao3-work-summary");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const TAB = 3;
const HOST = "archiveofourown.org";
const NOW = 10_000_000_000;
const ACCOUNT = "reader-1:1";

const CHALLENGE_PAGE =
  "<!DOCTYPE html><html><head><title>Just a moment...</title></head>" +
  "<body><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>";

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

// --- Answers, as a read in the reader's tab returns them ------------------------

function work(workId, summary, {
  status = 200,
  url = `https://${HOST}/works/${workId}?view_adult=true`,
  contentType = "text/html; charset=utf-8",
  cfMitigated = null,
  retryAfter = null,
  page = "work",
} = {}) {
  return { kind: "response", status, url, contentType, cfMitigated, retryAfter, page, summary };
}

/** Every work has a summary naming it. */
const siteAnswer = (workId) => work(workId, `Summary of ${workId}.`);

/** A tab reader whose tab and pages the test controls; records every read. */
function fakeTabs(respond = siteAnswer) {
  const reads = [];
  const tabs = new Map([[TAB, { host: HOST }]]);
  return {
    reads,
    tabs,
    allowed: true,
    async tabHost(tabId) {
      if (!tabs.has(tabId)) return { code: "tab_gone" };
      const tab = tabs.get(tabId);
      if (!/archiveofourown\.org$/.test(tab.host)) return { code: "tab_not_ao3" };
      return this.allowed ? { host: tab.host } : { code: "not_allowed" };
    },
    async readWork(tabId, host, workId) {
      reads.push({ tabId, host, workId });
      return respond(workId, reads.length);
    },
  };
}

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
  gaps = ["101", "102", "103"],
  enabled = true,
  contribution = "accepted",
  random = () => 0.999999, // keeps the server's order unless a test shuffles
  area = memoryArea(),
  local = memoryArea(),
  clock = { at: NOW },
  site = fakeTabs(respond),
  durable = true,
} = {}) {
  const contributions = [];
  const gapReads = [];
  const ports = { account: "reader-1:1", enabled, gaps };
  const make = () => new Ao3SummaryFill({
    clock: { now: () => clock.at },
    state: new StoredFillState(durable ? area : null),
    attempted: new StoredAttempted(local),
    tabs: site,
    random,
    account: () => ports.account,
    contributionsEnabled: async () => ports.enabled,
    listGaps: async () => {
      gapReads.push(ports.account);
      return typeof ports.gaps === "function" ? ports.gaps(ports.account) : ports.gaps;
    },
    contribute: async (summaries) => {
      contributions.push(summaries.map(({ storyId, summary }) => ({ storyId, summary })));
      return typeof contribution === "function" ? contribution() : contribution;
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
    /** An AO3 page in the reader's tab speaks to Trace. */
    async page(tabId = TAB) {
      await h.fill.ao3PageActivity(tabId);
      await settle();
    },
    /** A step gap passes, then a page speaks. */
    async step() {
      await h.advance(BACKFILL_GAP_MS);
      await h.page();
    },
  };
  return h;
}

const filledIds = (h) => h.contributions.flat().map(({ storyId }) => storyId);
const state = (h) => h.area.values[AO3_SUMMARY_STATE_KEY];
const readIds = (h) => h.site.reads.map(({ workId }) => workId);

function savedStory(workId, { hostKind = "ao3", sm = null } = {}) {
  return {
    hostKind,
    workKey: `${hostKind}:${workId}`,
    payload: {
      s: hostKind,
      at: "2026-10-21T00:00:00.000Z",
      item: { src: hostKind, ctx: "story", u: `https://${HOST}/works/${workId}`, t: "A work", chn: 3, sm },
    },
  };
}

// --- Classifying an answer from the tab ------------------------------------------

test("a work's page with a summary gives the summary, with the answer's facts noted", () => {
  const read = classifyAo3Answer(work("101", "  A summary.\n\nTwo paragraphs.  "), HOST, "101", NOW);
  assert.equal(read.kind, "summary");
  assert.equal(read.summary, "A summary.\n\nTwo paragraphs.");
  assert.deepEqual(read.note, { status: 200, host: HOST, path: "work", cf: null });
  // The first chapter's own address, or the work inside a collection, is the work too.
  for (const url of [
    `https://${HOST}/works/101/chapters/9900001`,
    `https://${HOST}/collections/lamplight/works/101`,
  ]) {
    assert.equal(classifyAo3Answer(work("101", "x", { url }), HOST, "101", NOW).kind, "summary", url);
  }
});

test("works AO3 says are gone, signed-in only, without a summary, or unreadable are skipped", () => {
  const cases = [
    [work("101", null, { status: 404 }), "gone"],
    [work("101", null, { status: 410 }), "gone"],
    [work("101", null, { url: `https://${HOST}/users/login?restricted=true` }), "restricted"],
    [work("101", null), "no_summary"],
    [work("101", "   "), "no_summary"],
    [work("101", null, { page: "other" }), "unreadable"],
    [work("101", null, { url: `https://${HOST}/` }), "unreadable"],
    [work("101", null, { url: `https://${HOST}/works/102` }), "unreadable"],
  ];
  for (const [given, outcome] of cases) {
    const read = classifyAo3Answer(given, HOST, "101", NOW);
    assert.equal(read.kind, "skip", outcome);
    assert.equal(read.outcome, outcome);
  }
});

test("a refusal, a check page, another site or an error pauses the fill, with any wait AO3 asks for", () => {
  const cases = [
    [work("101", null, { status: 429, retryAfter: "120" }), "status", { status: 429 }, 120_000],
    [work("101", null, { status: 503 }), "status", { status: 503 }, null],
    [work("101", null, { status: 403, cfMitigated: "challenge" }), "challenge", { cf: "challenge" }, null],
    [work("101", null, { status: 403, page: "challenge" }), "challenge", {}, null],
    [work("101", null, { page: "challenge" }), "challenge", {}, null],
    [work("101", null, { url: "https://archiveofourown.gay/works/101" }), "redirect", { host: "archiveofourown.gay" }, null],
    [work("101", null, { url: "http://archiveofourown.org/works/101" }), "redirect", {}, null],
    [work("101", null, { contentType: "application/json" }), "not_html", {}, null],
    [{ kind: "failed", code: "timeout" }, "error", { status: null, path: "work" }, null],
    [{ kind: "failed", code: "network" }, "error", {}, null],
  ];
  for (const [given, reason, note, waitMs] of cases) {
    const read = classifyAo3Answer(given, HOST, "101", NOW);
    assert.equal(read.kind, "stop", reason);
    assert.equal(read.reason, reason);
    assert.equal(read.waitMs, waitMs, reason);
    for (const [key, value] of Object.entries(note)) assert.equal(read.note[key], value, `${reason}: ${key}`);
  }
  // The tab could not be used: nothing was asked of the site, so no stop.
  for (const code of ["tab_gone", "tab_not_ao3", "not_allowed", "no_result"]) {
    assert.equal(classifyAo3Answer({ kind: "failed", code }, HOST, "101", NOW).kind, "tab");
  }
});

test("Retry-After is read as seconds or as a date", () => {
  assert.equal(retryAfterMs("90", NOW), 90_000);
  assert.equal(retryAfterMs(new Date(NOW + 30_000).toUTCString(), NOW), 30_000);
  assert.equal(retryAfterMs(new Date(NOW - 30_000).toUTCString(), NOW), null);
  assert.equal(retryAfterMs("soon", NOW), null);
  assert.equal(retryAfterMs(null, NOW), null);
});

// --- Reading in the tab (scripting mocked) ---------------------------------------

function tabReaderHarness({ tab = { url: "https://archiveofourown.org/works/555/chapters/9" }, allowed = true, result } = {}) {
  const calls = { get: [], contains: [], scripts: [] };
  const reader = createAo3TabReader({
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

test("a page is read only in an AO3 tab the reader has allowed Trace on", async () => {
  const ok = tabReaderHarness();
  assert.deepEqual(await ok.reader.tabHost(TAB), { host: HOST });
  assert.deepEqual(ok.calls.contains, ["https://archiveofourown.org/*"]);
  const listing = tabReaderHarness({ tab: { url: "https://archiveofourown.org/tags/Sherlock/works" } });
  assert.deepEqual(await listing.reader.tabHost(TAB), { host: HOST });
  const mirror = tabReaderHarness({ tab: { url: "https://archiveofourown.gay/collections/x/works/9" } });
  assert.deepEqual(await mirror.reader.tabHost(TAB), { host: "archiveofourown.gay" });

  assert.deepEqual(await tabReaderHarness({ tab: new Error("No tab") }).reader.tabHost(TAB), { code: "tab_gone" });
  for (const url of ["https://www.fanfiction.net/s/1/1/", "http://archiveofourown.org/works/1", "https://evil.example/works/1", "nonsense"]) {
    assert.deepEqual(await tabReaderHarness({ tab: { url } }).reader.tabHost(TAB), { code: "tab_not_ao3" }, url);
  }
  assert.deepEqual(await tabReaderHarness({ allowed: false }).reader.tabHost(TAB), { code: "not_allowed" });
  const noScripting = createAo3TabReader({ hasScripting: false, getTab: async () => ({}), executeScript: async () => [], containsOrigin: async () => true });
  assert.deepEqual(await noScripting.tabHost(TAB), { code: "no_result" });
});

test("the read runs in the tab's top frame and hands back only the answer's facts and the summary", async () => {
  const h = tabReaderHarness({
    result: () => [{ result: {
      ok: true, status: 200, url: `https://${HOST}/works/101?view_adult=true`, contentType: "text/html",
      cfMitigated: null, retryAfter: null, page: "work", summary: "A summary.", html: "<p>never kept</p>",
    } }],
  });
  const read = await h.reader.readWork(TAB, HOST, "101");
  assert.deepEqual(read, {
    kind: "response", status: 200, url: `https://${HOST}/works/101?view_adult=true`, contentType: "text/html",
    cfMitigated: null, retryAfter: null, page: "work", summary: "A summary.",
  });
  assert.deepEqual(h.calls.scripts[0].target, { tabId: TAB, frameIds: [0] });
  assert.equal(typeof h.calls.scripts[0].func, "function");
  assert.deepEqual(h.calls.scripts[0].args.slice(0, 2), [HOST, "101"]);

  const failures = [
    [() => [{ result: { ok: false, error: "moved" } }], "tab_not_ao3"],
    [() => [{ result: { ok: false, error: "timeout" } }], "timeout"],
    [() => [{ result: { ok: false, error: "network" } }], "network"],
    [() => [{ result: { ok: true, status: 200, url: "x", page: "anything", summary: null } }], "no_result"],
    [() => [{}], "no_result"],
    [() => { throw new Error("Cannot access contents of the page"); }, "no_result"],
    [() => new Promise(() => {}), "timeout"],
  ];
  for (const [result, code] of failures) {
    const failing = tabReaderHarness({ result });
    assert.deepEqual(await failing.reader.readWork(TAB, HOST, "101"), { kind: "failed", code });
  }
});

/** Runs the in-page read against `pages`, in a page at `HOST` with a real DOM parser. */
async function inPage(pages, { at = HOST, workId = "101", maxBytes = 1024 * 1024, contentFetch } = {}) {
  const h = tabReaderHarness({ result: () => [] });
  await h.reader.readWork(TAB, HOST, workId);
  const func = h.calls.scripts[0].func;
  const { window } = new JSDOM("");
  const saved = {
    location: globalThis.location, fetch: globalThis.fetch, DOMParser: globalThis.DOMParser, content: globalThis.content,
  };
  const requests = [];
  try {
    globalThis.location = { protocol: "https:", hostname: at };
    globalThis.DOMParser = window.DOMParser;
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init, via: "fetch" });
      return pages(url);
    };
    // Firefox gives a content script the page's own fetch as `content.fetch`.
    if (contentFetch) {
      globalThis.content = {
        fetch(url, init) {
          assert.equal(this, globalThis.content, "called on the page's window");
          requests.push({ url, init, via: "content.fetch" });
          return Promise.resolve(pages(url));
        },
      };
    }
    const result = await func(HOST, workId, maxBytes, 4000);
    return { result, requests };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

function htmlResponse(body, { status = 200, url, headers = {} } = {}) {
  const response = new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("in the page, the work's first page is a same-site request with the tab's cookies, and only its summary comes back", async () => {
  const { result, requests } = await inPage((url) => htmlResponse(fixture("chapter-1.html"), { url }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://${HOST}/works/101?view_adult=true`);
  assert.equal(requests[0].init.credentials, "include");
  assert.equal(requests[0].via, "fetch");
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(requests[0].init.method, "GET");
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    url: `https://${HOST}/works/101?view_adult=true`,
    contentType: "text/html; charset=utf-8",
    cfMitigated: null,
    retryAfter: null,
    page: "work",
    // The work's summary, never its notes.
    summary: "A lamplighter keeps a ledger of every fog that crosses Baker Street.",
  });
  const oneShot = await inPage((url) => htmlResponse(fixture("one-shot.html"), { url }));
  assert.equal(oneShot.result.summary, "One evening, one lamp, one detective.");
});


test("in the page on Firefox, the page's own content.fetch is used, so the reader's AO3 session goes with it", async () => {
  const { result, requests } = await inPage((url) => htmlResponse(fixture("chapter-1.html"), { url }), { contentFetch: true });
  assert.deepEqual(requests.map(({ via }) => via), ["content.fetch"]);
  assert.equal(requests[0].url, `https://${HOST}/works/101?view_adult=true`);
  assert.equal(requests[0].init.credentials, "include");
  assert.equal(result.summary, "A lamplighter keeps a ledger of every fog that crosses Baker Street.");
});

test("in the page, a body that cannot be streamed is read whole and still parsed", async () => {
  const { result } = await inPage((url) => {
    const response = htmlResponse(fixture("chapter-1.html"), { url });
    Object.defineProperty(response, "body", { value: null });
    return response;
  });
  assert.equal(result.page, "work");
  assert.equal(result.summary, "A lamplighter keeps a ledger of every fog that crosses Baker Street.");
});
test("in the page, paragraphs and line breaks are kept, and a chapter's summary is never the work's", async () => {
  const page = `<html><body><div id="workskin">
    <div class="preface group"><h2 class="title heading">T</h2></div>
    <div id="chapters"><div class="chapter preface group"><div class="summary module">
      <blockquote class="userstuff"><p>Chapter summary.</p></blockquote></div></div></div>
  </div></body></html>`;
  assert.equal((await inPage((url) => htmlResponse(page, { url }))).result.summary, null);
  assert.equal((await inPage((url) => htmlResponse(page, { url }))).result.page, "work");

  const paragraphs = `<html><body><div id="workskin"><div class="preface group"><div class="summary module">
    <blockquote class="userstuff"><p>canon-compliant.</p><p>1971 -   1995<br>a  line</p></blockquote>
  </div></div><div id="chapters"></div></div></body></html>`;
  assert.equal((await inPage((url) => htmlResponse(paragraphs, { url }))).result.summary, "canon-compliant.\n\n1971 - 1995\na line");
});

test("in the page, the read stops where the chapters start, and the rest is never downloaded", async () => {
  const encoder = new TextEncoder();
  const [preface, rest] = fixture("chapter-1.html").split(/(?=<div id="chapters")/);
  let pulls = 0;
  const chunks = [preface, rest.slice(0, 80), rest.slice(80), "<p>more chapter text</p>"];
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks[pulls];
      pulls += 1;
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });
  const { result } = await inPage((url) => htmlResponse(body, { url }));
  assert.equal(result.summary, "A lamplighter keeps a ledger of every fog that crosses Baker Street.");
  assert.ok(pulls <= 3, `chunks pulled: ${pulls}`);
});

test("in the page, a check page, another page or a refusal is reported as such", async () => {
  const challenge = await inPage((url) => htmlResponse(CHALLENGE_PAGE, { url, status: 403, headers: { "cf-mitigated": "challenge" } }));
  assert.equal(challenge.result.page, "challenge");
  assert.equal(challenge.result.cfMitigated, "challenge");
  const login = await inPage(() => htmlResponse("<html><body><form id=loginform></form></body></html>",
    { url: `https://${HOST}/users/login?restricted=true` }));
  assert.equal(login.result.page, "other");
  assert.equal(login.result.url, `https://${HOST}/users/login?restricted=true`);
  const limited = await inPage((url) => htmlResponse("Retry later", { url, status: 429, headers: { "retry-after": "300" } }));
  assert.equal(limited.result.status, 429);
  assert.equal(limited.result.retryAfter, "300");
  const json = await inPage((url) => {
    const response = new Response("{}", { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  assert.equal(json.result.page, "other");
  assert.equal(json.result.summary, null);
  const failed = await inPage(() => { throw new TypeError("Load failed"); });
  assert.deepEqual(failed.result, { ok: false, error: "network" });
});

test("in the page, a tab that moved on asks nothing of another site", async () => {
  const { result, requests } = await inPage(() => assert.fail("no request"), { at: "www.fanfiction.net" });
  assert.deepEqual(result, { ok: false, error: "moved" });
  assert.equal(requests.length, 0);
});

// --- The fill -------------------------------------------------------------------

test("the first AO3 page lists the gaps; then one work is read per step and sent as identity and summary", async () => {
  const h = harness();
  await h.page();
  assert.deepEqual(h.gapReads, ["reader-1:1"]);
  assert.deepEqual(state(h).queue, ["101", "102", "103"]);
  assert.deepEqual(h.site.reads, [], "the listing is the first step; the first read waits a step gap");

  await h.page();
  assert.deepEqual(h.site.reads, [], "a page sooner than the step gap does nothing");
  await h.step();
  assert.deepEqual(h.site.reads, [{ tabId: TAB, host: HOST, workId: "101" }]);
  assert.deepEqual(h.contributions, [[{ storyId: "101", summary: "Summary of 101." }]]);
  await h.step();
  await h.step();
  assert.deepEqual(filledIds(h), ["101", "102", "103"]);
  assert.equal(state(h).last.outcome, "filled");
  assert.deepEqual(state(h).queue, []);
  await h.step();
  assert.equal(h.site.reads.length, 3, "nothing left to read");
  assert.equal(h.gapReads.length, 1, "no listing again until a relist is due");
});

test("reads are at least 30 s apart and steps a minute apart, by the stored times, even across a restart", async () => {
  const h = harness();
  await h.page();
  await h.step();
  assert.equal(h.site.reads.length, 1);
  h.restart();
  await h.advance(REQUEST_GAP_MS);
  await h.page();
  assert.equal(h.site.reads.length, 1, "a fresh background still waits the step gap");
  await h.advance(BACKFILL_GAP_MS - REQUEST_GAP_MS);
  await h.page();
  assert.equal(h.site.reads.length, 2);
});

test("the fill waits during and just after a save, and without lasting state never runs", async () => {
  const h = harness();
  h.fill.saveStarted();
  await h.page();
  assert.equal(h.gapReads.length, 0);
  h.fill.saveEnded();
  await h.page();
  assert.equal(h.gapReads.length, 0, "just after a save");
  await h.advance(SAVE_SETTLE_MS);
  await h.page();
  assert.equal(h.gapReads.length, 1);

  const memoryOnly = harness({ durable: false });
  await memoryOnly.page();
  await memoryOnly.step();
  assert.equal(memoryOnly.gapReads.length, 0);
  assert.equal(memoryOnly.site.reads.length, 0);
});

test("with contributions turned off nothing is read, and nothing is kept to read later", async () => {
  const h = harness();
  await h.page();
  h.ports.enabled = false;
  await h.step();
  assert.deepEqual(h.site.reads, []);
  assert.deepEqual(state(h).queue, []);
  assert.equal(state(h).last.outcome, "off");
  await h.advance(RELIST_MS);
  await h.page();
  assert.equal(h.gapReads.length, 1, "nothing is listed while it is off");
});

test("a tab that cannot be read asks nothing of the site and keeps the work, without stopping", async () => {
  const h = harness();
  await h.page();
  h.site.allowed = false;
  await h.step();
  assert.deepEqual(h.site.reads, []);
  assert.equal(state(h).last.outcome, "not_allowed");
  assert.equal(state(h).stop, null);
  assert.deepEqual(state(h).queue, ["101", "102", "103"]);
  h.site.allowed = true;
  await h.page();
  assert.deepEqual(readIds(h), ["101"], "the next page reads it, the request gap not taken by the failed check");

  // A read the tab refused after the check counts for nothing either.
  const moved = harness({ respond: (workId, count) => (count === 1 ? { kind: "failed", code: "tab_not_ao3" } : siteAnswer(workId)) });
  await moved.page();
  await moved.step();
  assert.deepEqual(state(moved).queue, ["101", "102", "103"]);
  assert.equal(state(moved).reads, 0);
  await moved.page();
  assert.deepEqual(filledIds(moved), ["101"]);
});

test("the work the reader is on is read like any other, in its turn", async () => {
  // The page itself never reads a summary; the tab showing a chapter of 101
  // reads 101's first page when it is due.
  const h = harness();
  await h.page();
  await h.step();
  assert.deepEqual(readIds(h), ["101"]);
  assert.deepEqual(filledIds(h), ["101"]);
});

test("a work that is gone, signed-in only or has no summary is skipped and the fill carries on", async () => {
  const answers = {
    101: work("101", null, { status: 404 }),
    102: work("102", null, { url: `https://${HOST}/users/login?restricted=true` }),
    103: work("103", null),
    104: siteAnswer("104"),
  };
  const h = harness({ gaps: ["101", "102", "103", "104"], respond: (workId) => answers[workId] });
  await h.page();
  const outcomes = [];
  for (let index = 0; index < 4; index += 1) {
    await h.step();
    outcomes.push(state(h).last.outcome);
  }
  assert.deepEqual(outcomes, ["gone", "restricted", "no_summary", "filled"]);
  assert.deepEqual(filledIds(h), ["104"]);
  assert.equal(state(h).stop, null);
});

test("three unreadable pages in a row pause the fill; a readable one in between resets the count", async () => {
  const unreadable = (workId) => work(workId, null, { page: "other" });
  const h = harness({ gaps: ["1", "2", "3", "4", "5", "6"], respond: (workId) => (workId === "3" ? siteAnswer(workId) : unreadable(workId)) });
  await h.page();
  for (let index = 0; index < 4; index += 1) await h.step();
  assert.equal(state(h).stop, null, "the read of 3 reset the count");
  assert.equal(state(h).misses, 1);
  await h.step();
  await h.step();
  assert.equal(state(h).stop?.reason, "missing");
  assert.equal(state(h).stop.until - state(h).stop.at, STOP_MS);
  assert.equal(MISSES_MAX, 3);
});

test("a challenge pauses the fill for an hour with what stopped it recorded, then it tries the next work", async () => {
  const h = harness({
    respond: (workId, count) => (count === 1
      ? work(workId, null, { status: 403, cfMitigated: "challenge", page: "challenge" })
      : siteAnswer(workId)),
  });
  await h.page();
  await h.step();
  const stopped = state(h);
  assert.equal(stopped.stop.reason, "challenge");
  assert.deepEqual(
    { status: stopped.stop.status, host: stopped.stop.host, path: stopped.stop.path, cf: stopped.stop.cf },
    { status: 403, host: HOST, path: "work", cf: "challenge" },
  );
  assert.equal(stopped.stop.until - stopped.stop.at, STOP_MS);
  assert.deepEqual(stopped.queue, ["102", "103"], "the work that stopped it waits for a later listing");
  await h.advance(STOP_MS - 2 * BACKFILL_GAP_MS);
  await h.step();
  assert.equal(h.site.reads.length, 1, "still paused");
  await h.step();
  assert.deepEqual(readIds(h), ["101", "102"]);
});

test("AO3 asking to wait longer pauses for that long, at most a day; a shorter ask still pauses an hour", async () => {
  const long = harness({ respond: (workId) => work(workId, null, { status: 429, retryAfter: String(3 * 60 * 60) }) });
  await long.page();
  await long.step();
  assert.equal(state(long).stop.until - state(long).stop.at, 3 * 60 * 60_000);
  const huge = harness({ respond: (workId) => work(workId, null, { status: 429, retryAfter: String(7 * 24 * 60 * 60) }) });
  await huge.page();
  await huge.step();
  assert.equal(state(huge).stop.until - state(huge).stop.at, STOP_MAX_MS);
  const short = harness({ respond: (workId) => work(workId, null, { status: 429, retryAfter: "30" }) });
  await short.page();
  await short.step();
  assert.equal(state(short).stop.until - state(short).stop.at, STOP_MS);
});

test("an error, a failed listing or a refused contribution pauses it too, each with its reason", async () => {
  const error = harness({ respond: () => ({ kind: "failed", code: "timeout" }) });
  await error.page();
  await error.step();
  assert.equal(state(error).stop.reason, "error");

  const gaps = harness({ gaps: null });
  await gaps.page();
  assert.equal(state(gaps).stop.reason, "gaps");

  const refused = harness({ contribution: "failed" });
  await refused.page();
  await refused.step();
  assert.equal(state(refused).stop.reason, "send");
  assert.equal(state(refused).last.send, "failed");
});

test("at most 30 pages are read in six hours", async () => {
  const many = Array.from({ length: QUEUE_MAX }, (_, index) => String(1_000 + index));
  const h = harness({ gaps: many });
  await h.page();
  for (let index = 0; index < WINDOW_MAX_READS + 5; index += 1) await h.step();
  assert.equal(h.site.reads.length, WINDOW_MAX_READS);
  await h.advance(WINDOW_MS);
  await h.page();
  assert.equal(h.site.reads.length, WINDOW_MAX_READS + 1, "a new window allows more");
  assert.equal(state(h).reads, 1);
});

test("the gaps are listed again once the queue is empty for a while, or soon after the Library changed", async () => {
  const h = harness({ gaps: ["101"] });
  await h.page();
  await h.step();
  assert.deepEqual(filledIds(h), ["101"]);
  h.ports.gaps = ["201"];
  await h.step();
  assert.equal(h.gapReads.length, 1);
  await h.advance(RELIST_MS);
  await h.page();
  assert.equal(h.gapReads.length, 2, "an empty queue is listed again after a while");
  assert.deepEqual(state(h).queue, ["201"]);

  // An import of open tabs: listed again once RELIST_MIN_MS has passed since the last listing.
  const imported = harness({ gaps: ["101", "102"] });
  await imported.page();
  imported.ports.gaps = ["101", "102", "301"];
  await imported.fill.libraryChanged();
  assert.equal(state(imported).stale, true);
  await imported.step();
  assert.equal(imported.gapReads.length, 1, "not before RELIST_MIN_MS");
  await imported.advance(RELIST_MIN_MS);
  await imported.page();
  assert.equal(imported.gapReads.length, 2);
  assert.equal(state(imported).stale, false);
  assert.ok(state(imported).queue.includes("301"));
});

test("only a save whose reply says Trace has no summary puts the work first", async () => {
  const h = harness();
  await h.page();
  assert.deepEqual(state(h).queue, ["101", "102", "103"]);
  await h.fill.storySaved(savedStory("9"), true, ACCOUNT);
  await h.fill.storySaved(savedStory("9"), undefined, ACCOUNT);
  await h.fill.storySaved(savedStory("9", { hostKind: "ffn" }), false, ACCOUNT);
  await h.fill.storySaved({ ...savedStory("9"), workKey: "ao3:../9" }, false, ACCOUNT);
  assert.deepEqual(state(h).queue, ["101", "102", "103"], "Trace has it, or did not say");
  await h.fill.storySaved(savedStory("9"), false, ACCOUNT);
  assert.deepEqual(state(h).queue, ["9", "101", "102", "103"]);
  assert.equal(state(h).stale, false);
  assert.deepEqual(h.site.reads, [], "a save itself reads nothing");
  await h.fill.storySaved(savedStory("102"), false, ACCOUNT);
  assert.deepEqual(state(h).queue, ["102", "9", "101", "103"], "a listed work moves to the front");
});

test("a saved work without a summary waits for the pacing like any other", async () => {
  const h = harness({ gaps: [] });
  await h.page();
  assert.equal(h.gapReads.length, 1);
  h.fill.saveStarted();
  h.fill.saveEnded();
  await h.fill.storySaved(savedStory("9"), false, ACCOUNT);
  await h.page();
  assert.deepEqual(h.site.reads, [], "nothing during or just after a save");
  await h.advance(SAVE_SETTLE_MS);
  await h.page();
  assert.deepEqual(h.site.reads, [], "nor within a step gap of the listing");
  await h.advance(BACKFILL_GAP_MS - SAVE_SETTLE_MS);
  await h.page();
  assert.deepEqual(readIds(h), ["9"]);
  assert.deepEqual(filledIds(h), ["9"]);
});

test("a work already tried is not put first again, from this tab or another", async () => {
  const h = harness({ gaps: [] });
  await h.page();
  await h.fill.storySaved(savedStory("9"), false, ACCOUNT);
  await h.step();
  assert.deepEqual(readIds(h), ["9"]);
  // The same work saved again, from any tab: the tried list is shared.
  await h.fill.storySaved(savedStory("9"), false, ACCOUNT);
  assert.deepEqual(state(h).queue, []);
  h.restart();
  await h.fill.storySaved(savedStory("9"), false, ACCOUNT);
  assert.deepEqual(state(h).queue, [], "a new background remembers too");
  for (let index = 0; index < 3; index += 1) await h.step();
  assert.deepEqual(readIds(h), ["9"]);
});


test("a save's work is dropped when another account is signed in by its turn", async () => {
  const h = harness({ gaps: [] });
  await h.page();
  await h.fill.storySaved(savedStory("9"), false, null);
  await h.fill.storySaved(savedStory("9"), false, "reader-0:1");
  assert.deepEqual(state(h).queue, [], "made for another account, or for none");

  // The account changes while the save waits its turn behind a running step.
  let release;
  const held = harness({ gaps: [], respond: (workId) => new Promise((resolve) => { release = () => resolve(siteAnswer(workId)); }) });
  await held.page();
  await held.fill.storySaved(savedStory("8"), false, ACCOUNT);
  await held.advance(BACKFILL_GAP_MS);
  const running = held.fill.ao3PageActivity(TAB);
  await settle();
  const saved = held.fill.storySaved(savedStory("9"), false, ACCOUNT);
  held.ports.account = "reader-2:1";
  release();
  await running;
  await saved;
  await settle();
  assert.equal(state(held).queue.includes("9"), false);
});
test("a listing keeps a work a save put first ahead of the others", async () => {
  const h = harness({ gaps: ["101"], random: () => 0 });
  await h.page();
  await h.fill.storySaved(savedStory("9"), false, ACCOUNT);
  h.ports.gaps = ["101", "201", "9", "202"];
  await h.fill.libraryChanged();
  await h.advance(RELIST_MIN_MS);
  await h.page();
  assert.equal(h.gapReads.length, 2);
  assert.deepEqual(state(h).queue.slice(0, 2), ["9", "101"]);
  assert.deepEqual([...state(h).queue].sort(), ["101", "201", "202", "9"]);
  // A waiting work the server no longer lists is dropped.
  h.ports.gaps = ["201"];
  await h.fill.libraryChanged();
  await h.advance(RELIST_MIN_MS);
  await h.page();
  assert.deepEqual(state(h).queue, ["201"]);
});

test("works already tried come last and fresh ones are shuffled, so each listing tries others", async () => {
  const h = harness({ gaps: ["11", "12", "13", "14"], random: () => 0 });
  await h.local.set({ [AO3_SUMMARY_ATTEMPTED_KEY]: { account: "reader-1:1", ids: ["12", "11"] } });
  await h.page();
  // 13 and 14 were never tried (shuffled), then 12 and 11 in the order they were tried.
  assert.deepEqual(state(h).queue, ["14", "13", "12", "11"]);
  await h.step();
  assert.deepEqual(h.local.values[AO3_SUMMARY_ATTEMPTED_KEY], { account: "reader-1:1", ids: ["12", "11", "14"] });
});

test("sign-out removes the state and the tried list; another account starts fresh", async () => {
  const h = harness();
  await h.page();
  await h.step();
  assert.ok(AO3_SUMMARY_STATE_KEY in h.area.values);
  assert.ok(AO3_SUMMARY_ATTEMPTED_KEY in h.local.values);
  await h.fill.clear();
  assert.equal(AO3_SUMMARY_STATE_KEY in h.area.values, false);
  assert.equal(AO3_SUMMARY_ATTEMPTED_KEY in h.local.values, false);

  const other = harness();
  await other.page();
  await other.step();
  other.ports.account = "reader-2:1";
  other.ports.gaps = ["900"];
  await other.step();
  assert.equal(state(other).account, "reader-2:1");
  assert.deepEqual(state(other).queue, ["900"], "listed afresh for the new account");
  assert.equal(AO3_SUMMARY_ATTEMPTED_KEY in other.local.values, false, "the other account's tried list is gone");
  await other.step();
  assert.deepEqual(other.local.values[AO3_SUMMARY_ATTEMPTED_KEY], { account: "reader-2:1", ids: ["900"] });

  const signedOut = harness();
  await signedOut.page();
  signedOut.ports.account = null;
  await signedOut.step();
  assert.equal(AO3_SUMMARY_STATE_KEY in signedOut.area.values, false);
  assert.deepEqual(signedOut.site.reads, []);
});

test("a sign-out during a read writes nothing back and sends nothing", async () => {
  let release;
  const h = harness({ respond: (workId) => new Promise((resolve) => { release = () => resolve(siteAnswer(workId)); }) });
  await h.page();
  await h.advance(BACKFILL_GAP_MS);
  const running = h.fill.ao3PageActivity(TAB);
  await settle();
  await h.fill.clear();
  release();
  await running;
  await settle();
  assert.deepEqual(h.contributions, []);
  assert.equal(AO3_SUMMARY_STATE_KEY in h.area.values, false);
});

test("only ids, counters and answer facts are stored, never page text or a summary", async () => {
  const h = harness();
  await h.page();
  await h.step();
  for (const write of [...h.area.writes, ...h.local.writes]) {
    assert.doesNotMatch(write, /Summary of/);
  }
  assert.deepEqual(Object.keys(state(h)).sort(), [
    "account", "last", "lastRequestAt", "lastStepAt", "listedAt", "misses", "queue", "reads", "stale", "stop", "v", "windowStart",
  ]);
});

test("without session storage the state lives in local storage and expires", async () => {
  const area = memoryArea();
  const clock = { at: NOW };
  const store = new StoredFillState(area, { ttlMs: LOCAL_STATE_TTL_MS, now: () => clock.at });
  const h = harness({ area, clock });
  await h.page();
  const kept = await store.read();
  await store.write(kept);
  assert.equal(area.values[AO3_SUMMARY_STATE_KEY].exp, NOW + LOCAL_STATE_TTL_MS);
  clock.at += LOCAL_STATE_TTL_MS;
  assert.equal(await store.read(), null);
  assert.equal(AO3_SUMMARY_STATE_KEY in area.values, false);
});

test("every outcome the fill records survives being stored and read back", async () => {
  for (const code of ["tab_gone", "tab_not_ao3", "not_allowed", "no_result"]) {
    const h = harness({ respond: () => ({ kind: "failed", code }) });
    await h.page();
    await h.step();
    assert.equal(state(h).last.outcome, code);
    assert.notEqual(await new StoredFillState(h.area).read(), null, code);
  }
});

test("a stored state of the wrong shape is ignored", async () => {
  const area = memoryArea();
  area.values[AO3_SUMMARY_STATE_KEY] = { v: 1, account: "reader-1:1", queue: ["../1"] };
  assert.equal(await new StoredFillState(area).read(), null);
  area.values[AO3_SUMMARY_STATE_KEY] = { v: 3, account: "reader-1:1", pending: [], queue: [] };
  assert.equal(await new StoredFillState(area).read(), null);
});

// --- Wired into the session runtime ------------------------------------------

async function wiredRuntime({
  gaps = ["7038840"],
  summary = "A ledger of fog.",
  tabUrl = "https://archiveofourown.org/tags/Sherlock/works",
  summaryKnown,
} = {}) {
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
  const api = async (url, options = {}) => {
    const route = new URL(url).pathname;
    apiCalls.push({ route, body: options.body ? JSON.parse(options.body) : undefined });
    if (route === "/api/extension/account") return json({ account_id: "account-a", pro: true, library_count: 0 });
    if (route === "/api/extension/library-overlay") {
      return json({ success: true, data: { entries: {}, syncVersion: "2026-10-21T00:00:00.000Z" } });
    }
    if (route === "/api/extension/library/metadata-refresh") {
      return json({ success: true, data: { updated: 1, ignored: 0 } });
    }
    if (route === "/api/extension/library/summary-gaps") {
      return json({ success: true, data: { filled: 0, sourceStoryIds: gaps } });
    }
    if (route === "/api/extension/track") {
      const workKey = `ao3:${JSON.parse(options.body).item.u.split("/works/")[1]}`;
      return json({ success: true, data: {
        entry_id: TRACK_ENTRY.entryId, type: "created", work_key: workKey, entry: TRACK_ENTRY,
        syncVersion: "2026-10-21T00:00:01.000Z",
        ...(summaryKnown === undefined ? {} : { summary_known: summaryKnown }),
      } });
    }
    return json({ success: false }, 404);
  };
  const scripts = [];
  const controller = installSessionRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} }, async getPlatformInfo() { return { os: "mac" }; } },
    tabs: {
      async query() { return []; },
      async sendMessage() { return null; },
      async get(tabId) { return { id: tabId, url: tabUrl }; },
    },
    scripting: {
      async executeScript(details) {
        scripts.push({ target: details.target, args: details.args.slice(0, 2) });
        const [host, workId] = details.args;
        return [{ result: {
          ok: true, status: 200, url: `https://${host}/works/${workId}?view_adult=true`, contentType: "text/html",
          cfMitigated: null, retryAfter: null, page: "work", summary,
        } }];
      },
    },
    permissions: { async getAll() { return { origins: [] }; }, async contains() { return true; } },
    alarms: { async clear() { return true; } },
    storageArea: { async get() { return {}; }, async set() {}, async remove() {} },
    databaseFactory,
    privateDatabase: database,
    storageMode: "promise",
    fetch: api,
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
    ffnSummaryFill: { sessionArea: memoryArea() },
    ao3SummaryFill: { sessionArea: memoryArea() },
  });
  await controller.start();
  const sender = { frameId: 0, tab: { id: 3, url: tabUrl } };
  /** Any message from the AO3 page counts as the page speaking. */
  const speak = async () => {
    await controller.handle({ type: "TRACE_SESSION_GET_SNAPSHOT" }, sender);
    await settle();
  };
  /** The reader saves a chapter 2+ page of `workId`, which shows no work summary. */
  const save = (workId) => controller.handle({
    type: "TRACE_QUICK_ADD",
    payload: {
      s: "ao3",
      at: "2026-10-21T00:00:00.000Z",
      item: {
        src: "ao3", ctx: "story", u: `https://archiveofourown.org/works/${workId}`, t: "A work",
        chn: 2, chu: `https://archiveofourown.org/works/${workId}/chapters/2`, sm: null,
      },
    },
  }, sender);
  return { controller, scripts, apiCalls, speak, save };
}

const TRACK_ENTRY = {
  status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED",
  entryId: "00000000-0000-4000-8000-000000000456", rating: 0,
  privateContext: { hasNotes: false, tagCount: 0 }, chapters: { current: 2, total: 12 },
};

test("a save Trace answers with summary_known false is read in the AO3 tab at the next step; any other answer reads nothing", async () => {
  for (const summaryKnown of [false, true, undefined]) {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const { scripts, apiCalls, speak, save } = await wiredRuntime({
        gaps: [], summaryKnown, tabUrl: "https://archiveofourown.org/works/555/chapters/2",
      });
      await speak();
      const saved = await save("555");
      assert.equal(saved.ok, true, JSON.stringify(saved));
      await settle();
      assert.deepEqual(scripts, [], "nothing is read during or just after the save");
      now += BACKFILL_GAP_MS;
      await speak();
      const refreshes = apiCalls.filter(({ route }) => route === "/api/extension/library/metadata-refresh");
      if (summaryKnown === false) {
        assert.deepEqual(scripts, [{ target: { tabId: 3, frameIds: [0] }, args: ["archiveofourown.org", "555"] }]);
        assert.deepEqual(refreshes.map(({ body }) => body.items.map(({ sourceStoryId }) => sourceStoryId)), [["555"]]);
      } else {
        assert.deepEqual(scripts, [], `summary_known ${summaryKnown}`);
        assert.deepEqual(refreshes, []);
      }
    } finally {
      Date.now = realNow;
    }
  }
});

test("an AO3 page speaking lists the AO3 gaps, reads one in that tab, and sends only identity and summary", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { scripts, apiCalls, speak } = await wiredRuntime();
    await speak();
    const listings = apiCalls.filter(({ route }) => route === "/api/extension/library/summary-gaps");
    assert.deepEqual(listings.map(({ body }) => body), [{ source: "ao3" }]);
    assert.deepEqual(scripts, []);

    now += BACKFILL_GAP_MS;
    await speak();
    assert.deepEqual(scripts, [{ target: { tabId: 3, frameIds: [0] }, args: ["archiveofourown.org", "7038840"] }]);
    const refreshes = apiCalls.filter(({ route }) => route === "/api/extension/library/metadata-refresh");
    assert.deepEqual(refreshes.map(({ body }) => body), [{
      items: [{
        source: "ao3",
        sourceStoryId: "7038840",
        url: "https://archiveofourown.org/works/7038840",
        summary: "A ledger of fog.",
      }],
    }]);
  } finally {
    Date.now = realNow;
  }
});

test("a FanFiction.net page never runs the AO3 fill", async () => {
  const { scripts, apiCalls, speak } = await wiredRuntime({ tabUrl: "https://www.fanfiction.net/s/1/1/" });
  await speak();
  const listings = apiCalls.filter(({ route }) => route === "/api/extension/library/summary-gaps");
  assert.equal(listings.some(({ body }) => body.source === "ao3"), false);
  assert.equal(scripts.some(({ args }) => args[0] === "archiveofourown.org"), false);
});
