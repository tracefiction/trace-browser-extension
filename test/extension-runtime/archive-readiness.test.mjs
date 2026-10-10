import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_ACCESS_REPORTED_AT_KEY,
  ARCHIVE_ACCESS_REPORT_STALE_MS,
  ARCHIVE_ACCESS_STATE_KEY,
  ArchiveReadinessRuntimeController,
  BrowserArchiveAccessLedger,
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
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
// Safari on a Mac, and Safari on an iPad asking for desktop sites, both say this.
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DAY_MS = 24 * 60 * 60 * 1_000;
// A reading reached the app a minute ago, so a start alone takes no new one.
const DELIVERED_RECENTLY = { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: 50_000_000 - 60_000 };
// The same, for an install that has held the grant.
const GRANT_SEEN = { ...DELIVERED_RECENTLY, [ARCHIVE_ACCESS_STATE_KEY]: { grantSeen: true } };

/**
 * The background as Safari runs it. `granted` is what Safari currently
 * allows; changing it is the reader allowing access or a one-day grant
 * running out. `os` is what Safari reports the platform to be.
 */
function createAccessReportHarness(options = {}) {
  let now = options.now ?? 50_000_000;
  let granted = options.granted ?? [...REQUIRED_ORIGINS];
  let nativeResponse = options.nativeResponse ?? { ok: true };
  const os = options.os ?? "ios";
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
      return { os };
    },
    ...(options.withoutNativeMessaging ? {} : {
      async sendNativeMessage(...args) {
        nativeMessages.push(args.find((value) => value && typeof value === "object"));
        return nativeResponse;
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
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in stored).map((key) => [key, stored[key]]));
    },
    async set(patch) {
      Object.assign(stored, patch);
    },
    async remove() {},
  };
  const accessLedger = new BrowserArchiveAccessLedger(new BrowserStorage(storageArea, runtime, "promise"));
  const controller = new ArchiveReadinessRuntimeController({
    runtime,
    permissions,
    storageMode: "promise",
    clock: { now: () => now },
    requiredOrigins: REQUIRED_ORIGINS,
    accessConfirmWait: async () => {},
    accessLedger,
  });
  const access = installArchiveAccessReport(controller, {
    runtime,
    permissions,
    alarms,
    accessLedger,
    storageMode: "promise",
    clock: { now: () => now },
    platform: { userAgent: options.userAgent ?? (os === "ios" ? IPHONE_UA : MAC_UA) },
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
    access, messageListeners, alarmListeners, addedListeners, removedListeners, createdAlarms, stored, snapshots,
    sendFromPopup,
    setGranted(value) { granted = value; },
    setNow(value) { now = value; },
    setNativeResponse(value) { nativeResponse = value; },
  };
}

async function settleAccess() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const OPEN_POPUP = { type: "TRACE_ARCHIVE_ACCESS_REPORT" };

test("an opening popup has the current story-site access sent to the Trace app", async () => {
  const h = createAccessReportHarness({ granted: ["*://*/*"], stored: DELIVERED_RECENTLY });
  await settleAccess();
  assert.deepEqual(h.snapshots(), [], "a recent reading is not repeated just because the background started");

  h.setNow(50_000_500);
  assert.deepEqual(await h.sendFromPopup(OPEN_POPUP), { ok: true, report: "published" });
  // The existing native message and fields; no page, account or story data.
  assert.deepEqual(h.snapshots(), [{
    type: "TRACE_IOS_EXTENSION_HEARTBEAT",
    at: 50_000_500,
    permissionSnapshot: true,
    grantedOrigins: [...REQUIRED_ORIGINS, "*://*/*"],
  }]);
  assert.equal(h.stored[ARCHIVE_ACCESS_REPORTED_AT_KEY], 50_000_500);
  assert.equal(h.stored[ARCHIVE_ACCESS_STATE_KEY].grantSeen, true);
  assert.deepEqual(Object.keys(h.stored[ARCHIVE_ACCESS_STATE_KEY]).sort(), ["delivered", "grantSeen"],
    "what is kept: that a grant was seen, and a fingerprint of the reading");
});

test("opening the popup again and again sends one reading, not one each time", async () => {
  const h = createAccessReportHarness({ stored: DELIVERED_RECENTLY });
  await settleAccess();
  const replies = [];
  for (let open = 0; open < 5; open += 1) {
    h.setNow(50_000_000 + open * 20_000);
    replies.push((await h.sendFromPopup(OPEN_POPUP)).report);
  }
  assert.deepEqual(replies, ["published", "current", "current", "current", "current"]);
  assert.equal(h.snapshots().length, 1);

  // A burst of permission events is one reading too.
  for (let event = 0; event < 10; event += 1) for (const listener of h.addedListeners) listener();
  await settleAccess();
  assert.equal(h.snapshots().length, 1);

  // Once it is no longer recent, or access has changed, it is sent again.
  h.setNow(50_000_000 + 6 * 60_000);
  assert.deepEqual(await h.sendFromPopup(OPEN_POPUP), { ok: true, report: "published" });
  h.setGranted([...REQUIRED_ORIGINS, "*://*/*"]);
  assert.deepEqual(await h.sendFromPopup(OPEN_POPUP), { ok: true, report: "published" });
  assert.equal(h.snapshots().length, 3);
});

