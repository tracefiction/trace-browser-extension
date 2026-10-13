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

/** A page that can name its story. */
function namedStory(message) {
  return message.type === "TRACE_STORY_IDENTITY_GET"
    ? { ok: true, title: "The Long Way Round", author: "quillfeather", site: "ao3" }
    : undefined;
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
  platformOs = null,
  maxTouchPoints = 0,
  tabResponse = null,
  storageWritesFail = false,
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
  // Timers run on a clock the test moves, so delays and limits are real.
  const timeouts = [];
  let clock = 0;
  let timerSequence = 0;
  const runTimer = (timer) => {
    const index = timeouts.indexOf(timer);
    if (index < 0) return;
    timeouts.splice(index, 1);
    clock = Math.max(clock, timer.at);
    timer.fn();
  };
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
  const heldSnapshotReplies = [];
  const createdTabs = [];
  const permissionListeners = { added: [], removed: [] };
  // The background's side of the first-tap port: what the popup asked for,
  // and a way to send it a state.
  const firstTap = {
    commands: [],
    tabIds: [],
    messages: [],
    listeners: [],
    show(view) { for (const listener of firstTap.listeners) listener({ view }); },
    /** The state of the ask for lasting access, with or without a save state. */
    showAccess(access, view) { for (const listener of firstTap.listeners) listener(view ? { view, access } : { access }); },
  };
  let finishHostRequest;

  const ext = {
    runtime: {
      lastError: null,
      getURL: resource => `${popupUrl.startsWith("safari-web-extension:") ? "safari-web-extension" : promiseRuntime ? "moz-extension" : "chrome-extension"}://trace-test/${resource}`,
      connect({ name }) {
        hostLifecycle.push(name);
        if (name === "trace-first-tap-popup-v1") {
          return {
            postMessage(message) { firstTap.commands.push(message.command); firstTap.tabIds.push(message.tabId); firstTap.messages.push(message); },
            onMessage: { addListener(fn) { firstTap.listeners.push(fn); } },
            onDisconnect: { addListener(fn) { popupDisconnects.push(fn); } },
          };
        }
        return { onDisconnect: { addListener(fn) { popupDisconnects.push(fn); } } };
      },
      getManifest: () => ({ host_permissions: (archiveAccess || []).flatMap(item => item.origins) }),
      ...(platformOs ? {
        getPlatformInfo(callback) {
          if (promiseRuntime) return Promise.resolve({ os: platformOs });
          callback?.({ os: platformOs });
        },
      } : {}),
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
          response = tabResponse?.(message.command) ?? probeSaveResponse;
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
          if (response && response.held === true) {
            // A slow read: the test answers it later with answerSnapshot().
            if (promiseRuntime) return new Promise((resolve) => heldSnapshotReplies.push(resolve));
            heldSnapshotReplies.push(callback);
            return;
          }
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
          if (typeof storageWritesFail === "function" ? storageWritesFail(obj || {}) : storageWritesFail) {
            if (promiseRuntime) return Promise.reject(new Error("storage unavailable"));
            ext.runtime.lastError = { message: "storage unavailable" };
            callback?.();
            ext.runtime.lastError = null;
            return;
          }
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
      create(properties, callback) {
        createdTabs.push(properties.url);
        if (promiseRuntime) return Promise.resolve({ id: 99 });
        callback?.({ id: 99 });
      },
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
          : tabResponse?.(message) ?? probeSaveResponse;
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
      onAdded: { addListener(fn) { permissionListeners.added.push(fn); } },
      onRemoved: { addListener(fn) { permissionListeners.removed.push(fn); } },
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
    navigator: { userAgent, maxTouchPoints },
    globalThis: null,
    setTimeout(fn, ms) {
      timerSequence += 1;
      timeouts.push({ id: timerSequence, fn, ms, at: clock + (Number(ms) || 0) });
      return timerSequence;
    },
    clearTimeout(id) {
      const index = timeouts.findIndex((timer) => timer.id === id);
      if (index >= 0) timeouts.splice(index, 1);
    },
    TRACE_SESSION_MODE: sessionMode,
  };
  if (traceWebOrigin !== undefined) {
    context.TRACE_EXTENSION_WEB_ORIGIN = traceWebOrigin;
  }
  if (activeTabProbe) context.TRACE_IOS_ACTIVE_TAB_PROBE = true;
  if (earnedPermissionOnboarding) {
    context.TRACE_IOS_ACTIVE_TAB_PROBE = true;
    context.TRACE_IOS_EARNED_PERMISSION_ONBOARDING = {
      ...(earnedPermissionOnboarding === true ? {} : earnedPermissionOnboarding),
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
    createdTabs,
    injections,
    permissionRequests,
    hostLifecycle,
    firstTap,
    disconnectPopup: () => popupDisconnects.at(-1)(),
    /** Safari reports that website access was added or removed. */
    emitPermissionChange(kind) { for (const fn of permissionListeners[kind]) fn({ origins: [] }); },
    answerSnapshot: (reply) => heldSnapshotReplies.shift()?.(reply),
    finishHostRequest: result => finishHostRequest(result),
    registrationRequests,
    reconcileRequests,
    reloads,
    get closeCalled() {
      return closeCalled;
    },
    /**
     * Moves the clock to the last timer now pending, running every timer
     * that comes due on the way in order, including ones set meanwhile.
     */
    runTimeouts() {
      if (timeouts.length === 0) return;
      this.advance(Math.max(...timeouts.map((timer) => timer.at)) - clock);
    },
    /** Moves the clock forward, running each timer as it comes due. */
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = timeouts.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        runTimer(next);
      }
      clock = end;
    },
    pendingTimers: () => timeouts.map((timer) => timer.at - clock).sort((a, b) => a - b),
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
    // The site's home page has no story titles, so the prompt names none.
    assert.equal(h.document.getElementById("popup-earned-heading").textContent,
      "Open any story", url);
    assert.equal(h.document.getElementById("popup-earned-lead").textContent,
      "Trace saves it when it opens.", url);
    assert.doesNotMatch(h.document.getElementById("popup-earned-permission").textContent,
      /Tap a title/, url);
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
    "Open any story");
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
    "Open any story");
  assert.equal(h.document.getElementById("popup-earned-lead").textContent,
    "Trace saves it when it opens.");
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
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      activeTab: { id: 7, url },
      popupState: { ok: true, authState: { state: "signed_out" } },
      // The Trace app answered that it holds no account.
      sessionSnapshot: { state: "signed_out", accountId: null, canExecuteAuthenticated: false, reason: "credential_absent" },
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
    tabResponse: namedStory,
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  h.emitStorageChange({ traceArchiveReadiness: { newValue: { lastArchiveSeenAt: grantAt + 1_000 } } });
  for (let attempt = 0; attempt < 12; attempt += 1) await flush();

  assert.match(h.document.getElementById("popup-earned-kicker").textContent, /Library/);
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "The Long Way Round");
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

for (const reason of [
  "credential_absent",
  "credential_rejected",
  "account_unavailable",
  "invalid_account_response",
  "storage_write_failed",
  "malformed_envelope",
  "identity_conflict",
]) {
  test(`a reader who has never connected is not told to reconnect (${reason})`, async () => {
    const h = createPopupHarness({
      sessionMode: "kernel",
      sessionSnapshot: {
        state: "reconnect_required",
        canExecuteAuthenticated: false,
        reason,
        neverConnected: true,
      },
    });
    await flush();

    const primary = h.document.getElementById("popup-cta");
    assert.equal(primary.textContent, "Connect");
    assert.equal(primary.dataset.sessionAction, "reconnect");
    if (reason !== "identity_conflict") {
      assert.equal(h.document.getElementById("popup-status").textContent, "Connect Trace");
    }
    assert.match(h.document.getElementById("popup-lead").textContent, /Connect/);
    assert.doesNotMatch(h.document.querySelector(".popup-shell, main, body").textContent, /reconnect/i);
  });
}

test("a reader who was connected before is still asked to reconnect", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    sessionSnapshot: {
      state: "reconnect_required",
      canExecuteAuthenticated: false,
      reason: "credential_rejected",
    },
  });
  await flush();

  assert.equal(h.document.getElementById("popup-status").textContent, "Reconnect Trace");
  assert.equal(h.document.getElementById("popup-cta").textContent, "Reconnect");
  assert.match(h.document.getElementById("popup-lead").textContent, /then press Reconnect\./);
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const CONNECTED_REPLY = { ok: true, snapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" } };
// The Trace app's account could not be read: whether one exists is unknown.
const UNREADABLE_REPLY = {
  ok: true,
  snapshot: { state: "signed_out", accountId: null, canExecuteAuthenticated: false, reason: "provider_unavailable" },
  action: { kind: "unavailable" },
};
// The Trace app answered that it holds no account.
const NO_ACCOUNT_REPLY = {
  ok: true,
  snapshot: { state: "signed_out", accountId: null, canExecuteAuthenticated: false, reason: "credential_absent" },
  action: { kind: "unavailable" },
};
// Trace refused the account the app holds.
const REFUSED_REPLY = {
  ok: true,
  snapshot: { state: "reconnect_required", accountId: null, canExecuteAuthenticated: false, reason: "credential_rejected" },
  action: { kind: "completed", state: "reconnect_required" },
};
// The background is still reading or verifying the account.
const STILL_READING_REPLY = {
  ok: true,
  snapshot: { state: "connecting", accountId: null, canExecuteAuthenticated: false, reason: "none" },
};
// A read that has not come back yet; see answerSnapshot().
const SLOW_REPLY = { held: true };
const CONNECTED_AUTH = { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" };
const ACCOUNT_CONNECTED = { traceAccountProjectionRevisionV1: { newValue: "account-connected" } };

function iosLinkedPopupHarness(sessionSnapshotResponses, options = {}) {
  return createPopupHarness({
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    sessionMode: "kernel",
    earnedPermissionOnboarding: true,
    userAgent: IPHONE_UA,
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5000 } },
    sessionSnapshotResponses,
    ...options,
  });
}

async function settle(h, rounds = 8) {
  for (let attempt = 0; attempt < rounds; attempt += 1) await flush();
}

/** Lets `ms` pass on the popup's clock, then lets its replies arrive. */
async function pass(h, ms) {
  h.advance(ms);
  await settle(h, 12);
}

function snapshotRequests(h) {
  return h.messages.filter(({ type }) => type === "TRACE_SESSION_GET_SNAPSHOT").length;
}

function earnedText(h) {
  return h.document.getElementById("popup-earned-permission").textContent;
}

function earnedHeading(h) {
  return h.document.getElementById("popup-earned-heading").textContent;
}

const CONNECTING = "Connecting to your account…";
const COULD_NOT_CONNECT = "Trace couldn’t connect to your account";
const NO_ACCOUNT = "Finish setup in the Trace app";

/** The account is asked for at 0, 1, 3 and 7 seconds, and not otherwise. */
async function assertBackOff(h) {
  for (const [wait, requests] of [[999, 1], [1, 2], [1999, 2], [1, 3], [3999, 3]]) {
    await pass(h, wait);
    assert.equal(snapshotRequests(h), requests);
    assert.equal(earnedHeading(h), CONNECTING);
    assert.doesNotMatch(earnedText(h), /Create an account|Finish setup|couldn’t connect/);
  }
  await pass(h, 1);
  assert.equal(snapshotRequests(h), 4);
}

test("iOS: an unreadable app account says Connecting, never Create an account, then says it couldn't connect", async () => {
  const h = iosLinkedPopupHarness(Array(8).fill(UNREADABLE_REPLY));
  await settle(h);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "connecting-account");
  assert.equal(h.document.getElementById("popup-earned-pin").hidden, true, "nothing to tap while connecting");
  await assertBackOff(h);

  // Three follow-ups, further apart each time, then an honest stop.
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "account-unreachable");
  assert.doesNotMatch(earnedText(h), /Create an account|Finish setup/);
  const primary = h.document.getElementById("popup-earned-primary");
  assert.equal(primary.textContent, "Open Trace");
  assert.equal(primary.dataset.earnedAction, "open_connect");
  assert.equal(primary.dataset.emphasis, "primary");
  const secondary = h.document.getElementById("popup-earned-secondary");
  assert.equal(secondary.textContent, "Try again");
  assert.equal(secondary.dataset.emphasis, "tertiary");

  await pass(h, 10 * 60_000);
  assert.equal(snapshotRequests(h), 4, "the wait is bounded: nothing keeps asking");
});

test("iOS: the wait for the app's account backs off, re-reads no-account once, and is capped", () => {
  const h = createPopupHarness();
  assert.deepEqual([...h.evaluate("APP_ACCOUNT_RETRY_DELAYS_MS")], [1000, 2000, 4000]);
  assert.equal(h.evaluate("APP_ACCOUNT_RECHECK_MS"), 1200);
  assert.equal(h.evaluate("APP_ACCOUNT_WAIT_LIMIT_MS"), 10000);
});

test("iOS: an account that connects during the wait opens the reader view", async () => {
  const h = iosLinkedPopupHarness([UNREADABLE_REPLY, UNREADABLE_REPLY, CONNECTED_REPLY]);
  await settle(h);
  assert.equal(earnedHeading(h), CONNECTING);
  await pass(h, 1000);
  await pass(h, 2000);
  assert.equal(snapshotRequests(h), 3);
  assert.doesNotMatch(earnedText(h), /Create an account|Finish setup|couldn’t connect/);
  assert.equal(h.messages.some(({ type }) => type === "TRACE_POPUP_GET_STATE"), true);
  assert.notEqual(h.document.body.dataset.traceReaderView, "link");
});

test("iOS: Create an account or sign in is shown at once when the app has no account, and re-read once", async () => {
  const h = iosLinkedPopupHarness(Array(8).fill(NO_ACCOUNT_REPLY));
  await settle(h);
  assert.equal(snapshotRequests(h), 1);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P6");
  assert.equal(earnedHeading(h), NO_ACCOUNT);
  assert.match(h.document.getElementById("popup-earned-lead").textContent, /^Create an account or sign in, then come back to this story\./);
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Open Trace");
  assert.equal(h.document.getElementById("popup-earned-secondary").hidden, true);

  // One quiet look a moment later, for a reader who has only just signed up.
  await pass(h, 1199);
  assert.equal(snapshotRequests(h), 1);
  await pass(h, 1);
  assert.equal(snapshotRequests(h), 2);
  assert.equal(earnedHeading(h), NO_ACCOUNT);
  await pass(h, 10 * 60_000);
  assert.equal(snapshotRequests(h), 2, "a definite answer is not polled");
});

test("iOS: a reader who has just signed up is connected by the quiet second look", async () => {
  const h = iosLinkedPopupHarness([NO_ACCOUNT_REPLY, CONNECTED_REPLY]);
  await settle(h);
  assert.equal(earnedHeading(h), NO_ACCOUNT);
  await pass(h, 1200);
  assert.equal(snapshotRequests(h), 2);
  assert.notEqual(h.document.body.dataset.traceReaderView, "link");
  assert.equal(h.document.body.dataset.tracePopupState, "connected");
  assert.equal(h.messages.some(({ type }) => type === "TRACE_POPUP_GET_STATE"), true);
});

test("iOS: an account Trace refused is not described as having no account", async () => {
  const h = iosLinkedPopupHarness(Array(8).fill(REFUSED_REPLY));
  await settle(h);
  assert.equal(snapshotRequests(h), 1);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  assert.doesNotMatch(earnedText(h), /Create an account|Finish setup/);
  assert.equal(h.document.getElementById("popup-earned-primary").dataset.earnedAction, "open_connect");
  await pass(h, 10 * 60_000);
  assert.equal(snapshotRequests(h), 1);
});

test("iOS: Try again makes one more bounded attempt to connect", async () => {
  const h = iosLinkedPopupHarness([...Array(6).fill(UNREADABLE_REPLY), CONNECTED_REPLY]);
  await settle(h);
  await pass(h, 7000);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  assert.equal(snapshotRequests(h), 4);

  h.document.getElementById("popup-earned-secondary").click();
  await settle(h);
  assert.equal(earnedHeading(h), CONNECTING);
  assert.equal(snapshotRequests(h), 5);
  await pass(h, 999);
  assert.equal(snapshotRequests(h), 5, "the second round backs off like the first");
  await pass(h, 1);
  assert.equal(snapshotRequests(h), 6);
  await pass(h, 2000);
  assert.equal(snapshotRequests(h), 7);
  assert.doesNotMatch(earnedText(h), /Create an account/);
  assert.equal(h.document.body.dataset.tracePopupState, "connected");
});

for (const [name, replies, lead, heading] of [
  ["Connecting", [UNREADABLE_REPLY], 0, CONNECTING],
  ["no account", [NO_ACCOUNT_REPLY, NO_ACCOUNT_REPLY], 5000, NO_ACCOUNT],
  ["couldn't connect", Array(4).fill(UNREADABLE_REPLY), 7000, COULD_NOT_CONNECT],
  ["a refused account", [REFUSED_REPLY], 5000, COULD_NOT_CONNECT],
]) {
  test(`iOS: a popup showing ${name} moves on by itself when the background says an account connected`, async () => {
    const h = iosLinkedPopupHarness([...replies, CONNECTED_REPLY]);
    await settle(h);
    await pass(h, lead);
    assert.equal(earnedHeading(h), heading);
    assert.equal(snapshotRequests(h), replies.length);

    h.emitStorageChange(ACCOUNT_CONNECTED);
    await settle(h);
    assert.equal(snapshotRequests(h), replies.length + 1, "asked at once, with no timer run");
    assert.notEqual(h.document.body.dataset.traceReaderView, "link", "the account view has gone");
    assert.equal(h.document.body.dataset.tracePopupState, "connected");
    assert.equal(h.messages.some(({ type }) => type === "TRACE_POPUP_GET_STATE"), true);
  });
}

test("iOS: a published change that brings no account leaves a settled view alone", async () => {
  const h = iosLinkedPopupHarness(Array(12).fill(UNREADABLE_REPLY));
  await settle(h);
  await pass(h, 7000);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  for (let change = 1; change <= 3; change += 1) {
    h.emitStorageChange({ traceAccountProjectionRevisionV1: { newValue: `r${change}` } });
    await settle(h);
    assert.equal(snapshotRequests(h), 4 + change, "one question per published change, no more");
    assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  }
  await pass(h, 10 * 60_000);
  assert.equal(snapshotRequests(h), 7, "and no timer was started by them");

  const none = iosLinkedPopupHarness([NO_ACCOUNT_REPLY, NO_ACCOUNT_REPLY, UNREADABLE_REPLY]);
  await settle(none);
  await pass(none, 1200);
  none.emitStorageChange(ACCOUNT_CONNECTED);
  await settle(none);
  assert.equal(earnedHeading(none), NO_ACCOUNT, "a failed read does not replace a definite answer");
});

test("an iPad that reports a desktop user agent keeps the general view's own copy, and its wait is bounded", async () => {
  const h = iosLinkedPopupHarness(Array(12).fill(UNREADABLE_REPLY), {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
  });
  await settle(h);
  const status = () => h.document.getElementById("popup-status").textContent;
  for (const [wait, requests] of [[0, 1], [1000, 2], [2000, 3]]) {
    await pass(h, wait);
    assert.equal(snapshotRequests(h), requests);
    assert.equal(status(), "Checking Trace…");
  }
  await pass(h, 4000);
  assert.equal(snapshotRequests(h), 4);
  assert.equal(status(), "Connect Trace");
  assert.notEqual(h.document.body.dataset.traceReaderView, "link");
  await pass(h, 10 * 60_000);
  assert.equal(snapshotRequests(h), 4);
});

