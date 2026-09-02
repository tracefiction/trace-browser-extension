const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const POPUP_HTML_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "popup.html",
);
const POPUP_JS_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "popup.js",
);
const POPUP_CSS_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "popup.css",
);
const ACTIVE_TAB_PROBE_FILES = [
  "popup-config.js",
  "trace-finish-qualify.js",
  "collector.js",
];

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPopupHarness({
  storageState = {},
  popupState = {
    pro: false,
    autoTrackEnabled: true,
    libraryInlayEnabled: true,
    ao3SavedFiltersEnabled: true,
    metadataImproveEnabled: true,
    activeTab: { kind: "unsupported" },
  },
  importResponse = { ok: true },
  userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  traceWebOrigin,
  sessionMode = "legacy",
  sessionSnapshot = {
    state: "signed_out",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "none",
  },
  promiseRuntime = false,
  activeTabProbe = false,
  activeTab = { id: 7, url: "https://archiveofourown.org/works/123" },
  existingProbe = false,
  injectionError = null,
  probeSaveResponse = {
    ok: true,
    state: "saved",
    site: "ao3",
    serverConfirmed: true,
  },
  earnedPermissionOnboarding = false,
  grantedOrigins = [],
  registeredContentScripts = [],
  permissionRequestResult = true,
  permissionRequestError = null,
  permissionContainsResult = null,
  registrationReconcileResult = null,
} = {}) {
  const html = fs.readFileSync(POPUP_HTML_PATH, "utf8");
  const js = fs.readFileSync(POPUP_JS_PATH, "utf8");
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  const dom = new JSDOM(html, {
    url: "https://tracefiction.com",
    runScripts: "outside-only",
    contentType: "text/html",
    userAgent,
  });
  const { window } = dom;
  const style = window.document.createElement("style");
  style.textContent = css;
  window.document.head.appendChild(style);
  const store = { ...storageState };
  const messages = [];
  const storageChangeListeners = [];
  const timeouts = [];
  const tabMessages = [];
  const injections = [];
  const permissionRequests = [];
  const registrationRequests = [];
  const reconcileRequests = [];
  const reloads = [];
  let currentRegisteredContentScripts = [...registeredContentScripts];
  let closeCalled = false;

  const ext = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        let response;
        if (message.type === "TRACE_POPUP_OPEN") {
          response = { ok: true };
        }
        if (message.type === "TRACE_POPUP_GET_STATE") {
          response = popupState;
        }
        if (message.type === "TRACE_IMPORT_TRIGGER") {
          response = importResponse;
        }
        if (message.type === "TRACE_SESSION_GET_SNAPSHOT") {
          response = { ok: true, snapshot: sessionSnapshot };
        }
        if (message.type === "TRACE_SESSION_ACTION") {
          response = { ok: true, snapshot: sessionSnapshot, action: { kind: "ignored" } };
        }
        if (message.type === "TRACE_EARNED_PERMISSION_RECONCILE") {
          reconcileRequests.push(message);
          const completeGrant = grantedOrigins.length === 5;
          response = registrationReconcileResult ?? {
            ok: completeGrant,
            completeGrant,
            registered: completeGrant,
            changed: completeGrant,
            ...(completeGrant ? { grantAt: Date.now() } : { error: "permission_incomplete" }),
          };
        }
        if (promiseRuntime) return Promise.resolve(response);
        callback?.(response);
      },
    },
    storage: {
      local: {
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
            }
          }
          if (promiseRuntime) return Promise.resolve(out);
          callback?.(out);
        },
        set(obj, callback) {
          Object.assign(store, obj || {});
          if (promiseRuntime) return Promise.resolve();
          callback?.();
        },
      },
      onChanged: {
        addListener(fn) {
          storageChangeListeners.push(fn);
        },
      },
    },
    tabs: {
      query(_query, callback) {
        if (promiseRuntime) return Promise.resolve([activeTab]);
        callback?.([activeTab]);
      },
      sendMessage(tabId, message, callback) {
        tabMessages.push({ tabId, message });
        const injected = existingProbe || injections.length > 0;
        if (message.type === "TRACE_ACTIVE_TAB_PROBE_PING" && !injected) {
          if (promiseRuntime) return Promise.reject(new Error("no receiver"));
          ext.runtime.lastError = { message: "no receiver" };
          callback?.(undefined);
          ext.runtime.lastError = null;
          return;
        }
        const response = message.type === "TRACE_ACTIVE_TAB_PROBE_PING"
          ? { ok: true, probe: true }
          : probeSaveResponse;
        if (promiseRuntime) return Promise.resolve(response);
        callback?.(response);
      },
      reload(tabId, callback) {
        reloads.push(tabId);
        if (promiseRuntime) return Promise.resolve();
        callback?.();
      },
    },
    permissions: {
      getAll(callback) {
        const response = { origins: [...grantedOrigins], permissions: [] };
        if (promiseRuntime) return Promise.resolve(response);
        callback?.(response);
      },
      contains(request, callback) {
        const response =
          typeof permissionContainsResult === "boolean"
            ? permissionContainsResult
            : (request?.origins || []).every((origin) =>
                grantedOrigins.includes(origin),
              );
        if (promiseRuntime) return Promise.resolve(response);
        callback?.(response);
      },
      request(request, callback) {
        permissionRequests.push(request);
        if (permissionRequestError) {
          if (promiseRuntime) return Promise.reject(new Error(permissionRequestError));
          ext.runtime.lastError = { message: permissionRequestError };
          callback?.(undefined);
          ext.runtime.lastError = null;
          return;
        }
        if (permissionRequestResult) {
          grantedOrigins.splice(0, grantedOrigins.length, ...(request.origins || []));
        }
        if (promiseRuntime) return Promise.resolve(permissionRequestResult);
        callback?.(permissionRequestResult);
      },
    },
    scripting: {
      executeScript(injection, callback) {
        injections.push(injection);
        if (injectionError) {
          if (promiseRuntime) return Promise.reject(new Error(injectionError));
          ext.runtime.lastError = { message: injectionError };
          callback?.(undefined);
          ext.runtime.lastError = null;
          return;
        }
        if (promiseRuntime) return Promise.resolve([]);
        callback?.([]);
      },
      getRegisteredContentScripts(callback) {
        const response = [...currentRegisteredContentScripts];
        if (promiseRuntime) return Promise.resolve(response);
        callback?.(response);
      },
      unregisterContentScripts(filter, callback) {
        const ids = new Set(filter?.ids || []);
        currentRegisteredContentScripts = currentRegisteredContentScripts.filter(
          (registration) => !ids.has(registration.id),
        );
        if (promiseRuntime) return Promise.resolve();
        callback?.();
      },
      registerContentScripts(registrations, callback) {
        registrationRequests.push(registrations);
        currentRegisteredContentScripts.push(...registrations);
        if (promiseRuntime) return Promise.resolve();
        callback?.();
      },
    },
  };

  const context = {
    console,
    URL: window.URL,
    chrome: promiseRuntime ? undefined : ext,
    browser: promiseRuntime ? ext : undefined,
    document: window.document,
    window,
    self: window,
    /** popup.js reads `navigator.userAgent` at load; must match test device. */
    navigator: { userAgent },
    globalThis: null,
    setTimeout(fn, ms) {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    clearTimeout() {},
    TRACE_SESSION_MODE: sessionMode,
  };
  if (traceWebOrigin !== undefined) {
    context.TRACE_EXTENSION_WEB_ORIGIN = traceWebOrigin;
  }
  if (activeTabProbe) context.TRACE_IOS_ACTIVE_TAB_PROBE = true;
  if (earnedPermissionOnboarding) {
    context.TRACE_IOS_ACTIVE_TAB_PROBE = true;
    context.TRACE_IOS_EARNED_PERMISSION_ONBOARDING = {
      version: 3,
      origins: [
        "https://*.archiveofourown.org/*",
        "https://*.archiveofourown.gay/*",
        "https://archive.transformativeworks.org/*",
        "https://www.fanfiction.net/*",
        "https://m.fanfiction.net/*",
      ],
      registrations: [
        {
          id: "trace-archive-automation-v1",
          matches: ["https://*.archiveofourown.org/*"],
          js: ["collector.js"],
          persistAcrossSessions: true,
        },
        {
          id: "trace-ao3-saved-filters-v1",
          matches: ["https://*.archiveofourown.org/*"],
          js: ["ao3-saved-filters.js"],
          persistAcrossSessions: true,
        },
      ],
    };
  }
  context.globalThis = context;
  window.close = () => {
    closeCalled = true;
  };

  vm.createContext(context);
  vm.runInContext(js, context);

  return {
    window,
    document: window.document,
    store,
    messages,
    tabMessages,
    injections,
    permissionRequests,
    registrationRequests,
    reconcileRequests,
    reloads,
    get closeCalled() {
      return closeCalled;
    },
    runTimeouts() {
      const pending = timeouts.splice(0, timeouts.length);
      for (const item of pending) item.fn();
    },
    emitStorageChange(changes, area = "local") {
      if (area === "local") {
        for (const [key, change] of Object.entries(changes || {})) {
          if (change && Object.prototype.hasOwnProperty.call(change, "newValue")) {
            if (change.newValue === undefined) {
              delete store[key];
            } else {
              store[key] = change.newValue;
            }
          }
        }
      }
      for (const fn of storageChangeListeners) fn(changes, area);
    },
  };
}

