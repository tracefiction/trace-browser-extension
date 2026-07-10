const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BACKGROUND_PATH = path.join(
  __dirname,
  "..",
  "src",
  "background.js",
);

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function plainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function runTimerWithDelay(h, ms) {
  const index = h.timers.findIndex((item) => item && item.ms === ms);
  assert.notEqual(index, -1, `missing ${ms}ms timer`);
  const [timer] = h.timers.splice(index, 1);
  timer.fn();
}

function createResponse({ ok = true, status = 200, json = {} } = {}) {
  return {
    ok,
    status,
    async json() {
      return json;
    },
    clone() {
      return createResponse({ ok, status, json });
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createBackgroundHarness({
  apiBase = "https://tracefiction.com",
  webOrigin = "https://tracefiction.com",
  storageState = {},
  fetchImpl,
  activeTabs = [{ id: 11 }],
  sendMessageImpl,
  sendNativeMessageImpl,
} = {}) {
  const quietConsole = {
    log() {},
    debug() {},
    warn() {},
    error() {},
  };
  const source = fs
    .readFileSync(BACKGROUND_PATH, "utf8")
    .replace(/__TRACE_API_BASE__/g, apiBase)
    .replace(/__TRACE_WEB_ORIGIN__/g, webOrigin);

  const store = { ...storageState };
  const badgeTextCalls = [];
  const badgeColorCalls = [];
  const createdTabs = [];
  const updatedTabs = [];
  const nativeMessages = [];
  const fetchCalls = [];
  const timers = [];
  const storageChangeListeners = [];
  let onMessageListener = null;
  let onInstalledListener = null;
  let onAlarmListener = null;
  let onTabUpdatedListener = null;

  const localApi = {
    get(keys, callback) {
      const out = {};
      const list = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : keys && typeof keys === "object"
            ? Object.keys(keys)
            : [];
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(store, key)) {
          out[key] = store[key];
        } else if (keys && typeof keys === "object" && !Array.isArray(keys)) {
          out[key] = keys[key];
        }
      }
      callback?.(out);
    },
    set(obj, callback) {
      Object.assign(store, obj || {});
      callback?.();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete store[key];
      callback?.();
    },
  };

  const ext = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          onMessageListener = fn;
        },
      },
      onInstalled: {
        addListener(fn) {
          onInstalledListener = fn;
        },
      },
      sendNativeMessage(...args) {
        const callback =
          typeof args[args.length - 1] === "function" ? args.pop() : undefined;
        nativeMessages.push(plainJson(args));
        if (sendNativeMessageImpl) {
          return sendNativeMessageImpl(...args, callback);
        }
        if (callback) callback(undefined);
        return undefined;
      },
    },
    storage: {
      local: localApi,
      onChanged: {
        addListener(fn) {
          storageChangeListeners.push(fn);
        },
      },
    },
    action: {
      setBadgeText(args) {
        badgeTextCalls.push(args);
      },
      setBadgeBackgroundColor(args) {
        badgeColorCalls.push(args);
      },
    },
    tabs: {
      async query(queryInfo) {
        const urls = queryInfo && queryInfo.url;
        if (!urls) return activeTabs;
        const list = Array.isArray(urls) ? urls : [urls];
        const prefixOf = (pat) => {
          if (typeof pat !== "string") return "";
          return pat.endsWith("/*") ? pat.slice(0, -1) : pat;
        };
        return activeTabs.filter((tab) => {
          const u = tab.url || "";
          return list.some((pat) => {
            const p = prefixOf(pat);
            return p && u.startsWith(p);
          });
        });
      },
      async sendMessage(tabId, msg) {
        if (sendMessageImpl) return sendMessageImpl(tabId, msg);
        return { ok: false, error: "no_stubbed_content_script" };
      },
      async create(args) {
        createdTabs.push(args);
        return { id: 100 + createdTabs.length, ...args };
      },
      async update(tabId, args) {
        updatedTabs.push({ tabId, args });
        const tab = activeTabs.find((item) => item.id === tabId);
        if (tab) Object.assign(tab, args || {});
        return { id: tabId, ...(tab || {}), ...(args || {}) };
      },
      onUpdated: {
        addListener(fn) {
          onTabUpdatedListener = fn;
        },
      },
    },
    alarms: {
      create() {},
      get(_name, callback) {
        callback?.(null);
      },
      onAlarm: {
        addListener(fn) {
          onAlarmListener = fn;
        },
      },
    },
  };

  const context = {
    console: quietConsole,
    chrome: ext,
    browser: undefined,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (fetchImpl) return fetchImpl(url, init);
      return createResponse({ ok: false, status: 500 });
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout(id) {
      if (id > 0 && id <= timers.length) timers[id - 1] = null;
    },
    TextEncoder,
    URL,
    Date,
    JSON,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    globalThis: null,
  };
  context.globalThis = context;

  const expose = `
globalThis.__testHooks = {
  handleAutoTrack,
  executeAutoTrack,
  handleImportTrigger,
  handleMetadataBroadcast,
  handleLibraryMetadataRefresh,
  handleQuickAdd,
  handleSetHiddenWork,
  handleSetReaderStatus,
  handlePatchLibraryEntry,
  handleFinishQualificationSignal,
  syncAo3SavedFilters,
  scheduleAo3SavedFiltersSync,
  sanitizeAo3SavedFilterPresets,
  sanitizeAo3DeletedSavedFilters,
  patchOverlayHiddenPreference,
  patchOverlayReaderStatus,
  patchOverlayLibraryEntry,
  shouldIgnoreSenderForAutoTrack,
  setBearerToken(value) { bearerToken = value; },
  setVerifiedBearerToken(value) { verifiedBearerToken = value; },
  getVerifiedBearerToken() { return verifiedBearerToken; },
  getBearerToken() { return bearerToken; }
};
`;

  vm.createContext(context);
  vm.runInContext(source + expose, context);

  return {
    context,
    store,
    badgeTextCalls,
    badgeColorCalls,
    createdTabs,
    updatedTabs,
    nativeMessages,
    fetchCalls,
    timers,
    get hooks() {
      return context.__testHooks;
    },
    get onMessageListener() {
      return onMessageListener;
    },
    get onInstalledListener() {
      return onInstalledListener;
    },
    get onAlarmListener() {
      return onAlarmListener;
    },
    get onTabUpdatedListener() {
      return onTabUpdatedListener;
    },
    emitStorageChange(changes, area = "local") {
      for (const fn of storageChangeListeners) fn(changes, area);
    },
    async dispatchMessage(msg, sender = { tab: { id: 11 } }) {
      assert.equal(typeof onMessageListener, "function");
      let responded = false;
      return new Promise((resolve) => {
        const maybeAsync = onMessageListener(msg, sender, (res) => {
          responded = true;
          resolve(res);
        });
        if (maybeAsync !== true) {
          Promise.resolve().then(() => {
            if (!responded) resolve(undefined);
          });
        }
      });
    },
    runTimers() {
      const pending = timers.splice(0, timers.length).filter(Boolean);
      for (const item of pending) item.fn();
    },
  };
}

test("TRACE_AUTH_UPDATE with blank token clears session and marks signed out", async () => {
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-1",
      traceUserPro: true,
      traceAccountId: "acct-1",
      traceFirstSaveSeen: true,
      traceLibraryCount: 9,
      libraryOverlayCache: { entries: { "ao3:1": "READING" } },
      traceWorkStatesV1: {
        version: 1,
        accountId: "acct-1",
        items: {
          "acct-1|ao3:1": { accountId: "acct-1", workKey: "ao3:1", status: "pending" },
        },
      },
    },
  });

  const response = await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: "   " },
    { tab: { id: 22 } },
  );

  assert.deepEqual(plainJson(response), { success: true, state: "signed_out" });
  assert.equal(h.store.authToken, undefined);
  assert.equal(h.store.traceUserPro, undefined);
  assert.equal(h.store.traceAccountId, undefined);
  assert.equal(h.store.traceFirstSaveSeen, undefined);
  assert.equal(h.store.traceLibraryCount, undefined);
  assert.equal(h.store.libraryOverlayCache, undefined);
  assert.equal(h.store.traceWorkStatesV1, undefined);
  assert.equal(h.store.traceAuthState.state, "signed_out");
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "", tabId: 22 });
});

