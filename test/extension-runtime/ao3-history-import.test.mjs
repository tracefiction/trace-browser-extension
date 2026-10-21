import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";

import {
  classifyHistoryAnswer,
  historyDay,
  historyPageURL,
  readHistoryPage,
  retryAfterMs,
} from "../../.trace-build/extension-runtime/ao3-history-page.mjs";
import {
  AO3_HISTORY_IMPORT_MESSAGE,
  Ao3HistoryImport,
  LOST_AFTER_MS,
  MAX_CONSECUTIVE_RETRIES,
  MAX_PAGE_GAP_MS,
  PAGE_GAP_JITTER_MS,
  PAGE_GAP_MS,
  RETRY_MAX_MS,
  SAVE_SETTLE_MS,
} from "../../.trace-build/extension-runtime/ao3-history-import.mjs";
import {
  IndexedDbHistoryStore,
  MemoryHistoryStore,
  mergeHistoryWork,
} from "../../.trace-build/extension-runtime/ao3-history-store.mjs";
import { installAo3HistoryImport } from "../../.trace-build/extension-runtime/ao3-history-import-runtime.mjs";

// Invented works, people and accounts throughout; no archive capture.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const USER = "Synthetic_Reader";
const ACCOUNT = "account-1";
const TAB = 42;

const escapeHTML = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function work(id, { title = `Invented work ${id}`, author = "Synthetic_Quill", later = false, visited = "08 Oct 2026", times = 3, summary = `Invented summary ${id}.` } = {}) {
  const visit = `Last visited: ${visited} ${later ? "(Marked for Later.) " : ""}(Latest version.) Visited ${times === 1 ? "once" : `${times} times`}`;
  return `<li id="work_${id}" class="reading work blurb group" role="article"><div class="header module">` +
    `<h4 class="heading"><a href="/works/${id}">${escapeHTML(title)}</a> by <a rel="author" href="/users/${author}/pseuds/${author}">${escapeHTML(author)}</a></h4>` +
    `<h5 class="fandoms heading"><a class="tag" href="/tags/invented/works">Invented Lanterns</a></h5>` +
    `<ul class="required-tags"><li><span class="rating" title="General Audiences"><span class="text">General Audiences</span></span></li></ul></div>` +
    `<ul class="tags commas"><li class="freeforms"><a class="tag" href="/tags/found/works">Found Family</a></li></ul>` +
    `<blockquote class="userstuff summary"><p>${escapeHTML(summary)}</p></blockquote>` +
    `<dl class="stats"><dd class="words">12,345</dd><dd class="chapters">3/3</dd></dl>` +
    `<div class="user module group"><h4 class="viewed heading">${escapeHTML(visit)}</h4></div></li>`;
}

// AO3's History page: the page links above the listing and again below it,
// Next marked by its list item with no `rel`, a plain "Next" on the last page,
// and numbered links up to `last`.
function page(rows, { next = null, user = USER, rel = false, pages = true, last = null } = {}) {
  const nextLink = next === null
    ? '<li class="next"><span class="disabled">Next →</span></li>'
    : `<li class="next"><a ${rel ? 'rel="next" ' : ""}href="/users/${user}/readings?page=${next}">Next →</a></li>`;
  const lastLink = last === null ? "" : `<li><a href="/users/${user}/readings?page=${last}">${last}</a></li>`;
  const links = pages
    ? `<h4 class="landmark heading">Navigation</h4><ol class="pagination actions pagy" role="navigation" aria-label="Pagination">` +
      `<li class="previous"><span class="disabled">← Previous</span></li><li><a role="link" aria-disabled="true" aria-current="page" class="current">1</a></li>${lastLink}${nextLink}</ol>`
    : "";
  const listing = rows.length ? `<ol class="reading work index group">${rows.join("\n")}</ol>` : "";
  return `<!doctype html><html><head><title>History | Synthetic</title></head><body class="logged-in">` +
    `<div id="header"><a href="/users/${user}/readings">My History</a></div>` +
    `<div id="main" class="readings-index dashboard region"><h2 class="heading">History</h2>${links}` +
    `<h3 class="landmark heading">List of History Items</h3>${listing}${links}</div><div id="footer"></div></body></html>`;
}

