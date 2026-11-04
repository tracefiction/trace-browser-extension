import assert from "node:assert/strict";
import test from "node:test";

import { AO3_ORIGIN, COPY_FOLDER, KeepACopy, lockedFileURL, lockedVersion, ownName } from "../../.trace-build/extension-runtime/keep-a-copy.mjs";
import {
  KEEP_A_COPY_PREF_KEY,
  LIBRARY_DEFAULTS,
  LIBRARY_WHOLE_BELOW,
  LIBRARY_SYNC_ALARM,
  TraceLibraryCopies,
  installTraceKeepACopy,
  libraryList,
  publishedChapters,
  readerStatus,
} from "../../.trace-build/extension-runtime/keep-a-copy-library.mjs";
import { ACCOUNT_PROJECTION_REVISION_KEY } from "../../.trace-build/extension-runtime/runtime-messages.mjs";
import { IndexedDbKeepStore, PACER_KEY } from "../../.trace-build/extension-runtime/keep-a-copy-store.mjs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

// Invented works throughout, as in keep-a-copy.test.mjs.
const NOW = Date.parse("2026-10-29T10:00:00Z");

function workPage(id, { updatedAt = "1761700000", restricted = false, signedIn = true } = {}) {
  const link = (ext) => `<li><a href="/downloads/${id}/Invented_work.${ext}?updated_at=${updatedAt}">${ext.toUpperCase()}</a></li>`;
  return `<html><body class="${signedIn ? "logged-in" : "logged-out"}">` +
    `<ul class="work navigation actions"><li class="download"><button>Download</button><ul class="expandable secondary">${["epub", "pdf"].map(link).join("")}</ul></li></ul>` +
    `<dl class="work meta group"><dd class="fandom tags"><ul><li><a class="tag" href="/tags/x/works">Invented Lanterns</a></li></ul></dd>` +
    `<dd class="chapters">3/10</dd></dl><div class="preface group"><h2 class="title heading">` +
    `${restricted ? '<img alt="(Restricted)" src="/images/lockblue.png" />' : ""}Invented work ${id}</h2>` +
    `<h3 class="byline heading"><a rel="author" href="/users/Quill/pseuds/Quill">Synthetic_Quill</a></h3></div></body></html>`;
}

function epub(size = 2_000) {
  const bytes = new Uint8Array(size);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  bytes.set(new TextEncoder().encode("mimetypeapplication/epub+zip"), 30);
  return bytes;
}

const html = (url, text, status = 200) => ({ kind: "response", status, url, contentType: "text/html", retryAfter: null, cfMitigated: null, text });
/** A file's blob URL, one per file URL, holding no part of it, as a real one holds none. */
const handles = new Map();
const handleOf = (url) => `blob:keep-a-copy/${handles.get(url) ?? handles.set(url, handles.size + 1).get(url)}`;
const file = (url, bytes) => ({
  kind: "response", status: 200, url, contentType: "application/epub+zip", retryAfter: null, cfMitigated: null,
  bytes: bytes.slice(0, 8_192), size: bytes.length, handle: handleOf(url),
});
const workURL = (id) => `${AO3_ORIGIN}/works/${id}?view_adult=true`;
const loginURL = `${AO3_ORIGIN}/users/login?restricted=true`;
const navigateURL = (id) => `${AO3_ORIGIN}/works/${id}/navigate`;

/** A work's Chapter Index: `chapters` as [chapter id, YYYY-MM-DD]. */
function chapterIndex(id, chapters) {
  return `<html><body class="logged-in"><h2 class="heading">Chapter Index for <a href="/works/${id}">Invented work ${id}</a></h2>` +
    `<ol class="chapter index group">${chapters.map(([cid, date]) => `<li><a href="/works/${id}/chapters/${cid}">Chapter</a> <span class="datetime">(${date})</span></li>`).join("")}</ol></body></html>`;
}

/** A page as a request made signed out meets it in these tests: a locked work's is the sign-in page. */
function signedOut(result) {
  if (result?.kind !== "response" || typeof result.text !== "string") return result;
  if (/<img alt="\(Restricted\)"/.test(result.text)) return html(loginURL, '<body class="logged-out"><form action="/users/login"></form></body>');
  return { ...result, text: result.text.replace('<body class="logged-in">', '<body class="logged-out">') };
}
const fileURL = (id, updatedAt = "1761700000") => `${AO3_ORIGIN}/downloads/${id}/Invented_work.epub?updated_at=${updatedAt}`;

/** A queue over an IndexedDB store answering from `answers`, with one account's works in use, as in Trace. */
function harness(answers = {}, { store = new IndexedDbKeepStore(new IDBFactory(), IDBKeyRange), scope = "account-1" } = {}) {
  const box = { now: NOW, saved: [], removed: [], requests: [], modes: [], writes: [], store };
  let nextId = 1;
  const answer = async (url) => {
    box.requests.push(url);
    const value = answers[url];
    return (typeof value === "function" ? value() : value) ?? html(url, "<h2>Error 404</h2>", 404);
  };
  box.engine = new KeepACopy({
    clock: { now: () => box.now },
    random: () => 0,
    read: (scope) => store.read(scope),
    write: async (state, changed, scope) => {
      box.writes.push({ scope, changed: [...changed].sort() });
      box.stored = structuredClone(state);
      await store.write(state, changed, scope);
    },
    fetchPage: async (url, credentials) => {
      box.modes.push([url, credentials]);
      return credentials === "omit" ? signedOut(await answer(url)) : answer(url);
    },
    fetchFile: async (url, credentials) => {
      box.modes.push([url, credentials]);
      return answer(url);
    },
    save: async (request) => { box.saved.push(request); return nextId++; },
    settle: async (id) => ({ state: "complete", filename: `/home/reader/Downloads/${box.saved[id - 1]?.filename}` }),
    remove: async (id) => { box.removed.push(id); },
  }, LIBRARY_DEFAULTS, scope);
  box.drain = async (max = 50) => {
    for (let i = 0; i < max; i += 1) {
      const wait = await box.engine.tick();
      if (wait === null) return;
      box.now += wait;
    }
  };
  return box;
}

