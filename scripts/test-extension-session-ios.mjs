#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEVICE_ID = process.env.TRACE_IOS_SIMULATOR_ID;
const EVIDENCE_ROOT = path.resolve(
  process.env.TRACE_IOS_EVIDENCE_PATH ??
    path.join(os.tmpdir(), "trace-installed-ios-evidence"),
);
const PROVIDER_DEFAULTS_DOMAIN = "com.tracefiction.trace.extension";
const PROVIDER_DEFAULTS_KEY = "traceDebugSimulatorProviderCredential";
const PROVIDER_MISSING_FIXTURE = "trace-provider-fixture-missing-v1";
const PROVIDER_REQUEST_COUNT_KEY = "traceDebugSimulatorProviderRequestCount";
const PROVIDER_REQUEST_RESULT_KEY = "traceDebugSimulatorProviderRequestResult";
const TRACE_APP_BUNDLE_ID = "com.tracefiction.trace";
const APP_PROVIDER_V2_KEY = "traceDebugSimulatorAppProviderV2";
const APP_PROVIDER_RETIRED_KEY = "traceDebugSimulatorAppProviderRetired";
const APP_SEED_STALE_KEY = "traceDebugSeedStaleProvider";
const APP_SEED_LEGACY_RAW_KEY = "traceDebugSeedLegacyRawProvider";
const APP_FAIL_CLEAR_KEY = "traceDebugFailProviderClear";
const APP_DEVICE_SESSION_A = "10000000-0000-4000-8000-000000000001";
const APP_DEVICE_SESSION_B = "20000000-0000-4000-8000-000000000002";
const APP_DEVICE_CREDENTIAL_A =
  "trd_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const APP_DEVICE_CREDENTIAL_B =
  "trd_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const APP_DEVICE_SESSION_EXPIRES_AT = "2027-08-02T00:00:00.000Z";
const CONNECT_AND_SAVE_DRIVER_MARKER = "TRACE_INSTALLED_CONNECT_AND_SAVE_DRIVER";
const CONNECT_AND_SAVE_DRIVER_START =
  `/* ${CONNECT_AND_SAVE_DRIVER_MARKER}:start */`;
const CONNECT_AND_SAVE_DRIVER_END =
  `/* ${CONNECT_AND_SAVE_DRIVER_MARKER}:end */`;
// Use the same public FFN story as the checked-in collector fixture. A fresh
// Safari simulator can be redirected from AO3 works to AO3's Terms/content
// policy consent page, which tests a site cookie rather than Trace's installed
// sender, provider, and confirmed-save boundary.
const ARCHIVE_WORK_URL =
  "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter";
const ARCHIVE_WORK_KEY = "ffn:7038840";
const ARCHIVE_WORK_URL_IDENTITY_MARKER = "/s/7038840/";
const TEST_TARGET = "TraceInstalledLifecycleUITests/TraceInstalledLifecycleUITests";
const MODES = new Set(["ok-a", "ok-b", "rejected", "unavailable"]);
const JOURNEY_PHASE = process.env.TRACE_IOS_JOURNEY_PHASE ?? "all";
const PRESERVE_FAILED_WORKSPACE =
  process.env.TRACE_IOS_PRESERVE_FAILED_WORKSPACE === "1";

function run(command, args, { cwd = ROOT, env = process.env, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (quiet) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      const detail = output.trim();
      reject(new Error(
        `${command} ${args.join(" ")} failed with exit ${code}${detail ? `\n${detail}` : ""}`,
      ));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForEvidence(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function copyWorkingTree(destination) {
  const excluded = new Set([
    ".git",
    ".worktrees",
    "dist",
    "node_modules",
  ]);
  fs.cpSync(ROOT, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(ROOT, source);
      if (!relative) return true;
      // The harness supplies isolated fixture origins explicitly. A developer
      // `.env` has precedence in dev builds and would make this test exercise
      // whichever deployment happens to be configured on the host machine.
      if (relative === ".env") return false;
      return !relative.split(path.sep).some((part) => excluded.has(part));
    },
  });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(destination, "node_modules"), "dir");
}