test("iOS: publishes that bring no account while it says Connecting do not use up the wait", async () => {
  const h = iosLinkedPopupHarness(Array(20).fill(UNREADABLE_REPLY));
  await settle(h);
  await pass(h, 500);
  for (let publish = 1; publish <= 5; publish += 1) {
    h.emitStorageChange({ traceAccountProjectionRevisionV1: { newValue: `r${publish}` } });
    await settle(h);
    assert.equal(snapshotRequests(h), 1 + publish, "each publish is one question");
    assert.equal(earnedHeading(h), CONNECTING, "and none of them is a reason to give up");
  }
  // The wait's own next question comes a second after the last answer, and
  // the ten-second cap still ends it.
  await pass(h, 999);
  assert.equal(snapshotRequests(h), 6);
  await pass(h, 1);
  assert.equal(snapshotRequests(h), 7);
  assert.equal(earnedHeading(h), CONNECTING);
  await pass(h, 8500);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
});

test("iOS: only one question about the account is out at a time", async () => {
  // The second read is slow. Nothing that happens meanwhile sends another.
  const h = iosLinkedPopupHarness([UNREADABLE_REPLY, SLOW_REPLY, CONNECTED_REPLY]);
  await settle(h);
  await pass(h, 1000);
  assert.equal(snapshotRequests(h), 2);
  for (let publish = 1; publish <= 3; publish += 1) {
    h.emitStorageChange({ traceAccountProjectionRevisionV1: { newValue: `r${publish}` } });
    await settle(h);
  }
  await pass(h, 5000);
  assert.equal(snapshotRequests(h), 2, "the read that is out is waited for");
  h.answerSnapshot(CONNECTED_REPLY);
  await settle(h);
  assert.equal(h.document.body.dataset.tracePopupState, "connected");
});

test("iOS: Try again gets a fresh ten seconds, then gives way to buttons again", async () => {
  const h = iosLinkedPopupHarness([...Array(4).fill(UNREADABLE_REPLY), UNREADABLE_REPLY, SLOW_REPLY]);
  await settle(h);
  await pass(h, 7000);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);

  // The second round's follow-up read never comes back.
  h.document.getElementById("popup-earned-secondary").click();
  await settle(h);
  assert.equal(earnedHeading(h), CONNECTING);
  await pass(h, 1000);
  assert.equal(snapshotRequests(h), 6);
  await pass(h, 8999);
  assert.equal(earnedHeading(h), CONNECTING);
  await pass(h, 1);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT, "ten seconds after Try again, not never");
  assert.equal(h.document.getElementById("popup-earned-secondary").textContent, "Try again");
});

test("iOS: Connecting gives way to buttons after ten seconds however slow the reads are", async () => {
  // The first read fails; the second never comes back.
  const h = iosLinkedPopupHarness([UNREADABLE_REPLY, SLOW_REPLY, CONNECTED_REPLY]);
  await settle(h);
  await pass(h, 1000);
  assert.equal(snapshotRequests(h), 2);
  await pass(h, 8999);
  assert.equal(earnedHeading(h), CONNECTING);
  await pass(h, 1);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Open Trace");
  assert.equal(h.document.getElementById("popup-earned-secondary").textContent, "Try again");
  assert.equal(snapshotRequests(h), 2, "it does not ask again on top of a read still out");

  // A late answer is still taken: failure changes nothing, success moves on.
  h.answerSnapshot(UNREADABLE_REPLY);
  await settle(h);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  await pass(h, 60_000);
  assert.equal(snapshotRequests(h), 2);

  const late = iosLinkedPopupHarness([UNREADABLE_REPLY, SLOW_REPLY]);
  await settle(late);
  await pass(late, 10_000);
  assert.equal(earnedHeading(late), COULD_NOT_CONNECT);
  late.answerSnapshot(CONNECTED_REPLY);
  await settle(late);
  assert.equal(late.document.body.dataset.tracePopupState, "connected");
  assert.notEqual(late.document.body.dataset.traceReaderView, "link");
});

function setupPopupOnStory(options = {}) {
  const grantAt = Date.now() - 5_000;
  const popupState = {
    ok: true,
    authState: { state: "signed_out", accountId: null, canExecuteAuthenticated: false, reason: "none" },
    activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    activeWork: null,
    autoTrackEnabled: true,
  };
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: IPHONE_UA,
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: {
      traceEarnedPermissionOnboardingV1: { grantAt, registrationVersion: 3, promptResult: "granted" },
      traceArchiveReadiness: { lastArchiveSeenAt: grantAt - 1_000 },
    },
    popupState,
    tabResponse: namedStory,
    ...options,
  });
  let runs = 0;
  // The page reports in: the background writes this for a page run, and again
  // for a save or a details request that failed.
  const pageRan = () => {
    runs += 1;
    h.emitStorageChange({ traceArchiveReadiness: { newValue: { lastArchiveSeenAt: grantAt + runs * 1_000 } } });
  };
  return { h, popupState, pageRan };
}

/** A setup popup on a story whose page has reported in once. */
async function setupPopupWaitingOnAccount(sessionSnapshotResponses, options = {}) {
  const setup = setupPopupOnStory({ sessionSnapshotResponses, ...options });
  await settle(setup.h);
  assert.equal(earnedHeading(setup.h), "Saving your story…");
  setup.pageRan();
  await settle(setup.h, 12);
  return setup;
}

test("setup: a signed-in reader whose account is still arriving is never told to create one", async () => {
  // The extension does not hold the app's account yet when access is allowed.
  const { h, popupState } = await setupPopupWaitingOnAccount([UNREADABLE_REPLY, CONNECTED_REPLY]);
  assert.equal(earnedHeading(h), CONNECTING);
  assert.doesNotMatch(earnedText(h), /Create an account|Finish setup/);
  assert.equal(snapshotRequests(h), 1, "the popup asks the background to read the app's account");

  // The account arrives and the page saves the story.
  popupState.authState = CONNECTED_AUTH;
  h.emitStorageChange(ACCOUNT_CONNECTED);
  await settle(h, 12);
  assert.equal(snapshotRequests(h), 2);
  assert.equal(earnedHeading(h), "Saving your story…");

  popupState.activeWork = { workKey: "ao3:123", status: "saved", entry: { canonicalReaderStatus: "SAVED" }, syncVersion: "v1" };
  h.emitStorageChange({ traceAccountProjectionRevisionV1: { newValue: "r3" } });
  await settle(h, 12);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P2");
  assert.equal(h.document.getElementById("popup-earned-kicker-text").textContent, "Saved to your Library");
  assert.equal(earnedHeading(h), "The Long Way Round");
});

test("setup: Create an account or sign in appears only when the app has no account", async () => {
  const { h } = await setupPopupWaitingOnAccount([NO_ACCOUNT_REPLY, NO_ACCOUNT_REPLY]);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P6");
  assert.equal(earnedHeading(h), NO_ACCOUNT);
  assert.match(h.document.getElementById("popup-earned-lead").textContent, /Create an account or sign in/);
});

test("setup: no account, then the account appears: the popup carries on with the story", async () => {
  const { h, popupState } = await setupPopupWaitingOnAccount([NO_ACCOUNT_REPLY, CONNECTED_REPLY]);
  assert.equal(earnedHeading(h), NO_ACCOUNT);
  popupState.authState = CONNECTED_AUTH;
  await pass(h, 1200);
  assert.equal(snapshotRequests(h), 2);
  assert.equal(earnedHeading(h), "Saving your story…");

  // The same when it is the background that says so, after the quiet look.
  const later = await setupPopupWaitingOnAccount([NO_ACCOUNT_REPLY, NO_ACCOUNT_REPLY, CONNECTED_REPLY]);
  await pass(later.h, 5000);
  assert.equal(earnedHeading(later.h), NO_ACCOUNT);
  later.popupState.authState = CONNECTED_AUTH;
  later.h.emitStorageChange(ACCOUNT_CONNECTED);
  await settle(later.h, 12);
  assert.equal(earnedHeading(later.h), "Saving your story…");
});

test("setup: an account that never arrives ends in an honest stop with Open Trace", async () => {
  const { h } = await setupPopupWaitingOnAccount(Array(8).fill(UNREADABLE_REPLY));
  await assertBackOff(h);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  assert.match(h.document.getElementById("popup-earned-lead").textContent, /^Your Library is safe\. Open Trace and check you’re signed in, then come back to this story\.$/);
  assert.doesNotMatch(earnedText(h), /Create an account|Finish setup|Still confirming/);
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Open Trace");
  await pass(h, 10 * 60_000);
  assert.equal(snapshotRequests(h), 4);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
});

test("setup: page reports arriving while it says Connecting do not use up the wait", async () => {
  // A story load makes the page report in several times within a second or
  // two. Each one re-enters the setup flow; none may ask again or give up.
  const { h, pageRan } = await setupPopupWaitingOnAccount(Array(8).fill(UNREADABLE_REPLY));
  assert.equal(earnedHeading(h), CONNECTING);
  const stateReads = () => h.messages.filter(({ type }) => type === "TRACE_POPUP_GET_STATE").length;
  const stateReadsBefore = stateReads();
  for (const wait of [200, 300, 400]) {
    await pass(h, wait);
    pageRan();
    await settle(h, 12);
    assert.equal(snapshotRequests(h), 1, "a page report is not a reason to ask again");
    assert.equal(earnedHeading(h), CONNECTING);
  }
  pageRan();
  await settle(h, 12);
  assert.equal(snapshotRequests(h), 1);
  assert.equal(stateReads(), stateReadsBefore, "nor to start watching the story again under the wait");

  // 0.9 s have passed. The 1, 2, 4 s back-off still holds from the start.
  await pass(h, 99);
  assert.equal(snapshotRequests(h), 1);
  await pass(h, 1);
  assert.equal(snapshotRequests(h), 2);
  pageRan();
  await settle(h, 12);
  await pass(h, 1999);
  assert.equal(snapshotRequests(h), 2);
  await pass(h, 1);
  assert.equal(snapshotRequests(h), 3);
  assert.equal(earnedHeading(h), CONNECTING);
  pageRan();
  await settle(h, 12);
  await pass(h, 4000);
  assert.equal(snapshotRequests(h), 4);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  pageRan();
  await settle(h, 12);
  assert.equal(snapshotRequests(h), 4);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT, "and a later report does not restart it");
});

test("setup: anything else that needs the account joins the wait under way", async () => {
  const { h, popupState } = await setupPopupWaitingOnAccount([UNREADABLE_REPLY, UNREADABLE_REPLY, CONNECTED_REPLY]);
  assert.equal(earnedHeading(h), CONNECTING);
  assert.equal(h.evaluate("accountResolutions"), 1);

  // The story asks for its account again, three times, half a second in.
  await pass(h, 500);
  for (let again = 0; again < 3; again += 1) {
    h.evaluate("resolveAccountForStory({ ok: true, kind: 'story', site: 'AO3' }, () => {})");
  }
  // And a reply meant for the general view turns up as well.
  h.evaluate(`waitForAppAccount({ kind: "story" }, { connected() {} }, ${JSON.stringify(UNREADABLE_REPLY)})`);
  await settle(h, 12);
  assert.equal(snapshotRequests(h), 1, "none of them asks");
  assert.equal(h.evaluate("accountResolutions"), 1, "or spends the popup's budget");
  assert.equal(earnedHeading(h), CONNECTING);

  // The one wait keeps its schedule: the next question is still at one second.
  await pass(h, 499);
  assert.equal(snapshotRequests(h), 1);
  await pass(h, 1);
  assert.equal(snapshotRequests(h), 2);
  popupState.authState = CONNECTED_AUTH;
  await pass(h, 2000);
  assert.equal(snapshotRequests(h), 3);
  assert.equal(earnedHeading(h), "Saving your story…", "and it carries on with the story it began for");
});

test("setup: access that lapses during the wait hands the popup to the access prompt, for good", async () => {
  const granted = [...FULL_EARNED_ORIGINS];
  const { h, pageRan } = await setupPopupWaitingOnAccount(
    [UNREADABLE_REPLY, UNREADABLE_REPLY, CONNECTED_REPLY, CONNECTED_REPLY],
    { grantedOrigins: granted },
  );
  assert.equal(earnedHeading(h), CONNECTING);

  // Safari stops allowing the story sites, and the page reports in again.
  granted.splice(0, granted.length);
  pageRan();
  await settle(h, 12);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P3-lapse");
  assert.equal(earnedHeading(h), "Next, tap Always Allow.");

  // The account wait is over: neither its timers nor an account connecting
  // may write over the prompt.
  for (const wait of [1000, 2000, 4000, 10_000]) await pass(h, wait);
  h.emitStorageChange(ACCOUNT_CONNECTED);
  await settle(h, 12);
  assert.equal(snapshotRequests(h), 1);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P3-lapse");
  assert.equal(earnedHeading(h), "Next, tap Always Allow.");
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Allow story sites");
});

test("setup: an account that connects on the first re-ask is not lost to page reports", async () => {
  const { h, popupState, pageRan } = await setupPopupWaitingOnAccount([UNREADABLE_REPLY, CONNECTED_REPLY]);
  for (let report = 0; report < 3; report += 1) {
    pageRan();
    await settle(h, 12);
  }
  assert.equal(earnedHeading(h), CONNECTING);
  popupState.authState = CONNECTED_AUTH;
  await pass(h, 1000);
  assert.equal(snapshotRequests(h), 2);
  assert.equal(earnedHeading(h), "Saving your story…");
});

test("setup: a background that does not answer is not read as having no account", async () => {
  const { h } = await setupPopupWaitingOnAccount([]);
  assert.equal(snapshotRequests(h), 1);
  assert.equal(earnedHeading(h), CONNECTING);
  assert.doesNotMatch(earnedText(h), /Create an account|Finish setup/);
  for (const wait of [1000, 2000, 4000]) await pass(h, wait);
  assert.equal(snapshotRequests(h), 4);
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
});

test("setup: a background still reading the account is asked again, not given up on", async () => {
  const { h, popupState } = await setupPopupWaitingOnAccount([STILL_READING_REPLY, STILL_READING_REPLY, CONNECTED_REPLY]);
  assert.equal(earnedHeading(h), CONNECTING);
  await pass(h, 1000);
  assert.equal(snapshotRequests(h), 2);
  assert.equal(earnedHeading(h), CONNECTING);
  popupState.authState = CONNECTED_AUTH;
  await pass(h, 2000);
  assert.equal(snapshotRequests(h), 3);
  assert.equal(earnedHeading(h), "Saving your story…");
});

test("setup: a story that keeps reporting no account after it connects stops after two rounds", async () => {
  // The snapshot says connected while the story's own state never agrees.
  const { h } = await setupPopupWaitingOnAccount(Array(6).fill(CONNECTED_REPLY));
  await settle(h, 24);
  assert.equal(snapshotRequests(h), 2, "it does not go round for ever");
  assert.equal(earnedHeading(h), COULD_NOT_CONNECT);
  await pass(h, 10 * 60_000);
  assert.equal(snapshotRequests(h), 2);
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
      libraryCount: 50,
      libraryLimit: 50,
      capacity: { blocked: true, prompt: false },
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
    },
  });
  await flush();

  assert.equal(h.document.body.dataset.tracePopupState, "upgrade_required");
  assert.equal(h.document.getElementById("popup-status").textContent, "Your Library is full");
  assert.equal(
    h.document.getElementById("popup-lead").textContent,
    "50 stories on Free. Everything saved stays. See Trace Unlimited, or remove a story to make room.",
  );
  assert.equal(
    h.document.getElementById("popup-import").title,
    "Your Library is full. 50 stories on Free. Everything saved stays. See Trace Unlimited, or remove a story to make room.",
  );
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

const IOS_APP_UNLIMITED_URL = "traceauth://open?destination=unlimited";
const WEB_UPGRADE_URL = "https://tracefiction.com/?upgrade=1&source=extension_cap";

function libraryFullReaderHarness(options = {}, popupState = {}) {
  return createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 } },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    popupState: {
      ok: true,
      authState: { state: "connected" },
      firstSaveSeen: true,
      libraryCount: 100,
      libraryLimit: 100,
      pro: false,
      capacity: { blocked: true, prompt: false },
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      activeWork: null,
      autoTrackEnabled: true,
      ...popupState,
    },
    ...options,
  });
}

test("the full-Library reader view names the account's limit without repeating its heading", async () => {
  const h = libraryFullReaderHarness({}, { libraryCount: 50, libraryLimit: 50 });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.document.body.dataset.tracePopupStateCode, "library-full");
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Your Library is full");
  assert.equal(
    h.document.getElementById("popup-earned-lead").textContent,
    "50 stories on Free. Everything saved stays. See Trace Unlimited, or remove a story to make room. This story wasn’t added.",
  );
});

test("a full Library names no size until the account has reported one", async () => {
  const h = libraryFullReaderHarness({}, { libraryLimit: null });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(
    h.document.getElementById("popup-earned-lead").textContent,
    "Everything saved stays. See Trace Unlimited, or remove a story to make room. This story wasn’t added.",
  );
});

for (const device of [
  { name: "iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" },
  { name: "iPad with a desktop user agent", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", maxTouchPoints: 5 },
  { name: "iPad reported by Safari's platform info", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platformOs: "ios" },
]) {
  test(`See Trace Unlimited opens the Trace app's Unlimited sheet on ${device.name}`, async () => {
    const h = libraryFullReaderHarness(device);
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();
    assert.equal(h.document.body.dataset.tracePopupStateCode, "library-full");
    const primary = h.document.getElementById("popup-earned-primary");
    assert.equal(primary.textContent, "See Trace Unlimited");
    primary.click();
    for (let attempt = 0; attempt < 4; attempt += 1) await flush();
    assert.deepEqual(h.createdTabs, [IOS_APP_UNLIMITED_URL]);
  });
}

test("See Trace Unlimited keeps the web plan page in desktop browsers", async () => {
  const h = libraryFullReaderHarness({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platformOs: "mac" });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  h.document.getElementById("popup-earned-primary").click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.deepEqual(h.createdTabs, [WEB_UPGRADE_URL]);
});

test("the full-Library sheet routes its Unlimited action by platform", async () => {
  for (const [userAgent, expected] of [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)", IOS_APP_UNLIMITED_URL],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0", WEB_UPGRADE_URL],
  ]) {
    const connected = { state: "connected", message: "Connected" };
    const h = createPopupHarness({
      userAgent,
      storageState: { traceAuthState: connected, traceFirstSaveSeen: true, traceLibraryCount: 100 },
      popupState: { pro: false, authState: connected, firstSaveSeen: true, libraryCount: 100, libraryLimit: 100,
        capacity: { blocked: true, prompt: false }, activeTab: { kind: "supported_story", site: "ao3" } },
    });
    await flush();
    assert.equal(h.document.getElementById("popup-cta").textContent, "See Trace Unlimited");
    assert.equal(h.document.getElementById("popup-cta").dataset.externalUrl, expected);
  }
});

function libraryFullSheetHarness(options = {}) {
  const connected = { state: "connected", message: "Connected" };
  return createPopupHarness({
    storageState: { traceAuthState: connected, traceFirstSaveSeen: true, traceLibraryCount: 100 },
    popupState: { pro: false, authState: connected, firstSaveSeen: true, libraryCount: 100, libraryLimit: 100,
      capacity: { blocked: true, prompt: false }, activeTab: { kind: "supported_story", site: "ao3" } },
    ...options,
  });
}

const MAC_WEBKIT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";

