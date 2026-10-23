import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  EARNED_PERMISSION_REGISTRATION_MESSAGE,
  EARNED_PERMISSION_ENDED_KEY,
  EARNED_PERMISSION_RETRY_ALARM,
  EARNED_PERMISSION_RETRY_DELAYS_MINUTES,
  EARNED_PERMISSION_RETRY_REST_MINUTES,
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
  let alarmListener = null;
  let scriptsRegistered = 0;
  const alarms = {
    created: [],
    cleared: [],
    waiting: new Map(),
    async create(name, info) { alarms.created.push({ name, ...info }); alarms.waiting.set(name, info); },
    async clear(name) { alarms.cleared.push(name); return alarms.waiting.delete(name); },
    async getAll() { return [...alarms.waiting.keys()].map((name) => ({ name })); },
    onAlarm: { addListener(listener) { alarmListener = listener; } },
  };
  const runtime = {
    id: "trace-test",
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
    async remove(key) {
      delete store[key];
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
    alarms,
    onScriptsRegistered: () => { scriptsRegistered += 1; },
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
    alarms,
    get scriptsRegistered() {
      return scriptsRegistered;
    },
    /** The waiting retry alarm goes off. False when none is waiting. */
    async fireRetryAlarm() {
      const name = [...alarms.waiting.keys()].find((waiting) => waiting.startsWith(EARNED_PERMISSION_RETRY_ALARM));
      if (name === undefined) return false;
      alarms.waiting.delete(name);
      alarmListener({ name });
      await settled();
      return true;
    },
    /** The delays of the retries scheduled so far, in order. */
    get retryDelays() {
      return alarms.created.map(({ delayInMinutes }) => delayInMinutes);
    },
    /** A message the registration runtime may act on without answering. */
    send(message, sender) {
      return messageListener(message, sender, () => assert.fail("another listener answers this message"));
    },
    async dispatch(message) {
      return await new Promise((resolve) => {
        assert.equal(messageListener?.(message, {}, resolve), true);
      });
    },
  };
}

async function settled() {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
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

// --- An optional page script, registered on its own ---------------------

const VEIL = Object.freeze({
  id: "trace-story-open-veil-v1",
  matches: ORIGINS,
  js: Object.freeze(["trace-open-veil.js"]),
  runAt: "document_start",
  persistAcrossSessions: true,
});
const VEIL_CONFIG = Object.freeze({ ...CURRENT_CONFIG, optionalRegistrations: Object.freeze([VEIL]) });
const ids = (h) => h.registrations.map(({ id }) => id);

function refusingDocumentStart(h) {
  const register = h.environment.scripting.registerContentScripts;
  const asked = [];
  h.environment.scripting.registerContentScripts = async (scripts) => {
    asked.push(scripts.map(({ id }) => id));
    if (scripts.some(({ runAt }) => runAt === "document_start")) throw new Error("Invalid runAt");
    return register(scripts);
  };
  return asked;
}

async function quietly(work) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try { await work(); } finally { console.warn = warn; }
  return warnings;
}

test("a new grant registers the optional script in its own call, after the others", async () => {
  const h = createHarness({ origins: [...ORIGINS], config: VEIL_CONFIG });
  const controller = new EarnedPermissionRegistrationController(h.environment);
  const result = await controller.reconcile();
  await controller.optionalSettled();

  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.deepEqual(h.registered.map((scripts) => scripts.map(({ id }) => id)), [
    REGISTRATIONS.map(({ id }) => id),
    [VEIL.id],
  ]);
  assert.deepEqual(ids(h), [...REGISTRATIONS.map(({ id }) => id), VEIL.id]);
  assert.equal(h.registered[1][0].runAt, "document_start");
});

test("the veil registration fails, the other two stay registered, setup stays finished", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS], config: VEIL_CONFIG });
  const asked = refusingDocumentStart(h);
  const controller = new EarnedPermissionRegistrationController(h.environment);
  let first;
  const warnings = await quietly(async () => {
    first = await controller.reconcile();
    await controller.optionalSettled();
  });

  assert.equal(first.ok, true);
  assert.equal(first.registered, true);
  assert.equal(first.error, undefined);
  assert.deepEqual(asked, [REGISTRATIONS.map(({ id }) => id), [VEIL.id]]);
  assert.deepEqual(ids(h), REGISTRATIONS.map(({ id }) => id), "the collector and the saved filters stay");
  assert.equal(warnings.length, 1, "the refusal is logged");
  assert.match(warnings[0], /trace-story-open-veil-v1/);
  const setup = { ...STORE_BUILD_STATE, registrationVersion: 4 };
  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], setup,
    "the finished setup, the grant time and the generation are as without the veil");

  // Later starts find the two scripts registered and do not try again.
  for (let start = 0; start < 3; start += 1) {
    const again = new EarnedPermissionRegistrationController(h.environment);
    assert.deepEqual(await again.reconcile(), {
      ok: true, completeGrant: true, registered: true, changed: false, grantAt: STORE_BUILD_STATE.grantAt,
    });
    await again.optionalSettled();
  }
  assert.deepEqual(asked, [REGISTRATIONS.map(({ id }) => id), [VEIL.id]], "no re-register on every start");
  assert.deepEqual(h.unregistered, []);
  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], setup);
});

