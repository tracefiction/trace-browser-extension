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
