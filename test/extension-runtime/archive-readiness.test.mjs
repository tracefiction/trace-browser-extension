import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_ACCESS_REPORTED_AT_KEY,
  ARCHIVE_ACCESS_REPORT_STALE_MS,
  ArchiveReadinessRuntimeController,
  installArchiveAccessReport,
  installArchiveReadinessRuntime,
} from "../../.trace-build/extension-runtime/archive-readiness.mjs";
import { BrowserStorage } from "../../.trace-build/extension-runtime/browser-platform.mjs";
import {
  archiveHostKindFromSender,
} from "../../.trace-build/extension-runtime/archive-sender.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function createPromiseHarness(options = {}) {
  const nativeMessages = [];
  const listeners = [];
  const runtime = {
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
    async sendNativeMessage(...args) {
      const message = args.find((value) => value && typeof value === "object");
      nativeMessages.push(message);
      return options.nativeResponse ?? { ok: true };
    },
  };
  const controller = new ArchiveReadinessRuntimeController({
    runtime,
    permissions: options.permissions,
    storageMode: "promise",
    clock: options.clock ?? { now: () => 5_000 },
    status: options.status,
    publishTrackingPreference: options.publishTrackingPreference,
  });
  return { controller, listeners, nativeMessages, runtime };
}

const ao3Sender = {
  tab: { url: "https://archiveofourown.org/works/123" },
  frameId: 0,
  documentLifecycle: "active",
};

test("derives archive identity only from supported active top-frame senders", () => {
  assert.equal(archiveHostKindFromSender(ao3Sender), "ao3");
  assert.equal(archiveHostKindFromSender({
    tab: { url: "https://m.fanfiction.net/s/123/1/Story" },
    frameId: 0,
  }), "ffn");
  assert.equal(archiveHostKindFromSender({
    tab: { url: "https://evil.example/works/123" },
    frameId: 0,
  }), null);
  assert.equal(archiveHostKindFromSender({
    tab: { url: "https://archiveofourown.org/works/123" },
    frameId: 2,
  }), null);
  assert.equal(archiveHostKindFromSender({
    tab: { url: "https://archiveofourown.org/works/123" },
    frameId: 0,
    documentLifecycle: "prerender",
  }), null);
});

test("publishes a bounded handoff receipt without session or account state", async () => {
  const statusEvents = [];
  const h = createPromiseHarness({
    status: {
      async record(event) {
        statusEvents.push(event);
      },
    },
  });
  assert.deepEqual(
    await h.controller.handle({
      type: "TRACE_ARCHIVE_SEEN",
      handoffId: "handoff_123",
      hostKind: "ffn",
      token: "must-not-escape",
      accountId: "must-not-escape",
    }, ao3Sender),
    { ok: true, receipt: "published" },
  );
  assert.deepEqual(h.nativeMessages, [{
    type: "TRACE_IOS_EXTENSION_HEARTBEAT",
    hostKind: "ao3",
    at: 5_000,
    handoffId: "handoff_123",
  }]);
  await waitUntil(() => statusEvents.length === 1, "local readiness was not recorded");
  assert.deepEqual(statusEvents, [{ hostKind: "ao3" }]);
});

test("invalid, subframe, and spoofed senders are acknowledged without native evidence", async () => {
  const h = createPromiseHarness();
  for (const sender of [
    { tab: { url: "https://evil.example/works/123" }, frameId: 0 },
    { tab: { url: "https://archiveofourown.org/works/123" }, frameId: 3 },
    {
      tab: { url: "https://archiveofourown.org/works/123" },
      frameId: 0,
      documentLifecycle: "pending_deletion",
    },
  ]) {
    assert.deepEqual(
      await h.controller.handle({ type: "TRACE_ARCHIVE_SEEN", hostKind: "ao3" }, sender),
      { ok: true, receipt: "ignored" },
    );
  }
  assert.deepEqual(h.nativeMessages, []);
});

test("invalid handoff data is discarded rather than forwarded", async () => {
  const h = createPromiseHarness();
  assert.deepEqual(
    await h.controller.handle({
      type: "TRACE_ARCHIVE_SEEN",
      handoffId: "bad handoff with spaces",
    }, ao3Sender),
    { ok: true, receipt: "published" },
  );
  assert.equal(Object.hasOwn(h.nativeMessages[0], "handoffId"), false);
});