const entry = (status, extra = {}) => ({ status, ...extra });

test("the Library's AO3 stories are kept unless Dropped; FanFiction.net and malformed keys are not", () => {
  const list = libraryList({
    syncVersion: "2026-10-29T10:00:00.000Z",
    workPreferences: {},
    entries: {
      "ao3:11": entry("PLANNING", { canonicalReaderStatus: "SAVED" }),
      "ao3:12": entry("READING", { canonicalReaderStatus: "CAUGHT_UP" }),
      "ao3:13": entry("PAUSED"),
      "ao3:14": entry("COMPLETED"),
      "ao3:15": entry("DROPPED", { canonicalReaderStatus: "DROPPED" }),
      "ao3:16": entry("READING"),
      "ffn:17": entry("READING"),
    },
  }, 7);
  assert.deepEqual(list.keep.map((work) => work.workId), ["11", "12", "13", "14", "16"]);
  assert.deepEqual(list.drop, ["15"]);
  assert.equal(list.whole, true);
  // Legacy statuses alone map to the reader's own.
  assert.equal(readerStatus(entry("PLANNING")), "SAVED");
  assert.equal(readerStatus(entry("COMPLETED")), "FINISHED");
  assert.equal(readerStatus(entry("READING", { canonicalReaderStatus: "CAUGHT_UP" })), "CAUGHT_UP");
});

test("Trace's published chapter count is the reader's chapter plus the new ones, only when Trace knows both", () => {
  assert.equal(publishedChapters(entry("READING", { chapters: { current: 4, total: 10 }, catchupState: "BEHIND", newChapterCount: 2 })), 6);
  assert.equal(publishedChapters(entry("READING", { chapters: { current: 6, total: 10 }, catchupState: "UP", newChapterCount: 0 })), 6);
  assert.equal(publishedChapters(entry("READING", { chapters: { current: 6, total: 10 }, catchupState: "UNKNOWN", newChapterCount: 0 })), null);
  assert.equal(publishedChapters(entry("READING", { catchupState: "UP" })), null);
});

test("a Library near Trace's limit, by the account's own count, lets no missing work go", () => {
  const overlay = (count) => {
    const entries = {};
    for (let i = 1; i <= count; i += 1) entries[`ao3:${i}`] = entry("READING");
    return { entries, workPreferences: {}, syncVersion: "2026-10-29T10:00:00.000Z" };
  };
  assert.equal(libraryList(overlay(3), 3).whole, true);
  // Trace left rows out before sending 9,000 keys of a 10,200-story Library.
  assert.equal(libraryList(overlay(9_000), 10_200).whole, false);
  assert.equal(libraryList(overlay(3), LIBRARY_WHOLE_BELOW).whole, false);
  assert.equal(libraryList(overlay(LIBRARY_WHOLE_BELOW), 100).whole, false);
  // No count from Trace: never taken as whole.
  assert.equal(libraryList(overlay(3), null).whole, false);
});

test("turned on, every kept Library work is copied: its page, then its file, at the reader's pace", async () => {
  const box = harness({
    [workURL("21")]: html(workURL("21"), workPage("21")),
    [fileURL("21")]: file(fileURL("21"), epub()),
    [workURL("22")]: html(workURL("22"), workPage("22")),
    [fileURL("22")]: file(fileURL("22"), epub()),
  });
  // Off by default: nothing is kept.
  await box.engine.syncLibrary({ keep: [{ workId: "21", chapters: 3 }], drop: [], whole: true });
  assert.equal((await box.engine.view()).kept, 0);
  await box.engine.updateSettings({ enabled: true });
  const result = await box.engine.syncLibrary({ keep: [{ workId: "21", chapters: 3 }, { workId: "22", chapters: null }], drop: [], whole: true });
  assert.deepEqual(result, { added: 2, released: 0 });
  await box.drain();
  assert.deepEqual(box.requests, [workURL("21"), fileURL("21"), workURL("22"), fileURL("22")]);
  assert.deepEqual(box.saved.map((save) => save.filename), [
    `${COPY_FOLDER}/Invented Lanterns/Invented work 21 – Synthetic_Quill (21).epub`,
    `${COPY_FOLDER}/Invented Lanterns/Invented work 22 – Synthetic_Quill (22).epub`,
  ]);
  // A second read of the same Library asks AO3 for nothing.
  await box.engine.syncLibrary({ keep: [{ workId: "21", chapters: 3 }, { workId: "22", chapters: null }], drop: [], whole: true });
  await box.drain();
  assert.equal(box.requests.length, 4);
});

