import assert from "node:assert/strict";
import test from "node:test";

import {
  AO3_PERMISSION_BUNDLE,
  AO3_PERMISSION_REGISTRATION_SCRIPT_IDS,
  AO3_PERMISSION_SPIKE_EXCLUDE_MATCHES,
  AO3_PERMISSION_SPIKE_SCRIPT_ID,
  AO3_TRACE_MAIN_SCRIPT_ID,
  AO3_TRACE_SAVED_FILTERS_SCRIPT_ID,
  permissionBundleCoverage,
  registeredProbeScript,
  registeredTraceScripts,
} from "../Shared (Extension)/Resources/permission-spike-core.mjs";
import {
  reconcileTraceAo3Scripts,
  requestTraceAo3Permission,
} from "../src/permission-spike-background.mjs";

test("AO3 permission bundle contains every currently supported manifest pattern", () => {
  assert.deepEqual(AO3_PERMISSION_BUNDLE, [
    "https://archiveofourown.org/*",
    "https://*.archiveofourown.org/*",
    "https://archiveofourown.gay/*",
    "https://*.archiveofourown.gay/*",
    "https://archive.transformativeworks.org/*",
  ]);
});

test("permission coverage fails closed when one AO3 variant is absent", () => {
  const granted = AO3_PERMISSION_BUNDLE.slice(0, -1);
  const coverage = permissionBundleCoverage(granted);

  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missing, [
    "https://archive.transformativeworks.org/*",
  ]);
});

test("permission coverage accepts the complete bundle or Safari blanket grant", () => {
  assert.equal(permissionBundleCoverage(AO3_PERMISSION_BUNDLE).complete, true);
  assert.equal(permissionBundleCoverage(["*://*/*"]).complete, true);
  assert.equal(permissionBundleCoverage(["<all_urls>"]).complete, true);
});

test("registered probe script covers the complete bundle and persists", () => {
  const script = registeredProbeScript();

  assert.equal(script.id, AO3_PERMISSION_SPIKE_SCRIPT_ID);
  assert.deepEqual(script.js, ["permission-spike-content.js"]);
  assert.deepEqual(script.matches, [...AO3_PERMISSION_BUNDLE]);
  assert.deepEqual(
    script.excludeMatches,
    [...AO3_PERMISSION_SPIKE_EXCLUDE_MATCHES],
  );
  assert.equal(script.persistAcrossSessions, true);
  assert.equal(script.runAt, "document_idle");
  assert.equal(
    script.excludeMatches.includes(
      "https://archiveofourown.org/users/login*",
    ),
    true,
  );
  assert.equal(
    script.excludeMatches.includes(
      "https://archive.transformativeworks.org/users/auth/*",
    ),
    true,
  );
});

test("registered Trace scripts restore the production AO3 execution order", () => {
  const scripts = registeredTraceScripts();

  assert.deepEqual(
    scripts.map((script) => script.id),
    [AO3_TRACE_MAIN_SCRIPT_ID, AO3_TRACE_SAVED_FILTERS_SCRIPT_ID],
  );
  assert.deepEqual(scripts[0].js, [
    "popup-config.js",
    "trace-finish-qualify.js",
    "collector.js",
    "library-overlay-keys.js",
    "library-overlay.js",
  ]);
  assert.deepEqual(scripts[1].js, ["ao3-saved-filters.js"]);
  for (const script of scripts) {
    assert.deepEqual(script.matches, [...AO3_PERMISSION_BUNDLE]);
    assert.deepEqual(
      script.excludeMatches,
      [...AO3_PERMISSION_SPIKE_EXCLUDE_MATCHES],
    );
    assert.equal(script.persistAcrossSessions, true);
    assert.equal(script.runAt, "document_end");
  }
});

