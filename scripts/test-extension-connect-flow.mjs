#!/usr/bin/env node

// Installed Chromium check of the connect journeys a reader sees on an archive
// page. A local stand-in for the Trace website plays the signed-in page's part
// of the handshake: it answers token requests only after "Sign in" and posts
// its usual signed-in announcement. No real account or credential is used.

import assert from "node:assert/strict";
import { deviceSessionFixture } from "./device-session-test-fixture.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "chrome");
const SIGNED_IN_COOKIE = "trace_fixture_signed_in=1";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
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
    env: { ...process.env, TRACE_API_BASE: origin, TRACE_WEB_ORIGIN: origin },
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

async function sendSession(page, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await page.evaluate((runtimeMessage) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(runtimeMessage, (response) => {
          const text = chrome.runtime.lastError?.message;
          if (text) reject(new Error(text));
          else resolve(response);
        });
      }), message);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("session runtime did not respond");
}

async function sessionState(controlPage) {
  const response = await sendSession(controlPage, { type: "TRACE_SESSION_GET_SNAPSHOT" });
  return response?.snapshot?.state;
}

let trackCount = 0;
const savedWorkKeys = new Set();

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
  });
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

// The page half of the website handshake, as the signed-in Trace web app runs
// it: a token request with a request ID gets a reply, a signed-in page posts
// its token once on load, and the first-install page announces readiness.
const SIGNED_IN_SCRIPT = `
  const token = "kernel-connect-token";
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type === "TRACE_FICTION_TOKEN_REQUEST") {
      window.postMessage({
        type: "TRACE_FICTION_TOKEN",
        token,
        ...(data.reason === "credential_grant" && data.protocolVersion === 1
          ? { protocolVersion: 1, requestId: data.requestId }
          : {}),
      }, window.location.origin);
      return;
    }
    if (data?.type === "TRACE_EXTENSION_STATUS_READY") announceActivation();
  });
  function announceActivation() {
    const url = new URL(window.location.href);
    if (url.pathname !== "/" || url.searchParams.get("activation") !== "extension-installed") return;
    window.postMessage({ type: "TRACE_EXTENSION_FIRST_INSTALL_READY", protocolVersion: 1 }, window.location.origin);
  }
  document.body.dataset.signedIn = "true";
  window.postMessage({ type: "TRACE_FICTION_TOKEN", token }, window.location.origin);
  announceActivation();
`;

function tracePage(request) {
  const url = new URL(request.url, "http://fixture.invalid");
  const signedIn = (request.headers.cookie ?? "").includes(SIGNED_IN_COOKIE);
  if (url.pathname === "/auth/callback") {
    // Like an OAuth return: the browser lands on the callback, then the app
    // replaces the URL with where the reader started and signs them in.
    const returnTo = url.searchParams.get("returnTo") || "/";
    return {
      headers: { "Set-Cookie": `${SIGNED_IN_COOKIE}; Path=/` },
      body: `<!doctype html><title>Trace</title><body><script>
        setTimeout(() => {
          history.replaceState(null, "", ${JSON.stringify(returnTo)});
          ${SIGNED_IN_SCRIPT}
        }, 400);
      </script></body>`,
    };
  }
  if (signedIn) {
    return {
      headers: {},
      body: `<!doctype html><title>Trace</title><body><script>
        setTimeout(() => { ${SIGNED_IN_SCRIPT} }, 200);
      </script></body>`,
    };
  }
  return {
    headers: {},
    body: `<!doctype html><title>Trace</title><body data-signed-in="false">
      <button id="sign-in" type="button">Sign in</button>
      <script>
        document.getElementById("sign-in").addEventListener("click", () => {
          const returnTo = window.location.pathname + window.location.search;
          window.location.assign("/auth/callback?returnTo=" + encodeURIComponent(returnTo));
        });
      </script></body>`,
  };
}

