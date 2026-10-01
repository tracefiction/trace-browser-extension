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

test("successful probe is shared by concurrent saves and reused across endpoint paths", async () => {
  const seen = [];
  const send = createActivityFetch(async (_, request) => {
    seen.push(request);
    return response();
  }, runtime, "promise", api);
  await Promise.all(Array.from({ length: 25 }, (_, i) => send(api + "/api/extension/track?save=" + i, init)));
  await send(api + "/api/extension/account", { headers: init.headers });
  assert.equal(seen.filter(r => r.method === "OPTIONS").length, 1);
  assert.equal(seen.filter(r => r.method === "POST").length, 25);
  assert.equal(seen.length, 27);
  assert.ok(seen.every(r => r.headers.get("X-Trace-Extension-Version") === "2.3.1"));
});

function memoryCache() {
  const data = {};
  return { data, get: async key => ({ [key]: data[key] }), set: async patch => { Object.assign(data, patch); } };
}

test("origin cache survives worker restart, expires after an hour and cannot authorize another origin", async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const storage = memoryCache();
  const seen = [];
  const fetchImpl = async (url, request) => { seen.push({ url, request }); return response(); };
  const worker = (base = api) => createActivityFetch(fetchImpl, runtime, "promise", base, storage);
  await worker()(api + "/api/extension/track", init);
  now += 1_000;
  const restarted = worker();
  await restarted(api + "/api/extension/track", init);
  assert.equal(seen.filter(r => r.request.method === "OPTIONS").length, 1);
  assert.deepEqual(storage.data, { [`traceActivityCorsV1:${api}`]: 1_800_003_600_000 });
  const other = "https://other.example";
  await worker(other)(other + "/api/extension/track", init);
  assert.equal(seen.filter(r => r.request.method === "OPTIONS").length, 2);
  now = 1_800_003_600_000;
  await restarted(api + "/api/extension/track", init);
  assert.equal(seen.filter(r => r.request.method === "OPTIONS").length, 3);
});

test("HTTP and network failures invalidate a successful cache for the next call without replay", async () => {
  for (const failure of [401, 500, "network"]) {
    const storage = memoryCache();
    const seen = [];
    let fail = false;
    const fetchImpl = async (_, request) => {
      seen.push(request);
      if (request.method === "OPTIONS") return response();
      if (fail) {
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response("{}", { status: failure });
      }
      return response();
    };
    const send = createActivityFetch(fetchImpl, runtime, "promise", api, storage);
    await send(api + "/api/extension/track", init);
    fail = true;
    if (failure === "network") await assert.rejects(send(api + "/api/extension/track", init));
    else assert.equal((await send(api + "/api/extension/track", init)).status, failure);
    assert.deepEqual(seen.map(r => r.method), ["OPTIONS", "POST", "POST"]);
    assert.equal(storage.data[`traceActivityCorsV1:${api}`], 0);
    fail = false;
    await createActivityFetch(fetchImpl, runtime, "promise", api, storage)(api + "/api/extension/track", init);
    assert.deepEqual(seen.map(r => r.method), ["OPTIONS", "POST", "POST", "OPTIONS", "POST"]);
  }
});

test("a re-probe after server capability loss downgrades before the next mutation", async () => {
  let serverAccepts = true;
  const methods = [];
  const send = createActivityFetch(async (_, request) => {
    methods.push(request.method);
    if (!serverAccepts && request.headers.has("X-Trace-Platform")) throw new TypeError("Failed to fetch");
    return response();
  }, runtime, "promise", api);
  await send(api + "/api/extension/track", init);
  serverAccepts = false;
  await assert.rejects(send(api + "/api/extension/track", init));
  await send(api + "/api/extension/track", init);
  await send(api + "/api/extension/track", init);
  assert.deepEqual(methods, ["OPTIONS", "POST", "POST", "OPTIONS", "POST", "POST"]);
});

test("cancelling one caller does not cancel the shared probe or send its mutation", async () => {
  let finish;
  let start;
  const probeStarted = new Promise(resolve => { start = resolve; });
  const probeResponse = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const sent = [];
  const send = createActivityFetch(async (_, request) => {
    sent.push(request);
    if (request.method === "OPTIONS") { start(); return probeResponse; }
    return response();
  }, runtime, "promise", api);
  const cancelled = assert.rejects(send(api + "/api/extension/track", { ...init, signal: controller.signal }), { name: "AbortError" });
  const survivor = send(api + "/api/extension/track", init);
  await probeStarted;
  controller.abort();
  finish(response());
  await Promise.all([cancelled, survivor]);
  assert.deepEqual(sent.map(r => r.method), ["OPTIONS", "POST"]);
  await send(api + "/api/extension/track", init);
  assert.equal(sent.length, 3);
});

test("cache storage failures never block a save or cause repeat steady-state probes", async () => {
  const methods = [];
  const storage = { get: async () => { throw Error("unavailable"); }, set: async () => { throw Error("unavailable"); } };
  const send = createActivityFetch(async (_, request) => { methods.push(request.method); return response(); }, runtime, "promise", api, storage);
  await send(api + "/api/extension/track", init);
  await send(api + "/api/extension/track", init);
  assert.deepEqual(methods, ["OPTIONS", "POST", "POST"]);
});

test("Firefox does not read or write the capability cache", async () => {
  const storage = { get: () => assert.fail("cache read"), set: () => assert.fail("cache write") };
  const methods = [];
  const send = createActivityFetch(async (_, request) => { methods.push(request.method); return response(); }, { ...runtime, getURL: () => "moz-extension://fixture/" }, "promise", api, storage);
  await send(api + "/api/extension/track", init);
  assert.deepEqual(methods, ["POST"]);
});
