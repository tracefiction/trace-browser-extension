import assert from "node:assert/strict";
import test from "node:test";
import { declaredArchiveAccess, installArchiveHostAccess } from "../../.trace-build/extension-runtime/archive-host-access.mjs";

const AO3 = ["https://archiveofourown.org/*", "https://*.archiveofourown.org/*", "https://archiveofourown.gay/*", "https://archive.transformativeworks.org/*"];
const FFN = ["https://www.fanfiction.net/*", "https://m.fanfiction.net/*"];
const hosts = [...AO3, ...FFN, "https://www.tracefiction.com/*", "https://api.tracefiction.com/*"];
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(mode, scheme = "moz-extension", contains = () => false) {
  const events = {}, listeners = [], checked = [], pushed = [];
  let recovered = 0;
  const api = fn => (...args) => {
    const callback = mode === "callback" ? args.pop() : null;
    try {
      const value = fn(...args);
      if (callback) { callback(value); return; }
      return Promise.resolve(value);
    } catch (error) {
      if (!callback) return Promise.reject(error);
      runtime.lastError = { message: error.message }; callback(); delete runtime.lastError;
    }
  };
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const runtime = {
    id: "trace-test", getURL: path => `${scheme}://trace-test/${path}`,
    getManifest: () => ({ host_permissions: hosts }),
    onInstalled: event("installed"), onStartup: event("startup"),
    onMessage: { addListener(fn) { listeners.push(fn); } },
    sendMessage: api(message => pushed.push(message)),
  };
  const refresh = installArchiveHostAccess({ runtime, mode,
    permissions: { contains: api(request => { checked.push(request); return contains(request); }), onAdded: event("added"), onRemoved: event("removed"), request() { assert.fail("lifecycle must not request access"); } },
    tabs: { query: api(() => [
      { id: 1, url: "https://archiveofourown.org/works/123" },
      { id: 2, url: "https://www.fanfiction.net/s/123/1" },
      { id: 3, url: "https://archiveofourown.org/users/login" },
      { id: 4, url: "https://www.tracefiction.com/" },
      { id: 5, url: "https://ao3.org/works/123" },
    ]), sendMessage: api((id, message, options) => pushed.push({ id, message, options })) },
    recover: async () => { recovered++; },
  });
  const popup = { id: runtime.id, url: runtime.getURL("popup.html") };
  const send = (type, sender = popup) => new Promise(resolve => {
    const result = listeners[0]({ type, origins: ["https://evil.test/*"] }, sender, resolve);
    if (result !== true) resolve(undefined);
  });
  return { runtime, events, checked, pushed, refresh, send, popup, get recovered() { return recovered; } };
}

test("permission groups contain only the archive hosts declared by this package", () => {
  assert.deepEqual(declaredArchiveAccess({ getManifest: () => ({ host_permissions: hosts }) }), [
    { site: "ao3", label: "AO3", origins: AO3 }, { site: "ffn", label: "FanFiction.net", origins: FFN },
  ]);
});

for (const mode of ["promise", "callback"]) {
  test(`startup/install/update and revocation recheck without prompting (${mode})`, async () => {
    let granted = false;
    const h = harness(mode, "moz-extension", () => granted);
    await h.refresh();
    assert.ok(h.checked.length >= 2);
    for (const origin of h.checked.flatMap(item => item.origins)) assert.ok([...AO3, ...FFN].includes(origin));
    for (const [name, details] of [["installed", { reason: "install" }], ["installed", { reason: "update" }], ["startup"], ["removed"]]) {
      const before = h.checked.length; h.events[name](details); await tick();
      assert.equal(h.checked.length, before + 2);
    }
    granted = true; h.events.added(); await tick();
    assert.equal(h.recovered, 1);
    const state = await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET");
    assert.equal(state.ok, true); assert.ok(state.access.every(item => item.granted));
    granted = false;
    assert.ok((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET")).access.every(item => item.granted === false));
    await h.send("TRACE_ARCHIVE_HOST_ACCESS_REFRESH"); assert.equal(h.recovered, 2);
    assert.deepEqual([...new Set(h.pushed.filter(item => item.id).map(item => item.id))], [1, 2]);
    assert.ok(h.pushed.filter(item => item.id).every(item => item.options.frameId === 0 && item.message.access.length === 1));
  });
  test(`status reads are sender-bound; only bundled UI can refresh recovery (${mode})`, async () => {
    const h = harness(mode); await h.refresh();
    const archive = { id: h.runtime.id, url: "https://archiveofourown.org/works/123", tab: { id: 1, url: "https://archiveofourown.org/works/123" }, frameId: 0 };
    assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET", archive)).access.length, 1);
    for (const sender of [
      { ...archive, id: "other" }, { ...archive, frameId: 1 }, { ...archive, documentLifecycle: "prerender" },
      { ...archive, tab: { id: 1, url: "https://archiveofourown.org/users/login" } },
      { ...archive, tab: { id: 1, url: "https://example.org/works/1" } },
      { ...h.popup, url: h.runtime.getURL("options.html") },
    ]) assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET", sender)).ok, false);
    assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_REFRESH", archive)).ok, false);
    const frame = { ...h.popup, url: h.runtime.getURL("archive-access.html") + "?site=ao3", tab: archive.tab, frameId: 2 };
    assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET", frame)).ok, true);
    assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_REFRESH", frame)).ok, true);
  });
  test(`permission read errors remain unknown, never a false grant or denial (${mode})`, async () => {
    const h = harness(mode, "moz-extension", () => { throw Error("unavailable"); });
    const result = await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET");
    assert.ok(result.access.every(item => item.granted === null));
  });
}

test("Safari does not install the desktop host recovery flow", () => {
  const h = harness("promise", "safari-web-extension");
  assert.equal(h.refresh, null); assert.equal(h.checked.length, 0);
});
test("Chrome exposes a recovery only when a host check finds the same gap", async () => {
  for (const granted of [true, false]) {
    const h = harness("callback", "chrome-extension", () => granted);
    assert.ok((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET")).access.every(item => item.granted === granted));
  }
});
