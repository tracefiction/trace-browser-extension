import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AO3_HISTORY_EXPERIMENT_STATE_KEY,
  Ao3HistoryExperiment,
  MAX_CONSECUTIVE_RETRIES,
  PAGE_GAP_JITTER_MS,
  PAGE_GAP_MS,
  RETRY_MAX_MS,
  SAVE_SETTLE_MS,
  classifyHistoryAnswer,
  historyPageURL,
  readHistoryPage,
  retryAfterMs,
} from "../../.trace-build/extension-runtime/ao3-history-experiment.mjs";

// Invented works, people and account throughout; no archive capture.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const USER = "Synthetic_Reader";
const HISTORY = `https://archiveofourown.org/users/${USER}/readings`;

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

function answer(html, { url, status = 200, retryAfter = null, cfMitigated = null } = {}) {
  return { kind: "response", status, url, html, chars: html.length, retryAfter, cfMitigated, contentType: "text/html; charset=utf-8" };
}

const pageURL = (n) => historyPageURL(USER, n);

// --- A clock whose timers the test runs ---------------------------------------

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    pending: () => timers.size,
    /** Safari unloads the background: its timers are gone. */
    dropAll: () => timers.clear(),
    set: (value) => { now = value; },
    /** Fires the earliest timer, or returns false. */
    fireNext() {
      let earliest = null;
      for (const [id, timer] of timers) if (earliest === null || timer.at < earliest[1].at) earliest = [id, timer];
      if (earliest === null) return false;
      timers.delete(earliest[0]);
      now = Math.max(now, earliest[1].at);
      earliest[1].callback();
      return true;
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

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

/** An AO3 that answers from a script: one function per request, in order. */
function harness({ answers, store = memoryStore(), clock = fakeClock(), saves = { inFlight: 0, lastEndedAt: 0 }, bootId = "boot-1" }) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const experiment = new Ao3HistoryExperiment({
    store,
    clock,
    random: () => 0.5,
    newId: () => "run-1",
    bootId,
    saveActivity: () => saves,
    loadPage: async (path, url, tabId, signal) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      requests.push({ path, url, tabId, at: clock.now() });
      try {
        const next = answers.shift();
        if (next === undefined) throw new Error(`unexpected request ${url}`);
        return await next({ url, path, signal });
      } finally {
        inFlight -= 1;
      }
    },
    alarm: { start() {}, stop() {} },
  });
  return { experiment, requests, store, clock, saves, maxInFlight: () => maxInFlight };
}

async function runOut(clock, limit = 200) {
  await flush();
  for (let index = 0; index < limit && clock.fireNext(); index += 1) await flush();
}

const ok = (rows, next = null) => ({ url }) => answer(page(rows, { next }), { url });
const stateOf = (store) => store.data.get(AO3_HISTORY_EXPERIMENT_STATE_KEY);

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

// --- The run ---------------------------------------------------------------------

test("reads every page once, one at a time and 8 to 10 seconds apart, then stops", async () => {
  const h = harness({ answers: [ok([work(1), work(2)], 2), ok([work(3)], 3), ok([work(4)])] });
  await h.experiment.start(USER, 7);
  await runOut(h.clock);
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
  assert.deepEqual(h.store.data.get("traceAo3HistoryExperimentV1:page:1").map((r) => r.id), ["1", "2"]);
  assert.equal(h.clock.pending(), 0, "nothing is left scheduled");
});

test("a work on two pages is kept once", async () => {
  const h = harness({ answers: [ok([work(1), work(2)], 2), ok([work(2), work(3)])] });
  await h.experiment.start(USER, null);
  await runOut(h.clock);
  const state = stateOf(h.store);
  assert.equal(state.counts.rows, 4);
  assert.equal(state.counts.distinct, 3);
  assert.equal(state.counts.duplicates, 1);
  assert.deepEqual(h.store.data.get("traceAo3HistoryExperimentV1:page:2").map((r) => r.id), ["3"]);
});

