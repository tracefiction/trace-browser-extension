import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  BrowserCredentialPort,
  ACCOUNT_DATA_ALARM,
  LEGACY_ACCOUNT_KEYS,
  LEGACY_ACCOUNT_ALARMS,
  VerificationApi,
} from "../../.trace-build/extension-runtime/browser-adapters.mjs";
import {
  BrowserPrivateRecordDatabase,
  PRIVATE_RECORD_KEYS,
} from "../../.trace-build/extension-runtime/private-database.mjs";
import {
  installSessionRuntime,
} from "../../.trace-build/extension-runtime/controller.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

class FakeRetryClock {
  constructor() {
    this.pending = [];
  }

  setTimeout(callback, delayMs) {
    const handle = { callback, delayMs };
    this.pending.push(handle);
    return handle;
  }

  clearTimeout(handle) {
    this.pending = this.pending.filter((candidate) => candidate !== handle);
  }

  runNext() {
    const next = this.pending.shift();
    assert.ok(next, "expected a scheduled retry");
    next.callback();
    return next.delayMs;
  }
}

const archiveSender = {
  tab: { url: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter" },
};

class PromiseAlarms {
  constructor() {
    this.cleared = [];
  }

  async clear(name) {
    this.cleared.push(name);
    return true;
  }
}

const runtimeInstaller = installSessionRuntime;

function installTestRuntime(options) {
  return runtimeInstaller({
    alarms: new PromiseAlarms(),
    databaseFactory: new IDBFactory(),
    ...options,
  });
}

async function seedPrivateSession(databaseFactory, envelope, credentials) {
  const database = new BrowserPrivateRecordDatabase(databaseFactory);
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, envelope);
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, credentials);
  return database;
}

class PromiseStorageArea {
  constructor(initial = {}) {
    this.values = { ...initial };
    this.removes = [];
    this.sets = [];
    this.nextRemove = null;
  }

  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      list.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, this.values[key]]),
    );
  }

  async set(patch) {
    this.sets.push(patch);
    Object.assign(this.values, patch);
  }

  async remove(keys) {
    const list = Array.isArray(keys) ? [...keys] : [keys];
    this.removes.push(list);
    if (this.nextRemove) {
      const wait = this.nextRemove;
      this.nextRemove = null;
      await wait;
    }
    for (const key of list) delete this.values[key];
  }
}

class FailingThenHealthyIDBFactory {
  constructor(failures = 1) {
    this.factory = new IDBFactory();
    this.failures = failures;
  }

  open(...args) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("injected database failure");
    }
    return this.factory.open(...args);
  }

  deleteDatabase(...args) {
    return this.factory.deleteDatabase(...args);
  }
}

const unavailableProvider = {
  async acquire() {
    return { kind: "absent" };
  },
  cancel() {},
};

test("whole-store cleanup is ordered before an immediate later credential write", async () => {
  const databaseFactory = new IDBFactory();
  const underlying = new BrowserPrivateRecordDatabase(databaseFactory);
  await underlying.put(PRIVATE_RECORD_KEYS.sessionCredentials, {
    version: 1,
    entries: { old: "old-token" },
  });
  const cleanup = deferred();
  const database = {
    get: (key) => underlying.get(key),
    put: (key, value) => underlying.put(key, value),
    async delete(key) {
      await cleanup.promise;
      await underlying.delete(key);
    },
    deleteDatabase: () => underlying.deleteDatabase(),
  };
  const credentials = new BrowserCredentialPort(database, unavailableProvider, () => "new-id");

  const clearing = credentials.clearAll();
  const storing = credentials.storeUnique("new-token", 2);
  await new Promise((resolve) => setImmediate(resolve));
  cleanup.resolve();
  await clearing;
  const reference = await storing;
  assert.equal(reference, "session:2:new-id");
  assert.equal(await credentials.load(reference), "new-token");
  assert.equal(await credentials.load("old"), null);
});

test("account verification uses the fail-closed reachable status table", async () => {
  const responses = [
    new Response(JSON.stringify({ account_id: "account-a" }), { status: 200 }),
    new Response("", { status: 401 }),
    new Response("", { status: 410 }),
    new Response("", { status: 418 }),
    new Response("", { status: 429 }),
    new Response("", { status: 503 }),
    new Response(JSON.stringify({ nope: true }), { status: 200 }),
  ];
  const api = new VerificationApi(async () => responses.shift(), "https://api.tracefiction.com");
  assert.deepEqual(await api.verifyCredential("token"), {
    kind: "verified",
    accountId: "account-a",
  });
  assert.deepEqual(await api.verifyCredential("token"), { kind: "rejected" });
  assert.deepEqual(await api.verifyCredential("token"), { kind: "account_unavailable" });
  assert.deepEqual(await api.verifyCredential("token"), { kind: "account_unavailable" });
  assert.deepEqual(await api.verifyCredential("token"), { kind: "unavailable" });
  assert.deepEqual(await api.verifyCredential("token"), { kind: "unavailable" });
  assert.deepEqual(await api.verifyCredential("token"), { kind: "invalid_response" });
});

