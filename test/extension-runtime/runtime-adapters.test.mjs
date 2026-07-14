import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCredentialPort,
  BrowserStorage,
  LEGACY_ACCOUNT_KEYS,
  SESSION_CREDENTIALS_KEY,
  VerificationApi,
} from "../../.trace-build/extension-runtime/browser-adapters.mjs";
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

const runtime = { onMessage: { addListener() {} } };
const unavailableProvider = {
  async acquire() {
    return { kind: "absent" };
  },
  cancel() {},
};

test("whole-store cleanup is ordered before an immediate later credential write", async () => {
  const area = new PromiseStorageArea({
    [SESSION_CREDENTIALS_KEY]: {
      version: 1,
      entries: { old: "old-token" },
    },
  });
  const cleanup = deferred();
  area.nextRemove = cleanup.promise;
  const storage = new BrowserStorage(area, runtime, "promise");
  const credentials = new BrowserCredentialPort(storage, unavailableProvider, () => "new-id");

  const clearing = credentials.clearAll();
  const storing = credentials.storeUnique("new-token", 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(area.sets.length, 0);

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
  const controller = installSessionRuntime({
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
  const controller = installSessionRuntime({
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
  const controller = installSessionRuntime({
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

  const result = controller.handle({ type: "TRACE_CONNECT_AND_SAVE" });
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
  const controller = installSessionRuntime({
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

  const result = await controller.handle({ type: "TRACE_CONNECT_AND_SAVE" });
  assert.equal(result.snapshot.state, "signed_out");
  assert.equal(Object.hasOwn(result, "error"), false);
});

test("disabled mode clears both new stores and the complete legacy inventory", async () => {
  const area = new PromiseStorageArea({
    traceSessionEnvelopeV1: { version: 1 },
    traceSessionCredentialsV1: { version: 1, entries: { old: "secret" } },
    authToken: "secret",
    traceAo3SavedFiltersActiveV1: { id: "old" },
  });
  const controller = installSessionRuntime({
    mode: "disabled",
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
  assert.deepEqual(area.values, {});
  assert.deepEqual(controller.snapshot(), {
    state: "signed_out",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "none",
  });
});
