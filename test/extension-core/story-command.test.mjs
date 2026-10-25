import assert from "node:assert/strict";
import test from "node:test";

import {
  StoryCommandService,
} from "../../.trace-build/extension-core/story-command.mjs";

const scope = Object.freeze({ accountId: "account-a", epoch: 1 });
const entryId = "00000000-0000-4000-8000-000000000123";
const confirmation = Object.freeze({
  workKey: "ffn:7038840",
  entryId,
  entry: Object.freeze({
    status: "PLANNING",
    readerStatus: "PLANNING",
    canonicalReaderStatus: "SAVED",
    entryId,
  }),
  syncVersion: "2026-07-19T12:00:00.000Z",
});
const command = Object.freeze({
  intent: "ensure_saved",
  hostKind: "ffn",
  workKey: "ffn:7038840",
  payload: Object.freeze({
    s: "ffn",
    at: "2026-07-19T12:00:00.000Z",
    item: Object.freeze({
      src: "ffn",
      ctx: "story",
      u: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
    }),
  }),
  handoffId: "handoff_7038840",
});

function createHarness(options = {}) {
  const expectedCommand = options.command ?? command;
  const state = {
    scope,
    lookup: [...(options.lookup ?? [{ kind: "absent" }])],
    mutations: [...(options.mutations ?? [{
      kind: "confirmed",
      confirmation,
    }])],
    projection: options.projection ?? { kind: "published" },
    receipt: options.receipt ?? true,
    clear: options.clear ?? true,
  };
  const calls = {
    lookup: 0,
    track: 0,
    projection: 0,
    receipt: [],
    clear: [],
  };
  const session = {
    publicationScope() {
      return state.scope;
    },
    async executeAuthenticated(effect) {
      if (state.scope === null) return { kind: "unavailable" };
      const startingScope = state.scope;
      const result = await effect("private-token");
      if (
        state.scope === null ||
        state.scope.accountId !== startingScope.accountId ||
        state.scope.epoch !== startingScope.epoch
      ) {
        return { kind: "stale" };
      }
      if (result.kind === "success") return { kind: "published", value: result.value };
      if (result.kind === "auth_rejected") {
        return {
          kind: "auth_rejected",
          recovery: options.authRecovery ?? "reconnect_required",
        };
      }
      return { kind: "unavailable" };
    },
  };
  const service = new StoryCommandService({
    session,
    api: {
      async lookup(credential, workKey) {
        assert.equal(credential, "private-token");
        assert.equal(workKey, expectedCommand.workKey);
        calls.lookup += 1;
        const result = state.lookup.shift() ?? { kind: "unavailable" };
        return result.kind === "auth_rejected"
          ? result
          : { kind: "success", value: result };
      },
      async track(credential, actualCommand) {
        assert.equal(credential, "private-token");
        if (options.checkTrack) options.checkTrack(actualCommand, calls.track);
        else assert.deepStrictEqual(actualCommand, options.expectedTrack ?? expectedCommand);
        calls.track += 1;
        if (options.onTrack) await options.onTrack(state);
        const result = state.mutations.shift() ?? { kind: "uncertain" };
        return result.kind === "auth_rejected"
          ? result
          : { kind: "success", value: result };
      },
    },
    projection: {
      async publishConfirmed(actualScope, actualConfirmation) {
        calls.projection += 1;
        assert.deepEqual(actualScope, scope);
        assert.equal(actualConfirmation.workKey, expectedCommand.workKey);
        return state.projection;
      },
    },
    receipt: {
      ...(options.prepare ? { prepareSaveReceipt: options.prepare } : {}),
      async publishSaveReceipt(receipt) {
        calls.receipt.push(receipt);
        return state.receipt;
      },
    },
    handoff: {
      async clearExpected(handoffId) {
        calls.clear.push(handoffId);
        return state.clear;
      },
    },
    clock: { now: options.now ?? (() => 1_721_390_400_000) },
  });
  return { service, state, calls };
}