test("a reader whose scripts are already registered is offered the optional one once per version", async () => {
  let version = "1.0.2";
  const h = upgradeHarness({
    origins: [...ORIGINS],
    registrations: REGISTRATIONS,
    config: VEIL_CONFIG,
    state: { ...STORE_BUILD_STATE, registrationVersion: 4 },
  });
  h.environment.runtime.getManifest = () => ({ version });
  const asked = refusingDocumentStart(h);
  const start = async () => {
    const controller = new EarnedPermissionRegistrationController(h.environment);
    const result = await controller.reconcile();
    await controller.optionalSettled();
    return result;
  };

  await quietly(async () => {
    assert.equal((await start()).changed, false);
    assert.equal((await start()).changed, false);
  });
  assert.deepEqual(asked, [[VEIL.id]], "tried once, without touching the other two");
  assert.deepEqual(ids(h), REGISTRATIONS.map(({ id }) => id));

  version = "1.0.3";
  await quietly(start);
  assert.deepEqual(asked, [[VEIL.id], [VEIL.id]], "an update tries once more");
  assert.deepEqual(ids(h), REGISTRATIONS.map(({ id }) => id));
  assert.deepEqual(h.unregistered, []);
  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], { ...STORE_BUILD_STATE, registrationVersion: 4 });
});

test("an optional script that never answers does not hold back the others", async () => {
  const h = createHarness({ origins: [...ORIGINS], config: VEIL_CONFIG });
  h.environment.optionalRegistrationTimeoutMs = 20;
  const register = h.environment.scripting.registerContentScripts;
  h.environment.scripting.registerContentScripts = (scripts) =>
    scripts.some(({ runAt }) => runAt === "document_start") ? new Promise(() => {}) : register(scripts);
  const controller = new EarnedPermissionRegistrationController(h.environment);
  const result = await controller.reconcile();

  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.deepEqual(ids(h), REGISTRATIONS.map(({ id }) => id));
  const warnings = await quietly(() => controller.optionalSettled());
  assert.equal(warnings.length, 1);
});

test("an ended grant removes the optional script with the others", async () => {
  const h = createHarness({ registrations: [...REGISTRATIONS, VEIL], config: VEIL_CONFIG });
  const result = await new EarnedPermissionRegistrationController(h.environment).reconcile();

  assert.equal(result.completeGrant, false);
  assert.deepEqual(h.unregistered, [[...REGISTRATIONS.map(({ id }) => id), VEIL.id]]);
  assert.deepEqual(ids(h), []);
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

// --- A reconcile that could not finish is tried again ------------------------

function unreadablePermissions(h) {
  const { getAll, contains } = h.environment.permissions;
  h.environment.permissions.getAll = async () => { throw new Error("unavailable"); };
  h.environment.permissions.contains = async () => { throw new Error("unavailable"); };
  return () => Object.assign(h.environment.permissions, { getAll, contains });
}

test("update: a first reconcile that cannot read permissions is tried again by alarm, and open tabs get the scripts", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  const answerAgain = unreadablePermissions(h);
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();

  assert.deepEqual(h.registered, []);
  assert.deepEqual(h.alarms.created, [{ name: `${EARNED_PERMISSION_RETRY_ALARM}:0`, delayInMinutes: 1 }]);
  assert.equal(h.scriptsRegistered, 0);

  answerAgain();
  assert.equal(await h.fireRetryAlarm(), true);

  assert.deepEqual(h.registrations.map(({ id }) => id), REGISTRATIONS.map(({ id }) => id));
  assert.equal(h.scriptsRegistered, 1, "story tabs already open are given the scripts");
  assert.equal(h.alarms.waiting.size, 0, "nothing further is waiting once it has worked");
  assert.equal(h.alarms.created.length, 1);
  assert.equal(h.store[EARNED_PERMISSION_STATE_KEY].completedAt, STORE_BUILD_STATE.completedAt);
});

test("retries come further apart each time, then rest for a day at a time, one try each", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  unreadablePermissions(h);
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();
  for (let fired = 0; fired < 7; fired += 1) {
    assert.equal(h.alarms.waiting.size, 1, "never more than one retry waiting");
    await h.fireRetryAlarm();
  }
  assert.deepEqual(h.retryDelays, [
    1, 5, 30, 180,
    EARNED_PERMISSION_RETRY_REST_MINUTES, EARNED_PERMISSION_RETRY_REST_MINUTES,
    EARNED_PERMISSION_RETRY_REST_MINUTES, EARNED_PERMISSION_RETRY_REST_MINUTES,
  ]);
  assert.deepEqual(h.registered, []);
});

