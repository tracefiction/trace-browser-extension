#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { connectFirefox } from "./firefox-test-driver.mjs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firefox as playwrightFirefox } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYWRIGHT_FIREFOX = playwrightFirefox.executablePath();
const FIREFOX = process.env.TRACE_FIREFOX_BINARY ?? PLAYWRIGHT_FIREFOX;


function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  server.closeAllConnections();
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

function makeInstalledFixture(origin, fixtureRoot) {
  fs.cpSync(path.join(ROOT, "dist", "firefox"), fixtureRoot, { recursive: true });
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const fixtureUrl = new URL(origin);
  manifest.content_scripts.push({
    matches: [`${fixtureUrl.protocol}//${fixtureUrl.hostname}/*`],
    js: ["session-installed-test-driver.js"],
    run_at: "document_idle",
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  manifest.background.scripts.push("session-probe-background.js");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(fixtureRoot, "session-installed-test-driver.js"), `
    if (!sessionStorage.getItem("trace-session-proof")) {
      sessionStorage.setItem("trace-session-proof", "running");
      (async () => {
        const initial = await browser.runtime.sendMessage({ type: "TRACE_SESSION_GET_SNAPSHOT" });
        const connected = await browser.runtime.sendMessage({ type: "TRACE_SESSION_ACTION", action: "connect" });
        await browser.runtime.sendMessage({ type: "TRACE_TEST_RESTART", initial, connected });
      })().catch(error => fetch(${JSON.stringify(`${origin}/__trace_extension_result`)}, { method: "POST", body: JSON.stringify({ error: String(error) }) }));
    }
  `);
  fs.writeFileSync(path.join(fixtureRoot, "session-probe-background.js"), `
    browser.runtime.onMessage.addListener((message) => {
      if (message.type !== "TRACE_TEST_RESTART") return;
      return (async () => {
        await browser.storage.local.set({ traceTestProof: { initial: message.initial, connected: message.connected, phase: "restart" } });
        await fetch(${JSON.stringify(`${origin}/__expire_access_token`)}, { method: "POST" });
        const tabs = await browser.tabs.query({ url: ${JSON.stringify(origin + '/*')} });
        await browser.tabs.remove(tabs.map(tab => tab.id));
        browser.runtime.reload();
      })();
    });
    (async () => {
      const { traceTestProof } = await browser.storage.local.get("traceTestProof");
      if (traceTestProof?.phase !== "restart") return;
      await browser.storage.local.set({ traceTestProof: { ...traceTestProof, phase: "probe" } });
      await browser.tabs.create({ url: browser.runtime.getURL("popup.html") });
    })();
  `);
  fs.writeFileSync(path.join(fixtureRoot, "popup.html"), '<!doctype html><script src="session-probe-popup.js"></script>');
  fs.writeFileSync(path.join(fixtureRoot, "session-probe-popup.js"), `
    (async () => {
      const { traceTestProof } = await browser.storage.local.get("traceTestProof");
      const tabs = await browser.tabs.query({ url: ${JSON.stringify(origin + '/*')} });
      const restarted = await browser.runtime.sendMessage({ type: "TRACE_SESSION_GET_SNAPSHOT" });
      const disconnected = await browser.runtime.sendMessage({ type: "TRACE_SESSION_ACTION", action: "disconnect" });
      await fetch(${JSON.stringify(`${origin}/__trace_extension_result`)}, { method: "POST", body: JSON.stringify({ ...traceTestProof, restarted, disconnected, providerTabs: tabs.length }) });
    })().catch(error => fetch(${JSON.stringify(`${origin}/__trace_extension_result`)}, { method: "POST", body: JSON.stringify({ error: String(error) }) }));
  `);
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

assert.equal(
  fs.existsSync(FIREFOX),
  true,
  `Firefox binary not found: ${FIREFOX}. Run npx playwright install firefox.`,
);


const result = deferred();
let verificationReads = 0;
let accessExpired = false;
let issuanceCount = 0;
const deviceCredential = `trd_v1_${"a".repeat(43)}`;
const server = http.createServer((request, response) => {
  if (request.url === "/__expire_access_token") { accessExpired = true; response.writeHead(204); response.end(); return; }
  if (request.url === "/api/extension/session") { response.writeHead(200); response.end('{"ok":true}'); return; }
  if (request.url === "/api/extension/device-sessions") {
    if (accessExpired || request.headers.authorization !== "Bearer firefox-kernel-token") { response.writeHead(401); response.end(); return; }
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      const { installationId, platform } = JSON.parse(body);
      assert.equal(platform, "browser"); issuanceCount++;
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "issued", credential: deviceCredential, session: { installationId, id: "00000000-0000-4000-8000-000000000002", absoluteExpiresAt: "2099-01-01T00:00:00.000Z" } }));
    });
    return;
  }
  if (request.url === "/api/extension/account") {
    verificationReads += 1;
    if (request.headers.authorization !== `Bearer ${deviceCredential}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ account_id: "firefox-account-a" }));
    return;
  }

  if (request.url === "/__trace_extension_result" && request.method === "POST") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        result.resolve(JSON.parse(body));
      } catch (error) {
        result.reject(error);
      }
      response.writeHead(204);
      response.end();
    });
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <title>Trace Firefox installed credential fixture</title>
    <script>
      window.addEventListener("message", (event) => {
        if (event.origin !== window.location.origin) return;
        const request = event.data;
        if (request?.type !== "TRACE_FICTION_TOKEN_REQUEST") return;
        if (request.protocolVersion !== 1 || typeof request.requestId !== "string") return;
        window.postMessage({
          type: "TRACE_FICTION_TOKEN",
          protocolVersion: 1,
          requestId: request.requestId,
          token: "firefox-kernel-token",
        }, window.location.origin);
      });
      setTimeout(() => location.reload(), 1500);
    </script>`);
});

