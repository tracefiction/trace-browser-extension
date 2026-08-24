import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  INITIAL_SESSION_MODEL,
  SessionService,
  canSyncSavedFilters,
  parseSessionEnvelope,
  publishNonRegressing,
  readScopedValue,
  reduceSession,
  toSessionSnapshot,
  writeSavedFilterValue,
  writeScopedValue,
} from "../../.trace-build/extension-core/index.mjs";

const ROOT = process.cwd();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

class FakeStorage {
  constructor(value = null) {
    this.value = value;
    this.writes = [];
    this.failReads = 0;
    this.failWrites = 0;
  }

  async read() {
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error("read unavailable");
    }
    return this.value;
  }

  async write(envelope) {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error("write unavailable");
    }
    this.value = { ...envelope };
    this.writes.push(this.value);
  }
}

class FakeCredentials {
  constructor() {
    this.values = new Map();
    this.acquisitions = [];
    this.acquirePurposes = [];
    this.storedCredentials = [];
    this.deletedReferences = [];
    this.cancelCount = 0;
    this.nextReference = 1;
    this.failLoads = 0;
    this.deleteResults = [];
    this.storeResults = [];
    this.storeEpochs = [];
    this.clearAllResults = [];
    this.clearAllCount = 0;
  }

  seed(reference, credential) {
    this.values.set(reference, credential);
  }

  queueAcquisition(value) {
    this.acquisitions.push(value);
  }

  async acquire(purpose) {
    this.acquirePurposes.push(purpose);
    assert.ok(this.acquisitions.length > 0, `unexpected ${purpose} acquisition`);
    return await this.acquisitions.shift();
  }

  cancelAcquisition() {
    this.cancelCount += 1;
  }

  async load(reference) {
    if (this.failLoads > 0) {
      this.failLoads -= 1;
      throw new Error("credential store unavailable");
    }
    return this.values.get(reference) ?? null;
  }

  queueStoreResult(result) {
    this.storeResults.push(result);
  }

  async storeUnique(credential, epoch) {
    this.storeEpochs.push(epoch);
    const reference = this.storeResults.length > 0
      ? await this.storeResults.shift()
      : `credential-${this.nextReference++}`;
    this.values.set(reference, credential);
    this.storedCredentials.push(credential);
    return reference;
  }

  async delete(reference) {
    this.deletedReferences.push(reference);
    if (this.deleteResults.length > 0) await this.deleteResults.shift();
    this.values.delete(reference);
  }

  queueDeleteResult(result) {
    this.deleteResults.push(result);
  }

  async clearAll() {
    this.clearAllCount += 1;
    if (this.clearAllResults.length > 0) await this.clearAllResults.shift();
    this.values.clear();
  }

  queueClearAllResult(result) {
    this.clearAllResults.push(result);
  }
}

class FakeApi {
  constructor() {
    this.verifications = [];
    this.verifiedCredentials = [];
  }

  queueVerification(value) {
    this.verifications.push(value);
  }

  async verifyCredential(credential) {
    this.verifiedCredentials.push(credential);
    assert.ok(this.verifications.length > 0, "unexpected verification");
    return await this.verifications.shift();
  }
}

class FakeDiagnostics {
  constructor() {
    this.events = [];
  }

  record(event) {
    this.events.push(event);
  }
}

function createHarness({ envelope = null } = {}) {
  const storage = new FakeStorage(envelope);
  const credentials = new FakeCredentials();
  const api = new FakeApi();
  const diagnostics = new FakeDiagnostics();
  const service = new SessionService({ storage, credentials, api, diagnostics });
  return { service, storage, credentials, api, diagnostics };
}

async function connectAccount(harness, { accountId = "account-a", token = "token-a" } = {}) {
  harness.credentials.queueAcquisition({ kind: "credential", credential: token });
  harness.api.queueVerification({ kind: "verified", accountId });
  const result = await harness.service.connect();
  assert.deepEqual(result, { kind: "completed", state: "connected" });
  assert.equal(harness.service.snapshot().state, "connected");
}

