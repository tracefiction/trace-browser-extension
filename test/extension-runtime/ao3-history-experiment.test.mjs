import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AO3_HISTORY_EXPERIMENT_MESSAGE,
  AO3_HISTORY_EXPERIMENT_STATE_KEY,
  Ao3HistoryExperiment,
  LOST_AFTER_MS,
  MAX_CONSECUTIVE_RETRIES,
  PAGE_GAP_JITTER_MS,
  PAGE_GAP_MS,
  RETRY_MAX_MS,
  SAVE_SETTLE_MS,
  answerNote,
  classifyHistoryAnswer,
  describeSummaryFill,
  historyPageURL,
  installAo3HistoryExperiment,
  medianInterval,
  readHistoryPage,
  retryAfterMs,
} from "../../.trace-build/extension-runtime/ao3-history-experiment.mjs";
import { FFN_SUMMARY_STATE_KEY } from "../../.trace-build/extension-runtime/ffn-summary-fill.mjs";

// Invented works, people and account throughout; no archive capture.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const USER = "Synthetic_Reader";
const TAB = 42;

const escapeHTML = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function work(id, { title = `Invented work ${id}`, author = "Synthetic_Quill", later = false } = {}) {
  const visit = `Last visited: 08 Oct 2026 ${later ? "(Marked for Later.) " : ""}(Latest version.) Visited 3 times`;
  return `<li id="work_${id}" class="reading work blurb group" role="article"><div class="header module">` +
    `<h4 class="heading"><a href="/works/${id}">${escapeHTML(title)}</a> by <a rel="author" href="/users/${author}/pseuds/${author}">${escapeHTML(author)}</a></h4>` +
    `<h5 class="fandoms heading"><a class="tag" href="/tags/invented/works">Invented Lanterns</a></h5>` +
    `<ul class="required-tags"><li><span class="rating" title="General Audiences"><span class="text">General Audiences</span></span></li></ul></div>` +
    `<ul class="tags commas"><li class="freeforms"><a class="tag" href="/tags/found/works">Found Family</a></li></ul>` +
    `<blockquote class="userstuff summary"><p>Invented summary ${id}.</p></blockquote>` +
    `<dl class="stats"><dd class="words">12,345</dd><dd class="chapters">3/3</dd></dl>` +
    `<div class="user module group"><h4 class="viewed heading">${escapeHTML(visit)}</h4></div></li>`;
}

function page(rows, { next = null, user = USER } = {}) {
  const nextLink = next === null ? '<li class="next disabled">Next →</li>' : `<li class="next"><a rel="next" href="/users/${user}/readings?page=${next}">Next →</a></li>`;
  return `<!doctype html><html><head><title>History | Synthetic</title></head><body class="logged-in">` +
    `<div id="header"><a href="/users/${user}/readings">My History</a></div>` +
    `<div id="main" class="readings-index dashboard region"><ol class="reading work index group">${rows.join("\n")}</ol>` +
    `<ol class="pagination actions">${nextLink}</ol></div><div id="footer"></div></body></html>`;
}

function answer(html, { url, status = 200, retryAfter = null, cfMitigated = null, server = null, cfRay = null, title = null, contentType = "text/html; charset=utf-8" } = {}) {
  return { kind: "response", status, url, html, chars: html.length, retryAfter, cfMitigated, contentType, server, cfRay, title };
}

const pageURL = (n) => historyPageURL(USER, n);

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, set: (value) => { now = value; }, advance: (ms) => { now += ms; } };
}

function memoryStore({ failWhen = () => false } = {}) {
  const data = new Map();
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))])),
    set: async (items) => {
      if (failWhen(items)) throw new Error("quota");
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    remove: async (keys) => { for (const key of keys) data.delete(key); },
    keys: async () => [...data.keys()],
  };
}

/**
 * An AO3 that answers from a script, one function per request in order,
 * whether the background or the page loop in the tab asks.
 */
