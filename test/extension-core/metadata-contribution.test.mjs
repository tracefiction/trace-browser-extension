import assert from "node:assert/strict";
import test from "node:test";

import {
  MetadataContributionService,
} from "../../.trace-build/extension-core/metadata-contribution.mjs";

const scope = Object.freeze({ accountId: "account-a", epoch: 3 });
const command = Object.freeze({
  kind: "story_metadata",
  hostKind: "ffn",
  workKeys: Object.freeze(["ffn:7038840"]),
  payload: Object.freeze({
    s: "ffn",
    at: "2026-07-20T12:00:00.000Z",
    item: Object.freeze({
      src: "ffn",
      ctx: "story",
      u: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
      t: "A Chance Encounter",
    }),
  }),
});

function createHarness(options = {}) {
  const state = {
    scope: options.scope === undefined ? scope : options.scope,
    enabled: options.enabled ?? true,
    outcomes: [...(options.outcomes ?? [{ kind: "accepted", updated: true }])],
  };
  const calls = {
    preference: 0,
    authority: 0,
    api: 0,
    invalidation: 0,
    notification: 0,
  };
  const service = new MetadataContributionService({
    session: {
      publicationScope: () => state.scope,
      async executeAuthenticated(effect) {
        if (state.scope === null) return { kind: "unavailable" };
        const startingScope = state.scope;
        const result = await effect("private-token");
        if (
          state.scope === null ||
          state.scope.accountId !== startingScope.accountId ||
          state.scope.epoch !== startingScope.epoch
        ) {
          return { kind: "stale" };
        }
        if (result.kind === "success") {
          return { kind: "published", value: result.value };
        }
        if (result.kind === "auth_rejected") {
          return {
            kind: "auth_rejected",
            recovery: options.recovery ?? "reconnect_required",
          };
        }
        return { kind: "unavailable" };
      },
    },
    api: {
      async contribute(credential, actualCommand) {
        calls.api += 1;
        assert.equal(credential, "private-token");
        assert.equal(actualCommand, command);
        if (options.onContribute) await options.onContribute(state);
        const outcome = state.outcomes.shift() ?? { kind: "unavailable" };
        return outcome.kind === "auth_rejected" || outcome.kind === "unavailable_effect"
          ? { kind: outcome.kind === "auth_rejected" ? "auth_rejected" : "unavailable" }
          : { kind: "success", value: outcome };
      },
    },
    preference: {
      async enabled() {
        calls.preference += 1;
        if (options.preferenceError) throw new Error("storage unavailable");
        return state.enabled;
      },
    },
    authority: {
      async prepare() {
        calls.authority += 1;
        if (options.authorityError) throw new Error("authority unavailable");
      },
    },
    projection: {
      invalidate() {
        calls.invalidation += 1;
      },
    },
    notification: {
      async publish() {
        calls.notification += 1;
        return options.notification ?? true;
      },
    },
  });
  return { service, state, calls };
}

test("disabled metadata improvement skips authority, credential, and API work", async () => {
  const h = createHarness({ enabled: false });
  assert.deepEqual(await h.service.execute(command), {
    kind: "skipped",
    reason: "preference_disabled",
  });
  assert.equal(h.calls.authority, 0);
  assert.equal(h.calls.api, 0);
  assert.equal(h.calls.invalidation, 0);
});

test("accepted metadata invalidates the projection before notifying Trace tabs", async () => {
  const order = [];
  const h = createHarness();
  h.service = new MetadataContributionService({
    session: {
      publicationScope: () => scope,
      async executeAuthenticated(effect) {
        const result = await effect("private-token");
        return { kind: "published", value: result.value };
      },
    },
    api: {
      async contribute() {
        order.push("api");
        return { kind: "success", value: { kind: "accepted", updated: true } };
      },
    },
    preference: { async enabled() { return true; } },
    authority: { async prepare() { order.push("authority"); } },
    projection: { invalidate() { order.push("projection"); } },
    notification: {
      async publish() {
        order.push("notification");
        return true;
      },
    },
  });

  assert.deepEqual(await h.service.execute(command), {
    kind: "accepted",
    updated: true,
    projection: "invalidated",
    notification: "published",
  });
  assert.deepEqual(order, ["authority", "api", "projection", "notification"]);
});

test("unchanged listing metadata does not invalidate or notify", async () => {
  const h = createHarness({
    outcomes: [{ kind: "accepted", updated: false }],
  });
  assert.deepEqual(await h.service.execute(command), {
    kind: "accepted",
    updated: false,
    projection: "not_needed",
    notification: "not_needed",
  });
  assert.equal(h.calls.invalidation, 0);
  assert.equal(h.calls.notification, 0);
});

test("definitive auth rejection may retry once after session recovery", async () => {
  const h = createHarness({
    recovery: "connected",
    outcomes: [
      { kind: "auth_rejected" },
      { kind: "accepted", updated: true },
    ],
  });
  assert.equal((await h.service.execute(command)).kind, "accepted");
  assert.equal(h.calls.api, 2);
});

test("unavailable or account-stale effects never retry or invalidate", async () => {
  const unavailable = createHarness({
    outcomes: [{ kind: "unavailable" }],
  });
  assert.deepEqual(await unavailable.service.execute(command), {
    kind: "failed",
    reason: "unavailable",
  });
  assert.equal(unavailable.calls.api, 1);
  assert.equal(unavailable.calls.invalidation, 0);

  const stale = createHarness({
    onContribute(state) {
      state.scope = { accountId: "account-b", epoch: 4 };
    },
  });
  assert.deepEqual(await stale.service.execute(command), {
    kind: "failed",
    reason: "stale",
  });
  assert.equal(stale.calls.invalidation, 0);
  assert.equal(stale.calls.notification, 0);
});

test("preference read failure preserves the documented enabled-by-default behavior", async () => {
  const h = createHarness({ preferenceError: true });
  assert.equal((await h.service.execute(command)).kind, "accepted");
  assert.equal(h.calls.api, 1);
});
