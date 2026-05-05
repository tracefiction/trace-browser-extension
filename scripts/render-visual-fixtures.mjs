#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const fixtureRoot = path.join(repoRoot, "test", "visual-fixtures");
const resourceRoot = path.join(repoRoot, "Shared (Extension)", "Resources");
const outputRoot = process.env.TRACE_VISUAL_OUTPUT_DIR || "/tmp/trace-extension-visual-fixtures";
const renderSource = "fixture-rendered";
const visualMode = process.argv.includes("--popup-only") ? "popup" : "all";

process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY || "1";

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6xV2wAAAABJRU5ErkJggg==",
  "base64",
);

async function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    throw new Error(
      "Playwright is required to render visual fixtures. Run `npm install` in this repository first. Original error: " +
        error.message,
    );
  }
}

function chromiumLaunchOptions(chromium) {
  const options = { headless: true };
  const envPath = process.env.TRACE_CHROME_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath) {
    options.executablePath = envPath;
    return options;
  }
  const playwrightPath = chromium.executablePath();
  if (playwrightPath && fsSync.existsSync(playwrightPath)) {
    options.executablePath = playwrightPath;
    return options;
  }
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fsSync.existsSync(macChrome)) {
    options.executablePath = macChrome;
  }
  return options;
}

async function launchChromium(chromium) {
  try {
    return await chromium.launch(chromiumLaunchOptions(chromium));
  } catch (error) {
    throw new Error(
      [
        "Could not launch Chromium for visual fixture screenshots.",
        "",
        "Run `npm run visual:install-browsers` once after installing dependencies, or set TRACE_CHROME_EXECUTABLE to a working Chrome/Chromium binary.",
        "",
        "Original launch error:",
        error && error.message ? error.message : String(error),
      ].join("\n"),
    );
  }
}

async function readText(...parts) {
  return fs.readFile(path.join(...parts), "utf8");
}

function fixtureHtmlForRendering(html) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

function makeOverlayCache(variant = "default") {
  const cache = {
    syncVersion: "visual-fixtures-v1",
    entries: {
      "ao3:10404927": {
        status: "READING",
        readerStatus: "READING",
        entryId: "00000000-0000-4000-8000-000000104927",
        chapters: { current: 17, total: 52 },
        privateContext: { hasNotes: true, tagCount: 4 },
        workMark: { kind: "hiatus", challenge: { kind: "chapter-count-changed", chapterDelta: 2 } },
      },
      "ao3:28534965": {
        status: "READING",
        readerStatus: "READING",
        entryId: "00000000-0000-4000-8000-000000285349",
        chapters: { current: 1, total: null },
        privateContext: { hasNotes: true, tagCount: 3 },
      },
      "ffn:10709411": {
        status: "READING",
        readerStatus: "READING",
        entryId: "00000000-0000-4000-8000-000107094110",
        chapters: { current: 12, total: 72 },
        privateContext: { hasNotes: true, tagCount: 2 },
      },
      "ffn:7038840": {
        status: "READING",
        readerStatus: "READING",
        entryId: "00000000-0000-4000-8000-000000703884",
        chapters: { current: 3, total: 28 },
        privateContext: { hasNotes: true, tagCount: 2 },
        workMark: { kind: "abandoned" },
      },
    },
    workPreferences: {},
  };
  if (variant === "planning-zero") {
    cache.entries["ao3:10404927"] = {
      status: "PLANNING",
      readerStatus: "PLANNING",
      entryId: "00000000-0000-4000-8000-000000104927",
      chapters: { current: 0, total: 52 },
      privateContext: { hasNotes: true, tagCount: 4 },
    };
  }
  if (variant === "reading-one") {
    cache.entries["ao3:10404927"] = {
      status: "READING",
      readerStatus: "READING",
      entryId: "00000000-0000-4000-8000-000000104927",
      chapters: { current: 1, total: 52 },
      privateContext: { hasNotes: true, tagCount: 4 },
    };
  }
  if (variant === "status-saving") {
    cache.entries["ao3:10404927"] = {
      status: "PLANNING",
      readerStatus: "PLANNING",
      entryId: "00000000-0000-4000-8000-000000104927",
      chapters: { current: 0, total: 52 },
      __traceStatusPending: true,
      __traceStatusTarget: "READING",
    };
  }
  if (variant === "hidden-unknown") {
    cache.workPreferences["ao3:25010857"] = { browsePreference: { hidden: true } };
  }
  cache.entries["ao3:424242"] = {
    status: "READING",
    readerStatus: "READING",
    entryId: "00000000-0000-4000-8000-000000424242",
    chapters: { current: 1, total: 9 },
  };
  return cache;
}

