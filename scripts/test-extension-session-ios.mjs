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
const TEST_TARGET = "TraceInstalledLifecycleUITests/TraceInstalledLifecycleUITests";
const MODES = new Set(["ok-a", "ok-b", "rejected", "unavailable"]);

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
      return !relative.split(path.sep).some((part) => excluded.has(part));
    },
  });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(destination, "node_modules"), "dir");
}

function fixtureHtml() {
  return `<!doctype html>
    <html lang="en">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Trace installed iOS fixture</title>
      <style>
        body { font: 18px -apple-system, sans-serif; padding: 32px; }
        h1 { font-size: 28px; }
      </style>
      <h1>Trace installed iOS fixture</h1>
      <p>This local page exists only for the installed Safari lifecycle test.</p>
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

  const sourceRevision = (await run("git", ["rev-parse", "HEAD"], { quiet: true })).trim();
  const sourceStatus = (await run("git", ["status", "--short"], { quiet: true })).trim();

  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trace-installed-ios-"));
  const sourceRoot = path.join(temporaryRoot, "source");
  const derivedData = path.join(temporaryRoot, "derived-data");
  const uiDerivedData = path.join(temporaryRoot, "ui-derived-data");
  const verificationEvents = [];
  let mode = "ok-a";
  let succeeded = false;

  const server = http.createServer((request, response) => {
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

    if (request.url === "/api/account/me") {
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

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixtureHtml());
  });

  const simctl = (...args) => run("xcrun", ["simctl", ...args], { quiet: true });
  const clearProvider = async () => {
    try {
      await simctl("spawn", DEVICE_ID, "defaults", "delete", PROVIDER_DEFAULTS_DOMAIN, PROVIDER_DEFAULTS_KEY);
    } catch {
      // An absent key is the intended state.
    }
  };
  const setProvider = (value) => simctl(
    "spawn",
    DEVICE_ID,
    "defaults",
    "write",
    PROVIDER_DEFAULTS_DOMAIN,
    PROVIDER_DEFAULTS_KEY,
    "-string",
    value,
  );
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

    copyWorkingTree(sourceRoot);
    const buildEnvironment = {
      ...process.env,
      TRACE_API_BASE: origin,
      TRACE_WEB_ORIGIN: origin,
      TRACE_SESSION_MODE: "kernel",
    };
    await run("npm", ["run", "build:kernel"], { cwd: sourceRoot, env: buildEnvironment });

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
    await simctl("install", DEVICE_ID, appPath);

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

    const runTest = async (name) => {
      const resultBundle = path.join(EVIDENCE_ROOT, `${name}.xcresult`);
      fs.rmSync(resultBundle, { recursive: true, force: true });
      // Provider fixtures are changed between separate test invocations.
      // Restarting Safari prevents its extension process from retaining a
      // cached DEBUG UserDefaults value across those explicit boundaries.
      await terminateSafari();
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
      await capture(name);
    };

    await clearProvider();
    await runTest("testResetSession");
    await runTest("testSignedOutConnectWithoutAppCredentialFailsClosed");

    await setProvider("ios-fixture-token-a");
    await runTest("testConnectRestartRetryAndDisconnect");

    await setProvider("ios-fixture-token-a");
    await runTest("testLeaveReconnectRequiredForProviderChange");
    await setProvider("ios-fixture-token-b");
    await runTest("testReconnectWithChangedProvider");

    await setProvider("ios-fixture-token-b");
    await runTest("testLeaveReconnectRequiredForMissingProvider");
    await clearProvider();
    await runTest("testReconnectWithoutProviderFailsClosed");

    assert.ok(
      verificationEvents.some((event) => event.fixture === "fixture-a" && event.mode === "ok-a"),
      "fixture A never completed account verification",
    );
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
    const releaseExtension = path.join(
      temporaryRoot,
      "release-derived-data",
      "Build",
      "Products",
      "Release-iphonesimulator",
      "Trace.app",
      "PlugIns",
      "Trace Extension.appex",
      "Trace Extension",
    );
    const releaseStrings = await run("strings", [releaseExtension], { quiet: true });
    assert.doesNotMatch(
      releaseStrings,
      /traceDebugSimulatorProviderCredential/,
      "simulator fixture credential seam leaked into the Release binary",
    );

    const summary = {
      schema: "trace.installed-ios-session-evidence/v1",
      recordedAt: new Date().toISOString(),
      sourceRevision,
      sourceTreeState: sourceStatus ? "dirty" : "clean",
      deviceId: DEVICE_ID,
      sessionMode: "kernel",
      journeys: [
        "signed-out Connect with no app credential",
        "verified Connect",
        "online Safari restart re-verification",
        "unavailable restart then Retry",
        "Disconnect",
        "same-provider rejection to reconnect-required",
        "explicit different-provider Reconnect",
        "missing-provider Reconnect",
      ],
      fixtureVerificationEvents: verificationEvents,
      releaseFixtureSeamPresent: false,
      keychainBoundary: "deferred to the required real-device/TestFlight release-candidate smoke",
    };
    fs.writeFileSync(
      path.join(EVIDENCE_ROOT, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    succeeded = true;
    console.log(`Installed iOS session lifecycle passed. Evidence: ${EVIDENCE_ROOT}`);
  } finally {
    await closeServer(server);
    if (succeeded) {
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
