import assert from "node:assert/strict";
import test from "node:test";

import {
  StoryCommandApi,
} from "../../.trace-build/extension-runtime/story-command.mjs";
import {
  storyTrackCommandFromMessage,
} from "../../.trace-build/extension-runtime/story-command-sender.mjs";

const entryId = "00000000-0000-4000-8000-000000000123";
const sender = {
  frameId: 0,
  tab: {
    url: "https://www.fanfiction.net/s/7038840/2/A-Chance-Encounter",
  },
};
const message = {
  type: "TRACE_CONNECT_AND_SAVE",
  workKey: "ffn:7038840",
  handoffId: "handoff_7038840",
  payload: {
    s: "ffn",
    at: "2026-07-19T12:00:00.000Z",
    item: {
      src: "ffn",
      ctx: "story",
      u: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
      t: "A Chance Encounter",
      chn: 2,
    },
  },
};

function confirmationData(overrides = {}) {
  return {
    entry_id: entryId,
    type: "created",
    work_key: "ffn:7038840",
    entry: {
      status: "READING",
      readerStatus: "READING",
      canonicalReaderStatus: "READING",
      entryId,
      chapters: { current: 2, total: 12 },
    },
    syncVersion: "2026-07-19T12:00:01.000Z",
    ...overrides,
  };
}

test("story command derives identity from matching top-frame sender and bounded payload", () => {
  const command = storyTrackCommandFromMessage(message, sender);
  assert.deepEqual(command, {
    intent: "ensure_saved",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    payload: message.payload,
    handoffId: "handoff_7038840",
  });
  assert.notEqual(command.payload, message.payload);
});

test("auto-track derives a progress target and never accepts a listing sender", () => {
  const autoTrack = storyTrackCommandFromMessage({
    ...message,
    type: "TRACE_AUTO_TRACK",
    handoffId: "must-not-cross",
    payload: {
      ...message.payload,
      item: {
        ...message.payload.item,
        cht: 12,
      },
    },
  }, sender);
  assert.deepEqual(autoTrack, {
    intent: "record_progress",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    payload: {
      ...message.payload,
      item: {
        ...message.payload.item,
        cht: 12,
      },
    },
    progress: { current: 2, total: 12 },
  });
  assert.equal(storyTrackCommandFromMessage({
    ...message,
    type: "TRACE_AUTO_TRACK",
    payload: {
      ...message.payload,
      item: { ...message.payload.item, ctx: "listing" },
    },
  }, {
    tab: { url: "https://www.fanfiction.net/book/" },
  }), null);
});

test("quick-add accepts bounded same-host listing payloads without a story sender key", () => {
  const quickAdd = storyTrackCommandFromMessage({
    ...message,
    type: "TRACE_QUICK_ADD",
    handoffId: "must-not-cross",
    payload: {
      ...message.payload,
      item: { ...message.payload.item, ctx: "listing" },
    },
  }, {
    frameId: 0,
    tab: { url: "https://www.fanfiction.net/book/" },
  });
  assert.equal(quickAdd.intent, "ensure_saved");
  assert.equal(quickAdd.workKey, "ffn:7038840");
  assert.equal(quickAdd.handoffId, undefined);
});

test("story command rejects subframes, host/work mismatches, listings, and oversized payloads", () => {
  assert.equal(storyTrackCommandFromMessage(message, { ...sender, frameId: 4 }), null);
  assert.equal(storyTrackCommandFromMessage({
    ...message,
    workKey: "ffn:999",
  }, sender), null);
  assert.equal(storyTrackCommandFromMessage({
    ...message,
    payload: {
      ...message.payload,
      item: { ...message.payload.item, u: "https://www.fanfiction.net/s/999/1/Wrong" },
    },
  }, sender), null);
  assert.equal(storyTrackCommandFromMessage({
    ...message,
    payload: {
      ...message.payload,
      item: { ...message.payload.item, ctx: "listing" },
    },
  }, sender), null);
  assert.equal(storyTrackCommandFromMessage({
    ...message,
    payload: {
      ...message.payload,
      item: { ...message.payload.item, sm: "x".repeat(70_000) },
    },
  }, sender), null);
});

test("track adapter accepts only exact authoritative entry confirmation", async () => {
  const calls = [];
  const api = new StoryCommandApi(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      success: true,
      data: confirmationData(),
    }), { status: 200 });
  }, "https://api.tracefiction.com");
  const command = storyTrackCommandFromMessage(message, sender);
  const result = await api.track("private-token", command);
  assert.equal(result.kind, "success");
  assert.equal(result.value.kind, "confirmed");
  assert.equal(result.value.confirmation.workKey, "ffn:7038840");
  assert.equal(result.value.confirmation.entryId, entryId);
  assert.equal(calls[0].url, "https://api.tracefiction.com/api/extension/track");
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-token");
  const {readingActivity, ...payload}=JSON.parse(calls[0].options.body);
  assert.deepEqual(payload, message.payload);
  assert.match(readingActivity.operationId,/^[0-9a-f-]{36}$/i);
  await api.track("refreshed-token", command);
  assert.equal(calls[0].options.body,calls[1].options.body);
  await api.track("refreshed-token", {...command});
  assert.notEqual(readingActivity.operationId,JSON.parse(calls[2].options.body).readingActivity.operationId);
});

