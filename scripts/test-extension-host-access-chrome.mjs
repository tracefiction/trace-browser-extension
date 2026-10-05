#!/usr/bin/env node
// Installed Chromium toolbar check: isolated profile, always headless.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(ROOT, "dist/chrome");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "trace-host-access-chrome-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
  throw Error(`Timed out waiting for ${label}`);
}

let context;
try {
  assert.equal(fs.existsSync(path.join(extension, "archive-access.html")), false, "obsolete permission tab removed");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    args: ["--enable-unsafe-extension-debugging", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://")) ??
    await context.waitForEvent("serviceworker", { predicate: worker => worker.url().startsWith("chrome-extension://") });
  const id = new URL(worker.url()).hostname;
  const state = () => worker.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}),
    background: await chrome.action.getBadgeBackgroundColor({}), color: await chrome.action.getBadgeTextColor({}),
    granted: await chrome.permissions.contains({ origins: chrome.runtime.getManifest().host_permissions }),
  }));
  const expectBadge = async missing => {
    await until(async () => {
      const badge = await state();
      return badge.text === (missing ? "!" : "") && badge.title === (missing ? "Site access is off — click to allow" : manifest.action.default_title) && badge.granted === !missing;
    }, "toolbar badge and title after real host-access change");
    if (missing) {
      const badge = await state();
      assert.deepEqual(badge.background, [155, 65, 70, 255]);
      assert.deepEqual(badge.color, [255, 255, 255, 255]);
    }
  };
  await expectBadge(false);
  const settings = await context.newPage(); await settings.goto("chrome://extensions");
  // Use the same browser-owned setting as Extensions > Site access. Do not
  // mock permissions.contains or emit synthetic permission-change events.
  const setAccess = hostAccess => settings.evaluate(({ id, hostAccess }) =>
    chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess }), { id, hostAccess });
  const protocol = await context.browser().newBrowserCDPSession();
  const selector = "[data-trace-page-only-access]";
  for (const [label, url] of [["AO3", "https://archiveofourown.org/works?fixture=1"], ["FanFiction.net", "https://www.fanfiction.net/book/"]]) {
    await setAccess("ON_CLICK"); await expectBadge(true);
    const archive = await context.newPage();
    await archive.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body style='background:#fff'><h1>Local archive fixture</h1></body></html>" }));
    await archive.goto(url);
    assert.equal(await archive.locator(selector).count(), 0, "no script before the toolbar action");
    const { targetInfos } = await protocol.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] });
    const targetInfo = targetInfos.find(target => target.url === url);
    assert.ok(targetInfo, JSON.stringify(targetInfos));
    await archive.bringToFront();
    // CDP runs Chromium's actual extension action; no manual script injection.
    await protocol.send("Extensions.triggerAction", { id, targetId: targetInfo.targetId });
    await archive.locator(selector).waitFor({ state: "visible" });
    assert.equal(await archive.locator(selector).textContent(), `Trace is only on for this page. Allow it on ${label} to keep it on — click the Trace icon.`);
    assert.equal(await archive.locator(selector).locator("button,a").count(), 0);
    await expectBadge(true);
    const dismiss = archive.locator("button[aria-label='Dismiss Trace notice']");
    if (await dismiss.count()) await dismiss.click();
    assert.equal(await archive.locator(selector).count(), 1, "dismissing Connect does not dismiss access evidence");
    await setAccess("ON_ALL_SITES"); await expectBadge(false);
    await archive.locator(selector).waitFor({ state: "detached" });
    await archive.close();
  }
  // Both Trace origins are required even with all archive hosts granted.
  for (const host of manifest.host_permissions.filter(host => /tracefiction/.test(host))) {
    await settings.evaluate(({ id, host }) => chrome.developerPrivate.removeHostPermission(id, host), { id, host });
    await expectBadge(true);
    assert.equal(await worker.evaluate(async () => chrome.permissions.contains({ origins: chrome.runtime.getManifest().host_permissions.filter(origin => !/tracefiction/.test(origin)) })), true, "archives remain allowed in a Trace-only gap");
    await setAccess("ON_CLICK");
    await setAccess("ON_ALL_SITES"); await expectBadge(false);
  }
  console.log("Headless Chromium passed: actual AO3/FFN toolbar activation, persistent page-only lines, Connect dismissal, full-host restoration, Trace-only gaps, badge/title/colours.");
} finally {
  await context?.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