test("session envelope validation fails closed without trusting labels", () => {
  assert.deepEqual(parseSessionEnvelope(null), { kind: "missing" });
  assert.deepEqual(parseSessionEnvelope("connected"), {
    kind: "invalid",
    reason: "malformed_envelope",
  });
  assert.deepEqual(
    parseSessionEnvelope({
      version: 2,
      epoch: 4,
      desired: "connected",
      accountId: "account-a",
      credentialRef: "credential-a",
    }),
    { kind: "invalid", reason: "unsupported_envelope" },
  );
  assert.deepEqual(
    parseSessionEnvelope({
      version: 1,
      epoch: 4,
      desired: "disconnected",
      accountId: "account-a",
      credentialRef: null,
    }),
    { kind: "invalid", reason: "malformed_envelope" },
  );

  const connectedWithoutCredential = parseSessionEnvelope({
    version: 1,
    epoch: 4,
    desired: "connected",
    accountId: "account-a",
    credentialRef: null,
  });
  assert.equal(connectedWithoutCredential.kind, "valid");
});

test("pure reducer derives every public state and keeps execution root connected-only", () => {
  const scope = { accountId: "account-a", epoch: 7 };
  const cases = [
    [{ type: "signed_out", epoch: 7 }, "signed_out", null, null],
    [{ type: "connecting", epoch: 7 }, "connecting", null, null],
    [{ type: "verifying", epoch: 7, accountId: "account-a" }, "verifying", null, null],
    [{ type: "connected", scope }, "connected", scope, scope],
    [
      {
        type: "degraded",
        epoch: 7,
        displayScope: scope,
        reason: "verification_unavailable",
      },
      "degraded",
      null,
      scope,
    ],
    [
      { type: "reconnect_required", epoch: 7, reason: "credential_rejected" },
      "reconnect_required",
      null,
      null,
    ],
  ];

  for (const [event, state, publicationScope, displayScope] of cases) {
    const model = reduceSession(INITIAL_SESSION_MODEL, event);
    assert.equal(model.state, state);
    assert.deepEqual(model.publicationScope, publicationScope);
    assert.deepEqual(model.displayScope, displayScope);
    assert.equal(
      toSessionSnapshot(model).canExecuteAuthenticated,
      state === "connected",
    );
  }
});

test("account-scoped values reject wrong account, wrong epoch, and degraded writes", () => {
  const accountA1 = { accountId: "account-a", epoch: 1 };
  const accountA2 = { accountId: "account-a", epoch: 2 };
  const accountB1 = { accountId: "account-b", epoch: 1 };
  const accepted = writeScopedValue(accountA1, accountA1, { chapter: 3 });
  assert.equal(accepted.kind, "accepted");
  assert.equal(Object.isFrozen(accepted.entry.scope), true);
  assert.notEqual(accepted.entry.scope, accountA1);
  assert.deepEqual(readScopedValue(accepted.entry, accountA1), { chapter: 3 });
  assert.equal(readScopedValue(accepted.entry, accountA2), null);
  assert.equal(readScopedValue(accepted.entry, accountB1), null);
  assert.deepEqual(writeScopedValue(null, accountA1, "degraded write"), {
    kind: "rejected_scope",
  });
  assert.deepEqual(writeScopedValue(accountA2, accountA1, "stale epoch"), {
    kind: "rejected_scope",
  });

  const degradedSavedFilter = writeSavedFilterValue(
    accountA1,
    accountA1,
    { id: "preset-1" },
  );
  assert.equal(degradedSavedFilter.kind, "accepted");
  assert.deepEqual(writeSavedFilterValue(accountA2, accountA1, { id: "stale" }), {
    kind: "rejected_scope",
  });
  assert.equal(canSyncSavedFilters(null, accountA1), false);
  assert.equal(canSyncSavedFilters(accountA2, accountA1), false);
  assert.equal(canSyncSavedFilters(accountA1, accountA1), true);
});

test("server-version policy prevents an older query from replacing a newer command", () => {
  const command = { serverVersion: 11, value: { chapter: 12 } };
  const staleQuery = { serverVersion: 10, value: { chapter: 9 } };
  const stale = publishNonRegressing(command, staleQuery);
  assert.equal(stale.kind, "discarded_stale");
  assert.deepEqual(stale.current, command);
  assert.equal(Object.isFrozen(stale.current), true);

  const newerQuery = { serverVersion: 12, value: { chapter: 13 } };
  assert.deepEqual(publishNonRegressing(command, newerQuery), {
    kind: "published",
    current: newerQuery,
  });
  assert.throws(
    () => publishNonRegressing(null, { serverVersion: -1, value: null }),
    /serverVersion/,
  );
});

