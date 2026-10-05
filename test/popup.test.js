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
const FULL_EARNED_ORIGINS = [
  "https://*.archiveofourown.org/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
];

const ACTIVE_TAB_PROBE_FILES = [
  "popup-config.js",
  "trace-finish-qualify.js",
  "collector.js",
];

test("dark popup keeps Story Ink tokens instead of legacy forest aliases", () => {
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  const darkMedia = [...css.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/g)];
  assert.equal(darkMedia.length, 1, "one dark palette should own the popup");
  const darkRoot = css.slice(darkMedia[0].index).match(
    /^@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/,
  )?.[1];
  assert.ok(darkRoot, "dark mode should define the Story Ink palette");
  assert.match(darkRoot, /--action:\s*#ff8458;/);
  assert.doesNotMatch(darkRoot, /--(?:paper|card|ink|line|forest|rust|honey)(?:-[\w-]+)?:/);
  assert.match(css, /--paper:\s*var\(--surface\);/);
  assert.match(css, /--forest-deep:\s*var\(--action\);/);
  assert.doesNotMatch(css, /--(?:confirm|attention|problem|rule-strong)(?:-soft)?:/);
  assert.match(darkRoot, /--surface:\s*#121418;/);
  assert.match(darkRoot, /--rule:\s*#212429;/);
  assert.match(darkRoot, /--raised:\s*#1d1f23;/);
  assert.match(darkRoot, /--control-edge:\s*#686d75;/);
  assert.match(css, /\.popup-earned-actions button\[data-emphasis="primary"\]\s*\{[^}]*background:\s*var\(--action\);/s);
});

function contrastRatio(a, b) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("dark text roles keep WCAG AA on Trace's dark surfaces and AO3's dark skin", () => {
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  const darkRoot = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)[1];
  const popup = Object.fromEntries([...darkRoot.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
  for (const text of ["text", "text-2", "text-3", "action", "warning", "status-saved", "status-reading",
    "status-caught-up", "status-paused", "status-finished", "status-dropped"]) {
    for (const surface of ["ground", "surface", "raised"]) {
      const ratio = contrastRatio(popup[text], popup[surface]);
      assert.ok(ratio >= 4.5, `popup ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(contrastRatio(popup["action-ink"], popup.action) >= 4.5, "popup action ink on action");

  // Controls are bounded by a ring: WCAG 1.4.11 asks 3:1 against what they sit on.
  for (const ground of ["ground", "surface", "raised"]) {
    const ratio = contrastRatio(popup["control-edge"], popup[ground]);
    assert.ok(ratio >= 3, `popup control edge on ${ground} is ${ratio.toFixed(2)}:1`);
  }

  // Every page surface carries its own copy of the dark tokens. Read all four
  // and check each one, so a copy can't drift away from the others.
  const resources = path.join(__dirname, "..", "Shared (Extension)", "Resources");
  const pageCopies = {
    "library-overlay.js": /var dark = \{([^}]*)\}/,
    "collector.js": /var dark = \{([^}]*)\}/,
    "ao3-saved-filters.js": /var dark = \{([^}]*)\}/,
    "trace-finish-qualify.js": /dark: \{([^}]*)\}/,
  };
  const reference = {};
  for (const [file, pattern] of Object.entries(pageCopies)) {
    const block = fs.readFileSync(path.join(resources, file), "utf8").match(pattern)?.[1];
    assert.ok(block, `${file} should define a dark page palette`);
    const page = Object.fromEntries([...block.matchAll(/["']?([\w-]+)["']?:\s*["'](#[0-9A-F]{6})["']/gi)]
      .map((m) => [m[1], m[2].toUpperCase()]));
    for (const [key, value] of Object.entries(page)) {
      if (key in reference) assert.equal(value, reference[key], `${file} dark ${key} differs from the other copies`);
      else reference[key] = value;
    }
    assert.equal(page.raised, "#1D1F23", `${file} dark raised uses the app's lifted`);
    // Page marks sit on the host page itself, so check AO3 Reversi (#333, #222) too.
    const grounds = { surface: page.surface, raised: page.raised, "AO3 Reversi": "#333333",
      "AO3 Reversi listbox": "#222222", ...(page["record-well"] ? { "record-well": page["record-well"] } : {}) };
    for (const text of ["ink", "secondary", "tertiary", "teal", "warning", "authored", "private-record", "status-saved",
      "status-reading", "status-caught-up", "status-paused", "status-finished", "status-dropped"]) {
      if (!page[text]) continue;
      for (const [name, ground] of Object.entries(grounds)) {
        const ratio = contrastRatio(page[text], ground);
        assert.ok(ratio >= 4.5, `${file} ${text} on ${name} is ${ratio.toFixed(2)}:1`);
      }
    }
    assert.ok(page.control, `${file} should define a dark control edge`);
    for (const ground of ["ground", "surface", "raised", "record-well"]) {
      if (!page[ground]) continue;
      const ratio = contrastRatio(page.control, page[ground]);
      assert.ok(ratio >= 3, `${file} control edge on ${ground} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(contrastRatio(reference.control, popup.lifted ?? popup.raised) >= 3);
});

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
  popupUrl = "https://tracefiction.com",
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
  sessionSnapshotResponses = null,
  directTabUnavailable = false,
  archiveAccess = null,
  deferredHostRequest = false,
} = {}) {
  const html = fs.readFileSync(POPUP_HTML_PATH, "utf8");
  const js = fs.readFileSync(POPUP_JS_PATH, "utf8");
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  const dom = new JSDOM(html, {
    url: popupUrl,
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
  const hostLifecycle = [];
  const popupDisconnects = [];
  let finishHostRequest;

  const ext = {
    runtime: {
      lastError: null,
      getURL: resource => `${popupUrl.startsWith("safari-web-extension:") ? "safari-web-extension" : promiseRuntime ? "moz-extension" : "chrome-extension"}://trace-test/${resource}`,
      connect({ name }) {
        hostLifecycle.push(name);
        return { onDisconnect: { addListener(fn) { popupDisconnects.push(fn); } } };
      },
      getManifest: () => ({ host_permissions: (archiveAccess || []).flatMap(item => item.origins) }),
      sendMessage(message, callback) {
        messages.push(message);
        let response;
        if (message.type === "TRACE_ARCHIVE_HOST_ACCESS_GET" || message.type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") {
          response = { ok: true, access: (archiveAccess || []).map(item => ({ ...item,
            granted: item.origins.every(origin => grantedOrigins.includes(origin)),
          })) };
        }
        if (message.type === "TRACE_POPUP_PAGE_RELAY") {
          tabMessages.push({ tabId: message.tabId, message: message.command });
          response = probeSaveResponse;
        }
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
          response = Array.isArray(sessionSnapshotResponses)
            ? sessionSnapshotResponses.shift()
            : { ok: true, snapshot: sessionSnapshot };
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
        if (directTabUnavailable) throw new Error("Safari direct route unavailable");
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
        hostLifecycle.push("request");
        if (deferredHostRequest) {
          return new Promise(resolve => { finishHostRequest = result => { callback?.(result); resolve(result); }; });
        }
        if (permissionRequestError) {
          if (promiseRuntime) return Promise.reject(new Error(permissionRequestError));
          ext.runtime.lastError = { message: permissionRequestError };
          callback?.(undefined);
          ext.runtime.lastError = null;
          return;
        }
        if (permissionRequestResult) {
          grantedOrigins.splice(0, grantedOrigins.length, ...new Set([...(archiveAccess ? grantedOrigins : []), ...(request.origins || [])]));
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
    hostLifecycle.push("close");
    closeCalled = true;
  };

  vm.createContext(context);
  if (archiveAccess) vm.runInContext(fs.readFileSync(path.join(path.dirname(POPUP_JS_PATH), "archive-access-client.js"), "utf8"), context);
  vm.runInContext(js, context);

  return {
    window,
    evaluate: (source) => vm.runInContext(source, context),
    document: window.document,
    store,
    messages,
    tabMessages,
    injections,
    permissionRequests,
    hostLifecycle,
    disconnectPopup: () => popupDisconnects.at(-1)(),
    finishHostRequest: result => finishHostRequest(result),
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
      "AO3 story",
    );
    assert.equal(
      h.document.getElementById("popup-earned-heading").textContent,
      "Let Trace work on AO3 and FanFiction.net",
    );
    assert.equal(
      h.document.getElementById("popup-earned-lead").textContent,
      "Nothing has been saved yet.",
    );
    assert.equal(
      h.document.getElementById("popup-earned-primary").textContent,
      "Continue",
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
    "Saving your story…",
  );
  // The reader may leave now; the popup never implies the save is done.
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Keep reading");
  assert.equal(h.document.getElementById("popup-earned-primary").disabled, false);
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
    "Nothing was saved",
  );
  assert.equal(h.document.getElementById("popup-earned-help").hidden, true);
  assert.match(h.document.getElementById("popup-earned-lead").textContent, /Always Allow/);
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
    "Nothing was saved",
  );
  assert.equal(h.registrationRequests.length, 0);
  assert.equal(h.reconcileRequests.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.tabMessages.length, 0);
});

test("earned-permission unsupported pages give a direct exit instead of a retry loop", async () => {
  for (const url of [
    "https://www.google.com/",
    "https://archiveofourown.org/users/login",
    "https://www.fanfiction.net/login.php",
  ]) {
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime: true,
      earnedPermissionOnboarding: true,
      activeTab: { id: 7, url },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();

    assert.equal(h.document.getElementById("popup-earned-heading").textContent,
      "Open a story to finish", url);
    assert.equal(h.document.getElementById("popup-earned-primary").textContent,
      "Close", url);
    h.document.getElementById("popup-earned-primary").click();
    assert.equal(h.closeCalled, true, url);
    assert.equal(h.permissionRequests.length, 0, url);
  }
});

test("a supported site page can grant all five story sites before opening a story", async () => {
  const pages = [
    "https://archiveofourown.org/",
    "https://archiveofourown.org/works",
    "https://archiveofourown.org/works/search",
    "https://archiveofourown.org/tags/Some%20Tag/works",
    "https://www.fanfiction.net/",
    "https://www.fanfiction.net/search/?keywords=story",
  ];
  for (const url of pages) {
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime: true,
      earnedPermissionOnboarding: true,
      activeTab: { id: 7, url },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)",
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();
    assert.equal(h.document.getElementById("popup-earned-heading").textContent,
      "Next, tap Always Allow.", url);
    assert.equal(h.document.getElementById("popup-earned-primary").textContent,
      "Allow story sites", url);
    assert.equal(h.permissionRequests.length, 0, url);

    h.document.getElementById("popup-earned-primary").click();
    for (let attempt = 0; attempt < 10; attempt += 1) await flush();
    assert.equal(h.permissionRequests.length, 1, url);
    assert.equal(h.permissionRequests[0].origins.length, 5, url);
    assert.equal(h.reconcileRequests.length, 1, url);
    assert.equal(h.document.getElementById("popup-earned-heading").textContent,
      "Open any story to save it", url);
    assert.match(h.document.getElementById("popup-earned-lead").textContent,
      /Tap a title on this page/, url);
    assert.equal(h.document.getElementById("popup-earned-record").hidden, true, url);
    assert.equal(h.document.getElementById("popup-earned-save").dataset.state, "waiting", url);
    assert.equal(h.document.getElementById("popup-earned-primary").hidden, true, url);
    assert.equal(h.store.traceEarnedPermissionOnboardingV1.completedAt > 0, true, url);
    assert.deepEqual(h.reloads, [], url);
    assert.equal(h.store.traceSavedNoteFirstStoryShownV1, undefined, url);
  }
});

test("a complete Safari grant on a supported site page gives the first-story next step without another tap", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    activeTab: { id: 7, url: "https://m.fanfiction.net/" },
    grantedOrigins: [
      "https://*.archiveofourown.org/*",
      "https://*.archiveofourown.gay/*",
      "https://archive.transformativeworks.org/*",
      "https://www.fanfiction.net/*",
      "https://m.fanfiction.net/*",
    ],
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.getElementById("popup-earned-heading").textContent,
    "Open any story to save it");
  assert.equal(h.store.traceEarnedPermissionOnboardingV1.completedAt > 0, true);
  assert.equal(h.permissionRequests.length, 0);
  assert.deepEqual(h.reloads, []);
});

test("a later popup on a supported listing still points to the first story", async () => {
  const h = createPopupHarness({
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    activeTab: { id: 7, url: "https://archiveofourown.org/works" },
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 } },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    popupState: {
      ok: true,
      authState: { state: "connected" },
      firstSaveSeen: false,
      activeTab: { kind: "supported_archive", site: "ao3", canImport: true },
      activeWork: null,
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.getElementById("popup-earned-heading").textContent,
    "Open any story to save it");
  assert.match(h.document.getElementById("popup-earned-lead").textContent,
    /Tap a title on this page/);
  assert.equal(h.document.getElementById("popup-earned-record").hidden, true);
  assert.equal(h.document.getElementById("popup-earned-primary").hidden, true);
  assert.equal(h.permissionRequests.length, 0);
});

for (const [page, url, returnTo] of [
  ["listing", "https://archiveofourown.org/works", "any story"],
  ["story", "https://archiveofourown.org/works/123", "this story"],
]) {
  test(`unlinked ${page} setup says where to return after linking`, async () => {
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime: true,
      earnedPermissionOnboarding: true,
      activeTab: { id: 7, url },
      popupState: { ok: true, authState: { state: "signed_out" } },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();
    h.document.getElementById("popup-earned-primary").click();
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();
    h.emitStorageChange({
      traceArchiveReadiness: { newValue: { lastArchiveSeenAt: Date.now() + 1_000 } },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();

    assert.equal(h.document.getElementById("popup-earned-heading").textContent,
      "Finish setup in the Trace app");
    assert.match(h.document.getElementById("popup-earned-lead").textContent,
      new RegExp(`then come back to ${returnTo}`, "i"));
  });
}

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
    "Let Trace work on AO3 and FanFiction.net",
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
      "Let Trace work on AO3 and FanFiction.net",
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
    "Let Trace work on AO3 and FanFiction.net",
  );
  assert.equal(
    h.document.getElementById("popup-earned-primary").textContent,
    "Continue",
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
  assert.equal(h.document.getElementById("popup-status").textContent, "Trace is on");
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
  assert.equal(h.document.getElementById("popup-status").textContent, "Trace is on");
  assert.equal(h.permissionRequests.length, 0);
});

test("earned-permission onboarding continues without a tap when access is complete and keeps waiting for the confirmed story", async () => {
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

  // Every supported site is already allowed: no decision is left, so the
  // popup reloads once without asking for another tap.
  assert.equal(h.reloads.length, 1);
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Saving your story…",
  );
  assert.equal(
    h.document.getElementById("popup-earned-primary").textContent,
    "Keep reading",
  );

  h.emitStorageChange({
    traceArchiveReadiness: {
      newValue: { lastArchiveSeenAt: grantAt + 1_000 },
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  // A heartbeat proves Trace ran, not that the story saved: the popup keeps
  // waiting for the confirmed entry instead of switching to the general view.
  assert.equal(h.document.body.dataset.traceEarnedPermission, "true");
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, false);
  assert.notEqual(
    h.document.getElementById("popup-earned-kicker").textContent,
    "Saved to your Trace Library",
  );
  assert.equal(h.reloads.length, 1, "a heartbeat must not trigger another reload");
});

test("a popup that confirms the first story makes the page note unnecessary", async () => {
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
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    grantedOrigins: [...origins],
    registeredContentScripts: [{ id: "trace-archive-automation-v1" }, { id: "trace-ao3-saved-filters-v1" }],
    storageState: {
      traceEarnedPermissionOnboardingV1: { grantAt, registrationVersion: 3, promptResult: "granted" },
      traceArchiveReadiness: { lastArchiveSeenAt: grantAt - 1_000 },
    },
    popupState: {
      ok: true,
      authState: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      activeWork: {
        workKey: "ao3:123",
        status: "saved",
        entry: { status: "PLANNING", canonicalReaderStatus: "SAVED" },
        syncVersion: "v1",
      },
      autoTrackEnabled: true,
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  h.emitStorageChange({ traceArchiveReadiness: { newValue: { lastArchiveSeenAt: grantAt + 1_000 } } });
  for (let attempt = 0; attempt < 12; attempt += 1) await flush();

  assert.match(h.document.getElementById("popup-earned-kicker").textContent, /Library/);
  assert.equal(h.store.traceSavedNoteFirstStoryShownV1, true);
  assert.ok(h.tabMessages.some(({ message }) => message.type === "TRACE_SAVED_NOTE_DISMISS"));
});

test("an unavailable first story ends confirmation without claiming a save", async () => {
  const grantAt = Date.now() - 5_000;
  const popupState = {
    ok: true,
    authState: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    activeTab: { kind: "supported_story", site: "ffn", canImport: true },
    activeWork: null,
    activeStoryUnavailable: false,
    autoTrackEnabled: true,
  };
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    activeTab: { id: 7, url: "https://m.fanfiction.net/s/7038840/1/Story-Not-Found" },
    sessionSnapshot: popupState.authState,
    popupState,
    grantedOrigins: [
      "https://*.archiveofourown.org/*",
      "https://*.archiveofourown.gay/*",
      "https://archive.transformativeworks.org/*",
      "https://www.fanfiction.net/*",
      "https://m.fanfiction.net/*",
    ],
    storageState: {
      traceEarnedPermissionOnboardingV1: { grantAt, registrationVersion: 3, promptResult: "granted" },
      traceArchiveReadiness: { lastArchiveSeenAt: grantAt - 1_000 },
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  h.emitStorageChange({ traceArchiveReadiness: { newValue: { lastArchiveSeenAt: grantAt + 1_000 } } });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.getElementById("popup-earned-heading").textContent,
    "Saving your story…");

  popupState.activeStoryUnavailable = true;
  h.runTimeouts();
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.getElementById("popup-earned-heading").textContent,
    "This story isn’t available");
  assert.match(h.document.getElementById("popup-earned-lead").textContent,
    /nothing was saved/i);
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Close");
  assert.equal(h.document.getElementById("popup-earned-record").hidden, true);
  assert.equal(h.store.traceSavedNoteFirstStoryShownV1, undefined);
  assert.doesNotMatch(h.document.getElementById("popup-earned-heading").textContent,
    /Still confirming|Saved to your Trace Library/);
});

test("a returning popup shows an explicitly unavailable story instead of saving", async () => {
  const h = createPopupHarness({
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 } },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    popupState: {
      ok: true,
      authState: { state: "connected" },
      firstSaveSeen: false,
      activeTab: { kind: "supported_story", site: "ffn", canImport: true },
      activeWork: null,
      activeStoryUnavailable: true,
      autoTrackEnabled: true,
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.getElementById("popup-earned-heading").textContent,
    "This story isn’t available");
  assert.equal(h.document.getElementById("popup-earned-primary").textContent,
    "Close");
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
  // Connected readers see the reader view, in the same grammar as setup.
  assert.equal(h.document.body.dataset.traceReaderView, "true");
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, false);
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Trace works on AO3 and FanFiction.net",
  );
  assert.equal(h.document.getElementById("popup-status").textContent, "Trace is on");
  assert.equal(h.document.getElementById("popup-local-settings").hidden, false);
  const savedFilters = h.document.getElementById("pref-ao3-saved-filters");
  savedFilters.checked = false;
  savedFilters.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  await flush();
  assert.equal(h.store.prefAo3SavedFiltersEnabled, false);
  assert.equal(h.injections.length, 0, "normal popup must not run the retired active-tab probe");
});

test("completed earned-permission onboarding stays complete when Safari omits the grant snapshot", async () => {
  const completedAt = Date.now() - 5_000;
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    activeTab: { id: 8, url: "https://www.google.com/" },
    grantedOrigins: [],
    permissionContainsResult: false,
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
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.body.dataset.traceEarnedPermission, undefined);
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, true);
  assert.equal(h.document.getElementById("popup-status").textContent, "Trace is on");
  assert.equal(h.permissionRequests.length, 0);
});

test("archive heartbeat completes onboarding when legacy state has no grant timestamp", async () => {
  const lastArchiveSeenAt = Date.now() - 1_000;
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    activeTab: { id: 8, url: "https://www.google.com/" },
    grantedOrigins: [],
    permissionContainsResult: false,
    storageState: {
      traceEarnedPermissionOnboardingV1: {
        registrationVersion: 3,
        promptResult: "granted",
      },
      traceArchiveReadiness: { lastArchiveSeenAt },
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
  assert.equal(h.document.getElementById("popup-status").textContent, "Trace is on");
  assert.equal(h.store.traceEarnedPermissionOnboardingV1.completedAt > lastArchiveSeenAt, true);
  assert.equal(h.permissionRequests.length, 0);
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
    "Trace couldn’t finish setting up",
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

test("kernel popup retries a missing session owner finitely and never spins forever", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    sessionSnapshotResponses: [null, null, null],
  });
  await flush();
  h.runTimeouts();
  await flush();
  h.runTimeouts();
  await flush();

  assert.equal(
    h.messages.filter(({ type }) => type === "TRACE_SESSION_GET_SNAPSHOT").length,
    3,
  );
  assert.equal(
    h.document.getElementById("popup-status").textContent,
    "Trace is temporarily offline",
  );
  assert.equal(h.document.getElementById("popup-cta").textContent, "Try again");
  assert.equal(h.document.getElementById("popup-cta").dataset.emphasis, "tertiary");
  assert.equal(h.document.body.dataset.tracePopupState, "degraded");
});

for (const promiseRuntime of [false, true]) {
  test(`kernel ${promiseRuntime ? "promise" : "callback"} popup follows transient session states through a confirmed save`, async () => {
    const snapshot = (state) => ({ ok: true, snapshot: { state, reason: "none" } });
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime,
      earnedPermissionOnboarding: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      grantedOrigins: [...FULL_EARNED_ORIGINS],
      storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 } },
      sessionSnapshotResponses: [
        snapshot("initializing"),
        snapshot("connecting"),
        snapshot("verifying"),
        snapshot("connected"),
      ],
      popupState: {
        ok: true,
        authState: { state: "connected" },
        activeTab: { kind: "supported_story", site: "ao3", canImport: true },
        activeWork: {
          status: "saved",
          entry: { status: "PLANNING", canonicalReaderStatus: "SAVED" },
        },
        autoTrackEnabled: true,
      },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();
    for (const state of ["initializing", "connecting", "verifying", "connected"]) {
      if (state !== "connected") {
        assert.equal(h.document.body.dataset.tracePopupStateCode, "P1");
        assert.equal(h.document.getElementById("popup-earned-heading").textContent,
          "Saving your story…");
        assert.notEqual(h.document.getElementById("popup-earned-primary").textContent, "Cancel");
      } else {
        assert.equal(h.document.body.dataset.tracePopupState, "connected_first_run");
      }
      if (state !== "connected") {
        assert.equal(h.messages.some(({ type }) => type === "TRACE_POPUP_GET_STATE"), false);
        h.runTimeouts();
        for (let attempt = 0; attempt < 8; attempt += 1) await flush();
      }
    }
    assert.equal(h.document.getElementById("popup-earned-kicker").hidden, true);
    assert.equal(h.document.body.dataset.tracePopupStateCode, "P11");
    assert.equal(h.messages.filter(({ type }) => type === "TRACE_POPUP_GET_STATE").length, 1);
    h.runTimeouts();
    await flush();
    assert.equal(h.messages.filter(({ type }) => type === "TRACE_SESSION_GET_SNAPSHOT").length, 4);
  });
}

test("kernel popup bounds transient snapshot follow-ups", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    sessionSnapshot: { state: "connecting", reason: "none" },
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await flush();
    h.runTimeouts();
  }
  await flush();
  assert.equal(h.messages.filter(({ type }) => type === "TRACE_SESSION_GET_SNAPSHOT").length, 32);
  assert.equal(h.document.body.dataset.tracePopupState, "connecting");
  assert.equal(h.messages.some(({ type }) => type === "TRACE_POPUP_GET_STATE"), false);
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
  const preferences = h.document.getElementById("popup-preferences");
  assert.equal(preferences.hidden, false);
  assert.equal(preferences.open, false);
  assert.equal(
    h.document.getElementById("popup-preferences-count").textContent,
    "2 of 4 on",
  );
  assert.equal(h.document.getElementById("pref-auto-track").checked, false);
  assert.equal(h.document.getElementById("pref-library-inlay").checked, true);
  assert.equal(h.document.getElementById("pref-ao3-saved-filters").checked, false);
  assert.equal(h.document.getElementById("popup-import").hidden, false);
  assert.equal(h.document.getElementById("popup-import").textContent, "Import this story");
  assert.ok(
    h.document.getElementById("popup-import").compareDocumentPosition(preferences) &
      h.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
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
  assert.equal(helper.tagName, "BUTTON");
  assert.equal(helper.textContent, "Open Trace app");
  assert.equal(
    helper.getAttribute("data-external-url"),
    "traceauth://open?destination=extension-connect",
  );
});

