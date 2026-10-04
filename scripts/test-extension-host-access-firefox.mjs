#!/usr/bin/env node
// Installed Firefox smoke: isolated temporary profile, always headless.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIREFOX = process.env.TRACE_FIREFOX_BINARY || (process.platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error(`Timed out waiting for ${label}`);
}

// Firefox's built-in Marionette driver avoids a separate WebDriver dependency.
async function connect(port) {
  const socket = await until(() => new Promise(resolve => {
    const connection = net.connect(port, "127.0.0.1");
    connection.once("connect", () => resolve(connection));
    connection.once("error", () => { connection.destroy(); resolve(null); });
  }), "headless Firefox driver", 45000);
  let buffer = Buffer.alloc(0), nextId = 0;
  const pending = new Map();
  socket.on("data", data => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const colon = buffer.indexOf(58); if (colon < 0) return;
      const size = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + size) return;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size).toString());
      buffer = buffer.subarray(colon + 1 + size);
      if (!Array.isArray(message)) continue;
      const task = pending.get(message[1]); if (!task) continue;
      pending.delete(message[1]); clearTimeout(task.timeout);
      if (message[2]) task.reject(Error(JSON.stringify(message[2])));
      else task.resolve(message[3]);
    }
  });
  socket.on("error", error => { for (const task of pending.values()) task.reject(error); });
  return {
    close: () => socket.destroy(),
    send: (command, parameters = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(Error(`Driver timeout: ${command}`)); }, 20000);
      pending.set(id, { resolve, reject, timeout });
      const payload = JSON.stringify([0, id, command, parameters]);
      socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    }),
  };
}