test("a background that has never seen the grant reports nothing, however often it looks", async () => {
  // First start after install: no reading yet, no access yet.
  const first = createAccessReportHarness({ granted: [] });
  await settleAccess();
  assert.deepEqual(first.snapshots(), []);
  assert.deepEqual(first.stored, {}, "and it records nothing");
  assert.deepEqual(await first.sendFromPopup(OPEN_POPUP), { ok: true, report: "withheld" });

  // Part-way through setup: one site allowed, or sites listed another way.
  for (const granted of [
    ["https://*.archiveofourown.org/*"],
    ["*://*.archiveofourown.org/*", "*://*.fanfiction.net/*"],
    ["https://www.tracefiction.com/*"],
  ]) {
    const h = createAccessReportHarness({ granted, stored: DELIVERED_RECENTLY });
    await settleAccess();
    for (const listener of h.addedListeners) listener();
    for (const listener of h.alarmListeners) listener({ name: "traceArchiveAccessReport" });
    await settleAccess();
    assert.deepEqual(await h.sendFromPopup(OPEN_POPUP), { ok: true, report: "withheld" });
    assert.deepEqual(h.snapshots(), [], JSON.stringify(granted));
  }

  // The moment the grant is complete, that is reported and remembered.
  first.setGranted([...REQUIRED_ORIGINS]);
  for (const listener of first.addedListeners) listener();
  await settleAccess();
  assert.deepEqual(first.snapshots().map(({ grantedOrigins }) => grantedOrigins), [REQUIRED_ORIGINS]);
  assert.equal(first.stored[ARCHIVE_ACCESS_STATE_KEY].grantSeen, true);
});

test("a one-day grant that has run out is reported the next time anything looks", async () => {
  const h = createAccessReportHarness({ stored: GRANT_SEEN });
  await settleAccess();
  assert.deepEqual(h.snapshots(), []);

  // Safari ends the grant. No page script runs any more to say so.
  h.setGranted(["https://www.tracefiction.com/*"]);
  h.setNow(50_000_000 + DAY_MS);
  for (const listener of h.removedListeners) listener();
  await settleAccess();
  assert.deepEqual(h.snapshots(), [{
    type: "TRACE_IOS_EXTENSION_HEARTBEAT",
    at: 50_000_000 + DAY_MS,
    permissionSnapshot: true,
    grantedOrigins: ["https://www.tracefiction.com/*"],
  }]);

  // Allowing again is reported too, so the app can stop warning.
  h.setGranted([...REQUIRED_ORIGINS]);
  for (const listener of h.addedListeners) listener();
  await settleAccess();
  assert.deepEqual(h.snapshots().at(-1).grantedOrigins, REQUIRED_ORIGINS);
});

test("the daily alarm takes a reading and is not pushed back by a background restart", async () => {
  const fresh = createAccessReportHarness({ stored: DELIVERED_RECENTLY });
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

  const restarted = createAccessReportHarness({ existingAlarm: true, stored: DELIVERED_RECENTLY });
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
  const h = createAccessReportHarness({ stored: DELIVERED_RECENTLY });
  await settleAccess();
  for (const [message, sender] of [
    [OPEN_POPUP, ao3Sender],
    [OPEN_POPUP, { id: "another-extension" }],
    [{ ...OPEN_POPUP, grantedOrigins: ["*://*/*"] }, popupSender],
  ]) {
    assert.deepEqual(await h.sendFromPopup(message, sender), { ok: false });
  }
  assert.equal(await h.sendFromPopup({ type: "TRACE_SOMETHING_ELSE" }), undefined);
  assert.deepEqual(h.snapshots(), []);
});

test("an access reading is never sent when Safari did not answer", async () => {
  // Missing access must not be inferred from silence, even after a grant.
  const h = createAccessReportHarness({ containsUnavailable: true, granted: [], stored: GRANT_SEEN });
  await settleAccess();
  assert.deepEqual(await h.access.report(), { kind: "unknown" });
  assert.deepEqual(await h.sendFromPopup(OPEN_POPUP), { ok: true, report: "unknown" });
  assert.deepEqual(h.snapshots(), []);
});