test("Dropped stops a work's updates and never deletes its file; back in the Library it is looked at again", async () => {
  let updatedAt = "1761700000";
  const box = harness({
    [workURL("31")]: () => html(workURL("31"), workPage("31", { updatedAt })),
    [fileURL("31")]: file(fileURL("31"), epub()),
    [fileURL("31", "1761800000")]: file(fileURL("31", "1761800000"), epub()),
  });
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: [{ workId: "31", chapters: 3 }], drop: [], whole: true });
  await box.drain();
  assert.equal(box.saved.length, 1);

  assert.deepEqual(await box.engine.syncLibrary({ keep: [], drop: ["31"], whole: true }), { added: 0, released: 1 });
  updatedAt = "1761800000";
  // Opening the work, or a new chapter in Trace's count, fetches nothing now.
  const page = (await import("../../.trace-build/extension-runtime/keep-a-copy.mjs")).readWorkPage(workPage("31", { updatedAt }));
  await box.engine.notePage(page, "visit");
  await box.drain();
  assert.equal(box.requests.length, 2);
  assert.deepEqual(box.removed, []);
  const view = await box.engine.view();
  // Counted among works that update: none now, with one file kept aside.
  assert.equal(view.kept, 0);
  assert.equal(view.withCopy, 0);
  assert.equal(view.updatesOff, 1);

  // Reading again: its page is read once, and the new file is written over the old.
  await box.engine.syncLibrary({ keep: [{ workId: "31", chapters: 4 }], drop: [], whole: true });
  await box.drain();
  assert.deepEqual(box.requests.slice(2), [workURL("31"), fileURL("31", "1761800000")]);
  assert.equal(box.saved[1].filename, box.saved[0].filename);
  assert.equal(box.saved[1].conflict, "overwrite");
  assert.equal((await box.engine.view()).updatesOff, 0);
});

test("a rise in Trace's chapter count reads the page at the slow pace, and fetches the file only if AO3 changed it", async () => {
  let updatedAt = "1761700000";
  const box = harness({
    [workURL("41")]: () => html(workURL("41"), workPage("41", { updatedAt })),
    [fileURL("41")]: file(fileURL("41"), epub()),
    [fileURL("41", "1761900000")]: file(fileURL("41", "1761900000"), epub()),
  });
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: [{ workId: "41", chapters: 5 }], drop: [], whole: true });
  await box.drain();
  // The same count, or a fall (the reader read on), asks for nothing.
  await box.engine.syncLibrary({ keep: [{ workId: "41", chapters: 5 }], drop: [], whole: true });
  await box.drain();
  assert.equal(box.requests.length, 2);
  // Trace saw a chapter land, but AO3's file has not changed yet: only the page is read.
  await box.engine.syncLibrary({ keep: [{ workId: "41", chapters: 6 }], drop: [], whole: true });
  await box.drain();
  assert.deepEqual(box.requests.slice(2), [workURL("41")]);
  assert.equal(box.saved.length, 1);
  updatedAt = "1761900000";
  const before = box.now;
  await box.engine.syncLibrary({ keep: [{ workId: "41", chapters: 7 }], drop: [], whole: true });
  await box.drain();
  assert.deepEqual(box.requests.slice(3), [workURL("41"), fileURL("41", "1761900000")]);
  assert.equal(box.saved.length, 2);
  // The weekly check's pace: 30 s between the two requests, not 6.
  assert.ok(box.now - before >= 30_000);
});

test("a work missing from a Library that may be cut off keeps updating; from a whole one, it stops", async () => {
  const box = harness({
    [workURL("51")]: html(workURL("51"), workPage("51")),
    [fileURL("51")]: file(fileURL("51"), epub()),
  });
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: [{ workId: "51", chapters: null }], drop: [], whole: true });
  await box.drain();
  assert.equal((await box.engine.syncLibrary({ keep: [], drop: [], whole: false })).released, 0);
  assert.equal((await box.engine.syncLibrary({ keep: [], drop: [], whole: true })).released, 1);
});

test("a Library work is read signed out; a locked one from its Chapter Index, signed in, and again when a chapter lands", async () => {
  const day = (date) => String(Date.parse(`${date}T00:00:00Z`) / 1_000 + 0);
  const first = lockedFileURL("61", "Invented work 61", "epub", lockedVersion({ latestAt: Number(day("2026-10-20")), chapters: 1 }));
  const second = lockedFileURL("61", "Invented work 61", "epub", lockedVersion({ latestAt: Number(day("2026-10-28")), chapters: 2 }));
  const answers = {
    [workURL("61")]: html(workURL("61"), workPage("61", { restricted: true })),
    [navigateURL("61")]: html(navigateURL("61"), chapterIndex("61", [["611", "2026-10-20"]])),
    [first]: file(first, epub()),
    [second]: file(second, epub()),
    [workURL("62")]: html(workURL("62"), workPage("62")),
    [fileURL("62")]: file(fileURL("62"), epub()),
  };
  const box = harness(answers);
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: [{ workId: "61", chapters: 1 }, { workId: "62", chapters: 3 }], drop: [], whole: true });
  await box.drain();
  assert.deepEqual(box.modes, [[workURL("61"), "omit"], [navigateURL("61"), "include"], [first, "include"], [workURL("62"), "omit"], [fileURL("62"), "omit"]]);
  assert.equal((await box.engine.view()).withCopy, 2);
  // A chapter landing: the Chapter Index again, and the new version's file. The work's page is never read again.
  answers[navigateURL("61")] = html(navigateURL("61"), chapterIndex("61", [["611", "2026-10-20"], ["612", "2026-10-28"]]));
  await box.engine.syncLibrary({ keep: [{ workId: "61", chapters: 2 }, { workId: "62", chapters: 3 }], drop: [], whole: true });
  await box.drain();
  assert.deepEqual(box.modes.slice(5), [[navigateURL("61"), "include"], [second, "include"]]);
  assert.equal(JSON.stringify(box.stored).includes("/downloads/61/"), false);
});