test("TRACE_AUTH_UPDATE verifies account before marking connected", async () => {
  const h = createBackgroundHarness({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({
          json: { account_id: "acct-browser", pro: true, library_count: 7 },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  const response = await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: " verified-token " },
    { tab: { id: 23 } },
  );

  assert.deepEqual(plainJson(response), { success: true, state: "connected" });
  assert.equal(h.hooks.getBearerToken(), "verified-token");
  assert.equal(h.hooks.getVerifiedBearerToken(), "verified-token");
  assert.equal(h.store.authToken, "verified-token");
  assert.equal(h.store.traceAccountId, "acct-browser");
  assert.equal(h.store.traceUserPro, true);
  assert.equal(h.store.traceLibraryCount, 7);
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.store.traceAuthState.lastVerifiedAccountId, "acct-browser");
  assert.equal(h.store.traceAuthState.authVerificationVersion, 1);
  assert.match(h.store.traceAuthState.accountVerifiedAt, /^\d{4}-/);
  assert.match(h.store.traceAuthState.lastTokenSyncAt, /^\d{4}-/);
});

test("TRACE_AUTH_UPDATE clears account-scoped caches when the verified account changes", async () => {
  const h = createBackgroundHarness({
    storageState: {
      traceAccountId: "acct-old",
      libraryOverlayCache: {
        entries: {
          "ao3:123": { status: "PLANNING" },
        },
        syncVersion: "old",
      },
      traceWorkStatesV1: {
        version: 1,
        accountId: "acct-old",
        items: {
          "acct-old|ao3:123": {
            accountId: "acct-old",
            workKey: "ao3:123",
            status: "pending",
            expiresAt: Date.now() + 60_000,
          },
        },
      },
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({
          json: { account_id: "acct-new", pro: false, library_count: 0 },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "new" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: "new-account-token" },
    { tab: { id: 24 } },
  );

  assert.equal(h.store.traceAccountId, "acct-new");
  assert.equal(h.store.traceWorkStatesV1, undefined);
  assert.deepEqual(plainJson(h.store.libraryOverlayCache.entries), {});
});

test("iOS native auth token bootstraps the extension account", async () => {
  const h = createBackgroundHarness({
    sendNativeMessageImpl(message, callback) {
      assert.equal(message.type, "TRACE_IOS_AUTH_TOKEN_REQUEST");
      callback({ ok: true, token: "native-token" });
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: true, library_count: 3 } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "native-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  await flush();
  await flush();
  await flush();

  assert.deepEqual(plainJson(h.nativeMessages[0]), [
    { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", reason: "missing_token" },
  ]);
  assert.equal(h.hooks.getBearerToken(), "native-token");
  assert.equal(h.hooks.getVerifiedBearerToken(), "native-token");
  assert.equal(h.store.authToken, "native-token");
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.store.traceUserPro, true);
  assert.equal(h.store.traceLibraryCount, 3);
});

test("iOS native auth retries native messaging with application id after async failure", async () => {
  const h = createBackgroundHarness({
    sendNativeMessageImpl(firstArg, secondArg, callback) {
      if (firstArg === "com.tracefiction.trace") {
        assert.equal(secondArg.type, "TRACE_IOS_AUTH_TOKEN_REQUEST");
        callback({ ok: true, token: "native-token-two-arg" });
        return;
      }
      return Promise.reject(new Error("one-argument native message rejected"));
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/account/me")) {
        assert.equal(init.headers.Authorization, "Bearer native-token-two-arg");
        return createResponse({ json: { pro: false, library_count: 2 } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "native-two-arg-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  await flush();
  await flush();
  await flush();

  assert.deepEqual(plainJson(h.nativeMessages[0]), [
    { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", reason: "missing_token" },
  ]);
  assert.deepEqual(plainJson(h.nativeMessages[1]), [
    "com.tracefiction.trace",
    { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", reason: "missing_token" },
  ]);
  assert.equal(h.hooks.getBearerToken(), "native-token-two-arg");
  assert.equal(h.store.traceAuthState.state, "connected");
});

test("missing iOS native auth token leaves the extension signed out", async () => {
  const h = createBackgroundHarness();

  await flush();

  assert.deepEqual(plainJson(h.nativeMessages[0]), [
    { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", reason: "missing_token" },
  ]);
  assert.equal(h.hooks.getBearerToken(), null);
  assert.equal(h.store.authToken, undefined);
  assert.equal(h.store.traceAuthState.state, "signed_out");
});

test("late missing iOS bootstrap does not overwrite a browser token update", async () => {
  let nativeCallback;
  const h = createBackgroundHarness({
    sendNativeMessageImpl(message, callback) {
      assert.equal(message.type, "TRACE_IOS_AUTH_TOKEN_REQUEST");
      nativeCallback = callback;
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: false, library_count: 1 } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "web-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  const response = await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: "web-token" },
    { tab: { id: 23 } },
  );
  assert.deepEqual(plainJson(response), { success: true, state: "connected" });

  nativeCallback(undefined);
  await flush();

  assert.equal(h.hooks.getBearerToken(), "web-token");
  assert.equal(h.hooks.getVerifiedBearerToken(), "web-token");
  assert.equal(h.store.authToken, "web-token");
  assert.equal(h.store.traceAuthState.state, "connected");
});

test("TRACE_IOS_PENDING_FIRST_STORY messages proxy native pending state", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "stored-token" },
    sendNativeMessageImpl(message, callback) {
      if (message.type === "TRACE_IOS_PENDING_FIRST_STORY_GET") {
        callback({
          ok: true,
          url: "https://archiveofourown.org/works/123/chapters/456",
          expiresAt: 1767225600000,
        });
        return;
      }
      if (message.type === "TRACE_IOS_PENDING_FIRST_STORY_CLEAR") {
        callback({ ok: true });
        return;
      }
      callback({ ok: false, error: "unexpected_message" });
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: false, library_count: 0 } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "pending-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  const pending = await h.dispatchMessage({
    type: "TRACE_IOS_PENDING_FIRST_STORY_GET",
  });
  const cleared = await h.dispatchMessage({
    type: "TRACE_IOS_PENDING_FIRST_STORY_CLEAR",
  });

  assert.deepEqual(plainJson(pending), {
    ok: true,
    url: "https://archiveofourown.org/works/123/chapters/456",
    expiresAt: 1767225600000,
  });
  assert.deepEqual(plainJson(cleared), { ok: true });
  assert.deepEqual(
    h.nativeMessages.slice(-2).map((args) => plainJson(args[0])),
    [
      { type: "TRACE_IOS_PENDING_FIRST_STORY_GET" },
      { type: "TRACE_IOS_PENDING_FIRST_STORY_CLEAR" },
    ],
  );
});

test("TRACE_IOS_PENDING_FIRST_STORY_GET stops before URL handoff when iOS auth bootstrap fails", async () => {
  const h = createBackgroundHarness({
    sendNativeMessageImpl(message, callback) {
      if (message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST") {
        callback({ ok: false, error: "missing_token" });
        return;
      }
      if (message.type === "TRACE_IOS_PENDING_FIRST_STORY_GET") {
        callback({
          ok: true,
          url: "https://archiveofourown.org/works/123/chapters/456",
        });
        return;
      }
      callback({ ok: false, error: "unexpected_message" });
    },
  });

  const pending = await h.dispatchMessage({
    type: "TRACE_IOS_PENDING_FIRST_STORY_GET",
  });

  assert.deepEqual(plainJson(pending), {
    ok: false,
    error: "not_authenticated",
  });
  assert.equal(
    h.nativeMessages.some(
      (args) => plainJson(args[0]).type === "TRACE_IOS_PENDING_FIRST_STORY_GET",
    ),
    false,
  );
});

test("TRACE_AUTH_UPDATE handles bootstrap-required tokens without marking connected", async () => {
  const h = createBackgroundHarness({
    fetchImpl: async (url) => {
      assert.ok(String(url).endsWith("/api/account/me"));
      return createResponse({
        ok: false,
        status: 409,
        json: { code: "ACCOUNT_BOOTSTRAP_REQUIRED" },
      });
    },
  });

  const response = await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: "bootstrap-token" },
    { tab: { id: 24 } },
  );

  assert.deepEqual(plainJson(response), {
    success: false,
    state: "reconnect_required",
    error: "account_bootstrap_required",
  });
  assert.equal(h.hooks.getBearerToken(), null);
  assert.equal(h.store.authToken, undefined);
  assert.equal(h.store.traceAuthState.state, "reconnect_required");
  assert.equal(h.store.traceAuthState.lastHttpStatus, 409);
  assert.equal(h.store.traceAuthState.lastAuthErrorCode, "ACCOUNT_BOOTSTRAP_REQUIRED");
});

test("TRACE_AUTH_UPDATE retries transient verification failures before surfacing error", async () => {
  let accountChecks = 0;
  const h = createBackgroundHarness({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        accountChecks += 1;
        if (accountChecks === 1) {
          return createResponse({ ok: false, status: 500 });
        }
        return createResponse({ json: { pro: false, library_count: 4 } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  const response = await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: "network-token" },
    { tab: { id: 25 } },
  );

  assert.deepEqual(plainJson(response), {
    success: false,
    state: "unknown",
    error: "account_check_retrying",
    status: 500,
    retrying: true,
  });
  assert.equal(h.hooks.getBearerToken(), "network-token");
  assert.equal(h.store.authToken, "network-token");
  assert.equal(h.store.traceAuthState.state, "unknown");
  assert.equal(h.store.traceAuthState.lastHttpStatus, 500);
  assert.match(h.store.traceAuthState.message, /Retrying shortly/);
  assert.ok(h.timers.some((timer) => timer?.ms === 750));

  runTimerWithDelay(h, 750);
  await flush();
  await flush();

  assert.equal(accountChecks, 2);
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.hooks.getVerifiedBearerToken(), "network-token");
  assert.equal(h.store.traceLibraryCount, 4);
});

test("TRACE_AUTH_UPDATE surfaces hard error after transient verification retries are exhausted", async () => {
  const h = createBackgroundHarness({
    fetchImpl: async (url) => {
      assert.ok(String(url).endsWith("/api/account/me"));
      return createResponse({ ok: false, status: 500 });
    },
  });

  const response = await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: "network-token" },
    { tab: { id: 25 } },
  );

  assert.deepEqual(plainJson(response), {
    success: false,
    state: "unknown",
    error: "account_check_retrying",
    status: 500,
    retrying: true,
  });
  assert.equal(h.hooks.getBearerToken(), "network-token");
  assert.equal(h.store.authToken, "network-token");
  assert.equal(h.store.traceAuthState.state, "unknown");

  for (const delayMs of [750, 2_500, 8_000]) {
    runTimerWithDelay(h, delayMs);
    await flush();
    await flush();
  }

  assert.equal(h.store.traceAuthState.state, "error");
  assert.equal(h.store.traceAuthState.lastHttpStatus, 500);
});

test("startup re-verifies stored connected tokens before reporting connected", async () => {
  const accountMe = createDeferred();
  const h = createBackgroundHarness({
    storageState: {
      authToken: "legacy-connected-token",
      traceAuthState: {
        state: "connected",
        message: "Connected by old token receipt flow.",
        lastTokenSyncAt: "2026-05-01T12:00:00.000Z",
      },
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return accountMe.promise;
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  assert.equal(h.store.traceAuthState.state, "unknown");
  const beforeVerification = await h.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-before-startup-verification",
  });
  assert.deepEqual(plainJson(beforeVerification), {
    installed: true,
    connected: false,
    authState: "unknown",
    firstSaveSeen: false,
    browserKind: "unknown",
    lastTokenSyncAt: Date.parse("2026-05-01T12:00:00.000Z"),
  });

  accountMe.resolve(createResponse({ json: { pro: false, library_count: 3 } }));
  await flush();
  await flush();

  const afterVerification = await h.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-after-startup-verification",
  });
  assert.deepEqual(plainJson(afterVerification), {
    installed: true,
    connected: true,
    authState: "connected",
    firstSaveSeen: false,
    browserKind: "unknown",
    lastTokenSyncAt: Date.parse("2026-05-01T12:00:00.000Z"),
  });
  assert.equal(h.hooks.getVerifiedBearerToken(), "legacy-connected-token");
  assert.equal(h.store.traceAuthState.authVerificationVersion, 1);
  assert.match(h.store.traceAuthState.accountVerifiedAt, /^\d{4}-/);
});

test("syncAo3SavedFilters uploads dirty local presets and stores server ids", async () => {
  const h = createBackgroundHarness({
    storageState: {
      traceAo3SavedFiltersV1: [
        {
          id: "preset-a",
          clientId: "preset-a",
          name: "General audiences by kudos",
          scope: "context",
          contextKey: "tagId:Naruto",
          contextLabel: "Naruto",
          params: [
            ["include_work_search[rating_ids][]", "10"],
            ["work_search[sort_column]", "kudos_count"],
          ],
          summary: ["Include: General Audiences", "Sort: Kudos"],
          createdAt: "2026-06-18T10:00:00.000Z",
          updatedAt: "2026-06-18T10:00:00.000Z",
          clientUpdatedAt: "2026-06-18T10:00:00.000Z",
          dirty: true,
        },
      ],
    },
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/api\/extension\/ao3-saved-filters\/sync$/);
      const body = JSON.parse(init.body);
      assert.equal(body.clientId.startsWith("device_"), true);
      assert.equal(body.since, null);
      assert.equal(body.upserts.length, 1);
      assert.equal(body.upserts[0].clientId, "preset-a");
      assert.equal(body.upserts[0].scope, "context");
      assert.deepEqual(body.upserts[0].params, [
        ["include_work_search[rating_ids][]", "10"],
        ["work_search[sort_column]", "kudos_count"],
      ]);
      assert.deepEqual(body.deletes, []);
      return createResponse({
        json: {
          success: true,
          data: {
            serverTime: "2026-06-18T10:00:01.000Z",
            syncVersion: "2026-06-18T10:00:01.000Z",
            presets: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                clientId: "preset-a",
                name: "General audiences by kudos",
                scope: "context",
                contextKey: "tagId:Naruto",
                contextLabel: "Naruto",
                params: [
                  ["include_work_search[rating_ids][]", "10"],
                  ["work_search[sort_column]", "kudos_count"],
                ],
                summary: ["Include: General Audiences", "Sort: Kudos"],
                createdAt: "2026-06-18T10:00:00.000Z",
                updatedAt: "2026-06-18T10:00:01.000Z",
                clientUpdatedAt: "2026-06-18T10:00:00.000Z",
              },
            ],
            deleted: [],
          },
        },
      });
    },
  });
  h.hooks.setBearerToken("token-filters");

  const result = await h.hooks.syncAo3SavedFilters();

  assert.deepEqual(plainJson(result), {
    ok: true,
    syncVersion: "2026-06-18T10:00:01.000Z",
  });
  assert.equal(h.store.traceAo3SavedFiltersV1.length, 1);
  assert.equal(
    h.store.traceAo3SavedFiltersV1[0].serverId,
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(h.store.traceAo3SavedFiltersV1[0].dirty, false);
  assert.equal(h.store.traceAo3SavedFiltersSyncV1.syncVersion, "2026-06-18T10:00:01.000Z");
  assert.equal(h.store.traceAuthState.state, "connected");
});

test("syncAo3SavedFilters drains dirty local presets in bounded batches", async () => {
  const dirtyPresets = Array.from({ length: 105 }, (_, index) => {
    const num = index + 1;
    return {
      id: `preset-${num}`,
      clientId: `preset-${num}`,
      name: `Preset ${num}`,
      scope: "global",
      contextKey: "",
      contextLabel: "",
      params: [["work_search[sort_column]", "kudos_count"]],
      summary: ["Sort: Kudos"],
      createdAt: "2026-06-18T10:00:00.000Z",
      updatedAt: "2026-06-18T10:00:00.000Z",
      clientUpdatedAt: "2026-06-18T10:00:00.000Z",
      dirty: true,
    };
  });
  const seenBatches = [];
  const h = createBackgroundHarness({
    storageState: {
      traceAo3SavedFiltersV1: dirtyPresets,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      seenBatches.push(body.upserts.map((item) => item.clientId));
      assert.ok(body.upserts.length <= 100);
      assert.deepEqual(body.deletes, []);
      const syncVersion =
        seenBatches.length === 1
          ? "2026-06-18T10:01:00.000Z"
          : "2026-06-18T10:02:00.000Z";
      return createResponse({
        json: {
          success: true,
          data: {
            serverTime: syncVersion,
            syncVersion,
            presets: body.upserts.map((preset, index) => ({
              id: `00000000-0000-4000-8000-${String(seenBatches.length * 1000 + index).padStart(12, "0")}`,
              clientId: preset.clientId,
              name: preset.name,
              scope: preset.scope,
              contextKey: preset.contextKey,
              contextLabel: preset.contextLabel,
              params: preset.params,
              summary: preset.summary,
              createdAt: preset.createdAt,
              updatedAt: syncVersion,
              clientUpdatedAt: preset.clientUpdatedAt,
            })),
            deleted: [],
          },
        },
      });
    },
  });
  h.hooks.setBearerToken("token-filters");

  const result = await h.hooks.syncAo3SavedFilters();

  assert.deepEqual(plainJson(result), {
    ok: true,
    syncVersion: "2026-06-18T10:02:00.000Z",
  });
  assert.equal(seenBatches.length, 2);
  assert.equal(seenBatches[0].length, 100);
  assert.equal(seenBatches[1].length, 5);
  assert.equal(h.store.traceAo3SavedFiltersV1.length, 105);
  assert.equal(
    h.store.traceAo3SavedFiltersV1.every((preset) => preset.dirty === false),
    true,
  );
  assert.equal(
    h.store.traceAo3SavedFiltersSyncV1.syncVersion,
    "2026-06-18T10:02:00.000Z",
  );
});

test("syncAo3SavedFilters keeps local presets when the server active cap is reached", async () => {
  const h = createBackgroundHarness({
    storageState: {
      traceAo3SavedFiltersV1: [
        {
          id: "over-cap-local",
          clientId: "over-cap-local",
          name: "Over cap local",
          scope: "global",
          contextKey: "",
          contextLabel: "",
          params: [["work_search[sort_column]", "kudos_count"]],
          summary: ["Sort: Kudos"],
          createdAt: "2026-06-18T10:00:00.000Z",
          updatedAt: "2026-06-18T10:00:00.000Z",
          clientUpdatedAt: "2026-06-18T10:00:00.000Z",
          dirty: true,
        },
      ],
    },
    fetchImpl: async () =>
      createResponse({
        ok: false,
        status: 422,
        json: {
          error: "AO3 saved filter limit reached",
          code: "AO3_SAVED_FILTER_LIMIT_REACHED",
          limit: 250,
          current: 250,
          attempted: 251,
        },
      }),
  });
  h.hooks.setBearerToken("token-filters");

  const result = await h.hooks.syncAo3SavedFilters();

  assert.deepEqual(plainJson(result), {
    ok: false,
    error: "limit_reached",
    limit: 250,
  });
  assert.equal(h.store.traceAo3SavedFiltersV1.length, 1);
  assert.equal(h.store.traceAo3SavedFiltersV1[0].dirty, true);
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.match(h.store.traceAuthState.message, /up to 250 AO3 saved filters/);
});

test("syncAo3SavedFilters pulls remote presets onto another device", async () => {
  const h = createBackgroundHarness({
    storageState: {
      traceAo3SavedFiltersSyncV1: {
        syncVersion: "2026-06-18T09:00:00.000Z",
      },
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.since, "2026-06-18T09:00:00.000Z");
      assert.deepEqual(body.upserts, []);
      assert.deepEqual(body.deletes, []);
      return createResponse({
        json: {
          success: true,
          data: {
            serverTime: "2026-06-18T10:02:00.000Z",
            syncVersion: "2026-06-18T10:02:00.000Z",
            presets: [
              {
                id: "00000000-0000-4000-8000-000000000002",
                clientId: "remote-preset",
                name: "Remote saved filter",
                scope: "global",
                contextKey: null,
                contextLabel: null,
                params: [["work_search[sort_column]", "updated_at"]],
                summary: ["Sort: Date Updated"],
                createdAt: "2026-06-18T10:01:00.000Z",
                updatedAt: "2026-06-18T10:02:00.000Z",
                clientUpdatedAt: "2026-06-18T10:01:00.000Z",
              },
            ],
            deleted: [],
          },
        },
      });
    },
  });
  h.hooks.setBearerToken("token-filters");

  await h.hooks.syncAo3SavedFilters();

  assert.equal(h.store.traceAo3SavedFiltersV1.length, 1);
  assert.equal(h.store.traceAo3SavedFiltersV1[0].id, "remote-preset");
  assert.equal(h.store.traceAo3SavedFiltersV1[0].serverId, "00000000-0000-4000-8000-000000000002");
  assert.equal(h.store.traceAo3SavedFiltersV1[0].scope, "global");
});

test("syncAo3SavedFilters sends delete tombstones and clears them after server ack", async () => {
  const h = createBackgroundHarness({
    storageState: {
      traceAo3SavedFiltersDeletedV1: [
        {
          id: "preset-a",
          clientId: "preset-a",
          serverId: "00000000-0000-4000-8000-000000000003",
          clientUpdatedAt: "2026-06-18T10:06:00.000Z",
        },
      ],
      traceAo3SavedFiltersSyncV1: {
        syncVersion: "2026-06-18T10:00:00.000Z",
      },
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.upserts, []);
      assert.equal(body.deletes.length, 1);
      assert.equal(body.deletes[0].id, "00000000-0000-4000-8000-000000000003");
      assert.equal(body.deletes[0].clientId, "preset-a");
      return createResponse({
        json: {
          success: true,
          data: {
            serverTime: "2026-06-18T10:06:01.000Z",
            syncVersion: "2026-06-18T10:06:01.000Z",
            presets: [],
            deleted: [
              {
                id: "00000000-0000-4000-8000-000000000003",
                clientId: "preset-a",
                deletedAt: "2026-06-18T10:06:01.000Z",
                updatedAt: "2026-06-18T10:06:01.000Z",
                clientUpdatedAt: "2026-06-18T10:06:00.000Z",
              },
            ],
          },
        },
      });
    },
  });
  h.hooks.setBearerToken("token-filters");

  await h.hooks.syncAo3SavedFilters();

  assert.deepEqual(plainJson(h.store.traceAo3SavedFiltersV1), []);
  assert.deepEqual(plainJson(h.store.traceAo3SavedFiltersDeletedV1), []);
});

test("TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST queues only when signed in", async () => {
  const h = createBackgroundHarness();

  const signedOut = await h.dispatchMessage({
    type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST",
  });
  assert.deepEqual(plainJson(signedOut), { ok: true, queued: false });

  h.hooks.setBearerToken("token-filters");
  const signedIn = await h.dispatchMessage({
    type: "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST",
  });
  assert.deepEqual(plainJson(signedIn), { ok: true, queued: true });
  assert.equal(h.timers.length, 1);
});

test("TRACE_POPUP_GET_STATE includes local activation and active tab context", async () => {
  const connected = {
    state: "connected",
    message: "Connected",
    helpUrl: "https://tracefiction.com/",
  };
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-popup",
      traceAuthState: connected,
      traceFirstSaveSeen: false,
      prefAo3SavedFiltersEnabled: false,
    },
    activeTabs: [
      { id: 23, url: "https://archiveofourown.org/works/12345/chapters/67890" },
    ],
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: true, library_count: 0 } });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-popup");

  const response = await h.dispatchMessage({ type: "TRACE_POPUP_GET_STATE" });

  assert.equal(response.pro, true);
  assert.equal(response.firstSaveSeen, false);
  assert.equal(response.libraryCount, 0);
  assert.deepEqual(plainJson(response.activeTab), {
    kind: "supported_story",
    site: "ao3",
    canImport: true,
  });
  assert.equal(response.autoTrackEnabled, true);
  assert.equal(response.libraryInlayEnabled, true);
  assert.equal(response.ao3SavedFiltersEnabled, false);
  assert.equal(response.metadataImproveEnabled, true);
});

