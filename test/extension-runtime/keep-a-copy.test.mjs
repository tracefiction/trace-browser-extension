import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";

import { PAGE_GAP_MS, RETRY_BASE_MS } from "../../.trace-build/extension-runtime/ao3-history-import.mjs";
import {
  AO3_ORIGIN,
  CHECK_EVERY_MS,
  CHECKED_KEEP_COUNT,
  CHECKED_KEEP_MS,
  COPY_FOLDER,
  KeepACopy,
  classifyAnswer,
  copyFilename,
  formTriggerFor,
  greetedUser,
  isEpub,
  listPageURL,
  readDownloadLink,
  readListPage,
  readWorkPage,
  MAX_ATTEMPTS,
  MAX_NAME_BYTES,
  PACE_GAP_MS,
  PACE_MIN_WORKS,
  RETRYABLE_SKIPS,
  WORK_PACE_MS,
  SETTLE_MAX_MS,
  STOP_MAX_MS,
  LINK_MAX_AGE_MS,
  LOCKED_VERSION_BASE,
  lockedFileURL,
  lockedVersion,
  readChapterIndex,
  STOP_MS,
  safeSegment,
} from "../../.trace-build/extension-runtime/keep-a-copy.mjs";
import { CLAIM_MS, fromOffscreenAnswer, offscreenFetcher, requestAO3, toOffscreenAnswer } from "../../.trace-build/extension-runtime/keep-a-copy-fetch.mjs";
import { reliableSender, signedInUser, tellsUser, watchForms } from "../../.trace-build/extension-runtime/keep-a-copy-page.mjs";
import { downloadPorts, installKeepACopy, isOurFile, offscreenKeeper, ownDownload, repeatedMessage } from "../../.trace-build/extension-runtime/keep-a-copy-runtime.mjs";
import { ICON_SIZES, NAME, keepACopyManifest, writeIcons } from "../../scripts/build-keep-a-copy.mjs";

// Invented works and people throughout, in the markup of AO3's pages, not a capture.
const USER = "Synthetic_Reader";
const NOW = Date.parse("2026-10-29T10:00:00Z");

function workPage(id, { updatedAt = "1761700000", title = `Invented work ${id}`, chapters = "3/10", restricted = false, signedIn = true } = {}) {
  // A file name: the title cut to 24 characters, spaces as underscores.
  const link = (ext) => `\n          <li><a href="/downloads/${id}/Invented_work.${ext}?updated_at=${updatedAt}">${ext.toUpperCase()}</a></li>`;
  return `<html><body class="${signedIn ? "logged-in" : "logged-out"}"><ul id="greeting"><li class="dropdown"><a href="/users/${USER}">Hi, ${USER}!</a></li></ul>` +
    `<ul class="work navigation actions" role="menu"><li class="bookmark"><a class="bookmark_form_placement_open" href="#bookmark-form">Bookmark</a></li>` +
    `<li class="download"><noscript><h4 class="heading">Download</h4></noscript><button class="hidden">Download</button>\n      <ul class="expandable secondary">` +
    `${["azw3", "epub", "mobi", "pdf", "html"].map(link).join("")}\n      </ul>\n    </li>\n</ul>\n<!-- END navigation -->` +
    `<div class="wrapper"><dl class="work meta group"><dt class="fandom tags">Fandom:</dt><dd class="fandom tags"><ul class="commas"><li><a class="tag" href="/tags/x/works">Invented Lanterns</a></li></ul></dd>` +
    `<dt class="stats">Stats:</dt><dd class="stats"><dl class="stats"><dt class="chapters">Chapters:</dt><dd class="chapters">${chapters}</dd></dl></dd></dl></div>` +
    `<div class="preface group">\n  <h2 class="title heading">\n    ${restricted ? '<img alt="(Restricted)" title="Restricted" src="/images/lockblue.png" width="15" height="15" />\n    ' : ""}${title}\n  </h2>` +
    `\n  <h3 class="byline heading">\n    <a rel="author" href="/users/Quill/pseuds/Quill">Synthetic_Quill</a>\n  </h3></div></body></html>`;
}

function listRow(row) {
  const { id, updatedAt = "1761700000", chapters = "3/10", kind = "bookmark", restricted = false } = typeof row === "string" ? { id: row } : row;
  const [now, total] = chapters.split("/");
  const shown = Number(now) > 1 ? `<a href="/works/${id}/chapters/9">${now}</a>/${total}` : `${now}/${total}`;
  const open = kind === "bookmark"
    ? `<li id="bookmark_${id}0" class="bookmark blurb group work-${id} user-1" role="article">`
    : `<li id="work_${id}" class="reading work blurb group work-${id} user-2" role="article">`;
  return `${open}\n  <div class="header module">\n    <!-- updated_at=${updatedAt} -->\n    <h4 class="heading">\n      <a href="/works/${id}">Invented ${id}</a>\n      by\n      <!-- do not cache -->\n      <a rel="author" href="/users/Quill/pseuds/Quill">Quill</a>\n      ${restricted ? '<img alt="(Restricted)" title="Restricted" src="/images/lockblue.png" width="15" height="15" />' : ""}\n    </h4>` +
    `\n    <h5 class="fandoms heading"><a class="tag" href="/tags/x/works">Invented Lanterns</a></h5>\n    <p class="datetime">3 days ago</p>\n  </div>` +
    `<dl class="stats"><dt class="words">Words:</dt><dd class="words">12,345</dd><dt class="chapters">Chapters:</dt><dd class="chapters">${shown}</dd></dl></li>`;
}

// Every list marks its Next link with `li.next`.
function listPage(rows, { next = false, kind = "bookmark" } = {}) {
  return `<ol class="bookmark index group">${rows.map((row) => listRow(typeof row === "string" ? { id: row, kind } : { kind, ...row })).join("")}</ol>` +
    `<h4 class="landmark heading">Pages Navigation</h4><ol class="pagination actions" role="navigation"><li class="previous"><span class="disabled">← Previous</span></li>` +
    `<li class="next">${next ? `<a href="/users/${USER}/bookmarks?page=2">Next →</a>` : `<span class="disabled">Next →</span>`}</li></ol>`;
}

function epub(size = 2_000) {
  const bytes = new Uint8Array(size);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  bytes.set(new TextEncoder().encode("mimetypeapplication/epub+zip"), 30);
  return bytes;
}

const html = (url, text, status = 200, headers = {}) => ({
  kind: "response", status, url, contentType: "text/html; charset=utf-8", retryAfter: null, cfMitigated: null, text, ...headers,
});
/** A file's blob URL, one per file URL, holding no part of it, as a real one holds none. */
const handles = new Map();
const handleOf = (url) => `blob:keep-a-copy/${handles.get(url) ?? handles.set(url, handles.size + 1).get(url)}`;
const file = (url, bytes, status = 200) => ({
  kind: "response", status, url, contentType: "application/epub+zip", retryAfter: null, cfMitigated: null,
  bytes: bytes.slice(0, 8_192), size: bytes.length, handle: handleOf(url),
});
const workURL = (id) => `${AO3_ORIGIN}/works/${id}?view_adult=true`;
const LOGIN_URL = `${AO3_ORIGIN}/users/login?restricted=true`;
const navigateURL = (id) => `${AO3_ORIGIN}/works/${id}/navigate`;

/** A work's Chapter Index: `chapters` as [chapter id, YYYY-MM-DD]. */
function chapterIndex(id, { chapters = [["101", "2026-10-01"]], title = `Invented work ${id}`, signedIn = true } = {}) {
  return `<html><body class="${signedIn ? "logged-in" : "logged-out"}"><div id="main" class="works-navigate region">` +
    `<h2 class="heading">Chapter Index for <a href="/works/${id}">${title}</a> by <a rel="author" href="/users/Quill/pseuds/Quill">Synthetic_Quill</a></h2>` +
    `<ol class="chapter index group" role="navigation">` +
    chapters.map(([cid, date], i) => `<li><a href="/works/${id}/chapters/${cid}">${i + 1}. Chapter ${i + 1}</a> <span class="datetime">(${date})</span></li>`).join("") +
    `</ol></div></body></html>`;
}
const dayOf = (date) => Date.parse(`${date}T00:00:00Z`) / 1_000;
const loginPage = () => html(LOGIN_URL, '<body class="logged-out"><form id="new_user" action="/users/login" method="post"></form></body>');

/**
 * A page as a request made signed out meets it in these tests: a logged-out
 * page, and, for a locked work, the sign-in page.
 */
function signedOut(result) {
  if (result?.kind !== "response" || typeof result.text !== "string") return result;
  if (/<h2 class="title heading">\s*<img alt="\(Restricted\)"/.test(result.text)) return loginPage();
  return { ...result, text: result.text.replace('<body class="logged-in">', '<body class="logged-out">') };
}

