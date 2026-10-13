import assert from "node:assert/strict";
import test from "node:test";

import {
  SafariReadinessService,
  safariReadinessResult,
} from "../../.trace-build/extension-core/safari-readiness.mjs";

const PROVIDER = Object.freeze({ sessionID: "provider-session", recordDigest: "a".repeat(64) });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The world a report is read from: what the app's side holds, what Safari
 * allows, the scripts, the account and the preference. Everything is ready
 * unless a test says otherwise.
 */
function world(overrides = {}) {
  const state = {
    now: 1_800_000_000_000,
    provider: PROVIDER,
    cycle: { id: "cycle-1", accountId: "account-a" },
    access: [{ complete: true, granted: 5 }],
    registration: "registered",
    account: { state: "connected", session: "1.aaa", accountId: "account-a" },
    session: "1.aaa",
    saving: "on",
    delivery: ["stored"],
    ...overrides,
  };
  const calls = { prepared: 0, delivered: [], accessReads: 0, waits: [] };
  const service = new SafariReadinessService({
    async prepare() {
      calls.prepared += 1;
      return state.provider === null ? null : { provider: state.provider, cycle: state.cycle };
    },
    async deliver(report, preparation) {
      calls.delivered.push({ report, preparation });
      return state.delivery.length > 1 ? state.delivery.shift() : state.delivery[0];
    },
    async websiteAccess() {
      calls.accessReads += 1;
      const reading = state.access.length > 1 ? state.access.shift() : state.access[0];
      if (reading instanceof Error) throw reading;
      return reading;
    },
    async scriptRegistration() {
      if (state.registration instanceof Error) throw state.registration;
      return state.registration;
    },
    async account() {
      if (state.account instanceof Error) throw state.account;
      return typeof state.account === "function" ? state.account() : state.account;
    },
    session: () => state.session,
    async automaticSaving() {
      if (state.saving instanceof Error) throw state.saving;
      return state.saving;
    },
    async wait(ms) {
      calls.waits.push(ms);
      state.now += ms;
      await state.duringWait?.();
    },
    now: () => state.now,
  });
  return { state, calls, service };
}

const parts = (report) => Object.fromEntries(
  Object.entries(report.components).map(([name, { answer, reason }]) => [name, `${answer}:${reason}`]),
);

test("ready is all four positive, read in one cycle and bound to the provider and cycle that were open when it began", async () => {
  const w = world();
  const outcome = await w.service.report();
  assert.equal(outcome.kind, "delivered");
  assert.equal(outcome.report.result, "ready");
  assert.equal(outcome.report.version, 1);
  assert.equal(outcome.report.accountId, "account-a");
  assert.deepEqual(parts(outcome.report), {
    websiteAccess: "positive:allowed",
    scriptRegistration: "positive:registered",
    account: "positive:connected",
    automaticSaving: "positive:on",
  });
  for (const part of Object.values(outcome.report.components)) {
    assert.equal(part.observedAt <= outcome.report.observedAt, true, "each part was read before the report was made");
  }
  assert.deepEqual(w.calls.delivered[0].preparation, { provider: PROVIDER, cycle: { id: "cycle-1", accountId: "account-a" } });
  assert.deepEqual(w.calls.waits, [], "access read as allowed needs no second reading");
});