test("fresh install stays signed out until Connect verifies and publishes", async () => {
  const harness = createHarness();
  assert.equal((await harness.service.start()).state, "signed_out");
  await connectAccount(harness);

  assert.deepEqual(harness.storage.writes.map(({ desired, accountId }) => ({ desired, accountId })), [
    { desired: "disconnected", accountId: null },
    { desired: "connected", accountId: null },
    { desired: "connected", accountId: "account-a" },
  ]);
  assert.deepEqual(harness.service.publicationScope(), {
    accountId: "account-a",
    epoch: 1,
  });
  const exposedScope = harness.service.publicationScope();
  assert.equal(Object.isFrozen(exposedScope), true);
  assert.throws(() => {
    exposedScope.accountId = "account-b";
  }, TypeError);
  assert.deepEqual(harness.service.publicationScope(), {
    accountId: "account-a",
    epoch: 1,
  });
  const execution = await harness.service.executeAuthenticated(async (credential) => ({
    kind: "success",
    value: credential === "token-a" ? "server-result" : "wrong-token",
  }));
  assert.deepEqual(execution, { kind: "published", value: "server-result" });
  assert.equal(JSON.stringify(harness.service.snapshot()).includes("token-a"), false);
});

test("repeated start signals verify once and always return the current snapshot", async () => {
  const envelope = {
    version: 1,
    epoch: 8,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  };
  const harness = createHarness({ envelope });
  harness.credentials.seed("credential-a", "token-a");
  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });

  const [first, duplicate] = await Promise.all([
    harness.service.start(),
    harness.service.start(),
  ]);
  assert.equal(first.state, "connected");
  assert.equal(duplicate.state, "connected");
  assert.deepEqual(harness.api.verifiedCredentials, ["token-a"]);

  assert.deepEqual(await harness.service.disconnect(), {
    kind: "completed",
    state: "signed_out",
  });
  assert.equal((await harness.service.start()).state, "signed_out");
  assert.deepEqual(harness.api.verifiedCredentials, ["token-a"]);
});

test("Connect cancellation persists a higher epoch before late acquisition resolves", async () => {
  const harness = createHarness();
  await harness.service.start();
  const acquisition = deferred();
  harness.credentials.queueAcquisition(acquisition.promise);
  const connecting = harness.service.connect();
  await waitFor(() => harness.service.snapshot().state === "connecting", "connecting state");

  assert.deepEqual(await harness.service.cancelConnect(), {
    kind: "completed",
    state: "signed_out",
  });
  assert.equal(harness.storage.value.epoch, 2);
  assert.equal(harness.storage.value.desired, "disconnected");

  acquisition.resolve({ kind: "credential", credential: "late-token" });
  assert.deepEqual(await connecting, { kind: "stale" });
  assert.equal(harness.credentials.storedCredentials.length, 0);
  assert.equal(harness.service.snapshot().state, "signed_out");
});

test("Disconnect makes delayed verification inert", async () => {
  const harness = createHarness();
  await harness.service.start();
  const verification = deferred();
  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-a" });
  harness.api.queueVerification(verification.promise);
  const connecting = harness.service.connect();
  await waitFor(() => harness.service.snapshot().state === "verifying", "verification state");

  assert.deepEqual(await harness.service.disconnect(), {
    kind: "completed",
    state: "signed_out",
  });
  verification.resolve({ kind: "verified", accountId: "account-a" });
  assert.deepEqual(await connecting, { kind: "stale" });
  assert.equal(harness.storage.value.desired, "disconnected");
  assert.equal(harness.storage.value.epoch, 2);
  assert.equal(harness.service.publicationScope(), null);
});

test("Connect cancellation also fences delayed verification", async () => {
  const harness = createHarness();
  await harness.service.start();
  const verification = deferred();
  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-a" });
  harness.api.queueVerification(verification.promise);
  const connecting = harness.service.connect();
  await waitFor(() => harness.service.snapshot().state === "verifying", "verification state");

  assert.deepEqual(await harness.service.cancelConnect(), {
    kind: "completed",
    state: "signed_out",
  });
  verification.resolve({ kind: "verified", accountId: "account-a" });
  assert.deepEqual(await connecting, { kind: "stale" });
  assert.equal(harness.storage.value.desired, "disconnected");
  assert.equal(harness.storage.value.epoch, 2);
  assert.equal(harness.service.publicationScope(), null);
});

test("Disconnect completes and releases the lock while credential cleanup is stuck", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const cleanup = deferred();
  harness.credentials.queueClearAllResult(cleanup.promise);

  assert.deepEqual(await harness.service.disconnect(), {
    kind: "completed",
    state: "signed_out",
  });
  assert.equal(harness.storage.value.desired, "disconnected");
  assert.equal(harness.credentials.clearAllCount, 1);

  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-new" });
  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });
  const reconnecting = harness.service.connect();
  cleanup.resolve();
  assert.deepEqual(await reconnecting, {
    kind: "completed",
    state: "connected",
  });
});