test("while a work's file saves, a routine Library look asks nothing more; a chapter landing is looked at again after", async () => {
  const answers = { [workURL("71")]: html(workURL("71"), workPage("71")), [fileURL("71")]: file(fileURL("71"), epub()) };
  const box = harness(answers);
  const step = async () => { box.now += (await box.engine.tick()) ?? 0; };
  const sync = (chapters) => box.engine.syncLibrary({ keep: [{ workId: "71", chapters }], drop: [], whole: true });
  await box.engine.updateSettings({ enabled: true });
  await sync(1);
  await step();
  await step();
  assert.ok(box.stored.pending, "the file is saving");
  await sync(1);
  await box.drain();
  assert.deepEqual(box.requests, [workURL("71"), fileURL("71")]);
  // A chapter lands: its new file saves, and another chapter lands meanwhile.
  answers[workURL("71")] = html(workURL("71"), workPage("71", { updatedAt: "1761900000" }));
  answers[fileURL("71", "1761900000")] = file(fileURL("71", "1761900000"), epub());
  await sync(2);
  await step();
  await step();
  assert.ok(box.stored.pending, "the new file is saving");
  await sync(3);
  await box.drain();
  assert.deepEqual(box.requests.slice(2), [workURL("71"), fileURL("71", "1761900000"), workURL("71")]);
});

test("each step writes only the works it changed, to IndexedDB, and a new background reads them back", async () => {
  const answers = {};
  for (const id of ["81", "82", "83"]) {
    answers[workURL(id)] = html(workURL(id), workPage(id));
    answers[fileURL(id)] = file(fileURL(id), epub());
  }
  const box = harness(answers);
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: ["81", "82", "83"].map((workId) => ({ workId, chapters: 1 })), drop: [], whole: true });
  await box.drain();
  box.writes.length = 0;
  answers[workURL("82")] = html(workURL("82"), workPage("82", { updatedAt: "1761900000" }));
  answers[fileURL("82", "1761900000")] = file(fileURL("82", "1761900000"), epub());
  await box.engine.syncLibrary({ keep: ["81", "82", "83"].map((workId) => ({ workId, chapters: workId === "82" ? 2 : 1 })), drop: [], whole: true });
  await box.drain();
  assert.ok(box.writes.length > 0);
  for (const { changed } of box.writes.slice(1)) assert.deepEqual(changed.filter((id) => id !== "82"), [], `wrote ${changed}`);
  const again = harness(answers, { store: box.store });
  const view = await again.engine.view();
  assert.equal(view.kept, 3);
  assert.equal(view.withCopy, 3);
});

test("switched off, nothing is written, not even the reader's AO3 name", async () => {
  const box = harness();
  await box.engine.updateSettings({ enabled: false });
  await box.engine.noteUser("Synthetic_Reader");
  await box.engine.syncLibrary({ keep: [{ workId: "91", chapters: null }], drop: [], whole: true });
  assert.equal(await box.engine.tick(), null);
  assert.deepEqual(box.writes, []);
  assert.equal(await box.store.read("account-1"), undefined);
  assert.equal((await box.engine.view()).user, null);
  // Turned on, then off: the switch itself is kept.
  await box.engine.updateSettings({ enabled: true });
  await box.engine.updateSettings({ enabled: false });
  assert.equal((await box.store.read("account-1")).settings.enabled, false);
});

test("switched off, the reader's AO3 name goes: another reader signing in meanwhile, and on again, nothing of the reader before is read", async () => {
  const box = harness();
  await box.engine.updateSettings({ enabled: true, weeklyCheck: true });
  await box.engine.noteUser("Synthetic_Reader");
  assert.equal((await box.engine.view()).user, "Synthetic_Reader");
  await box.engine.updateSettings({ enabled: false });
  // Off, a page saying another reader is signed in is not heard.
  await box.engine.noteUser("Other_Reader");
  await box.engine.updateSettings({ enabled: true });
  assert.equal((await box.engine.view()).user, null);
  assert.equal(await box.engine.startBackup(), "no_user");
  box.now += 8 * 24 * 60 * 60_000;
  await box.drain();
  assert.deepEqual(box.requests, []);
});

test("an account that signs out and back in carries on with nothing checked again; another account has its own works and never touches the first's files", async () => {
  const answers = {
    [workURL("101")]: html(workURL("101"), workPage("101")),
    [fileURL("101")]: file(fileURL("101"), epub()),
  };
  const box = harness(answers);
  const library = { keep: [{ workId: "101", chapters: 4 }], drop: [], whole: true };
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary(library);
  await box.drain();
  assert.equal(box.requests.length, 2);
  // Signed out: nothing runs, and a visit fetches nothing.
  await box.engine.useScope(null);
  assert.equal(await box.engine.tick(), null);
  // The same account back: no page is read again.
  await box.engine.useScope("account-1");
  await box.engine.syncLibrary(library);
  await box.drain();
  assert.equal(box.requests.length, 2);

  // Another account keeping the same work: its own copy, at a name the browser picks free.
  await box.engine.useScope("account-2");
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary(library);
  await box.drain();
  assert.equal(box.requests.length, 4);
  assert.equal(box.saved[1].conflict, "uniquify");
  assert.deepEqual(box.removed, []);
  assert.equal((await box.store.read("account-1")).works["101"].copy.downloadId, 1);
  assert.equal((await box.store.read("account-2")).works["101"].copy.downloadId, 2);
});