function answer(html, { url, status = 200, retryAfter = null, cfMitigated = null, contentType = "text/html; charset=utf-8" } = {}) {
  return { kind: "response", status, url, html, chars: html.length, retryAfter, cfMitigated, contentType };
}

const pageURL = (n) => historyPageURL(USER, n);
const ok = (rows, next = null, options = {}) => ({ url }) => answer(page(rows, { next, ...options }), { url });

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

/** An AO3 that answers from a script, one function per request, in order. */
function harness({
  answers,
  store = new MemoryHistoryStore(),
  clock = fakeClock(),
  saves = { inFlight: 0, lastEndedAt: 0 },
  account = { id: ACCOUNT },
  instance = "1",
} = {}) {
  const requests = [];
  const loops = [];
  let ids = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const respond = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    requests.push({ url, at: clock.now() });
    try {
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      return await next({ url });
    } finally {
      inFlight -= 1;
    }
  };
  const history = new Ao3HistoryImport({
    store,
    clock,
    random: () => 0.5,
    newId: () => `id-${instance}-${++ids}`,
    account: async () => account.id,
    saveActivity: () => saves,
    async ensureLoop(tabId) { loops.push(tabId); return "started"; },
    alarm: { start() {}, stop() {} },
  });
  /** The page loop in the AO3 tab: tick, fetch when told, wait as told. */
  async function drive({ tabId = TAB, limit = 300, until = () => false } = {}) {
    for (let index = 0; index < limit; index += 1) {
      let next = await history.tick(tabId);
      if (typeof next.fetch === "string") next = await history.answer(next.token, await respond(next.fetch));
      if (next.stop || until()) return next;
      clock.advance(Math.max(next.wait, 500));
    }
    return null;
  }
  return { history, requests, loops, store, clock, saves, account, drive, respond, maxInFlight: () => maxInFlight };
}

const runOf = (store) => store.run;

// --- Reading pages ---------------------------------------------------------------

test("reads the repository's invented History page: dates as days, later rows kept and marked, required tags left out", () => {
  const html = fs.readFileSync(path.join(FIXTURES, "ao3_history.html"), "utf8");
  const read = readHistoryPage(html, "Ink_Reader_Test", 1);
  assert.equal(read.kind, "page");
  assert.equal(read.nextPage, null);
  assert.equal(read.totalPages, 1);
  assert.equal(read.deleted, 1);
  assert.equal(read.unreadable, 0);
  assert.deepEqual(read.works.find((w) => w.id === "41000001"), {
    id: "41000001",
    title: "The Lamplighter's Ledger",
    authors: ["Quill_Fennimore"],
    fandoms: ["Sherlock Holmes - Arthur Conan Doyle"],
    tags: ["No Archive Warnings Apply", "Slow Burn"],
    summary: "An invented summary for a test fixture.",
    words: 24310,
    chapters: "6/6",
    lastVisited: "2026-10-08",
    visits: 3,
    later: false,
  });
  assert.equal(read.works.find((w) => w.id === "41000002").visits, 1);
  assert.equal(read.works.find((w) => w.id === "41000004").visits, 1204);
  const later = read.works.find((w) => w.id === "41000003");
  assert.equal(later.later, true);
  assert.equal(later.lastVisited, null, "a work marked for later carries no visit");
  assert.equal(later.visits, null);
});

test("AO3's day reads as a calendar day; a day that does not exist, or before 2000, is left out", () => {
  assert.equal(historyDay("08 Oct 2026"), "2026-10-08");
  assert.equal(historyDay("1 Mar 2024"), "2024-03-01");
  assert.equal(historyDay("31 Feb 2024"), null);
  assert.equal(historyDay("08 Oct 1999"), null);
  assert.equal(historyDay("08 Foo 2026"), null);
  const read = readHistoryPage(page([work(1, { visited: "30 Feb 2026" })]), USER, 1);
  assert.equal(read.works[0].lastVisited, null);
});