let webExt = null, driver = null, firefoxPid = null;
let fixtureParent = null;
try {
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  buildKernel(origin);

  fixtureParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trace-kernel-firefox-")));
  const fixtureRoot = path.join(fixtureParent, "extension");
  makeInstalledFixture(origin, fixtureRoot);

  const profile = path.join(fixtureParent, "profile");
  fs.mkdirSync(profile);
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  fs.writeFileSync(path.join(profile, "user.js"), `user_pref("marionette.port", ${port});\nuser_pref("browser.shell.checkDefaultBrowser", false);\n`);
  const args = ["-headless", "-no-remote", "-profile", profile, "-marionette", "about:blank"];
  const appBundle = process.platform === "darwin" ? FIREFOX.match(/^(.+\.app)\//)?.[1] : null;
  webExt = spawn(appBundle ? "/usr/bin/open" : FIREFOX,
    appBundle ? ["-n", "-g", "-W", "-a", appBundle, "--args", ...args] : args,
    { env: { ...process.env, MOZ_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let webExtOutput = "";
  for (const stream of [webExt.stdout, webExt.stderr]) stream.on("data", chunk => { webExtOutput += chunk; });
  try { driver = await connectFirefox(port); } catch (error) { throw Error(`${error.message}\n${webExtOutput}`); }
  const session = await driver.send("WebDriver:NewSession", { acceptInsecureCerts: true });
  firefoxPid = session.capabilities["moz:processID"];
  await driver.send("Addon:Install", { path: fixtureRoot, temporary: true });
  // The production first-install listener opens the Trace fixture tab.

  const installedResult = await Promise.race([
    result.promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Firefox installed smoke timed out\n${webExtOutput}`)),
      30_000,
    )),
  ]);
  assert.equal(installedResult.error, undefined, installedResult.error);
  assert.equal(installedResult.initial.snapshot.state, "signed_out");
  assert.equal(installedResult.connected.action.kind, "completed");
  assert.equal(installedResult.connected.snapshot.state, "connected");
  assert.equal(installedResult.connected.snapshot.canExecuteAuthenticated, true);
  assert.equal(installedResult.disconnected.action.kind, "completed");
  assert.equal(installedResult.disconnected.snapshot.state, "signed_out");
  assert.equal(installedResult.disconnected.snapshot.canExecuteAuthenticated, false);
  assert.equal(installedResult.providerTabs, 0);
  assert.equal(installedResult.restarted.snapshot.state, "connected");
  assert.equal(installedResult.restarted.snapshot.canExecuteAuthenticated, true);
  assert.equal(accessExpired, true);
  assert.equal(issuanceCount, 1);
  assert.equal(verificationReads, 2);
  console.log("Firefox installed: Connect, close Trace, expire website token, reload extension, remain connected, Disconnect passed");
} finally {
  if (driver) { await driver.send("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {}); driver.close(); }
  if (firefoxPid) { try { process.kill(firefoxPid, "SIGTERM"); } catch {} }
  if (webExt && webExt.exitCode === null && webExt.signalCode === null) {
    webExt.kill("SIGTERM");
    await waitForExit(webExt);
    if (webExt.exitCode === null && webExt.signalCode === null) webExt.kill("SIGKILL");
  }
  await closeServer(server);
  if (fixtureParent) fs.rmSync(fixtureParent, { recursive: true, force: true });
}
