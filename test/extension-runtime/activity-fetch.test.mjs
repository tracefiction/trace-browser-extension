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
test("distinguishes Safari iOS and macOS without sending raw OS/UA", () => {
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
});
test("adds version metadata only to authenticated Trace extension API requests", async () => {
  const seen = [];
  const fetch = createActivityFetch(
    async (...args) => {
      seen.push(args);
      return new Response("{}");
    },
    runtime,
    "promise",
    "https://api.tracefiction.com",
  );
  await fetch("https://api.tracefiction.com/api/extension/track", {
    headers: { Authorization: "Bearer fixture" },
  });
  assert.equal(seen[0][1].headers.get("X-Trace-Extension-Version"), "2.3.1");
  assert.equal(seen[0][1].headers.get("Authorization"), "Bearer fixture");
  await fetch("https://example.com/api/extension/track", {
    headers: { Authorization: "Bearer fixture" },
  });
  await fetch("https://api.tracefiction.com/api/extension/account");
  assert.equal(seen[1][1].headers["X-Trace-Extension-Version"], undefined);
  assert.equal(seen[2][1], undefined);
});
