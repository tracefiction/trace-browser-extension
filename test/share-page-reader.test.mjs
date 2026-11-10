import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { sharePageReader } from "../scripts/build-share-page-reader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

// Safari evaluates the file in the page, then calls run() with a completion
// function. Everything the page could be asked to do besides being read is
// recorded, and nothing may be: no request, timer, listener, history or
// storage change, and the page's own markup untouched.
async function share(fixture, url, edit = (html) => html) {
  const html = edit(fs.readFileSync(path.join(FIXTURES, fixture), "utf8"));
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const { window } = dom;
  const done = [];
  const record = (what) => (...args) => { done.push([what, ...args.map(String)]); };
  window.fetch = (...args) => { record("fetch")(...args); return Promise.reject(new Error("no requests")); };
  window.XMLHttpRequest = function () { record("xhr")(); };
  window.setTimeout = record("setTimeout");
  window.setInterval = record("setInterval");
  window.EventTarget.prototype.addEventListener = record("listener");
  window.history.replaceState = record("replaceState");
  window.history.pushState = record("pushState");
  for (const change of ["setItem", "removeItem", "clear"]) window.Storage.prototype[change] = record(`storage ${change}`);
  const before = window.document.documentElement.outerHTML;

  window.eval(sharePageReader());
  let results = null;
  window.ExtensionPreprocessingJS.run({ completionFunction: (value) => { results = value; } });
  await tick();

  assert.deepEqual(Object.keys(results), ["tracePage"]);
  // jsdom's selector engine adds two hover listeners of its own the first time it is used.
  assert.deepEqual(done.filter(([, , handler]) => !/Snapshot\.HOVER/.test(handler ?? "")), []);
  assert.equal(window.document.documentElement.outerHTML, before);
  assert.deepEqual(Object.keys(window).filter((key) => /trace/i.test(key)), []);
  const page = JSON.parse(results.tracePage);
  // Story text never leaves the page.
  const plain = (text) => String(text).replace(/\s+/g, " ").trim();
  const handedBack = plain(Object.values(page.item ?? {}).flat().filter((value) => typeof value === "string").join(" "));
  for (const paragraph of window.document.querySelectorAll("#chapters p, #storytext p, #storycontent p")) {
    const text = plain(paragraph.textContent);
    if (text.length >= 40) assert.ok(!handedBack.includes(text.slice(0, 40)), text.slice(0, 40));
  }
  return page;
}

test("reads a FanFiction.net story page as iPhone shows it", async () => {
  const page = await share("ffn_story_mobile.html", "https://m.fanfiction.net/s/13579246/3/?x=1#frag");
  assert.deepEqual(Object.keys(page), ["url", "source", "item"]);
  assert.equal(page.url, "https://m.fanfiction.net/s/13579246/3/");
  assert.equal(page.source, "ffn");
  assert.equal(page.item.ctx, "story");
  assert.equal(page.item.u, "https://www.fanfiction.net/s/13579246/");
  assert.equal(page.item.t, "A Chance Encounter");
  assert.equal(page.item.a, "spectre4hire");
  assert.deepEqual(page.item.fms, ["Harry Potter"]);
  assert.equal(page.item.chn, 3);
  assert.equal(page.item.cht, 28);
  assert.equal(page.item.w, 226000);
});

test("reads a FanFiction.net story page on the desktop site", async () => {
  const page = await share("ffn_story.html", "https://www.fanfiction.net/s/13579246/2/A-Chance-Encounter");
  assert.equal(page.source, "ffn");
  assert.equal(page.item.t, "A Chance Encounter");
  assert.equal(page.item.chn, 2);
});

test("reads an AO3 work with its work and chapter addresses", async () => {
  const page = await share("ao3_story.html", "https://archiveofourown.org/works/123456/chapters/7890");
  assert.equal(page.url, "https://archiveofourown.org/works/123456/chapters/7890");
  assert.equal(page.source, "ao3");
  assert.equal(page.item.u, "https://archiveofourown.org/works/123456");
  assert.equal(page.item.chu, "https://archiveofourown.org/works/123456/chapters/7890");
  assert.equal(page.item.t, "Redivider");
  assert.equal(page.item.a, "Vichan");
  assert.equal(page.item.w, 107493);
  assert.equal(page.item.chn, 1);
  assert.equal(page.item.chPub, 17);
});

test("reads AO3's Entire Work view as chapter 1, and keeps the address plain", async () => {
  const page = await share("ao3_story.html", "https://archiveofourown.org/works/123456?view_full_work=true&view_adult=true#comments");
  assert.equal(page.url, "https://archiveofourown.org/works/123456");
  assert.equal(page.item.chn, 1);
  assert.equal(page.item.chu, null);
});

