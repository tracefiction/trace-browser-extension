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
    // The pause between the two readings that end a grant; tests that are
    // about that pause set their own.
    endedGrantConfirmDelayMs: 0,
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

// The committed bundle is the iPhone build, which registers its page scripts
// after the grant and leaves this gate idle. The gate still ships for the
// required-hosts build, so run it the way that build configures it.
function requiredHostsPopupConfig() {
  const source = fs.readFileSync(POPUP_CONFIG_PATH, "utf8");
  const configured = source.replace(
    /("registrationMode":)"(?:dynamic|static)"/,
    '$1"static"',
  );
  assert.match(configured, /"registrationMode":"static"/);
  return configured;
}

function runArchivePageGate(replies, { promiseApi = true, clock = null } = {}) {
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
    ...(clock ? { Date: { now: () => clock.now } } : {}),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].callback = () => {}; },
    ...(promiseApi ? { browser: { runtime } } : { chrome: { runtime } }),
  };
  context.globalThis = context;
  vm.runInNewContext(requiredHostsPopupConfig(), context);
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

test("archive page gate asks again on the reader's next scroll or touch after every retry went unanswered", async () => {
  // After an app update Safari can wake the new background later than every
  // bounded retry. The reader keeps reading the same tab, so neither pageshow
  // nor focus fires; their next interaction must open the page.
  const clock = { now: 1_000 };
  const replies = [undefined, undefined, undefined, undefined, undefined];
  const h = runArchivePageGate(replies, { clock });
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, false);
  assert.equal(h.sent.length, 5);

  h.fire("scroll");
  await h.drain();
  assert.equal(h.sent.length, 5, "an interaction right after the last ask waits");

  clock.now += 10_000;
  replies.push(COMPLETE_RESULT);
  h.fire("touchstart");
  await h.drain();
  assert.equal(h.context.TRACE_EARNED_PERMISSION_COMPLETE, true);
  assert.deepEqual(h.readyEvents, ["trace-earned-permission-ready"]);

  clock.now += 60_000;
  h.fire("scroll");
  h.fire("pointerdown");
  await h.drain();
  assert.equal(h.sent.length, 6, "a ready page never asks again");
});

