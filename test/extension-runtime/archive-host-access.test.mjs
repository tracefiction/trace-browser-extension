import assert from "node:assert/strict";
import test from "node:test";
import { declaredArchiveAccess, installArchiveHostAccess } from "../../.trace-build/extension-runtime/archive-host-access.mjs";

const AO3 = ["https://archiveofourown.org/*", "https://*.archiveofourown.org/*", "https://archiveofourown.gay/*", "https://archive.transformativeworks.org/*"];
const FFN = ["https://www.fanfiction.net/*", "https://m.fanfiction.net/*"];
const hosts = [...AO3, ...FFN, "https://www.tracefiction.com/*", "https://api.tracefiction.com/*"];
const warning = "Site access is off — click to allow";
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(mode, scheme = "moz-extension", contains = () => false, actionFailure = false) {
  const events = {}, listeners = [], checked = [], pushed = [], writes = [];
  const badge = { text: "", title: "Trace fixture" };
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
    getManifest: () => ({ host_permissions: hosts, action: { default_title: "Trace fixture" } }),
    onInstalled: event("installed"), onStartup: event("startup"),
    onMessage: { addListener(fn) { listeners.push(fn); } },
    sendMessage: api(message => pushed.push(message)),
  };
  const action = Object.fromEntries(["setBadgeText", "setTitle", "setBadgeBackgroundColor", "setBadgeTextColor"].map(method => [method, api(details => {
    writes.push({ method, ...details });
    if (actionFailure) throw Error("action unavailable");
    if (method === "setBadgeText") badge.text = details.text;
    if (method === "setTitle") badge.title = details.title;
    if (method === "setBadgeBackgroundColor") badge.background = details.color;
    if (method === "setBadgeTextColor") badge.color = details.color;
  })]));
  const refresh = installArchiveHostAccess({ runtime, action, mode,
    permissions: { contains: api(request => { checked.push(request); return contains(request); }), onAdded: event("added"), onRemoved: event("removed"), request() { assert.fail("lifecycle must not request access"); } },
    recover: async () => { recovered++; },
  });
  const popup = { id: runtime.id, url: runtime.getURL("popup.html") };
  const send = (type, sender = popup) => new Promise(resolve => {
    const result = listeners[0]({ type, origins: ["https://evil.test/*"] }, sender, resolve);
    if (result !== true) resolve(undefined);
  });
  return { runtime, action, events, checked, pushed, writes, badge, refresh, send, popup, get recovered() { return recovered; } };
}

function assertBadge(h, missing) {
  assert.equal(h.badge.text, missing ? "!" : "");
  assert.equal(h.badge.title, missing ? warning : "Trace fixture");
  assert.ok(h.writes.every(write => !Object.hasOwn(write, "tabId")), "badge is discoverable on any tab");
}

test("permission groups contain only the archive hosts declared by this package", () => {
  assert.deepEqual(declaredArchiveAccess({ getManifest: () => ({ host_permissions: hosts }) }), [
    { site: "ao3", label: "AO3", origins: AO3 }, { site: "ffn", label: "FanFiction.net", origins: FFN },
  ]);
});