test("TRACE_EXTENSION_STATUS_QUERY returns connected state without private fields", async () => {
  const h = createBackgroundHarness();
  h.hooks.setBearerToken("token-status-handshake");
  h.hooks.setVerifiedBearerToken("token-status-handshake");
  h.store.authToken = "token-status-handshake";
  h.store.traceAuthState = {
    state: "connected",
    message: "Extension connected to your Trace account.",
    helpUrl: "https://tracefiction.com/",
    lastTokenSyncAt: "2026-05-01T12:00:00.000Z",
    authVerificationVersion: 1,
    accountVerifiedAt: "2026-05-01T12:00:01.000Z",
    firstSaveSeen: true,
    userId: "user-should-not-leak",
  };
  h.store.traceFirstSaveSeen = true;

  const response = await h.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-connected",
  });

  assert.deepEqual(plainJson(response), {
    installed: true,
    connected: true,
    authState: "connected",
    firstSaveSeen: true,
    browserKind: "unknown",
    lastTokenSyncAt: Date.parse("2026-05-01T12:00:00.000Z"),
  });
  assert.equal(Object.prototype.hasOwnProperty.call(response, "authToken"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "userId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "message"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "helpUrl"), false);
});

test("TRACE_EXTENSION_STATUS_QUERY returns only coarse archive readiness fields", async () => {
  const h = createBackgroundHarness();
  h.hooks.setBearerToken("token-status-handshake");
  h.hooks.setVerifiedBearerToken("token-status-handshake");
  h.store.authToken = "token-status-handshake";
  h.store.traceAuthState = {
    state: "connected",
    message: "Extension connected to your Trace account.",
    authVerificationVersion: 1,
    accountVerifiedAt: "2026-05-01T12:00:01.000Z",
  };
  h.store.traceArchiveReadiness = {
    lastArchiveSeenAt: Date.parse("2026-05-01T12:00:00.000Z"),
    lastArchiveHostKind: "ao3",
    lastArchiveActionAt: Date.parse("2026-05-01T12:01:00.000Z"),
    lastArchiveActionKind: "quick_add",
    lastArchiveErrorAt: Date.now(),
    lastArchiveErrorKind: "parser",
    url: "https://archiveofourown.org/works/123",
    title: "must not leak",
    sourceId: "ao3:123",
    notes: "must not leak",
    rawError: "selector .private failed",
  };

  const response = await h.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-archive",
  });

  assert.deepEqual(plainJson(response), {
    installed: true,
    connected: true,
    authState: "connected",
    firstSaveSeen: false,
    browserKind: "unknown",
    lastArchiveSeenAt: Date.parse("2026-05-01T12:00:00.000Z"),
    lastArchiveHostKind: "ao3",
    lastArchiveActionAt: Date.parse("2026-05-01T12:01:00.000Z"),
    lastArchiveActionKind: "quick_add",
    lastArchiveErrorKind: "parser",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(response, "url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "title"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "sourceId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "notes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "rawError"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(response, "lastArchiveErrorAt"),
    false,
  );
});

