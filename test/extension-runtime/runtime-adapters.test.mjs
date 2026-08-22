import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  BrowserCredentialPort,
  ExplicitCredentialProvider,
  ACCOUNT_DATA_ALARM,
  LEGACY_ACCOUNT_KEYS,
  LEGACY_ACCOUNT_ALARMS,
  SAVED_FILTER_SYNC_ALARM,
  VerificationApi,
} from "../../.trace-build/extension-runtime/browser-adapters.mjs";
import {
  BrowserPrivateRecordDatabase,
  PRIVATE_RECORD_KEYS,
} from "../../.trace-build/extension-runtime/private-database.mjs";
import {
  installSessionRuntime,
} from "../../.trace-build/extension-runtime/controller.mjs";
import {
  ACCOUNT_PROJECTION_REVISION_KEY,
} from "../../.trace-build/extension-runtime/runtime-messages.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nativeCredentialResponse(credential = "current-app-token") {
  return {
    ok: true,
    protocolVersion: 3,
    credential,
    credentialKind: "access_token",
  };
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
const traceWebSender = {
  url: "https://www.tracefiction.com/setup",
  tab: { url: "https://www.tracefiction.com/setup" },
  frameId: 0,
  documentLifecycle: "active",
};
const popupSender = {
  url: "chrome-extension://trace-extension-id/popup.html",
};
const storyCommandMessage = {
  type: "TRACE_CONNECT_AND_SAVE",
  workKey: "ffn:7038840",
  payload: {
    s: "ffn",
    at: "2026-07-19T12:00:00.000Z",
    item: {
      src: "ffn",
      ctx: "story",
      u: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
      t: "A Chance Encounter",
      chn: 1,
      cht: 12,
    },
  },
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

test("iOS credential acquisition retries one transient provider read but not explicit sign-out", async () => {
  const responses = [
    { ok: false, error: "provider_unavailable" },
    {
      ok: true,
      protocolVersion: 3,
      credential: "current-app-token",
      credentialKind: "access_token",
    },
    { ok: false, error: "missing_token" },
    { ok: false, error: "provider_unavailable" },
    { ok: false, error: "provider_unavailable" },
  ];
  let nativeReads = 0;
  const provider = new ExplicitCredentialProvider({
    runtime: {
      async getPlatformInfo() {
        return { os: "ios" };
      },
      async sendNativeMessage() {
        nativeReads += 1;
        return responses.shift();
      },
    },
    tabs: {
      async query() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
      async sendMessage() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
    },
    mode: "promise",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "credential-id",
  });

  assert.deepEqual(await provider.acquire("refresh"), {
    kind: "credential",
    credential: "current-app-token",
  });
  assert.equal(nativeReads, 2);
  assert.deepEqual(await provider.acquire("refresh"), { kind: "absent" });
  assert.equal(nativeReads, 3);
  assert.deepEqual(await provider.acquire("refresh"), { kind: "unavailable" });
  assert.equal(nativeReads, 5);
});

test("iOS credential retry is cancelled before a second native read", async () => {
  let nativeReads = 0;
  const provider = new ExplicitCredentialProvider({
    runtime: {
      async getPlatformInfo() {
        return { os: "ios" };
      },
      async sendNativeMessage() {
        nativeReads += 1;
        return { ok: false, error: "provider_unavailable" };
      },
    },
    tabs: {
      async query() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
      async sendMessage() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
    },
    mode: "promise",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "credential-id",
  });

  const acquisition = provider.acquire("refresh");
  while (nativeReads === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  provider.cancel();

  assert.deepEqual(await acquisition, { kind: "cancelled" });
  assert.equal(nativeReads, 1);
});

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
  const localPreset = { id: "local-only", dirty: true };
  const area = new PromiseStorageArea({
    traceAo3SavedFiltersV1: [localPreset],
  });
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
  assert.deepEqual(area.values.traceAo3SavedFiltersV1, [localPreset]);
});

