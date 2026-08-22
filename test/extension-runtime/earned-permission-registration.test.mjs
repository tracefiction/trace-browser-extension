import assert from "node:assert/strict";
import test from "node:test";

import {
  EARNED_PERMISSION_REGISTRATION_MESSAGE,
  EARNED_PERMISSION_STATE_KEY,
  EarnedPermissionRegistrationController,
  installEarnedPermissionRegistrationRuntime,
} from "../../.trace-build/extension-runtime/earned-permission-registration.mjs";

const ORIGINS = Object.freeze([
  "https://*.archiveofourown.org/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
]);
const REGISTRATIONS = Object.freeze([
  Object.freeze({
    id: "trace-archive-automation-v1",
    matches: ORIGINS,
    js: Object.freeze(["content-config.js", "collector.js"]),
    runAt: "document_end",
    persistAcrossSessions: true,
  }),
  Object.freeze({
    id: "trace-ao3-saved-filters-v1",
    matches: ORIGINS.slice(0, 3),
    js: Object.freeze(["ao3-saved-filters.js"]),
    runAt: "document_end",
    persistAcrossSessions: true,
  }),
]);
const CONFIG = Object.freeze({
  version: 3,
  origins: ORIGINS,
  registrations: REGISTRATIONS,
});

function createHarness({
  origins = [],
  containsResult = null,
  registrations = [],
  state = null,
  now = 1_780_000_000_000,
} = {}) {
  const store = state ? { [EARNED_PERMISSION_STATE_KEY]: { ...state } } : {};
  let currentRegistrations = registrations.map((item) => ({ ...item }));
  const registered = [];
  const unregistered = [];
  let addedListener = null;
  let removedListener = null;
  let installedListener = null;
  let messageListener = null;
  const runtime = {
    onInstalled: {
      addListener(listener) {
        installedListener = listener;
      },
    },
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
  };
  const permissions = {
    async getAll() {
      return { origins: [...origins] };
    },
    async contains({ origins: requestedOrigins = [] }) {
      return typeof containsResult === "boolean"
        ? containsResult
        : requestedOrigins.every((origin) => origins.includes(origin));
    },
    onAdded: {
      addListener(listener) {
        addedListener = listener;
      },
    },
    onRemoved: {
      addListener(listener) {
        removedListener = listener;
      },
    },
  };
  const scripting = {
    async getRegisteredContentScripts() {
      return currentRegistrations.map((item) => ({ ...item }));
    },
    async unregisterContentScripts({ ids }) {
      unregistered.push([...ids]);
      const stale = new Set(ids);
      currentRegistrations = currentRegistrations.filter(
        ({ id }) => !stale.has(id),
      );
    },
    async registerContentScripts(next) {
      registered.push(next.map((item) => ({ ...item })));
      currentRegistrations.push(...next.map((item) => ({ ...item })));
    },
  };
  const storage = {
    async get(key) {
      return Object.hasOwn(store, key) ? { [key]: store[key] } : {};
    },
    async set(patch) {
      Object.assign(store, patch);
    },
  };
  const environment = {
    runtime,
    permissions,
    scripting,
    storage,
    storageMode: "promise",
    config: CONFIG,
    clock: () => now,
  };
  return {
    environment,
    origins,
    store,
    registered,
    unregistered,
    get registrations() {
      return currentRegistrations;
    },
    get addedListener() {
      return addedListener;
    },
    get removedListener() {
      return removedListener;
    },
    get installedListener() {
      return installedListener;
    },
    clearRegistrations() {
      currentRegistrations = [];
    },
    async dispatch(message) {
      return await new Promise((resolve) => {
        assert.equal(messageListener?.(message, {}, resolve), true);
      });
    },
  };
}

test("complete grant registers the canonical scripts and is idempotent", async () => {
  const h = createHarness({ origins: [...ORIGINS] });
  const controller = new EarnedPermissionRegistrationController(h.environment);

  const first = await controller.reconcile();
  assert.deepEqual(first, {
    ok: true,
    completeGrant: true,
    registered: true,
    changed: true,
    grantAt: 1_780_000_000_000,
  });
  assert.equal(h.registered.length, 1);
  assert.deepEqual(
    h.registered[0].map(({ id }) => id),
    REGISTRATIONS.map(({ id }) => id),
  );
  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], {
    grantAt: 1_780_000_000_000,
    registrationVersion: 3,
    promptResult: "granted",
    completedAt: null,
  });

  const second = await controller.reconcile();
  assert.equal(second.changed, false);
  assert.equal(h.registered.length, 1);
  assert.equal(h.unregistered.length, 0);
});

test("partial grant unregisters the bundle so Trace never presents partial coverage as ready", async () => {
  const h = createHarness({
    origins: ORIGINS.slice(0, 4),
    registrations: REGISTRATIONS,
    state: {
      grantAt: 1_779_000_000_000,
      registrationVersion: 3,
      promptResult: "granted",
    },
  });
  const controller = new EarnedPermissionRegistrationController(h.environment);

  assert.deepEqual(await controller.reconcile(), {
    ok: false,
    completeGrant: false,
    registered: false,
    changed: true,
    error: "permission_incomplete",
  });
  assert.deepEqual(h.unregistered, [REGISTRATIONS.map(({ id }) => id)]);
  assert.equal(h.registrations.length, 0);
  assert.equal(h.registered.length, 0);
});

test("semantic permission coverage adopts a legacy grant even when getAll uses different patterns", async () => {
  const h = createHarness({
    origins: ["https://archiveofourown.org/*"],
    containsResult: true,
  });
  const controller = new EarnedPermissionRegistrationController(h.environment);

  const result = await controller.reconcile();

  assert.equal(result.ok, true);
  assert.equal(result.completeGrant, true);
  assert.equal(result.registered, true);
  assert.equal(h.registered.length, 1);
});

test("worker startup adopts an existing complete grant before any popup opens", async () => {
  const h = createHarness({ origins: [...ORIGINS] });
  installEarnedPermissionRegistrationRuntime(h.environment);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof h.addedListener, "function");
  assert.equal(typeof h.removedListener, "function");
  assert.equal(typeof h.installedListener, "function");
  assert.equal(h.registered.length, 1);
  assert.equal(
    h.store[EARNED_PERMISSION_STATE_KEY].promptResult,
    "granted",
  );
  const response = await h.dispatch({
    type: EARNED_PERMISSION_REGISTRATION_MESSAGE,
  });
  assert.equal(response.ok, true);
  assert.equal(response.registered, true);
  assert.equal(h.registered.length, 1);
});

test("extension update restores dynamic scripts cleared by Safari", async () => {
  const h = createHarness({ origins: [...ORIGINS] });
  installEarnedPermissionRegistrationRuntime(h.environment);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.registered.length, 1);

  h.clearRegistrations();
  h.installedListener({ reason: "update" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.registered.length, 2);
  assert.deepEqual(
    h.registrations.map(({ id }) => id),
    REGISTRATIONS.map(({ id }) => id),
  );
});

test("unrelated runtime messages are ignored", () => {
  const h = createHarness({ origins: [...ORIGINS] });
  const controller = installEarnedPermissionRegistrationRuntime(h.environment);
  assert.ok(controller);
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.rejects(
        h.dispatch({ type: "TRACE_NOT_THIS_MESSAGE" }),
      ).finally(resolve);
    });
  });
});
