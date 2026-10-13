import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
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
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

// The same digest and random bytes the browser gives, answered at once so the
// tests do not depend on how long a real digest takes.
const steadyCrypto = {
  getRandomValues: (bytes) => nodeCrypto.randomFillSync(bytes),
  subtle: {
    async digest(_algorithm, bytes) {
      const digest = nodeCrypto.createHash("sha256").update(bytes).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    },
  },
};

const REGISTERED = ["trace-archive-automation-v1", "trace-ao3-saved-filters-v1"];

/**
 * One install: what Safari allows, the open tabs with the page script each
 * holds, storage and the account. `worker()` starts a background over it, as
 * Safari does each time it wakes the extension; what a background holds only
 * in memory starts empty.
 */
function install({ granted = false, registered = [], crypto = steadyCrypto } = {}) {
  const state = {
    granted, registered, binding: "1.aaa", accountId: "account-a",
    /** What `permissions.getAll` lists; null to list exactly what `granted` says. */
    listed: null,
    account: { state: "verified" },
    automaticSaving: "on",
    /** How a save ends: confirmed, or handed over and never answered. */
    saveEnds: "confirmed",
    /** Trace's answer to the exact-story read: a status and a body. */
    membership: { status: 200, body: { success: true, data: { work_key: WORK_KEY, membership: "absent" } } },
    // `page` is the page script in the tab: none, one in manual mode, or one
    // running as on any story page.
    tabs: {
      7: { id: 7, url: STORY_URL, page: null },
      9: { id: 9, url: "https://www.fanfiction.net/s/999/1/Other", page: "normal" },
      11: { id: 11, url: "https://example.com/", page: null },
    },
  };
  const calls = { injections: [], tabMessages: [], saves: [], presence: [], requests: [], store: {}, queries: [], reloads: [] };
  const worker = () => {
    let connect = null;
    let admission = null;
    let pageMessage = null;
    const runtime = {
      id: "trace-test",
      onConnect: { addListener(fn) { connect = fn; } },
      onMessage: { addListener(fn) { pageMessage = fn; } },
    };
    const afterScriptsRegistered = installFirstTapSave({
      runtime,
      mode: "promise",
      origins: FIVE,
      registrationIds: REGISTERED,
      permissions: {
        async contains({ origins }) {
          assert.deepEqual(origins, FIVE);
          if (state.granted instanceof Error) throw state.granted;
          return state.granted;
        },
        async getAll() {
          if (state.listed instanceof Error) throw state.listed;
          return { origins: state.listed ?? (state.granted === true ? [...FIVE] : []) };
        },
        request() { assert.fail("the background never asks for website access"); },
      },
      scripting: {
        async executeScript(injection) {
          calls.injections.push(injection);
          const tab = state.tabs[injection.target.tabId];
          if (tab.page === null) tab.page = "manual";
        },
        async getRegisteredContentScripts() {
          if (state.registered instanceof Error) throw state.registered;
          return state.registered.map((id) => ({ id }));
        },
        async registerContentScripts() { assert.fail("a first tap registers nothing"); },
        async unregisterContentScripts() { assert.fail("a first tap unregisters nothing"); },
      },
      tabs: {
        async query(filter) {
          calls.queries.push(filter);
          assert.deepEqual(filter, { url: FIVE }, "only story-site tabs are ever asked for");
          assert.equal(state.granted, true, "and only once the reader has allowed those sites");
          return Object.values(state.tabs)
            .filter(({ url }) => /fanfiction\.net|archiveofourown/.test(url))
            .map(({ id, url }) => ({ id, url }));
        },
        async get() { assert.fail("no tab is looked up: the popup says which tab it was opened on"); },
        async create() { assert.fail("no tab is opened"); },
        async reload(tabId) { calls.reloads.push(tabId); },
        async sendMessage(tabId, message, options) {
          calls.tabMessages.push({ tabId, message, options });
          const tab = state.tabs[tabId];
          if (!tab || tab.page === null) throw new Error("no page script in that tab");
          if (message.type === "TRACE_PAGE_MANUAL_MODE_END") {
            if (tab.page !== "manual") return { ok: false, error: "refused" };
            tab.page = "normal";
            return { ok: true };
          }
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
        async accountForThisOpen() {
          return state.account.state === "verified" ? { state: "verified", binding: state.binding } : state.account;
        },
        pageBinding() { return state.binding; },
        snapshot() { return { accountId: state.accountId }; },
        async automaticSaving() { return state.automaticSaving; },
        publicationScope() { return { accountId: state.accountId, epoch: 1 }; },
        async executeAuthenticated(effect) {
          const result = await effect("device-credential");
          if (result.kind === "success") return { kind: "published", value: result.value };
          return result.kind === "auth_rejected" ? { kind: "auth_rejected", recovery: "reconnect_required" } : { kind: "unavailable" };
        },
        async saveStoryWithEvidence(command, observer) {
          await observer.beforeWrite();
          calls.saves.push(command);
          if (state.saveEnds !== "confirmed") {
            return { result: { kind: "failed", reason: "confirmation_missing" }, dispatch: "sent_unconfirmed" };
          }
          return {
            result: { kind: "confirmed", intent: "ensure_saved", confirmation: CONFIRMATION, source: "mutation", projection: "published", receipt: "published", handoff: "not_present" },
            dispatch: "confirmed",
          };
        },
        async storyPresence(workKey) { calls.presence.push(workKey); return { kind: "unknown" }; },
        attachStoryAdmission(hooks) { admission = hooks; },
      },
      // Trace's service, stood in for: no request leaves these tests.
      async fetch(url, init) {
        calls.requests.push({ url: String(url), method: init.method, authorization: init.headers.Authorization });
        if (state.membership instanceof Error) throw state.membership;
        return new Response(JSON.stringify(state.membership.body), { status: state.membership.status });
      },
      apiBase: "https://api.trace.test",
      now: () => 1_800_000_000_000,
      ...(crypto === null ? {} : { crypto }),
    });
    const openPort = (sender = { id: "trace-test", url: "safari-web-extension://trace-test/popup.html" }, name = "trace-first-tap-popup-v1") => {
      const messages = [];
      let onMessage = null;
      let onDisconnect = null;
      connect({
        name, sender,
        postMessage(message) { messages.push(message); },
        onMessage: { addListener(fn) { onMessage = fn; } },
        onDisconnect: { addListener(fn) { onDisconnect = fn; } },
      });
      return {
        messages,
        /** The save states sent, and the states of the ask. */
        get posted() { return messages.filter(({ view }) => view).map(({ view }) => view); },
        get access() { return messages.filter(({ access }) => access).map(({ access }) => access); },
        send: (command, tab = {}) => onMessage?.({ command, tabId: 7, url: state.tabs[7].url, private: false, ...tab }),
        close: () => onDisconnect?.(),
        attached: onMessage !== null,
      };
    };
    /** A page script's own message to the background, and its answer. */
    const fromPage = (message, sender) => new Promise((resolve) => {
      if (pageMessage(message, sender, resolve) !== true) resolve(undefined);
    });
    return { openPort, fromPage, admission: () => admission, afterScriptsRegistered };
  };
  return { state, calls, worker };
}

function harness(options) {
  const world = install(options);
  return { state: world.state, calls: world.calls, world, ...world.worker() };
}

/** Tab messages of one kind, as `tab:type`. */
const told = (calls, type) => calls.tabMessages.filter(({ message }) => message.type === type).map(({ tabId }) => tabId);

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
  // Saving, saving again with the story's title once the page has named it, then the result.
  assert.deepEqual(port.posted.map(({ state }) => state), ["saving", "saving", "confirmed"]);
  assert.deepEqual(port.posted.map(({ story }) => story?.title ?? null), [null, "A Chance Encounter", "A Chance Encounter"]);
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
  // The story is confirmed, so there is nothing to ask Trace about.
  port.send("check");
  port.send("mutate");
  port.send(undefined);
  await turns();
  assert.deepEqual(h.calls.requests, []);
  assert.deepEqual(h.calls.presence, []);
  assert.equal(h.calls.saves.length, saves);
  assert.equal(h.calls.injections.length, 1);
});