test("permission diagnostics are sanitized and sent after the run receipt", async () => {
  let permissionResolved = false;
  const h = createPromiseHarness({
    permissions: {
      async getAll() {
        permissionResolved = true;
        return {
          origins: [
            " https://archiveofourown.org/* ",
            "https://archiveofourown.org/*",
            42,
            "https://www.fanfiction.net/*",
          ],
        };
      },
    },
    clock: {
      now: (() => {
        let value = 10_000;
        return () => value++;
      })(),
    },
  });

  assert.deepEqual(
    await h.controller.handle({ type: "TRACE_ARCHIVE_SEEN" }, ao3Sender),
    { ok: true, receipt: "published" },
  );
  assert.equal(permissionResolved, true);
  await waitUntil(() => h.nativeMessages.length === 2, "permission snapshot was not sent");
  assert.deepEqual(h.nativeMessages, [
    {
      type: "TRACE_IOS_EXTENSION_HEARTBEAT",
      hostKind: "ao3",
      at: 10_000,
    },
    {
      type: "TRACE_IOS_EXTENSION_HEARTBEAT",
      hostKind: "ao3",
      at: 10_001,
      permissionSnapshot: true,
      grantedOrigins: [
        "https://archiveofourown.org/*",
        "https://www.fanfiction.net/*",
      ],
    },
  ]);
});

test("callback-mode Safari adapters publish both receipt messages", async () => {
  const nativeMessages = [];
  let now = 20_000;
  const runtime = {
    onMessage: { addListener() {} },
    sendNativeMessage(message, callback) {
      nativeMessages.push(message);
      callback({ ok: "true" });
    },
  };
  const controller = new ArchiveReadinessRuntimeController({
    runtime,
    permissions: {
      getAll(callback) {
        callback({ origins: ["https://www.fanfiction.net/*"] });
      },
    },
    storageMode: "callback",
    clock: { now: () => now++ },
  });

  assert.deepEqual(
    await controller.handle(
      { type: "TRACE_ARCHIVE_SEEN", handoffId: "callback_handoff" },
      {
        tab: { url: "https://www.fanfiction.net/s/123/1/Story" },
        frameId: 0,
      },
    ),
    { ok: true, receipt: "published" },
  );
  await waitUntil(() => nativeMessages.length === 2, "callback snapshot was not sent");
  assert.deepEqual(nativeMessages, [
    {
      type: "TRACE_IOS_EXTENSION_HEARTBEAT",
      hostKind: "ffn",
      at: 20_000,
      handoffId: "callback_handoff",
    },
    {
      type: "TRACE_IOS_EXTENSION_HEARTBEAT",
      hostKind: "ffn",
      at: 20_001,
      permissionSnapshot: true,
      grantedOrigins: ["https://www.fanfiction.net/*"],
    },
  ]);
});

test("native messaging falls back to the application-id signature", async () => {
  const calls = [];
  const runtime = {
    onMessage: { addListener() {} },
    async sendNativeMessage(...args) {
      calls.push(args);
      if (args.length === 1) throw new Error("application id required");
      return { ok: true };
    },
  };
  const controller = new ArchiveReadinessRuntimeController({
    runtime,
    storageMode: "promise",
    clock: { now: () => 30_000 },
  });

  assert.deepEqual(
    await controller.handle({ type: "TRACE_ARCHIVE_SEEN" }, ao3Sender),
    { ok: true, receipt: "published" },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "com.tracefiction.trace");
  assert.equal(calls[1][1].type, "TRACE_IOS_EXTENSION_HEARTBEAT");
});

test("the installed listener keeps a cold worker alive only for the core receipt", async () => {
  const native = deferred();
  const permissions = deferred();
  const listeners = [];
  const nativeMessages = [];
  const runtime = {
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
    async sendNativeMessage(message) {
      nativeMessages.push(message);
      if (message.permissionSnapshot === true) return { ok: true };
      return native.promise;
    },
  };
  installArchiveReadinessRuntime({
    runtime,
    permissions: { getAll: () => permissions.promise },
    storageMode: "promise",
  });

  let response = null;
  const keepsWorkerAlive = listeners[0](
    { type: "TRACE_ARCHIVE_SEEN" },
    ao3Sender,
    (value) => {
      response = value;
    },
  );
  assert.equal(keepsWorkerAlive, true);
  assert.equal(response, null);
  assert.equal(nativeMessages.length, 1);

  native.resolve({ ok: true });
  await waitUntil(() => response !== null, "run receipt response was not delivered");
  assert.deepEqual(response, { ok: true, receipt: "published" });
  assert.equal(nativeMessages.length, 1);

  permissions.resolve({ origins: ["https://archiveofourown.org/*"] });
  await waitUntil(() => nativeMessages.length === 2, "diagnostic snapshot was not delivered");
});


