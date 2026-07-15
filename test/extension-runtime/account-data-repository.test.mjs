import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  AccountDataRepository,
} from "../../.trace-build/extension-runtime/account-data-repository.mjs";
import {
  BrowserPrivateRecordDatabase,
  PRIVATE_RECORD_KEYS,
} from "../../.trace-build/extension-runtime/private-database.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness() {
  const database = new BrowserPrivateRecordDatabase(new IDBFactory());
  const state = { display: null, publication: null };
  const repository = new AccountDataRepository(database, {
    displayScope: () => state.display,
    publicationScope: () => state.publication,
  });
  return { database, repository, state };
}

const accountA1 = Object.freeze({ accountId: "account-a", epoch: 1 });
const accountA2 = Object.freeze({ accountId: "account-a", epoch: 2 });
const accountB1 = Object.freeze({ accountId: "account-b", epoch: 1 });

const summary = Object.freeze({
  pro: false,
  libraryCount: 3,
  firstStoryCompleted: true,
});

function overlay(syncVersion = "2026-07-15T12:00:00.000Z") {
  return {
    entries: { "ao3:123": { status: "READING" } },
    workPreferences: {},
    syncVersion,
  };
}

test("repository creates and reads only the exact display/publication scope", async () => {
  const { repository, state } = createHarness();
  state.publication = accountA1;
  state.display = accountA1;
  assert.equal((await repository.ensureScope(accountA1)).kind, "published");
  assert.deepEqual(await repository.read(), {
    version: 1,
    scope: accountA1,
    summary: null,
    overlay: null,
  });

  state.display = accountA2;
  assert.equal(await repository.read(), null);
  state.display = accountB1;
  assert.equal(await repository.read(), null);
  state.display = null;
  assert.equal(await repository.read(), null);
});

test("repository rejects degraded and stale publication without a durable write", async () => {
  const { database, repository, state } = createHarness();
  state.display = accountA1;
  assert.deepEqual(await repository.publishSummary(accountA1, summary), {
    kind: "rejected_scope",
  });
  state.publication = accountA2;
  assert.deepEqual(await repository.publishSummary(accountA1, summary), {
    kind: "rejected_scope",
  });
  assert.equal(await database.get(PRIVATE_RECORD_KEYS.accountData), null);
});

test("serial authoritative overlay replaces a higher opaque timestamp", async () => {
  const { repository, state } = createHarness();
  state.display = accountA1;
  state.publication = accountA1;
  await repository.publishSummary(accountA1, summary);
  await repository.publishOverlay(accountA1, overlay("2026-07-15T12:00:00.000Z"));
  const lower = {
    entries: {},
    workPreferences: {},
    syncVersion: "2026-07-14T12:00:00.000Z",
  };
  assert.equal((await repository.publishOverlay(accountA1, lower)).kind, "published");
  assert.deepEqual((await repository.read()).overlay, lower);
  assert.deepEqual((await repository.read()).summary, summary);
});

test("malformed stored data is unreadable and cleared best effort", async () => {
  const { database, repository, state } = createHarness();
  state.display = accountA1;
  await database.put(PRIVATE_RECORD_KEYS.accountData, {
    version: 1,
    scope: accountA1,
    summary: { pro: "yes" },
    overlay: null,
  });
  assert.equal(await repository.read(), null);
  assert.equal(await database.get(PRIVATE_RECORD_KEYS.accountData), null);
});

test("queued Disconnect clear completes before an immediate reconnect publication", async () => {
  const underlying = new BrowserPrivateRecordDatabase(new IDBFactory());
  const deletion = deferred();
  const database = {
    get: (key) => underlying.get(key),
    put: (key, value) => underlying.put(key, value),
    async delete(key) {
      if (key === PRIVATE_RECORD_KEYS.accountData) await deletion.promise;
      await underlying.delete(key);
    },
    deleteDatabase: () => underlying.deleteDatabase(),
  };
  const state = { display: accountA1, publication: accountA1 };
  const repository = new AccountDataRepository(database, {
    displayScope: () => state.display,
    publicationScope: () => state.publication,
  });
  await repository.publishSummary(accountA1, summary);

  state.display = null;
  state.publication = null;
  const clearing = repository.clear();
  state.display = accountA2;
  state.publication = accountA2;
  const reconnecting = repository.publishSummary(accountA2, {
    ...summary,
    libraryCount: 9,
  });
  let reconnected = false;
  void reconnecting.then(() => { reconnected = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconnected, false);

  deletion.resolve();
  await clearing;
  await reconnecting;
  assert.deepEqual((await repository.read()).scope, accountA2);
  assert.equal((await repository.read()).summary.libraryCount, 9);
});
