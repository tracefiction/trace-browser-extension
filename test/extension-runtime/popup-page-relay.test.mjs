import assert from "node:assert/strict";
import test from "node:test";
import { PopupPageRelay, POPUP_PAGE_PORT, POPUP_PAGE_RELAY } from "../../.trace-build/extension-runtime/popup-page-relay.mjs";
const url = "https://archiveofourown.org/works/123";
const identity = { type: "TRACE_STORY_IDENTITY_GET" };
const tick = () => new Promise(setImmediate);
function harness(mode = "promise") {
  let onConnect, scope = { accountId: "account-a", epoch: 1 }, active = { id: 5, url };
  const executed = [];
  const runtime = { id: "trace", onConnect: { addListener(fn) { onConnect = fn; } } };
  const relay = new PopupPageRelay({ runtime, mode, timeoutMs: 100,
    tabs: { query(_query, callback) { if (mode === "callback") callback([active]); else return Promise.resolve([active]); },
      sendMessage() { throw new Error("Safari direct path broken"); }, connect() { throw new Error("Safari direct path broken"); } },
    scope: () => scope,
    execute: async (message, sender, captured) => { executed.push({ message, sender, captured }); return { ok: true, accountId: "private", url }; },
  });
  function connect(overrides = {}) {
    let receive, disconnect;
    const sent = [];
    const port = { name: POPUP_PAGE_PORT, sender: { id: "trace", frameId: 0, tab: { id: 5, url }, url, ...overrides },
      postMessage(message) { sent.push(message); },
      onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener(fn) { disconnect = fn; } },
    };
    onConnect(port);
    return { sent, receive: (m) => receive?.(m), disconnect: () => disconnect?.() };
  }
  return { relay, connect, executed, setScope(value) { scope = value; }, setActive(value) { active = value; } };
}
for (const mode of ["promise", "callback"]) test(`relay identity succeeds without either direct tab API (${mode})`, async () => {
  const h = harness(mode), page = h.connect();
  const result = h.relay.request(5, identity); await tick();
  const request = page.sent[0];
  page.receive({ kind: "response", id: request.id, response: { ok: true, title: "Story", author: "Writer", site: "AO3", url, accountId: "private" } });
  assert.deepEqual(await result, { ok: true, title: "Story", author: "Writer", site: "AO3" });
  assert.equal(JSON.stringify(page.sent).includes(url), false);
});
test("replacement content port wins after reload; stale disconnect and response cannot affect it", async () => {
  const h = harness(), old = h.connect();
  const pending = h.relay.request(5, identity); await tick();
  const next = h.connect();
  assert.equal((await pending).ok, false);
  old.disconnect();
  const recovered = h.relay.request(5, identity); await tick();
  old.receive({ kind: "response", id: next.sent[0].id, response: { ok: true, title: "Wrong", site: "AO3" } });
  next.receive({ kind: "response", id: next.sent[0].id, response: { ok: true, title: "Recovered", site: "AO3" } });
  assert.equal((await recovered).title, "Recovered");
  next.disconnect(); assert.equal((await h.relay.request(5, identity)).ok, false);
});
test("missing or silent port fails closed", async () => {
  const h = harness(); assert.equal((await h.relay.request(5, identity)).ok, false);
  h.connect(); assert.equal((await h.relay.request(5, identity)).ok, false);
});
test("other tabs, subframes, credentials pages and foreign extension senders cannot answer", async () => {
  for (const sender of [{ frameId: 1 }, { id: "other" }, { url: "https://archiveofourown.org/users/login" }, { documentLifecycle: "prerender" }, { tab: { id: 6, url } }]) {
    const h = harness(); h.connect(sender); assert.equal((await h.relay.request(5, identity)).ok, false);
  }
  const h = harness(); h.connect(); assert.equal((await h.relay.request(6, identity)).ok, false);
  const popup = { id: "trace", url: "safari-web-extension://trace/popup.html" };
  assert.equal(h.relay.accepts({ type: POPUP_PAGE_RELAY }, popup), true);
  assert.equal(h.relay.accepts({ type: POPUP_PAGE_RELAY }, { ...popup, tab: { id: 5, url } }), false);
  assert.equal(h.relay.accepts({ type: POPUP_PAGE_RELAY }, { ...popup, id: "other" }), false);
});
test("navigation and account transition discard in-flight replies", async () => {
  for (const transition of [h => h.setActive({ id: 5, url: `${url}/chapters/456` }), h => h.setActive({ id: 6, url }), h => h.setScope({ accountId: "account-b", epoch: 2 })]) {
    const h = harness(), page = h.connect(); const result = h.relay.request(5, identity); await tick(); transition(h);
    page.receive({ kind: "response", id: page.sent[0].id, response: { ok: true, title: "Stale", site: "AO3" } });
    assert.equal((await result).ok, false);
  }
});
test("status command is executed once with the port sender and captured account, with a bounded reply", async () => {
  const h = harness(), page = h.connect();
  const result = h.relay.request(5, { type: "TRACE_POPUP_SET_READER_STATUS", status: "PAUSED", entry: { entryId: "entry" } }); await tick();
  const id = page.sent[0].id;
  page.receive({ kind: "command", id, command: { type: "TRACE_SET_READER_STATUS", payload: { workKey: "ao3:123", entryId: "entry", status: "PAUSED" } } }); await tick();
  assert.equal(h.executed.length, 1); assert.equal(h.executed[0].sender.tab.id, 5); assert.equal(h.executed[0].captured.accountId, "account-a");
  assert.deepEqual(page.sent[1], { kind: "commandResult", id, response: { ok: true } });
  page.receive({ kind: "response", id, response: { ok: true, accountId: "private" } }); assert.deepEqual(await result, { ok: true });
});
test("queued mutations cannot cross account boundaries or invoke unrelated commands", async () => {
  for (const change of [true, false]) {
    const h = harness(), page = h.connect(); const result = h.relay.request(5, { type: "TRACE_POPUP_QUICK_ADD" }); await tick();
    if (change) h.setScope({ accountId: "account-b", epoch: 2 });
    page.receive({ kind: "command", id: page.sent[0].id, command: { type: change ? "TRACE_QUICK_ADD" : "TRACE_SESSION_ACTION" } });
    assert.equal((await result).ok, false); assert.equal(h.executed.length, 0);
  }
});

