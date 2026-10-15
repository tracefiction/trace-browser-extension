#!/usr/bin/env node
// The first-tap sheet as an iPhone draws it: the popup page, headless, at an
// iPhone's width, in WebKit (Safari's engine) and Chromium. The background's
// side of the port is stood in for; the page, its styles and its script are
// the packaged ones, with the release build's popup setup.
//
// Safari lays the popup out before it has sized the sheet, so the sheet's
// first state may be drawn while the page is still narrow. Whenever it is
// drawn, "Save this story" must be the height it is on a sheet drawn at full
// width from the start.
//
// TRACE_SHEET_LAYOUT_SHOTS=<directory> also saves a picture of each state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = path.join(ROOT, "Shared (Extension)", "Resources");
const read = (name) => fs.readFileSync(path.join(RESOURCES, name), "utf8");
const assets = { html: read("popup.html"), css: read("popup.css"), js: read("popup.js") };
const config = read("popup-config.js").match(/TRACE_IOS_EARNED_PERMISSION_ONBOARDING = (\{.*?\});\n/)?.[1];
assert.ok(config, "the packaged popup setup names the optional story sites");
assert.equal(JSON.parse(config).firstTapSave, undefined, "the packaged popup setup is a release one: no saving on opening");
const shots = process.env.TRACE_SHEET_LAYOUT_SHOTS || "";
if (shots) fs.mkdirSync(shots, { recursive: true });

const WIDTH = 390;
const HEIGHT = 700;
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1";
const STORY_URL = "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter";
const WORK_KEY = "ffn:7038840";
const STORY = { title: "A Chance Encounter", author: "someone", site: "FanFiction.net" };
const ENTRY = { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", chapters: { current: 1, total: 12 } };
const OFFER = { state: "awaiting_request", workKey: WORK_KEY, preference: "on", story: STORY };

const extension = `(() => {
  const store = { prefAutoTrackEnabled: true };
  window.__sent = [];
  const answer = (value, callback) => {
    if (typeof callback === "function") setTimeout(() => callback(value), 0);
    return Promise.resolve(value);
  };
  const api = {
    runtime: {
      id: "trace", lastError: null,
      getURL: (resource) => "safari-web-extension://trace/" + resource,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        const snapshot = { state: "connected", accountId: "a", canExecuteAuthenticated: true, reason: "none" };
        const session = message && (message.type === "TRACE_SESSION_GET_SNAPSHOT" || message.type === "TRACE_SESSION_ACTION");
        return answer(session ? { ok: true, snapshot } : { ok: true }, callback);
      },
      connect() {
        const listeners = [];
        window.__emit = (message) => listeners.forEach((listener) => listener(message));
        return {
          postMessage(message) { window.__sent.push(message); },
          onMessage: { addListener(listener) { listeners.push(listener); } },
          onDisconnect: { addListener() {} },
          disconnect() {},
        };
      },
    },
    storage: {
      local: {
        get(keys, callback) {
          const names = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || store);
          return answer(Object.fromEntries(names.map((name) => [name, store[name]])), callback);
        },
        set(values, callback) { Object.assign(store, values); return answer(undefined, callback); },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => [{ id: 7, url: ${JSON.stringify(STORY_URL)}, incognito: false }],
      sendMessage: async () => ({ ok: false }),
      reload: async () => {},
    },
    permissions: {
      getAll: async () => ({ origins: [], permissions: [] }),
      contains: async () => false,
      request: async () => false,
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    scripting: {
      executeScript: async () => [], getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
    },
  };
  window.chrome = api;
  window.browser = api;
  window.TRACE_SESSION_MODE = "kernel";
  window.TRACE_IOS_EARNED_PERMISSION_ONBOARDING = ${config};
})();`;

async function openSheet(browser, { width = WIDTH, height = HEIGHT } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, userAgent: USER_AGENT });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(extension);
  await page.route("**/*", (route) => {
    const file = new URL(route.request().url()).pathname;
    if (file.endsWith("/popup.css")) return route.fulfill({ contentType: "text/css", body: assets.css });
    if (file.endsWith("/popup.js")) return route.fulfill({ contentType: "application/javascript", body: assets.js });
    if (file.endsWith(".js")) return route.fulfill({ contentType: "application/javascript", body: "" });
    return route.fulfill({ contentType: "text/html", body: assets.html });
  });
  await page.goto("https://trace.local/popup.html");
  await page.waitForFunction(() => typeof window.__emit === "function");
  const emit = (message) => page.evaluate((sent) => window.__emit(sent), message);
  const measure = () => page.evaluate(() => {
    const box = (id) => document.getElementById(id)?.getBoundingClientRect();
    const primary = document.getElementById("popup-earned-primary");
    return {
      state: document.body.dataset.traceFirstTapState,
      heading: document.getElementById("popup-earned-heading")?.textContent.trim(),
      // What is shown, not the words read aloud beside it.
      byline: document.querySelector("#popup-earned-record-byline > [aria-hidden='true']")?.textContent.trim(),
      button: primary.hidden ? null : { label: primary.textContent.trim(), height: Math.round(box("popup-earned-primary").height), disabled: primary.disabled },
      pin: Math.round(box("popup-earned-pin").height),
      sent: window.__sent.map(({ command }) => command),
    };
  });
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
  };
  return { page, emit, measure, shot, errors };
}