function installConnectAndSaveDriver(sourceRoot) {
  const resourcesRoot = path.join(sourceRoot, "Shared (Extension)", "Resources");
  const manifestPath = path.join(resourcesRoot, "manifest.json");
  const collectorPath = path.join(resourcesRoot, "collector.js");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const archiveEntry = manifest.content_scripts.find(
    (entry) =>
      entry.js?.includes("collector.js") &&
      entry.matches?.some((pattern) => pattern.includes("archiveofourown.org")),
  );
  assert.ok(archiveEntry, "archive collector manifest entry is required for installed Connect-and-save");
  const collectorSource = fs.readFileSync(collectorPath, "utf8");
  assert.equal(
    collectorSource.includes(CONNECT_AND_SAVE_DRIVER_MARKER),
    false,
    "installed Connect-and-save driver was already present",
  );
  // Safari 26 isolates top-level lexical declarations between separate content
  // script files. Append the DEBUG-only driver to the copied collector so it
  // exercises the collector's real private Connect-and-save function instead
  // of duplicating production payload or runtime-message logic.
  fs.appendFileSync(collectorPath, `\n${CONNECT_AND_SAVE_DRIVER_START}\n(() => {
  const marker = ${JSON.stringify(CONNECT_AND_SAVE_DRIVER_MARKER)};
  const status = document.createElement("p");
  status.id = "trace-installed-connect-and-save-status";
  status.setAttribute("role", "status");
  status.style.cssText = "position:fixed;z-index:2147483647;top:8px;left:8px;right:8px;padding:12px;background:#fff7df;color:#3a4339;border:2px solid #1f4d3f;font:16px -apple-system,sans-serif";
  status.textContent = marker + ": preparing";
  document.documentElement.appendChild(status);

  if (
    typeof getWorkKeyFromUrl !== "function" ||
    typeof runKernelConnectAndSave !== "function" ||
    typeof sendCollectorMessage !== "function"
  ) {
    status.textContent = marker + ": collector unavailable";
    return;
  }
  const workKey = getWorkKeyFromUrl();
  if (!workKey) {
    status.textContent = marker + ": unsupported archive page";
    return;
  }

  const productionSend = sendCollectorMessage;
  sendCollectorMessage = function(message, callback) {
    return productionSend(message, function(response) {
      if (message && message.type === TRACE_CONNECT_AND_SAVE_MESSAGE) {
        const state = response && response.snapshot && response.snapshot.state;
        const outcome = response && response.ok === true
          ? "saved"
          : response && response.error;
        status.textContent = "Installed result: " + (state || "missing") + " / " + (outcome || "missing");
      }
      if (typeof callback === "function") callback(response);
    });
  };
  kernelPendingFirstStory = { workKey, handoffId: "installed-ios-connect-and-save" };
  status.textContent = "Installed Connect-and-save driver ready";
})();\n${CONNECT_AND_SAVE_DRIVER_END}\n`);
}

function removeConnectAndSaveDriver(sourceRoot) {
  const resourcesRoot = path.join(sourceRoot, "Shared (Extension)", "Resources");
  const collectorPath = path.join(resourcesRoot, "collector.js");
  const collectorSource = fs.readFileSync(collectorPath, "utf8");
  const startIndex = collectorSource.indexOf(CONNECT_AND_SAVE_DRIVER_START);
  if (startIndex < 0) return;
  const endIndex = collectorSource.indexOf(
    CONNECT_AND_SAVE_DRIVER_END,
    startIndex,
  );
  assert.notEqual(endIndex, -1, "installed Connect-and-save driver end marker is missing");
  const restoredCollector =
    collectorSource.slice(0, startIndex).trimEnd() + "\n" +
    collectorSource.slice(endIndex + CONNECT_AND_SAVE_DRIVER_END.length).trimStart();
  fs.writeFileSync(collectorPath, restoredCollector);
}

