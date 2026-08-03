#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firefox as playwrightFirefox } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYWRIGHT_FIREFOX = playwrightFirefox.executablePath();
const FIREFOX = process.env.TRACE_FIREFOX_BINARY ?? PLAYWRIGHT_FIREFOX;
const WEB_EXT = path.join(ROOT, "node_modules", ".bin", "web-ext");

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
  fs.writeFileSync(
    path.join(fixtureRoot, "session-installed-test-driver.js"),
    `(() => {
  if (sessionStorage.getItem("trace-firefox-session-test") === "running") return;
  sessionStorage.setItem("trace-firefox-session-test", "running");
  const run = async () => {
    const initial = await browser.runtime.sendMessage({ type: "TRACE_SESSION_GET_SNAPSHOT" });
    const connected = await browser.runtime.sendMessage({
      type: "TRACE_SESSION_ACTION",
      action: "connect",
    });
    const disconnected = await browser.runtime.sendMessage({
      type: "TRACE_SESSION_ACTION",
      action: "disconnect",
    });
    await fetch(${JSON.stringify(`${origin}/__trace_extension_result`)}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initial, connected, disconnected }),
    });
  };
  void run().catch(async (error) => {
    await fetch(${JSON.stringify(`${origin}/__trace_extension_result`)}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(error?.stack || error) }),
    });
  });
})();\n`,
  );
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
assert.equal(fs.existsSync(WEB_EXT), true, "web-ext is missing; run npm install");

const result = deferred();
let verificationReads = 0;
const server = http.createServer((request, response) => {
  if (request.url === "/api/extension/account") {
    verificationReads += 1;
    if (request.headers.authorization !== "Bearer firefox-kernel-token") {
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

let webExt = null;
let fixtureParent = null;
try {
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  buildKernel(origin);

  fixtureParent = fs.mkdtempSync(path.join(os.tmpdir(), "trace-kernel-firefox-"));
  const fixtureRoot = path.join(fixtureParent, "extension");
  makeInstalledFixture(origin, fixtureRoot);

  webExt = spawn(WEB_EXT, [
    "run",
    "--source-dir", fixtureRoot,
    "--firefox", FIREFOX,
    "--no-reload",
    "--no-input",
    "--verbose",
    "--start-url", origin,
  ], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let webExtOutput = "";
  for (const stream of [webExt.stdout, webExt.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { webExtOutput += chunk; });
  }
  webExt.once("exit", (code, signal) => {
    result.reject(new Error(
      `web-ext exited before the installed result (code=${code}, signal=${signal})\n${webExtOutput}`,
    ));
  });

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
  assert.equal(verificationReads, 1);
  console.log("Firefox installed kernel Connect/Disconnect passed");
} finally {
  if (webExt && webExt.exitCode === null && webExt.signalCode === null) {
    webExt.kill("SIGTERM");
    await waitForExit(webExt);
    if (webExt.exitCode === null && webExt.signalCode === null) webExt.kill("SIGKILL");
  }
  await closeServer(server);
  if (fixtureParent) fs.rmSync(fixtureParent, { recursive: true, force: true });
}
