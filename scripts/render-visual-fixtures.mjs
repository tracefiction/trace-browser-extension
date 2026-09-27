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
const visualMode = process.argv.includes("--restyle-qa1")
  ? "qa1"
  : process.argv.includes("--restyle-matrix")
  ? "matrix"
  : process.argv.includes("--capacity-only")
  ? "capacity"
  : process.argv.includes("--corrective-only")
    ? "corrective"
  : process.argv.includes("--popup-only")
    ? "popup"
    : "all";

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
    contextVersion: 1,
    accountId: "visual-account",
    apiBase: "https://api.tracefiction.com",
    syncVersion: "visual-fixtures-v1",
    entries: {
      "ao3:10404927": {
        status: "READING",
        readerStatus: "READING",
        entryId: "00000000-0000-4000-8000-000000104927",
        chapters: { current: 17, total: 52 },
        privateContext: {
          hasNotes: true,
          tagCount: 9,
          notePreview: "Slow start but the Riddle arc is worth it - pick back up at the duel.",
          tags: [
            "comfort reread",
            "favorite long private tag that should not own the sheet",
            "good story",
            "weekend",
            "reread soon",
          ],
        },
        workMark: { kind: "hiatus", challenge: { kind: "chapter-count-changed", chapterDelta: 2 } },
      },
      "ao3:28534965": {
        status: "READING",
        readerStatus: "READING",
        entryId: "00000000-0000-4000-8000-000000285349",
        chapters: { current: 1, total: null },
        privateContext: {
          hasNotes: true,
          tagCount: 8,
          notePreview: "Slow start but the Riddle arc is worth it - pick back up at the duel.",
          tags: [
            "comfort reread",
            "favorite long private tag that should not own the sheet",
            "good story",
            "weekend",
            "reread soon",
          ],
        },
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
        privateContext: {
          hasNotes: true,
          tagCount: 2,
          notePreview: "great story!",
          tags: ["favs", "good story"],
        },
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
  if (variant === "story-free-limit") {
    cache.entries["ao3:28534965"] = {
      __traceAutoTrackError: "free_limit_reached",
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
    traceFirstSaveSeen: connected,
    traceLibraryCount: connected ? 1 : 0,
    traceActiveTab: connected
      ? { kind: "supported_story", site: "ao3", canImport: true }
      : { kind: "unsupported" },
    traceAccountId: connected ? "visual-account" : null,
    traceApiBase: "https://api.tracefiction.com",
    libraryOverlayCache: makeOverlayCache(cacheVariant),
    prefAutoTrackEnabled: true,
    prefLibraryInlayEnabled: true,
    prefMetadataImproveEnabled: true,
    traceUserPro: connected,
  };
}

function postOnboardingPopupStorageData() {
  const grantAt = Date.now() - 60_000;
  return {
    traceEarnedPermissionOnboarding: true,
    traceGrantedOrigins: [
      "https://*.archiveofourown.org/*",
      "https://*.archiveofourown.gay/*",
      "https://archive.transformativeworks.org/*",
      "https://www.fanfiction.net/*",
      "https://m.fanfiction.net/*",
    ],
    traceRegisteredContentScripts: [
      { id: "trace-archive-automation-v1" },
      { id: "trace-ao3-saved-filters-v1" },
    ],
    traceEarnedPermissionOnboardingV1: {
      firstSaveAt: grantAt - 2_000,
      grantAt,
      registrationVersion: 2,
      promptResult: "granted",
    },
    traceArchiveReadiness: { lastArchiveSeenAt: grantAt + 2_000 },
    traceActiveTab: {
      kind: "supported_archive",
      site: "ao3",
      canImport: true,
    },
  };
}

function extensionMockSource(storageData, sessionSnapshot = null) {
  return `
    (() => {
      const storageData = ${JSON.stringify(storageData)};
      const sessionSnapshot = ${JSON.stringify(sessionSnapshot)};
      let activeTabProbeInjected = storageData.traceProbeAlreadyInjected === true;
      let grantedOrigins = Array.isArray(storageData.traceGrantedOrigins)
        ? [...storageData.traceGrantedOrigins]
        : [];
      let registeredContentScripts = Array.isArray(storageData.traceRegisteredContentScripts)
        ? [...storageData.traceRegisteredContentScripts]
        : [];
      const storageListeners = [];
      const popupState = {
        ok: true,
        authState: storageData.traceAuthState,
        firstSaveSeen: storageData.traceFirstSaveSeen === true,
        libraryCount: typeof storageData.traceLibraryCount === "number" ? storageData.traceLibraryCount : null,
        activeTab: storageData.traceActiveTab || { kind: "unknown" },
        activeWork: storageData.traceActiveWork || null,
        capacity: storageData.traceCapacityRecovery || null,
        pro: storageData.traceUserPro === true,
        autoTrackEnabled: storageData.prefAutoTrackEnabled !== false,
        libraryInlayEnabled: storageData.prefLibraryInlayEnabled !== false,
        ao3SavedFiltersEnabled: storageData.prefAo3SavedFiltersEnabled !== false,
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
        if (
          sessionSnapshot &&
          msg &&
          (msg.type === "TRACE_SESSION_GET_SNAPSHOT" || msg.type === "TRACE_SESSION_ACTION")
        ) {
          response = { ok: true, snapshot: sessionSnapshot, action: { kind: "ignored" } };
        }
        if (msg && msg.type === "TRACE_POPUP_GET_STATE") response = popupState;
        if (msg && msg.type === "TRACE_EARNED_PERMISSION_RECONCILE") {
          response = storageData.traceEarnedPermissionReconcileResult || {
            ok: true,
            completeGrant: true,
            registered: true,
            changed: true,
          };
        }
        if (msg && msg.type === "TRACE_SET_READER_STATUS") {
          response = { ok: true, entryId: msg.payload && msg.payload.entryId, status: msg.payload && msg.payload.status };
        }
        if (msg && msg.type === "TRACE_QUICK_ADD") {
          response = storageData.traceMockQuickAddError
            ? { ok: false, error: storageData.traceMockQuickAddError }
            : { ok: true, entryId: "00000000-0000-4000-8000-000000000999", status: "PLANNING" };
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
              const value = pick(keys);
              if (typeof cb === "function") cb(value);
              return Promise.resolve(value);
            },
            set(values, cb) {
              Object.assign(storageData, values || {});
              if (typeof cb === "function") cb();
              return Promise.resolve();
            },
          },
          onChanged: {
            addListener(fn) {
              storageListeners.push(fn);
            },
          },
        },
        tabs: {
          async query() {
            return [{
              id: 7,
              url: storageData.traceProbeUrl || "https://archiveofourown.org/works/28534965",
            }];
          },
          async sendMessage(_tabId, message) {
            window.__traceMessages.push(message);
            if (message && message.type === "TRACE_ACTIVE_TAB_PROBE_PING") {
              if (!activeTabProbeInjected) throw new Error("No receiving end");
              return { ok: true, probe: true };
            }
            if (message && message.type === "TRACE_STORY_IDENTITY_GET") {
              return { ok: true, title: "Synthetic Archive Work", author: "Demo Author", site: "AO3" };
            }
            if (message && message.type === "TRACE_ACTIVE_TAB_PROBE_SAVE") {
              return storageData.traceProbeSaveError
                ? { ok: false, error: storageData.traceProbeSaveError }
                : { ok: true, state: "saved", site: "ao3", serverConfirmed: true };
            }
            return { ok: false };
          },
          async reload(tabId) {
            window.__traceReloads = [...(window.__traceReloads || []), tabId];
          },
        },
        permissions: {
          async getAll() {
            return { origins: [...grantedOrigins], permissions: [] };
          },
          async request(request) {
            if (storageData.tracePermissionRequestPending === true) return new Promise(() => {});
            const allowed = storageData.tracePermissionRequestResult !== false;
            if (allowed) grantedOrigins = [...(request && request.origins || [])];
            return allowed;
          },
        },
        scripting: {
          async executeScript(injection) {
            window.__traceInjections = [...(window.__traceInjections || []), injection];
            if (storageData.traceProbeInjectionFailure === true) {
              throw new Error("Safari denied current-tab execution");
            }
            activeTabProbeInjected = true;
            return [];
          },
          async getRegisteredContentScripts() {
            return [...registeredContentScripts];
          },
          async unregisterContentScripts(filter) {
            const ids = new Set(filter && filter.ids || []);
            registeredContentScripts = registeredContentScripts.filter((entry) => !ids.has(entry.id));
          },
          async registerContentScripts(registrations) {
            registeredContentScripts.push(...registrations);
          },
        },
      };
      window.__traceMessages = [];
      if (sessionSnapshot) window.TRACE_SESSION_MODE = "kernel";
      if (storageData.traceActiveTabProbe === true) {
        window.TRACE_SESSION_MODE = "kernel";
        window.TRACE_IOS_ACTIVE_TAB_PROBE = true;
      }
      if (storageData.traceEarnedPermissionOnboarding === true) {
        window.TRACE_SESSION_MODE = "kernel";
        window.TRACE_IOS_ACTIVE_TAB_PROBE = true;
        window.TRACE_IOS_EARNED_PERMISSION_ONBOARDING = {
          version: 2,
          origins: [
            "https://*.archiveofourown.org/*",
            "https://*.archiveofourown.gay/*",
            "https://archive.transformativeworks.org/*",
            "https://www.fanfiction.net/*",
            "https://m.fanfiction.net/*",
          ],
          registrations: [
            { id: "trace-archive-automation-v1", matches: ["https://*.archiveofourown.org/*"], js: ["collector.js"], persistAcrossSessions: true },
            { id: "trace-ao3-saved-filters-v1", matches: ["https://*.archiveofourown.org/*"], js: ["ao3-saved-filters.js"], persistAcrossSessions: true },
          ],
        };
      }
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
    if (requestUrl.pathname.endsWith("/images/trace-icon.svg")) {
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
  await page.addInitScript(
    extensionMockSource({
      ...makeStorageData(definition.authState || connectedAuthState(), definition.cacheVariant),
      ...(definition.storageData || {}),
    }),
  );
  await installFixtureRoutes(page, html, definition.url);
  await page.goto(definition.url, { waitUntil: "domcontentloaded" });
  if (definition.darkHost) {
    // A dark reading skin (FFN dark theme, AO3 Reversi). Page UI takes its tone
    // from the host's computed background, never the phone's appearance.
    await page.evaluate(() => {
      document.documentElement.style.background = "#111111";
      document.body.style.background = "#111111";
      document.body.style.color = "#dadada";
    });
  }
  await injectScripts(page, definition.contentScripts.map((name) => scripts[name]));
  if (definition.finishQualify) {
    await page.evaluate((finishQualify) => {
      const anchor = document.querySelector(finishQualify.anchorSelector);
      if (!anchor || !window.TraceFinishQualify) return;
      if (finishQualify.kind === "toast") {
        window.TraceFinishQualify.toast({
          kind: finishQualify.result || "finished",
          story: { src: finishQualify.source || "AO3" },
          onOpenInTrace() {},
          autoDismissMs: 0,
        });
        return;
      }
      window.TraceFinishQualify.mount({
        anchorEl: anchor,
        placement: "inline",
        align: "start",
        story: { src: finishQualify.source || "AO3" },
        onQualify() { return false; },
        onDismiss() {},
        onOpenInTrace() {},
        autoDismissMs: 0,
      });
    }, definition.finishQualify);
  }
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
  const viewport = definition.viewport || { width: 360, height: 520 };
  const deviceScaleFactor = definition.deviceScaleFactor || 2;
  const pageOptions = { viewport, deviceScaleFactor };
  if (definition.userAgent) pageOptions.userAgent = definition.userAgent;
  const page = await browser.newPage(pageOptions);
  if (definition.colorScheme) {
    await page.emulateMedia({ colorScheme: definition.colorScheme });
  }
  const messages = [];
  page.on("pageerror", (error) => messages.push({ type: "pageerror", text: error.message }));
  await page.addInitScript(
    extensionMockSource(
      {
        ...makeStorageData(definition.authState),
        ...(definition.storageData || {}),
      },
      definition.sessionSnapshot || null,
    ),
  );
  await installPopupRoutes(page, assets.popupHtml, assets.popupCss, assets.popupJs, assets.markSvg);
  await page.goto("https://trace-extension.local/popup.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(
    document.body.dataset.tracePopupState ||
    document.body.dataset.tracePopupStateCode ||
    document.body.dataset.traceEarnedPermission ||
    document.body.dataset.traceActiveTabProbe
  ), null, { timeout: 10000 });
  await page.waitForTimeout(250);
  if (definition.storageData?.traceActiveTabProbe === true) {
    await page.waitForFunction(
      () => document.querySelector("#popup-probe-result")?.dataset.state !== "checking",
      { timeout: 10000 },
    );
  }
  if (definition.storageData?.traceEarnedPermissionOnboarding === true) {
    await page.waitForFunction(
      () =>
        document.body.dataset.traceEarnedPermission !== "true" ||
        Boolean(document.body.dataset.tracePopupStateCode) ||
        !document.querySelector("#popup-earned-permission")?.hidden,
      { timeout: 10000 },
    );
  }
  if (definition.clickSelector) {
    await page.click(definition.clickSelector);
    if (definition.clickWaitForText) {
      await page.waitForFunction(
        (expectedText) => document.body.innerText.includes(expectedText),
        definition.clickWaitForText,
        { timeout: 10000 },
      );
    }
    await page.waitForTimeout(150);
  }
  if (definition.firstViewportMaxHeight) {
    const firstViewport = await page.evaluate(({ selector, maxHeight }) => {
      const action = document.querySelector(selector);
      const body = document.body.getBoundingClientRect();
      const actionBox = action?.getBoundingClientRect();
      return {
        maxHeight,
        bodyHeight: Math.ceil(body.height),
        actionTop: actionBox ? Math.floor(actionBox.top) : null,
        actionBottom: actionBox ? Math.ceil(actionBox.bottom) : null,
        actionHidden: action
          ? action.hidden || getComputedStyle(action).display === "none"
          : true,
      };
    }, {
      selector: definition.firstViewportAction || "#popup-earned-primary",
      maxHeight: Math.max(definition.firstViewportMaxHeight, viewport.height),
    });
    if (
      firstViewport.actionHidden ||
      firstViewport.actionTop === null ||
      firstViewport.actionTop < 0 ||
      firstViewport.actionBottom > firstViewport.maxHeight ||
      firstViewport.bodyHeight > firstViewport.maxHeight
    ) {
      throw new Error(
        `Popup first action requires scrolling: ${JSON.stringify(firstViewport)}`,
      );
    }
  }
  if (
    definition.sessionSnapshot &&
    definition.storageData?.traceEarnedPermissionOnboarding !== true
  ) {
    const localSettings = await page.$eval("#popup-local-settings", (element) => ({
      hidden: element.hidden,
      display: getComputedStyle(element).display,
    }));
    const projectedSettingsExpected =
      definition.sessionSnapshot.state === "connected";
    const projectedSettingsVisible =
      !localSettings.hidden && localSettings.display !== "none";
    if (projectedSettingsVisible !== projectedSettingsExpected) {
      throw new Error(
        `Kernel popup projected settings visibility was incorrect: ${JSON.stringify(localSettings)}`,
      );
    }
  }
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

const RESTYLE_ORIGINS = [
  "https://*.archiveofourown.org/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
];
const RESTYLE_STATES = ["P1", "P2", "P3", "P3-lapse", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P11-menu"];
// Recovery and truth states drawn by the design pass after the prototype.
const RESTYLE_RECOVERY_STATES = ["P1-known-saved", "P10-saving", "P10-failed", "P11-settings", "P11-status-error",
  "other-account", "registration-failure", "reload-page", "library-full", "no-story", "on-list"];
const RESTYLE_PAGE_STATES = ["N1-saved", "N1-reading", "N2", "N3", "N4-lens", "N4-add-hide"];
const RESTYLE_DEVICES = [
  { name: "17", width: 384, height: 386 },
  { name: "se", width: 359, height: 283 },
];
const RESTYLE_SIZES = [
  { name: "large", px: 17 },
  { name: "xxxl", px: 26 },
  { name: "ax5", px: 36 },
];
const RESTYLE_IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

function restylePopupStorage() {
  return {
    ...makeStorageData(),
    traceEarnedPermissionOnboarding: true,
    traceGrantedOrigins: RESTYLE_ORIGINS,
    traceEarnedPermissionOnboardingV1: { completedAt: Date.now() - 60000, grantAt: Date.now() - 120000 },
    traceRegisteredContentScripts: [
      { id: "trace-archive-automation-v1" },
      { id: "trace-ao3-saved-filters-v1" },
    ],
    traceProbeUrl: "https://archiveofourown.org/works/28534965",
  };
}

async function renderRestylePopup(browser, assets, output, device, appearance, size, state) {
  const page = await browser.newPage({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent: RESTYLE_IOS_UA,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: appearance });
  await page.addInitScript(extensionMockSource(restylePopupStorage(), {
    state: "connected", accountId: "visual-account", canExecuteAuthenticated: true, reason: "none",
  }));
  const previewApi = "\nwindow.__traceVisualRender = { renderEarnedAccessPending, renderEarnedSaved, renderEarnedPermissionInvitation, renderEarnedDelayed, renderEarnedConnectAccount, renderEarnedPermissionDeclined, renderEarnedSiteReady, renderEarnedUnavailable, renderReaderView, openPopupStatusMenu, setEarnedCopy, setEarnedResult, configureEarnedActions, refreshEarnedLayout," +
    " renderEarnedOtherAccount: typeof renderEarnedOtherAccount === 'function' ? renderEarnedOtherAccount : null," +
    " renderEarnedCheckingLibrary: typeof renderEarnedCheckingLibrary === 'function' ? renderEarnedCheckingLibrary : null," +
    " renderEarnedLibraryFull: typeof renderEarnedLibraryFull === 'function' ? renderEarnedLibraryFull : null," +
    " renderPopupSaveStory: typeof renderPopupSaveStory === 'function' ? renderPopupSaveStory : null," +
    " setPopupStatusError: typeof setPopupStatusError === 'function' ? setPopupStatusError : null," +
    " renderEarnedRegistrationFailure, renderEarnedUnsupportedStory, renderPageReconnect };";
  await installPopupRoutes(page, assets.popupHtml, assets.popupCss, assets.popupJs + previewApi, assets.markSvg);
  await page.goto("https://trace-extension.local/popup.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__traceVisualRender));
  await page.addStyleTag({ content: `body[data-trace-platform="ios"] { font-size: ${size.px}px !important; }` });
  await page.evaluate(async (code) => {
    const { renderEarnedAccessPending, renderEarnedSaved, renderEarnedPermissionInvitation,
      renderEarnedDelayed, renderEarnedConnectAccount, renderEarnedPermissionDeclined,
      renderEarnedSiteReady, renderEarnedUnavailable, renderReaderView, openPopupStatusMenu,
      setEarnedCopy, setEarnedResult, configureEarnedActions, refreshEarnedLayout,
      renderEarnedOtherAccount, renderEarnedCheckingLibrary, renderEarnedLibraryFull, renderPopupSaveStory,
      setPopupStatusError, renderEarnedRegistrationFailure, renderEarnedUnsupportedStory,
      renderPageReconnect } = window.__traceVisualRender;
    const missing = (name) => { throw new Error(`${name} is not available in this popup build`); };
    const story = { ok: true, kind: "story", site: "AO3" };
    const identity = { title: "Synthetic Archive Work", author: "A. Writer", site: "AO3" };
    const saved = { status: "saved", entry: { entryId: "00000000-0000-4000-8000-000000285349",
      canonicalReaderStatus: "SAVED", chapters: { current: 0, total: 12 } } };
    const reader = { ok: true, authState: { state: "connected" }, firstSaveSeen: true,
      activeTab: { kind: "supported_story", site: "ao3", canImport: true },
      activeWork: { status: "saved", entry: { entryId: "00000000-0000-4000-8000-000000285349",
        canonicalReaderStatus: "READING", chapters: { current: 6, total: 12 } } },
      autoTrackEnabled: true };
    document.body.dataset.traceEarnedPermission = "true";
    document.getElementById("popup-earned-permission").hidden = false;
    if (code === "P1") renderEarnedAccessPending(story);
    if (code === "P2") renderEarnedSaved(story, saved, identity);
    if (code === "P3") renderEarnedPermissionInvitation(story, false, { granted: 1, required: 5 });
    if (code === "P3-lapse") renderEarnedPermissionInvitation(story, false, { granted: 1, required: 5 }, true);
    if (code === "P4") {
      configureEarnedActions({ label: "Waiting for Safari…", action: "", disabled: true, emphasis: "secondary" });
      setEarnedCopy({ stateCode: "P4", headingMarkup: "Tap <b>Always Allow</b>, not the blue button.",
        lead: "It lists 5 addresses. They’re all AO3 or FanFiction.net.",
        ruleMarkup: "Tap <b>Always Allow</b>, not the blue button.", duplicateRule: true });
      setEarnedResult("checking", "", "");
    }
    if (code === "P5") renderEarnedDelayed(story);
    if (code === "P6") renderEarnedConnectAccount(story);
    if (code === "P7") renderEarnedPermissionDeclined(story);
    if (code === "P8") renderEarnedSiteReady();
    if (code === "P9") renderEarnedUnavailable(story);
    if (code === "P10") await renderReaderView({ ...reader, activeWork: null, autoTrackEnabled: false });
    if (["P11", "P11-menu", "P11-menu-keyboard", "P11-settings", "P11-status-error"].includes(code)) {
      await renderReaderView(reader);
    }
    if (code === "P11-status-error") (setPopupStatusError || missing("setPopupStatusError"))("Status wasn’t changed. Try again.");
    const saveContext = { identity, story };
    if (code === "P1-known-saved") (renderEarnedCheckingLibrary || missing("renderEarnedCheckingLibrary"))();
    if (code === "P10-saving") (renderPopupSaveStory || missing("renderPopupSaveStory"))(saveContext, "saving");
    if (code === "P10-failed") (renderPopupSaveStory || missing("renderPopupSaveStory"))(saveContext, "failed", "save_failed");
    if (code === "other-account") (renderEarnedOtherAccount || missing("renderEarnedOtherAccount"))();
    if (code === "registration-failure") renderEarnedRegistrationFailure(story);
    if (code === "reload-page") renderPageReconnect();
    if (code === "library-full") (renderEarnedLibraryFull || missing("renderEarnedLibraryFull"))(true);
    if (code === "no-story") renderEarnedUnsupportedStory();
    if (code === "on-list") await renderReaderView({ ...reader, activeTab: { kind: "supported_archive", site: "ao3" }, activeWork: null });
    refreshEarnedLayout();
    window.dispatchEvent(new Event("resize"));
  }, state);
  if (state === "P11-menu") await page.locator("#popup-earned-status-control").tap();
  if (state === "P11-menu-keyboard") {
    await page.locator("#popup-earned-status-control").focus();
    await page.keyboard.press("Enter");
  }
  if (state === "P11-settings") await page.locator("#popup-earned-settings-row").tap();
  await page.waitForTimeout(80);
  const metrics = await page.evaluate(() => {
    const pin = document.getElementById("popup-earned-pin");
    const primary = document.getElementById("popup-earned-primary");
    const box = primary?.getBoundingClientRect();
    const kicker = document.getElementById("popup-earned-kicker");
    const menu = document.getElementById("popup-earned-status-menu");
    const preferences = document.getElementById("popup-preferences");
    const disconnect = document.getElementById("popup-session-secondary");
    return {
      state: document.body.dataset.tracePopupStateCode,
      innerHeight: window.innerHeight,
      bodyFontPx: getComputedStyle(document.body).fontSize,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      pinnedRatio: pin && getComputedStyle(pin).position === "sticky" ? pin.getBoundingClientRect().height / window.innerHeight : 0,
      primaryVisible: primary && !primary.hidden && getComputedStyle(primary).display !== "none",
      primaryBottom: box ? Math.ceil(box.bottom) : null,
      primaryText: primary?.textContent || "",
      axFlow: document.getElementById("popup-earned-permission")?.classList.contains("popup-earned-ax"),
      textAx: document.getElementById("popup-earned-permission")?.classList.contains("popup-earned-text-ax"),
      kickerVisible: Boolean(kicker && !kicker.hidden && getComputedStyle(kicker).display !== "none" && kicker.getBoundingClientRect().height),
      kickerText: kicker?.textContent?.trim() || "",
      leadHyphens: getComputedStyle(document.getElementById("popup-earned-lead")).hyphens,
      readerView: document.body.dataset.traceReaderView || null,
      menuRows: menu && !menu.hidden ? [...menu.querySelectorAll("button")].map((item) => ({
        label: item.textContent.replace("✓", "").trim(),
        status: item.querySelector(".popup-earned-record-dot")?.dataset.status || null,
        dotColor: item.querySelector(".popup-earned-record-dot") ? getComputedStyle(item.querySelector(".popup-earned-record-dot")).backgroundColor : null,
        weight: getComputedStyle(item).fontWeight,
        checked: item.getAttribute("aria-checked"),
        checkVisible: Boolean(item.querySelector(".popup-earned-menu-check")),
      })) : [],
      menuFocusVisible: Boolean(menu?.contains(document.activeElement) && document.activeElement.matches(":focus-visible")),
      settingsSwitches: preferences && !preferences.hidden ? [...preferences.querySelectorAll("input[type='checkbox']")].map((input) => ({
        id: input.id, visible: Boolean(input.getBoundingClientRect().height && getComputedStyle(input.closest("section")).display !== "none"),
      })) : [],
      disconnectVisible: Boolean(disconnect && !disconnect.hidden && getComputedStyle(disconnect).display !== "none" && disconnect.getBoundingClientRect().height),
      nestedSettingsScroll: Boolean(preferences?.querySelector(".popup-preferences-panel")?.scrollHeight > preferences?.querySelector(".popup-preferences-panel")?.clientHeight + 1),
      ground: getComputedStyle(document.documentElement).backgroundColor,
      bodyScrollHeight: document.body.scrollHeight,
      sectionScrollHeight: document.getElementById("popup-earned-permission")?.scrollHeight,
      scrollHeight: document.querySelector(".popup-earned-scroll")?.scrollHeight,
      sectionClasses: document.getElementById("popup-earned-permission")?.className,
    };
  });
  const file = `${device.name}-${appearance}-${size.name}__${state}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true, timeout: 120000 });
  if (device.name === "se" && appearance === "light" && size.name === "xxxl" && state === "P2") {
    metrics.scrollProbe = await page.evaluate(() => {
      window.scrollTo(0, 200);
      document.body.scrollTop = 200;
      return { windowY: window.scrollY, bodyY: document.body.scrollTop,
        scrollingElementY: document.scrollingElement?.scrollTop || 0 };
    });
    await page.screenshot({ path: path.join(output, "se-light-xxxl__P2-scrolled.png"), fullPage: false });
  }
  await page.close();
  return { type: "popup", file, device: device.name, appearance, size: size.name, state, metrics, errors };
}