test("preflight confirmation avoids a repeated mutation after worker restart", async () => {
  const h = createHarness({
    lookup: [{ kind: "found", confirmation }],
  });
  const result = await h.service.execute(command);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "preflight");
  assert.equal(h.calls.track, 0);
  assert.equal(h.calls.projection, 1);
  assert.deepEqual(h.calls.receipt, [{
    accountID: "account-a", entryID: confirmation.entryId, workKey: confirmation.workKey, source: "preflight",
    hostKind: "ffn",
    action: "quick_add",
    at: 1_721_390_400_000,
    handoffId: "handoff_7038840",
  }]);
  assert.deepEqual(h.calls.clear, ["handoff_7038840"]);
});

test("confirmed mutation publishes projection before receipt and clears only its handoff", async () => {
  const order = [];
  const h = createHarness();
  h.service = new StoryCommandService({
    session: {
      publicationScope: () => scope,
      async executeAuthenticated(effect) {
        const result = await effect("private-token");
        return { kind: "published", value: result.value };
      },
    },
    api: {
      async lookup() {
        order.push("lookup");
        return { kind: "success", value: { kind: "absent" } };
      },
      async track() {
        order.push("track");
        return { kind: "success", value: { kind: "confirmed", confirmation } };
      },
    },
    projection: {
      async publishConfirmed() {
        order.push("projection");
        return { kind: "published" };
      },
    },
    receipt: {
      async publishSaveReceipt() {
        order.push("receipt");
        return true;
      },
    },
    handoff: {
      async clearExpected() {
        order.push("clear");
        return true;
      },
    },
    clock: { now: () => 1 },
  });
  const result = await h.service.execute(command);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "mutation");
  assert.deepEqual(order, ["lookup", "track", "projection", "receipt", "clear"]);
});

test("uncertain POST reconciles by lookup and never repeats the mutation", async () => {
  const h = createHarness({
    lookup: [
      { kind: "absent" },
      { kind: "found", confirmation },
    ],
    mutations: [{ kind: "uncertain" }],
  });
  const result = await h.service.execute(command);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "reconciliation");
  assert.equal(h.calls.track, 1);
  assert.equal(h.calls.lookup, 2);
});

test("unconfirmed uncertain POST remains retryable without a receipt or cleanup", async () => {
  const h = createHarness({
    lookup: [{ kind: "absent" }, { kind: "absent" }],
    mutations: [{ kind: "uncertain" }],
  });
  assert.deepEqual(await h.service.execute(command), {
    kind: "failed",
    reason: "confirmation_missing",
  });
  assert.equal(h.calls.track, 1);
  assert.equal(h.calls.projection, 0);
  assert.deepEqual(h.calls.receipt, []);
  assert.deepEqual(h.calls.clear, []);
});

test("account change during mutation fences projection, receipt, and handoff cleanup", async () => {
  const h = createHarness({
    onTrack(state) {
      state.scope = { accountId: "account-b", epoch: 2 };
    },
  });
  assert.deepEqual(await h.service.execute(command), {
    kind: "failed",
    reason: "stale",
  });
  assert.equal(h.calls.projection, 0);
  assert.deepEqual(h.calls.receipt, []);
  assert.deepEqual(h.calls.clear, []);
});

test("projection scope rejection prevents a save receipt", async () => {
  const h = createHarness({
    projection: { kind: "rejected_scope" },
  });
  assert.deepEqual(await h.service.execute(command), {
    kind: "failed",
    reason: "stale",
  });
  assert.deepEqual(h.calls.receipt, []);
  assert.deepEqual(h.calls.clear, []);
});

test("native receipt failure does not turn a confirmed server save into another POST", async () => {
  const h = createHarness({ receipt: false, clear: false });
  const result = await h.service.execute(command);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.receipt, "unavailable");
  assert.equal(result.handoff, "unavailable");
  assert.equal(h.calls.track, 1);
});

test("a definitive 401 may retry once after recovery, while other failures do not mutate", async () => {
  const recovered = createHarness({
    lookup: [
      { kind: "auth_rejected" },
      { kind: "absent" },
    ],
    authRecovery: "connected",
  });
  assert.equal((await recovered.service.execute(command)).kind, "confirmed");
  assert.equal(recovered.calls.lookup, 2);
  assert.equal(recovered.calls.track, 1);

  const capped = createHarness({
    mutations: [{ kind: "rejected", reason: "free_limit_reached" }],
  });
  assert.deepEqual(await capped.service.execute(command), {
    kind: "failed",
    reason: "free_limit_reached",
  });
  assert.equal(capped.calls.projection, 0);
  assert.deepEqual(capped.calls.receipt, []);
});

