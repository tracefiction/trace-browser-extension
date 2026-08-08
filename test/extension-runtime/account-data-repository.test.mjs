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
    capacityRecovery: null,
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

test("confirmed story publication patches only the current account overlay", async () => {
  const { repository, state } = createHarness();
  state.display = accountA1;
  state.publication = accountA1;
  await repository.publishOverlay(accountA1, {
    entries: { "ao3:123": { status: "READING" } },
    workPreferences: {
      "ffn:999": { browsePreference: { hidden: true } },
    },
    syncVersion: "2026-07-15T12:00:00.000Z",
  });
  const entryId = "00000000-0000-4000-8000-000000000123";
  const result = await repository.publishConfirmedStory(accountA1, {
    workKey: "ffn:7038840",
    entryId,
    entry: {
      status: "PLANNING",
      readerStatus: "PLANNING",
      canonicalReaderStatus: "SAVED",
      entryId,
    },
    syncVersion: "2026-07-19T12:00:00.000Z",
  });
  assert.equal(result.kind, "published");
  assert.deepEqual((await repository.read()).overlay, {
    entries: {
      "ao3:123": { status: "READING" },
      "ffn:7038840": {
        status: "PLANNING",
        readerStatus: "PLANNING",
        canonicalReaderStatus: "SAVED",
        entryId,
      },
    },
    workPreferences: {
      "ffn:999": { browsePreference: { hidden: true } },
    },
    syncVersion: "2026-07-19T12:00:00.000Z",
  });
});

test("capacity recovery is account scoped, snoozed, and reset by room or entitlement", async () => {
  const { repository, state } = createHarness();
  state.display = accountA1;
  state.publication = accountA1;
  await repository.publishSummary(accountA1, {
    ...summary,
    libraryCount: 100,
  });

  const blocked = await repository.publishCapacityBlocked(accountA1, 1_000);
  assert.equal(blocked.kind, "published");
  assert.deepEqual(blocked.value.capacityRecovery, {
    blockedAt: 1_000,
    blockedLibraryCount: 100,
    nextPromptAt: 0,
  });

  await repository.acknowledgeCapacityRecovery(accountA1, "shown", 2_000);
  const afterShown = (await repository.read()).capacityRecovery;
  assert.equal(afterShown.nextPromptAt, 2_000 + (24 * 60 * 60 * 1_000));

  await repository.acknowledgeCapacityRecovery(accountA1, "dismissed", 3_000);
  const afterDismissal = (await repository.read()).capacityRecovery;
  assert.equal(afterDismissal.nextPromptAt, 3_000 + (7 * 24 * 60 * 60 * 1_000));

  await repository.publishCapacityBlocked(accountA1, 4_000);
  assert.deepEqual((await repository.read()).capacityRecovery, afterDismissal);

  await repository.publishSummary(accountA1, {
    ...summary,
    libraryCount: 99,
  });
  assert.equal((await repository.read()).capacityRecovery, null);

  await repository.publishSummary(accountA1, {
    ...summary,
    libraryCount: 100,
  });
  await repository.publishCapacityBlocked(accountA1, 5_000);
  await repository.publishSummary(accountA1, {
    ...summary,
    pro: true,
    libraryCount: 100,
  });
  assert.equal((await repository.read()).capacityRecovery, null);
});

test("a late full refresh cannot erase a newer command confirmation", async () => {
  const { repository, state } = createHarness();
  state.display = accountA1;
  state.publication = accountA1;
  const refreshReservation = repository.reserveOverlayWrite();
  const entryId = "00000000-0000-4000-8000-000000000123";

  assert.equal((await repository.publishConfirmedStory(accountA1, {
    workKey: "ffn:7038840",
    entryId,
    entry: {
      status: "PLANNING",
      readerStatus: "PLANNING",
      canonicalReaderStatus: "SAVED",
      entryId,
    },
    syncVersion: "2026-07-19T12:00:00.000Z",
  })).kind, "published");

  assert.deepEqual(
    await repository.publishOverlay(accountA1, {
      entries: {},
      workPreferences: {},
      syncVersion: "2026-07-19T12:00:01.000Z",
    }, refreshReservation),
    { kind: "stale_write" },
  );
  assert.equal(
    (await repository.read()).overlay.entries["ffn:7038840"].entryId,
    entryId,
  );
});

