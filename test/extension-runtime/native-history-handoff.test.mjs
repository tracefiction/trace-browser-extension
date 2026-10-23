import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HISTORY_MAXIMUM_PART_BYTES,
  HISTORY_MAXIMUM_PART_ITEMS,
  NativeHistoryHandoffProducer,
  historyImportItem,
  historyParts,
} from "../../.trace-build/extension-runtime/native-history-handoff.mjs";

// Invented works and account throughout.
const requestID = "00000000-0000-4000-8000-000000000001";
const handoffID = "00000000-0000-4000-8000-000000000002";
const now = 1_800_000_000_000;
const scope = { accountId: "synthetic-account", epoch: 7 };

function work(id, overrides = {}) {
  return {
    id: String(id), title: `Synthetic work ${id} café 📚`, authors: ["Synthetic_Quill", "Second_Quill"],
    fandoms: ["Invented Lanterns"], tags: ["Found Family"], summary: `Invented summary ${id}.`,
    words: 12_345, chapters: "3/3", lastVisited: "2026-10-08", visits: 3, later: false, ...overrides,
  };
}

test("a History work becomes an Import listing item with its History fields", () => {
  assert.deepEqual(historyImportItem(work(1)), {
    src: "ao3", ctx: "listing", u: "https://archiveofourown.org/works/1", t: "Synthetic work 1 café 📚",
    a: "Synthetic_Quill", fms: ["Invented Lanterns"], tags: ["Found Family"], sm: "Invented summary 1.",
    w: 12_345, chPub: 3, cht: 3, s: "complete", lv: "2026-10-08", vc: 3,
  });
  const wip = historyImportItem(work(2, { chapters: "4/?", authors: [], summary: "", words: null }));
  assert.deepEqual([wip.chPub, wip.cht, wip.s, "a" in wip, "sm" in wip, "w" in wip], [4, "?", "wip", false, false, false]);
  const later = historyImportItem(work(3, { later: true, lastVisited: null, visits: null }));
  assert.equal(later.ml, true);
  assert.equal("lv" in later || "vc" in later, false, "a work marked for later carries no visit");
});

test("the History is cut into bounded parts, newest visit first, with the digest of the whole", async () => {
  const works = Array.from({ length: 2_500 }, (_, index) => work(index + 1, {
    lastVisited: `2026-${String((index % 12) + 1).padStart(2, "0")}-01`,
    summary: "An invented summary of an invented story. ".repeat(10),
  }));
  const history = await historyParts(works, "2026-10-22T07:00:00.000Z");
  assert.ok(history.parts.length >= 3);
  let previous = "9999";
  let count = 0;
  for (const part of history.parts) {
    assert.ok(part.byteLength <= HISTORY_MAXIMUM_PART_BYTES);
    const json = JSON.parse(new TextDecoder().decode(part));
    assert.deepEqual(Object.keys(json).sort(), ["at", "items", "s"]);
    assert.equal(json.s, "ao3-history");
    assert.ok(json.items.length <= HISTORY_MAXIMUM_PART_ITEMS);
    for (const item of json.items) {
      assert.ok(item.lv <= previous, "newest visit first");
      previous = item.lv;
    }
    count += json.items.length;
  }
  assert.equal(count, 2_500);
  assert.equal(history.itemCount, 2_500);
  assert.equal(history.byteCount, history.parts.reduce((total, part) => total + part.byteLength, 0));
  const whole = createHash("sha256");
  for (const part of history.parts) whole.update(part);
  assert.equal(history.sha256, whole.digest("hex"));
  assert.equal(await historyParts([], "x"), null, "nothing to hand over");
});

function fixture({ intercept = () => undefined, parts = 3 } = {}) {
  const messages = [];
  let current = true;
  const runtime = {
    sendNativeMessage(...args) {
      const message = args.find((value) => value && typeof value === "object");
      messages.push(message);
      const override = intercept(message);
      if (override !== undefined) return Promise.resolve(override);
      if (message.type === "TRACE_IOS_HISTORY_PREPARE") {
        return Promise.resolve({ type: message.type, protocolVersion: 1, ok: true, state: "prepared", handoffID,
          expiresAtMs: now + 1_800_000, receivedParts: 0, maximumPartBytes: 393_216, maximumParts: 128, maximumItems: 25_000 });
      }
      if (message.type === "TRACE_IOS_HISTORY_STAGE") {
        const received = messages.filter((m) => m.type === "TRACE_IOS_HISTORY_STAGE").length;
        return Promise.resolve({ type: message.type, protocolVersion: 1, ok: true, handoffID, expiresAtMs: now + 1_800_000,
          state: received === parts ? "ready_to_open" : "staging", receivedParts: received });
      }
      return Promise.resolve({ type: message.type, protocolVersion: 1, ok: true, state: "cancelled" });
    },
  };
  const producer = new NativeHistoryHandoffProducer({ runtime, mode: "promise",
    apiOrigin: "https://development.example.test", randomID: () => requestID, now: () => now });
  const history = {
    parts: Array.from({ length: parts }, (_, index) => new TextEncoder().encode(`{"s":"ao3-history","at":"x","items":[${index}]}`)),
    byteCount: 120, itemCount: 30, sha256: "a".repeat(64),
  };
  return { producer, messages, history, setCurrent: (value) => { current = value; },
    run: () => producer.run(scope, async () => current, history) };
}

