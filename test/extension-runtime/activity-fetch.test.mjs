import test from "node:test";
import assert from "node:assert/strict";
import {
  activityHeaders,
  createActivityFetch,
} from "../../.trace-build/extension-runtime/activity-fetch.mjs";
const runtime = {
  getURL: () => "safari-web-extension://fixture/",
  getManifest: () => ({ version: "2.3.1" }),
  getPlatformInfo: async () => ({ os: "mac" }),
};
const api = "https://api.tracefiction.com";
const init = {
  method: "POST",
  headers: {
    Authorization: "Bearer fixture",
    "Content-Type": "application/json",
  },
  body: '{"operationId":"same-save"}',
};
const response = () => new Response("{}");
test("distinguishes Safari OS and rejects arbitrary versions without raw UA", () => {
  assert.deepEqual(activityHeaders(runtime, "mac", "PRIVATE_UA"), {
    "X-Trace-Platform": "web_desktop",
    "X-Trace-Extension-Browser": "safari_macos",
    "X-Trace-Extension-Version": "2.3.1",
  });
  assert.equal(
    activityHeaders(runtime, "ios", "Macintosh")["X-Trace-Extension-Browser"],
    "safari_ios",
  );
  assert.equal(
    activityHeaders(runtime, "unknown", "PRIVATE_UA")[
      "X-Trace-Extension-Browser"
    ],
    undefined,
  );
  assert.equal(
    activityHeaders(
      { ...runtime, getManifest: () => ({ version: "PRIVATE_CONTEXT" }) },
      "mac",
      "",
    )["X-Trace-Extension-Version"],
    undefined,
  );
});
test("checks CORS with OPTIONS before one authenticated save; other origins and unauthenticated calls are untouched", async () => {
  const seen = [];
  const send = createActivityFetch(
    async (...args) => {
      seen.push(args);
      return response();
    },
    runtime,
    "promise",
    api,
  );
  await send(api + "/api/extension/track", init);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][1].method, "OPTIONS");
  assert.equal(seen[0][1].body, undefined);
  assert.equal(seen[1][1].method, "POST");
  assert.equal(seen[1][1].body, init.body);
  assert.equal(seen[1][1].headers.get("X-Trace-Extension-Version"), "2.3.1");
  assert.equal(seen[1][1].headers.get("Authorization"), "Bearer fixture");
  await send("https://example.com/api/extension/track", init);
  assert.equal(seen[2][1], init);
  await send(api + "/api/extension/account");
  assert.equal(seen[3][1], undefined);
});
test("preflight rejection downgrades without sending a duplicate mutation and disables later probes", async () => {
  const seen = [];
  const send = createActivityFetch(
    async (url, request) => {
      seen.push(request);
      if (request.method === "OPTIONS") throw new TypeError("Failed to fetch");
      return response();
    },
    runtime,
    "promise",
    api,
  );
  await send(api + "/api/extension/track", init);
  await send(api + "/api/extension/track", init);
  assert.deepEqual(
    seen.map((r) => r.method),
    ["OPTIONS", "POST", "POST"],
  );
  for (const request of seen.slice(1)) {
    assert.equal(request.body, init.body);
    assert.deepEqual(Object.fromEntries(request.headers), {
      authorization: "Bearer fixture",
      "content-type": "application/json",
    });
  }
});
test("Firefox emits none of the optional headers and does not read dimensions or probe", async () => {
  const firefox = {
    getURL: () => "moz-extension://fixture/",
    getManifest: () => {
      throw Error("must not read release");
    },
    getPlatformInfo: () => {
      throw Error("must not read OS");
    },
  };
  assert.deepEqual(activityHeaders(firefox, "linux", "PRIVATE_UA"), {});
  const seen = [];
  const send = createActivityFetch(
    async (_, request) => {
      seen.push(request);
      return response();
    },
    firefox,
    "promise",
    api,
  );
  await send(api + "/api/extension/track", {
    ...init,
    headers: {
      ...init.headers,
      "X-Trace-Platform": "web_desktop",
      "X-Trace-App-Version": "1",
      "X-Trace-Extension-Browser": "firefox",
      "X-Trace-Extension-Version": "2",
    },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.fromEntries(seen[0].headers), {
    authorization: "Bearer fixture",
    "content-type": "application/json",
  });
});
test("never retries a mutation after HTTP or ambiguous network errors", async () => {
  for (const status of [401, 402, 500, "network"]) {
    const seen = [];
    const send = createActivityFetch(
      async (_, request) => {
        seen.push(request);
        if (request.method === "OPTIONS") return response();
        if (status === "network") throw new TypeError("Failed to fetch");
        return new Response("{}", { status });
      },
      runtime,
      "promise",
      api,
    );
    if (status === "network")
      await assert.rejects(send(api + "/api/extension/track", init));
    else
      assert.equal(
        (await send(api + "/api/extension/track", init)).status,
        status,
      );
    assert.deepEqual(
      seen.map((r) => r.method),
      ["OPTIONS", "POST"],
    );
  }
});
test("probe timeout is bounded and caller cancellation never sends a save", async () => {
  const seen = [];
  const send = createActivityFetch(
    async (_, request) => {
      seen.push(request);
      if (request.method === "OPTIONS") return new Promise(() => {});
      return response();
    },
    runtime,
    "promise",
    api,
  );
  await send(api + "/api/extension/track", init);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].headers.has("X-Trace-Platform"), false);
  const controller = new AbortController();
  const cancelled = [];
  const sendCancelled = createActivityFetch(
    async (_, request) => {
      cancelled.push(request);
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
    runtime,
    "promise",
    api,
  );
  await assert.rejects(
    sendCancelled(api + "/api/extension/track", {
      ...init,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(cancelled.length, 1);
});
test("a failed probe preserves a Request body for its single real send", async () => {
  const original = new Request(api + "/api/extension/track", init);
  const bodies = [];
  const send = createActivityFetch(
    async (input, request) => {
      if (request.method === "OPTIONS") throw new TypeError("Failed to fetch");
      bodies.push(await input.text());
      return response();
    },
    runtime,
    "promise",
    api,
  );
  await send(original);
  assert.deepEqual(bodies, [init.body]);
});
