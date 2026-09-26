import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  LibraryCommandApi,
} from "../../.trace-build/extension-runtime/library-command.mjs";
import {
  finishQualificationCommandFromMessage,
  libraryMutationCommandFromMessage,
} from "../../.trace-build/extension-runtime/library-command-sender.mjs";
import {
  installSessionRuntime,
} from "../../.trace-build/extension-runtime/controller.mjs";
import {
  BrowserPrivateRecordDatabase,
  PRIVATE_RECORD_KEYS,
} from "../../.trace-build/extension-runtime/private-database.mjs";

const entryId = "00000000-0000-4000-8000-000000000123";
const finishOperationId = "00000000-0000-4000-8000-000000000001";
const authoritativeEntry = Object.freeze({
  status: "READING",
  readerStatus: "READING",
  canonicalReaderStatus: "CAUGHT_UP",
  entryId,
  chapters: Object.freeze({ current: 12, total: 12 }),
  workStatus: "wip",
  workStatusProvenance: "source",
});
const storySender = {
  frameId: 0,
  tab: { url: "https://www.fanfiction.net/s/7038840/4/A-Chance-Encounter" },
};
const listingSender = {
  frameId: 0,
  tab: { url: "https://www.fanfiction.net/book/" },
};

test("library mutation sender derives bounded same-host commands", () => {
  assert.deepEqual(libraryMutationCommandFromMessage({
    type: "TRACE_SET_READER_STATUS",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      status: "PLANNING",
      progress: { unit: "CHAPTER", value: 1, total: 12 },
    },
  }, storySender), {
    kind: "entry_patch",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    patch: {
      status: "SAVED",
      progress: { unit: "CHAPTER", value: 1, total: 12 },
    },
  });
  assert.deepEqual(libraryMutationCommandFromMessage({
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ffn:7038840", hidden: true },
  }, listingSender), {
    kind: "work_preference",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    hidden: true,
  });
});

test("library mutation sender rejects subframes, cross-host keys, and story mismatches", () => {
  const message = {
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      patch: { rating: 5 },
    },
  };
  assert.equal(libraryMutationCommandFromMessage(message, { ...storySender, frameId: 2 }), null);
  assert.equal(libraryMutationCommandFromMessage({
    ...message,
    payload: { ...message.payload, workKey: "ao3:7038840" },
  }, listingSender), null);
  assert.equal(libraryMutationCommandFromMessage({
    ...message,
    payload: { ...message.payload, workKey: "ffn:999" },
  }, storySender), null);
});

test("finish qualification sender requires exact story identity and resolved fields", () => {
  const command = finishQualificationCommandFromMessage({
    type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      source: "ffn",
      chapter: 12,
      total: 12,
      state: "resolved",
      workStatus: "hiatus",
      readerStatus: "CAUGHT_UP",
      resolutionSource: "source",
    },
  }, storySender);
  assert.equal(command.kind, "finish_qualification");
  assert.equal(command.workStatus, "hiatus");
  assert.equal(command.resolutionSource, "source");
  const legacyCommand = finishQualificationCommandFromMessage({
    type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      source: "ffn",
      chapter: 12,
      total: 12,
      state: "resolved",
      workStatus: "complete",
    },
  }, storySender);
  assert.equal(legacyCommand.resolutionSource, "reader");
  assert.equal(finishQualificationCommandFromMessage({
    type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      source: "ao3",
      chapter: 12,
      total: 12,
      state: "open",
    },
  }, storySender), null);
  assert.equal(finishQualificationCommandFromMessage({
    type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      source: "ffn",
      chapter: 13,
      total: 12,
      state: "open",
    },
  }, storySender), null);
});