test("a later authoritative mutation supersedes a finish acknowledgement", async () => {
  const { repository, state } = createHarness();
  state.display = accountA1;
  state.publication = accountA1;
  const entryId = "00000000-0000-4000-8000-000000000123";
  await repository.publishOverlay(accountA1, {
    entries: {},
    workPreferences: {},
    syncVersion: "2026-07-19T12:00:00.000Z",
  });

  const finishReservation = repository.reserveOverlayWrite();
  const laterMutationReservation = repository.reserveOverlayWrite();

  assert.equal((await repository.publishOverlay(accountA1, {
    entries: {
      "ffn:7038840": {
        status: "READING",
        readerStatus: "READING",
        canonicalReaderStatus: "READING",
        entryId,
      },
    },
    workPreferences: {},
    syncVersion: "2026-07-19T12:00:01.000Z",
  }, laterMutationReservation)).kind, "published");

  assert.equal((await repository.publishAuthoritativeStory(accountA1, {
    workKey: "ffn:7038840",
    entryId,
    entry: {
      status: "COMPLETED",
      readerStatus: "COMPLETED",
      canonicalReaderStatus: "FINISHED",
      entryId,
    },
  }, finishReservation)).kind, "stale_write");
  assert.equal(
    (await repository.read()).overlay.syncVersion,
    "2026-07-19T12:00:01.000Z",
    "a finish response delayed past a newer mutation cannot overwrite it",
  );
  assert.equal(
    (await repository.read()).overlay.entries["ffn:7038840"].canonicalReaderStatus,
    "READING",
  );
});

test("a terminal deletion receipt removes only the exact account, work, and entry", async () => {
  const { repository, state } = createHarness();
  state.display = accountA1;
  state.publication = accountA1;
  const entryId = "00000000-0000-4000-8000-000000000123";
  await repository.publishOverlay(accountA1, {
    entries: {
      "ffn:7038840": {
        status: "READING",
        entryId,
      },
      "ao3:123": {
        status: "READING",
        entryId: "00000000-0000-4000-8000-000000000124",
      },
    },
    workPreferences: {},
    syncVersion: "2026-07-19T12:00:00.000Z",
  });

  assert.equal((await repository.removeAuthoritativeStory(accountA1, {
    workKey: "ffn:7038840",
    entryId,
  })).kind, "published");
  assert.deepEqual(Object.keys((await repository.read()).overlay.entries), ["ao3:123"]);

  assert.equal((await repository.removeAuthoritativeStory(accountA1, {
    workKey: "ao3:123",
    entryId,
  })).kind, "published");
  assert.ok((await repository.read()).overlay.entries["ao3:123"]);

  const replacementEntryId = "00000000-0000-4000-8000-000000000125";
  await repository.publishAuthoritativeStory(accountA1, {
    workKey: "ffn:7038840",
    entryId: replacementEntryId,
    entry: {
      status: "READING",
      entryId: replacementEntryId,
    },
  });
  assert.equal((await repository.removeAuthoritativeStory(accountA1, {
    workKey: "ffn:7038840",
    entryId,
  })).kind, "published");
  assert.equal(
    (await repository.read()).overlay.entries["ffn:7038840"].entryId,
    replacementEntryId,
  );

  state.publication = accountB1;
  assert.equal((await repository.removeAuthoritativeStory(accountA1, {
    workKey: "ffn:7038840",
    entryId: replacementEntryId,
  })).kind, "rejected_scope");
  assert.equal(
    (await repository.read()).overlay.entries["ffn:7038840"].entryId,
    replacementEntryId,
  );
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