test("the producer declares the whole History, stages every part in order, and returns only the continuation", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { ok: true, state: "ready_to_open", handoffID, expiresAtMs: now + 1_800_000 });
  assert.deepEqual(f.messages.map((m) => m.type), [
    "TRACE_IOS_HISTORY_PREPARE", "TRACE_IOS_HISTORY_STAGE", "TRACE_IOS_HISTORY_STAGE", "TRACE_IOS_HISTORY_STAGE",
  ]);
  const prepare = f.messages[0];
  assert.deepEqual([prepare.partCount, prepare.byteCount, prepare.itemCount, prepare.sha256, prepare.accountID, prepare.accountEpoch],
    [3, 120, 30, "a".repeat(64), "synthetic-account", 7]);
  assert.equal(prepare.apiOrigin, "https://development.example.test");
  assert.deepEqual(f.messages.slice(1).map((m) => m.partIndex), [0, 1, 2]);
  assert.deepEqual(Buffer.from(f.messages[2].partBase64, "base64"), Buffer.from(f.history.parts[1]));
  assert.ok(f.messages.every((m) => !("credential" in m) && !("token" in m) && !("profileID" in m)));
});

test("a refused part, a wrong acknowledgement or a departed account cancels the History", async () => {
  const refused = fixture({ intercept: (m) => (m.type === "TRACE_IOS_HISTORY_STAGE" && m.partIndex === 1
    ? { type: m.type, protocolVersion: 1, ok: false, error: "conflict" } : undefined) });
  assert.deepEqual(await refused.run(), { ok: false, error: "history_handoff_unavailable" });
  assert.equal(refused.messages.at(-1).type, "TRACE_IOS_HISTORY_CANCEL");
  assert.equal(refused.messages.at(-1).handoffID, handoffID);

  const early = fixture({ intercept: (m) => (m.type === "TRACE_IOS_HISTORY_STAGE" && m.partIndex === 0
    ? { type: m.type, protocolVersion: 1, ok: true, handoffID, expiresAtMs: now + 1_800_000, state: "ready_to_open" } : undefined) });
  assert.equal((await early.run()).ok, false, "ready before the last part is not believed");

  const limits = fixture({ intercept: (m) => (m.type === "TRACE_IOS_HISTORY_PREPARE"
    ? { type: m.type, protocolVersion: 1, ok: true, state: "prepared", handoffID, expiresAtMs: now + 1_800_000,
      maximumPartBytes: 524_288, maximumParts: 128, maximumItems: 25_000 } : undefined) });
  assert.equal((await limits.run()).ok, false, "other limits than this producer's are not believed");

  const departed = fixture({ intercept: (m) => {
    if (m.type === "TRACE_IOS_HISTORY_STAGE" && m.partIndex === 0) departed.setCurrent(false);
    return undefined;
  } });
  assert.equal((await departed.run()).ok, false);
  assert.equal(departed.messages.at(-1).type, "TRACE_IOS_HISTORY_CANCEL");

  const unsupported = fixture({ intercept: () => ({ ok: false, error: "unsupported" }) });
  assert.equal((await unsupported.run()).ok, false);
  assert.deepEqual(unsupported.messages.map((m) => m.type), ["TRACE_IOS_HISTORY_PREPARE"], "nothing staged");
});

test("a staged History whose account left is cancelled", async () => {
  const f = fixture();
  await f.run();
  await f.producer.discardUnpublished();
  assert.equal(f.messages.at(-1).type, "TRACE_IOS_HISTORY_CANCEL");
  const sent = f.messages.length;
  await f.producer.discardUnpublished();
  assert.equal(f.messages.length, sent, "once");
});