test("a 429 waits at least Retry-After, doubles the gap, and three in a row pause the run", async () => {
  const slowDown = ({ url }) => answer("", { url, status: 429, retryAfter: "90" });
  const h = harness({ answers: [ok([work(1)], 2), slowDown, ok([work(2)], 3), slowDown, slowDown, slowDown] });
  await h.experiment.start(USER, null);
  await runOut(h.clock);
  const [, limited, after] = h.requests;
  assert.ok(after.at - limited.at >= 90_000, "Retry-After is honoured");
  let state = stateOf(h.store);
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "rate_limited");
  assert.equal(state.pace.rateLimited, 1 + MAX_CONSECUTIVE_RETRIES);
  assert.ok(state.timing.gapMs >= PAGE_GAP_MS * 4, "every later page waits longer");
  // The saved retry deadline still holds after Resume.
  const requestsBefore = h.requests.length;
  h.clock.set(h.clock.now() + 1_000);
  const resumeAt = h.clock.now();
  const due = state.timing.dueAt;
  const h2 = harness({ answers: [ok([work(3)])], store: h.store, clock: h.clock });
  await h2.experiment.resume(null);
  await runOut(h.clock);
  assert.equal(h.requests.length, requestsBefore);
  assert.ok(due - resumeAt >= 60_000, "the backoff deadline outlives the pause");
  assert.ok(h2.requests[0].at >= due, "no request before the saved deadline");
  state = stateOf(h.store);
  assert.equal(state.status, "finished");
});

test("a Retry-After longer than 15 minutes pauses instead of waiting", async () => {
  const h = harness({ answers: [({ url }) => answer("", { url, status: 503, retryAfter: String(RETRY_MAX_MS / 1000 + 60) })] });
  await h.experiment.start(USER, null);
  await runOut(h.clock);
  const state = stateOf(h.store);
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "retry_later");
  assert.ok(state.timing.dueAt >= h.requests[0].at + RETRY_MAX_MS + 60_000);
});

test("a challenge stops the run and nothing more is requested", async () => {
  const h = harness({ answers: [ok([work(1)], 2), ({ url }) => answer("<title>Just a moment...</title>", { url, status: 403 })] });
  await h.experiment.start(USER, null);
  await runOut(h.clock);
  h.clock.set(h.clock.now() + 3_600_000);
  await h.experiment.wake("alarm");
  await runOut(h.clock);
  assert.equal(h.requests.length, 2);
  assert.equal(stateOf(h.store).reason, "challenge");
  assert.equal(stateOf(h.store).errors.challenge, 1);
});

test("nothing is requested while a save is under way, nor just after", async () => {
  const saves = { inFlight: 1, lastEndedAt: 0 };
  const h = harness({ answers: [ok([work(1)])], saves });
  await h.experiment.start(USER, null);
  await flush();
  for (let index = 0; index < 3; index += 1) { h.clock.fireNext(); await flush(); }
  assert.equal(h.requests.length, 0);
  saves.inFlight = 0;
  saves.lastEndedAt = h.clock.now();
  await runOut(h.clock);
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests[0].at - saves.lastEndedAt >= SAVE_SETTLE_MS);
  assert.ok(stateOf(h.store).pace.waitsForSave >= 3);
});