test("normal popup keeps the active-tab probe hidden", async () => {
  const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true });
  await flush();

  assert.equal(h.document.getElementById("popup-active-tab-probe").hidden, true);
  assert.notEqual(h.document.body.dataset.traceActiveTabProbe, "true");
  assert.deepEqual(h.injections, []);
});

for (const promiseRuntime of [false, true]) {
  test(`active-tab probe saves a supported story with the ${promiseRuntime ? "promise" : "callback"} API`, async () => {
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime,
      activeTabProbe: true,
    });
    await flush();
    await flush();

    assert.deepEqual(
      JSON.parse(JSON.stringify(h.injections)),
      [{ target: { tabId: 7 }, files: ACTIVE_TAB_PROBE_FILES }],
    );
    assert.equal(h.document.getElementById("popup-active-tab-probe").hidden, false);
    assert.equal(h.document.body.dataset.traceActiveTabProbe, "true");
    assert.equal(h.document.getElementById("popup-probe-story").dataset.state, "pass");
    assert.equal(h.document.getElementById("popup-probe-access").dataset.state, "pass");
    assert.equal(h.document.getElementById("popup-probe-save").dataset.state, "pass");
    assert.equal(h.document.getElementById("popup-probe-result").dataset.state, "success");
    assert.equal(h.document.getElementById("popup-probe-result-heading").textContent, "Saved to your Trace library.");
    assert.equal(h.document.body.textContent.includes("archiveofourown.org/works/123"), false);
  });
}

test("active-tab probe does not inject on an unsupported page", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    activeTabProbe: true,
    activeTab: { id: 8, url: "https://www.google.com/" },
  });
  await flush();

  assert.deepEqual(h.injections, []);
  assert.deepEqual(h.tabMessages, []);
  assert.equal(h.document.getElementById("popup-probe-story").dataset.state, "fail");
  assert.equal(h.document.getElementById("popup-probe-result").dataset.state, "failure");
  assert.equal(h.document.getElementById("popup-probe-result-heading").textContent, "Open a supported story");
});

test("active-tab probe makes injection failure explicit and retryable", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    activeTabProbe: true,
    injectionError: "Safari denied execution",
  });
  await flush();
  await flush();

  assert.equal(h.document.getElementById("popup-probe-access").dataset.state, "fail");
  assert.equal(h.document.getElementById("popup-probe-result-heading").textContent, "Current-tab access failed");
  assert.equal(h.document.getElementById("popup-probe-retry").disabled, false);
});