function connectedAuthState() {
  return {
    state: "connected",
    message: "Trace is connected. Library status and progress are available on supported AO3 and FanFiction.net pages.",
    helpUrl: "https://tracefiction.com/apps",
  };
}

function makeStorageData(authState = connectedAuthState(), cacheVariant = "default") {
  const connected = authState.state === "connected";
  return {
    authToken: connected ? "visual-token" : null,
    traceAuthState: authState,
    libraryOverlayCache: makeOverlayCache(cacheVariant),
    prefAutoTrackEnabled: true,
    prefLibraryInlayEnabled: true,
    prefMetadataImproveEnabled: true,
    traceUserPro: true,
  };
}

function extensionMockSource(storageData) {
  return `
    (() => {
      const storageData = ${JSON.stringify(storageData)};
      const storageListeners = [];
      const popupState = {
        pro: storageData.traceUserPro === true,
        autoTrackEnabled: storageData.prefAutoTrackEnabled !== false,
        libraryInlayEnabled: storageData.prefLibraryInlayEnabled !== false,
        metadataImproveEnabled: storageData.prefMetadataImproveEnabled !== false,
      };
      function pick(keys) {
        if (Array.isArray(keys)) {
          return keys.reduce((acc, key) => {
            acc[key] = storageData[key];
            return acc;
          }, {});
        }
        if (typeof keys === "string") return { [keys]: storageData[keys] };
        if (keys && typeof keys === "object") {
          return Object.keys(keys).reduce((acc, key) => {
            acc[key] = Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : keys[key];
            return acc;
          }, {});
        }
        return { ...storageData };
      }
      function respond(msg, cb) {
        window.__traceMessages.push(msg);
        let response = { ok: true };
        if (msg && msg.type === "TRACE_POPUP_GET_STATE") response = popupState;
        if (msg && msg.type === "TRACE_SET_READER_STATUS") {
          response = { ok: true, entryId: msg.payload && msg.payload.entryId, status: msg.payload && msg.payload.status };
        }
        if (msg && msg.type === "TRACE_QUICK_ADD") {
          response = { ok: true, entryId: "00000000-0000-4000-8000-000000000999", status: "PLANNING" };
        }
        if (typeof cb === "function") setTimeout(() => cb(response), 0);
        return Promise.resolve(response);
      }
      const api = {
        runtime: {
          lastError: null,
          getURL(path) {
            return "chrome-extension://trace/" + String(path || "").replace(/^\\//, "");
          },
          onMessage: { addListener() {} },
          sendMessage: respond,
        },
        storage: {
          local: {
            get(keys, cb) {
              if (typeof cb === "function") cb(pick(keys));
            },
            set(values, cb) {
              Object.assign(storageData, values || {});
              if (typeof cb === "function") cb();
            },
          },
          onChanged: {
            addListener(fn) {
              storageListeners.push(fn);
            },
          },
        },
      };
      window.__traceMessages = [];
      window.chrome = api;
      window.browser = api;
      window.xcookie_read = window.xcookie_read || function () {};
      window.xfont_auto_loader = window.xfont_auto_loader || function () {};
      window.xfont_fix_smooth = window.xfont_fix_smooth || function () {};
      window.xauto_width_init = window.xauto_width_init || function () {};
      window.xauto_fontsize = window.xauto_fontsize || function () {};
      window.xauto_width = window.xauto_width || function () {};
      window.XCOOKIE = window.XCOOKIE || { gui_font: "Verdana" };
      window.isAndroid = false;
      window.isChrome = true;
      window.isIphone = false;
      window.isIpad = false;
      window.$ = window.$ || function (arg) {
        if (typeof arg === "function") arg();
        return { resize() {}, ready() {}, on() {} };
      };
      window.jQuery = window.$;
    })();
  `;
}