test("Check again after an unanswered save asks Trace about that one story, once a tap, and says only what Trace said", async () => {
  const h = harness();
  h.state.saveEnds = "unanswered";
  const port = h.openPort();
  port.send("open");
  await turns();
  assert.equal(port.posted.at(-1).dispatch, "sent_unconfirmed");
  assert.deepEqual(h.calls.requests, [], "opening Trace and saving ask nothing of the exact-story read");

  // Not in the Library, on Trace's own word.
  port.send("check");
  await turns();
  assert.deepEqual(h.calls.requests, [{
    url: `https://api.trace.test/api/extension/library-membership?work_key=${WORK_KEY}`,
    method: "GET", authorization: "Bearer device-credential",
  }], "the key the save was made under, with the account's own sign-in");
  assert.deepEqual(port.posted.at(-1), {
    state: "failed", workKey: WORK_KEY, reason: "unavailable", dispatch: "not_in_library",
    story: { title: "A Chance Encounter", author: "someone", site: "FanFiction.net" },
  });

  // Turned away as too many, a server error, an unreadable answer, no network: not known.
  for (const membership of [
    { status: 429, body: { success: false } },
    { status: 503, body: { success: false } },
    { status: 200, body: { success: true, data: { work_key: "ffn:1", membership: "absent" } } },
    new TypeError("network unavailable"),
  ]) {
    h.state.membership = membership;
    port.send("check");
    await turns();
    assert.deepEqual(port.posted.at(-1), { state: "presence_unknown", workKey: WORK_KEY });
  }

  // The account's sign-in was turned down.
  h.state.membership = { status: 401, body: { success: false } };
  port.send("check");
  await turns();
  assert.deepEqual(port.posted.at(-1), { state: "account_reconnect_required", workKey: WORK_KEY });

  // In the Library after all.
  h.state.membership = {
    status: 200,
    body: { success: true, data: { work_key: WORK_KEY, membership: "present", entry_id: ENTRY_ID, entry: CONFIRMATION.entry } },
  };
  port.send("check");
  await turns();
  assert.deepEqual(port.posted.at(-1), {
    state: "confirmed", workKey: WORK_KEY, provenance: "found", mode: null,
    story: { title: "A Chance Encounter", author: "someone", site: "FanFiction.net" },
    entry: { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", chapters: null },
  });
  assert.equal(h.calls.requests.length, 7, "one request for each tap, and none besides");
  assert.equal(h.calls.saves.length, 1, "no look sent a save");
  assert.deepEqual(h.calls.presence, [], "and none read the whole Library");
});

test("the popup names the tab it was opened on, once; the background looks no tab up, and reaches no other", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  await turns();
  assert.equal(h.calls.saves.length, 1);
  assert.deepEqual(h.calls.queries, [], "no tab is searched for");

  // A later message naming another tab is still about the first.
  port.send("save", { tabId: 9, url: "https://www.fanfiction.net/s/999/1/Other" });
  await turns();
  assert.deepEqual([...new Set(h.calls.injections.map(({ target }) => target.tabId))], [7]);

  // An address that is not a story saves nothing and reaches no page.
  const elsewhere = harness();
  const other = elsewhere.openPort();
  other.send("open", { tabId: 11, url: "https://example.com/" });
  await turns();
  assert.deepEqual(other.posted, [{ state: "not_applicable" }]);
  assert.deepEqual(elsewhere.calls.injections, []);

  // No tab named, or no address for it: nothing happens at all.
  const unnamed = harness();
  const silent = unnamed.openPort();
  silent.send("open", { tabId: undefined });
  silent.send("open", { tabId: "7" });
  silent.send("open", { url: undefined });
  await turns();
  assert.deepEqual(silent.messages, []);
  assert.deepEqual(unnamed.calls.injections, []);
});