test("the bound does not depend on anything being stored", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  unreadablePermissions(h);
  h.environment.storage.set = async () => { throw new Error("storage full"); };
  h.environment.storage.remove = async () => { throw new Error("storage full"); };
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();
  for (let fired = 0; fired < 5; fired += 1) await h.fireRetryAlarm();
  assert.deepEqual(h.retryDelays, [
    1, 5, 30, 180, EARNED_PERMISSION_RETRY_REST_MINUTES, EARNED_PERMISSION_RETRY_REST_MINUTES,
  ]);

  // A worker started some other way while a retry waits adds nothing to it,
  // whether that retry is the first or the rest after the last.
  const fresh = upgradeHarness({ origins: [...ORIGINS] });
  unreadablePermissions(fresh);
  fresh.alarms.waiting.set(`${EARNED_PERMISSION_RETRY_ALARM}:rest`, {});
  installEarnedPermissionRegistrationRuntime(fresh.environment);
  await settled();
  fresh.send({ type: "TRACE_ARCHIVE_ACCESS_REPORT" }, { id: "trace-test" });
  await settled();
  assert.deepEqual(fresh.alarms.created, []);
});

test("when the waiting alarms cannot be read, no retry is set; one that fired still leads to the next", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  unreadablePermissions(h);
  h.alarms.getAll = async () => { throw new Error("alarms unavailable"); };
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();
  h.send({ type: "TRACE_ARCHIVE_ACCESS_REPORT" }, { id: "trace-test" });
  await settled();
  assert.deepEqual(h.alarms.created, [], "a count that cannot be read is never taken to be zero");

  // A retry alarm that does fire carries its own place in the sequence.
  h.alarms.waiting.set(`${EARNED_PERMISSION_RETRY_ALARM}:1`, {});
  await h.fireRetryAlarm();
  assert.deepEqual(h.retryDelays, [30], "the next one only, and not a second first one beside it");
});

test("an update or a new grant starts the retries afresh", async () => {
  for (const trigger of ["update", "grant"]) {
    const h = upgradeHarness({ origins: [...ORIGINS] });
    unreadablePermissions(h);
    installEarnedPermissionRegistrationRuntime(h.environment);
    await settled();
    for (let fired = 0; fired < 4; fired += 1) await h.fireRetryAlarm();
    assert.deepEqual([...h.alarms.waiting.keys()], [`${EARNED_PERMISSION_RETRY_ALARM}:rest`]);

    if (trigger === "update") h.installedListener({ reason: "update" });
    else h.addedListener();
    await settled();
    assert.deepEqual([...h.alarms.waiting.keys()], [`${EARNED_PERMISSION_RETRY_ALARM}:0`], trigger);
    assert.equal(h.retryDelays.at(-1), 1);
  }
});

test("a registration the browser refuses is tried again the same way", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  const register = h.environment.scripting.registerContentScripts;
  h.environment.scripting.registerContentScripts = async () => { throw new Error("refused"); };
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();
  assert.deepEqual(h.retryDelays, [1]);

  h.environment.scripting.registerContentScripts = register;
  await h.fireRetryAlarm();
  assert.equal(h.registrations.length, 2);
  assert.equal(h.scriptsRegistered, 1);
});

test("update: one reading that the grant is incomplete is asked again, not taken as the answer", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  scriptedReadings(h, [{ contains: false }, { contains: true }]);
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();

  assert.deepEqual(h.registered, [], "the first reconcile did not finish");
  assert.deepEqual(h.retryDelays, [1]);
  assert.equal(Object.hasOwn(h.store, EARNED_PERMISSION_ENDED_KEY), false, "an unconfirmed ending is not recorded");

  await h.fireRetryAlarm();
  assert.equal(h.registrations.length, 2);
});