async function installFixtureRoutes(page, html, url) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const type = request.resourceType();
    if (request.isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
      return;
    }
    if (type === "stylesheet") {
      await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return;
    }
    if (type === "script") {
      await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
      return;
    }
    if (type === "image") {
      await route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}

async function installPopupRoutes(page, popupHtml, popupCss, popupJs, markSvg) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.endsWith("/popup.html") || route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: "text/html", body: popupHtml });
      return;
    }
    if (requestUrl.pathname.endsWith("/popup.css")) {
      await route.fulfill({ status: 200, contentType: "text/css", body: popupCss });
      return;
    }
    if (requestUrl.pathname.endsWith("/popup.js")) {
      await route.fulfill({ status: 200, contentType: "application/javascript", body: popupJs });
      return;
    }
    if (requestUrl.pathname.endsWith("/images/trace-mark.svg")) {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: markSvg });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}

async function injectScripts(page, scripts) {
  for (const script of scripts) {
    await page.addScriptTag({ content: script.source });
  }
}

async function waitForDomSelector(page, selector) {
  await page.waitForFunction(
    (targetSelector) => Boolean(document.querySelector(targetSelector)),
    selector,
    { timeout: 10000 },
  );
}

async function scrollTo(page, selector, block = "center") {
  await page.evaluate(
    ({ selector: targetSelector, block: targetBlock }) => {
      document.querySelector(targetSelector)?.scrollIntoView({ block: targetBlock, inline: "nearest" });
    },
    { selector, block },
  );
  await page.waitForTimeout(250);
}

async function focusForScreenshot(page, focus) {
  if (!focus) return;
  const focused = await page.evaluate(({ target, closest, keepActionSurface }) => {
    const targetEl = document.querySelector(target);
    const container = targetEl && (closest ? targetEl.closest(closest) : targetEl);
    if (!container) return false;
    const surface = keepActionSurface ? document.querySelector("[data-trace-action-surface]") : null;
    document.body.replaceChildren(container);
    if (surface) document.body.appendChild(surface);
    document.body.style.margin = "24px";
    document.body.style.background = getComputedStyle(document.documentElement).backgroundColor || "#fff";
    window.scrollTo(0, 0);
    return true;
  }, focus);
  if (!focused) {
    throw new Error(`Could not focus screenshot target ${focus.target}`);
  }
  await page.waitForTimeout(150);
}