test("iOS: enabled but not yet linked points to one step in the Trace app", async () => {
  const h = createPopupHarness({
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    sessionMode: "kernel",
    earnedPermissionOnboarding: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5000 } },
    sessionSnapshot: {
      state: "signed_out",
      accountId: null,
      canExecuteAuthenticated: false,
      reason: "credential_absent",
    },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();

  assert.equal(h.document.body.dataset.traceReaderView, "link");
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, false);
  assert.equal(
    h.document.getElementById("popup-earned-heading").textContent,
    "Finish setup in the Trace app",
  );
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Open Trace");
  assert.equal(h.document.getElementById("popup-earned-primary").dataset.earnedAction, "open_connect");
  assert.equal(h.document.getElementById("popup-import").hidden, true);
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
    h.document.getElementById("popup-cta").getAttribute("data-external-url"),
    "http://localhost:5173/",
  );
});

test("popup header is the plain Trace word with no connection label", async () => {
  const cases = [
    { name: "signed out", authState: { state: "signed_out" }, firstSaveSeen: false, expectedHeading: "Connect Trace" },
    { name: "reconnect", authState: { state: "reconnect_required" }, firstSaveSeen: false, expectedHeading: "Sign in again" },
    {
      name: "checking",
      authState: { state: "unknown", message: "Checking your Trace account connection. Retrying shortly." },
      firstSaveSeen: false,
      expectedHeading: "Checking Trace…",
    },
    { name: "upgrade", authState: { state: "upgrade_required" }, firstSaveSeen: false, expectedHeading: "Your Library is full" },
    { name: "connected", authState: { state: "connected" }, firstSaveSeen: true, expectedHeading: "Trace is on" },
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

    assert.equal(h.document.getElementById("popup-connection"), null, item.name);
    assert.equal(h.document.querySelector(".popup-brand img"), null, item.name);
    assert.equal(h.document.querySelector(".popup-brand-name").textContent, "Trace", item.name);
    assert.doesNotMatch(h.document.body.textContent, /\bConnected\b/, item.name);
    assert.equal(h.document.getElementById("popup-status").textContent, item.expectedHeading, item.name);
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

  assert.equal(h.document.querySelector(".popup-eyebrow").hidden, true);
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

  assert.equal(h.document.getElementById("popup-status").textContent, "Trace is on");
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

  assert.equal(h.document.getElementById("popup-status").textContent, "Trace is on");
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
    h.document.getElementById("popup-cta").getAttribute("data-external-url"),
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
    h.document.getElementById("popup-cta").getAttribute("data-external-url"),
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
  assert.equal(h.document.getElementById("popup-status").textContent, "Your Library is full");
  assert.match(h.document.getElementById("popup-lead").textContent, /make room in Trace, or see Trace Unlimited/i);
  assert.equal(h.document.getElementById("popup-cta").textContent, "See Trace Unlimited");
  assert.equal(
    h.document.getElementById("popup-cta").dataset.externalUrl,
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
  assert.equal(button.textContent, "Import failed. Try again.");
  assert.equal(button.title, "collect_failed");
  assert.equal(h.document.getElementById("popup-import-recovery-help").hidden, true);
  assert.equal(button.hasAttribute("aria-describedby"), false);
});

function createSafariImportRecoveryHarness(options = {}) {
  return createPopupHarness({
    sessionMode: "kernel",
    popupUrl: "safari-web-extension://trace/popup.html",
    sessionSnapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
    popupState: { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true } },
    ...options,
  });
}

function assertNoImportRecoveryActions(h, messageStart, importCount) {
  // The story confirmation timer may refresh read-only popup state.
  assert.deepEqual(
    h.messages.slice(messageStart).map(({ type }) => type).filter((type) => type !== "TRACE_POPUP_GET_STATE"),
    Array(importCount).fill("TRACE_IMPORT_TRIGGER"),
  );
  // The reader view may ask the page for the story's visible title to display
  // it; that read is not a recovery action and changes nothing.
  const tabActions = h.tabMessages.filter(({ message }) => message?.type !== "TRACE_STORY_IDENTITY_GET");
  for (const calls of [h.permissionRequests, h.reconcileRequests, h.registrationRequests,
    tabActions, h.injections, h.reloads]) assert.deepEqual(calls, []);
}

for (const promiseRuntime of [false, true]) {
  test(`Safari collection recovery is accessible in the regular popup with the ${promiseRuntime ? "promise" : "callback"} API`, async () => {
    const h = createSafariImportRecoveryHarness({
      promiseRuntime,
      importResponse: { ok: false, error: "collect_failed" },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();
    const button = h.document.getElementById("popup-import");
    const help = h.document.getElementById("popup-import-recovery-help");
    const messageStart = h.messages.length;
    assert.equal(help.hidden, true);
    button.click();
    await flush();

    assert.equal(button.textContent, "Import failed. Try again.");
    assert.equal(button.title, "collect_failed");
    assert.equal(help.hidden, false);
    assert.equal(help.hasAttribute("role"), false);
    assert.equal(button.getAttribute("aria-describedby"), help.id);
    assert.equal(help.textContent,
      "Reload this story. If importing still fails, restart Safari and reopen the story.");
    h.runTimeouts();
    await flush();
    assertNoImportRecoveryActions(h, messageStart, 1);
    assert.equal(h.closeCalled, false);
  });
}

test("Safari collection recovery clears on a new intent and stays absent for other outcomes", async () => {
  const response = { ok: false, error: "collect_failed" };
  const h = createSafariImportRecoveryHarness({ promiseRuntime: true, importResponse: response });
  await flush();
  const button = h.document.getElementById("popup-import");
  const help = h.document.getElementById("popup-import-recovery-help");
  const messageStart = h.messages.length;
  let importCount = 0;
  for (const [error, label] of [
    ["native_import_unavailable", "Import unavailable. Try again."],
    ["permission_required", "Allow site access, then try again"],
    ["not_authenticated", "Reconnect Trace, then try again"],
    ["auth_expired", "Reconnect Trace, then try again"],
    ["unsupported_page", "Open a supported page"],
    ["no_active_tab", "Open a supported page"],
    ["unavailable", "Import failed. Try again."],
    [undefined, "Import failed. Try again."],
  ]) {
    response.error = "collect_failed";
    button.click();
    importCount += 1;
    await flush();
    assert.equal(help.hidden, false);
    response.error = error;
    button.click();
    importCount += 1;
    assert.equal(help.hidden, true, "a new intent clears prior guidance before its reply");
    assert.equal(help.textContent, "");
    assert.equal(button.hasAttribute("aria-describedby"), false);
    await flush();
    assert.equal(help.hidden, true);
    assert.equal(button.textContent, label);
    assertNoImportRecoveryActions(h, messageStart, importCount);
  }

  response.error = "collect_failed";
  button.click();
  importCount += 1;
  await flush();
  assert.equal(help.hidden, false);
  delete response.error;
  Object.assign(response, { ok: true, state: "ready_to_open",
    handoffID: "00000000-0000-4000-8000-000000000001",
    expiresAtMs: Date.now() + 600000, snapshot: { state: "connected" } });
  button.click();
  importCount += 1;
  await flush();
  assert.equal(help.hidden, true);
  assert.equal(button.hasAttribute("aria-describedby"), false);
  assert.equal(h.document.getElementById("popup-import-open-native").hidden, false);
  assertNoImportRecoveryActions(h, messageStart, importCount);
});

test("Safari collection recovery clears when the popup loses its connected state", async () => {
  const h = createPopupHarness({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    storageState: { traceAuthState: { state: "connected" }, traceFirstSaveSeen: true },
    popupState: { firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true } },
    importResponse: { ok: false, error: "collect_failed" },
  });
  await flush();
  const button = h.document.getElementById("popup-import");
  const help = h.document.getElementById("popup-import-recovery-help");
  const messageStart = h.messages.length;
  button.click();
  assert.equal(help.hidden, false);
  h.emitStorageChange({ traceAuthState: { newValue: { state: "signed_out" } } });
  assert.equal(button.hidden, true);
  assert.equal(help.hidden, true);
  assert.equal(help.textContent, "");
  assert.equal(button.hasAttribute("aria-describedby"), false);
  assertNoImportRecoveryActions(h, messageStart, 1);
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
  assert.equal(button.textContent, "Allow site access, then try again");
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

test("native staged Import uses a fresh direct link without claiming opened or saved", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    sessionSnapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
    popupState: { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true } },
    importResponse: { ok: true, state: "ready_to_open", handoffID: "00000000-0000-4000-8000-000000000001",
      expiresAtMs: Date.now() + 600000, snapshot: { state: "connected" } },
  });
  await flush();
  const button = h.document.getElementById("popup-import");
  button.click();
  const link = h.document.getElementById("popup-import-open-native");
  assert.equal(button.hidden, true);
  assert.equal(link.hidden, false);
  assert.equal(link.textContent, "Open in Trace");
  assert.equal(link.getAttribute("href"), "traceauth://open?destination=library-import&handoff=00000000-0000-4000-8000-000000000001");
  assert.equal(h.closeCalled, false);
});