test("follows only the next page of the same History, and reads the page count from its links", () => {
  const first = readHistoryPage(page([work(1)], { next: 2, last: 31 }), USER, 1);
  assert.equal(first.nextPage, 2);
  assert.equal(first.totalPages, 31);
  assert.equal(readHistoryPage(page([work(1)], { next: 2 }), USER, 1).totalPages, 2);
  assert.equal(readHistoryPage(page([work(1)]), USER, 3).nextPage, null);
  assert.equal(readHistoryPage(page([work(1)], { last: 9 }), USER, 3).totalPages, 3, "a last page is the last");
  assert.deepEqual(readHistoryPage(page([work(1)], { next: 5 }), USER, 1), { kind: "stop", code: "pagination_unexpected" });
  assert.deepEqual(readHistoryPage(page([work(1)], { next: 2, user: "Someone_Else" }), USER, 1), { kind: "stop", code: "pagination_unexpected" });
  assert.deepEqual(readHistoryPage("<html><body><form action=\"/users/login\"></form></body></html>", USER, 1), { kind: "stop", code: "signed_out" });
  assert.deepEqual(readHistoryPage("<html><body><div id=\"main\" class=\"works-show\"></div></body></html>", USER, 1), { kind: "stop", code: "unrecognized_page" });
});

test("reads rows below AO3's top page links, and Next from its list item or rel", () => {
  const read = readHistoryPage(page([work(1), work(2)], { next: 2 }), USER, 1);
  assert.deepEqual(read.works.map((w) => w.id), ["1", "2"]);
  assert.equal(read.nextPage, 2);
  assert.equal(readHistoryPage(page([work(1)], { next: 2, rel: true }), USER, 1).nextPage, 2);
  assert.equal(readHistoryPage(page([work(1)], { pages: false }), USER, 1).nextPage, null);
});

test("the last page is only one with no page links, or with AO3's disabled Next", () => {
  const odd = page([work(1)]).replace('<li class="next"><span class="disabled">Next →</span></li>', '<li class="next">Next →</li>');
  assert.deepEqual(readHistoryPage(odd, USER, 1), { kind: "stop", code: "pagination_unexpected" });
  const none = page([work(1)]).replaceAll('<li class="next"><span class="disabled">Next →</span></li>', "");
  assert.deepEqual(readHistoryPage(none, USER, 1), { kind: "stop", code: "pagination_unexpected" });
  const both = page([work(1)], { next: 2 }).replace(
    `<li class="next"><a href="/users/${USER}/readings?page=2">Next →</a></li>`,
    '<li class="next"><span class="disabled">Next →</span></li>',
  );
  assert.deepEqual(readHistoryPage(both, USER, 1), { kind: "stop", code: "pagination_unexpected" });
});

test("an empty page, a page cut short, and a page of rows it cannot read are never the end", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.deepEqual(readHistoryPage(page([]), USER, 1), { kind: "empty" });
  assert.deepEqual(classifyHistoryAnswer(answer(page([]), { url: pageURL(1) }), USER, 1, now),
    { kind: "retry", code: "empty_page", retryAfterMs: null });
  const full = page([work(1), work(2)]);
  const cut = full.slice(0, full.indexOf('<div id="footer"'));
  assert.deepEqual(readHistoryPage(cut, USER, 1), { kind: "incomplete" });
  const strange = '<li class="reading work blurb group" role="article"><p>No id here</p></li>';
  assert.deepEqual(readHistoryPage(page([work(1), strange, strange]), USER, 1), { kind: "stop", code: "rows_unreadable" });
  const some = readHistoryPage(page([work(1), work(2), strange]), USER, 1);
  assert.equal(some.kind, "page");
  assert.equal(some.unreadable, 1);
});