test("Disconnect clears orphan credentials even when the envelope has no reference", async () => {
  const harness = createHarness();
  harness.credentials.seed("orphan", "orphan-token");
  await harness.service.start();

  assert.deepEqual(await harness.service.disconnect(), {
    kind: "completed",
    state: "signed_out",
  });
  assert.equal(harness.credentials.clearAllCount, 1);
  assert.equal(harness.credentials.values.size, 0);
});

test("online restart re-verifies while offline restart is read-only degraded", async () => {
  const envelope = {
    version: 1,
    epoch: 8,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  };
  const online = createHarness({ envelope });
  online.credentials.seed("credential-a", "token-a");
  online.api.queueVerification({ kind: "verified", accountId: "account-a" });
  assert.equal((await online.service.start()).state, "connected");

  const offline = createHarness({ envelope });
  offline.credentials.seed("credential-a", "token-a");
  offline.api.queueVerification({ kind: "unavailable" });
  assert.equal((await offline.service.start()).state, "degraded");
  assert.equal(offline.service.publicationScope(), null);
  assert.deepEqual(offline.service.displayScope(), {
    accountId: "account-a",
    epoch: 8,
  });
  assert.deepEqual(
    await offline.service.executeAuthenticated(async () => ({ kind: "success", value: true })),
    { kind: "unavailable" },
  );

  offline.api.queueVerification({ kind: "verified", accountId: "account-a" });
  assert.deepEqual(await offline.service.retry(), { kind: "completed", state: "connected" });
  assert.equal(offline.service.snapshot().state, "connected");
});

test("temporary storage read failure stays degraded until Retry rereads the envelope", async () => {
  const envelope = {
    version: 1,
    epoch: 6,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  };
  const harness = createHarness({ envelope });
  harness.storage.failReads = 1;
  harness.credentials.seed("credential-a", "token-a");
  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });

  assert.equal((await harness.service.start()).state, "degraded");
  assert.deepEqual(await harness.service.retry(), { kind: "completed", state: "connected" });
  assert.equal(harness.service.snapshot().state, "connected");
  assert.deepEqual(harness.service.publicationScope(), {
    accountId: "account-a",
    epoch: 6,
  });
});

test("temporary credential-store read failure degrades without deleting the reference", async () => {
  const envelope = {
    version: 1,
    epoch: 6,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  };
  const harness = createHarness({ envelope });
  harness.credentials.seed("credential-a", "token-a");
  harness.credentials.failLoads = 1;

  assert.equal((await harness.service.start()).state, "degraded");
  assert.equal(harness.storage.value.credentialRef, "credential-a");
  assert.equal(harness.credentials.values.has("credential-a"), true);

  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });
  assert.deepEqual(await harness.service.retry(), {
    kind: "completed",
    state: "connected",
  });
});

test("a fenced late store cannot delete the next Connect credential", async () => {
  const harness = createHarness();
  await harness.service.start();
  const lateStore = deferred();
  harness.credentials.queueStoreResult(lateStore.promise);
  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-old" });
  const firstConnect = harness.service.connect();
  await waitFor(
    () => harness.credentials.storeEpochs.length === 1,
    "first credential store",
  );

  assert.deepEqual(await harness.service.disconnect(), {
    kind: "completed",
    state: "signed_out",
  });
  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-new" });
  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });
  assert.deepEqual(await harness.service.connect(), {
    kind: "completed",
    state: "connected",
  });
  const currentReference = harness.storage.value.credentialRef;

  lateStore.resolve("credential-late");
  assert.deepEqual(await firstConnect, { kind: "stale" });
  assert.equal(harness.credentials.values.has("credential-late"), false);
  assert.equal(harness.credentials.values.get(currentReference), "token-new");
  assert.deepEqual(harness.credentials.storeEpochs, [1, 3]);
});

