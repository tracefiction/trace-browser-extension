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

test("every tab lookup in the background is for the tab just used, for sites it established, or by an id it was handed", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(process.cwd(), "src", "extension-runtime");
  const found = [];
  for (const file of fs.readdirSync(root).filter(name => name.endsWith(".mts"))) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    // Every spelling of a tab lookup in this runtime: a helper handed "query"
    // or "get" with its argument list, or the controller's own wrapper.
    for (const call of [
      ...source.matchAll(/"query",\s*\[\s*(\{[\s\S]*?\})\s*\]/g),
      ...source.matchAll(/#callTabsQuery\((\{[^)]*\})\)/g),
    ]) found.push({ file, source, at: call.index, kind: "query", argument: call[1].replace(/\s+/g, " ").trim() });
    for (const call of source.matchAll(/\btabs, "get",\s*\[([^\]]*)\]/g)) {
      found.push({ file, source, at: call.index, kind: "get", argument: call[1].trim() });
    }
    // No other spelling slips past the two above: nothing calls the browser's
    // tab lookups directly, or names one that returns tabs wholesale.
    assert.equal(/(?<!#)\btabs\??\.(?:get|query|getCurrent|getAllInWindow)\s*\(/.test(source), false, `${file} looks tabs up directly`);
    assert.equal(/"(?:getCurrent|getAllInWindow|getSelected)"/.test(source), false, `${file} looks tabs up wholesale`);
    // The controller's wrapper is the one place that calls through, with the
    // filter each caller above handed it.
    for (const direct of source.matchAll(/#tabs\.(?:get|query)\(([^,)]*)/g)) {
      assert.equal(direct[1], "query", `${file} looks tabs up directly`);
    }
  }
  assert.ok(found.filter(({ kind }) => kind === "query").length >= 9, "the runtime's tab queries were found");
  assert.ok(found.some(({ file, kind }) => file === "first-tap-runtime.mts" && kind === "query"), "the hand-over's query was found");
  assert.ok(found.some(({ kind }) => kind === "get"), "the runtime's lookups by tab id were found");
  for (const { file, source, at, kind, argument } of found) {
    const where = `${file} looks up tabs with ${argument}`;
    if (kind === "get") {
      // One tab, by an id a message or the browser handed over; never a search.
      // The save made when the reader opens Trace is not among them: it is
      // told which tab by the popup, and looks none up. `createdTabId` is a
      // tab the browser reported creating for the sheet's app link.
      assert.match(argument, /^(?:source|connect|created)TabId$/, where);
      if (argument === "createdTabId") assert.equal(file, "app-link-tabs.mts", where);
      assert.doesNotMatch(file, /^(?:first-tap|story-site)/, where);
      continue;
    }
    if (/^\{ active: true, currentWindow: true,? \}$/.test(argument)) continue;
    const filter = /^\{ url: (.+) \}$/.exec(argument)?.[1];
    assert.ok(filter, where);
    if (filter === "storySites") {
      // Story sites only, and the list is built from nothing else.
      assert.match(source.slice(0, at), /const storySites = [^;]*\.filter\(isStorySitePattern\)/, where);
      if (file === "first-tap-runtime.mts") {
        // This one runs with no tap behind it (a background starting, a
        // registration finishing), in a build that declares no story site.
        // It is reached only once the reader has allowed them all.
        const guard = source.lastIndexOf("if (!(await savesByItself())) return;", at);
        assert.ok(guard !== -1 && at - guard < 900, `${where} without first establishing the complete grant`);
        assert.match(source, /const savesByItself = async \(\): Promise<boolean> => \{\s*const \[grant, scripts\] = await Promise\.all\(\[grantComplete\(\), registered\(\)\]\);\s*return grant === true && scripts === true;/);
      }
    } else {
      // Trace's own site, and only after the build is known to declare it.
      assert.match(filter, /^\[(?:this\.#queryPattern|this\.#webTabPattern|target\.queryPattern)\]$/, where);
      const guard = source.lastIndexOf("declaresHostPattern(", at);
      assert.ok(guard !== -1 && at - guard < 1_200, `${where} without first checking the build declares that site`);
    }
  }
});
