#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "chrome");
const CONTROL = Object.freeze({
  status: "TRACE_SHADOW_TEST_STATUS",
  connect: "TRACE_SHADOW_TEST_CONNECT",
  disconnect: "TRACE_SHADOW_TEST_DISCONNECT",
  retry: "TRACE_SHADOW_TEST_RETRY",
  compare: "TRACE_SHADOW_TEST_COMPARE",
  failCredentialDelete: "TRACE_SHADOW_TEST_FAIL_CREDENTIAL_DELETE",
  reset: "TRACE_SHADOW_TEST_RESET",
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${label}`);
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

function buildShadow(apiBase) {
  const result = spawnSync("npm", ["run", "build:shadow"], {
    cwd: ROOT,
    env: {
      ...process.env,
      TRACE_API_BASE: apiBase,
      TRACE_WEB_ORIGIN: apiBase,
    },
    encoding: "utf8",
    stdio: "inherit",
  });
  assert.equal(result.status, 0, result.error?.message ?? "shadow build failed");
}

async function extensionWorker(context) {
  const existing = context.serviceWorkers().find((worker) => (
    worker.url().startsWith("chrome-extension://")
  ));
  return existing ?? context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith("chrome-extension://"),
    timeout: 15_000,
  });
}

async function sendControl(page, message, { retries = 40 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await page.evaluate((controlMessage) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(controlMessage, (response) => {
          const messageText = chrome.runtime.lastError?.message;
          if (messageText) {
            reject(new Error(messageText));
            return;
          }
          resolve(response);
        });
      }), message);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("shadow control did not respond");
}

async function terminateWorker(context, page, worker) {
  const client = await context.newCDPSession(page);
  try {
    await client.send("ServiceWorker.enable");
    await client.send("ServiceWorker.stopAllWorkers");
  } catch {
    const { targetInfos } = await client.send("Target.getTargets");
    const target = targetInfos.find((candidate) => (
      candidate.type === "service_worker" && candidate.url === worker.url()
    ));
    assert.ok(target, "extension service worker target not found");
    await client.send("Target.closeTarget", { targetId: target.targetId });
  } finally {
    await client.detach();
  }
  await delay(250);
}

const delayedVerificationSeen = deferred();
const delayedVerificationRelease = deferred();
let verificationCount = 0;

const server = http.createServer(async (request, response) => {
  if (request.url !== "/api/account/me") {
    response.writeHead(404).end();
    return;
  }
  verificationCount += 1;
  const authorization = request.headers.authorization ?? "";
  if (authorization === "Bearer shadow-delay-token") {
    delayedVerificationSeen.resolve();
    await delayedVerificationRelease.promise;
  }
  if (!authorization.startsWith("Bearer shadow-")) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ account_id: "shadow-account-a" }));
});

let context = null;
let userDataDirectory = null;

try {
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const apiBase = `http://127.0.0.1:${address.port}`;
  buildShadow(apiBase);

  const executablePath = chromium.executablePath();
  assert.equal(
    fs.existsSync(executablePath),
    true,
    "Playwright Chromium is missing; run npm run visual:install-browsers",
  );
  userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trace-shadow-chrome-"));
  context = await chromium.launchPersistentContext(userDataDirectory, {
    // Chromium's headless shell does not load extensions. This still uses
    // Playwright's managed browser and an isolated temporary profile.
    headless: false,
    serviceWorkers: "allow",
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
    ],
  });

  let worker = await extensionWorker(context);
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/shadow-control.html`);

  const initial = await sendControl(page, { type: CONTROL.status });
  assert.equal(initial.ok, true);
  assert.equal(initial.snapshot.state, "signed_out");

  const connected = await sendControl(page, {
    type: CONTROL.connect,
    credential: "shadow-connect-token",
  });
  assert.equal(connected.ok, true);
  assert.equal(connected.snapshot.state, "connected");
  assert.equal(connected.snapshot.canExecuteAuthenticated, true);
  assert.equal(verificationCount, 1);
  const comparison = await sendControl(page, {
    type: CONTROL.compare,
    expected: {
      state: "connected",
      accountId: "shadow-account-a",
      canExecuteAuthenticated: true,
    },
  });
  assert.equal(comparison.matches, true);

  await terminateWorker(context, page, worker);
  const restarted = await sendControl(page, { type: CONTROL.status });
  assert.equal(restarted.snapshot.state, "connected");
  assert.equal(restarted.snapshot.canExecuteAuthenticated, true);
  assert.equal(verificationCount, 2, "online restart must reverify");
  worker = await extensionWorker(context);

  await context.setOffline(true);
  await terminateWorker(context, page, worker);
  const offlineRestart = await sendControl(page, { type: CONTROL.status });
  assert.equal(offlineRestart.snapshot.state, "degraded");
  assert.equal(offlineRestart.snapshot.canExecuteAuthenticated, false);
  await context.setOffline(false);
  const recovered = await sendControl(page, { type: CONTROL.retry });
  assert.equal(recovered.snapshot.state, "connected");
  assert.equal(recovered.snapshot.canExecuteAuthenticated, true);

  const signedOut = await sendControl(page, { type: CONTROL.disconnect });
  assert.equal(signedOut.snapshot.state, "signed_out");
  const connecting = sendControl(page, {
    type: CONTROL.connect,
    credential: "shadow-delay-token",
  });
  await delayedVerificationSeen.promise;
  const disconnectedDuringVerification = await sendControl(page, {
    type: CONTROL.disconnect,
  });
  assert.equal(disconnectedDuringVerification.snapshot.state, "signed_out");
  delayedVerificationRelease.resolve();
  const lateConnect = await connecting;
  assert.deepEqual(lateConnect.action, { kind: "stale" });
  assert.equal(lateConnect.snapshot.state, "signed_out");

  await sendControl(page, {
    type: CONTROL.connect,
    credential: "shadow-cleanup-token",
  });
  await sendControl(page, { type: CONTROL.failCredentialDelete });
  const cleanupFailure = await sendControl(page, { type: CONTROL.disconnect });
  assert.equal(cleanupFailure.snapshot.state, "signed_out");
  assert.equal(cleanupFailure.storage.credentialReferenceCount, 1);
  assert.equal(
    cleanupFailure.diagnostics.some(({ code }) => code === "credential_cleanup_failed"),
    true,
  );

  const reset = await sendControl(page, { type: CONTROL.reset });
  assert.deepEqual(reset.storage, {
    sessionPresent: false,
    credentialReferenceCount: 0,
  });
  const shadowKeys = await page.evaluate(() => new Promise((resolve, reject) => {
    chrome.storage.local.get(
      ["traceShadowSessionV1", "traceShadowCredentialV1"],
      (snapshot) => {
        const message = chrome.runtime.lastError?.message;
        if (message) reject(new Error(message));
        else resolve(Object.keys(snapshot));
      },
    );
  }));
  assert.deepEqual(shadowKeys, []);

  const diagnosticJson = JSON.stringify(cleanupFailure.diagnostics);
  assert.equal(diagnosticJson.includes("shadow-cleanup-token"), false);
  assert.equal(diagnosticJson.includes("shadow-account-a"), false);
  console.log(`shadow lifecycle passed (${verificationCount} verification reads)`);
} finally {
  delayedVerificationRelease.resolve();
  if (context) await context.close();
  await closeServer(server);
  if (userDataDirectory) fs.rmSync(userDataDirectory, { recursive: true, force: true });
}
