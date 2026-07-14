import assert from "node:assert/strict";
import test from "node:test";

import {
  SHADOW_CREDENTIAL_KEY,
  SHADOW_SESSION_KEY,
  ShadowBrowserStorage,
  ShadowVerificationApi,
} from "../../.trace-build/extension-shadow/browser-adapters.mjs";
import {
  SHADOW_CONTROL_TYPES,
  installShadowObserver,
} from "../../.trace-build/extension-shadow/observer.mjs";

class FakeStorageArea {
  constructor() {
    this.values = {};
    this.calls = [];
  }

  async get(keys) {
    this.calls.push(["get", keys]);
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested
        .filter((key) => Object.hasOwn(this.values, key))
        .map((key) => [key, this.values[key]]),
    );
  }

  async set(patch) {
    this.calls.push(["set", Object.keys(patch)]);
    Object.assign(this.values, structuredClone(patch));
  }

  async remove(keys) {
    this.calls.push(["remove", keys]);
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key];
  }
}

class FakeRuntime {
  constructor() {
    this.id = "trace-shadow-test";
    this.listeners = [];
    this.onMessage = {
      addListener: (listener) => this.listeners.push(listener),
    };
  }

  dispatch(message, sender = { id: this.id }) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of this.listeners) {
        const result = listener(message, sender, resolve);
        if (result === true) {
          handled = true;
          break;
        }
      }
      if (!handled) reject(new Error("message was not handled"));
    });
  }
}

function response({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createHarness(fetchImpl = async () => response({ body: { account_id: "account-a" } })) {
  const runtime = new FakeRuntime();
  const storageArea = new FakeStorageArea();
  let reference = 0;
  const controller = installShadowObserver({
    runtime,
    storageArea,
    storageMode: "promise",
    fetch: fetchImpl,
    apiBase: "https://api.tracefiction.test",
    randomId: () => `reference-${++reference}`,
  });
  return { runtime, storageArea, controller };
}

function assertOnlyShadowStorageKeys(storageArea) {
  const observedKeys = storageArea.calls.flatMap(([, keys]) => (
    Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : []
  ));
  assert.deepEqual(
    new Set(observedKeys),
    new Set([SHADOW_CREDENTIAL_KEY, SHADOW_SESSION_KEY]),
  );
}

test("shadow listener registers before boot and explicit Connect uses only allowlisted effects", async () => {
  const fetches = [];
  const harness = createHarness(async (url, init) => {
    fetches.push({ url, init });
    return response({ body: { account_id: "private-account-a" } });
  });
  assert.equal(harness.runtime.listeners.length, 1);

  const connected = await harness.runtime.dispatch({
    type: SHADOW_CONTROL_TYPES.connect,
    credential: "unit-secret-token",
  });
  assert.equal(connected.ok, true);
  assert.equal(connected.snapshot.state, "connected");
  assert.equal(connected.snapshot.accountId, "private-account-a");
  assert.equal(connected.snapshot.canExecuteAuthenticated, true);
  assert.deepEqual(fetches, [{
    url: "https://api.tracefiction.test/api/account/me",
    init: {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: "Bearer unit-secret-token" },
    },
  }]);
  assert.deepEqual(Object.keys(harness.storageArea.values).sort(), [
    SHADOW_CREDENTIAL_KEY,
    SHADOW_SESSION_KEY,
  ]);
  assertOnlyShadowStorageKeys(harness.storageArea);

  const comparison = await harness.runtime.dispatch({
    type: SHADOW_CONTROL_TYPES.compare,
    expected: { state: "signed_out", accountId: null },
  });
  assert.equal(comparison.ok, true);
  assert.equal(comparison.matches, false);
  assert.equal(
    comparison.diagnostics.some(({ code }) => code === "shadow_snapshot_mismatch"),
    true,
  );
  const diagnosticJson = JSON.stringify(comparison.diagnostics);
  assert.equal(diagnosticJson.includes("unit-secret-token"), false);
  assert.equal(diagnosticJson.includes("private-account-a"), false);
});

test("cleanup failure cannot reconnect and reset deterministically clears both namespaces", async () => {
  const harness = createHarness();
  await harness.runtime.dispatch({
    type: SHADOW_CONTROL_TYPES.connect,
    credential: "cleanup-token",
  });
  await harness.runtime.dispatch({ type: SHADOW_CONTROL_TYPES.failCredentialDelete });

  const disconnected = await harness.runtime.dispatch({
    type: SHADOW_CONTROL_TYPES.disconnect,
  });
  assert.equal(disconnected.ok, true);
  assert.deepEqual(disconnected.action, { kind: "completed", state: "signed_out" });
  assert.equal(disconnected.snapshot.state, "signed_out");
  assert.equal(disconnected.storage.credentialReferenceCount, 1);
  assert.equal(
    disconnected.diagnostics.some(({ code }) => code === "credential_cleanup_failed"),
    true,
  );

  const reset = await harness.runtime.dispatch({ type: SHADOW_CONTROL_TYPES.reset });
  assert.equal(reset.ok, true);
  assert.equal(reset.snapshot.state, "signed_out");
  assert.deepEqual(reset.storage, {
    sessionPresent: false,
    credentialReferenceCount: 0,
  });
  assert.deepEqual(Object.keys(harness.storageArea.values), []);
  assertOnlyShadowStorageKeys(harness.storageArea);
});

test("shadow control rejects external senders and malformed messages", async () => {
  const harness = createHarness();
  assert.deepEqual(
    await harness.runtime.dispatch(
      { type: SHADOW_CONTROL_TYPES.status },
      { id: "another-extension" },
    ),
    { ok: false, error: "unauthorized" },
  );
  await assert.rejects(
    harness.runtime.dispatch({ type: "TRACE_SHADOW_UNKNOWN" }),
    /not handled/,
  );
});

test("verification adapter maps the existing account contract without leaking transport detail", async () => {
  const cases = [
    [response({ body: { account_id: " account-a " } }), { kind: "verified", accountId: "account-a" }],
    [response({ status: 401 }), { kind: "rejected" }],
    [response({ status: 403 }), { kind: "rejected" }],
    [response({ status: 500 }), { kind: "unavailable" }],
    [response({ body: { account_id: "" } }), { kind: "malformed" }],
    [response({ body: { id: "wrong-field" } }), { kind: "malformed" }],
  ];
  for (const [fixture, expected] of cases) {
    const api = new ShadowVerificationApi(async () => fixture, "https://api.tracefiction.test/");
    assert.deepEqual(await api.verifyCredential("test-token"), expected);
  }
  const unavailable = new ShadowVerificationApi(
    async () => { throw new Error("offline"); },
    "https://api.tracefiction.test",
  );
  assert.deepEqual(await unavailable.verifyCredential("test-token"), {
    kind: "unavailable",
  });
});

test("callback storage adapter treats runtime.lastError as failure", async () => {
  const runtime = { lastError: undefined, onMessage: { addListener() {} } };
  const area = {
    get(_keys, callback) {
      runtime.lastError = { message: "storage unavailable" };
      callback({});
      runtime.lastError = undefined;
    },
    set(_patch, callback) { callback(); },
    remove(_keys, callback) { callback(); },
  };
  const storage = new ShadowBrowserStorage(area, runtime, "callback");
  await assert.rejects(storage.get(SHADOW_SESSION_KEY), /storage unavailable/);
});
