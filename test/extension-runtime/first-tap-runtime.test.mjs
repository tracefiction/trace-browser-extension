import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_TAP_PAGE_FILES,
  installFirstTapSave,
} from "../../.trace-build/extension-runtime/first-tap-runtime.mjs";

const STORY_URL = "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter";
const WORK_KEY = "ffn:7038840";
const FIVE = ["https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*", "https://www.fanfiction.net/*", "https://m.fanfiction.net/*"];
const ENTRY_ID = "00000000-0000-4000-8000-000000000123";
const CONFIRMATION = {
  workKey: WORK_KEY, entryId: ENTRY_ID,
  entry: { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", entryId: ENTRY_ID },
  syncVersion: "2026-10-12T12:00:00.000Z",
};

async function turns() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

function harness({ granted = false, registered = [] } = {}) {
  const state = {
    granted, registered, binding: "1.aaa",
    tabs: { 7: { id: 7, url: STORY_URL, active: true }, 9: { id: 9, url: "https://www.fanfiction.net/s/999/1/Other", active: false } },
  };
  const calls = { injections: [], tabMessages: [], saves: [], presence: [], store: {}, gets: [] };
  let connect = null;
  let admission = null;
  const runtime = { id: "trace-test", onConnect: { addListener(fn) { connect = fn; } } };
  const afterScriptsRegistered = installFirstTapSave({
    runtime,
    mode: "promise",
    origins: FIVE,
    registrationIds: ["trace-archive-automation-v1", "trace-ao3-saved-filters-v1"],
    permissions: {
      async contains({ origins }) { assert.deepEqual(origins, FIVE); return state.granted; },
      request() { assert.fail("the background never asks for website access"); },
    },
    scripting: {
      async executeScript(injection) { calls.injections.push(injection); },
      async getRegisteredContentScripts() { return state.registered.map((id) => ({ id })); },
      async registerContentScripts() { assert.fail("a first tap registers nothing"); },
      async unregisterContentScripts() { assert.fail("a first tap unregisters nothing"); },
    },
    tabs: {
      async query() { assert.fail("no tab is searched for: the popup names the one it was opened on"); },
      async get(tabId) { calls.gets.push(tabId); return state.tabs[tabId] ?? null; },
      async create() { assert.fail("no tab is opened"); },
      async sendMessage(tabId, message, options) {
        calls.tabMessages.push({ tabId, message, options });
        if (message.type !== "TRACE_FIRST_TAP_COLLECT") return { ok: true };
        return {
          ok: true, workKey: WORK_KEY, title: "A Chance Encounter", author: "someone",
          payload: { s: "ffn", at: "2026-10-12T12:00:00.000Z", item: { src: "ffn", ctx: "story", u: STORY_URL, t: "A Chance Encounter" } },
        };
      },
    },
    storage: {
      async get(key) { return Object.hasOwn(calls.store, key) ? { [key]: calls.store[key] } : {}; },
      async set(patch) { Object.assign(calls.store, patch); },
      async remove(key) { delete calls.store[key]; },
    },
    session: {
      async accountForThisOpen() { return { state: "verified", binding: state.binding }; },
      pageBinding() { return state.binding; },
      async automaticSaving() { return "on"; },
      async saveStoryWithEvidence(command, observer) {
        await observer.beforeWrite();
        calls.saves.push(command);
        return {
          result: { kind: "confirmed", intent: "ensure_saved", confirmation: CONFIRMATION, source: "mutation", projection: "published", receipt: "published", handoff: "not_present" },
          dispatch: "confirmed",
        };
      },
      async storyPresence(workKey) { calls.presence.push(workKey); return { kind: "unknown" }; },
      attachStoryAdmission(hooks) { admission = hooks; },
    },
    now: () => 1_800_000_000_000,
  });
  const openPort = (sender = { id: "trace-test", url: "safari-web-extension://trace-test/popup.html" }, name = "trace-first-tap-popup-v1") => {
    const posted = [];
    let onMessage = null;
    let onDisconnect = null;
    connect({
      name, sender,
      postMessage(message) { posted.push(message.view); },
      onMessage: { addListener(fn) { onMessage = fn; } },
      onDisconnect: { addListener(fn) { onDisconnect = fn; } },
    });
    return {
      posted,
      send: (command, ...tab) => onMessage?.({ command, tabId: tab.length > 0 ? tab[0] : 7 }),
      close: () => onDisconnect?.(),
      attached: onMessage !== null,
    };
  };
  return { state, calls, openPort, admission: () => admission, afterScriptsRegistered };
}

test("the sheet's port saves the tapped story: manual-mode script first, one save, the mark after the sheet closes", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  await turns();

  assert.deepEqual(h.calls.injections, [{ target: { tabId: 7, frameIds: [0] }, files: [...FIRST_TAP_PAGE_FILES] }]);
  assert.equal(FIRST_TAP_PAGE_FILES[0], "page-manual-mode.js", "the mode is set before the page script runs");
  assert.deepEqual(FIRST_TAP_PAGE_FILES.slice(1), ["content-config.js", "trace-finish-qualify.js", "collector.js"]);
  assert.deepEqual(h.calls.tabMessages.map(({ message }) => message.type), ["TRACE_FIRST_TAP_COLLECT"]);
  assert.deepEqual(h.calls.tabMessages[0].options, { frameId: 0 });
  assert.equal(h.calls.saves.length, 1);
  assert.equal(h.calls.saves[0].mode, "bounded_manual");
  assert.deepEqual(port.posted.map(({ state }) => state), ["saving", "confirmed"]);
  assert.equal(port.posted.at(-1).provenance, "saved_now");

  port.close();
  await turns();
  assert.deepEqual(
    h.calls.tabMessages.at(-1),
    { tabId: 7, message: { type: "TRACE_FIRST_TAP_MARK", workKey: WORK_KEY }, options: { frameId: 0 } },
  );
});