// collector.js runs inside one IIFE, so its note helpers are not page globals.
// Preview renders append a hook inside that scope; shipped code is unchanged.
function collectorWithNotePreview(collector) {
  const end = collector.source.lastIndexOf("})();");
  if (end < 0) throw new Error("collector.js no longer ends with its IIFE; update the note preview hook");
  // Chromium has no -apple-system-body, so the hook sets the note's own font
  // size to the text-size proxy (capped at the note's 2x) before layout.
  const hook = "\nglobalThis.__traceVisualNote = function (kind, title, chapter, textPx) {\n" +
    "  var card = createStoryPageNote(kind, title, chapter, false).note;\n" +
    "  if (textPx) card.style.fontSize = Math.min(textPx, 34) + 'px';\n" +
    "  storySavedNoteMount(card);\n" +
    "  if (typeof applyStoryNoteLayout === 'function') applyStoryNoteLayout(card);\n" +
    "  activeStorySavedNote = card;\n  return card;\n};\n";
  return { name: collector.name, source: collector.source.slice(0, end) + hook + collector.source.slice(end) };
}

async function renderRestylePage(browser, scripts, output, device, size, host, state, phoneAppearance, supplement = false) {
  const listing = state.startsWith("N4");
  const fixture = listing ? "ao3_listing.html" : "ao3_story.html";
  const url = listing ? "https://archiveofourown.org/works?tag_id=Harry+Potter"
    : "https://archiveofourown.org/works/28534965/chapters/69925506";
  const page = await browser.newPage({
    viewport: { width: device.name === "17" ? 402 : 375, height: device.name === "17" ? 874 : 667 },
    deviceScaleFactor: 2, userAgent: RESTYLE_IOS_UA,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: phoneAppearance });
  const savedHandle = state === "N1-saved" || state === "N2";
  const cache = makeOverlayCache(savedHandle ? "planning-zero" : "default");
  cache.entries["ao3:28534965"] = {
    status: savedHandle ? "PLANNING" : "READING",
    readerStatus: savedHandle ? "PLANNING" : "READING",
    canonicalReaderStatus: savedHandle ? "SAVED" : "READING",
    entryId: "00000000-0000-4000-8000-000000285349",
    chapters: { current: savedHandle ? 0 : 5, total: 12 },
  };
  const storage = { ...makeStorageData(), libraryOverlayCache: cache };
  await page.addInitScript(extensionMockSource(storage));
  await installFixtureRoutes(page, fixtureHtmlForRendering(await readText(fixtureRoot, fixture)), url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ host, px }) => {
    const background = host === "dark" ? "#111111" : "#ffffff";
    document.documentElement.style.background = background;
    document.body.style.background = background;
    document.body.style.color = host === "dark" ? "#f2f6fa" : "#18232d";
    document.body.style.fontSize = `${px}px`;
  }, { host, px: size.px });
  const pageNote = state === "N2" || state === "N3";
  await injectScripts(page, listing ? [scripts.keys, scripts.overlay]
    : [pageNote ? collectorWithNotePreview(scripts.collector) : scripts.collector]);
  await page.waitForTimeout(250);
  if (pageNote) {
    await page.evaluate(({ kind, px }) => {
      window.__traceVisualNote(kind === "N2" ? "saved" : "kept", "Synthetic Archive Work", 5, px);
      const note = document.querySelector("trace-saved-note");
      if (note) {
        const card = note.__traceShadow.querySelector("[data-trace-saved-note]");
        if (card) { card.style.opacity = "1"; card.style.transform = "none"; }
      }
    }, { kind: state, px: size.px });
  }
  if (listing) {
    const selector = state === "N4-lens" ? "#work_10404927" : "#work_25010857";
    await page.locator(selector).scrollIntoViewIfNeeded();
  }
  const metrics = await page.evaluate(() => {
    const handle = document.querySelector("[data-trace-story-handle]");
    const chevron = handle?.querySelector("svg");
    const mark = document.querySelector("[data-trace-inline-work-mark-challenge]");
    return {
      hostTone: document.documentElement.dataset.traceHostTone || document.body.dataset.traceHostTone || null,
      surface: getComputedStyle(document.body).getPropertyValue("--trace-page-surface").trim(),
      ink: getComputedStyle(document.body).getPropertyValue("--trace-page-ink").trim(),
      teal: getComputedStyle(document.body).getPropertyValue("--trace-page-teal").trim(),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      noteVisible: Boolean(document.querySelector("trace-saved-note")),
      handleText: handle?.textContent?.trim() || null,
      handleStatus: handle?.getAttribute("data-trace-story-status") || null,
      chevron: chevron ? { width: chevron.getBoundingClientRect().width,
        height: chevron.getBoundingClientRect().height,
        viewBox: chevron.getAttribute("viewBox"), path: chevron.querySelector("path")?.getAttribute("d") } : null,
      workMark: mark ? { text: mark.textContent?.trim(), color: getComputedStyle(mark).color,
        weight: getComputedStyle(mark).fontWeight } : null,
    };
  });
  const file = supplement
    ? `${device.name}-${host}-phone-${phoneAppearance}-${size.name}__${state}.png`
    : `${device.name}-${host}-${size.name}__${state}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: false, timeout: 120000 });
  await page.close();
  return { type: supplement ? "page-supplement" : "page", file, device: device.name, host,
    phoneAppearance, size: size.name, state, metrics, errors };
}

async function renderRestyleMatrix(browser, assets, scripts, manifest) {
  const root = path.join(outputRoot, "matrix");
  await fs.mkdir(root, { recursive: true });
  const sample = process.argv.includes("--matrix-sample");
  const only = process.env.TRACE_MATRIX_STATES ? process.env.TRACE_MATRIX_STATES.split(",") : null;
  const states = only ? only.filter((state) => !state.startsWith("N"))
    : sample ? ["P2", "P3", "P11-menu"] : [...RESTYLE_STATES, ...RESTYLE_RECOVERY_STATES];
  const pageStates = only ? only.filter((state) => state.startsWith("N"))
    : sample ? ["N2", "N4-add-hide"] : RESTYLE_PAGE_STATES;
  const devices = RESTYLE_DEVICES;
  const sizes = RESTYLE_SIZES;
  const appearances = sample ? ["light"] : ["light", "dark"];
  const entries = [];
  for (const device of devices) for (const size of sizes) for (const appearance of appearances) {
    for (const state of states) {
      console.error(`Popup ${device.name} ${appearance} ${size.name} ${state}`);
      entries.push(await renderRestylePopup(browser, assets, root, device, appearance, size, state));
    }
  }
  for (const device of devices) for (const size of sizes) for (const host of ["light", "dark"]) {
    for (const state of pageStates) {
      const phoneAppearance = host === "light" ? "dark" : "light";
      console.error(`Page ${device.name} ${host} ${size.name} ${state}`);
      entries.push(await renderRestylePage(browser, scripts, root, device, size, host, state, phoneAppearance));
    }
  }
  if (!sample && !only) {
    for (const device of RESTYLE_DEVICES) for (const state of RESTYLE_PAGE_STATES) {
      console.error(`Page ${device.name} light-host light-phone large ${state}`);
      entries.push(await renderRestylePage(browser, scripts, root, device, RESTYLE_SIZES[0],
        "light", state, "light", true));
    }
  }
  manifest.matrix = {
    method: "Chromium rendering through the repository preview harness; text sizes are 17/26/36 px proxies, not iOS Dynamic Type",
    expectedPopup: sample ? 18 : (RESTYLE_STATES.length + RESTYLE_RECOVERY_STATES.length) * 12,
    expectedPage: sample ? 24 : 72,
    supplementaryLightHostPhoneLight: sample ? 0 : 12,
    entries,
  };
  await fs.writeFile(path.join(outputRoot, "index.json"), JSON.stringify(manifest, null, 2) + "\n");
}

async function renderRestyleQa1(browser, assets, scripts, manifest) {
  const entries = [];
  for (const device of RESTYLE_DEVICES) for (const size of RESTYLE_SIZES) {
    for (const appearance of ["light", "dark"]) {
      const states = ["P3", "P3-lapse"];
      if (size.name !== "xxxl") states.push("P11-settings", "P11-menu");
      if (device.name === "se" && size.name === "large") states.push("P11-menu-keyboard");
      for (const state of states) {
        console.error(`QA1 popup ${device.name} ${appearance} ${size.name} ${state}`);
        entries.push(await renderRestylePopup(browser, assets, outputRoot, device, appearance, size, state));
      }
    }
  }
  for (const device of RESTYLE_DEVICES) for (const size of RESTYLE_SIZES) {
    for (const host of ["light", "dark"]) {
      const states = ["N2"];
      if (size.name !== "xxxl") states.push("N1-saved", "N1-reading", "N4-lens", "N4-add-hide");
      for (const state of states) {
        console.error(`QA1 page ${device.name} ${host} ${size.name} ${state}`);
        entries.push(await renderRestylePage(browser, scripts, outputRoot, device, size, host, state,
          host === "light" ? "dark" : "light"));
      }
    }
  }
  const failures = [];
  for (const entry of entries) {
    const m = entry.metrics;
    if (entry.errors.length) failures.push(`${entry.file}: ${entry.errors.join("; ")}`);
    if (entry.state === "P3" || entry.state === "P3-lapse") {
      const large = entry.size !== "ax5";
      if (m.kickerVisible !== large || m.textAx === large || m.leadHyphens !== (large ? "none" : "auto")) {
        failures.push(`${entry.file}: kicker or hyphenation differs from text-size rule`);
      }
    }
    if (entry.state === "P11-settings") {
      if (m.readerView !== "settings" || m.settingsSwitches.length !== 4 ||
          m.settingsSwitches.some((switchRow) => !switchRow.visible) || !m.disconnectVisible || m.nestedSettingsScroll) {
        failures.push(`${entry.file}: four switches and Disconnect must use the document scroll`);
      }
    }
    if (entry.state === "P11-menu" || entry.state === "P11-menu-keyboard") {
      if (m.menuRows.length !== 6 || m.menuRows.some((row) => !row.status || !row.dotColor || row.weight !== "400") ||
          m.menuRows.filter((row) => row.checked === "true" && row.checkVisible).length !== 1 ||
          m.menuFocusVisible !== (entry.state === "P11-menu-keyboard")) {
        failures.push(`${entry.file}: status rows or input-modality focus differs from the contract`);
      }
    }
    if (entry.state === "N1-saved" || entry.state === "N1-reading") {
      if (m.chevron?.viewBox !== "0 0 10 7" || m.chevron?.width !== 10 || m.chevron?.height !== 7) {
        failures.push(`${entry.file}: handle chevron is not 10 by 7`);
      }
    }
    if (entry.state === "N4-lens" || entry.state === "N4-add-hide") {
      if (!m.workMark || m.workMark.weight !== "600" ||
          m.workMark.color === "rgb(155, 65, 70)" || m.workMark.color === "rgb(231, 161, 159)") {
        failures.push(`${entry.file}: chapter work mark is missing or uses warning styling`);
      }
    }
    if (entry.state === "N2" && (!m.noteVisible || m.handleStatus !== "SAVED" || !m.handleText?.includes("Saved"))) {
      failures.push(`${entry.file}: first-save note must accompany a Saved handle`);
    }
  }
  manifest.qa1 = {
    method: "Targeted Chromium popup preview and injected page fixtures; 17/26/36 px text-size proxies",
    counts: { popup: entries.filter((entry) => entry.type === "popup").length,
      page: entries.filter((entry) => entry.type === "page").length },
    failures,
    entries,
  };
  await fs.writeFile(path.join(outputRoot, "index.json"), JSON.stringify(manifest, null, 2) + "\n");
  const examples = ["se-light-large__P3.png", "se-dark-xxxl__P3-lapse.png", "se-light-ax5__P3.png",
    "se-dark-large__P11-settings.png", "se-light-large__P11-menu.png", "se-light-large__P11-menu-keyboard.png",
    "se-light-large__N1-saved.png", "se-dark-large__N4-lens.png", "17-light-large__N2.png"];
  const index = [
    "# Popup and page design QA 1",
    "",
    `Extension render source: ${manifest.generatedAt}. Targeted preview: ${manifest.qa1.counts.popup} popup and ${manifest.qa1.counts.page} page captures.`,
    "Text sizes use 17/26/36 px proxies, not iOS Dynamic Type. The [JSON index](index.json) lists every capture and measured result.",
    "N2 fixtures pair the first-save note with a confirmed Saved handle.",
    "",
    ...examples.map((file) => `- [${file}](${file})`),
    "",
    `Automated audit: ${failures.length} failure(s).`,
  ].join("\n") + "\n";
  await fs.writeFile(path.join(outputRoot, "index.md"), index);
  if (failures.length) throw new Error(`QA1 capture audit failed:\n${failures.join("\n")}`);
}


async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  const { chromium } = await loadPlaywright();
  const assets = {
    keys: { name: "library-overlay-keys.js", source: await readText(resourceRoot, "library-overlay-keys.js") },
    overlay: { name: "library-overlay.js", source: await readText(resourceRoot, "library-overlay.js") },
    collector: { name: "collector.js", source: await readText(resourceRoot, "collector.js") },
    finish: { name: "trace-finish-qualify.js", source: await readText(resourceRoot, "trace-finish-qualify.js") },
    savedFilters: { name: "ao3-saved-filters.js", source: await readText(resourceRoot, "ao3-saved-filters.js") },
    popupHtml: await readText(resourceRoot, "popup.html"),
    popupCss: await readText(resourceRoot, "popup.css"),
    popupJs: await readText(resourceRoot, "popup.js"),
    markSvg: await readText(resourceRoot, "images", "trace-icon.svg"),
  };
  const scripts = {
    keys: assets.keys,
    overlay: assets.overlay,
    collector: assets.collector,
    finish: assets.finish,
    savedFilters: assets.savedFilters,
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
  if (visualMode === "qa1") {
    try { await renderRestyleQa1(browser, assets, scripts, manifest); }
    finally { await browser.close(); }
    console.log(`QA1 index: ${path.join(outputRoot, "index.md")}`);
    return;
  }
  if (visualMode === "matrix") {
    try { await renderRestyleMatrix(browser, assets, scripts, manifest); }
    finally { await browser.close(); }
    console.log(`Matrix index: ${path.join(outputRoot, "index.json")}`);
    return;
  }
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
        name: "AO3 listing signed-out connect notice",
        file: "ao3-listing-signed-out-notice.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 900, height: 520 },
        contentScripts: ["keys", "overlay"],
        authState: {
          state: "signed_out",
          message: "Open Trace and sign in once to connect the extension. Then refresh this AO3 tab to restore sync.",
          helpUrl: "https://tracefiction.com/apps",
        },
        waitFor: "[data-trace-connect-notice]",
        focusForScreenshot: {
          target: "[data-trace-connect-notice]",
        },
      },
      {
        name: "AO3 listing quick-add free limit",
        file: "ao3-listing-quick-add-free-limit.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 900, height: 520 },
        contentScripts: ["keys", "overlay"],
        storageData: { traceMockQuickAddError: "free_limit_reached" },
        waitFor: "#work_25010857 [data-trace-quick-add]",
        scrollTo: "#work_25010857",
        clickSelector: "#work_25010857 [data-trace-quick-add]",
        clickWaitForText: "Full",
        focusForScreenshot: {
          target: "#work_25010857 [data-trace-library-overlay-wrap]",
          closest: "li.work",
        },
      },
      {
        name: "AO3 listing capacity recovery notice",
        file: "ao3-listing-capacity-recovery-notice.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 900, height: 620 },
        contentScripts: ["keys", "overlay"],
        storageData: { traceMockQuickAddError: "free_limit_reached" },
        waitFor: "#work_25010857 [data-trace-quick-add]",
        scrollTo: "#work_25010857",
        clickSelector: "#work_25010857 [data-trace-quick-add]",
        clickWaitFor: "[data-trace-capacity-notice]",
      },
      {
        name: "AO3 listing capacity recovery notice mobile",
        file: "ao3-listing-capacity-recovery-notice-mobile.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 390, height: 844 },
        contentScripts: ["keys", "overlay"],
        storageData: { traceMockQuickAddError: "free_limit_reached" },
        waitFor: "#work_25010857 [data-trace-quick-add]",
        scrollTo: "#work_25010857",
        clickSelector: "#work_25010857 [data-trace-quick-add]",
        clickWaitFor: "[data-trace-capacity-notice]",
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
        name: "AO3 story signed-out sheet",
        file: "ao3-story-signed-out-sheet.png",
        fixture: "ao3_story.html",
        url: "https://archiveofourown.org/works/28534965/chapters/71063826",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["collector"],
        authState: {
          state: "signed_out",
          message: "Open Trace and sign in once to connect the extension. Then refresh this AO3 tab to restore sync.",
          helpUrl: "https://tracefiction.com/apps",
        },
        waitFor: "[data-trace-story-handle][data-trace-story-handle-state='auth']",
        scrollTo: "[data-trace-story-handle]",
        scrollBlock: "start",
        openSelector: "[data-trace-story-handle]",
        openWaitFor: "[data-trace-story-sheet][data-trace-open='1']",
      },
      {
        name: "AO3 story free-limit handle",
        file: "ao3-story-free-limit-handle.png",
        fixture: "ao3_story.html",
        url: "https://archiveofourown.org/works/28534965/chapters/71063826",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["collector"],
        cacheVariant: "story-free-limit",
        storageData: { prefAutoTrackEnabled: false },
        waitFor: "[data-trace-story-handle][data-trace-story-handle-state='full']",
        scrollTo: "[data-trace-story-handle]",
        scrollBlock: "start",
      },
      {
        name: "AO3 story free-limit recovery sheet",
        file: "ao3-story-free-limit-recovery-sheet.png",
        fixture: "ao3_story.html",
        url: "https://archiveofourown.org/works/28534965/chapters/71063826",
        viewport: { width: 1440, height: 1000 },
        contentScripts: ["collector"],
        cacheVariant: "story-free-limit",
        storageData: { prefAutoTrackEnabled: false },
        waitFor: "[data-trace-story-handle][data-trace-story-handle-state='full']",
        scrollTo: "[data-trace-story-handle]",
        scrollBlock: "start",
        openSelector: "[data-trace-story-handle]",
        openWaitFor: "[data-trace-story-sheet][data-trace-open='1']",
      },
      {
        name: "AO3 story free-limit recovery sheet mobile",
        file: "ao3-story-free-limit-recovery-sheet-mobile.png",
        fixture: "ao3_story.html",
        url: "https://archiveofourown.org/works/28534965/chapters/71063826",
        viewport: { width: 390, height: 844 },
        contentScripts: ["collector"],
        cacheVariant: "story-free-limit",
        storageData: { prefAutoTrackEnabled: false },
        waitFor: "[data-trace-story-handle][data-trace-story-handle-state='full']",
        scrollTo: "[data-trace-story-handle]",
        scrollBlock: "start",
        openSelector: "[data-trace-story-handle]",
        openWaitFor: "[data-trace-story-sheet][data-trace-open='1']",
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
        name: "Opened AO3 listing action surface mobile",
        file: "ao3-listing-action-surface-mobile.png",
        fixture: "ao3_listing.html",
        url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
        viewport: { width: 390, height: 844 },
        contentScripts: ["keys", "overlay"],
        waitFor: "#work_10404927 [data-trace-library-lens]",
        scrollTo: "#work_10404927",
        openSelector: "#work_10404927 [data-trace-library-lens]",
        openWaitFor: "[data-trace-action-surface]",
      },
      {
        name: "AO3 Saved to Reading result",
        file: "ao3-saved-reading-result.png",
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
      {
        name: "AO3 finish status decision",
        file: "ao3-finish-status-decision.png",
        fixture: "ao3_story.html",
        url: "https://archiveofourown.org/works/28534965/chapters/71063826",
        viewport: { width: 390, height: 844 },
        contentScripts: ["finish"],
        finishQualify: { kind: "prompt", anchorSelector: "#chapters", source: "AO3" },
        waitFor: "[data-trace-finish-qualify]",
        scrollTo: "[data-trace-finish-qualify]",
        focusForScreenshot: { target: "[data-trace-finish-qualify]" },
        corrective: true,
      },
      {
        name: "FFN automatic finish confirmation",
        file: "ffn-auto-finish-confirmation.png",
        fixture: "ffn_story_mobile.html",
        url: "https://m.fanfiction.net/s/7038840/28/Stay-Standing",
        viewport: { width: 390, height: 844 },
        contentScripts: ["finish"],
        finishQualify: { kind: "toast", anchorSelector: "#content", source: "FanFiction.net", result: "finished" },
        waitFor: "[data-trace-finish-toast]",
        focusForScreenshot: { target: "[data-trace-finish-toast]" },
        corrective: true,
      },
      {
        name: "AO3 saved-filter management tray",
        file: "ao3-saved-filter-management.png",
        fixture: "../fixtures/ao3_listing.html",
        url: "https://archiveofourown.org/works?work_search%5Bsort_column%5D=kudos_count&work_search%5Bcomplete%5D=T&tag_id=Harry+Potter+-+J*d*+K*d*+Rowling",
        viewport: { width: 390, height: 844 },
        contentScripts: ["savedFilters"],
        storageData: {
          traceAo3SavedFiltersPanelCollapsedV1: true,
          traceAo3SavedFiltersV1: [
            {
              id: "visual-context-1",
              name: "Long complete works",
              params: [["work_search[complete]", "T"], ["work_search[sort_column]", "kudos_count"]],
              scope: "context",
              context: { type: "tagId", key: "tagId:Harry Potter - J. K. Rowling", tagId: "Harry Potter - J. K. Rowling", label: "Harry Potter" },
              summary: ["Complete works only", "Sort: Kudos"],
            },
            {
              id: "visual-global-1",
              name: "Quiet comfort reads",
              params: [["work_search[other_tag_names]", "Fluff"]],
              scope: "global",
              summary: ["Include: Fluff"],
            },
          ],
        },
        waitFor: "[data-trace-ao3-saved-filters]",
        openSelector: ".trace-sf-head",
        openWaitFor: ".trace-sf-menu-btn",
        clickSelector: ".trace-sf-menu-btn",
        clickWaitFor: ".trace-sf-manage",
        focusForScreenshot: { target: "[data-trace-ao3-saved-filters]" },
        corrective: true,
      },
    ];

    // Dark-host twins for every surface family the contract covers.
    const darkHostTwins = [
      "Opened AO3 story sheet", "Opened AO3 listing action surface", "AO3 listing signed-out connect notice",
      "AO3 listing capacity recovery notice", "AO3 finish status decision", "FFN automatic finish confirmation",
      "AO3 saved-filter management tray", "AO3 story top", "AO3 listing desktop",
    ];
    for (const name of darkHostTwins) {
      const base = fixtureScreenshots.find((definition) => definition.name === name);
      if (!base) throw new Error(`Missing fixture ${name} for its dark-host twin`);
      fixtureScreenshots.push({ ...base, name: `${name} (dark host)`, file: base.file.replace(/\.png$/, "-dark-host.png"), darkHost: true });
    }

    if (visualMode === "all" || visualMode === "capacity" || visualMode === "corrective") {
      const selectedFixtures = visualMode === "capacity"
        ? fixtureScreenshots.filter((definition) =>
            /capacity|free-limit/i.test(definition.name)
          )
        : visualMode === "corrective"
          ? fixtureScreenshots.filter((definition) => definition.corrective === true)
        : fixtureScreenshots;
      for (const definition of selectedFixtures) {
        await renderFixtureScreenshot(browser, definition, scripts, manifest);
      }
    }

    const popupScreenshots = [
      {
        name: "iOS earned-permission first save",
        file: "popup-ios-earned-first-save.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          traceEarnedPermissionOnboarding: true,
          traceFirstSaveSeen: false,
          traceLibraryCount: 0,
        },
        viewport: { width: 360, height: 680 },
        firstViewportMaxHeight: 360,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS earned-permission reopen after denial",
        file: "popup-ios-earned-reopen-after-denial.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          traceEarnedPermissionOnboarding: true,
          traceEarnedPermissionOnboardingV1: {
            firstSaveAt: Date.now() - 60_000,
            promptResult: "declined",
          },
        },
        viewport: { width: 360, height: 680 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS earned-permission denied",
        file: "popup-ios-earned-denied.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          traceEarnedPermissionOnboarding: true,
          tracePermissionRequestResult: false,
        },
        clickSelector: "#popup-earned-primary",
        clickWaitForText: "Nothing was saved",
        viewport: { width: 360, height: 680 },
        firstViewportMaxHeight: 360,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS earned-permission adding story",
        file: "popup-ios-earned-adding-story.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          traceEarnedPermissionOnboarding: true,
          tracePermissionRequestPending: true,
        },
        clickSelector: "#popup-earned-primary",
        clickWaitForText: "Tap Always Allow",
        viewport: { width: 360, height: 680 },
        firstViewportMaxHeight: 360,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS earned-permission registration failure",
        file: "popup-ios-earned-registration-failure.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          traceEarnedPermissionOnboarding: true,
          traceGrantedOrigins: [
            "https://*.archiveofourown.org/*",
            "https://*.archiveofourown.gay/*",
            "https://archive.transformativeworks.org/*",
            "https://www.fanfiction.net/*",
            "https://m.fanfiction.net/*",
          ],
          traceEarnedPermissionReconcileResult: {
            ok: false,
            completeGrant: true,
            registered: false,
            changed: false,
            error: "registration_failed",
          },
        },
        viewport: { width: 360, height: 680 },
        firstViewportMaxHeight: 360,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS earned-permission unsupported page",
        file: "popup-ios-earned-unsupported.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          traceEarnedPermissionOnboarding: true,
          traceProbeUrl: "https://www.google.com/",
        },
        viewport: { width: 360, height: 680 },
        firstViewportMaxHeight: 360,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS post-onboarding extension controls",
        file: "popup-ios-post-onboarding-controls.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: postOnboardingPopupStorageData(),
        viewport: { width: 360, height: 680 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "dark",
      },
      {
        name: "iOS post-onboarding expanded settings",
        file: "popup-ios-post-onboarding-settings-expanded.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: "visual-account",
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          ...postOnboardingPopupStorageData(),
          traceActiveTab: { kind: "supported_story", site: "ao3", canImport: true },
          traceActiveWork: { status: "saved", entry: {
            entryId: "00000000-0000-4000-8000-000000285349",
            canonicalReaderStatus: "READING", chapters: { current: 6, total: 12 },
          } },
        },
        clickSelector: "#popup-earned-settings-row",
        viewport: { width: 360, height: 680 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "dark",
      },
      {
        name: "iOS active-tab probe success",
        file: "popup-ios-active-tab-probe-success.png",
        authState: connectedAuthState(),
        storageData: {
          traceActiveTabProbe: true,
        },
        viewport: { width: 360, height: 620 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS active-tab probe current-tab failure",
        file: "popup-ios-active-tab-probe-failure.png",
        authState: connectedAuthState(),
        storageData: {
          traceActiveTabProbe: true,
          traceProbeInjectionFailure: true,
        },
        viewport: { width: 360, height: 620 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "iOS active-tab probe unsupported page",
        file: "popup-ios-active-tab-probe-unsupported.png",
        authState: connectedAuthState(),
        storageData: {
          traceActiveTabProbe: true,
          traceProbeUrl: "https://www.google.com/",
        },
        viewport: { width: 360, height: 620 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "light",
      },
      {
        name: "Extension popup connected",
        file: "popup-connected.png",
        authState: connectedAuthState(),
        colorScheme: "dark",
      },
      {
        name: "Extension popup first run on story",
        file: "popup-first-run-story.png",
        authState: connectedAuthState(),
        storageData: {
          traceFirstSaveSeen: false,
          traceLibraryCount: 0,
          traceActiveTab: { kind: "supported_story", site: "ao3", canImport: true },
        },
        colorScheme: "dark",
      },
      {
        name: "Kernel popup iOS first run on story",
        file: "popup-kernel-ios-first-run-story.png",
        authState: connectedAuthState(),
        sessionSnapshot: {
          state: "connected",
          accountId: null,
          canExecuteAuthenticated: true,
          reason: "none",
        },
        storageData: {
          traceFirstSaveSeen: false,
          traceLibraryCount: 0,
          traceActiveTab: { kind: "supported_story", site: "ao3", canImport: true },
        },
        viewport: { width: 360, height: 520 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        colorScheme: "dark",
      },
      {
        name: "Extension popup signed out",
        file: "popup-signed-out.png",
        authState: {
          state: "signed_out",
          message: "Open Trace in this browser and sign in. Then return to an AO3 or FFN story page to save your first story.",
          helpUrl: "https://tracefiction.com/apps",
        },
        colorScheme: "dark",
      },
      {
        name: "Extension popup iOS signed out",
        file: "popup-ios-signed-out.png",
        authState: {
          state: "signed_out",
          message: "Open Trace in Safari and sign in.",
          helpUrl: "https://tracefiction.com/apps#safari-ios-setup",
        },
        viewport: { width: 360, height: 520 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
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
      {
        name: "Extension popup library full",
        file: "popup-library-full.png",
        authState: connectedAuthState(),
        storageData: {
          traceLibraryCount: 100,
          traceUserPro: false,
          traceCapacityRecovery: { blocked: true, prompt: false },
        },
        colorScheme: "light",
      },
      {
        name: "Extension popup library full dark",
        file: "popup-library-full-dark.png",
        authState: connectedAuthState(),
        storageData: {
          traceLibraryCount: 100,
          traceUserPro: false,
          traceCapacityRecovery: { blocked: true, prompt: false },
        },
        colorScheme: "dark",
      },
      {
        name: "Kernel popup connected",
        file: "popup-kernel-connected.png",
        sessionSnapshot: {
          state: "connected",
          accountId: null,
          canExecuteAuthenticated: true,
          reason: "none",
        },
        colorScheme: "light",
      },
      {
        name: "Kernel popup degraded",
        file: "popup-kernel-degraded.png",
        sessionSnapshot: {
          state: "degraded",
          accountId: null,
          canExecuteAuthenticated: false,
          reason: "verification_unavailable",
        },
        colorScheme: "light",
      },
      {
        name: "Kernel popup reconnect required",
        file: "popup-kernel-reconnect-required.png",
        sessionSnapshot: {
          state: "reconnect_required",
          accountId: null,
          canExecuteAuthenticated: false,
          reason: "credential_rejected",
        },
        colorScheme: "light",
      },
    ];

    const selectedPopups = visualMode === "capacity"
      ? popupScreenshots.filter((definition) => /library full/i.test(definition.name))
      : visualMode === "corrective"
        ? popupScreenshots.filter((definition) => definition.file === "popup-ios-post-onboarding-controls.png")
      : popupScreenshots;
    for (const definition of selectedPopups) {
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
