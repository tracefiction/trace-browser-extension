import assert from "node:assert/strict";
import test from "node:test";

import {
  SETUP_MILESTONES_KEY,
  SETUP_STEP_MESSAGE,
  SetupMilestoneApi,
  SetupMilestoneReporter,
  safariAccessAnswer,
  sendAsSignedIn,
  setupMilestoneReport,
  setupStepFromMessage,
} from "../../.trace-build/extension-runtime/setup-milestones.mjs";

const NOW = 1_800_000_000_000;
const ATTEMPT = "B7C2328B-0738-4389-8EC7-31F51783210E";
const OTHER_ATTEMPT = "0f1e2d3c-4b5a-4987-a654-321098765432";
const API = "https://api.trace.test";
const ENDPOINT = `${API}/api/extension/setup-milestones`;

/**
 * One install: its local storage, the account signed in, the setup the app
 * has under way, and Trace's answers. `background()` starts a reporter over
 * them, as Safari does each time it wakes the extension.
 */
function install() {
  const state = {
    account: "account-a",
    /** The app's PREPARE context; null when it has none. */
    context: { setupAttemptID: ATTEMPT, setupAttemptExpiresAt: NOW + 3_600_000 },
    /** Trace's status for each request, or an Error for one that never arrives. */
    answer: 200,
    now: NOW,
  };
  const store = {};
  const requests = [];
  const prepares = [];
  const writes = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, authorization: init.headers.Authorization, body: JSON.parse(init.body) });
    if (state.answer instanceof Error) throw state.answer;
    return new Response(JSON.stringify(state.answer === 200 ? { accepted: true, duplicate: false } : { error: "no" }), { status: state.answer });
  };
  const background = () => new SetupMilestoneReporter({
    account: () => state.account,
    async attempt(accountId) {
      prepares.push(accountId);
      return state.context ?? undefined;
    },
    send: sendAsSignedIn(async (effect) => {
      const result = await effect("device-credential");
      return result.kind === "success" ? { kind: "published", value: result.value } : { kind: "unavailable" };
    }, new SetupMilestoneApi(fetch, API)),
    storage: {
      async get(key) { return Object.hasOwn(store, key) ? { [key]: structuredClone(store[key]) } : {}; },
      async set(patch) { writes.push(Object.keys(patch)); Object.assign(store, structuredClone(patch)); },
      async remove(key) { delete store[key]; },
    },
    now: () => state.now,
  });
  return { state, store, requests, prepares, writes, background };
}

const opened = (page = "story") => ({ kind: "sheet_opened", page });
const answered = (answer) => ({ kind: "access_answered", answer });

test("each step maps to exactly the milestone, outcome and evidence Trace accepts", () => {
  const cases = [
    [opened("story"), "safari_sheet_opened", "confirmed", "extension_sheet_story_page"],
    [opened("other"), "safari_sheet_opened", "confirmed", "extension_sheet_other_page"],
    [answered("granted"), "safari_access_answered", "confirmed", "extension_permission_granted"],
    [answered("declined"), "safari_access_answered", "failed", "extension_permission_declined"],
    [answered("partial"), "safari_access_answered", "failed", "extension_permission_partial"],
    [answered("unanswered"), "safari_access_answered", "unknown", "extension_permission_unanswered"],
  ];
  for (const [step, milestone, outcome, evidence] of cases) {
    assert.deepEqual(setupMilestoneReport(step), { milestone, outcome, evidence_source: evidence });
  }
});

test("what the background reads of the ask becomes the reader's answer; a look with nothing asked is none", () => {
  const states = {
    allowed: "granted", registration_failed: "granted", registration_unknown: "granted",
    partial: "partial", not_allowed: "declined", not_known: "unanswered", could_not_ask: "unanswered",
    waiting: null, not_asked: null,
  };
  for (const [state, answer] of Object.entries(states)) {
    assert.equal(safariAccessAnswer({ state }), answer, state);
  }
});

test("a popup's message is read strictly: one of the known steps, or nothing", () => {
  assert.deepEqual(setupStepFromMessage({ type: SETUP_STEP_MESSAGE, step: "sheet_opened", page: "other" }), opened("other"));
  assert.deepEqual(setupStepFromMessage({ type: SETUP_STEP_MESSAGE, step: "access_answered", answer: "partial" }), answered("partial"));
  for (const message of [
    null, "TRACE_SETUP_STEP", { type: "OTHER", step: "sheet_opened", page: "story" },
    { type: SETUP_STEP_MESSAGE, step: "sheet_opened", page: "https://www.fanfiction.net/s/1/1/" },
    { type: SETUP_STEP_MESSAGE, step: "access_answered", answer: "always" },
    { type: SETUP_STEP_MESSAGE, step: "something_else" },
  ]) {
    assert.equal(setupStepFromMessage(message), null);
  }
});

test("the sheet's opening is reported once for a setup, with the exact body and the extension's credential", async () => {
  const world = install();
  const reporter = world.background();
  await reporter.record(opened("story"));
  await reporter.record(opened("other"));
  await world.background().record(opened("story"));

  assert.deepEqual(world.requests, [{
    url: ENDPOINT, method: "POST", authorization: "Bearer device-credential",
    body: {
      attempt_id: ATTEMPT.toLowerCase(),
      milestone: "safari_sheet_opened",
      outcome: "confirmed",
      evidence_source: "extension_sheet_story_page",
    },
  }]);
  assert.deepEqual(Object.keys(world.requests[0].body).sort(), ["attempt_id", "evidence_source", "milestone", "outcome"]);
  assert.deepEqual(world.prepares, ["account-a", "account-a", "account-a"]);
  assert.deepEqual(world.store[SETUP_MILESTONES_KEY].pending, [], "nothing is left once Trace has answered");

  // A new setup from the app is its own: its opening is reported too.
  world.state.context = { setupAttemptID: OTHER_ATTEMPT, setupAttemptExpiresAt: NOW + 3_600_000 };
  await reporter.record(opened("other"));
  assert.equal(world.requests.length, 2);
  assert.deepEqual(world.requests[1].body, {
    attempt_id: OTHER_ATTEMPT, milestone: "safari_sheet_opened", outcome: "confirmed", evidence_source: "extension_sheet_other_page",
  });
});