for (const promiseRuntime of [false, true]) {
  test(`earned-permission onboarding identifies the story without saving before permission with the ${promiseRuntime ? "promise" : "callback"} API`, async () => {
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime,
      earnedPermissionOnboarding: true,
      sessionSnapshot: {
        state: "connected",
        accountId: "account-a",
        canExecuteAuthenticated: true,
        reason: "none",
      },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();

    assert.equal(h.document.body.dataset.traceEarnedPermission, "true");
    assert.equal(h.document.getElementById("popup-earned-story").dataset.state, "pass");
    assert.equal(h.document.getElementById("popup-earned-access").dataset.state, "waiting");
    assert.equal(h.document.getElementById("popup-earned-save").dataset.state, "waiting");
    assert.equal(
      h.document.getElementById("popup-earned-kicker").textContent,
      "AO3 story found",
    );
    assert.equal(
      h.document.getElementById("popup-earned-heading").textContent,
      "Allow Trace on AO3 and FanFiction.net",
    );
    assert.equal(
      h.document.getElementById("popup-earned-lead").textContent,
      "When Safari asks, choose Always Allow.",
    );
    assert.equal(
      h.document.getElementById("popup-earned-primary").textContent,
      "Allow access and add story",
    );
    assert.equal(h.document.getElementById("popup-earned-help").hidden, true);
    assert.ok(
      h.document.getElementById("popup-earned-primary").compareDocumentPosition(
        h.document.getElementById("popup-earned-ledger"),
      ) & h.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.equal(h.permissionRequests.length, 0);
    assert.equal(h.reconcileRequests.length, 0);
    assert.equal(h.injections.length, 0);
    assert.equal(
      h.tabMessages.some(
        ({ message }) => message.type === "TRACE_ACTIVE_TAB_PROBE_SAVE",
      ),
      false,
    );
    assert.equal(h.document.body.textContent.includes("archiveofourown.org/works/123"), false);
  });
}

test("earned-permission action requests the exact sites, delegates registration, and reloads for proof", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    sessionSnapshot: {
      state: "connected",
      accountId: "account-a",
      canExecuteAuthenticated: true,
      reason: "none",
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  h.document.getElementById("popup-earned-primary").dispatchEvent(
    new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  for (let attempt = 0; attempt < 10; attempt += 1) await flush();

  assert.equal(h.permissionRequests.length, 1);
  assert.equal(h.permissionRequests[0].origins.length, 5);
  assert.equal(h.reconcileRequests.length, 1);
  assert.equal(h.registrationRequests.length, 0);
  assert.deepEqual(h.reloads, [7]);
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Adding your story…",
  );
  assert.equal(h.document.getElementById("popup-earned-primary").disabled, true);
  assert.equal(
    h.tabMessages.some(
      ({ message }) => message.type === "TRACE_ACTIVE_TAB_PROBE_SAVE",
    ),
    false,
  );
});

test("earned-permission denial saves nothing and offers concise retry and Settings recovery", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    permissionRequestResult: false,
    sessionSnapshot: {
      state: "connected",
      accountId: "account-a",
      canExecuteAuthenticated: true,
      reason: "none",
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  h.document.getElementById("popup-earned-primary").dispatchEvent(
    new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.registrationRequests.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Access wasn’t allowed",
  );
  assert.equal(h.document.getElementById("popup-earned-help").hidden, false);
  assert.equal(
    h.document.getElementById("popup-earned-help-summary").textContent,
    "No prompt?",
  );
  assert.match(
    h.document.getElementById("popup-earned-disclosure").textContent,
    /Settings > Apps > Safari > Extensions > Trace/i,
  );
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Try again");
  assert.equal(h.permissionRequests.length, 1);
  assert.equal(h.reconcileRequests.length, 0);
});

test("earned-permission request errors do not claim access or save the story", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    permissionRequestError: "Safari request unavailable",
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  h.document.getElementById("popup-earned-primary").dispatchEvent(
    new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.getElementById("popup-earned-access").dataset.state, "fail");
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Access wasn’t allowed",
  );
  assert.equal(h.registrationRequests.length, 0);
  assert.equal(h.reconcileRequests.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.tabMessages.length, 0);
});

test("earned-permission unsupported pages give a direct exit instead of a retry loop", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    activeTab: { id: 7, url: "https://www.google.com/" },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Open a story first",
  );
  assert.equal(
    h.document.getElementById("popup-earned-primary").textContent,
    "Close and open a story",
  );
  h.document.getElementById("popup-earned-primary").dispatchEvent(
    new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  assert.equal(h.closeCalled, true);
  assert.equal(h.permissionRequests.length, 0);
});

test("earned-permission previously declined state still requires access and never becomes a manual mode", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    storageState: {
      traceEarnedPermissionOnboardingV1: {
        firstSaveAt: Date.now() - 5_000,
        grantAt: null,
        registrationVersion: null,
        promptResult: "declined",
      },
    },
    sessionSnapshot: {
      state: "connected",
      accountId: "account-a",
      canExecuteAuthenticated: true,
      reason: "none",
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(
    h.tabMessages.filter(
      ({ message }) => message.type === "TRACE_ACTIVE_TAB_PROBE_SAVE",
    ).length,
    0,
  );
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Allow Trace on AO3 and FanFiction.net",
  );
  assert.equal(h.document.getElementById("popup-earned-save").dataset.state, "waiting");
});

for (const promiseRuntime of [false, true]) {
  test(`earned-permission onboarding keeps a clean extension session untouched until the permission action with the ${promiseRuntime ? "promise" : "callback"} API`, async () => {
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime,
      earnedPermissionOnboarding: true,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();

    assert.equal(
      h.messages.some(({ type }) => type === "TRACE_SESSION_GET_SNAPSHOT"),
      false,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(h.injections)), []);
    assert.equal(h.tabMessages.length, 0);
    assert.equal(h.document.getElementById("popup-earned-story").dataset.state, "pass");
    assert.equal(h.document.getElementById("popup-earned-access").dataset.state, "waiting");
    assert.equal(h.document.getElementById("popup-earned-save").dataset.state, "waiting");
    assert.equal(
      h.document.getElementById("popup-earned-heading").textContent,
      "Allow Trace on AO3 and FanFiction.net",
    );
  });
}