const deviceSessions = deviceSessionFixture();
const server = http.createServer(async (request, response) => {
  if (await deviceSessions(request, response)) return;
  const authorized = (request.headers.authorization ?? "").startsWith("Bearer kernel-");
  if (request.url === "/api/extension/account") {
    if (!authorized) return json(response, 401, { error: "unauthorized" });
    return json(response, 200, { account_id: "connect-flow-account" });
  }
  if (request.url === "/api/extension/library-overlay") {
    if (!authorized) return json(response, 401, { error: "unauthorized" });
    return json(response, 200, {
      success: true,
      data: { entries: {}, workPreferences: {}, syncVersion: "2026-10-04T09:00:00.000Z" },
    });
  }
  if (request.url === "/api/extension/track" && request.method === "POST") {
    if (!authorized) return json(response, 401, { error: "unauthorized" });
    const payload = JSON.parse(await readBody(request));
    const match = String(payload.item?.u ?? "").match(/\/works\/(\d+)/);
    assert.ok(match, `unexpected track URL ${payload.item?.u}`);
    const workKey = `ao3:${match[1]}`;
    trackCount += 1;
    savedWorkKeys.add(workKey);
    const entryId = `00000000-0000-4000-8000-${String(trackCount).padStart(12, "0")}`;
    return json(response, 200, {
      success: true,
      data: {
        entry_id: entryId,
        type: "created",
        work_key: workKey,
        entry: {
          status: "PLANNING",
          readerStatus: "PLANNING",
          canonicalReaderStatus: "SAVED",
          entryId,
          chapters: { current: 0, total: 1 },
        },
        syncVersion: `2026-10-04T09:0${trackCount}:00.000Z`,
      },
    });
  }
  if (request.url === "/api/extension/ao3-saved-filters/sync") {
    await readBody(request);
    const at = "2026-10-04T09:00:00.000Z";
    return json(response, 200, {
      success: true,
      data: { serverTime: at, syncVersion: at, presets: [], deleted: [] },
    });
  }
  if (request.url?.startsWith("/api/")) {
    await readBody(request);
    return json(response, 200, { success: true, data: {} });
  }
  const page = tracePage(request);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...page.headers });
  response.end(page.body);
});

let context = null;
let userDataDirectory = null;