for (const [name, options, expected] of [
  ["an iPad known only from Safari's platform info",
    { userAgent: MAC_WEBKIT_USER_AGENT, platformOs: "ios", maxTouchPoints: 0 }, IOS_APP_UNLIMITED_URL],
  ["Safari without a platform report",
    { userAgent: MAC_WEBKIT_USER_AGENT, maxTouchPoints: 0 }, IOS_APP_UNLIMITED_URL],
  ["Safari on a Mac", { userAgent: MAC_WEBKIT_USER_AGENT, platformOs: "mac" }, WEB_UPGRADE_URL],
  ["Chrome without a platform report",
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0" }, WEB_UPGRADE_URL],
]) {
  test(`the full-Library sheet's Unlimited action waits for the platform on ${name}`, async () => {
    const h = libraryFullSheetHarness(options);
    const cta = h.document.getElementById("popup-cta");
    // Click before the platform report has settled.
    cta.click();
    for (let attempt = 0; attempt < 4; attempt += 1) await flush();
    assert.equal(cta.textContent, "See Trace Unlimited");
    assert.deepEqual(h.createdTabs, [expected]);
  });
}

test("Free plan line: the count, a heads-up at 80% for a day, nothing for Unlimited", () => {
  const h = createPopupHarness();
  const raw = (args) => JSON.parse(JSON.stringify(h.evaluate(`freePlanLine(${JSON.stringify(args)})`)));
  const line = (args) => raw({ limit: 100, ...args });
  const now = 1_800_000_000_000;
  // The Library size is the account's; without it nothing is claimed.
  assert.equal(raw({ pro: false, libraryCount: 64, now }), null);
  assert.equal(raw({ pro: false, libraryCount: 64, limit: null, now }), null);
  assert.deepEqual(raw({ pro: false, libraryCount: 40, limit: 50, now }),
    { text: "You’re at 40 of 50 stories. Unlimited keeps every story.", headsUp: true, nearLimit: true });
  assert.deepEqual(raw({ pro: false, libraryCount: 12, limit: 50, now }),
    { text: "12 of 50 stories kept", headsUp: false, nearLimit: false });
  assert.equal(line({ pro: true, libraryCount: 64, now }), null);
  assert.equal(line({ pro: null, libraryCount: 64, now }), null);
  assert.equal(line({ pro: false, libraryCount: null, now }), null);
  assert.deepEqual(line({ pro: false, libraryCount: 64, now }),
    { text: "64 of 100 stories kept", headsUp: false, nearLimit: false });
  assert.deepEqual(line({ pro: false, libraryCount: 80, headsUpShownAt: null, now }),
    { text: "You’re at 80 of 100 stories. Unlimited keeps every story.", headsUp: true, nearLimit: true });
  assert.equal(line({ pro: false, libraryCount: 92, headsUpShownAt: now - 60_000, now }).headsUp, true);
  assert.deepEqual(line({ pro: false, libraryCount: 92, headsUpShownAt: now - 25 * 3_600_000, now }),
    { text: "92 of 100 stories kept", headsUp: false, nearLimit: true });
  assert.deepEqual(line({ pro: false, libraryCount: 100, now }),
    { text: "100 of 100 stories kept", headsUp: false, nearLimit: false });
  assert.equal(line({ pro: false, libraryCount: 79, limit: 100, now }).headsUp, false);
});

function savedStoryReaderHarness({ libraryCount, libraryLimit = 100, pro = false, storageState = {} }) {
  return createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 }, ...storageState },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    popupState: {
      ok: true,
      authState: { state: "connected" },
      firstSaveSeen: true,
      libraryCount,
      libraryLimit,
      pro,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      activeWork: { status: "saved", entry: { status: "READING", canonicalReaderStatus: "READING" } },
      autoTrackEnabled: true,
    },
  });
}

test("the reader view shows the Free count on a saved story, and nothing for Unlimited", async () => {
  const free = savedStoryReaderHarness({ libraryCount: 64 });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(free.document.body.dataset.tracePopupStateCode, "P11");
  const plan = free.document.getElementById("popup-earned-plan");
  assert.equal(plan.hidden, false);
  assert.equal(plan.textContent, "64 of 100 stories kept");
  assert.equal(free.store.traceFreeLimitHeadsUpV1, undefined);

  const smaller = savedStoryReaderHarness({ libraryCount: 12, libraryLimit: 50 });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(smaller.document.getElementById("popup-earned-plan").textContent, "12 of 50 stories kept");

  const unknown = savedStoryReaderHarness({ libraryCount: 64, libraryLimit: null });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(unknown.document.body.dataset.tracePopupStateCode, "P11");
  assert.equal(unknown.document.getElementById("popup-earned-plan").hidden, true);

  const unlimited = savedStoryReaderHarness({ libraryCount: 640, pro: true });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(unlimited.document.body.dataset.tracePopupStateCode, "P11");
  assert.equal(unlimited.document.getElementById("popup-earned-plan").hidden, true);
});

test("the 80% heads-up is recorded once, then gives way to the plain count", async () => {
  const first = savedStoryReaderHarness({ libraryCount: 84 });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  const plan = first.document.getElementById("popup-earned-plan");
  assert.equal(plan.textContent, "You’re at 84 of 100 stories. Unlimited keeps every story.");
  assert.equal(plan.dataset.headsUp, "true");
  const shownAt = first.store.traceFreeLimitHeadsUpV1?.shownAt;
  assert.ok(Number.isSafeInteger(shownAt));

  const sameDay = savedStoryReaderHarness({ libraryCount: 85,
    storageState: { traceFreeLimitHeadsUpV1: { shownAt } } });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(sameDay.document.getElementById("popup-earned-plan").dataset.headsUp, "true");
  assert.equal(sameDay.store.traceFreeLimitHeadsUpV1.shownAt, shownAt);

  const later = savedStoryReaderHarness({ libraryCount: 86,
    storageState: { traceFreeLimitHeadsUpV1: { shownAt: Date.now() - 2 * 86_400_000 } } });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(later.document.getElementById("popup-earned-plan").textContent, "86 of 100 stories kept");

  const madeRoom = savedStoryReaderHarness({ libraryCount: 40,
    storageState: { traceFreeLimitHeadsUpV1: { shownAt: Date.now() - 2 * 86_400_000 } } });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(madeRoom.document.getElementById("popup-earned-plan").textContent, "40 of 100 stories kept");
  assert.equal(madeRoom.store.traceFreeLimitHeadsUpV1, null);
});

test("the Trace is on sheet shows the Free count in desktop browsers", async () => {
  const connected = { state: "connected", message: "Connected" };
  const h = createPopupHarness({
    storageState: { traceAuthState: connected, traceFirstSaveSeen: true, traceLibraryCount: 64 },
    popupState: { pro: false, authState: connected, firstSaveSeen: true, libraryCount: 64, libraryLimit: 100,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true } },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(h.document.body.dataset.tracePopupState, "connected_saved");
  const plan = h.document.getElementById("popup-plan");
  assert.equal(plan.hidden, false);
  assert.equal(plan.textContent, "64 of 100 stories kept");
});

// Import in the iPhone reader view. The ordinary popup's action area is not
// part of that view, so these check what is displayed, not only `hidden`.
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const LISTING = { kind: "supported_archive", site: "ao3", canImport: true };
const STORY = { kind: "supported_story", site: "ao3", canImport: true };
const SAVED_STORY = { status: "saved", entry: { entryId: "00000000-0000-4000-8000-000000000123",
  status: "READING", canonicalReaderStatus: "READING", chapters: { current: 3, total: 3 } } };
const HANDOFF_ID = "00000000-0000-4000-8000-000000000001";

function isDisplayed(h, element) {
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (h.window.getComputedStyle(node).display === "none") return false;
  }
  return Boolean(element && element.isConnected);
}

async function iosReaderImportHarness(popupState = {}, options = {}) {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: IPHONE_USER_AGENT,
    popupUrl: "safari-web-extension://trace/popup.html",
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 5_000 } },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    activeTab: { id: 7, url: "https://archiveofourown.org/users/lanternwright/readings" },
    popupState: {
      ok: true,
      authState: { state: "connected" },
      firstSaveSeen: true,
      libraryCount: 12,
      libraryLimit: 100,
      pro: false,
      capacity: null,
      activeTab: LISTING,
      activeWork: null,
      autoTrackEnabled: true,
      nativeImport: true,
      ...popupState,
    },
    ...options,
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  return h;
}

// The popup's messages belong to its own realm, so compare their shape here.
function importTriggers(h) {
  return h.messages.filter(({ type }) => type === "TRACE_IMPORT_TRIGGER")
    .map((message) => JSON.stringify(message));
}
const ONE_IMPORT = ['{"type":"TRACE_IMPORT_TRIGGER"}'];

test("the iPhone reader view shows Import from this page on a listing and starts the import", async () => {
  const h = await iosReaderImportHarness({}, {
    importResponse: { ok: true, state: "ready_to_open", handoffID: HANDOFF_ID,
      expiresAtMs: Date.now() + 600_000, snapshot: { state: "connected" } },
  });
  assert.equal(h.document.body.dataset.traceReaderView, "true");
  assert.equal(h.document.body.dataset.tracePopupStateCode, "on-list");
  // The ordinary popup's action area stays out of the reader view.
  assert.equal(h.window.getComputedStyle(h.document.querySelector(".popup-actions")).display, "none");

  const button = h.document.getElementById("popup-import");
  assert.equal(button.textContent.trim(), "Import from this page");
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(isDisplayed(h, button), true, "the control is displayed, not only un-hidden");
  const settings = h.document.getElementById("popup-earned-settings-row");
  assert.equal(isDisplayed(h, settings), true);
  assert.ok(button.compareDocumentPosition(settings) & h.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "Import sits above Settings");
  assert.equal(h.document.getElementById("popup-earned-primary").hidden, true, "Import is not made the task");

  assert.deepEqual(importTriggers(h), []);
  button.click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.deepEqual(importTriggers(h), ONE_IMPORT);

  // Trace has the page: one tap opens the Trace app on its Import review.
  const link = h.document.getElementById("popup-import-open-native");
  assert.equal(button.hidden, true);
  assert.equal(link.textContent, "Open in Trace");
  assert.equal(isDisplayed(h, link), true);
  assert.equal(link.getAttribute("href"), `traceauth://open?destination=library-import&handoff=${HANDOFF_ID}`);
  assert.deepEqual(h.createdTabs, [], "nothing opens without the reader's own tap");
  link.click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.deepEqual(h.createdTabs, [`traceauth://open?destination=library-import&handoff=${HANDOFF_ID}`]);
  assert.equal(h.closeCalled, false);
});

for (const page of [
  { name: "a listing, History or Bookmarks page", state: {}, code: "on-list" },
  { name: "a listing before the first story is saved", state: { firstSaveSeen: false, libraryCount: 0 }, code: "P8" },
  { name: "a FanFiction.net listing", state: { activeTab: { kind: "supported_archive", site: "ffn", canImport: true } },
    code: "on-list" },
  { name: "a saved story", state: { activeTab: STORY, activeWork: SAVED_STORY }, code: "P11",
    options: { activeTab: { id: 7, url: "https://archiveofourown.org/works/5550001/chapters/7770003" } } },
]) {
  test(`Import from this page shows in the iPhone reader view on ${page.name}, only with the Trace app's Import`, async () => {
    const on = await iosReaderImportHarness(page.state, page.options);
    assert.equal(on.document.body.dataset.tracePopupStateCode, page.code);
    const button = on.document.getElementById("popup-import");
    assert.equal(button.textContent.trim(), "Import from this page");
    assert.equal(isDisplayed(on, button), true);
    button.click();
    for (let attempt = 0; attempt < 4; attempt += 1) await flush();
    assert.deepEqual(importTriggers(on), ONE_IMPORT);

    for (const nativeImport of [false, undefined]) {
      const off = await iosReaderImportHarness({ ...page.state, nativeImport }, page.options);
      assert.equal(off.document.body.dataset.tracePopupStateCode, page.code);
      const hiddenButton = off.document.getElementById("popup-import");
      assert.equal(isDisplayed(off, hiddenButton), false, "a build without the Trace app's Import shows no control");
      assert.equal(isDisplayed(off, off.document.getElementById("popup-import-open-native")), false);
      hiddenButton.click();
      for (let attempt = 0; attempt < 4; attempt += 1) await flush();
      assert.deepEqual(importTriggers(off), [], "and can start nothing");
    }
  });
}

for (const page of [
  { name: "another website", state: { activeTab: { kind: "unsupported" } }, code: "other-site" },
  { name: "an archive sign-in page", state: { activeTab: { kind: "blocked_archive", site: "ao3", canImport: false } },
    code: "on-list" },
  { name: "a story still being saved", state: { activeTab: STORY }, code: null },
  { name: "a story with automatic saving off", state: { activeTab: STORY, autoTrackEnabled: false }, code: "P10" },
  { name: "a full Library", state: { capacity: { blocked: true, prompt: false }, libraryCount: 100 }, code: "library-full" },
  { name: "a page that lost its connection to Trace", state: {}, code: "P18",
    options: { probeSaveResponse: { ok: false, error: "page_unavailable" } } },
]) {
  test(`Import is not offered in the iPhone reader view on ${page.name}`, async () => {
    const h = await iosReaderImportHarness(page.state, page.options);
    if (page.code) assert.equal(h.document.body.dataset.tracePopupStateCode, page.code);
    const button = h.document.getElementById("popup-import");
    assert.equal(isDisplayed(h, button), false);
    assert.equal(isDisplayed(h, h.document.getElementById("popup-import-open-native")), false);
    button.click();
    for (let attempt = 0; attempt < 4; attempt += 1) await flush();
    assert.deepEqual(importTriggers(h), []);
  });
}

test("Import leaves the iPhone reader view for Settings and for a reader who is not connected", async () => {
  const h = await iosReaderImportHarness();
  const button = h.document.getElementById("popup-import");
  assert.equal(isDisplayed(h, button), true);
  h.document.getElementById("popup-earned-settings-row").click();
  assert.equal(h.document.body.dataset.traceReaderView, "settings");
  assert.equal(isDisplayed(h, button), false);
  h.document.getElementById("popup-earned-settings-back").click();
  assert.equal(isDisplayed(h, button), true);

  const signedOut = await iosReaderImportHarness({}, {
    sessionSnapshot: { state: "signed_out", accountId: null, canExecuteAuthenticated: false, reason: "none" },
  });
  assert.equal(signedOut.document.body.dataset.traceReaderView, "link");
  assert.equal(isDisplayed(signedOut, signedOut.document.getElementById("popup-import")), false);
});

test("a failed import in the iPhone reader view says so, in words for the page, and can be tried again", async () => {
  const response = { ok: false, error: "collect_failed" };
  const h = await iosReaderImportHarness({}, { importResponse: response });
  const button = h.document.getElementById("popup-import");
  const help = h.document.getElementById("popup-import-recovery-help");
  button.click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(button.textContent, "Import failed. Try again.");
  assert.equal(button.disabled, false);
  assert.equal(isDisplayed(h, button), true);
  assert.equal(isDisplayed(h, help), true);
  assert.equal(help.textContent, "Reload this page. If importing still fails, restart Safari and reopen the page.");

  response.error = "native_import_unavailable";
  button.click();
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(button.textContent, "Import unavailable. Try again.");
  assert.equal(help.hidden, true);
  assert.equal(importTriggers(h).length, 2);
});

test("the ordinary popup keeps its Import control and labels", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    sessionSnapshot: { state: "connected", reason: "none", canExecuteAuthenticated: true },
    popupState: { ok: true, authState: { state: "connected" }, firstSaveSeen: true, activeTab: LISTING },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  const button = h.document.getElementById("popup-import");
  assert.equal(h.document.body.dataset.traceReaderView, undefined);
  assert.equal(button.parentElement.className, "popup-actions");
  assert.equal(button.textContent, "Import this page");
  assert.equal(isDisplayed(h, button), true);
  button.click();
  assert.deepEqual(importTriggers(h), ONE_IMPORT);
});

test("the still-waiting state says to keep reading and when to reload, not that there is nothing to redo", async () => {
  const { h, popupState, pageRan } = setupPopupOnStory({ sessionSnapshotResponses: [] });
  popupState.authState = { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" };
  await settle(h);
  pageRan();
  await settle(h, 12);
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Saving your story…");

  // The story is still not confirmed when the popup's patience runs out.
  h.runTimeouts();
  await settle(h, 12);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P5");
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Still confirming your story");
  assert.equal(h.document.getElementById("popup-earned-lead").textContent,
    "Keep reading; it’ll appear in Trace. If it hasn’t after a minute, reload this page.");
  h.runTimeouts();
  await settle(h);
  const announced = h.document.getElementById("popup-earned-result").textContent;
  assert.match(announced, /If it hasn’t after a minute, reload this page\./);
  assert.doesNotMatch(earnedText(h) + announced, /Nothing to redo/);
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Keep reading");
  assert.equal(h.document.getElementById("popup-earned-secondary").textContent, "Check again");
});

for (const page of [
  { name: "FanFiction.net", url: "https://m.fanfiction.net/s/4821/1/The-Long-Way-Round", site: "ffn", byline: "quillfeather · FanFiction.net" },
  { name: "AO3", url: "https://archiveofourown.org/works/123", site: "ao3", byline: "quillfeather · AO3" },
]) {
  test(`the popup that finishes setup confirms a first save that already landed on ${page.name}`, async () => {
    // Safari put Trace on the open story when access was allowed, and the page
    // saved it before the popup first looked.
    const h = createPopupHarness({
      sessionMode: "kernel",
      promiseRuntime: true,
      earnedPermissionOnboarding: true,
      userAgent: IPHONE_UA,
      activeTab: { id: 7, url: page.url },
      grantedOrigins: [...FULL_EARNED_ORIGINS],
      storageState: { traceArchiveReadiness: { lastArchiveSeenAt: Date.now() - 500 } },
      sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
      popupState: {
        ok: true,
        authState: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
        firstSaveSeen: true,
        libraryCount: 1,
        libraryLimit: 100,
        activeTab: { kind: "supported_story", site: page.site, canImport: true },
        activeWork: { workKey: "story", status: "saved", entry: { canonicalReaderStatus: "SAVED" }, syncVersion: "v1" },
        autoTrackEnabled: true,
        nativeImport: true,
      },
      tabResponse: (message) => message.type === "TRACE_STORY_IDENTITY_GET"
        ? { ok: true, title: "The Long Way Round", author: "quillfeather", site: page.site }
        : undefined,
    });
    await settle(h, 16);

    assert.ok(h.store.traceEarnedPermissionOnboardingV1.completedAt > 0, "setup finished in this popup");
    assert.equal(h.document.body.dataset.tracePopupStateCode, "P2");
    assert.equal(h.document.getElementById("popup-earned-kicker-text").textContent, "Saved to your Library");
    assert.equal(h.document.getElementById("popup-earned-heading").textContent, "The Long Way Round");
    assert.equal(h.document.getElementById("popup-earned-record-byline").textContent, page.byline);
    assert.match(h.document.getElementById("popup-earned-lead").textContent, /Your chapter fills in as you read\./);
    assert.equal(h.document.getElementById("popup-earned-primary").textContent, "Keep reading");
    assert.equal(isDisplayed(h, h.document.getElementById("popup-import")), false, "the confirmation is one thing");
    assert.equal(h.store.traceSavedNoteFirstStoryShownV1, true, "the page note need not repeat it");
    assert.ok(h.tabMessages.some(({ message }) => message.type === "TRACE_SAVED_NOTE_DISMISS"));
  });
}

test("a later popup on a saved story still opens on the everyday view", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: IPHONE_UA,
    activeTab: { id: 7, url: "https://m.fanfiction.net/s/4821/1/The-Long-Way-Round" },
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: {
      traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 60_000 },
      traceArchiveReadiness: { lastArchiveSeenAt: Date.now() - 500 },
    },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    popupState: {
      ok: true,
      authState: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
      firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ffn", canImport: true },
      activeWork: { workKey: "ffn:4821", status: "saved", entry: { canonicalReaderStatus: "SAVED" }, syncVersion: "v1" },
      autoTrackEnabled: true,
    },
    tabResponse: namedStory,
  });
  await settle(h, 16);
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P11");
  assert.equal(h.document.getElementById("popup-earned-status-control").hidden, false);
});