test("classifies AO3's answers: slow down, challenge, signed out, wrong host, redirect", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const html = page([work(1)]);
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: pageURL(1), status: 429, retryAfter: "120" }), USER, 1, now),
    { kind: "retry", code: "rate_limited", retryAfterMs: 120_000 });
  assert.equal(retryAfterMs("Wed, 21 Oct 2026 12:01:00 GMT", now), 60_000);
  assert.equal(retryAfterMs("soon", now), null);
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: pageURL(1), status: 525 }), USER, 1, now),
    { kind: "retry", code: "server_error", retryAfterMs: null });
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: pageURL(1), cfMitigated: "challenge" }), USER, 1, now), { kind: "stop", code: "challenge" });
  const challenge = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>";
  assert.deepEqual(classifyHistoryAnswer(answer(challenge, { url: pageURL(1), status: 403 }), USER, 1, now), { kind: "stop", code: "challenge" });
  assert.deepEqual(classifyHistoryAnswer(answer("<html></html>", { url: "https://archiveofourown.org/users/login?return_to=x" }), USER, 1, now), { kind: "stop", code: "signed_out" });
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: "https://example.org/users/x/readings" }), USER, 1, now), { kind: "stop", code: "wrong_host" });
  assert.deepEqual(classifyHistoryAnswer(answer(html, { url: `https://archiveofourown.org/users/${USER}` }), USER, 1, now), { kind: "stop", code: "redirected" });
  assert.deepEqual(classifyHistoryAnswer({ kind: "failed", code: "timeout" }, USER, 1, now), { kind: "retry", code: "timeout", retryAfterMs: null });
  assert.equal(classifyHistoryAnswer(answer(html, { url: pageURL(1) }), USER, 1, now).kind, "page");
});

// --- Keeping works ----------------------------------------------------------------

test("a work seen again keeps its first details, the latest visit day and the highest count, never a sum", () => {
  const read = (rows) => readHistoryPage(page(rows), USER, 1).works[0];
  const newer = read([work(1, { visited: "08 Oct 2026", times: 5 })]);
  const older = { ...read([work(1, { visited: "01 Mar 2024", times: 7, title: "Old title" })]), summary: "" };
  const merged = mergeHistoryWork(newer, older);
  assert.equal(merged.title, newer.title);
  assert.equal(merged.lastVisited, "2026-10-08");
  assert.equal(merged.visits, 7);
  assert.equal(mergeHistoryWork({ ...newer, summary: "" }, older).summary, "", "a gap stays a gap when neither has it");
  assert.equal(mergeHistoryWork({ ...newer, later: true }, { ...older, later: true }).later, true);
  assert.equal(mergeHistoryWork({ ...newer, later: true }, older).later, false, "a visit outweighs a mark for later");
});

test("the IndexedDB store keeps a page's works and the run together, and they outlast the connection", async () => {
  const factory = new IDBFactory();
  const store = new IndexedDbHistoryStore(factory);
  const works = readHistoryPage(page([work(1), work(2)]), USER, 1).works;
  const first = await store.admit(works, ({ fresh }) => ({ v: 1, fresh }));
  assert.deepEqual(first, { fresh: 2, repeats: 0 });
  const again = await store.admit(
    readHistoryPage(page([work(2, { visited: "01 Jan 2025", times: 9 }), work(3)]), USER, 2).works,
    ({ fresh, repeats }) => ({ v: 1, fresh, repeats }),
  );
  assert.deepEqual(again, { fresh: 1, repeats: 1 });

  const reopened = new IndexedDbHistoryStore(factory);
  assert.deepEqual(await reopened.readRun(), { v: 1, fresh: 1, repeats: 1 });
  const kept = (await reopened.readWorks()).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(kept.map((w) => w.id), ["1", "2", "3"]);
  assert.equal(kept[1].visits, 9);
  assert.equal(kept[1].lastVisited, "2026-10-08");
  await reopened.clear();
  assert.equal(await reopened.readRun(), null);
  assert.deepEqual(await reopened.readWorks(), []);
});

// --- The run, paced by the page loop ------------------------------------------

