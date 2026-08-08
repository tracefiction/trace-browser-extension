import assert from "node:assert/strict";
import test from "node:test";

import {
  FinishQualificationService,
  LibraryMutationService,
} from "../../.trace-build/extension-core/library-command.mjs";

const scope = Object.freeze({ accountId: "account-a", epoch: 4 });
const entryId = "00000000-0000-4000-8000-000000000123";
const finishOperationId = "00000000-0000-4000-8000-000000000001";

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
const finishedEntry = Object.freeze({
  ...readingEntry,
  status: "COMPLETED",
  readerStatus: "COMPLETED",
  canonicalReaderStatus: "FINISHED",
  chapters: Object.freeze({ current: 12, total: 12 }),
  workStatus: "complete",
  workStatusProvenance: "source",
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
      workKey: "ffn:7038840",
      entry: savedEntry,
      syncVersion: "2026-07-20T09:00:00.000Z",
    }])],
  };
  const calls = {
    mutate: 0,
    signal: 0,
    projection: 0,
    publication: 0,
    publicationReservations: 0,
    operationIds: 0,
    finishOperations: [],
  };
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
      reserveFinishPublication() {
        calls.publicationReservations += 1;
        return calls.publicationReservations;
      },
      async refreshAndRead() {
        calls.projection += 1;
        return state.projections.shift() ?? { kind: "unavailable" };
      },
      async publishFinishAcknowledgement(
        actualScope,
        _command,
        acknowledgement,
        reservation,
      ) {
        calls.publication += 1;
        assert.deepEqual(actualScope, scope);
        assert.equal(reservation, calls.publicationReservations);
        if (options.onPublishFinish) return options.onPublishFinish(state, acknowledgement);
        return { kind: "published" };
      },
    },
    finishOperationIds: {
      create() {
        calls.operationIds += 1;
        return `00000000-0000-4000-8000-${String(calls.operationIds).padStart(12, "0")}`;
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
      async qualifyFinish(credential, operation) {
        assert.equal(credential, "private-token");
        calls.signal += 1;
        calls.finishOperations.push(operation);
        if (options.onSignal) options.onSignal(state);
        const rawValue = state.signals.shift() ?? { kind: "uncertain" };
        const value = rawValue.kind === "acknowledged"
          ? {
              ...rawValue,
              operationId: rawValue.operationId ??
                (operation.state === "resolved" ? operation.operationId : null),
            }
          : rawValue;
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

test("finish qualification uses the authoritative API entry without projection preflight", async () => {
  const h = harness({
    projections: [{ kind: "unavailable" }],
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
    operationId: null,
    workKey: "ffn:7038840",
    entry: savedEntry,
    syncVersion: "2026-07-20T09:00:00.000Z",
  });
  assert.equal(h.calls.signal, 1);
  assert.equal(h.calls.publication, 1);
  assert.equal(h.calls.projection, 0);
});

test("ignored finish qualification publishes its authoritative entry", async () => {
  const h = harness({
    signals: [{
      kind: "acknowledged",
      state: "ignored",
      eventId: null,
      workKey: "ffn:7038840",
      entry: finishedEntry,
    }],
  });
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "wip",
    resolutionSource: "source",
  });

  assert.deepEqual(await new FinishQualificationService(h.ports).execute(command), {
    kind: "acknowledged",
    state: "ignored",
    eventId: null,
    operationId: finishOperationId,
    workKey: "ffn:7038840",
    entry: finishedEntry,
  });
  assert.equal(h.calls.signal, 1);
  assert.equal(h.calls.publication, 1);
  assert.equal(h.calls.projection, 0);
  assert.equal(h.calls.operationIds, 1);
});

test("ignored deletion receipt is published once without a transport retry", async () => {
  const h = harness({
    signals: [{
      kind: "acknowledged",
      state: "ignored",
      eventId: null,
      workKey: null,
      entry: null,
      syncVersion: null,
    }],
  });
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "wip",
    resolutionSource: "source",
  });

  assert.deepEqual(await new FinishQualificationService(h.ports).execute(command), {
    kind: "acknowledged",
    state: "ignored",
    eventId: null,
    operationId: finishOperationId,
    workKey: null,
    entry: null,
    syncVersion: null,
  });
  assert.equal(h.calls.signal, 1);
  assert.equal(h.calls.publication, 1);
});

test("resolved receipt replay after deletion is published once without recovery retry", async () => {
  const eventId = "00000000-0000-4000-8000-000000000999";
  const h = harness({
    signals: [{
      kind: "acknowledged",
      state: "resolved",
      eventId,
      workKey: null,
      entry: null,
      syncVersion: null,
    }],
  });
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "wip",
    resolutionSource: "source",
  });

  assert.deepEqual(await new FinishQualificationService(h.ports).execute(command), {
    kind: "acknowledged",
    state: "resolved",
    eventId,
    operationId: finishOperationId,
    workKey: null,
    entry: null,
    syncVersion: null,
  });
  assert.equal(h.calls.signal, 1);
  assert.equal(h.calls.publication, 1);
});