test("a command whose active-tab lookup outlives its request cannot execute", async () => {
  let connect, receive, releaseQuery, hold = false, executed = 0;
  const relay = new PopupPageRelay({
    runtime: { id: "trace", onConnect: { addListener(fn) { connect = fn; } } },
    mode: "promise", timeoutMs: 30, scope: () => ({ accountId: "a", epoch: 1 }),
    tabs: { query() { return hold ? new Promise(resolve => { releaseQuery = resolve; }) : [{ id: 5, url }]; } },
    execute: async () => { executed++; return { ok: true }; },
  });
  const sent = [];
  connect({ name: POPUP_PAGE_PORT, sender: { id: "trace", frameId: 0, tab: { id: 5, url }, url },
    postMessage(message) { sent.push(message); }, onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener() {} },
  });
  const pending = relay.request(5, { type: "TRACE_POPUP_QUICK_ADD" }); await tick();
  hold = true;
  receive({ kind: "command", id: sent[0].id, command: { type: "TRACE_QUICK_ADD" } });
  assert.equal((await pending).ok, false);
  releaseQuery([{ id: 5, url }]); await tick();
  assert.equal(executed, 0);
});

test("Import data is read over the page's channel by the background only, and never across accounts", async () => {
  const payload = { s: "ao3", at: "2026-10-09T12:00:00.000Z",
    items: [{ src: "ao3", ctx: "listing", u: "https://archiveofourown.org/works/5550001", t: "The Lanterns at Netherfield" }] };
  const h = harness(), page = h.connect();
  // A popup relay message cannot ask a page for Import data.
  assert.deepEqual(await h.relay.request(5, { type: "TRACE_COLLECT" }), { ok: false, error: "page_unavailable" });
  assert.deepEqual(page.sent, []);

  const collected = h.relay.collect(5); await tick();
  assert.deepEqual(page.sent[0].command, { type: "TRACE_COLLECT" });
  page.receive({ kind: "response", id: page.sent[0].id, response: { ok: true, payload } });
  assert.deepEqual(await collected, { ok: true, payload });

  const refused = h.relay.collect(5); await tick();
  page.receive({ kind: "response", id: page.sent[1].id, response: { ok: false, error: "page_contains_password_field" } });
  assert.deepEqual(await refused, { ok: false, error: "page_contains_password_field" });

  const stale = h.relay.collect(5); await tick();
  h.setScope({ accountId: "account-b", epoch: 2 });
  page.receive({ kind: "response", id: page.sent[2].id, response: { ok: true, payload } });
  assert.deepEqual(await stale, { ok: false, error: "page_unavailable" });

  assert.deepEqual(await h.relay.collect(6), { ok: false, error: "page_unavailable" });
  assert.deepEqual(await harness().relay.collect(5), { ok: false, error: "page_unavailable" });
});