test("earned-permission onboarding does not touch the save path before permission even if Trace is disconnected", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    probeSaveResponse: { ok: false, error: "not_authenticated" },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.getElementById("popup-earned-story").dataset.state, "pass");
  assert.equal(h.document.getElementById("popup-earned-access").dataset.state, "waiting");
  assert.equal(h.document.getElementById("popup-earned-save").dataset.state, "waiting");
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Allow Trace on AO3 and FanFiction.net",
  );
  assert.equal(
    h.document.getElementById("popup-earned-primary").textContent,
    "Allow access and add story",
  );
  assert.equal(h.tabMessages.length, 0);
});

test("earned-permission onboarding confirms automation only from a post-grant archive run", async () => {
  const grantAt = Date.now() - 5_000;
  const origins = [
    "https://*.archiveofourown.org/*",
    "https://*.archiveofourown.gay/*",
    "https://archive.transformativeworks.org/*",
    "https://www.fanfiction.net/*",
    "https://m.fanfiction.net/*",
  ];
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    grantedOrigins: [...origins],
    registeredContentScripts: [
      { id: "trace-archive-automation-v1" },
      { id: "trace-ao3-saved-filters-v1" },
    ],
    storageState: {
      traceEarnedPermissionOnboardingV1: {
        firstSaveAt: grantAt - 1_000,
        grantAt,
        registrationVersion: 3,
        promptResult: "granted",
      },
      traceArchiveReadiness: { lastArchiveSeenAt: grantAt + 1_000 },
    },
    sessionSnapshot: {
      state: "connected",
      accountId: "account-a",
      canExecuteAuthenticated: true,
      reason: "none",
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.body.dataset.traceEarnedPermission, undefined);
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, true);
  assert.equal(h.document.getElementById("popup-status").textContent, "Connected");
  assert.equal(h.store.traceEarnedPermissionOnboardingV1.completedAt > grantAt, true);
});

test("earned-permission onboarding accepts semantically complete legacy grants", async () => {
  const grantAt = Date.now() - 5_000;
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    sessionSnapshot: {
      state: "connected",
      accountId: "account-a",
      canExecuteAuthenticated: true,
      reason: "none",
    },
    grantedOrigins: ["https://archiveofourown.org/*"],
    permissionContainsResult: true,
    registeredContentScripts: [
      { id: "trace-archive-automation-v1" },
      { id: "trace-ao3-saved-filters-v1" },
    ],
    storageState: {
      traceEarnedPermissionOnboardingV1: {
        grantAt,
        registrationVersion: 3,
        promptResult: "granted",
      },
      traceArchiveReadiness: { lastArchiveSeenAt: grantAt + 1_000 },
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.body.dataset.traceEarnedPermission, undefined);
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, true);
  assert.equal(h.document.getElementById("popup-status").textContent, "Connected");
  assert.equal(h.permissionRequests.length, 0);
});

test("earned-permission onboarding confirms a heartbeat while the popup stays open", async () => {
  const grantAt = Date.now() - 5_000;
  const origins = [
    "https://*.archiveofourown.org/*",
    "https://*.archiveofourown.gay/*",
    "https://archive.transformativeworks.org/*",
    "https://www.fanfiction.net/*",
    "https://m.fanfiction.net/*",
  ];
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    sessionSnapshot: {
      state: "connected",
      accountId: "account-a",
      canExecuteAuthenticated: true,
      reason: "none",
    },
    grantedOrigins: [...origins],
    registeredContentScripts: [
      { id: "trace-archive-automation-v1" },
      { id: "trace-ao3-saved-filters-v1" },
    ],
    storageState: {
      traceEarnedPermissionOnboardingV1: {
        firstSaveAt: grantAt - 1_000,
        grantAt,
        registrationVersion: 3,
        promptResult: "granted",
      },
      traceArchiveReadiness: { lastArchiveSeenAt: grantAt - 1_000 },
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(
    h.document.getElementById("popup-earned-primary").textContent,
    "Add story",
  );

  h.emitStorageChange({
    traceArchiveReadiness: {
      newValue: { lastArchiveSeenAt: grantAt + 1_000 },
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.body.dataset.traceEarnedPermission, undefined);
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, true);
  assert.equal(h.document.getElementById("popup-status").textContent, "Connected");
});

test("completed earned-permission onboarding opens normal controls away from story pages", async () => {
  const completedAt = Date.now() - 5_000;
  const origins = [
    "https://*.archiveofourown.org/*",
    "https://*.archiveofourown.gay/*",
    "https://archive.transformativeworks.org/*",
    "https://www.fanfiction.net/*",
    "https://m.fanfiction.net/*",
  ];
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    activeTab: { id: 8, url: "https://www.google.com/" },
    grantedOrigins: [...origins],
    storageState: {
      traceEarnedPermissionOnboardingV1: {
        grantAt: completedAt - 5_000,
        registrationVersion: 3,
        promptResult: "granted",
        completedAt,
      },
    },
    sessionSnapshot: {
      state: "connected",
      accountId: "account-a",
      canExecuteAuthenticated: true,
      reason: "none",
    },
    popupState: {
      ok: true,
      authState: {
        state: "connected",
        accountId: "account-a",
        canExecuteAuthenticated: true,
        reason: "none",
      },
      firstSaveSeen: true,
      libraryCount: 12,
      activeTab: { kind: "unsupported" },
      pro: true,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      ao3SavedFiltersEnabled: true,
      metadataImproveEnabled: true,
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.body.dataset.traceEarnedPermission, undefined);
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, true);
  assert.equal(h.document.getElementById("popup-status").textContent, "Connected");
  assert.equal(h.document.getElementById("popup-local-settings").hidden, false);
  const savedFilters = h.document.getElementById("pref-ao3-saved-filters");
  savedFilters.checked = false;
  savedFilters.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  await flush();
  assert.equal(h.store.prefAo3SavedFiltersEnabled, false);
  assert.equal(h.injections.length, 0, "normal popup must not run the retired active-tab probe");
});

test("earned-permission onboarding gives a bounded retry when background registration fails", async () => {
  const previousGrantAt = Date.now() - 60_000;
  const origins = [
    "https://*.archiveofourown.org/*",
    "https://*.archiveofourown.gay/*",
    "https://archive.transformativeworks.org/*",
    "https://www.fanfiction.net/*",
    "https://m.fanfiction.net/*",
  ];
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    grantedOrigins: [...origins],
    registeredContentScripts: [
      { id: "trace-archive-automation-v1" },
      { id: "trace-ao3-saved-filters-v1" },
    ],
    registrationReconcileResult: {
      ok: false,
      completeGrant: true,
      registered: false,
      changed: false,
      error: "registration_failed",
    },
    storageState: {
      traceEarnedPermissionOnboardingV1: {
        firstSaveAt: previousGrantAt - 1_000,
        grantAt: previousGrantAt,
        registrationVersion: 2,
        promptResult: "granted",
      },
      traceArchiveReadiness: { lastArchiveSeenAt: previousGrantAt - 1_000 },
    },
  });
  for (let attempt = 0; attempt < 10; attempt += 1) await flush();

  assert.equal(h.reconcileRequests.length, 1);
  assert.equal(h.registrationRequests.length, 0);
  assert.equal(
    h.document.getElementById("popup-earned-primary").textContent,
    "Try again",
  );
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Trace couldn’t finish setup",
  );
  assert.equal(h.document.getElementById("popup-earned-help").hidden, false);
  assert.equal(
    h.document.getElementById("popup-earned-help-summary").textContent,
    "Still not working?",
  );
});

