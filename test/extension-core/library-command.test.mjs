import assert from "node:assert/strict";
import test from "node:test";

import {
  FinishQualificationService,
  LibraryMutationService,
} from "../../.trace-build/extension-core/library-command.mjs";

const scope = Object.freeze({ accountId: "account-a", epoch: 4 });
const entryId = "00000000-0000-4000-8000-000000000123";

function accountData(entry, hidden = false) {
  return Object.freeze({
    version: 1,
    scope,
    overlay: Object.freeze({
      entries: Object.freeze({ "ffn:7038840": Object.freeze(entry) }),
      workPreferences: Object.freeze(hidden
        ? {
            "ffn:7038840": Object.freeze({
              browsePreference: Object.freeze({ hidden: true }),
            }),
          }
        : {}),
      syncVersion: "2026-07-20T09:00:00.000Z",
    }),
  });
}

const savedEntry = Object.freeze({
  status: "PLANNING",
  readerStatus: "PLANNING",
  canonicalReaderStatus: "SAVED",
  entryId,
  chapters: Object.freeze({ current: 0, total: 12 }),
  rating: 0,
});
const readingEntry = Object.freeze({
  ...savedEntry,
  status: "READING",
  readerStatus: "READING",
  canonicalReaderStatus: "READING",
  chapters: Object.freeze({ current: 4, total: 12 }),
  rating: 5,
});
const patchCommand = Object.freeze({
  kind: "entry_patch",
  hostKind: "ffn",
  workKey: "ffn:7038840",
  entryId,
  patch: Object.freeze({
    status: "READING",
    progress: Object.freeze({ unit: "CHAPTER", value: 4, total: 12 }),
    rating: 5,
  }),
});

function harness(options = {}) {
  const state = {
    scope,
    projections: [...(options.projections ?? [
      { kind: "value", value: accountData(savedEntry) },
      { kind: "value", value: accountData(readingEntry) },
    ])],
    mutations: [...(options.mutations ?? [{ kind: "accepted" }])],
    signals: [...(options.signals ?? [{
      kind: "acknowledged",
      state: "open",
      eventId: "00000000-0000-4000-8000-000000000999",
    }])],
  };
  const calls = { mutate: 0, signal: 0, projection: 0 };
  const ports = {
    session: {
      publicationScope() {
        return state.scope;
      },
      async executeAuthenticated(effect) {
        if (state.scope === null) return { kind: "unavailable" };
        const starting = state.scope;
        const result = await effect("private-token");
        if (
          state.scope === null ||
          state.scope.accountId !== starting.accountId ||
          state.scope.epoch !== starting.epoch
        ) {
          return { kind: "stale" };
        }
        return result.kind === "auth_rejected"
          ? { kind: "auth_rejected", recovery: options.recovery ?? "reconnect_required" }
          : { kind: "published", value: result.value };
      },
    },
    projection: {
      async refreshAndRead() {
        calls.projection += 1;
        return state.projections.shift() ?? { kind: "unavailable" };
      },
    },
    api: {
      async mutate(credential, command) {
        assert.equal(credential, "private-token");
        assert.equal(command, patchCommand);
        calls.mutate += 1;
        if (options.onMutate) options.onMutate(state);
        const value = state.mutations.shift() ?? { kind: "uncertain" };
        return value.kind === "auth_rejected"
          ? value
          : { kind: "success", value };
      },
      async qualifyFinish(credential) {
        assert.equal(credential, "private-token");
        calls.signal += 1;
        const value = state.signals.shift() ?? { kind: "uncertain" };
        return value.kind === "auth_rejected"
          ? value
          : { kind: "success", value };
      },
    },
  };
  return { state, calls, ports };
}

test("already-satisfied entry patch is confirmed without another write", async () => {
  const h = harness({
    projections: [{ kind: "value", value: accountData(readingEntry) }],
  });
  const result = await new LibraryMutationService(h.ports).execute(patchCommand);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "preflight");
  assert.equal(h.calls.mutate, 0);
});

test("accepted entry patch is confirmed only after authoritative projection refresh", async () => {
  const h = harness();
  const result = await new LibraryMutationService(h.ports).execute(patchCommand);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "mutation");
  assert.equal(result.entry, readingEntry);
  assert.equal(h.calls.mutate, 1);
  assert.equal(h.calls.projection, 2);
});

test("uncertain entry patch reconciles without repeating the write", async () => {
  const h = harness({ mutations: [{ kind: "uncertain" }] });
  const result = await new LibraryMutationService(h.ports).execute(patchCommand);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "reconciliation");
  assert.equal(h.calls.mutate, 1);
});

test("entry id must match the authoritative work projection", async () => {
  const wrong = Object.freeze({ ...patchCommand, entryId: "00000000-0000-4000-8000-000000000456" });
  const h = harness({
    projections: [{ kind: "value", value: accountData(savedEntry) }],
  });
  const result = await new LibraryMutationService(h.ports).execute(wrong);
  assert.deepEqual(result, { kind: "failed", reason: "invalid_request" });
  assert.equal(h.calls.mutate, 0);
});

test("work preference command confirms exact absence and reconciles a hidden write", async () => {
  const command = Object.freeze({
    kind: "work_preference",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    hidden: true,
  });
  const h = harness({
    projections: [
      { kind: "value", value: accountData(savedEntry) },
      { kind: "value", value: accountData(savedEntry, true) },
    ],
  });
  h.ports.api.mutate = async () => {
    h.calls.mutate += 1;
    return { kind: "success", value: { kind: "uncertain" } };
  };
  const result = await new LibraryMutationService(h.ports).execute(command);
  assert.equal(result.kind, "confirmed");
  assert.equal(result.source, "reconciliation");
  assert.equal(h.calls.mutate, 1);
});

test("account change during mutation fences the projection result", async () => {
  const h = harness({
    onMutate(state) {
      state.scope = { accountId: "account-b", epoch: 5 };
    },
  });
  assert.deepEqual(
    await new LibraryMutationService(h.ports).execute(patchCommand),
    { kind: "failed", reason: "stale" },
  );
});

test("finish qualification requires the projected entry and returns only validated ack", async () => {
  const h = harness({
    projections: [{ kind: "value", value: accountData(savedEntry) }],
  });
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "open",
  });
  const result = await new FinishQualificationService(h.ports).execute(command);
  assert.deepEqual(result, {
    kind: "acknowledged",
    state: "open",
    eventId: "00000000-0000-4000-8000-000000000999",
  });
  assert.equal(h.calls.signal, 1);
});

test("finish qualification is fenced when the account changes during projection refresh", async () => {
  const h = harness();
  h.ports.projection.refreshAndRead = async () => {
    h.state.scope = { accountId: "account-b", epoch: 5 };
    return { kind: "value", value: accountData(savedEntry) };
  };
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "open",
  });
  assert.deepEqual(
    await new FinishQualificationService(h.ports).execute(command),
    { kind: "failed", reason: "stale" },
  );
  assert.equal(h.calls.signal, 0);
});
