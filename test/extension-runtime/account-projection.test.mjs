import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountProjectionApi,
} from "../../.trace-build/extension-runtime/account-projection.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("projection API fetches overlay and summary without exposing the credential", async () => {
  const calls = [];
  const api = new AccountProjectionApi(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/extension/library-overlay")) {
      return jsonResponse({
        success: true,
        data: {
          entries: { "ffn:7038840": { status: "READING" } },
          workPreferences: {},
          syncVersion: "2026-07-20T12:00:00.000Z",
        },
      });
    }
    return jsonResponse({
      account_id: "account-a",
      pro: true,
      library_count: 4,
      first_story_completed_at: "2026-07-19T12:00:00.000Z",
    });
  }, "https://api.tracefiction.com/");

  const result = await api.load("private-token");

  assert.equal(result.kind, "success");
  assert.equal(result.value.overlay.kind, "value");
  assert.deepEqual(result.value.summary, {
    kind: "value",
    value: {
      accountId: "account-a",
      value: { pro: true, libraryCount: 4, firstStoryCompleted: true },
    },
  });
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname).sort(), [
    "/api/extension/account",
    "/api/extension/library-overlay",
  ]);
  assert.ok(calls.every(({ options }) =>
    options.headers.Authorization === "Bearer private-token"
  ));
});

test("projection API preserves a valid part when the other endpoint is unavailable", async () => {
  const api = new AccountProjectionApi(async (url) => {
    if (url.endsWith("/api/extension/library-overlay")) throw new Error("offline");
    return jsonResponse({
      account_id: "account-a",
      pro: false,
      library_count: 0,
      first_story_completed_at: null,
    });
  }, "https://api.tracefiction.com");

  const result = await api.load("token");

  assert.equal(result.kind, "success");
  assert.deepEqual(result.value.overlay, { kind: "unavailable" });
  assert.equal(result.value.summary.kind, "value");
});

test("any projection 401 rejects the private capability", async () => {
  const api = new AccountProjectionApi(async (url) =>
    url.endsWith("/api/extension/account")
      ? new Response("", { status: 401 })
      : jsonResponse({
          success: true,
          data: {
            entries: {},
            workPreferences: {},
            syncVersion: "2026-07-20T12:00:00.000Z",
          },
        })
  , "https://api.tracefiction.com");

  assert.deepEqual(await api.load("token"), { kind: "auth_rejected" });
});
