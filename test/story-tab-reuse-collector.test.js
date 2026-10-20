const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const COLLECTOR = fs.readFileSync(
  path.join(__dirname, "..", "Shared (Extension)", "Resources", "collector.js"),
  "utf8",
);
const REUSE = "TRACE_STORY_TAB_REUSE";

function load(url, { body = "", referrer, before } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    url,
    runScripts: "outside-only",
    ...(referrer ? { referrer } : {}),
  });
  const sent = [];
  dom.window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        sent.push(JSON.parse(JSON.stringify(message)));
        if (callback) callback({ ok: true, reused: false, closed: false });
      },
      lastError: null,
    },
  };
  if (before) before(dom.window);
  dom.window.eval(COLLECTOR);
  const asks = sent.filter((message) => message.type === REUSE);
  const href = dom.window.location.href;
  dom.window.close();
  return { asks, href };
}

test("a story link the Trace app opened loses its mark and asks for the open tab", () => {
  const { asks, href } = load("https://archiveofourown.org/works/123/chapters/456#trace-open");
  assert.equal(href, "https://archiveofourown.org/works/123/chapters/456");
  assert.deepEqual(asks, [{ type: REUSE, payload: { url: "https://archiveofourown.org/works/123/chapters/456" } }]);

  const ffn = load("https://www.fanfiction.net/s/789/4/Title#trace-open");
  assert.equal(ffn.href, "https://www.fanfiction.net/s/789/4/Title");
  assert.deepEqual(ffn.asks, [{ type: REUSE, payload: { url: "https://www.fanfiction.net/s/789/4/Title" } }]);
});

test("the mark keeps the page's query, such as AO3's whole-work view", () => {
  const { asks, href } = load("https://archiveofourown.org/works/123?view_full_work=true#trace-open");
  assert.equal(href, "https://archiveofourown.org/works/123?view_full_work=true");
  assert.equal(asks[0].payload.url, href);
});

test("a page without the mark, or with another fragment, never asks and keeps its address", () => {
  for (const url of [
    "https://archiveofourown.org/works/123/chapters/456",
    "https://archiveofourown.org/works/123/chapters/456#workskin",
    "https://archiveofourown.org/works/123/chapters/456#trace-open-later",
  ]) {
    const { asks, href } = load(url);
    assert.equal(href, url);
    assert.deepEqual(asks, [], url);
  }
});

test("a marked page the reader reached from another page is cleaned but never asks", () => {
  const followed = load("https://archiveofourown.org/works/123/chapters/456#trace-open", {
    referrer: "https://archiveofourown.org/works/123/chapters/455",
  });
  assert.equal(followed.href, "https://archiveofourown.org/works/123/chapters/456");
  assert.deepEqual(followed.asks, []);

  const withHistory = load("https://archiveofourown.org/works/123/chapters/456#trace-open", {
    before: (window) => {
      window.history.pushState(null, "", "/works/123/chapters/456#trace-open");
    },
  });
  assert.equal(withHistory.href, "https://archiveofourown.org/works/123/chapters/456");
  assert.deepEqual(withHistory.asks, []);
});

test("a marked page that has been open a while, or that holds a password field, never asks", () => {
  const late = load("https://archiveofourown.org/works/123/chapters/456#trace-open", {
    before: (window) => {
      Object.defineProperty(window.performance, "now", { value: () => 60_000 });
    },
  });
  assert.equal(late.href, "https://archiveofourown.org/works/123/chapters/456");
  assert.deepEqual(late.asks, []);

  const password = load("https://archiveofourown.org/works/123/chapters/456#trace-open", {
    body: '<form><input type="password"></form>',
  });
  assert.equal(password.href, "https://archiveofourown.org/works/123/chapters/456");
  assert.deepEqual(password.asks, []);
});