test("Trace-page status exposes only coarse session and onboarding evidence", async () => {
  const readinessAt = Date.now() - 1_000;
  const area = new PromiseStorageArea({
    traceArchiveReadiness: {
      lastArchiveSeenAt: readinessAt,
      lastArchiveHostKind: "ao3",
      lastArchiveErrorAt: readinessAt,
      lastArchiveErrorKind: "permission",
      url: "https://archiveofourown.org/works/private",
    },
  });
  const controller = installTestRuntime({
    mode: "kernel",
    runtime: { id: "trace-extension-id", onMessage: { addListener() {} } },
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
  }, { ...traceWebSender, id: "trace-extension-id" }), {
    installed: true,
    connected: false,
    authState: "signed_out",
    firstSaveSeen: false,
    browserKind: "unknown",
    capabilities: { firstStoryAdd: true },
    lastArchiveSeenAt: readinessAt,
    lastArchiveHostKind: "ao3",
    lastArchiveErrorKind: "permission",
  });
  assert.equal(await controller.handle({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "",
  }, { ...traceWebSender, id: "trace-extension-id" }), null);
  assert.equal(await controller.handle({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "status-wrong-extension",
  }, { ...traceWebSender, id: "other-extension" }), null);
  assert.equal(await controller.handle({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "status-archive",
  }, archiveSender), null);
  assert.equal(await controller.handle({
    type: "TRACE_SESSION_ACTION",
    action: "connect",
  }, archiveSender), null);
  assert.equal(await controller.handle({
    type: "TRACE_SESSION_ACTION",
    action: "connect",
    token: "must-not-be-accepted",
  }, { ...traceWebSender, id: "trace-extension-id" }), null);
});

