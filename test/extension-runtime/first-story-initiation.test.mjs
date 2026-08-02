import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  BrowserFirstStoryInitiator,
  firstStoryInitiationFromMessage,
} from "../../.trace-build/extension-runtime/first-story-initiation.mjs";
import {
  installSessionRuntime,
} from "../../.trace-build/extension-runtime/controller.mjs";
import {
  BrowserPrivateRecordDatabase,
  PRIVATE_RECORD_KEYS,
} from "../../.trace-build/extension-runtime/private-database.mjs";

const runtimeId = "trace-extension-id";
const webOrigin = "https://www.tracefiction.com";
const popupSender = {
  id: runtimeId,
  url: `chrome-extension://${runtimeId}/popup.html`,
};
const traceSender = {
  id: runtimeId,
  frameId: 0,
  documentLifecycle: "active",
  url: `${webOrigin}/onboarding`,
  tab: { url: `${webOrigin}/onboarding` },
};
const storyUrl = "https://www.fanfiction.net/s/7038840/1/A-Chance-Encounter";
const entryId = "00000000-0000-4000-8000-000000000123";

test("first-story messages are accepted only from their owning popup or Trace surface", () => {
  assert.deepEqual(firstStoryInitiationFromMessage(
    { type: "TRACE_IMPORT_TRIGGER" },
    {
      ...popupSender,
      tab: { url: `chrome-extension://${runtimeId}/popup.html` },
    },
    runtimeId,
    webOrigin,
  ), { kind: "popup_import" });
  assert.equal(firstStoryInitiationFromMessage(
    { type: "TRACE_IMPORT_TRIGGER" },
    traceSender,
    runtimeId,
    webOrigin,
  ), null);
  assert.deepEqual(firstStoryInitiationFromMessage(
    {
      type: "TRACE_FIRST_STORY_ADD",
      nonce: "first_story_1",
      url: storyUrl,
    },
    traceSender,
    runtimeId,
    webOrigin,
  ), {
    kind: "web_save",
    nonce: "first_story_1",
    url: storyUrl,
  });
  assert.deepEqual(firstStoryInitiationFromMessage(
    {
      type: "TRACE_FIRST_STORY_ADD",
      nonce: "first_story_2",
      url: "https://example.com/story/1",
    },
    traceSender,
    runtimeId,
    webOrigin,
  ), { kind: "invalid", error: "invalid_url" });
  assert.equal(firstStoryInitiationFromMessage(
    {
      type: "TRACE_FIRST_STORY_ADD",
      nonce: "first_story_3",
      url: storyUrl,
    },
    { ...traceSender, frameId: 2 },
    runtimeId,
    webOrigin,
  ), null);
});

test("popup import validates the active archive payload before opening Trace import", async () => {
  const created = [];
  const initiator = new BrowserFirstStoryInitiator({
    runtime: { id: runtimeId, onMessage: { addListener() {} } },
    tabs: {
      async query() {
        return [{ id: 7, url: "https://archiveofourown.org/tags/Naruto/works" }];
      },
      async sendMessage(tabId, message) {
        assert.equal(tabId, 7);
        assert.deepEqual(message, { type: "TRACE_COLLECT" });
        return {
          ok: true,
          payload: {
            s: "ao3",
            at: "2026-07-20T12:00:00.000Z",
            items: [{
              src: "ao3",
              ctx: "listing",
              u: "https://archiveofourown.org/works/123",
              t: "Example",
            }],
          },
        };
      },
      async create(options) {
        created.push(options);
        return { id: 8, url: options.url };
      },
    },
    mode: "promise",
    webOrigin,
  });

  assert.deepEqual(await initiator.importActivePage(), { ok: true, state: "opened" });
  assert.equal(created.length, 1);
  const importUrl = new URL(created[0].url);
  assert.equal(importUrl.origin, webOrigin);
  assert.equal(importUrl.pathname, "/import");
  assert.match(importUrl.hash, /^#U/);
});

test("missing archive receiver becomes an actionable permission result", async () => {
  const initiator = new BrowserFirstStoryInitiator({
    runtime: { id: runtimeId, onMessage: { addListener() {} } },
    tabs: {
      async query() {
        return [{ id: 7, url: storyUrl }];
      },
      async sendMessage() {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
      async create() {
        assert.fail("permission failure must not open an import tab");
      },
    },
    mode: "promise",
    webOrigin,
  });
  assert.deepEqual(
    await initiator.importActivePage(),
    { ok: false, error: "permission_required" },
  );
});

test("popup import uses the callback browser contract without changing its boundary", async () => {
  const runtime = {
    id: runtimeId,
    lastError: null,
    onMessage: { addListener() {} },
  };
  const created = [];
  const initiator = new BrowserFirstStoryInitiator({
    runtime,
    tabs: {
      query(_query, callback) {
        callback([{ id: 9, url: storyUrl }]);
      },
      sendMessage(_tabId, _message, callback) {
        callback({
          ok: true,
          payload: {
            s: "ffn",
            at: "2026-07-20T12:00:00.000Z",
            items: [{
              src: "ffn",
              ctx: "story",
              u: "https://www.fanfiction.net/s/7038840/",
              t: "A Chance Encounter",
            }],
          },
        });
      },
      create(options, callback) {
        created.push(options);
        callback({ id: 10, url: options.url });
      },
    },
    mode: "callback",
    webOrigin,
  });
  assert.deepEqual(await initiator.importActivePage(), { ok: true, state: "opened" });
  assert.equal(created.length, 1);
});

test("desktop handoff retries content-script startup and reports permission denial finitely", async () => {
  let sends = 0;
  let delays = 0;
  const initiator = new BrowserFirstStoryInitiator({
    runtime: { id: runtimeId, onMessage: { addListener() {} } },
    tabs: {
      async query() {
        return [];
      },
      async create() {
        return { id: 12, url: storyUrl };
      },
      async sendMessage() {
        sends += 1;
        throw new Error("Receiving end does not exist.");
      },
    },
    mode: "promise",
    webOrigin,
    async delay() {
      delays += 1;
    },
  });
  assert.deepEqual(
    await initiator.saveFromTrace(storyUrl),
    { ok: false, error: "permission_required" },
  );
  assert.equal(sends, 25);
  assert.equal(delays, 24);
});

class StorageArea {
  async get() {
    return {};
  }
  async set() {}
  async remove() {}
}

async function seededDatabase() {
  const factory = new IDBFactory();
  const database = new BrowserPrivateRecordDatabase(factory);
  await database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, {
    version: 1,
    epoch: 1,
    desired: "connected",
    accountId: "account-a",
    credentialRef: "credential-a",
  });
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, {
    version: 1,
    entries: { "credential-a": "private-token" },
  });
  return { factory, database };
}

