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
const LEGACY_KEYS = [
  "traceSessionEnvelopeV1",
  "traceSessionCredentialsV1",
  "authToken",
  "traceAuthState",
  "traceAccountId",
  "libraryOverlayCache",
  "libraryOverlayFetchedAt",
  "traceWorkStatesV1",
  "traceUserPro",
  "traceLibraryCount",
  "traceFirstSaveSeen",
  "traceAo3SavedFiltersV1",
  "traceAo3SavedFiltersDeletedV1",
  "traceAo3SavedFiltersSyncV1",
  "traceAo3SavedFiltersClientIdV1",
  "traceAo3SavedFiltersActiveV1",
];

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

function buildKernel(origin) {
  const result = spawnSync("npm", ["run", "build:kernel"], {
    cwd: ROOT,
    env: {
      ...process.env,
      TRACE_API_BASE: origin,
      TRACE_WEB_ORIGIN: origin,
    },
    encoding: "utf8",
    stdio: "inherit",
  });
  assert.equal(result.status, 0, result.error?.message ?? "kernel build failed");
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

async function sendSession(page, message, { retries = 40 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await page.evaluate((runtimeMessage) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(runtimeMessage, (response) => {
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
  throw lastError ?? new Error("session runtime did not respond");
}

async function storage(page, method, value) {
  return page.evaluate(({ storageMethod, storageValue }) => new Promise((resolve, reject) => {
    chrome.storage.local[storageMethod](storageValue, (result) => {
      const message = chrome.runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve(result);
    });
  }), { storageMethod: method, storageValue: value });
}

async function privateRecord(page, key) {
  return page.evaluate((recordKey) => new Promise((resolve, reject) => {
    const opening = indexedDB.open("traceKernelPrivateV1", 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains("records")) {
        opening.result.createObjectStore("records");
      }
    };
    opening.onerror = () => reject(opening.error ?? new Error("private database open failed"));
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction("records", "readonly");
      const request = transaction.objectStore("records").get(recordKey);
      request.onerror = () => reject(request.error ?? new Error("private record read failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("private read aborted"));
      transaction.oncomplete = () => {
        database.close();
        resolve(request.result ?? null);
      };
    };
  }), key);
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
  if (request.url === "/api/account/me") {
    verificationCount += 1;
    const authorization = request.headers.authorization ?? "";
    if (authorization === "Bearer kernel-delay-token") {
      delayedVerificationSeen.resolve();
      await delayedVerificationRelease.promise;
    }
    if (!authorization.startsWith("Bearer kernel-")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ account_id: "kernel-account-a" }));
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <title>Trace credential fixture</title>
    <script>
      window.traceCredential = "kernel-connect-token";
      window.addEventListener("message", (event) => {
        if (event.origin !== window.location.origin) return;
        const request = event.data;
        if (request?.type !== "TRACE_FICTION_TOKEN_REQUEST") return;
        if (request.protocolVersion !== 1 || typeof request.requestId !== "string") return;
        window.postMessage({
          type: "TRACE_FICTION_TOKEN",
          protocolVersion: 1,
          requestId: request.requestId,
          token: window.traceCredential,
        }, window.location.origin);
      });
    </script>`);
});

let context = null;
let userDataDirectory = null;

try {
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  buildKernel(origin);

  const executablePath = chromium.executablePath();
  assert.equal(
    fs.existsSync(executablePath),
    true,
    "Playwright Chromium is missing; run npm run visual:install-browsers",
  );
  userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trace-kernel-chrome-"));
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    serviceWorkers: "allow",
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
    ],
  });

  let worker = await extensionWorker(context);
  const extensionId = new URL(worker.url()).host;
  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const tracePage = await context.newPage();
  await tracePage.goto(origin);

  const initial = await sendSession(controlPage, { type: "TRACE_SESSION_GET_SNAPSHOT" });
  assert.equal(initial.snapshot.state, "signed_out");

  const legacySeed = Object.fromEntries(LEGACY_KEYS.map((key) => [key, "stale-value"]));
  await storage(controlPage, "set", legacySeed);
  await terminateWorker(context, controlPage, worker);
  const afterUpgrade = await sendSession(controlPage, { type: "TRACE_SESSION_GET_SNAPSHOT" });
  assert.equal(afterUpgrade.snapshot.state, "signed_out");
  await waitFor(async () => {
    const snapshot = await storage(controlPage, "get", LEGACY_KEYS);
    return Object.keys(snapshot).length === 0;
  }, "legacy account state cleanup");

  const connected = await sendSession(controlPage, {
    type: "TRACE_SESSION_ACTION",
    action: "connect",
  });
  assert.equal(connected.action.kind, "completed");
  assert.equal(connected.snapshot.state, "connected");
  assert.equal(connected.snapshot.canExecuteAuthenticated, true);
  assert.equal(verificationCount, 1);
  assert.equal((await privateRecord(controlPage, "session-envelope")).desired, "connected");
  assert.equal(
    Object.keys((await privateRecord(controlPage, "session-credentials")).entries).length,
    1,
  );

  worker = await extensionWorker(context);
  await terminateWorker(context, controlPage, worker);
  const restarted = await sendSession(controlPage, { type: "TRACE_SESSION_GET_SNAPSHOT" });
  assert.equal(restarted.snapshot.state, "connected");
  assert.equal(restarted.snapshot.canExecuteAuthenticated, true);
  assert.equal(verificationCount, 2, "online restart must reverify");

  worker = await extensionWorker(context);
  await context.setOffline(true);
  await terminateWorker(context, controlPage, worker);
  const offlineRestart = await sendSession(controlPage, { type: "TRACE_SESSION_GET_SNAPSHOT" });
  assert.equal(offlineRestart.snapshot.state, "degraded");
  assert.equal(offlineRestart.snapshot.canExecuteAuthenticated, false);
  await context.setOffline(false);
  const recovered = await sendSession(controlPage, {
    type: "TRACE_SESSION_ACTION",
    action: "retry",
  });
  assert.equal(recovered.snapshot.state, "connected");
  assert.equal(recovered.snapshot.canExecuteAuthenticated, true);

  const signedOut = await sendSession(controlPage, {
    type: "TRACE_SESSION_ACTION",
    action: "disconnect",
  });
  assert.equal(signedOut.snapshot.state, "signed_out");
  await waitFor(async () => {
    return await privateRecord(controlPage, "session-credentials") === null;
  }, "extension-owned credential cleanup");

  await tracePage.evaluate(() => {
    window.traceCredential = "kernel-delay-token";
  });
  const delayedConnect = sendSession(controlPage, {
    type: "TRACE_SESSION_ACTION",
    action: "connect",
  });
  await delayedVerificationSeen.promise;
  const disconnectedDuringVerification = await sendSession(controlPage, {
    type: "TRACE_SESSION_ACTION",
    action: "disconnect",
  });
  assert.equal(disconnectedDuringVerification.snapshot.state, "signed_out");
  delayedVerificationRelease.resolve();
  const staleConnect = await delayedConnect;
  assert.deepEqual(staleConnect.action, { kind: "stale" });
  assert.equal(staleConnect.snapshot.state, "signed_out");

  const envelope = await privateRecord(controlPage, "session-envelope");
  assert.equal(envelope.desired, "disconnected");
  assert.equal(await privateRecord(controlPage, "session-credentials"), null);
  const stored = await storage(controlPage, "get", LEGACY_KEYS);
  assert.deepEqual(Object.keys(stored), []);
  console.log(`kernel lifecycle passed (${verificationCount} verification reads)`);
} finally {
  delayedVerificationRelease.resolve();
  if (context) await context.close();
  await closeServer(server);
  if (userDataDirectory) fs.rmSync(userDataDirectory, { recursive: true, force: true });
}