test("a private tab, or one the popup could not call ordinary, leaves no record behind", async () => {
  for (const tab of [{ private: true }, { private: undefined }, { private: "no" }]) {
    const h = harness();
    const port = h.openPort();
    port.send("open", tab);
    await turns();
    assert.equal(port.posted.at(-1).state, "confirmed");
    assert.deepEqual(h.calls.store.traceFirstTapSaveV2?.records ?? [], []);
  }
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

// --- From the first manual save to automatic saving -----------------------------

test("once the sites are allowed and the scripts registered, the page saved on a first tap is told to carry on, with no reload", async () => {
  const h = harness();
  const port = h.openPort();
  port.send("open");
  await turns();
  port.close();
  await turns();
  assert.equal(h.state.tabs[7].page, "manual");

  await h.afterScriptsRegistered();
  assert.deepEqual(told(h.calls, "TRACE_PAGE_MANUAL_MODE_END"), [], "not while the sites are not allowed");
  h.state.granted = true;
  await h.afterScriptsRegistered();
  assert.deepEqual(told(h.calls, "TRACE_PAGE_MANUAL_MODE_END"), [], "not until the scripts are registered");
  assert.deepEqual(h.calls.queries, [], "and no tab is asked for until then");

  h.state.registered = REGISTERED;
  await h.afterScriptsRegistered();
  assert.equal(h.state.tabs[7].page, "normal", "the same page script carries on");
  assert.deepEqual(
    h.calls.tabMessages.find(({ message }) => message.type === "TRACE_PAGE_MANUAL_MODE_END"),
    { tabId: 7, message: { type: "TRACE_PAGE_MANUAL_MODE_END", reload: false }, options: { frameId: 0 } },
  );
  assert.deepEqual(h.calls.reloads, [], "nothing is reloaded");
  assert.equal(h.calls.injections.length, 1, "and no second page script is put in");
  assert.equal(h.calls.saves.length, 1, "nor the story saved again");
  // Whatever that page sends from now on is stamped by what holds now.
  assert.equal(await h.admission().modeFor(7, WORK_KEY), "normal_automatic");

  // Told again, it has nothing to do: the page is no longer in manual mode.
  await h.afterScriptsRegistered();
  assert.equal(h.state.tabs[7].page, "normal");
});

test("a background that slept since the first tap still hands the page over: allowed from the sheet, or in Safari's settings", async () => {
  for (const [how, wake] of [
    // The reader allowed the sites and the registration told the new background.
    ["told the scripts were registered", (worker) => worker.afterScriptsRegistered()],
    // Nothing tells it: the sites were allowed in Safari's settings and the
    // scripts registered by a background that then went away.
    ["started with the sites already allowed", () => turns()],
  ]) {
    const world = install();
    const first = world.worker();
    const port = first.openPort();
    port.send("open");
    await turns();
    port.close();
    await turns();
    assert.equal(world.state.tabs[7].page, "manual", how);

    // Safari puts the background to sleep; the reader allows the story sites.
    world.state.granted = true;
    world.state.registered = REGISTERED;
    const second = world.worker();
    await wake(second);
    await turns();
    assert.equal(world.state.tabs[7].page, "normal", `${how}: the page was told with nothing remembered`);
    assert.deepEqual(world.calls.queries.at(-1), { url: FIVE });
    assert.equal(world.calls.injections.length, 1, "no second page script");
    assert.equal(world.calls.saves.length, 1, "no second save");
    assert.equal(await second.admission().modeFor(7, WORK_KEY), "normal_automatic");
  }
});

test("a page in manual mode that asks is told when the story sites are allowed, and only its own extension's page is answered", async () => {
  const h = harness();
  const page = { id: "trace-test", tab: { id: 7 }, frameId: 0 };
  const ask = { type: "TRACE_PAGE_MANUAL_MODE_QUERY" };
  assert.deepEqual(await h.fromPage(ask, page), { ok: true, manual: true, reload: false });
  h.state.granted = true;
  assert.deepEqual(await h.fromPage(ask, page), { ok: true, manual: true, reload: false }, "allowed, scripts not registered");
  h.state.registered = REGISTERED;
  assert.deepEqual(await h.fromPage(ask, page), { ok: true, manual: false, reload: false });
  // A background started by the page's own question answers the same.
  assert.deepEqual(await h.world.worker().fromPage(ask, page), { ok: true, manual: false, reload: false });

  h.state.registered = new Error("unavailable");
  assert.deepEqual(await h.fromPage(ask, page), { ok: true, manual: true, reload: false }, "unreadable is not allowed");

  for (const sender of [
    { id: "another-extension", tab: { id: 7 }, frameId: 0 },
    { id: "trace-test", frameId: 0 },
    { id: "trace-test", tab: { id: 7 }, frameId: 3 },
  ]) {
    assert.deepEqual(await h.fromPage(ask, sender), { ok: false });
  }
  assert.equal(await h.fromPage({ type: "TRACE_SOMETHING_ELSE" }, page), undefined, "other messages are left to their owners");
});

// --- The ask for lasting access ---------------------------------------------------

/** A sheet with a confirmed first-tap save, about to ask. */
async function savedSheet(options) {
  const h = harness(options);
  const port = h.openPort();
  port.send("open");
  await turns();
  assert.equal(port.posted.at(-1).state, "confirmed");
  return { h, port };
}
const ALLOWED = { state: "allowed", account: "connected", automaticSaving: "on", handOver: "in_place" };

test("the ask: waiting while Safari's question is up, then allowed only from a fresh read of all the story sites with the scripts registered", async () => {
  const { h, port } = await savedSheet();
  port.send("access_asking");
  await turns();
  assert.deepEqual(port.access, [{ state: "waiting" }]);
  assert.equal(h.state.tabs[7].page, "manual", "nothing changes on the page while Safari asks");

  // The reader allows the sites; the registration puts the scripts in.
  h.state.granted = true;
  h.state.registered = REGISTERED;
  port.send("access_answered", { returned: true });
  await turns();
  assert.deepEqual(port.access.at(-1), ALLOWED);
  assert.equal(h.state.tabs[7].page, "normal", "and the page it saved from carries on by itself");
  assert.deepEqual(h.calls.reloads, []);
  assert.equal(h.calls.injections.length, 1, "one page script throughout");
  assert.equal(h.calls.saves.length, 1, "one save throughout");
  assert.deepEqual(port.posted.map(({ state }) => state), ["saving", "saving", "confirmed"], "the save shown is not taken back");
});

test("the ask: what the request returned is never the outcome", async () => {
  // It returned false, and the sites read as allowed.
  const yes = await savedSheet();
  yes.h.state.granted = true;
  yes.h.state.registered = REGISTERED;
  yes.port.send("access_answered", { returned: false });
  await turns();
  assert.deepEqual(yes.port.access.at(-1), ALLOWED);

  // It returned true, and the sites do not read as allowed.
  const no = await savedSheet();
  no.port.send("access_answered", { returned: true });
  await turns();
  assert.deepEqual(no.port.access.at(-1), { state: "not_known" });
  assert.equal(no.h.state.tabs[7].page, "manual");

  // It threw, and the sites read as allowed (allowed in settings meanwhile).
  const threw = await savedSheet();
  threw.h.state.granted = true;
  threw.h.state.registered = REGISTERED;
  threw.port.send("access_answered", { threw: true });
  await turns();
  assert.deepEqual(threw.port.access.at(-1), ALLOWED);
});

test("the ask: a request that came back false is not allowed, however long it took; only one that threw could not ask", async () => {
  // Trace cannot tell a reader who said no from a browser that said no for
  // them without asking, so nothing is read into how long the answer took.
  for (const detail of [{}, { elapsedMs: 30 }, { elapsedMs: 350 }, { elapsedMs: 2_500 }, { elapsedMs: 900_000 }]) {
    const { h, port } = await savedSheet();
    port.send("access_asking");
    port.send("access_answered", { returned: false, ...detail });
    await turns();
    assert.deepEqual(port.access, [{ state: "waiting" }, { state: "not_allowed", automaticSaving: "on" }], JSON.stringify(detail));
    assert.equal(h.state.tabs[7].page, "manual", "nothing changes on the page");
    assert.deepEqual(h.calls.queries, [], "and no tab is asked for");
  }

  const threw = await savedSheet();
  threw.port.send("access_answered", { threw: true });
  await turns();
  assert.deepEqual(threw.port.access.at(-1), { state: "could_not_ask", automaticSaving: "on" });

  // With it, the preference as read just then: off means a later tap alone saves nothing.
  for (const [preference, answer, expected] of [
    ["off", { returned: false }, "not_allowed"],
    ["unknown", { returned: false }, "not_allowed"],
    ["off", { threw: true }, "could_not_ask"],
  ]) {
    const off = await savedSheet();
    off.h.state.automaticSaving = preference;
    off.port.send("access_answered", answer);
    await turns();
    assert.deepEqual(off.port.access.at(-1), { state: expected, automaticSaving: preference });
  }
});

test("the ask: a request that came back with no answer is not known, never not allowed", async () => {
  for (const returned of [undefined, null, "", 0, "false", {}]) {
    const { port } = await savedSheet();
    port.send("access_answered", { returned });
    await turns();
    assert.deepEqual(port.access.at(-1), { state: "not_known" }, JSON.stringify(returned));
  }
});

test("the ask: while the request is out, looking again ends the wait only when the story sites are allowed", async () => {
  const { h, port } = await savedSheet();
  port.send("access_asking");
  // Looked at again and again, with nothing allowed: still waiting, for as
  // long as the popup goes on asking. No number of looks becomes an answer.
  for (let look = 0; look < 40; look += 1) port.send("access_waiting");
  await turns();
  assert.deepEqual([...new Set(port.access.map(({ state }) => state))], ["waiting"]);
  assert.equal(h.state.tabs[7].page, "manual");

  // The request never comes back, and the sites are now allowed.
  h.state.granted = true;
  h.state.registered = REGISTERED;
  port.send("access_waiting");
  await turns();
  assert.deepEqual(port.access.at(-1), ALLOWED, "allowed, from the read alone");
  assert.equal(h.state.tabs[7].page, "normal");
  // The wait is over: the reader could ask again from this popup.
  h.state.granted = false;
  h.state.registered = [];
  port.send("access_asking");
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "waiting" });
});