test("TRACE_EXTENSION_STATUS_QUERY ignores invalid archive readiness fields", async () => {
  const h = createBackgroundHarness();
  h.hooks.setBearerToken("token-status-handshake");
  h.hooks.setVerifiedBearerToken("token-status-handshake");
  h.store.authToken = "token-status-handshake";
  h.store.traceAuthState = {
    state: "connected",
    authVerificationVersion: 1,
    accountVerifiedAt: "2026-05-01T12:00:01.000Z",
  };
  h.store.traceArchiveReadiness = {
    lastArchiveSeenAt: "not-a-date",
    lastArchiveHostKind: "archiveofourown.org",
    lastArchiveActionAt: Number.NaN,
    lastArchiveActionKind: "story_title",
    lastArchiveErrorAt: Date.now(),
    lastArchiveErrorKind: "raw_selector_failure",
  };

  const response = await h.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-invalid-archive",
  });

  assert.deepEqual(plainJson(response), {
    installed: true,
    connected: true,
    authState: "connected",
    firstSaveSeen: false,
    browserKind: "unknown",
  });
});

test("TRACE_EXTENSION_STATUS_QUERY does not trust legacy stored connected state", async () => {
  const h = createBackgroundHarness();
  h.hooks.setBearerToken("legacy-token");
  h.store.authToken = "legacy-token";
  h.store.traceAuthState = {
    state: "connected",
    message: "Connected by old token receipt flow.",
    lastTokenSyncAt: "2026-05-01T12:00:00.000Z",
  };

  const response = await h.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-legacy-connected",
  });

  assert.deepEqual(plainJson(response), {
    installed: true,
    connected: false,
    authState: "unknown",
    firstSaveSeen: false,
    browserKind: "unknown",
    lastTokenSyncAt: Date.parse("2026-05-01T12:00:00.000Z"),
  });
});

test("TRACE_EXTENSION_STATUS_QUERY returns signed-out state", async () => {
  const h = createBackgroundHarness();

  const response = await h.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-signed-out",
  });

  assert.deepEqual(plainJson(response), {
    installed: true,
    connected: false,
    authState: "signed_out",
    firstSaveSeen: false,
    browserKind: "unknown",
  });
});

test("TRACE_EXTENSION_STATUS_QUERY returns reconnect and error states", async () => {
  const reconnect = createBackgroundHarness();
  reconnect.store.traceAuthState = {
    state: "reconnect_required",
    message: "Open Trace and sign in again.",
    lastHttpStatus: 401,
  };
  const reconnectResponse = await reconnect.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-reconnect",
  });
  assert.deepEqual(plainJson(reconnectResponse), {
    installed: true,
    connected: false,
    authState: "reconnect_required",
    firstSaveSeen: false,
    browserKind: "unknown",
  });

  const errored = createBackgroundHarness();
  errored.store.traceAuthState = {
    state: "error",
    message: "Trace could not load extension storage.",
  };
  const errorResponse = await errored.dispatchMessage({
    type: "TRACE_EXTENSION_STATUS_QUERY",
    nonce: "nonce-error",
  });
  assert.deepEqual(plainJson(errorResponse), {
    installed: true,
    connected: false,
    authState: "error",
    firstSaveSeen: false,
    browserKind: "unknown",
  });
});

test("TRACE_EXTENSION_STATUS_QUERY ignores missing or invalid nonces", async () => {
  const h = createBackgroundHarness();

  assert.equal(
    await h.dispatchMessage({ type: "TRACE_EXTENSION_STATUS_QUERY" }),
    undefined,
  );
  assert.equal(
    await h.dispatchMessage({ type: "TRACE_EXTENSION_STATUS_QUERY", nonce: "" }),
    undefined,
  );
  assert.equal(
    await h.dispatchMessage({ type: "TRACE_EXTENSION_STATUS_QUERY", nonce: "   " }),
    undefined,
  );
});

test("onInstalled opens the activation URL only for first install", async () => {
  const h = createBackgroundHarness({
    webOrigin: "https://tracefiction.com",
  });

  assert.equal(typeof h.onInstalledListener, "function");
  h.onInstalledListener({ reason: "install" });
  await flush();
  assert.deepEqual(plainJson(h.createdTabs), [
    {
      url: "https://tracefiction.com/?activation=extension-installed",
      active: true,
    },
  ]);
  assert.deepEqual(plainJson(h.updatedTabs), []);

  h.createdTabs.length = 0;
  h.onInstalledListener({ reason: "update" });
  await flush();
  assert.deepEqual(plainJson(h.createdTabs), []);
  assert.deepEqual(plainJson(h.updatedTabs), []);
});

test("onInstalled reuses an existing Trace tab for activation", async () => {
  const h = createBackgroundHarness({
    webOrigin: "https://tracefiction.com",
    activeTabs: [
      { id: 44, url: "https://tracefiction.com/?panel=add", active: false },
      { id: 55, url: "https://example.com/", active: true },
    ],
  });

  assert.equal(typeof h.onInstalledListener, "function");
  h.onInstalledListener({ reason: "install" });
  await flush();

  assert.deepEqual(plainJson(h.createdTabs), []);
  assert.deepEqual(plainJson(h.updatedTabs), [
    {
      tabId: 44,
      args: {
        url: "https://tracefiction.com/?activation=extension-installed",
        active: true,
      },
    },
  ]);
});

test("TRACE_FIRST_STORY_ADD rejects unsupported URLs without opening a tab", async () => {
  const h = createBackgroundHarness();
  h.hooks.setBearerToken("token-first-story");

  for (const url of [
    "https://archiveofourown.org/users/example/bookmarks",
    "https://example.com/works/123",
    "not a url",
  ]) {
    const response = await h.dispatchMessage({
      type: "TRACE_FIRST_STORY_ADD",
      nonce: "nonce-invalid",
      url,
    });
    assert.deepEqual(plainJson(response), { ok: false, error: "invalid_url" });
  }
  assert.deepEqual(plainJson(h.createdTabs), []);
});

test("TRACE_FIRST_STORY_ADD requires an authenticated Trace session", async () => {
  const h = createBackgroundHarness();

  const response = await h.dispatchMessage({
    type: "TRACE_FIRST_STORY_ADD",
    nonce: "nonce-auth",
    url: "https://archiveofourown.org/works/123",
  });

  assert.deepEqual(plainJson(response), {
    ok: false,
    error: "not_authenticated",
  });
  assert.deepEqual(plainJson(h.createdTabs), []);
});

test("TRACE_FIRST_STORY_ADD opens supported archive URLs and dispatches focus-add", async () => {
  const sentMessages = [];
  const h = createBackgroundHarness({
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true, state: "saved" };
    },
  });
  h.hooks.setBearerToken("token-first-story");

  const response = await h.dispatchMessage({
    type: "TRACE_FIRST_STORY_ADD",
    nonce: "nonce-ao3",
    url: "https://archiveofourown.org/works/123/chapters/456",
  });

  assert.deepEqual(plainJson(response), { ok: true, state: "saved" });
  assert.deepEqual(plainJson(h.createdTabs), [
    {
      url: "https://archiveofourown.org/works/123/chapters/456",
      active: true,
    },
  ]);
  assert.deepEqual(plainJson(sentMessages), [
    {
      tabId: 101,
      msg: { type: "TRACE_FIRST_STORY_FOCUS_ADD" },
    },
  ]);
});

test("TRACE_FIRST_STORY_ADD supports FanFiction.net story chapters", async () => {
  const sentMessages = [];
  const h = createBackgroundHarness({
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true, state: "saved" };
    },
  });
  h.hooks.setBearerToken("token-first-story");

  const response = await h.dispatchMessage({
    type: "TRACE_FIRST_STORY_ADD",
    nonce: "nonce-ffn",
    url: "https://www.fanfiction.net/s/123/2/Story-Title",
  });

  assert.deepEqual(plainJson(response), { ok: true, state: "saved" });
  assert.deepEqual(plainJson(h.createdTabs), [
    {
      url: "https://www.fanfiction.net/s/123/2/Story-Title",
      active: true,
    },
  ]);
  assert.deepEqual(plainJson(sentMessages), [
    {
      tabId: 101,
      msg: { type: "TRACE_FIRST_STORY_FOCUS_ADD" },
    },
  ]);
});

test("AO3 tab completion pings the collector to schedule auto-track", async () => {
  const sentMessages = [];
  const h = createBackgroundHarness({
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true };
    },
  });

  assert.equal(typeof h.onTabUpdatedListener, "function");
  h.onTabUpdatedListener(
    77,
    { status: "complete" },
    { id: 77, url: "https://archiveofourown.org/works/10404927/chapters/24829887#workskin" },
  );
  h.runTimers();
  await flush();

  assert.deepEqual(plainJson(sentMessages), [
    {
      tabId: 77,
      msg: {
        type: "TRACE_SCHEDULE_AUTO_TRACK",
        trigger: "background_tab_complete",
      },
    },
  ]);
});