test("finish qualification API sends source provenance through the scoped endpoint", async () => {
  const calls = [];
  const api = new LibraryCommandApi(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      success: true,
      data: {
        state: "resolved",
        eventId: null,
        operationId: finishOperationId,
        workKey: "ffn:7038840",
        entry: authoritativeEntry,
        syncVersion: "2026-07-20T09:00:00.000Z",
      },
    }), { status: 200 });
  }, "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "wip",
    resolutionSource: "source",
    operationId: finishOperationId,
  };

  assert.deepEqual(await api.qualifyFinish("trd_v1_device-credential", command), {
    kind: "success",
    value: {
      kind: "acknowledged",
      state: "resolved",
      eventId: null,
      operationId: finishOperationId,
      workKey: "ffn:7038840",
      entry: authoritativeEntry,
      syncVersion: "2026-07-20T09:00:00.000Z",
    },
  });
  assert.equal(new URL(calls[0].url).pathname, "/api/extension/finish-qualification");
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer trd_v1_device-credential",
  );
  const {readingActivity, ...body}=JSON.parse(calls[0].options.body);
  assert.match(readingActivity.calendarDate,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(readingActivity.operationId,undefined);
  assert.deepEqual(body, {
    entryId,
    workKey: "ffn:7038840",
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    operationId: finishOperationId,
    workStatus: "wip",
    resolutionSource: "source",
  });
});

test("finish qualification API accepts authoritative open and ignored results", async () => {
  const responses = ["open", "ignored"];
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    success: true,
    data: {
      state: responses.shift(),
      eventId: null,
      operationId: null,
      workKey: "ffn:7038840",
      entry: authoritativeEntry,
    },
  }), { status: 200 }), "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "open",
  };

  for (const state of ["open", "ignored"]) {
    assert.deepEqual(await api.qualifyFinish("token", command), {
      kind: "success",
      value: {
        kind: "acknowledged",
        state,
        eventId: null,
        operationId: null,
        workKey: "ffn:7038840",
        entry: authoritativeEntry,
      },
    });
  }
});

test("finish qualification API accepts an operation-scoped ignored deletion receipt", async () => {
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    success: true,
    data: {
      state: "ignored",
      eventId: null,
      operationId: finishOperationId,
      workKey: null,
      entry: null,
      syncVersion: null,
    },
  }), { status: 200 }), "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    operationId: finishOperationId,
    workStatus: "wip",
    resolutionSource: "source",
  };

  assert.deepEqual(await api.qualifyFinish("token", command), {
    kind: "success",
    value: {
      kind: "acknowledged",
      state: "ignored",
      eventId: null,
      operationId: finishOperationId,
      workKey: null,
      entry: null,
      syncVersion: null,
    },
  });
});

test("finish qualification API accepts a resolved receipt replay after deletion", async () => {
  const eventId = "00000000-0000-4000-8000-000000000999";
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    success: true,
    data: {
      state: "resolved",
      eventId,
      operationId: finishOperationId,
      workKey: null,
      entry: null,
      syncVersion: null,
    },
  }), { status: 200 }), "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    operationId: finishOperationId,
    workStatus: "wip",
    resolutionSource: "source",
  };

  assert.deepEqual(await api.qualifyFinish("token", command), {
    kind: "success",
    value: {
      kind: "acknowledged",
      state: "resolved",
      eventId,
      operationId: finishOperationId,
      workKey: null,
      entry: null,
      syncVersion: null,
    },
  });
});

test("finish qualification API accepts a matching replay receipt with a newer projection", async () => {
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    success: true,
    data: {
      state: "resolved",
      eventId: "00000000-0000-4000-8000-000000000999",
      operationId: finishOperationId,
      workKey: "ffn:7038840",
      entry: authoritativeEntry,
      syncVersion: "2026-07-20T09:00:02.000Z",
    },
  }), { status: 200 }), "https://api.tracefiction.com");
  const replayedCommand = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    operationId: finishOperationId,
    workStatus: "hiatus",
    resolutionSource: "reader",
  };

  const result = await api.qualifyFinish("token", replayedCommand);
  assert.equal(result.kind, "success");
  assert.equal(result.value.kind, "acknowledged");
  assert.equal(result.value.operationId, finishOperationId);
  assert.equal(result.value.entry.workStatus, "wip");
});

