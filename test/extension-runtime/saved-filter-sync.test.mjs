import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  BrowserSavedFilterRepository,
  SavedFilterSyncAlarm,
  SavedFilterSyncApi,
} from "../../.trace-build/extension-runtime/saved-filter-sync.mjs";
import {
  isSavedFilterSyncRequest,
} from "../../.trace-build/extension-runtime/saved-filter-sync-sender.mjs";
import {
  SessionRuntimeController,
} from "../../.trace-build/extension-runtime/controller.mjs";
import {
  BrowserStorage,
} from "../../.trace-build/extension-runtime/browser-adapters.mjs";
import {
  BrowserPrivateRecordDatabase,
  PRIVATE_RECORD_KEYS,
} from "../../.trace-build/extension-runtime/private-database.mjs";

const ao3Sender = {
  tab: { url: "https://archiveofourown.org/tags/Naruto/works" },
  frameId: 0,
  documentLifecycle: "active",
};

function remotePreset(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    clientId: "preset-1",
    name: "Kudos",
    scope: "global",
    contextKey: null,
    contextLabel: null,
    params: [["work_search[sort_column]", "kudos_count"]],
    summary: ["Sort: Kudos"],
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:01:00.000Z",
    clientUpdatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

function responseData(overrides = {}) {
  return {
    serverTime: "2026-07-20T10:01:00.000Z",
    syncVersion: "2026-07-20T10:01:00.000Z",
    presets: [remotePreset()],
    deleted: [],
    ...overrides,
  };
}

class PromiseStorageArea {
  constructor(values = {}) {
    this.values = { ...values };
    this.removes = [];
  }

  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      list
        .filter((key) => Object.hasOwn(this.values, key))
        .map((key) => [key, this.values[key]]),
    );
  }

  async set(patch) {
    Object.assign(this.values, patch);
  }

  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    this.removes.push([...list]);
    for (const key of list) delete this.values[key];
  }
}

test("saved-filter sync requests require an exact active AO3 top-frame sender", () => {
  const message = { type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST" };
  assert.equal(isSavedFilterSyncRequest(message, ao3Sender), true);
  assert.equal(isSavedFilterSyncRequest(
    message,
    { ...ao3Sender, frameId: 2 },
  ), false);
  assert.equal(isSavedFilterSyncRequest(
    message,
    { tab: { url: "https://archiveofourown.org/users/login" }, frameId: 0 },
  ), false);
  assert.equal(isSavedFilterSyncRequest(
    { ...message, payload: {} },
    ao3Sender,
  ), false);
  assert.equal(isSavedFilterSyncRequest(
    message,
    { tab: { url: "https://www.fanfiction.net/book/" }, frameId: 0 },
  ), false);
});

test("kernel alarm schedules a bounded periodic pull and filters unrelated alarms", () => {
  const listeners = [];
  const creates = [];
  let runs = 0;
  SavedFilterSyncAlarm.install({
    create(name, options) {
      creates.push({ name, options });
    },
    onAlarm: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
  }, { onMessage: { addListener() {} } }, () => {
    runs += 1;
  });
  assert.deepEqual(creates, [{
    name: "traceAo3SavedFiltersSync",
    options: { periodInMinutes: 30 },
  }]);
  listeners[0]({ name: "other" });
  listeners[0]({ name: "traceAo3SavedFiltersSync" });
  assert.equal(runs, 1);
});

test("saved-filter API uses the canonical route and validates exact outcomes", async () => {
  const requests = [];
  const api = new SavedFilterSyncApi(async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      success: true,
      data: responseData(),
    }), { status: 200 });
  }, "https://api.tracefiction.com/");
  const result = await api.sync("private-token", {
    clientId: "device:one",
    since: null,
    upserts: [],
    deletes: [],
  });
  assert.equal(result.kind, "success");
  assert.equal(result.value.kind, "accepted");
  assert.equal(
    requests[0].url,
    "https://api.tracefiction.com/api/extension/ao3-saved-filters/sync",
  );
  assert.equal(requests[0].options.headers.Authorization, "Bearer private-token");

  const malformed = new SavedFilterSyncApi(async () =>
    new Response(JSON.stringify({
      success: true,
      data: responseData({ extra: true }),
    }), { status: 200 }), "https://api.tracefiction.com");
  assert.deepEqual(await malformed.sync("token", {
    clientId: "device:one",
    since: null,
    upserts: [],
    deletes: [],
  }), {
    kind: "success",
    value: { kind: "invalid_response" },
  });

  const limited = new SavedFilterSyncApi(async () =>
    new Response(JSON.stringify({
      code: "AO3_SAVED_FILTER_LIMIT_REACHED",
      limit: 250,
    }), { status: 422 }), "https://api.tracefiction.com");
  assert.deepEqual(await limited.sync("token", {
    clientId: "device:one",
    since: null,
    upserts: [],
    deletes: [],
  }), {
    kind: "success",
    value: { kind: "rejected", reason: "limit_reached", limit: 250 },
  });
});