function harness({ answers, store = memoryStore(), clock = fakeClock(), saves = { inFlight: 0, lastEndedAt: 0 }, bootId = "boot-1" }) {
  const requests = [];
  const loops = [];
  let ids = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const respond = async (pathTaken, url, extra = {}) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    requests.push({ path: pathTaken, url, at: clock.now(), ...extra });
    try {
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      return await next({ url, path: pathTaken });
    } finally {
      inFlight -= 1;
    }
  };
  const experiment = new Ao3HistoryExperiment({
    store,
    clock,
    random: () => 0.5,
    newId: () => `id-${bootId}-${++ids}`,
    bootId,
    saveActivity: () => saves,
    loadInBackground: (url) => respond("background", url),
    async ensureLoop(tabId) { loops.push(tabId); return "started"; },
    alarm: { start() {}, stop() {} },
  });
  /** The page loop in the AO3 tab: tick, fetch when told, wait as told. */
  async function drive({ tabId = TAB, limit = 300, until = () => false } = {}) {
    for (let index = 0; index < limit; index += 1) {
      let next = await experiment.tick(tabId);
      if (typeof next.fetch === "string") {
        next = await experiment.answer(next.token, await respond("tab", next.fetch, { tabId }));
      }
      if (next.stop || until()) return next;
      clock.advance(Math.max(next.wait, 500));
    }
    return null;
  }
  return { experiment, requests, loops, store, clock, saves, drive, maxInFlight: () => maxInFlight };
}

const ok = (rows, next = null) => ({ url }) => answer(page(rows, { next }), { url });
const stateOf = (store) => store.data.get(AO3_HISTORY_EXPERIMENT_STATE_KEY);
const login = ({ url }) => answer("<html></html>", { url: "https://archiveofourown.org/users/login" });

// --- Reading pages ---------------------------------------------------------------

test("reads the repository's invented History page without counting required tags as tags", () => {
  const html = fs.readFileSync(path.join(FIXTURES, "ao3_history.html"), "utf8");
  const read = readHistoryPage(html, "Ink_Reader_Test", 1);
  assert.equal(read.kind, "page");
  assert.equal(read.nextPage, null);
  assert.equal(read.deleted, 1);
  assert.equal(read.markedForLater, 1);
  assert.equal(read.unreadable, 0);
  const first = read.records.find((record) => record.id === "41000001");
  assert.deepEqual(first, {
    id: "41000001",
    t: "The Lamplighter's Ledger",
    a: ["Quill_Fennimore"],
    f: ["Sherlock Holmes - Arthur Conan Doyle"],
    g: ["No Archive Warnings Apply", "Slow Burn"],
    s: "An invented summary for a test fixture.",
    w: 24310,
    ch: "6/6",
    lv: "08 Oct 2026",
    vc: 3,
  });
  assert.equal(read.records.find((record) => record.id === "41000002").vc, 1);
  assert.equal(read.records.find((record) => record.id === "41000004").vc, 1204);
  assert.equal(read.records.some((record) => record.id === "41000003"), false, "Marked for Later is counted, not kept");
});

test("follows only the next page of the same History", () => {
  assert.equal(readHistoryPage(page([work(1)], { next: 2 }), USER, 1).nextPage, 2);
  assert.equal(readHistoryPage(page([work(1)]), USER, 3).nextPage, null);
  assert.deepEqual(readHistoryPage(page([work(1)], { next: 5 }), USER, 1), { kind: "stop", code: "pagination_unexpected" });
  assert.deepEqual(readHistoryPage(page([work(1)], { next: 2, user: "Someone_Else" }), USER, 1), { kind: "stop", code: "pagination_unexpected" });
  assert.deepEqual(readHistoryPage("<html><body><form action=\"/users/login\"></form></body></html>", USER, 1), { kind: "stop", code: "signed_out" });
  assert.deepEqual(readHistoryPage("<html><body><div id=\"main\" class=\"works-show\"></div></body></html>", USER, 1), { kind: "stop", code: "unrecognized_page" });
});