test("malformed storage and a different verified identity fail closed", async () => {
  const malformed = createHarness({ envelope: { version: 99, desired: "connected" } });
  assert.deepEqual(await malformed.service.start(), {
    state: "reconnect_required",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "unsupported_envelope",
  });
  assert.equal(malformed.api.verifiedCredentials.length, 0);

  const conflict = createHarness({
    envelope: {
      version: 1,
      epoch: 3,
      desired: "connected",
      accountId: "account-a",
      credentialRef: "credential-a",
    },
  });
  conflict.credentials.seed("credential-a", "token-b");
  conflict.api.queueVerification({ kind: "verified", accountId: "account-b" });
  assert.equal((await conflict.service.start()).state, "reconnect_required");
  assert.equal(conflict.storage.value.credentialRef, null);
  assert.equal(conflict.service.publicationScope(), null);
  assert.deepEqual(conflict.credentials.deletedReferences, ["credential-a"]);
});

test("a never-verified Connect candidate is cleared instead of entering refresh", async () => {
  const harness = createHarness();
  await harness.service.start();
  harness.credentials.queueAcquisition({ kind: "credential", credential: "bad-token" });
  harness.api.queueVerification({ kind: "rejected" });

  assert.deepEqual(await harness.service.connect(), {
    kind: "completed",
    state: "reconnect_required",
  });
  assert.equal(harness.service.snapshot().state, "reconnect_required");
  assert.equal(harness.service.snapshot().reason, "credential_rejected");
  assert.equal(harness.storage.value.credentialRef, null);
  assert.deepEqual(harness.credentials.acquirePurposes, ["connect"]);
});

test("malformed verified identity cannot publish connected", async () => {
  const harness = createHarness();
  await harness.service.start();
  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-a" });
  harness.api.queueVerification({ kind: "verified", accountId: "" });

  assert.deepEqual(await harness.service.connect(), {
    kind: "completed",
    state: "reconnect_required",
  });
  assert.equal(harness.service.snapshot().reason, "invalid_account_response");
  assert.equal(harness.service.publicationScope(), null);
  assert.equal(harness.storage.value.credentialRef, null);
});

test("malformed port results fail closed instead of escaping the kernel", async () => {
  const malformedAcquisition = createHarness();
  await malformedAcquisition.service.start();
  malformedAcquisition.credentials.queueAcquisition(null);
  assert.deepEqual(await malformedAcquisition.service.connect(), {
    kind: "unavailable",
  });
  assert.equal(malformedAcquisition.service.snapshot().state, "signed_out");

  const malformedVerification = createHarness();
  await malformedVerification.service.start();
  malformedVerification.credentials.queueAcquisition({
    kind: "credential",
    credential: "token-a",
  });
  malformedVerification.api.queueVerification(null);
  assert.deepEqual(await malformedVerification.service.connect(), {
    kind: "completed",
    state: "reconnect_required",
  });
  assert.equal(malformedVerification.service.snapshot().reason, "invalid_account_response");

  const malformedEffect = createHarness();
  await malformedEffect.service.start();
  await connectAccount(malformedEffect);
  assert.deepEqual(
    await malformedEffect.service.executeAuthenticated(async () => null),
    { kind: "unavailable" },
  );
  assert.equal(malformedEffect.service.snapshot().state, "degraded");
});

test("same-account refresh replaces capability and fences its late result", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness, { token: "token-old" });

  const oldEffect = deferred();
  const execution = harness.service.executeAuthenticated(async () => oldEffect.promise);
  await Promise.resolve();

  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-new" });
  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });
  assert.deepEqual(await harness.service.refreshForExpiry(), {
    kind: "completed",
    state: "connected",
  });
  assert.equal(harness.storage.value.epoch, 1);

  oldEffect.resolve({ kind: "success", value: "stale-result" });
  assert.deepEqual(await execution, { kind: "stale" });
  assert.deepEqual(harness.credentials.deletedReferences, ["credential-1"]);

  const current = await harness.service.executeAuthenticated(async (credential) => ({
    kind: "success",
    value: credential,
  }));
  assert.deepEqual(current, { kind: "published", value: "token-new" });
});

test("provider synchronization is a no-op for the current native credential", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const writesBefore = harness.storage.writes.length;

  harness.credentials.queueAcquisition({
    kind: "credential",
    credential: "token-a",
  });
  assert.deepEqual(await harness.service.synchronizeProviderCredential(), {
    kind: "completed",
    state: "connected",
  });

  assert.equal(harness.storage.writes.length, writesBefore);
  assert.equal(harness.storage.value.epoch, 1);
  assert.deepEqual(harness.api.verifiedCredentials, ["token-a"]);
  assert.deepEqual(harness.credentials.acquirePurposes, ["connect", "refresh"]);
});

