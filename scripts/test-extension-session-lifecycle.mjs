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
const LEGACY_ACCOUNT_KEYS = [
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
let overlayReadCount = 0;
let libraryPatchCount = 0;
let firstStoryTrackCount = 0;
let metadataContributionCount = 0;
let savedFilterSyncCount = 0;
let installedRating = 0;
const installedEntryId = "00000000-0000-4000-8000-000000000123";

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

  if (request.url === "/api/extension/library-overlay") {
    overlayReadCount += 1;
    if (!(request.headers.authorization ?? "").startsWith("Bearer kernel-")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      success: true,
      data: {
        entries: {
          "ffn:7038840": {
            status: "READING",
            readerStatus: "READING",
            canonicalReaderStatus: "READING",
            entryId: installedEntryId,
            chapters: { current: 2, total: 12 },
            rating: installedRating,
          },
        },
        workPreferences: {},
        syncVersion: `2026-07-20T09:00:0${installedRating}.000Z`,
      },
    }));
    return;
  }

  if (
    request.url === `/api/library/${installedEntryId}` &&
    request.method === "PATCH"
  ) {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const patch = JSON.parse(body);
    assert.equal(patch.rating, 5);
    installedRating = patch.rating;
    libraryPatchCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: { entry_id: installedEntryId } }));
    return;
  }

  if (request.url === "/api/extension/track" && request.method === "POST") {
    assert.equal(
      (request.headers.authorization ?? "").startsWith("Bearer kernel-"),
      true,
    );
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.item.ctx, "story");
    assert.match(payload.item.u, /\/s\/999999\/?$/);
    firstStoryTrackCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      success: true,
      data: {
        entry_id: "00000000-0000-4000-8000-000000000999",
        type: "created",
        work_key: "ffn:999999",
        entry: {
          status: "PLANNING",
          readerStatus: "PLANNING",
          canonicalReaderStatus: "SAVED",
          entryId: "00000000-0000-4000-8000-000000000999",
          chapters: { current: 0, total: 12 },
        },
        syncVersion: "2026-07-20T09:10:00.000Z",
      },
    }));
    return;
  }

  if (request.url === "/api/extension/metadata" && request.method === "POST") {
    assert.equal(
      (request.headers.authorization ?? "").startsWith("Bearer kernel-"),
      true,
    );
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.item.ctx, "story");
    assert.equal(payload.item.u, "https://www.fanfiction.net/s/7038840/");
    metadataContributionCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      success: true,
      data: { story_id: 7038840 },
    }));
    return;
  }

  if (
    request.url === "/api/extension/ao3-saved-filters/sync" &&
    request.method === "POST"
  ) {
    assert.equal(
      (request.headers.authorization ?? "").startsWith("Bearer kernel-"),
      true,
    );
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.deepEqual(payload.deletes, []);
    if (payload.upserts.length === 0) {
      const at = "2026-07-20T09:19:00.000Z";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        success: true,
        data: {
          serverTime: at,
          syncVersion: at,
          presets: [],
          deleted: [],
        },
      }));
      return;
    }
    assert.equal(payload.upserts.length, 1);
    assert.equal(payload.upserts[0].name, "Installed AO3 filter");
    assert.deepEqual(payload.upserts[0].params, [
      ["work_search[sort_column]", "kudos_count"],
    ]);
    savedFilterSyncCount += 1;
    const at = "2026-07-20T09:20:00.000Z";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      success: true,
      data: {
        serverTime: at,
        syncVersion: at,
        presets: [{
          ...payload.upserts[0],
          id: "00000000-0000-4000-8000-000000000777",
          updatedAt: at,
        }],
        deleted: [],
      },
    }));
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
  const installedStoryHtml = fs.readFileSync(
    path.join(ROOT, "test", "fixtures", "ffn_story.html"),
    "utf8",
  );
  const installedAo3ListingHtml = fs.readFileSync(
    path.join(ROOT, "test", "fixtures", "ao3_listing.html"),
    "utf8",
  );
  await context.route("https://www.fanfiction.net/**", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: installedStoryHtml,
    });
  });
  await context.route("https://archiveofourown.org/**", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: installedAo3ListingHtml,
    });
  });

  let worker = await extensionWorker(context);
  const extensionId = new URL(worker.url()).host;
  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const tracePage = await context.newPage();
  await tracePage.goto(origin);

  const initial = await sendSession(controlPage, { type: "TRACE_SESSION_GET_SNAPSHOT" });
  assert.equal(initial.snapshot.state, "signed_out");

  const legacySeed = Object.fromEntries(
    LEGACY_ACCOUNT_KEYS.map((key) => [key, "stale-value"]),
  );
  await storage(controlPage, "set", legacySeed);
  await terminateWorker(context, controlPage, worker);
  const afterUpgrade = await sendSession(controlPage, { type: "TRACE_SESSION_GET_SNAPSHOT" });
  assert.equal(afterUpgrade.snapshot.state, "signed_out");
  await waitFor(async () => {
    const snapshot = await storage(controlPage, "get", LEGACY_ACCOUNT_KEYS);
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

  const savedFilterPage = await context.newPage();
  await savedFilterPage.goto(
    "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&tag_id=Naruto",
    { waitUntil: "domcontentloaded" },
  );
  const savedFilterRoot = savedFilterPage.locator(
    "[data-trace-ao3-saved-filters]",
  );
  await savedFilterRoot.waitFor({ state: "visible", timeout: 10_000 });
  await savedFilterRoot.locator(
    "[data-trace-sf-action='save-open']",
  ).click();
  await savedFilterRoot.locator("[data-trace-sf-name]").fill(
    "Installed AO3 filter",
  );
  await savedFilterRoot.locator(
    "[data-trace-sf-action='save-confirm']",
  ).click();
  await waitFor(async () => {
    const saved = await storage(
      controlPage,
      "get",
      "traceAo3SavedFiltersV1",
    );
    return (
      savedFilterSyncCount === 1 &&
      saved.traceAo3SavedFiltersV1?.[0]?.dirty === false &&
      saved.traceAo3SavedFiltersV1?.[0]?.serverId ===
        "00000000-0000-4000-8000-000000000777"
    );
  }, "installed Chromium AO3 saved-filter sync");
  await savedFilterPage.close();

  await storage(controlPage, "set", {
    prefAutoTrackEnabled: false,
    prefMetadataImproveEnabled: false,
  });
  const handoffUrl =
    "https://www.fanfiction.net/s/999999/1/First-Story-Handoff";
  const [handoffPage, handoffResponse] = await Promise.all([
    context.waitForEvent("page"),
    tracePage.evaluate((url) => new Promise((resolve, reject) => {
      const nonce = "installed_desktop_handoff";
      const timeout = window.setTimeout(
        () => reject(new Error("first-story handoff response timed out")),
        15_000,
      );
      const onMessage = (event) => {
        if (event.origin !== window.location.origin) return;
        if (
          event.data?.type !== "TRACE_FIRST_STORY_ADD_RESPONSE" ||
          event.data?.nonce !== nonce
        ) {
          return;
        }
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({
        type: "TRACE_FIRST_STORY_ADD_REQUEST",
        nonce,
        url,
      }, window.location.origin);
    }), handoffUrl),
  ]);
  assert.deepEqual(
    {
      ok: handoffResponse.ok,
      state: handoffResponse.state,
    },
    { ok: true, state: "saved" },
  );
  assert.equal(firstStoryTrackCount, 1);
  await handoffPage.close();

  await storage(controlPage, "set", { prefMetadataImproveEnabled: true });
  const archivePage = await context.newPage();
  await archivePage.goto(
    "https://www.fanfiction.net/s/7038840/2/A-Chance-Encounter",
    { waitUntil: "domcontentloaded" },
  );
  const storyHandle = archivePage.locator("[data-trace-story-handle]");
  await storyHandle.waitFor({ state: "visible", timeout: 10_000 });
  await storyHandle.click();
  const ratingFive = archivePage.locator("[data-trace-rating-choice='5']");
  await ratingFive.waitFor({ state: "visible", timeout: 10_000 });
  await ratingFive.click();
  await waitFor(
    () => (
      libraryPatchCount === 1 &&
      installedRating === 5 &&
      overlayReadCount >= 2 &&
      metadataContributionCount === 1
    ),
    "installed Chromium authoritative library mutation and metadata contribution",
  );
  assert.equal(libraryPatchCount, 1, "installed mutation must write exactly once");
  assert.equal(
    metadataContributionCount,
    1,
    "installed metadata contribution must write exactly once",
  );
  await archivePage.close();

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
  const queuedDisconnect = sendSession(controlPage, {
    type: "TRACE_SESSION_ACTION",
    action: "disconnect",
  });
  delayedVerificationRelease.resolve();
  const staleConnect = await delayedConnect;
  const disconnectedDuringVerification = await queuedDisconnect;
  assert.equal(staleConnect.action.kind, "completed");
  assert.equal(disconnectedDuringVerification.snapshot.state, "signed_out");

  const envelope = await privateRecord(controlPage, "session-envelope");
  assert.equal(envelope.desired, "disconnected");
  assert.equal(await privateRecord(controlPage, "session-credentials"), null);
  const stored = await storage(controlPage, "get", LEGACY_ACCOUNT_KEYS);
  assert.deepEqual(Object.keys(stored), []);
  console.log(
    `kernel lifecycle, AO3 saved-filter sync, desktop first-story handoff, ` +
    `metadata contribution, and library mutation passed ` +
    `(${verificationCount} verification reads, ` +
    `${overlayReadCount} projection reads)`,
  );
} finally {
  delayedVerificationRelease.resolve();
  if (context) await context.close();
  await closeServer(server);
  if (userDataDirectory) fs.rmSync(userDataDirectory, { recursive: true, force: true });
}