test("classifies AO3's answers: slow down, challenge, signed out, wrong host, redirect", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const html = page([work(1)]);
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: pageURL(1), status: 429, retryAfter: "120" }), USER, 1, now),
    { kind: "retry", code: "rate_limited", retryAfterMs: 120_000 });
  assert.equal(retryAfterMs("Fri, 16 Oct 2026 12:01:00 GMT", now), 60_000);
  assert.equal(retryAfterMs("soon", now), null);
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: pageURL(1), cfMitigated: "challenge" }), USER, 1, now), { kind: "stop", code: "challenge" });
  const challenge = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>";
  assert.deepEqual(classifyHistoryAnswer(answer(challenge, { url: pageURL(1), status: 403 }), USER, 1, now), { kind: "stop", code: "challenge" });
  assert.deepEqual(classifyHistoryAnswer(answer("<html></html>", { url: "https://archiveofourown.org/users/login?return_to=x" }), USER, 1, now), { kind: "stop", code: "signed_out" });
  const home = '<html><body class="logged-out"><form action="/users/login" id="new_user_session_small"></form></body></html>';
  assert.deepEqual(classifyHistoryAnswer(answer(home, { url: "https://archiveofourown.org/" }), USER, 1, now), { kind: "stop", code: "signed_out" });
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: "https://example.org/users/x/readings" }), USER, 1, now), { kind: "stop", code: "wrong_host" });
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: "https://archiveofourown.org/users/Synthetic_Reader" }), USER, 1, now), { kind: "stop", code: "redirected" });
  assert.deepEqual(classifyHistoryAnswer({ kind: "failed", code: "timeout" }, USER, 1, now), { kind: "retry", code: "timeout", retryAfterMs: null });
  assert.equal(classifyHistoryAnswer(answer(html, { url: pageURL(1) }), USER, 1, now).kind, "page");
});

// --- The run, paced by the page loop ------------------------------------------

test("start puts the loop into the AO3 tab, which reads every page once, 8 to 10 seconds apart", async () => {
  const h = harness({ answers: [ok([work(1), work(2)], 2), ok([work(3)], 3), ok([work(4)])] });
  await h.experiment.start(USER, TAB);
  assert.deepEqual(h.loops, [TAB]);
  assert.equal(h.requests.length, 0, "the background asks nothing by itself");
  await h.drive();
  assert.deepEqual(h.requests.map((r) => r.url), [pageURL(1), pageURL(2), pageURL(3)]);
  assert.ok(h.requests.every((r) => r.path === "background"));
  assert.equal(h.maxInFlight(), 1);
  for (let index = 1; index < h.requests.length; index += 1) {
    const gap = h.requests[index].at - h.requests[index - 1].at;
    assert.ok(gap >= PAGE_GAP_MS && gap <= PAGE_GAP_MS + PAGE_GAP_JITTER_MS, `gap ${gap}`);
  }
  const state = stateOf(h.store);
  assert.equal(state.status, "finished");
  assert.equal(state.reason, "reached_last_page");
  assert.equal(state.counts.pagesRead, 3);
  assert.equal(state.counts.distinct, 4);
  assert.equal(state.probes.background, "ok");
  assert.equal(state.timing.requests, 3);
  assert.equal(state.timing.answers, 3);
  assert.equal(state.inFlight, null);
  assert.deepEqual(h.store.data.get("traceAo3HistoryExperimentV1:page:1").map((r) => r.id), ["1", "2"]);
  assert.deepEqual(await h.experiment.tick(TAB), { stop: true }, "the loop is told to stop");
});

test("a work on two pages is kept once", async () => {
  const h = harness({ answers: [ok([work(1), work(2)], 2), ok([work(2), work(3)])] });
  await h.experiment.start(USER, TAB);
  await h.drive();
  const state = stateOf(h.store);
  assert.equal(state.counts.rows, 4);
  assert.equal(state.counts.distinct, 3);
  assert.equal(state.counts.duplicates, 1);
  assert.deepEqual(h.store.data.get("traceAo3HistoryExperimentV1:page:2").map((r) => r.id), ["3"]);
});

test("a 429 waits at least Retry-After, doubles the gap, and three in a row pause the run", async () => {
  const slowDown = ({ url }) => answer("", { url, status: 429, retryAfter: "90" });
  const h = harness({ answers: [ok([work(1)], 2), slowDown, ok([work(2)], 3), slowDown, slowDown, slowDown] });
  await h.experiment.start(USER, TAB);
  await h.drive();
  const [, limited, after] = h.requests;
  assert.ok(after.at - limited.at >= 90_000, "Retry-After is honoured");
  let state = stateOf(h.store);
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "rate_limited");
  assert.equal(state.pace.rateLimited, 1 + MAX_CONSECUTIVE_RETRIES);
  assert.ok(state.timing.gapMs >= PAGE_GAP_MS * 4, "every later page waits longer");
  // The saved retry deadline still holds after Resume.
  h.clock.advance(1_000);
  const resumeAt = h.clock.now();
  const due = state.timing.dueAt;
  const h2 = harness({ answers: [ok([work(3)])], store: h.store, clock: h.clock });
  await h2.experiment.resume(TAB);
  await h2.drive();
  assert.ok(due - resumeAt >= 60_000, "the backoff deadline outlives the pause");
  assert.ok(h2.requests[0].at >= due, "no request before the saved deadline");
  state = stateOf(h.store);
  assert.equal(state.status, "finished");
});