test("only Trace's own sheet can open that port", async () => {
  const h = harness();
  for (const [sender, name] of [
    [{ id: "trace-test", tab: { id: 7, url: STORY_URL }, url: STORY_URL }, "trace-first-tap-popup-v1"],
    [{ id: "another-extension", url: "safari-web-extension://other/popup.html" }, "trace-first-tap-popup-v1"],
    [{ id: "trace-test", url: "safari-web-extension://trace-test/popup.html", frameId: 2 }, "trace-first-tap-popup-v1"],
    [{ id: "trace-test", url: "safari-web-extension://trace-test/popup.html" }, "trace-popup-page-v1"],
  ]) {
    const port = h.openPort(sender, name);
    assert.equal(port.attached, false);
    port.send("open");
  }
  await turns();
  assert.deepEqual(h.calls.injections, []);
  assert.deepEqual(h.calls.saves, []);
});

test("Check again over the port looks and cannot save; an unknown command does nothing", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  await turns();
  const saves = h.calls.saves.length;
  // The story is confirmed, so the look has nothing to add; it still only looks.
  port.send("check");
  port.send("mutate");
  port.send(undefined);
  await turns();
  assert.deepEqual(h.calls.presence, [WORK_KEY]);
  assert.equal(h.calls.saves.length, saves);
  assert.equal(h.calls.injections.length, 1);
});

test("the popup names its tab once; the background reads that tab by id and saves nothing on any other", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open", 7);
  await turns();
  assert.deepEqual(h.calls.gets, [7]);
  assert.equal(h.calls.saves.length, 1);

  // A later message naming another tab is still about the first.
  port.send("save", 9);
  await turns();
  assert.deepEqual([...new Set(h.calls.gets)], [7]);

  // A tab that is not the one on show in its window is not saved from.
  const elsewhere = harness();
  const other = elsewhere.openPort();
  other.send("open", 9);
  await turns();
  assert.deepEqual(other.posted, [{ state: "not_applicable" }]);
  assert.deepEqual(elsewhere.calls.injections, []);

  // No tab named: nothing happens at all.
  const unnamed = harness();
  const silent = unnamed.openPort();
  silent.send("open", undefined);
  silent.send("open", "7");
  await turns();
  assert.deepEqual(silent.posted, []);
  assert.deepEqual(unnamed.calls.gets, []);
});

test("what the background keeps is a salted digest, never the story", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  await turns();
  const kept = JSON.stringify(h.calls.store);
  assert.match(kept, /traceFirstTapSaveV2/);
  for (const readable of ["ffn", "7038840", "fanfiction", "A Chance Encounter", "someone"]) {
    assert.equal(kept.includes(readable), false, `${readable} is not kept`);
  }
});

test("once the sites are allowed and the scripts registered, injected pages are told to leave manual mode", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  await turns();
  port.close();
  await turns();
  const before = h.calls.tabMessages.length;

  await h.afterScriptsRegistered();
  assert.equal(h.calls.tabMessages.length, before, "not while the sites are not allowed");
  h.state.granted = true;
  await h.afterScriptsRegistered();
  assert.equal(h.calls.tabMessages.length, before, "not until the scripts are registered");

  h.state.registered = ["trace-archive-automation-v1", "trace-ao3-saved-filters-v1"];
  await h.afterScriptsRegistered();
  assert.deepEqual(
    h.calls.tabMessages.slice(before),
    [{ tabId: 7, message: { type: "TRACE_PAGE_MANUAL_MODE_END" }, options: { frameId: 0 } }],
  );
  // Whatever that page sends from now on is stamped by what holds now.
  assert.equal(await h.admission().modeFor(7, WORK_KEY), "normal_automatic");
});

test("a page's own save is stamped by what holds when it is admitted", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  await turns();
  const hooks = h.admission();

  assert.equal(await hooks.modeFor(7, WORK_KEY), "bounded_manual", "a page this background injected, sites not allowed");
  assert.equal(await hooks.modeFor(8, WORK_KEY), null, "a page it did not inject, sites not allowed: neither");

  h.state.granted = true;
  assert.equal(await hooks.modeFor(7, WORK_KEY), null, "allowed but scripts not registered: neither");
  h.state.registered = ["trace-archive-automation-v1", "trace-ao3-saved-filters-v1"];
  assert.equal(await hooks.modeFor(7, WORK_KEY), "normal_automatic", "a debt armed in manual mode and paid after the grant is automatic");
  assert.equal(await hooks.modeFor(8, WORK_KEY), "normal_automatic");
});

test("once the story sites are allowed the port saves nothing", async () => {
  const h = harness({ granted: true });
  const port = h.openPort();
  port.send("open");
  await turns();
  assert.deepEqual(port.posted, [{ state: "automatic" }]);
  assert.deepEqual(h.calls.gets, [7]);
  assert.deepEqual(h.calls.injections, []);
  assert.deepEqual(h.calls.saves, []);
});

test("a sheet closed the moment it opened still lets the page show its mark for the confirmed save", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  port.close();
  await turns();
  assert.equal(h.calls.saves.length, 1);
  assert.deepEqual(port.posted, [], "a closed sheet is told nothing");
  assert.deepEqual(
    h.calls.tabMessages.at(-1).message,
    { type: "TRACE_FIRST_TAP_MARK", workKey: WORK_KEY },
  );
});

