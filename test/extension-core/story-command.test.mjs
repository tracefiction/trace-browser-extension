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
        assert.equal(actualCommand, expectedCommand);
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
    clock: { now: () => 1_721_390_400_000 },
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

test("progress intent mutates until authoritative chapters reach its target", async () => {
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
  assert.equal(result.receipt, "not_applicable");
  assert.equal(result.handoff, "not_present");
  assert.equal(h.calls.track, 1);
  assert.deepEqual(h.calls.receipt, []);
  assert.deepEqual(h.calls.clear, []);
});

test("progress preflight skips mutation only when current and total reach the target", async () => {
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
  });

  const result = await h.service.execute(progressCommand);

  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "preflight");
  assert.equal(h.calls.track, 0);
  assert.deepEqual(h.calls.receipt, []);
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
    lookup: [
      { kind: "found", confirmation: behind },
      { kind: "found", confirmation: behind },
    ],
    mutations: [{ kind: "uncertain" }],
  });

  assert.deepEqual(await h.service.execute(progressCommand), {
    kind: "failed",
    reason: "confirmation_missing",
  });
  assert.deepEqual(h.calls.receipt, []);
  assert.deepEqual(h.calls.clear, []);
});