test("a Retry-After longer than 15 minutes pauses instead of waiting", async () => {
  const h = harness({ answers: [ok([work(1)], 2), ({ url }) => answer("", { url, status: 503, retryAfter: String(RETRY_MAX_MS / 1000 + 60) })] });
  await h.experiment.start(USER, TAB);
  await h.drive();
  const state = stateOf(h.store);
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "retry_later");
  assert.ok(state.timing.dueAt >= h.requests[1].at + RETRY_MAX_MS + 60_000);
});

test("a challenge stops the run, and the alarm or the page loop asks nothing more", async () => {
  const h = harness({ answers: [ok([work(1)], 2), ({ url }) => answer("<title>Just a moment...</title>", { url, status: 403 })] });
  await h.experiment.start(USER, TAB);
  await h.drive();
  h.clock.advance(3_600_000);
  await h.experiment.wake("alarm");
  await h.drive();
  assert.equal(h.requests.length, 2);
  assert.equal(stateOf(h.store).reason, "challenge");
  assert.equal(stateOf(h.store).errors.challenge, 1);
});

test("nothing is requested while a save is under way, nor just after", async () => {
  const saves = { inFlight: 1, lastEndedAt: 0 };
  const h = harness({ answers: [ok([work(1)])], saves });
  await h.experiment.start(USER, TAB);
  for (let index = 0; index < 3; index += 1) {
    const next = await h.experiment.tick(TAB);
    assert.ok(next.wait > 0);
    h.clock.advance(next.wait);
  }
  assert.equal(h.requests.length, 0);
  saves.inFlight = 0;
  saves.lastEndedAt = h.clock.now();
  await h.drive();
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests[0].at - saves.lastEndedAt >= SAVE_SETTLE_MS);
  assert.ok(stateOf(h.store).pace.waitsForSave >= 3);
});

// --- A background that comes and goes ----------------------------------------------

test("the checkpoint carries a run into a restarted background, at the same pace", async () => {
  const store = memoryStore();
  const clock = fakeClock();
  const first = harness({ answers: [ok([work(1), work(2)], 2)], store, clock, bootId: "boot-1" });
  await first.experiment.start(USER, TAB);
  await first.experiment.tick(TAB);
  assert.equal(first.requests.length, 1);
  // Safari unloads the background; the alarm starts a new one.
  const second = harness({ answers: [ok([work(2), work(3)])], store, clock, bootId: "boot-2" });
  await second.experiment.wake("alarm");
  assert.equal(second.requests.length, 0, "woken by the alarm: it only logs and puts the loop back");
  assert.deepEqual(second.loops, [TAB]);
  await second.drive();
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].url, pageURL(2));
  assert.ok(second.requests[0].at - first.requests[0].at >= PAGE_GAP_MS);
  const state = stateOf(store);
  assert.equal(state.status, "finished");
  assert.equal(state.counts.distinct, 3);
  assert.equal(state.counts.duplicates, 1);
  assert.deepEqual(state.lifetime.boots, ["boot-1", "boot-2"]);
  assert.equal(state.lifetime.revivedBy.alarm, 1);
});

test("a request the background was unloaded under is counted lost, not answered, and the pace holds", async () => {
  const store = memoryStore();
  const clock = fakeClock();
  const first = harness({ answers: [() => new Promise(() => {})], store, clock, bootId: "boot-1" });
  await first.experiment.start(USER, TAB);
  void first.experiment.tick(TAB);
  await flush();
  assert.equal(first.requests.length, 1);
  const sentAt = clock.now();

  clock.advance(5_000);
  const second = harness({ answers: [ok([work(1)])], store, clock, bootId: "boot-2" });
  const next = await second.experiment.tick(TAB);
  assert.ok(next.wait > 0, "the lost request's own time limit and the gap are waited out");
  let state = stateOf(store);
  assert.equal(state.timing.lost, 1);
  assert.equal(state.errors.lost_request, 1);
  assert.equal(state.inFlight, null);

  await second.drive();
  assert.ok(second.requests[0].at - sentAt >= LOST_AFTER_MS + PAGE_GAP_MS);
  state = stateOf(store);
  assert.equal(state.timing.requests, 2);
  assert.equal(state.timing.answers, 1, "answers are counted apart from requests");
  const view = await second.experiment.view();
  assert.match(view.report, /Requests: 2/);
  assert.match(view.report, /Answers: 1/);
  assert.match(view.report, /Lost requests: 1/);
});