test("TRACE_POPUP_OPEN heals stale error state when token still exists", async () => {
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-2",
      traceAuthState: { state: "error", message: "stale error" },
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: true } });
      }
      return createResponse({ ok: false, status: 403 });
    },
  });

  const response = await h.dispatchMessage({ type: "TRACE_POPUP_OPEN" });
  await flush();

  assert.deepEqual(plainJson(response), { ok: true });
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.store.traceUserPro, true);
});

test("TRACE_OPEN_TRACE_URL opens validated Trace URLs in a browser tab", async () => {
  const h = createBackgroundHarness({
    webOrigin: "http://localhost:5173",
  });

  const response = await h.dispatchMessage({
    type: "TRACE_OPEN_TRACE_URL",
    payload: {
      url: "http://localhost:5173/?panel=details&entryId=00000000-0000-4000-8000-000000000123",
    },
  });

  assert.deepEqual(plainJson(response), { ok: true });
  assert.deepEqual(plainJson(h.createdTabs), [
    {
      url: "http://localhost:5173/?panel=details&entryId=00000000-0000-4000-8000-000000000123",
    },
  ]);
});

test("TRACE_OPEN_TRACE_URL rejects non-Trace URLs", async () => {
  const h = createBackgroundHarness({
    webOrigin: "https://tracefiction.com",
  });

  const response = await h.dispatchMessage({
    type: "TRACE_OPEN_TRACE_URL",
    payload: { url: "https://example.com/?panel=details" },
  });

  assert.deepEqual(plainJson(response), { ok: false, error: "invalid_trace_url" });
  assert.deepEqual(plainJson(h.createdTabs), []);
});

test("handleAutoTrack without a token keeps first-install popup state signed out", async () => {
  const h = createBackgroundHarness();

  const response = await new Promise((resolve) => {
    h.hooks.handleAutoTrack(
      { s: "ffn", item: { t: "A Story", u: "https://www.fanfiction.net/s/1/" } },
      { tab: { id: 33 } },
      resolve,
    );
  });

  assert.deepEqual(plainJson(response), { ok: false, error: "not_authenticated" });
  assert.equal(h.store.traceAuthState.state, "signed_out");
  assert.match(h.store.traceAuthState.message, /automatic sync will work/i);
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "LOG", tabId: 33 });
});

test("shouldIgnoreSenderForAutoTrack ignores prerendered or subframe senders", () => {
  const h = createBackgroundHarness();

  assert.equal(
    h.hooks.shouldIgnoreSenderForAutoTrack({ tab: { id: 34 }, frameId: 2 }),
    true,
  );
  assert.equal(
    h.hooks.shouldIgnoreSenderForAutoTrack({
      tab: { id: 35 },
      frameId: 0,
      documentLifecycle: "prerender",
    }),
    true,
  );
  assert.equal(
    h.hooks.shouldIgnoreSenderForAutoTrack({
      tab: { id: 36 },
      frameId: 0,
      documentLifecycle: "active",
    }),
    false,
  );
});

test("executeAutoTrack 401 clears token and asks user to reconnect", async () => {
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-3",
      traceUserPro: true,
      libraryOverlayCache: { entries: {} },
    },
    fetchImpl: async () => createResponse({ ok: false, status: 401 }),
  });
  h.hooks.setBearerToken("token-3");

  await h.hooks.executeAutoTrack(
    { s: "ao3", item: { t: "Redivider", u: "https://archiveofourown.org/works/1" } },
    { tab: { id: 44 } },
  );

  assert.equal(h.hooks.getBearerToken(), null);
  assert.equal(h.store.authToken, undefined);
  assert.equal(h.store.traceAuthState.state, "reconnect_required");
  assert.equal(h.store.traceAuthState.lastHttpStatus, 401);
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "LOG", tabId: 44 });
});

test("executeAutoTrack 402 keeps session and shows library full", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-4" },
    fetchImpl: async () => createResponse({ ok: false, status: 402 }),
  });
  h.hooks.setBearerToken("token-4");

  await h.hooks.executeAutoTrack(
    { s: "ffn", item: { t: "Story", u: "https://www.fanfiction.net/s/2/" } },
    { tab: { id: 55 } },
  );

  assert.equal(h.hooks.getBearerToken(), "token-4");
  assert.equal(h.store.authToken, "token-4");
  assert.equal(h.store.traceAuthState.state, "upgrade_required");
  assert.equal(h.store.traceAuthState.lastHttpStatus, 402);
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "FULL", tabId: 55 });
});

test("executeAutoTrack network failure keeps manual import available", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-5" },
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  h.hooks.setBearerToken("token-5");

  await h.hooks.executeAutoTrack(
    { s: "ao3", item: { t: "Story", u: "https://archiveofourown.org/works/2" } },
    { tab: { id: 66 } },
  );

  assert.equal(h.store.traceAuthState.state, "connected");
  assert.match(h.store.traceAuthState.message, /couldn’t reach trace/i);
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "!", tabId: 66 });
});

test("executeAutoTrack success refreshes overlay cache immediately", async () => {
  const sentMessages = [];
  const h = createBackgroundHarness({
    storageState: { authToken: "token-6" },
    activeTabs: [
      { id: 67, url: "https://archiveofourown.org/works/2" },
      { id: 91, url: "https://tracefiction.com/library" },
    ],
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true };
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: false, library_count: 1 } });
      }
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({ json: { success: true, data: { entry_id: "e-track", type: "updated" } } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: {
            success: true,
            data: {
              entries: { "ao3:2": { status: "READING", chapters: { current: 2, total: 17 } } },
              syncVersion: "v-track",
            },
          },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-6");

  await h.hooks.executeAutoTrack(
    { s: "ao3", item: { t: "Story", u: "https://archiveofourown.org/works/2" } },
    { tab: { id: 67 } },
  );

  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.store.traceAuthState.firstSaveSeen, true);
  assert.equal(h.store.traceFirstSaveSeen, true);
  assert.equal(h.store.libraryOverlayCache.syncVersion, "v-track");
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "OK", tabId: 67 });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].tabId, 91);
  assert.equal(sentMessages[0].msg.type, "TRACE_LIBRARY_INVALIDATED");
  assert.equal(sentMessages[0].msg.reason, "track");
  assert.match(String(sentMessages[0].msg.at || ""), /^\d{4}-\d{2}-\d{2}T/);
});

test("handleMetadataBroadcast posts by default for signed-in users", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-meta-1" },
    fetchImpl: async () => createResponse({ json: { success: true } }),
  });
  h.hooks.setBearerToken("token-meta-1");

  await h.hooks.handleMetadataBroadcast(
    { s: "ao3", item: { t: "Story", u: "https://archiveofourown.org/works/3" } },
    { tab: { id: 71 } },
  );

  const metadataCalls = h.fetchCalls.filter((call) =>
    /\/api\/extension\/metadata$/.test(String(call.url)),
  );
  assert.equal(metadataCalls.length, 1);
});

test("handleMetadataBroadcast respects disabled metadata improvement pref", async () => {
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-meta-2",
      prefMetadataImproveEnabled: false,
    },
    fetchImpl: async () => createResponse({ json: { success: true } }),
  });
  h.hooks.setBearerToken("token-meta-2");

  await h.hooks.handleMetadataBroadcast(
    { s: "ffn", item: { t: "Story", u: "https://www.fanfiction.net/s/3/" } },
    { tab: { id: 72 } },
  );

  const metadataCalls = h.fetchCalls.filter((call) =>
    /\/api\/extension\/metadata$/.test(String(call.url)),
  );
  assert.equal(metadataCalls.length, 0);
});

test("handleLibraryMetadataRefresh posts tracked listing metadata and invalidates on update", async () => {
  const sentMessages = [];
  const h = createBackgroundHarness({
    storageState: { authToken: "token-refresh-1" },
    activeTabs: [{ id: 91, url: "https://tracefiction.com/library" }],
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true };
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/extension/library/metadata-refresh")) {
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, "Bearer token-refresh-1");
        assert.deepEqual(JSON.parse(init.body), {
          items: [
            {
              source: "ffn",
              sourceStoryId: "7654321",
              summary: "Listing summary",
            },
          ],
        });
        return createResponse({
          json: {
            success: true,
            data: { updated: 1, ignored: 0 },
          },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-refresh-1");

  await h.hooks.handleLibraryMetadataRefresh(
    {
      items: [
        {
          source: "ffn",
          sourceStoryId: "7654321",
          summary: "Listing summary",
        },
      ],
    },
    { tab: { id: 91 } },
  );

  const refreshCalls = h.fetchCalls.filter((call) =>
    /\/api\/extension\/library\/metadata-refresh$/.test(String(call.url)),
  );
  assert.equal(refreshCalls.length, 1);
  await flush();
  assert.equal(h.store.traceArchiveReadiness.lastArchiveHostKind, "ffn");
  assert.equal(h.store.traceArchiveReadiness.lastArchiveActionKind, "metadata");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].tabId, 91);
  assert.equal(sentMessages[0].msg.type, "TRACE_LIBRARY_INVALIDATED");
  assert.equal(sentMessages[0].msg.reason, "metadata");
});

test("handleLibraryMetadataRefresh respects disabled metadata improvement pref", async () => {
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-refresh-2",
      prefMetadataImproveEnabled: false,
    },
    fetchImpl: async () => createResponse({ json: { success: true } }),
  });
  h.hooks.setBearerToken("token-refresh-2");

  await h.hooks.handleLibraryMetadataRefresh(
    {
      items: [
        {
          source: "ffn",
          sourceStoryId: "7654321",
          summary: "Listing summary",
        },
      ],
    },
    { tab: { id: 92 } },
  );

  const refreshCalls = h.fetchCalls.filter((call) =>
    /\/api\/extension\/library\/metadata-refresh$/.test(String(call.url)),
  );
  assert.equal(refreshCalls.length, 0);
});

// =======================================================
// Quick-add (TRACE_QUICK_ADD)
// =======================================================

test("TRACE_QUICK_ADD returns ok and refreshes overlay on success", async () => {
  const sentMessages = [];
  const h = createBackgroundHarness({
    storageState: { authToken: "token-qa1" },
    activeTabs: [{ id: 77, url: "https://tracefiction.com/library" }],
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true };
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({ json: { success: true, data: { entry_id: "e1", type: "created" } } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({ json: { success: true, data: { entries: {}, syncVersion: "v1" } } });
      }
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: false } });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-qa1");

  const response = await h.hooks.handleQuickAdd(
    { s: "ao3", at: new Date().toISOString(), item: { t: "Test", u: "https://archiveofourown.org/works/99" } },
    { tab: { id: 77 } },
    (res) => res,
  );

  // dispatchMessage is cleaner for testing async responses
  const msgResponse = await h.dispatchMessage(
    {
      type: "TRACE_QUICK_ADD",
      payload: { s: "ao3", at: new Date().toISOString(), item: { t: "Test", u: "https://archiveofourown.org/works/99" } },
    },
    { tab: { id: 77 } },
  );

  assert.equal(msgResponse.ok, true);
  assert.equal(msgResponse.entryId, "e1");
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.store.traceAuthState.firstSaveSeen, true);
  assert.equal(h.store.traceFirstSaveSeen, true);
  assert.ok(h.store.traceAuthState.lastQuickAddAt);
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "OK", tabId: 77 });
  assert.equal(sentMessages.length >= 1, true);
  assert.equal(sentMessages.at(-1).tabId, 77);
  assert.equal(sentMessages.at(-1).msg.type, "TRACE_LIBRARY_INVALIDATED");
  assert.equal(sentMessages.at(-1).msg.reason, "quick_add");
  assert.match(String(sentMessages.at(-1).msg.at || ""), /^\d{4}-\d{2}-\d{2}T/);
});