test("the checkpoint carries a run into a restarted background, at the same pace", async () => {
  const store = memoryStore();
  const clock = fakeClock();
  const first = harness({ answers: [ok([work(1), work(2)], 2)], store, clock, bootId: "boot-1" });
  await first.experiment.start(USER, null);
  await flush();
  assert.equal(first.requests.length, 1);
  clock.dropAll();
  const second = harness({ answers: [ok([work(2), work(3)])], store, clock, bootId: "boot-2" });
  // Woken by the alarm too early: it waits for the gap rather than asking.
  await second.experiment.wake("alarm");
  assert.equal(second.requests.length, 0);
  await runOut(clock);
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

test("pause stops requests, resume carries on, and the pause is not counted as running time", async () => {
  const h = harness({ answers: [ok([work(1)], 2), ok([work(2)])] });
  await h.experiment.start(USER, null);
  await flush();
  await h.experiment.pause();
  h.clock.set(h.clock.now() + 600_000);
  await h.experiment.wake("alarm");
  await runOut(h.clock);
  assert.equal(h.requests.length, 1);
  assert.equal(stateOf(h.store).reason, "paused_by_you");
  await h.experiment.resume(null);
  await runOut(h.clock);
  assert.equal(h.requests.length, 2);
  const state = stateOf(h.store);
  assert.equal(state.status, "finished");
  assert.ok(state.timing.pausedMs >= 590_000);
  assert.equal(state.timing.maxGapMs, 0, "the gap across a pause is not counted");
});

test("cancel during a request keeps nothing, then and afterwards", async () => {
  let release;
  const h = harness({ answers: [ok([work(1)], 2), ({ url }) => new Promise((resolve) => { release = () => resolve(answer(page([work(2)], { next: 3 }), { url })); })] });
  await h.experiment.start(USER, null);
  await flush();
  h.clock.fireNext();
  await flush();
  assert.equal(h.requests.length, 2);
  await h.experiment.clear();
  release();
  await runOut(h.clock);
  assert.equal(h.store.data.size, 0, "every key is gone");
  assert.equal((await h.experiment.view()).status, "idle");
});

test("a page that cannot be stored pauses without moving past it", async () => {
  const store = memoryStore({ failWhen: (items) => "traceAo3HistoryExperimentV1:page:2" in items });
  const h = harness({ answers: [ok([work(1)], 2), ok([work(2)], 3)], store });
  await h.experiment.start(USER, null);
  await runOut(h.clock);
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "storage_write_failed");
  assert.equal(state.nextPage, 2);
  assert.equal(state.counts.distinct, 1);
  assert.equal(state.storage.writeFailures, 1);
});

test("a background that is not signed in hands over to the reader's AO3 tab", async () => {
  const login = ({ url }) => answer("<html></html>", { url: "https://archiveofourown.org/users/login" });
  const h = harness({ answers: [login, ok([work(1)], 2), ok([work(2)])] });
  await h.experiment.start(USER, 42);
  await runOut(h.clock);
  assert.deepEqual(h.requests.map((r) => r.path), ["background", "tab", "tab"]);
  assert.ok(h.requests.slice(1).every((r) => r.tabId === 42));
  const state = stateOf(h.store);
  assert.deepEqual(state.probes, { background: "signed_out", tab: "ok" });
  assert.equal(state.status, "finished");
});

test("when neither can read the History, the run pauses and says so", async () => {
  const login = ({ url }) => answer("<html></html>", { url: "https://archiveofourown.org/users/login" });
  const h = harness({ answers: [login, login] });
  await h.experiment.start(USER, 42);
  await runOut(h.clock);
  assert.equal(stateOf(h.store).reason, "no_working_path");
});

test("the copied results carry counts, times and codes, never the account, titles or authors", async () => {
  const h = harness({
    answers: [
      ok([work(1, { title: "Lantern Secret Title", author: "Hidden_Author_Name" })], 2),
      ({ url }) => answer("", { url, status: 429, retryAfter: "60" }),
      ok([work(2, { title: "Second Private Title" })]),
    ],
  });
  await h.experiment.start(USER, null);
  await runOut(h.clock);
  const view = await h.experiment.view();
  const copied = [view.report, ...view.lines.flat()].join("\n");
  for (const secret of [USER, "Lantern Secret Title", "Hidden_Author_Name", "Second Private Title", "archiveofourown", "/works/"]) {
    assert.equal(copied.includes(secret), false, `the results mention ${secret}`);
  }
  assert.match(view.report, /Pages read: 2/);
  assert.match(view.report, /Different works: 2/);
  assert.match(view.report, /429 answers: 1/);
  assert.match(view.report, /Errors: rate_limited×1/);
});