test("the ask: a request the popup stopped waiting on is not known, never not allowed, and the reader can ask again", async () => {
  const { h, port } = await savedSheet();
  port.send("access_asking");
  port.send("access_unanswered");
  await turns();
  assert.deepEqual(port.access, [{ state: "waiting" }, { state: "not_known" }]);
  assert.equal(h.state.tabs[7].page, "manual");
  port.send("access_asking");
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "waiting" }, "a new ask is not blocked by the old one");

  // Given up on, with the sites allowed after all, or some of them.
  const allowed = await savedSheet();
  allowed.h.state.granted = true;
  allowed.h.state.registered = REGISTERED;
  allowed.port.send("access_unanswered");
  await turns();
  assert.deepEqual(allowed.port.access.at(-1), ALLOWED);
  const partly = await savedSheet();
  partly.h.state.listed = FIVE.slice(0, 2);
  partly.port.send("access_unanswered");
  await turns();
  assert.deepEqual(partly.port.access.at(-1), { state: "partial", granted: 2, total: 5 });
});

test("the ask: allowed does not outlive the access: looked at again after it is removed, it is no longer allowed", async () => {
  const { h, port } = await savedSheet();
  h.state.granted = true;
  h.state.registered = REGISTERED;
  port.send("access_answered", { returned: true });
  await turns();
  assert.deepEqual(port.access.at(-1), ALLOWED);

  // The reader removes the story sites in Safari's settings.
  h.state.granted = false;
  port.send("access_check");
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "not_asked" });

  // Some left, and the read failing, are each their own state too.
  h.state.listed = FIVE.slice(0, 4);
  port.send("access_check");
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "partial", granted: 4, total: 5 });
  h.state.granted = new Error("unavailable");
  h.state.listed = new Error("unavailable");
  port.send("access_check");
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "not_known" });
});