test("website access: allowed on one fresh reading; a blocker only on two agreeing readings with the list answering; otherwise unknown", async () => {
  for (const [readings, expected, reads] of [
    [[{ complete: true, granted: 5 }], "positive:allowed", 1],
    // A broader grant need not list the story sites by name.
    [[{ complete: true, granted: 0 }], "positive:allowed", 1],
    [[{ complete: false, granted: 0 }, { complete: false, granted: 0 }], "blocker:not_allowed", 2],
    [[{ complete: false, granted: 3 }, { complete: false, granted: 3 }], "blocker:partly_allowed", 2],
    [[{ complete: false, granted: 0 }, { complete: false, granted: 2 }], "blocker:partly_allowed", 2],
    // Unknown: no answer; an answer with no list; a second reading that disagrees or fails.
    [[{ complete: null, granted: null }], "unknown:unreadable", 1],
    [[new Error("unavailable")], "unknown:unreadable", 1],
    [[{ complete: false, granted: null }], "unknown:unconfirmed", 1],
    [[{ complete: false, granted: 0 }, { complete: null, granted: null }], "unknown:unconfirmed", 2],
    [[{ complete: false, granted: 0 }, { complete: false, granted: null }], "unknown:unconfirmed", 2],
    [[{ complete: false, granted: 0 }, new Error("unavailable")], "unknown:unconfirmed", 2],
    // Allowed by the time of the second reading is allowed.
    [[{ complete: false, granted: 0 }, { complete: true, granted: 5 }], "positive:allowed", 2],
  ]) {
    const w = world({ access: [...readings] });
    const { report } = await w.service.report();
    assert.equal(parts(report).websiteAccess, expected, JSON.stringify(readings.map(String)));
    assert.equal(w.calls.accessReads, reads);
    assert.deepEqual(w.calls.waits, reads === 2 ? [2_000] : [], "the two readings are a moment apart");
  }
});

test("script registration, the account and the automatic-saving preference each answer three ways", async () => {
  for (const [override, part, expected] of [
    [{ registration: "registered" }, "scriptRegistration", "positive:registered"],
    [{ registration: "declared" }, "scriptRegistration", "positive:declared"],
    [{ registration: "not_registered" }, "scriptRegistration", "blocker:not_registered"],
    [{ registration: "registration_failed" }, "scriptRegistration", "blocker:registration_failed"],
    [{ registration: "unreadable" }, "scriptRegistration", "unknown:unreadable"],
    [{ registration: new Error("unavailable") }, "scriptRegistration", "unknown:unreadable"],

    [{ account: { state: "no_account" } }, "account", "blocker:no_account"],
    [{ account: { state: "reconnect_required" } }, "account", "blocker:reconnect_required"],
    [{ account: { state: "pending" } }, "account", "unknown:pending"],
    [{ account: { state: "unreachable" } }, "account", "unknown:unreachable"],
    [{ account: new Error("unavailable") }, "account", "unknown:unreachable"],
    // Confirmed, and not the account the app's cycle is for.
    [{ cycle: { id: "cycle-1", accountId: "account-b" } }, "account", "unknown:mismatch"],

    [{ saving: "on" }, "automaticSaving", "positive:on"],
    [{ saving: "off" }, "automaticSaving", "blocker:off"],
    [{ saving: "unknown" }, "automaticSaving", "unknown:unreadable"],
    [{ saving: new Error("unavailable") }, "automaticSaving", "unknown:unreadable"],
  ]) {
    const w = world(override);
    const { report } = await w.service.report();
    assert.equal(parts(report)[part], expected, JSON.stringify(override));
    const answer = expected.split(":")[0];
    assert.equal(report.result, answer === "positive" ? "ready" : answer === "blocker" ? "not_ready" : "unknown");
    assert.equal(Object.hasOwn(report, "accountId"), parts(report).account === "positive:connected",
      "an account is named only when it is the one confirmed");
  }
});

test("not ready keeps every cause; unknown is only when nothing is a known blocker", async () => {
  const w = world({
    access: [{ complete: false, granted: 0 }],
    registration: "registration_failed",
    account: { state: "pending" },
    saving: "off",
  });
  const { report } = await w.service.report();
  assert.equal(report.result, "not_ready");
  assert.deepEqual(parts(report), {
    websiteAccess: "blocker:not_allowed",
    scriptRegistration: "blocker:registration_failed",
    account: "unknown:pending",
    automaticSaving: "blocker:off",
  });

  const part = (answer) => ({ answer, reason: "x", observedAt: 1 });
  const of = (a, b, c, d) => safariReadinessResult({
    websiteAccess: part(a), scriptRegistration: part(b), account: part(c), automaticSaving: part(d),
  });
  assert.equal(of("positive", "positive", "positive", "positive"), "ready");
  assert.equal(of("positive", "positive", "positive", "unknown"), "unknown");
  assert.equal(of("unknown", "unknown", "unknown", "unknown"), "unknown");
  assert.equal(of("positive", "unknown", "blocker", "positive"), "not_ready");
  assert.equal(of("blocker", "blocker", "blocker", "blocker"), "not_ready");
});