function harness(answers = {}) {
  // `modes`, `fileModes`: each page and file request's credentials mode.
  const box = { now: NOW, stored: undefined, saved: [], removed: [], released: [], requests: [], modes: [], fileModes: [], quiet: [], downloads: new Map() };
  let nextId = 1;
  const answer = async (url) => {
    box.requests.push(url);
    const value = answers[url];
    const result = typeof value === "function" ? value() : value;
    return result ?? html(url, "<h2>Error 404</h2>", 404);
  };
  box.ports = {
    clock: { now: () => box.now },
    random: () => 0,
    read: async () => structuredClone(box.stored),
    write: async (state) => { box.stored = structuredClone(state); },
    fetchPage: async (url, credentials) => {
      // No Keep a Copy request reads a work's page or a chapter signed in.
      assert.ok(credentials === "omit" || !/\/works\/[0-9]+(?:[?#]|$|\/chapters\/)/.test(url), `${url} read signed in`);
      box.modes.push([url, credentials]);
      const result = await answer(url);
      return credentials === "omit" ? signedOut(result) : result;
    },
    fetchFile: async (url, credentials) => {
      box.fileModes.push([url, credentials]);
      return answer(url);
    },
    save: async (request) => {
      box.saved.push(request);
      const id = nextId++;
      box.downloads.set(id, "complete");
      return id;
    },
    settle: async (id) => ({ state: box.downloads.get(id) ?? "interrupted", filename: `/home/reader/Downloads/${box.saved[id - 1]?.filename}` }),
    release: (handle) => box.released.push(handle),
    remove: async (id) => { box.removed.push(id); },
    quiet: (on) => box.quiet.push(on),
  };
  box.engine = new KeepACopy(box.ports);
  /** Runs ticks, moving the clock on by each wait, until idle or `max` requests. */
  box.drain = async (max = 50) => {
    for (let i = 0; i < max; i += 1) {
      const wait = await box.engine.tick();
      if (wait === null) return;
      box.now += wait;
    }
  };
  return box;
}

const epubLink = (id, updatedAt = "1761700000") => `${AO3_ORIGIN}/downloads/${id}/Invented_work.epub?updated_at=${updatedAt}`;

// --- Pages --------------------------------------------------------------------------

test("reads the Download menu, on AO3's own hosts only", () => {
  assert.deepEqual(readDownloadLink("/downloads/123/A_Title.epub?updated_at=1761700000"), {
    workId: "123", format: "epub", link: { url: epubLink("123").replace("Invented_work", "A_Title"), updatedAt: "1761700000" },
  });
  assert.equal(readDownloadLink("https://download.archiveofourown.org/downloads/9/T.pdf?updated_at=1&amp;x=1")?.format, "pdf");
  assert.equal(readDownloadLink("https://example.org/downloads/9/T.epub?updated_at=1"), null);
  assert.equal(readDownloadLink("http://archiveofourown.org/downloads/9/T.epub?updated_at=1"), null);
  assert.equal(readDownloadLink("/downloads/9/T.exe?updated_at=1"), null);
  assert.equal(readDownloadLink("/downloads/9/T.epub"), null);
});

test("reads a work page's title, author, fandom, chapters and every format", () => {
  const page = readWorkPage(workPage("123", { title: "Lanterns &amp; Tide" }));
  assert.equal(page.workId, "123");
  assert.equal(page.title, "Lanterns & Tide");
  assert.equal(page.author, "Synthetic_Quill");
  assert.equal(page.fandom, "Invented Lanterns");
  assert.equal(page.complete, false);
  assert.deepEqual(Object.keys(page.downloads).sort(), ["azw3", "epub", "html", "mobi", "pdf"]);
  assert.equal(readWorkPage(workPage("5", { chapters: "10/10" })).complete, true);
  assert.equal(readWorkPage(workPage("5", { chapters: "4/?" })).complete, false);
  const locked = readWorkPage(workPage("5", { title: "Locked", restricted: true }));
  assert.equal(locked.title, "Locked");
  assert.equal(locked.restricted, true);
  assert.equal(readWorkPage(workPage("5")).restricted, false);
  // An older menu, as a January 2021 Wayback capture shows it: a plain link, spaces as %20.
  const older = '<li class="download" aria-haspopup="true">\n      <a href="#">Download</a>\n      <ul class="expandable secondary">\n' +
    '          <li><a href="/downloads/4242/An%20Invented%20Tale.epub?updated_at=1515000000">EPUB</a></li>\n      </ul>\n    </li>';
  assert.deepEqual(readWorkPage(older).downloads.epub, { url: `${AO3_ORIGIN}/downloads/4242/An%20Invented%20Tale.epub?updated_at=1515000000`, updatedAt: "1515000000" });
  assert.equal(readWorkPage("<html>no menu</html>"), null);
  // Only the work's own Download menu counts, not a file linked from its notes.
  const notes = '<div class="notes module"><a href="/downloads/999/Other.epub?updated_at=5">another work</a></div>';
  assert.equal(readWorkPage(notes + workPage("5")).workId, "5");
  assert.equal(readWorkPage(notes), null);
});

test("reads the reader's lists and their next page", () => {
  const read = readListPage(listPage(["11", { id: "12", updatedAt: "1761800000", chapters: "10/10" }, "11"], { next: true }), "bookmarks");
  assert.deepEqual(read.works, [
    { workId: "11", updatedAt: "1761700000", complete: false, restricted: false },
    { workId: "12", updatedAt: "1761800000", complete: true, restricted: false },
  ]);
  assert.equal(read.next, true);
  const later = readListPage(listPage([{ id: "21", chapters: "1/1" }], { kind: "reading" }), "later");
  assert.deepEqual(later, { works: [{ workId: "21", updatedAt: "1761700000", complete: true, restricted: false }], next: false });
  assert.equal(readListPage(listPage([{ id: "22", restricted: true }]), "bookmarks").works[0].restricted, true);
  // An "Anonymous:" status before the title, for the work's own author.
  const own = listRow("31").replace('<h4 class="heading">', '<h4 class="heading"><span class="status">Anonymous:</span>');
  assert.equal(readListPage(own, "bookmarks").works[0].workId, "31");
  // Subscriptions: a link per work in a <dt>, none for an unrevealed one, and a Next link.
  const subscriptions = readListPage('<dl class="subscription index group">\n    <dt>\n          <a href="/works/77">A</a>\n          (Work)\n          by <a rel="author" href="/users/B/pseuds/B">B</a>\n    </dt>' +
    '<dd><form action="/users/R/subscriptions/5" method="post"></form></dd><dt>\n Hidden (Work)\n</dt><dt>\n <a href="/series/3">S</a>\n</dt></dl>' +
    '<ol class="pagination actions"><li class="next" title="next"><a href="/users/R/subscriptions?page=2&amp;type=works">Next →</a></li></ol>', "subscriptions");
  assert.deepEqual(subscriptions.works.map((w) => w.workId), ["77"]);
  assert.equal(subscriptions.next, true);
  assert.equal(listPageURL(USER, "later", 2), `${AO3_ORIGIN}/users/${USER}/readings?show=to-read&page=2`);
});

test("knows the forms that keep a work, by where they post", () => {
  assert.equal(formTriggerFor("/works/123/bookmarks"), "bookmark");
  assert.equal(formTriggerFor("/collections/lanterns/works/123/bookmarks"), "bookmark");
  assert.equal(formTriggerFor("/works/123/mark_for_later"), "later");
  assert.equal(formTriggerFor("/works/123/mark_as_read"), null);
  assert.equal(formTriggerFor("/kudos"), "kudos");
  assert.equal(formTriggerFor(`/users/${USER}/subscriptions`), "subscribe");
  assert.equal(formTriggerFor(`/users/${USER}/subscriptions/55`), null);
  assert.equal(formTriggerFor("/bookmarks/9"), null);
});

// --- Answers --------------------------------------------------------------------------

test("accepts only a real EPUB, and fails closed on everything else", () => {
  const url = epubLink("1");
  assert.equal(isEpub(epub()), true);
  assert.equal(isEpub(new TextEncoder().encode("<html>Just a moment</html>")), false);
  assert.deepEqual(classifyAnswer(file(url, epub()), "epub", NOW), { kind: "ok" });
  // A wrong file is that work's problem; a check page or refusal is the site's.
  assert.deepEqual(classifyAnswer(file(url, new Uint8Array(100)), "epub", NOW), { kind: "skip", code: "not_a_file" });
  const challenge = { ...file(url, new TextEncoder().encode("<title>Just a moment...</title>")), contentType: "text/html" };
  assert.equal(classifyAnswer(challenge, "epub", NOW).code, "challenge");
  assert.equal(classifyAnswer({ ...file(url, epub()), cfMitigated: "challenge" }, "epub", NOW).code, "challenge");
  assert.equal(classifyAnswer(file(url, new Uint8Array(0), 418), "epub", NOW).code, "forbidden");
  assert.equal(classifyAnswer(html(url, "Forbidden", 403), "page", NOW).code, "forbidden");
  assert.equal(classifyAnswer(file("https://example.org/x.epub", epub()), "epub", NOW).code, "wrong_host");
  assert.deepEqual(classifyAnswer({ kind: "failed", code: "too_large" }, "epub", NOW), { kind: "skip", code: "too_large" });
  assert.deepEqual(classifyAnswer(file(url, epub(), 500), "epub", NOW), { kind: "skip", code: "http_error" });
});

test("waits on 429, 445 and the front ends' 5xx; skips gone works and sign-in pages", () => {
  const url = workURL("1");
  assert.deepEqual(classifyAnswer(html(url, "", 429, { retryAfter: "120" }), "page", NOW), { kind: "retry", waitMs: 120_000 });
  assert.deepEqual(classifyAnswer(html(url, "", 503), "page", NOW), { kind: "retry", waitMs: null });
  // A 429 with a plain "Retry later" body and Retry-After.
  assert.deepEqual(classifyAnswer({ ...html(url, "Retry later\n", 429, { retryAfter: "300" }), contentType: "text/plain" }, "page", NOW), { kind: "retry", waitMs: 300_000 });
  // The "heavy traffic" page.
  assert.equal(classifyAnswer(html(url, "Error 445", 445), "page", NOW).kind, "retry");
  assert.equal(classifyAnswer(html(url, "", 502), "page", NOW).kind, "retry");
  assert.deepEqual(classifyAnswer(html(url, "", 500), "page", NOW), { kind: "skip", code: "http_error" });
  // A work page whose story mentions the words is just a page.
  assert.deepEqual(classifyAnswer(html(url, "<p>Retry later, she said.</p>"), "page", NOW), { kind: "ok" });
  // A download that lands on a work's page.
  assert.deepEqual(classifyAnswer(html(`${AO3_ORIGIN}/works/1`, "<html>work</html>"), "epub", NOW), { kind: "skip", code: "no_download" });
  // A refusal of the whole site.
  assert.equal(classifyAnswer(html(url, "<h2>Error 403</h2>", 403), "page", NOW).code, "forbidden");
  assert.deepEqual(classifyAnswer({ kind: "failed", code: "network" }, "page", NOW).kind, "retry");
  assert.deepEqual(classifyAnswer(html(url, "", 404), "page", NOW), { kind: "skip", code: "gone" });
  // Read signed out, every page has AO3's sign-in form: only its sign-in page itself is a locked work.
  assert.deepEqual(classifyAnswer(loginPage(), "page", NOW), { kind: "skip", code: "needs_sign_in" });
  assert.deepEqual(classifyAnswer(loginPage(), "epub", NOW), { kind: "skip", code: "needs_sign_in" });
  // Any other sign-in page, read signed out, has nothing to copy.
  assert.deepEqual(classifyAnswer(html(`${AO3_ORIGIN}/users/login?return_to=%2Fworks%2F1`, "<form action=\"/users/login\"></form>"), "page", NOW), { kind: "skip", code: "no_download" });
  const loggedOut = '<body class="logged-out"><form action="/users/login" method="post"></form><h2 class="title heading">A work</h2></body>';
  assert.deepEqual(classifyAnswer(html(url, loggedOut), "page", NOW), { kind: "ok" });
  assert.equal(classifyAnswer(html(url, loggedOut, 403), "page", NOW).code, "forbidden");
  // A page read with the reader's session: there, the sign-in form says they signed out.
  const list = listPageURL(USER, "later", 1);
  assert.deepEqual(classifyAnswer(html(list, loggedOut), "session", NOW), { kind: "skip", code: "needs_sign_in" });
  assert.deepEqual(classifyAnswer(html(list, loggedOut, 403), "session", NOW), { kind: "skip", code: "needs_sign_in" });
  assert.deepEqual(classifyAnswer(html(list, listPage([])), "session", NOW), { kind: "ok" });
});

// --- File names -----------------------------------------------------------------------

test("builds file names that are safe everywhere", () => {
  assert.equal(copyFilename({ workId: "123", title: "Lanterns: A/B?", author: "Quill", fandom: "Invented <Lanterns>" }, "epub"),
    `${COPY_FOLDER}/Invented -Lanterns-/Lanterns- A-B- – Quill (123).epub`);
  assert.equal(safeSegment("CON", 10, "x"), "_CON");
  assert.equal(safeSegment("con.txt", 10, "x"), "_con.txt");
  // What Chrome's downloads API refuses in any part of a path.
  assert.equal(safeSegment("Clock$", 10, "x"), "_Clock$");
  assert.equal(safeSegment("Thumbs.db", 20, "x"), "_Thumbs.db");
  assert.equal(safeSegment("Hotel.local", 20, "x"), "Hotel-local");
  assert.equal(safeSegment("Fan.LNK", 20, "x"), "Fan-LNK");
  assert.equal(safeSegment("Odd.{clsid}", 20, "x"), "Odd-{clsid}");
  assert.equal(safeSegment("Tide\u200b\u202eRev\u0007", 20, "x"), "TideRev");
  assert.equal(safeSegment("...hidden. ", 20, "x"), "hidden");
  assert.equal(safeSegment("   ", 20, "Untitled"), "Untitled");
  assert.equal([...safeSegment("é".repeat(200), 80, "x")].length, 40);
  // A long title gives way; the id and extension always stay.
  const long = copyFilename({ workId: "123456789", title: "長".repeat(300), author: "A".repeat(300), fandom: "F" }, "epub", "updated 2026-10-29 1000");
  const name = long.split("/").at(-1);
  assert.ok(new TextEncoder().encode(name).length <= MAX_NAME_BYTES);
  assert.match(name, / \(123456789\) \(updated 2026-10-29 1000\)\.epub$/);
  assert.equal(copyFilename({ workId: "1", title: "T", author: "A", fandom: "F" }, "pdf", "updated 2026-10-29 1000"), `${COPY_FOLDER}/F/T – A (1) (updated 2026-10-29 1000).pdf`);
});

// --- The queue --------------------------------------------------------------------------

test("a bookmark keeps the work: one file, from the page's own link", async () => {
  const box = harness({ [epubLink("123")]: file(epubLink("123"), epub()) });
  await box.engine.notePage(readWorkPage(workPage("123")), "bookmark");
  await box.drain();
  assert.deepEqual(box.requests, [epubLink("123")]);
  assert.equal(box.saved.length, 1);
  assert.equal(box.saved[0].filename, `${COPY_FOLDER}/Invented Lanterns/Invented work 123 – Synthetic_Quill (123).epub`);
  // The same version again asks AO3 for nothing.
  await box.engine.notePage(readWorkPage(workPage("123")), "visit");
  await box.drain();
  assert.equal(box.requests.length, 1);
  const view = await box.engine.view();
  assert.equal(view.kept, 1);
  assert.equal(view.withCopy, 1);
});

test("a visit keeps nothing new unless Every work I open is on", async () => {
  const box = harness();
  await box.engine.notePage(readWorkPage(workPage("5")), "visit");
  assert.equal((await box.engine.view()).kept, 0);
  await box.engine.updateSettings({ triggers: { open: true } });
  await box.engine.notePage(readWorkPage(workPage("5")), "visit");
  assert.equal((await box.engine.view()).kept, 1);
  await box.engine.updateSettings({ triggers: { kudos: false } });
  await box.engine.notePage(readWorkPage(workPage("6")), "kudos");
  assert.equal((await box.engine.view()).kept, 1);
});

test("an update replaces the file for that work id, even under a new title", async () => {
  const box = harness({
    [epubLink("123")]: file(epubLink("123"), epub(2_000)),
    [epubLink("123", "1761800000")]: file(epubLink("123", "1761800000"), epub(2_400)),
  });
  await box.engine.notePage(readWorkPage(workPage("123")), "bookmark");
  await box.drain();
  await box.engine.notePage(readWorkPage(workPage("123", { updatedAt: "1761800000", title: "Renamed" })), "visit");
  await box.drain();
  assert.equal(box.saved.length, 2);
  assert.match(box.saved[1].filename, /\/Renamed – /);
  assert.deepEqual(box.removed, [1]);
});

test("a much shorter version keeps the old file and saves the new one dated", async () => {
  const box = harness({
    [epubLink("123")]: file(epubLink("123"), epub(10_000)),
    [epubLink("123", "1761800000")]: file(epubLink("123", "1761800000"), epub(7_000)),
  });
  await box.engine.notePage(readWorkPage(workPage("123")), "bookmark");
  await box.drain();
  await box.engine.notePage(readWorkPage(workPage("123", { updatedAt: "1761800000" })), "visit");
  await box.drain();
  assert.deepEqual(box.removed, []);
  assert.match(box.saved[1].filename, /\(123\) \(updated 2026-10-29 1000\)\.epub$/);
  assert.equal(box.saved[1].conflict, "uniquify");
  assert.deepEqual(box.stored.works["123"].setAside, [box.saved[0].filename]);
});

test("a backup reads the reader's lists, then each work's page, then its file, 6 to 7 s apart", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: html(listPageURL(USER, "bookmarks", 1), listPage(["11"], { next: true })),
    [listPageURL(USER, "bookmarks", 2)]: html(listPageURL(USER, "bookmarks", 2), listPage(["12"])),
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), listPage([])),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
  };
  for (const id of ["11", "12"]) {
    answers[workURL(id)] = html(workURL(id), workPage(id));
    answers[epubLink(id)] = file(epubLink(id), epub());
  }
  const box = harness(answers);
  assert.equal(await box.engine.startBackup(), "no_user");
  await box.engine.noteUser(USER);
  assert.equal(await box.engine.startBackup(), "started");
  const times = [];
  const fetchPage = box.ports.fetchPage;
  box.ports.fetchPage = box.ports.fetchFile = async (url, credentials) => { times.push(box.now); return fetchPage(url, credentials); };
  await box.drain();
  assert.equal(box.saved.length, 2);
  assert.equal(box.requests.length, 8);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= PAGE_GAP_MS);
  const view = await box.engine.view();
  assert.equal(view.run.status, "finished");
  assert.equal(view.run.found, 2);
  assert.equal(box.quiet[0], true);
  assert.equal(box.quiet.at(-1), false);
});

test("the queue carries on in a new background from what was stored", async () => {
  const box = harness({ [epubLink("9")]: file(epubLink("9"), epub()) });
  box.ports.fetchFile = async () => ({ kind: "failed", code: "network" });
  await box.engine.notePage(readWorkPage(workPage("9")), "bookmark");
  await box.engine.tick();
  assert.equal(box.stored.queue.length, 1);
  box.ports.fetchFile = async (url) => file(url, epub());
  const again = new KeepACopy(box.ports);
  box.engine = again;
  box.now += 60_000;
  await box.drain();
  assert.equal(box.saved.length, 1);
  assert.equal(box.stored.queue.length, 0);
});

test("429s back off and doubling, three in a row stop the queue; a 403 stops it at once", async () => {
  const box = harness({ [epubLink("9")]: file(epubLink("9"), new Uint8Array(0), 429) });
  await box.engine.notePage(readWorkPage(workPage("9")), "bookmark");
  assert.equal(await box.engine.tick(), RETRY_BASE_MS);
  box.now += RETRY_BASE_MS;
  assert.equal(await box.engine.tick(), RETRY_BASE_MS * 2);
  box.now += RETRY_BASE_MS * 2;
  assert.equal(await box.engine.tick(), STOP_MS);
  assert.equal((await box.engine.view()).stopped.code, "slow_down");
  assert.equal(box.saved.length, 0);

  const refused = harness({ [epubLink("9")]: { ...file(epubLink("9"), new Uint8Array(0), 403), retryAfter: String(48 * 3600) } });
  await refused.engine.notePage(readWorkPage(workPage("9")), "bookmark");
  assert.equal(await refused.engine.tick(), STOP_MAX_MS);
  assert.equal((await refused.engine.view()).stopped.code, "forbidden");
  assert.equal(refused.requests.length, 1);
});

