import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_ACCESS_REPEAT_AFTER_MS,
  ARCHIVE_ACCESS_RETRY_DELAYS_MS,
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
// An install that has held the grant before: the only kind that can lose it.
const GRANT_SEEN = { grantSeen: true };

function createAccessHarness(options = {}) {
  let now = 2_000_000;
  const published = [];
  const waits = [];
  const listed = [...(options.listed ?? [])];
  const contains = [...(options.contains ?? [])];
  const containsRequests = [];
  let ledger = options.ledger ?? { grantSeen: false };
  const ledgerWrites = [];
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
    ...(options.withoutLedger ? {} : {
      accessLedger: {
        async read() {
          if (options.ledgerUnreadable) throw new Error("storage unavailable");
          return ledger;
        },
        async write(next) {
          ledgerWrites.push(next);
          ledger = next;
        },
      },
    }),
  });
  return {
    service, published, waits, containsRequests, ledgerWrites,
    ledger: () => ledger,
    setAccess(nextListed, nextContains) {
      listed.splice(0, listed.length, nextListed);
      contains.splice(0, contains.length, nextContains);
    },
    advance(ms) {
      now += ms;
    },
  };
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
  assert.equal(h.ledger().grantSeen, true, "the grant is remembered");
  assert.equal(h.ledger().deliveredAt, 2_000_000);
});

test("a confirmed grant is reported even when the browser lists nothing", async () => {
  const h = createAccessHarness({ listed: [null], contains: [true] });
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });
  assert.deepEqual(h.published[0].grantedOrigins, REQUIRED_ORIGINS);
});

test("missing access is never reported before this install has seen the grant", async () => {
  for (const [name, listed] of [
    ["first start, nothing granted", []],
    ["only Trace's own site", ["https://www.tracefiction.com/*"]],
    ["part-way through granting", REQUIRED_ORIGINS.slice(0, 3)],
    ["another spelling of some sites", ["*://*.archiveofourown.org/*", "*://*.fanfiction.net/*"]],
  ]) {
    const h = createAccessHarness({ listed: [listed], contains: [false] });
    assert.deepEqual(await h.service.reportAccess(), { kind: "withheld" }, name);
    assert.deepEqual(h.published, [], name);
    assert.deepEqual(h.waits, [], "nothing to confirm when nothing will be sent");
    assert.deepEqual(h.ledgerWrites, [], name);
  }
  // No ledger, or one that cannot be read, is the same as never having seen it.
  for (const options of [{ withoutLedger: true }, { ledgerUnreadable: true, ledger: GRANT_SEEN }]) {
    const h = createAccessHarness({ listed: [[]], contains: [false], ...options });
    assert.deepEqual(await h.service.reportAccess(), { kind: "withheld" });
    assert.deepEqual(h.published, []);
  }
});

test("access that ends after a recorded grant is reported, after the browser says so twice", async () => {
  const h = createAccessHarness({ listed: [REQUIRED_ORIGINS], contains: [true] });
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });

  // A one-day grant runs out: only Trace's own site is still granted.
  h.advance(24 * 60 * 60 * 1_000);
  h.setAccess(["https://www.tracefiction.com/*"], false);
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: false });
  assert.deepEqual(h.waits, [2_000]);
  assert.equal(h.containsRequests.length, 3, "one look while granted, two to confirm the loss");
  assert.deepEqual(h.published.at(-1), {
    at: 2_000_000 + 24 * 60 * 60 * 1_000 + 2_000,
    grantedOrigins: ["https://www.tracefiction.com/*"],
  });
  assert.equal(h.ledger().grantSeen, true);
});

test("a first reading of missing access that the second look contradicts is not reported as missing", async () => {
  const h = createAccessHarness({
    ledger: GRANT_SEEN,
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
    { listed: [[], null], contains: [false] },
    { listed: [[]], contains: [false], withoutRequired: true },
    { listed: [[]], withoutContains: true },
  ]) {
    const h = createAccessHarness({ ledger: GRANT_SEEN, ...options });
    assert.deepEqual(await h.service.reportAccess(), { kind: "unknown" });
    assert.deepEqual(h.published, []);
  }
});

test("the same reading is not sent again within a few minutes, and a changed one is sent at once", async () => {
  const h = createAccessHarness({ listed: [REQUIRED_ORIGINS], contains: [true] });
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });
  for (const wait of [1_000, 60_000, 4 * 60_000 - 61_001]) {
    h.advance(wait);
    assert.deepEqual(await h.service.reportAccess(), { kind: "current" });
  }
  assert.equal(h.published.length, 1);

  // A change is news however recent the last reading was.
  h.setAccess([...REQUIRED_ORIGINS, "*://*/*"], true);
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });
  h.setAccess([], false);
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: false });
  assert.equal(h.published.length, 3);

  // And an unchanged one is repeated once the few minutes have passed.
  h.advance(ARCHIVE_ACCESS_REPEAT_AFTER_MS);
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: false });
  assert.equal(h.published.length, 4);
});

