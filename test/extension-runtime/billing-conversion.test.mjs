import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionCapacityEventApi,
} from "../../.trace-build/extension-runtime/billing-conversion.mjs";

test("capacity conversion API sends only the bounded event contract", async () => {
  const requests = [];
  const api = new ExtensionCapacityEventApi(async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }, "https://api.tracefiction.com/");

  const result = await api.record("private-credential", {
    event: "prompt_viewed",
    surface: "story",
  });

  assert.deepEqual(result, { kind: "success", value: undefined });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.tracefiction.com/api/extension/capacity-events",
  );
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer private-credential");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    event: "prompt_viewed",
    surface: "story",
  });
});

test("capacity conversion API rejects invalid authority but absorbs telemetry outages", async () => {
  const rejected = new ExtensionCapacityEventApi(
    async () => new Response("", { status: 401 }),
    "https://api.tracefiction.com",
  );
  assert.deepEqual(
    await rejected.record("expired", {
      event: "prompt_dismissed",
      surface: "listing",
    }),
    { kind: "auth_rejected" },
  );

  const offline = new ExtensionCapacityEventApi(
    async () => {
      throw new Error("offline");
    },
    "https://api.tracefiction.com",
  );
  assert.deepEqual(
    await offline.record("current", {
      event: "prompt_viewed",
      surface: "story",
    }),
    { kind: "success", value: undefined },
  );
});