test("archive page gate does not repeat a definite answer on scroll", async () => {
  const clock = { now: 1_000 };
  const h = runArchivePageGate([
    { ok: false, completeGrant: false, registered: false, changed: false, error: "permission_incomplete" },
  ], { clock });
  await h.drain();
  assert.equal(h.sent.length, 1);
  clock.now += 60_000;
  h.fire("scroll");
  h.fire("touchstart");
  await h.drain();
  assert.equal(h.sent.length, 1);
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a slow static check that finishes after a newer one cannot erase newer onboarding state", async () => {
  const h = createHarness({ origins: [...ORIGINS], config: { ...CONFIG, registrationMode: "static" } });
  const get = h.environment.storage.get;
  const slowRead = deferred();
  let reads = 0;
  h.environment.storage.get = (key) => {
    reads += 1;
    return reads === 1 ? slowRead.promise : get(key);
  };
  const controller = new EarnedPermissionRegistrationController({ ...h.environment, reconcileTimeoutMs: 20 });
  await assert.rejects(controller.reconcile(), /reconcile_timeout/);
  const current = await controller.reconcile();
  assert.equal(current.ok, true);
  // The popup records completed onboarding after the newer check.
  h.store[EARNED_PERMISSION_STATE_KEY] = { ...h.store[EARNED_PERMISSION_STATE_KEY], completedAt: 42 };
  const expected = structuredClone(h.store);
  // The slow check now sees its stale, empty state and would write it back.
  slowRead.resolve({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.store, expected, "the late check changed nothing");
});

test("a slow dynamic check that finds an incomplete grant late cannot unregister newer scripts", async () => {
  const h = createHarness({ origins: [...ORIGINS] });
  const contains = h.environment.permissions.contains;
  const slowContains = deferred();
  let calls = 0;
  h.environment.permissions.contains = (request) => {
    calls += 1;
    return calls === 1 ? slowContains.promise : contains(request);
  };
  const controller = new EarnedPermissionRegistrationController({ ...h.environment, reconcileTimeoutMs: 20 });
  await assert.rejects(controller.reconcile(), /reconcile_timeout/);
  const current = await controller.reconcile();
  assert.equal(current.registered, true);
  slowContains.resolve(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.unregistered, [], "the late incomplete result unregistered nothing");
  assert.deepEqual(h.registrations.map(({ id }) => id), REGISTRATIONS.map(({ id }) => id));
});

test("a failed getAll with a positive contains answer is still a complete grant", async () => {
  const h = createHarness({ origins: [...ORIGINS], config: { ...CONFIG, registrationMode: "static" } });
  h.environment.permissions.getAll = async () => { throw new Error("unavailable"); };
  h.environment.permissions.contains = async () => true;
  const result = await new EarnedPermissionRegistrationController(h.environment).reconcile();
  assert.equal(result.ok, true);
  assert.equal(result.completeGrant, true);
});

// --- Readers who arrive from the build that required its story sites -------
//
// That build declared its page scripts in the manifest and recorded a finished
// setup as { grantAt, registrationVersion: 3, promptResult, completedAt }. It
// never registered a script. None of these cases may ask the reader anything.

const STORE_BUILD_STATE = Object.freeze({
  grantAt: 1_770_000_000_000,
  registrationVersion: 3,
  promptResult: "granted",
  completedAt: 1_770_000_600_000,
});
const CURRENT_CONFIG = Object.freeze({ ...CONFIG, version: 4, registrationMode: "dynamic" });

function upgradeHarness(options) {
  const h = createHarness({ config: CURRENT_CONFIG, state: STORE_BUILD_STATE, ...options });
  h.environment.permissions.request = () => assert.fail("an update must never ask for website access");
  return h;
}

test("update: a reader with the five story sites allowed keeps saving and is not sent through setup again", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  installEarnedPermissionRegistrationRuntime(h.environment);
  h.installedListener({ reason: "update" });
  const result = await h.dispatch({ type: EARNED_PERMISSION_REGISTRATION_MESSAGE });

  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.deepEqual(h.registrations.map(({ id }) => id), REGISTRATIONS.map(({ id }) => id));
  assert.equal(h.registered.length, 1, "registered once, not once per trigger");
  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], {
    ...STORE_BUILD_STATE,
    registrationVersion: 4,
  }, "the finished setup and the time of the grant are kept");
});

test("update: a reader who allowed every website is carried over the same way", async () => {
  // Safari lists one broad pattern, none of the five; only `contains` knows.
  const h = upgradeHarness({ origins: ["*://*/*"], containsResult: true });
  const result = await new EarnedPermissionRegistrationController(h.environment).reconcile();

  assert.equal(result.registered, true);
  assert.equal(h.registered.length, 1);
  assert.equal(h.store[EARNED_PERMISSION_STATE_KEY].completedAt, STORE_BUILD_STATE.completedAt);
});

for (const [name, origins] of [
  ["one story site", ["https://m.fanfiction.net/*"]],
  ["four of the five story sites", ORIGINS.slice(0, 4)],
  ["no story site", []],
]) {
  test(`update: a reader with ${name} allowed gets no script, no question and an untouched record`, async () => {
    const h = upgradeHarness({ origins });
    const result = await new EarnedPermissionRegistrationController(h.environment).reconcile();

    assert.deepEqual(result, {
      ok: false,
      completeGrant: false,
      registered: false,
      changed: false,
      error: "permission_incomplete",
    });
    assert.deepEqual(h.registered, []);
    assert.deepEqual(h.unregistered, []);
    assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], STORE_BUILD_STATE);
  });
}

test("update: scripts registered by an earlier generation are replaced once and setup stays finished", async () => {
  const older = REGISTRATIONS.map((item) => ({ ...item, js: ["popup-config.js", "collector.js"] }));
  const h = upgradeHarness({ origins: [...ORIGINS], registrations: older });
  const controller = new EarnedPermissionRegistrationController(h.environment);

  const first = await controller.reconcile();
  const second = await controller.reconcile();

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(h.unregistered, [REGISTRATIONS.map(({ id }) => id)]);
  assert.equal(h.registered.length, 1);
  assert.deepEqual(h.registrations.map(({ js }) => js), REGISTRATIONS.map(({ js }) => js));
  assert.equal(h.store[EARNED_PERMISSION_STATE_KEY].completedAt, STORE_BUILD_STATE.completedAt);
});