test("the ask: fewer than all the story sites is partly allowed, never allowed", async () => {
  for (const returned of [true, false]) {
    const { h, port } = await savedSheet();
    h.state.listed = FIVE.slice(0, 3);
    h.state.registered = REGISTERED;
    port.send("access_answered", { returned });
    await turns();
    assert.deepEqual(port.access.at(-1), { state: "partial", granted: 3, total: 5 });
    assert.equal(h.state.tabs[7].page, "manual", "the page is not handed over on a partial grant");
    assert.deepEqual(h.calls.queries, []);
  }
});

test("the ask: sites allowed with the scripts not registered, or unreadable, is not allowed", async () => {
  for (const [registered, expected] of [
    [[], { state: "registration_failed" }],
    [["trace-archive-automation-v1"], { state: "registration_failed" }],
    [new Error("unavailable"), { state: "registration_unknown" }],
  ]) {
    const { h, port } = await savedSheet();
    h.state.granted = true;
    h.state.registered = registered;
    port.send("access_answered", { returned: true });
    await turns();
    assert.deepEqual(port.access.at(-1), expected);
    assert.equal(h.state.tabs[7].page, "manual");

    // Looking again, with no new request, finds it once the scripts are in.
    h.state.registered = REGISTERED;
    port.send("access_check");
    await turns();
    assert.deepEqual(port.access.at(-1), ALLOWED);
    assert.equal(h.state.tabs[7].page, "normal");
  }
});