test("the weekly check queues only unfinished kept works whose updated_at moved, at the slow pace", async () => {
  const box = harness({
    [epubLink("11")]: file(epubLink("11"), epub()),
    [epubLink("12")]: file(epubLink("12"), epub()),
  });
  await box.engine.noteUser(USER);
  await box.engine.notePage(readWorkPage(workPage("11")), "bookmark");
  await box.engine.notePage(readWorkPage(workPage("12", { chapters: "10/10" })), "bookmark");
  await box.drain();
  await box.engine.updateSettings({ weeklyCheck: true });
  box.now += CHECK_EVERY_MS;
  box.ports.fetchPage = async (url) => {
    box.requests.push(url);
    if (url === listPageURL(USER, "bookmarks", 1)) {
      return html(url, listPage([{ id: "11", updatedAt: "1761800000" }, { id: "12", updatedAt: "1761800000", chapters: "10/10" }, "13", { id: "14" }]));
    }
    if (url === workURL("11")) return html(url, workPage("11", { updatedAt: "1761800000" }));
    return html(url, listPage([]));
  };
  box.ports.fetchFile = async (url) => { box.requests.push(url); return file(url, epub(2_200)); };
  const started = box.now;
  await box.drain();
  assert.ok(box.now - started >= 3 * 30_000);
  assert.equal(box.saved.length, 3);
  assert.deepEqual(box.requests.slice(2), [listPageURL(USER, "bookmarks", 1), listPageURL(USER, "later", 1), workURL("11"), epubLink("11", "1761800000")]);
  assert.equal(box.stored.works["13"], undefined);
});

// --- Fix round 1 ----------------------------------------------------------------------

test("a save that throws is tried MAX_ATTEMPTS times with a growing wait, then skipped", async () => {
  const box = harness({ [epubLink("1")]: file(epubLink("1"), epub()) });
  const gets = [];
  box.ports.fetchFile = async (url) => {
    // The try is stored before AO3 is asked, so a background stopped here still counts it.
    gets.push(box.stored.queue[0].attempts);
    return file(url, epub());
  };
  box.ports.save = async () => { throw new Error("Invalid filename"); };
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  const waits = [];
  for (let i = 0; i < 6; i += 1) {
    const wait = await box.engine.tick();
    if (wait === null) break;
    waits.push(wait);
    box.now += wait;
  }
  assert.deepEqual(gets, [1, 2, 3]);
  // Three failed saves in a row stop the queue; once the stop is over the work is skipped.
  assert.deepEqual(waits.slice(0, 3), [RETRY_BASE_MS, RETRY_BASE_MS * 2, STOP_MS]);
  assert.equal(box.stored.works["1"].skipped, "save_failed");
  assert.equal(box.stored.queue.length, 0);
  assert.deepEqual((await box.engine.view()).skipped, { save_failed: 1 });
  assert.equal(box.released.length, 3);
});

test("a background stopped mid-request does not ask again at once, nor for ever", async () => {
  const box = harness();
  box.ports.fetchFile = async () => new Promise(() => {});
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    void box.engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const again = new KeepACopy(box.ports);
    box.engine = again;
    assert.ok(box.stored.pacer.dueAt > box.now);
    box.now = box.stored.pacer.dueAt;
  }
  await box.engine.tick();
  assert.equal(box.stored.works["1"].skipped, "failed");
});

test("one work's wrong file is skipped and the queue goes on; a changed format re-reads the page", async () => {
  const box = harness({
    [epubLink("1")]: file(epubLink("1"), new Uint8Array(500)),
    [epubLink("2")]: file(epubLink("2"), epub()),
  });
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  await box.engine.notePage(readWorkPage(workPage("2")), "bookmark");
  await box.drain();
  assert.equal(box.stored.works["1"].skipped, "not_a_file");
  assert.equal(box.saved.length, 1);
  assert.equal((await box.engine.view()).stopped, null);

  const pdf = `${AO3_ORIGIN}/downloads/3/Invented_work.pdf?updated_at=1761700000`;
  const switched = harness({ [workURL("3")]: html(workURL("3"), workPage("3")), [pdf]: { ...file(pdf, new TextEncoder().encode("%PDF-1.7 ...")), contentType: "application/pdf" } });
  await switched.engine.notePage(readWorkPage(workPage("3")), "bookmark");
  await switched.engine.updateSettings({ format: "pdf" });
  await switched.drain();
  assert.deepEqual(switched.requests, [workURL("3"), pdf]);
  assert.equal(switched.saved[0].format, "pdf");
});

test("a save is asked after by its own URL, and one the browser finds under another id keeps that id", async () => {
  const box = harness({ [epubLink("1")]: file(epubLink("1"), epub()) });
  const asked = [];
  box.ports.settle = async (id, handle) => {
    asked.push([id, handle]);
    return { state: "complete", filename: "/home/reader/Downloads/x.epub", downloadId: 9 };
  };
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  await box.drain();
  assert.deepEqual(asked, [[1, box.saved[0].handle]]);
  assert.equal(box.stored.works["1"].copy.downloadId, 9);
});

test("a character reference past the last code point reads as the replacement character", () => {
  const page = workPage("1").replace("Invented work 1", "A&#x110000;B&#1114112;C");
  assert.match(readWorkPage(page).title, /^A\uFFFDB\uFFFDC/);
});

test("the old file goes only once the new one is complete; an interrupted save keeps it, and is given up", async () => {
  const box = harness({
    [epubLink("1")]: file(epubLink("1"), epub()),
    [epubLink("1", "2")]: file(epubLink("1", "2"), epub()),
    [epubLink("1", "3")]: file(epubLink("1", "3"), epub()),
  });
  // Every save given up, from the start: never one that completed.
  const cancelled = [];
  box.ports.cancel = async (id, handle) => { cancelled.push([id, handle]); };
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  await box.drain();
  const first = box.stored.works["1"].copy;
  // A new title, so a new name: the old file has to be removed.
  const save = box.ports.save;
  box.ports.save = async (request) => {
    const id = await save(request);
    box.downloads.set(id, "in_progress");
    return id;
  };
  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "2", title: "Renamed" })), "visit");
  await box.engine.tick();
  assert.equal(box.stored.pending.downloadId, 2);
  // A new background picks the save up from storage.
  box.engine = new KeepACopy(box.ports);
  assert.equal(await box.engine.tick(), 2_000);
  assert.deepEqual(box.removed, []);
  box.downloads.set(2, "complete");
  await box.engine.tick();
  assert.deepEqual(box.removed, [1]);
  assert.equal(box.stored.works["1"].copy.updatedAt, "2");
  assert.equal(box.stored.works["1"].copy.path, `/home/reader/Downloads/${box.saved[1].filename}`);

  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "3", title: "Again" })), "visit");
  box.ports.save = async (request) => {
    const id = await save(request);
    box.downloads.set(id, "interrupted");
    return id;
  };
  // Cut off (a browser quit mid-save): given up and forgotten, with its part-written file, by its own URL.
  await box.drain(4);
  assert.ok(cancelled.some(([id, handle]) => id === 3 && handle === box.saved[2].handle), `given up: ${JSON.stringify(cancelled)}`);
  assert.equal(cancelled.some(([id]) => id === 1 || id === 2), false, "a save that completed is never given up");
  assert.deepEqual(box.removed, [1]);
  assert.equal(box.stored.works["1"].copy.updatedAt, "2");
  assert.notEqual(first.downloadId, box.stored.works["1"].copy.downloadId);
});

test("two much shorter versions in a day get two names, neither written over", async () => {
  const answers = {};
  for (const [at, size] of [["1", 10_000], ["2", 7_000], ["3", 4_000]]) answers[epubLink("1", at)] = file(epubLink("1", at), epub(size));
  const box = harness(answers);
  for (const at of ["1", "2", "3"]) {
    await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: at })), at === "1" ? "bookmark" : "visit");
    await box.drain();
  }
  const names = box.saved.map((saved) => saved.filename);
  assert.equal(new Set(names).size, 3);
  assert.deepEqual(box.saved.map((saved) => saved.conflict), ["overwrite", "uniquify", "uniquify"]);
  assert.deepEqual(box.stored.works["1"].setAside, names.slice(0, 2));
  assert.deepEqual(box.removed, []);
});

test("the download bubble is hidden only while a backup runs, and shown again on every way out", async () => {
  const box = harness({ [epubLink("1")]: file(epubLink("1"), epub()), [epubLink("2")]: file(epubLink("2"), epub()) });
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  await box.engine.notePage(readWorkPage(workPage("2")), "bookmark");
  await box.drain();
  assert.deepEqual(box.quiet, []);
  await box.engine.noteUser(USER);
  box.ports.fetchPage = async (url) => html(url, listPage(["7"], { next: true }));
  await box.engine.startBackup();
  await box.engine.tick();
  assert.deepEqual(box.quiet, [true]);
  await box.engine.updateSettings({ enabled: false });
  assert.deepEqual(box.quiet, [true, false]);
  await box.engine.updateSettings({ enabled: true });
  box.now += 60_000;
  box.ports.fetchPage = async (url) => html(url, "Forbidden", 403);
  await box.engine.tick();
  assert.deepEqual(box.quiet, [true, false, true, false]);
});

test("the popup's view answers while a request is under way, and writes nothing", async () => {
  const box = harness();
  let answer;
  box.ports.fetchFile = () => new Promise((resolve) => { answer = resolve; });
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  const ticking = box.engine.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let writes = 0;
  const write = box.ports.write;
  box.ports.write = async (state) => { writes += 1; return write(state); };
  assert.equal((await box.engine.view()).waiting, 1);
  assert.equal(writes, 0);
  answer(file(epubLink("1"), epub()));
  await ticking;
});

test("an old file is removed only when it is still this extension's, at its recorded name", () => {
  const item = { id: 4, filename: "C:\\Users\\r\\Downloads\\AO3\\F\\T – A (1).epub", state: "complete", byExtensionId: "ext" };
  assert.equal(isOurFile(item, "ext", "AO3/F/T – A (1).epub"), true);
  assert.equal(isOurFile({ ...item, byExtensionId: "other" }, "ext", "AO3/F/T – A (1).epub"), false);
  assert.equal(isOurFile(item, "ext", "AO3/F/Other (2).epub"), false);
  assert.equal(isOurFile(undefined, "ext", "AO3/F/T – A (1).epub"), false);
  const { byExtensionId, ...firefox } = item;
  assert.equal(isOurFile(firefox, "ext", "AO3/F/T – A (1).epub"), true);
});

test("a file's first bytes cross to and from the offscreen document intact", () => {
  const fetched = file(epubLink("1"), epub());
  const back = fromOffscreenAnswer(JSON.parse(JSON.stringify(toOffscreenAnswer(fetched))));
  assert.deepEqual(back, fetched);
  assert.equal(isEpub(back.bytes), true);
});

// --- Fix round 2 ----------------------------------------------------------------------