test("saved-filter API aborts its current request for an account transition", async () => {
  let started = false;
  let aborted = false;
  const api = new SavedFilterSyncApi(async (_url, options) => {
    started = true;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    });
  }, "https://api.tracefiction.com");
  const pending = api.sync("token", {
    clientId: "device:one",
    since: null,
    upserts: [],
    deletes: [],
  });
  while (!started) await new Promise((resolve) => setImmediate(resolve));

  api.cancelPending();

  assert.deepEqual(await pending, {
    kind: "success",
    value: { kind: "unavailable" },
  });
  assert.equal(aborted, true);
});

test("browser repository preserves local data and fences stale account merges", async () => {
  const area = new PromiseStorageArea({
    traceAo3SavedFiltersV1: [{
      id: "preset-1",
      clientId: "preset-1",
      serverId: "",
      name: "Kudos",
      params: [["work_search[sort_column]", "kudos_count"]],
      scope: "global",
      contextKey: "",
      contextLabel: "",
      summary: ["Sort: Kudos"],
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
      clientUpdatedAt: "2026-07-20T10:00:00.000Z",
      dirty: true,
    }],
  });
  let scope = { accountId: "account-a", epoch: 1 };
  const runtime = { onMessage: { addListener() {} } };
  const repository = new BrowserSavedFilterRepository({
    storage: new BrowserStorage(area, runtime, "promise"),
    session: { publicationScope: () => scope },
    randomId: () => "install-one",
  });
  const initial = await repository.read();
  assert.equal(initial.clientId, "device:install-one");
  scope = { accountId: "account-a", epoch: 2 };
  assert.deepEqual(await repository.merge(
    { accountId: "account-a", epoch: 1 },
    responseData(),
    new Set(),
    "2026-07-20T10:02:00.000Z",
  ), { kind: "stale" });
  assert.equal(area.values.traceAo3SavedFiltersV1[0].dirty, true);
});

test("controller syncs a local preset without exposing credentials to the AO3 page", async () => {
  const databaseFactory = new IDBFactory();
  const database = new BrowserPrivateRecordDatabase(databaseFactory);
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "session:1:seed",
  });
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, {
    version: 1,
    entries: { "session:1:seed": "private-token" },
  });
  const area = new PromiseStorageArea({
    traceAo3SavedFiltersClientIdV1: "device:one",
    traceAo3SavedFiltersV1: [{
      id: "preset-1",
      clientId: "preset-1",
      serverId: "",
      name: "Kudos",
      params: [["work_search[sort_column]", "kudos_count"]],
      scope: "global",
      contextKey: "",
      contextLabel: "",
      summary: ["Sort: Kudos"],
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
      clientUpdatedAt: "2026-07-20T10:00:00.000Z",
      dirty: true,
    }],
  });
  const calls = [];
  const controller = new SessionRuntimeController({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      async query() { return []; },
      async sendMessage() { return null; },
      async create() { return null; },
    },
    alarms: { async clear() { return true; } },
    databaseFactory,
    privateDatabase: database,
    storageArea: area,
    storageMode: "promise",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/account/me")) {
        return new Response(JSON.stringify({ account_id: "account-a" }), { status: 200 });
      }
      assert.ok(url.endsWith("/api/extension/ao3-saved-filters/sync"));
      assert.equal(options.headers.Authorization, "Bearer private-token");
      const body = JSON.parse(options.body);
      assert.equal(body.upserts[0].clientId, "preset-1");
      return new Response(JSON.stringify({
        success: true,
        data: responseData(),
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "runtime-id",
  });
  await controller.start();
  const result = await controller.handle(
    { type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST" },
    ao3Sender,
  );
  assert.equal(result.ok, true);
  assert.equal(result.sync.kind, "completed");
  assert.equal(area.values.traceAo3SavedFiltersV1[0].dirty, false);
  assert.equal(Object.hasOwn(result, "credential"), false);
  assert.equal(calls.length, 2);
});