test("a saved story the page has not named yet is confirmed without a made-up title", async () => {
  // After the reload that follows "Allow", the page can save the story before
  // it can answer with its title.
  let named = false;
  const { h, popupState, pageRan } = setupPopupOnStory({
    sessionSnapshotResponses: [],
    tabResponse: (message) => {
      if (message.type !== "TRACE_STORY_IDENTITY_GET") return undefined;
      return named ? { ok: true, title: "The Long Way Round", author: "quillfeather", site: "ao3" } : { ok: false };
    },
  });
  popupState.authState = { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" };
  await settle(h);
  pageRan();
  await settle(h, 12);
  popupState.activeWork = { workKey: "ao3:123", status: "saved", entry: { canonicalReaderStatus: "SAVED" }, syncVersion: "v1" };
  h.emitStorageChange({ traceAccountProjectionRevisionV1: { newValue: "r2" } });
  await settle(h, 12);

  const heading = h.document.getElementById("popup-earned-heading");
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P2");
  assert.equal(heading.textContent, "Saved to your Library");
  assert.equal(h.document.getElementById("popup-earned-kicker").hidden, true, "the confirmation is not said twice");
  assert.equal(h.document.getElementById("popup-earned-record-byline").textContent, "AO3");
  assert.equal(h.document.getElementById("popup-earned-record-label").textContent, "Saved");
  h.runTimeouts();
  await settle(h, 12);
  const announced = h.document.getElementById("popup-earned-result").textContent;
  assert.equal(announced, "Saved to your Library. Your chapter fills in as you read.");
  assert.doesNotMatch(earnedText(h) + announced, /Your story by|the author/);
  assert.notEqual(heading.textContent, "Your story");

  // The page can name the story now; the popup fills it in.
  named = true;
  h.runTimeouts();
  await settle(h, 12);
  assert.equal(heading.textContent, "The Long Way Round");
  assert.equal(h.document.getElementById("popup-earned-kicker-text").textContent, "Saved to your Library");
  assert.equal(h.document.getElementById("popup-earned-record-byline").textContent, "quillfeather · AO3");
  h.runTimeouts();
  await settle(h);
  assert.equal(h.document.getElementById("popup-earned-result").textContent,
    "Saved to your Library: The Long Way Round by quillfeather. Your chapter fills in as you read.");
});

test("a title that never arrives leaves the confirmation as it is and stops asking", async () => {
  const { h, popupState, pageRan } = setupPopupOnStory({
    sessionSnapshotResponses: [],
    tabResponse: (message) => (message.type === "TRACE_STORY_IDENTITY_GET" ? { ok: false } : undefined),
  });
  popupState.authState = { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" };
  popupState.activeWork = { workKey: "ao3:123", status: "saved", entry: { canonicalReaderStatus: "SAVED" }, syncVersion: "v1" };
  await settle(h);
  pageRan();
  await settle(h, 12);
  const identityAsks = () => h.tabMessages.filter(({ message }) => message.type === "TRACE_STORY_IDENTITY_GET").length;
  for (let round = 0; round < 6; round += 1) {
    h.runTimeouts();
    await settle(h, 12);
  }
  const asked = identityAsks();
  h.runTimeouts();
  await settle(h, 12);
  assert.equal(identityAsks(), asked, "the lookup is bounded");
  assert.match(h.document.getElementById("popup-earned-heading").textContent, /in your Library$/);
  assert.doesNotMatch(earnedText(h), /Your story by|the author/);
});

test("the iPhone popup reports story-site access once each time it opens", async () => {
  const h = iosLinkedPopupHarness([CONNECTED_REPLY]);
  await settle(h);
  assert.equal(
    JSON.stringify(h.messages.filter(({ type }) => type === "TRACE_ARCHIVE_ACCESS_REPORT")),
    JSON.stringify([{ type: "TRACE_ARCHIVE_ACCESS_REPORT" }]),
  );
  h.emitStorageChange({ traceArchiveReadiness: { newValue: { lastArchiveSeenAt: Date.now() } } });
  await settle(h);
  assert.equal(h.messages.filter(({ type }) => type === "TRACE_ARCHIVE_ACCESS_REPORT").length, 1);

  // Also when access has ended, which is when the reading matters most.
  const lapsed = iosLinkedPopupHarness([CONNECTED_REPLY], { permissionContainsResult: false });
  await settle(lapsed);
  assert.equal(lapsed.document.body.dataset.tracePopupStateCode, "P3-lapse");
  assert.equal(lapsed.messages.filter(({ type }) => type === "TRACE_ARCHIVE_ACCESS_REPORT").length, 1);

  const desktop = createPopupHarness({ sessionMode: "kernel" });
  await settle(desktop);
  assert.equal(desktop.messages.some(({ type }) => type === "TRACE_ARCHIVE_ACCESS_REPORT"), false);
});

test("a site's home page keeps the open-any-story prompt after access is allowed there", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: IPHONE_UA,
    activeTab: { id: 7, url: "https://archiveofourown.org/" },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    popupState: {
      ok: true,
      authState: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
      firstSaveSeen: false,
      activeTab: { kind: "supported_archive", site: "ao3", canImport: true },
      activeWork: null,
      autoTrackEnabled: true,
    },
  });
  await settle(h);
  h.document.getElementById("popup-earned-primary").click();
  await settle(h, 12);
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Open any story");

  // Safari puts Trace on the open page, which reports in. There is no story
  // here to wait for, however long the popup stays open.
  h.emitStorageChange({ traceArchiveReadiness: { newValue: { lastArchiveSeenAt: Date.now() + 1_000 } } });
  await settle(h, 12);
  for (let round = 0; round < 3; round += 1) {
    h.runTimeouts();
    await settle(h, 12);
  }
  assert.equal(h.document.getElementById("popup-earned-heading").textContent, "Open any story");
  assert.equal(h.document.getElementById("popup-earned-lead").textContent, "Trace saves it when it opens.");
  assert.doesNotMatch(earnedText(h), /Still confirming your story|Saving your story/);
});

test("the popup that finishes setup on a story that is not saved yet says Saving, not Saved", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: IPHONE_UA,
    activeTab: { id: 7, url: "https://archiveofourown.org/works/123" },
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceArchiveReadiness: { lastArchiveSeenAt: Date.now() - 500 } },
    sessionSnapshot: CONNECTED_AUTH,
    popupState: {
      ok: true,
      authState: CONNECTED_AUTH,
      firstSaveSeen: false,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      activeWork: null,
      autoTrackEnabled: true,
    },
    tabResponse: namedStory,
  });
  await settle(h, 16);
  assert.ok(h.store.traceEarnedPermissionOnboardingV1.completedAt > 0, "setup finished in this popup");
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P1");
  assert.equal(earnedHeading(h), "Saving your story…");
  assert.doesNotMatch(earnedText(h), /Saved to your Library/);
  assert.equal(h.store.traceSavedNoteFirstStoryShownV1, undefined, "nothing was confirmed");
});

test("a popup that finishes setup on a list page does not confirm a save", async () => {
  // Setup completes on a list. Only a popup that finished it on a story may
  // open on that story's confirmation.
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: true,
    userAgent: IPHONE_UA,
    activeTab: { id: 7, url: "https://archiveofourown.org/works" },
    grantedOrigins: [...FULL_EARNED_ORIGINS],
    storageState: { traceArchiveReadiness: { lastArchiveSeenAt: Date.now() - 500 } },
    sessionSnapshot: CONNECTED_AUTH,
    popupState: {
      ok: true,
      authState: CONNECTED_AUTH,
      firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      activeWork: { workKey: "ao3:123", status: "saved", entry: { canonicalReaderStatus: "SAVED" }, syncVersion: "v1" },
      autoTrackEnabled: true,
    },
    tabResponse: namedStory,
  });
  await settle(h, 16);
  assert.ok(h.store.traceEarnedPermissionOnboardingV1.completedAt > 0, "setup finished in this popup");
  assert.equal(h.document.body.dataset.tracePopupStateCode, "P11");
  assert.equal(h.document.getElementById("popup-earned-kicker").hidden, true);
});

test("a page that answers with a blank title is asked a few more times, not for ever", async () => {
  const { h, popupState, pageRan } = setupPopupOnStory({
    sessionSnapshotResponses: [],
    tabResponse: (message) => (message.type === "TRACE_STORY_IDENTITY_GET"
      ? { ok: true, title: "   ", author: null, site: "ao3" } : undefined),
  });
  popupState.authState = CONNECTED_AUTH;
  popupState.activeWork = { workKey: "ao3:123", status: "saved", entry: { canonicalReaderStatus: "SAVED" }, syncVersion: "v1" };
  await settle(h);
  pageRan();
  await settle(h, 12);
  const asks = () => h.tabMessages.filter(({ message }) => message.type === "TRACE_STORY_IDENTITY_GET").length;
  const before = asks();
  for (const wait of [400, 1200, 2500]) await pass(h, wait);
  assert.equal(asks(), before + 3, "three more tries");
  await pass(h, 10 * 60_000);
  assert.equal(asks(), before + 3, "and then it stops");
  assert.match(earnedHeading(h), /in your Library$/);
  assert.notEqual(earnedHeading(h).trim(), "");
});

// --- First-tap save: the popup draws what the background sends ----------------

const FIRST_TAP_STORY = { title: "The Long Way", author: "someone", site: "AO3" };
const FIRST_TAP_ENTRY = { status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", chapters: { current: 3, total: 40 } };
const ALLOW_BUTTON = "Allow AO3 and FanFiction.net";
const RULE_LINE = "Tap Always Allow, not the blue Allow for One Day.";

/** What a sighted reader sees of an element: text kept for reading aloud is left out. */
function shownText(element) {
  if (!element || element.hidden || element.closest("[hidden]")) return null;
  const copy = element.cloneNode(true);
  for (const spoken of copy.querySelectorAll(".popup-earned-internal")) spoken.remove();
  // Line breaks in the markup between one part and the next are not text.
  return copy.textContent.trim().replace(/\s*\n\s*/g, "");
}

/** What is read aloud in place of an element's shown text, if anything is. */
function spokenText(element) {
  return element?.querySelector(".popup-earned-internal")?.textContent ?? null;
}

async function openFirstTapPopup(options = {}) {
  const h = createPopupHarness({
    sessionMode: "kernel",
    promiseRuntime: true,
    earnedPermissionOnboarding: { firstTapSave: true },
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
    ...options,
  });
  for (let attempt = 0; attempt < 10; attempt += 1) await flush();
  const element = (id) => h.document.getElementById(id);
  /** The text on show in an element, or null when the element is not shown. */
  const text = (id) => shownText(element(id));
  const shown = () => h.document.body.dataset.traceFirstTapState;
  const click = async (id) => {
    element(id).dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  };
  /** What the live region says, once it has been given its words. */
  const announced = async () => {
    h.advance(0);
    await flush();
    return element("popup-earned-result").textContent;
  };
  /** Everything the sheet shows, in the order it is laid out. */
  const sheet = () => ({
    state: shown(),
    kicker: text("popup-earned-kicker"),
    heading: text("popup-earned-heading"),
    body: text("popup-earned-lead"),
    record: text("popup-earned-record"),
    second: text("popup-earned-ask"),
    rule: text("popup-earned-rule"),
    primary: text("popup-earned-primary"),
    secondary: text("popup-earned-secondary"),
  });
  return { h, element, text, shown, click, announced, sheet };
}

test("first tap: opening Trace on a story asks the background to save it, and asks Safari for nothing", async () => {
  const { h, element, text, shown, announced, sheet } = await openFirstTapPopup();
  assert.deepEqual(h.firstTap.commands, ["open"]);
  assert.deepEqual(h.firstTap.tabIds, [7], "it names the tab it was opened on");
  assert.deepEqual(sheet(), {
    state: "connecting", kicker: null, heading: "Connecting to your account…", body: null, record: null,
    second: null, rule: null, primary: null, secondary: null,
  });
  assert.equal(await announced(), "Connecting to your account.");
  assert.equal(element("popup-earned-heading-glyph").getAttribute("aria-hidden"), "true", "the progress mark is not read out");
  assert.deepEqual(h.permissionRequests, [], "no website question is raised by opening Trace");
  assert.deepEqual(h.injections, [], "the popup injects nothing itself");
  assert.deepEqual(h.reloads, []);

  h.firstTap.show({ state: "saving", workKey: "ao3:123", startedAt: 0 });
  assert.deepEqual(sheet(), {
    state: "saving", kicker: null, heading: "This story", body: null, record: "AO3Saving to your Library…",
    second: null, rule: null, primary: null, secondary: null,
  });
  assert.equal(await announced(), "Saving to your Library.");
  assert.equal(text("popup-earned-record-byline"), "AO3");
  assert.equal(spokenText(element("popup-earned-record-byline")), "on AO3.");
});

test("first tap: saved, already there and found are drawn from the background's word alone", async () => {
  for (const [provenance, state, words, glyph] of [
    ["saved_now", "saved", "Saved to your Library", true],
    ["already", "already-in-library", "Already in your Library", false],
    ["found", "in-library", "In your Library", true],
  ]) {
    const { h, element, shown, announced, sheet } = await openFirstTapPopup({
      // A page cache that says otherwise is not consulted.
      storageState: { libraryOverlayCache: { entries: provenance === "saved_now" ? { "ao3:123": { entryId: "e" } } : {} } },
    });
    h.firstTap.show({ state: "confirmed", workKey: "ao3:123", provenance, mode: "bounded_manual", story: FIRST_TAP_STORY, entry: FIRST_TAP_ENTRY });
    assert.deepEqual(sheet(), {
      state, kicker: words, heading: "The Long Way", body: null, record: "someone · AO3Reading · Chapter 3 of 40",
      second: null, rule: null, primary: null, secondary: null,
    }, "the save is on show by itself first");
    assert.equal(element("popup-earned-kicker-icon").childElementCount, glyph ? 1 : 0);
    assert.equal(await announced(), `${words}. The Long Way, by someone, on AO3. Reading. Chapter 3 of 40.`);
    assert.equal(spokenText(element("popup-earned-record-byline")), "by someone, on AO3.");
    assert.equal(spokenText(element("popup-earned-record-label")), "Reading. Chapter 3 of 40.");
    assert.equal(element("popup-earned-record-dot").dataset.status, "READING", "the entry's real status");

    // The ask arrives a moment later, under the save, and asks Safari nothing by itself.
    h.advance(1_099);
    assert.equal(sheet().second, null);
    h.advance(1);
    assert.deepEqual(sheet(), {
      state: shown(), kicker: words, heading: "The Long Way", body: null, record: "someone · AO3Reading · Chapter 3 of 40",
      second: "Let Trace save the next one by itselfSafari asks first. It lists AO3 and FanFiction.net’s 5 addresses.",
      rule: RULE_LINE, primary: ALLOW_BUTTON, secondary: "Not now",
    });
    assert.equal(shown(), state);
    assert.equal(element("popup-earned-primary").dataset.emphasis, "primary");
    assert.equal(await announced(), "Let Trace save the next one by itself. Safari asks first. It lists AO3 and FanFiction.net’s 5 addresses.");
    assert.deepEqual(h.permissionRequests, []);
  }
});

test("first tap: a saved story the page did not name is shown without a made-up title, and FanFiction.net reads the same", async () => {
  const unnamed = await openFirstTapPopup();
  unnamed.h.firstTap.show({ state: "confirmed", workKey: "ao3:123", provenance: "saved_now", mode: "bounded_manual", story: null, entry: { ...FIRST_TAP_ENTRY, chapters: null } });
  assert.equal(unnamed.sheet().heading, "This story");
  assert.equal(unnamed.sheet().record, "AO3Reading");
  assert.equal(await unnamed.announced(), "Saved to your Library. This story, on AO3. Reading.");

  const ffn = await openFirstTapPopup({ activeTab: { id: 7, url: "https://www.fanfiction.net/s/123/2/" } });
  ffn.h.firstTap.show({
    state: "confirmed", workKey: "ffn:123", provenance: "saved_now", mode: "bounded_manual",
    story: { title: "A Quiet Harbour", author: "tidewatcher", site: "FanFiction.net" },
    entry: { ...FIRST_TAP_ENTRY, chapters: { current: 2, total: null } },
  });
  ffn.h.advance(1_100);
  assert.deepEqual(ffn.sheet(), {
    state: "saved", kicker: "Saved to your Library", heading: "A Quiet Harbour", body: null,
    record: "tidewatcher · FanFiction.netReading · Chapter 2",
    second: "Let Trace save the next one by itselfSafari asks first. It lists AO3 and FanFiction.net’s 5 addresses.",
    rule: RULE_LINE, primary: ALLOW_BUTTON, secondary: "Not now",
  });
});

test("first tap: no account, an unread account and a refused account each say only what is known, and the popup asks again by itself", async () => {
  const { h, shown, click, sheet } = await openFirstTapPopup();
  const words = () => `${sheet().heading} ${sheet().body}`;
  h.firstTap.show({ state: "account_unknown", workKey: "ao3:123" });
  assert.deepEqual(sheet(), {
    state: "account-unreachable", kicker: null, heading: "Trace can’t reach your account right now",
    body: "Check your connection, then try again.", record: null, second: null, rule: null,
    primary: "Try again", secondary: null,
  });
  assert.doesNotMatch(words(), /sign in|Create an account|nothing was saved/i, "not known is never drawn as signed out");

  await click("popup-earned-primary");
  assert.deepEqual(h.firstTap.commands, ["open", "open"]);

  h.firstTap.show({ state: "account_missing", workKey: "ao3:123" });
  assert.deepEqual(sheet(), {
    state: "account-missing", kicker: null, heading: "Trace couldn’t connect to your account",
    body: "Trace in Safari doesn’t have your account yet. Open the Trace app, then come back and tap Trace again.",
    record: null, second: null, rule: null, primary: "Try again", secondary: null,
  });
  h.emitStorageChange({ traceAccountProjectionRevisionV1: { newValue: "r2" } });
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(h.firstTap.commands.at(-1), "open", "an account that connects is asked about without a tap");
  assert.equal(h.firstTap.commands.length, 3);

  h.firstTap.show({ state: "account_reconnect_required", workKey: "ao3:123" });
  assert.deepEqual(sheet(), {
    state: "account-reconnect", kicker: null, heading: "Open the Trace app to reconnect",
    body: "Trace in Safari needs your account again. Open the Trace app, then come back and tap Trace again.",
    record: null, second: null, rule: null, primary: "Try again", secondary: null,
  });
  await click("popup-earned-primary");
  assert.equal(h.firstTap.commands.at(-1), "open", "Try again reads the account again");
  h.emitStorageChange({ traceAccountProjectionRevisionV1: { newValue: "r3" } });
  for (let attempt = 0; attempt < 4; attempt += 1) await flush();
  assert.equal(h.firstTap.commands.length, 5, "and so does an account that connects");
  assert.equal(shown(), "account-reconnect");
  assert.doesNotMatch(words(), /sign in/i, "the app may be signed in already, so signing in is not what is asked");
});

test("first tap: only a save that was never sent may be drawn as unsent; an unconfirmed one offers a look, not another save", async () => {
  const { h, shown, click, sheet } = await openFirstTapPopup();
  const failed = (reason, dispatch) => ({ state: "failed", workKey: "ao3:123", reason, dispatch, story: FIRST_TAP_STORY });
  const words = () => `${sheet().heading} ${sheet().body}`;

  h.firstTap.show(failed("unavailable", "sent_unconfirmed"));
  assert.deepEqual(sheet(), {
    state: "save-unconfirmed", kicker: null, heading: "Trace couldn’t confirm this save",
    body: "It may have saved anyway. Check again to find out.", record: null, second: null, rule: null,
    primary: "Check again", secondary: null,
  });
  assert.doesNotMatch(words(), /Nothing was saved|wasn.t added|not saved|added nothing|wasn.t sent/i);
  await click("popup-earned-primary");
  assert.equal(h.firstTap.commands.at(-1), "check", "Check again looks; it cannot ask for a save");

  h.firstTap.show({ state: "presence_unknown", workKey: "ao3:123" });
  assert.deepEqual(sheet(), {
    state: "still-unknown", kicker: null, heading: "Trace still couldn’t check",
    body: "Look for it in your Library in the Trace app, or check again later.", record: null, second: null,
    rule: null, primary: "Check again", secondary: "Try again",
  });
  assert.doesNotMatch(words(), /Nothing was saved|wasn.t added|not saved|added nothing|wasn.t sent/i);
  await click("popup-earned-primary");
  assert.equal(h.firstTap.commands.at(-1), "check");
  assert.equal(h.firstTap.commands.includes("save"), false);

  h.firstTap.show(failed("unavailable", "never_sent"));
  assert.deepEqual(sheet(), {
    state: "save-not-sent", kicker: null, heading: "The save wasn’t sent",
    body: "This tap added nothing to your Library.", record: null, second: null, rule: null,
    primary: "Try again", secondary: "Not now",
  });
  await click("popup-earned-primary");
  assert.equal(h.firstTap.commands.at(-1), "save", "Try again is a new save the reader chose");

  h.firstTap.show(failed("rate_limited", "refused"));
  assert.deepEqual(sheet(), {
    state: "save-refused", kicker: null, heading: "Trace couldn’t save this story",
    body: "It wasn’t added to your Library. Try again in a moment.", record: null, second: null, rule: null,
    primary: "Try again", secondary: "Not now",
  });

  // Trace's own word, asked for by the reader, that the story is not in the
  // Library: the same screen, with the same way to save.
  h.firstTap.show(failed("unavailable", "not_in_library"));
  assert.deepEqual(sheet(), {
    state: "save-not-sent", kicker: null, heading: "The save wasn’t sent",
    body: "This tap added nothing to your Library.", record: null, second: null, rule: null,
    primary: "Try again", secondary: "Not now",
  });
  await click("popup-earned-primary");
  assert.equal(h.firstTap.commands.at(-1), "save");

  // Trace turned the account down: the reader reconnects, then saves.
  for (const dispatch of ["refused", "never_sent"]) {
    h.firstTap.show(failed("not_authenticated", dispatch));
    assert.deepEqual(sheet(), {
      state: "save-reconnect", kicker: null, heading: "Open the Trace app to reconnect",
      body: "Trace in Safari needs your account again. Open the Trace app, then come back and tap Trace again.",
      record: null, second: null, rule: null, primary: "Try again", secondary: null,
    });
    await click("popup-earned-primary");
    assert.equal(h.firstTap.commands.at(-1), "save");
  }
  // A save that went out with that answer still unread is not called unsent.
  h.firstTap.show(failed("not_authenticated", "sent_unconfirmed"));
  assert.equal(shown(), "save-unconfirmed");

  h.firstTap.show({ state: "failed", workKey: "ao3:123", reason: "story_unavailable", dispatch: "never_sent", story: null });
  assert.deepEqual(sheet(), {
    state: "story-unavailable", kicker: null, heading: "This story isn’t available",
    body: "It may be deleted or locked, so Trace can’t read it.", record: null, second: null, rule: null,
    primary: "Close", secondary: null,
  });

  // A full Library keeps the words the rest of the popup uses for it.
  h.firstTap.show(failed("free_limit_reached", "refused"));
  assert.equal(shown(), "library-full");
  assert.equal(sheet().heading, "Your Library is full");
  assert.equal(sheet().primary, "See Trace Unlimited");
});

test("first tap: a save still out after the popup's patience says so, offers a look, and asks for lasting access under it", async () => {
  const { h, element, text, shown, click, announced, sheet } = await openFirstTapPopup({ deferredHostRequest: true });
  h.firstTap.show({ state: "saving", workKey: "ao3:123", startedAt: 0 });
  h.advance(19_999);
  assert.equal(shown(), "saving");
  h.advance(1);
  // The story, the news of the save with a look to ask for, and under it the
  // ask for lasting access with its rule line and button.
  assert.deepEqual(sheet(), {
    state: "still-confirming", kicker: null, heading: "This story", body: null, record: "AO3",
    second: ASK_UNDER_THE_SAVE, rule: RULE_LINE, primary: ALLOW_BUTTON, secondary: "Keep reading",
  });
  assert.equal(text("popup-earned-note"), "Still confirming your storyTrace hasn’t heard back yet. It may already be saved.Check again");
  assert.equal(element("popup-earned-note-heading").tagName, "H2");
  assert.equal(await announced(), "Still confirming your story. Trace hasn’t heard back yet. It may already be saved.");
  const order = ["popup-earned-heading", "popup-earned-record", "popup-earned-note", "popup-earned-ask", "popup-earned-rule", "popup-earned-primary", "popup-earned-secondary"]
    .map((id) => element(id));
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index - 1].compareDocumentPosition(order[index]) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, order[index].id);
  }
  const look = element("popup-earned-note-action");
  assert.equal(look.tagName, "BUTTON");
  assert.equal(look.dataset.emphasis, "tertiary", "looking again is offered quietly");
  assert.equal(element("popup-earned-primary").dataset.emphasis, "primary");
  assert.equal(element("popup-earned-secondary").dataset.emphasis, "secondary", "Keep reading is raised");
  assert.equal(element("popup-earned-secondary").dataset.earnedAction, "close");
  await click("popup-earned-note-action");
  assert.equal(h.firstTap.commands.at(-1), "check");

  // The same save's state arriving again does not start the wait over, and
  // brings the story's title once the page has named it.
  h.firstTap.show({ state: "saving", workKey: "ao3:123", startedAt: 0, story: FIRST_TAP_STORY });
  assert.equal(shown(), "still-confirming");
  assert.equal(sheet().heading, "The Long Way");
  assert.equal(sheet().record, "someone · AO3");

  // The ask can be made without waiting on the save; Safari's question leaves the rest as it was.
  await click("popup-earned-primary");
  assert.equal(h.permissionRequests.length, 1);
  h.firstTap.showAccess({ state: "waiting" });
  assert.deepEqual(sheet(), {
    state: "access-waiting", kicker: null, heading: "The Long Way", body: null, record: "someone · AO3",
    second: ASK_UNDER_THE_SAVE, rule: RULE_LINE, primary: "Waiting for Safari…", secondary: "Keep reading",
  });
  assert.equal(text("popup-earned-note-heading"), "Still confirming your story");
  assert.equal(element("popup-earned-primary").disabled, true);

  h.firstTap.showAccess({ state: "not_asked" });
  h.firstTap.show({ state: "confirmed", workKey: "ao3:123", provenance: "saved_now", mode: "bounded_manual", story: FIRST_TAP_STORY, entry: FIRST_TAP_ENTRY });
  h.advance(60_000);
  assert.equal(shown(), "saved", "a result that arrives ends the wait");
  assert.equal(text("popup-earned-note"), null, "and nothing of the wait is left on show");

  // A new save has a wait of its own.
  h.firstTap.show({ state: "saving", workKey: "ao3:123", startedAt: 90_000, story: FIRST_TAP_STORY });
  assert.equal(shown(), "saving");
  assert.equal(sheet().heading, "The Long Way", "named from the start when the background knows the story");
  h.advance(20_000);
  assert.equal(shown(), "still-confirming");
});