test("native Import rejects a malformed continuation instead of opening a supplied URL", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel", sessionSnapshot: { state: "connected" },
    popupState: { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true } },
    importResponse: { ok: true, state: "ready_to_open", handoffID: "https://untrusted.example.test",
      expiresAtMs: Date.now() + 600000, snapshot: { state: "connected" } },
  });
  await flush();
  h.document.getElementById("popup-import").click();
  const link = h.document.getElementById("popup-import-open-native");
  assert.equal(link.hidden, true);
  assert.equal(link.getAttribute("href"), null);
  assert.equal(h.closeCalled, false);
});


test("an expired earned grant shows P3 lapse before a saved story can appear", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    permissionContainsResult: false,
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 86_400_000 } },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P3-lapse");
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Next, tap Always Allow.");
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Allow story sites");
  assert.equal(h.document.getElementById("popup-earned-record").hidden, true);
  assert.equal(h.messages.some(({ type }) => type === "TRACE_SESSION_GET_SNAPSHOT"), false);
  assert.ok(h.store.traceEarnedPermissionOnboardingV1.completedAt > 0);
});

test("P10 quick save is sent once while pending and automatic saving toggle persists", async () => {
  const popupState = { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
    activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    activeWork: null, autoTrackEnabled: false };
  const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true,
    earnedPermissionOnboarding: true, grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5000 } },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true },
    popupState });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P10");
  const primary = h.document.getElementById("popup-earned-primary");
  primary.click();
  primary.click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(h.tabMessages.filter(({ message }) => message.type === "TRACE_POPUP_QUICK_ADD").length, 1);
  assert.equal(primary.disabled, true);
  assert.notEqual(h.document.body.dataset.tracePopupStateCode, "P11", "confirmation is required");
  popupState.autoTrackEnabled = true; // background reads the newly persisted preference
  h.document.getElementById("popup-earned-secondary").click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(h.store.prefAutoTrackEnabled, true);
  assert.ok(h.tabMessages.some(({ message }) => message.type === "TRACE_SCHEDULE_AUTO_TRACK"));
  assert.equal(h.document.getElementById("pref-auto-track").checked, true);
});