test("the offscreen document fetches one file at a time, joins a repeat, keeps the worker up and lets unclaimed blobs go", async () => {
  const timers = [];
  const revoked = [];
  let alive = 0;
  let finish;
  const fetcher = offscreenFetcher({
    fetchFile: () => new Promise((resolve) => { finish = resolve; }),
    revoke: (handle) => revoked.push(handle),
    keepAlive: () => { alive += 1; return () => { alive -= 1; }; },
    setTimer: (run, ms) => { timers.push({ run, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (at) => { timers[at].cleared = true; },
  });
  const first = fetcher.fetch(epubLink("1"));
  const again = fetcher.fetch(epubLink("1"));
  assert.deepEqual(await fetcher.fetch(epubLink("2")), { kind: "failed", code: "busy" });
  assert.equal(alive, 1);
  finish(file(epubLink("1"), epub()));
  const [a, b] = await Promise.all([first, again]);
  assert.equal(a.handle, b.handle);
  assert.equal(alive, 0);
  assert.equal(timers[0].ms, CLAIM_MS);
  timers[0].run();
  assert.deepEqual(revoked, [a.handle]);

  const claimed = fetcher.fetch(epubLink("3"));
  finish(file(epubLink("3"), epub()));
  fetcher.claim((await claimed).handle);
  assert.equal(timers[1].cleared, true);
  assert.equal(classifyAnswer({ kind: "failed", code: "busy" }, "epub", NOW).network, undefined);
});

test("the offscreen document is opened again whenever Chrome closed it, and closed only when open", async () => {
  let open = false;
  const calls = [];
  const keeper = offscreenKeeper({
    hasDocument: async () => open,
    createDocument: async () => { calls.push("create"); open = true; },
    closeDocument: async () => { calls.push("close"); open = false; },
  });
  await keeper.ensure();
  await keeper.ensure();
  open = false; // Chrome closed it.
  await keeper.ensure();
  await keeper.close();
  await keeper.close();
  assert.deepEqual(calls, ["create", "create", "close"]);
});

test("saves that keep failing stop the whole queue as save_failed after three, not three per work", async () => {
  const answers = {};
  for (const id of ["1", "2", "3", "4"]) answers[epubLink(id)] = file(epubLink(id), epub());
  const box = harness(answers);
  box.ports.save = async () => { throw new Error("Disk full"); };
  for (const id of ["1", "2", "3", "4"]) await box.engine.notePage(readWorkPage(workPage(id)), "bookmark");
  for (let i = 0; i < 3; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.pacer.stopped.code, "save_failed");
  assert.equal(box.requests.length, 3);
});

test("pages that read but files that do not, three works in a row, stop the queue", async () => {
  const answers = {};
  for (const id of ["1", "2", "3"]) {
    answers[workURL(id)] = html(workURL(id), workPage(id));
    answers[epubLink(id)] = file(epubLink(id), new Uint8Array(400));
  }
  const box = harness(answers);
  for (const id of ["1", "2", "3"]) await box.engine.noteWork(id, "bookmark");
  for (let i = 0; i < 6 && !box.stored?.pacer.stopped; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.pacer.stopped.code, "unreadable");
  assert.equal(box.requests.length, 6);
});

test("unreadable works and failed saves are counted apart, so each stop names its own cause", async () => {
  const answers = {};
  for (const id of ["1", "2", "3"]) answers[epubLink(id)] = file(epubLink(id), id === "3" ? epub() : new Uint8Array(400));
  const box = harness(answers);
  const save = box.ports.save;
  let throws = 1;
  box.ports.save = async (request) => {
    if (throws-- > 0) throw new Error("Disk full");
    return save(request);
  };
  for (const id of ["1", "2", "3"]) await box.engine.notePage(readWorkPage(workPage(id)), "bookmark");
  // Two works AO3 made no file of, then one save that failed: three failures, but no cause three times.
  for (let i = 0; i < 3; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.pacer.stopped, null);
  assert.equal(box.stored.pacer.misses, 2);
  assert.equal(box.stored.pacer.failedSaves, 1);
  await box.drain();
  assert.equal(box.stored.works["3"].copy.updatedAt, "1761700000");
  assert.equal(box.stored.pacer.stopped, null);
  assert.equal(box.stored.pacer.misses + box.stored.pacer.failedSaves, 0);
});

test("a save the browser never finishes is cancelled before its file is let go", async () => {
  const box = harness({ [epubLink("1")]: file(epubLink("1"), epub()) });
  const cancelled = [];
  box.ports.cancel = async (id) => { cancelled.push(id); box.downloads.set(id, "interrupted"); };
  const save = box.ports.save;
  box.ports.save = async (request) => {
    const id = await save(request);
    box.downloads.set(id, "in_progress");
    return id;
  };
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  await box.engine.tick();
  box.now += SETTLE_MAX_MS;
  await box.engine.tick();
  assert.deepEqual(cancelled, [1]);
  assert.deepEqual(box.released, [handleOf(epubLink("1"))]);
  assert.equal(box.stored.pending, null);
  assert.equal(box.stored.works["1"].copy, null);
});

test("Windows paths match the stored path with either slash and any case", () => {
  const item = { id: 4, filename: "C:\\Users\\Reader\\Downloads\\AO3\\F\\T – A (1).epub", state: "complete" };
  assert.equal(isOurFile(item, "ext", "C:\\Users\\Reader\\Downloads\\AO3\\F\\T – A (1).epub"), true);
  assert.equal(isOurFile(item, "ext", "c:\\users\\reader\\downloads\\ao3\\f\\t – a (1).epub"), true);
  assert.equal(isOurFile(item, "ext", "AO3/F/T – A (1).epub"), true);
  assert.equal(isOurFile(item, "ext", "C:\\Users\\Reader\\Downloads\\AO3\\F\\Other (2).epub"), false);
  // Elsewhere, case still counts.
  assert.equal(isOurFile({ ...item, filename: "/home/r/Downloads/AO3/F/T – A (1).epub" }, "ext", "ao3/f/t – a (1).epub"), false);
});

// --- Locked works -----------------------------------------------------------------------

test("every work page is read signed out; only the reader's own lists go with their session", async () => {
  const box = harness({
    [listPageURL(USER, "bookmarks", 1)]: html(listPageURL(USER, "bookmarks", 1), listPage(["7"])),
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), listPage([])),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
    [workURL("7")]: html(workURL("7"), workPage("7")),
    [epubLink("7")]: file(epubLink("7"), epub()),
  });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await box.drain();
  assert.deepEqual(box.modes, [
    ...["bookmarks", "later", "subscriptions"].map((list) => [listPageURL(USER, list, 1), "include"]),
    [workURL("7"), "omit"],
  ]);
  assert.equal(box.saved.length, 1);
});

test("a Chapter Index gives its work, title, chapters and latest date; the version moves with each new chapter", () => {
  const index = readChapterIndex(chapterIndex("8", { chapters: [["81", "2026-10-01"], ["82", "2026-10-20"]], title: "Lanterns &amp; Tide" }));
  assert.deepEqual(index, { workId: "8", title: "Lanterns & Tide", author: "Synthetic_Quill", chapters: 2, latestAt: dayOf("2026-10-20"), signedIn: true });
  const sameDay = readChapterIndex(chapterIndex("8", { chapters: [["81", "2026-10-01"], ["82", "2026-10-20"], ["83", "2026-10-20"]] }));
  const later = readChapterIndex(chapterIndex("8", { chapters: [["81", "2026-10-01"], ["82", "2026-10-21"]] }));
  assert.equal(new Set([index, sameDay, later].map(lockedVersion)).size, 3);
  assert.equal(readChapterIndex(chapterIndex("8", { signedIn: false })).signedIn, false);
  // Twelve digits, above any Download link's updated_at: a locked version is compared only with another.
  assert.equal(lockedVersion(index).length, 12);
  assert.ok(Number(lockedVersion({ chapters: 1, latestAt: 0 })) > 99_999_999_999);
  // Another work's chapter in the list, a chapter with no date, or no index at all.
  assert.equal(readChapterIndex(chapterIndex("8").replace("/works/8/chapters/101", "/works/9/chapters/101").replace("</ol>", '<li><a href="/works/8/chapters/102">2.</a> <span class="datetime">(2026-10-02)</span></li></ol>')), null);
  assert.equal(readChapterIndex(chapterIndex("8").replace(/<span class="datetime">[^<]*<\/span>/, "")), null);
  assert.equal(readChapterIndex(workPage("8")), null);
  assert.equal(lockedFileURL("8", "Lanterns: Tide / Über", "epub", "1792540802"), `${AO3_ORIGIN}/downloads/8/Lanterns_Tide_Uber.epub?updated_at=1792540802`);
  assert.equal(lockedFileURL("8", "", "epub", "1"), `${AO3_ORIGIN}/downloads/8/8.epub?updated_at=1`);
});

test("a locked work is copied from its Chapter Index read signed in, then its file, from a URL built only after that read", async () => {
  const chapters = [["81", "2026-10-01"], ["82", "2026-10-20"]];
  const version = String(LOCKED_VERSION_BASE + dayOf("2026-10-20") + 2);
  const lockedFile = lockedFileURL("8", "Lanterns Locked", "epub", version);
  const answers = {
    [workURL("8")]: html(workURL("8"), workPage("8", { restricted: true })),
    [navigateURL("8")]: html(navigateURL("8"), chapterIndex("8", { chapters, title: "Lanterns Locked" })),
    [lockedFile]: file(lockedFile, epub()),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.noteWork("8", "bookmark");
  await box.drain();
  // Its page signed out lands on the sign-in page; then its Chapter Index and file, signed in, in one step.
  assert.deepEqual(box.modes, [[workURL("8"), "omit"], [navigateURL("8"), "include"]]);
  assert.deepEqual(box.fileModes, [[lockedFile, "include"]]);
  assert.equal(box.saved.length, 1);
  assert.equal(box.stored.works["8"].copy.updatedAt, version);
  assert.equal(box.stored.works["8"].restricted, true);
  assert.equal(JSON.stringify(box.stored).includes("/downloads/8/"), false, "the URL is never kept");
  // Looked at again: the index alone, once; the same page's Download link again asks nothing.
  const indexReads = () => box.modes.filter(([url]) => url === navigateURL("8")).length;
  for (let i = 0; i < 2; i += 1) {
    await box.engine.notePage(readWorkPage(workPage("8", { restricted: true })), "visit");
    await box.drain();
  }
  assert.equal(box.fileModes.length, 1);
  assert.equal(indexReads(), 2);
  // A new chapter moves the page's link: copied again. Its work page is never read again.
  chapters.push(["83", "2026-10-20"]);
  const newer = lockedFileURL("8", "Lanterns Locked", "epub", String(LOCKED_VERSION_BASE + dayOf("2026-10-20") + 3));
  answers[navigateURL("8")] = html(navigateURL("8"), chapterIndex("8", { chapters, title: "Lanterns Locked" }));
  answers[newer] = file(newer, epub(3_000));
  await box.engine.notePage(readWorkPage(workPage("8", { restricted: true, updatedAt: "1761800000" })), "visit");
  await box.drain();
  assert.equal(indexReads(), 3);
  assert.equal(JSON.stringify(box.stored).includes("/downloads/8/"), false, "no link of it is kept");
  assert.deepEqual(box.fileModes.map(([url]) => url), [lockedFile, newer]);
  assert.equal(box.stored.works["8"].copy.updatedAt, String(LOCKED_VERSION_BASE + dayOf("2026-10-20") + 3));
  assert.equal(box.modes.filter(([url]) => url === workURL("8")).length, 1);
});

test("a locked work's Chapter Index on the sign-in page, or shown signed out, is needs_sign_in: no file, no miss, no stop", async () => {
  const answers = {
    [navigateURL("8")]: loginPage(),
    [navigateURL("9")]: html(navigateURL("9"), chapterIndex("9", { signedIn: false })),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  for (const id of ["8", "9"]) await box.engine.notePage(readWorkPage(workPage(id, { restricted: true })), "bookmark");
  await box.drain();
  assert.deepEqual(box.modes, [[navigateURL("8"), "include"], [navigateURL("9"), "include"]]);
  assert.deepEqual(box.fileModes, []);
  assert.deepEqual((await box.engine.view()).skipped, { needs_sign_in: 2 });
  assert.equal(box.stored.pacer.misses, 0);
  assert.equal(box.stored.pacer.stopped, null);
  // A page shows the reader signed out, then signed in again: copied on their own.
  const lockedFile = lockedFileURL("8", "Invented work 8", "epub", String(LOCKED_VERSION_BASE + dayOf("2026-10-01") + 1));
  answers[navigateURL("8")] = html(navigateURL("8"), chapterIndex("8"));
  answers[lockedFile] = file(lockedFile, epub());
  await box.engine.noteUser(null);
  await box.engine.noteUser(USER);
  answers[navigateURL("9")] = loginPage();
  await box.drain();
  assert.deepEqual(box.fileModes, [[lockedFile, "include"]]);
  assert.deepEqual((await box.engine.view()).skipped, { needs_sign_in: 1 });
});

test("a Chapter Index of another work, or any other page, fetches no file; a locked work's kept link is never used", async () => {
  const box = harness({
    [navigateURL("8")]: html(navigateURL("8"), chapterIndex("9")),
    [navigateURL("7")]: html(navigateURL("7"), workPage("7")),
    [listPageURL(USER, "bookmarks", 1)]: html(listPageURL(USER, "bookmarks", 1), listPage([{ id: "7", restricted: true }])),
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), listPage([])),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
  });
  await box.engine.notePage(readWorkPage(workPage("8", { restricted: true })), "bookmark");
  assert.equal(box.stored.queue[0].link, undefined, "the reader's page's link is not taken");
  // A link left in storage is dropped before the step.
  box.stored.queue[0].link = { url: epubLink("8"), updatedAt: "1761700000" };
  box.engine = new KeepACopy(box.ports);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await box.drain();
  assert.deepEqual(box.fileModes, []);
  assert.deepEqual((await box.engine.view()).skipped, { no_download: 2 });
  assert.deepEqual(box.modes.filter(([url]) => url.includes("/works/")), [[navigateURL("8"), "include"], [navigateURL("7"), "include"]]);
});

test("a request with the reader's session follows no redirect: one request, and nothing asked of where it went", async (t) => {
  const realFetch = globalThis.fetch;
  const asked = [];
  // A redirect to the work's page, as the browser hands back one it does not follow.
  globalThis.fetch = async (url, init) => {
    asked.push([String(url), init?.credentials, init?.redirect]);
    if (init?.redirect === "manual") return { type: "opaqueredirect", status: 0, url: String(url), headers: new Headers(), body: null };
    return new Response(workPage("5"), { headers: { "content-type": "text/html" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  assert.deepEqual(await requestAO3(navigateURL("5"), "text", 5_000, 1_000_000, "include"), { kind: "redirect", url: navigateURL("5") });
  assert.deepEqual(await requestAO3(epubLink("5"), "file", 5_000, 1_000_000, "include"), { kind: "redirect", url: epubLink("5") });
  assert.equal((await requestAO3(workURL("5"), "text", 5_000, 1_000_000)).kind, "response");
  assert.deepEqual(asked, [[navigateURL("5"), "include", "manual"], [epubLink("5"), "include", "manual"], [workURL("5"), "omit", "follow"]]);
  // Not followed: a Chapter Index sent elsewhere wants a sign-in, a file sent elsewhere has none to take.
  assert.deepEqual(classifyAnswer({ kind: "redirect", url: navigateURL("5") }, "session", NOW), { kind: "skip", code: "needs_sign_in" });
  assert.deepEqual(classifyAnswer({ kind: "redirect", url: epubLink("5") }, "epub", NOW), { kind: "skip", code: "no_download" });
});

test("a backup reads a locked work's Chapter Index again only when its list's updated_at moves", async () => {
  const lockedFile = lockedFileURL("8", "Invented work 8", "epub", lockedVersion({ chapters: 1, latestAt: dayOf("2026-10-01") }));
  const answers = {
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), listPage([])),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
    [navigateURL("8")]: html(navigateURL("8"), chapterIndex("8")),
    [lockedFile]: file(lockedFile, epub()),
  };
  const listing = (updatedAt) => {
    answers[listPageURL(USER, "bookmarks", 1)] = html(listPageURL(USER, "bookmarks", 1), listPage([{ id: "8", restricted: true, updatedAt }]));
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  const indexReads = async (updatedAt) => {
    listing(updatedAt);
    assert.equal(await box.engine.startBackup(), "started");
    await box.drain();
    return box.modes.filter(([url]) => url === navigateURL("8")).length;
  };
  assert.equal(await indexReads("1761700000"), 1);
  assert.equal(await indexReads("1761700000"), 1, "unchanged on the list: not read again");
  assert.equal(await indexReads("1761900000"), 2);
  assert.equal(box.saved.length, 1);
});

const loggedOutList = (list) => html(listPageURL(USER, list, 1), '<body class="logged-out"><form action="/users/login" method="post"></form></body>');

/** A list page as AO3 answers the reader signed in, greeting them by name. */
const greeting = (user) => `<ul id="greeting"><li class="dropdown"><a href="/users/${user}">Hi, ${user}!</a></li></ul>`;
const signedInList = (list, rows = [], user = USER) => html(listPageURL(user, list, 1), `<body class="logged-in">${greeting(user)}${listPage(rows)}</body>`);

test("a list sent elsewhere: Bookmarks is read once more, and shown signed in, only that list is over", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks", ["7"]),
    // Marked for Later sends this reader elsewhere: not followed.
    [listPageURL(USER, "later", 1)]: { kind: "redirect", url: listPageURL(USER, "later", 1) },
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
    [workURL("7")]: html(workURL("7"), workPage("7")),
    [epubLink("7")]: file(epubLink("7"), epub()),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await box.drain();
  assert.equal(box.stored.pacer.stopped, null);
  assert.equal(box.stored.run.status, "finished");
  assert.deepEqual(box.requests.filter((url) => url.includes("/users/")), ["bookmarks", "later", "bookmarks", "subscriptions"].map((list) => listPageURL(USER, list, 1)));
  assert.equal(box.saved.length, 1);
});

test("a list sent elsewhere when the reader signed out stops the run: seen signed out, or shown so by Bookmarks", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: html(listPageURL(USER, "bookmarks", 1), listPage([])),
    [listPageURL(USER, "later", 1)]: { kind: "redirect", url: listPageURL(USER, "later", 1) },
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  // Bookmarks read; then Later sends elsewhere, and Bookmarks, read again, shows the reader signed out.
  box.now += await box.engine.tick();
  answers[listPageURL(USER, "bookmarks", 1)] = loggedOutList("bookmarks");
  for (let i = 0; i < 3 && !box.stored.pacer.stopped; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.pacer.stopped.code, "signed_out");
  assert.deepEqual(box.requests, ["bookmarks", "later", "bookmarks"].map((list) => listPageURL(USER, list, 1)));
  // Signed in again; then a page shows them signed out: Later sends elsewhere and the run stops at once.
  answers[listPageURL(USER, "bookmarks", 1)] = html(listPageURL(USER, "bookmarks", 1), listPage([]));
  await box.engine.noteUser(USER);
  await box.engine.noteUser(null);
  box.now += 1;
  for (let i = 0; i < 3 && !box.stored.pacer.stopped; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.pacer.stopped.code, "signed_out");
  assert.equal(box.requests.at(-1), listPageURL(USER, "later", 1));
  // A list page shown signed out stops it the same way.
  const shown = harness({ [listPageURL(USER, "bookmarks", 1)]: loggedOutList("bookmarks") });
  await shown.engine.noteUser(USER);
  await shown.engine.startBackup();
  await shown.engine.tick();
  assert.equal(shown.stored.pacer.stopped.code, "signed_out");
});

test("Bookmarks read once more that tells nothing is read again, three times in all, then only that list is over", async () => {
  for (const [kind, bookmarks] of [
    ["500", html(listPageURL(USER, "bookmarks", 1), "<h2>Error 500</h2>", 500)],
    ["404", html(listPageURL(USER, "bookmarks", 1), "", 404)],
    ["too large", { kind: "failed", code: "too_large" }],
    ["sent elsewhere", { kind: "redirect", url: listPageURL(USER, "bookmarks", 1) }],
    ["no word on signing in", html(listPageURL(USER, "bookmarks", 1), listPage([]))],
  ]) {
    const answers = {
      [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks"),
      [listPageURL(USER, "later", 1)]: { kind: "redirect", url: listPageURL(USER, "later", 1) },
      [listPageURL(USER, "subscriptions", 1)]: signedInList("subscriptions"),
    };
    const box = harness(answers);
    await box.engine.noteUser(USER);
    await box.engine.startBackup();
    box.now += await box.engine.tick();
    answers[listPageURL(USER, "bookmarks", 1)] = bookmarks;
    // Later sends elsewhere; then Bookmarks, read again, tells nothing twice: Later is not over yet.
    for (let i = 0; i < 3; i += 1) box.now += await box.engine.tick();
    assert.equal(box.stored.run.list, 1, kind);
    assert.equal(box.stored.run.confirm, true, kind);
    box.now += await box.engine.tick();
    assert.equal(box.stored.run.list, 2, kind);
    assert.equal(box.stored.pacer.stopped, null, kind);
    assert.equal(box.requests.filter((url) => url === listPageURL(USER, "bookmarks", 1)).length, 4, kind);
  }
});

const OTHER = "Other_Reader";

test("another reader signing in ends the run, not done, with nothing more asked of the first reader's lists", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks"),
    [listPageURL(USER, "later", 1)]: { kind: "redirect", url: listPageURL(USER, "later", 1) },
    [listPageURL(USER, "subscriptions", 1)]: signedInList("subscriptions"),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  box.now += await box.engine.tick();
  await box.engine.noteUser(OTHER);
  assert.equal(box.stored.run.status, "finished");
  for (let i = 0; i < 5; i += 1) {
    await box.engine.noteUser(OTHER);
    box.now += 60_000;
    await box.drain();
  }
  assert.deepEqual(box.requests, [listPageURL(USER, "bookmarks", 1)]);
  assert.equal(box.stored.pacer.stopped, null);
});

test("a sign-out stop holds no other reader: another reader signing in ends it, and their copies go on", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: loggedOutList("bookmarks"),
    [epubLink("5")]: file(epubLink("5"), epub()),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await box.engine.tick();
  assert.equal(box.stored.pacer.stopped.code, "signed_out");
  await box.engine.noteUser(OTHER);
  assert.equal(box.stored.pacer.stopped, null);
  assert.equal(box.stored.run.status, "finished");
  await box.engine.notePage(readWorkPage(workPage("5")), "bookmark");
  await box.drain();
  assert.equal(box.saved.length, 1);
});

test("a run whose reader is no longer the one signed in asks nothing with the other's session", async () => {
  const box = harness({ [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks") });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  // A stored run of one reader, while another is signed in (as a background stopped part-way leaves it).
  box.stored.user = OTHER;
  box.stored.run.confirm = true;
  box.engine = new KeepACopy(box.ports);
  await box.drain();
  assert.deepEqual(box.requests, []);
  assert.equal(box.stored.run.status, "finished");
});

test("each reader has their own weekly check date: a new one's comes a week on, one's never moves another's, one cut short comes again", async () => {
  const answers = {};
  for (const user of [USER, OTHER]) for (const list of ["bookmarks", "later"]) answers[listPageURL(user, list, 1)] = signedInList(list, [], user);
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.updateSettings({ weeklyCheck: true });
  const first = box.stored.checkedAt[USER];
  assert.equal(first, box.now, "seen for the first time: a week on");
  box.now += CHECK_EVERY_MS;
  // The first reader's check reads Bookmarks; then the other reader signs in, and it ends, not done.
  box.now += await box.engine.tick();
  await box.engine.noteUser(OTHER);
  assert.equal(box.stored.run, null);
  // The other reader is new: no check of theirs yet.
  await box.drain();
  assert.equal(box.requests.some((url) => url.includes(OTHER)), false);
  // A week on, the other reader's check runs and moves only their date.
  box.now += CHECK_EVERY_MS;
  await box.drain();
  assert.ok(box.requests.includes(listPageURL(OTHER, "later", 1)));
  assert.ok(box.stored.checkedAt[OTHER] > first);
  assert.equal(box.stored.checkedAt[USER], first);
  // Back, the first reader's check runs again, whole.
  await box.engine.noteUser(USER);
  await box.drain();
  assert.ok(box.requests.includes(listPageURL(USER, "later", 1)));
  assert.ok(box.stored.checkedAt[USER] > first);
});

test("a reader away keeps their check date for 90 days, twenty readers at most, the oldest going first; switched off, none", async () => {
  const box = harness({});
  const DAY = 24 * 60 * 60_000;
  await box.engine.noteUser(USER);
  box.now += 30 * DAY;
  // Away a month, their check long due: the date is kept, so the check runs when they are back.
  await box.engine.noteUser(OTHER);
  assert.deepEqual(Object.keys(box.stored.checkedAt).sort(), [OTHER, USER]);
  box.now += CHECKED_KEEP_MS - 30 * DAY;
  await box.engine.noteUser("Third_Reader");
  assert.deepEqual(Object.keys(box.stored.checkedAt).sort(), [OTHER, "Third_Reader"]);
  for (let i = 0; i < CHECKED_KEEP_COUNT; i += 1) {
    box.now += 60_000;
    await box.engine.noteUser(`Reader_${i}`);
  }
  const kept = Object.keys(box.stored.checkedAt);
  assert.equal(kept.length, CHECKED_KEEP_COUNT);
  assert.equal(kept.includes(OTHER) || kept.includes("Third_Reader"), false, "the oldest went first");
  assert.ok(kept.includes(`Reader_${CHECKED_KEEP_COUNT - 1}`), "never the reader signed in");
  await box.engine.updateSettings({ enabled: false });
  assert.equal(box.stored.checkedAt, undefined);
  assert.equal(box.stored.user, null);
});

test("two readers who take turns on one browser each get their weekly check", async () => {
  const answers = {};
  for (const user of [USER, OTHER]) for (const list of ["bookmarks", "later"]) answers[listPageURL(user, list, 1)] = signedInList(list, [], user);
  const box = harness(answers);
  await box.engine.updateSettings({ weeklyCheck: true });
  const start = box.now;
  // The first reader is signed in 2 days in every 9, the other the rest, for 90 days.
  for (let hour = 0; hour < 24 * 90; hour += 6) {
    box.now = Math.max(box.now, start + hour * 3_600_000);
    await box.engine.noteUser(Math.floor(hour / 24) % 9 < 2 ? USER : OTHER);
    await box.drain();
  }
  const checks = (user) => box.requests.filter((url) => url === listPageURL(user, "later", 1)).length;
  assert.ok(checks(USER) >= 9, `the first reader's checks: ${checks(USER)}`);
  assert.ok(checks(OTHER) >= 9, `the other reader's checks: ${checks(OTHER)}`);
});

test("AO3's own greeting decides who is signed in: a list answered for another reader ends the run, not done", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks", [], OTHER),
    [listPageURL(USER, "later", 1)]: signedInList("later"),
  };
  const box = harness(answers);
  // A page told of the first reader, but the session is the other's now.
  await box.engine.noteUser(USER);
  await box.engine.updateSettings({ weeklyCheck: true });
  const checkedAt = box.stored.checkedAt[USER];
  box.now += CHECK_EVERY_MS;
  await box.drain();
  assert.deepEqual(box.requests, [listPageURL(USER, "bookmarks", 1)]);
  assert.equal(box.stored.run, null);
  assert.equal(box.stored.checkedAt[USER], checkedAt, "nothing counted as checked");
  // The greeted reader is the one signed in, new here, so their first check is a week on.
  assert.equal(box.stored.user, OTHER);
  assert.ok(box.stored.checkedAt[OTHER] >= checkedAt + CHECK_EVERY_MS);
  // A message from a form or an old page carries no reader: it changes nothing.
  await box.engine.notePage(readWorkPage(workPage("5")), "visit");
  assert.equal(box.stored.user, OTHER);
  box.now += 60_000;
  await box.drain();
  assert.equal(box.requests.length, 1, "nothing more is asked");
});

test("a stale page of the reader before leaves the new reader's run alone, and that reader's check reads nothing on with the new session", async () => {
  const answers = { [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks", [], OTHER) };
  for (const list of ["bookmarks", "later", "subscriptions"]) answers[listPageURL(OTHER, list, 1)] = signedInList(list, [], OTHER);
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.updateSettings({ weeklyCheck: true });
  const checkedAt = box.stored.checkedAt[USER];
  box.now += CHECK_EVERY_MS;
  // The other reader signs in and backs up; the first reader's old tab, come back from the history or sending a form, says no reader.
  await box.engine.noteUser(OTHER);
  await box.engine.startBackup();
  box.now += await box.engine.tick();
  await box.engine.notePage(readWorkPage(workPage("5")), "visit");
  await box.drain();
  assert.equal(box.stored.user, OTHER);
  assert.equal(box.stored.run.status, "finished");
  assert.deepEqual(box.requests, ["bookmarks", "later", "subscriptions"].map((list) => listPageURL(OTHER, list, 1)));
  // Told of the first reader all the same: their check is due, and AO3's answer to its first read greets the other reader.
  await box.engine.noteUser(USER);
  box.now += 60_000;
  await box.drain();
  assert.deepEqual(box.requests.filter((url) => url.includes(`/users/${USER}/`)), [listPageURL(USER, "bookmarks", 1)]);
  assert.equal(box.stored.user, OTHER);
  assert.equal(box.stored.run, null);
  assert.equal(box.stored.checkedAt[USER], checkedAt, "nothing counted as checked");
});

test("a page and the background on different sessions: the page's reader's check reads with the other session at most once a week", async () => {
  // The pages are the first reader's (a private window, a container); the background has the other's session.
  const answers = { [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks", [], OTHER), [listPageURL(USER, "later", 1)]: { kind: "redirect", url: listPageURL(USER, "later", 1) } };
  for (const list of ["bookmarks", "later"]) answers[listPageURL(OTHER, list, 1)] = signedInList(list, [], OTHER);
  const box = harness(answers);
  await box.engine.updateSettings({ weeklyCheck: true });
  const start = box.now;
  const reads = [];
  for (let hour = 0; hour < 24 * 30; hour += 1) {
    box.now = Math.max(box.now, start + hour * 3_600_000);
    // A fresh page of the first reader each hour.
    await box.engine.noteUser(USER);
    const [before, at] = [box.requests.length, box.now];
    await box.drain();
    for (const url of box.requests.slice(before)) if (url.includes(`/users/${USER}/`)) reads.push(at);
  }
  assert.ok(reads.length >= 3 && reads.length <= 4, `reads of the first reader's lists: ${reads.length}`);
  for (let i = 1; i < reads.length; i += 1) assert.ok(reads[i] - reads[i - 1] >= CHECK_EVERY_MS, "a week apart");
});

test("a read of the reader's lists that greets them lets their weekly check run again at once", async () => {
  const answers = { [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks", [], OTHER), [listPageURL(USER, "later", 1)]: signedInList("later") };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.updateSettings({ weeklyCheck: true });
  box.now += CHECK_EVERY_MS;
  await box.drain();
  assert.equal(box.stored.user, OTHER);
  assert.ok(box.stored.contradicted[USER]);
  // Back with their own session, the reader backs up: AO3 greets them, and their check, due, is no longer held.
  answers[listPageURL(USER, "bookmarks", 1)] = signedInList("bookmarks");
  await box.engine.noteUser(USER);
  await box.drain();
  assert.equal(box.requests.length, 1, "held: nothing is read");
  assert.equal(await box.engine.startBackup(), "started");
  await box.drain();
  assert.equal(box.stored.contradicted[USER], undefined);
  assert.ok(box.requests.filter((url) => url === listPageURL(USER, "later", 1)).length >= 2, "the backup, then the check");
});

test("AO3's greeting names the reader from their own link, never a sign-in or sign-out link", () => {
  const fixture = fs.readFileSync("test/fixtures/ao3_bookmarks.html", "utf8");
  assert.equal(greetedUser(fixture), "Whimsy_FF");
  for (const [kind, page, user] of [
    ["sign-out link first", '<nav id="greeting"><ul><li><a rel="nofollow" href="/users/logout?return_to=%2F">Log Out</a></li></ul></nav>', undefined],
    ["sign-in link", '<nav id="greeting"><ul><li><a href="/users/login">Log In</a></li></ul></nav>', undefined],
    ["a pseud link", `<nav id="greeting"><ul><li><a href="/users/${USER}/pseuds/Other">Hi</a></li></ul></nav>`, USER],
    ["a data-id before the greeting", `<div data-id="greeting"><ul><li><a href="/users/Mallory">x</a></li></ul></div><nav id="greeting"><ul><li><a href="/users/${USER}">Hi</a></li></ul></nav>`, USER],
    ["no list in the greeting, then the site menu", '<nav id="greeting"><a href="/works/new">Post</a></nav><nav><ul><li><a href="/users/Gamma/works">x</a></li></ul></nav>', undefined],
    ["a name too long", `<nav id="greeting"><ul><li><a href="/users/${"a".repeat(41)}">Hi</a></li></ul></nav>`, undefined],
    ["no greeting", "<h1>The Archive is down for maintenance</h1>", undefined],
  ]) assert.equal(greetedUser(page), user, kind);
});

test("the extra Bookmarks read ends the list only when it greets the run's own reader", async () => {
  for (const [kind, bookmarks, after] of [
    ["the run's reader", signedInList("bookmarks"), { list: 2 }],
    ["another reader", signedInList("bookmarks", [], OTHER), { run: "finished" }],
    ["signed in, no greeting", html(listPageURL(USER, "bookmarks", 1), `<body class="logged-in">${listPage([])}</body>`), { list: 1 }],
  ]) {
    const answers = {
      [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks"),
      [listPageURL(USER, "later", 1)]: { kind: "redirect", url: listPageURL(USER, "later", 1) },
      [listPageURL(USER, "subscriptions", 1)]: signedInList("subscriptions"),
    };
    const box = harness(answers);
    await box.engine.noteUser(USER);
    await box.engine.startBackup();
    box.now += await box.engine.tick();
    answers[listPageURL(USER, "bookmarks", 1)] = bookmarks;
    for (let i = 0; i < 2; i += 1) box.now += await box.engine.tick();
    if (after.list !== undefined) assert.equal(box.stored.run.list, after.list, kind);
    if (after.run) assert.equal(box.stored.run.status, after.run, kind);
  }
});

test("a sign-out stop leaves no error count of the list behind it", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: html(listPageURL(USER, "bookmarks", 1), "<h2>Error 500</h2>", 500),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  box.now += await box.engine.tick();
  assert.equal(box.stored.run.errors, 1);
  answers[listPageURL(USER, "bookmarks", 1)] = loggedOutList("bookmarks");
  await box.engine.tick();
  assert.equal(box.stored.pacer.stopped.code, "signed_out");
  assert.equal(box.stored.run.errors, undefined);
});

test("switched off, the AO3 name goes and a run ends; on again, nothing of the reader before is read", async () => {
  const answers = { [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks"), [listPageURL(USER, "later", 1)]: signedInList("later") };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  box.now += await box.engine.tick();
  await box.engine.updateSettings({ enabled: false });
  assert.equal(box.stored.user, null);
  assert.equal(box.stored.run.status, "finished");
  // Off, a page naming a reader is not heard: no name is kept.
  await box.engine.noteUser(OTHER);
  assert.equal(box.stored.user, null);
  await box.engine.updateSettings({ enabled: true });
  await box.drain();
  assert.deepEqual(box.requests, [listPageURL(USER, "bookmarks", 1)]);
  assert.equal(await box.engine.startBackup(), "no_user");
});

test("only a fresh page load's own visit says who is signed in", () => {
  assert.equal(tellsUser("visit", "navigate"), true);
  assert.equal(tellsUser("visit", "reload"), true);
  assert.equal(tellsUser("visit", undefined), true);
  assert.equal(tellsUser("visit", "back_forward"), false);
  for (const trigger of ["bookmark", "later", "subscribe", "kudos"]) assert.equal(tellsUser(trigger, "navigate"), false);
});

test("the extra Bookmarks read counts its own errors, not those of the list before it", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: signedInList("bookmarks"),
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), "<h2>Error 500</h2>", 500),
    [listPageURL(USER, "subscriptions", 1)]: signedInList("subscriptions"),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  box.now += await box.engine.tick();
  // Later errs once, then sends elsewhere.
  box.now += await box.engine.tick();
  assert.equal(box.stored.run.errors, 1);
  answers[listPageURL(USER, "later", 1)] = { kind: "redirect", url: listPageURL(USER, "later", 1) };
  box.now += await box.engine.tick();
  assert.equal(box.stored.run.errors, undefined);
  // Bookmarks, read again, errs twice: Later is not over yet; a third ends it.
  answers[listPageURL(USER, "bookmarks", 1)] = html(listPageURL(USER, "bookmarks", 1), "<h2>Error 500</h2>", 500);
  for (let i = 0; i < 2; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.run.list, 1);
  box.now += await box.engine.tick();
  assert.equal(box.stored.run.list, 2);
});

test("a list page that is gone ends that list; one that errs is tried three times, then ends it; neither stops the run", async () => {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: html(listPageURL(USER, "bookmarks", 1), "", 404),
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), "<h2>Error 500</h2>", 500),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await box.drain();
  assert.equal(box.stored.pacer.stopped, null);
  assert.equal(box.stored.run.status, "finished");
  assert.deepEqual(box.requests, [
    listPageURL(USER, "bookmarks", 1), ...Array(3).fill(listPageURL(USER, "later", 1)), listPageURL(USER, "subscriptions", 1),
  ]);
});

test("a locked work's list value is kept only once its Chapter Index is read: one that failed is asked for again", async () => {
  const lockedFile = lockedFileURL("8", "Invented work 8", "epub", lockedVersion({ chapters: 1, latestAt: dayOf("2026-10-01") }));
  const answers = {
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), listPage([])),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
    [navigateURL("8")]: html(navigateURL("8"), chapterIndex("8")),
    [lockedFile]: file(lockedFile, epub()),
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  const index = (ok) => { answers[navigateURL("8")] = ok ? html(navigateURL("8"), chapterIndex("8")) : html(navigateURL("8"), "", 500); };
  const listing = (updatedAt) => {
    answers[listPageURL(USER, "bookmarks", 1)] = html(listPageURL(USER, "bookmarks", 1), listPage([{ id: "8", restricted: true, updatedAt }]));
  };
  const indexReads = () => box.modes.filter(([url]) => url === navigateURL("8")).length;
  const backup = async (updatedAt) => {
    listing(updatedAt);
    await box.engine.startBackup();
    await box.drain();
  };
  await backup("1761700000");
  assert.equal(box.stored.works["8"].listed, "1761700000");
  index(false);
  await backup("1761800000");
  assert.equal(box.stored.works["8"].listed, "1761700000", "not read: the old value stays");
  index(true);
  await backup("1761800000");
  assert.equal(indexReads(), 3);
  assert.equal(box.stored.works["8"].listed, "1761800000");
  // The weekly check, the same way.
  await box.engine.updateSettings({ weeklyCheck: true });
  const check = async (updatedAt) => {
    listing(updatedAt);
    box.now += CHECK_EVERY_MS;
    await box.drain();
  };
  index(false);
  await check("1761900000");
  assert.equal(box.stored.works["8"].listed, "1761800000");
  index(true);
  await check("1761900000");
  assert.equal(indexReads(), 5);
  assert.equal(box.stored.works["8"].listed, "1761900000");
});

test("a locked work whose new file fails keeps the old list value, so the next list asks for it again", async () => {
  const one = lockedFileURL("8", "Invented work 8", "epub", lockedVersion({ chapters: 1, latestAt: dayOf("2026-10-01") }));
  const two = lockedFileURL("8", "Invented work 8", "epub", lockedVersion({ chapters: 2, latestAt: dayOf("2026-10-20") }));
  const answers = {
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), listPage([])),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), ""),
    [navigateURL("8")]: html(navigateURL("8"), chapterIndex("8")),
    [one]: file(one, epub()),
  };
  const backup = async (updatedAt) => {
    answers[listPageURL(USER, "bookmarks", 1)] = html(listPageURL(USER, "bookmarks", 1), listPage([{ id: "8", restricted: true, updatedAt }]));
    await box.engine.startBackup();
    await box.drain();
  };
  const box = harness(answers);
  await box.engine.noteUser(USER);
  await backup("1761700000");
  assert.equal(box.stored.works["8"].listed, "1761700000");
  // A new chapter, but its file fails: the old copy and the old list value stay.
  answers[navigateURL("8")] = html(navigateURL("8"), chapterIndex("8", { chapters: [["81", "2026-10-01"], ["82", "2026-10-20"]] }));
  answers[two] = file(two, epub(), 500);
  await backup("1761800000");
  assert.equal(box.stored.works["8"].listed, "1761700000");
  assert.equal(box.stored.works["8"].copy.updatedAt, lockedVersion({ chapters: 1, latestAt: dayOf("2026-10-01") }));
  // The next list asks again, and the new file is saved.
  answers[two] = file(two, epub());
  await backup("1761800000");
  assert.equal(box.stored.works["8"].copy.updatedAt, lockedVersion({ chapters: 2, latestAt: dayOf("2026-10-20") }));
  assert.equal(box.stored.works["8"].listed, "1761800000");
});