test("first tap: with automatic saving off the popup saves only when asked", async () => {
  const off = await openFirstTapPopup();
  off.h.firstTap.show({ state: "awaiting_request", workKey: "ao3:123", preference: "off" });
  assert.deepEqual(off.sheet(), {
    state: "automatic-saving-off", kicker: null, heading: "Automatic saving is off", body: null,
    record: "This storyAO3", second: null, rule: null,
    primary: "Save this story", secondary: "Turn automatic saving on",
  });
  assert.deepEqual(off.h.firstTap.commands, ["open"]);
  await off.click("popup-earned-primary");
  assert.deepEqual(off.h.firstTap.commands, ["open", "save"]);

  // Turning it on is the reader's choice; the background then reads it for itself.
  await off.click("popup-earned-secondary");
  assert.equal(off.h.store.prefAutoTrackEnabled, true);
  assert.equal(typeof off.h.store.prefAutoTrackSetAt, "number");
  assert.deepEqual(off.h.firstTap.commands, ["open", "save", "open"]);

  // A preference that could not be read saves nothing unasked either.
  const unread = await openFirstTapPopup();
  unread.h.firstTap.show({ state: "awaiting_request", workKey: "ao3:123", preference: "unknown" });
  assert.deepEqual(unread.sheet(), {
    state: "save-on-request", kicker: null, heading: "This story", body: null, record: "AO3", second: null,
    rule: null, primary: "Save this story", secondary: null,
  });
  assert.deepEqual(unread.h.firstTap.commands, ["open"]);
});

test("first tap: once the story sites are allowed, or on a build without it, the popup's usual flow is unchanged", async () => {
  const allowed = await openFirstTapPopup();
  allowed.h.firstTap.show({ state: "confirmed", workKey: "ao3:123", provenance: "saved_now", mode: "bounded_manual", story: FIRST_TAP_STORY, entry: FIRST_TAP_ENTRY });
  allowed.h.advance(1_100);
  assert.equal(allowed.element("popup-earned-primary").getAttribute("aria-describedby"), "popup-earned-rule");
  allowed.h.firstTap.show({ state: "automatic" });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(allowed.shown(), undefined);
  assert.equal(allowed.text("popup-earned-primary"), "Continue", "the existing ask is shown");
  assert.deepEqual(allowed.h.firstTap.commands, ["open"], "and the first-tap save is not asked for again");
  // Nothing of the first-tap sheet is left on the popup that took over.
  assert.equal(allowed.text("popup-earned-ask"), null);
  assert.equal(allowed.element("popup-earned-primary").hasAttribute("aria-describedby"), false);
  assert.equal(allowed.h.document.querySelector(".popup-first-tap-fade, .popup-first-tap-rise"), null);
  assert.equal(allowed.element("popup-earned-heading-row").nextElementSibling, allowed.element("popup-earned-record"));
  allowed.h.advance(120_000);
  assert.equal(allowed.shown(), undefined, "and no timer of it draws again");

  const without = createPopupHarness({
    sessionMode: "kernel", promiseRuntime: true, earnedPermissionOnboarding: true,
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
  });
  for (let attempt = 0; attempt < 10; attempt += 1) await flush();
  assert.deepEqual(without.firstTap.commands, []);
  assert.equal(without.hostLifecycle.includes("trace-first-tap-popup-v1"), false);
  assert.equal(without.document.body.dataset.traceFirstTapState, undefined);
  assert.equal(without.document.getElementById("popup-earned-primary").textContent, "Continue");
  assert.equal(without.document.getElementById("popup-earned-heading").textContent, "Let Trace work on AO3 and FanFiction.net");
  assert.equal(without.document.getElementById("popup-earned-lead").textContent, "Nothing has been saved yet.");
  // With the switch off the sheet's own markup is never made.
  assert.equal(without.document.getElementById("popup-earned-ask"), null);
  assert.equal(without.document.querySelector(".popup-earned-record .popup-earned-internal"), null);
  assert.equal(without.document.getElementById("popup-earned-primary").hasAttribute("aria-describedby"), false);
  assert.equal(
    without.document.getElementById("popup-earned-heading-row").nextElementSibling,
    without.document.getElementById("popup-earned-record"),
  );

  const onList = await openFirstTapPopup({ activeTab: { id: 7, url: "https://archiveofourown.org/works" } });
  assert.deepEqual(onList.h.firstTap.commands, [], "a list or home page saves nothing and keeps the existing ask");
});

test("first tap: an account that changed under the popup is asked about again, never drawn as unreachable", async () => {
  const { h, text, shown } = await openFirstTapPopup();
  h.firstTap.show({ state: "confirmed", workKey: "ao3:123", provenance: "found", mode: null, story: FIRST_TAP_STORY, entry: FIRST_TAP_ENTRY });
  h.firstTap.show({ state: "account_changed", workKey: "ao3:123" });
  assert.equal(shown(), "connecting");
  assert.equal(text("popup-earned-heading"), "Connecting to your account…");
  assert.equal(text("popup-earned-kicker"), null, "nothing of the other account's save is left on show");
  assert.equal(text("popup-earned-record"), null);
  assert.deepEqual(h.firstTap.commands, ["open", "open"]);
  h.advance(5_000);
  assert.equal(shown(), "connecting", "and the ask that was due does not arrive over it");
  assert.equal(text("popup-earned-ask"), null);
});

// --- The ask for lasting access, from the popup's own button --------------------

const FIRST_TAP_CONFIRMED = { state: "confirmed", workKey: "ao3:123", provenance: "saved_now", mode: "bounded_manual", story: FIRST_TAP_STORY, entry: FIRST_TAP_ENTRY };
const FIVE_STORY_SITES = [
  "https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*", "https://m.fanfiction.net/*",
];
const SAVED_RECORD = "someone · AO3Reading · Chapter 3 of 40";
const ASK_UNDER_THE_SAVE = "Let Trace save the next one by itselfSafari asks first. It lists AO3 and FanFiction.net’s 5 addresses.";

/** Values made in the popup's own realm, as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A sheet showing a confirmed save, with the ask arrived under it. */
async function openSavedFirstTapPopup(options = {}) {
  const opened = await openFirstTapPopup(options);
  opened.h.firstTap.show(FIRST_TAP_CONFIRMED);
  opened.h.advance(1_100);
  return opened;
}

test("first tap: the popup tells the background which tab it was opened on, read in that tap", async () => {
  for (const [activeTab, expected] of [
    [{ id: 7, url: "https://archiveofourown.org/works/123" }, null],
    [{ id: 7, url: "https://archiveofourown.org/works/123", incognito: false }, false],
    [{ id: 7, url: "https://archiveofourown.org/works/123", incognito: true }, true],
  ]) {
    const { h } = await openFirstTapPopup({ activeTab });
    assert.deepEqual(plain(h.firstTap.messages), [
      { command: "open", tabId: 7, url: "https://archiveofourown.org/works/123", private: expected },
    ]);
  }
});

test("first tap: the ask is made by the tap itself, for the five story sites, and the outcome is left to the background", async () => {
  const { h, element, text, shown, announced, sheet } = await openSavedFirstTapPopup({ deferredHostRequest: true });
  assert.equal(text("popup-earned-primary"), ALLOW_BUTTON);
  assert.deepEqual(h.permissionRequests, [], "nothing is asked until the reader taps");

  // The request is out before the click handler returns: no read or wait
  // comes between the tap and it.
  element("popup-earned-primary").dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(plain(h.permissionRequests), [{ origins: FIVE_STORY_SITES }]);
  assert.equal(h.firstTap.commands.at(-1), "access_asking");
  assert.deepEqual(h.reloads, []);

  h.firstTap.showAccess({ state: "waiting" });
  assert.deepEqual(sheet(), {
    state: "access-waiting", kicker: "Saved to your Library", heading: "The Long Way", body: null,
    record: SAVED_RECORD, second: ASK_UNDER_THE_SAVE, rule: RULE_LINE,
    primary: "Waiting for Safari…", secondary: "Not now",
  }, "the save and the ask stay as they were shown; only the button changes");
  assert.equal(element("popup-earned-primary").disabled, true);
  assert.equal(await announced(), "Waiting for Safari.");

  // Safari's question is answered. The popup passes on what the request
  // returned and draws nothing from it.
  h.finishHostRequest(true);
  for (let attempt = 0; attempt < 6; attempt += 1) await flush();
  assert.deepEqual(plain(h.firstTap.messages.at(-1)), {
    command: "access_answered", tabId: 7, url: "https://archiveofourown.org/works/123", private: null, returned: true,
  }, "what it returned, and nothing about how long it took");
  assert.equal(shown(), "access-waiting", "still waiting on the background's word");
  assert.deepEqual(h.reloads, [], "the page is not reloaded");
  assert.deepEqual(h.injections, []);
});

test("first tap: a tap on the ask before it has arrived cannot happen, and a second while Safari's question is up does nothing", async () => {
  const early = await openFirstTapPopup({ deferredHostRequest: true });
  early.h.firstTap.show(FIRST_TAP_CONFIRMED);
  assert.equal(early.element("popup-earned-pin").hidden, true, "there is no button until the ask arrives");
  await early.click("popup-earned-primary");
  assert.deepEqual(early.h.permissionRequests, []);

  const { h, element, click } = await openSavedFirstTapPopup({ deferredHostRequest: true });
  await click("popup-earned-primary");
  await click("popup-earned-primary");
  // The waiting state disables the button; a tap that still arrives is ignored too.
  h.firstTap.showAccess({ state: "waiting" });
  element("popup-earned-primary").disabled = false;
  element("popup-earned-primary").dataset.earnedAction = "first_tap_allow";
  await click("popup-earned-primary");
  assert.equal(h.permissionRequests.length, 1, "one request");
  assert.equal(h.firstTap.commands.filter((command) => command === "access_asking").length, 1);

  // Once it has come back, the reader can ask again.
  h.finishHostRequest(false);
  for (let attempt = 0; attempt < 6; attempt += 1) await flush();
  await click("popup-earned-primary");
  assert.equal(h.permissionRequests.length, 1, "nor until the background has said what came of it");
  h.firstTap.showAccess({ state: "not_allowed" });
  await click("popup-earned-secondary");
  assert.equal(h.permissionRequests.length, 1, "going back to the ask is not asking");
  await click("popup-earned-primary");
  assert.equal(h.permissionRequests.length, 2);
});

test("first tap: a request that throws is reported as thrown, and one that says no as no", async () => {
  const threw = await openSavedFirstTapPopup({ permissionRequestError: "must be called during a user gesture" });
  await threw.click("popup-earned-primary");
  for (let attempt = 0; attempt < 6; attempt += 1) await flush();
  assert.deepEqual(plain(threw.h.firstTap.messages.at(-1)), {
    command: "access_answered", tabId: 7, url: "https://archiveofourown.org/works/123", private: null, threw: true,
  });

  const refused = await openSavedFirstTapPopup({ permissionRequestResult: false });
  await refused.click("popup-earned-primary");
  for (let attempt = 0; attempt < 6; attempt += 1) await flush();
  assert.equal(refused.h.firstTap.messages.at(-1).returned, false);
  assert.equal(refused.h.reconcileRequests.length, 0, "nothing is registered where nothing is allowed");
});

test("first tap: where the story sites read as allowed, the page scripts are registered before the background is asked", async () => {
  const { h, click } = await openSavedFirstTapPopup();
  await click("popup-earned-primary");
  for (let attempt = 0; attempt < 6; attempt += 1) await flush();
  assert.equal(h.reconcileRequests.length, 1);
  assert.equal(h.firstTap.commands.at(-1), "access_answered");
  assert.ok(
    h.messages.findIndex(({ type }) => type === "TRACE_EARNED_PERMISSION_RECONCILE") !== -1,
    "through the existing registration, which asks Safari for nothing",
  );
  assert.deepEqual(h.reloads, [], "and the story is not reloaded");
});