test("progress starts with its authoritative monotonic mutation", async () => {
  const behind = Object.freeze({
    ...confirmation,
    entry: Object.freeze({
      ...confirmation.entry,
      chapters: Object.freeze({ current: 2, total: 12 }),
    }),
  });
  const current = Object.freeze({
    ...confirmation,
    entry: Object.freeze({
      ...confirmation.entry,
      chapters: Object.freeze({ current: 4, total: 12 }),
    }),
  });
  const progressCommand = Object.freeze({
    ...command,
    intent: "record_progress",
    progress: Object.freeze({ current: 4, total: 12 }),
  });
  const h = createHarness({
    command: progressCommand,
    lookup: [{ kind: "found", confirmation: behind }],
    mutations: [{ kind: "confirmed", confirmation: current }],
  });

  const result = await h.service.execute(progressCommand);

  assert.equal(result.kind, "confirmed");
  assert.equal(result.intent, "record_progress");
  assert.equal(result.source, "mutation");
  assert.equal(result.receipt, "published");
  assert.equal(result.handoff, "not_present");
  assert.equal(h.calls.lookup, 0);
  assert.equal(h.calls.track, 1);
  assert.equal(h.calls.receipt.length, 1);
  assert.equal(h.calls.receipt[0].action, "read");
  assert.equal(h.calls.receipt[0].entryID, current.entryId);
  assert.deepEqual(h.calls.receipt[0].progress, { current: 4, total: 12 },
    "the receipt names the chapter the page reported");
  assert.deepEqual(h.calls.clear, []);
});

test("progress does not use a full-overlay preflight to suppress its mutation", async () => {
  const current = Object.freeze({
    ...confirmation,
    entry: Object.freeze({
      ...confirmation.entry,
      chapters: Object.freeze({ current: 5, total: 13 }),
    }),
  });
  const progressCommand = Object.freeze({
    ...command,
    intent: "record_progress",
    progress: Object.freeze({ current: 4, total: 12 }),
  });
  const h = createHarness({
    command: progressCommand,
    lookup: [{ kind: "found", confirmation: current }],
    mutations: [{ kind: "confirmed", confirmation: current }],
  });

  const result = await h.service.execute(progressCommand);

  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "mutation");
  assert.equal(h.calls.lookup, 0);
  assert.equal(h.calls.track, 1);
  assert.equal(h.calls.receipt.length, 1);
  assert.equal(h.calls.receipt[0].action, "read");
  assert.equal(h.calls.receipt[0].entryID, current.entryId);
});

test("uncertain progress write is not confirmed by an older reconciled chapter", async () => {
  const behind = Object.freeze({
    ...confirmation,
    entry: Object.freeze({
      ...confirmation.entry,
      chapters: Object.freeze({ current: 2, total: 12 }),
    }),
  });
  const progressCommand = Object.freeze({
    ...command,
    intent: "record_progress",
    progress: Object.freeze({ current: 4, total: 12 }),
  });
  const h = createHarness({
    command: progressCommand,
    lookup: [{ kind: "found", confirmation: behind }],
    mutations: [{ kind: "uncertain" }],
  });

  assert.deepEqual(await h.service.execute(progressCommand), {
    kind: "failed",
    reason: "confirmation_missing",
  });
  assert.equal(h.calls.lookup, 1);
  assert.equal(h.calls.track, 1);
  assert.deepEqual(h.calls.receipt, []);
  assert.deepEqual(h.calls.clear, []);
});