function fixtureHtml() {
  return `<!doctype html>
    <html lang="en">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Trace installed iOS fixture</title>
      <style>
        body { font: 18px -apple-system, sans-serif; padding: 32px; }
        h1 { font-size: 28px; }
        button { display: block; font: inherit; margin: 16px 0; padding: 12px; }
        [hidden] { display: none !important; }
      </style>
      <main id="browser-fixture">
        <h1>Trace installed iOS fixture</h1>
        <p>Browser-only Trace session is signed in.</p>
        <p>This local page exists only for the installed Safari lifecycle test.</p>
      </main>
      <main id="app-fixture" hidden>
        <h1>Trace installed app fixture</h1>
        <p id="app-route"></p>
        <p id="app-provider-status">App fixture ready</p>
        <button id="app-sign-out" type="button">App sign out</button>
        <button id="app-provider-retry" type="button">Retry provider cleanup</button>
      </main>
      <script>
        (() => {
          const pending = new Map();
          let nonce = 0;
          const browserFixture = document.getElementById("browser-fixture");
          const appFixture = document.getElementById("app-fixture");
          const appStatus = document.getElementById("app-provider-status");
          const native = window.webkit?.messageHandlers?.traceSafariExtension;

          window.addEventListener("message", (event) => {
            const data = event.data || {};
            if (data.type === "TRACE_FICTION_TOKEN_REQUEST") {
              window.postMessage({
                type: "TRACE_FICTION_TOKEN",
                protocolVersion: 1,
                requestId: data.requestId,
                token: "browser-only-token",
              }, window.location.origin);
              return;
            }
            const pendingAction = pending.get(data.nonce);
            if (!pendingAction) return;
            pending.delete(data.nonce);
            const ok = data.ok === true || data.ok === "true";
            const error = typeof data.error === "string" ? data.error : null;
            if (typeof pendingAction === "object" && pendingAction.action === "status") {
              fetch("/__app-event", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "status", ok, error }),
              }).catch(() => {});
              if (ok) {
                mutate("update", pendingAction.provider);
              } else {
                appStatus.textContent =
                  "Provider status failed: " + (error || "native_error");
              }
              return;
            }
            const action = pendingAction;
            if (action === "update") {
              appStatus.textContent = ok
                ? "Provider ready"
                : "Provider update failed: " + (error || "native_error");
            } else {
              appStatus.textContent = ok
                ? "Signed out and provider cleared"
                : "Sign out blocked: " + (error || "native_error") + ". Still signed in. Retry available.";
            }
            fetch("/__app-event", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, ok, error }),
            }).catch(() => {});
          });

          if (!native || typeof native.postMessage !== "function") return;
          browserFixture.hidden = true;
          appFixture.hidden = false;
          document.getElementById("app-route").textContent =
            "App route: " + location.pathname + location.search + location.hash;

          const mutate = (action, provider) => {
            const requestNonce = "installed-app-" + (++nonce);
            pending.set(requestNonce, action);
            native.postMessage(action === "update" ? {
              type: "TRACE_IOS_AUTH_TOKEN_UPDATE",
              protocolVersion: 3,
              nonce: requestNonce,
              provider,
            } : {
              type: "TRACE_IOS_AUTH_TOKEN_CLEAR",
              protocolVersion: 3,
              nonce: requestNonce,
            });
          };

          const prepareProvider = (provider) => {
            const requestNonce = "installed-app-" + (++nonce);
            pending.set(requestNonce, { action: "status", provider });
            native.postMessage({
              type: "TRACE_IOS_AUTH_PROVIDER_STATUS_REQUEST",
              protocolVersion: 3,
              nonce: requestNonce,
            });
          };

          document.getElementById("app-sign-out").addEventListener("click", () => {
            mutate("clear");
          });
          document.getElementById("app-provider-retry").addEventListener("click", () => {
            mutate("clear");
          });
          fetch("/__app-mode")
            .then((response) => response.text())
            .then((appMode) => {
              if (appMode === "signed-in-a") prepareProvider({
                version: 2,
                kind: "device_session",
                sessionId: "${APP_DEVICE_SESSION_A}",
                credential: "${APP_DEVICE_CREDENTIAL_A}",
                expiresAt: "${APP_DEVICE_SESSION_EXPIRES_AT}",
              });
              else if (appMode === "signed-in-b") prepareProvider({
                version: 2,
                kind: "device_session",
                sessionId: "${APP_DEVICE_SESSION_B}",
                credential: "${APP_DEVICE_CREDENTIAL_B}",
                expiresAt: "${APP_DEVICE_SESSION_EXPIRES_AT}",
              });
              else {
                appStatus.textContent = "Signed out; provider unchanged";
              }
            })
            .catch(() => { appStatus.textContent = "App fixture control unavailable"; });
        })();
      </script>
    </html>`;
}

function redactVerification(authorization, mode) {
  const fixture = authorization === "Bearer ios-fixture-token-a"
    ? "fixture-a"
    : authorization === "Bearer ios-fixture-token-b"
      ? "fixture-b"
      : authorization
        ? "unrecognized"
        : "absent";
  return { fixture, mode };
}

