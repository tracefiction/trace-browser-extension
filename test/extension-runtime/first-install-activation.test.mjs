import assert from "node:assert/strict";
import test from "node:test";

import {
  installTraceFirstInstallActivation,
} from "../../.trace-build/extension-runtime/trace-web-navigation.mjs";

async function flush() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Promise.resolve();
  }
}

function promiseRuntime(platform = "mac") {
  const listeners = [];
  return {
    listeners,
    runtime: {
      onInstalled: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: platform };
      },
    },
  };
}

test("first browser install reuses an exact-origin Trace tab", async () => {
  const h = promiseRuntime();
  const updates = [];
  const creates = [];
  installTraceFirstInstallActivation({
    runtime: h.runtime,
    tabs: {
      async query(query) {
        assert.deepEqual(query, { url: ["https://www.tracefiction.com/*"] });
        return [
          { id: 4, url: "https://www.tracefiction.com.evil.example/" },
          { id: 7, url: "https://www.tracefiction.com/library" },
        ];
      },
      async update(tabId, options) {
        updates.push({ tabId, options });
        return { id: tabId, url: options.url };
      },
      async create(options) {
        creates.push(options);
        return { id: 9, url: options.url };
      },
      async sendMessage() {},
    },
    mode: "promise",
    webOrigin: "https://www.tracefiction.com",
  });

  assert.equal(h.listeners.length, 1);
  h.listeners[0]({ reason: "install" });
  await flush();

  assert.deepEqual(updates, [{
    tabId: 7,
    options: {
      url: "https://www.tracefiction.com/?activation=extension-installed",
      active: true,
    },
  }]);
  assert.deepEqual(creates, []);
});

test("Chrome callback mode opens a fresh activation tab only on install", async () => {
  const listeners = [];
  const creates = [];
  const runtime = {
    onInstalled: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
    onMessage: { addListener() {} },
    getPlatformInfo(callback) {
      callback({ os: "win" });
    },
  };
  installTraceFirstInstallActivation({
    runtime,
    tabs: {
      query(_query, callback) {
        callback([]);
      },
      create(options, callback) {
        creates.push(options);
        callback({ id: 12, url: options.url });
      },
      sendMessage() {},
    },
    mode: "callback",
    webOrigin: "https://www.tracefiction.com",
  });

  listeners[0]({ reason: "update" });
  await flush();
  assert.deepEqual(creates, []);

  listeners[0]({ reason: "install" });
  await flush();
  assert.deepEqual(creates, [{
    url: "https://www.tracefiction.com/?activation=extension-installed",
    active: true,
  }]);
});

test("iOS keeps first-install onboarding app-led", async () => {
  const h = promiseRuntime("ios");
  let tabCalls = 0;
  installTraceFirstInstallActivation({
    runtime: h.runtime,
    tabs: {
      async query() {
        tabCalls += 1;
        return [];
      },
      async create() {
        tabCalls += 1;
      },
      async sendMessage() {},
    },
    mode: "promise",
    webOrigin: "https://www.tracefiction.com",
  });

  h.listeners[0]({ reason: "install" });
  await flush();
  assert.equal(tabCalls, 0);
});

test("a failed tab query falls back to a fresh activation tab", async () => {
  const h = promiseRuntime();
  const creates = [];
  installTraceFirstInstallActivation({
    runtime: h.runtime,
    tabs: {
      async query() {
        throw new Error("tabs unavailable");
      },
      async create(options) {
        creates.push(options);
        return { id: 2, url: options.url };
      },
      async sendMessage() {},
    },
    mode: "promise",
    webOrigin: "https://www.tracefiction.com",
  });

  h.listeners[0]({ reason: "install" });
  await flush();
  assert.equal(creates.length, 1);
});