test("P11 status menu and Settings use relay with broken direct tab messaging", async () => {
  const h = createPopupHarness({ sessionMode: "kernel", directTabUnavailable: true, promiseRuntime: true,
    earnedPermissionOnboarding: true, grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5000 } },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true },
    popupState: { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      activeWork: { status: "saved", entry: { entryId: "00000000-0000-4000-8000-000000000123",
        status: "PLANNING", canonicalReaderStatus: "SAVED", chapters: { current: 5, total: 12 } } },
      autoTrackEnabled: true } });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P11");
  assert.equal(h.document.getElementById("popup-import").hidden, true);
  assert.equal(h.document.getElementById("popup-earned-primary").hidden, true);
  const control = h.document.getElementById("popup-earned-status-control");
  assert.equal(control.getAttribute("aria-label"), "Reading status: Saved");
  control.click();
  const menu = h.document.getElementById("popup-earned-status-menu");
  assert.deepEqual([...menu.querySelectorAll("button")].map((item) => item.textContent.replace("✓", "")),
    ["Saved", "Reading", "Caught up", "Paused", "Finished", "Dropped"]);
  assert.deepEqual([...menu.querySelectorAll(".popup-earned-record-dot")].map((dot) => dot.dataset.status),
    ["SAVED", "READING", "CAUGHT_UP", "PAUSED", "FINISHED", "DROPPED"]);
  assert.equal([...menu.querySelectorAll(".popup-earned-record-dot")].every((dot) => dot.getAttribute("aria-hidden") === "true"), true);
  menu.querySelectorAll("button")[1].click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(h.tabMessages.some(({ message }) => message.type === "TRACE_POPUP_SET_READER_STATUS" && message.status === "READING"), true);
  assert.equal(control.getAttribute("aria-label"), "Reading status: Reading");
  // Status appears once, in the control; the line beside it is progress only.
  assert.equal(h.document.querySelector(".popup-earned-record-state").hidden, true);
  assert.equal(h.document.getElementById("popup-earned-progress").textContent, "Chapter 5 of 12");
  assert.equal(h.document.getElementById("popup-earned-progress").hidden, false);
  h.document.getElementById("popup-earned-settings-row").click();
  assert.equal(h.document.body.dataset.traceReaderView, "settings");
  assert.equal(h.document.getElementById("popup-session-secondary").textContent.trim(), "Disconnect");
  assert.equal(h.document.getElementById("popup-preferences").hidden, false);
  h.document.getElementById("popup-earned-settings-back").click();
  assert.equal(h.document.body.dataset.traceReaderView, "true");
});