async function main() {
  assert.ok(DEVICE_ID, "Set TRACE_IOS_SIMULATOR_ID to one booted iOS simulator UDID");
  assert.equal(fs.existsSync(path.join(ROOT, "node_modules")), true, "Run npm install first");
  assert.ok(
    ["all", "app", "session"].includes(JOURNEY_PHASE),
    "TRACE_IOS_JOURNEY_PHASE must be all, app, or session",
  );
  const runsAppJourneys = JOURNEY_PHASE === "all" || JOURNEY_PHASE === "app";
  const runsSessionJourneys = JOURNEY_PHASE === "all" || JOURNEY_PHASE === "session";

  const sourceRevision = (await run("git", ["rev-parse", "HEAD"], { quiet: true })).trim();
  const sourceStatus = (await run("git", ["status", "--short"], { quiet: true })).trim();

  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trace-installed-ios-"));
  const sourceRoot = path.join(temporaryRoot, "source");
  const derivedData = path.join(temporaryRoot, "derived-data");
  const uiDerivedData = path.join(temporaryRoot, "ui-derived-data");
  const verificationEvents = [];
  const storyCommandEvents = [];
  const appEvents = [];
  let coldStartPreservationEvidence = null;
  let extensionPreferencesPath = null;
  let mode = "ok-a";
  let appMode = "signed-out";
  let succeeded = false;

  const server = http.createServer((request, response) => {
    if (request.url === "/__app-mode") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(appMode);
      return;
    }

    if (request.url === "/__app-event" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        try {
          const event = JSON.parse(body);
          appEvents.push({
            action:
              event.action === "update"
                ? "update"
                : event.action === "status"
                  ? "status"
                  : "clear",
            ok: event.ok === true,
            error: typeof event.error === "string" ? event.error : null,
          });
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
      return;
    }

    if (request.url === "/__control" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const requested = body.trim();
        if (!MODES.has(requested)) {
          response.writeHead(400).end();
          return;
        }
        mode = requested;
        response.writeHead(204).end();
      });
      return;
    }

    if (request.url === "/api/extension/account") {
      const authorization = request.headers.authorization ?? "";
      verificationEvents.push(redactVerification(authorization, mode));
      if (mode === "unavailable") {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_unavailable" }));
        return;
      }
      if (mode === "rejected") {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_rejected" }));
        return;
      }
      const expected = mode === "ok-a" ? "Bearer ios-fixture-token-a" : "Bearer ios-fixture-token-b";
      if (authorization !== expected) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_wrong_credential" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        account_id: mode === "ok-a" ? "ios-fixture-account-a" : "ios-fixture-account-b",
      }));
      return;
    }

    if (request.url === "/api/extension/library-overlay") {
      const authorization = request.headers.authorization ?? "";
      const expected = mode === "ok-a"
        ? "Bearer ios-fixture-token-a"
        : "Bearer ios-fixture-token-b";
      if (mode === "rejected" || authorization !== expected) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_rejected" }));
        return;
      }
      if (mode === "unavailable") {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_unavailable" }));
        return;
      }
      const saved = storyCommandEvents.some(
        (event) => event.account === mode && event.workKey === ARCHIVE_WORK_KEY,
      );
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        success: true,
        data: {
          entries: saved ? {
            [ARCHIVE_WORK_KEY]: {
              status: "PLANNING",
              readerStatus: "PLANNING",
              canonicalReaderStatus: "SAVED",
              entryId: "00000000-0000-4000-8000-000000000123",
            },
          } : {},
          workPreferences: {},
          syncVersion: saved
            ? "2026-07-19T12:00:01.000Z"
            : "1970-01-01T00:00:00.000Z",
        },
      }));
      return;
    }

    if (request.url === "/api/extension/track" && request.method === "POST") {
      const authorization = request.headers.authorization ?? "";
      const expected = mode === "ok-a"
        ? "Bearer ios-fixture-token-a"
        : "Bearer ios-fixture-token-b";
      if (mode === "rejected" || authorization !== expected) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_rejected" }));
        return;
      }
      if (mode === "unavailable") {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_unavailable" }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "fixture_invalid_json" }));
          return;
        }
        const workUrl = payload?.item?.u;
        if (
          typeof workUrl !== "string" ||
          !workUrl.includes(ARCHIVE_WORK_URL_IDENTITY_MARKER)
        ) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "fixture_unexpected_work" }));
          return;
        }
        storyCommandEvents.push({ account: mode, workKey: ARCHIVE_WORK_KEY });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          success: true,
          data: {
            entry_id: "00000000-0000-4000-8000-000000000123",
            type: "created",
            work_key: ARCHIVE_WORK_KEY,
            entry: {
              status: "PLANNING",
              readerStatus: "PLANNING",
              canonicalReaderStatus: "SAVED",
              entryId: "00000000-0000-4000-8000-000000000123",
            },
            syncVersion: "2026-07-19T12:00:01.000Z",
          },
        }));
      });
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixtureHtml());
  });

  const simctl = (...args) => run("xcrun", ["simctl", ...args], { quiet: true });
  const writeDefault = (domain, key, value) => simctl(
    "spawn",
    DEVICE_ID,
    "defaults",
    "write",
    domain,
    key,
    "-string",
    value,
  );
  const deleteDefault = async (domain, key) => {
    try {
      await simctl("spawn", DEVICE_ID, "defaults", "delete", domain, key);
    } catch {
      // An absent key is the intended state.
    }
  };
  const readInstalledAppDefault = async (key) => {
    try {
      const container = (await simctl(
        "get_app_container",
        DEVICE_ID,
        TRACE_APP_BUNDLE_ID,
        "data",
      )).trim();
      const preferences = path.join(
        container,
        "Library",
        "Preferences",
        `${TRACE_APP_BUNDLE_ID}.plist`,
      );
      return (await run(
        "plutil",
        ["-extract", key, "raw", "-o", "-", preferences],
        { quiet: true },
      )).trim();
    } catch {
      return null;
    }
  };
  const waitForDefault = async (reader, key, expected, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let value = null;
    while (Date.now() < deadline) {
      value = await reader(key);
      if (value === expected) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return value;
  };
  const resolveInstalledExtensionPreferences = async () => {
    const appContainer = (await simctl(
      "get_app_container",
      DEVICE_ID,
      TRACE_APP_BUNDLE_ID,
      "data",
    )).trim();
    const pluginRoot = path.resolve(appContainer, "../../PluginKitPlugin");
    for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const container = path.join(pluginRoot, entry.name);
      const metadata = path.join(
        container,
        ".com.apple.mobile_container_manager.metadata.plist",
      );
      if (!fs.existsSync(metadata)) continue;
      try {
        const identifier = (await run(
          "plutil",
          ["-extract", "MCMMetadataIdentifier", "raw", "-o", "-", metadata],
          { quiet: true },
        )).trim();
        if (identifier === PROVIDER_DEFAULTS_DOMAIN) {
          return path.join(
            container,
            "Library",
            "Preferences",
            `${PROVIDER_DEFAULTS_DOMAIN}.plist`,
          );
        }
      } catch {
        // Ignore unrelated or malformed plugin-container metadata.
      }
    }
    return null;
  };
  const readInstalledExtensionDefault = async (key) => {
    if (!extensionPreferencesPath || !fs.existsSync(extensionPreferencesPath)) return null;
    try {
      return (await run(
        "plutil",
        ["-extract", key, "raw", "-o", "-", extensionPreferencesPath],
        { quiet: true },
      )).trim();
    } catch {
      return null;
    }
  };
  const readProviderRequestCount = async () => {
    const raw = await readInstalledExtensionDefault(PROVIDER_REQUEST_COUNT_KEY);
    const count = Number.parseInt(raw ?? "", 10);
    return Number.isInteger(count) ? count : 0;
  };
  const clearProvider = async () => {
    // An unsigned simulator cannot prove the shared access group. Use an
    // explicit DEBUG-only state so "missing" cannot be confused with an
    // entitlement/read failure from the real Keychain path.
    await writeDefault(
      PROVIDER_DEFAULTS_DOMAIN,
      PROVIDER_DEFAULTS_KEY,
      PROVIDER_MISSING_FIXTURE,
    );
  };
  const setProvider = (value) => writeDefault(
    PROVIDER_DEFAULTS_DOMAIN,
    PROVIDER_DEFAULTS_KEY,
    value,
  );
  const providerRequestEvidence = [];
  const assertProviderRequest = async (journey, expectedResult, baselineCount) => {
    const deadline = Date.now() + 15_000;
    let count = baselineCount;
    let result = null;
    while (Date.now() < deadline) {
      count = await readProviderRequestCount();
      result = await readInstalledExtensionDefault(PROVIDER_REQUEST_RESULT_KEY);
      if (count > baselineCount && result === expectedResult) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(count > baselineCount, `${journey} did not reach the native provider`);
    assert.equal(result, expectedResult, `${journey} recorded the wrong provider outcome`);
    providerRequestEvidence.push({
      journey,
      requestsObserved: count - baselineCount,
      result,
    });
  };
  const capture = (name) => simctl(
    "io",
    DEVICE_ID,
    "screenshot",
    path.join(EVIDENCE_ROOT, `${name}.png`),
  );
  const terminateSafari = async () => {
    try {
      await simctl("terminate", DEVICE_ID, "com.apple.mobilesafari");
    } catch {
      // A stopped Safari is the desired precondition.
    }
  };

  try {
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      await simctl("shutdown", DEVICE_ID);
    } catch {
      // A stopped simulator is already at the required isolation boundary.
    }
    await simctl("boot", DEVICE_ID);
    await simctl("bootstatus", DEVICE_ID, "-b");

    copyWorkingTree(sourceRoot);
    const buildEnvironment = {
      ...process.env,
      TRACE_API_BASE: origin,
      TRACE_WEB_ORIGIN: origin,
      TRACE_SESSION_MODE: "kernel",
    };
    await run("npm", ["run", "build:kernel"], { cwd: sourceRoot, env: buildEnvironment });
    if (runsSessionJourneys) installConnectAndSaveDriver(sourceRoot);

    await run("xcodebuild", [
      "-project", "Trace.xcodeproj",
      "-scheme", "Trace (iOS)",
      "-configuration", "Debug",
      "-destination", `platform=iOS Simulator,id=${DEVICE_ID}`,
      "-derivedDataPath", derivedData,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ], { cwd: sourceRoot });

    const appPath = path.join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Trace.app");
    assert.equal(fs.existsSync(appPath), true, "Trace simulator app was not built");
    try {
      await simctl("uninstall", DEVICE_ID, TRACE_APP_BUNDLE_ID);
    } catch {
      // A missing prior install is already isolated.
    }
    await simctl("install", DEVICE_ID, appPath);
    extensionPreferencesPath = await resolveInstalledExtensionPreferences();
    assert.ok(
      extensionPreferencesPath,
      "the installed Trace native-extension preferences container was not found",
    );

    const uiRoot = path.join(sourceRoot, "test", "installed-ios");
    const testEnvironment = {
      ...process.env,
      TRACE_IOS_FIXTURE_ORIGIN: origin,
    };
    await run("xcodegen", ["generate", "--spec", "project.yml"], {
      cwd: uiRoot,
      env: testEnvironment,
    });
    await run("xcodebuild", [
      "build-for-testing",
      "-project", "TraceInstalledLifecycleUITests.xcodeproj",
      "-scheme", "TraceInstalledLifecycleUITests",
      "-destination", `platform=iOS Simulator,id=${DEVICE_ID}`,
      "-derivedDataPath", uiDerivedData,
      "CODE_SIGNING_ALLOWED=NO",
    ], { cwd: uiRoot });

    const runTest = async (name, { artifact = name, url = origin } = {}) => {
      const artifactName = JOURNEY_PHASE === "all" ? artifact : `${JOURNEY_PHASE}-${artifact}`;
      const resultBundle = path.join(EVIDENCE_ROOT, `${artifactName}.xcresult`);
      fs.rmSync(resultBundle, { recursive: true, force: true });
      // Provider fixtures are changed between separate test invocations.
      // Restarting Safari prevents its extension process from retaining a
      // cached DEBUG UserDefaults value across those explicit boundaries.
      await terminateSafari();
      await simctl("openurl", DEVICE_ID, url);
      await run("xcodebuild", [
        "test-without-building",
        "-quiet",
        "-project", "TraceInstalledLifecycleUITests.xcodeproj",
        "-scheme", "TraceInstalledLifecycleUITests",
        "-destination", `platform=iOS Simulator,id=${DEVICE_ID}`,
        "-derivedDataPath", uiDerivedData,
        "-resultBundlePath", resultBundle,
        "CODE_SIGNING_ALLOWED=NO",
        `-only-testing:${TEST_TARGET}/${name}`,
      ], { cwd: uiRoot, env: testEnvironment });
      await capture(artifactName);
    };

    await clearProvider();
    for (const historicalAppDebugKey of [
      APP_PROVIDER_V2_KEY,
      APP_PROVIDER_RETIRED_KEY,
      APP_FAIL_CLEAR_KEY,
    ]) {
      await deleteDefault(TRACE_APP_BUNDLE_ID, historicalAppDebugKey);
    }

    if (runsAppJourneys) {
      appMode = "signed-out";
      const priorColdStartEventCount = appEvents.length;
      await runTest("testAppSignedOutColdStartPreservesDeviceProvider");
      assert.equal(
        appEvents.length,
        priorColdStartEventCount,
        "ambient signed-out startup mutated the app-owned provider",
      );
      coldStartPreservationEvidence = "no native mutation observed";

      await runTest("testResetSession", { artifact: "testResetSessionBeforeBrowserOnly" });
      const browserOnlyProviderBaseline = await readProviderRequestCount();
      await runTest("testBrowserOnlySignInCannotConnectWithoutAppProvider");
      await assertProviderRequest(
        "browser-only Connect",
        "missing",
        browserOnlyProviderBaseline,
      );

      appMode = "signed-out";
      await runTest("testOpenTraceAppFromPopup");

      appMode = "signed-in-a";
      let priorAppEventCount = appEvents.length;
      await runTest("testAppSignInWritesProvider");
      await waitForEvidence(
        () => appEvents.slice(priorAppEventCount).some(
          (event) => event.action === "update" && event.ok,
        ),
        "the app's real v3 update handler did not acknowledge provider A",
      );
      await waitForEvidence(
        () => appEvents.slice(priorAppEventCount).some(
          (event) => event.action === "status" && event.ok,
        ),
        "the app's real v3 status handler did not acknowledge provider access",
      );

      priorAppEventCount = appEvents.length;
      await runTest("testAppSignInMigratesV060RawProvider");
      await waitForEvidence(
        () => appEvents.slice(priorAppEventCount).some(
          (event) => event.action === "status" && event.ok,
        ),
        "the app did not classify the v0.6.0 raw provider as replaceable legacy data",
      );
      await waitForEvidence(
        () => appEvents.slice(priorAppEventCount).some(
          (event) => event.action === "update" && event.ok,
        ),
        "the app did not overwrite the v0.6.0 raw provider with the v3 device provider",
      );
      await runTest("testAppResumeDoesNotAmbientlyConnect");

      // Unsigned Simulator apps cannot share the production Keychain access
      // group. Mirror only a legacy fixture value after the real app v3
      // handler validates and acknowledges the device-session record. The
      // signed/TestFlight gate remains responsible for the physical shared
      // Keychain boundary.
      await setProvider("ios-fixture-token-a");
      mode = "ok-a";
      const appProviderBaseline = await readProviderRequestCount();
      await runTest("testReturnAfterAppSignInRequiresExplicitConnect");
      await assertProviderRequest("app-provider Connect", "present", appProviderBaseline);

      appMode = "signed-in-a";
      priorAppEventCount = appEvents.length;
      await runTest("testAppSignOutClearsProvider");
      await waitForEvidence(
        () => appEvents.slice(priorAppEventCount).some(
          (event) => event.action === "clear" && event.ok,
        ),
        "app sign-out did not acknowledge provider cleanup",
      );
      await clearProvider();
      await runTest("testConnectedSessionAfterAppSignOutNeedsReconnectOnRejection");

      await runTest("testResetSession", { artifact: "testResetSessionBeforeClearFailure" });
      appMode = "signed-in-b";
      priorAppEventCount = appEvents.length;
      await runTest("testAppClearFailureBlocksSignOut");
      await waitForEvidence(
        () => appEvents.slice(priorAppEventCount).some(
          (event) =>
            event.action === "clear" &&
            !event.ok &&
            event.error === "provider_clear_failed",
        ),
        "the app provider-clear failure was not acknowledged",
      );
    }

    if (runsSessionJourneys) {
      await runTest("testResetSession", { artifact: "testResetSessionBeforeSameProvider" });
      mode = "ok-a";
      await setProvider("ios-fixture-token-a");
      const connectAndSaveProviderBaseline = await readProviderRequestCount();
      await runTest("testConnectAndSaveFromInstalledArchiveSender", {
        url: ARCHIVE_WORK_URL,
      });
      await assertProviderRequest(
        "installed Connect-and-save",
        "present",
        connectAndSaveProviderBaseline,
      );
      assert.deepEqual(
        storyCommandEvents,
        [
          { account: "ok-a", workKey: ARCHIVE_WORK_KEY },
          { account: "ok-a", workKey: ARCHIVE_WORK_KEY },
        ],
        "installed first-story setup did not produce the bounded save and automatic-progress pair",
      );
      await runTest("testResetSession", { artifact: "testResetSessionAfterConnectAndSave" });
      await runTest("testLeaveReconnectRequiredForProviderChange", {
        artifact: "testLeaveReconnectRequiredForSameProvider",
      });
      await runTest("testReconnectWithSameProvider");

      await runTest("testResetSession", { artifact: "testResetSessionBeforeChangedProvider" });
      await setProvider("ios-fixture-token-a");
      await runTest("testLeaveReconnectRequiredForProviderChange", {
        artifact: "testLeaveReconnectRequiredForChangedProvider",
      });
      await setProvider("ios-fixture-token-b");
      await runTest("testReconnectWithChangedProvider");

      await setProvider("ios-fixture-token-b");
      await runTest("testLeaveReconnectRequiredForMissingProvider");
      await clearProvider();
      await runTest("testReconnectWithoutProviderFailsClosed");

      await setProvider("ios-fixture-token-a");
      await runTest("testConnectRestartRetryAndDisconnect");
    }

    assert.ok(
      verificationEvents.some((event) => event.fixture === "fixture-a" && event.mode === "ok-a"),
      "fixture A never completed account verification",
    );
    if (runsSessionJourneys) {
      assert.ok(
        verificationEvents.some((event) => event.fixture === "fixture-b" && event.mode === "ok-b"),
        "fixture B never completed account verification",
      );
      assert.ok(
        verificationEvents.some((event) => event.mode === "unavailable"),
        "the installed offline/retry boundary was not exercised",
      );
      assert.ok(
        verificationEvents.filter((event) => event.mode === "rejected").length >= 2,
        "the one-refresh rejection boundary was not exercised",
      );
    }
    if (runsAppJourneys) {
      assert.ok(
        appEvents.some((event) => event.action === "update" && event.ok),
        "the app v3 provider update was not acknowledged",
      );
      assert.ok(
        appEvents.some((event) => event.action === "clear" && event.ok),
        "the app v3 provider clear was not acknowledged",
      );
      assert.ok(
        appEvents.some(
          (event) => event.action === "clear" && !event.ok && event.error === "provider_clear_failed",
        ),
        "the app provider-clear failure was not observed",
      );
    }

    removeConnectAndSaveDriver(sourceRoot);
    await run("npm", ["run", "build:kernel:release"], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        TRACE_API_BASE: "https://api.tracefiction.com",
        TRACE_WEB_ORIGIN: "https://www.tracefiction.com",
      },
    });
    await run("xcodebuild", [
      "-project", "Trace.xcodeproj",
      "-scheme", "Trace (iOS)",
      "-configuration", "Release",
      "-destination", "generic/platform=iOS Simulator",
      "-derivedDataPath", path.join(temporaryRoot, "release-derived-data"),
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ], { cwd: sourceRoot });
    const releaseExtensionBundle = path.join(
      temporaryRoot,
      "release-derived-data",
      "Build",
      "Products",
      "Release-iphonesimulator",
      "Trace.app",
      "PlugIns",
      "Trace Extension.appex",
    );
    const releaseCollectorSource = fs.readFileSync(
      path.join(releaseExtensionBundle, "collector.js"),
      "utf8",
    );
    assert.equal(
      releaseCollectorSource.includes(CONNECT_AND_SAVE_DRIVER_MARKER),
      false,
      "installed Connect-and-save driver leaked into the Release collector",
    );
    const releaseManifest = JSON.parse(fs.readFileSync(
      path.join(sourceRoot, "Shared (Extension)", "Resources", "manifest.json"),
      "utf8",
    ));
    assert.equal(
      releaseManifest.content_scripts.filter(
        (entry) => entry.js?.includes("collector.js"),
      ).length,
      1,
      "Release manifest must contain exactly one production collector entry",
    );
    const releaseExtension = path.join(
      releaseExtensionBundle,
      "Trace Extension",
    );
    const releaseStrings = await run("strings", [releaseExtension], { quiet: true });
    for (const debugString of [
      PROVIDER_DEFAULTS_KEY,
      PROVIDER_REQUEST_COUNT_KEY,
      PROVIDER_REQUEST_RESULT_KEY,
      CONNECT_AND_SAVE_DRIVER_MARKER,
    ]) {
      assert.doesNotMatch(
        releaseStrings,
        new RegExp(debugString),
        `${debugString} leaked into the Release extension binary`,
      );
    }
    const releaseApp = path.join(
      temporaryRoot,
      "release-derived-data",
      "Build",
      "Products",
      "Release-iphonesimulator",
      "Trace.app",
      "Trace",
    );
    const releaseAppStrings = await run("strings", [releaseApp], { quiet: true });
    for (const debugString of [
      APP_PROVIDER_V2_KEY,
      APP_PROVIDER_RETIRED_KEY,
      APP_SEED_STALE_KEY,
      APP_SEED_LEGACY_RAW_KEY,
      APP_FAIL_CLEAR_KEY,
      "stale-v2-provider",
      "stale-retired-provider",
    ]) {
      assert.doesNotMatch(
        releaseAppStrings,
        new RegExp(debugString),
        `${debugString} leaked into the Release containing-app binary`,
      );
    }

    const summary = {
      schema: "trace.installed-ios-session-evidence/v2",
      recordedAt: new Date().toISOString(),
      sourceRevision,
      sourceTreeState: sourceStatus ? "dirty" : "clean",
      deviceId: DEVICE_ID,
      sessionMode: "kernel",
      journeyPhase: JOURNEY_PHASE,
      journeys: [
        ...(runsAppJourneys ? [
          "ambient signed-out app startup preserves device-provider state",
          "browser-only website sign-in cannot satisfy Connect",
          "Open Trace app routes in-shell without connecting",
          "app sign-in writes the v3 device provider without ambient connection",
          "v0.6.0 raw Keychain providers migrate to the v3 device provider",
          "return from app sign-in requires explicit verified Connect",
          "app sign-out clears the provider without ambient session mutation",
          "post-sign-out verification rejection requires Reconnect",
          "provider-clear failure remains signed in and retryable",
        ] : []),
        ...(runsSessionJourneys ? [
          "installed archive Connect-and-save reaches the collector and confirms one save",
          "verified explicit Connect",
          "online Safari restart re-verification",
          "unavailable restart then Retry",
          "Disconnect",
          "same-provider rejection to reconnect-required",
          "explicit same-provider Reconnect",
          "explicit different-provider Reconnect",
          "missing-provider Reconnect",
        ] : []),
      ],
      fixtureVerificationEvents: verificationEvents,
      fixtureStoryCommandEvents: storyCommandEvents,
      appProviderEvents: appEvents,
      connectAndSaveBoundary: runsSessionJourneys ? {
        senderOrigin: new URL(ARCHIVE_WORK_URL).origin,
        snapshotState: "connected",
        result: "saved",
        confirmedWrites: storyCommandEvents.length,
      } : null,
      nativeProviderReachProof: providerRequestEvidence,
      coldStartPreservationProof: runsAppJourneys ? {
        result: coldStartPreservationEvidence,
        owner: "explicit logout lifecycle",
      } : null,
      releaseFixtureSeamPresent: false,
      keychainBoundary: "deferred to the required real-device/TestFlight release-candidate smoke",
    };
    const summaryName = JOURNEY_PHASE === "all"
      ? "summary.json"
      : `summary-${JOURNEY_PHASE}.json`;
    fs.writeFileSync(
      path.join(EVIDENCE_ROOT, summaryName),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    succeeded = true;
    console.log(
      `Installed iOS session lifecycle phase ${JOURNEY_PHASE} passed. Evidence: ${EVIDENCE_ROOT}`,
    );
  } finally {
    await closeServer(server);
    if (succeeded || !PRESERVE_FAILED_WORKSPACE) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } else {
      console.error(`Preserved failed installed-iOS workspace: ${temporaryRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