test("start puts the loop into the AO3 tab, which reads every page once, 8 to 10 seconds apart", async () => {
  const h = harness({ answers: [ok([work(1), work(2)], 2, { last: 3 }), ok([work(3)], 3), ok([work(4)])] });
  const started = await h.history.start(USER, TAB);
  assert.equal(started.status, "running");
  assert.deepEqual(h.loops, [TAB]);
  assert.equal(h.requests.length, 0, "nothing is read before the loop asks");
  await h.drive();
  assert.deepEqual(h.requests.map((r) => r.url), [pageURL(1), pageURL(2), pageURL(3)]);
  assert.equal(h.maxInFlight(), 1);
  for (let index = 1; index < h.requests.length; index += 1) {
    const gap = h.requests[index].at - h.requests[index - 1].at;
    assert.ok(gap >= PAGE_GAP_MS && gap <= PAGE_GAP_MS + PAGE_GAP_JITTER_MS, `gap ${gap}`);
  }
  const view = await h.history.view();
  assert.equal(view.status, "finished");
  assert.equal(view.reason, "reached_last_page");
  assert.equal(view.pagesRead, 3);
  assert.equal(view.totalPages, 3);
  assert.equal(view.works, 4);
  assert.equal(view.remainingMs, null);
  assert.deepEqual((await h.history.works()).map((w) => w.id).sort(), ["1", "2", "3", "4"]);
  assert.deepEqual(await h.history.tick(TAB), { stop: true }, "the loop is told to stop");
});

test("a run starts only for a connected Trace account and a clear AO3 name, and only once", async () => {
  const h = harness({ answers: [], account: { id: null } });
  assert.deepEqual(await h.history.start(USER, TAB), { error: "not_connected" });
  h.account.id = ACCOUNT;
  assert.deepEqual(await h.history.start("not a name!", TAB), { error: "username_unclear" });
  assert.equal((await h.history.start(USER, TAB)).status, "running");
  assert.deepEqual(await h.history.start(USER, TAB), { error: "already_started" });
});

test("the view says how far it has got and about how long is left, never the AO3 name or a work", async () => {
  const h = harness({ answers: [ok([work(1, { title: "Secret title" })], 2, { last: 31 }), ok([work(2)], 3, { last: 31 }), ok([work(3)], 4, { last: 31 })] });
  await h.history.start(USER, TAB);
  await h.drive({ until: () => h.requests.length === 3 && h.store.run.counts.pages === 3 });
  const view = await h.history.view();
  assert.equal(view.pagesRead, 3);
  assert.equal(view.totalPages, 31);
  assert.equal(view.status, "running");
  // 28 pages left at the pace pages have been kept at (9 s here).
  assert.equal(view.remainingMs, 28 * (PAGE_GAP_MS + PAGE_GAP_JITTER_MS / 2));
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, new RegExp(USER));
  assert.doesNotMatch(text, /Secret title/);
});

test("a work on two pages is kept once, with the counts saying so", async () => {
  const h = harness({ answers: [ok([work(1), work(2)], 2), ok([work(2, { visited: "01 Mar 2024", times: 9 }), work(3)])] });
  await h.history.start(USER, TAB);
  await h.drive();
  const run = runOf(h.store);
  assert.equal(run.counts.works, 3);
  assert.equal(run.counts.repeats, 1);
  const two = (await h.history.works()).find((w) => w.id === "2");
  assert.equal(two.lastVisited, "2026-10-08");
  assert.equal(two.visits, 9);
});

test("a 429 waits at least Retry-After, doubles the gap, says so, and three in a row pause the run", async () => {
  const slow = ({ url }) => answer(page([work(9)]), { url, status: 429, retryAfter: "120" });
  const h = harness({ answers: [ok([work(1)], 2), slow, ok([work(2)], 3), slow, slow, slow] });
  await h.history.start(USER, TAB);
  await h.drive({ until: () => h.store.run.retry.code === "rate_limited" });
  assert.equal((await h.history.view()).waitingFor, "slow_down");
  await h.drive();
  const [, first, after] = h.requests;
  assert.ok(after.at - first.at >= 120_000, "never before Retry-After");
  const run = runOf(h.store);
  assert.equal(run.status, "paused");
  assert.equal(run.reason, "rate_limited");
  // Doubled for each slow-down AO3 asked for, never past the longest gap.
  assert.equal(run.timing.gapMs, MAX_PAGE_GAP_MS);
  assert.equal(run.counts.pages, 2);
});

test("a Retry-After longer than 15 minutes pauses for the reader instead of waiting", async () => {
  const later = ({ url }) => answer(page([]), { url, status: 503, retryAfter: String(RETRY_MAX_MS / 1_000 + 60) });
  const h = harness({ answers: [later] });
  await h.history.start(USER, TAB);
  await h.drive();
  const run = runOf(h.store);
  assert.equal(run.status, "paused");
  assert.equal(run.reason, "retry_later");
});

