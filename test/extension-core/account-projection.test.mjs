import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountProjectionService,
} from "../../.trace-build/extension-core/account-projection.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const scope = Object.freeze({ accountId: "account-a", epoch: 1 });
const overlay = Object.freeze({
  entries: Object.freeze({ "ffn:7038840": Object.freeze({ status: "READING" }) }),
  workPreferences: Object.freeze({}),
  syncVersion: "2026-07-20T12:00:00.000Z",
});
const summary = Object.freeze({
  pro: true,
  libraryCount: 4,
  firstStoryCompleted: true,
});

function createHarness(options = {}) {
  const gate = options.gate;
  const state = {
    scope,
    data: null,
    now: 1_000,
  };
  const calls = {
    api: 0,
    overlay: 0,
    summary: 0,
    reservations: 0,
  };
  const service = new AccountProjectionService({
    session: {
      publicationScope: () => state.scope,
      displayScope: () => state.scope,
      async executeAuthenticated(effect) {
        const startingScope = state.scope;
        const result = await effect("private-token");
        if (state.scope !== startingScope) return { kind: "stale" };
        if (result.kind === "success") return { kind: "published", value: result.value };
        if (result.kind === "auth_rejected") {
          return { kind: "auth_rejected", recovery: options.recovery ?? "reconnect_required" };
        }
        return { kind: "unavailable" };
      },
    },
    api: {
      async load(credential) {
        assert.equal(credential, "private-token");
        calls.api += 1;
        if (gate) await gate.promise;
        return options.apiResults?.shift() ?? {
          kind: "success",
          value: {
            overlay: { kind: "value", value: overlay },
            summary: {
              kind: "value",
              value: { accountId: "account-a", value: summary },
            },
          },
        };
      },
    },
    repository: {
      async read() {
        return state.data;
      },
      reserveOverlayWrite() {
        calls.reservations += 1;
        return calls.reservations;
      },
      async publishOverlay(actualScope, value) {
        assert.deepEqual(actualScope, scope);
        calls.overlay += 1;
        state.data = {
          version: 1,
          scope,
          summary: state.data?.summary ?? null,
          overlay: value,
        };
        return { kind: "published", value: state.data };
      },
      async publishSummary(actualScope, value) {
        assert.deepEqual(actualScope, scope);
        calls.summary += 1;
        state.data = {
          version: 1,
          scope,
          summary: value,
          overlay: state.data?.overlay ?? null,
        };
        return { kind: "published", value: state.data };
      },
    },
    clock: { now: () => state.now },
  });
  return { service, state, calls };
}

test("projection refresh deduplicates concurrent reads and publishes both exact-scope parts", async () => {
  const gate = deferred();
  const h = createHarness({ gate });
  const first = h.service.read();
  const second = h.service.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.api, 1);
  assert.equal(h.calls.reservations, 1);
  gate.resolve();

  assert.deepEqual(await first, await second);
  assert.equal(h.calls.overlay, 1);
  assert.equal(h.calls.summary, 1);
  assert.deepEqual(h.state.data, {
    version: 1,
    scope,
    summary,
    overlay,
  });

  assert.deepEqual(await h.service.refreshIfNeeded(), { kind: "current" });
  assert.equal(h.calls.api, 1);
});

test("projection refresh rejects a summary owned by a different account", async () => {
  const h = createHarness({
    apiResults: [{
      kind: "success",
      value: {
        overlay: { kind: "value", value: overlay },
        summary: {
          kind: "value",
          value: { accountId: "account-b", value: summary },
        },
      },
    }],
  });

  assert.deepEqual(await h.service.refreshIfNeeded(), {
    kind: "refreshed",
    overlay: "published",
    summary: "invalid",
  });
  assert.equal(h.calls.overlay, 1);
  assert.equal(h.calls.summary, 0);
});

test("projection refresh retries a safe GET once after authenticated recovery", async () => {
  const h = createHarness({
    recovery: "connected",
    apiResults: [
      { kind: "auth_rejected" },
      {
        kind: "success",
        value: {
          overlay: { kind: "value", value: overlay },
          summary: {
            kind: "value",
            value: { accountId: "account-a", value: summary },
          },
        },
      },
    ],
  });

  assert.equal((await h.service.refreshIfNeeded()).kind, "refreshed");
  assert.equal(h.calls.api, 2);
  assert.equal(h.calls.reservations, 2);
});

test("invalidation during an in-flight refresh forces the next read past stale freshness", async () => {
  const gate = deferred();
  const h = createHarness({ gate });
  const first = h.service.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.api, 1);

  h.service.invalidate();
  const afterInvalidation = h.service.read();
  gate.resolve();
  await first;
  await afterInvalidation;
  assert.equal(h.calls.api, 2);
  assert.equal(h.calls.overlay, 2);
  assert.equal(h.calls.summary, 2);
});