test("Connect and save mutates only after current-worker verification and authoritative confirmation", async () => {
  const area = new PromiseStorageArea();
  const verification = deferred();
  let verificationStarted = false;
  const entryId = "00000000-0000-4000-8000-000000000123";
  const fetches = [];
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
    fetch: async (url, options) => {
      fetches.push({ url, options });
      assert.equal(options.headers.Authorization, "Bearer explicit-token");
      if (url.endsWith("/api/extension/account")) {
        verificationStarted = true;
        return verification.promise;
      }
      if (url.endsWith("/api/extension/library-overlay")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: {},
            workPreferences: {},
            syncVersion: "1970-01-01T00:00:00.000Z",
          },
        }), { status: 200 });
      }
      assert.ok(url.endsWith("/api/extension/track"));
      return new Response(JSON.stringify({
        success: true,
        data: {
          entry_id: entryId,
          type: "created",
          work_key: "ffn:7038840",
          entry: {
            status: "PLANNING",
            readerStatus: "PLANNING",
            canonicalReaderStatus: "SAVED",
            entryId,
          },
          syncVersion: "2026-07-19T12:00:01.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });

  const result = controller.handle(storyCommandMessage, archiveSender);
  while (!verificationStarted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().state, "verifying");
  verification.resolve(new Response(JSON.stringify({ account_id: "account-a" }), { status: 200 }));

  const response = await result;
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.state, "connected");
  assert.deepEqual(response.action, { kind: "completed", state: "connected" });
  assert.equal(response.command.kind, "confirmed");
  assert.equal(response.command.source, "mutation");
  assert.equal(response.command.projection, "published");
  assert.equal(response.command.receipt, "unavailable");
  assert.equal(response.entryId, entryId);
  assert.deepEqual(
    area.sets.filter((patch) => Object.hasOwn(patch, ACCOUNT_PROJECTION_REVISION_KEY)),
    [{ [ACCOUNT_PROJECTION_REVISION_KEY]: 1 }],
  );
  assert.deepEqual(fetches.map(({ url }) => new URL(url).pathname), [
    "/api/extension/account",
    "/api/extension/library-overlay",
    "/api/extension/track",
  ]);
  const status = await controller.handle({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "status-after-first-save",
  }, traceWebSender);
  assert.equal(status.firstSaveSeen, true);
  assert.equal(status.lastArchiveHostKind, "ffn");
  assert.equal(status.lastArchiveActionKind, "quick_add");
  assert.equal(typeof status.lastArchiveSeenAt, "number");
  assert.equal(typeof status.lastArchiveActionAt, "number");
});

test("iOS Connect and save adopts the containing app account before any story write", async () => {
  const databaseFactory = new IDBFactory();
  const privateDatabase = await seedPrivateSession(databaseFactory, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  }, {
    version: 1,
    entries: { "credential-a": "old-account-token" },
  });
  const nativeMessages = [];
  const authorizations = [];
  const entryId = "00000000-0000-4000-8000-000000000123";
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "ios" };
      },
      async sendNativeMessage(message) {
        nativeMessages.push(message);
        if (message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST") {
          return nativeCredentialResponse();
        }
        if (message.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR") {
          return { ok: true, cleared: true };
        }
        return { ok: true };
      },
    },
    tabs: {
      async query() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
      async sendMessage() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
    },
    storageArea: new PromiseStorageArea(),
    storageMode: "promise",
    fetch: async (url, options) => {
      authorizations.push({
        path: new URL(url).pathname,
        authorization: options.headers.Authorization,
      });
      if (url.endsWith("/api/extension/account")) {
        const accountId = options.headers.Authorization === "Bearer old-account-token"
          ? "account-a"
          : "account-b";
        return new Response(JSON.stringify({ account_id: accountId }), { status: 200 });
      }
      if (url.endsWith("/api/extension/library-overlay")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: {},
            workPreferences: {},
            syncVersion: "1970-01-01T00:00:00.000Z",
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          entry_id: entryId,
          type: "created",
          work_key: "ffn:7038840",
          entry: {
            status: "PLANNING",
            readerStatus: "PLANNING",
            canonicalReaderStatus: "SAVED",
            entryId,
          },
          syncVersion: "2026-07-19T12:00:01.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  });
  await controller.start();
  assert.equal(controller.snapshot().accountId, "account-a");

  const response = await controller.handle({
    ...storyCommandMessage,
    handoffId: "handoff_7038840",
  }, archiveSender);
  assert.equal(response.ok, true);
  assert.equal(controller.snapshot().accountId, "account-b");
  const writes = authorizations.filter(({ path }) =>
    path === "/api/extension/track"
  );
  assert.deepEqual(writes, [{
    path: "/api/extension/track",
    authorization: "Bearer current-app-token",
  }]);
  assert.deepEqual(nativeMessages.map((message) => message.type), [
    "TRACE_IOS_AUTH_TOKEN_REQUEST",
    "TRACE_IOS_EXTENSION_HEARTBEAT",
    "TRACE_IOS_PENDING_FIRST_STORY_CLEAR",
  ]);
  assert.equal(nativeMessages[1].action, "quick_add");
  assert.equal(nativeMessages[1].handoffId, "handoff_7038840");
  assert.equal(nativeMessages[2].handoffId, "handoff_7038840");
  assert.equal(
    (await privateDatabase.get(PRIVATE_RECORD_KEYS.accountData)).scope.accountId,
    "account-b",
  );
  await controller.handle(
    { type: "TRACE_SESSION_ACTION", action: "disconnect" },
    popupSender,
  );
  assert.equal(await privateDatabase.get(PRIVATE_RECORD_KEYS.accountData), null);
});

