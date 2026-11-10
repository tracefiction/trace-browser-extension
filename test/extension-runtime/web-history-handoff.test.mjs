import assert from "node:assert/strict";
import test from "node:test";

import { historyParts } from "../../.trace-build/extension-runtime/native-history-handoff.mjs";
import {
  WEB_HISTORY_LIFETIME_MS,
  WEB_HISTORY_RECEIVED,
  WEB_HISTORY_REQUEST,
  WebHistoryHandoff,
} from "../../.trace-build/extension-runtime/web-history-handoff.mjs";

// Invented works, account and ids throughout.
const handoffID = "00000000-0000-4000-8000-0000000000aa";
const account = "synthetic-account";
const start = 1_800_000_000_000;

function work(id, lastVisited) {
  return { id: String(id), title: `Synthetic work ${id}`, authors: ["Synthetic_Quill"], fandoms: [], tags: [],
    summary: "", words: 1_000, chapters: "1/1", lastVisited, visits: 1, later: false };
}

async function offered(count = 3, clock = { now: start }) {
  const web = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test/", randomID: () => handoffID,
    now: () => clock.now });
  const history = await historyParts(Array.from({ length: count }, (_, i) => work(i + 1, `2026-0${(i % 9) + 1}-01`)),
    "2026-10-27T12:00:00.000Z");
  return { web, history, offer: await web.offer(account, history), clock };
}

test("Review in Trace on a computer offers the History to Trace's review page, by a fragment the server never sees", async () => {
  const { offer } = await offered();
  assert.deepEqual(offer, { ok: true, state: "opened_on_web", handoffID, expiresAtMs: start + WEB_HISTORY_LIFETIME_MS,
    url: `https://www.tracefiction.test/import/history#handoff=${handoffID}` });
});

test("the page gets the declaration, then each part as the iPhone's JSON, for the account that read it", async () => {
  const { web, history } = await offered(2_500);
  const declaration = await web.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: "declaration" }, account);
  assert.deepEqual(declaration, { ok: true, kind: "declaration", handoffID, accountId: account,
    partCount: history.parts.length, byteCount: history.byteCount, itemCount: 2_500, sha256: history.sha256,
    expiresAtMs: start + WEB_HISTORY_LIFETIME_MS });
  assert.ok(history.parts.length >= 3, "a History of thousands goes in several parts");
  let items = 0;
  for (let part = 0; part < history.parts.length; part += 1) {
    const answer = await web.answer({ type: WEB_HISTORY_REQUEST, handoffID, part }, account);
    assert.equal(answer.kind, "part");
    assert.equal(answer.text, new TextDecoder().decode(history.parts[part]));
    const parsed = JSON.parse(answer.text);
    assert.equal(parsed.s, "ao3-history");
    items += parsed.items.length;
  }
  assert.equal(items, 2_500);
  // A part asked for again is given again: the page retries a part that failed.
  assert.equal((await web.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: 0 }, account)).kind, "part");
});

test("nothing is given to another account, after it expires, for another id, or once received", async () => {
  const { web, clock } = await offered();
  const ask = (extra = {}, who = account) => web.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: 0, ...extra }, who);
  assert.deepEqual(await ask({}, "another-account"), { ok: false, error: "history_handoff_account_changed" });
  assert.deepEqual(await ask({}, null), { ok: false, error: "history_handoff_not_connected" }, "a moment's disconnect is not another account");
  assert.deepEqual(await ask({ handoffID: "00000000-0000-4000-8000-0000000000bb" }), { ok: false, error: "history_handoff_unknown" });
  assert.deepEqual(await ask({ part: 99 }), { ok: false, error: "history_handoff_bad_request" });
  assert.deepEqual(await ask({ part: "1" }), { ok: false, error: "history_handoff_bad_request" });
  assert.deepEqual(await web.answer({ type: "OTHER", handoffID }, account), { ok: false, error: "history_handoff_bad_request" });
  assert.deepEqual(await web.answer({ type: WEB_HISTORY_RECEIVED, handoffID }, account), { ok: true, kind: "received" });
  assert.deepEqual(await ask(), { ok: false, error: "history_handoff_unknown" }, "a received History is spent");

  const later = await offered(3, clock);
  later.clock.now = start + WEB_HISTORY_LIFETIME_MS;
  assert.deepEqual(await later.web.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: 0 }, account),
    { ok: false, error: "history_handoff_expired" });

  const left = await offered();
  await left.web.discard();
  assert.deepEqual(await left.web.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: 0 }, account),
    { ok: false, error: "history_handoff_unknown" }, "an account that left takes its History with it");
});

