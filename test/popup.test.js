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
const ARCHIVE_PERMISSION_BUNDLE = Object.freeze([
  "https://archiveofourown.org/*",
  "https://*.archiveofourown.org/*",
  "https://archiveofourown.gay/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
]);
const ARCHIVE_PERMISSION_CONTENT_SCRIPTS = Object.freeze([
  {
    id: "trace-popup-permission-archive-runtime",
    js: [
      "popup-config.js",
      "trace-finish-qualify.js",
      "collector.js",
      "library-overlay-keys.js",
      "library-overlay.js",
    ],
    matches: [...ARCHIVE_PERMISSION_BUNDLE],
    excludeMatches: [],
    persistAcrossSessions: true,
    runAt: "document_end",
  },
  {
    id: "trace-popup-permission-ao3-saved-filters",
    js: ["ao3-saved-filters.js"],
    matches: ARCHIVE_PERMISSION_BUNDLE.slice(0, 5),
    excludeMatches: [],
    persistAcrossSessions: true,
    runAt: "document_end",
  },
]);

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
  permissionSpike = false,
  grantedOrigins = [],
  permissionRequestGranted = true,
  permissionRequestOrigins,
  permissionRequestError = null,
  registeredScriptIds = [],
  registrationError = null,
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
  const permissionRequests = [];
  const registeredScripts = registeredScriptIds.map((id) => ({ id }));
  let currentGrantedOrigins = [...grantedOrigins];
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
          callback?.(out);
        },
        set(obj, callback) {
          Object.assign(store, obj || {});
          callback?.();
        },
      },
      onChanged: {
        addListener(fn) {
          storageChangeListeners.push(fn);
        },
      },
    },
    permissions: {
      async getAll() {
        return { origins: [...currentGrantedOrigins], permissions: [] };
      },
      async request(request) {
        permissionRequests.push(request);
        if (permissionRequestError) throw new Error(permissionRequestError);
        if (permissionRequestGranted) {
          currentGrantedOrigins = Array.isArray(permissionRequestOrigins)
            ? [...permissionRequestOrigins]
            : [...(request?.origins || [])];
        }
        return permissionRequestGranted;
      },
    },
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) {
        const allowed = new Set(Array.isArray(ids) ? ids : []);
        return registeredScripts.filter(
          (entry) => allowed.size === 0 || allowed.has(entry.id),
        );
      },
      async registerContentScripts(entries) {
        if (registrationError) throw new Error(registrationError);
        for (const entry of entries || []) {
          if (!registeredScripts.some((current) => current.id === entry.id)) {
            registeredScripts.push(entry);
          }
        }
      },
    },
  };

  const context = {
    console,
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
  if (permissionSpike) {
    context.TRACE_IOS_POPUP_PERMISSION_SPIKE = true;
    context.TRACE_ARCHIVE_PERMISSION_BUNDLE = [...ARCHIVE_PERMISSION_BUNDLE];
    context.TRACE_ARCHIVE_PERMISSION_CONTENT_SCRIPTS =
      ARCHIVE_PERMISSION_CONTENT_SCRIPTS.map((entry) => ({
        ...entry,
        js: [...entry.js],
        matches: [...entry.matches],
        excludeMatches: [...entry.excludeMatches],
      }));
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
    permissionRequests,
    registeredScripts,
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

test("normal popup keeps the developer permission surface hidden", async () => {
  const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true });
  await flush();

  assert.equal(h.document.getElementById("popup-permission-spike").hidden, true);
  assert.notEqual(h.document.body.dataset.tracePermissionSpike, "true");
  assert.deepEqual(h.permissionRequests, []);
});

test("popup spike requests the exact archive bundle and registers both production script groups", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    permissionSpike: true,
  });
  await flush();

  assert.equal(h.document.getElementById("popup-permission-spike").hidden, false);
  assert.equal(h.document.body.dataset.tracePermissionSpike, "true");
  assert.equal(h.document.getElementById("popup-permission-request").textContent.trim(), "Allow AO3 & FFN");
  assert.equal(h.document.getElementById("popup-permission-ao3").textContent, "Needed");
  assert.equal(h.document.getElementById("popup-permission-ffn").textContent, "Needed");

  h.document.getElementById("popup-permission-request").click();
  await flush();

  assert.deepEqual(
    JSON.parse(JSON.stringify(h.permissionRequests)),
    [{ origins: [...ARCHIVE_PERMISSION_BUNDLE] }],
  );
  assert.deepEqual(
    h.registeredScripts.map((entry) => entry.id).sort(),
    ARCHIVE_PERMISSION_CONTENT_SCRIPTS.map((entry) => entry.id).sort(),
  );
  assert.equal(h.document.getElementById("popup-permission-heading").textContent, "Website access allowed");
  assert.equal(h.document.getElementById("popup-permission-status").dataset.state, "success");
  assert.equal(h.document.getElementById("popup-permission-request").hidden, true);
  assert.equal(h.document.getElementById("popup-permission-open-ao3").hidden, false);
  assert.equal(h.document.getElementById("popup-permission-note").hidden, false);
});

test("popup spike reports a denied request without claiming readiness", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    permissionSpike: true,
    permissionRequestGranted: false,
  });
  await flush();

  h.document.getElementById("popup-permission-request").click();
  await flush();

  assert.equal(h.permissionRequests.length, 1);
  assert.equal(h.registeredScripts.length, 0);
  assert.equal(h.document.getElementById("popup-permission-heading").textContent, "Allow story sites");
  assert.match(h.document.getElementById("popup-permission-status").textContent, /did not allow/i);
  assert.equal(h.document.getElementById("popup-permission-open-ao3").hidden, true);
  assert.equal(h.document.getElementById("popup-permission-request").textContent, "Try allowing again");
});

test("popup spike keeps granted sites distinct from a script-registration failure", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    permissionSpike: true,
    registrationError: "Safari blocked dynamic registration.",
  });
  await flush();

  h.document.getElementById("popup-permission-request").click();
  await flush();

  assert.equal(h.document.getElementById("popup-permission-ao3").textContent, "Allowed");
  assert.equal(h.document.getElementById("popup-permission-ffn").textContent, "Allowed");
  assert.equal(h.document.getElementById("popup-permission-status").dataset.state, "error");
  assert.match(h.document.getElementById("popup-permission-status").textContent, /dynamic registration/i);
  assert.equal(h.document.getElementById("popup-permission-open-ao3").hidden, true);
  assert.equal(h.document.getElementById("popup-permission-request").textContent, "Retry preparing Trace");

  h.document.getElementById("popup-permission-request").click();
  await flush();
  assert.equal(h.permissionRequests.length, 1);
});

test("popup spike restores dynamic scripts when permission survived an extension restart", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    permissionSpike: true,
    grantedOrigins: ARCHIVE_PERMISSION_BUNDLE,
    registeredScriptIds: [ARCHIVE_PERMISSION_CONTENT_SCRIPTS[0].id],
  });
  await flush();

  assert.deepEqual(h.permissionRequests, []);
  assert.deepEqual(
    h.registeredScripts.map((entry) => entry.id).sort(),
    ARCHIVE_PERMISSION_CONTENT_SCRIPTS.map((entry) => entry.id).sort(),
  );
  assert.equal(h.document.getElementById("popup-permission-heading").textContent, "Website access allowed");
  assert.match(h.document.getElementById("popup-permission-evidence").textContent, /"registrationsComplete": true/);
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
  assert.equal(h.document.getElementById("popup-cta").textContent, "Manage library");
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