test("iOS auto-track adopts the app account, records progress, and emits no save receipt", async () => {
  const databaseFactory = new IDBFactory();
  const privateDatabase = await seedPrivateSession(databaseFactory, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  }, {
    version: 1,
    entries: { "credential-a": "old-account-token" },
  });
  const nativeMessages = [];
  const writes = [];
  let providerReads = 0;
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "ios" };
      },
      async sendNativeMessage(message) {
        nativeMessages.push(message);
        if (message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST") {
          providerReads += 1;
          return providerReads === 1
            ? { ok: false, error: "provider_unavailable" }
            : nativeCredentialResponse();
        }
        return { ok: true };
      },
    },
    tabs: {
      async query() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
      async sendMessage() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
    },
    storageArea: new PromiseStorageArea(),
    storageMode: "promise",
    fetch: async (url, options) => {
      const authorization = options.headers.Authorization;
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({
          account_id: authorization === "Bearer old-account-token"
            ? "account-a"
            : "account-b",
        }), { status: 200 });
      }
      if (url.endsWith("/api/extension/library-overlay")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: {},
            workPreferences: {},
            syncVersion: "2026-07-20T12:00:00.000Z",
          },
        }), { status: 200 });
      }
      writes.push({ authorization, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        success: true,
        data: {
          entry_id: "00000000-0000-4000-8000-000000000123",
          type: "updated",
          work_key: "ffn:7038840",
          entry: {
            status: "READING",
            readerStatus: "READING",
            canonicalReaderStatus: "READING",
            entryId: "00000000-0000-4000-8000-000000000123",
            chapters: { current: 2, total: 12 },
          },
          syncVersion: "2026-07-20T12:00:01.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  });
  await controller.start();

  const response = await controller.handle({
    ...storyCommandMessage,
    type: "TRACE_AUTO_TRACK",
    handoffId: "must-not-clear",
    payload: {
      ...storyCommandMessage.payload,
      item: {
        ...storyCommandMessage.payload.item,
        chn: 2,
      },
    },
  }, archiveSender);

  assert.equal(response.ok, true);
  assert.equal(response.command.kind, "confirmed");
  assert.equal(response.command.intent, "record_progress");
  assert.equal(response.command.receipt, "not_applicable");
  assert.equal(response.command.handoff, "not_present");
  assert.equal(response.state.entry.chapters.current, 2);
  assert.deepEqual(writes.map(({ authorization }) => authorization), [
    "Bearer current-app-token",
  ]);
  assert.deepEqual(nativeMessages.map(({ type }) => type), [
    "TRACE_IOS_AUTH_TOKEN_REQUEST",
    "TRACE_IOS_AUTH_TOKEN_REQUEST",
  ]);
  assert.equal(
    (await privateDatabase.get(PRIVATE_RECORD_KEYS.accountData)).scope.accountId,
    "account-b",
  );
});

test("iOS metadata contribution adopts the app account and invalidates without a story receipt", async () => {
  const databaseFactory = new IDBFactory();
  const privateDatabase = await seedPrivateSession(databaseFactory, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  }, {
    version: 1,
    entries: { "credential-a": "old-account-token" },
  });
  const nativeMessages = [];
  const metadataWrites = [];
  const tabMessages = [];
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "ios" };
      },
      async sendNativeMessage(message) {
        nativeMessages.push(message);
        return message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST"
          ? nativeCredentialResponse()
          : { ok: true };
      },
    },
    tabs: {
      async query() {
        return [{ id: 91, url: "https://www.tracefiction.com/library" }];
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        return { ok: true };
      },
    },
    storageArea: new PromiseStorageArea(),
    storageMode: "promise",
    fetch: async (url, options) => {
      const authorization = options.headers.Authorization;
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({
          account_id: authorization === "Bearer old-account-token"
            ? "account-a"
            : "account-b",
        }), { status: 200 });
      }
      if (url.endsWith("/api/extension/metadata")) {
        metadataWrites.push({
          authorization,
          body: JSON.parse(options.body),
        });
        return new Response(JSON.stringify({
          success: true,
          data: { story_id: 7038840 },
        }), { status: 200 });
      }
      return new Response("", { status: 404 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: (() => {
      let id = 0;
      return () => `metadata-id-${++id}`;
    })(),
  });
  await controller.start();
  assert.equal(controller.snapshot().accountId, "account-a");

  const response = await controller.handle({
    type: "TRACE_METADATA_BROADCAST",
    payload: {
      s: "ffn",
      at: "2026-07-20T12:00:00.000Z",
      item: {
        src: "ffn",
        ctx: "story",
        u: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
        t: "A Chance Encounter",
      },
    },
  }, archiveSender);

  assert.equal(response.ok, true);
  assert.deepEqual(response.command, {
    kind: "accepted",
    updated: true,
    projection: "invalidated",
    notification: "published",
  });
  assert.equal(controller.snapshot().accountId, "account-b");
  assert.deepEqual(metadataWrites.map(({ authorization }) => authorization), [
    "Bearer current-app-token",
  ]);
  assert.equal(metadataWrites[0].body.item.u, storyCommandMessage.payload.item.u);
  assert.deepEqual(nativeMessages.map(({ type }) => type), [
    "TRACE_IOS_AUTH_TOKEN_REQUEST",
  ]);
  assert.deepEqual(
    tabMessages
      .filter(({ message }) => message.type === "TRACE_LIBRARY_INVALIDATED")
      .map(({ tabId, message }) => ({
        tabId,
        type: message.type,
        reason: message.reason,
      })),
    [{
      tabId: 91,
      type: "TRACE_LIBRARY_INVALIDATED",
      reason: "metadata",
    }],
  );
  await waitUntil(
    () => tabMessages.some(
      ({ message }) =>
        message.type === "TRACE_EXTENSION_STATUS_PUSH" &&
        message.state.lastArchiveActionKind === "metadata",
    ),
    "settled kernel readiness status was not published",
  );
  const statusMessages = tabMessages.filter(
    ({ message }) => message.type === "TRACE_EXTENSION_STATUS_PUSH",
  );
  const settledStatus = statusMessages.at(-1).message.state;
  assert.equal(settledStatus.installed, true);
  assert.equal(settledStatus.connected, true);
  assert.equal(settledStatus.authState, "connected");
  assert.equal(settledStatus.firstSaveSeen, false);
  assert.equal(settledStatus.lastArchiveHostKind, "ffn");
  assert.equal(settledStatus.lastArchiveActionKind, "metadata");
});

