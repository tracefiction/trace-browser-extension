import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_RUN_THROTTLE_MS,
  ArchiveReadinessService,
} from "../../.trace-build/extension-core/index.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function createHarness() {
  let now = 1_000_000;
  const events = [];
  const permissionReads = [];
  const runResults = [];
  const receipts = {
    async publishRunReceipt(receipt) {
      events.push({ kind: "run", value: receipt });
      return runResults.length > 0 ? await runResults.shift() : true;
    },
    async publishPermissionSnapshot(snapshot) {
      events.push({ kind: "permissions", value: snapshot });
      return true;
    },
  };
  const permissions = {
    async readGrantedOrigins() {
      if (permissionReads.length === 0) return null;
      return await permissionReads.shift();
    },
  };
  const service = new ArchiveReadinessService({
    receipts,
    permissions,
    clock: { now: () => now },
  });
  return {
    service,
    events,
    permissionReads,
    runResults,
    setNow(value) {
      now = value;
    },
  };
}

test("publishes positive run evidence before optional permission diagnostics", async () => {
  const h = createHarness();
  h.permissionReads.push([
    "https://archiveofourown.org/*",
    "https://www.fanfiction.net/*",
  ]);

  assert.deepEqual(
    await h.service.recordRun({ hostKind: "ao3", handoffId: "handoff_123" }),
    { kind: "published" },
  );
  await waitUntil(() => h.events.length === 2, "permission snapshot was not published");

  assert.deepEqual(h.events, [
    {
      kind: "run",
      value: {
        hostKind: "ao3",
        at: 1_000_000,
        handoffId: "handoff_123",
      },
    },
    {
      kind: "permissions",
      value: {
        hostKind: "ao3",
        at: 1_000_000,
        grantedOrigins: [
          "https://archiveofourown.org/*",
          "https://www.fanfiction.net/*",
        ],
      },
    },
  ]);
});

test("a stalled permission query cannot delay the run receipt result", async () => {
  const h = createHarness();
  const stalled = deferred();
  h.permissionReads.push(stalled.promise);

  assert.deepEqual(await h.service.recordRun({ hostKind: "ffn" }), {
    kind: "published",
  });
  assert.deepEqual(h.events, [{
    kind: "run",
    value: { hostKind: "ffn", at: 1_000_000 },
  }]);

  stalled.resolve(null);
});

test("throttles ordinary host receipts while handoff receipts always pass", async () => {
  const h = createHarness();
  assert.deepEqual(await h.service.recordRun({ hostKind: "ao3" }), {
    kind: "published",
  });
  h.setNow(1_000_000 + 100);
  assert.deepEqual(await h.service.recordRun({ hostKind: "ao3" }), {
    kind: "throttled",
  });
  assert.deepEqual(
    await h.service.recordRun({ hostKind: "ao3", handoffId: "handoff_retry" }),
    { kind: "published" },
  );
  assert.equal(h.events.filter((event) => event.kind === "run").length, 2);

  h.setNow(1_000_000 + ARCHIVE_RUN_THROTTLE_MS + 101);
  assert.deepEqual(await h.service.recordRun({ hostKind: "ao3" }), {
    kind: "published",
  });
});

test("a failed native publication does not suppress the next real navigation", async () => {
  const h = createHarness();
  h.runResults.push(false, true);

  assert.deepEqual(await h.service.recordRun({ hostKind: "ffn" }), {
    kind: "unavailable",
  });
  h.setNow(1_000_001);
  assert.deepEqual(await h.service.recordRun({ hostKind: "ffn" }), {
    kind: "published",
  });
  assert.equal(h.events.filter((event) => event.kind === "run").length, 2);
});

const REQUIRED_ORIGINS = [
  "https://*.archiveofourown.org/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
];