test("progress retries a definitive 401 directly after auth recovery", async () => {
  const current = Object.freeze({
    ...confirmation,
    entry: Object.freeze({
      ...confirmation.entry,
      chapters: Object.freeze({ current: 4, total: 12 }),
    }),
  });
  const progressCommand = Object.freeze({
    ...command,
    intent: "record_progress",
    progress: Object.freeze({ current: 4, total: 12 }),
  });
  const h = createHarness({
    command: progressCommand,
    lookup: [{ kind: "found", confirmation: current }],
    mutations: [
      { kind: "auth_rejected" },
      { kind: "confirmed", confirmation: current },
    ],
    authRecovery: "connected",
  });

  const result = await h.service.execute(progressCommand);

  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "mutation");
  assert.equal(h.calls.lookup, 0);
  assert.equal(h.calls.track, 2);
});

const attemptID = "b7c2328b-0738-4389-8ec7-31f51783210e";
const setupContext = { setupAttemptID: attemptID, setupAttemptExpiresAt: 1_721_390_401_000 };
test("carries only a native prepared, unexpired setup UUID", async () => {
  for (const intent of ["ensure_saved", "record_progress"]) {
    const input = { ...command, intent };
    const h = createHarness({ command: input, prepare: async () => setupContext,
      expectedTrack: { ...input, payload: { ...input.payload, attempt_id: attemptID } } });
    await h.service.execute(input);
    assert.equal(h.calls.track, 1);
  }
});
test("omits absent, expired, malformed and page-supplied attribution", async () => {
  for (const context of [undefined, {}, { ...setupContext, setupAttemptID: "https://example.test/story" },
    { ...setupContext, setupAttemptExpiresAt: 0 }, { ...setupContext, setupAttemptExpiresAt: Infinity }]) {
    const input = { ...command, payload: { ...command.payload, attempt_id: attemptID } };
    const h = createHarness({ command: input, prepare: async () => context, expectedTrack: command });
    await h.service.execute(input);
    assert.equal(h.calls.track, 1);
  }
});
test("account change while native preparation is pending suppresses the write", async () => {
  let h;
  h = createHarness({ prepare: async () => { h.state.scope = { accountId: "account-b", epoch: 2 }; return setupContext; } });
  assert.deepEqual(await h.service.execute(command), { kind: "failed", reason: "stale" });
  assert.equal(h.calls.track, 0);
});

test("expiry is checked again for a definitive auth retry", async () => {
  let now = 1_721_390_400_000;
  let firstCommand;
  const h = createHarness({ prepare: async () => setupContext, now: () => now,
    lookup: [{ kind: "absent" }, { kind: "absent" }], authRecovery: "connected",
    mutations: [{ kind: "auth_rejected" }, { kind: "confirmed", confirmation }],
    checkTrack(actual, index) {
      assert.equal(actual.payload.attempt_id, index === 0 ? attemptID : undefined);
      if (index === 0) firstCommand = actual;
      else assert.equal(actual, firstCommand, "preserve reading-activity retry identity");
    },
    onTrack() { now = setupContext.setupAttemptExpiresAt; } });
  assert.equal((await h.service.execute(command)).kind, "confirmed");
  assert.equal(h.calls.track, 2);
});

// --- What is known about the write when a save ends --------------------------

test("a save that never reached the network is the only one reported as never sent", async () => {
  for (const [name, options, expected] of [
    ["no account", { scopeNull: true }, "never_sent"],
    ["the Library could not be read first", { lookup: [{ kind: "unavailable" }] }, "never_sent"],
    ["the Library answer was unreadable", { lookup: [{ kind: "invalid_response" }] }, "never_sent"],
    ["sign-in refused before the write", { lookup: [{ kind: "auth_rejected" }] }, "never_sent"],
    ["Trace declined the story", { mutations: [{ kind: "rejected", reason: "free_limit_reached" }] }, "refused"],
    ["sign-in refused at the write", { mutations: [{ kind: "auth_rejected" }] }, "refused"],
    ["no answer, and the Library does not show it", { lookup: [{ kind: "absent" }, { kind: "absent" }], mutations: [{ kind: "uncertain" }] }, "sent_unconfirmed"],
    ["no answer, and the Library could not be read", { lookup: [{ kind: "absent" }, { kind: "unavailable" }], mutations: [{ kind: "uncertain" }] }, "sent_unconfirmed"],
    ["an unreadable answer to the write", { mutations: [{ kind: "invalid_response" }] }, "sent_unconfirmed"],
  ]) {
    const h = createHarness(options);
    if (options.scopeNull) h.state.scope = null;
    const { result, dispatch } = await h.service.executeWithEvidence(command);
    assert.equal(result.kind, "failed", name);
    assert.equal(dispatch, expected, name);
    assert.equal(h.calls.track, expected === "never_sent" ? 0 : 1, name);
  }
});