test("finish qualification API treats operation conflicts as terminal invalid requests", async () => {
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    code: "FINISH_QUALIFICATION_OPERATION_CONFLICT",
  }), { status: 409 }), "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    operationId: finishOperationId,
    workStatus: "wip",
    resolutionSource: "source",
  };

  assert.deepEqual(await api.qualifyFinish("token", command), {
    kind: "success",
    value: { kind: "rejected", reason: "invalid_request" },
  });
});

test("finish qualification API treats the explicit disabled response as terminal", async () => {
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    code: "EXTENSION_FINISH_QUALIFICATION_DISABLED",
    retryable: false,
  }), { status: 503 }), "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    operationId: finishOperationId,
    workStatus: "wip",
    resolutionSource: "source",
  };

  assert.deepEqual(await api.qualifyFinish("token", command), {
    kind: "success",
    value: {
      kind: "rejected",
      reason: "finish_qualification_disabled",
    },
  });
});

test("finish qualification API leaves generic 503 responses retryable", async () => {
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    error: "Temporarily unavailable",
  }), { status: 503 }), "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    operationId: finishOperationId,
    workStatus: "wip",
    resolutionSource: "source",
  };

  assert.deepEqual(await api.qualifyFinish("token", command), {
    kind: "success",
    value: { kind: "uncertain" },
  });
});

test("finish qualification API rejects malformed or mismatched authoritative entries", async () => {
  const responses = [
    {
      state: "open",
      eventId: null,
      workKey: "ffn:7038840",
      entry: authoritativeEntry,
    },
    { state: "resolved", eventId: null, entry: authoritativeEntry },
    {
      state: "resolved",
      eventId: null,
      workKey: "ffn:999",
      entry: authoritativeEntry,
    },
    {
      state: "resolved",
      eventId: null,
      workKey: "ffn:7038840",
      entry: { ...authoritativeEntry, entryId: "00000000-0000-4000-8000-000000000456" },
    },
    {
      state: "resolved",
      eventId: null,
      workKey: "ffn:7038840",
      entry: { ...authoritativeEntry, canonicalReaderStatus: "INVALID" },
    },
  ];
  const api = new LibraryCommandApi(async () => new Response(JSON.stringify({
    success: true,
    data: { operationId: finishOperationId, ...responses.shift() },
  }), { status: 200 }), "https://api.tracefiction.com");
  const command = {
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "wip",
    resolutionSource: "source",
    operationId: finishOperationId,
  };

  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await api.qualifyFinish("token", command), {
      kind: "success",
      value: { kind: "invalid_response" },
    });
  }
});

test("library command API accepts only exact mutation acknowledgements", async () => {
  const calls = [];
  const responses = [
    { data: { entry_id: entryId } },
    {
      success: true,
      data: {
        key: "ffn:7038840",
        browsePreference: { hidden: true },
      },
    },
  ];
  const api = new LibraryCommandApi(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }, "https://api.tracefiction.com");
  const patch = {
    kind: "entry_patch",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    patch: { rating: 5 },
  };
  assert.deepEqual(await api.mutate("private-token", patch), {
    kind: "success",
    value: { kind: "accepted" },
  });
  assert.deepEqual(await api.mutate("private-token", {
    kind: "work_preference",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    hidden: true,
  }), {
    kind: "success",
    value: { kind: "accepted" },
  });
  assert.equal(new URL(calls[0].url).pathname, `/api/extension/library/${entryId}`);
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { rating: 5 });
  assert.equal(new URL(calls[1].url).pathname, "/api/extension/work-preferences");
});