test("iOS popup typography scales and mono stays in the developer probe", () => {
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes('[data-trace-platform="ios"]'));
  assert.ok(rules.length > 0);
  for (const [, selector, declarations] of rules) {
    assert.doesNotMatch(declarations, /font(?:-size)?\s*:[^;]*\b\d+(?:\.\d+)?px\b/i, selector);
  }
  for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (declarations.includes("var(--trace-mono)")) {
      assert.match(selector, /\.popup-probe-/, "mono is reserved for the developer probe");
    }
  }
});


test("P10 confirmed save refreshes the reader after presentation changes session CSS state", async () => {
  const state = { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
    activeTab: { kind: "supported_story", site: "ao3" }, activeWork: null, autoTrackEnabled: false };
  const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true,
    earnedPermissionOnboarding: true, grantedOrigins: [...FULL_EARNED_ORIGINS],
    sessionSnapshot: { state: "connected", canExecuteAuthenticated: true }, popupState: state,
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: 1 } } });
  for (let i=0;i<8;i++) await flush();
  state.activeWork = { status: "saved", entry: { entryId: "00000000-0000-4000-8000-000000000123", canonicalReaderStatus: "SAVED" } };
  h.evaluate("requestKernelPopupState()");
  for (let i=0;i<8;i++) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P11");
});