test("kernel popup is read-only on open and exposes only explicit session actions", async () => {
  const h = createPopupHarness({ sessionMode: "kernel" });
  await flush();

  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [
    { type: "TRACE_SESSION_GET_SNAPSHOT" },
  ]);
  assert.equal(h.document.getElementById("popup-status").textContent, "Connect Trace");
  assert.equal(h.document.getElementById("popup-cta").textContent, "Connect");
  assert.equal(h.document.getElementById("popup-import").hidden, true);
  const localSettings = h.document.getElementById("popup-local-settings");
  assert.equal(localSettings.hidden, true);
  assert.equal(h.window.getComputedStyle(localSettings).display, "none");

  h.document.getElementById("popup-cta").dispatchEvent(
    new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), {
    type: "TRACE_SESSION_ACTION",
    action: "connect",
  });
});

test("kernel popup uses the promise runtime contract on Firefox and Safari", async () => {
  const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true });
  await flush();

  assert.equal(h.document.getElementById("popup-status").textContent, "Connect Trace");
  h.document.getElementById("popup-cta").dispatchEvent(
    new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), {
    type: "TRACE_SESSION_ACTION",
    action: "connect",
  });
  assert.equal(h.document.getElementById("popup-cta").hasAttribute("aria-disabled"), false);
});

for (const promiseRuntime of [false, true]) {
  const runtimeLabel = promiseRuntime ? "promise" : "callback";
  for (const fixture of [
    { state: "initializing", primary: null, secondary: null },
    { state: "signed_out", primary: "connect", secondary: null },
    { state: "connecting", primary: "cancel", secondary: null },
    { state: "verifying", primary: "cancel", secondary: null },
    { state: "connected", primary: null, secondary: "disconnect" },
    { state: "degraded", primary: "retry", secondary: "disconnect" },
    { state: "reconnect_required", primary: "reconnect", secondary: "disconnect" },
  ]) {
    test(`kernel ${runtimeLabel} popup exposes the required ${fixture.state} actions`, async () => {
      const h = createPopupHarness({
        sessionMode: "kernel",
        promiseRuntime,
        sessionSnapshot: {
          state: fixture.state,
          accountId: fixture.state === "connected" ? "account-a" : null,
          canExecuteAuthenticated: fixture.state === "connected",
          reason: fixture.state === "degraded" ? "verification_unavailable" : "none",
        },
      });
      await flush();
      const primary = h.document.getElementById("popup-cta");
      const secondary = h.document.getElementById("popup-session-secondary");

      assert.equal(primary.hidden, fixture.primary == null);
      assert.equal(primary.dataset.sessionAction || null, fixture.primary);
      assert.equal(secondary.hidden, fixture.secondary == null);
      assert.equal(secondary.dataset.sessionAction || null, fixture.secondary);

      if (fixture.primary) {
        primary.dispatchEvent(
          new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await flush();
        const actionMessage = h.messages
          .filter((message) => message.type === "TRACE_SESSION_ACTION")
          .at(-1);
        assert.deepEqual(JSON.parse(JSON.stringify(actionMessage)), {
          type: "TRACE_SESSION_ACTION",
          action: fixture.primary,
        });
      }
      if (fixture.secondary) {
        secondary.dispatchEvent(
          new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await flush();
        const actionMessage = h.messages
          .filter((message) => message.type === "TRACE_SESSION_ACTION")
          .at(-1);
        assert.deepEqual(JSON.parse(JSON.stringify(actionMessage)), {
          type: "TRACE_SESSION_ACTION",
          action: fixture.secondary,
        });
      }
    });
  }
}

test("connected kernel popup renders authoritative summary, preferences, and migrated import", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    sessionSnapshot: {
      state: "connected",
      accountId: "must-not-render",
      canExecuteAuthenticated: true,
      reason: "none",
    },
    popupState: {
      ok: true,
      authState: {
        state: "connected",
        reason: "none",
        canExecuteAuthenticated: true,
      },
      firstSaveSeen: true,
      libraryCount: 8,
      activeTab: { kind: "supported_story", site: "ffn", canImport: true },
      pro: true,
      autoTrackEnabled: false,
      libraryInlayEnabled: true,
      ao3SavedFiltersEnabled: false,
      metadataImproveEnabled: true,
    },
  });
  await flush();

  assert.equal(h.document.getElementById("popup-local-settings").hidden, false);
  assert.equal(h.document.getElementById("popup-pro-settings").hidden, false);
  assert.equal(h.document.getElementById("pref-auto-track").checked, false);
  assert.equal(h.document.getElementById("pref-library-inlay").checked, true);
  assert.equal(h.document.getElementById("pref-ao3-saved-filters").checked, false);
  assert.equal(h.document.getElementById("popup-import").hidden, false);
  assert.equal(h.document.getElementById("popup-import").textContent, "Import this story");
  h.document.getElementById("popup-import").click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), {
    type: "TRACE_IMPORT_TRIGGER",
  });
  assert.equal(
    h.messages.some((message) => message.type === "TRACE_POPUP_GET_STATE"),
    true,
  );
});