test("malformed or mismatched 2xx track responses are uncertain, never confirmed", async () => {
  const responses = [
    confirmationData({ work_key: "ffn:999" }),
    confirmationData({ entry_id: "not-a-uuid" }),
    confirmationData({ entry: { status: "NOT_A_STATUS", entryId } }),
    null,
  ];
  const api = new StoryCommandApi(async () => new Response(JSON.stringify({
    success: true,
    data: responses.shift(),
  }), { status: 200 }), "https://api.tracefiction.com");
  const command = storyTrackCommandFromMessage(message, sender);
  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(await api.track("private-token", command), {
      kind: "success",
      value: { kind: "uncertain" },
    });
  }
});

test("track adapter preserves definitive auth, cap, validation, and rate-limit outcomes", async () => {
  const statuses = [401, 400, 402, 429, 503];
  const api = new StoryCommandApi(async () => new Response("", {
    status: statuses.shift(),
  }), "https://api.tracefiction.com");
  const command = storyTrackCommandFromMessage(message, sender);
  assert.deepEqual(await api.track("token", command), { kind: "auth_rejected" });
  assert.deepEqual(await api.track("token", command), {
    kind: "success",
    value: { kind: "rejected", reason: "invalid_request" },
  });
  assert.deepEqual(await api.track("token", command), {
    kind: "success",
    value: { kind: "rejected", reason: "free_limit_reached" },
  });
  assert.deepEqual(await api.track("token", command), {
    kind: "success",
    value: { kind: "rejected", reason: "rate_limited" },
  });
  assert.deepEqual(await api.track("token", command), {
    kind: "success",
    value: { kind: "uncertain" },
  });
});

test("lookup returns a targeted authoritative confirmation or exact absence", async () => {
  const bodies = [
    {
      success: true,
      data: {
        entries: { "ffn:7038840": confirmationData().entry },
        workPreferences: {},
        syncVersion: "2026-07-19T12:00:01.000Z",
      },
    },
    {
      success: true,
      data: {
        entries: {},
        workPreferences: {},
        syncVersion: "2026-07-19T12:00:02.000Z",
      },
    },
  ];
  const api = new StoryCommandApi(
    async () => new Response(JSON.stringify(bodies.shift()), { status: 200 }),
    "https://api.tracefiction.com",
  );
  const found = await api.lookup("token", "ffn:7038840");
  assert.equal(found.kind, "success");
  assert.equal(found.value.kind, "found");
  assert.equal(found.value.confirmation.entryId, entryId);
  assert.deepEqual(await api.lookup("token", "ffn:7038840"), {
    kind: "success",
    value: { kind: "absent" },
  });
});


test("native exact receipt is independent of a failed heartbeat", async () => {
  const { NativeStorySaveReceiptPort } = await import("../../.trace-build/extension-runtime/browser-adapters.mjs");
  const context = { attemptID: "attempt", operationID: "operation", initiatedAt: 100 };
  const messages = [];
  const runtime = { async sendNativeMessage(message) {
    messages.push(message);
    if (message.type === "TRACE_IOS_SAVE_PREPARE") return { ok: true, context };
    return { ok: message.type === "TRACE_IOS_SAVE_CONFIRMED" };
  } };
  const port = new NativeStorySaveReceiptPort(runtime, "promise", "https://api.tracefiction.com");
  const prepared = await port.prepareSaveReceipt("account-a");
  assert.deepEqual(prepared, context);
  assert.equal(await port.publishSaveReceipt({ accountID: "account-a", entryID: entryId,
    workKey: "ffn:7038840", source: "mutation", context: prepared,
    hostKind: "ffn", action: "quick_add", at: 200 }), true);
  assert.equal(messages[1].type, "TRACE_IOS_SAVE_CONFIRMED");
  assert.equal(messages[1].entryID, entryId);
  assert.equal(messages[1].accountID, "account-a");
  assert.equal(messages[1].apiOrigin, "https://api.tracefiction.com");
  assert.equal(messages[2].type, "TRACE_IOS_EXTENSION_HEARTBEAT");
  assert.equal("entryID" in messages[2], false);
});

test("confirmed automatic reading reaches native without becoming a quick-add heartbeat", async () => {
  const { NativeStorySaveReceiptPort } = await import("../../.trace-build/extension-runtime/browser-adapters.mjs");
  const context = { attemptID: "attempt", operationID: "operation", initiatedAt: 100 };
  const messages = [];
  const runtime = { async sendNativeMessage(message) {
    messages.push(message);
    return message.type === "TRACE_IOS_SAVE_PREPARE" ? { ok: true, context } : { ok: true };
  } };
  const port = new NativeStorySaveReceiptPort(runtime, "promise", "https://api.tracefiction.com");
  const prepared = await port.prepareSaveReceipt("account-a");
  assert.equal(await port.publishSaveReceipt({ accountID: "account-a", entryID: entryId,
    workKey: "ffn:5782108", source: "mutation", context: prepared,
    hostKind: "ffn", action: "read", at: 200 }), true);
  assert.deepEqual(messages.map(message => message.type), ["TRACE_IOS_SAVE_PREPARE", "TRACE_IOS_SAVE_CONFIRMED"]);
  assert.equal(messages[1].entryID, entryId);
  assert.equal(await port.publishSaveReceipt({ accountID: "account-a", entryID: entryId,
    workKey: "ffn:5782108", source: "mutation", hostKind: "ffn", action: "read", at: 200 }), false);
  assert.equal(messages.length, 2, "Without native context, ordinary reading does not gain an action heartbeat");
});