const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trace-host-access-firefox-")));
let firefox, driver, firefoxPid;
try {
  const profile = path.join(parent, "profile"); fs.mkdirSync(profile);
  const fixture = path.join(parent, "extension");
  assert.ok(fs.existsSync(path.join(ROOT, "dist/firefox/manifest.json")), "Run npm run build:release first");
  fs.cpSync(path.join(ROOT, "dist/firefox"), fixture, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, "manifest.json"), "utf8"));
  fs.writeFileSync(path.join(fixture, "host-access-test-frame.html"), '<!doctype html><title>Host access test</title><iframe src="archive-access.html?site=ao3" style="width:360px;height:120px"></iframe>');
  // Do not open the first-install Trace website in a test.
  fs.writeFileSync(path.join(fixture, "background.js"), fs.readFileSync(path.join(fixture, "background.js"), "utf8") + '\nbrowser.runtime.onInstalled.addListener(() => browser.tabs.query({}).then(tabs => Promise.all(tabs.filter(tab => tab.url?.includes("activation=extension-installed")).map(tab => browser.tabs.remove(tab.id)))));\n');
  const portServer = net.createServer();
  await new Promise((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  fs.writeFileSync(path.join(profile, "user.js"), `user_pref("marionette.port", ${port});\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\n`);
  const argumentsList = ["-headless", "-no-remote", "-profile", profile, "-marionette", "--remote-allow-system-access", "about:blank"];
  // LaunchServices supplies macOS's Firefox app-data authorization. Headless
  // is still explicit, and -n/-no-remote keep the user's browser untouched.
  const appBundle = process.platform === "darwin" ? FIREFOX.match(/^(.+\.app)\//)?.[1] : null;
  firefox = spawn(appBundle ? "/usr/bin/open" : FIREFOX,
    appBundle ? ["-n", "-g", "-W", "-a", appBundle, "--args", ...argumentsList] : argumentsList, {
    env: { ...process.env, MOZ_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  firefox.stdout.on("data", data => { output += data; }); firefox.stderr.on("data", data => { output += data; });
  try { driver = await connect(port); } catch (error) { throw Error(`${error.message}\n${output}`); }
  const session = await driver.send("WebDriver:NewSession", { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
  firefoxPid = session.capabilities?.["moz:processID"];
  await driver.send("Addon:Install", { path: fixture, temporary: true });
  await driver.send("Marionette:SetContext", { value: "chrome" });
  const execute = async script => (await driver.send("WebDriver:ExecuteScript", { script, args: [], newSandbox: false, sandbox: "default" })).value;
  const extensionId = manifest.browser_specific_settings.gecko.id;
  const hostname = await until(() => execute(`return WebExtensionPolicy.getByID(${JSON.stringify(extensionId)})?.mozExtensionHostname;`), "installed extension");
  const base = `moz-extension://${hostname}/`;
  // Exercise the real permissions.request decision without rendering browser
  // chrome in a headless window. Only this disposable profile is affected.
  await execute(`
    const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
    Services.obs.removeObserver(ExtensionsUI, "webextension-optional-permission-prompt");
    window.__traceHostPrompt = null;
    window.__traceHostObserver = { observe(subject) { window.__traceHostPrompt = subject.wrappedJSObject; } };
    Services.obs.addObserver(window.__traceHostObserver, "webextension-optional-permission-prompt");
  `);
  await driver.send("Marionette:SetContext", { value: "content" });
  await driver.send("WebDriver:Navigate", { url: `${base}archive-access.html?site=ao3` });
  const asyncScript = async script => (await driver.send("WebDriver:ExecuteAsyncScript", { script, args: [], newSandbox: false, sandbox: "default", scriptTimeout: 10000 })).value;
  const remove = origins => asyncScript(`const done = arguments[arguments.length - 1]; const api = (window.wrappedJSObject || window).browser; api.permissions.remove({ origins: ${JSON.stringify(origins)} }).then(done, error => done({ error: String(error) }));`);
  const label = () => execute('return document.querySelector("button")?.textContent;');
  const state = () => asyncScript('const done = arguments[arguments.length - 1]; (window.wrappedJSObject || window).browser.runtime.sendMessage({ type: "TRACE_ARCHIVE_HOST_ACCESS_GET" }).then(done);');
  const initial = await state(); assert.equal(initial.ok, true);
  const ao3 = initial.access.find(item => item.site === "ao3");
  const ffn = initial.access.find(item => item.site === "ffn");
  assert.ok(ao3.origins.length && ffn.origins.length);
  assert.equal(await remove(ao3.origins), true);
  await driver.send("WebDriver:Navigate", { url: `${base}host-access-test-frame.html` });
  await driver.send("WebDriver:SwitchToFrame", { id: 0 });
  await until(async () => await label() === "Allow Trace on AO3", "AO3 recovery button");
  assert.equal((await state()).access.find(item => item.site === "ao3").granted, false);

  const clickAllow = async () => {
    await until(() => execute('return document.querySelector("#archive-access-allow").disabled === false;'), "enabled Allow button");
    const element = (await driver.send("WebDriver:FindElement", { using: "css selector", value: "#archive-access-allow" })).value;
    await driver.send("WebDriver:ElementClick", { id: element["element-6066-11e4-a52e-4f735466cecf"] });
  };
  const answerPrompt = async accept => {
    await driver.send("Marionette:SetContext", { value: "chrome" });
    await until(() => execute('return !!window.__traceHostPrompt;'), "Firefox host permission decision");
    const requested = await execute('return window.__traceHostPrompt.permissions.origins;');
    assert.ok(requested.length > 0);
    assert.ok(requested.every(origin => [...ao3.origins, ...ffn.origins].includes(origin)), "the browser request contains only declared archive hosts");
    await execute(`window.__traceHostPrompt.resolve(${accept}); window.__traceHostPrompt = null;`);
    await driver.send("Marionette:SetContext", { value: "content" });
  };
  await clickAllow(); await answerPrompt(false);
  await until(() => execute('return document.querySelector("#archive-access-result").textContent.includes("still off");'), "denial explanation");
  assert.equal((await state()).access.find(item => item.site === "ao3").granted, false);
  await clickAllow(); await answerPrompt(true);
  await until(async () => (await state()).access.find(item => item.site === "ao3").granted, "durable AO3 grant");
  await until(async () => await label() === "Site access allowed", "AO3 success");
  assert.equal(await remove(ffn.origins), true);
  await driver.send("WebDriver:Navigate", { url: `${base}archive-access.html?site=ffn` });
  await until(async () => await label() === "Allow Trace on FanFiction.net", "FFN recovery button");
  await clickAllow(); await answerPrompt(true);
  await until(async () => (await state()).access.every(item => item.granted), "both archive grants");
  console.log("Headless installed Firefox passed: revoked AO3/FFN detection, embedded Allow button, browser permission decisions, denial, retry, and durable grants");
} finally {
  driver?.close();
  if (Number.isInteger(firefoxPid)) { try { process.kill(firefoxPid, "SIGTERM"); } catch {} }
  if (firefox && firefox.exitCode === null) {
    firefox.kill("SIGTERM");
    await Promise.race([new Promise(resolve => firefox.once("exit", resolve)), delay(5000)]);
    if (firefox.exitCode === null) firefox.kill("SIGKILL");
  }
  fs.rmSync(parent, { recursive: true, force: true });
}