test("disconnected cached story offers Reload page and re-queries after reload", async () => {
  const response = { ok: false, error: "page_unavailable" };
  const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true,
    earnedPermissionOnboarding: true, probeSaveResponse: response, grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: 1 } },
    sessionSnapshot: { state: "connected", canExecuteAuthenticated: true },
    popupState: { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3" },
      activeWork: { status: "saved", entry: { canonicalReaderStatus: "READING" } } } });
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Reload this page to keep going");
  const button = h.document.getElementById("popup-earned-primary");
  assert.equal(button.textContent, "Reload page");
  assert.equal(button.dataset.emphasis, "primary");
  Object.assign(response, { ok: true, error: undefined, title: "Recovered story", site: "AO3" });
  button.click();
  for (let i = 0; i < 8; i++) await flush();
  assert.deepEqual(h.reloads, [7]);
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Recovered story");
  assert.equal(h.permissionRequests.length, 0);
  h.window.close();
});

test("page identity deadline settles when Safari never answers", async () => {
  const h = createPopupHarness();
  h.evaluate("probeQueryActiveTab = () => new Promise(() => {})");
  const pending = h.evaluate("readActiveStoryIdentity()");
  h.runTimeouts();
  assert.equal((await pending).pageUnavailable, true);
});

test("popup CSS keeps one system type ladder with no px fonts, stylistic sets or serif", () => {
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Every rule can reach iOS, not only selectors that name the platform.
    // The desktop base is the one px size; iOS replaces it with -apple-system-body.
    if (selector.trim() === "body") continue;
    // A px value inside min() is a cap on an em size, not a fixed size.
    const scaled = declarations.replace(/min\([^)]*\)/g, "min()");
    assert.doesNotMatch(scaled, /font(?:-size)?\s*:[^;]*\b\d+(?:\.\d+)?px\b/i, selector.trim());
    assert.doesNotMatch(declarations, /outline:\s*\d+px solid/i, `${selector.trim()} uses the system focus ring`);
  }
  assert.doesNotMatch(css, /font-feature-settings|ss01/);
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssWithoutComments, /Georgia|New York|ui-serif|(?<!sans-)serif\b/i);
  assert.doesNotMatch(css, /popup-connection|popup-brand-mark/);
  assert.match(css, /body \{[^}]*font-size:\s*16px;/, "desktop popups use a 16 px base");
  assert.match(css, /--switch-thumb:\s*#ffffff;/);
  assert.doesNotMatch(css.match(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}/)[0], /--switch-thumb/,
    "the switch thumb stays white on the vermilion track in dark mode");
  assert.match(css, /\.popup-earned-status-control \{[^}]*min-height:\s*44px;[^}]*border-radius:\s*12px;/);
});

