import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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
  config = CONFIG,
  scriptingAvailable = true,
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
    ...(scriptingAvailable ? { scripting } : {}),
    storage,
    storageMode: "promise",
    config,
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

test("static compatibility mode adopts a complete grant without scripting", async () => {
  const h = createHarness({
    origins: [...ORIGINS],
    config: { ...CONFIG, registrationMode: "static" },
    scriptingAvailable: false,
  });
  const controller = new EarnedPermissionRegistrationController(h.environment);

  assert.deepEqual(await controller.reconcile(), {
    ok: true,
    completeGrant: true,
    registered: true,
    changed: false,
    grantAt: 1_780_000_000_000,
  });
  assert.equal(h.registered.length, 0);
  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], {
    grantAt: 1_780_000_000_000,
    registrationVersion: 3,
    promptResult: "granted",
  });
});

test("static compatibility mode keeps archive runtime gated for a partial grant", async () => {
  const h = createHarness({
    origins: ORIGINS.slice(0, 4),
    config: { ...CONFIG, registrationMode: "static" },
    scriptingAvailable: false,
  });
  const controller = new EarnedPermissionRegistrationController(h.environment);

  assert.deepEqual(await controller.reconcile(), {
    ok: false,
    completeGrant: false,
    registered: false,
    changed: false,
    error: "permission_incomplete",
  });
  assert.equal(h.registered.length, 0);
  assert.equal(h.unregistered.length, 0);
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

// The archive page gate lives in the generated popup-config.js content script.
// Run the committed Safari bundle file against scripted background replies.
const POPUP_CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../Shared (Extension)/Resources/popup-config.js",
);
const COMPLETE_RESULT = Object.freeze({
  ok: true,
  completeGrant: true,
  registered: true,
  changed: false,
  grantAt: 1,
});

function runArchivePageGate(replies, { promiseApi = true } = {}) {
  const sent = [];
  const timers = [];
  const readyEvents = [];
  const nextReply = () => (replies.length > 0 ? replies.shift() : undefined);
  const runtime = promiseApi
    ? {
        sendMessage(message) {
          sent.push(message);
          const reply = nextReply();
          return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
        },
      }
    : {
        lastError: undefined,
        sendMessage(message, callback) {
          sent.push(message);
          const reply = nextReply();
          queueMicrotask(() => {
            runtime.lastError = reply instanceof Error ? { message: reply.message } : undefined;
            callback(reply instanceof Error ? undefined : reply);
            runtime.lastError = undefined;
          });
        },
      };
  const listeners = new Map();
  const listen = (type, listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  };
  const context = {
    location: { hostname: "archiveofourown.org" },
    document: {
      hidden: false,
      dispatchEvent: (event) => readyEvents.push(event.type),
      addEventListener: listen,
    },
    addEventListener: listen,
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].callback = () => {}; },
    ...(promiseApi ? { browser: { runtime } } : { chrome: { runtime } }),
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(POPUP_CONFIG_PATH, "utf8"), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const drain = async () => {
    await settle();
    while (timers.length > 0) {
      timers.shift().callback();
      await settle();
    }
  };
  const fire = (type, init = {}) => {
    for (const listener of listeners.get(type) ?? []) listener({ type, ...init });
  };
  return { context, sent, timers, readyEvents, drain, fire };
}

for (const promiseApi of [true, false]) {
  const api = promiseApi ? "promise" : "callback";

  test(`archive page gate asks again when the background could not answer yet (${api} API)`, async () => {
    // Safari re-injects content scripts into open tabs when the extension
    // reloads; a reconcile sent before the background listens comes back empty.
    const h = runArchivePageGate([undefined, new Error("no listener"), COMPLETE_RESULT], { promiseApi });
    await h.drain();
    assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, true);
    assert.deepEqual(h.readyEvents, ["trace-earned-permission-ready"]);
    assert.equal(h.sent.length, 3);
    assert.ok(h.sent.every((message) => message.type === EARNED_PERMISSION_REGISTRATION_MESSAGE));
  });

  test(`archive page gate treats a definite incomplete grant as final (${api} API)`, async () => {
    const h = runArchivePageGate([
      { ok: false, completeGrant: false, registered: false, changed: false, error: "permission_incomplete" },
      COMPLETE_RESULT,
    ], { promiseApi });
    await h.drain();
    assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, false);
    assert.deepEqual(h.readyEvents, []);
    assert.equal(h.sent.length, 1);
  });
}