test("provider synchronization rotates a same-account credential without changing scope", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness, { token: "token-old" });
  const scopeBefore = harness.service.publicationScope();

  harness.credentials.queueAcquisition({
    kind: "credential",
    credential: "token-new",
  });
  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });
  assert.deepEqual(await harness.service.synchronizeProviderCredential(), {
    kind: "completed",
    state: "connected",
  });

  assert.deepEqual(harness.service.publicationScope(), scopeBefore);
  assert.equal(harness.storage.value.epoch, 1);
  assert.deepEqual(harness.credentials.deletedReferences, ["credential-1"]);
  assert.deepEqual(
    await harness.service.executeAuthenticated(async (credential) => ({
      kind: "success",
      value: credential,
    })),
    { kind: "published", value: "token-new" },
  );
});

test("provider synchronization retains a verified session when the provider is temporarily unavailable", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const envelopeBefore = { ...harness.storage.value };

  harness.credentials.queueAcquisition({ kind: "unavailable" });
  assert.deepEqual(await harness.service.synchronizeProviderCredential(), {
    kind: "unavailable",
  });

  assert.equal(harness.service.snapshot().state, "connected");
  assert.deepEqual(harness.storage.value, envelopeBefore);
  assert.deepEqual(
    await harness.service.executeAuthenticated(async (credential) => ({
      kind: "success",
      value: credential,
    })),
    { kind: "published", value: "token-a" },
  );
});

test("concurrent provider synchronization shares one native acquisition", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const acquisition = deferred();
  harness.credentials.queueAcquisition(acquisition.promise);

  const first = harness.service.synchronizeProviderCredential();
  const second = harness.service.synchronizeProviderCredential();
  assert.equal(first, second);
  await waitFor(
    () => harness.credentials.acquirePurposes.length === 2,
    "provider refresh acquisition",
  );
  acquisition.resolve({ kind: "credential", credential: "token-a" });

  assert.deepEqual(await first, { kind: "completed", state: "connected" });
  assert.deepEqual(await second, { kind: "completed", state: "connected" });
  assert.deepEqual(harness.credentials.acquirePurposes, ["connect", "refresh"]);
});

test("provider synchronization fences a genuine account change", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);

  harness.credentials.queueAcquisition({
    kind: "credential",
    credential: "token-b",
  });
  harness.api.queueVerification({ kind: "verified", accountId: "account-b" });

  assert.deepEqual(await harness.service.synchronizeProviderCredential(), {
    kind: "completed",
    state: "connected",
  });
  assert.deepEqual(harness.service.publicationScope(), {
    accountId: "account-b",
    epoch: 2,
  });
  assert.deepEqual(harness.credentials.acquirePurposes, [
    "connect",
    "refresh",
  ]);
});

test("failed account-switch credential storage leaves a durable signed-out fence", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const store = deferred();
  harness.credentials.queueStoreResult(store.promise);
  harness.credentials.queueAcquisition({
    kind: "credential",
    credential: "token-b",
  });
  harness.api.queueVerification({ kind: "verified", accountId: "account-b" });

  const synchronization = harness.service.synchronizeProviderCredential();
  await waitFor(
    () => harness.credentials.storeEpochs.includes(2),
    "account-switch credential store",
  );
  store.reject(new Error("credential store unavailable"));

  assert.deepEqual(await synchronization, { kind: "unavailable" });
  assert.equal(harness.service.snapshot().state, "signed_out");
  assert.deepEqual(harness.storage.value, {
    version: 1,
    epoch: 2,
    desired: "disconnected",
    accountId: null,
    credentialRef: null,
  });
  assert.deepEqual(
    await harness.service.executeAuthenticated(async () => ({
      kind: "success",
      value: "must-not-run",
    })),
    { kind: "unavailable" },
  );
  await waitFor(
    () => harness.credentials.deletedReferences.includes("credential-1"),
    "old provider credential cleanup",
  );
});

test("provider synchronization treats a definitively absent native account as disconnect", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  harness.credentials.queueAcquisition({ kind: "absent" });

  assert.deepEqual(await harness.service.synchronizeProviderCredential(), {
    kind: "completed",
    state: "signed_out",
  });
  assert.equal(harness.service.publicationScope(), null);
  assert.equal(harness.storage.value.desired, "disconnected");
});

test("degradation revokes a capability before another same-capability result publishes", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const unavailable = deferred();
  const lateSuccess = deferred();
  const first = harness.service.executeAuthenticated(async () => unavailable.promise);
  const second = harness.service.executeAuthenticated(async () => lateSuccess.promise);
  await Promise.resolve();

  unavailable.resolve({ kind: "unavailable" });
  assert.deepEqual(await first, { kind: "unavailable" });
  assert.equal(harness.service.snapshot().state, "degraded");

  lateSuccess.resolve({ kind: "success", value: "stale" });
  assert.deepEqual(await second, { kind: "stale" });
  assert.equal(harness.service.publicationScope(), null);
});