test("a locked work's copy in another format is copied again once the format is changed, its link unmoved", async () => {
  const epubFile = lockedFileURL("8", "Invented work 8", "epub", lockedVersion({ chapters: 1, latestAt: dayOf("2026-10-01") }));
  const pdfFile = lockedFileURL("8", "Invented work 8", "pdf", lockedVersion({ chapters: 1, latestAt: dayOf("2026-10-01") }));
  const pdf = new Uint8Array(2_000);
  pdf.set(new TextEncoder().encode("%PDF-1.7"));
  const box = harness({ [navigateURL("8")]: html(navigateURL("8"), chapterIndex("8")), [epubFile]: file(epubFile, epub()), [pdfFile]: { ...file(pdfFile, pdf), contentType: "application/pdf" } });
  await box.engine.notePage(readWorkPage(workPage("8", { restricted: true })), "bookmark");
  await box.drain();
  await box.engine.updateSettings({ format: "pdf" });
  await box.engine.notePage(readWorkPage(workPage("8", { restricted: true })), "visit");
  await box.drain();
  assert.deepEqual(box.fileModes.map(([url]) => url), [epubFile, pdfFile]);
  assert.equal(box.stored.works["8"].copy.format, "pdf");
});

test("a busy file fetcher is no stop and no read; after the page was sent, it is the work's try", async () => {
  const box = harness({ [navigateURL("8")]: html(navigateURL("8"), chapterIndex("8")) });
  box.ports.fetchFile = async (url, credentials) => {
    box.fileModes.push([url, credentials]);
    return { kind: "failed", code: "busy" };
  };
  // Nothing sent: a link from the reader's page, its file fetcher taken.
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  for (let i = 0; i < 5; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.pacer.stopped, null);
  assert.equal(box.stored.pacer.window.reads, 0);
  assert.equal(box.stored.queue[0].attempts, 0);
  // A locked work's Chapter Index is sent, then its file fetcher is taken: three tries, then skipped.
  box.engine = new KeepACopy(box.ports);
  box.stored.queue = [];
  await box.engine.notePage(readWorkPage(workPage("8", { restricted: true })), "bookmark");
  for (let i = 0; i < 6 && !box.stored.works["8"].skipped; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.works["8"].skipped, "failed");
  assert.equal(box.stored.pacer.stopped, null);
  assert.equal(box.modes.filter(([url]) => url === navigateURL("8")).length, 3);
});