test("concurrent iOS page mutations share same-account authority without clearing its projection", async () => {
  const databaseFactory = new IDBFactory();
  const privateDatabase = await seedPrivateSession(databaseFactory, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  }, {
    version: 1,
    entries: { "credential-a": "current-app-token" },
  });
  await privateDatabase.put(PRIVATE_RECORD_KEYS.accountData, {
    version: 1,
    scope: { accountId: "account-a", epoch: 1 },
    summary: {
      pro: false,
      libraryCount: 1,
      firstStoryCompleted: true,
    },
    overlay: {
      entries: {},
      workPreferences: {},
      syncVersion: "2026-07-20T12:00:00.000Z",
    },
  });

  const provider = deferred();
  const nativeMessages = [];
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "ios" };
      },
      async sendNativeMessage(message) {
        nativeMessages.push(message);
        return message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST"
          ? provider.promise
          : { ok: true };
      },
    },
    tabs: {
      async query() {
        return [];
      },
      async sendMessage() {
        return { ok: true };
      },
    },
    storageArea: new PromiseStorageArea(),
    storageMode: "promise",
    fetch: async (url) => {
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({ account_id: "account-a" }), { status: 200 });
      }
      if (url.endsWith("/api/extension/metadata")) {
        return new Response(JSON.stringify({
          success: true,
          data: { story_id: 7038840 },
        }), { status: 200 });
      }
      if (url.endsWith("/api/extension/library-overlay")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: {},
            workPreferences: {},
            syncVersion: "2026-07-20T12:00:00.000Z",
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          entry_id: "00000000-0000-4000-8000-000000000123",
          type: "updated",
          work_key: "ffn:7038840",
          entry: {
            status: "READING",
            readerStatus: "READING",
            canonicalReaderStatus: "READING",
            entryId: "00000000-0000-4000-8000-000000000123",
            chapters: { current: 2, total: 12 },
          },
          syncVersion: "2026-07-20T12:00:01.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "same-account-id",
  });
  await controller.start();

  const metadata = controller.handle({
    type: "TRACE_METADATA_BROADCAST",
    payload: {
      s: "ffn",
      at: "2026-07-20T12:00:00.000Z",
      item: {
        src: "ffn",
        ctx: "story",
        u: storyCommandMessage.payload.item.u,
        t: "A Chance Encounter",
      },
    },
  }, archiveSender);
  const autoTrack = controller.handle({
    ...storyCommandMessage,
    type: "TRACE_AUTO_TRACK",
    payload: {
      ...storyCommandMessage.payload,
      item: {
        ...storyCommandMessage.payload.item,
        chn: 2,
      },
    },
  }, archiveSender);

  await waitUntil(
    () => nativeMessages.length === 1,
    "expected one coalesced native credential acquisition",
  );
  provider.resolve(nativeCredentialResponse());

  const [metadataResponse, autoTrackResponse] = await Promise.all([metadata, autoTrack]);
  assert.equal(metadataResponse.ok, true);
  assert.equal(autoTrackResponse.ok, true);
  assert.deepEqual(nativeMessages.map(({ type }) => type), [
    "TRACE_IOS_AUTH_TOKEN_REQUEST",
  ]);
  assert.equal(controller.snapshot().accountId, "account-a");
  const accountData = await privateDatabase.get(PRIVATE_RECORD_KEYS.accountData);
  assert.deepEqual(accountData.scope, { accountId: "account-a", epoch: 1 });
  assert.equal(accountData.summary.libraryCount, 1);
  assert.equal(accountData.overlay.entries["ffn:7038840"].chapters.current, 2);
});