test("runtime registers its message listener before asynchronous cleanup", async () => {
  const cleanup = deferred();
  const area = new PromiseStorageArea();
  area.nextRemove = cleanup.promise;
  const listeners = [];
  const extensionRuntime = {
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
  };
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: extensionRuntime,
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    storageArea: area,
    storageMode: "promise",
    fetch: async () => new Response("", { status: 503 }),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });

  assert.equal(listeners.length, 1);
  assert.deepEqual(area.removes[0], [...LEGACY_ACCOUNT_KEYS]);
  cleanup.resolve();
  await controller.start();
  assert.equal(controller.snapshot().state, "signed_out");
});

test("Trace-page status exposes only the coarse current-worker session state", async () => {
  const area = new PromiseStorageArea();
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    storageArea: area,
    storageMode: "promise",
    fetch: async () => new Response("", { status: 503 }),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });
  await controller.start();

  assert.deepEqual(await controller.handle({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "status-1",
  }), {
    installed: true,
    connected: false,
    authState: "signed_out",
  });
  assert.equal(await controller.handle({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "",
  }), null);
});

test("Connect and save reports command handoff only after current-worker verification", async () => {
  const area = new PromiseStorageArea();
  const verification = deferred();
  let verificationStarted = false;
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      async query(filter) {
        assert.deepEqual(filter, { url: ["https://www.tracefiction.com/*"] });
        return [{ id: 7, url: "https://www.tracefiction.com/library", active: true }];
      },
      async sendMessage(_tabId, message) {
        return { ok: true, requestId: message.requestId, token: "explicit-token" };
      },
    },
    storageArea: area,
    storageMode: "promise",
    fetch: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer explicit-token");
      verificationStarted = true;
      return verification.promise;
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });

  const result = controller.handle({ type: "TRACE_CONNECT_AND_SAVE" }, archiveSender);
  while (!verificationStarted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().state, "verifying");
  verification.resolve(new Response(JSON.stringify({ account_id: "account-a" }), { status: 200 }));

  assert.deepEqual(await result, {
    ok: true,
    snapshot: {
      state: "connected",
      canExecuteAuthenticated: true,
      reason: "none",
    },
    action: { kind: "completed", state: "connected" },
    error: "commands_unavailable",
  });
});

test("Connect and save does not claim a command handoff when acquisition fails", async () => {
  const area = new PromiseStorageArea();
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    storageArea: area,
    storageMode: "promise",
    fetch: async () => assert.fail("verification must not run without a credential"),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });

  const result = await controller.handle({ type: "TRACE_CONNECT_AND_SAVE" }, archiveSender);
  assert.equal(result.snapshot.state, "signed_out");
  assert.equal(Object.hasOwn(result, "error"), false);
});

test("Connect and save rejects non-archive senders before credential acquisition", async () => {
  const area = new PromiseStorageArea();
  let tabQueries = 0;
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      async query() { tabQueries += 1; return []; },
      async sendMessage() { return null; },
    },
    storageArea: area,
    storageMode: "promise",
    fetch: async () => new Response("", { status: 503 }),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });

  assert.equal(
    await controller.handle(
      { type: "TRACE_CONNECT_AND_SAVE" },
      { tab: { url: "https://www.tracefiction.com/library" } },
    ),
    null,
  );
  assert.equal(tabQueries, 0);
});

test("kernel exposes only a sanitized pending-story read to archive content scripts", async () => {
  const area = new PromiseStorageArea();
  const nativeMessages = [];
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: {
      onMessage: { addListener() {} },
      async sendNativeMessage(message) {
        nativeMessages.push(message);
        return {
          ok: true,
          url: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
          mode: "story",
          hostKind: "ffn",
          handoffId: "handoff_7038840",
          expiresAt: 1_800_000_000,
          token: "must-not-escape",
          accountId: "must-not-escape",
        };
      },
    },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    storageArea: area,
    storageMode: "promise",
    fetch: async () => new Response("", { status: 503 }),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });

  assert.deepEqual(
    await controller.handle({ type: "TRACE_IOS_PENDING_FIRST_STORY_GET" }, archiveSender),
    {
      ok: true,
      url: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
      mode: "story",
      hostKind: "ffn",
      handoffId: "handoff_7038840",
      expiresAt: 1_800_000_000,
    },
  );
  assert.deepEqual(nativeMessages, [{ type: "TRACE_IOS_PENDING_FIRST_STORY_GET" }]);
  assert.deepEqual(
    await controller.handle(
      { type: "TRACE_IOS_PENDING_FIRST_STORY_GET" },
      { tab: { url: "https://www.tracefiction.com/library" } },
    ),
    { ok: false, error: "native_unavailable" },
  );
  assert.equal(nativeMessages.length, 1);
});