test("an account that changes while the report is read makes it unknown, never a mix of two accounts", async () => {
  // The account changes during the wait for the second access reading.
  const during = world({ access: [{ complete: false, granted: 0 }, { complete: false, granted: 0 }] });
  during.state.duringWait = () => { during.state.session = "2.bbb"; };
  const outcome = await during.service.report();
  const first = during.calls.delivered[0].report;
  assert.equal(parts(first).account, "unknown:changed");
  assert.equal(first.result, "unknown", "not ready is not claimed for an account that is no longer the one read");
  assert.equal(Object.hasOwn(first, "accountId"), false, "and neither account is named");
  // It reads again, for the account there is now.
  assert.equal(during.calls.prepared > 1, true);
  assert.equal(outcome.report.result !== "ready", true);

  // The account answered under one session and the session is already another.
  const already = world({ account: { state: "connected", session: "1.aaa", accountId: "account-a" }, session: "2.bbb" });
  await already.service.report();
  assert.equal(parts(already.calls.delivered[0].report).account, "unknown:changed");
  assert.equal(already.calls.delivered[0].report.result, "unknown");

  // Signed out while it was read.
  const gone = world({ access: [{ complete: false, granted: 0 }] });
  gone.state.duringWait = () => { gone.state.session = null; };
  await gone.service.report();
  assert.equal(gone.calls.delivered[0].report.result, "unknown");
});

test("an answer for a cycle the app has since replaced is not delivered as current: it is read again for the new one", async () => {
  const w = world({ delivery: ["stale_cycle", "stored"] });
  const cycles = [{ id: "cycle-1", accountId: "account-a" }, { id: "cycle-2", accountId: "account-a" }];
  w.state.cycle = cycles[0];
  const original = w.service;
  // The app opens a new cycle after the first reading began.
  const outcomePromise = original.report();
  w.state.cycle = cycles[1];
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "delivered");
  assert.equal(w.calls.prepared, 2, "it asked again which cycle is open");
  assert.deepEqual(w.calls.delivered.map(({ preparation }) => preparation.cycle.id), ["cycle-1", "cycle-2"]);

  // It does not go on for ever against an app that keeps refusing.
  const stuck = world({ delivery: ["stale_cycle"] });
  const refused = await stuck.service.report();
  assert.equal(refused.kind, "refused");
  assert.equal(stuck.calls.delivered.length, 3);

  // A plain refusal is not retried.
  const no = world({ delivery: ["refused"] });
  assert.equal((await no.service.report()).kind, "refused");
  assert.equal(no.calls.delivered.length, 1);
});

test("with no cycle open the report is still made, bound to the provider alone", async () => {
  const w = world({ cycle: null });
  const outcome = await w.service.report();
  assert.equal(outcome.kind, "delivered");
  assert.equal(outcome.report.result, "ready");
  assert.equal(w.calls.delivered[0].preparation.cycle, null);
});

test("with no provider nothing is read and nothing is sent", async () => {
  const w = world({ provider: null });
  assert.deepEqual(await w.service.report(), { kind: "no_provider" });
  assert.equal(w.calls.accessReads, 0);
  assert.deepEqual(w.calls.delivered, []);
});

test("a request while a report is being read is answered by reading again, not by a second report at once", async () => {
  const w = world();
  const gate = deferred();
  w.state.account = async () => { await gate.promise; return { state: "connected", session: "1.aaa", accountId: "account-a" }; };
  const first = w.service.report();
  const second = w.service.report();
  const third = w.service.report();
  assert.equal(first, second);
  assert.equal(second, third);
  // What it was asked about changed meanwhile.
  w.state.saving = "off";
  gate.resolve();
  const outcome = await first;
  assert.equal(w.calls.delivered.length, 2, "one more reading for all the requests that arrived");
  assert.equal(outcome.report.result, "not_ready", "and the last word is the latest reading");
});
