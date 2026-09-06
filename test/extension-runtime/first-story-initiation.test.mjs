import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  BrowserFirstStoryInitiator,
  firstStoryInitiationFromMessage,
  isPopupSender,
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

test("popup ownership accepts trusted Safari resource URLs without Chrome-shaped sender ids", () => {
  assert.equal(isPopupSender({
    url: "safari-web-extension://com.tracefiction.trace.Extension/popup.html",
  }, runtimeId), true);
  assert.equal(isPopupSender({
    id: "com.tracefiction.trace.Extension",
    url: "safari-web-extension://9A87D1E4/Resources/popup.html",
  }, runtimeId), true);
  assert.equal(isPopupSender({
    id: runtimeId,
  }, runtimeId), true);

  assert.equal(isPopupSender({
    id: runtimeId,
    url: "https://archiveofourown.org/popup.html",
    tab: { url: "https://archiveofourown.org/works/123" },
  }, runtimeId), false);
  assert.equal(isPopupSender({
    id: runtimeId,
    url: "safari-web-extension://com.tracefiction.trace.Extension/settings.html",
  }, runtimeId), false);
  assert.equal(isPopupSender({ id: "another-extension" }, runtimeId), false);
});

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

const importPlatforms = [
  { name: 'iOS platform API', info: { os: 'ios' }, native: true },
  { name: 'iOS UA without platform API', missing: true, native: true, userAgent: 'iPad' },
  { name: 'confirmed macOS', info: { os: 'mac' } },
  { name: 'confirmed Windows', info: { os: 'win' } },
  { name: 'confirmed Linux', info: { os: 'linux' } },
  { name: 'missing platform API', missing: true, unknown: true },
  { name: 'rejected platform API', rejects: true, unknown: true },
  { name: 'unrecognized platform', info: { os: 'unexpected' }, unknown: true },
  { name: 'empty platform result', info: undefined, unknown: true },
];
for (const candidate of [false, true]) {
  for (const platform of importPlatforms) {
  test(`${platform.name}, native candidate=${candidate} selects only its configured Import transport`, async (t) => {
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      userAgent: platform.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    } });
    t.after(() => { if (navigator) Object.defineProperty(globalThis, 'navigator', navigator); else delete globalThis.navigator; });
    const { factory, database } = await seededDatabase();
    const native = []; const created = [];
    let collected = 0;
    const handoffID = "00000000-0000-4000-8000-000000000099";
    let expiry = 0;
    let ids = 0;
    const runtime = {
      id: runtimeId, onMessage: { addListener() {} },
      ...(platform.missing ? {} : { async getPlatformInfo() {
        if (platform.rejects) throw new Error('platform unavailable');
        return platform.info;
      } }),
      async sendNativeMessage(...args) {
        const message = args.find((value) => value && typeof value === "object");
        if (message.type === "TRACE_IOS_AUTH_TOKEN_REQUEST") return { ok: true, credential: "private-token", credentialKind: "device_session", sessionId: handoffID, expiresAt: "2030-01-01T00:00:00Z" };
        if (message.type === "TRACE_IOS_IMPORT_PREPARE") {
          native.push(message); expiry = Date.now() + 600000;
          return { type: message.type, ok: true, protocolVersion: 1, state: "prepared", handoffID,
            expiresAtMs: expiry, maximumPayloadBytes: 524288, maximumItems: 250 };
        }
        if (message.type === "TRACE_IOS_IMPORT_STAGE") {
          native.push(message);
          return { type: message.type, ok: true, protocolVersion: 1, state: "ready_to_open", handoffID, expiresAtMs: expiry };
        }
        return { ok: false };
      },
    };
    const controller = installSessionRuntime({
      mode: "kernel", runtime, nativeImportHandoff: candidate,
      tabs: {
        async query() { return [{ id: 1, url: storyUrl }]; },
        async create(value) { created.push(value); return { id: 2 }; },
        async sendMessage() { collected += 1; return { ok: true, payload: { s: "ffn", at: "synthetic",
          items: [{ src: "ffn", u: storyUrl }] } }; },
      },
      alarms: { async clear() { return true; } }, storageArea: new StorageArea(),
      databaseFactory: factory, privateDatabase: database, storageMode: "promise",
      fetch: async (url) => new Response(JSON.stringify(new URL(url).pathname === "/api/extension/account"
        ? { account_id: "account-a" }
        : { success: true, data: { entries: {}, workPreferences: {}, syncVersion: "1970-01-01T00:00:00.000Z" } }), { status: 200 }),
      apiBase: "https://development.example.test", webOrigin,
      randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    });
    await controller.start();
    const response = await controller.handle({ type: "TRACE_IMPORT_TRIGGER", accountID: "untrusted" }, popupSender);
    const selected = candidate && platform.native;
    const blocked = candidate && platform.unknown;
    assert.equal(response.ok, !blocked);
    assert.equal(response.state, blocked ? undefined : selected ? "ready_to_open" : "opened");
    assert.equal(response.error, blocked ? 'native_import_unavailable' : undefined);
    assert.equal(created.length, selected || blocked ? 0 : 1);
    assert.equal(collected, blocked ? 0 : 1);
    assert.equal(native.length, selected ? 2 : 0);
    assert.equal(Object.hasOwn(response.snapshot, "accountId"), false);
    if (selected) {
      assert.equal(native[0].accountID, "account-a");
      assert.equal(native[0].apiOrigin, "https://development.example.test");
      assert.equal(response.handoffID, handoffID);
    }
    const denied = await controller.handle({ type: "TRACE_IMPORT_TRIGGER" }, {
      id: runtimeId, frameId: 0, tab: { url: storyUrl }, url: storyUrl });
    assert.equal(denied, null);
    if (blocked) {
      runtime.getPlatformInfo = async () => ({ os: 'ios' });
      const recovered = await controller.handle({ type: 'TRACE_IMPORT_TRIGGER' }, popupSender);
      assert.equal(recovered.state, 'ready_to_open', 'unknown detection is not cached as a permanent routing decision');
      assert.equal(created.length, 0);
      assert.equal(collected, 1);
    }
  });
  }
}
