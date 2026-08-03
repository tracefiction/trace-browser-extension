import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyAccountData,
  parseAccountData,
} from "../../.trace-build/extension-core/index.mjs";

const scope = Object.freeze({ accountId: "account-a", epoch: 4 });

function validRoot(overrides = {}) {
  return {
    version: 1,
    scope,
    summary: {
      pro: true,
      libraryCount: 12,
      firstStoryCompleted: true,
    },
    overlay: {
      entries: {
        "ao3:123": {
          status: "READING",
          readerStatus: "READING",
          canonicalReaderStatus: "READING",
          entryId: "00000000-0000-4000-8000-000000000000",
          chapters: { current: 4, total: 10 },
          rating: 4,
          privateContext: {
            hasNotes: true,
            tagCount: 2,
            notePreview: "reader-safe note",
            tags: ["favorite", "reread"],
          },
          ignoredFutureField: "not persisted",
        },
      },
      workPreferences: {
        "ffn:456": { browsePreference: { hidden: true } },
      },
      syncVersion: "2026-07-15T12:00:00.000Z",
    },
    ...overrides,
  };
}

test("account record parser copies a bounded, immutable V1 model", () => {
  const parsed = parseAccountData(validRoot());
  assert.equal(parsed.kind, "valid");
  assert.equal(Object.isFrozen(parsed.value), true);
  assert.equal(Object.isFrozen(parsed.value.overlay.entries["ao3:123"]), true);
  assert.equal(Object.hasOwn(parsed.value.overlay.entries["ao3:123"], "ignoredFutureField"), false);
  assert.deepEqual(parsed.value.scope, scope);
  assert.notEqual(parsed.value.scope, scope);
  assert.equal(parsed.value.capacityRecovery, null);
});

test("account parser accepts legacy records and validates capacity recovery state", () => {
  const legacy = parseAccountData(validRoot());
  assert.equal(legacy.kind, "valid");
  assert.equal(legacy.value.capacityRecovery, null);

  const blocked = parseAccountData(validRoot({
    capacityRecovery: {
      blockedAt: 100,
      blockedLibraryCount: 100,
      nextPromptAt: 200,
    },
  }));
  assert.equal(blocked.kind, "valid");
  assert.deepEqual(blocked.value.capacityRecovery, {
    blockedAt: 100,
    blockedLibraryCount: 100,
    nextPromptAt: 200,
  });
  assert.deepEqual(parseAccountData(validRoot({
    capacityRecovery: {
      blockedAt: -1,
      blockedLibraryCount: 100,
      nextPromptAt: 200,
    },
  })), { kind: "invalid" });
});

test("account parser fails closed for wrong roots, scopes, and private bounds", () => {
  const cases = [
    null,
    { ...validRoot(), version: 2 },
    { ...validRoot(), scope: { accountId: "", epoch: 4 } },
    { ...validRoot(), scope: { accountId: "account-a", epoch: -1 } },
    { ...validRoot(), summary: { pro: true, libraryCount: -1, firstStoryCompleted: true } },
    {
      ...validRoot(),
      overlay: {
        ...validRoot().overlay,
        entries: { "unknown:123": { status: "READING" } },
      },
    },
    {
      ...validRoot(),
      overlay: {
        ...validRoot().overlay,
        entries: { "ao3:123": { status: "READING", readerStatus: "PAUSED" } },
      },
    },
    {
      ...validRoot(),
      overlay: {
        ...validRoot().overlay,
        entries: {
          "ao3:123": {
            status: "READING",
            privateContext: {
              hasNotes: true,
              tagCount: 1,
              notePreview: "x".repeat(181),
            },
          },
        },
      },
    },
    {
      ...validRoot(),
      overlay: {
        ...validRoot().overlay,
        syncVersion: "July 15, 2026",
      },
    },
  ];

  assert.deepEqual(parseAccountData(cases[0]), { kind: "missing" });
  for (const value of cases.slice(1)) {
    assert.deepEqual(parseAccountData(value), { kind: "invalid" });
  }
});

test("opaque overlay timestamps may move backward and remain valid full snapshots", () => {
  const newer = parseAccountData(validRoot());
  const lower = parseAccountData(validRoot({
    overlay: {
      entries: {},
      workPreferences: {},
      syncVersion: "2026-07-14T12:00:00.000Z",
    },
  }));
  assert.equal(newer.kind, "valid");
  assert.equal(lower.kind, "valid");
  assert.equal(lower.value.overlay.syncVersion < newer.value.overlay.syncVersion, true);
  assert.deepEqual(lower.value.overlay.entries, {});
});

test("empty account data is exact-scope and contains no inferred values", () => {
  assert.deepEqual(createEmptyAccountData(scope), {
    version: 1,
    scope,
    summary: null,
    overlay: null,
    capacityRecovery: null,
  });
  assert.throws(
    () => createEmptyAccountData({ accountId: "account-a", epoch: Number.NaN }),
    /invalid account scope/,
  );
});
