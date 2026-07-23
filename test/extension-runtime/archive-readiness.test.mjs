import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveReadinessRuntimeController,
  installArchiveReadinessRuntime,
} from "../../.trace-build/extension-runtime/archive-readiness.mjs";
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
