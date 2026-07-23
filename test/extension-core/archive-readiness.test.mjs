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