test("kernel iOS credential recovery gives app-only guidance and opens the app", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    sessionSnapshot: {
      state: "reconnect_required",
      accountId: null,
      canExecuteAuthenticated: false,
      reason: "credential_rejected",
    },
  });
  await flush();

  assert.match(h.document.getElementById("popup-lead").textContent, /Trace app/i);
  assert.match(h.document.getElementById("popup-lead").textContent, /does not connect/i);
  const helper = h.document.getElementById("popup-session-help");
  assert.equal(helper.hidden, false);
  assert.equal(helper.textContent, "Open Trace app");
  assert.equal(
    helper.getAttribute("href"),
    "traceauth://open?destination=extension-connect",
  );
});

test("kernel iOS account-response failures are not mislabeled as an app sign-in problem", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    sessionSnapshot: {
      state: "reconnect_required",
      accountId: null,
      canExecuteAuthenticated: false,
      reason: "invalid_account_response",
    },
  });
  await flush();

  assert.match(h.document.getElementById("popup-lead").textContent, /safely verify/i);
  assert.doesNotMatch(h.document.getElementById("popup-lead").textContent, /sign in/i);
  assert.equal(h.document.getElementById("popup-session-help").hidden, true);
});

test("popup renders signed-out fallback with a direct Trace sign-in CTA", async () => {
  const h = createPopupHarness({
    storageState: {},
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      activeTab: { kind: "unsupported" },
    },
  });
  await flush();

  assert.equal(
    h.document.getElementById("popup-status").textContent,
    "Connect Trace",
  );
  assert.equal(
    h.document.getElementById("popup-cta").textContent,
    "Open Trace to sign in",
  );
  assert.match(
    h.document.getElementById("popup-lead").textContent,
    /return to an AO3 or FFN story page/i,
  );
  assert.equal(h.document.querySelector(".popup-eyebrow").hidden, true);
  assert.doesNotMatch(h.document.body.textContent, /Extension lens/i);
  assert.equal(h.document.getElementById("popup-import").hidden, true);
  assert.equal(
    h.document.getElementById("popup-pro-settings").classList.contains("hidden"),
    true,
  );
  assert.equal(
    h.document.getElementById("popup-local-settings").classList.contains("hidden"),
    false,
  );
  assert.equal(h.document.getElementById("pref-ao3-saved-filters").checked, true);
});

test("popup signed-out CTA uses configured Trace web origin", async () => {
  const h = createPopupHarness({
    traceWebOrigin: "http://localhost:5173",
    storageState: {},
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      activeTab: { kind: "unsupported" },
    },
  });
  await flush();

  assert.equal(
    h.document.getElementById("popup-cta").getAttribute("href"),
    "http://localhost:5173/",
  );
});

test("popup connection indicator reflects D1 state labels", async () => {
  const cases = [
    {
      name: "signed out",
      authState: { state: "signed_out" },
      firstSaveSeen: false,
      expectedState: "off",
      expectedLabel: "Not linked",
    },
    {
      name: "reconnect",
      authState: { state: "reconnect_required" },
      firstSaveSeen: false,
      expectedState: "warn",
      expectedLabel: "Reconnect",
    },
    {
      name: "checking",
      authState: {
        state: "unknown",
        message: "Checking your Trace account connection. Retrying shortly.",
      },
      firstSaveSeen: false,
      expectedState: "warn",
      expectedLabel: "Checking",
      expectedHeading: "Checking Trace",
    },
    {
      name: "error",
      authState: { state: "error" },
      firstSaveSeen: false,
      expectedState: "error",
      expectedLabel: "Issue",
    },
    {
      name: "upgrade",
      authState: { state: "upgrade_required" },
      firstSaveSeen: false,
      expectedState: "warn",
      expectedLabel: "Upgrade",
    },
    {
      name: "connected",
      authState: { state: "connected" },
      firstSaveSeen: true,
      expectedState: "connected",
      expectedLabel: "Connected",
    },
  ];

  for (const item of cases) {
    const h = createPopupHarness({
      storageState: { traceAuthState: item.authState },
      popupState: {
        pro: false,
        autoTrackEnabled: true,
        libraryInlayEnabled: true,
        metadataImproveEnabled: true,
        authState: item.authState,
        firstSaveSeen: item.firstSaveSeen,
        libraryCount: item.firstSaveSeen ? 1 : 0,
        activeTab: { kind: "unsupported" },
      },
    });
    await flush();

    const connection = h.document.getElementById("popup-connection");
    assert.equal(connection.dataset.state, item.expectedState, item.name);
    assert.equal(
      connection.querySelector(".popup-connection-label").textContent,
      item.expectedLabel,
      item.name,
    );
    assert.ok(connection.querySelector(".popup-connection-dot[aria-hidden='true']"), item.name);
    if (item.expectedHeading) {
      assert.equal(
        h.document.getElementById("popup-status").textContent,
        item.expectedHeading,
        item.name,
      );
    }
  }
});

