import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

import {
  AO3_HOST_MATCHES,
  MINIMIZED_SITE_HOST_MATCHES,
  SITE_HOST_MATCHES,
} from "../../scripts/build-origin-permissions.mjs";

const ROOT = process.cwd();
const RESOURCES = path.join(ROOT, "Shared (Extension)", "Resources");
const RELEASE_ENV = {
  ...process.env,
  TRACE_API_BASE: "https://api.tracefiction.com",
  TRACE_WEB_ORIGIN: "https://www.tracefiction.com",
};

/**
 * The background wiring of the first-tap save and of the ask and hand-over
 * that follow it. A package built with the switch off has none of it.
 */
const FIRST_TAP_WIRING = [
  "firstTapSave: true",
  "trace-first-tap-popup-v1",
  "TRACE_FIRST_TAP_COLLECT",
  "TRACE_FIRST_TAP_MARK",
  "TRACE_PAGE_MANUAL_MODE_END",
  "TRACE_PAGE_MANUAL_MODE_QUERY",
  "access_asking",
  "access_answered",
  "access_check",
  "access_waiting",
  "access_unanswered",
  "could_not_ask",
  "HAND_OVER_BY_RELOADING_THE_PAGE",
  "traceFirstTapSaveV2",
];

function assertNoFirstTapWiring(root, what) {
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  for (const wiring of FIRST_TAP_WIRING) {
    assert.equal(background.includes(wiring), false, `${what}: background.js carries ${wiring}`);
  }
  assert.equal(fs.existsSync(path.join(root, "page-manual-mode.js")), false, `${what}: carries the manual-mode page file`);
  const config = fs.readFileSync(path.join(root, "popup-config.js"), "utf8");
  assert.equal(config.includes("firstTapSave"), false, `${what}: popup config turns the first-tap save on`);
}