test("first tap: each outcome of the ask is drawn from the background's word, in its own words, and none claims how long access lasts", async () => {
  const allowed = { state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" };
  const allowedKicker = "Allowed on AO3 and FanFiction.net";
  const savedKicker = "Saved to your Library";
  const justAllowed = {
    kicker: allowedKicker, heading: "The Long Way", body: null, record: SAVED_RECORD, second: null, rule: null,
    primary: "Keep reading",
  };
  const thatsIt = {
    state: "access-allowed", kicker: allowedKicker, heading: "That’s it. Keep reading.",
    body: "Trace saves the stories you open there and keeps your place. Your Library is in the Trace app.",
    record: `The Long Way${SAVED_RECORD}`, second: null, rule: null, primary: "Keep reading", secondary: null,
  };
  for (const [access, expected] of [
    [allowed, thatsIt],
    [{ ...allowed, handOver: "reload" }, thatsIt],
    [{ ...allowed, automaticSaving: "off" }, {
      state: "access-allowed-automatic-saving-off", kicker: allowedKicker, heading: "Automatic saving is off",
      body: "Trace in Safari is set to save stories only when you ask.", record: null, second: null, rule: null,
      primary: "Turn automatic saving on", secondary: "Keep reading",
    }],
    // Allowed, with something else not vouched for: allowed, and no more.
    [{ ...allowed, automaticSaving: "unknown" }, { state: "access-allowed-unconfirmed", ...justAllowed, secondary: null }],
    [{ ...allowed, account: "unknown" }, { state: "access-allowed-unconfirmed", ...justAllowed, secondary: null }],
    // Allowed, with no account to save to: what to do about the account, in that state's own words.
    [{ ...allowed, account: "missing" }, {
      state: "access-allowed-account-missing", kicker: allowedKicker, heading: "Trace couldn’t connect to your account",
      body: "Trace in Safari doesn’t have your account yet. Open the Trace app, then come back and tap Trace again.",
      record: null, second: null, rule: null, primary: "Try again", secondary: "Keep reading",
    }],
    [{ ...allowed, account: "reconnect_required" }, {
      state: "access-allowed-account-reconnect", kicker: allowedKicker, heading: "Open the Trace app to reconnect",
      body: "Trace in Safari needs your account again. Open the Trace app, then come back and tap Trace again.",
      record: null, second: null, rule: null, primary: "Try again", secondary: "Keep reading",
    }],
    // The account outranks the preference: with no account, nothing saves either way.
    [{ ...allowed, account: "missing", automaticSaving: "off" }, {
      state: "access-allowed-account-missing", kicker: allowedKicker, heading: "Trace couldn’t connect to your account",
      body: "Trace in Safari doesn’t have your account yet. Open the Trace app, then come back and tap Trace again.",
      record: null, second: null, rule: null, primary: "Try again", secondary: "Keep reading",
    }],
    [{ state: "registration_unknown" }, { state: "access-registration-unknown", ...justAllowed, secondary: "Check again" }],
    [{ state: "registration_failed" }, {
      state: "access-registration-failed", kicker: allowedKicker,
      heading: "Trace couldn’t finish turning on automatic saving",
      body: "Safari allowed AO3 and FanFiction.net, but Trace’s part didn’t start.", record: null, second: null,
      rule: null, primary: "Try again", secondary: null,
    }],
    [{ state: "partial", granted: 3, total: 5 }, {
      state: "access-partial", kicker: savedKicker, heading: "Safari allowed only some addresses",
      body: "Trace needs all 5 of AO3 and FanFiction.net’s addresses to save by itself.",
      record: null, second: null, rule: RULE_LINE, primary: ALLOW_BUTTON, secondary: "Not now",
    }],
    [{ state: "not_allowed", automaticSaving: "on" }, {
      state: "access-not-allowed", kicker: savedKicker, heading: "Trace will save when you tap it",
      body: "To save another story, open Trace from the Page Menu on it. You can let it save by itself any time.",
      record: null, second: null, rule: null, primary: "Keep reading", secondary: "Try again",
    }],
    // With automatic saving off a tap opens Trace and saves nothing by itself.
    [{ state: "not_allowed", automaticSaving: "off" }, {
      state: "access-not-allowed", kicker: savedKicker, heading: "Trace saves when you ask",
      body: "To save another story, open Trace from the Page Menu on it and tap Save this story.",
      record: null, second: null, rule: null, primary: "Keep reading", secondary: "Try again",
    }],
    [{ state: "could_not_ask", automaticSaving: "off" }, {
      state: "access-not-allowed", kicker: savedKicker, heading: "Trace saves when you ask",
      body: "To save another story, open Trace from the Page Menu on it and tap Save this story.",
      record: null, second: null, rule: null, primary: "Keep reading", secondary: "Try again",
    }],
    // A preference that could not be read claims neither.
    [{ state: "not_allowed", automaticSaving: "unknown" }, {
      state: "access-not-allowed", kicker: savedKicker, heading: "Trace will save when you tap it",
      body: "To save another story, open Trace from the Page Menu on it. You can let it save by itself any time.",
      record: null, second: null, rule: null, primary: "Keep reading", secondary: "Try again",
    }],
    [{ state: "not_known" }, {
      state: "access-not-known", kicker: savedKicker, heading: "Trace couldn’t check with Safari",
      body: "AO3 and FanFiction.net may be allowed already. Check again, or ask once more.", record: null,
      second: null, rule: RULE_LINE, primary: ALLOW_BUTTON, secondary: "Check again",
    }],
  ]) {
    const { h, sheet } = await openSavedFirstTapPopup();
    h.firstTap.showAccess(access);
    const drawn = sheet();
    assert.deepEqual(drawn, expected, expected.state);
    const outcome = [drawn.kicker, drawn.heading, drawn.body, drawn.primary, drawn.secondary].join(" ");
    assert.doesNotMatch(outcome, /always|one day|tomorrow|for good|permanent|from now on|until/i, expected.state);
    // Pressing the ask's button only makes a request: nothing says what Safari will then do.
    if (drawn.state === "access-partial") assert.doesNotMatch(outcome, /asks again/i);
    assert.deepEqual(h.reloads, [], "no outcome reloads the page from the popup");
    assert.deepEqual(h.permissionRequests, [], "and drawing one asks Safari for nothing");
  }
});

test("first tap: a no from the reader and a request Safari could not make are one state for the reader", async () => {
  const drawn = [];
  for (const state of ["not_allowed", "could_not_ask"]) {
    const { h, element, shown, click, announced, sheet } = await openSavedFirstTapPopup({ deferredHostRequest: true });
    h.firstTap.showAccess({ state });
    assert.equal(shown(), "access-not-allowed", state);
    drawn.push({
      sheet: sheet(),
      markup: element("popup-earned-permission").innerHTML,
      announced: await announced(),
      code: h.document.body.dataset.tracePopupStateCode,
      actions: [element("popup-earned-primary").dataset.earnedAction, element("popup-earned-secondary").dataset.earnedAction],
      emphasis: [element("popup-earned-primary").dataset.emphasis, element("popup-earned-secondary").dataset.emphasis],
    });
    // The save is kept and said to be: neither is drawn as a failure of it.
    assert.equal(sheet().kicker, "Saved to your Library", state);
    assert.doesNotMatch(`${sheet().heading} ${sheet().body}`, /couldn.t ask|declined|refused|denied|nothing was saved/i, state);

    // Try again goes back to the ask, where the request is the reader's own tap.
    await click("popup-earned-secondary");
    assert.equal(shown(), "saved", state);
    assert.equal(sheet().primary, ALLOW_BUTTON, state);
    assert.equal(sheet().second, ASK_UNDER_THE_SAVE, state);
    assert.deepEqual(h.permissionRequests, [], `${state}: returning to the ask is not asking`);
    await click("popup-earned-primary");
    assert.equal(h.permissionRequests.length, 1, state);
  }
  assert.deepEqual(drawn[0], drawn[1]);
  assert.deepEqual(drawn[0].actions, ["close", "first_tap_show_ask"]);
  assert.deepEqual(drawn[0].emphasis, ["secondary", "tertiary"], "Keep reading is raised; nothing here is the task");
  assert.equal(drawn[0].announced, "Trace will save when you tap it. To save another story, open Trace from the Page Menu on it. You can let it save by itself any time.");

  const popup = fs.readFileSync(POPUP_JS_PATH, "utf8");
  assert.doesNotMatch(popup, /access-could-not-ask|access-declined/, "there is no second presentation left to draw");
});

test("first tap: allowed with no saved story on show says so without a record", async () => {
  const { h, sheet, announced } = await openFirstTapPopup({ grantedOrigins: [...FIVE_STORY_SITES] });
  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "unknown", handOver: "in_place" }, { state: "automatic" });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.deepEqual(sheet(), {
    state: "access-allowed-unconfirmed", kicker: null, heading: "Allowed on AO3 and FanFiction.net", body: null,
    record: null, second: null, rule: null, primary: "Keep reading", secondary: null,
  });
  assert.equal(await announced(), "Allowed on AO3 and FanFiction.net.");
});

test("first tap: a failed registration or an unread answer is looked at again without asking Safari; partly allowed and not known ask again from the tap", async () => {
  for (const [state, button] of [
    ["registration_failed", "popup-earned-primary"],
    ["registration_unknown", "popup-earned-secondary"],
    ["not_known", "popup-earned-secondary"],
  ]) {
    const { h, click } = await openSavedFirstTapPopup({ grantedOrigins: [...FIVE_STORY_SITES] });
    h.firstTap.showAccess({ state });
    await click(button);
    for (let attempt = 0; attempt < 6; attempt += 1) await flush();
    assert.equal(h.firstTap.commands.at(-1), "access_check", state);
    assert.deepEqual(h.permissionRequests, [], state);
    assert.deepEqual(h.reloads, [], state);
  }

  for (const access of [{ state: "partial", granted: 2, total: 5 }, { state: "not_known" }]) {
    const { h, element, click, sheet } = await openSavedFirstTapPopup({ deferredHostRequest: true });
    h.firstTap.showAccess(access);
    assert.equal(element("popup-earned-primary").getAttribute("aria-describedby"), "popup-earned-rule", access.state);
    await click("popup-earned-primary");
    assert.equal(h.permissionRequests.length, 1, access.state);
    // While Safari's question is up the saved story and the ask are what is shown.
    h.firstTap.showAccess({ state: "waiting" });
    assert.equal(sheet().state, "access-waiting", access.state);
    assert.equal(sheet().primary, "Waiting for Safari…", access.state);
    assert.equal(sheet().second, ASK_UNDER_THE_SAVE, access.state);
  }
});

test("first tap: Turn automatic saving on sets the preference and has the background read what holds", async () => {
  const granted = [...FIVE_STORY_SITES];
  const { h, click, sheet } = await openSavedFirstTapPopup({ grantedOrigins: granted, storageState: { prefAutoTrackEnabled: false } });
  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "off", handOver: "in_place" });
  assert.equal(sheet().primary, "Turn automatic saving on");
  const before = h.firstTap.commands.length;
  await click("popup-earned-primary");
  for (let attempt = 0; attempt < 6; attempt += 1) await flush();
  assert.equal(h.store.prefAutoTrackEnabled, true);
  assert.equal(h.document.getElementById("pref-auto-track").checked, true);
  assert.deepEqual(h.firstTap.commands.slice(before), ["access_check"]);
  assert.equal(sheet().state, "access-allowed-automatic-saving-off", "nothing more is claimed until the background says so");
  assert.deepEqual(h.permissionRequests, []);
  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" });
  assert.equal(sheet().heading, "That’s it. Keep reading.");
});

// The wait on Safari. Every time below is the popup's own clock, moved by the test.

/** A saved sheet whose ask has just been tapped, with Safari's answer held back. */
async function askingFirstTapPopup(options = {}) {
  const granted = [];
  const opened = await openSavedFirstTapPopup({ deferredHostRequest: true, grantedOrigins: granted, ...options });
  await opened.click("popup-earned-primary");
  opened.h.firstTap.showAccess({ state: "waiting" });
  const settle = async () => { for (let attempt = 0; attempt < 8; attempt += 1) await flush(); };
  /** Moves the popup's clock on, letting each look that comes due finish. */
  const pass = async (ms) => {
    for (let moved = 0; moved < ms; moved += 1_000) {
      opened.h.advance(Math.min(1_000, ms - moved));
      await settle();
    }
  };
  const sent = () => opened.h.firstTap.commands.filter((command) => command.startsWith("access_"));
  return { ...opened, granted, settle, pass, sent };
}

test("first tap: a request Safari never answers does not hold the sheet: after a minute it is not known, the reader can ask again, and it is never a no", async () => {
  const { h, element, text, shown, click, pass, sent } = await askingFirstTapPopup();
  const seen = new Set();
  for (let second = 0; second < 59; second += 1) {
    await pass(1_000);
    seen.add(shown());
  }
  assert.deepEqual([...seen], ["access-waiting"], "waiting, for all of the first 59 seconds");
  assert.equal(element("popup-earned-primary").disabled, true);
  assert.deepEqual(sent(), ["access_asking"], "with nothing allowed there is nothing to tell the background");

  await pass(1_000);
  assert.equal(shown(), "access-not-known", "at the minute: not known");
  assert.equal(sent().at(-1), "access_unanswered", "and the background is asked to read for itself");
  assert.equal(text("popup-earned-heading"), "Trace couldn’t check with Safari");
  assert.equal(text("popup-earned-primary"), ALLOW_BUTTON, "the ask is there again");
  assert.equal(element("popup-earned-primary").disabled, false);
  assert.equal(text("popup-earned-secondary"), "Check again");

  // However much longer, it is never drawn as a no, and nothing more is sent.
  const count = sent().length;
  for (let minute = 0; minute < 10; minute += 1) {
    await pass(60_000);
    assert.equal(shown(), "access-not-known");
  }
  assert.equal(sent().length, count);
  assert.equal(h.permissionRequests.length, 1, "and Safari is not asked again by itself");

  // The reader asks again, from a tap.
  await click("popup-earned-primary");
  assert.equal(h.permissionRequests.length, 2);
  assert.equal(sent().at(-1), "access_asking");
});

test("first tap: while Safari's answer is out the popup reads again, and goes on as allowed once the sites are, whether or not the request ever comes back", async () => {
  const { h, shown, granted, pass, sent } = await askingFirstTapPopup();
  await pass(8_000);
  assert.deepEqual(sent(), ["access_asking"]);
  assert.equal(h.reconcileRequests.length, 0);

  // The sites become allowed. The request still has not come back.
  granted.push(...FIVE_STORY_SITES);
  await pass(2_000);
  assert.equal(sent().at(-1), "access_waiting", "the background is asked to read, within one look");
  assert.equal(h.reconcileRequests.length, 1, "after the page scripts were registered");
  assert.equal(shown(), "access-waiting", "and the popup still draws only what the background says");
  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" });
  assert.equal(shown(), "access-allowed");

  // The wait is over: the deadline that would have come changes nothing.
  const count = sent().length;
  await pass(120_000);
  assert.equal(shown(), "access-allowed");
  assert.equal(sent().length, count);
  assert.deepEqual(h.reloads, []);
});

test("first tap: the popup coming back into view while Safari's answer is out reads at once", async () => {
  const { h, granted, settle, sent } = await askingFirstTapPopup();
  granted.push(...FIVE_STORY_SITES);
  Object.defineProperty(h.document, "hidden", { value: false, configurable: true });
  h.document.dispatchEvent(new h.window.Event("visibilitychange"));
  await settle();
  assert.equal(sent().at(-1), "access_waiting", "without waiting for the next look to come due");

  // With nothing allowed, coming back into view tells the background nothing.
  const idle = await askingFirstTapPopup();
  idle.h.window.dispatchEvent(new idle.h.window.Event("focus"));
  await idle.settle();
  assert.deepEqual(idle.sent(), ["access_asking"]);
});

test("first tap: an answer that comes after the minute is still passed on, and one with neither yes nor no is looked at once more", async () => {
  const late = await askingFirstTapPopup();
  await late.pass(60_000);
  assert.equal(late.shown(), "access-not-known");
  late.h.finishHostRequest(false);
  await late.settle();
  assert.equal(late.h.firstTap.messages.at(-1).command, "access_answered");
  assert.equal(late.h.firstTap.messages.at(-1).returned, false, "the background reads, and then says what came of it");

  // Safari returns nothing at all.
  const empty = await openSavedFirstTapPopup({ permissionRequestResult: null });
  await empty.click("popup-earned-primary");
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(empty.h.firstTap.messages.at(-1).command, "access_answered");
  assert.equal(empty.h.firstTap.messages.at(-1).returned, null);
  empty.h.firstTap.showAccess({ state: "not_known" });
  assert.equal(empty.shown(), "access-not-known");
  empty.h.advance(2_000);
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(empty.h.firstTap.commands.at(-1), "access_unanswered", "a look that can find allowed, and never a no");
});

test("first tap: allowed does not outlive the access: when Safari reports a change the popup has the background read again", async () => {
  const granted = [...FIVE_STORY_SITES];
  const { h, shown, text } = await openSavedFirstTapPopup({ grantedOrigins: granted });
  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" });
  assert.equal(shown(), "access-allowed");

  // The reader removes the story sites while the sheet is open.
  granted.length = 0;
  h.emitPermissionChange("removed");
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.firstTap.commands.at(-1), "access_check");
  h.firstTap.showAccess({ state: "not_asked" });
  assert.equal(shown(), "saved", "allowed is gone; the save and the ask are what is left");
  assert.equal(text("popup-earned-kicker"), "Saved to your Library");
  assert.equal(text("popup-earned-heading"), "The Long Way");
  assert.equal(text("popup-earned-primary"), ALLOW_BUTTON);
  assert.equal(h.document.getElementById("popup-earned-heading-row").nextElementSibling, h.document.getElementById("popup-earned-record"), "with the record back under the title");
  assert.deepEqual(h.permissionRequests, [], "and Safari was asked nothing");

  // Allowed elsewhere while the sheet shows the save and its ask.
  const before = h.firstTap.commands.length;
  granted.push(...FIVE_STORY_SITES);
  h.emitPermissionChange("added");
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.firstTap.commands.length, before + 1);
  assert.equal(h.firstTap.commands.at(-1), "access_check");

  // Coming back into view with allowed on show reads again too.
  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" });
  h.window.dispatchEvent(new h.window.Event("focus"));
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(h.firstTap.commands.length, before + 2);
  assert.equal(h.firstTap.commands.at(-1), "access_check");

  // A look that finds nothing to show leaves a sheet that shows nothing of the ask alone.
  const plainSheet = await openSavedFirstTapPopup();
  plainSheet.h.firstTap.showAccess({ state: "not_asked" });
  assert.equal(plainSheet.shown(), "saved");
  plainSheet.h.firstTap.showAccess({ state: "waiting" });
  assert.equal(plainSheet.shown(), "saved", "and waiting is only ever shown for a request this popup has out");
});

test("first tap: opened on a story with the sites allowed but setup not finished, the popup shows what the background read and reloads nothing", async () => {
  const { h, shown, text, sheet } = await openFirstTapPopup({ grantedOrigins: [...FIVE_STORY_SITES] });
  assert.deepEqual(h.firstTap.commands, ["open"], "the background is asked what holds");
  assert.equal(h.reconcileRequests.length, 1, "after the page scripts were registered");
  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" }, { state: "automatic" });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.deepEqual(sheet(), {
    state: "access-allowed", kicker: "Allowed on AO3 and FanFiction.net", heading: "That’s it. Keep reading.",
    body: "Trace saves the stories you open there and keeps your place. Your Library is in the Trace app.",
    record: null, second: null, rule: null, primary: "Keep reading", secondary: null,
  });
  assert.deepEqual(h.reloads, [], "the story is not reloaded");
  assert.deepEqual(h.permissionRequests, []);

  // The page reporting in after it was handed over does not replace the sheet.
  h.emitStorageChange({ traceArchiveReadiness: { newValue: { lastArchiveSeenAt: Date.now() + 1_000 } } });
  for (let attempt = 0; attempt < 20; attempt += 1) await flush();
  assert.equal(shown(), "access-allowed");
  assert.equal(text("popup-earned-heading"), "That’s it. Keep reading.", "what the sheet shows is left alone");
  assert.equal(h.document.getElementById("popup-earned-permission").hidden, false);
  assert.deepEqual(h.firstTap.commands, ["open"]);
  assert.deepEqual(h.reloads, []);
});