test("a settled answer that the sites are not allowed schedules nothing and ends any retry", async () => {
  for (const state of [null, STORE_BUILD_STATE]) {
    const h = createHarness({ origins: [], config: CURRENT_CONFIG, state });
    const answerAgain = unreadablePermissions(h);
    installEarnedPermissionRegistrationRuntime(h.environment);
    await settled();
    assert.equal(h.alarms.created.length, 1);

    answerAgain();
    await h.fireRetryAlarm();

    assert.equal(h.alarms.created.length, 1, "not allowed is an answer, not a failure");
    assert.equal(h.alarms.waiting.size, 0);
    assert.deepEqual(h.registered, []);
    assert.equal(h.scriptsRegistered, 0);
  }
});

// --- A reader whose access has ended pays the pause once ---------------------

test("an ended grant is confirmed once; after that an incomplete reading needs no second look", async () => {
  const h = upgradeHarness({ origins: [] });
  let reads = 0;
  const contains = h.environment.permissions.contains;
  h.environment.permissions.contains = async (request) => { reads += 1; return contains(request); };
  const controller = new EarnedPermissionRegistrationController(h.environment);

  assert.equal((await controller.reconcile()).error, "permission_incomplete");
  assert.equal(reads, 2, "the first ending is read twice");
  assert.equal(typeof h.store[EARNED_PERMISSION_ENDED_KEY], "number");

  assert.equal((await controller.reconcile()).error, "permission_incomplete");
  assert.equal((await controller.reconcile()).error, "permission_incomplete");
  assert.equal(reads, 4, "each later reconcile reads once");
  assert.deepEqual(h.store[EARNED_PERMISSION_STATE_KEY], STORE_BUILD_STATE);
});

test("scripts still registered are never removed on one reading, whatever was confirmed before", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS], registrations: REGISTRATIONS });
  h.store[EARNED_PERMISSION_ENDED_KEY] = 1_779_000_000_000;
  scriptedReadings(h, [{ contains: false }, { contains: true }]);
  await assert.rejects(
    new EarnedPermissionRegistrationController(h.environment).reconcile(),
    /permission_state_unconfirmed/,
  );
  assert.deepEqual(h.unregistered, []);
});

test("access coming back, or a new grant, means the next ending is confirmed again", async () => {
  const back = upgradeHarness({ origins: [...ORIGINS] });
  back.store[EARNED_PERMISSION_ENDED_KEY] = 1_779_000_000_000;
  await new EarnedPermissionRegistrationController(back.environment).reconcile();
  assert.equal(Object.hasOwn(back.store, EARNED_PERMISSION_ENDED_KEY), false);

  const granted = upgradeHarness({ origins: [] });
  granted.store[EARNED_PERMISSION_ENDED_KEY] = 1_779_000_000_000;
  let reads = 0;
  const contains = granted.environment.permissions.contains;
  granted.environment.permissions.contains = async (request) => { reads += 1; return contains(request); };
  installEarnedPermissionRegistrationRuntime(granted.environment);
  await settled();
  assert.equal(reads, 1, "a recorded ending is not read twice");
  // Safari reports a grant, but the reading that follows still says incomplete.
  granted.addedListener();
  await settled();
  assert.equal(reads, 3, "after a grant event the ending is confirmed again");
});

test("the popup opening reconciles for a reader whose setup is finished, and only the popup can ask that way", async () => {
  const h = upgradeHarness({ origins: [...ORIGINS] });
  const answerAgain = unreadablePermissions(h);
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();
  answerAgain();
  const opened = { type: "TRACE_ARCHIVE_ACCESS_REPORT" };

  assert.equal(h.send(opened, { id: "trace-test", tab: { id: 3 }, url: "https://archiveofourown.org/works/1" }), false);
  await settled();
  assert.deepEqual(h.registered, [], "a page cannot start it");

  assert.equal(h.send(opened, { id: "trace-test" }), false, "the message is left for its own listener to answer");
  await settled();
  assert.equal(h.registrations.length, 2);
  assert.equal(h.scriptsRegistered, 1);
});

test("allowing the story sites while the worker is awake gives open story tabs the scripts", async () => {
  const h = createHarness({ origins: [], config: CURRENT_CONFIG });
  installEarnedPermissionRegistrationRuntime(h.environment);
  await settled();
  assert.equal(h.scriptsRegistered, 0);

  h.origins.push(...ORIGINS);
  h.addedListener();
  await settled();

  assert.equal(h.registrations.length, 2);
  assert.equal(h.scriptsRegistered, 1);

  h.addedListener();
  await settled();
  assert.equal(h.scriptsRegistered, 1, "an unchanged registration injects nothing again");
});