function runBuild(script) {
  const result = spawnSync("npm", ["run", script], {
    cwd: ROOT,
    env: RELEASE_ENV,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function manifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
}

// Apple refuses a Safari extension whose description is over 112 characters
// or whose name is over 40. Chrome documents 132 and 75; the Firefox package
// is held to Chrome's figures, which are the tighter.
function assertStoreText() {
  for (const [root, descriptionLimit, nameLimit] of [
    [RESOURCES, 112, 40],
    [path.join(ROOT, "dist", "chrome"), 132, 75],
    [path.join(ROOT, "dist", "firefox"), 132, 75],
  ]) {
    const { description, name } = manifest(root);
    assert.equal(typeof description, "string");
    assert.ok(
      description.length > 0 && description.length <= descriptionLimit,
      `${root} description is ${description.length} characters; the limit is ${descriptionLimit}`,
    );
    assert.ok(name.length > 0 && name.length <= nameLimit, `${root} name is ${name.length} characters`);
  }
  const messages = JSON.parse(
    fs.readFileSync(path.join(RESOURCES, "_locales", "en", "messages.json"), "utf8"),
  );
  assert.equal(manifest(RESOURCES).description, messages.extension_description.message);
}

function hasSavedFilterScript(value) {
  return value.content_scripts.some((entry) => entry.js?.includes("ao3-saved-filters.js"));
}

function assertCollectorModeConfig(root, expectedMode) {
  const value = manifest(root);
  const popupConfig = fs.readFileSync(path.join(root, "popup-config.js"), "utf8");
  const contentConfig = fs.readFileSync(path.join(root, "content-config.js"), "utf8");
  if (expectedMode === "disabled") {
    assert.deepEqual(
      value.content_scripts,
      [],
      "disabled packages must not inject extension code into archive or Trace pages",
    );
    assert.match(popupConfig, /TRACE_SESSION_MODE = "disabled"/);
    assert.match(contentConfig, /TRACE_SESSION_MODE = "disabled"/);
    return;
  }
  const collectorEntries = value.content_scripts.filter((entry) => entry.js?.includes("collector.js"));
  assert.ok(collectorEntries.length > 0, "expected an archive collector content-script entry");
  for (const entry of collectorEntries) {
    assert.ok(entry.js.indexOf("content-config.js") < entry.js.indexOf("collector.js"));
  }
  assert.doesNotMatch(contentConfig, /TRACE_IOS_ACTIVE_TAB_PROBE/);
  assert.doesNotMatch(contentConfig, /TRACE_IOS_EARNED_PERMISSION_ONBOARDING/);
  if (expectedMode === "legacy") {
    assert.doesNotMatch(contentConfig, /TRACE_SESSION_MODE/);
  } else {
    assert.match(contentConfig, new RegExp(`TRACE_SESSION_MODE = "${expectedMode}"`));
  }
}

function assertSurfacePrivateBoundary(root) {
  for (const name of ["popup.js", "collector.js", "library-overlay.js", "sync.js"]) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    for (const marker of [
      "indexedDB",
      "private-database",
      "traceKernelPrivateV1",
      "session-envelope",
      "session-credentials",
      "account-data",
    ]) {
      assert.doesNotMatch(source, new RegExp(marker), `${name} contains ${marker}`);
    }
  }
}

async function assertArchiveReceiptSurvivesStorageFailure(bundle) {
  const listeners = [];
  const installedListeners = [];
  const nativeMessages = [];
  const createdTabs = [];
  const context = {
    URL,
    Date,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "package-proof-id" },
    browser: {
      runtime: {
        onInstalled: {
          addListener(listener) {
            installedListeners.push(listener);
          },
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        async getPlatformInfo() {
          return { os: "mac" };
        },
        async sendNativeMessage(message) {
          nativeMessages.push(message);
          return { ok: true };
        },
      },
      alarms: { async clear() { return true; } },
      storage: { local: {} },
      tabs: {
        async query() { return []; },
        async create(options) {
          createdTabs.push(options);
          return { id: 4, url: options.url };
        },
        async sendMessage() { return null; },
      },
    },
  };
  vm.runInNewContext(bundle, context);
  assert.equal(context.__traceSessionRuntimeBootFailed, true);
  assert.equal(listeners.length, 1);
  assert.equal(installedListeners.length, 2);

  for (const listener of installedListeners) listener({ reason: "install" });
  for (let attempt = 0; attempt < 8; attempt += 1) await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(createdTabs)), [{
    url: "https://www.tracefiction.com/?activation=extension-installed",
    active: true,
  }]);

  const response = await new Promise((resolve) => {
    const keepsWorkerAlive = listeners[0](
      { type: "TRACE_ARCHIVE_SEEN", handoffId: "package_handoff" },
      {
        tab: { url: "https://archiveofourown.org/works/123" },
        frameId: 0,
        documentLifecycle: "active",
      },
      resolve,
    );
    assert.equal(keepsWorkerAlive, true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.receipt, "published");
  assert.equal(nativeMessages.length, 1);
  assert.equal(nativeMessages[0].type, "TRACE_IOS_EXTENSION_HEARTBEAT");
  assert.equal(nativeMessages[0].hostKind, "ao3");
  assert.equal(nativeMessages[0].handoffId, "package_handoff");
  assert.equal(Object.hasOwn(nativeMessages[0], "permissionSnapshot"), false);
}

// Runs the built iPhone background as Safari would: no story site allowed at
// first, one story tab and one unrelated tab open, then the reader allows the
// five sites in Safari's settings while the background is awake.
async function assertIphoneBundleFollowsTheGrant(bundle, builtManifest) {
  let allowed = false;
  let registrations = [];
  const queries = [];
  const injected = [];
  const created = [];
  const added = [];
  const stored = {};
  const event = (listeners = []) => ({ listeners, addListener(listener) { listeners.push(listener); } });
  const context = {
    URL, Date, Promise, console, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "package-proof-id" },
    browser: {
      runtime: {
        id: "trace-iphone-proof",
        onInstalled: event(), onStartup: event(), onMessage: event(),
        getManifest: () => builtManifest,
        getURL: (resource) => `safari-web-extension://trace-iphone-proof/${resource}`,
        // An iPad can report itself as a Mac.
        async getPlatformInfo() { return { os: "mac" }; },
      },
      alarms: { async clear() { return true; }, async create() {}, async get() {}, onAlarm: event() },
      storage: { local: {
        async get(key) { return Object.hasOwn(stored, key) ? { [key]: stored[key] } : {}; },
        async set(patch) { Object.assign(stored, patch); },
        async remove(key) { delete stored[key]; },
      } },
      permissions: {
        async contains() { return allowed; },
        async getAll() { return { origins: allowed ? [...builtManifest.optional_host_permissions] : [] }; },
        request() { assert.fail("the background never asks for website access"); },
        onAdded: event(added), onRemoved: event(),
      },
      scripting: {
        async getRegisteredContentScripts() { return registrations; },
        async registerContentScripts(next) { registrations = [...registrations, ...next]; },
        async unregisterContentScripts() { registrations = []; },
        async executeScript(injection) { injected.push(injection); },
      },
      tabs: {
        async query(filter) {
          queries.push(filter);
          return [{ id: 11, url: "https://archiveofourown.org/works/123" }];
        },
        async create(options) { created.push(options); return { id: 12, url: options.url }; },
        async sendMessage() { return null; },
      },
    },
  };
  const turns = async () => { for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
  vm.runInNewContext(bundle, context);
  for (const listener of context.browser.runtime.onInstalled.listeners) listener({ reason: "install" });
  await turns();
  assert.deepEqual(queries, [], "with no story site allowed the background asks for no tab at all");
  assert.deepEqual(injected, []);
  assert.deepEqual(registrations, []);
  assert.deepEqual(created, [], "it opens no page of its own");

  allowed = true;
  for (const listener of added) listener({ origins: builtManifest.optional_host_permissions });
  await turns();
  assert.deepEqual(registrations.map(({ id }) => id), ["trace-archive-automation-v1", "trace-ao3-saved-filters-v1"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(queries)),
    [{ url: builtManifest.optional_host_permissions }],
    "then it asks only for story-site tabs, by address",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(injected)), [{
    target: { tabId: 11, frameIds: [0] },
    files: [
      "content-config.js",
      "trace-finish-qualify.js",
      "collector.js",
      "library-overlay-keys.js",
      "library-overlay.js",
      "ao3-saved-filters.js",
    ],
  }], "and the story tab that was already open gets the registered scripts");
}

