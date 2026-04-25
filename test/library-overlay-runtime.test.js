const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const KEYS_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "library-overlay-keys.js",
);
const OVERLAY_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "library-overlay.js",
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("library-overlay reruns when listing links are inserted after initial render", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://m.fanfiction.net/book/Harry-Potter/",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  assert.equal(
    window.document.querySelectorAll("[data-trace-library-overlay-wrap]").length,
    0,
  );

  const root = window.document.getElementById("root");
  root.innerHTML =
    '<div class="bs brb"><a href="/s/123/1/Test-Story">Test Story</a> by <a href="/u/1/TestAuthor">TestAuthor</a></div>';

  await sleep(180);

  const wraps = window.document.querySelectorAll(
    "[data-trace-library-overlay-wrap]",
  );
  assert.equal(wraps.length, 1);
  assert.match(wraps[0].textContent || "", /\+ ADD/i);
});

test("library-overlay exits on pages with password fields", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><input type='password'><main id='root'><a href='/works/12345'>Demo Work</a></main></body></html>",
    {
      url: "https://archiveofourown.org/users/login",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  let storageReadCount = 0;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          storageReadCount += 1;
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  await sleep(180);

  assert.equal(storageReadCount, 0);
  assert.equal(
    window.document.querySelectorAll("[data-trace-library-overlay-wrap]").length,
    0,
  );
});

test("library-overlay decorates listing links even without overlay-keys global", async () => {
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  const root = window.document.getElementById("root");
  root.innerHTML =
    '<ol class="work index group"><li class="work blurb group"><h4 class="heading"><a href="/works/12345">Demo Work</a></h4></li></ol>';

  await sleep(180);

  const wraps = window.document.querySelectorAll(
    "[data-trace-library-overlay-wrap]",
  );
  assert.equal(wraps.length, 1);
  assert.match(wraps[0].textContent || "", /\+ ADD/i);
});

test("library-overlay FFN fallback quick-add includes mobile row summary text", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://m.fanfiction.net/book/Harry-Potter/",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  let sentPayload = null;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sentPayload = msg && msg.payload ? msg.payload : null;
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  const root = window.document.getElementById("root");
  root.innerHTML =
    '<div class="bs brb"><a href="/s/7038840/1/A-Chance-Encounter">A Chance Encounter</a> by <a href="/u/593152/devilblondie">devilblondie</a> WIP. Harry makes a different choice in King\\\'s Cross and is given a second chance.<div class="gray">T, English, Drama, chapters: 28, words: 226k+</div></div>';

  await sleep(220);

  const button = window.document.querySelector(
    "[data-trace-library-overlay-wrap] button[data-trace-quick-add]",
  );
  assert.ok(button, "expected quick-add button for FFN mobile listing row");
  button.click();

  assert.ok(sentPayload && sentPayload.item, "expected TRACE_QUICK_ADD payload");
  assert.equal(sentPayload.item.src, "ffn");
  assert.equal(sentPayload.item.ctx, "listing");
  assert.match(sentPayload.item.sm || "", /King\\'s Cross/i);
});

test("library-overlay FFN fallback quick-add includes desktop listing summary", async () => {
  const keysSrc = fs.readFileSync(KEYS_PATH, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY_PATH, "utf8");
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='root'></main></body></html>",
    {
      url: "https://www.fanfiction.net/book/Harry-Potter/",
      runScripts: "outside-only",
      contentType: "text/html",
    },
  );

  const { window } = dom;
  let sentPayload = null;
  const chrome = {
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            authToken: "test-token",
            prefLibraryInlayEnabled: true,
            traceAuthState: { state: "connected" },
            libraryOverlayCache: { entries: {} },
          });
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sentPayload = msg && msg.payload ? msg.payload : null;
        if (typeof cb === "function") cb({ ok: true });
      },
    },
  };

  window.chrome = chrome;
  window.browser = chrome;
  window.eval(keysSrc);
  window.eval(overlaySrc);

  window.document.dispatchEvent(
    new window.Event("DOMContentLoaded", { bubbles: true }),
  );
  const root = window.document.getElementById("root");
  root.innerHTML =
    '<div class="z-list"><a class="stitle" href="/s/3659524/1/A-Shadowed-Soul">A Shadowed Soul</a> by <a href="/u/593152/devilblondie">devilblondie</a><div class="z-indent">He was abandoned at a young age, the world believed him dead.</div><div class="xgray">Rated: Fiction T - English - Chapters: 26</div></div>';

  await sleep(220);

  const button = window.document.querySelector(
    "[data-trace-library-overlay-wrap] button[data-trace-quick-add]",
  );
  assert.ok(button, "expected quick-add button for FFN desktop listing row");
  button.click();

  assert.ok(sentPayload && sentPayload.item, "expected TRACE_QUICK_ADD payload");
  assert.equal(sentPayload.item.src, "ffn");
  assert.equal(sentPayload.item.ctx, "listing");
  assert.match(sentPayload.item.sm || "", /abandoned at a young age/i);
});