test("a challenge stops the run at once, and nothing more is asked", async () => {
  const challenge = ({ url }) => answer(page([work(1)]), { url, cfMitigated: "challenge" });
  const h = harness({ answers: [ok([work(1)], 2), challenge] });
  await h.history.start(USER, TAB);
  assert.deepEqual(await h.drive(), { stop: true });
  assert.equal(runOf(h.store).reason, "challenge");
  assert.equal(h.requests.length, 2);
  assert.deepEqual(await h.history.tick(TAB), { stop: true });
});

test("page 1 empty three times pauses as an empty History; a later empty page pauses as AO3's", async () => {
  const empty = ({ url }) => answer(page([]), { url });
  const first = harness({ answers: [empty, empty, empty] });
  await first.history.start(USER, TAB);
  await first.drive();
  assert.equal(runOf(first.store).reason, "history_empty");
  assert.equal((await first.history.view()).status, "paused");

  const later = harness({ answers: [ok([work(1)], 2), empty, empty, empty] });
  await later.history.start(USER, TAB);
  await later.drive();
  assert.equal(runOf(later.store).reason, "empty_page");
  assert.equal(runOf(later.store).counts.pages, 1);
});

test("nothing is requested while a save is under way, nor just after", async () => {
  const h = harness({ answers: [ok([work(1)])], saves: { inFlight: 1, lastEndedAt: 0 } });
  await h.history.start(USER, TAB);
  const waiting = await h.history.tick(TAB);
  assert.ok("wait" in waiting);
  assert.equal((await h.history.view()).waitingFor, "save");
  h.saves.inFlight = 0;
  h.saves.lastEndedAt = h.clock.now();
  h.clock.advance(SAVE_SETTLE_MS - 1);
  assert.ok("wait" in await h.history.tick(TAB));
  assert.equal(h.requests.length, 0);
  h.clock.advance(1);
  await h.drive();
  assert.equal(h.requests.length, 1);
});

test("a run carries on in a restarted background from the page it had reached", async () => {
  const store = new MemoryHistoryStore();
  const clock = fakeClock();
  const before = harness({ answers: [ok([work(1)], 2)], store, clock });
  await before.history.start(USER, TAB);
  await before.drive({ until: () => store.run.counts.pages === 1 });
  const after = harness({ answers: [ok([work(2)])], store, clock, instance: "2" });
  clock.advance(PAGE_GAP_MS + PAGE_GAP_JITTER_MS);
  await after.drive();
  assert.deepEqual(after.requests.map((r) => r.url), [pageURL(2)]);
  assert.equal(runOf(store).status, "finished");
  assert.equal(runOf(store).counts.works, 2);
});

test("an answer that never comes is given up after its time limit, and a late one is not kept", async () => {
  const h = harness({ answers: [ok([work(1)])] });
  await h.history.start(USER, TAB);
  const asked = await h.history.tick(TAB);
  assert.equal(typeof asked.fetch, "string");
  h.clock.advance(LOST_AFTER_MS - 1);
  assert.ok("wait" in await h.history.tick(TAB), "still waiting for it");
  h.clock.advance(2);
  const again = await h.history.tick(TAB);
  assert.equal(typeof again.fetch, "string", "asked again");
  assert.notEqual(again.token, asked.token);
  await h.history.answer(asked.token, answer(page([work(5)]), { url: pageURL(1) }));
  assert.equal(runOf(h.store).counts.pages, 0, "the late answer is not kept");
  await h.history.answer(again.token, answer(page([work(1)]), { url: pageURL(1) }));
  assert.equal(runOf(h.store).status, "finished");
});