test("a tab answer that never comes is counted lost after its time limit, and a late one is not kept", async () => {
  const h = harness({ answers: [login, ok([work(1)])] });
  await h.experiment.start(USER, TAB);
  await h.drive({ until: () => stateOf(h.store).path === "probe_tab" });
  h.clock.advance(PAGE_GAP_MS + PAGE_GAP_JITTER_MS);
  const told = await h.experiment.tick(TAB);
  assert.equal(typeof told.fetch, "string");
  // The tab moved on before answering.
  h.clock.advance(LOST_AFTER_MS + 1);
  await h.experiment.tick(TAB);
  assert.equal(stateOf(h.store).timing.lost, 1);
  await h.experiment.answer(told.token, answer(page([work(9)]), { url: pageURL(1) }));
  assert.equal(stateOf(h.store).counts.pagesRead, 0);
  await h.drive();
  assert.equal(stateOf(h.store).status, "finished");
});

test("pause stops requests, resume carries on, and the pause is not counted as running time", async () => {
  const h = harness({ answers: [ok([work(1)], 2), ok([work(2)])] });
  await h.experiment.start(USER, TAB);
  await h.experiment.tick(TAB);
  await h.experiment.pause();
  h.clock.advance(600_000);
  await h.experiment.wake("alarm");
  assert.deepEqual(await h.experiment.tick(TAB), { stop: true });
  assert.equal(h.requests.length, 1);
  assert.equal(stateOf(h.store).reason, "paused_by_you");
  await h.experiment.resume(TAB);
  await h.drive();
  assert.equal(h.requests.length, 2);
  const state = stateOf(h.store);
  assert.equal(state.status, "finished");
  assert.ok(state.timing.pausedMs >= 590_000);
  assert.equal(state.timing.maxGapMs, 0, "the gap across a pause is not counted");
});

test("cancel during a request keeps nothing, then and afterwards", async () => {
  let release;
  const h = harness({ answers: [ok([work(1)], 2), ({ url }) => new Promise((resolve) => { release = () => resolve(answer(page([work(2)], { next: 3 }), { url })); })] });
  await h.experiment.start(USER, TAB);
  const first = await h.experiment.tick(TAB);
  h.clock.advance(first.wait);
  const pending = h.experiment.tick(TAB);
  await flush();
  assert.equal(h.requests.length, 2);
  await h.experiment.clear();
  release();
  assert.deepEqual(await pending, { stop: true });
  assert.equal(h.store.data.size, 0, "every key is gone");
  assert.equal((await h.experiment.view()).status, "idle");
});

test("a page that cannot be stored pauses without moving past it", async () => {
  const store = memoryStore({ failWhen: (items) => "traceAo3HistoryExperimentV1:page:2" in items });
  const h = harness({ answers: [ok([work(1)], 2), ok([work(2)], 3)], store });
  await h.experiment.start(USER, TAB);
  await h.drive();
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "storage_write_failed");
  assert.equal(state.nextPage, 2);
  assert.equal(state.counts.distinct, 1);
  assert.equal(state.storage.writeFailures, 1);
});

// --- The background probe and the tab --------------------------------------------

test("a background that is not signed in hands over to the page loop's own requests", async () => {
  const h = harness({ answers: [login, ok([work(1)], 2), ok([work(2)])] });
  await h.experiment.start(USER, TAB);
  await h.drive();
  assert.deepEqual(h.requests.map((r) => r.path), ["background", "tab", "tab"]);
  assert.ok(h.requests.slice(1).every((r) => r.tabId === TAB));
  const state = stateOf(h.store);
  assert.deepEqual(state.probes, { background: "signed_out", tab: "ok" });
  assert.equal(state.status, "finished");
});