test("AO3's pacer is the browser's: another account, after a stop, asks AO3 nothing until it is over, under the same cap", async () => {
  const box = harness({
    [workURL("111")]: html(workURL("111"), "<h2>Error 403</h2>", 403),
    [workURL("112")]: html(workURL("112"), workPage("112")),
    [fileURL("112")]: file(fileURL("112"), epub()),
  });
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: [{ workId: "111", chapters: 1 }], drop: [], whole: true });
  await box.engine.tick();
  const stopped = (await box.engine.view()).stopped;
  assert.equal(stopped.code, "forbidden");
  await box.engine.useScope("account-2");
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: [{ workId: "112", chapters: 1 }], drop: [], whole: true });
  assert.equal(await box.engine.tick(), stopped.until - box.now);
  assert.deepEqual(box.requests, [workURL("111")]);
  assert.equal((await box.engine.view()).stopped.until, stopped.until);
  // Over: the reads of six hours count on from the first account's.
  box.now = stopped.until;
  await box.drain();
  assert.deepEqual(box.requests, [workURL("111"), workURL("112"), fileURL("112")]);
  assert.equal((await box.store.read("account-2")).pacer.window.reads, 3);
  assert.equal((await box.store.read("account-1")).pacer.window.reads, 3);
});

test("an account's pacer kept the earlier way, with its works, becomes the device's", async () => {
  const factory = new IDBFactory();
  const store = new IndexedDbKeepStore(factory, IDBKeyRange);
  const until = NOW + 30 * 60_000;
  const earlier = { v: 1, settings: { ...LIBRARY_DEFAULTS, enabled: true }, user: null, queue: [], run: null, pending: null,
    pacer: { dueAt: 0, window: { startedAt: NOW, reads: 4 }, retries: 0, misses: 0, stopped: { code: "challenge", until }, lastCheckAt: NOW } };
  assert.equal(await store.read("account-1"), undefined);
  const db = await new Promise((resolve) => { factory.open("traceKeepACopyV1", 1).onsuccess = (event) => resolve(event.target.result); });
  await new Promise((resolve) => {
    const tx = db.transaction("cores", "readwrite");
    tx.objectStore("cores").put(earlier, "account-1");
    tx.oncomplete = resolve;
  });
  const box = harness({}, { store });
  assert.equal((await box.engine.view()).stopped.until, until);
  await box.engine.noteUser("Synthetic_Reader");
  const moved = await new Promise((resolve) => { db.transaction("meta").objectStore("meta").get(PACER_KEY).onsuccess = (event) => resolve(event.target.result); });
  assert.equal(moved.stopped.until, until);
  await box.engine.useScope("account-2");
  assert.equal((await box.engine.view()).stopped.until, until);
});

test("an update writes over the account's own file, wherever the browser put it", () => {
  assert.equal(ownName({ filename: "AO3/F/T – A (1).epub", path: "C:\\Users\\r\\Downloads\\AO3\\F\\T – A (1) (1).epub" }), "AO3/F/T – A (1) (1).epub");
  assert.equal(ownName({ filename: "AO3/F/T – A (1).epub", path: null }), "AO3/F/T – A (1).epub");
});

function copiesHarness({ pref = false, overlay = null } = {}) {
  const calls = { settings: [], syncs: [], alarms: [], wakes: 0, reads: [], scopes: [] };
  let library = overlay && { accountId: "account-1", overlay, libraryCount: 2 };
  const copies = new TraceLibraryCopies({
    engine: {
      updateSettings: async (patch) => { calls.settings.push(patch); },
      syncLibrary: async (list) => { calls.syncs.push(list); return { added: 0, released: 0 }; },
      useScope: async (scope) => { calls.scopes.push(scope); },
      switchOff: async () => undefined,
    },
    scopes: async () => [],
    wake: () => { calls.wakes += 1; },
    library: async (refresh) => { calls.reads.push(refresh); return library; },
    readPref: async () => pref,
    alarm: (on) => calls.alarms.push(on),
  });
  return { copies, calls, setLibrary: (value) => { library = value && { accountId: "account-1", overlay: value, libraryCount: 2 }; } };
}

const OVERLAY = { syncVersion: "2026-10-29T10:00:00.000Z", workPreferences: {}, entries: { "ao3:71": entry("READING"), "ao3:72": entry("DROPPED") } };

test("the switch is off until the reader turns it on; off, Trace's Library is never read for it", async () => {
  const { copies, calls } = copiesHarness({ overlay: OVERLAY });
  await copies.start();
  await copies.sync(true);
  assert.deepEqual(calls.settings, [{ enabled: false }]);
  assert.deepEqual(calls.alarms, [false]);
  assert.deepEqual(calls.reads, []);
  await copies.prefChanged(true);
  assert.deepEqual(calls.settings.at(-1), { enabled: true });
  assert.deepEqual(calls.alarms.at(-1), true);
  assert.deepEqual(calls.scopes, ["account-1"]);
  assert.deepEqual(calls.syncs, [{ keep: [{ workId: "71", chapters: null }], drop: ["72"], whole: true }]);
  assert.equal(calls.wakes, 1);
});