test("gives back nothing for a page that is not one story", async () => {
  for (const [fixture, url] of [
    ["ao3_listing.html", "https://archiveofourown.org/tags/Foo/works"],
    ["ao3_bookmarks.html", "https://archiveofourown.org/users/reader/bookmarks"],
    ["ao3_history.html", "https://archiveofourown.org/users/reader/readings"],
    ["ffn_listing_mobile.html", "https://m.fanfiction.net/book/Harry-Potter/"],
    ["ffn_listing.html", "https://www.fanfiction.net/book/Harry-Potter/"],
  ]) assert.deepEqual(await share(fixture, url), {}, url);
});

test("gives back nothing for a story address with no story on the page", async () => {
  // AO3's adult content notice, and a story FanFiction.net no longer has.
  assert.deepEqual(await share("ao3_adult_content_notice.html", "https://archiveofourown.org/works/123456"), {});
  assert.deepEqual(await share("ffn_story_not_found_mobile.html", "https://m.fanfiction.net/s/13579246/1/"), {});
  // Pages under a work that are not the work itself.
  for (const rest of ["/bookmarks", "/comments/999", "/edit", "/kudos", "/navigate", "/chapters/7890/edit"]) {
    assert.deepEqual(await share("ao3_story.html", `https://archiveofourown.org/works/123456${rest}`), {}, rest);
  }
  // A collection's name is letters, digits and underscores, as the background takes it.
  assert.equal((await share("ao3_story.html", "https://archiveofourown.org/collections/Yuletide_2025/works/123456")).item.t, "Redivider");
  for (const name of ["a.b", "a%2F..%2Fworks%2F999", "a-b"]) {
    assert.deepEqual(await share("ao3_story.html", `https://archiveofourown.org/collections/${name}/works/123456`), {}, name);
  }
  assert.deepEqual(await share("ao3_listing.html", "https://archiveofourown.org/works/123456/bookmarks"), {});
});

test("gives back nothing on any other site, whatever the page looks like", async () => {
  for (const url of [
    "https://example.com/works/123456",
    "https://archiveofourown.org.evil.example/works/123456",
    "https://evilarchiveofourown.org/works/123456",
    "https://ao3.org/works/123456",
    "http://archiveofourown.org/works/123456",
  ]) assert.deepEqual(await share("ao3_story.html", url), {}, url);
  for (const url of [
    "https://example.com/s/13579246/3/",
    "https://notfanfiction.net/s/13579246/3/",
    "https://m.fanfiction.net.evil.example/s/13579246/3/",
    "https://forums.fanfiction.net/s/13579246/3/",
    "https://fanfiction.net/s/13579246/3/",
    "http://m.fanfiction.net/s/13579246/3/",
  ]) assert.deepEqual(await share("ffn_story_mobile.html", url), {}, url);
});

test("gives back nothing on a page with a password box, except AO3's own header login", async () => {
  const url = "https://archiveofourown.org/works/123456";
  const story = fs.readFileSync(path.join(FIXTURES, "ao3_story.html"), "utf8");
  assert.ok(story.includes("new_user_session_small"), "the saved page has AO3's header login form");
  assert.equal((await share("ao3_story.html", url)).item.t, "Redivider");
  const withPasswordBox = (html) => html.replace("</body>", '<form><input type="PASSWORD" name="p"></form></body>');
  assert.deepEqual(await share("ao3_story.html", url, withPasswordBox), {});
  assert.deepEqual(await share("ao3_story.html", "https://archiveofourown.org/users/login"), {});
});

test("is collector.js up to the end of its reading functions, and says so when they move", () => {
  const collector = fs.readFileSync(path.join(ROOT, "Shared (Extension)", "Resources", "collector.js"), "utf8");
  const reader = sharePageReader(collector);
  assert.ok(reader.includes("function collectAO3Work()"));
  assert.ok(reader.includes("function collectFFNStoryMobile()"));
  for (const later of ["handleCollectorMessage", "reuseOpenStoryTabForTraceLink", "function initQuickAdd"]) {
    assert.ok(!reader.includes(later), later);
  }
  assert.throws(() => sharePageReader("no markers here"), /missing the markers/);
  assert.throws(() => sharePageReader(collector.replace("\nfunction collectForSave(", "\nfunction collectForSaving(")),
    /no longer has collectForSave\(\)/);
});

test("the build script writes the same file, also when run through a link", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "share-page-reader-"));
  try {
    const script = path.join(ROOT, "scripts", "build-share-page-reader.mjs");
    const link = path.join(directory, "linked");
    fs.symlinkSync(path.join(ROOT, "scripts"), link);
    for (const [run, name] of [[script, "direct.js"], [path.join(link, "build-share-page-reader.mjs"), "nested/linked.js"]]) {
      const output = path.join(directory, name);
      execFileSync(process.execPath, [run, output]);
      assert.equal(fs.readFileSync(output, "utf8"), sharePageReader(), name);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