test("pause stops requests and resume carries on; the pause is not part of the estimate", async () => {
  const h = harness({
    answers: [ok([work(1)], 2, { last: 5 }), ok([work(2)], 3), ok([work(3)], 4), ok([work(4)], 5), ok([work(5)])],
  });
  await h.history.start(USER, TAB);
  await h.drive({ until: () => h.store.run.counts.pages === 3 });
  await h.history.pause();
  assert.deepEqual(await h.history.tick(TAB), { stop: true });
  h.clock.advance(3_600_000);
  await h.history.resume(TAB);
  await h.drive({ until: () => h.store.run.counts.pages === 4 });
  const view = await h.history.view();
  assert.equal(view.remainingMs, PAGE_GAP_MS + PAGE_GAP_JITTER_MS / 2, "an hour's pause does not count");
  await h.drive();
  assert.equal(runOf(h.store).status, "finished");
});

test("Stop and delete during a request keeps nothing, then and afterwards", async () => {
  const h = harness({ answers: [] });
  await h.history.start(USER, TAB);
  const asked = await h.history.tick(TAB);
  await h.history.delete();
  assert.deepEqual(await h.history.answer(asked.token, answer(page([work(1)]), { url: pageURL(1) })), { stop: true });
  assert.equal(h.store.run, null);
  assert.equal(h.store.works.size, 0);
  assert.equal((await h.history.view()).status, "idle");
});

test("a page the device will not keep pauses without moving past it", async () => {
  const store = new MemoryHistoryStore();
  const h = harness({ answers: [ok([work(1)], 2), ok([work(2)], 3)], store });
  await h.history.start(USER, TAB);
  await h.drive({ until: () => store.run.counts.pages === 1 });
  store.failWrites = "full";
  await h.drive();
  assert.equal((await h.history.view()).reason, "storage_full");
  store.failWrites = null;
  const run = runOf(store);
  assert.equal(run.counts.pages, 1);
  assert.equal(run.nextPage, 2, "page 2 is read again on Resume");
  assert.equal(store.works.size, 1);
});

test("another account never sees a run: it is deleted on sight, and when the account leaves", async () => {
  const h = harness({ answers: [ok([work(1)], 2)] });
  await h.history.start(USER, TAB);
  await h.drive({ until: () => h.store.run.counts.pages === 1 });
  h.account.id = "account-2";
  assert.equal((await h.history.view()).status, "idle");
  assert.equal(h.store.run, null);
  assert.equal(h.store.works.size, 0);

  const left = harness({ answers: [ok([work(1)], 2)] });
  await left.history.start(USER, TAB);
  await left.drive({ until: () => left.store.run.counts.pages === 1 });
  await left.history.accountLeft();
  assert.equal(left.store.run, null);
  assert.equal(left.store.works.size, 0);
});

test("an unknown account (a background still starting) keeps the run", async () => {
  const h = harness({ answers: [ok([work(1)], 2)] });
  await h.history.start(USER, TAB);
  h.account.id = null;
  assert.equal((await h.history.view()).status, "running");
});

// --- Safari wiring -------------------------------------------------------------------

