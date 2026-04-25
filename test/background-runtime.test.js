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

function createBackgroundHarness({
  apiBase = "https://tracefiction.com",
  webOrigin = "https://tracefiction.com",
  storageState = {},
  fetchImpl,
  activeTabs = [{ id: 11 }],
  sendMessageImpl,
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
        return args;
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
  handleQuickAdd,
  shouldIgnoreSenderForAutoTrack,
  setBearerToken(value) { bearerToken = value; },
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
      libraryOverlayCache: { entries: { "ao3:1": "READING" } },
    },
  });

  const response = await h.dispatchMessage(
    { type: "TRACE_AUTH_UPDATE", token: "   " },
    { tab: { id: 22 } },
  );

  assert.deepEqual(plainJson(response), { success: true, state: "signed_out" });
  assert.equal(h.store.authToken, undefined);
  assert.equal(h.store.traceUserPro, undefined);
  assert.equal(h.store.libraryOverlayCache, undefined);
  assert.equal(h.store.traceAuthState.state, "signed_out");
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "", tabId: 22 });
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

test("handleAutoTrack without a token moves popup state to reconnect required", () => {
  const h = createBackgroundHarness();

  h.hooks.handleAutoTrack(
    { s: "ffn", item: { t: "A Story", u: "https://www.fanfiction.net/s/1/" } },
    { tab: { id: 33 } },
  );

  assert.equal(h.store.traceAuthState.state, "reconnect_required");
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
  assert.deepEqual(Object.keys(msgResponse), ["ok"]);
  assert.equal(h.store.traceAuthState.state, "connected");
  assert.ok(h.store.traceAuthState.lastQuickAddAt);
  assert.deepEqual(plainJson(h.badgeTextCalls.at(-1)), { text: "OK", tabId: 77 });
  assert.equal(sentMessages.length >= 1, true);
  assert.equal(sentMessages.at(-1).tabId, 77);
  assert.equal(sentMessages.at(-1).msg.type, "TRACE_LIBRARY_INVALIDATED");
  assert.equal(sentMessages.at(-1).msg.reason, "quick_add");
  assert.match(String(sentMessages.at(-1).msg.at || ""), /^\d{4}-\d{2}-\d{2}T/);
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

test("TRACE_AUTO_TRACK responds ok:true only after the server write returns 2xx", async () => {
  const h = createBackgroundHarness({
    storageState: { authToken: "token-at-3" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/extension/track")) {
        return createResponse({ json: { success: true, data: { story_id: "s-1" } } });
      }
      if (String(url).endsWith("/api/extension/library-overlay")) {
        return createResponse({
          json: { success: true, data: { entries: {}, syncVersion: "v-at" } },
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
        item: { t: "Story", u: "https://archiveofourown.org/works/203" },
      },
    },
    { tab: { id: 113 }, frameId: 0, documentLifecycle: "active" },
  );

  assert.equal(response.ok, true);
  // The collector only inspects response.ok; do not start leaking server
  // payload fields into the ack without a documented consumer.
  assert.deepEqual(Object.keys(response), ["ok"]);
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
