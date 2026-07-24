import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_READINESS_ERROR_RECENT_MS,
  ARCHIVE_READINESS_STATUS_KEY,
  BrowserArchiveReadinessStatus,
} from "../../.trace-build/extension-runtime/archive-readiness-status.mjs";

class MemoryStorage {
  constructor(values = {}) {
    this.values = { ...values };
  }

  async get() {
    return { ...this.values };
  }

  async set(patch) {
    Object.assign(this.values, patch);
  }
}

test("readiness status exposes only bounded coarse evidence", async () => {
  const now = 50_000;
  const storage = new MemoryStorage({
    [ARCHIVE_READINESS_STATUS_KEY]: {
      lastArchiveSeenAt: 40_000.9,
      lastArchiveHostKind: "ao3",
      lastArchiveActionAt: 41_000,
      lastArchiveActionKind: "quick_add",
      lastArchiveErrorAt: 42_000,
      lastArchiveErrorKind: "permission",
      url: "https://archiveofourown.org/works/private",
      title: "must not escape",
    },
  });
  const status = new BrowserArchiveReadinessStatus(storage, { now: () => now });

  assert.deepEqual(await status.read(), {
    lastArchiveSeenAt: 40_000,
    lastArchiveHostKind: "ao3",
    lastArchiveActionAt: 41_000,
    lastArchiveActionKind: "quick_add",
    lastArchiveErrorKind: "permission",
  });
});

test("successful action clears a recent issue and concurrent events stay serialized", async () => {
  let now = 100_000;
  const storage = new MemoryStorage();
  const status = new BrowserArchiveReadinessStatus(storage, { now: () => now++ });

  await Promise.all([
    status.record({ hostKind: "ao3", errorKind: "network" }),
    status.record({ hostKind: "ffn", actionKind: "metadata" }),
  ]);

  assert.deepEqual(await status.read(), {
    lastArchiveSeenAt: 100_001,
    lastArchiveHostKind: "ffn",
    lastArchiveActionAt: 100_001,
    lastArchiveActionKind: "metadata",
  });
});

test("old issue evidence expires without deleting positive archive evidence", async () => {
  const storage = new MemoryStorage({
    [ARCHIVE_READINESS_STATUS_KEY]: {
      lastArchiveSeenAt: 10,
      lastArchiveHostKind: "ffn",
      lastArchiveErrorAt: 20,
      lastArchiveErrorKind: "parser",
    },
  });
  const status = new BrowserArchiveReadinessStatus(storage, {
    now: () => 20 + ARCHIVE_READINESS_ERROR_RECENT_MS + 1,
  });

  assert.deepEqual(await status.read(), {
    lastArchiveSeenAt: 10,
    lastArchiveHostKind: "ffn",
  });
});