test("library command API treats malformed success and server failures as uncertain", async () => {
  const responses = [
    new Response(JSON.stringify({ data: null }), { status: 200 }),
    new Response("", { status: 503 }),
    new Response("", { status: 401 }),
    new Response("", { status: 429 }),
  ];
  const api = new LibraryCommandApi(async () => responses.shift(), "https://api.tracefiction.com");
  const command = {
    kind: "entry_patch",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    patch: { rating: 5 },
  };
  assert.deepEqual(await api.mutate("token", command), {
    kind: "success",
    value: { kind: "uncertain" },
  });
  assert.deepEqual(await api.mutate("token", command), {
    kind: "success",
    value: { kind: "uncertain" },
  });
  assert.deepEqual(await api.mutate("token", command), { kind: "auth_rejected" });
  assert.deepEqual(await api.mutate("token", command), {
    kind: "success",
    value: { kind: "rejected", reason: "rate_limited" },
  });
});

class StorageArea {
  async get() {
    return {};
  }
  async set() {}
  async remove() {}
}

test("controller owns patch execution and confirms it through the account projection", async () => {
  const databaseFactory = new IDBFactory();
  const database = new BrowserPrivateRecordDatabase(databaseFactory);
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  });
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, {
    version: 1,
    entries: { "credential-a": "private-token" },
  });
  let rating = 0;
  const paths = [];
  const controller = installSessionRuntime({
    mode: "kernel",
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "mac" };
      },
    },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { async clear() { return true; } },
    storageArea: new StorageArea(),
    databaseFactory,
    privateDatabase: database,
    storageMode: "promise",
    fetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/api/extension/account") {
        return new Response(JSON.stringify({
          account_id: "account-a",
          library_count: 1,
          pro: false,
        }), { status: 200 });
      }
      if (path === "/api/extension/library-overlay") {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: {
              "ffn:7038840": {
                status: "PLANNING",
                readerStatus: "PLANNING",
                canonicalReaderStatus: "SAVED",
                entryId,
                rating,
                chapters: { current: 0, total: 12 },
              },
            },
            workPreferences: {},
            syncVersion: `2026-07-20T09:00:0${rating}.000Z`,
          },
        }), { status: 200 });
      }
      assert.equal(path, `/api/extension/library/${entryId}`);
      assert.equal(options.headers.Authorization, "Bearer private-token");
      rating = JSON.parse(options.body).rating;
      return new Response(JSON.stringify({ data: { entry_id: entryId } }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });
  await controller.start();
  const response = await controller.handle({
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      patch: { rating: 5 },
    },
  }, storySender);
  assert.equal(response.ok, true);
  assert.equal(response.command.kind, "confirmed");
  assert.equal(response.command.source, "mutation");
  assert.equal(rating, 5);
  assert.equal(paths.filter((path) => path === `/api/extension/library/${entryId}`).length, 1);
  assert.ok(paths.filter((path) => path === "/api/extension/library-overlay").length >= 2);
});