test("a Library that cannot be read lets nothing go; an account that leaves takes its works out of use", async () => {
  const { copies, calls, setLibrary } = copiesHarness({ pref: true, overlay: OVERLAY });
  await copies.start();
  // A background starting reads the Library kept here; only the reader's switch or the alarm asks Trace.
  assert.deepEqual(calls.reads, [false]);
  setLibrary(null);
  await copies.sync(true);
  assert.equal(calls.syncs.length, 1);
  await copies.accountLeft();
  assert.equal(calls.syncs.length, 1, "leaving released works");
  assert.deepEqual(calls.scopes.at(-1), null);
});

/** A Trace background over `stored`, its accounts' works kept in a map, with the Library's account and its read held as asked. */
function traceBackground(stored, { pref = true } = {}) {
  const engine = new KeepACopy({
    clock: { now: () => NOW }, random: () => 0,
    read: async (scope) => structuredClone(stored.get(scope)),
    write: async (state, _changed, scope) => { stored.set(scope, structuredClone(state)); },
    fetchPage: async () => ({ kind: "failed", code: "network" }), fetchFile: async () => ({ kind: "failed", code: "network" }),
    save: async () => 1, settle: async () => ({ state: "complete", filename: "x" }), remove: async () => undefined,
  }, LIBRARY_DEFAULTS, null);
  const ctl = { account: "account-1", pref, gate: null, reached: null, prefGate: null };
  /** Holds the next Library read until `release()`; `reached` settles once it has begun. */
  ctl.hold = () => {
    let release;
    ctl.gate = new Promise((resolve) => { release = resolve; });
    ctl.reached = new Promise((resolve) => { ctl.reach = resolve; });
    return () => { ctl.gate = null; release(); };
  };
  const copies = new TraceLibraryCopies({
    engine, wake() {}, alarm() {},
    scopes: async () => [...stored.keys()],
    readPref: async () => { const value = ctl.pref; await ctl.prefGate; return value; },
    library: async () => {
      const account = ctl.account;
      ctl.reach?.();
      await ctl.gate;
      return account === null ? null : { accountId: account, overlay: { entries: {} }, libraryCount: 0 };
    },
  });
  return { engine, copies, ctl };
}

const keptIn = (stored, scope) => ({ enabled: stored.get(scope)?.settings.enabled, user: stored.get(scope)?.user });
const OFF = { enabled: false, user: null };

test("switched off, every account's works kept here are switched off: not even an AO3 name stays", async () => {
  const stored = new Map();
  // One account in use, then another: the first's works are no longer in use.
  const { engine, copies, ctl } = traceBackground(stored);
  await copies.start();
  await engine.noteUser("Synthetic_Reader");
  ctl.account = "account-2";
  await copies.sync(true);
  await engine.noteUser("Other_Reader");
  assert.deepEqual(keptIn(stored, "account-1"), { enabled: true, user: "Synthetic_Reader" });
  await copies.prefChanged(false);
  assert.deepEqual(keptIn(stored, "account-1"), OFF);
  assert.deepEqual(keptIn(stored, "account-2"), OFF);

  // A new background, its Library read for the second account still under way when the switch goes off.
  await copies.prefChanged(true);
  await engine.noteUser("Other_Reader");
  ctl.account = "account-1";
  await copies.sync(true);
  await engine.noteUser("Synthetic_Reader");
  const fresh = traceBackground(stored);
  fresh.ctl.account = "account-2";
  const release = fresh.ctl.hold();
  const starting = fresh.copies.start();
  await fresh.ctl.reached;
  const off = fresh.copies.prefChanged(false);
  release();
  await Promise.all([starting, off]);
  assert.deepEqual(keptIn(stored, "account-1"), OFF);
  assert.deepEqual(keptIn(stored, "account-2"), OFF);

  // A background starting with the switch off reaches them too, as after a browser restart.
  await fresh.copies.prefChanged(true);
  await fresh.engine.noteUser("Other_Reader");
  await fresh.copies.accountLeft();
  const restarted = traceBackground(stored, { pref: false });
  await restarted.copies.start();
  assert.deepEqual(keptIn(stored, "account-2"), OFF);
  assert.equal(await restarted.engine.enabled(), false);
});

test("switching off an account not in use reads and writes only its small record: its works stay as stored", async () => {
  const store = new IndexedDbKeepStore(new IDBFactory(), IDBKeyRange);
  const other = harness({ [workURL("91")]: html(workURL("91"), workPage("91")), [fileURL("91")]: file(fileURL("91"), epub()) }, { store, scope: "account-2" });
  await other.engine.updateSettings({ enabled: true });
  await other.engine.noteUser("Other_Reader");
  await other.engine.syncLibrary({ keep: [{ workId: "91", chapters: null }], drop: [], whole: true });
  await other.drain();
  const before = (await store.read("account-2")).works;
  assert.ok(before["91"]);
  const reads = [];
  const engine = new KeepACopy({
    clock: { now: () => NOW }, random: () => 0,
    read: async (scope) => { reads.push(`whole ${scope}`); return store.read(scope); },
    readCore: async (scope) => { reads.push(`small ${scope}`); return store.readCore(scope); },
    write: (state, changed, scope) => store.write(state, changed, scope),
    fetchPage: async () => ({ kind: "failed", code: "network" }), fetchFile: async () => ({ kind: "failed", code: "network" }),
    save: async () => 1, settle: async () => ({ state: "complete", filename: "x" }), remove: async () => undefined,
  }, LIBRARY_DEFAULTS, "account-1");
  await engine.switchOff("account-2");
  // Already off: read, and not written again.
  await engine.switchOff("account-2");
  assert.deepEqual(reads, ["small account-2", "small account-2"], "no work read");
  const after = await store.read("account-2");
  assert.deepEqual({ enabled: after.settings.enabled, user: after.user }, OFF);
  assert.deepEqual(after.works, before, "the works stay as stored");
});