test("popup connected first-run state points unsupported tabs to AO3 and FFN", async () => {
  const h = createPopupHarness({
    storageState: {
      traceAuthState: {
        state: "connected",
        message: "Connected",
        helpUrl: "https://tracefiction.com/apps",
      },
    },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      authState: {
        state: "connected",
        message: "Connected",
        helpUrl: "https://tracefiction.com/apps",
      },
      firstSaveSeen: false,
      libraryCount: 0,
      activeTab: { kind: "unsupported" },
    },
  });
  await flush();

  assert.equal(
    h.document.getElementById("popup-status").textContent,
    "Open AO3 or FFN",
  );
  assert.match(h.document.getElementById("popup-lead").textContent, /Add to Trace/i);
  assert.equal(h.document.getElementById("popup-import").hidden, true);
  assert.equal(h.document.getElementById("popup-archive-links").hidden, false);
  assert.equal(
    h.document.getElementById("popup-open-ao3").getAttribute("href"),
    "https://archiveofourown.org/works",
  );
  assert.equal(
    h.document.getElementById("popup-open-ffn").getAttribute("href"),
    "https://www.fanfiction.net/",
  );
});

test("popup connected first-run story page makes import the primary action", async () => {
  const connected = {
    state: "connected",
    message: "Connected",
    helpUrl: "https://tracefiction.com/apps",
  };
  const h = createPopupHarness({
    storageState: { traceAuthState: connected },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      authState: connected,
      firstSaveSeen: false,
      libraryCount: 0,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    },
  });
  await flush();

  assert.equal(h.document.querySelector(".popup-eyebrow").textContent, "First story");
  assert.equal(
    h.document.getElementById("popup-status").textContent,
    "Save this story",
  );
  assert.match(h.document.getElementById("popup-lead").textContent, /Use Add to Trace/i);
  assert.equal(h.document.getElementById("popup-import").hidden, false);
  assert.equal(h.document.getElementById("popup-import").disabled, false);
  assert.equal(h.document.getElementById("popup-import").textContent, "Import this story");
  assert.equal(h.document.getElementById("popup-cta").textContent, "Open Library");
});

test("popup switches to compact connected state after a local first-save signal", async () => {
  const connected = {
    state: "connected",
    message: "Extension connected to your Trace account.",
    helpUrl: "https://tracefiction.com/apps",
  };
  const h = createPopupHarness({
    storageState: { traceAuthState: connected },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      authState: connected,
      firstSaveSeen: false,
      libraryCount: 0,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    },
  });
  await flush();

  h.emitStorageChange(
    { traceFirstSaveSeen: { oldValue: false, newValue: true } },
    "local",
  );

  assert.equal(h.document.getElementById("popup-status").textContent, "Connected");
  assert.equal(h.document.querySelector(".popup-eyebrow").hidden, true);
  assert.doesNotMatch(h.document.body.textContent, /Extension lens/i);
  assert.equal(h.document.getElementById("popup-lead").hidden, true);
  assert.equal(h.document.getElementById("popup-lead").textContent, "");
  assert.equal(h.document.getElementById("popup-import").textContent, "Import this story");
  assert.equal(
    h.document.getElementById("popup-cta").textContent,
    "Open Library",
  );
});

test("popup treats account library count as first-save completion", async () => {
  const next = {
    state: "connected",
    message: "Extension connected to your Trace account.",
    helpUrl: "https://tracefiction.com/apps",
  };
  const h = createPopupHarness({
    storageState: { traceAuthState: next },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      authState: next,
      firstSaveSeen: false,
      libraryCount: 3,
      activeTab: { kind: "unsupported" },
    },
  });
  await flush();

  assert.equal(h.document.getElementById("popup-status").textContent, "Connected");
  assert.equal(h.document.getElementById("popup-lead").hidden, true);
  assert.equal(
    h.document.getElementById("popup-cta").textContent,
    "Open Library",
  );
});