test("controller returns the server-authoritative finish entry and defaults provenance", async () => {
  const databaseFactory = new IDBFactory();
  const database = new BrowserPrivateRecordDatabase(databaseFactory);
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  });
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, {
    version: 1,
    entries: { "credential-a": "private-token" },
  });
  const finishBodies = [];
  const controller = installSessionRuntime({
    mode: "kernel",
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "mac" };
      },
    },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { async clear() { return true; } },
    storageArea: new StorageArea(),
    databaseFactory,
    privateDatabase: database,
    storageMode: "promise",
    fetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/extension/account") {
        return new Response(JSON.stringify({
          account_id: "account-a",
          library_count: 1,
          pro: false,
        }), { status: 200 });
      }
      if (path === "/api/extension/library-overlay") {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: { "ffn:7038840": authoritativeEntry },
            workPreferences: {},
            syncVersion: "2026-07-20T09:00:00.000Z",
          },
        }), { status: 200 });
      }
      assert.equal(path, "/api/extension/finish-qualification");
      assert.equal(options.headers.Authorization, "Bearer private-token");
      finishBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        success: true,
        data: {
          state: "resolved",
          eventId: "00000000-0000-4000-8000-000000000999",
          operationId: finishOperationId,
          workKey: "ffn:7038840",
          entry: authoritativeEntry,
          syncVersion: "2026-07-20T09:00:01.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => finishOperationId,
  });
  await controller.start();

  const response = await controller.handle({
    type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      source: "ffn",
      chapter: 12,
      total: 12,
      state: "resolved",
      workStatus: "wip",
    },
  }, storySender);

  assert.equal(response.ok, true);
  assert.deepEqual(response.command, {
    kind: "acknowledged",
    state: "resolved",
    eventId: "00000000-0000-4000-8000-000000000999",
    operationId: finishOperationId,
    workKey: "ffn:7038840",
    entry: authoritativeEntry,
    syncVersion: "2026-07-20T09:00:01.000Z",
  });
  assert.equal(finishBodies.length, 1);
  assert.equal(finishBodies[0].resolutionSource, "reader");
  assert.equal(finishBodies[0].operationId, finishOperationId);
});


test("reader status and progress match the strict released extension PATCH contract", async () => {
 const api = new LibraryCommandApi(async (url, options) => {
  assert.equal(new URL(url).pathname, `/api/extension/library/${entryId}`);
  assert.equal(options.headers.Authorization, "Bearer trd_v1_device");
  const body = JSON.parse(options.body);
  const supported = ["status", "progress", "rating", "story_snapshot"];
  if (Object.keys(body).some(k => !supported.includes(k))) return new Response("unknown field", { status: 400 });
  return new Response(JSON.stringify({ data: { entry_id: entryId } }), { status: 200 });
 }, "https://api.tracefiction.com");
 for (const status of ["READING", "SAVED", "CAUGHT_UP", "PAUSED", "FINISHED", "DROPPED"]) {
  const result = await api.mutate("trd_v1_device", { kind: "entry_patch", hostKind: "ffn", workKey: "ffn:7038840", entryId,
   patch: { status, ...(status === "READING" ? { progress: { unit: "CHAPTER", value: 1, total: 12 } } : {}) } });
  assert.deepEqual(result, { kind: "success", value: { kind: "accepted" } });
 }
});

// A fake of the released Trace API for the reader-status path. It mirrors the
// server contract exactly: GET /library-overlay omits `workPreferences` when the
// account has no hidden works (LibraryOverlayResponseSchema marks it optional),
// POST /track creates the entry, and PATCH /library/:entryId accepts only the
// strict extension patch body.
function releasedTraceApi({ entries = {} } = {}) {
  const rows = new Map(Object.entries(entries));
  const patches = [];
  let clock = Date.parse("2026-09-26T00:00:00.000Z");
  const tick = () => new Date((clock += 1_000)).toISOString();
  const legacy = (status) =>
    status === "SAVED" ? "PLANNING"
      : status === "FINISHED" ? "COMPLETED"
        : status === "CAUGHT_UP" ? "READING"
          : status;
  const overlayEntry = (row) => ({
    status: legacy(row.status),
    readerStatus: legacy(row.status),
    canonicalReaderStatus: row.status,
    entryId: row.entryId,
    rating: 0,
    privateContext: { hasNotes: false, tagCount: 0 },
    workStatus: "wip",
    workStatusProvenance: "source",
    catchupState: "BEHIND",
    newChapterCount: 0,
    chapters: { current: row.current, total: row.total },
  });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    assert.equal(options.headers.Authorization, "Bearer private-token");
    if (path === "/api/extension/account") {
      return json({ account_id: "account-a", pro: false, library_count: rows.size });
    }
    if (path === "/api/extension/library-overlay") {
      const data = { entries: {}, syncVersion: new Date(clock).toISOString() };
      for (const [workKey, row] of rows) data.entries[workKey] = overlayEntry(row);
      return json({ success: true, data });
    }
    if (path === "/api/extension/track" && method === "POST") {
      const body = JSON.parse(options.body);
      const workKey = `${body.s}:${/\/s\/(\d+)/.exec(body.item.u)[1]}`;
      const row = rows.get(workKey) ?? {
        entryId: "00000000-0000-4000-8000-000000000456",
        status: "SAVED",
        current: 0,
        total: body.item.cht ?? null,
      };
      rows.set(workKey, row);
      return json({
        success: true,
        data: {
          entry_id: row.entryId,
          type: "created",
          work_key: workKey,
          entry: overlayEntry(row),
          syncVersion: tick(),
        },
      });
    }
    const patchPath = /^\/api\/extension\/library\/([0-9a-f-]{36})$/.exec(path);
    if (patchPath && method === "PATCH") {
      const body = JSON.parse(options.body);
      patches.push({ entryId: patchPath[1], body });
      const allowed = ["status", "progress", "rating", "story_snapshot"];
      if (Object.keys(body).some((key) => !allowed.includes(key))) {
        return json({ error: "Invalid request" }, 400);
      }
      const row = [...rows.values()].find((candidate) => candidate.entryId === patchPath[1]);
      if (row === undefined) return json({ error: "Library entry not found" }, 404);
      if (body.status !== undefined) row.status = body.status;
      if (body.progress !== undefined) {
        row.current = body.progress.value;
        row.total = body.progress.total ?? row.total;
      }
      tick();
      return json({ data: { entry_id: row.entryId } });
    }
    return assert.fail(`unexpected ${method} ${path}`);
  };
  return { fetch, rows, patches };
}