test("identity conflict gets its own truthful state with one route out", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    earnedPermissionOnboarding: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 } },
    sessionSnapshot: { state: "reconnect_required", accountId: null, canExecuteAuthenticated: false, reason: "identity_conflict" },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "other-account");
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Safari was signed in to another account");
  assert.match(h.document.getElementById("popup-earned-lead").textContent, /Nothing was saved\./);
  assert.doesNotMatch(h.document.getElementById("popup-earned-lead").textContent, /Create an account/);
  const primary = h.document.getElementById("popup-earned-primary");
  assert.equal(primary.textContent, "Open Trace");
  assert.equal(primary.dataset.earnedAction, "open_connect");
  assert.equal(h.document.getElementById("popup-earned-secondary").hidden, true);
});

test("P10 save failure is stated in place and never silently re-enables", async () => {
  const response = { ok: false, error: "save_failed" };
  const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true,
    earnedPermissionOnboarding: true, grantedOrigins: [...FULL_EARNED_ORIGINS], probeSaveResponse: response,
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: 1 } },
    sessionSnapshot: { state: "connected", canExecuteAuthenticated: true },
    popupState: { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3" }, activeWork: null, autoTrackEnabled: false } });
  for (let i = 0; i < 8; i++) await flush();
  // The identity lookup shares the stubbed tab response, so the page reads as reachable.
  const primary = h.document.getElementById("popup-earned-primary");
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P10");
  assert.equal(primary.textContent, "Save this story");
  primary.click();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P10-saving");
  assert.equal(primary.textContent, "Saving…");
  assert.equal(primary.disabled, true);
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P10-failed");
  const failure = h.document.getElementById("popup-earned-failure");
  assert.ok(failure && !failure.hidden);
  assert.match(failure.textContent, /Nothing was saved/);
  assert.ok(failure.querySelector(".popup-earned-failure-glyph svg"));
  assert.equal(primary.textContent, "Try again");
  assert.equal(primary.disabled, false);
});