test("popup signed-out lead on iPhone user agent mentions Safari website permission", async () => {
  const h = createPopupHarness({
    storageState: {},
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
    },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await flush();

  const lead = h.document.getElementById("popup-lead").textContent;
  assert.match(lead, /sign in/i);
  assert.match(lead, /tracefiction\.com/i);
  assert.match(lead, /enable Trace in Extensions/i);
  assert.match(lead, /allow it on tracefiction\.com/i);
  assert.match(lead, /AO3/i);
  assert.match(lead, /FFN/i);
  assert.match(lead, /Add to Trace or import/i);
  assert.equal(
    h.document.getElementById("popup-cta").textContent,
    "Safari setup help",
  );
  assert.equal(
    h.document.getElementById("popup-cta").getAttribute("href"),
    "https://tracefiction.com/apps#safari-ios-setup",
  );
});

test("popup reconnect guidance on iPhone links to Safari setup help", async () => {
  const h = createPopupHarness({
    storageState: {
      traceAuthState: {
        state: "reconnect_required",
        message: "Open Trace to sign in again.",
        helpUrl: "https://tracefiction.com/",
      },
    },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
    },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await flush();

  const lead = h.document.getElementById("popup-lead").textContent;
  assert.match(lead, /Open Trace to sign in again/i);
  assert.match(lead, /allow it on tracefiction\.com/i);
  assert.match(lead, /AO3/i);
  assert.match(lead, /FFN/i);
  assert.equal(
    h.document.getElementById("popup-cta").textContent,
    "Safari setup help",
  );
  assert.equal(
    h.document.getElementById("popup-cta").getAttribute("href"),
    "https://tracefiction.com/apps#safari-ios-setup",
  );
});

test("popup first-run state on iPhone explains archive site permission before saving", async () => {
  const connected = {
    state: "connected",
    message: "Connected",
    helpUrl: "https://tracefiction.com/apps",
  };
  const h = createPopupHarness({
    storageState: { traceAuthState: connected },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      authState: connected,
      firstSaveSeen: false,
      libraryCount: 0,
      activeTab: { kind: "unsupported" },
    },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await flush();

  const lead = h.document.getElementById("popup-lead").textContent;
  assert.match(lead, /allow Trace on AO3 and FFN/i);
  assert.match(lead, /supported story page/i);
  assert.match(lead, /Add to Trace or import/i);
});

test("popup shows reconnect guidance with a direct recovery CTA", async () => {
  const h = createPopupHarness({
    storageState: {
      traceAuthState: {
        state: "reconnect_required",
        message:
          "Your Trace session expired. Open Trace and sign in again, then refresh your AO3 or FFN tab to restore sync.",
        helpUrl: "https://tracefiction.com/apps",
      },
    },
  });
  await flush();

  assert.equal(
    h.document.getElementById("popup-status").textContent,
    "Sign in again",
  );
  assert.equal(
    h.document.getElementById("popup-cta").textContent,
    "Open Trace to reconnect",
  );
  assert.equal(
    h.document.getElementById("popup-pro-settings").classList.contains("hidden"),
    true,
  );
});

test("popup keeps a durable library-capacity recovery action", async () => {
  const connected = {
    state: "connected",
    message: "Connected",
    helpUrl: "https://tracefiction.com/",
  };
  const h = createPopupHarness({
    storageState: {
      traceAuthState: connected,
      traceFirstSaveSeen: true,
      traceLibraryCount: 100,
    },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      ao3SavedFiltersEnabled: true,
      metadataImproveEnabled: true,
      authState: connected,
      firstSaveSeen: true,
      libraryCount: 100,
      capacity: { blocked: true, prompt: false },
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    },
  });
  await flush();

  assert.equal(h.document.body.dataset.tracePopupState, "upgrade_required");
  assert.equal(h.document.getElementById("popup-status").textContent, "Library full");
  assert.match(h.document.getElementById("popup-lead").textContent, /make room or get/i);
  assert.equal(h.document.getElementById("popup-cta").textContent, "Get Trace Unlimited");
  assert.equal(
    h.document.getElementById("popup-cta").href,
    "https://tracefiction.com/?upgrade=1&source=extension_cap",
  );
  assert.equal(h.document.getElementById("popup-import").hidden, true);
});

test("popup shows local and connected controls and persists toggle changes", async () => {
  const h = createPopupHarness({
    storageState: {
      traceAuthState: { state: "connected", message: "Connected", helpUrl: "https://tracefiction.com/apps" },
      traceFirstSaveSeen: true,
    },
    popupState: {
      pro: true,
      autoTrackEnabled: false,
      libraryInlayEnabled: true,
      ao3SavedFiltersEnabled: false,
      metadataImproveEnabled: true,
      firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    },
  });
  await flush();

  const section = h.document.getElementById("popup-pro-settings");
  const localSection = h.document.getElementById("popup-local-settings");
  const auto = h.document.getElementById("pref-auto-track");
  const inlay = h.document.getElementById("pref-library-inlay");
  const savedFilters = h.document.getElementById("pref-ao3-saved-filters");
  const metadata = h.document.getElementById("pref-metadata-improve");

  assert.equal(section.classList.contains("hidden"), false);
  assert.equal(localSection.classList.contains("hidden"), false);
  assert.doesNotMatch(section.textContent, /Extension behavior/i);
  assert.doesNotMatch(section.textContent, /Saved filters on AO3/i);
  assert.match(localSection.textContent, /Saved filters on AO3/i);
  assert.equal(auto.checked, false);
  assert.equal(inlay.checked, true);
  assert.equal(savedFilters.checked, false);
  assert.equal(metadata.checked, true);

  auto.checked = true;
  auto.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  inlay.checked = false;
  inlay.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  savedFilters.checked = true;
  savedFilters.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  metadata.checked = false;
  metadata.dispatchEvent(new h.window.Event("change", { bubbles: true }));

  assert.equal(h.store.prefAutoTrackEnabled, true);
  assert.equal(h.store.prefLibraryInlayEnabled, false);
  assert.equal(h.store.prefAo3SavedFiltersEnabled, true);
  assert.equal(h.store.prefMetadataImproveEnabled, false);
});

test("popup import failure re-enables the button and exposes the failure reason", async () => {
  const h = createPopupHarness({
    storageState: {
      traceAuthState: { state: "connected", message: "Connected", helpUrl: "https://tracefiction.com/apps" },
      traceFirstSaveSeen: true,
    },
    importResponse: { ok: false, error: "collect_failed" },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    },
  });
  await flush();

  const button = h.document.getElementById("popup-import");
  button.click();

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Import failed — try again");
  assert.equal(button.title, "collect_failed");
});

test("popup import turns a missing site grant into actionable permission guidance", async () => {
  const connected = { state: "connected", message: "Connected" };
  const h = createPopupHarness({
    sessionMode: "kernel",
    sessionSnapshot: {
      state: "connected",
      accountId: "must-not-render",
      canExecuteAuthenticated: true,
      reason: "none",
    },
    importResponse: { ok: false, error: "permission_required" },
    popupState: {
      ok: true,
      authState: {
        state: "connected",
        reason: "none",
        canExecuteAuthenticated: true,
      },
      firstSaveSeen: false,
      libraryCount: 0,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      ao3SavedFiltersEnabled: true,
      metadataImproveEnabled: true,
    },
    storageState: { traceAuthState: connected },
  });
  await flush();

  const button = h.document.getElementById("popup-import");
  button.click();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Allow site access, then retry");
  assert.match(button.title, /extension settings/i);
  assert.match(button.title, /refresh/i);
});

test("popup import success closes the popup after a short delay", async () => {
  const h = createPopupHarness({
    storageState: {
      traceAuthState: { state: "connected", message: "Connected", helpUrl: "https://tracefiction.com/apps" },
      traceFirstSaveSeen: true,
    },
    importResponse: { ok: true },
    popupState: {
      pro: false,
      autoTrackEnabled: true,
      libraryInlayEnabled: true,
      metadataImproveEnabled: true,
      firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    },
  });
  await flush();

  const button = h.document.getElementById("popup-import");
  button.click();

  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Opened import tab");
  h.runTimeouts();
  assert.equal(h.closeCalled, true);
});