try {
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  if (process.env.TRACE_CONNECT_FLOW_SKIP_BUILD !== "1") buildKernel(origin);

  userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "trace-connect-chrome-"));
  // Full Chromium's new headless mode loads extensions, so the run stays off
  // screen. TRACE_CONNECT_FLOW_HEADED=1 shows the browser for debugging.
  context = await chromium.launchPersistentContext(userDataDirectory, {
    channel: "chromium",
    headless: process.env.TRACE_CONNECT_FLOW_HEADED !== "1",
    serviceWorkers: "allow",
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
    ],
  });
  const ao3Listing = fs.readFileSync(path.join(ROOT, "test", "fixtures", "ao3_listing.html"), "utf8");
  const ao3Story = fs.readFileSync(path.join(ROOT, "test", "fixtures", "ao3_story.html"), "utf8");
  await context.route("https://archiveofourown.org/**", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.abort();
      return;
    }
    const isStory = /\/works\/\d+/.test(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: isStory ? ao3Story : ao3Listing,
    });
  });

  // 1. Fresh install: the extension opens its setup page on the Trace site.
  //    The reader is signed out there and signs in on that same tab.
  let activationPage = null;
  await waitFor(() => {
    activationPage = context.pages().find((page) => (
      page.url().includes("activation=extension-installed")
    )) ?? null;
    return activationPage !== null;
  }, "the first-install Trace setup page");
  const worker = await extensionWorker(context);
  const extensionId = new URL(worker.url()).host;
  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await activationPage.bringToFront();
  await activationPage.locator("#sign-in").waitFor({ state: "visible" });
  // An AO3 tab the reader already has open before finishing sign-in.
  const listingPage = await context.newPage();
  await listingPage.goto("https://archiveofourown.org/tags/Naruto/works", { waitUntil: "domcontentloaded" });
  await listingPage.locator("[data-trace-connect-notice]").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await sessionState(controlPage), "signed_out");
  // The signed-out setup page is the public landing page. Following one of
  // its links (How it works, Privacy, Setup) leaves the setup address, so
  // signing in afterwards returns somewhere else.
  await activationPage.bringToFront();
  await activationPage.goto(`${origin}/landing#how`);
  await activationPage.locator("#sign-in").click();
  await activationPage.waitForFunction(() => document.body?.dataset.signedIn === "true");
  await waitFor(async () => (await sessionState(controlPage)) === "connected", "connection after signing in on the setup page");
  await waitFor(
    async () => (await listingPage.locator("[data-trace-connect-notice]").count()) === 0 &&
      (await listingPage.locator("[data-trace-quick-add]").count()) > 0,
    "AO3 listing showing connected without a refresh",
  );
  console.log("install: signing in on the setup tab (after leaving its address) connected, and AO3 updated in place");

  // 2. Signed in on Trace but the extension is disconnected, with no Trace tab
  //    open. The notice's Connect opens Trace, which completes the handshake.
  await sendSession(controlPage, { type: "TRACE_SESSION_ACTION", action: "disconnect" });
  assert.equal(await sessionState(controlPage), "signed_out");
  await activationPage.close();
  await listingPage.bringToFront();
  const notice = listingPage.locator("[data-trace-connect-notice]");
  await notice.waitFor({ state: "visible", timeout: 15_000 });
  const pagesBefore = context.pages().length;
  await notice.locator("[data-trace-connect-notice-cta]").click();
  await waitFor(async () => (await sessionState(controlPage)) === "connected", "connection from the notice");
  await waitFor(
    async () => (await notice.count()) === 0 &&
      (await listingPage.locator("[data-trace-quick-add]").count()) > 0,
    "AO3 listing showing connected after the notice's Connect",
  );
  const openedTracePages = context.pages().filter((page) => page.url().startsWith(origin));
  assert.ok(context.pages().length > pagesBefore, "Connect must open Trace when no Trace tab is open");
  await waitFor(async () => controlPage.evaluate(() => new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]?.url?.includes("/tags/Naruto/works")));
  })), "return to the originating archive tab");
  console.log(`notice (no Trace tab): connected without a refresh; ${openedTracePages.length} Trace tab open`);

  // 3. Disconnected again, a signed-in Trace tab already open: Connect uses it
  //    without opening another one.
  await sendSession(controlPage, { type: "TRACE_SESSION_ACTION", action: "disconnect" });
  await listingPage.bringToFront();
  await notice.waitFor({ state: "visible", timeout: 15_000 });
  const pagesBeforeSecond = context.pages().length;
  await notice.locator("[data-trace-connect-notice-cta]").click();
  await waitFor(async () => (await sessionState(controlPage)) === "connected", "connection through the open Trace tab");
  await waitFor(async () => (await notice.count()) === 0, "notice removed after connecting");
  assert.equal(context.pages().length, pagesBeforeSecond, "an open signed-in Trace tab must be reused");
  console.log("notice (Trace tab open): connected through the open tab, no new tab");

  // ...and a story saves from the listing.
  const quickAdd = listingPage.locator("[data-trace-quick-add]").first();
  await quickAdd.click();
  await waitFor(() => trackCount === 1, "listing save after connecting");
  console.log(`listing save: ${[...savedWorkKeys].join(", ")}`);

  // 4. Story page while disconnected: its Connect runs the same flow, then the
  //    story saves.
  await sendSession(controlPage, { type: "TRACE_SESSION_ACTION", action: "disconnect" });
  await controlPage.evaluate(() => new Promise((resolve) => {
    chrome.storage.local.set({ prefAutoTrackEnabled: false }, resolve);
  }));
  for (const page of context.pages().filter(page => page.url().startsWith(origin))) await page.close();
  const storyPage = await context.newPage();
  await storyPage.goto("https://archiveofourown.org/works/28534965", { waitUntil: "domcontentloaded" });
  const handle = storyPage.locator("[data-trace-story-handle]");
  await handle.waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(async () => /connect/i.test(await handle.innerText()), "story handle offering Connect");
  await storyPage.evaluate(() => {
    document.body.style.minHeight = "5000px";
    window.traceReadingMarker = "same-document";
    window.scrollTo(0, 900);
    document.addEventListener("click", event => {
      if (event.target.closest("[data-trace-story-connect]")) window.traceBeforeConnectScroll = window.scrollY;
    }, true);
  });
  await handle.click();
  const sheetConnect = storyPage.locator("[data-trace-story-connect]");
  await sheetConnect.waitFor({ state: "visible", timeout: 10_000 });
  await sheetConnect.click();
  await waitFor(async () => (await sessionState(controlPage)) === "connected", "connection from the story page");
  await waitFor(async () => controlPage.evaluate(() => new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]?.url?.includes("/works/28534965")));
  })), "return to the existing story tab");
  assert.equal(await storyPage.evaluate(() => window.traceReadingMarker), "same-document");
  const position = await storyPage.evaluate(() => ({ before: window.traceBeforeConnectScroll, after: window.scrollY }));
  assert.ok(position.before > 0, "the story was scrolled when Connect was pressed");
  assert.equal(position.after, position.before);
  await waitFor(async () => /add to trace/i.test(await handle.innerText()), "story handle offering Add after connecting");
  await handle.click();
  await waitFor(() => trackCount === 2, "story save after connecting");
  assert.ok(savedWorkKeys.has("ao3:28534965"));
  console.log("story page: Connect connected in place and the story saved");

  console.log("connect flow passed");
} finally {
  if (context) await context.close();
  await closeServer(server);
  if (userDataDirectory) fs.rmSync(userDataDirectory, { recursive: true, force: true });
}