test("each story heartbeat refreshes preference without delaying run receipt or claiming a save", async () => {
  const pending = deferred();
  let publications = 0;
  const h = createPromiseHarness({ publishTrackingPreference: () => { publications++; return pending.promise; } });
  const result = h.controller.handle({ type: "TRACE_ARCHIVE_SEEN" }, ao3Sender);
  await waitUntil(() => h.nativeMessages.length === 1, "run receipt must not wait for preferences");
  assert.equal(h.nativeMessages[0].action, undefined);
  assert.equal(publications, 1);
  pending.resolve();
  await result;
  await h.controller.handle({ type: "TRACE_ARCHIVE_SEEN" }, ao3Sender);
  assert.equal(publications, 2, "Even a throttled run refreshes current preference evidence");
});

const REQUIRED_ORIGINS = [
  "https://*.archiveofourown.org/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
];
const popupSender = { id: "trace-extension", url: "safari-web-extension://trace/popup.html" };

/**
 * The background as Safari on iPhone runs it. `granted` is what Safari
 * currently allows; changing it is the reader allowing access or a one-day
 * grant running out.
 */
function createAccessReportHarness(options = {}) {
  let now = options.now ?? 50_000_000;
  let granted = options.granted ?? [...REQUIRED_ORIGINS];
  const nativeMessages = [];
  const messageListeners = [];
  const alarmListeners = [];
  const addedListeners = [];
  const removedListeners = [];
  const createdAlarms = [];
  const stored = { ...(options.stored ?? {}) };
  const runtime = {
    id: "trace-extension",
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    async getPlatformInfo() {
      return { os: options.os ?? "ios" };
    },
    ...(options.withoutNativeMessaging ? {} : {
      async sendNativeMessage(...args) {
        nativeMessages.push(args.find((value) => value && typeof value === "object"));
        return options.nativeResponse ?? { ok: true };
      },
    }),
  };
  const permissions = {
    async getAll() {
      return { origins: [...granted] };
    },
    async contains({ origins }) {
      if (options.containsUnavailable) throw new Error("no answer");
      return granted.includes("*://*/*") || origins.every((origin) => granted.includes(origin));
    },
    onAdded: { addListener: (listener) => addedListeners.push(listener) },
    onRemoved: { addListener: (listener) => removedListeners.push(listener) },
  };
  const alarms = {
    async clear() {},
    async get(name) {
      return options.existingAlarm ? { name, periodInMinutes: 1440 } : undefined;
    },
    create(name, info) {
      createdAlarms.push({ name, info });
    },
    onAlarm: { addListener: (listener) => alarmListeners.push(listener) },
  };
  const storageArea = {
    async get(key) {
      return key in stored ? { [key]: stored[key] } : {};
    },
    async set(patch) {
      Object.assign(stored, patch);
    },
    async remove() {},
  };
  const controller = new ArchiveReadinessRuntimeController({
    runtime,
    permissions,
    storageMode: "promise",
    clock: { now: () => now },
    requiredOrigins: REQUIRED_ORIGINS,
    accessConfirmWait: async () => {},
  });
  const access = installArchiveAccessReport(controller, {
    runtime,
    permissions,
    alarms,
    storage: new BrowserStorage(storageArea, runtime, "promise"),
    storageMode: "promise",
    clock: { now: () => now },
  });
  const snapshots = () => nativeMessages.filter((message) => message.permissionSnapshot === true);
  const sendFromPopup = (message, sender = popupSender) => new Promise((resolve) => {
    let handled = false;
    for (const listener of messageListeners) {
      if (listener(message, sender, resolve) === true) handled = true;
    }
    if (!handled) setImmediate(() => resolve(undefined));
  });
  return {
    access, alarmListeners, addedListeners, removedListeners, createdAlarms, stored, snapshots,
    sendFromPopup,
    setGranted(value) { granted = value; },
    setNow(value) { now = value; },
  };
}

async function settleAccess() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("an opening popup has the current story-site access sent to the Trace app", async () => {
  const h = createAccessReportHarness({
    granted: ["*://*/*"],
    stored: { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 - 60_000 },
  });
  await settleAccess();
  assert.deepEqual(h.snapshots(), [], "a recent reading is not repeated just because the background started");

  h.setNow(50_000_500);
  assert.deepEqual(
    await h.sendFromPopup({ type: "TRACE_ARCHIVE_ACCESS_REPORT" }),
    { ok: true, report: "published" },
  );
  // The existing native message and fields; no page, account or story data.
  assert.deepEqual(h.snapshots(), [{
    type: "TRACE_IOS_EXTENSION_HEARTBEAT",
    at: 50_000_500,
    permissionSnapshot: true,
    grantedOrigins: [...REQUIRED_ORIGINS, "*://*/*"],
  }]);
  assert.equal(h.stored[ARCHIVE_ACCESS_REPORTED_AT_KEY], 50_000_500);
});

