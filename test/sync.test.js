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
  { sendMessageImpl, sessionMode = "legacy", now = null, framed = false } = {},
) {
  const js = fs.readFileSync(SYNC_JS_PATH, "utf8");
  const outer = new JSDOM(`<!doctype html><html><body>${framed ? "<iframe></iframe>" : ""}</body></html>`, {
    url: origin,
    runScripts: "outside-only",
    contentType: "text/html",
  });
  // `framed`: the script finds itself in a frame inside some other page.
  const dom = { window: framed ? outer.window.frames[0] : outer.window };
  const messages = [];
  const postedMessages = [];
  const consoleErrors = [];
  const originalPostMessage = dom.window.postMessage.bind(dom.window);
  dom.window.postMessage = (data, targetOrigin, transfer) => {
    postedMessages.push({ data, targetOrigin });
    // The test frame has no address of its own, so its origin reads "null",
    // which cannot be posted to by name.
    return originalPostMessage(data, framed && targetOrigin === "null" ? "*" : targetOrigin, transfer);
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
    ...(now ? { Date: { now } } : {}),
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

function dispatchPageMessage(h, data, origin = "https://tracefiction.com") {
  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data,
      origin,
      source: h.window,
    }),
  );
}

function createFirstInstallHarness({
  url = "https://tracefiction.com/?activation=extension-installed",
  sessionMode = "kernel",
  authState = "signed_out",
} = {}) {
  return createSyncHarness(url, {
    sessionMode,
    sendMessageImpl(message, callback) {
      if (message.type === "TRACE_EXTENSION_STATUS_QUERY") {
        callback?.({
          installed: true,
          connected: false,
          authState,
        });
      } else if (message.type === "TRACE_SESSION_ACTION") {
        callback?.({
          ok: true,
          snapshot: {
            state: "connected",
            reason: "none",
            canExecuteAuthenticated: true,
          },
        });
      }
    },
  });
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

function credentialGrantRequestMessages(h) {
  return tokenRequestMessages(h).filter(
    (item) => item.data.reason === "credential_grant",
  );
}

test("kernel sync accepts only a correlated explicit credential grant", async () => {
  const h = createSyncHarness("https://tracefiction.com", { sessionMode: "kernel" });
  assert.deepEqual(credentialGrantRequestMessages(h), []);
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
  const explicitRequests = credentialGrantRequestMessages(h);
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

test("kernel sync asks a loaded page once whether it is signed in", async () => {
  const h = createSyncHarness("https://tracefiction.com", { sessionMode: "kernel" });
  h.window.dispatchEvent(new h.window.Event("pageshow"));
  h.window.dispatchEvent(new h.window.Event("focus"));
  await flush();
  const requests = tokenRequestMessages(h);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.reason, "sync_ready");
  assert.equal(Object.hasOwn(requests[0].data, "requestId"), false);
  assert.deepEqual(h.messages, []);
});

test("kernel sync turns a signed-in page's own token into a content-free hint", async () => {
  const h = createSyncHarness("https://tracefiction.com", { sessionMode: "kernel" });
  dispatchPageMessage(h, { type: "TRACE_FICTION_TOKEN", token: null });
  dispatchPageMessage(h, { type: "TRACE_FICTION_TOKEN", token: "   " });
  dispatchPageMessage(h, { type: "TRACE_FICTION_TOKEN", token: "ambient-token" }, "https://evil.example");
  await flush();
  assert.deepEqual(h.messages, []);

  dispatchPageMessage(h, { type: "TRACE_FICTION_TOKEN", token: "ambient-token" });
  await flush();
  assert.deepEqual(plainJson(h.messages), [{ type: "TRACE_WEB_READY" }]);
  assert.equal(JSON.stringify(h.messages).includes("ambient-token"), false);
});

test("kernel sync asks again for a grant the page could not answer before signing in", async () => {
  const h = createSyncHarness("https://tracefiction.com", { sessionMode: "kernel" });
  const responses = [];
  h.emitRuntimeMessage(
    {
      type: "TRACE_CREDENTIAL_GRANT_REQUEST",
      protocolVersion: 1,
      requestId: "grant-early",
      purpose: "connect",
    },
    {},
    (response) => responses.push(response),
  );
  assert.equal(credentialGrantRequestMessages(h).length, 1);

  // The page finishes signing in and posts its token on its own.
  dispatchPageMessage(h, { type: "TRACE_FICTION_TOKEN", token: "ambient-token" });
  const repeated = credentialGrantRequestMessages(h);
  assert.equal(repeated.length, 2);
  assert.equal(repeated[1].data.requestId, "grant-early");
  assert.deepEqual(responses, [], "an uncorrelated token never answers a grant");

  dispatchPageMessage(h, {
    type: "TRACE_FICTION_TOKEN",
    token: "current-token",
    protocolVersion: 1,
    requestId: "grant-early",
  });
  assert.deepEqual(plainJson(responses), [
    { ok: true, requestId: "grant-early", token: "current-token" },
  ]);
});

test("legacy sync never sends the kernel readiness hint", async () => {
  const h = createSyncHarness();
  dispatchPageMessage(h, { type: "TRACE_FICTION_TOKEN", token: "legacy-token" });
  await flush();
  assert.equal(h.messages.some((message) => message.type === "TRACE_WEB_READY"), false);
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

test("kernel first install connects from both empty and existing library readiness", async () => {
  const statusHarness = createFirstInstallHarness();
  dispatchPageMessage(statusHarness, {
    type: "TRACE_EXTENSION_STATUS_REQUEST",
    nonce: "install-connect",
  });
  await flush();
  assert.deepEqual(plainJson(statusHarness.messages), [
    { type: "TRACE_EXTENSION_STATUS_QUERY", nonce: "install-connect" },
    { type: "TRACE_SESSION_ACTION", action: "connect" },
  ]);

  const readyHarness = createFirstInstallHarness();
  dispatchPageMessage(readyHarness, {
    type: "TRACE_EXTENSION_FIRST_INSTALL_READY",
    protocolVersion: 1,
  });
  await flush();
  assert.equal(readyHarness.messages[0].type, "TRACE_EXTENSION_STATUS_QUERY");
  assert.match(
    readyHarness.messages[0].nonce,
    /^first-install-[a-z0-9]+-[a-z0-9]+$/,
  );
  assert.deepEqual(plainJson(readyHarness.messages[1]), {
    type: "TRACE_SESSION_ACTION",
    action: "connect",
  });
});

test("kernel first install reconnects a retained session at most once", async () => {
  const h = createFirstInstallHarness({ authState: "reconnect_required" });
  for (const nonce of ["install-reconnect-1", "install-reconnect-2"]) {
    dispatchPageMessage(h, {
      type: "TRACE_EXTENSION_STATUS_REQUEST",
      nonce,
    });
    await flush();
  }
  assert.deepEqual(
    plainJson(
      h.messages.filter((message) => message.type === "TRACE_SESSION_ACTION"),
    ),
    [{ type: "TRACE_SESSION_ACTION", action: "reconnect" }],
  );
});

test("first-install activation stays exact-origin, exact-envelope, kernel-only, and route-bound", async () => {
  const invalidReadyCases = [
    {
      h: createFirstInstallHarness(),
      origin: "https://evil.example",
      data: {
        type: "TRACE_EXTENSION_FIRST_INSTALL_READY",
        protocolVersion: 1,
      },
    },
    {
      h: createFirstInstallHarness(),
      origin: "https://tracefiction.com",
      data: {
        type: "TRACE_EXTENSION_FIRST_INSTALL_READY",
        protocolVersion: 1,
        token: "must-not-be-accepted",
      },
    },
    {
      h: createFirstInstallHarness({ url: "https://tracefiction.com/library" }),
      origin: "https://tracefiction.com",
      data: {
        type: "TRACE_EXTENSION_FIRST_INSTALL_READY",
        protocolVersion: 1,
      },
    },
  ];
  for (const item of invalidReadyCases) {
    dispatchPageMessage(item.h, item.data, item.origin);
    await flush();
    assert.deepEqual(item.h.messages, []);
  }

  for (const h of [
    createFirstInstallHarness({ url: "https://tracefiction.com/library" }),
    createFirstInstallHarness({ sessionMode: "legacy" }),
  ]) {
    h.messages.length = 0;
    dispatchPageMessage(h, {
      type: "TRACE_EXTENSION_STATUS_REQUEST",
      nonce: "bounded-status",
    });
    await flush();
    assert.deepEqual(
      h.messages.filter((message) => message.type === "TRACE_SESSION_ACTION"),
      [],
    );
  }
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

// ---- Setup page requests ----

const SETUP_ORIGIN = "https://www.tracefiction.com";
const SETUP_PAGE_URL = `${SETUP_ORIGIN}/safari-setup`;

function setupHarness(replies = {}, options = {}) {
  return createSyncHarness(SETUP_PAGE_URL, {
    sessionMode: "kernel",
    sendMessageImpl(message, callback) {
      if (message.type !== "TRACE_SETUP_PAGE_REQUEST") return callback?.(undefined);
      const reply = replies[message.request];
      callback?.(typeof reply === "function" ? reply(message) : reply);
    },
    ...options,
  });
}

function setupMessages(h) {
  return plainJson(h.messages.filter((message) => message.type === "TRACE_SETUP_PAGE_REQUEST"));
}

function setupAnswers(h) {
  return plainJson(h.postedMessages.filter((item) =>
    item?.data?.type === "TRACE_SETUP_RESPONSE" || item?.data?.type === "TRACE_SETUP_ACCESS_CHANGED"));
}

function askSetup(h, data, { origin = SETUP_ORIGIN, source } = {}) {
  h.window.dispatchEvent(new h.window.MessageEvent("message", {
    data: { type: "TRACE_SETUP_REQUEST", ...data },
    origin,
    source: source === undefined ? h.window : source,
  }));
}

test("setup: the page learns whether the story sites are allowed", async () => {
  for (const result of [
    { storySitesAllowed: true, scope: "all" },
    { storySitesAllowed: true, scope: "story-sites" },
    { storySitesAllowed: false, scope: "this-site" },
  ]) {
    const h = setupHarness({ access: { ok: true, result: { ...result, origins: ["*://*/*"], secret: "x" } } });
    askSetup(h, { id: "q1", request: "access" });
    await flush();
    assert.deepEqual(setupMessages(h), [{ type: "TRACE_SETUP_PAGE_REQUEST", request: "access" }]);
    assert.deepEqual(setupAnswers(h), [{
      data: { type: "TRACE_SETUP_RESPONSE", id: "q1", ok: true, result },
      targetOrigin: SETUP_ORIGIN,
    }], "exactly the two fields, to this page's own origin");
  }
});

test("setup: the page is given story tabs by id, title and site, and nothing else about them", async () => {
  const h = setupHarness({
    "story-tabs": {
      ok: true,
      result: {
        tabs: [
          { tabId: 12, title: "The Other Road | FanFiction", site: "ffn", url: "https://www.fanfiction.net/s/4821/2/", windowId: 3, active: true },
          { tabId: 11, title: "x".repeat(400), site: "ao3", favIconUrl: "https://archiveofourown.org/favicon.ico" },
        ],
        everyTab: [{ url: "https://bank.example/" }],
      },
    },
  });
  askSetup(h, { id: "q2", request: "story-tabs" });
  await flush();
  assert.deepEqual(setupMessages(h), [{ type: "TRACE_SETUP_PAGE_REQUEST", request: "story-tabs" }]);
  const [answer] = setupAnswers(h);
  assert.deepEqual(answer.data, {
    type: "TRACE_SETUP_RESPONSE",
    id: "q2",
    ok: true,
    result: {
      tabs: [
        { tabId: 12, title: "The Other Road | FanFiction", site: "ffn" },
        { tabId: 11, title: "x".repeat(120), site: "ao3" },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(answer), /https?:\/\/(?!www\.tracefiction\.com")|bank|favicon|windowId/);

  // More than five, or anything not shaped like a story tab, is not passed on.
  const many = setupHarness({
    "story-tabs": { ok: true, result: { tabs: Array.from({ length: 9 }, (_, index) => ({ tabId: index, title: `Story ${index}`, site: "ao3" })) } },
  });
  askSetup(many, { id: "q3", request: "story-tabs" });
  await flush();
  assert.equal(setupAnswers(many)[0].data.result.tabs.length, 5);

  for (const tabs of [
    [{ tabId: "12", title: "A", site: "ao3" }],
    [{ tabId: 12, title: "A", site: "bank" }],
    [{ tabId: 12, site: "ao3" }],
    [{ tabId: -1, title: "A", site: "ao3" }],
    [null],
    "all of them",
  ]) {
    const bad = setupHarness({ "story-tabs": { ok: true, result: { tabs } } });
    askSetup(bad, { id: "q4", request: "story-tabs" });
    await flush();
    assert.deepEqual(setupAnswers(bad)[0].data, { type: "TRACE_SETUP_RESPONSE", id: "q4", ok: false, error: "unavailable" }, JSON.stringify(tabs));
  }
});

test("setup: the page can ask for one of its story tabs to be brought forward, by id only", async () => {
  const h = setupHarness({ "switch-to-tab": { ok: true, tab: { url: "https://archiveofourown.org/works/123" } } });
  askSetup(h, { id: "q5", request: "switch-to-tab", tabId: 11, url: "https://bank.example/", active: false, windowId: 9 });
  await flush();
  assert.deepEqual(setupMessages(h), [{ type: "TRACE_SETUP_PAGE_REQUEST", request: "switch-to-tab", tabId: 11 }],
    "nothing but the id travels: no address, no other change to the tab");
  assert.deepEqual(setupAnswers(h)[0].data, { type: "TRACE_SETUP_RESPONSE", id: "q5", ok: true });

  for (const [reply, error] of [
    [{ ok: false, error: "not_listed" }, "not_listed"],
    [{ ok: false, error: "not_a_story" }, "not_a_story"],
    [{ ok: false, error: "not_allowed" }, "not_allowed"],
    [{ ok: false, error: "switch_failed" }, "switch_failed"],
    [{ ok: false, error: "rate_limited" }, "rate_limited"],
    [{ ok: false, error: "forbidden" }, "forbidden"],
    [{ ok: false, error: "Error: No tab with id 11 at https://archiveofourown.org/works/123" }, "unavailable"],
    [{ ok: false }, "unavailable"],
    [undefined, "unavailable"],
    ["ok", "unavailable"],
  ]) {
    const refused = setupHarness({ "switch-to-tab": reply });
    askSetup(refused, { id: "q6", request: "switch-to-tab", tabId: 11 });
    await flush();
    assert.deepEqual(setupAnswers(refused)[0].data, { type: "TRACE_SETUP_RESPONSE", id: "q6", ok: false, error }, JSON.stringify(reply));
  }

  for (const tabId of [undefined, "11", 1.5, -1, null, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = setupHarness({ "switch-to-tab": { ok: true } });
    askSetup(invalid, { id: "q7", request: "switch-to-tab", tabId });
    await flush();
    assert.deepEqual(setupAnswers(invalid)[0].data, { type: "TRACE_SETUP_RESPONSE", id: "q7", ok: false, error: "invalid_request" }, String(tabId));
    assert.deepEqual(setupMessages(invalid), [], "a malformed request never reaches the background");
  }
});

test("setup: a request this script does not know is refused by name, without asking the background", async () => {
  const h = setupHarness({ access: { ok: true, result: { storySitesAllowed: true, scope: "all" } } });
  for (const [request, error] of [
    ["request-access", "unknown_request"],
    ["permissions", "unknown_request"],
    ["open-tab", "unknown_request"],
    ["", "unknown_request"],
    [undefined, "invalid_request"],
    [7, "invalid_request"],
    [["access"], "invalid_request"],
  ]) {
    h.postedMessages.length = 0;
    askSetup(h, { id: "q8", request });
    await flush();
    assert.deepEqual(setupAnswers(h).map(({ data }) => data), [{ type: "TRACE_SETUP_RESPONSE", id: "q8", ok: false, error }], String(request));
  }
  assert.deepEqual(setupMessages(h), []);
});

test("setup: only this page's own top-level window, speaking to itself, is heard", async () => {
  const reply = { access: { ok: true, result: { storySitesAllowed: true, scope: "all" } } };

  // Another origin's message, as a frame or an opener would send it.
  const h = setupHarness(reply);
  for (const origin of ["https://archiveofourown.org", "https://www.fanfiction.net", "https://example.com", "https://tracefiction.com", "http://www.tracefiction.com", "null", ""]) {
    askSetup(h, { id: "q9", request: "access" }, { origin });
  }
  // The right origin, from a different window: a same-origin frame, or no window at all.
  const frame = h.window.document.createElement("iframe");
  h.window.document.body.appendChild(frame);
  askSetup(h, { id: "q9", request: "access" }, { source: frame.contentWindow });
  askSetup(h, { id: "q9", request: "access" }, { source: null });
  await flush();
  assert.deepEqual(setupMessages(h), []);
  assert.deepEqual(setupAnswers(h), [], "and it gets no answer at all");

  // The script running inside a frame hears nothing either, even from that
  // frame's own window on that frame's own origin.
  const framed = setupHarness(reply, { framed: true });
  assert.notEqual(framed.window.top, framed.window, "the script's window is a frame");
  framed.window.dispatchEvent(new framed.window.MessageEvent("message", {
    data: { type: "TRACE_SETUP_REQUEST", id: "q9", request: "access" },
    origin: framed.window.location.origin,
    source: framed.window,
  }));
  await flush();
  assert.deepEqual(setupMessages(framed), []);
  assert.deepEqual(setupAnswers(framed), []);
  framed.emitRuntimeMessage({ type: "TRACE_SETUP_ACCESS_PUSH", storySitesAllowed: true, scope: "all" });
  assert.deepEqual(setupAnswers(framed), [], "nor is it told when access changes");

  // The same request from the page itself is answered.
  askSetup(h, { id: "q9", request: "access" });
  await flush();
  assert.equal(setupAnswers(h).length, 1);
});

test("setup: a request that cannot be addressed, and any other message type, is ignored silently", async () => {
  const h = setupHarness({ access: { ok: true, result: { storySitesAllowed: true, scope: "all" } } });
  for (const id of [undefined, "", 7, null, {}, "x".repeat(65)]) {
    askSetup(h, { id, request: "access" });
  }
  for (const type of ["TRACE_SETUP_RESPONSE", "TRACE_SETUP_ACCESS_CHANGED", "TRACE_SETUP_PAGE_REQUEST", "TRACE_SETUP_ACCESS_PUSH", "TRACE_SETUP", "trace_setup_request", "SOMETHING_ELSE"]) {
    h.window.dispatchEvent(new h.window.MessageEvent("message", {
      data: { type, id: "q10", request: "access", storySitesAllowed: true, scope: "all" },
      origin: SETUP_ORIGIN,
      source: h.window,
    }));
  }
  for (const data of [null, undefined, "TRACE_SETUP_REQUEST", 7, ["TRACE_SETUP_REQUEST"]]) {
    h.window.dispatchEvent(new h.window.MessageEvent("message", { data, origin: SETUP_ORIGIN, source: h.window }));
  }
  await flush();
  assert.deepEqual(setupMessages(h), []);
  assert.deepEqual(setupAnswers(h), []);
  assert.deepEqual(h.consoleErrors, []);
});

test("setup: a page that asks too fast is answered here, without waking the background", async () => {
  let time = 1_000_000;
  const h = setupHarness({ access: { ok: true, result: { storySitesAllowed: true, scope: "all" } } }, { now: () => time });
  for (let request = 0; request < 20; request += 1) askSetup(h, { id: `a${request}`, request: "access" });
  await flush();
  assert.equal(setupMessages(h).length, 20);
  assert.equal(setupAnswers(h).filter(({ data }) => data.ok === true).length, 20);

  h.postedMessages.length = 0;
  for (let request = 0; request < 300; request += 1) {
    askSetup(h, { id: `b${request}`, request: ["access", "story-tabs", "switch-to-tab"][request % 3], tabId: 11 });
  }
  await flush();
  assert.equal(setupMessages(h).length, 20, "three hundred more requests send nothing to the background");
  assert.equal(setupAnswers(h).length, 300);
  assert.ok(setupAnswers(h).every(({ data }) => data.ok === false && data.error === "rate_limited"));

  time += 9_999;
  askSetup(h, { id: "c1", request: "access" });
  await flush();
  assert.equal(setupMessages(h).length, 20);
  time += 1;
  askSetup(h, { id: "c2", request: "access" });
  await flush();
  assert.equal(setupMessages(h).length, 21, "the limit is a window, not a ban");
});

test("setup: a change in access is passed to the page as it happens", async () => {
  const h = setupHarness();
  h.emitRuntimeMessage({ type: "TRACE_SETUP_ACCESS_PUSH", storySitesAllowed: true, scope: "story-sites", origins: ["x"], at: 1 });
  h.emitRuntimeMessage({ type: "TRACE_SETUP_ACCESS_PUSH", storySitesAllowed: false, scope: "this-site" });
  assert.deepEqual(setupAnswers(h), [
    { data: { type: "TRACE_SETUP_ACCESS_CHANGED", storySitesAllowed: true, scope: "story-sites" }, targetOrigin: SETUP_ORIGIN },
    { data: { type: "TRACE_SETUP_ACCESS_CHANGED", storySitesAllowed: false, scope: "this-site" }, targetOrigin: SETUP_ORIGIN },
  ]);

  // Anything that is not a well-formed, self-consistent reading is dropped.
  h.postedMessages.length = 0;
  for (const push of [
    { storySitesAllowed: "yes", scope: "all" },
    { storySitesAllowed: true, scope: "everything" },
    { storySitesAllowed: true, scope: "this-site" },
    { storySitesAllowed: false, scope: "all" },
    { scope: "all" },
    {},
  ]) {
    h.emitRuntimeMessage({ type: "TRACE_SETUP_ACCESS_PUSH", ...push });
  }
  assert.deepEqual(setupAnswers(h), []);
});

test("setup: an answer the background did not give in the agreed shape is not passed on", async () => {
  for (const reply of [
    { ok: true },
    { ok: true, result: null },
    { ok: true, result: { storySitesAllowed: true } },
    { ok: true, result: { storySitesAllowed: true, scope: "this-site" } },
    { ok: true, result: { storySitesAllowed: 1, scope: "all" } },
    { ok: "true", result: { storySitesAllowed: true, scope: "all" } },
    undefined,
    null,
  ]) {
    const h = setupHarness({ access: reply });
    askSetup(h, { id: "q11", request: "access" });
    await flush();
    assert.deepEqual(setupAnswers(h)[0].data, { type: "TRACE_SETUP_RESPONSE", id: "q11", ok: false, error: "unavailable" }, JSON.stringify(reply));
  }

  // A build without the background that answers these says so, and asks nothing.
  const legacy = createSyncHarness(SETUP_PAGE_URL, { sessionMode: "legacy" });
  askSetup(legacy, { id: "q12", request: "access" });
  await flush();
  assert.deepEqual(setupAnswers(legacy)[0].data, { type: "TRACE_SETUP_RESPONSE", id: "q12", ok: false, error: "unavailable" });
  assert.deepEqual(legacy.messages.filter(({ type }) => type === "TRACE_SETUP_PAGE_REQUEST"), []);
});

test("setup: the script still announces itself exactly as before", async () => {
  const h = setupHarness();
  assert.deepEqual(statusReadyMessages(h).map(({ data, targetOrigin }) => [data.type, Object.keys(data).sort(), targetOrigin]), [
    ["TRACE_EXTENSION_STATUS_READY", ["at", "type"], SETUP_ORIGIN],
  ]);
});