test("the ask: access that cannot be read is not known, never not allowed", async () => {
  const { h, port } = await savedSheet();
  h.state.granted = new Error("unavailable");
  h.state.listed = new Error("unavailable");
  port.send("access_answered", { returned: false });
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "not_known" });
  port.send("access_check");
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "not_known" });

  // One of the two reads is enough to know.
  h.state.listed = null;
  h.state.granted = false;
  port.send("access_check");
  await turns();
  assert.deepEqual(port.access.at(-1), { state: "not_asked" });
});

test("the ask: allowed says what else was read, and claims nothing it did not read", async () => {
  for (const [arrange, expected] of [
    [(state) => { state.account = { state: "missing" }; }, { ...ALLOWED, account: "missing" }],
    [(state) => { state.account = { state: "unknown" }; }, { ...ALLOWED, account: "unknown" }],
    [(state) => { state.account = { state: "reconnect_required" }; }, { ...ALLOWED, account: "reconnect_required" }],
    [(state) => { state.automaticSaving = "off"; }, { ...ALLOWED, automaticSaving: "off" }],
    [(state) => { state.automaticSaving = "unknown"; }, { ...ALLOWED, automaticSaving: "unknown" }],
  ]) {
    const { h, port } = await savedSheet();
    h.state.granted = true;
    h.state.registered = REGISTERED;
    arrange(h.state);
    port.send("access_answered", { returned: true });
    await turns();
    assert.deepEqual(port.access.at(-1), expected);
    assert.deepEqual(Object.keys(port.access.at(-1)).sort(), ["account", "automaticSaving", "handOver", "state"],
      "nothing says how long the access lasts");
  }
});