test("a delivery that keeps failing is tried less and less often", async () => {
  let delivers = false;
  const h = createAccessHarness({
    listed: [REQUIRED_ORIGINS],
    contains: [true],
    publish: () => delivers,
  });
  assert.deepEqual(await h.service.reportAccess(), { kind: "unavailable" });
  assert.equal(h.ledger().grantSeen, true, "the grant was seen even though it was not delivered");
  assert.equal(h.ledger().deliveredAt, undefined, "an undelivered reading is not recorded as delivered");

  let attempts = 1;
  for (const delay of ARCHIVE_ACCESS_RETRY_DELAYS_MS) {
    h.advance(delay - 1);
    assert.deepEqual(await h.service.reportAccess(), { kind: "deferred" });
    assert.equal(h.published.length, attempts, "no attempt before the wait is over");
    h.advance(1);
    assert.deepEqual(await h.service.reportAccess(), { kind: "unavailable" });
    attempts += 1;
    assert.equal(h.published.length, attempts);
  }
  // The longest wait repeats; it does not grow without limit.
  h.advance(ARCHIVE_ACCESS_RETRY_DELAYS_MS.at(-1));
  delivers = true;
  assert.deepEqual(await h.service.reportAccess(), { kind: "published", complete: true });
  assert.equal(h.ledger().failures, undefined, "a delivery clears the back-off");
  assert.equal(h.ledger().retryAt, undefined);

  // A clock that moved backwards cannot silence readings for good.
  const skewed = createAccessHarness({
    listed: [REQUIRED_ORIGINS],
    contains: [true],
    ledger: { grantSeen: true, failures: 1, retryAt: 2_000_000 + 10 * 24 * 60 * 60 * 1_000 },
  });
  assert.deepEqual(await skewed.service.reportAccess(), { kind: "published", complete: true });
});

test("an open popup is not made to wait behind a failed delivery", async () => {
  let delivers = false;
  const h = createAccessHarness({
    listed: [REQUIRED_ORIGINS],
    contains: [true],
    publish: () => delivers,
  });
  // Six failures in a row, each as soon as the back-off allows.
  for (let failure = 0; failure < 6; failure += 1) {
    assert.deepEqual(await h.service.reportAccess(), { kind: "unavailable" });
    h.advance(ARCHIVE_ACCESS_RETRY_DELAYS_MS.at(-1));
  }
  assert.deepEqual(await h.service.reportAccess(), { kind: "unavailable" });
  const attempts = h.published.length;

  // The app is healthy again a minute later. A background trigger still
  // waits; a reader opening the popup does not.
  delivers = true;
  h.advance(60_000);
  assert.deepEqual(await h.service.reportAccess(), { kind: "deferred" });
  assert.equal(h.published.length, attempts);
  assert.deepEqual(await h.service.reportAccess({ readerPresent: true }), { kind: "published", complete: true });
  assert.equal(h.ledger().retryAt, undefined, "and the back-off is over");

  // Access that ends during a back-off is delivered when the popup opens.
  delivers = false;
  h.advance(ARCHIVE_ACCESS_REPEAT_AFTER_MS);
  assert.deepEqual(await h.service.reportAccess(), { kind: "unavailable" });
  h.setAccess(["https://www.tracefiction.com/*"], false);
  delivers = true;
  assert.deepEqual(await h.service.reportAccess(), { kind: "deferred" });
  assert.deepEqual(await h.service.reportAccess({ readerPresent: true }), { kind: "published", complete: false });

  // A popup open that fails is still one attempt, and still backs off the rest.
  delivers = false;
  h.advance(ARCHIVE_ACCESS_REPEAT_AFTER_MS);
  const before = h.published.length;
  assert.deepEqual(await h.service.reportAccess({ readerPresent: true }), { kind: "unavailable" });
  assert.equal(h.published.length, before + 1);
  assert.deepEqual(await h.service.reportAccess(), { kind: "deferred" });
});

test("a popup open that arrives while a deferred reading is under way still gets past the back-off", async () => {
  const h = createAccessHarness({
    ledger: { grantSeen: true, failures: 2, retryAt: 2_000_000 + 60_000 },
    listed: [REQUIRED_ORIGINS],
    contains: [true],
  });
  // A background trigger starts first and will be deferred; the popup opens
  // before it has finished. Both get the popup's answer.
  const background = h.service.reportAccess();
  const popup = h.service.reportAccess({ readerPresent: true });
  assert.deepEqual(await popup, { kind: "published", complete: true });
  assert.equal(await background, await popup);
  assert.equal(h.published.length, 1);

  // The reader's presence is used once; it does not leak into a later trigger.
  const later = createAccessHarness({
    ledger: { grantSeen: true, failures: 2, retryAt: 2_000_000 + 60_000 },
    listed: [REQUIRED_ORIGINS],
    contains: [true],
    publish: () => false,
  });
  assert.deepEqual(await later.service.reportAccess({ readerPresent: true }), { kind: "unavailable" });
  assert.deepEqual(await later.service.reportAccess(), { kind: "deferred" });
  assert.equal(later.published.length, 1);
});

test("a failed delivery is never left alone for more than thirty minutes", () => {
  assert.deepEqual([...ARCHIVE_ACCESS_RETRY_DELAYS_MS], [60_000, 5 * 60_000, 30 * 60_000]);
});

test("a delivery that throws is reported as unavailable", async () => {
  const h = createAccessHarness({
    listed: [REQUIRED_ORIGINS],
    contains: [true],
    publish: () => { throw new Error("native messaging failed"); },
  });
  assert.deepEqual(await h.service.reportAccess(), { kind: "unavailable" });
});

test("requests made while a reading is running share it and trigger one more look", async () => {
  let again;
  const h = createAccessHarness({
    ledger: GRANT_SEEN,
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

test("a reading that keeps being asked for again still ends", async () => {
  let asked = 0;
  const h = createAccessHarness({
    ledger: GRANT_SEEN,
    listed: [[]],
    contains: [false],
    // Something asks again during every confirmation, eight times over.
    duringWait: async () => {
      asked += 1;
      if (asked <= 8) void h.service.reportAccess();
    },
  });
  await h.service.reportAccess();
  assert.equal(h.waits.length, 3, "three passes at most for one run");
});
