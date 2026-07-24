import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserTraceWebNavigation,
  traceWebNavigationRequestFromMessage,
} from "../../.trace-build/extension-runtime/trace-web-navigation.mjs";
import {
  TraceWebStatusNotification,
} from "../../.trace-build/extension-runtime/trace-web-status.mjs";

const webOrigin = "https://www.tracefiction.com";
const archiveSender = {
  frameId: 0,
  documentLifecycle: "active",
  tab: { url: "https://archiveofourown.org/works/123" },
};

test("archive navigation accepts only an exact configured Trace origin", () => {
  assert.deepEqual(traceWebNavigationRequestFromMessage({
    type: "TRACE_OPEN_TRACE_URL",
    payload: { url: `${webOrigin}/settings/extension` },
  }, archiveSender, webOrigin), {
    kind: "open",
    url: `${webOrigin}/settings/extension`,
  });
  assert.deepEqual(traceWebNavigationRequestFromMessage({
    type: "TRACE_OPEN_TRACE_URL",
    payload: { url: "/settings/extension" },
  }, archiveSender, webOrigin), {
    kind: "open",
    url: `${webOrigin}/settings/extension`,
  });
  for (const url of [
    "https://tracefiction.com.evil.example/settings",
    "https://user:secret@www.tracefiction.com/settings",
    "javascript:alert(1)",
  ]) {
    assert.deepEqual(traceWebNavigationRequestFromMessage({
      type: "TRACE_OPEN_TRACE_URL",
      payload: { url },
    }, archiveSender, webOrigin), { kind: "invalid" });
  }
});

test("archive navigation rejects untrusted frames, credential pages, and loose envelopes", () => {
  const message = {
    type: "TRACE_OPEN_TRACE_URL",
    payload: { url: `${webOrigin}/` },
  };
  assert.equal(traceWebNavigationRequestFromMessage(
    message,
    { ...archiveSender, frameId: 2 },
    webOrigin,
  ), null);
  assert.equal(traceWebNavigationRequestFromMessage(
    message,
    { tab: { url: "https://archiveofourown.org/users/login" } },
    webOrigin,
  ), null);
  assert.equal(traceWebNavigationRequestFromMessage(
    { ...message, unexpected: true },
    archiveSender,
    webOrigin,
  ), null);
  assert.equal(traceWebNavigationRequestFromMessage({
    ...message,
    payload: { ...message.payload, unexpected: true },
  }, archiveSender, webOrigin), null);
});

test("Trace navigation uses both promise and callback browser contracts", async () => {
  const promiseCreates = [];
  const promiseNavigation = new BrowserTraceWebNavigation({
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      async create(options) {
        promiseCreates.push(options);
        return { id: 1, url: options.url };
      },
    },
    mode: "promise",
  });
  assert.equal(await promiseNavigation.open(`${webOrigin}/`), true);
  assert.deepEqual(promiseCreates, [{ url: `${webOrigin}/` }]);

  const callbackCreates = [];
  const callbackNavigation = new BrowserTraceWebNavigation({
    runtime: { lastError: null, onMessage: { addListener() {} } },
    tabs: {
      create(options, callback) {
        callbackCreates.push(options);
        callback({ id: 2, url: options.url });
      },
    },
    mode: "callback",
  });
  assert.equal(await callbackNavigation.open(`${webOrigin}/library`), true);
  assert.deepEqual(callbackCreates, [{ url: `${webOrigin}/library` }]);
});

test("status publication targets only exact configured Trace tabs and is best effort", async () => {
  const sends = [];
  const notification = new TraceWebStatusNotification({
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      async query(query) {
        assert.deepEqual(query, { url: ["https://www.tracefiction.com/*"] });
        return [
          { id: 7, url: `${webOrigin}/setup` },
          { id: 8, url: "https://www.tracefiction.com.evil.example/setup" },
          { id: 9, url: `${webOrigin}/library` },
          { url: `${webOrigin}/missing-tab-id` },
        ];
      },
      async sendMessage(tabId, message) {
        sends.push({ tabId, message });
        if (tabId === 9) throw new Error("receiver has navigated");
      },
    },
    mode: "promise",
    webOrigin,
  });
  const state = {
    installed: true,
    connected: false,
    authState: "reconnect_required",
  };
  assert.equal(await notification.publish(state), true);
  assert.deepEqual(sends, [
    { tabId: 7, message: { type: "TRACE_EXTENSION_STATUS_PUSH", state } },
    { tabId: 9, message: { type: "TRACE_EXTENSION_STATUS_PUSH", state } },
  ]);
});