test("iOS archive projection adopts containing-app authority after delayed site permission", async () => {
  const databaseFactory = new IDBFactory();
  const privateDatabase = new BrowserPrivateRecordDatabase(databaseFactory);
  const nativeMessages = [];
  const authorizations = [];
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: {
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "ios" };
      },
      async sendNativeMessage(message) {
        nativeMessages.push(message);
        return message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST"
          ? nativeCredentialResponse()
          : { ok: true };
      },
    },
    tabs: {
      async query() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
      async sendMessage() {
        assert.fail("iOS credentials must not come from a browser tab");
      },
    },
    storageArea: new PromiseStorageArea(),
    storageMode: "promise",
    fetch: async (url, options) => {
      authorizations.push(options.headers.Authorization);
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({
          account_id: "account-a",
          pro: false,
          library_count: 1,
        }), { status: 200 });
      }
      if (url.endsWith("/api/extension/library-overlay")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: {
              "ao3:123": {
                status: "READING",
                chapters: { current: 2, total: 15 },
              },
            },
            workPreferences: {},
            syncVersion: "2026-07-20T20:45:00.000Z",
          },
        }), { status: 200 });
      }
      return new Response("", { status: 404 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "delayed-permission-id",
  });
  await controller.start();
  assert.equal(controller.snapshot().state, "signed_out");

  const response = await controller.handle({
    type: "TRACE_ACCOUNT_PROJECTION_GET",
    workKeys: ["ao3:123"],
  }, {
    frameId: 0,
    tab: { url: "https://archiveofourown.org/works" },
  });

  assert.equal(response.snapshot.state, "connected");
  assert.equal(response.projection.entries["ao3:123"].chapters.current, 2);
  assert.deepEqual(nativeMessages.map(({ type }) => type), [
    "TRACE_IOS_AUTH_TOKEN_REQUEST",
  ]);
  assert.ok(authorizations.length >= 2);
  assert.ok(authorizations.every((value) => value === "Bearer current-app-token"));
  const envelope = await privateDatabase.get(PRIVATE_RECORD_KEYS.sessionEnvelope);
  const accountData = await privateDatabase.get(PRIVATE_RECORD_KEYS.accountData);
  assert.equal(envelope.accountId, "account-a");
  assert.equal(envelope.desired, "connected");
  assert.equal(accountData.scope.accountId, "account-a");
});