test("TRACE_QUICK_ADD stores authoritative account-scoped work state and overlay entry", async () => {
  const entry = {
    status: "PLANNING",
    readerStatus: "PLANNING",
    canonicalReaderStatus: "SAVED",
    entryId: "00000000-0000-4000-8000-000000000099",
  };
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-state-quick",
      traceAccountId: "acct-state",
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({
          json: {
            success: true,
            data: {
              entry_id: entry.entryId,
              type: "created",
              work_key: "ao3:99",
              entry,
              syncVersion: "2026-07-10T01:00:00.000Z",
            },
          },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: {
            success: true,
            data: {
              entries: { "ao3:99": entry },
              syncVersion: "2026-07-10T01:00:00.000Z",
            },
          },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-state-quick");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_QUICK_ADD",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: {
          src: "ao3",
          t: "Test",
          u: "https://archiveofourown.org/works/99",
        },
      },
    },
    { tab: { id: 77 } },
  );

  assert.equal(response.ok, true);
  assert.equal(response.entryId, entry.entryId);
  assert.equal(response.state.status, "saved");
  assert.equal(response.state.accountId, "acct-state");
  assert.equal(response.state.workKey, "ao3:99");
  assert.equal(response.state.entry.entryId, entry.entryId);
  assert.equal(h.store.libraryOverlayCache.entries["ao3:99"].entryId, entry.entryId);

  const queried = await h.dispatchMessage({
    type: "TRACE_WORK_STATE_GET",
    workKey: "ao3:99",
  });
  assert.equal(queried.ok, true);
  assert.equal(queried.state.status, "saved");
  assert.equal(queried.state.entryId, entry.entryId);
});

test("TRACE_QUICK_ADD returns free_limit_reached on 402", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-qa2" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({ ok: false, status: 402, json: { code: "FREE_LIMIT_REACHED" } });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-qa2");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_QUICK_ADD",
      payload: { s: "ao3", at: new Date().toISOString(), item: { t: "Test", u: "https://archiveofourown.org/works/100" } },
    },
    { tab: { id: 88 } },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "free_limit_reached");
  assert.equal(h.hooks.getBearerToken(), "token-qa2"); // session preserved
});

test("TRACE_QUICK_ADD without token returns not_authenticated", async () => {
  const h = createBackgroundHarness();
  // No token set

  const response = await h.dispatchMessage(
    {
      type: "TRACE_QUICK_ADD",
      payload: { s: "ao3", at: new Date().toISOString(), item: { t: "Test", u: "https://archiveofourown.org/works/101" } },
    },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "not_authenticated");
});

test("TRACE_QUICK_ADD bootstraps iOS native auth before first-story quick add", async () => {
  const h = createBackgroundHarness({
    sendNativeMessageImpl(message, callback) {
      if (
        message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST" &&
        message.reason === "quick_add"
      ) {
        callback({ ok: true, token: "native-quick-token" });
        return;
      }
      callback({ ok: false, error: "missing_token" });
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/account/me")) {
        assert.equal(init.headers.Authorization, "Bearer native-quick-token");
        return createResponse({ json: { pro: false, library_count: 0 } });
      }
      if (String(url).endsWith("/api/extension/track")) {
        assert.equal(init.headers.Authorization, "Bearer native-quick-token");
        return createResponse({
          json: {
            success: true,
            data: { entry_id: "entry-quick-native", type: "created" },
          },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "quick-native-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });

  const response = await h.dispatchMessage(
    {
      type: "TRACE_QUICK_ADD",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Test", u: "https://archiveofourown.org/works/102" },
      },
    },
    { tab: { id: 89 } },
  );

  assert.deepEqual(plainJson(response), {
    ok: true,
    entryId: "entry-quick-native",
  });
  assert.equal(h.hooks.getBearerToken(), "native-quick-token");
  assert.equal(h.store.traceFirstSaveSeen, true);
  assert.ok(
    h.nativeMessages.some(
      (args) => plainJson(args[0]).reason === "quick_add",
    ),
  );
});

test("TRACE_QUICK_ADD retries with iOS native auth after a stale stored token", async () => {
  let trackCalls = 0;
  const h = createBackgroundHarness({
    sendNativeMessageImpl(message, callback) {
      if (
        message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST" &&
        message.reason === "quick_add_auth_failure"
      ) {
        callback({ ok: true, token: "native-quick-fresh-token" });
        return;
      }
      callback({ ok: false, error: "missing_token" });
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/account/me")) {
        assert.equal(
          init.headers.Authorization,
          "Bearer native-quick-fresh-token",
        );
        return createResponse({ json: { pro: false, library_count: 0 } });
      }
      if (String(url).endsWith("/api/extension/track")) {
        trackCalls += 1;
        if (trackCalls === 1) {
          assert.equal(init.headers.Authorization, "Bearer stale-quick-token");
          return createResponse({ ok: false, status: 401 });
        }
        assert.equal(
          init.headers.Authorization,
          "Bearer native-quick-fresh-token",
        );
        return createResponse({
          json: {
            success: true,
            data: { entry_id: "entry-quick-retry", type: "created" },
          },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "quick-retry-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("stale-quick-token");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_QUICK_ADD",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Test", u: "https://archiveofourown.org/works/103" },
      },
    },
    { tab: { id: 90 } },
  );

  assert.deepEqual(plainJson(response), {
    ok: true,
    entryId: "entry-quick-retry",
  });
  assert.equal(trackCalls, 2);
  assert.equal(h.hooks.getBearerToken(), "native-quick-fresh-token");
  assert.ok(
    h.nativeMessages.some(
      (args) => plainJson(args[0]).reason === "quick_add_auth_failure",
    ),
  );
});

// =======================================================
// Reading status choices (TRACE_SET_READER_STATUS)
// =======================================================

test("TRACE_SET_READER_STATUS patches library entry status and overlay cache", async () => {
  const entryId = "00000000-0000-4000-8000-000000000123";
  const sentMessages = [];
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-status-1",
      libraryOverlayCache: {
        entries: {
          "ao3:123": {
            entryId,
            status: "PLANNING",
            readerStatus: "PLANNING",
            chapters: { current: 0, total: 17 },
          },
        },
        syncVersion: "v-before",
      },
    },
    activeTabs: [{ id: 90, url: "https://tracefiction.com/library" }],
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true };
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith(`/api/library/${entryId}`)) {
        assert.equal(init.method, "PATCH");
        assert.equal(init.headers.Authorization, "Bearer token-status-1");
        assert.deepEqual(JSON.parse(init.body), {
          status: "READING",
          progress: { unit: "CHAPTER", value: 1, total: 17 },
        });
        return createResponse({ json: { data: { entry_id: entryId } } });
      }
      if (String(url).endsWith("/api/account/me")) {
        return createResponse({ json: { pro: false } });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-status-1");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_SET_READER_STATUS",
      payload: {
        entryId,
        status: "READING",
        progress: { unit: "CHAPTER", value: 1, total: 17 },
      },
    },
    { tab: { id: 90 } },
  );

  assert.equal(response.ok, true);
  assert.equal(response.entryId, entryId);
  assert.equal(response.status, "READING");
  assert.equal(response.workKey, "ao3:123");
  assert.equal(h.store.libraryOverlayCache.entries["ao3:123"].status, "READING");
  assert.equal(h.store.libraryOverlayCache.entries["ao3:123"].readerStatus, "READING");
  assert.deepEqual(plainJson(h.store.libraryOverlayCache.entries["ao3:123"].chapters), { current: 1, total: 17 });
  assert.match(h.store.libraryOverlayCache.syncVersion, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(sentMessages.at(-1).msg.type, "TRACE_LIBRARY_INVALIDATED");
  assert.equal(sentMessages.at(-1).msg.reason, "reader_status");
});

test("TRACE_SET_READER_STATUS handles validation and auth failures", async () => {
  const noToken = createBackgroundHarness();
  const notAuthenticated = await noToken.dispatchMessage({
    type: "TRACE_SET_READER_STATUS",
    payload: { entryId: "00000000-0000-4000-8000-000000000123", status: "READING" },
  });
  assert.equal(notAuthenticated.ok, false);
  assert.equal(notAuthenticated.error, "not_authenticated");

  const invalid = createBackgroundHarness({ storageState: { authToken: "token-status-2" } });
  invalid.hooks.setBearerToken("token-status-2");
  const invalidResponse = await invalid.dispatchMessage({
    type: "TRACE_SET_READER_STATUS",
    payload: { entryId: "not-a-uuid", status: "DROPPED" },
  });
  assert.equal(invalidResponse.ok, false);
  assert.equal(invalidResponse.error, "invalid_request");

  const expired = createBackgroundHarness({
    storageState: { authToken: "token-status-3" },
    fetchImpl: async (url) => {
      if (String(url).includes("/api/library/")) {
        return createResponse({ ok: false, status: 401 });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  expired.hooks.setBearerToken("token-status-3");
  const expiredResponse = await expired.dispatchMessage({
    type: "TRACE_SET_READER_STATUS",
    payload: { entryId: "00000000-0000-4000-8000-000000000123", status: "COMPLETED" },
  });
  assert.equal(expiredResponse.ok, false);
  assert.equal(expiredResponse.error, "auth_expired");
  assert.equal(expired.hooks.getBearerToken(), null);
  assert.equal(expired.store.traceAuthState.state, "reconnect_required");
  assert.equal(expired.store.traceAuthState.helpUrl, "https://tracefiction.com/");
});

// =======================================================
// Hidden work preferences (TRACE_SET_HIDDEN_WORK)
// =======================================================

test("TRACE_SET_HIDDEN_WORK posts hidden preference and patches overlay cache", async () => {
  const sentMessages = [];
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-hide-1",
      libraryOverlayCache: {
        entries: {
          "ao3:123": {
            status: "READING",
            chapters: { current: 3, total: 17 },
          },
        },
        syncVersion: "v-before",
      },
    },
    activeTabs: [{ id: 91, url: "https://tracefiction.com/library" }],
    sendMessageImpl: async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return { ok: true };
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/extension/work-preferences")) {
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, "Bearer token-hide-1");
        assert.deepEqual(JSON.parse(init.body), { key: "ao3:123", hidden: true });
        return createResponse({
          json: {
            success: true,
            data: {
              key: "ao3:123",
              browsePreference: { hidden: true },
            },
          },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-hide-1");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_SET_HIDDEN_WORK",
      payload: { key: "ao3:123", hidden: true },
    },
    { tab: { id: 88 } },
  );

  assert.deepEqual(plainJson(response), {
    ok: true,
    key: "ao3:123",
    hidden: true,
  });
  assert.equal(
    h.store.libraryOverlayCache.entries["ao3:123"].browsePreference.hidden,
    true,
  );
  assert.equal(
    h.store.libraryOverlayCache.workPreferences["ao3:123"].browsePreference.hidden,
    true,
  );
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "HID", tabId: 88 });
  assert.equal(sentMessages.at(-1).msg.type, "TRACE_LIBRARY_INVALIDATED");
  assert.equal(sentMessages.at(-1).msg.reason, "work_preference");
});

test("TRACE_SET_HIDDEN_WORK clears hidden preference from overlay cache", async () => {
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-hide-2",
      libraryOverlayCache: {
        entries: {
          "ffn:456": {
            status: "READING",
            browsePreference: { hidden: true },
          },
        },
        workPreferences: {
          "ffn:456": { browsePreference: { hidden: true } },
        },
        syncVersion: "v-before",
      },
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/extension/work-preferences")) {
        assert.deepEqual(JSON.parse(init.body), { key: "ffn:456", hidden: false });
        return createResponse({ json: { success: true } });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-hide-2");

  const response = await h.dispatchMessage({
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ffn:456", hidden: false },
  });

  assert.equal(response.ok, true);
  assert.equal(response.hidden, false);
  assert.equal(h.store.libraryOverlayCache.entries["ffn:456"].browsePreference, undefined);
  assert.equal(h.store.libraryOverlayCache.workPreferences["ffn:456"], undefined);
});

test("TRACE_SET_HIDDEN_WORK handles auth, validation, and rate-limit failures", async () => {
  const noAuth = createBackgroundHarness();
  assert.deepEqual(
    plainJson(
      await noAuth.dispatchMessage({
        type: "TRACE_SET_HIDDEN_WORK",
        payload: { key: "ao3:123", hidden: true },
      }),
    ),
    { ok: false, error: "not_authenticated" },
  );

  const invalid = createBackgroundHarness({ storageState: { authToken: "token-hide-3" } });
  invalid.hooks.setBearerToken("token-hide-3");
  assert.deepEqual(
    plainJson(
      await invalid.dispatchMessage({
        type: "TRACE_SET_HIDDEN_WORK",
        payload: { key: "bad-key", hidden: true },
      }),
    ),
    { ok: false, error: "invalid_request" },
  );

  const rateLimited = createBackgroundHarness({
    storageState: { authToken: "token-hide-4" },
    fetchImpl: async () => createResponse({ ok: false, status: 429 }),
  });
  rateLimited.hooks.setBearerToken("token-hide-4");
  const rateResponse = await rateLimited.dispatchMessage({
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ao3:123", hidden: true },
  });
  assert.equal(rateResponse.ok, false);
  assert.equal(rateResponse.error, "rate_limited");
  assert.equal(rateLimited.store.traceAuthState.lastHttpStatus, 429);

  const expired = createBackgroundHarness({
    storageState: { authToken: "token-hide-5" },
    fetchImpl: async () => createResponse({ ok: false, status: 401 }),
  });
  expired.hooks.setBearerToken("token-hide-5");
  const expiredResponse = await expired.dispatchMessage({
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ao3:123", hidden: true },
  });
  assert.equal(expiredResponse.ok, false);
  assert.equal(expiredResponse.error, "auth_expired");
  assert.equal(expired.hooks.getBearerToken(), null);

  const capped = createBackgroundHarness({
    storageState: { authToken: "token-hide-6" },
    fetchImpl: async () => createResponse({ ok: false, status: 402 }),
  });
  capped.hooks.setBearerToken("token-hide-6");
  const cappedResponse = await capped.dispatchMessage({
    type: "TRACE_SET_HIDDEN_WORK",
    payload: { key: "ao3:123", hidden: true },
  });
  assert.equal(cappedResponse.ok, false);
  assert.equal(cappedResponse.error, "free_limit_reached");
  assert.equal(capped.store.traceAuthState.state, "upgrade_required");
});

test("TRACE_PATCH_LIBRARY_ENTRY patches rating and updates overlay cache", async () => {
  const entryId = "00000000-0000-4000-8000-000000000777";
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-patch-1",
      libraryOverlayCache: {
        entries: {
          "ao3:777": {
            entryId,
            status: "READING",
            readerStatus: "READING",
            chapters: { current: 4, total: 8 },
            rating: 0,
          },
        },
        syncVersion: "v-before-rating",
      },
    },
    fetchImpl: async (url, init) => {
      assert.equal(
        String(url),
        `https://tracefiction.com/api/library/${entryId}`,
      );
      assert.equal(init.method, "PATCH");
      assert.deepEqual(JSON.parse(init.body), { rating: 4 });
      return createResponse({ json: { data: { entry_id: entryId } } });
    },
  });
  h.hooks.setBearerToken("token-patch-1");

  const response = await h.dispatchMessage({
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: { entryId, patch: { rating: 4 } },
  });

  assert.equal(response.ok, true);
  assert.equal(response.workKey, "ao3:777");
  assert.deepEqual(plainJson(response.patch), { rating: 4 });
  assert.equal(h.store.libraryOverlayCache.entries["ao3:777"].rating, 4);
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.store.traceFirstSaveSeen, true);
});

