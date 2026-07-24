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

function tokenRequestMessages(h) {
  return plainJson(
    h.postedMessages.filter(
      (item) => item?.data?.type === "TRACE_FICTION_TOKEN_REQUEST",
    ),
  );
}

function nonTokenRequestMessages(h) {
  return plainJson(
    h.postedMessages.filter(
      (item) =>
        item?.data?.type !== "TRACE_FICTION_TOKEN_REQUEST" &&
        item?.data?.type !== "TRACE_EXTENSION_STATUS_READY",
    ),
  );
}

function statusReadyMessages(h) {
  return plainJson(
    h.postedMessages.filter(
      (item) => item?.data?.type === "TRACE_EXTENSION_STATUS_READY",
    ),
  );
}

function createSyncHarness(
  origin = "https://tracefiction.com",
  { sendMessageImpl, sessionMode = "legacy" } = {},
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
        sendMessage(message, callback) {
          messages.push(message);
          if (sendMessageImpl) return sendMessageImpl(message, callback);
          if (typeof callback === "function") callback(undefined);
        },
        onMessage: {
          addListener(fn) {
            onRuntimeMessage = fn;
          },
        },
      },
    },
    browser: undefined,
    TRACE_SESSION_MODE: sessionMode,
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
      return onRuntimeMessage?.(message, sender, sendResponse);
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