test("a bad id or an empty History is never offered", async () => {
  const web = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => "not-a-uuid" });
  const { history } = await offered();
  assert.deepEqual(await web.offer(account, history), { ok: false, error: "history_handoff_unavailable" });
  const fine = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => handoffID });
  assert.deepEqual(await fine.offer("", history), { ok: false, error: "history_handoff_unavailable" });
});

test("an offer outlives a background restart: kept in session storage, its parts made again from the same works", async () => {
  const kept = new Map();
  const keep = { load: async () => kept.get("offer") ?? null, save: async (v) => { kept.set("offer", v); }, clear: async () => { kept.delete("offer"); } };
  const works = Array.from({ length: 1_200 }, (_, i) => work(i + 1, "2026-03-01"));
  const first = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => handoffID, now: () => start, keep });
  const history = await historyParts(works, "2026-10-27T12:00:00.000Z");
  await first.offer(account, history);
  // The background stops; a new one starts with nothing in memory.
  const restarted = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => handoffID, now: () => start + 60_000, keep });
  restarted.useSource((at) => historyParts(works, at));
  const declaration = await restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: "declaration" }, account);
  assert.equal(declaration.sha256, history.sha256, "the same parts, made again");
  const part = await restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: 1 }, account);
  assert.equal(part.text, new TextDecoder().decode(history.parts[1]));

  // Works changed since (the run carried on): nothing that wasn't offered is given out.
  const changed = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => handoffID, now: () => start + 60_000, keep });
  changed.useSource((at) => historyParts([...works, work(9_999, "2026-10-01")], at));
  assert.deepEqual(await changed.answer({ type: WEB_HISTORY_REQUEST, handoffID, part: 0 }, account), { ok: false, error: "history_handoff_unknown" });

  await restarted.answer({ type: WEB_HISTORY_RECEIVED, handoffID }, account);
  assert.equal(kept.size, 0, "received: the kept offer is gone too");
});

test("after a restart one rebuild serves every request, and a newer offer is never replaced by it", async () => {
  const kept = new Map();
  const keep = { load: async () => kept.get("offer") ?? null, save: async (v) => { kept.set("offer", v); }, clear: async () => { kept.delete("offer"); } };
  const older = Array.from({ length: 50 }, (_, i) => work(i + 1, "2026-03-01"));
  const newer = [...older, work(999, "2026-10-01")];
  const ids = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"];
  const first = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => ids[0], now: () => start, keep });
  await first.offer(account, await historyParts(older, "2026-10-27T12:00:00.000Z"));

  let rebuilds = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const restarted = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => ids[1], now: () => start, keep });
  restarted.useSource(async (at) => { rebuilds += 1; await gate; return historyParts(older, at); });
  const asking = [0, 1, 2].map(() => restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[0], part: "declaration" }, account));
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The reader carried on and chose Review again meanwhile.
  const fresh = await historyParts(newer, "2026-10-27T13:00:00.000Z");
  await restarted.offer(account, fresh);
  release();
  const answers = await Promise.all(asking);
  assert.equal(rebuilds, 1, "one rebuild for every request");
  assert.ok(answers.every((answer) => answer.ok === false), "the withdrawn offer answers nothing");
  const declaration = await restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[1], part: "declaration" }, account);
  assert.equal(declaration.sha256, fresh.sha256, "the newer offer keeps its own parts");
  assert.equal(declaration.itemCount, 51);
});