test("a 5xx from the background probe tries the tab instead of waiting", async () => {
  for (const status of [502, 503, 520]) {
    const h = harness({ answers: [({ url }) => answer("<html><head><title>Bad gateway</title></head></html>", { url, status }), ok([work(1)])] });
    await h.experiment.start(USER, TAB);
    await h.drive();
    assert.deepEqual(h.requests.map((r) => r.path), ["background", "tab"], `status ${status}`);
    const state = stateOf(h.store);
    assert.equal(state.probes.tab, "ok");
    assert.match(state.probes.background, /^(?:server_error|unavailable)$/);
    assert.equal(state.pace.backoffs, 0, "no backoff for a probe that moved on");
    assert.equal(state.lastAnswer.status, status);
    assert.equal(state.status, "finished");
  }
});

test("when neither can read the History, the run pauses and says so", async () => {
  const h = harness({ answers: [login, login] });
  await h.experiment.start(USER, TAB);
  await h.drive();
  assert.equal(stateOf(h.store).reason, "no_working_path");
});

// --- What the results say -----------------------------------------------------------

test("an answer that is not a page is recorded as facts, with no account name or work title", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const note = answerNote(answer("x".repeat(2_048), {
    url: "https://archiveofourown.org/users/login?return_to=%2Fusers%2FSynthetic_Reader%2Freadings",
    status: 200, contentType: "text/html; charset=utf-8", server: "cloudflare", cfRay: "8abc123def-LHR",
    title: `  Log in as ${USER} | Archive of Our Own and a very long tail that goes on and on  `,
  }), "signed_out", USER, now);
  assert.deepEqual({ ...note, title: undefined }, {
    code: "signed_out", status: 200, host: "archiveofourown.org", path: "login", type: "text/html",
    length: 2_048, cf: null, server: "cloudflare", ray: "8abc123def-LHR", title: undefined, at: now,
  });
  assert.ok(note.title.length <= 60);
  assert.equal(note.title.includes(USER), false);
  assert.match(note.title, /^Log in as ‹you› \| Archive of Our Own/);
  const workPage = answerNote(answer("", { url: "https://archiveofourown.org/works/123", title: "A Private Title" }), "redirected", USER, now);
  assert.equal(workPage.title, null);
  assert.equal(workPage.path, "other");
  assert.equal(answerNote(answer("", { url: `https://archiveofourown.org/users/${USER}/readings?page=2` }), "http_error", USER, now).path, "readings");
  assert.equal(answerNote({ kind: "failed", code: "timeout" }, "timeout", USER, now).status, null);
});

test("wake-ups are logged by source, with their count and median interval", async () => {
  assert.equal(medianInterval([]), null);
  assert.equal(medianInterval([10]), null);
  assert.equal(medianInterval([0, 60_000, 540_000, 600_000]), 60_000);
  assert.equal(medianInterval([0, 100, 400]), 200);

  const h = harness({ answers: [] });
  await h.experiment.start(USER, TAB);
  for (const gap of [0, 8 * 60_000, 8 * 60_000, 9 * 60_000]) {
    h.clock.advance(gap);
    await h.experiment.wake("alarm");
  }
  await h.experiment.wake("sheet", TAB);
  const state = stateOf(h.store);
  assert.equal(state.wakes.alarm.n, 4);
  assert.equal(state.wakes.alarm.t.length, 4);
  const view = await h.experiment.view();
  const line = view.lines.find(([label]) => label === "Wake-ups")[1];
  assert.match(line, /alarm 4 \(median 8 min 0 s\)/);
  assert.match(line, /sheet 1/);
  assert.match(view.report, /Wake-ups: /);
});

test("the copied results carry counts, times, codes and the last answer, never the account, titles or authors", async () => {
  const h = harness({
    answers: [
      ok([work(1, { title: "Lantern Secret Title", author: "Hidden_Author_Name" })], 2),
      ({ url }) => answer("", { url, status: 429, retryAfter: "60", server: "nginx", title: `${USER} | Busy` }),
      ok([work(2, { title: "Second Private Title" })]),
    ],
  });
  await h.experiment.start(USER, TAB);
  await h.drive();
  const view = await h.experiment.view();
  const copied = [view.report, ...view.lines.flat()].join("\n");
  for (const secret of [USER, "Lantern Secret Title", "Hidden_Author_Name", "Second Private Title", "/works/", "/users/"]) {
    assert.equal(copied.includes(secret), false, `the results mention ${secret}`);
  }
  assert.match(view.report, /Pages read: 2/);
  assert.match(view.report, /Different works: 2/);
  assert.match(view.report, /429 answers: 1/);
  assert.match(view.report, /Errors: rate_limited×1/);
  assert.match(view.report, /Last answer: rate_limited · 429 · archiveofourown\.org readings · text\/html · 0\.0 KB · cf-mitigated none · server nginx · “‹you› \| Busy” · \d\d:\d\d:\d\d/);
});