test("a reader who never finished setup still gets a fresh grant time when scripts are registered", async () => {
  const h = createHarness({
    origins: [...ORIGINS],
    config: CURRENT_CONFIG,
    state: { grantAt: 1_770_000_000_000, registrationVersion: 3, promptResult: "declined" },
  });
  await new EarnedPermissionRegistrationController(h.environment).reconcile();

  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], {
    grantAt: 1_780_000_000_000,
    registrationVersion: 4,
    promptResult: "granted",
    completedAt: null,
  });
});

// --- A grant ends only when two readings agree ------------------------------

function scriptedReadings(h, readings) {
  let reads = 0;
  h.environment.permissions.contains = async () => {
    const reading = readings[Math.min(reads, readings.length - 1)];
    reads += 1;
    if (reading.contains instanceof Error) throw reading.contains;
    return reading.contains;
  };
  let lists = 0;
  h.environment.permissions.getAll = async () => {
    const reading = readings[Math.min(lists, readings.length - 1)];
    lists += 1;
    if (reading.listed === false) throw new Error("unavailable");
    return { origins: reading.contains === true ? [...ORIGINS] : [] };
  };
  return { get reads() { return reads; } };
}

test("one reading that the grant is incomplete removes nothing when the next reading says it is complete", async () => {
  const h = createHarness({ origins: [...ORIGINS], registrations: REGISTRATIONS, config: CURRENT_CONFIG });
  const readings = scriptedReadings(h, [{ contains: false }, { contains: true }]);
  const controller = new EarnedPermissionRegistrationController(h.environment);

  await assert.rejects(controller.reconcile(), /permission_state_unconfirmed/);

  assert.equal(readings.reads, 2);
  assert.deepEqual(h.unregistered, []);
  assert.deepEqual(h.registrations.map(({ id }) => id), REGISTRATIONS.map(({ id }) => id));
});

test("an incomplete reading the browser could not back with a list of what is granted removes nothing", async () => {
  for (const readings of [
    [{ contains: false, listed: false }, { contains: false }],
    [{ contains: false }, { contains: false, listed: false }],
    [{ contains: false }, { contains: new Error("unavailable"), listed: false }],
  ]) {
    const h = createHarness({ origins: [...ORIGINS], registrations: REGISTRATIONS, config: CURRENT_CONFIG });
    scriptedReadings(h, readings);
    await assert.rejects(
      new EarnedPermissionRegistrationController(h.environment).reconcile(),
      /permission_state_unconfirmed/,
    );
    assert.deepEqual(h.unregistered, []);
  }
});

test("two readings that agree the grant has ended remove the scripts, and only after the pause between them", async () => {
  const h = createHarness({ origins: [], registrations: REGISTRATIONS, config: CURRENT_CONFIG });
  const readings = scriptedReadings(h, [{ contains: false }, { contains: false }]);
  const controller = new EarnedPermissionRegistrationController({
    ...h.environment,
    endedGrantConfirmDelayMs: 40,
  });

  const pending = controller.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.unregistered, [], "nothing is removed on the first reading");
  const result = await pending;

  assert.equal(readings.reads, 2);
  assert.equal(result.error, "permission_incomplete");
  assert.equal(result.changed, true);
  assert.deepEqual(h.unregistered, [REGISTRATIONS.map(({ id }) => id)]);
});

test("a page or popup that asks during an unconfirmed ending is told to ask again, and the scripts stay", async () => {
  const h = createHarness({ origins: [...ORIGINS], registrations: REGISTRATIONS, config: CURRENT_CONFIG });
  // The start-up reconcile and the asked-for one each read twice.
  scriptedReadings(h, [{ contains: false }, { contains: true }, { contains: false }, { contains: true }]);
  installEarnedPermissionRegistrationRuntime(h.environment);

  const response = await h.dispatch({ type: EARNED_PERMISSION_REGISTRATION_MESSAGE });

  assert.equal(response.ok, false);
  assert.equal(response.error, "registration_failed");
  assert.deepEqual(h.unregistered, []);
});