function wiring({ tabUrl = "https://archiveofourown.org/works/1", scriptResult = () => "started", permitted = true } = {}) {
  const listeners = [];
  const scripts = [];
  const cleanups = [];
  const store = new MemoryHistoryStore();
  const history = installAo3HistoryImport({
    runtime: { id: "trace-test", onMessage: { addListener: (listener) => listeners.push(listener) }, getURL: (p) => `safari-web-extension://trace-test/${p}` },
    tabs: { async get(tabId) { return { id: tabId, url: tabUrl }; }, async query() { return []; }, async sendMessage() {}, async create() {} },
    scripting: { async executeScript(details) { scripts.push(details); return [{ result: scriptResult(details) }]; } },
    permissions: { async contains() { return permitted; } },
    alarms: { async clear() {}, async create() {}, onAlarm: { addListener() {} } },
    storageMode: "promise",
    databaseFactory: null,
    store,
    account: async () => ACCOUNT,
    whenAccountLeaves: (cleanup) => cleanups.push(cleanup),
    saveActivity: () => ({ inFlight: 0, lastEndedAt: 0 }),
  });
  const send = (message, sender) => new Promise((resolve) => {
    for (const listener of listeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    resolve(undefined);
  });
  return { history, send, scripts, cleanups, store };
}

const POPUP = { id: "trace-test", url: "safari-web-extension://trace-test/popup.html" };
const AO3_TAB = { id: "trace-test", url: "https://archiveofourown.org/works/1", tab: { id: TAB, url: "https://archiveofourown.org/works/1" } };

test("the sheet starts a run for the AO3 name the tab shows, and is told plainly when it cannot", async () => {
  const signedIn = wiring({ scriptResult: (details) => (details.args?.length ? "started" : [USER]) });
  const reply = await signedIn.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "start", tabId: TAB }, POPUP);
  assert.equal(reply.ok, true);
  assert.equal(reply.view.status, "running");
  assert.equal(signedIn.store.run.user, USER);
  assert.equal(signedIn.cleanups.length, 1, "it leaves with the account");

  const signedOut = wiring({ scriptResult: (details) => (details.args?.length ? "started" : []) });
  assert.equal((await signedOut.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "start", tabId: TAB }, POPUP)).error, "signed_out");
  const twoNames = wiring({ scriptResult: () => [USER, "Someone_Else"] });
  assert.equal((await twoNames.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "start", tabId: TAB }, POPUP)).error, "username_unclear");
  const elsewhere = wiring({ tabUrl: "https://example.org/" });
  assert.equal((await elsewhere.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "start", tabId: TAB }, POPUP)).error, "open_ao3_first");
  const noAccess = wiring({ permitted: false });
  assert.equal((await noAccess.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "start", tabId: TAB }, POPUP)).error, "no_site_access");
  // A page, not the sheet, cannot start a run.
  assert.equal(await signedOut.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "start", tabId: TAB }, AO3_TAB), undefined);
});

test("the page loop's ticks are answered only for a page on AO3; with no run it is told to stop", async () => {
  const w = wiring();
  assert.deepEqual(await w.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "tab_tick" }, AO3_TAB), { stop: true });
  const elsewhere = { ...AO3_TAB, url: "https://example.org/", tab: { id: 9, url: "https://example.org/" } };
  assert.equal(await w.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "tab_tick" }, elsewhere), undefined);
});

test("in the page, the loop ticks only while the tab is visible, reads when told, and stops when told", async () => {
  const w = wiring({ scriptResult: (details) => (details.args?.length ? "started" : [USER]) });
  await w.send({ type: AO3_HISTORY_IMPORT_MESSAGE, action: "start", tabId: TAB }, POPUP);
  const loop = w.scripts.find((details) => details.args?.[0] === AO3_HISTORY_IMPORT_MESSAGE);
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
      const response = new Response(page([work(1)]), { status: 200, headers: { "content-type": "text/html", "retry-after": "5" } });
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
    assert.equal(sent[0].type, AO3_HISTORY_IMPORT_MESSAGE);
    assert.equal(fetched[0].url, pageURL(1));
    assert.equal(fetched[0].init.credentials, "same-origin");
    assert.equal(fetched[0].init.headers, undefined, "no headers of its own");
    const handed = sent[1].answer;
    assert.equal(sent[1].token, "t1");
    assert.equal(handed.kind, "response");
    assert.equal(handed.status, 200);
    assert.equal(handed.retryAfter, "5");

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

test("a History of 10,000 works is read and kept in IndexedDB, far past the old 5 MB storage", async () => {
  const store = new IndexedDbHistoryStore(new IDBFactory());
  const pages = 500;
  const answers = Array.from({ length: pages }, (_, index) => {
    const number = index + 1;
    // A summary of AO3's usual length, so the works weigh what real ones do.
    const rows = Array.from({ length: 20 }, (_, row) => work(number * 100 + row, {
      title: `Invented work ${number}-${row}`,
      summary: "An invented summary of an invented story. ".repeat(14),
    }));
    return ok(rows, number === pages ? null : number + 1, { last: pages });
  });
  const h = harness({ answers, store });
  await h.history.start(USER, TAB);
  await h.drive({ limit: 5_000 });
  const view = await h.history.view();
  assert.equal(view.status, "finished");
  assert.equal(view.pagesRead, pages);
  assert.equal(view.works, 10_000);
  const kept = await store.readWorks();
  assert.equal(kept.length, 10_000);
  assert.ok(new TextEncoder().encode(JSON.stringify(kept)).byteLength > 5 * 1_024 * 1_024);
});