test("one controller-owned retry sequence uses 750ms, 2.5s, and 8s then stops on success", async () => {
  const area = new PromiseStorageArea();
  const databaseFactory = new IDBFactory();
  const privateDatabase = await seedPrivateSession(databaseFactory, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  }, {
    version: 1,
    entries: { "credential-a": "current-token" },
  });
  const retryClock = new FakeRetryClock();
  let verificationCalls = 0;
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    databaseFactory,
    privateDatabase,
    storageArea: area,
    storageMode: "promise",
    fetch: async () => {
      verificationCalls += 1;
      return verificationCalls <= 3
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ account_id: "account-a" }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
    retryClock,
  });

  await controller.start();
  assert.equal(controller.snapshot().state, "degraded");
  assert.deepEqual(retryClock.pending.map((entry) => entry.delayMs), [750]);
  await controller.handle({ type: "TRACE_SESSION_GET_SNAPSHOT" });
  await controller.handle({ type: "TRACE_SESSION_GET_SNAPSHOT" });
  assert.deepEqual(retryClock.pending.map((entry) => entry.delayMs), [750]);

  assert.equal(retryClock.runNext(), 750);
  await waitUntil(() => verificationCalls === 2 && retryClock.pending.length === 1, "second retry was not scheduled");
  assert.deepEqual(retryClock.pending.map((entry) => entry.delayMs), [2_500]);
  assert.equal(retryClock.runNext(), 2_500);
  await waitUntil(() => verificationCalls === 3 && retryClock.pending.length === 1, "third retry was not scheduled");
  assert.deepEqual(retryClock.pending.map((entry) => entry.delayMs), [8_000]);
  assert.equal(retryClock.runNext(), 8_000);
  await waitUntil(() => controller.snapshot().state === "connected", "retry sequence did not reconnect");
  assert.equal(verificationCalls, 4);
  assert.equal(retryClock.pending.length, 0);
});

test("storage unavailability uses the same single retry clock and stops after recovery", async () => {
  const area = new PromiseStorageArea();
  const retryClock = new FakeRetryClock();
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    databaseFactory: new FailingThenHealthyIDBFactory(),
    storageArea: area,
    storageMode: "promise",
    fetch: async () => new Response("", { status: 503 }),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
    retryClock,
  });

  await controller.start();
  assert.equal(controller.snapshot().state, "degraded");
  assert.equal(controller.snapshot().reason, "storage_unavailable");
  assert.deepEqual(retryClock.pending.map((entry) => entry.delayMs), [750]);
  assert.equal(retryClock.runNext(), 750);
  await waitUntil(() => controller.snapshot().state === "signed_out", "storage retry did not recover");
  assert.equal(retryClock.pending.length, 0);
});

test("HTTP 429 remains degraded for explicit Retry and maps public status to unknown", async () => {
  const area = new PromiseStorageArea();
  const databaseFactory = new IDBFactory();
  const privateDatabase = await seedPrivateSession(databaseFactory, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  }, {
    version: 1,
    entries: { "credential-a": "current-token" },
  });
  const retryClock = new FakeRetryClock();
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    databaseFactory,
    privateDatabase,
    storageArea: area,
    storageMode: "promise",
    fetch: async () => new Response("", { status: 429 }),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
    retryClock,
  });

  await controller.start();
  assert.equal(controller.snapshot().state, "degraded");
  assert.equal(retryClock.pending.length, 0);
  assert.deepEqual(
    await controller.handle({ type: "TRACE_EXTENSION_STATUS_QUERY", nonce: "status-429" }),
    { installed: true, connected: false, authState: "unknown" },
  );
  await controller.handle({ type: "TRACE_SESSION_ACTION", action: "retry" });
  assert.equal(retryClock.pending.length, 0);
});

test("disabled mode deletes the private database, alarms, and complete legacy inventory", async () => {
  const area = new PromiseStorageArea({
    traceSessionEnvelopeV1: { version: 1 },
    traceSessionCredentialsV1: { version: 1, entries: { old: "secret" } },
    authToken: "secret",
    traceAo3SavedFiltersActiveV1: { id: "old" },
  });
  const alarms = new PromiseAlarms();
  const databaseFactory = new IDBFactory();
  const seededDatabase = await seedPrivateSession(databaseFactory, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "old",
  }, { version: 1, entries: { old: "secret" } });
  await seededDatabase.put(PRIVATE_RECORD_KEYS.accountData, {
    version: 1,
    scope: { accountId: "account-a", epoch: 1 },
    summary: null,
    overlay: null,
  });
  const controller = installTestRuntime({
    mode: "disabled",
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms,
    databaseFactory,
    privateDatabase: seededDatabase,
    storageArea: area,
    storageMode: "promise",
    fetch: async () => new Response("", { status: 503 }),
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });
  await controller.start();
  assert.deepEqual(area.values, {});
  const emptyDatabase = new BrowserPrivateRecordDatabase(databaseFactory);
  assert.equal(await emptyDatabase.get(PRIVATE_RECORD_KEYS.sessionEnvelope), null);
  assert.equal(await emptyDatabase.get(PRIVATE_RECORD_KEYS.sessionCredentials), null);
  assert.equal(await emptyDatabase.get(PRIVATE_RECORD_KEYS.accountData), null);
  assert.deepEqual(alarms.cleared, [ACCOUNT_DATA_ALARM, ...LEGACY_ACCOUNT_ALARMS]);
  assert.deepEqual(controller.snapshot(), {
    state: "signed_out",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "none",
  });
});