test("update reconciliation replaces the probe with real Trace scripts", async () => {
  const unregistered = [];
  const registered = [];
  const extensionApi = {
    permissions: {
      async getAll() {
        return { origins: [...AO3_PERMISSION_BUNDLE] };
      },
    },
    scripting: {
      async unregisterContentScripts(options) {
        unregistered.push(options);
      },
      async registerContentScripts(scripts) {
        registered.push(scripts);
      },
    },
  };

  const result = await reconcileTraceAo3Scripts(extensionApi);

  assert.equal(result.ok, true);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(
    unregistered,
    AO3_PERMISSION_REGISTRATION_SCRIPT_IDS.map((id) => ({ ids: [id] })),
  );
  assert.deepEqual(
    registered[0].map((script) => script.id),
    [AO3_TRACE_MAIN_SCRIPT_ID, AO3_TRACE_SAVED_FILTERS_SCRIPT_ID],
  );
});

test("reconciliation removes stale scripts when AO3 access is incomplete", async () => {
  let registerCalls = 0;
  let unregisterCalls = 0;
  const result = await reconcileTraceAo3Scripts({
    permissions: {
      async getAll() {
        return { origins: AO3_PERMISSION_BUNDLE.slice(0, -1) };
      },
    },
    scripting: {
      async unregisterContentScripts() {
        unregisterCalls += 1;
      },
      async registerContentScripts() {
        registerCalls += 1;
      },
    },
  });

  assert.equal(result.coverage.complete, false);
  assert.equal(
    unregisterCalls,
    AO3_PERMISSION_REGISTRATION_SCRIPT_IDS.length,
  );
  assert.equal(registerCalls, 0);
});

test("a trusted Trace-page request grants the complete bundle and registers real scripts", async () => {
  const requested = [];
  const registered = [];
  const extensionApi = {
    permissions: {
      async request(options) {
        requested.push(options);
        return true;
      },
      async getAll() {
        return { origins: [...AO3_PERMISSION_BUNDLE] };
      },
    },
    scripting: {
      async unregisterContentScripts() {},
      async registerContentScripts(scripts) {
        registered.push(...scripts);
      },
    },
  };

  const result = await requestTraceAo3Permission(
    extensionApi,
    { tab: { url: "https://trace-git-dev.example/setup" } },
    "https://trace-git-dev.example",
  );

  assert.deepEqual(requested, [{ origins: [...AO3_PERMISSION_BUNDLE] }]);
  assert.deepEqual(result, {
    ok: true,
    outcome: "granted_complete",
    requestAttempted: true,
    granted: true,
    coverageComplete: true,
    missingCount: 0,
    scriptsRegistered: true,
  });
  assert.deepEqual(
    registered.map((script) => script.id),
    [AO3_TRACE_MAIN_SCRIPT_ID, AO3_TRACE_SAVED_FILTERS_SCRIPT_ID],
  );
});

test("permission request fails closed for untrusted senders and reports denial without private detail", async () => {
  let requestCalls = 0;
  const extensionApi = {
    permissions: {
      async request() {
        requestCalls += 1;
        return false;
      },
      async getAll() {
        return { origins: [] };
      },
    },
    scripting: {
      async unregisterContentScripts() {},
      async registerContentScripts() {},
    },
  };

  assert.deepEqual(
    await requestTraceAo3Permission(
      extensionApi,
      { tab: { url: "https://evil.example/setup" } },
      "https://trace-git-dev.example",
    ),
    {
      ok: false,
      outcome: "untrusted_sender",
      requestAttempted: false,
      granted: false,
      coverageComplete: false,
      missingCount: AO3_PERMISSION_BUNDLE.length,
      scriptsRegistered: false,
    },
  );
  assert.equal(requestCalls, 0);

  assert.deepEqual(
    await requestTraceAo3Permission(
      extensionApi,
      { tab: { url: "https://trace-git-dev.example/setup" } },
      "https://trace-git-dev.example",
    ),
    {
      ok: false,
      outcome: "denied",
      requestAttempted: true,
      granted: false,
      coverageComplete: false,
      missingCount: AO3_PERMISSION_BUNDLE.length,
      scriptsRegistered: false,
    },
  );
});
