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

function earnedPermissionBootstrapHarness(source, responses) {
  let nextTimerId = 1;
  const timers = new Map();
  const windowListeners = new Map();
  const dispatchedEvents = [];
  let messageCount = 0;
  const context = {
    Promise,
    location: { hostname: "archiveofourown.org" },
    setTimeout(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      hidden: false,
      addEventListener() {},
      dispatchEvent(event) {
        dispatchedEvents.push(event.type);
      },
    },
    browser: {
      runtime: {
        sendMessage(message) {
          assert.deepEqual(
            JSON.parse(JSON.stringify(message)),
            { type: "TRACE_EARNED_PERMISSION_RECONCILE" },
          );
          const response = responses[messageCount];
          messageCount += 1;
          return response === "pending"
            ? new Promise(() => {})
            : Promise.resolve(response);
        },
      },
    },
  };
  vm.runInNewContext(source, context);
  return {
    context,
    dispatchedEvents,
    get messageCount() {
      return messageCount;
    },
    fireWindowEvent(type) {
      windowListeners.get(type)?.();
    },
    async runNextTimer() {
      const next = [...timers.entries()].sort(
        (left, right) => left[1].delay - right[1].delay,
      )[0];
      assert.ok(next, "expected a pending bootstrap timer");
      timers.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
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

    runBuild("build:ios-earned-permission-onboarding:release");
    const earnedSafariManifest = manifest(RESOURCES);
    const earnedSafariConfig = fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8");
    assert.deepEqual(earnedSafariManifest.permissions, [
      "alarms",
      "tabs",
      "storage",
      "nativeMessaging",
    ]);
    const earnedPermissionSurface = {
      permissions: earnedSafariManifest.permissions,
      host_permissions: earnedSafariManifest.host_permissions,
      content_scripts: earnedSafariManifest.content_scripts,
    };
    assert.equal(
      crypto
        .createHash("sha256")
        .update(JSON.stringify(earnedPermissionSurface))
        .digest("hex"),
      "09aa341fbcaf4a92b430bc4faf4a04ae5635b7d458219ec24f6aebf53daf5d83",
      "production onboarding must preserve the exact v0.6.5 Safari permission surface",
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
    const recoveredBootstrap = earnedPermissionBootstrapHarness(
      earnedSafariConfig,
      [
        "pending",
        {
          ok: true,
          completeGrant: true,
          registered: true,
        },
      ],
    );
    assert.equal(recoveredBootstrap.messageCount, 1);
    assert.equal(
      recoveredBootstrap.context.TRACE_EARNED_PERMISSION_COMPLETE,
      false,
      "archive behavior must remain gated while Safari drops the first worker message",
    );
    await recoveredBootstrap.runNextTimer();
    await recoveredBootstrap.runNextTimer();
    assert.equal(recoveredBootstrap.messageCount, 2);
    assert.equal(
      recoveredBootstrap.context.TRACE_EARNED_PERMISSION_COMPLETE,
      true,
    );
    assert.deepEqual(recoveredBootstrap.dispatchedEvents, [
      "trace-earned-permission-ready",
    ]);
    recoveredBootstrap.fireWindowEvent("pageshow");
    assert.equal(
      recoveredBootstrap.messageCount,
      2,
      "successful readiness must not start duplicate reconcile cycles",
    );

    const incompleteBootstrap = earnedPermissionBootstrapHarness(
      earnedSafariConfig,
      [
        {
          ok: false,
          completeGrant: false,
          registered: false,
          error: "permission_incomplete",
        },
      ],
    );
    await Promise.resolve();
    await Promise.resolve();
    incompleteBootstrap.fireWindowEvent("pageshow");
    assert.equal(
      incompleteBootstrap.messageCount,
      1,
      "a real incomplete grant remains fail-closed instead of being retried",
    );
    assert.equal(
      incompleteBootstrap.context.TRACE_EARNED_PERMISSION_COMPLETE,
      false,
    );
    assert.deepEqual(incompleteBootstrap.dispatchedEvents, []);

    const lifecycleBootstrap = earnedPermissionBootstrapHarness(
      earnedSafariConfig,
      ["pending", "pending", "pending", "pending", {
        ok: true,
        completeGrant: true,
        registered: true,
      }],
    );
    for (let timer = 0; timer < 7; timer += 1) {
      await lifecycleBootstrap.runNextTimer();
    }
    assert.equal(lifecycleBootstrap.messageCount, 4);
    assert.equal(
      lifecycleBootstrap.context.TRACE_EARNED_PERMISSION_COMPLETE,
      false,
    );
    lifecycleBootstrap.fireWindowEvent("focus");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lifecycleBootstrap.messageCount, 5);
    assert.equal(
      lifecycleBootstrap.context.TRACE_EARNED_PERMISSION_COMPLETE,
      true,
      "returning to a page must start a fresh bounded cycle after transport exhaustion",
    );
    assert.deepEqual(lifecycleBootstrap.dispatchedEvents, [
      "trace-earned-permission-ready",
    ]);
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
    assert.match(
      fs.readFileSync(
        path.join(ROOT, "iOS (App)", "TraceWebOrigin.generated.swift"),
        "utf8",
      ),
      /httpsOrigin: String = "https:\/\/www\.tracefiction\.com"[\s\S]*earnedPermissionOnboardingEnabled: Bool = true[\s\S]*allowReleaseExperimentOrigin: Bool = false/,
    );

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
      "https://trace-git-dev-zacs-projects-378417c9.vercel.app";
    const previewApiOrigin =
      "https://ff-app-development.up.railway.app";
    assert.match(
      fs.readFileSync(path.join(RESOURCES, "popup-config.js"), "utf8"),
      new RegExp(previewOrigin.replaceAll(".", "\\.")),
    );
    assert.match(
      fs.readFileSync(path.join(RESOURCES, "background.js"), "utf8"),
      new RegExp(previewApiOrigin.replaceAll(".", "\\.")),
    );
    assert.match(
      fs.readFileSync(
        path.join(ROOT, "iOS (App)", "TraceWebOrigin.generated.swift"),
        "utf8",
      ),
      /trace-git-dev-zacs-projects-378417c9\.vercel\.app"[\s\S]*ff-app-development\.up\.railway\.app"[\s\S]*earnedPermissionOnboardingEnabled: Bool = true[\s\S]*allowReleaseExperimentOrigin: Bool = true/,
    );

    for (const packageRoot of [
      path.join(ROOT, "dist", "chrome"),
      path.join(ROOT, "dist", "firefox"),
    ]) {
      const packaged = manifest(packageRoot);
      const packagedConfig = fs.readFileSync(path.join(packageRoot, "popup-config.js"), "utf8");
      assert.equal(Object.hasOwn(packaged, "optional_host_permissions"), false);
      assert.equal(packaged.permissions.includes("scripting"), false);
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
    assert.match(
      fs.readFileSync(
        path.join(ROOT, "iOS (App)", "TraceWebOrigin.generated.swift"),
        "utf8",
      ),
      /earnedPermissionOnboardingEnabled: Bool = false[\s\S]*allowReleaseExperimentOrigin: Bool = false/,
    );
  }
});
