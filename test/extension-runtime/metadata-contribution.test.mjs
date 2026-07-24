import assert from "node:assert/strict";
import test from "node:test";

import {
  MetadataContributionApi,
  TraceWebMetadataNotificationPort,
} from "../../.trace-build/extension-runtime/metadata-contribution.mjs";
import {
  metadataContributionCommandFromMessage,
} from "../../.trace-build/extension-runtime/metadata-contribution-sender.mjs";

const storySender = {
  frameId: 0,
  tab: {
    url: "https://www.fanfiction.net/s/7038840/2/A-Chance-Encounter",
  },
};
const storyMessage = {
  type: "TRACE_METADATA_BROADCAST",
  payload: {
    s: "ffn",
    at: "2026-07-20T12:00:00.000Z",
    item: {
      src: "ffn",
      ctx: "story",
      u: "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter",
      t: "A Chance Encounter",
      chn: 2,
    },
  },
};

test("story metadata is bound to one matching top-frame story sender", () => {
  const command = metadataContributionCommandFromMessage(storyMessage, storySender);
  assert.deepEqual(command, {
    kind: "story_metadata",
    hostKind: "ffn",
    workKeys: ["ffn:7038840"],
    payload: storyMessage.payload,
  });
  assert.notEqual(command.payload, storyMessage.payload);
  assert.equal(metadataContributionCommandFromMessage(
    storyMessage,
    { ...storySender, frameId: 2 },
  ), null);
  assert.equal(metadataContributionCommandFromMessage({
    ...storyMessage,
    payload: {
      ...storyMessage.payload,
      item: { ...storyMessage.payload.item, u: "https://www.fanfiction.net/s/999/1/" },
    },
  }, storySender), null);
  assert.equal(metadataContributionCommandFromMessage(storyMessage, {
    tab: { url: "https://www.fanfiction.net/login.php" },
  }), null);
});

test("story metadata is byte bounded and cannot be sent from a listing", () => {
  assert.equal(metadataContributionCommandFromMessage({
    ...storyMessage,
    payload: {
      ...storyMessage.payload,
      item: { ...storyMessage.payload.item, sm: "é".repeat(40_000) },
    },
  }, storySender), null);
  assert.equal(metadataContributionCommandFromMessage(storyMessage, {
    tab: { url: "https://www.fanfiction.net/book/Harry-Potter/" },
  }), null);
});

test("listing refresh accepts only bounded strict same-host items", () => {
  const sender = {
    frameId: 0,
    tab: { url: "https://www.fanfiction.net/book/Harry-Potter/" },
  };
  const message = {
    type: "TRACE_LIBRARY_METADATA_REFRESH",
    payload: {
      items: [{
        source: "ffn",
        sourceStoryId: "7654321",
        url: "https://www.fanfiction.net/s/7654321/1/Tracked-Story",
        title: "Tracked Story",
        summary: "Listing summary",
        chapters: 7,
        fandoms: ["Harry Potter"],
      }],
    },
  };
  assert.deepEqual(metadataContributionCommandFromMessage(message, sender), {
    kind: "library_metadata_refresh",
    hostKind: "ffn",
    workKeys: ["ffn:7654321"],
    payload: message.payload,
  });
  assert.equal(metadataContributionCommandFromMessage({
    ...message,
    payload: {
      items: [{ ...message.payload.items[0], source: "ao3" }],
    },
  }, sender), null);
  assert.equal(metadataContributionCommandFromMessage({
    ...message,
    payload: {
      items: [{ ...message.payload.items[0], sourceStoryId: "999" }],
    },
  }, sender), null);
  assert.equal(metadataContributionCommandFromMessage({
    ...message,
    payload: {
      items: [{ ...message.payload.items[0], unexpected: "field" }],
    },
  }, sender), null);
  assert.equal(metadataContributionCommandFromMessage({
    ...message,
    payload: {
      items: Array.from({ length: 101 }, () => message.payload.items[0]),
    },
  }, sender), null);
});

test("metadata API uses exact routes and validates both success response shapes", async () => {
  const calls = [];
  const responses = [
    { success: true, data: { story_id: 123 } },
    { success: true, data: { updated: 1, ignored: 2 } },
  ];
  const api = new MetadataContributionApi(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }, "https://api.tracefiction.com");
  const storyCommand = metadataContributionCommandFromMessage(storyMessage, storySender);
  const listingCommand = metadataContributionCommandFromMessage({
    type: "TRACE_LIBRARY_METADATA_REFRESH",
    payload: {
      items: [{ source: "ffn", sourceStoryId: "7654321" }],
    },
  }, {
    frameId: 0,
    tab: { url: "https://www.fanfiction.net/book/" },
  });

  assert.deepEqual(await api.contribute("private-token", storyCommand), {
    kind: "success",
    value: { kind: "accepted", updated: true },
  });
  assert.deepEqual(await api.contribute("private-token", listingCommand), {
    kind: "success",
    value: { kind: "accepted", updated: true },
  });
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/api/extension/metadata",
    "/api/extension/library/metadata-refresh",
  ]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), storyMessage.payload);
});

test("metadata API preserves auth, validation, rate-limit, malformed, and unavailable outcomes", async () => {
  const responses = [
    new Response("", { status: 401 }),
    new Response("", { status: 400 }),
    new Response("", { status: 429 }),
    new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }),
    new Response("", { status: 503 }),
  ];
  const api = new MetadataContributionApi(async () => responses.shift(), "https://api.tracefiction.com");
  const command = metadataContributionCommandFromMessage(storyMessage, storySender);
  assert.deepEqual(await api.contribute("token", command), { kind: "auth_rejected" });
  assert.deepEqual(await api.contribute("token", command), {
    kind: "success",
    value: { kind: "rejected", reason: "invalid_request" },
  });
  assert.deepEqual(await api.contribute("token", command), {
    kind: "success",
    value: { kind: "rejected", reason: "rate_limited" },
  });
  assert.deepEqual(await api.contribute("token", command), {
    kind: "success",
    value: { kind: "invalid_response" },
  });
  assert.deepEqual(await api.contribute("token", command), {
    kind: "success",
    value: { kind: "unavailable" },
  });
});

test("Trace invalidation notifies only exact configured-origin tabs", async () => {
  const sent = [];
  const tabs = {
    async query() {
      return [
        { id: 1, url: "https://www.tracefiction.com/library" },
        { id: 2, url: "https://www.tracefiction.com.evil.test/library" },
        { id: 3, url: "https://tracefiction.com/library" },
      ];
    },
    async sendMessage(tabId, message) {
      sent.push({ tabId, message });
      return { ok: true };
    },
  };
  const notifier = new TraceWebMetadataNotificationPort({
    runtime: {},
    tabs,
    mode: "promise",
    webOrigin: "https://www.tracefiction.com",
  });
  assert.equal(await notifier.publish(), true);
  assert.deepEqual(sent.map(({ tabId }) => tabId), [1]);
  assert.equal(sent[0].message.type, "TRACE_LIBRARY_INVALIDATED");
  assert.equal(sent[0].message.reason, "metadata");
});