test("a locked work's file sent elsewhere is not followed: no file, and nothing more is asked", async () => {
  const lockedFile = lockedFileURL("8", "Invented work 8", "epub", lockedVersion({ chapters: 1, latestAt: dayOf("2026-10-01") }));
  const box = harness({ [navigateURL("8")]: html(navigateURL("8"), chapterIndex("8")), [lockedFile]: { kind: "redirect", url: lockedFile } });
  await box.engine.notePage(readWorkPage(workPage("8", { restricted: true })), "bookmark");
  await box.drain();
  assert.deepEqual(box.requests, [navigateURL("8"), lockedFile]);
  assert.deepEqual((await box.engine.view()).skipped, { no_download: 1 });
});

test("the background asks AO3 for works and files signed out, and for the reader's lists with their session", async (t) => {
  // The background's own timers never fire here, so nothing is asked after the test.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push([String(url), init?.credentials]);
    if (String(url).includes("/downloads/")) return new Response(epub(), { headers: { "content-type": "application/epub+zip" } });
    const text = String(url).includes("/users/") ? listPage([]) : workPage("5");
    return new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const fetched = await requestAO3(epubLink("5"), "file", 5_000, 1_000_000);
  URL.revokeObjectURL(fetched.handle);
  const locked = await requestAO3(epubLink("6"), "file", 5_000, 1_000_000, "include");
  URL.revokeObjectURL(locked.handle);
  assert.deepEqual(asked.splice(0), [[epubLink("5"), "omit"], [epubLink("6"), "include"]]);

  const listener = () => ({ addListener() {} });
  const install = () => {
    const stored = {};
    return installKeepACopy({
      runtime: { id: "keep", sendMessage: async () => null, onConnect: listener(), onMessage: listener() },
      storage: { local: { get: async (key) => structuredClone({ [key]: stored[key] }), set: async (items) => { Object.assign(stored, structuredClone(items)); } } },
      alarms: { create() {}, get: async () => ({ name: "keep-a-copy" }), onAlarm: listener() },
      downloads: { download: async () => 1, search: async () => [], removeFile: async () => undefined, cancel: async () => undefined, erase: async () => [], onChanged: { addListener() {}, removeListener() {} } },
    });
  };
  const work = install();
  await work.noteWork("5", "bookmark");
  await work.tick();
  const lists = install();
  await lists.noteUser(USER);
  await lists.startBackup();
  await lists.tick();
  assert.deepEqual(asked, [[workURL("5"), "omit"], [listPageURL(USER, "bookmarks", 1), "include"]]);
});

// --- The standalone build ---------------------------------------------------------------

test("the standalone manifests ask for downloads and AO3, nothing more", () => {
  const chrome = keepACopyManifest("chrome");
  const firefox = keepACopyManifest("firefox");
  assert.deepEqual(chrome.permissions, ["downloads", "storage", "alarms", "downloads.ui", "offscreen"]);
  assert.deepEqual(firefox.permissions, ["downloads", "storage", "alarms"]);
  for (const manifest of [chrome, firefox]) {
    assert.deepEqual(manifest.host_permissions, ["https://archiveofourown.org/*", "https://*.archiveofourown.org/*"]);
    assert.deepEqual(manifest.content_scripts.flatMap((script) => script.matches), ["https://archiveofourown.org/*"]);
    assert.equal(manifest.optional_permissions, undefined);
    assert.equal(manifest.externally_connectable, undefined);
  }
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"] });
  assert.equal(firefox.browser_specific_settings.gecko_android, undefined);
});

/** The downloads API over `items`, recording what is cancelled and erased. */
function fakeDownloads(items) {
  const touched = [];
  return {
    touched,
    items,
    search: async (query) => items.filter((item) => ("id" in query ? item.id === query.id : item.url === query.url)),
    cancel: async (id) => { touched.push(["cancel", id]); },
    erase: async ({ id }) => { touched.push(["erase", id]); return [id]; },
    removeFile: async (id) => { touched.push(["removeFile", id]); },
    onChanged: { addListener() {}, removeListener() {} },
  };
}

test("a save is its own download by its URL: after a restart, another download at its id is left alone", async () => {
  const handle = "blob:keep-a-copy/1";
  // The reader's own paused download now has the save's old id; the save is nowhere.
  const theirs = { id: 1, url: "https://example.org/big.iso", filename: "/home/reader/Downloads/big.iso", state: "interrupted" };
  const restarted = fakeDownloads([theirs]);
  const ports = downloadPorts(restarted, "ext");
  assert.deepEqual(await ports.settle(1, handle), { state: "interrupted", filename: null });
  await ports.cancel(1, handle);
  assert.deepEqual(restarted.touched, [], "the reader's download is not touched");
  // The save found again under another id: that one is the save's, and its id is told.
  const found = fakeDownloads([theirs, { id: 7, url: handle, filename: "/home/reader/Downloads/AO3/F/T – A (1).epub", state: "complete" }]);
  assert.deepEqual(await downloadPorts(found, "ext").settle(1, handle), { state: "complete", filename: "/home/reader/Downloads/AO3/F/T – A (1).epub", downloadId: 7 });
  const cut = fakeDownloads([theirs, { id: 7, url: handle, filename: "/x.epub", state: "interrupted" }]);
  await downloadPorts(cut, "ext").cancel(1, handle);
  assert.deepEqual(cut.touched, [["cancel", 7], ["erase", 7]]);
  // Another extension's download with the same URL is not ours.
  assert.equal(await ownDownload(fakeDownloads([{ id: 1, url: handle, filename: "/x", state: "complete", byExtensionId: "other" }]), "ext", 1, handle), undefined);
});

