const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const SYNC_JS_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "sync.js",
);

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function plainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSyncHarness(
  origin = "https://tracefiction.com",
  { sendMessageImpl } = {},
) {
  const js = fs.readFileSync(SYNC_JS_PATH, "utf8");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: origin,
    runScripts: "outside-only",
    contentType: "text/html",
  });
  const messages = [];
  const postedMessages = [];
  const consoleErrors = [];
  const originalPostMessage = dom.window.postMessage.bind(dom.window);
  dom.window.postMessage = (data, targetOrigin, transfer) => {
    postedMessages.push({ data, targetOrigin });
    return originalPostMessage(data, targetOrigin, transfer);
  };
  let onRuntimeMessage = null;
  const context = {
    console: {
      ...console,
      error(...args) {
        consoleErrors.push(args);
      },
    },
    window: dom.window,
    document: dom.window.document,
    self: dom.window,
    chrome: {
      runtime: {
        sendMessage(message) {
          if (sendMessageImpl) return sendMessageImpl(message);
          messages.push(message);
        },
        onMessage: {
          addListener(fn) {
            onRuntimeMessage = fn;
          },
        },
      },
    },
    browser: undefined,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(js, context);
  return {
    window: dom.window,
    messages,
    postedMessages,
    consoleErrors,
    emitRuntimeMessage(message, sender = {}, sendResponse = () => {}) {
      onRuntimeMessage?.(message, sender, sendResponse);
    },
  };
}

test("sync forwards same-origin TRACE_FICTION_TOKEN messages to background", async () => {
  const h = createSyncHarness();
  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_FICTION_TOKEN", token: "abc123" },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(plainJson(h.messages), [
    { type: "TRACE_AUTH_UPDATE", token: "abc123" },
  ]);
});

test("sync ignores unrelated or cross-origin messages", () => {
  const h = createSyncHarness();
  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_FICTION_TOKEN", token: "abc123" },
      origin: "https://evil.example",
      source: h.window,
    }),
  );
  h.window.postMessage({ type: "OTHER_EVENT", token: "abc123" }, "https://tracefiction.com");

  assert.deepEqual(h.messages, []);
});

test("sync suppresses transient Safari stale-tab sendMessage errors", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl() {
      throw new Error("Invalid call to runtime.sendMessage(). Tab not found.");
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_FICTION_TOKEN", token: "abc123" },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(h.consoleErrors, []);
});

test("sync suppresses transient async runtime sendMessage rejections", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl() {
      return Promise.reject(new Error("Extension context invalidated."));
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_FICTION_TOKEN", token: "abc123" },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(h.consoleErrors, []);
});

test("sync still reports unexpected runtime sendMessage failures", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl() {
      throw new Error("permission denied");
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_FICTION_TOKEN", token: "abc123" },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.equal(h.consoleErrors.length, 1);
  assert.equal(h.consoleErrors[0][0], "[Trace Sync] Failed to update auth state");
  assert.match(h.consoleErrors[0][1].message, /permission denied/);
});

test("sync forwards library invalidation runtime messages into the page", async () => {
  const h = createSyncHarness();

  h.emitRuntimeMessage({
    type: "TRACE_LIBRARY_INVALIDATED",
    reason: "quick_add",
    at: "2026-04-11T15:00:00.000Z",
  });
  await flush();

  assert.deepEqual(plainJson(h.postedMessages), [
    {
      data: {
        type: "TRACE_LIBRARY_INVALIDATED",
        reason: "quick_add",
        at: "2026-04-11T15:00:00.000Z",
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);
});