test("each answer is reported once; no answer is not reported after an answer", async () => {
  const world = install();
  const reporter = world.background();
  await reporter.record(answered("unanswered"));
  await reporter.record(answered("granted"));
  await reporter.record(answered("granted"));
  await reporter.record(answered("unanswered"));
  await reporter.record(answered("declined"));
  assert.deepEqual(world.requests.map(({ body }) => body.evidence_source), [
    "extension_permission_unanswered", "extension_permission_granted", "extension_permission_declined",
  ]);
});

test("without a setup under way, or without an account, nothing is kept or sent", async () => {
  for (const [label, change] of [
    ["no account", (state) => { state.account = null; }],
    ["no setup", (state) => { state.context = null; }],
    ["an older app's context", (state) => { state.context = { attemptID: ATTEMPT }; }],
    ["an ended setup", (state) => { state.context.setupAttemptExpiresAt = NOW; }],
    ["an end too far ahead", (state) => { state.context.setupAttemptExpiresAt = NOW + 86_400_001; }],
    ["a malformed id", (state) => { state.context.setupAttemptID = "https://www.fanfiction.net/s/1/1/"; }],
  ]) {
    const world = install();
    change(world.state);
    await world.background().record(opened("story"));
    await world.background().record(answered("granted"));
    assert.deepEqual(world.requests, [], label);
    assert.deepEqual(world.writes, [], label);
    assert.equal(Object.hasOwn(world.store, SETUP_MILESTONES_KEY), false, label);
  }
});

test("any answer but 200 is final: the report is dropped and never sent again", async () => {
  for (const status of [400, 401, 409, 429, 500]) {
    const world = install();
    world.state.answer = status;
    const reporter = world.background();
    await reporter.record(opened("story"));
    assert.equal(world.requests.length, 1, String(status));
    assert.deepEqual(world.store[SETUP_MILESTONES_KEY].pending, [], String(status));
    world.state.answer = 200;
    await reporter.flush();
    await world.background().record(opened("story"));
    assert.equal(world.requests.length, 1, `${status} is not sent again`);
  }
});

test("a request that never reaches Trace goes once more on the next opening, then is let go", async () => {
  const world = install();
  world.state.answer = new Error("offline");
  await world.background().record(opened("story"));
  assert.equal(world.requests.length, 1);
  assert.equal(world.store[SETUP_MILESTONES_KEY].pending.length, 1, "kept for the next sheet");

  await world.background().record(opened("story"));
  assert.equal(world.requests.length, 2, "sent once more, by a new background");
  assert.deepEqual(world.store[SETUP_MILESTONES_KEY].pending, []);

  await world.background().flush();
  assert.equal(world.requests.length, 2, "never a third time");
});

test("a background stopped before a report went sends it when it next runs, with no timer", async () => {
  const world = install();
  // As if Safari stopped the background the moment the report was kept.
  world.store[SETUP_MILESTONES_KEY] = {
    account: "account-a", attempt: ATTEMPT.toLowerCase(), reported: ["safari_sheet_opened"],
    pending: [{ attempt: ATTEMPT.toLowerCase(), milestone: "safari_sheet_opened", outcome: "confirmed", evidence_source: "extension_sheet_other_page", at: NOW - 60_000, sends: 0 }],
  };
  await world.background().record(answered("declined"));
  assert.deepEqual(world.requests.map(({ body }) => body.evidence_source), [
    "extension_sheet_other_page", "extension_permission_declined",
  ]);

  // A report kept longer than a day is let go unsent.
  const stale = install();
  stale.store[SETUP_MILESTONES_KEY] = {
    account: "account-a", attempt: ATTEMPT.toLowerCase(), reported: ["safari_sheet_opened"],
    pending: [{ attempt: ATTEMPT.toLowerCase(), milestone: "safari_sheet_opened", outcome: "confirmed", evidence_source: "extension_sheet_other_page", at: NOW - 86_400_001, sends: 0 }],
  };
  await stale.background().flush();
  assert.deepEqual(stale.requests, []);
  assert.deepEqual(stale.store[SETUP_MILESTONES_KEY].pending, []);
});

test("sign-out clears what is kept, and another account never sends the last one's reports", async () => {
  const world = install();
  world.state.answer = new Error("offline");
  const reporter = world.background();
  await reporter.record(opened("story"));
  assert.equal(world.store[SETUP_MILESTONES_KEY].pending.length, 1);
  await reporter.clear();
  assert.equal(Object.hasOwn(world.store, SETUP_MILESTONES_KEY), false);

  await reporter.record(opened("story"));
  assert.equal(world.store[SETUP_MILESTONES_KEY].pending.length, 1);
  world.state.answer = 200;
  world.state.account = "account-b";
  await world.background().flush();
  assert.equal(world.requests.length, 2, "nothing goes as the new account");
  assert.equal(Object.hasOwn(world.store, SETUP_MILESTONES_KEY), false);

  // Not signed in yet, as when a background starts: kept, not cleared.
  const starting = install();
  starting.state.answer = new Error("offline");
  await starting.background().record(opened("other"));
  starting.state.account = null;
  await starting.background().flush();
  assert.equal(starting.store[SETUP_MILESTONES_KEY].pending.length, 1);
});