test("a delivery the app does not take is left alone by the background, but not by an open popup", async () => {
  const h = createAccessReportHarness({ nativeResponse: { ok: false, error: "shared_storage_unavailable" } });
  await settleAccess();
  assert.equal(h.snapshots().length, 1, "the overdue reading at start");
  assert.equal(ARCHIVE_ACCESS_REPORTED_AT_KEY in h.stored, false, "it is not recorded as delivered");

  // Restarts, alarms and permission events in the next minute do not hammer the app.
  const restarted = createAccessReportHarness({ nativeResponse: { ok: false }, stored: h.stored });
  await settleAccess();
  for (const listener of h.alarmListeners) listener({ name: "traceArchiveAccessReport" });
  for (const listener of h.removedListeners) listener();
  await settleAccess();
  assert.equal(h.snapshots().length + restarted.snapshots().length, 1);

  // The reader opens the popup: that is worth one try, back-off or not.
  assert.deepEqual(await h.sendFromPopup(OPEN_POPUP), { ok: true, report: "unavailable" });
  assert.equal(h.snapshots().length, 2);
  h.setNativeResponse({ ok: true });
  assert.deepEqual(await h.sendFromPopup(OPEN_POPUP), { ok: true, report: "published" });
  assert.equal(h.stored[ARCHIVE_ACCESS_REPORTED_AT_KEY], 50_000_000);
  assert.equal("failures" in h.stored[ARCHIVE_ACCESS_STATE_KEY], false);
  assert.equal("retryAt" in h.stored[ARCHIVE_ACCESS_STATE_KEY], false);
});

test("Safari on a Mac sends nothing and holds no alarm", async () => {
  const mac = createAccessReportHarness({ os: "mac", granted: [], stored: GRANT_SEEN });
  await settleAccess();
  // It cannot be told from an iPad until Safari answers, so its listeners
  // exist; every one of them then does nothing.
  for (const listener of mac.alarmListeners) listener({ name: "traceArchiveAccessReport" });
  for (const listener of mac.removedListeners) listener();
  for (const listener of mac.addedListeners) listener();
  await settleAccess();
  assert.deepEqual(await mac.sendFromPopup(OPEN_POPUP), { ok: true, report: "unknown" });
  assert.deepEqual(await mac.access.report(), { kind: "unknown" });
  assert.deepEqual(mac.createdAlarms, []);
  assert.deepEqual(mac.snapshots(), []);
  assert.deepEqual(mac.stored, GRANT_SEEN, "and records nothing");

  // A browser with no Trace app beside it, or one that is plainly not Apple's, installs nothing at all.
  for (const options of [{ withoutNativeMessaging: true }, { os: "mac", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" }]) {
    const h = createAccessReportHarness({ ...options, granted: [], stored: GRANT_SEEN });
    await settleAccess();
    assert.deepEqual(
      [h.messageListeners.length, h.alarmListeners.length, h.addedListeners.length, h.removedListeners.length],
      [0, 0, 0, 0],
      JSON.stringify(options),
    );
    assert.deepEqual(h.createdAlarms, []);
    assert.equal(await h.sendFromPopup(OPEN_POPUP), undefined, "the message has no handler here");
    assert.deepEqual(await h.access.report(), { kind: "unknown" });
    assert.deepEqual(h.snapshots(), []);
  }
});

test("an iPad that calls itself a Mac hears the event that woke the background", async () => {
  const listeners = (h) =>
    [h.messageListeners.length, h.alarmListeners.length, h.addedListeners.length, h.removedListeners.length];
  const iphone = createAccessReportHarness({ stored: DELIVERED_RECENTLY });
  const ipad = createAccessReportHarness({ os: "ios", userAgent: MAC_UA, stored: GRANT_SEEN });
  // Before anything asynchronous has run: an event that woke the background
  // is delivered only to listeners that exist in its first turn.
  assert.deepEqual(listeners(iphone), [1, 1, 1, 1]);
  assert.deepEqual(listeners(ipad), [1, 1, 1, 1]);
  assert.deepEqual(ipad.createdAlarms, [], "the alarm waits until Safari says what this is");

  // Safari wakes the iPad's background because access was removed. The
  // listener is already there; the reading goes out once the platform is known.
  ipad.setGranted(["https://www.tracefiction.com/*"]);
  for (const listener of ipad.removedListeners) listener();
  await settleAccess();
  assert.deepEqual(ipad.snapshots().map(({ grantedOrigins }) => grantedOrigins), [["https://www.tracefiction.com/*"]]);
  assert.equal(ipad.createdAlarms.length, 1);
  assert.deepEqual(await ipad.sendFromPopup(OPEN_POPUP), { ok: true, report: "current" });
});