test("the summary fill's record reads as one line: last step, stop and what waits", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(describeSummaryFill(undefined, now), "nothing yet");
  const fill = {
    v: 3, account: "a:1", pending: [{ s: "1", a: "2" }], queue: [], listed: false, backfills: 0, saves: 1,
    lastRequestAt: now - 60_000, lastBackfillAt: 0,
    stop: { reason: "challenge", status: 403, host: "m.fanfiction.net", path: "author", cf: "challenge", at: now - 60_000, until: now + 59 * 60_000 },
    last: { trigger: "save", stage: "author_list", outcome: "challenge", status: 403, host: "m.fanfiction.net", path: "author", cf: "challenge", rows: null, found: null, send: null, at: now - 60_000 },
  };
  const line = describeSummaryFill(fill, now);
  assert.match(line, /^save · author_list · challenge · 403 · m\.fanfiction\.net author · cf-mitigated challenge · \d\d:\d\d:\d\d · stopped: challenge/);
  assert.match(line, /tries again \d\d:\d\d:\d\d · waiting: 1 saved, 0 backfill$/);
  const filled = describeSummaryFill({
    ...fill, stop: null, pending: [],
    last: { ...fill.last, stage: "send", outcome: "filled", status: 200, cf: null, rows: 12, found: 1, send: "accepted" },
  }, now);
  assert.match(filled, /^save · send · filled · 200 · m\.fanfiction\.net author · rows 12 · found 1 · sent accepted · \d\d:\d\d:\d\d · waiting: 0 saved, 0 backfill$/);
});

// --- Safari wiring -------------------------------------------------------------------

function mapArea(map) {
  return {
    async get(keys) {
      if (keys === null) return Object.fromEntries(map);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => map.has(key)).map((key) => [key, structuredClone(map.get(key))]));
    },
    async set(items) { for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key); },
  };
}