test("a switch that cannot be read leaves every account's works as they are, and nothing runs", async () => {
  const stored = new Map();
  const first = traceBackground(stored);
  await first.copies.start();
  await first.engine.noteUser("Synthetic_Reader");
  const { engine, copies, ctl } = traceBackground(stored);
  ctl.prefGate = Promise.reject(new Error("storage unreadable"));
  ctl.prefGate.catch(() => undefined);
  await copies.start();
  assert.deepEqual(keptIn(stored, "account-1"), { enabled: true, user: "Synthetic_Reader" });
  assert.equal(await engine.enabled(), false);
});

test("an account that cannot be switched off does not keep the others on", async () => {
  const stored = new Map();
  const { engine, copies, ctl } = traceBackground(stored);
  await copies.start();
  await engine.noteUser("Synthetic_Reader");
  ctl.account = "account-2";
  await copies.sync(true);
  await engine.noteUser("Other_Reader");
  ctl.account = "account-3";
  await copies.sync(true);
  const switchOff = engine.switchOff.bind(engine);
  engine.switchOff = (scope) => (scope === "account-1" ? Promise.reject(new Error("unreadable")) : switchOff(scope));
  await copies.prefChanged(false);
  assert.deepEqual(keptIn(stored, "account-2"), OFF);
  assert.deepEqual(keptIn(stored, "account-1"), { enabled: true, user: "Synthetic_Reader" });
});

test("an off goes on when the works in use cannot be written: the other accounts go off, and the alarm stops", async () => {
  const stored = new Map();
  let failFor = null;
  const engine = new KeepACopy({
    clock: { now: () => NOW }, random: () => 0,
    read: async (scope) => structuredClone(stored.get(scope)),
    write: async (state, _changed, scope) => {
      if (scope === failFor) throw new Error("write failed");
      stored.set(scope, structuredClone(state));
    },
    fetchPage: async () => ({ kind: "failed", code: "network" }), fetchFile: async () => ({ kind: "failed", code: "network" }),
    save: async () => 1, settle: async () => ({ state: "complete", filename: "x" }), remove: async () => undefined,
  }, LIBRARY_DEFAULTS, null);
  let account = "account-1";
  const alarms = [];
  const copies = new TraceLibraryCopies({
    engine, wake() {}, alarm: (on) => alarms.push(on),
    scopes: async () => [...stored.keys()],
    readPref: async () => true,
    library: async () => ({ accountId: account, overlay: { entries: {} }, libraryCount: 0 }),
  });
  await copies.start();
  await engine.noteUser("Synthetic_Reader");
  account = "account-2";
  await copies.sync(true);
  await engine.noteUser("Other_Reader");
  // The works in use cannot be written.
  failFor = "account-2";
  await copies.prefChanged(false);
  assert.deepEqual(keptIn(stored, "account-1"), OFF);
  assert.equal(alarms.at(-1), false, "the alarm stops");
  assert.equal(await engine.enabled(), false);
});

test("off, then at once on again, with the Trace account gone: no AO3 name is kept, and the account back is on", async () => {
  const stored = new Map();
  const { engine, copies, ctl } = traceBackground(stored);
  await copies.start();
  await engine.noteUser("Synthetic_Reader");
  await copies.accountLeft();
  ctl.account = null;
  await Promise.all([copies.prefChanged(false), copies.prefChanged(true)]);
  assert.deepEqual(keptIn(stored, "account-1"), OFF);
  assert.equal(await engine.enabled(), false, "no account's works in use");
  ctl.account = "account-1";
  await copies.sync(true);
  assert.deepEqual(keptIn(stored, "account-1"), { enabled: true, user: null });
  assert.equal(await engine.enabled(), true);
});

test("a background's first read of the switch, landing after the reader changed it, is not used", async () => {
  const stored = new Map();
  const first = traceBackground(stored);
  await first.copies.start();
  await first.engine.noteUser("Synthetic_Reader");
  const { engine, copies, ctl } = traceBackground(stored);
  let release;
  ctl.prefGate = new Promise((resolve) => { release = resolve; });
  // The read sees the switch on; before it lands, the reader turns it off.
  const starting = copies.start();
  await copies.prefChanged(false);
  release();
  await starting;
  assert.equal(await engine.enabled(), false);
  assert.deepEqual(keptIn(stored, "account-1"), OFF);
});