test("TRACE_PATCH_LIBRARY_ENTRY patches catch-up progress and clears new chapter state", async () => {
  const entryId = "00000000-0000-4000-8000-000000000778";
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-patch-2",
      libraryOverlayCache: {
        entries: {
          "ao3:778": {
            entryId,
            status: "READING",
            readerStatus: "READING",
            chapters: { current: 4, total: 8 },
            catchupState: "BEHIND",
            newChapterCount: 2,
          },
        },
        syncVersion: "v-before-catchup",
      },
    },
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), {
        progress: { unit: "CHAPTER", value: 6, total: 8 },
      });
      return createResponse({ json: { data: { entry_id: entryId } } });
    },
  });
  h.hooks.setBearerToken("token-patch-2");

  const response = await h.dispatchMessage({
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: {
      entryId,
      patch: { progress: { unit: "CHAPTER", value: 6, total: 8 } },
    },
  });

  assert.equal(response.ok, true);
  const entry = h.store.libraryOverlayCache.entries["ao3:778"];
  assert.deepEqual(plainJson(entry.chapters), { current: 6, total: 8 });
  assert.equal(entry.catchupState, "UP");
  assert.equal(entry.newChapterCount, 0);
});


test("TRACE_PATCH_LIBRARY_ENTRY accepts canonical finished status and work override", async () => {
  const entryId = "00000000-0000-4000-8000-000000000780";
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-patch-4",
      libraryOverlayCache: {
        entries: {
          "ffn:780": {
            entryId,
            status: "READING",
            readerStatus: "READING",
            chapters: { current: 7, total: 8 },
            catchupState: "BEHIND",
            newChapterCount: 1,
          },
        },
        syncVersion: "v-before-finish-qualify",
      },
    },
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), {
        status: "FINISHED",
        progress: { unit: "CHAPTER", value: 8, total: 8 },
        story_snapshot: { work_status_override: "abandoned" },
      });
      return createResponse({ json: { data: { entry_id: entryId } } });
    },
  });
  h.hooks.setBearerToken("token-patch-4");

  const response = await h.dispatchMessage({
    type: "TRACE_PATCH_LIBRARY_ENTRY",
    payload: {
      entryId,
      patch: {
        status: "FINISHED",
        progress: { unit: "CHAPTER", value: 8, total: 8 },
        story_snapshot: { work_status_override: "abandoned" },
      },
    },
  });

  assert.equal(response.ok, true);
  const entry = h.store.libraryOverlayCache.entries["ffn:780"];
  assert.equal(entry.status, "COMPLETED");
  assert.equal(entry.readerStatus, "COMPLETED");
  assert.equal(entry.canonicalReaderStatus, "FINISHED");
  assert.deepEqual(plainJson(entry.chapters), { current: 8, total: 8 });
  assert.equal(entry.catchupState, "UP");
  assert.equal(entry.newChapterCount, 0);
  assert.equal(entry.workStatus, "abandoned");
  assert.equal(entry.workStatusProvenance, "override");
  assert.deepEqual(plainJson(entry.workMark), { kind: "abandoned" });
});

test("TRACE_PATCH_LIBRARY_ENTRY validates auth, entry id, rating, and progress", async () => {
  const noAuth = createBackgroundHarness();
  assert.deepEqual(
    plainJson(
      await noAuth.dispatchMessage({
        type: "TRACE_PATCH_LIBRARY_ENTRY",
        payload: {
          entryId: "00000000-0000-4000-8000-000000000779",
          patch: { rating: 4 },
        },
      }),
    ),
    { ok: false, error: "not_authenticated" },
  );

  const invalid = createBackgroundHarness({ storageState: { authToken: "token-patch-3" } });
  invalid.hooks.setBearerToken("token-patch-3");
  for (const payload of [
    { entryId: "bad-id", patch: { rating: 4 } },
    { entryId: "00000000-0000-4000-8000-000000000779", patch: { rating: 6 } },
    {
      entryId: "00000000-0000-4000-8000-000000000779",
      patch: { progress: { unit: "CHAPTER", value: -1, total: 8 } },
    },
    { entryId: "00000000-0000-4000-8000-000000000779", patch: {} },
  ]) {
    assert.deepEqual(
      plainJson(
        await invalid.dispatchMessage({
          type: "TRACE_PATCH_LIBRARY_ENTRY",
          payload,
        }),
      ),
      { ok: false, error: "invalid_request" },
    );
  }
});

test("TRACE_FINISH_QUALIFICATION_SIGNAL posts unresolved and resolved finish evidence", async () => {
  const entryId = "00000000-0000-4000-8000-000000000781";
  const seenBodies = [];
  const h = createBackgroundHarness({
    storageState: { authToken: "token-finish-1" },
    fetchImpl: async (url, init) => {
      assert.equal(
        String(url),
        "https://tracefiction.com/api/extension/finish-qualification",
      );
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer token-finish-1");
      seenBodies.push(JSON.parse(init.body));
      return createResponse({
        json: {
          success: true,
          data: { state: seenBodies.at(-1).state, eventId: "event-1" },
        },
      });
    },
  });
  h.hooks.setBearerToken("token-finish-1");

  const openResponse = await h.dispatchMessage({
    type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    payload: {
      entryId,
      workKey: "ao3:781",
      source: "ao3",
      chapter: 5,
      total: 5,
      state: "open",
    },
  });
  const resolvedResponse = await h.dispatchMessage({
    type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    payload: {
      entryId,
      workKey: "ao3:781",
      source: "ao3",
      chapter: 5,
      total: 5,
      state: "resolved",
      workStatus: "hiatus",
      readerStatus: "CAUGHT_UP",
    },
  });

  assert.equal(openResponse.ok, true);
  assert.equal(resolvedResponse.ok, true);
  assert.deepEqual(plainJson(seenBodies), [
    {
      entryId,
      workKey: "ao3:781",
      source: "ao3",
      chapter: 5,
      total: 5,
      state: "open",
    },
    {
      entryId,
      workKey: "ao3:781",
      source: "ao3",
      chapter: 5,
      total: 5,
      state: "resolved",
      workStatus: "hiatus",
      readerStatus: "CAUGHT_UP",
    },
  ]);
  assert.match(h.store.traceAuthState.lastFinishQualificationAt, /^\d{4}-/);
});