test("disabled finish qualification is terminal and is not retried", async () => {
  const h = harness({
    signals: [{
      kind: "rejected",
      reason: "finish_qualification_disabled",
    }],
  });
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "wip",
    resolutionSource: "source",
  });

  assert.deepEqual(await new FinishQualificationService(h.ports).execute(command), {
    kind: "failed",
    reason: "finish_qualification_disabled",
  });
  assert.equal(h.calls.signal, 1);
  assert.equal(h.calls.publication, 0);
});

test("finish qualification is fenced when the account changes during authenticated execution", async () => {
  const h = harness({
    onSignal(state) {
      state.scope = { accountId: "account-b", epoch: 5 };
    },
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
  assert.deepEqual(
    await new FinishQualificationService(h.ports).execute(command),
    { kind: "failed", reason: "stale" },
  );
  assert.equal(h.calls.signal, 1);
  assert.equal(h.calls.publication, 0);
});

test("finish qualification is fenced when account authority changes during publication", async () => {
  const h = harness({
    onPublishFinish(state) {
      state.scope = { accountId: "account-b", epoch: 5 };
      return { kind: "rejected_scope" };
    },
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

  assert.deepEqual(
    await new FinishQualificationService(h.ports).execute(command),
    { kind: "failed", reason: "stale" },
  );
  assert.equal(h.calls.publication, 1);
});

test("response loss retries the same idempotent finish request once", async () => {
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
  const h = harness({
    projections: [{ kind: "unavailable" }],
    signals: [
      { kind: "uncertain" },
      {
        kind: "acknowledged",
        state: "resolved",
        eventId: "00000000-0000-4000-8000-000000000999",
        workKey: "ffn:7038840",
        entry: finishedEntry,
        syncVersion: "2026-07-20T09:00:01.000Z",
      },
    ],
  });

  assert.deepEqual(await new FinishQualificationService(h.ports).execute(command), {
    kind: "acknowledged",
    state: "resolved",
    eventId: "00000000-0000-4000-8000-000000000999",
    operationId: finishOperationId,
    workKey: "ffn:7038840",
    entry: finishedEntry,
    syncVersion: "2026-07-20T09:00:01.000Z",
  });
  assert.equal(h.calls.signal, 2);
  assert.equal(h.calls.publication, 1);
  assert.equal(h.calls.projection, 0);
  assert.equal(h.calls.operationIds, 1);
  assert.equal(h.calls.finishOperations[0], h.calls.finishOperations[1]);
  assert.equal(h.calls.finishOperations[0].operationId, finishOperationId);
});

test("projection state never substitutes for a finish acknowledgement", async () => {
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
  const h = harness({
    projections: [{ kind: "value", value: accountData(finishedEntry) }],
    signals: [{ kind: "uncertain" }, { kind: "uncertain" }],
  });

  assert.deepEqual(
    await new FinishQualificationService(h.ports).execute(command),
    { kind: "failed", reason: "unavailable" },
  );
  assert.equal(h.calls.signal, 2);
  assert.equal(h.calls.projection, 0);
});

test("uncertain open observation is not retried", async () => {
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
  const h = harness({
    signals: [{ kind: "uncertain" }],
  });

  assert.deepEqual(
    await new FinishQualificationService(h.ports).execute(command),
    { kind: "failed", reason: "unavailable" },
  );
  assert.equal(h.calls.signal, 1);
  assert.equal(h.calls.projection, 0);
});

test("command-incompatible finish acknowledgements never reach projection publication", async () => {
  const h = harness({
    signals: [{
      kind: "acknowledged",
      state: "resolved",
      eventId: null,
      workKey: "ffn:7038840",
      entry: finishedEntry,
    }],
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

  assert.deepEqual(
    await new FinishQualificationService(h.ports).execute(command),
    { kind: "failed", reason: "invalid_response" },
  );
  assert.equal(h.calls.publication, 0);
});

test("finish acknowledgement waits for account-scoped publication", async () => {
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
  const h = harness({
    signals: [{
      kind: "acknowledged",
      state: "resolved",
      eventId: null,
      workKey: "ffn:7038840",
      entry: finishedEntry,
    }],
  });
  h.ports.projection.publishFinishAcknowledgement = () => new Promise(() => {});

  const result = await Promise.race([
    new FinishQualificationService(h.ports).execute(command),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 25)),
  ]);

  assert.equal(result, "timed_out");
});

test("a failed account-scoped publication cannot escape as a successful acknowledgement", async () => {
  const command = Object.freeze({
    kind: "finish_qualification",
    hostKind: "ffn",
    workKey: "ffn:7038840",
    entryId,
    source: "ffn",
    chapter: 12,
    total: 12,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
  const h = harness({
    signals: [{
      kind: "acknowledged",
      state: "resolved",
      eventId: null,
      workKey: "ffn:7038840",
      entry: finishedEntry,
    }],
  });
  h.ports.projection.publishFinishAcknowledgement = () => {
    throw new Error("projection unavailable");
  };

  assert.deepEqual(await new FinishQualificationService(h.ports).execute(command), {
    kind: "failed",
    reason: "unavailable",
  });
});