async function renderFixtureScreenshot(browser, definition, scripts, manifest) {
  console.error(`Rendering ${definition.name} from ${definition.fixture}`);
  const html = fixtureHtmlForRendering(await readText(fixtureRoot, definition.fixture));
  const page = await browser.newPage({ viewport: definition.viewport });
  const messages = [];
  page.on("pageerror", (error) => messages.push({ type: "pageerror", text: error.message }));
  await page.addInitScript(extensionMockSource(makeStorageData(definition.authState || connectedAuthState(), definition.cacheVariant)));
  await installFixtureRoutes(page, html, definition.url);
  await page.goto(definition.url, { waitUntil: "domcontentloaded" });
  await injectScripts(page, definition.contentScripts.map((name) => scripts[name]));
  if (definition.waitFor) await waitForDomSelector(page, definition.waitFor);
  if (definition.scrollTo) await scrollTo(page, definition.scrollTo, definition.scrollBlock || "center");
  await focusForScreenshot(page, definition.focusBeforeOpen);
  if (definition.openSelector) {
    const clicked = await page.evaluate((targetSelector) => {
      const clickable = document.querySelector(targetSelector);
      if (!clickable) return false;
      clickable.click();
      return true;
    }, definition.openSelector);
    if (!clicked) {
      throw new Error(`Could not find ${definition.openSelector}`);
    }
    await waitForDomSelector(page, definition.openWaitFor);
    await page.waitForTimeout(250);
  }
  if (definition.openWithin) {
    const clicked = await page.evaluate(({ within, target }) => {
      const anchor = document.querySelector(within);
      const container = anchor && anchor.closest("li, .z-list, .bs, article, .work");
      const clickable = container && container.querySelector(target);
      if (!clickable) return false;
      clickable.click();
      return true;
    }, definition.openWithin);
    if (!clicked) {
      throw new Error(`Could not find ${definition.openWithin.target} within ${definition.openWithin.within}`);
    }
    await waitForDomSelector(page, definition.openWaitFor);
    await page.waitForTimeout(250);
  }
  if (definition.clickSelector) {
    const clicked = await page.evaluate((targetSelector) => {
      const clickable = document.querySelector(targetSelector);
      if (!clickable) return false;
      clickable.click();
      return true;
    }, definition.clickSelector);
    if (!clicked) {
      throw new Error(`Could not find ${definition.clickSelector}`);
    }
    if (definition.clickWaitFor) await waitForDomSelector(page, definition.clickWaitFor);
    if (definition.clickWaitForText) {
      await page.waitForFunction(
        (expectedText) => document.body.innerText.includes(expectedText),
        definition.clickWaitForText,
        { timeout: 10000 },
      );
    }
    await page.waitForTimeout(250);
  }
  await focusForScreenshot(page, definition.focusForScreenshot);
  const outputPath = path.join(outputRoot, definition.file);
  await page.screenshot({ path: outputPath, fullPage: false, timeout: 120000 });
  await page.close();
  manifest.screenshots.push({
    name: definition.name,
    file: outputPath,
    renderSource,
    fixture: path.join("test", "visual-fixtures", definition.fixture),
    url: definition.url,
    contentScripts: definition.contentScripts,
    viewport: definition.viewport,
    messages,
  });
}