function createAccessHarness(options = {}) {
  let now = 2_000_000;
  const published = [];
  const waits = [];
  const listed = [...(options.listed ?? [])];
  const contains = [...(options.contains ?? [])];
  const containsRequests = [];
  const service = new ArchiveReadinessService({
    receipts: {
      async publishRunReceipt() {
        return true;
      },
      async publishPermissionSnapshot(snapshot) {
        published.push(snapshot);
        if (options.publish) return options.publish(snapshot);
        return true;
      },
    },
    permissions: {
      async readGrantedOrigins() {
        const next = listed.length > 1 ? listed.shift() : listed[0];
        if (next instanceof Error) throw next;
        return next ?? null;
      },
      ...(options.withoutContains ? {} : {
        async containsOrigins(origins) {
          containsRequests.push([...origins]);
          const next = contains.length > 1 ? contains.shift() : contains[0];
          if (next instanceof Error) throw next;
          return next ?? null;
        },
      }),
    },
    clock: { now: () => now },
    ...(options.withoutRequired ? {} : { requiredOrigins: REQUIRED_ORIGINS }),
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
      await options.duringWait?.();
    },
  });
  return { service, published, waits, containsRequests };
}

test("an access reading names the required origins when the browser confirms them", async () => {
  // "Always Allow on Every Website" need not list the story sites one by one.
  const h = createAccessHarness({ listed: [["*://*/*"]], contains: [true] });

  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });
  assert.deepEqual(h.containsRequests, [REQUIRED_ORIGINS]);
  assert.deepEqual(h.waits, [], "a complete reading needs no second look");
  assert.deepEqual(h.published, [{
    at: 2_000_000,
    grantedOrigins: [...REQUIRED_ORIGINS, "*://*/*"],
  }]);
  assert.equal(Object.hasOwn(h.published[0], "hostKind"), false, "it follows no page run");
});

test("a confirmed grant is reported even when the browser lists nothing", async () => {
  const h = createAccessHarness({ listed: [null], contains: [true] });
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });
  assert.deepEqual(h.published[0].grantedOrigins, REQUIRED_ORIGINS);
});

test("ended access is reported only after the browser says so twice", async () => {
  // A one-day grant has run out: only Trace's own site is still granted.
  const h = createAccessHarness({
    listed: [["https://www.tracefiction.com/*"]],
    contains: [false],
  });

  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: false });
  assert.deepEqual(h.waits, [2_000]);
  assert.equal(h.containsRequests.length, 2);
  assert.deepEqual(h.published, [{
    at: 2_002_000,
    grantedOrigins: ["https://www.tracefiction.com/*"],
  }]);
});

test("a first reading of missing access that the second look contradicts is not reported as missing", async () => {
  const h = createAccessHarness({
    listed: [[], REQUIRED_ORIGINS],
    contains: [false, true],
  });
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });
  assert.deepEqual(h.published.map(({ grantedOrigins }) => grantedOrigins), [REQUIRED_ORIGINS]);
});

test("an access reading the browser cannot answer sends nothing", async () => {
  for (const options of [
    { listed: [REQUIRED_ORIGINS.slice(0, 2)], contains: [null] },
    { listed: [REQUIRED_ORIGINS.slice(0, 2)], contains: [new Error("no answer")] },
    // Missing access is never claimed without the list of what is granted.
    { listed: [null], contains: [false] },
    { listed: [new Error("no answer")], contains: [false] },
    { listed: [[]], contains: [false, null] },
    { listed: [[]], contains: [false], withoutRequired: true },
    { listed: [[]], withoutContains: true },
  ]) {
    const h = createAccessHarness(options);
    assert.deepEqual(await h.service.reportAccess(), { kind: "unknown" });
    assert.deepEqual(h.published, []);
  }
});

test("an access reading that cannot be delivered is reported as unavailable", async () => {
  for (const publish of [() => false, () => { throw new Error("native messaging failed"); }]) {
    const h = createAccessHarness({ listed: [REQUIRED_ORIGINS], contains: [true], publish });
    assert.deepEqual(await h.service.reportAccess(), { kind: "unavailable" });
  }
});

test("requests made while a reading is running share it and trigger one more look", async () => {
  let again;
  const h = createAccessHarness({
    listed: [[], [], REQUIRED_ORIGINS],
    contains: [false, false, true],
    // Access is granted just after the first reading takes its second look.
    duringWait: async () => {
      again = h.service.reportAccess();
    },
  });
  const first = h.service.reportAccess();
  const result = await first;
  assert.equal(await again, result);
  assert.deepEqual(result, { kind: "published", complete: true });
  assert.deepEqual(h.published.map(({ grantedOrigins }) => grantedOrigins.length), [0, 5],
    "the newer reading is the last one sent");
  assert.equal(h.containsRequests.length, 3, "one extra pass, not one per request");
});