for (const [mode, scheme] of [["promise", "moz-extension"], ["callback", "chrome-extension"]]) {
  test(`boot/install/update/startup/permission changes update the toolbar without prompting (${mode})`, async () => {
    let granted = false;
    const h = harness(mode, scheme, () => granted);
    await tick(); assertBadge(h, true);
    for (const origin of h.checked.flatMap(item => item.origins)) assert.ok([...AO3, ...FFN].includes(origin));
    for (const [name, details] of [["installed", { reason: "install" }], ["installed", { reason: "update" }], ["startup"]]) {
      granted = true;
      const before = h.checked.length; h.events[name](details); await tick();
      assert.equal(h.checked.length, before + 2); assertBadge(h, false);
      granted = false; h.events.removed(); await tick(); assertBadge(h, true);
    }
    granted = true; h.events.added(); await tick();
    assert.equal(h.recovered, 1); assertBadge(h, false);
    const state = await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET");
    assert.equal(state.ok, true); assert.ok(state.access.every(item => item.granted));
    granted = false;
    assert.ok((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET")).access.every(item => item.granted === false));
    assertBadge(h, true, "opening the popup also rechecks the badge");
    await h.send("TRACE_ARCHIVE_HOST_ACCESS_REFRESH"); assert.equal(h.recovered, 2);
    assert.ok(h.pushed.every(item => item.type === "TRACE_ARCHIVE_HOST_ACCESS_CHANGED"));
  });
  test(`either archive keeps the badge until all declared archive hosts are granted (${mode})`, async () => {
    const granted = new Set();
    const h = harness(mode, scheme, ({ origins }) => origins.every(origin => granted.has(origin)));
    await h.refresh(); assertBadge(h, true);
    for (const origin of AO3) granted.add(origin);
    await h.refresh(); assertBadge(h, true);
    for (const origin of FFN) granted.add(origin);
    await h.refresh(); assertBadge(h, false);
    granted.delete(AO3[1]); await h.refresh(); assertBadge(h, true);
    granted.add(AO3[1]); granted.delete(FFN[0]); await h.refresh(); assertBadge(h, true);
  });
  test(`status and recovery accept only the toolbar popup; obsolete page flows are removed (${mode})`, async () => {
    const h = harness(mode, scheme); await h.refresh();
    const archive = { id: h.runtime.id, url: "https://archiveofourown.org/works/123", tab: { id: 1, url: "https://archiveofourown.org/works/123" }, frameId: 0 };
    for (const sender of [
      archive, { ...archive, frameId: 1 }, { ...h.popup, id: "other" },
      { ...h.popup, url: h.runtime.getURL("options.html") },
      { ...h.popup, url: h.runtime.getURL("archive-access.html"), tab: { id: 2, url: h.runtime.getURL("archive-access.html") }, frameId: 0 },
    ]) {
      assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET", sender)).ok, false);
      assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_REFRESH", sender)).ok, false);
    }
    assert.equal(await h.send("TRACE_ARCHIVE_HOST_ACCESS_OPEN", archive), undefined);
    assert.equal(await h.send("TRACE_ARCHIVE_HOST_ACCESS_FINISH"), undefined);
    assert.equal(h.recovered, 0);
    assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET")).ok, true);
  });
  test(`unknown evidence cannot claim a denial or clear an existing warning (${mode})`, async () => {
    let unavailable = false;
    const h = harness(mode, scheme, () => { if (unavailable) throw Error("unavailable"); return false; });
    await h.refresh(); assertBadge(h, true);
    unavailable = true;
    const result = await h.send("TRACE_ARCHIVE_HOST_ACCESS_GET");
    assert.ok(result.access.every(item => item.granted === null)); assertBadge(h, true);
    const unknown = harness(mode, scheme, () => { throw Error("unavailable"); });
    await unknown.refresh(); assert.equal(unknown.writes.length, 0);
  });
  test(`action failures do not block the popup permission flow (${mode})`, async () => {
    const h = harness(mode, scheme, () => false, true);
    assert.equal((await h.send("TRACE_ARCHIVE_HOST_ACCESS_REFRESH")).ok, true);
    assert.equal(h.recovered, 1);
  });
}

test("stale permission reads cannot restore a badge after a newer grant", async () => {
  const pending = [];
  const h = harness("promise", "moz-extension", () => new Promise(resolve => pending.push(resolve)));
  const newest = h.refresh();
  pending.slice(2).forEach(resolve => resolve(true)); await newest; assertBadge(h, false);
  pending.slice(0, 2).forEach(resolve => resolve(false)); await tick(); assertBadge(h, false);
});

test("warning badge text has WCAG AA contrast against its background", async () => {
  const h = harness("promise"); await h.refresh();
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  assert.ok((luminance(h.badge.color) + 0.05) / (luminance(h.badge.background) + 0.05) >= 4.5);
});

test("Safari does not install or write the desktop toolbar recovery flow", () => {
  const h = harness("promise", "safari-web-extension");
  assert.equal(h.refresh, null); assert.equal(h.checked.length, 0); assert.equal(h.writes.length, 0);
});