test("one post-rejection refresh recovers and duplicate old-capability rejection is stale", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness, { token: "token-old" });
  const first = deferred();
  const second = deferred();
  const firstExecution = harness.service.executeAuthenticated(async () => first.promise);
  const secondExecution = harness.service.executeAuthenticated(async () => second.promise);
  await Promise.resolve();

  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-new" });
  harness.api.queueVerification({ kind: "verified", accountId: "account-a" });
  first.resolve({ kind: "auth_rejected" });
  assert.deepEqual(await firstExecution, {
    kind: "auth_rejected",
    recovery: "connected",
  });

  second.resolve({ kind: "auth_rejected" });
  assert.deepEqual(await secondExecution, {
    kind: "auth_rejected",
    recovery: "stale",
  });
  assert.deepEqual(harness.credentials.acquirePurposes, ["connect", "refresh"]);
  assert.equal(harness.service.snapshot().state, "connected");
});

test("different-account refresh cannot switch the root", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  harness.credentials.queueAcquisition({ kind: "credential", credential: "token-b" });
  harness.api.queueVerification({ kind: "verified", accountId: "account-b" });

  assert.deepEqual(await harness.service.refreshForExpiry(), {
    kind: "completed",
    state: "reconnect_required",
  });
  assert.equal(harness.service.snapshot().reason, "identity_conflict");
  assert.equal(harness.service.publicationScope(), null);
  assert.equal(harness.storage.value.accountId, "account-a");
  assert.equal(harness.storage.value.credentialRef, null);
});

test("proactive provider unavailability degrades without discarding the current reference", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const reference = harness.storage.value.credentialRef;

  harness.credentials.queueAcquisition({ kind: "unavailable" });
  assert.deepEqual(await harness.service.refreshForExpiry(), { kind: "unavailable" });
  assert.equal(harness.service.snapshot().state, "degraded");
  assert.equal(harness.storage.value.credentialRef, reference);
  assert.deepEqual(harness.service.displayScope(), { accountId: "account-a", epoch: 1 });
});

test("post-rejection refresh failure clears the token and cannot loop after restart", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  harness.credentials.queueAcquisition({ kind: "absent" });

  const rejected = await harness.service.executeAuthenticated(async () => ({
    kind: "auth_rejected",
  }));
  assert.deepEqual(rejected, {
    kind: "auth_rejected",
    recovery: "reconnect_required",
  });
  assert.equal(harness.storage.value.desired, "connected");
  assert.equal(harness.storage.value.credentialRef, null);
  assert.equal(harness.service.snapshot().state, "reconnect_required");

  const restarted = createHarness({ envelope: harness.storage.value });
  assert.equal((await restarted.service.start()).state, "reconnect_required");
  assert.equal(restarted.api.verifiedCredentials.length, 0);
  assert.equal(restarted.credentials.acquirePurposes.length, 0);
});

test("post-rejection clear-write failure deletes the credential and converges on restart", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const rejectedReference = harness.storage.value.credentialRef;
  harness.credentials.queueAcquisition({ kind: "absent" });
  harness.storage.failWrites = 1;

  assert.deepEqual(
    await harness.service.executeAuthenticated(async () => ({ kind: "auth_rejected" })),
    { kind: "auth_rejected", recovery: "reconnect_required" },
  );
  assert.equal(harness.storage.value.credentialRef, rejectedReference);
  assert.equal(harness.credentials.values.has(rejectedReference), false);

  const restartedApi = new FakeApi();
  const restarted = new SessionService({
    storage: harness.storage,
    credentials: harness.credentials,
    api: restartedApi,
    diagnostics: new FakeDiagnostics(),
  });
  assert.equal((await restarted.start()).state, "reconnect_required");
  assert.equal(harness.storage.value.credentialRef, null);
  assert.equal(restartedApi.verifiedCredentials.length, 0);
  assert.deepEqual(harness.credentials.acquirePurposes, ["connect", "refresh"]);
});

