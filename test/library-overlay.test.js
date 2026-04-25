const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const vm = require("node:vm");

const FIXTURES = path.join(__dirname, "fixtures");
const KEYS_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "library-overlay-keys.js",
);

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function loadKeyFn() {
  const src = fs.readFileSync(KEYS_PATH, "utf8");
  const ctx = {
    console,
    URL: global.URL,
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.equal(typeof ctx.traceExternalStoryKeyFromUrl, "function");
  return ctx.traceExternalStoryKeyFromUrl;
}

test("library-overlay-keys match AO3/FFN URLs", () => {
  const keyFn = loadKeyFn();
  const ao3 = keyFn("https://archiveofourown.org/works/28534965");
  assert.equal(ao3.platform, "ao3");
  assert.equal(ao3.workId, "28534965");
  assert.equal(ao3.key, "ao3:28534965");
  const ffn = keyFn("https://www.fanfiction.net/s/123/1/Some-Title");
  assert.equal(ffn.platform, "ffn");
  assert.equal(ffn.workId, "123");
  assert.equal(ffn.key, "ffn:123");
});

test("fixture ao3_listing: work links resolve to ao3 keys", () => {
  const keyFn = loadKeyFn();
  const dom = new JSDOM(loadFixture("ao3_listing.html"), {
    url: "https://archiveofourown.org/works?tag_id=Harry+Potter",
    contentType: "text/html",
  });
  const anchors = dom.window.document.querySelectorAll(
    'a[href*="/works/"]',
  );
  assert.ok(anchors.length > 0);
  const keys = new Set();
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href || href.includes("/users/")) continue;
    try {
      const abs = new URL(href, dom.window.location.href).href;
      const k = keyFn(abs);
      if (k) keys.add(k.key);
    } catch {
      /* ignore bad href */
    }
  }
  assert.ok(keys.size > 0, "expected at least one ao3 work key from listing fixture");
  assert.ok([...keys].some((k) => /^ao3:\d+$/.test(k)));
});

test("fixture ffn_listing: story links resolve to ffn keys", () => {
  const keyFn = loadKeyFn();
  const dom = new JSDOM(loadFixture("ffn_listing.html"), {
    url: "https://www.fanfiction.net/book/Harry-Potter/",
    contentType: "text/html",
  });
  const anchors = dom.window.document.querySelectorAll('a[href*="/s/"]');
  assert.ok(anchors.length > 0);
  let found = false;
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    try {
      const abs = new URL(href, dom.window.location.href).href;
      const k = keyFn(abs);
      if (k && k.platform === "ffn") {
        found = true;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  assert.ok(found, "expected at least one ffn key from listing fixture");
});