test("archive page gate stops asking after a bounded number of empty replies", async () => {
  const h = runArchivePageGate([]);
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, false);
  assert.ok(h.sent.length > 1 && h.sent.length <= 5, `sent ${h.sent.length}`);
});

test("archive page gate asks again when a back-forward cache restore resumes a page that ran out of retries", async () => {
  // The background was asleep for the whole bounded round of asking; Safari
  // then restores the page from memory, so no content script runs again.
  const replies = [undefined, undefined, undefined, undefined, undefined];
  const h = runArchivePageGate(replies);
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, false);
  assert.equal(h.sent.length, 5);
  replies.push(COMPLETE_RESULT);
  h.fire("pageshow", { persisted: true });
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, true);
  assert.deepEqual(h.readyEvents, ["trace-earned-permission-ready"]);
  h.fire("pageshow", { persisted: true });
  h.fire("visibilitychange");
  await h.drain();
  assert.equal(h.sent.length, 6, "a ready page never asks again");
});

test("archive page gate re-checks a definite incomplete grant when the reader returns", async () => {
  const replies = [{ ok: false, completeGrant: false, registered: false, changed: false, error: "permission_incomplete" }];
  const h = runArchivePageGate(replies);
  await h.drain();
  assert.equal(h.sent.length, 1);
  h.context.document.hidden = true;
  h.fire("visibilitychange");
  await h.drain();
  assert.equal(h.sent.length, 1, "a hidden page does not ask");
  h.context.document.hidden = false;
  replies.push(COMPLETE_RESULT);
  h.fire("visibilitychange");
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, true);
});

test("archive page gate treats a background that could not read permissions as transient", async () => {
  const h = runArchivePageGate([
    { ok: false, completeGrant: false, registered: false, changed: false, error: "registration_failed" },
    COMPLETE_RESULT,
  ]);
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, true);
  assert.equal(h.sent.length, 2);
});

test("archive page gate does not wait forever on a reply Safari never delivers", async () => {
  const replies = [new Promise(() => {}), COMPLETE_RESULT];
  const sent = [];
  const h = runArchivePageGate([]);
  // Replace the scripted runtime with one whose first reply never settles.
  h.context.browser.runtime.sendMessage = (message) => {
    sent.push(message);
    const reply = replies.shift();
    return reply instanceof Promise ? reply : Promise.resolve(reply);
  };
  h.fire("pageshow", { persisted: true });
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, true);
  assert.ok(sent.length >= 2);
});

test("a hung browser call cannot wedge later reconciles until Safari restarts", async () => {
  const h = createHarness({ origins: [...ORIGINS], config: { ...CONFIG, registrationMode: "static" } });
  const getAll = h.environment.permissions.getAll;
  const contains = h.environment.permissions.contains;
  h.environment.permissions.getAll = () => new Promise(() => {});
  h.environment.permissions.contains = () => new Promise(() => {});
  const controller = new EarnedPermissionRegistrationController({
    ...h.environment,
    reconcileTimeoutMs: 20,
  });
  await assert.rejects(controller.reconcile(), /reconcile_timeout/);
  h.environment.permissions.getAll = getAll;
  h.environment.permissions.contains = contains;
  const recovered = await controller.reconcile();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.completeGrant, true);
});

test("an unreadable permission state is reported as transient, never as a partial grant", async () => {
  const h = createHarness({ origins: [...ORIGINS], registrations: REGISTRATIONS });
  h.environment.permissions.getAll = async () => { throw new Error("unavailable"); };
  h.environment.permissions.contains = async () => { throw new Error("unavailable"); };
  installEarnedPermissionRegistrationRuntime(h.environment);
  const response = await h.dispatch({ type: EARNED_PERMISSION_REGISTRATION_MESSAGE });
  assert.equal(response.ok, false);
  assert.equal(response.error, "registration_failed");
  assert.deepEqual(h.unregistered, [], "registered scripts survive a failed permission read");
});