async function connectedKernel(server, transport = {}) {
  const databaseFactory = new IDBFactory();
  const database = new BrowserPrivateRecordDatabase(databaseFactory);
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  });
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, {
    version: 1,
    entries: { "credential-a": "private-token" },
  });
  const controller = installSessionRuntime({
    mode: "kernel",
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "mac" };
      },
    },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { async clear() { return true; } },
    storageArea: new StorageArea(),
    databaseFactory,
    privateDatabase: database,
    storageMode: "promise",
    fetch: server.fetch,
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
    ...transport,
  });
  await controller.start();
  return controller;
}

test("account projection accepts the released overlay that omits empty workPreferences", async () => {
  const { AccountProjectionApi } = await import(
    "../../.trace-build/extension-runtime/account-projection.mjs"
  );
  const server = releasedTraceApi({
    entries: { "ffn:7038840": { entryId, status: "READING", current: 3, total: 12 } },
  });
  const loaded = await new AccountProjectionApi(server.fetch, "https://api.tracefiction.com")
    .load("private-token");
  assert.equal(loaded.kind, "success");
  assert.equal(loaded.value.overlay.kind, "value");
  assert.deepEqual(loaded.value.overlay.value.workPreferences, {});
  assert.equal(loaded.value.overlay.value.entries["ffn:7038840"].entryId, entryId);
});

test("P11 popup and page story-sheet status changes PATCH a previously saved story", async () => {
  const server = releasedTraceApi({
    entries: { "ffn:7038840": { entryId, status: "SAVED", current: 0, total: 12 } },
  });
  const controller = await connectedKernel(server);

  // P11 popup: collector forwards TRACE_POPUP_SET_READER_STATUS as this message,
  // with the SAVED -> READING first-chapter progress patch.
  const fromPopup = await controller.handle({
    type: "TRACE_SET_READER_STATUS",
    payload: {
      workKey: "ffn:7038840",
      entryId,
      status: "READING",
      progress: { unit: "CHAPTER", value: 1, total: 12 },
    },
  }, storySender);
  assert.equal(fromPopup.ok, true, JSON.stringify(fromPopup));
  assert.equal(fromPopup.command.kind, "confirmed");
  assert.equal(fromPopup.command.source, "mutation");

  // Page story sheet: bindReaderStatusChoice sends this message directly.
  const fromPage = await controller.handle({
    type: "TRACE_SET_READER_STATUS",
    payload: { workKey: "ffn:7038840", entryId, status: "PAUSED" },
  }, storySender);
  assert.equal(fromPage.ok, true, JSON.stringify(fromPage));
  assert.equal(fromPage.command.kind, "confirmed");
  assert.equal(fromPage.command.entry.canonicalReaderStatus, "PAUSED");

  assert.deepEqual(server.patches, [
    {
      entryId,
      body: { status: "READING", progress: { unit: "CHAPTER", value: 1, total: 12 } },
    },
    { entryId, body: { status: "PAUSED" } },
  ]);
  assert.equal(server.rows.get("ffn:7038840").status, "PAUSED");
  assert.equal(server.rows.get("ffn:7038840").current, 1);
});