test("archive projection and work-state reads return only requested current-account records", async () => {
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
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    storageArea: new PromiseStorageArea(),
    storageMode: "promise",
    fetch: async (url) => {
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({
          account_id: "account-a",
          pro: false,
          library_count: 2,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          entries: {
            "ffn:7038840": {
              status: "READING",
              chapters: { current: 2, total: 12 },
            },
            "ffn:999": { status: "PLANNING" },
            "ao3:123": { status: "READING" },
          },
          workPreferences: {
            "ffn:7038840": { browsePreference: { hidden: false } },
            "ffn:999": { browsePreference: { hidden: true } },
          },
          syncVersion: "2026-07-20T12:00:00.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });
  await controller.start();

  const projection = await controller.handle({
    type: "TRACE_ACCOUNT_PROJECTION_GET",
    workKeys: ["ffn:7038840"],
  }, {
    frameId: 0,
    tab: { url: "https://www.fanfiction.net/book/" },
  });
  assert.deepEqual(Object.keys(projection.projection.entries), ["ffn:7038840"]);
  assert.deepEqual(Object.keys(projection.projection.workPreferences), ["ffn:7038840"]);
  assert.equal(JSON.stringify(projection).includes("account-a"), false);
  assert.equal(JSON.stringify(projection).includes("current-token"), false);

  const workState = await controller.handle({
    type: "TRACE_WORK_STATE_GET",
    workKey: "ffn:7038840",
  }, archiveSender);
  assert.equal(workState.state.status, "saved");
  assert.equal(workState.state.entry.chapters.current, 2);
  assert.equal(await controller.handle({
    type: "TRACE_ACCOUNT_PROJECTION_GET",
    workKeys: ["ao3:123"],
  }, {
    frameId: 0,
    tab: { url: "https://www.fanfiction.net/book/" },
  }), null);
  assert.equal(await controller.handle({
    type: "TRACE_ACCOUNT_PROJECTION_GET",
    workKeys: ["ffn:7038840"],
  }, {
    frameId: 0,
    tab: { url: "https://www.fanfiction.net/login.php" },
  }), null);
});

test("capacity failures persist recovery state, suppress new work, and preserve existing progress", async () => {
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
  let trackRequests = 0;
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: { id: "trace-extension", onMessage: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    storageArea: new PromiseStorageArea(),
    storageMode: "promise",
    fetch: async (url, options = {}) => {
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({
          account_id: "account-a",
          pro: false,
          library_count: 100,
          first_story_completed_at: "2026-07-19T12:00:00.000Z",
        }), { status: 200 });
      }
      if (url.endsWith("/api/extension/library-overlay")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            entries: {
              "ffn:999": {
                status: "READING",
                readerStatus: "READING",
                canonicalReaderStatus: "READING",
                entryId: "00000000-0000-4000-8000-000000000999",
                chapters: { current: 1, total: 5 },
              },
            },
            workPreferences: {},
            syncVersion: "2026-07-20T12:00:00.000Z",
          },
        }), { status: 200 });
      }
      if (url.endsWith("/api/extension/track")) {
        trackRequests += 1;
        const item = JSON.parse(options.body).item;
        if (item.u.includes("/7038840/")) {
          return new Response("", { status: 402 });
        }
        return new Response(JSON.stringify({
          success: true,
          data: {
            entry_id: "00000000-0000-4000-8000-000000000999",
            type: "updated",
            work_key: "ffn:999",
            entry: {
              status: "READING",
              readerStatus: "READING",
              canonicalReaderStatus: "READING",
              entryId: "00000000-0000-4000-8000-000000000999",
              chapters: { current: 2, total: 5 },
            },
            syncVersion: "2026-07-20T12:00:01.000Z",
          },
        }), { status: 200 });
      }
      return new Response("", { status: 404 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });
  await controller.start();

  const blocked = await controller.handle({
    ...storyCommandMessage,
    type: "TRACE_AUTO_TRACK",
  }, archiveSender);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "free_limit_reached");
  assert.deepEqual(blocked.capacity, { blocked: true, prompt: true });
  assert.equal(trackRequests, 1);

  const repeated = await controller.handle({
    ...storyCommandMessage,
    type: "TRACE_AUTO_TRACK",
  }, archiveSender);
  assert.equal(repeated.error, "free_limit_reached");
  assert.equal(trackRequests, 1);

  const existingSender = {
    tab: { url: "https://www.fanfiction.net/s/999/2/Existing" },
  };
  const existingProgress = await controller.handle({
    ...storyCommandMessage,
    type: "TRACE_AUTO_TRACK",
    workKey: "ffn:999",
    payload: {
      ...storyCommandMessage.payload,
      item: {
        ...storyCommandMessage.payload.item,
        u: "https://www.fanfiction.net/s/999/2/Existing",
        chn: 2,
        cht: 5,
      },
    },
  }, existingSender);
  assert.equal(existingProgress.ok, true);
  assert.equal(existingProgress.state.entry.chapters.current, 2);
  assert.equal(trackRequests, 2);

  const acknowledged = await controller.handle({
    type: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE",
    action: "dismissed",
  }, archiveSender);
  assert.equal(acknowledged.ok, true);
  assert.deepEqual(acknowledged.capacity, { blocked: true, prompt: false });

  const popup = await controller.handle(
    { type: "TRACE_POPUP_GET_STATE" },
    { ...popupSender, id: "trace-extension" },
  );
  assert.deepEqual(popup.capacity, { blocked: true, prompt: false });
  assert.equal(JSON.stringify(popup).includes("account-a"), false);
  assert.equal(await controller.handle({
    type: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE",
    action: "dismissed",
  }, {
    frameId: 0,
    tab: { url: "https://www.fanfiction.net/login.php" },
  }), null);
});

