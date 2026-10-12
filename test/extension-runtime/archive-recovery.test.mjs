import assert from "node:assert/strict";
import test from "node:test";
import { installArchiveRecovery } from "../../.trace-build/extension-runtime/archive-recovery.mjs";

for (const mode of ["promise", "callback"]) test(`recovery only injects granted manifest archive pages (${mode})`, async () => {
  let installed;
  const injected = [], checked = [], queries = [];
  const api = fn => (...args) => mode === "promise" ? Promise.resolve(fn(...args)) : args.pop()(fn(...args));
  const runtime = { onInstalled: { addListener(fn) { installed = fn; } }, getManifest: () => ({ content_scripts: [
    { matches: ["https://*.archiveofourown.org/*", "https://www.fanfiction.net/*"], js: ["popup-config.js", "collector.js"], exclude_matches: ["https://*.archiveofourown.org/private/*"] },
    { matches: ["https://www.tracefiction.com/*"], js: ["sync.js"] },
  ] }) };
  const urls = ["https://archiveofourown.org/works/123", "https://www.fanfiction.net/s/123/1", "https://archiveofourown.org/users/login", "https://archiveofourown.org/private/x", "https://www.tracefiction.com/", "https://ao3.org/works/1", "https://example.com/"];
  const recover = installArchiveRecovery({ runtime, mode,
    tabs: { query: api(filter => { queries.push(filter); return urls.map((url, id) => ({ url, id })); }) },
    permissions: { contains: api(({ origins }) => { checked.push(origins); return origins[0] === "https://archiveofourown.org/*"; }), request() { assert.fail("must never prompt"); } },
    scripting: { executeScript: api(value => { injected.push(value); }) },
  });
  await recover();
  assert.deepEqual(injected, [{ target: { tabId: 0, frameIds: [0] }, files: ["popup-config.js", "collector.js"] }]);
  assert.equal(checked.length, 2);
  // Story sites only, by address: never every open tab, never Trace's own site.
  assert.deepEqual(queries, [{ url: ["https://*.archiveofourown.org/*", "https://www.fanfiction.net/*"] }]);
  installed({ reason: "update" }); await recover(); assert.equal(injected.length, 2);
  installed({ reason: "install" }); await recover(); assert.equal(injected.length, 3);
});

test("injection rejection is contained and later starts can recover", async () => {
  let fail = true, calls = 0;
  const recover = installArchiveRecovery({ mode: "promise", runtime: { getManifest: () => ({ content_scripts: [{ matches: ["https://archiveofourown.org/*"], js: ["collector.js"] }] }) },
    tabs: { query: async () => [{ id: 1, url: "https://archiveofourown.org/works/1" }] },
    permissions: { contains: async () => true }, scripting: { executeScript: async () => { calls++; if (fail) throw Error("denied"); } } });
  await recover(); fail = false; await recover(); assert.equal(calls, 2);
});

// --- A build that registers its page scripts after the grant ----------------

const FIVE = ["https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*", "https://www.fanfiction.net/*", "https://m.fanfiction.net/*"];
const REGISTERED = { origins: FIVE, registrations: [
  { id: "automation", matches: FIVE, js: ["content-config.js", "collector.js"], excludeMatches: ["https://*.archiveofourown.org/users/login*"] },
  { id: "filters", matches: FIVE.slice(0, 3), js: ["ao3-saved-filters.js"] },
] };

function registeredRecovery({ complete, open = [] }) {
  const queries = [], injected = [], asked = [];
  const recover = installArchiveRecovery({ mode: "promise", registered: REGISTERED,
    // This build's manifest declares no page scripts and no website access.
    runtime: { getManifest: () => ({ host_permissions: [] }) },
    tabs: { query: async filter => { queries.push(filter); return open.map((url, id) => ({ url, id })); } },
    permissions: {
      contains: async ({ origins }) => { asked.push(origins); if (complete instanceof Error) throw complete; return complete; },
      request() { assert.fail("must never prompt"); },
    },
    scripting: { executeScript: async value => { injected.push(value); } },
  });
  return { recover, queries, injected, asked };
}

test("after an update, story tabs already open get the registered scripts back when the five sites are allowed", async () => {
  const h = registeredRecovery({ complete: true, open: [
    "https://archiveofourown.org/works/123", "https://m.fanfiction.net/s/9/1", "https://archiveofourown.org/users/login",
  ] });
  await h.recover();
  assert.deepEqual(h.asked[0], FIVE, "the complete grant is established before any tab is asked for");
  assert.deepEqual(h.queries, [{ url: FIVE }]);
  assert.deepEqual(h.injected, [
    { target: { tabId: 0, frameIds: [0] }, files: ["content-config.js", "collector.js", "ao3-saved-filters.js"] },
    { target: { tabId: 1, frameIds: [0] }, files: ["content-config.js", "collector.js"] },
  ]);
});

for (const [name, complete] of [["incomplete", false], ["unreadable", new Error("unavailable")], ["unanswered", undefined]]) {
  test(`with the five-site grant ${name}, no tab is asked for and nothing is injected`, async () => {
    const h = registeredRecovery({ complete, open: ["https://archiveofourown.org/works/123"] });
    await h.recover();
    assert.deepEqual(h.queries, []);
    assert.deepEqual(h.injected, []);
  });
}

// --- The rule every background tab query follows ----------------------------

test("no background code asks the browser for tabs without an address or the tab the reader just used", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(process.cwd(), "src", "extension-runtime");
  const found = [];
  for (const file of fs.readdirSync(root).filter(name => name.endsWith(".mts"))) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    // Every spelling of a tabs query in this runtime: a helper handed "query"
    // with its argument list, or the controller's own wrapper.
    const calls = [
      ...source.matchAll(/"query",\s*\[\s*(\{[\s\S]*?\})\s*\]/g),
      ...source.matchAll(/#callTabsQuery\((\{[^)]*\})\)/g),
    ];
    for (const call of calls) found.push({ file, argument: call[1].replace(/\s+/g, " ").trim() });
  }
  assert.ok(found.length >= 8, `expected to find the runtime's tab queries, found ${found.length}`);
  for (const { file, argument } of found) {
    const byAddress = /^\{ url: \S/.test(argument);
    const tabJustUsed = /^\{ active: true, currentWindow: true,? \}$/.test(argument);
    assert.ok(byAddress || tabJustUsed, `${file} asks for tabs with ${argument}`);
  }
});