test("sync requests a Trace token when ready and on page lifecycle events", async () => {
  const h = createSyncHarness();

  const grantRequests = tokenRequestMessages(h);
  assert.deepEqual(grantRequests, [
    {
      data: {
        type: "TRACE_FICTION_TOKEN_REQUEST",
        reason: "sync_ready",
        at: grantRequests[0].data.at,
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);

  h.postedMessages.length = 0;
  h.window.dispatchEvent(new h.window.Event("pageshow"));
  await flush();

  assert.deepEqual(tokenRequestMessages(h), [
    {
      data: {
        type: "TRACE_FICTION_TOKEN_REQUEST",
        reason: "pageshow",
        at: h.postedMessages[0].data.at,
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);
});

test("kernel sync accepts only a correlated explicit credential grant", async () => {
  const h = createSyncHarness("https://tracefiction.com", { sessionMode: "kernel" });
  assert.deepEqual(tokenRequestMessages(h), []);
  const responses = [];

  assert.equal(
    h.emitRuntimeMessage(
      {
        type: "TRACE_CREDENTIAL_GRANT_REQUEST",
        protocolVersion: 1,
        requestId: "grant-1",
        purpose: "connect",
      },
      {},
      (response) => responses.push(response),
    ),
    true,
  );
  const explicitRequests = tokenRequestMessages(h);
  assert.deepEqual(explicitRequests, [
    {
      data: {
        type: "TRACE_FICTION_TOKEN_REQUEST",
        reason: "credential_grant",
        at: explicitRequests[0].data.at,
        protocolVersion: 1,
        requestId: "grant-1",
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: {
        type: "TRACE_FICTION_TOKEN",
        token: "wrong-token",
        protocolVersion: 1,
        requestId: "other-grant",
      },
      origin: "https://tracefiction.com",
    }),
  );
  assert.deepEqual(responses, []);
  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: {
        type: "TRACE_FICTION_TOKEN",
        token: "current-token",
        protocolVersion: 1,
        requestId: "grant-1",
      },
      origin: "https://tracefiction.com",
    }),
  );
  assert.deepEqual(plainJson(responses), [
    { ok: true, requestId: "grant-1", token: "current-token" },
  ]);
  assert.deepEqual(h.messages, []);
});

test("kernel sync ignores ambient token and lifecycle pushes", async () => {
  const h = createSyncHarness("https://tracefiction.com", { sessionMode: "kernel" });
  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_FICTION_TOKEN", token: "ambient-token" },
      origin: "https://tracefiction.com",
    }),
  );
  h.window.dispatchEvent(new h.window.Event("pageshow"));
  await flush();
  assert.deepEqual(h.messages, []);
  assert.deepEqual(tokenRequestMessages(h), []);
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

test("sync answers same-origin extension status requests with sanitized state", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl(message, callback) {
      callback?.({
        installed: true,
        connected: true,
        authState: "connected",
        lastTokenSyncAt: Date.parse("2026-05-01T12:00:00.000Z"),
        firstSaveSeen: true,
        browserKind: "chrome",
        capabilities: { firstStoryAdd: true },
        lastArchiveSeenAt: Date.parse("2026-05-01T12:01:00.987Z"),
        lastArchiveHostKind: "ao3",
        lastArchiveActionAt: Date.parse("2026-05-01T12:02:00.987Z"),
        lastArchiveActionKind: "quick_add",
        lastArchiveErrorKind: "permission",
        authToken: "token-should-not-leak",
        userId: "user-should-not-leak",
        url: "https://archiveofourown.org/works/1",
        privateTags: ["private"],
        rating: "private",
        notes: "private note",
        rawError: "raw parser error",
        collectionData: { id: "collection-1" },
        storyData: { title: "should not leak" },
      });
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_EXTENSION_STATUS_REQUEST", nonce: "nonce-1" },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(plainJson(h.messages), [
    { type: "TRACE_EXTENSION_STATUS_QUERY", nonce: "nonce-1" },
  ]);
  assert.deepEqual(nonTokenRequestMessages(h), [
    {
      data: {
        type: "TRACE_EXTENSION_STATUS_RESPONSE",
        nonce: "nonce-1",
        state: {
          installed: true,
          connected: true,
          authState: "connected",
          lastTokenSyncAt: Date.parse("2026-05-01T12:00:00.000Z"),
          firstSaveSeen: true,
          browserKind: "chrome",
          capabilities: { firstStoryAdd: true },
          lastArchiveSeenAt: Date.parse("2026-05-01T12:01:00.987Z"),
          lastArchiveHostKind: "ao3",
          lastArchiveActionAt: Date.parse("2026-05-01T12:02:00.987Z"),
          lastArchiveActionKind: "quick_add",
          lastArchiveErrorKind: "permission",
        },
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);
});

test("sync drops invalid archive readiness values without failing status", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl(message, callback) {
      callback?.({
        installed: true,
        connected: true,
        authState: "connected",
        lastArchiveSeenAt: "2026-05-01T12:01:00.987Z",
        lastArchiveHostKind: "archiveofourown.org",
        lastArchiveActionAt: Number.NaN,
        lastArchiveActionKind: "story_title",
        lastArchiveErrorKind: "raw_selector_failure",
      });
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_EXTENSION_STATUS_REQUEST", nonce: "nonce-invalid" },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(nonTokenRequestMessages(h), [
    {
      data: {
        type: "TRACE_EXTENSION_STATUS_RESPONSE",
        nonce: "nonce-invalid",
        state: {
          installed: true,
          connected: true,
          authState: "connected",
        },
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);
});

test("sync ignores status requests without a non-empty nonce", async () => {
  const h = createSyncHarness();
  for (const nonce of [undefined, "", "   "]) {
    h.window.dispatchEvent(
      new h.window.MessageEvent("message", {
        data: { type: "TRACE_EXTENSION_STATUS_REQUEST", nonce },
        origin: "https://tracefiction.com",
        source: h.window,
      }),
    );
  }
  await flush();

  assert.deepEqual(h.messages, []);
  assert.deepEqual(nonTokenRequestMessages(h), []);
});

test("sync ignores cross-origin status requests", async () => {
  const h = createSyncHarness();
  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_EXTENSION_STATUS_REQUEST", nonce: "nonce-2" },
      origin: "https://evil.example",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(h.messages, []);
  assert.deepEqual(nonTokenRequestMessages(h), []);
});

test("sync forwards first-story add requests and posts sanitized responses", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl(message, callback) {
      callback?.({
        ok: true,
        state: "saved",
        authToken: "token-should-not-leak",
        story: { title: "private" },
      });
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: {
        type: "TRACE_FIRST_STORY_ADD_REQUEST",
        nonce: "first-story-1",
        url: "https://archiveofourown.org/works/123",
      },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(plainJson(h.messages), [
    {
      type: "TRACE_FIRST_STORY_ADD",
      nonce: "first-story-1",
      url: "https://archiveofourown.org/works/123",
    },
  ]);
  assert.deepEqual(nonTokenRequestMessages(h), [
    {
      data: {
        type: "TRACE_FIRST_STORY_ADD_RESPONSE",
        nonce: "first-story-1",
        ok: true,
        state: "saved",
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);
});

test("sync returns sanitized first-story add failures", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl(message, callback) {
      callback?.({
        ok: false,
        error: "invalid_url",
        rawError: "do not leak",
      });
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: {
        type: "TRACE_FIRST_STORY_ADD_REQUEST",
        nonce: "first-story-2",
        url: "https://example.com/works/123",
      },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(plainJson(h.messages), [
    {
      type: "TRACE_FIRST_STORY_ADD",
      nonce: "first-story-2",
      url: "https://example.com/works/123",
    },
  ]);
  assert.deepEqual(nonTokenRequestMessages(h), [
    {
      data: {
        type: "TRACE_FIRST_STORY_ADD_RESPONSE",
        nonce: "first-story-2",
        ok: false,
        error: "invalid_url",
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);
});

test("sync preserves the bounded site-permission failure and hides unknown errors", async () => {
  const responses = [
    { ok: false, error: "permission_required", rawError: "private" },
    { ok: false, error: "internal_stack_trace" },
  ];
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl(_message, callback) {
      callback?.(responses.shift());
    },
  });

  for (const nonce of ["permission-1", "permission-2"]) {
    h.window.dispatchEvent(
      new h.window.MessageEvent("message", {
        data: {
          type: "TRACE_FIRST_STORY_ADD_REQUEST",
          nonce,
          url: "https://archiveofourown.org/works/123",
        },
        origin: "https://tracefiction.com",
        source: h.window,
      }),
    );
    await flush();
  }

  assert.deepEqual(
    nonTokenRequestMessages(h).map((message) => message.data),
    [
      {
        type: "TRACE_FIRST_STORY_ADD_RESPONSE",
        nonce: "permission-1",
        ok: false,
        error: "permission_required",
      },
      {
        type: "TRACE_FIRST_STORY_ADD_RESPONSE",
        nonce: "permission-2",
        ok: false,
        error: "unknown_error",
      },
    ],
  );
});

test("sync ignores first-story add requests without nonce or URL", async () => {
  const h = createSyncHarness();

  for (const data of [
    { type: "TRACE_FIRST_STORY_ADD_REQUEST", nonce: "", url: "https://archiveofourown.org/works/123" },
    { type: "TRACE_FIRST_STORY_ADD_REQUEST", nonce: "first-story-3", url: "" },
  ]) {
    h.window.dispatchEvent(
      new h.window.MessageEvent("message", {
        data,
        origin: "https://tracefiction.com",
        source: h.window,
      }),
    );
  }
  await flush();

  assert.deepEqual(h.messages, []);
  assert.deepEqual(nonTokenRequestMessages(h), []);
});

test("sync returns safe unknown state when background status messaging fails", async () => {
  const h = createSyncHarness("https://tracefiction.com", {
    sendMessageImpl() {
      throw new Error("permission denied");
    },
  });

  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data: { type: "TRACE_EXTENSION_STATUS_REQUEST", nonce: "nonce-3" },
      origin: "https://tracefiction.com",
      source: h.window,
    }),
  );
  await flush();

  assert.deepEqual(plainJson(h.messages), [
    { type: "TRACE_EXTENSION_STATUS_QUERY", nonce: "nonce-3" },
  ]);
  assert.deepEqual(nonTokenRequestMessages(h), [
    {
      data: {
        type: "TRACE_EXTENSION_STATUS_RESPONSE",
        nonce: "nonce-3",
        state: {
          installed: true,
          connected: false,
          authState: "unknown",
        },
      },
      targetOrigin: "https://tracefiction.com",
    },
  ]);
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

  assert.deepEqual(nonTokenRequestMessages(h), [
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

test("sync announces readiness to the page once on load", async () => {
  const h = createSyncHarness();
  await flush();

  const announcements = statusReadyMessages(h);
  assert.equal(announcements.length, 1);
  assert.equal(announcements[0].targetOrigin, "https://tracefiction.com");
  assert.equal(typeof announcements[0].data.at, "number");
});

test("sync forwards status push runtime messages into the page sanitized", async () => {
  const h = createSyncHarness();

  h.emitRuntimeMessage({
    type: "TRACE_EXTENSION_STATUS_PUSH",
    state: {
      installed: true,
      connected: true,
      authState: "connected",
      firstSaveSeen: false,
      browserKind: "chrome",
      capabilities: { firstStoryAdd: true },
      token: "must not reach the page",
    },
    at: "2026-07-11T12:00:00.000Z",
  });
  await flush();

  const forwarded = nonTokenRequestMessages(h);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].targetOrigin, "https://tracefiction.com");
  assert.equal(forwarded[0].data.type, "TRACE_EXTENSION_STATUS_UPDATE");
  assert.deepEqual(forwarded[0].data.state, {
    installed: true,
    connected: true,
    authState: "connected",
    firstSaveSeen: false,
    browserKind: "chrome",
    capabilities: { firstStoryAdd: true },
  });
  assert.equal(typeof forwarded[0].data.at, "number");
});

test("sync forwards malformed status pushes as a safe disconnected state", async () => {
  const h = createSyncHarness();

  h.emitRuntimeMessage({
    type: "TRACE_EXTENSION_STATUS_PUSH",
    state: "garbage",
  });
  await flush();

  const forwarded = nonTokenRequestMessages(h);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].data.state, {
    installed: true,
    connected: false,
    authState: "unknown",
  });
});