test("session handover shows a neutral check, not Saving, for a story already in the Library", async () => {
  const snapshot = (state) => ({ ok: true, snapshot: { state, reason: "none" } });
  const h = createPopupHarness({
    sessionMode: "kernel",
    earnedPermissionOnboarding: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: {
      traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 },
      libraryOverlayCache: { entries: { "ao3:123": { entryId: "00000000-0000-4000-8000-000000000123", status: "READING" } } },
    },
    sessionSnapshotResponses: [snapshot("initializing"), snapshot("connecting")],
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "checking");
  assert.doesNotMatch(h.document.getElementById("popup-earned-heading").textContent, /Saving/);
  assert.match(h.document.getElementById("popup-earned-record-label").textContent, /Checking your Library/);
  assert.equal(h.document.getElementById("popup-earned-pin").hidden, true);
});

const DESKTOP_ARCHIVE_ACCESS = [{ site: "all", label: "AO3 and FanFiction.net", origins: [
  "https://archiveofourown.org/*", "https://*.archiveofourown.org/*", "https://archiveofourown.gay/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*", "https://m.fanfiction.net/*", "https://www.tracefiction.com/*", "https://api.tracefiction.com/*",
] }];
for (const promiseRuntime of [true, false]) {
  test(`missing host access is explained before account state and requested directly on click (${promiseRuntime})`, async () => {
    const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime,
      archiveAccess: DESKTOP_ARCHIVE_ACCESS, grantedOrigins: [],
      sessionSnapshot: { state: "connected", reason: "none" },
    });
    await flush();
    const button = h.document.getElementById("popup-host-access-allow");
    assert.equal(h.document.getElementById("popup-host-access").hidden, false);
    assert.equal(h.document.body.dataset.traceHostAccess, "missing");
    assert.equal(button.textContent, "Allow Trace on AO3 and FanFiction.net");
    assert.match(h.document.getElementById("popup-host-access-lead").textContent, /without opening this popup each time/);
    assert.equal(h.permissionRequests.length, 0);
    button.click();
    assert.equal(h.permissionRequests.length, 1, "request starts in the same click, before awaiting");
    assert.deepEqual(Array.from(h.permissionRequests[0].origins), DESKTOP_ARCHIVE_ACCESS[0].origins);
    assert.equal(h.closeCalled, true, "popup closes synchronously after starting the request");
    assert.deepEqual(h.hostLifecycle.slice(-2), ["request", "close"]);
    await flush();
    assert.equal(h.messages.some(message => message.type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH"), false, "grant recovery belongs to the background after popup destruction");
  });
  test(`denied and rejected host requests close; reopening offers Allow again (${promiseRuntime})`, async () => {
    for (const permissionRequestError of [null, "user gesture rejected"]) {
      const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime, archiveAccess: DESKTOP_ARCHIVE_ACCESS,
        permissionRequestResult: false, permissionRequestError });
      await flush(); h.document.getElementById("popup-host-access-allow").click(); await flush();
      assert.equal(h.document.getElementById("popup-host-access").hidden, false);
      assert.equal(h.closeCalled, true);
      const reopened = createPopupHarness({ sessionMode: "kernel", promiseRuntime, archiveAccess: DESKTOP_ARCHIVE_ACCESS, permissionRequestResult: false });
      await flush();
      assert.equal(reopened.document.getElementById("popup-host-access-allow").disabled, false);
      assert.equal(reopened.document.getElementById("popup-host-access").hidden, false);
    }
  });
  test(`popup closes before a pending browser permission decision (${promiseRuntime})`, async () => {
    const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime, archiveAccess: DESKTOP_ARCHIVE_ACCESS, deferredHostRequest: true });
    await flush(); h.document.getElementById("popup-host-access-allow").click();
    assert.equal(h.closeCalled, true);
    assert.deepEqual(h.hostLifecycle.slice(-2), ["request", "close"]);
    h.finishHostRequest(true); await flush();
    assert.equal(h.messages.some(message => message.type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH"), false);
  });
}
test("granted desktop hosts and Safari keep their normal popup", async () => {
  for (const userAgent of ["Firefox/145.0", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)"]) {
    const h = createPopupHarness({ sessionMode: "kernel", promiseRuntime: true, archiveAccess: DESKTOP_ARCHIVE_ACCESS,
      grantedOrigins: DESKTOP_ARCHIVE_ACCESS.flatMap(item => item.origins), userAgent });
    await flush(); assert.equal(h.document.getElementById("popup-host-access").hidden, true);
    assert.equal(h.permissionRequests.length, 0);
  }
});
test("popup presence reconnects after a worker restart but stops when the popup leaves", async () => {
  const h = createPopupHarness({ sessionMode: "kernel", archiveAccess: DESKTOP_ARCHIVE_ACCESS });
  await flush();
  const connections = () => h.hostLifecycle.filter(item => item === "trace-archive-access-popup").length;
  assert.equal(connections(), 1);
  h.disconnectPopup(); h.runTimeouts();
  assert.equal(connections(), 2, "visible popup re-establishes presence");
  h.window.dispatchEvent(new h.window.Event("pagehide"));
  h.disconnectPopup(); h.runTimeouts();
  assert.equal(connections(), 2, "a closing popup never reconnects");
});
test("Safari's popup does not open a desktop presence port", async () => {
  const h = createPopupHarness({ sessionMode: "kernel", archiveAccess: DESKTOP_ARCHIVE_ACCESS,
    popupUrl: "safari-web-extension://trace/popup.html", grantedOrigins: DESKTOP_ARCHIVE_ACCESS[0].origins });
  await flush();
  assert.equal(h.hostLifecycle.length, 0);
});
test("Trace-only gaps and either archive tab offer the same full-host request", async () => {
  for (const missing of ["https://www.tracefiction.com/*", "https://api.tracefiction.com/*"]) {
    const h = createPopupHarness({ sessionMode: "kernel", archiveAccess: DESKTOP_ARCHIVE_ACCESS,
      grantedOrigins: DESKTOP_ARCHIVE_ACCESS[0].origins.filter(origin => origin !== missing),
      activeTab: { id: 7, url: "https://www.fanfiction.net/s/123/1" } });
    await flush();
    const button = h.document.getElementById("popup-host-access-allow");
    assert.equal(button.textContent, "Allow Trace on AO3 and FanFiction.net");
    button.click(); await flush();
    assert.deepEqual(Array.from(h.permissionRequests[0].origins), DESKTOP_ARCHIVE_ACCESS[0].origins);
    assert.equal(h.permissionRequests.length, 1);
    assert.equal(h.closeCalled, true);
  }
});