test("after a restart, a save whose id is another download's is lost and tried again, the other left alone", async () => {
  const box = harness({ [epubLink("1")]: file(epubLink("1"), epub()) });
  const downloads = fakeDownloads([]);
  const ports = downloadPorts(downloads, "ext");
  Object.assign(box.ports, { settle: ports.settle, cancel: ports.cancel });
  box.ports.save = async (request) => {
    box.saved.push(request);
    // The first save is cut off by a restart; the second completes.
    if (box.saved.length === 2) downloads.items.push({ id: 2, url: request.handle, filename: `/home/reader/Downloads/${request.filename}`, state: "complete" });
    return box.saved.length;
  };
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  await box.engine.tick();
  assert.equal(box.stored.pending.downloadId, 1);
  // After the restart, id 1 is the reader's own paused download.
  downloads.items.push({ id: 1, url: "https://example.org/big.iso", filename: "/home/reader/Downloads/big.iso", state: "interrupted" });
  box.engine = new KeepACopy(box.ports);
  await box.drain();
  assert.equal(downloads.touched.some(([, id]) => id === 1), false, "the reader's download is left alone");
  assert.equal(box.saved.length, 2, "the save is tried again");
  assert.equal(box.stored.works["1"].copy.downloadId, 2);
});

test("an old file is deleted only while its download is the copy's own: one the reader saved there by hand is left", async () => {
  const path = "/home/reader/Downloads/AO3/F/T – A (1).epub";
  const url = "blob:keep-a-copy/1";
  // A later session: the reader saved a file by hand at the copy's path, and it has the copy's old id.
  const byHand = fakeDownloads([{ id: 1, url: "https://example.org/T.epub", filename: path, state: "complete" }]);
  await downloadPorts(byHand, "ext").remove(1, path, url);
  assert.deepEqual(byHand.touched, [], "the reader's file is left");
  // The copy's own download, found by its URL under another id: deleted.
  const own = fakeDownloads([{ id: 1, url: "https://example.org/T.epub", filename: path, state: "complete" }, { id: 4, url, filename: path, state: "complete" }]);
  await downloadPorts(own, "ext").remove(1, path, url);
  assert.deepEqual(own.touched, [["removeFile", 4], ["erase", 4]]);
  // A copy with no URL kept is only forgotten.
  const old = fakeDownloads([{ id: 1, url, filename: path, state: "complete" }]);
  await downloadPorts(old, "ext").remove(1, path);
  assert.deepEqual(old.touched, []);
});

test("a copy keeps the URL it was saved from, and a renamed copy's old file is asked to go by it", async () => {
  const box = harness({ [epubLink("1")]: file(epubLink("1"), epub()), [epubLink("1", "2")]: file(epubLink("1", "2"), epub()) });
  const removed = [];
  box.ports.remove = async (id, filename, url) => { removed.push([id, url]); };
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  await box.drain();
  assert.equal(box.stored.works["1"].copy.url, box.saved[0].handle);
  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "2", title: "Renamed" })), "visit");
  await box.drain();
  assert.deepEqual(removed, [[1, box.saved[0].handle]]);
});

test("the standalone's icons: every size, the two small ones its own drawing, in the manifest and the toolbar", async () => {
  const chrome = keepACopyManifest("chrome");
  assert.deepEqual(Object.keys(chrome.icons), ["16", "32", "48", "128"]);
  assert.deepEqual(Object.keys(chrome.action.default_icon), ["16", "32"]);
  assert.deepEqual(keepACopyManifest("firefox").icons, chrome.icons);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "keep-a-copy-icons-"));
  try {
    await writeIcons(out);
    for (const size of ICON_SIZES) {
      const png = fs.readFileSync(path.join(out, chrome.icons[size]));
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  const svg = (name) => fs.readFileSync(new URL(`../../src/keep-a-copy/${name}`, import.meta.url), "utf8");
  assert.match(svg("icon-small.svg"), /viewBox="0 0 16 16"/);
  assert.match(svg("icon-large.svg"), /viewBox="0 0 128 128"/);
});

test("copies go in the one folder this build names", () => {
  assert.equal(NAME, COPY_FOLDER);
  const name = copyFilename({ workId: "1", title: "T", author: "A", fandom: "F" }, "epub");
  assert.equal(name, `${COPY_FOLDER}/F/T – A (1).epub`);
  assert.equal(name.startsWith("AO3/"), false);
});

// --- A backup in the popup -------------------------------------------------------------

/** Three lists: `bookmarks` and `later` as ids, each with a page and a file. */
function backupBox({ bookmarks = ["1", "2"], later = [], subscriptions = [], extra = {} } = {}) {
  const answers = {
    [listPageURL(USER, "bookmarks", 1)]: html(listPageURL(USER, "bookmarks", 1), listPage(bookmarks)),
    [listPageURL(USER, "later", 1)]: html(listPageURL(USER, "later", 1), listPage(later, { kind: "reading" })),
    [listPageURL(USER, "subscriptions", 1)]: html(listPageURL(USER, "subscriptions", 1), subscriptions.map((id) => `<dl><dt><a href="/works/${id}">x</a></dt></dl>`).join("")),
  };
  for (const id of new Set([...bookmarks, ...later, ...subscriptions])) {
    answers[workURL(id)] = html(workURL(id), workPage(id));
    answers[epubLink(id)] = file(epubLink(id), epub());
  }
  const box = harness({ ...answers, ...extra });
  return box;
}

const step = async (box, count = 1) => {
  for (let i = 0; i < count; i += 1) {
    const wait = await box.engine.tick();
    if (wait === null) return;
    box.now += wait;
  }
};

test("a backup reads all its lists first, so its total is known, and counts a work on two lists once", async () => {
  const box = backupBox({ bookmarks: ["1", "2"], later: ["2", "3"], subscriptions: ["3"] });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await step(box, 2);
  let { backup } = await box.engine.view();
  assert.equal(backup.readingLists, true);
  assert.equal(backup.estimateMs, null);
  await step(box, 1);
  assert.deepEqual(box.requests, [listPageURL(USER, "bookmarks", 1), listPageURL(USER, "later", 1), listPageURL(USER, "subscriptions", 1)]);
  ({ backup } = await box.engine.view());
  assert.deepEqual({ state: backup.state, done: backup.done, total: backup.total, readingLists: backup.readingLists }, { state: "running", done: 0, total: 3, readingLists: false });
  assert.equal(backup.estimateMs, 3 * WORK_PACE_MS);
  await box.drain();
  assert.equal((await box.engine.view()).backup, null);
  assert.equal(box.saved.length, 3);
});

test("the estimate comes from the real pace, and a long gap starts the measure again", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => String(i + 1));
  const box = backupBox({ bookmarks: ids });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await step(box, 3);
  const finishWork = async () => {
    const before = box.stored.queue.length;
    for (let i = 0; i < 12 && box.stored.queue.length === before; i += 1) await step(box);
  };
  for (let i = 0; i < PACE_MIN_WORKS; i += 1) {
    await finishWork();
    box.now += 60_000;
  }
  const { backup } = await box.engine.view();
  assert.equal(backup.done, PACE_MIN_WORKS);
  assert.ok(backup.estimateMs > (ids.length - PACE_MIN_WORKS) * 60_000, "measured, not assumed");
  // The browser closed overnight: not counted as pace.
  box.now += PACE_GAP_MS * 100;
  await finishWork();
  const after = await box.engine.view();
  assert.equal(after.backup.estimateMs, after.backup.total === after.backup.done ? 0 : (ids.length - after.backup.done) * WORK_PACE_MS);
});

test("Pause holds every queued work, a new one too, and Resume picks up where it stopped", async () => {
  const box = backupBox({ bookmarks: ["1", "2", "3"], extra: {
    [workURL("9")]: html(workURL("9"), workPage("9")),
    [epubLink("9")]: file(epubLink("9"), epub()),
  } });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await step(box, 3);
  const before = box.requests.length;
  await box.engine.stopBackup();
  let view = await box.engine.view();
  assert.equal(view.backup.state, "stopped");
  assert.equal(view.backup.estimateMs, null);
  box.now += 3_600_000;
  assert.equal(await box.engine.tick(), null);
  assert.equal(box.requests.length, before);
  assert.equal(box.quiet.at(-1), false);

  await box.engine.noteWork("9", "bookmark");
  assert.equal(await box.engine.tick(), null);
  assert.equal(box.requests.length, before);
  assert.equal((await box.engine.view()).backup.state, "stopped");

  await box.engine.resumeBackup();
  view = await box.engine.view();
  assert.equal(view.backup.state, "running");
  assert.equal(view.backup.done, 0);
  await box.drain();
  assert.equal(box.saved.length, 4);
  assert.equal((await box.engine.view()).backup, null);
});

test("Pause holds a work queued at the weekly check's pace", async () => {
  const box = backupBox({ bookmarks: ["1"], extra: { [workURL("7")]: html(workURL("7"), workPage("7", { updatedAt: "2" })) } });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await step(box, 3);
  box.stored.queue.push({ workId: "7", pace: "check" });
  box.engine = new KeepACopy(box.ports);
  const before = box.requests.length;
  await box.engine.stopBackup();
  box.now += 3_600_000;
  assert.equal(await box.engine.tick(), null);
  assert.equal(box.requests.length, before);
});

test("a backup that lists a work already queued counts it, and it waits with the backup", async () => {
  const box = backupBox({ bookmarks: ["1", "2"] });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  box.stored.queue.push({ workId: "2", pace: "check" });
  box.engine = new KeepACopy(box.ports);
  await step(box, 1);
  assert.equal(box.stored.queue.find((queued) => queued.workId === "2").batch, true);
  await step(box, 2);
  const { backup } = await box.engine.view();
  assert.deepEqual([backup.done, backup.total], [0, 2]);
  assert.deepEqual(box.requests.slice(0, 3), [listPageURL(USER, "bookmarks", 1), listPageURL(USER, "later", 1), listPageURL(USER, "subscriptions", 1)]);
});

test("Pause while the lists are being read holds the next page too", async () => {
  const box = backupBox();
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await step(box);
  await box.engine.stopBackup();
  box.now += 3_600_000;
  assert.equal(await box.engine.tick(), null);
  assert.equal(box.requests.length, 1);
  await box.engine.resumeBackup();
  await box.drain();
  assert.equal(box.saved.length, 2);
});

// --- Skipped works ----------------------------------------------------------------------

test("Try again goes back through the queue: its pace, its stops and a Pause all hold", async () => {
  let fixed = false;
  const box = backupBox({ bookmarks: ["1", "2"], extra: {
    [epubLink("1")]: () => (fixed ? file(epubLink("1"), epub()) : html(epubLink("1"), "<html>nope</html>")),
    [epubLink("2")]: () => (fixed ? file(epubLink("2"), epub()) : html(epubLink("2"), "<html>nope</html>")),
  } });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await box.drain();
  assert.deepEqual((await box.engine.view()).skipped, { not_a_file: 2 });
  fixed = true;

  // The pace: nothing goes before it is due.
  box.stored.pacer.dueAt = box.now + 5_000;
  const engine = new KeepACopy(box.ports);
  box.engine = engine;
  await engine.retrySkipped();
  assert.deepEqual((await engine.view()).skipped, {});
  const asked = box.requests.length;
  assert.equal(await engine.tick(), 5_000);
  assert.equal(box.requests.length, asked);

  // A stop: nothing goes until it is over.
  box.now += 5_000;
  const stopped = box.stored;
  stopped.pacer.stopped = { code: "challenge", until: box.now + 1_000 };
  box.engine = new KeepACopy(box.ports);
  assert.equal(await box.engine.tick(), 1_000);
  assert.equal(box.requests.length, asked);
  box.now += 1_000;

  await box.drain();
  assert.equal(box.saved.length, 2);
  assert.deepEqual((await box.engine.view()).skipped, {});
});

test("Try again waits behind a Pause, and a file that still fails counts toward a stop", async () => {
  const box = backupBox({ bookmarks: ["1", "2", "3"], extra: Object.fromEntries(["1", "2", "3"].map((id) => [epubLink(id), html(epubLink(id), "<html>nope</html>")])) });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  // Lists, then both failing works: page and file each.
  await step(box, 7);
  assert.deepEqual((await box.engine.view()).skipped, { not_a_file: 2 });
  await box.engine.stopBackup();
  await box.engine.retrySkipped();
  const asked = box.requests.length;
  box.now += 3_600_000;
  assert.equal(await box.engine.tick(), null);
  assert.equal(box.requests.length, asked);
  await box.engine.resumeBackup();
  for (let i = 0; i < 6 && !box.stored.pacer.stopped; i += 1) box.now += await box.engine.tick();
  assert.equal(box.stored.pacer.stopped.code, "unreadable");
  assert.ok(RETRYABLE_SKIPS.includes("not_a_file") && !RETRYABLE_SKIPS.includes("gone") && !RETRYABLE_SKIPS.includes("needs_sign_in"));
});

// --- Paused, or AO3 not available --------------------------------------------------------

test("AO3 giving a time is a pause, whatever failed", async () => {
  const box = harness({ [workURL("1")]: html(workURL("1"), "Retry later", 429, { retryAfter: "3600" }) });
  await box.engine.noteWork("1", "bookmark");
  for (let i = 0; i < 3; i += 1) {
    box.now = box.stored.pacer.dueAt;
    await box.engine.tick();
  }
  const { stopped } = await box.engine.view();
  assert.equal(stopped.code, "slow_down");
  assert.equal(stopped.unavailable, undefined);
  assert.equal(stopped.until, box.stored.pacer.stopped.until);
});

test("one 429 with a time shows as a pause until that time, then not", async () => {
  const box = harness({ [workURL("1")]: html(workURL("1"), "Retry later", 429, { retryAfter: "90" }) });
  await box.engine.noteWork("1", "bookmark");
  await box.engine.tick();
  const { stopped } = await box.engine.view();
  assert.equal(stopped.code, "slow_down");
  assert.equal(stopped.unavailable, undefined);
  assert.equal(stopped.until, NOW + 90_000);
  assert.equal(box.stored.pacer.dueAt, NOW + 90_000);
  box.now = NOW + 90_001;
  assert.equal((await box.engine.view()).stopped, null);
});

test("one failure with no time is never unavailable", async () => {
  const box = harness({ [workURL("1")]: html(workURL("1"), "refused", 403) });
  await box.engine.noteWork("1", "bookmark");
  await box.engine.tick();
  const { stopped } = await box.engine.view();
  assert.equal(stopped.code, "forbidden");
  assert.equal(stopped.unavailable, undefined);
  assert.equal(stopped.until, NOW + STOP_MS);
});

