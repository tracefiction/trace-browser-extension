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
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
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
  for (let repeat = 0; repeat < 2; repeat++) {
    await setAccess("ON_CLICK"); await expectBadge(true);
    await setAccess("ON_ALL_SITES"); await expectBadge(false);
  }
  console.log("Headless Chromium passed: real site-access revocation/restoration, toolbar badge/title/colours, no archive tab or popup needed.");
} finally {
  await context?.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