test("popup state is extension-page-only and contains sanitized summary plus local preferences", async () => {
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
  const controller = installTestRuntime({
    mode: "kernel",
    databaseFactory,
    privateDatabase,
    runtime: { id: "trace-extension", onMessage: { addListener() {} } },
    tabs: {
      async query() {
        return [{ url: "https://www.fanfiction.net/s/7038840/1/Story" }];
      },
      async sendMessage() { return null; },
    },
    storageArea: new PromiseStorageArea({
      prefAutoTrackEnabled: false,
      prefLibraryInlayEnabled: true,
      prefAo3SavedFiltersEnabled: false,
      prefMetadataImproveEnabled: true,
    }),
    storageMode: "promise",
    fetch: async (url) => {
      if (url.endsWith("/api/extension/account")) {
        return new Response(JSON.stringify({
          account_id: "account-a",
          pro: true,
          library_count: 8,
          first_story_completed_at: "2026-07-19T12:00:00.000Z",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          entries: {},
          workPreferences: {},
          syncVersion: "2026-07-20T12:00:00.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin: "https://www.tracefiction.com",
    randomId: () => "id",
  });
  await controller.start();

  const popup = await controller.handle(
    { type: "TRACE_POPUP_GET_STATE" },
    {
      id: "trace-extension",
      url: "moz-extension://trace-extension/popup.html",
    },
  );
  assert.equal(popup.authState.state, "connected");
  assert.equal(popup.pro, true);
  assert.equal(popup.capacity, null);
  assert.equal(popup.libraryCount, 8);
  assert.equal(popup.firstSaveSeen, true);
  assert.equal(popup.autoTrackEnabled, false);
  assert.equal(popup.ao3SavedFiltersEnabled, false);
  assert.deepEqual(popup.activeTab, {
    kind: "supported_story",
    site: "ffn",
    canImport: true,
  });
  assert.equal(JSON.stringify(popup).includes("current-token"), false);
  assert.equal(JSON.stringify(popup).includes("account-a"), false);
  assert.equal(await controller.handle(
    { type: "TRACE_POPUP_GET_STATE" },
    archiveSender,
  ), null);
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

  const result = await controller.handle(storyCommandMessage, archiveSender);
  assert.equal(result.snapshot.state, "signed_out");
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_authenticated");
  assert.equal(
    area.sets.some((patch) => Object.hasOwn(patch, ACCOUNT_PROJECTION_REVISION_KEY)),
    false,
  );
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
  await controller.handle({ type: "TRACE_SESSION_GET_SNAPSHOT" }, popupSender);
  await controller.handle({ type: "TRACE_SESSION_GET_SNAPSHOT" }, popupSender);
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
    await controller.handle(
      { type: "TRACE_EXTENSION_STATUS_QUERY", nonce: "status-429" },
      traceWebSender,
    ),
    {
      installed: true,
      connected: false,
      authState: "unknown",
      firstSaveSeen: false,
      browserKind: "unknown",
      capabilities: { firstStoryAdd: true },
    },
  );
  await controller.handle(
    { type: "TRACE_SESSION_ACTION", action: "retry" },
    popupSender,
  );
  assert.equal(retryClock.pending.length, 0);
});

test("disabled mode deletes the private database, alarms, and complete legacy inventory", async () => {
  const area = new PromiseStorageArea({
    traceSessionEnvelopeV1: { version: 1 },
    traceSessionCredentialsV1: { version: 1, entries: { old: "secret" } },
    authToken: "secret",
    traceAo3SavedFiltersActiveV1: { id: "old" },
    traceArchiveReadiness: { lastArchiveSeenAt: 1, lastArchiveHostKind: "ao3" },
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
  assert.deepEqual(alarms.cleared, [
    ACCOUNT_DATA_ALARM,
    SAVED_FILTER_SYNC_ALARM,
    ...LEGACY_ACCOUNT_ALARMS,
  ]);
  assert.deepEqual(controller.snapshot(), {
    state: "signed_out",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "none",
  });
});
