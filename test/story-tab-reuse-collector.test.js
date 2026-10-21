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

// trace-open-veil.js runs at document_start, collector.js at document_end.
const VEIL = fs.readFileSync(
  path.join(__dirname, "..", "Shared (Extension)", "Resources", "trace-open-veil.js"),
  "utf8",
);
const VEIL_LONGEST_MS = 1200;

function open(url, { body = "", referrer, before, reply, veil = true, collector = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><p id="story">${body}</p></body></html>`, {
    url,
    runScripts: "outside-only",
    ...(referrer ? { referrer } : {}),
  });
  const { window } = dom;
  const sent = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        sent.push(JSON.parse(JSON.stringify(message)));
        if (message.type === REUSE && reply) return reply(window, callback);
        if (callback) callback({ ok: true, reused: false, closed: false });
      },
      lastError: null,
    },
  };
  // The veil's own limit, run by hand; every other timer runs as it would.
  const caps = [];
  const setTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...rest) => {
    if (delay === VEIL_LONGEST_MS) {
      caps.push(callback);
      return -caps.length;
    }
    return setTimeout(callback, delay, ...rest);
  };
  const clearTimeout = window.clearTimeout.bind(window);
  window.clearTimeout = (id) => {
    if (typeof id === "number" && id < 0) caps[-id - 1] = null;
    else clearTimeout(id);
  };
  if (before) before(window);
  if (veil) window.eval(VEIL);
  const hiddenAtStart = isHidden(window);
  if (collector) window.eval(COLLECTOR);
  return {
    window,
    sent,
    hiddenAtStart,
    hidden: () => isHidden(window),
    expire: () => caps.splice(0).forEach((callback) => callback && callback()),
    close: () => window.close(),
  };
}

function isHidden(window) {
  const veils = window.document.querySelectorAll("style#trace-open-veil");
  const story = window.document.getElementById("story");
  const hidden = window.getComputedStyle(story).visibility === "hidden";
  assert.equal(hidden, veils.length > 0, "the page is hidden exactly while the veil is in it");
  return hidden;
}

const CHAPTER = "https://archiveofourown.org/works/123/chapters/456#trace-open";

test("a marked page Safari has just opened is hidden from the start, with no motion to reduce", () => {
  const page = open(CHAPTER, { collector: false });
  assert.equal(page.hiddenAtStart, true);
  const veil = page.window.document.getElementById("trace-open-veil");
  assert.equal(veil.parentNode, page.window.document.documentElement);
  assert.equal(veil.textContent, "html,html *{visibility:hidden!important}");
  assert.doesNotMatch(veil.textContent, /transition|animation|@media|reduced-motion/);
  assert.equal(page.window.location.hash, "#trace-open", "the mark is left for collector.js");
  page.close();
});

test("a tab the background closes for an open one stays hidden until it is gone", () => {
  const page = open(CHAPTER, { reply: (_, callback) => callback({ ok: true, reused: true, closed: true }) });
  assert.equal(page.window.location.href, "https://archiveofourown.org/works/123/chapters/456");
  assert.equal(page.sent.filter((message) => message.type === REUSE).length, 1);
  assert.equal(page.hidden(), true);
  page.expire();
  assert.equal(page.hidden(), false, "and is never left hidden");
  page.close();
});

test("with no tab to reuse, or one brought forward without this one closing, the page shows at once", () => {
  for (const answer of [
    { ok: true, reused: false, closed: false },
    { ok: true, reused: true, closed: false },
    { ok: false, reused: false, closed: false },
    null,
    undefined,
  ]) {
    const page = open(CHAPTER, { reply: (_, callback) => callback(answer) });
    assert.equal(page.hiddenAtStart, true);
    assert.equal(page.hidden(), false, JSON.stringify(answer));
    page.close();
  }
});

test("a message that fails shows the page at once", () => {
  const thrown = open(CHAPTER, { reply: () => { throw new Error("no background"); } });
  assert.equal(thrown.hidden(), false);
  thrown.close();

  const refused = open(CHAPTER, {
    reply: (window, callback) => {
      window.chrome.runtime.lastError = { message: "Could not establish connection." };
      callback(undefined);
      window.chrome.runtime.lastError = null;
    },
  });
  assert.equal(refused.hidden(), false);
  refused.close();
});

test("an answer that never comes leaves the page hidden for at most the veil's limit", () => {
  const page = open(CHAPTER, { reply: () => {} });
  assert.equal(page.hidden(), true);
  page.expire();
  assert.equal(page.hidden(), false);
  page.close();

  // The limit holds even when collector.js never runs.
  const alone = open(CHAPTER, { collector: false });
  assert.equal(alone.hidden(), true);
  alone.expire();
  assert.equal(alone.hidden(), false);
  alone.close();
});

test("a hidden page restored from the back-forward cache shows again", () => {
  const page = open(CHAPTER, { reply: () => {} });
  page.window.dispatchEvent(new page.window.PageTransitionEvent("pageshow", { persisted: false }));
  assert.equal(page.hidden(), true);
  page.window.dispatchEvent(new page.window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.equal(page.hidden(), false);
  page.close();
});

test("a page without the mark, or not just opened for it, is never hidden", () => {
  const cases = [
    ["https://archiveofourown.org/works/123/chapters/456", {}],
    ["https://archiveofourown.org/works/123/chapters/456#trace-open-later", {}],
    [CHAPTER, { referrer: "https://archiveofourown.org/works/123/chapters/455" }],
    [CHAPTER, { before: (window) => window.history.pushState(null, "", "/works/123/chapters/456#trace-open") }],
    [CHAPTER, { before: (window) => Object.defineProperty(window.performance, "now", { value: () => 60_000 }) }],
    [CHAPTER, { before: (window) => Object.defineProperty(window.document, "prerendering", { value: true }) }],
  ];
  for (const [url, options] of cases) {
    const page = open(url, { ...options, reply: () => {} });
    assert.equal(page.hiddenAtStart, false, url);
    assert.equal(page.hidden(), false, url);
    page.close();
  }
});

test("a page collector.js will not ask for is shown as soon as it decides", () => {
  // A password field is only known once the page is read.
  const page = open(CHAPTER, { body: '<input type="password">', reply: () => {} });
  assert.equal(page.hiddenAtStart, true);
  assert.equal(page.sent.filter((message) => message.type === REUSE).length, 0);
  assert.equal(page.hidden(), false);
  page.close();

  const manual = open(CHAPTER, {
    before: (window) => { window.TRACE_PAGE_MANUAL_MODE = true; },
    reply: () => {},
  });
  assert.equal(manual.hidden(), false);
  manual.close();
});

test("a page shown again after the veil does the same document_end work as one never hidden", async () => {
  const types = (page) => page.sent.map((message) => message.type).filter((type) => type !== REUSE);
  const veiled = open(CHAPTER, { reply: (_, callback) => callback({ ok: true, reused: false, closed: false }) });
  const plain = open(CHAPTER, {
    veil: false,
    reply: (_, callback) => callback({ ok: true, reused: false, closed: false }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(plain.hiddenAtStart, false);
  assert.equal(veiled.hidden(), false);
  assert.ok(types(plain).length > 0, "the page sends its usual messages");
  assert.deepEqual(types(veiled), types(plain));
  assert.equal(
    veiled.window.document.documentElement.outerHTML,
    plain.window.document.documentElement.outerHTML,
    "and is left as it would have been",
  );
  veiled.close();
  plain.close();
});
