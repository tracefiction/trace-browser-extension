import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_LINK_FRONT_GRACE_MS,
  APP_LINK_PENDING_KEY,
  APP_LINK_SETTLE_MS,
  APP_LINK_TABS_KEY,
  installAppLinkTabCleanup,
} from "../../.trace-build/extension-runtime/app-link-tabs.mjs";

const settle = async () => {
  for (let index = 0; index < 30; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A browser with tabs whose addresses the extension cannot read, as on Safari without `tabs`. */
function browser({ store = {}, start = 1_000_000 } = {}) {
  let now = start;
  let nextId = 1;
  const open = new Map();
  const listeners = { created: [], activated: [], updated: [], removed: [] };
  const event = (name) => ({ addListener: (fn) => listeners[name].push(fn) });
  const tabs = {
    async get(id) {
      if (!open.has(id)) throw new Error("No tab with id");
      return { id, active: open.get(id).active };
    },
    async remove(id) {
      if (!open.has(id)) throw new Error("No tab with id");
      open.delete(id);
      listeners.removed.forEach((fn) => fn(id));
    },
    onCreated: event("created"),
    onActivated: event("activated"),
    onUpdated: event("updated"),
    onRemoved: event("removed"),
  };
  const storage = {
    async get(keys) { return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, structuredClone(store[key])])); },
    async set(items) { Object.assign(store, structuredClone(items)); },
    async remove(key) { delete store[key]; },
  };
  const activate = (id) => {
    for (const [tabId, tab] of open) tab.active = tabId === id;
    listeners.activated.forEach((fn) => fn({ tabId: id }));
  };
  return {
    store,
    open,
    tabs,
    storage,
    clock: { now: () => now, advance: (ms) => { now += ms; } },
    /** A tab the reader opens, or the sheet's app link (with the sheet's note first). */
    create({ appLink = false } = {}) {
      if (appLink) store[APP_LINK_PENDING_KEY] = now;
      const id = nextId++;
      open.set(id, { active: false });
      listeners.created.forEach((fn) => fn({ id }));
      activate(id);
      return id;
    },
    activate,
    load(id) { listeners.updated.forEach((fn) => fn(id, { status: "loading" })); },
  };
}

function install(b) {
  return installAppLinkTabCleanup({
    runtime: {}, tabs: b.tabs, storage: b.storage, mode: "promise", now: b.clock.now,
  });
}

const appLinkTabs = (b) => (b.store[APP_LINK_TABS_KEY] ?? []).map((item) => item.id);

test("the app-link tab is closed as soon as the reader is on another tab", async () => {
  const b = browser();
  install(b);
  const story = b.create();
  await settle();
  const appLink = b.create({ appLink: true });
  await settle();
  assert.deepEqual(appLinkTabs(b), [appLink]);
  assert.equal(b.open.has(appLink), true, "never closed while Safari may still be asking");

  b.activate(story);
  await settle();
  assert.equal(b.open.has(appLink), false);
  assert.equal(b.open.has(story), true);
  assert.deepEqual(appLinkTabs(b), []);
  assert.equal(APP_LINK_PENDING_KEY in b.store, false);
});

test("an app-link tab still in front is closed once Safari's question is long answered, by a later background", async () => {
  const b = browser();
  install(b);
  const appLink = b.create({ appLink: true });
  await settle();
  const early = install(b);
  await early.sweep();
  assert.equal(b.open.has(appLink), true);

  b.clock.advance(APP_LINK_FRONT_GRACE_MS + 1);
  install(b); // Safari reopened, or the background woke for anything else.
  await settle();
  assert.equal(b.open.has(appLink), false);
  assert.deepEqual(appLinkTabs(b), []);
});

test("tabs the reader opens are never closed, nor an app-link tab they go on to use", async () => {
  const b = browser();
  install(b);
  const own = b.create();
  await settle();
  const reused = b.create({ appLink: true });
  await settle();
  b.clock.advance(APP_LINK_SETTLE_MS + 1);
  b.load(reused); // The reader typed an address into it.
  await settle();
  b.activate(own);
  await settle();
  b.clock.advance(APP_LINK_FRONT_GRACE_MS + 1);
  install(b);
  await settle();
  assert.deepEqual([...b.open.keys()].sort(), [own, reused].sort());
  assert.deepEqual(appLinkTabs(b), []);
});

test("a stale note from the sheet marks no tab", async () => {
  const b = browser();
  install(b);
  b.store[APP_LINK_PENDING_KEY] = b.clock.now();
  b.clock.advance(60_000);
  const own = b.create();
  await settle();
  assert.deepEqual(appLinkTabs(b), []);
  b.create();
  await settle();
  assert.equal(b.open.has(own), true);
});