test("repeated failure with no time is unavailable, the queue keeps trying politely, and an answer ends it", async () => {
  let down = true;
  const box = harness({
    [workURL("1")]: () => (down ? { kind: "failed", code: "network" } : html(workURL("1"), workPage("1"))),
    [workURL("2")]: () => (down ? html(workURL("2"), "Bad gateway", 502) : html(workURL("2"), workPage("2"))),
    [epubLink("2")]: file(epubLink("2"), epub()),
  });
  await box.engine.noteWork("2", "bookmark");
  await step(box);
  assert.equal((await box.engine.view()).stopped, null, "never on one");
  await step(box);
  assert.equal((await box.engine.view()).stopped, null);
  await step(box);
  let view = await box.engine.view();
  assert.equal(view.stopped.unavailable, true);
  assert.equal(view.backup, null);
  assert.ok(box.stored.pacer.stopped.until >= box.now);
  // Tries again, and between tries it still says so.
  box.now = box.stored.pacer.stopped.until;
  await box.engine.tick();
  view = await box.engine.view();
  assert.equal(view.stopped.unavailable, true);
  down = false;
  await box.drain();
  view = await box.engine.view();
  assert.equal(view.stopped, null);
  assert.equal(box.saved.length, 1);
  assert.equal(box.stored.pacer.failures, 0);
});

test("an outage skips no work: no answer charges nothing, and the copies carry on when AO3 is back", async () => {
  let down = true;
  const ids = ["1", "2", "3", "4"];
  const answers = {};
  for (const id of ids) {
    answers[workURL(id)] = () => (down ? { kind: "failed", code: "network" } : html(workURL(id), workPage(id)));
    answers[epubLink(id)] = () => file(epubLink(id), epub());
  }
  const box = harness(answers);
  for (const id of ids) await box.engine.noteWork(id, "bookmark");
  // A day of it: the queue stops and tries again every hour.
  for (let i = 0; i < 60; i += 1) box.now += await box.engine.tick();
  const view = await box.engine.view();
  assert.deepEqual(view.skipped, {});
  assert.equal(box.stored.queue.length, 4);
  assert.ok(box.stored.queue.every((queued) => (queued.attempts ?? 0) === 0));
  down = false;
  await box.drain();
  assert.equal(box.saved.length, 4);
  assert.deepEqual((await box.engine.view()).skipped, {});
});

test("one work that never answers holds up no other, and is not skipped for it", async () => {
  const box = harness({
    [workURL("1")]: () => ({ kind: "failed", code: "timeout" }),
    [workURL("2")]: html(workURL("2"), workPage("2")),
    [epubLink("2")]: file(epubLink("2"), epub()),
  });
  await box.engine.noteWork("1", "bookmark");
  await box.engine.noteWork("2", "bookmark");
  await step(box, 4);
  assert.deepEqual(box.saved.map((saved) => saved.filename.includes("(2)")), [true]);
  assert.equal(box.stored.works["1"].skipped, null);
});

test("signing out mid-backup says so, counts against AO3 for nothing, and the next signed-in page ends it", async () => {
  const lists = html(listPageURL(USER, "bookmarks", 1), listPage(["1"]));
  let signedIn = false;
  const box = backupBox({ bookmarks: ["1"], extra: {
    [listPageURL(USER, "bookmarks", 1)]: () => (signedIn ? lists : html(`${AO3_ORIGIN}/users/login?restricted=true`, '<body class="logged-out"><form action="/users/login"></form></body>')),
  } });
  await box.engine.noteUser(USER);
  await box.engine.startBackup();
  await box.engine.tick();
  let view = await box.engine.view();
  assert.equal(view.stopped.code, "signed_out");
  assert.equal(view.stopped.unavailable, undefined);
  assert.equal(box.stored.pacer.failures, 0);
  assert.equal(view.backup.estimateMs, null);
  // Nothing is asked again before the reader is back, however long they take.
  const asked = box.requests.length;
  box.now += STOP_MS * 5;
  await box.engine.tick();
  assert.equal(box.requests.length, asked);
  assert.equal((await box.engine.view()).stopped.code, "signed_out");
  // A page that does not say is not the reader signing in.
  signedIn = true;
  await box.engine.noteUser(null);
  assert.equal((await box.engine.view()).stopped.code, "signed_out");
  await box.engine.noteUser(USER);
  view = await box.engine.view();
  assert.equal(view.stopped, null);
  await box.drain();
  assert.equal(box.saved.length, 1);
  assert.equal((await box.engine.view()).stopped, null);
});

test("a run of works that cannot be read is no failure of AO3's being there; nor are files that cannot be saved", async () => {
  const unreadable = harness(Object.fromEntries(["1", "2", "3"].map((id) => [workURL(id), html(workURL(id), "<html></html>")])));
  for (const id of ["1", "2", "3"]) await unreadable.engine.noteWork(id, "bookmark");
  for (let i = 0; i < 6 && !unreadable.stored?.pacer.stopped; i += 1) {
    unreadable.now = unreadable.stored.pacer.dueAt;
    await unreadable.engine.tick();
  }
  const stoppedRead = await unreadable.engine.view();
  assert.equal(stoppedRead.stopped.code, "unreadable");
  assert.equal(stoppedRead.stopped.unavailable, undefined);
  assert.equal(unreadable.stored.pacer.failures, 0);

  const full = harness(Object.fromEntries(["1", "2", "3"].map((id) => [epubLink(id), file(epubLink(id), epub())])));
  full.ports.save = async () => { throw new Error("disk full"); };
  for (const id of ["1", "2", "3"]) await full.engine.notePage(readWorkPage(workPage(id)), "bookmark");
  for (let i = 0; i < 12 && !full.stored?.pacer.stopped; i += 1) {
    full.now = full.stored.pacer.dueAt;
    await full.engine.tick();
  }
  const { stopped } = await full.engine.view();
  assert.equal(stopped.code, "save_failed");
  assert.equal(stopped.unavailable, undefined);
});

test("a page says the reader is signed out only with AO3's login link", () => {
  const page = (body) => new JSDOM(`<!doctype html><body>${body}</body>`).window.document;
  assert.equal(signedInUser(page(`<div id="header"><ul id="greeting"><li><a href="/users/${USER}">Hi</a></li></ul></div>`)), USER);
  assert.equal(signedInUser(page('<div id="header"><div id="login"><p><a id="login-dropdown" href="/users/login">Log In</a></p></div></div>')), null);
  assert.equal(signedInUser(page('<div id="header"><a href="/users/login">Log In</a></div>')), null);
  assert.equal(signedInUser(page('<div id="header"><ul id="greeting"><li><a href="/users/login">Log In</a></li></ul></div>')), null);
  // A 429, a check page, and a link in someone's work are not the reader signing out.
  assert.equal(signedInUser(page("Retry later")), undefined);
  assert.equal(signedInUser(page('<div id="challenge-form">Just a moment...</div>')), undefined);
  assert.equal(signedInUser(page('<div class="userstuff"><a href="/users/login">a link in a story</a></div>')), undefined);
});

test("the view says when the last copy was saved", async () => {
  const box = harness({ [workURL("1")]: html(workURL("1"), workPage("1")), [epubLink("1")]: file(epubLink("1"), epub()) });
  assert.equal((await box.engine.view()).lastCopyAt, null);
  await box.engine.noteWork("1", "bookmark");
  await box.drain();
  assert.equal((await box.engine.view()).lastCopyAt, box.stored.works["1"].copy.savedAt);
});

// A page's own script may cancel the click on a form's submit button and send the form itself.
test("a form sent from a click the page cancels still counts, once", () => {
  const { document } = new JSDOM(`<form id="kudos" action="/kudos"><input type="submit" id="send"></form>
    <form id="later" action="/works/1/mark_for_later"><button type="submit" id="mark">Mark for Later</button></form>
    <form id="plain" action="/works/1/bookmarks"><input type="text" id="note"><input type="submit" id="create"></form>
    <button id="other">Not in a form</button>`).window;
  const sent = [];
  watchForms(document, (form) => sent.push(form.id));
  document.addEventListener("submit", (event) => event.preventDefault());

  document.getElementById("send").addEventListener("click", (event) => event.preventDefault());
  document.getElementById("send").click();
  assert.deepEqual(sent, ["kudos"], "the click is all there is");

  document.getElementById("mark").click();
  assert.deepEqual(sent, ["kudos", "later"], "a click and its submit count once");

  document.getElementById("plain").requestSubmit();
  assert.deepEqual(sent, ["kudos", "later", "plain"], "a submit with no click");

  document.getElementById("note").click();
  document.getElementById("other").click();
  assert.equal(sent.length, 3, "other clicks are nothing");
});

test("an update that comes while a copy is saving is still fetched", async () => {
  const box = harness({ [epubLink("1", "1")]: file(epubLink("1", "1"), epub()), [epubLink("1", "2")]: file(epubLink("1", "2"), epub()) });
  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "1" })), "bookmark");
  await box.engine.tick();
  assert.equal(box.stored.pending.updatedAt, "1", "the save is under way");
  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "2" })), "visit");
  await box.drain();
  assert.equal(box.stored.works["1"].copy.updatedAt, "2");
  assert.deepEqual(box.requests, [epubLink("1", "1"), epubLink("1", "2")]);
  assert.equal(box.stored.queue.length, 0);
});

test("the same page again while a copy is saving asks for nothing more", async () => {
  const box = harness({ [epubLink("1", "1")]: file(epubLink("1", "1"), epub()) });
  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "1" })), "bookmark");
  await box.engine.tick();
  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "1" })), "visit");
  await box.drain();
  assert.deepEqual(box.requests, [epubLink("1", "1")]);
  assert.equal(box.stored.queue.length, 0);
});

test("a page's message sent again is handled once: a work just skipped is not read again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = globalThis.fetch;
  const asked = [];
  // A page with no Download menu: the work is skipped, a miss.
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(workPage("5").replace(/<li class="download">[\s\S]*?<\/ul>\n    <\/li>/, ""), { headers: { "content-type": "text/html" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  let onMessage;
  const listener = () => ({ addListener() {} });
  const stored = {};
  const engine = installKeepACopy({
    runtime: { id: "keep", sendMessage: async () => null, onConnect: listener(), onMessage: { addListener: (heard) => { onMessage = heard; } } },
    storage: { local: { get: async (key) => structuredClone({ [key]: stored[key] }), set: async (items) => { Object.assign(stored, structuredClone(items)); } } },
    alarms: { create() {}, get: async () => ({ name: "keep-a-copy" }), onAlarm: listener() },
    downloads: { download: async () => 1, search: async () => [], removeFile: async () => undefined, cancel: async () => undefined, erase: async () => [], onChanged: { addListener() {}, removeListener() {} } },
  });
  const send = (message) => new Promise((respond) => onMessage(message, { id: "keep", url: `${AO3_ORIGIN}/works/5/bookmarks` }, respond));
  const bookmark = { type: "KEEP_A_COPY_PAGE", trigger: "bookmark", html: "", workId: "5", id: "0b9f1c52-5a1e-4f37-9d55-41c4b0a7e8d2" };
  await send(bookmark);
  await engine.tick();
  assert.deepEqual(asked, [workURL("5")]);
  assert.equal(stored.keepACopyV1.works["5"].skipped, "no_download");
  await send(bookmark);
  await engine.tick();
  assert.deepEqual(asked, [workURL("5")]);
  assert.equal((await engine.view()).waiting, 0);
  assert.equal(stored.keepACopyV1.pacer.misses, 1);

  const repeated = repeatedMessage(2);
  assert.deepEqual(["a", "a", "b", "c", "a", undefined, undefined].map(repeated), [false, true, false, false, false, false, false]);
});

test("a link from the reader's page that waited longer than a few minutes is not used: the page is read again first", async () => {
  const box = harness({ [workURL("1")]: html(workURL("1"), workPage("1")), [epubLink("1")]: file(epubLink("1"), epub()) });
  await box.engine.notePage(readWorkPage(workPage("1")), "bookmark");
  box.now += LINK_MAX_AGE_MS + 1;
  await box.drain();
  assert.deepEqual(box.requests, [workURL("1"), epubLink("1")]);
  assert.equal(box.saved.length, 1);
});

test("a work asked for again, with no link, while its copy is saving is looked at once more", async () => {
  const box = harness({
    [epubLink("1", "1")]: file(epubLink("1", "1"), epub()),
    [workURL("1")]: html(workURL("1"), workPage("1", { updatedAt: "2" })),
    [epubLink("1", "2")]: file(epubLink("1", "2"), epub()),
  });
  await box.engine.notePage(readWorkPage(workPage("1", { updatedAt: "1" })), "bookmark");
  await box.engine.tick();
  assert.equal(box.stored.pending.updatedAt, "1", "the save is under way");
  // Asked for again with no link (as a check does): AO3 has a newer version by now.
  await box.engine.noteWork("1", "kudos");
  await box.drain();
  assert.deepEqual(box.requests, [epubLink("1", "1"), workURL("1"), epubLink("1", "2")]);
  assert.equal(box.stored.works["1"].copy.updatedAt, "2");
  assert.equal(box.stored.queue.length, 0);
});

test("what the reader did stays in the tab until it is answered, and the next page sends it", async () => {
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const later = { type: "PAGE", trigger: "later", html: "<li>", workId: "1" };
  const kudos = { type: "PAGE", trigger: "kudos", html: "<li>", workId: "2" };

  // The page goes before the worker answers: the promise never settles.
  const lost = [];
  reliableSender(storage, (message) => { lost.push(message); return new Promise(() => undefined); }).send(later, { user: "Reader" });
  assert.deepEqual(lost, [{ ...later, user: "Reader" }]);
  await flush();
  assert.equal(stored.size, 1, "kept");

  // The next page sends it, without the old page's word on who is signed in, and an answer clears it.
  const again = [];
  const next = reliableSender(storage, async (message) => { again.push(message); return null; });
  next.resend();
  await flush();
  assert.deepEqual(again, [later]);
  assert.equal(stored.size, 0, "answered");
  next.resend();
  await flush();
  assert.equal(again.length, 1, "only once");

  // Refused (no worker to take it): kept for the next page. An answer to one leaves the other.
  const refused = reliableSender(storage, async () => { throw new Error("no receiver"); });
  refused.send(later, {});
  await flush();
  refused.send(kudos, {});
  await flush();
  assert.equal(JSON.parse(stored.get("keepACopyUnanswered")).length, 2);
  const answers = [];
  reliableSender(storage, (message) => new Promise((resolve) => answers.push({ message, resolve }))).resend();
  answers[0].resolve(null);
  await flush();
  assert.deepEqual(JSON.parse(stored.get("keepACopyUnanswered")), [kudos]);

  // Nothing readable in the tab is nothing to send.
  stored.set("keepACopyUnanswered", "not json");
  const none = [];
  reliableSender(storage, async (message) => { none.push(message); }).resend();
  assert.equal(none.length, 0);
});

test("the background listens for the browser opening, so a queue goes on with no page open", () => {
  const listener = () => ({ addListener() {} });
  const startups = [];
  installKeepACopy({
    runtime: { id: "keep", sendMessage: async () => null, onConnect: listener(), onMessage: listener(), onStartup: { addListener: (run) => startups.push(run) } },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
    alarms: { create() {}, onAlarm: listener() },
    downloads: { download: async () => 1, search: async () => [], removeFile: async () => undefined, cancel: async () => undefined, erase: async () => [], onChanged: { addListener() {}, removeListener() {} } },
  });
  assert.equal(startups.length, 1);
});
