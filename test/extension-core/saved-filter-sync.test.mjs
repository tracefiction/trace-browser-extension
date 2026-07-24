import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeSavedFilterSyncData,
  normalizeSavedFilterSnapshot,
  parseSavedFilterSyncData,
  savedFilterSyncRequest,
  SavedFilterSyncService,
} from "../../.trace-build/extension-core/saved-filter-sync.mjs";

const accountA1 = Object.freeze({ accountId: "account-a", epoch: 1 });
const accountA2 = Object.freeze({ accountId: "account-a", epoch: 2 });

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function localPreset(index, overrides = {}) {
  const at = `2026-07-20T10:${String(index % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: `preset-${index}`,
    clientId: `preset-${index}`,
    serverId: "",
    name: `Preset ${index}`,
    params: [["work_search[sort_column]", "kudos_count"]],
    scope: "global",
    contextKey: "",
    contextLabel: "",
    summary: ["Sort: Kudos"],
    createdAt: at,
    updatedAt: at,
    clientUpdatedAt: at,
    dirty: true,
    ...overrides,
  };
}

function remotePreset(local, index, overrides = {}) {
  return {
    id: uuid(index),
    clientId: local.clientId,
    name: local.name,
    scope: local.scope,
    contextKey: local.scope === "context" ? local.contextKey : null,
    contextLabel: local.scope === "context" ? local.contextLabel : null,
    params: local.params,
    summary: local.summary,
    createdAt: local.createdAt,
    updatedAt: local.updatedAt ?? local.clientUpdatedAt,
    clientUpdatedAt: local.clientUpdatedAt,
    ...overrides,
  };
}

function syncData(presets = [], deleted = [], version = "2026-07-20T12:00:00.000Z") {
  return {
    serverTime: version,
    syncVersion: version,
    presets,
    deleted,
  };
}

test("normalization and request planning preserve only bounded AO3 filter state", () => {
  const snapshot = normalizeSavedFilterSnapshot({
    presets: [
      localPreset(1, {
        params: [
          ["work_search[sort_column]", "kudos_count"],
          ["include_work_search[rating_ids][]", "10"],
        ],
      }),
      localPreset(2, { params: [["page", "2"]] }),
    ],
    deleted: [{
      id: "old",
      clientId: "old",
      clientUpdatedAt: "2026-07-20T09:00:00.000Z",
    }],
    clientId: "device:one",
  }, "2026-07-20T12:00:00.000Z");

  assert.equal(snapshot.presets.length, 1);
  assert.deepEqual(snapshot.presets[0].params, [
    ["include_work_search[rating_ids][]", "10"],
    ["work_search[sort_column]", "kudos_count"],
  ]);
  assert.deepEqual(savedFilterSyncRequest(snapshot), {
    clientId: "device:one",
    since: null,
    upserts: [{
      clientId: "preset-1",
      name: "Preset 1",
      scope: "global",
      contextKey: null,
      contextLabel: null,
      params: [
        ["include_work_search[rating_ids][]", "10"],
        ["work_search[sort_column]", "kudos_count"],
      ],
      summary: ["Sort: Kudos"],
      createdAt: "2026-07-20T10:01:00.000Z",
      clientUpdatedAt: "2026-07-20T10:01:00.000Z",
    }],
    deletes: [{
      clientId: "old",
      clientUpdatedAt: "2026-07-20T09:00:00.000Z",
    }],
  });
});

test("strict response parsing rejects unknown fields and invalid query parameters", () => {
  const local = localPreset(1);
  assert.ok(parseSavedFilterSyncData(syncData([remotePreset(local, 1)])));
  assert.equal(parseSavedFilterSyncData({
    ...syncData([remotePreset(local, 1)]),
    extra: true,
  }), null);
  assert.equal(parseSavedFilterSyncData(syncData([
    remotePreset(local, 1, { params: [["authenticity_token", "secret"]] }),
  ])), null);
});

test("merge preserves a newer dirty local edit while applying remote tombstones", () => {
  const newer = localPreset(1, {
    clientUpdatedAt: "2026-07-20T12:00:00.000Z",
  });
  const deletedLocally = localPreset(2, {
    serverId: uuid(2),
    dirty: false,
  });
  const snapshot = normalizeSavedFilterSnapshot({
    presets: [newer, deletedLocally],
    deleted: [],
    clientId: "device:one",
  }, "2026-07-20T12:00:00.000Z");
  const merged = mergeSavedFilterSyncData(
    snapshot,
    syncData(
      [remotePreset(newer, 1, {
        name: "Stale remote",
        clientUpdatedAt: "2026-07-20T11:00:00.000Z",
      })],
      [{
        id: uuid(2),
        clientId: "preset-2",
        deletedAt: "2026-07-20T12:01:00.000Z",
        updatedAt: "2026-07-20T12:01:00.000Z",
        clientUpdatedAt: "2026-07-20T12:01:00.000Z",
      }],
    ),
    new Set(),
    "2026-07-20T12:02:00.000Z",
  );
  assert.deepEqual(merged.presets.map((preset) => preset.name), ["Preset 1"]);
  assert.equal(merged.presets[0].dirty, true);
});

test("service drains dirty presets in bounded batches and merges each response", async () => {
  let snapshot = normalizeSavedFilterSnapshot({
    presets: Array.from({ length: 105 }, (_, index) => localPreset(index + 1)),
    clientId: "device:one",
  }, "2026-07-20T12:00:00.000Z");
  const requestSizes = [];
  const service = new SavedFilterSyncService({
    session: {
      publicationScope: () => accountA1,
      async executeAuthenticated(effect) {
        const result = await effect("token-a");
        return result.kind === "success"
          ? { kind: "published", value: result.value }
          : { kind: "auth_rejected", recovery: "reconnect_required" };
      },
    },
    api: {
      async sync(_credential, request) {
        requestSizes.push(request.upserts.length);
        return {
          kind: "success",
          value: {
            kind: "accepted",
            data: syncData(
              request.upserts.map((item, index) =>
                remotePreset(item, requestSizes.length * 1000 + index)
              ),
              [],
              `2026-07-20T12:0${requestSizes.length}:00.000Z`,
            ),
          },
        };
      },
    },
    repository: {
      async read() {
        return snapshot;
      },
      async merge(scope, data, sentDeletes, syncedAt) {
        assert.deepEqual(scope, accountA1);
        snapshot = mergeSavedFilterSyncData(snapshot, data, sentDeletes, syncedAt);
        return { kind: "published", snapshot };
      },
    },
    clock: { now: () => "2026-07-20T12:10:00.000Z" },
  });

  assert.deepEqual(await service.sync(), {
    kind: "completed",
    syncVersion: "2026-07-20T12:02:00.000Z",
    requests: 2,
  });
  assert.deepEqual(requestSizes, [100, 5]);
  assert.equal(snapshot.presets.every((preset) => preset.dirty === false), true);
});

test("definitive auth rejection retries once only for the same recovered account", async () => {
  let scope = accountA1;
  let executions = 0;
  let snapshot = normalizeSavedFilterSnapshot({
    presets: [localPreset(1)],
    clientId: "device:one",
  }, "2026-07-20T12:00:00.000Z");
  const service = new SavedFilterSyncService({
    session: {
      publicationScope: () => scope,
      async executeAuthenticated(effect) {
        executions += 1;
        if (executions === 1) {
          scope = accountA2;
          return { kind: "auth_rejected", recovery: "connected" };
        }
        const result = await effect("token-new");
        return { kind: "published", value: result.value };
      },
    },
    api: {
      async sync(credential, request) {
        assert.equal(credential, "token-new");
        return {
          kind: "success",
          value: {
            kind: "accepted",
            data: syncData([remotePreset(request.upserts[0], 1)]),
          },
        };
      },
    },
    repository: {
      async read() {
        return snapshot;
      },
      async merge(requestedScope, data, sent, at) {
        assert.deepEqual(requestedScope, accountA2);
        snapshot = mergeSavedFilterSyncData(snapshot, data, sent, at);
        return { kind: "published", snapshot };
      },
    },
    clock: { now: () => "2026-07-20T12:10:00.000Z" },
  });
  assert.equal((await service.sync()).kind, "completed");
  assert.equal(executions, 2);
});

test("uncertain API outcomes do not repeat a request in the same run", async () => {
  let calls = 0;
  const snapshot = normalizeSavedFilterSnapshot({
    presets: [localPreset(1)],
    clientId: "device:one",
  }, "2026-07-20T12:00:00.000Z");
  const service = new SavedFilterSyncService({
    session: {
      publicationScope: () => accountA1,
      async executeAuthenticated(effect) {
        const result = await effect("token");
        return { kind: "published", value: result.value };
      },
    },
    api: {
      async sync() {
        calls += 1;
        return { kind: "success", value: { kind: "unavailable" } };
      },
    },
    repository: {
      async read() {
        return snapshot;
      },
      async merge() {
        assert.fail("uncertain responses must not merge");
      },
    },
    clock: { now: () => "2026-07-20T12:10:00.000Z" },
  });
  assert.deepEqual(await service.sync(), {
    kind: "failed",
    reason: "unavailable",
  });
  assert.equal(calls, 1);
});

test("cancellation fences an in-flight response before it can merge", async () => {
  let release;
  let started = false;
  let merged = false;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const snapshot = normalizeSavedFilterSnapshot({
    presets: [localPreset(1)],
    clientId: "device:one",
  }, "2026-07-20T12:00:00.000Z");
  const service = new SavedFilterSyncService({
    session: {
      publicationScope: () => accountA1,
      async executeAuthenticated(effect) {
        return { kind: "published", value: (await effect("token")).value };
      },
    },
    api: {
      async sync() {
        started = true;
        return response;
      },
    },
    repository: {
      async read() {
        return snapshot;
      },
      async merge() {
        merged = true;
        return { kind: "published", snapshot };
      },
    },
    clock: { now: () => "2026-07-20T12:10:00.000Z" },
  });

  const pending = service.sync();
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  service.cancel();
  release({
    kind: "success",
    value: { kind: "accepted", data: syncData() },
  });

  assert.deepEqual(await pending, { kind: "failed", reason: "stale" });
  assert.equal(merged, false);
});