test("the declaration says how much of the History is on offer: a year first, then the whole of it in its place", async () => {
  const ids = ["00000000-0000-4000-8000-0000000000c1", "00000000-0000-4000-8000-0000000000c2"];
  const kept = new Map();
  const keep = { load: async () => kept.get("offer") ?? null, save: async (v) => { kept.set("offer", v); }, clear: async () => { kept.delete("offer"); } };
  const year = [work(1, "2026-11-03"), work(2, "2026-01-01")];
  const all = [...year, work(3, "2025-12-31"), work(4, "2019-03-17")];
  const since = (works, day) => (day === null ? works : works.filter((w) => w.lastVisited >= day));
  let next = 0;
  const web = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => ids[next], now: () => start, keep });
  const yearCoverage = { complete: false, since: "2026-01-01", through: "2025-12-31", deleted: 1, unreadable: 0, started: "2026-11-10T11:40:00.000Z" };
  const yearParts = await historyParts(year, "2026-11-10T12:00:00.000Z");
  await web.offer(account, yearParts, yearCoverage);
  const first = await web.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[0], part: "declaration" }, account);
  assert.deepEqual(first, { ok: true, kind: "declaration", handoffID: ids[0], accountId: account, partCount: 1,
    byteCount: yearParts.byteCount, itemCount: 2, sha256: yearParts.sha256, expiresAtMs: start + WEB_HISTORY_LIFETIME_MS, ...yearCoverage });

  // The background stops while the run reads on: the year is made again from the works kept, older ones left out.
  const restarted = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => ids[1], now: () => start + 60_000, keep });
  restarted.useSource((at, day) => historyParts(since(all, day), at));
  const again = await restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[0], part: "declaration" }, account);
  assert.deepEqual(again, first, "the same year and the same account of it, though the run has kept more since");
  assert.equal((await restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[0], part: 0 }, account)).text,
    new TextDecoder().decode(yearParts.parts[0]));

  // The read finishes and the reader chooses Review in Trace: the whole History takes the year's place.
  const wholeParts = await historyParts(all, "2026-11-10T12:30:00.000Z");
  // A story the run kept since, opened in the year: the year as offered is gone, and nothing else is given in its name.
  const moved = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => ids[1], now: () => start + 60_000, keep });
  moved.useSource((at, day) => historyParts(since([...all, work(5, "2026-06-01")], day), at));
  assert.deepEqual(await moved.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[0], part: 0 }, account), { ok: false, error: "history_handoff_unknown" });

  await restarted.offer(account, wholeParts, { complete: true, since: null, through: "2019-03-17", deleted: 4, unreadable: 1, started: null });
  assert.deepEqual(await restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[0], part: "declaration" }, account),
    { ok: false, error: "history_handoff_unknown" }, "the year is no longer on offer");
  const whole = await restarted.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[1], part: "declaration" }, account);
  assert.deepEqual([whole.complete, whole.since, whole.through, whole.deleted, whole.unreadable, whole.itemCount],
    [true, null, "2019-03-17", 4, 1, 4]);

  // A coverage that makes no sense is never offered as if it were the whole History.
  next = 0;
  const plain = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => ids[0], now: () => start });
  assert.deepEqual(await plain.offer(account, yearParts, { complete: "yes", since: "January", through: null, deleted: -1, unreadable: 0 }),
    { ok: false, error: "history_handoff_unavailable" });
  // An offer kept by an earlier version has no coverage: it is made again as the whole of what was kept, and says nothing more.
  kept.set("offer", { v: 1, handoffID: ids[0], accountId: account, expiresAtMs: start + WEB_HISTORY_LIFETIME_MS,
    capturedAt: "2026-11-10T12:30:00.000Z", sha256: wholeParts.sha256 });
  const olderOffer = new WebHistoryHandoff({ webOrigin: "https://www.tracefiction.test", randomID: () => ids[1], now: () => start, keep });
  olderOffer.useSource((at, day) => historyParts(since(all, day), at));
  const bare = await olderOffer.answer({ type: WEB_HISTORY_REQUEST, handoffID: ids[0], part: "declaration" }, account);
  assert.deepEqual([bare.itemCount, "complete" in bare, "since" in bare], [4, false, false]);
});
