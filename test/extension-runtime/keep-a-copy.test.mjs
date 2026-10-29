import assert from "node:assert/strict";
import test from "node:test";

import { PAGE_GAP_MS, RETRY_BASE_MS } from "../../.trace-build/extension-runtime/ao3-history-import.mjs";
import {
  AO3_ORIGIN,
  CHECK_EVERY_MS,
  KeepACopy,
  classifyAnswer,
  copyFilename,
  formTriggerFor,
  isEpub,
  listPageURL,
  readDownloadLink,
  readListPage,
  readWorkPage,
  MAX_ATTEMPTS,
  MAX_NAME_BYTES,
  STOP_MAX_MS,
  STOP_MS,
  safeSegment,
} from "../../.trace-build/extension-runtime/keep-a-copy.mjs";

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
const file = (url, bytes, status = 200) => ({
  kind: "response", status, url, contentType: "application/epub+zip", retryAfter: null, cfMitigated: null,
  bytes: bytes.slice(0, 8_192), size: bytes.length, handle: `blob:keep-a-copy/${url}`,
});
const workURL = (id) => `${AO3_ORIGIN}/works/${id}?view_adult=true`;

function harness(answers = {}) {
  const box = { now: NOW, stored: undefined, saved: [], removed: [], released: [], requests: [], quiet: [], downloads: new Map() };
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
    fetchPage: answer,
    fetchFile: answer,
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
  assert.equal(locked.signedIn, true);
  assert.equal(readWorkPage(workPage("5", { signedIn: false })).signedIn, false);
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
  assert.deepEqual(classifyAnswer(html(`${AO3_ORIGIN}/users/login?restricted=true`, "<form action=\"/users/login\">"), "page", NOW), { kind: "skip", code: "needs_sign_in" });
});

// --- File names -----------------------------------------------------------------------

test("builds file names that are safe everywhere", () => {
  assert.equal(copyFilename({ workId: "123", title: "Lanterns: A/B?", author: "Quill", fandom: "Invented <Lanterns>" }, "epub"),
    "AO3/Invented -Lanterns-/Lanterns- A-B- – Quill (123).epub");
  assert.equal(safeSegment("CON", 10, "x"), "_CON");
  assert.equal(safeSegment("con.txt", 10, "x"), "_con.txt");
  assert.equal(safeSegment("Tide\u200b\u202eRev\u0007", 20, "x"), "TideRev");
  assert.equal(safeSegment("...hidden. ", 20, "x"), "hidden");
  assert.equal(safeSegment("   ", 20, "Untitled"), "Untitled");
  assert.equal([...safeSegment("é".repeat(200), 80, "x")].length, 40);
  // A long title gives way; the id and extension always stay.
  const long = copyFilename({ workId: "123456789", title: "長".repeat(300), author: "A".repeat(300), fandom: "F" }, "epub", "updated 2026-10-29 1000");
  const name = long.split("/").at(-1);
  assert.ok(new TextEncoder().encode(name).length <= MAX_NAME_BYTES);
  assert.match(name, / \(123456789\) \(updated 2026-10-29 1000\)\.epub$/);
  assert.equal(copyFilename({ workId: "1", title: "T", author: "A", fandom: "F" }, "pdf", "updated 2026-10-29 1000"), "AO3/F/T – A (1) (updated 2026-10-29 1000).pdf");
});

// --- The queue --------------------------------------------------------------------------

test("a bookmark keeps the work: one file, from the page's own link", async () => {
  const box = harness({ [epubLink("123")]: file(epubLink("123"), epub()) });
  await box.engine.notePage(readWorkPage(workPage("123")), "bookmark");
  await box.drain();
  assert.deepEqual(box.requests, [epubLink("123")]);
  assert.equal(box.saved.length, 1);
  assert.equal(box.saved[0].filename, "AO3/Invented Lanterns/Invented work 123 – Synthetic_Quill (123).epub");
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
  box.ports.fetchPage = box.ports.fetchFile = async (url) => { times.push(box.now); return fetchPage(url); };
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

test("the old file goes only once the new one is complete; an interrupted save keeps it", async () => {
  const box = harness({
    [epubLink("1")]: file(epubLink("1"), epub()),
    [epubLink("1", "2")]: file(epubLink("1", "2"), epub()),
    [epubLink("1", "3")]: file(epubLink("1", "3"), epub()),
  });
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
  await box.drain(4);
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

// --- Fix round 2 ----------------------------------------------------------------------

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