function wiring({ tabUrl = "https://archiveofourown.org/works/1", scriptResult = () => "started" } = {}) {
  const listeners = [];
  const session = new Map([[FFN_SUMMARY_STATE_KEY, {
    v: 3, account: "a:1", pending: [], queue: [], listed: true, backfills: 0, saves: 1, lastRequestAt: 0, lastBackfillAt: 0,
    stop: null,
    last: { trigger: "page", stage: "send", outcome: "filled", status: 200, host: "www.fanfiction.net", path: "author", cf: null, rows: 4, found: 1, send: "accepted", at: Date.now() },
  }]]);
  const scripts = [];
  const experiment = installAo3HistoryExperiment({
    runtime: { id: "trace-test", onMessage: { addListener: (listener) => listeners.push(listener) }, getURL: (p) => `safari-web-extension://trace-test/${p}` },
    tabs: { async get(tabId) { return { id: tabId, url: tabUrl }; }, async query() { return []; }, async sendMessage() {}, async create() {} },
    scripting: { async executeScript(details) { scripts.push(details); return [{ result: scriptResult(details) }]; } },
    alarms: { async clear() {}, async create() {}, onAlarm: { addListener() {} } },
    storageArea: mapArea(new Map()),
    sessionArea: mapArea(session),
    storageMode: "promise",
    fetch: async () => { throw new Error("no network in tests"); },
    saveActivity: () => ({ inFlight: 0, lastEndedAt: 0 }),
  });
  const send = (message, sender) => new Promise((resolve) => {
    for (const listener of listeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    resolve(undefined);
  });
  return { experiment, send, session, scripts };
}

const POPUP = { id: "trace-test", url: "safari-web-extension://trace-test/popup.html" };
const AO3_TAB = { id: "trace-test", url: "https://archiveofourown.org/works/1", tab: { id: TAB, url: "https://archiveofourown.org/works/1" } };

test("the sheet shows the summary fill line, and Reset summary fill clears the fill's session state", async () => {
  const w = wiring();
  const status = await w.send({ type: AO3_HISTORY_EXPERIMENT_MESSAGE, action: "status" }, POPUP);
  assert.equal(status.ok, true);
  assert.match(status.view.fill, /^page · send · filled · 200 · www\.fanfiction\.net author · rows 4 · found 1 · sent accepted/);
  const reset = await w.send({ type: AO3_HISTORY_EXPERIMENT_MESSAGE, action: "reset_fill" }, POPUP);
  assert.equal(reset.ok, true);
  assert.equal(w.session.has(FFN_SUMMARY_STATE_KEY), false);
  assert.equal(reset.view.fill, "nothing yet");
  // The sheet's actions are taken only from the sheet.
  assert.equal(await w.send({ type: AO3_HISTORY_EXPERIMENT_MESSAGE, action: "reset_fill" }, AO3_TAB), undefined);
});

test("the page loop's ticks are answered only for a page on AO3; with no run it is told to stop", async () => {
  const w = wiring();
  assert.deepEqual(await w.send({ type: AO3_HISTORY_EXPERIMENT_MESSAGE, action: "tab_tick" }, AO3_TAB), { stop: true });
  const elsewhere = { ...AO3_TAB, url: "https://example.org/", tab: { id: 9, url: "https://example.org/" } };
  assert.equal(await w.send({ type: AO3_HISTORY_EXPERIMENT_MESSAGE, action: "tab_tick" }, elsewhere), undefined);
});

test("in the page, the loop ticks only while the tab is visible, reads when told, and stops when told", async () => {
  const w = wiring({ tabUrl: `https://archiveofourown.org/users/${USER}/readings` });
  await w.experiment.start(USER, TAB);
  const loop = w.scripts.find((details) => details.args?.[0] === AO3_HISTORY_EXPERIMENT_MESSAGE);
  assert.ok(loop, "start puts the loop into the AO3 tab");
  assert.deepEqual(loop.target, { tabId: TAB, frameIds: [0] });

  const saved = { document: globalThis.document, browser: globalThis.browser, fetch: globalThis.fetch };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const visibility = { state: "hidden" };
    const shown = [];
    globalThis.document = {
      get visibilityState() { return visibility.state; },
      addEventListener: (type, listener) => { if (type === "visibilitychange") shown.push(listener); },
      removeEventListener: () => {},
    };
    const sent = [];
    const replies = [{ fetch: pageURL(1), token: "t1" }, { wait: 9_000 }, { stop: true }];
    globalThis.browser = { runtime: { sendMessage: async (message) => { sent.push(message); return replies.shift() ?? { stop: true }; } } };
    const fetched = [];
    globalThis.fetch = async (url, init) => {
      fetched.push({ url, init });
      const response = new Response(page([work(1)]), { status: 200, headers: { "content-type": "text/html", server: "nginx", "cf-ray": "1-LHR" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };

    assert.equal(loop.func(...loop.args), "started");
    assert.equal(loop.func(...loop.args), "running", "one loop per page");
    mock.timers.tick(1);
    await flush();
    assert.equal(sent.length, 0, "hidden: it does not tick");

    visibility.state = "visible";
    for (const listener of shown) listener();
    mock.timers.tick(500);
    await flush();
    assert.deepEqual(sent.map(({ action }) => action), ["tab_tick", "tab_answer"]);
    assert.equal(sent[0].type, AO3_HISTORY_EXPERIMENT_MESSAGE);
    assert.equal(fetched[0].url, pageURL(1));
    assert.equal(fetched[0].init.credentials, "same-origin");
    const handed = sent[1].answer;
    assert.equal(sent[1].token, "t1");
    assert.equal(handed.kind, "response");
    assert.equal(handed.status, 200);
    assert.equal(handed.server, "nginx");
    assert.equal(handed.cfRay, "1-LHR");
    assert.equal(handed.title, "History | Synthetic");

    mock.timers.tick(9_000);
    await flush();
    assert.deepEqual(sent.map(({ action }) => action), ["tab_tick", "tab_answer", "tab_tick"]);
    mock.timers.tick(60_000);
    await flush();
    assert.equal(sent.length, 3, "told to stop: no more ticks");
  } finally {
    mock.timers.reset();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