const settle = (page) => page.waitForTimeout(150);

async function run(engine) {
  const browser = await playwright[engine].launch({ headless: true });
  try {
    // A fresh open: the sheet is its full width before the offer arrives.
    const fresh = await openSheet(browser);
    await fresh.emit({ view: OFFER });
    await settle(fresh.page);
    const offered = await fresh.measure();
    assert.equal(offered.state, "save-on-request", engine);
    assert.equal(offered.heading, STORY.title, `${engine}: the offer names the story`);
    assert.equal(offered.byline, `${STORY.author} · ${STORY.site}`, engine);
    assert.equal(offered.button.label, "Save this story", engine);
    assert.ok(offered.button.height >= 44 && offered.button.height <= 56, `${engine}: a button's height, not the sheet's (${offered.button.height}px)`);
    await fresh.shot(`${engine}-1-SH0-fresh-open`);

    // Opened again on a story seen before: the background answers before
    // Safari has sized the sheet, so the offer is drawn while the page is
    // narrow, and the page then widens to the sheet.
    for (const narrow of [1, 40, 120]) {
      const early = await openSheet(browser, { width: narrow });
      await early.emit({ view: OFFER });
      await settle(early.page);
      await early.page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await settle(early.page);
      const drawn = await early.measure();
      assert.equal(drawn.button.height, offered.button.height, `${engine}: drawn at ${narrow}px then widened, the button is its own height`);
      assert.equal(drawn.pin, offered.pin, `${engine}: and so is what holds it`);
      if (narrow === 1) await early.shot(`${engine}-2-SH0-drawn-before-the-sheet-was-sized`);
      assert.deepEqual(early.errors, [], engine);
      await early.page.close();
    }

    // The tap: the button waits, the save is asked for once, and its answer moves the sheet on.
    await fresh.page.locator("#popup-earned-primary").tap();
    await settle(fresh.page);
    const tapped = await fresh.measure();
    assert.deepEqual(tapped.sent, ["open", "save"], engine);
    assert.equal(tapped.button.disabled, true, `${engine}: the tapped button waits on its answer`);
    assert.equal(tapped.button.height, offered.button.height, engine);
    await fresh.shot(`${engine}-3-tapped-waiting`);
    await fresh.page.locator("#popup-earned-primary").tap({ force: true });
    await settle(fresh.page);
    assert.deepEqual((await fresh.measure()).sent, ["open", "save"], `${engine}: a second tap sends nothing more`);
    const look = await fresh.page.evaluate(() => window.__sent.at(-1).look);
    await fresh.emit({ view: { state: "saving", workKey: WORK_KEY, startedAt: 0, story: STORY }, answered: look });
    await settle(fresh.page);
    assert.equal((await fresh.measure()).state, "saving", engine);
    await fresh.shot(`${engine}-4-SH1-saving`);
    await fresh.emit({ view: { state: "confirmed", workKey: WORK_KEY, provenance: "saved_now", mode: "bounded_manual", story: STORY, entry: ENTRY } });
    await fresh.page.waitForTimeout(1_800);
    const saved = await fresh.measure();
    assert.equal(saved.state, "saved", engine);
    assert.equal(saved.button.label, "Allow AO3 and FanFiction.net", `${engine}: then the ask`);
    await fresh.shot(`${engine}-5-SH2-saved-then-ask`);
    // Opened again on the same story by the same sheet: never the offer again.
    await fresh.emit({ view: OFFER });
    await settle(fresh.page);
    assert.equal((await fresh.measure()).state, "saved", `${engine}: a confirmed save is not taken back to the offer`);
    assert.deepEqual(fresh.errors, [], engine);
    await fresh.page.close();

    // A tap that no background answers, over the first port or a new one:
    // the sheet says so, and never sits on the offer.
    const unanswered = await openSheet(browser);
    await unanswered.emit({ view: OFFER });
    await settle(unanswered.page);
    await unanswered.page.locator("#popup-earned-primary").tap();
    await unanswered.page.waitForTimeout(8_400);
    const silent = await unanswered.measure();
    assert.deepEqual(silent.sent, ["open", "save", "save"], `${engine}: sent once more, over a new port`);
    assert.equal(silent.state, "save-unconfirmed", engine);
    assert.equal(silent.heading, "Trace couldn’t confirm this save", engine);
    assert.equal(silent.button.label, "Check again", engine);
    await unanswered.shot(`${engine}-7-SH13b-tap-unanswered`);
    await unanswered.page.close();

    // Opened on a story already in the Library.
    const already = await openSheet(browser);
    await already.emit({ view: { state: "confirmed", workKey: WORK_KEY, provenance: "already", mode: null, story: STORY, entry: ENTRY } });
    await already.page.waitForTimeout(1_800);
    const there = await already.measure();
    assert.equal(there.state, "already-in-library", engine);
    assert.equal(await already.page.evaluate(() => document.getElementById("popup-earned-kicker").textContent.trim()), "Already in your Library");
    await already.shot(`${engine}-6-SH10-already-in-library`);
    assert.deepEqual(already.errors, [], engine);
    await already.page.close();
  } finally {
    await browser.close();
  }
}

for (const engine of ["webkit", "chromium"]) {
  await run(engine);
  console.log(`first-tap sheet layout: ${engine} ok`);
}
