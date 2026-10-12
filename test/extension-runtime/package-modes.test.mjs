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