/**
 * The built iPhone background, beside a Trace app: opening the popup makes it
 * ask the app's side which provider and cycle there are, and answer with one
 * report. It looks up no tab, runs nothing on a page and asks Safari nothing.
 */
async function assertIphoneBundleReportsReadiness(bundle, builtManifest) {
  const native = [];
  const stored = {};
  let registrations = [];
  const event = (listeners = []) => ({ listeners, addListener(listener) { listeners.push(listener); } });
  const provider = { sessionID: "8a0ead75-6a99-4380-a175-bb97331f48e7", recordDigest: "a".repeat(64) };
  const context = {
    URL, Date, Promise, console, setTimeout, clearTimeout,
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" },
    crypto: { randomUUID: () => "package-proof-id" },
    browser: {
      runtime: {
        id: "trace-iphone-proof",
        onInstalled: event(), onStartup: event(), onMessage: event(),
        getManifest: () => builtManifest,
        getURL: (resource) => `safari-web-extension://trace-iphone-proof/${resource}`,
        async getPlatformInfo() { return { os: "ios" }; },
        async sendNativeMessage(...args) {
          const message = args.find((value) => value && typeof value === "object");
          native.push(JSON.parse(JSON.stringify(message)));
          if (message.type === "TRACE_IOS_SAFARI_READINESS_PREPARE") {
            return { ok: true, provider, cycle: { id: "0b7c5a52-7c1d-4a52-9b43-1d6f8f0a2c11", accountID: "account-a" } };
          }
          return { ok: true };
        },
      },
      alarms: { async clear() { return true; }, async create() {}, async get() {}, onAlarm: event() },
      storage: { local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]));
        },
        async set(patch) { Object.assign(stored, patch); },
        async remove(key) { delete stored[key]; },
      } },
      permissions: {
        async contains() { return true; },
        async getAll() { return { origins: [...builtManifest.optional_host_permissions] }; },
        request() { assert.fail("the background never asks for website access"); },
        onAdded: event(), onRemoved: event(),
      },
      scripting: {
        async getRegisteredContentScripts() { return registrations; },
        async registerContentScripts(next) { registrations = [...registrations, ...next]; },
        async unregisterContentScripts() { registrations = []; },
        async executeScript() {},
      },
      tabs: {
        async query() { return []; },
        async create() { assert.fail("it opens no page of its own"); },
        async sendMessage() { return null; },
      },
    },
  };
  const turns = async () => { for (let turn = 0; turn < 60; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
  vm.runInNewContext(bundle, context);
  await turns();
  const reports = () => native.filter(({ type }) => type === "TRACE_IOS_SAFARI_READINESS_REPORT");
  assert.equal(reports().length, 1, "this background's start registered the page scripts, which is reported, once");
  const sent = native.length;
  const popup = { id: "trace-iphone-proof", url: "safari-web-extension://trace-iphone-proof/popup.html" };
  for (const listener of context.browser.runtime.onMessage.listeners) {
    listener({ type: "TRACE_ARCHIVE_ACCESS_REPORT" }, popup, () => {});
  }
  await turns();
  const since = native.slice(sent).map(({ type }) => type);
  assert.equal(since.includes("TRACE_IOS_SAFARI_READINESS_PREPARE"), true, "the popup opening asks which provider and cycle");
  const report = reports().at(-1);
  assert.ok(report, "and one report follows");
  assert.equal(report.version, 1);
  assert.deepEqual(report.provider, provider);
  assert.equal(report.cycleID, "0b7c5a52-7c1d-4a52-9b43-1d6f8f0a2c11");
  assert.equal(report.components.websiteAccess.reason, "allowed");
  assert.equal(report.components.scriptRegistration.reason, "registered");
  assert.equal(report.components.automaticSaving.answer !== "blocker", true);
  // This stand-in has no private database, so no account can be confirmed.
  assert.equal(report.components.account.answer, "unknown");
  assert.equal(report.result, "unknown", "one part not known and none a blocker");
  assert.equal(Object.hasOwn(report, "accountID"), false);
}

test("legacy, kernel, and disabled packages have one deterministic classic owner", async () => {
  try {
    runBuild("build:legacy:release");
    const legacyChrome = path.join(ROOT, "dist", "chrome");
    assert.deepEqual(manifest(legacyChrome).background, { service_worker: "background.js" });
    assert.equal(hasSavedFilterScript(manifest(legacyChrome)), true);
    assertCollectorModeConfig(legacyChrome, "legacy");
    const source = fs.readFileSync(path.join(ROOT, "src", "background.js"), "utf8")
      .replaceAll("__TRACE_API_BASE__", "https://api.tracefiction.com")
      .replaceAll("__TRACE_WEB_ORIGIN__", "https://www.tracefiction.com");
    assert.equal(fs.readFileSync(path.join(RESOURCES, "background.js"), "utf8"), source);

    for (const [script, mode] of [
      ["build:kernel:release", "kernel"],
      ["build:disabled:release", "disabled"],
    ]) {
      runBuild(script);
      const chromeRoot = path.join(ROOT, "dist", "chrome");
      const firefoxRoot = path.join(ROOT, "dist", "firefox");
      const chromeManifest = manifest(chromeRoot);
      const firefoxManifest = manifest(firefoxRoot);
      assert.deepEqual(chromeManifest.background, { service_worker: "background.js" });
      assert.equal(Object.hasOwn(chromeManifest.background, "type"), false);
      assert.deepEqual(firefoxManifest.background, { scripts: ["background.js"] });
      assert.equal(hasSavedFilterScript(chromeManifest), mode === "kernel");
      assert.equal(hasSavedFilterScript(firefoxManifest), mode === "kernel");
      assertCollectorModeConfig(chromeRoot, mode);
      assertCollectorModeConfig(firefoxRoot, mode);
      assertSurfacePrivateBoundary(chromeRoot);
      assertSurfacePrivateBoundary(firefoxRoot);
      const bundle = fs.readFileSync(path.join(chromeRoot, "background.js"), "utf8");
      assert.doesNotMatch(bundle, /Generated legacy runtime gate/);
      assert.doesNotMatch(bundle, /TRACE_SESSION_MODE === "legacy"/);
      assert.match(bundle, new RegExp(`TRACE_SESSION_MODE = "${mode}"`));
      assert.match(bundle, /traceSessionEnvelopeV1/);
      assert.match(bundle, /traceSessionCredentialsV1/);
      assert.match(bundle, /traceKernelPrivateV1/);
      assert.match(bundle, /indexedDB/);
      if (mode === "kernel") {
        await assertArchiveReceiptSurvivesStorageFailure(bundle);
      }
      assert.equal(fs.existsSync(path.join(chromeRoot, "extension-session-runtime.js")), false);
      assert.equal(fs.existsSync(path.join(chromeRoot, "legacy-background.js")), false);
    }

    runBuild("build:release");
    assertCollectorModeConfig(path.join(ROOT, "dist", "chrome"), "kernel");
    assertCollectorModeConfig(path.join(ROOT, "dist", "firefox"), "kernel");
    assertNoFirstTapWiring(RESOURCES, "Mac Safari");
    assertNoFirstTapWiring(path.join(ROOT, "dist", "chrome"), "Chrome");
    assertNoFirstTapWiring(path.join(ROOT, "dist", "firefox"), "Firefox");
    // The readiness report is for the Trace app on iPhone and iPad. A build
    // with no story-site grant to report on carries none of its working code.
    for (const root of [RESOURCES, path.join(ROOT, "dist", "chrome"), path.join(ROOT, "dist", "firefox")]) {
      const desktopBackground = fs.readFileSync(path.join(root, "background.js"), "utf8");
      assert.doesNotMatch(desktopBackground, /function installSafariReadinessReport\b/);
      assert.doesNotMatch(desktopBackground, /class SafariReadinessService\b/);
      assert.doesNotMatch(desktopBackground, /traceSafariReadinessSessionV1/);
    }
    // Mac Safari, Chrome and Firefox keep required story sites, `tabs` and
    // manifest-declared page scripts. Only the iPhone build below differs.
    assertStoreText();
    const desktopSafariManifest = manifest(RESOURCES);
    assert.deepEqual(desktopSafariManifest.permissions, [
      "alarms",
      "tabs",
      "storage",
      "scripting",
      "nativeMessaging",
    ]);
    assert.deepEqual(
      desktopSafariManifest.host_permissions,
      [...SITE_HOST_MATCHES, "https://www.tracefiction.com/*"],
    );
    assert.equal(Object.hasOwn(desktopSafariManifest, "optional_host_permissions"), false);
    assert.equal(desktopSafariManifest.content_scripts.length, 3);
    for (const browser of ["chrome", "firefox"]) {
      const packaged = manifest(path.join(ROOT, "dist", browser));
      assert.deepEqual(packaged.permissions, ["alarms", "tabs", "storage", "scripting"]);
      assert.deepEqual(packaged.host_permissions, [
        ...SITE_HOST_MATCHES,
        "https://api.tracefiction.com/*",
        "https://www.tracefiction.com/*",
      ]);
      assert.equal(Object.hasOwn(packaged, "optional_host_permissions"), false);
      assert.equal(packaged.content_scripts.length, 3);
    }

    runBuild("build");
    assertCollectorModeConfig(path.join(ROOT, "dist", "chrome"), "kernel");
    assertCollectorModeConfig(path.join(ROOT, "dist", "firefox"), "kernel");

    runBuild("build:ios-active-tab-probe:release");
    const safariManifest = manifest(RESOURCES);
    const safariConfig = fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8");
    assert.deepEqual(safariManifest.permissions, [
      "alarms",
      "storage",
      "nativeMessaging",
      "activeTab",
      "scripting",
    ]);
    assert.deepEqual(safariManifest.host_permissions, []);
    assert.equal(Object.hasOwn(safariManifest, "optional_host_permissions"), false);
    assert.deepEqual(safariManifest.content_scripts, []);
    assert.match(safariConfig, /TRACE_IOS_ACTIVE_TAB_PROBE = true/);

    runBuild("build:ios-active-tab-optional-hosts-probe:release");
    const optionalSafariManifest = manifest(RESOURCES);
    const optionalSafariConfig = fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8");
    assert.deepEqual(optionalSafariManifest.permissions, [
      "alarms",
      "storage",
      "nativeMessaging",
      "activeTab",
      "scripting",
    ]);
    assert.deepEqual(optionalSafariManifest.host_permissions, []);
    assert.deepEqual(
      optionalSafariManifest.optional_host_permissions,
      MINIMIZED_SITE_HOST_MATCHES,
    );
    assert.deepEqual(optionalSafariManifest.content_scripts, []);
    assert.match(optionalSafariConfig, /TRACE_IOS_ACTIVE_TAB_PROBE = true/);

    // The earlier iPhone shape stays buildable, unchanged to the byte.
    runBuild("build:ios-earned-permission-onboarding:required-hosts:release");
    assertStoreText();
    assertNoFirstTapWiring(RESOURCES, "the required-hosts iPhone build");
    const earnedSafariManifest = manifest(RESOURCES);
    const earnedSafariConfig = fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8");
    assert.deepEqual(earnedSafariManifest.permissions, [
      "alarms",
      "tabs",
      "storage",
      "scripting",
      "nativeMessaging",
    ]);
    const earnedPermissionSurface = {
      permissions: earnedSafariManifest.permissions.filter(permission => permission !== "scripting"),
      host_permissions: earnedSafariManifest.host_permissions,
      content_scripts: earnedSafariManifest.content_scripts,
    };
    assert.equal(
      crypto
        .createHash("sha256")
        .update(JSON.stringify(earnedPermissionSurface))
        .digest("hex"),
      "09aa341fbcaf4a92b430bc4faf4a04ae5635b7d458219ec24f6aebf53daf5d83",
      "recovery adds only scripting; existing host access and static scripts stay unchanged",
    );
    assert.deepEqual(
      earnedSafariManifest.host_permissions,
      [...SITE_HOST_MATCHES, "https://www.tracefiction.com/*"],
    );
    assert.equal(
      Object.hasOwn(earnedSafariManifest, "optional_host_permissions"),
      false,
    );
    assert.equal(earnedSafariManifest.content_scripts.length, 3);
    assert.deepEqual(earnedSafariManifest.content_scripts[0].matches, SITE_HOST_MATCHES);
    assert.deepEqual(earnedSafariManifest.content_scripts[0].js, [
      "popup-config.js",
      "trace-finish-qualify.js",
      "collector.js",
      "library-overlay-keys.js",
      "library-overlay.js",
    ]);
    assert.deepEqual(earnedSafariManifest.content_scripts[1], {
      matches: ["https://www.tracefiction.com/*"],
      js: ["popup-config.js", "sync.js"],
      run_at: "document_idle",
    });
    assert.deepEqual(earnedSafariManifest.content_scripts[2].matches, AO3_HOST_MATCHES);
    assert.deepEqual(earnedSafariManifest.content_scripts[2].js, [
      "ao3-saved-filters.js",
    ]);
    assert.doesNotMatch(earnedSafariConfig, /TRACE_IOS_ACTIVE_TAB_PROBE/);
    assert.match(earnedSafariConfig, /TRACE_IOS_EARNED_PERMISSION_ONBOARDING/);
    assert.match(earnedSafariConfig, /trace-archive-automation-v1/);
    assert.match(earnedSafariConfig, /persistAcrossSessions/);
    assert.match(earnedSafariConfig, /trace-earned-permission-ready/);
    const earnedConfigContext = {};
    vm.runInNewContext(earnedSafariConfig, earnedConfigContext);
    const earnedOnboarding = earnedConfigContext.TRACE_IOS_EARNED_PERMISSION_ONBOARDING;
    assert.equal(earnedOnboarding.version, 3);
    assert.equal(earnedOnboarding.registrationMode, "static");
    const automationRegistration = earnedOnboarding.registrations.find(
      (registration) => registration.id === "trace-archive-automation-v1",
    );
    assert.deepEqual(Array.from(automationRegistration.js), [
      "content-config.js",
      "trace-finish-qualify.js",
      "collector.js",
      "library-overlay-keys.js",
      "library-overlay.js",
    ]);
    const earnedContentConfig = fs.readFileSync(
      path.join(RESOURCES, "content-config.js"),
      "utf8",
    );
    const earnedContentContext = {};
    vm.runInNewContext(earnedContentConfig, earnedContentContext);
    assert.equal(earnedContentContext.TRACE_SESSION_MODE, "kernel");
    assert.equal(earnedContentContext.TRACE_IOS_ACTIVE_TAB_PROBE, undefined);
    assert.equal(
      earnedContentContext.TRACE_IOS_EARNED_PERMISSION_ONBOARDING,
      undefined,
    );
    const requiredHostsPackages = ["chrome", "firefox"].map((browser) =>
      fs.readFileSync(path.join(ROOT, "dist", browser, "manifest.json"), "utf8"));

    // The iPhone and iPad build: nothing is asked before the first tap.
    runBuild("build:ios-earned-permission-onboarding:release");
    assertStoreText();
    const iphoneManifest = manifest(RESOURCES);
    assert.deepEqual(iphoneManifest.permissions, [
      "alarms",
      "storage",
      "nativeMessaging",
      "activeTab",
      "scripting",
    ], "no `tabs`; `activeTab` covers only the tab the reader tapped Trace on");
    assert.deepEqual(iphoneManifest.host_permissions, [], "no story site is required");
    assert.deepEqual(
      iphoneManifest.optional_host_permissions,
      MINIMIZED_SITE_HOST_MATCHES,
      "the five story-site patterns are optional, and Trace's own site is not named",
    );
    assert.equal(
      Object.hasOwn(iphoneManifest, "content_scripts"),
      false,
      "no page script is declared, and the key is absent rather than empty",
    );
    const iphoneContext = {};
    vm.runInNewContext(
      fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8"),
      iphoneContext,
    );
    const iphoneOnboarding = iphoneContext.TRACE_IOS_EARNED_PERMISSION_ONBOARDING;
    assert.equal(iphoneOnboarding.version, 4);
    assert.equal(iphoneOnboarding.registrationMode, "dynamic");
    assert.deepEqual(Array.from(iphoneOnboarding.origins), MINIMIZED_SITE_HOST_MATCHES);
    assert.equal(iphoneOnboarding.registrations.length, 2);
    for (const registration of iphoneOnboarding.registrations) {
      assert.equal(registration.persistAcrossSessions, true);
      assert.equal(registration.runAt, "document_end");
      for (const match of registration.matches) {
        assert.ok(
          MINIMIZED_SITE_HOST_MATCHES.includes(match),
          `${registration.id} runs only where the reader can allow it`,
        );
      }
      assert.ok(registration.excludeMatches.length > 0, "sign-in pages stay excluded");
      for (const file of registration.js) {
        assert.ok(fs.existsSync(path.join(RESOURCES, file)), `${file} ships in the bundle`);
        assert.notEqual(file, "popup-config.js", "registered pages do not load the popup's setup");
        // Nothing of Trace's runs on Trace's own site in this build, so no
        // message from that site, and none of what such a message starts,
        // can reach the background.
        assert.notEqual(file, "sync.js");
      }
    }
    const iphoneBackground = fs.readFileSync(path.join(RESOURCES, "background.js"), "utf8");
    assert.match(iphoneBackground, /registrationMode: "dynamic"/);
    assert.doesNotMatch(iphoneBackground, /registrationMode: "static"/);
    await assertIphoneBundleFollowsTheGrant(iphoneBackground, iphoneManifest);
    await assertIphoneBundleReportsReadiness(iphoneBackground, iphoneManifest);
    // The Chrome and Firefox packages built beside it do not follow it.
    assert.deepEqual(
      ["chrome", "firefox"].map((browser) =>
        fs.readFileSync(path.join(ROOT, "dist", browser, "manifest.json"), "utf8")),
      requiredHostsPackages,
    );
    const misuse = spawnSync("node", ["scripts/build.mjs"], {
      cwd: ROOT,
      env: { ...RELEASE_ENV, TRACE_SESSION_MODE: "kernel", TRACE_IOS_EARNED_PERMISSION_REQUIRED_HOSTS: "1" },
      encoding: "utf8",
    });
    assert.notEqual(misuse.status, 0, "the required-hosts switch belongs to the iPhone build only");

    // The first-tap save is a development switch. With it off, its wiring
    // and its page file are not in the package at all.
    assert.equal(Object.hasOwn(iphoneOnboarding, "firstTapSave"), false);
    assert.doesNotMatch(iphoneBackground, /firstTapSave: true/);
    assert.doesNotMatch(iphoneBackground, /trace-first-tap-popup-v1/);
    assert.doesNotMatch(iphoneBackground, /TRACE_FIRST_TAP_COLLECT/);
    assertNoFirstTapWiring(RESOURCES, "the iPhone store build");
    // The readiness report is live in the iPhone build, switch or no switch.
    assert.match(iphoneBackground, /function installSafariReadinessReport\b/);
    assert.match(iphoneBackground, /TRACE_IOS_SAFARI_READINESS_PREPARE/);
    assert.match(iphoneBackground, /TRACE_IOS_SAFARI_READINESS_REPORT/);
    assert.match(iphoneBackground, /readiness = installSafariReadinessReport\(/);
    assert.equal(fs.existsSync(path.join(RESOURCES, "page-manual-mode.js")), false);
    for (const browser of ["chrome", "firefox"]) {
      assert.equal(fs.existsSync(path.join(ROOT, "dist", browser, "page-manual-mode.js")), false);
    }
    const firstTapBuild = (extra) => {
      const env = {
        ...RELEASE_ENV, TRACE_SESSION_MODE: "kernel",
        TRACE_IOS_EARNED_PERMISSION_ONBOARDING: "1", TRACE_IOS_FIRST_TAP_SAVE: "1", ...extra,
      };
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
      return spawnSync("node", ["scripts/build.mjs"], { cwd: ROOT, env, encoding: "utf8" });
    };
    // No release build can turn it on, whatever else is set.
    for (const extra of [
      { TRACE_BUILD_MODE: "release" },
      { TRACE_BUILD_MODE: "release", TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF: "1" },
      { TRACE_BUILD_MODE: "release", TRACE_IOS_EARNED_PERMISSION_PREVIEW_RELEASE: "1" },
    ]) {
      const refused = firstTapBuild(extra);
      assert.notEqual(refused.status, 0, JSON.stringify(extra));
      assert.match(refused.stderr, /cannot be turned on in a release build/);
    }
    // It exists only in the optional-sites iPhone build.
    for (const extra of [
      { TRACE_IOS_EARNED_PERMISSION_REQUIRED_HOSTS: "1" },
      { TRACE_IOS_EARNED_PERMISSION_ONBOARDING: "0" },
    ]) {
      const elsewhere = firstTapBuild(extra);
      assert.notEqual(elsewhere.status, 0);
      assert.match(elsewhere.stderr, /requires the iPhone build with optional story sites/);
    }
    // A development build that talks to the production service needs the
    // second switch, and that switch is read from the command line only.
    const unproven = firstTapBuild({});
    assert.notEqual(unproven.status, 0);
    assert.match(unproven.stderr, /needs TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF=1 on the command line/);
    const buildSource = fs.readFileSync(path.join(ROOT, "scripts", "build.mjs"), "utf8");
    assert.match(buildSource, /process\.env\.TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF/);
    assert.doesNotMatch(buildSource, /(?<!process\.)env\.TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF/);
    const proofAlone = spawnSync("node", ["scripts/build.mjs"], {
      cwd: ROOT,
      env: { ...RELEASE_ENV, TRACE_SESSION_MODE: "kernel", TRACE_IOS_EARNED_PERMISSION_ONBOARDING: "1", TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF: "1" },
      encoding: "utf8",
    });
    assert.notEqual(proofAlone.status, 0, "the proof switch does nothing by itself");

    // The proof build: the switch on, against the production service.
    runBuild("build:ios-first-tap-proof");
    const proofContext = {};
    vm.runInNewContext(fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8"), proofContext);
    assert.equal(proofContext.TRACE_IOS_EARNED_PERMISSION_ONBOARDING.firstTapSave, true);
    const proofBackground = fs.readFileSync(path.join(RESOURCES, "background.js"), "utf8");
    assert.match(proofBackground, /firstTapSave: true/);
    assert.match(proofBackground, /trace-first-tap-popup-v1/, "the popup's port is wired");
    assert.match(proofBackground, /TRACE_FIRST_TAP_COLLECT/);
    assert.match(proofBackground, /TRACE_PAGE_MANUAL_MODE_END/);
    // The ask and the hand-over are part of the same switch.
    assert.match(proofBackground, /TRACE_PAGE_MANUAL_MODE_QUERY/, "a page in manual mode can ask for itself");
    assert.match(proofBackground, /access_asking/, "the ask is wired");
    assert.match(proofBackground, /HAND_OVER_BY_RELOADING_THE_PAGE = false/, "handing over without a reload");
    assert.doesNotMatch(proofBackground, /tabs, "get", \[tapped/, "and no tab is looked up for a tap");
    assert.match(proofBackground, /"page-manual-mode\.js"/, "and the manual-mode file is what it injects first");
    assert.match(
      fs.readFileSync(path.join(RESOURCES, "page-manual-mode.js"), "utf8"),
      /TRACE_PAGE_MANUAL_MODE = true/,
    );
    assert.equal(manifest(RESOURCES).name, "Trace (first-tap proof)", "the build names itself for what it is");
    assert.equal(iphoneManifest.name, "Trace");
    assert.deepEqual(manifest(RESOURCES).permissions, iphoneManifest.permissions, "turning it on asks Safari for nothing more");
    assert.deepEqual(manifest(RESOURCES).host_permissions, []);
    assert.deepEqual(manifest(RESOURCES).optional_host_permissions, iphoneManifest.optional_host_permissions);
    // A development build with local origins needs no proof switch.
    const local = firstTapBuild({ TRACE_API_BASE: "http://localhost:3001", TRACE_WEB_ORIGIN: "http://localhost:5173" });
    assert.equal(local.status, 0, local.stderr);
    runBuild("build:ios-earned-permission-onboarding:release");
    assert.equal(fs.existsSync(path.join(RESOURCES, "page-manual-mode.js")), false, "a later store build removes the file again");
    assert.equal(manifest(RESOURCES).name, "Trace", "and the name is the shipping one again");
    const previewResult = spawnSync(
      "npm",
      ["run", "build:ios-earned-permission-onboarding:preview-release"],
      { cwd: ROOT, env: process.env, encoding: "utf8" },
    );
    assert.equal(
      previewResult.status,
      0,
      previewResult.stderr || previewResult.stdout,
    );
    const previewOrigin =
      "https://web.development.example.test";
    const previewApiOrigin =
      "https://api.development.example.test";
    assert.match(
      fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8"),
      new RegExp(previewOrigin.replaceAll(".", "\\.")),
    );
    assert.match(
      fs.readFileSync(path.join(RESOURCES, "background.js"), "utf8"),
      new RegExp(previewApiOrigin.replaceAll(".", "\\.")),
    );
    for (const packageRoot of [
      path.join(ROOT, "dist", "chrome"),
      path.join(ROOT, "dist", "firefox"),
    ]) {
      const packaged = manifest(packageRoot);
      const packagedConfig = fs.readFileSync(path.join(packageRoot, "popup-config.js"), "utf8");
      assert.equal(Object.hasOwn(packaged, "optional_host_permissions"), false);
      assert.equal(packaged.permissions.includes("scripting"), true);
      assert.equal(packaged.permissions.includes("activeTab"), false);
      assert.ok(packaged.permissions.includes("tabs"));
      for (const origin of SITE_HOST_MATCHES) {
        assert.ok(packaged.host_permissions.includes(origin));
      }
      assertCollectorModeConfig(packageRoot, "kernel");
      assert.doesNotMatch(packagedConfig, /TRACE_IOS_ACTIVE_TAB_PROBE/);
    }
  } finally {
    runBuild("build:release");
  }
});

test("explicit development JSON pairs output and rejects invalid or production use", () => {
  const temporary = fs.mkdtempSync(path.join(ROOT, ".trace-dev-config-test-"));
  const config = path.join(temporary, "config.json");
  const pair = { apiOrigin: "https://api.synthetic.example.test", webOrigin: "https://web.synthetic.example.test" };
  const previewEnv = { ...RELEASE_ENV, TRACE_BUILD_MODE: "release", TRACE_SESSION_MODE: "kernel",
    TRACE_IOS_EARNED_PERMISSION_ONBOARDING: "1", TRACE_IOS_EARNED_PERMISSION_PREVIEW_RELEASE: "1",
    TRACE_EXTENSION_DEV_CONFIG: config };
  const build = (env = previewEnv) => spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: ROOT, env, encoding: "utf8" });
  try {
    fs.writeFileSync(config, JSON.stringify(pair));
    const result = build();
    assert.equal(result.status, 0, result.stderr);
    const worker = fs.readFileSync(path.join(RESOURCES, "background.js"), "utf8");
    assert(worker.includes(pair.apiOrigin) && worker.includes(pair.webOrigin));
    assert(!worker.includes("https://api.development.example.test"));
    assert(fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8").includes(pair.webOrigin));
    // The iPhone build names no Trace site of its own; the packages built
    // beside it pair their Trace-site script with the same web origin.
    assert.equal(Object.hasOwn(manifest(RESOURCES), "content_scripts"), false);
    assert(!JSON.stringify(manifest(RESOURCES)).includes(pair.webOrigin));
    assert.deepEqual(manifest(path.join(ROOT, "dist/chrome")).content_scripts.find(entry => entry.js.includes("sync.js")).matches, [`${pair.webOrigin}/*`]);
    for (const invalid of [null, [], {}, { ...pair, extra: true }, { apiOrigin: pair.apiOrigin },
      ...[null, 12, "http://api.example.test", "https://localhost", "https://foo.localhost", "https://127.0.0.1",
        "https://[::1]", "https://*.example.test", "https://user:pass@api.example.test", "https://api.example.test/",
        "https://api.example.test/path", "https://api.example.test?q=1", "https://api.example.test#x",
        "https://api.example.test:443", "https://bad..test", " https://api.example.test"].flatMap(value => [
          { ...pair, apiOrigin: value }, { ...pair, webOrigin: value }])]) {
      fs.writeFileSync(config, JSON.stringify(invalid));
      assert.notEqual(build().status, 0, JSON.stringify(invalid));
    }
    fs.writeFileSync(config, "{");
    assert.notEqual(build().status, 0);
    fs.unlinkSync(config);
    assert.notEqual(build().status, 0, "Missing supplied file is not absence");
    fs.writeFileSync(config, JSON.stringify(pair));
    for (const env of [
      { ...RELEASE_ENV, TRACE_BUILD_MODE: "release", TRACE_EXTENSION_DEV_CONFIG: config },
      { ...previewEnv, TRACE_BUILD_MODE: "dev" },
      { ...previewEnv, TRACE_IOS_EARNED_PERMISSION_ONBOARDING: "0" },
    ]) assert.notEqual(build(env).status, 0, "Override requires the explicit preview mode");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    runBuild("build:release");
  }
  for (const root of [RESOURCES, path.join(ROOT, "dist/chrome"), path.join(ROOT, "dist/firefox")]) {
    for (const file of ["background.js", "popup-config.js", "content-config.js", "manifest.json"]) {
      const output = fs.readFileSync(path.join(root, file), "utf8");
      assert(!output.includes("synthetic.example.test") && !output.includes("development.example.test"));
    }
  }
});
