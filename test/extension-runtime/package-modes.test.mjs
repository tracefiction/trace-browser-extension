import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

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

function hasSavedFilterScript(value) {
  return value.content_scripts.some((entry) => entry.js?.includes("ao3-saved-filters.js"));
}

function assertCollectorModeConfig(root, expectedMode) {
  const value = manifest(root);
  const config = fs.readFileSync(path.join(root, "popup-config.js"), "utf8");
  if (expectedMode === "disabled") {
    assert.deepEqual(
      value.content_scripts,
      [],
      "disabled packages must not inject extension code into archive or Trace pages",
    );
    assert.match(config, /TRACE_SESSION_MODE = "disabled"/);
    return;
  }
  const collectorEntries = value.content_scripts.filter((entry) => entry.js?.includes("collector.js"));
  assert.ok(collectorEntries.length > 0, "expected an archive collector content-script entry");
  for (const entry of collectorEntries) {
    assert.ok(entry.js.indexOf("popup-config.js") < entry.js.indexOf("collector.js"));
  }
  if (expectedMode === "legacy") {
    assert.doesNotMatch(config, /TRACE_SESSION_MODE/);
  } else {
    assert.match(config, new RegExp(`TRACE_SESSION_MODE = "${expectedMode}"`));
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
  assert.equal(installedListeners.length, 1);

  installedListeners[0]({ reason: "install" });
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

    runBuild("build");
    assertCollectorModeConfig(path.join(ROOT, "dist", "chrome"), "kernel");
    assertCollectorModeConfig(path.join(ROOT, "dist", "firefox"), "kernel");
  } finally {
    runBuild("build:release");
  }
});