test("controller desktop handoff reaches the existing story-command owner", async () => {
  const { factory, database } = await seededDatabase();
  let controller;
  let trackWrites = 0;
  const tabs = {
    async query() {
      return [];
    },
    async create(options) {
      assert.deepEqual(options, { url: storyUrl, active: true });
      return { id: 42, url: storyUrl };
    },
    async sendMessage(tabId, message) {
      assert.equal(tabId, 42);
      assert.deepEqual(message, { type: "TRACE_FIRST_STORY_FOCUS_ADD" });
      const response = await controller.handle({
        type: "TRACE_QUICK_ADD",
        workKey: "ffn:7038840",
        payload: {
          s: "ffn",
          at: "2026-07-20T12:00:00.000Z",
          item: {
            src: "ffn",
            ctx: "story",
            u: storyUrl,
            t: "A Chance Encounter",
            chn: 1,
            cht: 12,
          },
        },
      }, {
        id: runtimeId,
        frameId: 0,
        documentLifecycle: "active",
        tab: { url: storyUrl },
      });
      return response?.ok
        ? { ok: true, state: "saved" }
        : { ok: false, error: response?.error };
    },
  };
  controller = installSessionRuntime({
    mode: "kernel",
    runtime: {
      id: runtimeId,
      onMessage: { addListener() {} },
      async getPlatformInfo() {
        return { os: "mac" };
      },
    },
    tabs,
    alarms: { async clear() { return true; } },
    storageArea: new StorageArea(),
    databaseFactory: factory,
    privateDatabase: database,
    storageMode: "promise",
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/extension/account") {
        return new Response(JSON.stringify({ account_id: "account-a" }), { status: 200 });
      }
      if (path === "/api/extension/track") {
        trackWrites += 1;
        return new Response(JSON.stringify({
          success: true,
          data: {
            entry_id: entryId,
            type: "created",
            work_key: "ffn:7038840",
            entry: {
              status: "PLANNING",
              readerStatus: "PLANNING",
              canonicalReaderStatus: "SAVED",
              entryId,
              chapters: { current: 0, total: 12 },
            },
            syncVersion: "2026-07-20T12:00:01.000Z",
          },
        }), { status: 200 });
      }
      assert.equal(path, "/api/extension/library-overlay");
      return new Response(JSON.stringify({
        success: true,
        data: {
          entries: {},
          workPreferences: {},
          syncVersion: "1970-01-01T00:00:00.000Z",
        },
      }), { status: 200 });
    },
    apiBase: "https://api.tracefiction.com",
    webOrigin,
    randomId: () => "id",
  });
  await controller.start();

  const response = await controller.handle({
    type: "TRACE_FIRST_STORY_ADD",
    nonce: "desktop_handoff_1",
    url: storyUrl,
  }, traceSender);
  assert.deepEqual(response, {
    ok: true,
    snapshot: {
      state: "connected",
      reason: "none",
      canExecuteAuthenticated: true,
    },
    state: "saved",
  });
  assert.equal(trackWrites, 1);
});
