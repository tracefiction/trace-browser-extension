import assert from "node:assert/strict";
import test from "node:test";
import { installArchiveRecovery } from "../../.trace-build/extension-runtime/archive-recovery.mjs";

for (const mode of ["promise", "callback"]) test(`recovery only injects granted manifest archive pages (${mode})`, async () => {
  let installed;
  const injected = [], checked = [], asked = [];
  const api = fn => (...args) => mode === "promise" ? Promise.resolve(fn(...args)) : args.pop()(fn(...args));
  const runtime = { onInstalled: { addListener(fn) { installed = fn; } }, getManifest: () => ({ content_scripts: [
    { matches: ["https://*.archiveofourown.org/*", "https://www.fanfiction.net/*"], js: ["popup-config.js", "collector.js"], exclude_matches: ["https://*.archiveofourown.org/private/*"] },
    { matches: ["https://www.tracefiction.com/*"], js: ["sync.js"] },
  ] }) };
  const urls = ["https://archiveofourown.org/works/123", "https://www.fanfiction.net/s/123/1", "https://archiveofourown.org/users/login", "https://archiveofourown.org/private/x", "https://www.tracefiction.com/", "https://ao3.org/works/1", "https://example.com/"];
  const recover = installArchiveRecovery({ runtime, mode,
    tabs: { query: api((filter) => { asked.push(filter); return urls.map((url, id) => ({ url, id })); }) },
    permissions: { contains: api(({ origins }) => { checked.push(origins); return origins[0] === "https://archiveofourown.org/*"; }), request() { assert.fail("must never prompt"); } },
    scripting: { executeScript: api(value => { injected.push(value); }) },
  });
  await recover();
  assert.deepEqual(injected, [{ target: { tabId: 0, frameIds: [0] }, files: ["popup-config.js", "collector.js"] }]);
  assert.equal(checked.length, 2);
  installed({ reason: "update" }); await recover(); assert.equal(injected.length, 2);
  installed({ reason: "install" }); await recover(); assert.equal(injected.length, 3);
  // Every look at the open tabs is for story-site addresses only: never every
  // tab, and never Trace's own site, though the manifest names it too.
  assert.ok(asked.length >= 3);
  for (const filter of asked) {
    assert.deepEqual(filter, { url: ["https://*.archiveofourown.org/*", "https://www.fanfiction.net/*"] });
  }
});

test("at background start the open tabs are asked for by story-site address, never all of them", async () => {
  const asked = [];
  const manifest = { content_scripts: [
    { matches: ["https://archiveofourown.org/*", "https://*.archiveofourown.org/*", "https://m.fanfiction.net/*"], js: ["collector.js"] },
    { matches: ["https://www.tracefiction.com/*"], js: ["sync.js"] },
    { matches: ["https://*.archiveofourown.org/*", "https://archive.transformativeworks.org/*", "https://example.com/*", "*://*/*", "<all_urls>"], js: ["filters.js"] },
  ] };
  installArchiveRecovery({ mode: "promise", runtime: { getManifest: () => manifest },
    tabs: { query: async (filter) => { asked.push(filter); return []; } },
    permissions: { contains: async () => true }, scripting: { executeScript: async () => assert.fail("no tab was returned") } });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.deepEqual(asked, [{ url: [
    "https://archiveofourown.org/*", "https://*.archiveofourown.org/*", "https://m.fanfiction.net/*", "https://archive.transformativeworks.org/*",
  ] }], "one filtered look, in the first turns after start");

  // With no story-site script to restore there is nothing to look for, so no tab is asked about at all.
  const none = [];
  const recover = installArchiveRecovery({ mode: "promise", runtime: { getManifest: () => ({ content_scripts: [{ matches: ["https://www.tracefiction.com/*"], js: ["sync.js"] }] }) },
    tabs: { query: async (filter) => { none.push(filter); return []; } },
    permissions: { contains: async () => true }, scripting: { executeScript: async () => undefined } });
  await recover();
  assert.deepEqual(none, []);
});

test("injection rejection is contained and later starts can recover", async () => {
  let fail = true, calls = 0;
  const recover = installArchiveRecovery({ mode: "promise", runtime: { getManifest: () => ({ content_scripts: [{ matches: ["https://archiveofourown.org/*"], js: ["collector.js"] }] }) },
    tabs: { query: async () => [{ id: 1, url: "https://archiveofourown.org/works/1" }] },
    permissions: { contains: async () => true }, scripting: { executeScript: async () => { calls++; if (fail) throw Error("denied"); } } });
  await recover(); fail = false; await recover(); assert.equal(calls, 2);
});