test("failed Disconnect write keeps the current worker fenced from a late capability", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const effect = deferred();
  const execution = harness.service.executeAuthenticated(async () => effect.promise);
  await Promise.resolve();

  harness.storage.failWrites = 1;
  assert.deepEqual(await harness.service.disconnect(), { kind: "storage_error" });
  assert.equal(harness.service.snapshot().state, "reconnect_required");
  assert.equal(harness.service.snapshot().reason, "storage_write_failed");
  assert.equal(harness.storage.value.epoch, 1, "durable envelope was not falsely advanced");
  assert.deepEqual(
    harness.credentials.deletedReferences,
    ["credential-1"],
    "failed persistence still attempts credential cleanup",
  );

  effect.resolve({ kind: "success", value: "late" });
  assert.deepEqual(await execution, { kind: "stale" });
  assert.equal(harness.service.publicationScope(), null);
});

test("failed Disconnect waits for credential deletion because it is the restart fence", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness);
  const cleanup = deferred();
  harness.credentials.queueDeleteResult(cleanup.promise);
  harness.storage.failWrites = 1;

  let settled = false;
  const disconnect = harness.service.disconnect().then((result) => {
    settled = true;
    return result;
  });
  await waitFor(
    () => harness.credentials.deletedReferences.length === 1,
    "failed-Disconnect credential cleanup",
  );
  assert.equal(settled, false);
  assert.equal(harness.credentials.values.has("credential-1"), true);

  cleanup.resolve();
  assert.deepEqual(await disconnect, { kind: "storage_error" });
  assert.equal(harness.credentials.values.has("credential-1"), false);
  assert.equal(harness.storage.value.credentialRef, "credential-1");
});

test("diagnostics expose stable reason codes without credentials or account payloads", async () => {
  const harness = createHarness();
  await harness.service.start();
  await connectAccount(harness, { accountId: "private-account", token: "secret-token" });
  const serialized = JSON.stringify(harness.diagnostics.events);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("private-account"), false);
  for (const event of harness.diagnostics.events) {
    assert.deepEqual(Object.keys(event).sort(), ["code", "epoch", "state"]);
  }
});

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
    })
    .sort();
}

function hashDirectory(directory) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(directory)) {
    hash.update(path.relative(directory, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

test("core graph is browser-neutral, deterministic, and bundled only into the kernel owner", () => {
  const sourceDirectory = path.join(ROOT, "src", "extension-core");
  for (const file of listFiles(sourceDirectory)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.match(match[1], /^\.\//, `${path.relative(ROOT, file)} has external import`);
    }
    assert.doesNotMatch(
      source,
      /\b(?:chrome|browser|document|window|fetch|XMLHttpRequest|webkit|sendNativeMessage)\b/,
      `${path.relative(ROOT, file)} imports a runtime boundary`,
    );
  }

  const productionRoots = [
    path.join(ROOT, "src"),
    path.join(ROOT, "Shared (Extension)", "Resources"),
  ];
  const runtimeSourceDirectory = path.join(ROOT, "src", "extension-runtime");
  const generatedBackground = path.join(
    ROOT,
    "Shared (Extension)",
    "Resources",
    "background.js",
  );
  const popupConfig = fs.readFileSync(
    path.join(ROOT, "Shared (Extension)", "Resources", "popup-config.js"),
    "utf8",
  );
  const packagedMode =
    popupConfig.match(/globalThis\.TRACE_SESSION_MODE = "(kernel|disabled)"/)?.[1] ??
    "legacy";
  for (const productionFile of productionRoots.flatMap(listFiles)) {
    if (productionFile.startsWith(`${sourceDirectory}${path.sep}`)) continue;
    if (productionFile.startsWith(`${runtimeSourceDirectory}${path.sep}`)) continue;
    if (!/\.(?:css|html|js|json|mjs|swift)$/.test(productionFile)) continue;
    const source = fs.readFileSync(productionFile, "utf8");
    if (productionFile === generatedBackground && packagedMode !== "legacy") {
      assert.match(source, /src\/extension-core\//);
      assert.match(source, /src\/extension-runtime\//);
      assert.doesNotMatch(source, /\.trace-build/);
      continue;
    }
    assert.doesNotMatch(
      source,
      /(?:extension-core|\.trace-build)/,
      `${path.relative(ROOT, productionFile)} reaches the TypeScript source graph`,
    );
  }
  assert.equal(
    fs.existsSync(path.join(ROOT, "Shared (Extension)", "Resources", "extension-core")),
    false,
  );

  const output = path.join(ROOT, ".trace-build", "extension-core");
  const before = hashDirectory(output);
  const build = spawnSync(process.execPath, ["scripts/build-extension-core.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.equal(hashDirectory(output), before);
});