test("a one-day grant that has run out is reported the next time anything looks", async () => {
  const h = createAccessReportHarness({
    stored: { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 - 60_000 },
  });
  await settleAccess();

  // Safari ends the grant. No page script runs any more to say so.
  h.setGranted(["https://www.tracefiction.com/*"]);
  h.setNow(50_000_000 + 24 * 60 * 60 * 1_000);
  for (const listener of h.removedListeners) listener();
  await settleAccess();
  assert.deepEqual(h.snapshots().at(-1), {
    type: "TRACE_IOS_EXTENSION_HEARTBEAT",
    at: 50_000_000 + 24 * 60 * 60 * 1_000,
    permissionSnapshot: true,
    grantedOrigins: ["https://www.tracefiction.com/*"],
  });

  // Allowing again is reported too, so the app can stop warning.
  h.setGranted([...REQUIRED_ORIGINS]);
  for (const listener of h.addedListeners) listener();
  await settleAccess();
  assert.deepEqual(h.snapshots().at(-1).grantedOrigins, REQUIRED_ORIGINS);
});

test("the daily alarm takes a reading and is not pushed back by a background restart", async () => {
  const fresh = createAccessReportHarness({
    stored: { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 - 60_000 },
  });
  await settleAccess();
  assert.deepEqual(fresh.createdAlarms, [{
    name: "traceArchiveAccessReport",
    info: { periodInMinutes: 24 * 60 },
  }]);
  for (const listener of fresh.alarmListeners) listener({ name: "traceAo3SavedFiltersSync" });
  await settleAccess();
  assert.equal(fresh.snapshots().length, 0, "another alarm is not a reason to report");
  for (const listener of fresh.alarmListeners) listener({ name: "traceArchiveAccessReport" });
  await settleAccess();
  assert.equal(fresh.snapshots().length, 1);

  const restarted = createAccessReportHarness({
    existingAlarm: true,
    stored: { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 - 60_000 },
  });
  await settleAccess();
  assert.deepEqual(restarted.createdAlarms, []);
});

test("a background that starts with no recent reading takes one", async () => {
  for (const stored of [
    {},
    { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 - ARCHIVE_ACCESS_REPORT_STALE_MS },
    { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 + 60_000 },
    { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: "yesterday" },
  ]) {
    const h = createAccessReportHarness({ stored });
    await settleAccess();
    assert.equal(h.snapshots().length, 1, JSON.stringify(stored));
    assert.equal(h.stored[ARCHIVE_ACCESS_REPORTED_AT_KEY], 50_000_000);
  }
});

test("only the extension's own popup can ask for an access reading", async () => {
  const h = createAccessReportHarness({
    stored: { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 - 60_000 },
  });
  await settleAccess();
  for (const [message, sender] of [
    [{ type: "TRACE_ARCHIVE_ACCESS_REPORT" }, ao3Sender],
    [{ type: "TRACE_ARCHIVE_ACCESS_REPORT" }, { id: "another-extension" }],
    [{ type: "TRACE_ARCHIVE_ACCESS_REPORT", grantedOrigins: ["*://*/*"] }, popupSender],
  ]) {
    assert.deepEqual(await h.sendFromPopup(message, sender), { ok: false });
  }
  assert.equal(await h.sendFromPopup({ type: "TRACE_SOMETHING_ELSE" }), undefined);
  assert.deepEqual(h.snapshots(), []);
});

test("an access reading is never sent when it would not be true or has nowhere to go", async () => {
  // Safari did not answer: missing access must not be inferred from silence.
  const unanswered = createAccessReportHarness({ containsUnavailable: true, granted: [] });
  await settleAccess();
  assert.deepEqual(await unanswered.access.report(), { kind: "unknown" });
  assert.deepEqual(unanswered.snapshots(), []);
  assert.equal(ARCHIVE_ACCESS_REPORTED_AT_KEY in unanswered.stored, false);

  // Other browsers have no Trace app beside them.
  for (const options of [{ os: "mac" }, { withoutNativeMessaging: true }]) {
    const h = createAccessReportHarness({ ...options, granted: [] });
    await settleAccess();
    assert.deepEqual(await h.access.report(), { kind: "unknown" });
    assert.deepEqual(h.snapshots(), []);
  }

  // A reading the app did not take is not recorded as delivered.
  const undelivered = createAccessReportHarness({ nativeResponse: { ok: false } });
  await settleAccess();
  assert.deepEqual(await undelivered.access.report(), { kind: "unavailable" });
  assert.equal(ARCHIVE_ACCESS_REPORTED_AT_KEY in undelivered.stored, false);
});