test("first tap: a reader who finished setup is not sent through the first-tap states", async () => {
  const { h, shown } = await openFirstTapPopup({
    grantedOrigins: [...FIVE_STORY_SITES],
    storageState: { traceEarnedPermissionOnboardingV1: { completedAt: 1, grantAt: 1, promptResult: "granted", registrationVersion: 3 } },
  });
  assert.deepEqual(h.firstTap.commands, []);
  assert.equal(shown(), undefined);
});

// --- The sheet's words, and how it is read, sized and moved ----------------------

/** Every state of the sheet, as the background's word for it. */
const FIRST_TAP_STATES = (() => {
  const allowed = { state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" };
  const failed = (reason, dispatch) => ({ state: "failed", workKey: "ao3:123", reason, dispatch, story: FIRST_TAP_STORY });
  const confirmed = (provenance) => ({ ...FIRST_TAP_CONFIRMED, provenance });
  return [
    ["connecting", { view: { state: "opening" } }],
    ["account-missing", { view: { state: "account_missing", workKey: "ao3:123" } }],
    ["account-unreachable", { view: { state: "account_unknown", workKey: "ao3:123" } }],
    ["account-reconnect", { view: { state: "account_reconnect_required", workKey: "ao3:123" } }],
    ["save-on-request", { view: { state: "awaiting_request", workKey: "ao3:123", preference: "unknown" } }],
    ["automatic-saving-off", { view: { state: "awaiting_request", workKey: "ao3:123", preference: "off" } }],
    ["saving", { view: { state: "saving", workKey: "ao3:123", startedAt: 0 } }],
    ["still-confirming", { view: { state: "saving", workKey: "ao3:123", startedAt: 0 }, after: 20_000 }],
    ["saved", { view: confirmed("saved_now"), after: 1_100 }],
    ["already-in-library", { view: confirmed("already"), after: 1_100 }],
    ["in-library", { view: confirmed("found"), after: 1_100 }],
    ["save-unconfirmed", { view: failed("unavailable", "sent_unconfirmed") }],
    ["still-unknown", { view: { state: "presence_unknown", workKey: "ao3:123" } }],
    ["story-unavailable", { view: failed("story_unavailable", "never_sent") }],
    ["library-full", { view: failed("free_limit_reached", "refused") }],
    ["save-not-sent", { view: failed("page_unreachable", "never_sent") }],
    ["save-not-sent", { view: failed("unavailable", "not_in_library") }],
    ["save-refused", { view: failed("rate_limited", "refused") }],
    ["save-reconnect", { view: failed("not_authenticated", "refused") }],
    ["access-waiting", { view: confirmed("saved_now"), after: 1_100, tap: "popup-earned-primary", access: { state: "waiting" } }],
    ["access-allowed", { view: confirmed("saved_now"), access: allowed }],
    ["access-allowed-automatic-saving-off", { view: confirmed("saved_now"), access: { ...allowed, automaticSaving: "off" } }],
    ["access-allowed-unconfirmed", { view: confirmed("saved_now"), access: { ...allowed, account: "unknown" } }],
    ["access-allowed-account-missing", { view: confirmed("saved_now"), access: { ...allowed, account: "missing" } }],
    ["access-allowed-account-reconnect", { view: confirmed("saved_now"), access: { ...allowed, account: "reconnect_required" } }],
    ["access-registration-unknown", { view: confirmed("saved_now"), access: { state: "registration_unknown" } }],
    ["access-registration-failed", { view: confirmed("saved_now"), access: { state: "registration_failed" } }],
    ["access-partial", { view: confirmed("saved_now"), access: { state: "partial", granted: 1, total: 5 } }],
    ["access-not-allowed", { view: confirmed("saved_now"), access: { state: "not_allowed", automaticSaving: "on" } }],
    ["access-not-allowed", { view: confirmed("saved_now"), access: { state: "could_not_ask", automaticSaving: "on" } }],
    ["access-not-allowed", { view: confirmed("saved_now"), access: { state: "not_allowed", automaticSaving: "off" } }],
    ["access-not-known", { view: confirmed("saved_now"), access: { state: "not_known" } }],
  ];
})();

/** Opens the sheet and takes it to one state. */
async function firstTapPopupIn({ view, after = 0, tap = null, access = null }, options = {}) {
  const opened = await openFirstTapPopup({ deferredHostRequest: true, ...options });
  if (view.state !== "opening") opened.h.firstTap.show(view);
  if (after) opened.h.advance(after);
  if (tap) await opened.click(tap);
  if (access) opened.h.firstTap.showAccess(access);
  return opened;
}

test("first tap: every state is reachable, has one headline, says its news aloud and offers only real buttons", async () => {
  const reached = new Set();
  for (const [name, steps] of FIRST_TAP_STATES) {
    const { h, element, shown, announced, sheet } = await firstTapPopupIn(steps);
    assert.equal(shown(), name);
    reached.add(name);
    const section = element("popup-earned-permission");
    assert.equal(section.hidden, false, name);
    assert.equal(section.getAttribute("aria-labelledby"), "popup-earned-heading", name);

    // One headline, a real one, that says something.
    const headlines = [...section.querySelectorAll("h1")].filter((node) => !node.closest("[hidden]"));
    assert.equal(headlines.length, 1, name);
    assert.equal(headlines[0].id, "popup-earned-heading", name);
    assert.ok(sheet().heading, name);
    assert.doesNotMatch(Object.values(sheet()).join(" "), /\[[a-z-]+\]/, `${name}: no stand-in for words is left`);
    if (sheet().second !== null) assert.equal(element("popup-earned-ask-heading").tagName, "H2", name);
    assert.equal(shownText(element("popup-earned-note")) !== null, name === "still-confirming", `${name}: news of a save still out`);

    // The result is said through one polite live region, and is never empty.
    const live = element("popup-earned-result");
    assert.equal(live.getAttribute("role"), "status", name);
    assert.equal(live.getAttribute("aria-live"), "polite", name);
    assert.equal(live.getAttribute("aria-atomic"), "true", name);
    const said = await announced();
    assert.ok(said.length > 0, `${name}: something is announced`);
    assert.doesNotMatch(said, /…|<b>|\{count\}|undefined|null/, name);

    // Marks and dots are decoration; what they mean is in the words.
    for (const id of ["popup-earned-kicker-icon", "popup-earned-heading-glyph", "popup-earned-record-dot"]) {
      assert.equal(element(id).getAttribute("aria-hidden"), "true", `${name}: ${id}`);
    }

    // Every action on show is a button with a label and something to do.
    for (const id of ["popup-earned-primary", "popup-earned-secondary", "popup-earned-note-action"]) {
      const button = element(id);
      if (!button || button.hidden || button.closest("[hidden]")) continue;
      assert.equal(button.tagName, "BUTTON", name);
      assert.ok(button.textContent.trim(), name);
      assert.ok(button.disabled || button.dataset.earnedAction, `${name}: ${id} does something`);
    }

    // The rule line names Safari's buttons; read aloud, it leaves the colour out.
    const rule = element("popup-earned-rule");
    if (rule.hidden) {
      assert.equal(element("popup-earned-primary").hasAttribute("aria-describedby"), false, name);
    } else {
      assert.equal(shownText(rule), RULE_LINE, name);
      assert.equal(spokenText(rule), "Tap Always Allow, not Allow for One Day.", name);
      assert.equal(rule.firstElementChild.getAttribute("aria-hidden"), "true", name);
      assert.equal(element("popup-earned-primary").getAttribute("aria-describedby"), "popup-earned-rule", name);
      assert.equal(rule.nextElementSibling.contains(element("popup-earned-primary")), true, `${name}: the rule is the last thing above the button`);
    }
    assert.deepEqual(h.reloads, [], name);
  }
  assert.equal(reached.size, FIRST_TAP_STATES.length - 3, "every state: a request that came to nothing is one state however it did, and so is a tap that added nothing");
});

test("first tap: the wording keeps to the rules for Trace's copy", async () => {
  const { h } = await openFirstTapPopup();
  const words = JSON.parse(h.evaluate("JSON.stringify(FIRST_TAP_WORDS)"));
  const lines = Object.entries(words);
  assert.ok(lines.length > 40);
  for (const [key, line] of lines) {
    const said = line.replace(/<\/?b>/g, "");
    // One person's voice, and the product's own words.
    assert.doesNotMatch(said, /\b(?:we|we.re|we.ll|our|ours|us|the team)\b/i, key);
    assert.doesNotMatch(said, /\bretry\b|\bshel(?:f|ves)\b|story sites?|\bbeta\b|\bfics?\b/i, key);
    // Safari's settings screen is never where a reader is sent to check access,
    // and nothing says what that screen will show.
    assert.doesNotMatch(said, /\bsettings\b|says ["“]?allow|shows? ["“]?allow|set to ["“]?allow|check (?:it|that|safari)/i, key);
    // The two sites are named together, and neither is called by a logo or a nickname.
    assert.equal(/AO3/.test(said), /FanFiction\.net/.test(said), `${key}: AO3 and FanFiction.net together`);
    assert.doesNotMatch(said, /\bFFN\b|Archive of Our Own|fanfiction\.net(?!\b)|<img|<svg/, key);
    // Nothing about a plan is said here; a full Library keeps its own words, with its limit.
    assert.doesNotMatch(said, /\bfree\b|unlimited/i, key);
    // No state says how long access lasts. Only the rule line names Safari's two buttons.
    if (!key.startsWith("rule")) assert.doesNotMatch(said, /always|one day|tomorrow|for good|permanent|forever/i, key);
    assert.doesNotMatch(said, /'|"|\.\.\./, `${key}: typographic marks`);
    assert.doesNotMatch(said, /\b(?:sorry|oops|uh oh|great|awesome|hooray|yay|don.t worry|relax)\b|!/i, `${key}: no narrated feeling`);
  }
  assert.equal(words.allow, ALLOW_BUTTON);
  assert.equal(words.rule, "Tap <b>Always Allow</b>, not the blue <b>Allow for One Day</b>.");
  assert.equal(words.tryAgain, "Try again");

  assert.equal(words.checking, "Checking…");
  assert.equal(words.reconnectHeading, "Open the Trace app to reconnect");
  assert.equal(words.reconnectBody, "Trace in Safari needs your account again. Open the Trace app, then come back and tap Trace again.");
  assert.equal(words.partialBody, "Trace needs all {count} of AO3 and FanFiction.net’s addresses to save by itself.");
  assert.equal(words.notAllowedOnRequestHeading, "Trace saves when you ask");
  assert.equal(words.notAllowedOnRequestBody, "To save another story, open Trace from the Page Menu on it and tap Save this story.");
  // Whether Safari shows its question again is not something Trace can know.
  for (const [key, line] of lines) {
    if (key !== "askBody") assert.doesNotMatch(line, /Safari asks/i, key);
    assert.doesNotMatch(line, /sign in/i, `${key}: the app may be signed in already`);
  }

  // Wording that has not been reviewed yet is marked as such. None is left.
  const popup = fs.readFileSync(POPUP_JS_PATH, "utf8");
  const table = popup.slice(popup.indexOf("const FIRST_TAP_WORDS = Object.freeze({"), popup.indexOf("function firstTapSend("));
  assert.equal((table.match(/Wording pending review/g) || []).length, 0);
  assert.doesNotMatch(popup, /firstTapPlaceholder|renderFirstTapUnworded/);
});

test("first tap: the number of addresses in the ask is the build's own", async () => {
  const { h, text } = await openSavedFirstTapPopup();
  assert.match(text("popup-earned-ask-body"), /FanFiction\.net’s 5 addresses\.$/);
  assert.equal(h.evaluate("earnedOrigins().length"), 5);
  assert.equal(h.evaluate("firstTapCounted('{count}')"), "5");
});

test("first tap: where every button in Safari's question is blue, the rule line does not point at a colour", async () => {
  const agent = (system, safari) =>
    `Mozilla/5.0 (iPhone; CPU iPhone OS ${system} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${safari}Mobile/15E148 Safari/604.1`;
  for (const [userAgent, expected] of [
    [agent("17_6", "Version/17.6 "), "Tap Always Allow, not Allow for One Day."],
    [agent("18_6", "Version/18.6 "), "Tap Always Allow, not Allow for One Day."],
    [agent("17_6", ""), "Tap Always Allow, not Allow for One Day."],
    [agent("18_6", "Version/26.0 "), RULE_LINE],
    [agent("18_7", "Version/27.0 "), RULE_LINE],
    // Not known to be older: the approved line stands.
    [agent("18_6", ""), RULE_LINE],
  ]) {
    const { h, element } = await openSavedFirstTapPopup({ userAgent });
    assert.equal(shownText(element("popup-earned-rule")), expected, userAgent);
    assert.equal(spokenText(element("popup-earned-rule")), "Tap Always Allow, not Allow for One Day.", userAgent);
    assert.equal(h.document.body.dataset.tracePlatform, "ios");
  }
});

test("first tap: arrivals play once, the ask after the save, and a redraw of the same state moves nothing", async () => {
  const moving = (h) => [...h.document.querySelectorAll(".popup-first-tap-fade, .popup-first-tap-rise")]
    .map((node) => `${node.id || node.className.split(" ")[0]}:${node.classList.contains("popup-first-tap-rise") ? "rise" : "fade"}`).sort();
  const { h, shown } = await openFirstTapPopup();
  h.firstTap.show(FIRST_TAP_CONFIRMED);
  assert.deepEqual(moving(h), ["popup-earned-kicker:fade", "popup-earned-record-state:fade"], "Saved lands: the kicker and the status line");
  h.advance(1_100);
  assert.deepEqual(moving(h), ["popup-earned-ask:rise", "popup-earned-pin:rise"], "then the ask and its buttons, as one move");
  h.firstTap.show(FIRST_TAP_CONFIRMED);
  assert.deepEqual(moving(h), ["popup-earned-ask:rise", "popup-earned-pin:rise"], "the same state drawn again starts nothing new");

  h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" });
  assert.equal(shown(), "access-allowed");
  assert.deepEqual(moving(h), ["popup-earned-pin:fade", "popup-earned-scroll:fade"], "allowed takes the ask's place in one cross-fade");
  h.firstTap.showAccess({ state: "not_allowed" });
  assert.deepEqual(moving(h), [], "and the other outcomes simply appear");

  // A new save starts over: saved by itself, then the ask.
  h.firstTap.showAccess({ state: "not_asked" });
  h.firstTap.show({ state: "saving", workKey: "ao3:123", startedAt: 0 });
  h.firstTap.show(FIRST_TAP_CONFIRMED);
  assert.equal(h.document.getElementById("popup-earned-pin").hidden, true);
  h.advance(1_100);
  assert.equal(h.document.getElementById("popup-earned-primary").textContent, ALLOW_BUTTON);
});

test("first tap: the sheet's styles respect Reduce Motion, wrap long labels and keep the kicker at every text size", () => {
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  // Under Reduce Motion an arrival is a short cross-fade and nothing else moves.
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");
  assert.match(reduced, /\*\s*\{[^}]*animation:\s*none !important/);
  assert.match(reduced, /\.popup-earned \.popup-first-tap-fade,\s*\.popup-earned \.popup-first-tap-rise \{ animation: popup-first-tap-fade 0\.15s linear both !important; \}/);
  assert.match(css, /@keyframes popup-first-tap-fade \{ from \{ opacity: 0; \} \}/, "the cross-fade moves nothing");
  assert.doesNotMatch(reduced, /popup-first-tap-rise 0|translate|scale\(/);
  assert.ok(css.lastIndexOf("popup-first-tap-fade 0.15s") > css.indexOf("popup-first-tap-rise 0.5s"), "and it comes after the moves it replaces");
  // The spinning mark stands still: the blanket rule above covers it.
  assert.match(css, /\.popup-earned-heading-glyph\[data-tone="progress"\] svg \{ animation: popup-spin/);

  // "Allow AO3 and FanFiction.net" is longer than the sheet at the largest sizes.
  assert.match(css, /body\[data-trace-first-tap-state\] \.popup-earned-actions button \{[^}]*white-space:\s*normal;/);
  // The kicker carries the news here, so the largest sizes keep it.
  assert.match(css, /body\[data-trace-first-tap-state\] \.popup-earned-text-ax \.popup-earned-story-summary \{ display: flex; \}/);
  // Both colour schemes come from the popup's own tokens: no colour is written into these rules.
  const own = css.slice(css.indexOf("/* The sheet a first tap opens"), css.indexOf("@media (max-height: 300px)"));
  assert.ok(own.length > 500);
  assert.doesNotMatch(own, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(own, /var\(--text\)/);
  assert.match(own, /var\(--text-2\)/);
  assert.match(own, /var\(--rule\)/);
});

test("first tap: at the largest text sizes nothing is pinned, so the rule line and the button come last in reading order", async () => {
  const { h, element } = await openSavedFirstTapPopup({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  });
  h.document.body.style.fontSize = "53px";
  h.firstTap.show(FIRST_TAP_CONFIRMED);
  const section = element("popup-earned-permission");
  assert.equal(section.classList.contains("popup-earned-ax"), true);
  assert.equal(section.classList.contains("popup-earned-fixed-pin"), false);
  // Reading order is the order on the page: confirmation, story, ask, rule, buttons.
  const order = ["popup-earned-kicker", "popup-earned-heading", "popup-earned-record", "popup-earned-ask", "popup-earned-rule", "popup-earned-primary", "popup-earned-secondary"]
    .map((id) => element(id));
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index - 1].compareDocumentPosition(order[index]) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, order[index].id);
  }
});

// --- Buttons that wait on an answer -------------------------------------------------

/** Taps a button even where the browser would not deliver the tap. */
async function tapRegardless(opened, id, action) {
  const button = opened.element(id);
  button.disabled = false;
  button.dataset.earnedAction = action;
  await opened.click(id);
}

test("first tap: Check again and Try again wait on their answer, send one request a tap, and say the answer aloud even when nothing changed", async () => {
  const failed = { state: "failed", workKey: "ao3:123", reason: "unavailable", dispatch: "sent_unconfirmed", story: FIRST_TAP_STORY };
  const allowed = { state: "allowed", account: "reconnect_required", automaticSaving: "on", handOver: "in_place" };
  for (const [name, arrive, button, command, restored, said] of [
    ["an unconfirmed save", (h) => h.firstTap.show(failed), "popup-earned-primary", "check", "Check again",
      "Trace couldn’t confirm this save. It may have saved anyway. Check again to find out."],
    ["a look that could not tell", (h) => h.firstTap.show({ state: "presence_unknown", workKey: "ao3:123" }), "popup-earned-primary", "check", "Check again",
      "Trace still couldn’t check. Look for it in your Library in the Trace app, or check again later."],
    ["no account", (h) => h.firstTap.show({ state: "account_missing", workKey: "ao3:123" }), "popup-earned-primary", "open", "Try again",
      "Trace couldn’t connect to your account. Trace in Safari doesn’t have your account yet. Open the Trace app, then come back and tap Trace again."],
    ["a failed registration", (h) => h.firstTap.showAccess({ state: "registration_failed" }), "popup-earned-primary", "access_check", "Try again",
      "Trace couldn’t finish turning on automatic saving. Safari allowed AO3 and FanFiction.net, but Trace’s part didn’t start."],
    ["an unread answer", (h) => h.firstTap.showAccess({ state: "not_known" }), "popup-earned-secondary", "access_check", "Check again",
      "Trace couldn’t check with Safari. AO3 and FanFiction.net may be allowed already. Check again, or ask once more."],
    ["allowed with an account to reconnect", (h) => h.firstTap.showAccess(allowed), "popup-earned-primary", "access_check", "Try again",
      "Allowed on AO3 and FanFiction.net. Open the Trace app to reconnect. Trace in Safari needs your account again. Open the Trace app, then come back and tap Trace again."],
  ]) {
    const opened = await openSavedFirstTapPopup({ grantedOrigins: command === "access_check" ? [...FIVE_STORY_SITES] : [] });
    const { h, element, click, announced, sheet } = opened;
    const settle = async () => { for (let attempt = 0; attempt < 6; attempt += 1) await flush(); };
    arrive(h);
    assert.equal(await announced(), said, name);
    const drawn = sheet();
    const action = element(button).dataset.earnedAction;
    const before = h.firstTap.commands.length;

    await click(button);
    await settle();
    assert.equal(shownText(element(button)), "Checking…", name);
    assert.equal(element(button).disabled, true, name);
    assert.equal(element(button).dataset.earnedAction, "", name);
    assert.equal(await announced(), "Checking.", name);
    assert.deepEqual(h.firstTap.commands.slice(before), [command], name);
    // A second tap that still arrives sends nothing more.
    await tapRegardless(opened, button, action);
    await settle();
    assert.deepEqual(h.firstTap.commands.slice(before), [command], `${name}: one request for one tap`);
    assert.deepEqual(h.permissionRequests, [], `${name}: and Safari is asked nothing`);

    // The same answer comes back. The sheet is as it was, and says so again.
    arrive(h);
    assert.deepEqual(sheet(), drawn, name);
    assert.equal(shownText(element(button)), restored, name);
    assert.equal(element(button).disabled, false, name);
    assert.equal(element("popup-earned-result").textContent, "", `${name}: the live region is cleared`);
    assert.equal(await announced(), said, `${name}: and given the same words again`);

    // And the reader can ask again.
    await click(button);
    await settle();
    assert.deepEqual(h.firstTap.commands.slice(before), [command, command], name);
  }
});

test("first tap: a look that is never answered gives its button back, and one asked of a background that has gone opens on the story again", async () => {
  const unconfirmed = { state: "failed", workKey: "ao3:123", reason: "unavailable", dispatch: "sent_unconfirmed", story: FIRST_TAP_STORY };
  const { h, element, text, click, announced, sheet } = await openFirstTapPopup();
  h.firstTap.show(unconfirmed);
  const drawn = sheet();
  await click("popup-earned-primary");
  h.advance(14_999);
  assert.equal(text("popup-earned-primary"), "Checking…");
  h.advance(1);
  assert.deepEqual(sheet(), drawn, "the sheet as it stood");
  assert.equal(element("popup-earned-primary").disabled, false);
  assert.equal(await announced(), "Trace couldn’t confirm this save. It may have saved anyway. Check again to find out.");

  // The background was restarted under the sheet: its port is gone.
  h.disconnectPopup();
  const before = h.firstTap.commands.length;
  await click("popup-earned-primary");
  assert.equal(h.hostLifecycle.filter((name) => name === "trace-first-tap-popup-v1").length, 2, "the port is opened again");
  assert.deepEqual(h.firstTap.commands.slice(before), ["open"], "and the story is opened on afresh, which looks before it saves");
});

test("first tap: the still-confirming look waits and answers aloud like any other, and a result that arrives meanwhile is simply shown", async () => {
  const saving = { state: "saving", workKey: "ao3:123", startedAt: 0, story: FIRST_TAP_STORY };
  const { h, element, text, shown, click, announced } = await openFirstTapPopup();
  h.firstTap.show(saving);
  h.advance(20_000);
  assert.equal(shown(), "still-confirming");
  await announced();
  await click("popup-earned-note-action");
  assert.equal(text("popup-earned-note-action"), "Checking…");
  assert.equal(element("popup-earned-note-action").disabled, true);
  assert.equal(text("popup-earned-primary"), ALLOW_BUTTON, "the ask is left as it was");
  assert.equal(await announced(), "Checking.");

  // Trace does not have the story yet and the save is still out: the same state, said again.
  h.firstTap.show(saving);
  assert.equal(shown(), "still-confirming");
  assert.equal(text("popup-earned-note-action"), "Check again");
  assert.equal(element("popup-earned-note-action").disabled, false);
  assert.equal(await announced(), "Still confirming your story. Trace hasn’t heard back yet. It may already be saved.");

  // Trace has it after all: what a found entry always gets, with the entry's own status.
  await click("popup-earned-note-action");
  h.firstTap.show({
    state: "confirmed", workKey: "ao3:123", provenance: "found", mode: null, story: FIRST_TAP_STORY,
    entry: { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", chapters: null },
  });
  assert.equal(shown(), "in-library");
  assert.equal(text("popup-earned-kicker"), "In your Library");
  assert.equal(text("popup-earned-record"), "someone · AO3Saved");
  assert.equal(await announced(), "In your Library. The Long Way, by someone, on AO3. Saved.");
});

test("first tap: Check again answered by Trace's own word draws not in the Library, an account to reconnect, or still not known", async () => {
  const { h, shown, click, sheet } = await openFirstTapPopup();
  h.firstTap.show({ state: "failed", workKey: "ao3:123", reason: "unavailable", dispatch: "sent_unconfirmed", story: FIRST_TAP_STORY });
  await click("popup-earned-primary");
  h.firstTap.show({ state: "presence_unknown", workKey: "ao3:123" });
  assert.equal(shown(), "still-unknown", "a request that could not be made or read is never drawn as absent");
  assert.doesNotMatch(`${sheet().heading} ${sheet().body}`, /added nothing|wasn.t sent|isn.t in/i);

  await click("popup-earned-primary");
  h.firstTap.show({ state: "account_reconnect_required", workKey: "ao3:123" });
  assert.equal(shown(), "account-reconnect");
  assert.equal(sheet().heading, "Open the Trace app to reconnect");

  h.firstTap.show({ state: "presence_unknown", workKey: "ao3:123" });
  await click("popup-earned-primary");
  h.firstTap.show({ state: "failed", workKey: "ao3:123", reason: "unavailable", dispatch: "not_in_library", story: FIRST_TAP_STORY });
  assert.deepEqual(sheet(), {
    state: "save-not-sent", kicker: null, heading: "The save wasn’t sent",
    body: "This tap added nothing to your Library.", record: null, second: null, rule: null,
    primary: "Try again", secondary: "Not now",
  });
  assert.deepEqual(h.firstTap.commands, ["open", "check", "check", "check"], "one request for each tap, and no save among them");
});

// --- Automatic saving, turned on from the sheet -----------------------------------------

test("first tap: Turn automatic saving on is one change and one request however often it is tapped, and it saves the story the reader is on", async () => {
  const opened = await openFirstTapPopup({ storageState: { prefAutoTrackEnabled: false } });
  const { h, element, text, shown, click } = opened;
  const settle = async () => { for (let attempt = 0; attempt < 6; attempt += 1) await flush(); };
  h.firstTap.show({ state: "awaiting_request", workKey: "ao3:123", preference: "off" });
  await click("popup-earned-secondary");
  assert.equal(text("popup-earned-secondary"), "Turn automatic saving on", "the button waits under its own name");
  assert.equal(element("popup-earned-secondary").disabled, true);
  assert.equal(text("popup-earned-primary"), "Save this story");
  // Tapped again before anything has come back.
  await tapRegardless(opened, "popup-earned-secondary", "first_tap_automatic_saving_on");
  await settle();
  assert.equal(h.store.prefAutoTrackEnabled, true);
  assert.equal(h.document.getElementById("pref-auto-track").checked, true);
  assert.deepEqual(h.firstTap.commands, ["open", "open"], "one open: the background then saves this story, once");

  h.firstTap.show({ state: "saving", workKey: "ao3:123", startedAt: 5, story: null });
  assert.equal(shown(), "saving");

  // From the allowed state it is the same: one read of what holds.
  const granted = await openSavedFirstTapPopup({ grantedOrigins: [...FIVE_STORY_SITES], storageState: { prefAutoTrackEnabled: false } });
  granted.h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "off", handOver: "in_place" });
  const before = granted.h.firstTap.commands.length;
  await granted.click("popup-earned-primary");
  assert.equal(granted.element("popup-earned-primary").disabled, true);
  await tapRegardless(granted, "popup-earned-primary", "first_tap_automatic_saving_on");
  for (let attempt = 0; attempt < 6; attempt += 1) await flush();
  assert.deepEqual(granted.h.firstTap.commands.slice(before), ["access_check"]);
});

test("first tap: a preference that could not be stored leaves the settings control as it was, sends nothing and claims nothing", async () => {
  for (const view of [
    { state: "awaiting_request", workKey: "ao3:123", preference: "off" },
    null,
  ]) {
    const opened = await openSavedFirstTapPopup({
      grantedOrigins: view ? [] : [...FIVE_STORY_SITES],
      storageState: { prefAutoTrackEnabled: false },
      storageWritesFail: (patch) => "prefAutoTrackEnabled" in patch,
    });
    const { h, element, click, announced, sheet } = opened;
    if (view) h.firstTap.show(view);
    else h.firstTap.showAccess({ state: "allowed", account: "connected", automaticSaving: "off", handOver: "in_place" });
    const button = view ? "popup-earned-secondary" : "popup-earned-primary";
    const control = h.document.getElementById("pref-auto-track");
    control.checked = false;
    const drawn = sheet();
    const said = await announced();
    const before = h.firstTap.commands.length;

    await click(button);
    for (let attempt = 0; attempt < 6; attempt += 1) await flush();
    assert.equal(h.store.prefAutoTrackEnabled, false, "nothing was stored");
    assert.equal(control.checked, false, "and the control shows what is stored, not what was asked for");
    assert.deepEqual(h.firstTap.commands.slice(before), [], "the background is asked nothing");
    assert.deepEqual(sheet(), drawn, "the sheet is as it was, in the words it already had");
    assert.equal(element(button).disabled, false, "with its button back");
    assert.equal(element(button).dataset.earnedAction, "first_tap_automatic_saving_on");
    assert.equal(await announced(), said, "and what it says is said again");
  }
});

// --- Coming back to the ask ---------------------------------------------------------------

test("first tap: after Try again on the not-allowed state, focus is on the ask's headline, not on the button that became Not now", async () => {
  const { h, element, text, shown, click } = await openSavedFirstTapPopup();
  h.firstTap.showAccess({ state: "not_allowed", automaticSaving: "on" });
  const tapped = element("popup-earned-secondary");
  tapped.focus();
  assert.equal(h.document.activeElement, tapped);
  assert.equal(text("popup-earned-secondary"), "Try again");

  await click("popup-earned-secondary");
  assert.equal(shown(), "saved");
  assert.equal(text("popup-earned-secondary"), "Not now", "the same button now closes the sheet");
  assert.equal(tapped.dataset.earnedAction, "close");
  const heading = element("popup-earned-ask-heading");
  assert.equal(h.document.activeElement, heading);
  assert.equal(heading.textContent, "Let Trace save the next one by itself");
  assert.equal(heading.getAttribute("tabindex"), "-1", "it takes focus without joining the tab order");
  assert.equal(h.closeCalled, false);
});

// --- A sheet too short for the state ---------------------------------------------------------

/**
 * Gives the sheet a layout: the height of the sheet, how far down its content
 * ends, and the heights of the pinned area's parts.
 */
function layOutFirstTapSheet(opened, { sheetHeight, contentEnds, ruleAndButton = 92, second = 44, between = 2 }) {
  const { h, element } = opened;
  const scroll = h.document.querySelector(".popup-earned-scroll");
  const pin = element("popup-earned-pin");
  const primary = element("popup-earned-primary");
  const secondary = element("popup-earned-secondary");
  const home = pin.querySelector(".popup-earned-actions");
  const give = (node, name, read) => Object.defineProperty(node, name, { get: read, configurable: true });
  const secondShown = () => !secondary.hidden && secondary.parentNode === home;
  h.window.innerHeight = sheetHeight;
  give(scroll, "offsetTop", () => 0);
  for (const child of scroll.children) {
    give(child, "offsetTop", () => 0);
    give(child, "offsetHeight", () => child.id === "popup-earned-scroll-actions" ? second : contentEnds);
  }
  give(primary, "offsetTop", () => 30);
  give(primary, "offsetHeight", () => 48);
  give(secondary, "offsetTop", () => 78 + between);
  give(secondary, "offsetHeight", () => second);
  const pinHeight = () => ruleAndButton + (secondShown() ? between + second : 0);
  give(pin, "offsetHeight", pinHeight);
  pin.getBoundingClientRect = () => ({ height: pinHeight(), top: 0, bottom: pinHeight() });
  h.window.dispatchEvent(new h.window.Event("resize"));
  return { scroll, pin, primary, secondary, home, section: element("popup-earned-permission") };
}

test("first tap: on a sheet too short for the ask, the rule line and the button stay pinned and Not now scrolls with the content", async () => {
  const opened = await openSavedFirstTapPopup();
  const { h, element } = opened;
  // The ask on a sheet 283 high, with content that ends below that.
  const { scroll, pin, primary, secondary, home, section } = layOutFirstTapSheet(opened, { sheetHeight: 283, contentEnds: 240 });
  assert.equal(section.classList.contains("popup-earned-fixed-pin"), true, "the action area is pinned");
  assert.equal(section.classList.contains("popup-earned-ax"), false);
  assert.equal(section.style.getPropertyValue("--trace-pin-height"), "92px", "and the content is given room to scroll clear of it");
  assert.equal(secondary.parentNode.id, "popup-earned-scroll-actions");
  assert.equal(secondary.parentNode.parentNode, scroll, "Not now joins what scrolls");
  assert.equal(secondary.parentNode.hidden, false);
  assert.deepEqual([...pin.querySelectorAll("p, button")].filter((node) => !node.hidden).map((node) => node.id),
    ["popup-earned-rule", "popup-earned-primary"], "only the rule line and the main button are pinned");
  assert.equal(element("popup-earned-rule").nextElementSibling.contains(primary), true, "the rule line is the last thing above the button");
  const order = ["popup-earned-ask", "popup-earned-secondary", "popup-earned-rule", "popup-earned-primary"].map((id) => element(id));
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index - 1].compareDocumentPosition(order[index]) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, order[index].id);
  }

  // Laid out again, it is the same: the button does not go back and forth.
  secondary.focus();
  for (let pass = 0; pass < 3; pass += 1) h.window.dispatchEvent(new h.window.Event("resize"));
  assert.equal(secondary.parentNode.id, "popup-earned-scroll-actions");
  assert.equal(h.document.activeElement, secondary, "and focus stays on a button that was moved");
  h.firstTap.show(FIRST_TAP_CONFIRMED);
  assert.equal(secondary.parentNode.id, "popup-earned-scroll-actions", "a redraw of the state leaves it there");
  assert.equal(section.classList.contains("popup-earned-fixed-pin"), true);

  // A sheet tall enough for all of it has both buttons together again.
  layOutFirstTapSheet(opened, { sheetHeight: 700, contentEnds: 240 });
  assert.equal(secondary.parentNode, home);
  assert.equal(primary.nextElementSibling, secondary);
  assert.equal(element("popup-earned-scroll-actions").hidden, true);
  assert.equal(section.classList.contains("popup-earned-fixed-pin"), false);

  // Short again, then the first-tap sheet stands aside: the popup that takes over has its buttons where they were.
  layOutFirstTapSheet(opened, { sheetHeight: 283, contentEnds: 240 });
  assert.equal(secondary.parentNode.id, "popup-earned-scroll-actions");
  h.firstTap.show({ state: "automatic" });
  for (let attempt = 0; attempt < 8; attempt += 1) await flush();
  assert.equal(secondary.parentNode, home);
});