test("the ask: a second tap while one is out does nothing", async () => {
  const { h, port } = await savedSheet();
  port.send("access_asking");
  port.send("access_asking");
  port.send("access_asking");
  await turns();
  assert.deepEqual(port.access, [{ state: "waiting" }]);
  assert.deepEqual(h.calls.queries, []);

  port.send("access_answered", { returned: false });
  await turns();
  // Once it has come back, the reader may ask again.
  port.send("access_asking");
  await turns();
  assert.deepEqual(port.access, [{ state: "waiting" }, { state: "not_allowed", automaticSaving: "on" }, { state: "waiting" }]);
});

test("the ask: a sheet closed while Safari's question is up loses nothing, and the next one looks afresh", async () => {
  // Allowed while the sheet was closed.
  const granted = await savedSheet();
  granted.port.send("access_asking");
  granted.port.close();
  await turns();
  granted.h.state.granted = true;
  granted.h.state.registered = REGISTERED;
  const reopened = granted.h.openPort();
  reopened.send("open");
  await turns();
  assert.deepEqual(reopened.messages, [{ view: { state: "automatic" }, access: ALLOWED }]);
  assert.equal(granted.h.state.tabs[7].page, "normal", "the page is handed over on that open");
  assert.equal(granted.h.calls.saves.length, 1, "and nothing is saved again");

  // Not allowed while it was closed: the save is still shown, the ask is
  // offered again, and it is not stuck waiting.
  const declined = await savedSheet();
  declined.port.send("access_asking");
  declined.port.close();
  await turns();
  const again = declined.h.openPort();
  again.send("open");
  await turns();
  assert.deepEqual(again.messages.map(({ view, access }) => [view?.state, access?.state]), [["confirmed", undefined]]);
  again.send("access_asking");
  await turns();
  assert.deepEqual(again.access, [{ state: "waiting" }], "a new sheet can ask");
  assert.equal(declined.h.calls.saves.length, 1);
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

test("with the browser's own digest, the same story is found again under the same key", async () => {
  const h = harness({ crypto: null });
  const port = h.openPort();
  port.send("open");
  // A real digest answers in its own time, so wait for the result itself.
  for (let waited = 0; waited < 400 && port.posted.at(-1)?.state !== "confirmed"; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(port.posted.at(-1)?.state, "confirmed");
  const kept = h.calls.store.traceFirstTapSaveV2;
  assert.match(kept.salt, /^[0-9a-f]{32}$/);
  assert.match(kept.records[0].k, /^[0-9a-f]{32}$/);
  assert.notEqual(kept.records[0].k, kept.records[0].s);

  // Reopened: the same record answers, and nothing is saved again.
  const again = h.openPort();
  again.send("open");
  for (let waited = 0; waited < 400 && again.posted.length === 0; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(again.posted[0].state, "confirmed");
  assert.equal(h.calls.saves.length, 1);
});

