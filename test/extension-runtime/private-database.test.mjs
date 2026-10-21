import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  BrowserPrivateRecordDatabase,
  PRIVATE_DATABASE_NAME,
  PRIVATE_RECORD_KEYS,
} from "../../.trace-build/extension-runtime/private-database.mjs";

function openRaw(factory, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = factory.open(PRIVATE_DATABASE_NAME, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onerror = () => reject(request.error ?? new Error("open failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

test("private database round-trips and deletes only named records", async () => {
  const database = new BrowserPrivateRecordDatabase(new IDBFactory());
  assert.equal(await database.get(PRIVATE_RECORD_KEYS.sessionEnvelope), null);

  const envelope = { version: 1, epoch: 3, desired: "disconnected" };
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, envelope);
  await database.put(PRIVATE_RECORD_KEYS.accountData, { private: true });
  assert.deepEqual(await database.get(PRIVATE_RECORD_KEYS.sessionEnvelope), envelope);
  assert.deepEqual(await database.get(PRIVATE_RECORD_KEYS.accountData), { private: true });

  await database.delete(PRIVATE_RECORD_KEYS.sessionEnvelope);
  assert.equal(await database.get(PRIVATE_RECORD_KEYS.sessionEnvelope), null);
  assert.deepEqual(await database.get(PRIVATE_RECORD_KEYS.accountData), { private: true });
});

test("failed structured-clone transaction is visible and a later transaction recovers", async () => {
  const database = new BrowserPrivateRecordDatabase(new IDBFactory());
  await assert.rejects(
    database.put(PRIVATE_RECORD_KEYS.accountData, { cannotClone() {} }),
    /private database/,
  );
  await database.put(PRIVATE_RECORD_KEYS.accountData, { valid: true });
  assert.deepEqual(await database.get(PRIVATE_RECORD_KEYS.accountData), { valid: true });
});

test("future-version database fails closed but whole-database rollback deletes it", async () => {
  const factory = new IDBFactory();
  const future = await openRaw(factory, 2, (database) => {
    database.createObjectStore("future-records");
  });
  future.close();

  const database = new BrowserPrivateRecordDatabase(factory);
  await assert.rejects(
    database.get(PRIVATE_RECORD_KEYS.sessionEnvelope),
    /private database open failed/,
  );
  await database.deleteDatabase();

  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, { version: 1 });
  assert.deepEqual(await database.get(PRIVATE_RECORD_KEYS.sessionEnvelope), { version: 1 });
});

test("database deletion reports a blocking connection and succeeds after it closes", async () => {
  const factory = new IDBFactory();
  const blocker = await openRaw(factory, 1, (database) => {
    database.createObjectStore("records");
  });
  const database = new BrowserPrivateRecordDatabase(factory);

  await assert.rejects(database.deleteDatabase(), /deletion blocked/);
  blocker.close();
  await database.deleteDatabase();
  assert.equal(await database.get(PRIVATE_RECORD_KEYS.accountData), null);
});

// A factory that hands out real connections and keeps them, so a test can
// close one under the database as Safari does when its storage goes away.
function keepingFactory(factory, { hangFirstOpen = false } = {}) {
  const opened = [];
  let opens = 0;
  return {
    opened,
    open(name, version) {
      opens += 1;
      if (hangFirstOpen && opens === 1) return {};
      const request = factory.open(name, version);
      request.addEventListener("success", () => opened.push(request.result));
      return request;
    },
    deleteDatabase: (name) => factory.deleteDatabase(name),
  };
}

test("a lost connection is dropped and the request is made again on a new one", async () => {
  const factory = keepingFactory(new IDBFactory());
  const database = new BrowserPrivateRecordDatabase(factory);
  await database.put(PRIVATE_RECORD_KEYS.accountData, { kept: true });
  assert.equal(factory.opened.length, 1);

  factory.opened[0].close();

  assert.deepEqual(await database.get(PRIVATE_RECORD_KEYS.accountData), { kept: true });
  await database.put(PRIVATE_RECORD_KEYS.accountData, { kept: "again" });
  assert.deepEqual(await database.get(PRIVATE_RECORD_KEYS.accountData), { kept: "again" });
  assert.equal(factory.opened.length, 2);
});

test("an open that never answers times out and the next request opens again", async () => {
  const factory = keepingFactory(new IDBFactory(), { hangFirstOpen: true });
  const database = new BrowserPrivateRecordDatabase(factory, { openTimeoutMs: 20 });

  await assert.rejects(database.get(PRIVATE_RECORD_KEYS.accountData), /open timed out/);
  assert.equal(await database.get(PRIVATE_RECORD_KEYS.accountData), null);
});

// A connection as Safari can leave it after ending its storage process: it
// opens, but its transactions never answer, or abort with "UnknownError".
function brokenConnection(behaviour) {
  const connection = {
    version: 1,
    objectStoreNames: { length: 1, contains: (name) => name === "records" },
    closed: 0,
    close() { connection.closed += 1; },
    transaction() {
      const transaction = {
        error: null,
        abort() {},
        objectStore: () => ({
          get: () => {
            if (behaviour === "unknown-error") {
              setTimeout(() => {
                transaction.error = new DOMException("Connection lost", "UnknownError");
                transaction.onabort?.();
              }, 0);
            }
            return {};
          },
        }),
      };
      return transaction;
    },
  };
  return connection;
}

// The first open answers with `broken`; every later one is a real database.
function factoryOpeningFirst(broken) {
  const real = new IDBFactory();
  const counts = { opens: 0 };
  return {
    counts,
    open(name, version) {
      counts.opens += 1;
      if (counts.opens > 1) return real.open(name, version);
      const request = {};
      setTimeout(() => {
        request.result = broken;
        request.onsuccess?.();
      }, 0);
      return request;
    },
    deleteDatabase: (name) => real.deleteDatabase(name),
  };
}

test("a transaction that never answers times out, and the request is made again on a new connection", async () => {
  const broken = brokenConnection("silent");
  const factory = factoryOpeningFirst(broken);
  const database = new BrowserPrivateRecordDatabase(factory, { transactionTimeoutMs: 20 });

  assert.equal(await database.get(PRIVATE_RECORD_KEYS.accountData), null);
  assert.equal(broken.closed, 1);
  assert.equal(factory.counts.opens, 2);
});

test("a transaction aborted with UnknownError is made again on a new connection", async () => {
  const broken = brokenConnection("unknown-error");
  const factory = factoryOpeningFirst(broken);
  const database = new BrowserPrivateRecordDatabase(factory, { transactionTimeoutMs: 1_000 });

  assert.equal(await database.get(PRIVATE_RECORD_KEYS.accountData), null);
  assert.equal(broken.closed, 1);
  assert.equal(factory.counts.opens, 2);
});

test("requests that fail together on one connection open one new connection between them", async () => {
  const broken = brokenConnection("silent");
  const factory = factoryOpeningFirst(broken);
  const database = new BrowserPrivateRecordDatabase(factory, { transactionTimeoutMs: 20 });

  const answers = await Promise.all([
    database.get(PRIVATE_RECORD_KEYS.accountData),
    database.get(PRIVATE_RECORD_KEYS.sessionEnvelope),
    database.get(PRIVATE_RECORD_KEYS.sessionCredentials),
  ]);
  assert.deepEqual(answers, [null, null, null]);
  assert.equal(factory.counts.opens, 2);
});