function fakeExtension() {
  const listeners = { message: [], alarm: [], changed: [], connect: [] };
  const store = {};
  const alarmSet = new Map();
  return {
    listeners, store, alarmSet,
    runtime: {
      id: "trace-test",
      sendMessage: async () => undefined,
      onConnect: { addListener: (listener) => listeners.connect.push(listener) },
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: structuredClone(store[key]) }),
        set: async (items) => { Object.assign(store, structuredClone(items)); },
      },
      onChanged: { addListener: (listener) => listeners.changed.push(listener) },
    },
    alarms: {
      create: (name, info) => alarmSet.set(name, info),
      get: async (name) => alarmSet.get(name),
      clear: async (name) => alarmSet.delete(name),
      onAlarm: { addListener: (listener) => listeners.alarm.push(listener) },
    },
    downloads: {
      download: async () => 1,
      search: async () => [],
      removeFile: async () => undefined,
      cancel: async () => undefined,
      erase: async () => undefined,
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Waits until `ready()` holds, however slow the machine; fails after ten seconds. */
async function until(ready, what) {
  for (const started = Date.now(); !ready(); await settle()) {
    if (Date.now() - started > 10_000) assert.fail(`still waiting: ${what}`);
  }
}

test("in Trace's background, with no Trace account, the switch on keeps nothing and copies nothing: not even an AO3 page's reader", async (t) => {
  const extension = fakeExtension();
  extension.store[KEEP_A_COPY_PREF_KEY] = true;
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response("<h2>Error 404</h2>", { status: 404, headers: { "content-type": "text/html" } });
  };
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  t.after(() => {
    globalThis.fetch = realFetch;
    delete globalThis.indexedDB;
    delete globalThis.IDBKeyRange;
  });
  // Trace signed out: its Library cannot be read.
  const copies = installTraceKeepACopy(extension, { librarySnapshot: async () => null, whenAccountLeaves: () => undefined });
  await settle();
  const [listener] = extension.listeners.message;
  const send = (message) => new Promise((respond) => listener(message, { id: "trace-test", url: `${AO3_ORIGIN}/works/1` }, respond));
  await send({ type: "KEEP_A_COPY_PAGE", trigger: "visit", user: "Synthetic_Reader" });
  await send({ type: "KEEP_A_COPY_PAGE", trigger: "bookmark", html: "", workId: "1", id: "6f1c1d1e-0d7a-4a8e-9f31-2b6a1c0e5d42" });
  await copies.sync(true);
  await settle();
  assert.deepEqual(fetched, [], "no account's works in use: nothing is copied");
  const store = new IndexedDbKeepStore(globalThis.indexedDB, IDBKeyRange);
  assert.equal(await store.read(""), undefined, "nothing written");
});

test("in Trace's background it answers only its own messages, and wakes nothing while the switch is off", async (t) => {
  const extension = fakeExtension();
  const reads = [];
  // AO3 is never reached from a test.
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response("<h2>Error 404</h2>", { status: 404, headers: { "content-type": "text/html" } });
  };
  // The works are kept in IndexedDB, never in storage.local.
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  t.after(async () => {
    // Off, whatever the test reached: the background asks nothing more, and no timer of its stays.
    for (const changed of extension.listeners.changed) changed({ [KEEP_A_COPY_PREF_KEY]: { newValue: false } }, "local");
    await until(() => !extension.alarmSet.has(LIBRARY_SYNC_ALARM), "the alarm to stop");
    await settle();
    globalThis.fetch = realFetch;
    delete globalThis.indexedDB;
    delete globalThis.IDBKeyRange;
  });
  installTraceKeepACopy(extension, {
    librarySnapshot: async (refresh) => { reads.push(refresh); return { accountId: "account-1", overlay: OVERLAY, libraryCount: 2 }; },
    whenAccountLeaves: () => undefined,
  });
  await settle();
  const [listener] = extension.listeners.message;
  // Another part of the background's message is left to it.
  assert.equal(listener({ type: "TRACE_POPUP_GET_STATE" }, { id: "trace-test" }, () => assert.fail("answered")), undefined);
  // No list backup in Trace's build.
  assert.equal(listener({ type: "KEEP_A_COPY_BACKUP" }, { id: "trace-test" }, () => assert.fail("answered")), undefined);
  let view = null;
  assert.equal(listener({ type: "KEEP_A_COPY_VIEW" }, { id: "trace-test" }, (value) => { view = value; }), true);
  await until(() => view !== null, "the view");
  assert.equal(view.settings.enabled, false);
  assert.equal(view.settings.triggers.bookmark, false);
  assert.deepEqual(reads, []);
  assert.equal(extension.alarmSet.size, 0, "an alarm runs for a switch that is off");

  // Turned on: the Library is read and its work queued; the alarms run.
  extension.store[KEEP_A_COPY_PREF_KEY] = true;
  for (const changed of extension.listeners.changed) changed({ [KEEP_A_COPY_PREF_KEY]: { newValue: true } }, "local");
  await until(() => fetched.length > 0, "the work's page");
  assert.deepEqual(reads, [true]);
  assert.equal(extension.alarmSet.has(LIBRARY_SYNC_ALARM), true);
  assert.deepEqual(fetched, [`${AO3_ORIGIN}/works/71?view_adult=true`]);
  // A save in Trace reads the Library again.
  for (const changed of extension.listeners.changed) changed({ [ACCOUNT_PROJECTION_REVISION_KEY]: { newValue: 2 } }, "local");
  await until(() => reads.length === 2, "the Library read again");
  assert.deepEqual(reads, [true, true]);
  assert.deepEqual(Object.keys(extension.store).filter((key) => key !== KEEP_A_COPY_PREF_KEY), [], "Keep a Copy wrote to storage.local");
  // Turned off: its alarm stops.
  for (const changed of extension.listeners.changed) changed({ [KEEP_A_COPY_PREF_KEY]: { newValue: false } }, "local");
  await until(() => !extension.alarmSet.has(LIBRARY_SYNC_ALARM), "the alarm to stop");
  assert.equal(extension.alarmSet.has(LIBRARY_SYNC_ALARM), false);
});