test("a confirmed save says so whichever way it was confirmed, and execute still returns the bare result", async () => {
  for (const [options, source] of [
    [{ lookup: [{ kind: "found", confirmation }] }, "preflight"],
    [{}, "mutation"],
    [{ lookup: [{ kind: "absent" }, { kind: "found", confirmation }], mutations: [{ kind: "uncertain" }] }, "reconciliation"],
  ]) {
    const { result, dispatch } = await createHarness(options).service.executeWithEvidence(command);
    assert.equal(result.kind, "confirmed");
    assert.equal(result.source, source);
    assert.equal(dispatch, "confirmed");
    const bare = await createHarness(options).service.execute(command);
    assert.deepEqual(bare, result);
  }
});

test("an account that changes while the write is out is not reported as never sent", async () => {
  const h = createHarness({ onTrack(state) { state.scope = { accountId: "account-b", epoch: 2 }; } });
  const { result, dispatch } = await h.service.executeWithEvidence(command);
  assert.deepEqual(result, { kind: "failed", reason: "stale" });
  assert.equal(dispatch, "sent_unconfirmed");
});

test("the mode stamped on a command reaches its receipt and is not sent to Trace", async () => {
  const h = createHarness();
  const result = await h.service.execute({ ...command, mode: "bounded_manual" });
  assert.equal(result.kind, "confirmed");
  assert.equal(h.calls.receipt[0].mode, "bounded_manual");
  const unstamped = createHarness();
  await unstamped.service.execute(command);
  assert.equal(Object.hasOwn(unstamped.calls.receipt[0], "mode"), false);
});

// --- Looking without saving ---------------------------------------------------

test("presence finds a story without sending, publishing or telling the app anything", async () => {
  const h = createHarness({ lookup: [{ kind: "found", confirmation }] });
  assert.deepEqual(await h.service.presence(command.workKey), { kind: "found", confirmation });
  assert.equal(h.calls.track, 0);
  assert.equal(h.calls.projection, 0);
  assert.deepEqual(h.calls.receipt, []);
  assert.deepEqual(h.calls.clear, []);
});

test("presence never reports a story as missing, and cannot reach the write", async () => {
  for (const lookup of [
    [{ kind: "absent" }],
    [{ kind: "unavailable" }],
    [{ kind: "invalid_response" }],
    [{ kind: "auth_rejected" }],
    [{ kind: "found", confirmation: { ...confirmation, workKey: "ffn:1" } }],
  ]) {
    const h = createHarness({ lookup, checkTrack() { assert.fail("looking must never save"); } });
    assert.deepEqual(await h.service.presence(command.workKey), { kind: "unknown" });
    assert.equal(h.calls.track, 0);
  }
  const noAccount = createHarness();
  noAccount.state.scope = null;
  assert.deepEqual(await noAccount.service.presence(command.workKey), { kind: "unknown" });
  const changed = createHarness({ lookup: [{ kind: "found", confirmation }] });
  const lookup = changed.service.presence(command.workKey);
  changed.state.scope = { accountId: "account-b", epoch: 2 };
  assert.deepEqual(await lookup, { kind: "unknown" });
});

test("a caller is told just before each write goes out, and only then; what it does cannot stop the save", async () => {
  const order = [];
  const h = createHarness({ checkTrack() { order.push("write"); } });
  const { dispatch } = await h.service.executeWithEvidence(command, {
    async beforeWrite() { order.push("before"); throw new Error("could not record it"); },
  });
  assert.deepEqual(order, ["before", "write"]);
  assert.equal(dispatch, "confirmed");

  const found = createHarness({ lookup: [{ kind: "found", confirmation }] });
  let told = 0;
  await found.service.executeWithEvidence(command, { beforeWrite() { told += 1; } });
  assert.equal(told, 0, "a story found first has no write to announce");
});