test("TRACE_FINISH_QUALIFICATION_SIGNAL validates auth and resolved payloads", async () => {
  const entryId = "00000000-0000-4000-8000-000000000782";
  const noAuth = createBackgroundHarness();
  assert.deepEqual(
    plainJson(
      await noAuth.dispatchMessage({
        type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
        payload: {
          entryId,
          source: "ao3",
          chapter: 1,
          total: 1,
          state: "open",
        },
      }),
    ),
    { ok: false, error: "not_authenticated" },
  );

  const invalid = createBackgroundHarness({ storageState: { authToken: "token-finish-2" } });
  invalid.hooks.setBearerToken("token-finish-2");
  for (const payload of [
    { entryId: "bad-id", source: "ao3", chapter: 1, total: 1, state: "open" },
    { entryId, source: "ao3", chapter: 0, total: 1, state: "open" },
    {
      entryId,
      source: "ao3",
      chapter: 1,
      total: 1,
      state: "resolved",
      workStatus: "hiatus",
    },
  ]) {
    assert.deepEqual(
      plainJson(
        await invalid.dispatchMessage({
          type: "TRACE_FINISH_QUALIFICATION_SIGNAL",
          payload,
        }),
      ),
      { ok: false, error: "invalid_request" },
    );
  }
});

// =======================================================
// Auto-track dispatch (TRACE_AUTO_TRACK ack contract)
// =======================================================
//
// The collector waits for an acknowledged response before flipping the
// story-page pill to READING. These tests pin the ack shape per failure
// mode so a future regression that returns a misleading ok:true (or drops
// the response entirely) shows up here.

test("TRACE_AUTO_TRACK without a token responds not_authenticated", async () => {
  const h = createBackgroundHarness();

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/200" },
      },
    },
    { tab: { id: 110 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "not_authenticated");
});

test("TRACE_AUTO_TRACK bootstraps iOS native auth before first story track", async () => {
  const h = createBackgroundHarness({
    sendNativeMessageImpl(message, callback) {
      if (
        message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST" &&
        message.reason === "auto_track"
      ) {
        callback({ ok: true, token: "native-auto-token" });
        return;
      }
      callback({ ok: false, error: "missing_token" });
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/account/me")) {
        assert.equal(init.headers.Authorization, "Bearer native-auto-token");
        return createResponse({ json: { pro: false, library_count: 0 } });
      }
      if (String(url).endsWith("/api/extension/track")) {
        assert.equal(init.headers.Authorization, "Bearer native-auto-token");
        return createResponse({
          json: {
            success: true,
            data: { entry_id: "entry-native-1", type: "created" },
          },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "native-at-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  await flush();

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/200" },
      },
    },
    { tab: { id: 110 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.deepEqual(plainJson(response), {
    ok: true,
    entryId: "entry-native-1",
  });
  assert.equal(h.hooks.getBearerToken(), "native-auto-token");
  assert.equal(h.hooks.getVerifiedBearerToken(), "native-auto-token");
  assert.equal(h.store.authToken, "native-auto-token");
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.equal(h.store.traceFirstSaveSeen, true);
  assert.ok(
    h.nativeMessages.some(
      (args) => plainJson(args[0]).reason === "auto_track",
    ),
  );
});

test("TRACE_AUTO_TRACK retries with iOS native auth after a stale stored token", async () => {
  let trackCalls = 0;
  const h = createBackgroundHarness({
    sendNativeMessageImpl(message, callback) {
      if (
        message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST" &&
        message.reason === "auto_track_auth_failure"
      ) {
        callback({ ok: true, token: "native-auto-fresh-token" });
        return;
      }
      callback({ ok: false, error: "missing_token" });
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/account/me")) {
        assert.equal(
          init.headers.Authorization,
          "Bearer native-auto-fresh-token",
        );
        return createResponse({ json: { pro: false, library_count: 0 } });
      }
      if (String(url).endsWith("/api/extension/track")) {
        trackCalls += 1;
        if (trackCalls === 1) {
          assert.equal(init.headers.Authorization, "Bearer stale-auto-token");
          return createResponse({ ok: false, status: 401 });
        }
        assert.equal(
          init.headers.Authorization,
          "Bearer native-auto-fresh-token",
        );
        return createResponse({
          json: {
            success: true,
            data: { entry_id: "entry-auto-retry", type: "created" },
          },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "auto-retry-v1" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("stale-auto-token");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/204" },
      },
    },
    { tab: { id: 114 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.deepEqual(plainJson(response), {
    ok: true,
    entryId: "entry-auto-retry",
  });
  assert.equal(trackCalls, 2);
  assert.equal(h.hooks.getBearerToken(), "native-auto-fresh-token");
  assert.ok(
    h.nativeMessages.some(
      (args) => plainJson(args[0]).reason === "auto_track_auth_failure",
    ),
  );
});

test("TRACE_AUTO_TRACK from a subframe responds ignored_sender", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-1" },
  });
  h.hooks.setBearerToken("token-at-1");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/201" },
      },
    },
    { tab: { id: 111 }, frameId: 7 },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "ignored_sender");
  // No fetch should have happened for an ignored sender.
  const trackCalls = h.fetchCalls.filter((call) =>
    /\/api\/extension\/track$/.test(String(call.url)),
  );
  assert.equal(trackCalls.length, 0);
});

test("TRACE_AUTO_TRACK with auto-track disabled responds auto_track_disabled", async () => {
  const h = createBackgroundHarness({
    storageState: {
      authToken: "token-at-2",
      prefAutoTrackEnabled: false,
    },
  });
  h.hooks.setBearerToken("token-at-2");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/202" },
      },
    },
    { tab: { id: 112 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "auto_track_disabled");
  const trackCalls = h.fetchCalls.filter((call) =>
    /\/api\/extension\/track$/.test(String(call.url)),
  );
  assert.equal(trackCalls.length, 0);
});

test("TRACE_AUTO_TRACK confirms saved from an authoritative track entry", async () => {
  const entry = {
    status: "PLANNING",
    readerStatus: "PLANNING",
    canonicalReaderStatus: "SAVED",
    entryId: "00000000-0000-4000-8000-000000000203",
  };
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-3" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({
          json: {
            success: true,
            data: {
              entry_id: entry.entryId,
              work_key: "ao3:203",
              entry,
              syncVersion: "v-at",
            },
          },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: { "ao3:203": entry }, syncVersion: "v-at" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-at-3");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: {
          src: "ao3",
          t: "Story",
          u: "https://archiveofourown.org/works/203",
        },
      },
    },
    { tab: { id: 113 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, true);
  assert.equal(response.entryId, entry.entryId);
  assert.equal(response.state.status, "saved");
  assert.equal(response.state.entry.entryId, entry.entryId);
  assert.equal(h.store.libraryOverlayCache.entries["ao3:203"].entryId, entry.entryId);
});

test("TRACE_AUTO_TRACK confirms legacy track responses only after overlay refresh sees the entry", async () => {
  const entry = {
    status: "PLANNING",
    readerStatus: "PLANNING",
    canonicalReaderStatus: "SAVED",
    entryId: "00000000-0000-4000-8000-000000000204",
  };
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-legacy" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({
          json: { success: true, data: { entry_id: entry.entryId, type: "created" } },
        });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: { "ao3:204": entry }, syncVersion: "v-at-legacy" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-at-legacy");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: {
          src: "ao3",
          t: "Story",
          u: "https://archiveofourown.org/works/204",
        },
      },
    },
    { tab: { id: 114 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, true);
  assert.equal(response.entryId, entry.entryId);
  assert.equal(response.state.status, "saved");
  assert.equal(response.state.entry.entryId, entry.entryId);
});

test("TRACE_AUTO_TRACK does not report saved when a 2xx write lacks library confirmation", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-missing" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({ json: { success: true, data: { story_id: "s-1" } } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "v-at-missing" } },
        });
      }
      return createResponse({ ok: false, status: 404 });
    },
  });
  h.hooks.setBearerToken("token-at-missing");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: {
          src: "ao3",
          t: "Story",
          u: "https://archiveofourown.org/works/205",
        },
      },
    },
    { tab: { id: 115 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "confirmation_missing");
  assert.equal(h.store.libraryOverlayCache.entries["ao3:205"], undefined);
  const queried = await h.dispatchMessage({
    type: "TRACE_WORK_STATE_GET",
    workKey: "ao3:205",
  });
  assert.equal(queried.ok, true);
  assert.equal(queried.state.status, "error");
  assert.equal(queried.state.error, "confirmation_missing");
});

test("TRACE_AUTO_TRACK responds auth_expired on 401", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-4" },
    fetchImpl: async () => createResponse({ ok: false, status: 401 }),
  });
  h.hooks.setBearerToken("token-at-4");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/204" },
      },
    },
    { tab: { id: 114 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "auth_expired");
});

test("TRACE_AUTO_TRACK responds account_bootstrap_required on 409", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-bootstrap" },
    fetchImpl: async () =>
      createResponse({
        ok: false,
        status: 409,
        json: { code: "ACCOUNT_BOOTSTRAP_REQUIRED" },
      }),
  });
  h.hooks.setBearerToken("token-at-bootstrap");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/204" },
      },
    },
    { tab: { id: 114 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "account_bootstrap_required");
  assert.equal(h.hooks.getBearerToken(), null);
  assert.equal(h.store.authToken, undefined);
  assert.equal(h.store.traceAuthState.state, "reconnect_required");
  assert.equal(h.store.traceAuthState.lastAuthErrorCode, "ACCOUNT_BOOTSTRAP_REQUIRED");
});

test("TRACE_AUTO_TRACK responds free_limit_reached on 402", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-5" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({ ok: false, status: 402 });
      }
      return createResponse({ json: { success: true, data: { entries: {} } } });
    },
  });
  h.hooks.setBearerToken("token-at-5");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/205" },
      },
    },
    { tab: { id: 115 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "free_limit_reached");
});

test("TRACE_AUTO_TRACK responds http_<status> on other non-2xx", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-6" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({ ok: false, status: 503 });
      }
      return createResponse({ json: { success: true, data: { entries: {} } } });
    },
  });
  h.hooks.setBearerToken("token-at-6");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/206" },
      },
    },
    { tab: { id: 116 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "http_503");
});

test("TRACE_AUTO_TRACK responds network_error when fetch throws", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-7" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        throw new Error("offline");
      }
      return createResponse({ json: { success: true, data: { entries: {} } } });
    },
  });
  h.hooks.setBearerToken("token-at-7");

  const response = await h.dispatchMessage(
    {
      type: "TRACE_AUTO_TRACK",
      payload: {
        s: "ao3",
        at: new Date().toISOString(),
        item: { t: "Story", u: "https://archiveofourown.org/works/207" },
      },
    },
    { tab: { id: 117 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error, "network_error");
});