test("first tap: on a short sheet at the largest text sizes, or where the button alone would take most of it, nothing is pinned", async () => {
  const large = await openSavedFirstTapPopup();
  large.h.document.body.style.fontSize = "53px";
  const atLargest = layOutFirstTapSheet(large, { sheetHeight: 283, contentEnds: 900, ruleAndButton: 330, second: 120 });
  assert.equal(atLargest.secondary.parentNode, atLargest.home);
  assert.equal(atLargest.section.classList.contains("popup-earned-ax"), true);
  assert.equal(atLargest.section.classList.contains("popup-earned-fixed-pin"), false);

  const tall = await openSavedFirstTapPopup();
  const tooTall = layOutFirstTapSheet(tall, { sheetHeight: 283, contentEnds: 320, ruleAndButton: 180 });
  assert.equal(tooTall.secondary.parentNode, tooTall.home, "everything flows in reading order instead");
  assert.equal(tooTall.section.classList.contains("popup-earned-ax"), true);
  assert.equal(tooTall.section.classList.contains("popup-earned-fixed-pin"), false);

  // A state with one button and room for it is left exactly as it was.
  const fits = await openSavedFirstTapPopup();
  const roomy = layOutFirstTapSheet(fits, { sheetHeight: 386, contentEnds: 190 });
  assert.equal(roomy.secondary.parentNode, roomy.home);
  assert.equal(roomy.section.classList.contains("popup-earned-fixed-pin"), false);
});

test("first tap: with the switch off, a short sheet is laid out as it always was and none of the sheet's own markup is made", async () => {
  const h = createPopupHarness({
    sessionMode: "kernel", promiseRuntime: true, earnedPermissionOnboarding: true,
    sessionSnapshot: { state: "connected", accountId: "account-a", canExecuteAuthenticated: true, reason: "none" },
  });
  for (let attempt = 0; attempt < 10; attempt += 1) await flush();
  const element = (id) => h.document.getElementById(id);
  const laid = layOutFirstTapSheet({ h, element }, { sheetHeight: 283, contentEnds: 240 });
  assert.equal(laid.secondary.parentNode, laid.home);
  assert.equal(element("popup-earned-scroll-actions"), null);
  assert.equal(element("popup-earned-note"), null);
  assert.equal(element("popup-earned-ask"), null);
  assert.equal(laid.section.classList.contains("popup-earned-ax"), true, "a pinned area over thirty percent of the sheet is not pinned, as before");
  assert.equal(laid.section.classList.contains("popup-earned-fixed-pin"), false);
  assert.deepEqual(h.firstTap.commands, []);
});

test("first tap: the sheet's styles pin the action area on a short sheet and mark where the content passes under it", () => {
  const css = fs.readFileSync(POPUP_CSS_PATH, "utf8");
  assert.match(css, /\.popup-earned-fixed-pin \.popup-earned-pin \{ position: fixed; left: 0; right: 0; bottom: 0;/);
  assert.match(css, /\.popup-earned-fixed-pin \.popup-earned-scroll \{[^}]*padding-bottom: calc\(8px \+ var\(--trace-pin-height, 0px\)\);/);
  assert.match(css, /body\[data-trace-first-tap-state\] \.popup-earned-fixed-pin \.popup-earned-pin \{ border-top: 1px solid var\(--rule\); \}/);
  assert.match(css, /\.popup-earned-scroll > \.popup-earned-actions \{ margin-top: 8px; \}/);
  assert.match(css, /\.popup-earned-ax \.popup-earned-pin \{ position: static;/, "and at the largest sizes it is not pinned at all");
  // The news of a save still out has a button big enough to tap, and its own disabled look.
  assert.match(css, /\.popup-earned-note button \{[^}]*min-height: 44px;/);
  assert.match(css, /\.popup-earned-note button:disabled \{ opacity: 0\.55;/);
});