async function renderPopupScreenshot(browser, definition, assets, manifest) {
  console.error(`Rendering ${definition.name} from popup.html`);
  const viewport = definition.viewport || { width: 291, height: 420 };
  const deviceScaleFactor = definition.deviceScaleFactor || 2;
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  if (definition.colorScheme) {
    await page.emulateMedia({ colorScheme: definition.colorScheme });
  }
  const messages = [];
  page.on("pageerror", (error) => messages.push({ type: "pageerror", text: error.message }));
  await page.addInitScript(extensionMockSource(makeStorageData(definition.authState)));
  await installPopupRoutes(page, assets.popupHtml, assets.popupCss, assets.popupJs, assets.markSvg);
  await page.goto("https://trace-extension.local/popup.html", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#popup-status", { timeout: 10000 });
  await page.waitForTimeout(250);
  const outputPath = path.join(outputRoot, definition.file);
  const clipHeight = await page.evaluate(() => {
    const bodyBox = document.body.getBoundingClientRect();
    return Math.max(1, Math.ceil(bodyBox.height));
  });
  await page.screenshot({
    path: outputPath,
    fullPage: false,
    clip: { x: 0, y: 0, width: viewport.width, height: clipHeight },
    timeout: 120000,
  });
  await page.close();
  manifest.screenshots.push({
    name: definition.name,
    file: outputPath,
    renderSource,
    fixture: "Shared (Extension)/Resources/popup.html",
    url: "chrome-extension://trace/popup.html",
    contentScripts: ["popup.js"],
    viewport,
    deviceScaleFactor,
    colorScheme: definition.colorScheme || "light",
    messages,
  });
}

async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  const { chromium } = await loadPlaywright();
  const assets = {
    keys: { name: "library-overlay-keys.js", source: await readText(resourceRoot, "library-overlay-keys.js") },
    overlay: { name: "library-overlay.js", source: await readText(resourceRoot, "library-overlay.js") },
    collector: { name: "collector.js", source: await readText(resourceRoot, "collector.js") },
    popupHtml: await readText(resourceRoot, "popup.html"),
    popupCss: await readText(resourceRoot, "popup.css"),
    popupJs: await readText(resourceRoot, "popup.js"),
    markSvg: await readText(resourceRoot, "images", "trace-mark.svg"),
  };
  const scripts = {
    keys: assets.keys,
    overlay: assets.overlay,
    collector: assets.collector,
  };
  const manifest = {
    generatedAt: new Date().toISOString(),
    outputRoot,
    renderSource,
    notes: [
      "Fixture screenshots are rendered from test/visual-fixtures copies with actual extension scripts injected.",
      "They do not depend on /dev/extension-overlay-preview.",
      "Live AO3/FFN CSS, fonts, images, ads, and scripts are not fetched; host script tags are stripped at render time for deterministic fixture screenshots.",
      "Compare against installed-extension QA before accepting material visual changes.",
    ],
    screenshots: [],
  };

  const browser = await launchChromium(chromium);
  try {
    const fixtureScreenshots = [
      {
        name: "AO3 listing desktop",
        file: "ao3-listing-desktop.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_10404927 [data-trace-library-overlay-wrap]",
        scrollTo: "#work_10404927",
        focusForScreenshot: {
          target: "#work_10404927 [data-trace-library-overlay-wrap]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 listing mobile",
        file: "ao3-listing-mobile.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 390, height: 844 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_10404927 [data-trace-library-overlay-wrap]",
        scrollTo: "#work_10404927",
      },
      {
        name: "AO3 desktop known status action row",
        file: "ao3-desktop-known-action-row.png",
        fixture: "ao3_listing_desktop_date.html",
        url: "https://archiveofourown.org/works?tag_id=Desktop+Known",
        viewport: { width: 900, height: 360 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_10404927 [data-trace-library-overlay-wrap]",
        focusForScreenshot: {
          target: "#work_10404927 [data-trace-library-overlay-wrap]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 mobile long title and fandom",
        file: "ao3-mobile-long-title.png",
        fixture: "ao3_listing_long_mobile.html",
        url: "https://archiveofourown.org/works?tag_id=Long+Mobile",
        viewport: { width: 390, height: 520 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_424242 [data-trace-library-overlay-wrap]",
        focusForScreenshot: {
          target: "#work_424242 [data-trace-library-overlay-wrap]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 unknown work Add and Hide",
        file: "ao3-unknown-add-hide.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_25010857 [data-trace-quick-add]",
        scrollTo: "#work_25010857",
        focusForScreenshot: {
          target: "#work_25010857 [data-trace-library-overlay-wrap]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 desktop unknown Add and Hide action row",
        file: "ao3-desktop-unknown-action-row.png",
        fixture: "ao3_listing_desktop_unknown_long.html",
        url: "https://archiveofourown.org/works?tag_id=Desktop+Unknown",
        viewport: { width: 900, height: 380 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_77776 [data-trace-quick-add]",
        focusForScreenshot: {
          target: "#work_77776 [data-trace-library-overlay-wrap]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 mobile unknown work Add and Hide",
        file: "ao3-mobile-unknown-add-hide.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 390, height: 844 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_25010857 [data-trace-quick-add]",
        scrollTo: "#work_25010857",
        focusForScreenshot: {
          target: "#work_25010857 [data-trace-library-overlay-wrap]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 hidden unknown collapsed row",
        file: "ao3-hidden-unknown-collapsed.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["keys", "overlay"],
        cacheVariant: "hidden-unknown",
        waitFor: "#work_25010857 [data-trace-hidden-placeholder]",
        scrollTo: "#work_25010857",
        focusForScreenshot: {
          target: "#work_25010857 [data-trace-hidden-placeholder]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 story top",
        file: "ao3-story-top.png",
        fixture: "ao3_story.html",
        url: "https://archiveofourown.org/works/28534965/chapters/71063826",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["collector"],
        waitFor: "[data-trace-story-handle]",
        scrollTo: "[data-trace-story-handle]",
        scrollBlock: "start",
      },
      {
        name: "Opened AO3 listing action surface",
        file: "ao3-listing-action-surface.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_10404927 [data-trace-library-lens]",
        scrollTo: "#work_10404927",
        openSelector: "#work_10404927 [data-trace-library-lens]",
        openWaitFor: "[data-trace-action-surface]",
      },
      {
        name: "AO3 Planning to Reading result",
        file: "ao3-planning-reading-result.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["keys", "overlay"],
        cacheVariant: "reading-one",
        waitFor: "#work_10404927 [data-trace-library-lens]",
        scrollTo: "#work_10404927",
        focusForScreenshot: {
          target: "#work_10404927 [data-trace-library-lens]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 status mutation saving state",
        file: "ao3-status-saving.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["keys", "overlay"],
        cacheVariant: "status-saving",
        waitFor: "#work_10404927 [data-trace-status-saving]",
        scrollTo: "#work_10404927",
        focusForScreenshot: {
          target: "#work_10404927 [data-trace-status-saving]",
          closest: "li.work",
        },
      },
      {
        name: "FFN unknown work Add and Hide",
        file: "ffn-unknown-add-hide.png",
        fixture: "ffn_listing_unknown.html",
        url: "https://www.fanfiction.net/book/Harry-Potter/",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["keys", "overlay"],
        waitFor: "[data-trace-quick-add='ffn:77777']",
        scrollTo: "a[href*='/s/77777/1/']",
        focusForScreenshot: {
          target: "[data-trace-quick-add='ffn:77777']",
          closest: ".z-list",
        },
      },
      {
        name: "Opened AO3 story sheet",
        file: "ao3-story-sheet.png",
        fixture: "ao3_story.html",
        url: "https://archiveofourown.org/works/28534965/chapters/71063826",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["collector"],
        waitFor: "[data-trace-story-handle]",
        scrollTo: "[data-trace-story-handle]",
        scrollBlock: "start",
        openSelector: "[data-trace-story-handle]",
        openWaitFor: "[data-trace-story-sheet][data-trace-open='1']",
      },
    ];

    if (visualMode === "all") {
      for (const definition of fixtureScreenshots) {
        await renderFixtureScreenshot(browser, definition, scripts, manifest);
      }
    }

    const popupScreenshots = [
      {
        name: "Extension popup connected",
        file: "popup-connected.png",
        authState: connectedAuthState(),
        colorScheme: "dark",
      },
      {
        name: "Extension popup signed out",
        file: "popup-signed-out.png",
        authState: {
          state: "signed_out",
          message: "Open Trace and sign in once to connect the extension.",
          helpUrl: "https://tracefiction.com/apps",
        },
        colorScheme: "dark",
      },
      {
        name: "Extension popup reconnect required",
        file: "popup-reconnect-required.png",
        authState: {
          state: "reconnect_required",
          message: "Open Trace to refresh your extension connection.",
          helpUrl: "https://tracefiction.com/apps",
        },
        colorScheme: "dark",
      },
      {
        name: "Extension popup error",
        file: "popup-error.png",
        authState: {
          state: "error",
          message: "Trace could not be reached. Try again after checking your connection.",
          helpUrl: "https://tracefiction.com/apps",
        },
        colorScheme: "dark",
      },
      {
        name: "Extension popup connected light",
        file: "popup-connected-light.png",
        authState: connectedAuthState(),
        colorScheme: "light",
      },
    ];

    for (const definition of popupScreenshots) {
      await renderPopupScreenshot(browser, definition, assets, manifest);
    }
  } finally {
    await browser.close();
  }

  const manifestPath = path.join(outputRoot, "visual-fixture-screenshots.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  for (const item of manifest.screenshots) {
    console.log(`${item.name}: ${item.file} [${item.renderSource}]`);
  }
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