test("a story saved in this session can change reading status straight away", async () => {
  const server = releasedTraceApi();
  const controller = await connectedKernel(server);
  const saved = await controller.handle({
    type: "TRACE_QUICK_ADD",
    payload: {
      s: "ffn",
      at: "2026-09-26T00:00:00.000Z",
      item: {
        src: "ffn",
        ctx: "story",
        u: "https://www.fanfiction.net/s/7038840/4/A-Chance-Encounter",
        t: "A Chance Encounter",
        chn: 4,
        cht: 12,
      },
    },
  }, storySender);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const savedEntryId = saved.entryId;
  assert.equal(savedEntryId, "00000000-0000-4000-8000-000000000456");

  const changed = await controller.handle({
    type: "TRACE_SET_READER_STATUS",
    payload: { workKey: "ffn:7038840", entryId: savedEntryId, status: "DROPPED" },
  }, storySender);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.command.kind, "confirmed");
  assert.deepEqual(server.patches, [{ entryId: savedEntryId, body: { status: "DROPPED" } }]);
  assert.equal(server.rows.get("ffn:7038840").status, "DROPPED");
});


test("popup port relay persists status through the kernel when both direct tab APIs fail", async () => {
  const server = releasedTraceApi({
    entries: { "ffn:7038840": { entryId, status: "SAVED", current: 0, total: 12 } },
  });
  const url = "https://www.fanfiction.net/s/7038840/1/Story";
  let connect, receive;
  const controller = await connectedKernel(server, {
    runtime: { id: "trace", onMessage: { addListener() {} },
      onConnect: { addListener(fn) { connect = fn; } }, async getPlatformInfo() { return { os: "mac" }; } },
    tabs: { async query() { return [{ id: 7, url }]; },
      sendMessage() { throw new Error("broken Safari route"); }, connect() { throw new Error("broken Safari route"); } },
  });
  connect({ name: "trace-popup-page-v1", sender: { id: "trace", frameId: 0, tab: { id: 7, url }, url },
    onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener() {} },
    postMessage(envelope) {
      if (envelope.kind === "request") {
        receive({ kind: "command", id: envelope.id, command: {
          type: "TRACE_SET_READER_STATUS", payload: { workKey: "ffn:7038840", entryId,
            status: envelope.command.status, progress: { unit: "CHAPTER", value: 1, total: 12 } },
        } });
      } else if (envelope.kind === "commandResult") {
        receive({ kind: "response", id: envelope.id, response: envelope.response });
      }
    },
  });
  const response = await controller.handle({ type: "TRACE_POPUP_PAGE_RELAY", tabId: 7,
    command: { type: "TRACE_POPUP_SET_READER_STATUS", status: "READING", entry: { entryId } },
  }, { id: "trace", url: "safari-web-extension://trace/popup.html" });
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(server.patches, [{ entryId, body: { status: "READING", progress: { unit: "CHAPTER", value: 1, total: 12 } } }]);
  assert.equal(server.rows.get("ffn:7038840").status, "READING");
});
