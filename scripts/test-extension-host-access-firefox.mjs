#!/usr/bin/env node
// Installed Firefox smoke: isolated temporary profile, always headless.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIREFOX = process.env.TRACE_FIREFOX_BINARY || (process.platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox");
const value = result => result?.value ?? result;
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
const screenshots = path.resolve(process.env.TRACE_HOST_ACCESS_SCREENSHOTS || path.join(os.tmpdir(), "trace-host-access-screenshots"));
fs.mkdirSync(screenshots, { recursive: true });
let firefox, driver, firefoxPid, webServer;
try {
  // Resolve only these archive test hosts to a local HTTPS server in this profile.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(parent, "key.pem"), "-out", path.join(parent, "cert.pem"), "-days", "1", "-subj", "/CN=archiveofourown.org"], { stdio: "ignore" });
  webServer = https.createServer({ key: fs.readFileSync(path.join(parent, "key.pem")), cert: fs.readFileSync(path.join(parent, "cert.pem")) }, (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html><head><title>Archive fixture</title><style>html,body{background:#fff;color:#18232d;font:16px system-ui}body{margin:24px}h1{font-size:22px}</style></head><body><h1>Archive fixture</h1><p>A local archive listing for the installed-extension test.</p><ol class="work index group"><li class="work blurb group" id="work_123"><h4 class="heading"><a href="/works/123">Fixture story</a></h4><dl class="stats"><dt>Words:</dt><dd class="words">1000</dd></dl></li></ol></body></html>');
  });
  await new Promise(resolve => webServer.listen(0, "127.0.0.1", resolve));
  const archiveURL = `https://archiveofourown.org:${webServer.address().port}/works?tag_id=fixture`;
  const profile = path.join(parent, "profile"); fs.mkdirSync(profile);
  const fixture = path.join(parent, "extension");
  assert.ok(fs.existsSync(path.join(ROOT, "dist/firefox/manifest.json")), "Run npm run build:release first");
  fs.cpSync(path.join(ROOT, "dist/firefox"), fixture, { recursive: true });
  assert.ok(!fs.readFileSync(path.join(fixture, "popup-config.js"), "utf8").includes("TRACE_IOS_EARNED_PERMISSION_ONBOARDING"), "Build the desktop release without Safari onboarding flags first");
  assert.equal(fs.existsSync(path.join(fixture, "archive-access.html")), false, "obsolete permission tab removed from the package");
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, "manifest.json"), "utf8"));
  fs.writeFileSync(path.join(fixture, "host-access-test-control.html"), '<!doctype html><title>Headless extension test control</title>');
  // Suppress only the first-install setup tab in this disposable fixture.
  fs.appendFileSync(path.join(fixture, "background.js"), '\nbrowser.runtime.onInstalled.addListener(() => browser.tabs.query({}).then(tabs => Promise.all(tabs.filter(tab => tab.url?.includes("activation=extension-installed")).map(tab => browser.tabs.remove(tab.id)))));\n');
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  fs.writeFileSync(path.join(profile, "user.js"), `user_pref("marionette.port", ${port});\nuser_pref("network.dns.localDomains", "archiveofourown.org,www.fanfiction.net");\nuser_pref("network.trr.mode", 5);\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\n`);
  const argumentsList = ["-headless", "-no-remote", "-profile", profile, "-marionette", "--remote-allow-system-access", "about:blank"];
  // LaunchServices supplies macOS app-data authorization; headless stays explicit.
  const appBundle = process.platform === "darwin" ? FIREFOX.match(/^(.+\.app)\//)?.[1] : null;
  firefox = spawn(appBundle ? "/usr/bin/open" : FIREFOX,
    appBundle ? ["-n", "-g", "-W", "-a", appBundle, "--args", ...argumentsList] : argumentsList, {
      env: { ...process.env, MOZ_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
  let output = "";
  firefox.stdout.on("data", data => { output += data; }); firefox.stderr.on("data", data => { output += data; });
  try { driver = await connect(port); } catch (error) { throw Error(`${error.message}\n${output}`); }
  // Marionette accepts the capabilities directly (not HTTP WebDriver's wrapper).
  const session = await driver.send("WebDriver:NewSession", { acceptInsecureCerts: true });
  firefoxPid = session.capabilities["moz:processID"];
  await driver.send("Addon:Install", { path: fixture, temporary: true });
  const context = value => driver.send("Marionette:SetContext", { value });
  const execute = async script => (await driver.send("WebDriver:ExecuteScript", { script, args: [], newSandbox: false, sandbox: "default" })).value;
  const asyncScript = async script => (await driver.send("WebDriver:ExecuteAsyncScript", { script, args: [], newSandbox: false, sandbox: "default", scriptTimeout: 10000 })).value;
  await context("chrome");
  const extensionId = manifest.browser_specific_settings.gecko.id;
  const hostname = await until(() => execute(`return WebExtensionPolicy.getByID(${JSON.stringify(extensionId)})?.mozExtensionHostname;`), "installed extension");
  const base = `moz-extension://${hostname}/`;
  await execute(`const e=WebExtensionPolicy.getByID(${JSON.stringify(extensionId)}).extension;
    window.__traceAction=e.apiManager.getAPI("browserAction",e,"addon_parent");
    const {CustomizableUI}=ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
    CustomizableUI.addWidgetToArea(window.__traceAction.id, CustomizableUI.AREA_NAVBAR);
    // Observe the native parent API's promise, whose lifetime outlasts the popup
    // context. Delegate unchanged to Firefox; do not fake a request or decision.
    const permissions=e.apiManager.getAPI("permissions",e,"addon_parent");
    const getAPI=permissions.getAPI.bind(permissions);
    window.__traceRequestResults=[];
    permissions.getAPI=context=>{
      const api=getAPI(context), request=api.permissions.request;
      api.permissions.request=(...args)=>{
        const pending=request(...args);
        pending.then(granted=>window.__traceRequestResults.push(granted));
        return pending;
      };
      return api;
    };
    window.__traceRequests=[];
    window.__traceHostObserver={observe(subject){window.__traceRequests.push(subject.wrappedJSObject.permissions.origins);}};
    Services.obs.addObserver(window.__traceHostObserver,"webextension-optional-permission-prompt");`);
  // Observe only. Keep Firefox's real ExtensionsUI prompt and decision handling.
  await context("content");
  await driver.send("WebDriver:Navigate", { url: `${base}host-access-test-control.html` });
  const controlHandle = value(await driver.send("WebDriver:GetWindowHandle"));
  const api = expression => asyncScript(`const done=arguments[arguments.length-1]; const api=(window.wrappedJSObject||window).browser; (${expression}).then(done,e=>done({error:String(e)}));`);
  await execute("const page=window.wrappedJSObject||window; window.__traceAdded=[]; page.browser.permissions.onAdded.addListener(p=>window.__traceAdded.push([...p.origins]));");
  const allPermissions = { origins: manifest.host_permissions };
  const allHosts = manifest.host_permissions;
  const ao3 = allPermissions.origins.filter(origin => /archiveofourown|transformativeworks/.test(origin));
  const ffn = allPermissions.origins.filter(origin => /fanfiction/.test(origin));
  assert.ok(ao3.length && ffn.length);
  const badge = () => api("Promise.all([api.action.getBadgeText({}),api.action.getTitle({}),api.action.getBadgeBackgroundColor({}),api.action.getBadgeTextColor({})]).then(([text,title,background,color])=>({text,title,background,color}))");
  const expectBadge = async missing => {
    await switchHandle(controlHandle);
    const title = missing ? "Site access is off — click to allow" : manifest.action.default_title;
    await until(async () => { const state = await badge(); return state.text === (missing ? "!" : "") && state.title === title; }, "toolbar badge and title");
    if (missing) {
      const state = await badge();
      assert.deepEqual(state.background, [155, 65, 70, 255]);
      assert.deepEqual(state.color, [255, 255, 255, 255]);
    }
  };
  // Revoke before opening the HTTPS archive: no injected notice can supply discovery.
  assert.equal(await api(`api.permissions.remove({origins:${JSON.stringify(allHosts)}})`), true);
  const created = await api(`api.tabs.create({url:${JSON.stringify(archiveURL)}})`);
  assert.ok(created.id);
  const switchHandle = async handle => { await context("content"); await driver.send("WebDriver:SwitchToWindow", { handle }); };
  const tabHandle = async prefix => {
    await context("content");
    const handles = value(await driver.send("WebDriver:GetWindowHandles"));
    for (const handle of handles) {
      await switchHandle(handle);
      if (await execute(`return location.href.startsWith(${JSON.stringify(prefix)});`)) return handle;
    }
    return null;
  };
  const archiveHandle = await until(() => tabHandle(archiveURL), "archive tab");
  await switchHandle(archiveHandle);
  await until(() => execute("return document.readyState === 'complete';"), "local HTTPS archive loaded");
  await delay(300);
  assert.equal(await execute("return !!document.querySelector('[data-trace-connect-notice]');"), false, "no content-script notice without host access");
  const save = (name, base64) => fs.writeFileSync(path.join(screenshots, name), Buffer.from(base64, "base64"));
  const theme = async dark => {
    await context("chrome"); await execute(`Services.prefs.setIntPref("ui.systemUsesDarkTheme", ${dark ? 1 : 0});`);
  };
  await expectBadge(true);
  await switchHandle(archiveHandle);
  const answerPrompt = async accept => {
    await context("chrome");
    await until(() => execute("return PopupNotifications.panel.state === 'open' && !!document.querySelector('#addon-webext-permissions-notification');"), "real Firefox permission prompt");
    const origins = await execute("return window.__traceRequests.at(-1);");
    assert.ok(origins.length); assert.ok(origins.every(origin => allHosts.includes(origin)));
    const prompt = await execute("const p=document.querySelector('#addon-webext-permissions-notification'); return {text:p.textContent,button:p.button.label||p.button.textContent};");
    assert.match(prompt.text, /archiveofourown|fanfiction|tracefiction/i);
    // Click the native browser UI, never replace the permission decision callback.
    await until(() => execute(`return !document.querySelector('#addon-webext-permissions-notification').${accept ? "button" : "secondaryButton"}.disabled;`), "native prompt button");
    // Firefox's native moz-button is not scrollable by WebDriver in headless
    // chrome. Invoke its ordinary click handler, with the real prompt intact.
    await execute(`document.querySelector('#addon-webext-permissions-notification').${accept ? "button" : "secondaryButton"}.click();`);
    await context("content");
  };
  // Marionette's actor drives the actual remote toolbar popup, which is not a tab.
  const popupQuery = async body => {
    await context("chrome");
    const result = await asyncScript(`const done=arguments[arguments.length-1]; (async()=>{const b=document.querySelector('browser[webextension-view-type=popup]'); const actor=b.browsingContext.currentWindowGlobal.getActor('MarionetteCommands'); ${body}})().then(done,e=>done({error:String(e)}));`);
    assert.ok(!result?.error, result?.error); return result;
  };
  const popupScript = script => popupQuery(`return actor.executeScript(${JSON.stringify(script)},[],{sandboxName:'default',newSandbox:false,async:false});`);
  const archiveScript = async script => {
    await context("chrome");
    const result = await asyncScript(`const done=arguments[arguments.length-1]; const b=[...gBrowser.browsers].find(b=>b.currentURI.spec===${JSON.stringify(archiveURL)}); const actor=b.browsingContext.currentWindowGlobal.getActor('MarionetteCommands'); actor.executeScript(${JSON.stringify(script)},[],{sandboxName:'default',newSandbox:false,async:false}).then(done,e=>done({error:String(e)}));`);
    assert.ok(!result?.error, result?.error); return result;
  };
  const openPopup = async () => {
    await context("chrome"); await execute("window.focus();");
    const widget = await execute("return window.__traceAction.id;");
    const button = (await driver.send("WebDriver:FindElement", { using: "css selector", value: "#" + widget + " .unified-extensions-item-action-button" })).value;
    await driver.send("WebDriver:ElementClick", { id: button["element-6066-11e4-a52e-4f735466cecf"] });
    await until(() => execute("return !!document.querySelector('browser[webextension-view-type=popup]')?.browsingContext.currentWindowGlobal;"), "actual toolbar popup");
    await until(async () => {
      try { return await popupScript("return document.querySelector('#popup-host-access-allow')?.textContent;") === "Allow Trace on AO3 and FanFiction.net"; }
      catch (error) {
        // The browser replaces its initial about:blank popup actor on load.
        if (/destroyed before query|b is null/.test(error.message)) return false;
        throw error;
      }
    }, "popup missing-access state");
    await until(async () => await archiveScript("return !document.querySelector('[data-trace-page-only-access]');"), "page line hidden while real popup is open");
  };
  const closePopup = async () => {
    await context("chrome"); await execute("const {ViewPopup}=ChromeUtils.importESModule('resource:///modules/ExtensionPopups.sys.mjs'); ViewPopup.for(window.__traceAction.extension,window)?.closePopup();");
  };
  for (const dark of [false, true]) {
    await theme(dark); await openPopup();
    const styles = await popupScript("const section=document.querySelector('#popup-host-access'); const s=getComputedStyle(section); const b=document.querySelector('#popup-host-access-allow'); const bs=getComputedStyle(b); return {padding:s.paddingLeft,right:s.paddingRight,color:bs.color,background:bs.backgroundColor,radius:bs.borderRadius,overflow:document.documentElement.scrollWidth>360};");
    assert.equal(styles.padding, "18px"); assert.equal(styles.right, "18px"); assert.equal(styles.radius, "12px"); assert.equal(styles.overflow, false);
    assert.equal(styles.background, dark ? "rgb(255, 132, 88)" : "rgb(194, 76, 34)");
    save(`popup-${dark ? "ink" : "light"}.png`, await popupQuery("const el=await actor.findElement('css selector','.popup',{}); return actor.takeScreenshot(el,0,false,true);"));
    // Inspect the fleeting disabled state without requesting or mocking access.
    await popupScript("document.querySelector('#popup-host-access-allow').disabled=true;");
    const disabled = await popupScript("const s=getComputedStyle(document.querySelector('#popup-host-access-allow')); return {background:s.backgroundColor,color:s.color,opacity:s.opacity};");
    assert.deepEqual(disabled, { background: dark ? "rgb(29, 31, 35)" : "rgb(233, 238, 243)", color: dark ? "rgb(180, 188, 198)" : "rgb(95, 107, 118)", opacity: "1" });
    save(`popup-disabled-${dark ? "ink" : "light"}.png`, await popupQuery("const el=await actor.findElement('css selector','.popup',{}); return actor.takeScreenshot(el,0,false,true);"));
    await closePopup();
    await switchHandle(archiveHandle);
    await until(() => execute("return !!document.querySelector('[data-trace-page-only-access]');"), "toolbar activates the page-only warning");
    const selector = "[data-trace-page-only-access]";
    assert.equal(await execute(`return document.querySelector('${selector}').textContent;`), "Trace is only on for this page. Allow it on AO3 to keep it on — click the Trace icon.");
    assert.equal(await execute(`return document.querySelector('${selector}').querySelector('button,a');`), null);
    await execute(`document.documentElement.style.backgroundColor=${JSON.stringify(dark ? "#07090c" : "#ffffff")}; document.body.style.backgroundColor=${JSON.stringify(dark ? "#07090c" : "#ffffff")}; window.dispatchEvent(new Event('pageshow'));`);
    await until(() => execute(`return getComputedStyle(document.querySelector('${selector}')).backgroundColor === ${JSON.stringify(dark ? "rgb(18, 20, 24)" : "rgb(255, 255, 255)")};`), "page-only theme");
    const line = (await driver.send("WebDriver:FindElement", { using: "css selector", value: selector })).value;
    save(`page-only-${dark ? "ink" : "light"}.png`, value(await driver.send("WebDriver:TakeScreenshot", { id: line["element-6066-11e4-a52e-4f735466cecf"], full: false })));
    await expectBadge(true);
    await switchHandle(archiveHandle);
  }
  const clickAllow = async () => {
    await popupQuery(`const el=await actor.findElement('css selector','#popup-host-access-allow',{}); return actor.sendQuery('MarionetteCommandsParent:clickElement',{elem:el,capabilities:${JSON.stringify(session.capabilities)}});`);
    await context("chrome");
    await until(() => execute("return !document.querySelector('browser[webextension-view-type=popup]');"), "Allow destroys the popup before the native decision");
    await until(() => execute("return PopupNotifications.panel.state==='open' && !!document.querySelector('#addon-webext-permissions-notification');"), "unobstructed native prompt survives popup destruction");
    assert.equal(await archiveScript("return !!document.querySelector('[data-trace-page-only-access]');"), true, "line returns while the native decision is pending");
  };
  await openPopup(); await clickAllow(); await answerPrompt(false);
  await context("chrome");
  await until(() => execute("return window.__traceRequestResults.length===1;"), "native request resolves after closed popup and decline");
  assert.deepEqual(await execute("return window.__traceRequestResults;"), [false]);
  await expectBadge(true);
  assert.equal(await api(`api.permissions.contains({origins:${JSON.stringify(ao3)}})`), false, "declining keeps access off");
  await switchHandle(archiveHandle); await openPopup();
  assert.equal(await popupScript("return document.querySelector('#popup-host-access-allow').disabled;"), false, "popup remains retryable");
  await clickAllow(); await answerPrompt(true);
  await context("chrome");
  await until(() => execute("return window.__traceRequestResults.length===2;"), "native request resolves after closed popup and grant");
  assert.deepEqual(await execute("return window.__traceRequestResults;"), [false, true]);
  await switchHandle(controlHandle);
  await until(async () => await api(`api.permissions.contains({origins:${JSON.stringify(allHosts)}})`) === true, "all declared hosts granted in one prompt");
  await until(() => execute("return window.__traceAdded.length===1;"), "real onAdded fires after requesting popup is destroyed");
  await expectBadge(false);
  await switchHandle(archiveHandle);
  await until(() => execute("return !!document.querySelector('[data-trace-connect-notice]');"), "archive scripts restored after grant");
  await until(() => execute("return !document.querySelector('[data-trace-page-only-access]');"), "grant removes the page-only line");
  // Trace-site access is required too, even when both archives remain allowed.
  await switchHandle(controlHandle);
  const traceHosts = allHosts.filter(origin => /tracefiction/.test(origin));
  assert.equal(await api(`api.permissions.remove({origins:${JSON.stringify(traceHosts)}})`), true);
  await expectBadge(true);
  await switchHandle(archiveHandle);
  await until(() => execute("return !!document.querySelector('[data-trace-page-only-access]');"), "Trace-only gap restores the persistent line");
  await openPopup(); await clickAllow(); await answerPrompt(true);
  await expectBadge(false);
  await until(() => execute("return window.__traceAdded.length===2;"), "second real onAdded after popup destruction");
  await switchHandle(archiveHandle);
  await until(() => execute("return !document.querySelector('[data-trace-page-only-access]');"), "onAdded clears line without reload");
  await context("chrome");
  assert.deepEqual(await execute("return window.__traceRequestResults;"), [false, true, true], "native requests resolve with their real decisions after popup destruction");
  assert.equal(await execute(`return window.__traceRequests.length;`), 3, "one native prompt per Allow click, including retry");
  assert.equal(await execute(`return [...gBrowser.tabs].some(t=>t.linkedBrowser.currentURI.spec.startsWith(${JSON.stringify(base + "archive-access.html")}));`), false, "no redundant permission tab");
  console.log(`Headless Firefox passed: real popup hides page line, Allow destroys popup before native decision, unobstructed all-host prompt survives close, denial/retry, onAdded and grant after popup destruction, badge/line recovery, Trace-only gaps, light/Ink enabled and neutral disabled screenshots. Screenshots: ${screenshots}`);
} finally {
  webServer?.close(); driver?.close();
  if (Number.isInteger(firefoxPid)) { try { process.kill(firefoxPid, "SIGTERM"); } catch {} }
  if (firefox && firefox.exitCode === null) {
    firefox.kill("SIGTERM");
    await Promise.race([new Promise(resolve => firefox.once("exit", resolve)), delay(5000)]);
    if (firefox.exitCode === null) firefox.kill("SIGKILL");
  }
  fs.rmSync(parent, { recursive: true, force: true });
}
