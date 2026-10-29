import assert from "node:assert/strict";
import test from "node:test";

import { AO3_ORIGIN, KeepACopy } from "../../.trace-build/extension-runtime/keep-a-copy.mjs";
import {
  KEEP_A_COPY_PREF_KEY,
  LIBRARY_DEFAULTS,
  LIBRARY_MAX_ENTRIES,
  LIBRARY_SYNC_ALARM,
  TraceLibraryCopies,
  installTraceKeepACopy,
  libraryList,
  publishedChapters,
  readerStatus,
} from "../../.trace-build/extension-runtime/keep-a-copy-library.mjs";
import { ACCOUNT_PROJECTION_REVISION_KEY } from "../../.trace-build/extension-runtime/runtime-messages.mjs";

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
const file = (url, bytes) => ({
  kind: "response", status: 200, url, contentType: "application/epub+zip", retryAfter: null, cfMitigated: null,
  bytes: bytes.slice(0, 8_192), size: bytes.length, handle: `blob:keep-a-copy/${url}`,
});
const workURL = (id) => `${AO3_ORIGIN}/works/${id}?view_adult=true`;
const fileURL = (id, updatedAt = "1761700000") => `${AO3_ORIGIN}/downloads/${id}/Invented_work.epub?updated_at=${updatedAt}`;

/** A store-backed queue answering from `answers`, as in keep-a-copy.test.mjs. */
function harness(answers = {}) {
  const box = { now: NOW, stored: undefined, saved: [], removed: [], requests: [] };
  let nextId = 1;
  const answer = async (url) => {
    box.requests.push(url);
    const value = answers[url];
    return (typeof value === "function" ? value() : value) ?? html(url, "<h2>Error 404</h2>", 404);
  };
  box.engine = new KeepACopy({
    clock: { now: () => box.now },
    random: () => 0,
    read: async () => structuredClone(box.stored),
    write: async (state) => { box.stored = structuredClone(state); },
    fetchPage: answer,
    fetchFile: answer,
    save: async (request) => { box.saved.push(request); return nextId++; },
    settle: async (id) => ({ state: "complete", filename: `/home/reader/Downloads/${box.saved[id - 1]?.filename}` }),
    remove: async (id) => { box.removed.push(id); },
  }, LIBRARY_DEFAULTS);
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
  });
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

test("a Library cut off at Trace's limit lets no missing work go", () => {
  const entries = {};
  for (let i = 1; i <= LIBRARY_MAX_ENTRIES; i += 1) entries[`ao3:${i}`] = entry("READING");
  assert.equal(libraryList({ entries, workPreferences: {}, syncVersion: "2026-10-29T10:00:00.000Z" }).whole, false);
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
    "AO3/Invented Lanterns/Invented work 21 – Synthetic_Quill (21).epub",
    "AO3/Invented Lanterns/Invented work 22 – Synthetic_Quill (22).epub",
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
  assert.equal(view.withCopy, 1);
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

test("a locked Library work is copied only from its page as the signed-in reader sees it, in the same step", async () => {
  const box = harness({
    [workURL("61")]: html(workURL("61"), workPage("61", { restricted: true })),
    [fileURL("61")]: file(fileURL("61"), epub()),
    [workURL("62")]: html(workURL("62"), workPage("62", { restricted: true, signedIn: false })),
  });
  await box.engine.updateSettings({ enabled: true });
  await box.engine.syncLibrary({ keep: [{ workId: "61", chapters: null }, { workId: "62", chapters: null }], drop: [], whole: true });
  await box.drain();
  assert.deepEqual(box.requests, [workURL("61"), fileURL("61"), workURL("62")]);
  assert.deepEqual((await box.engine.view()).skipped, { needs_sign_in: 1 });
  // No link of a locked work is ever kept.
  assert.equal(JSON.stringify(box.stored).includes("/downloads/61/"), false);
});

function copiesHarness({ pref = false, overlay = null } = {}) {
  const calls = { settings: [], syncs: [], alarms: [], wakes: 0, reads: [] };
  let library = overlay;
  const copies = new TraceLibraryCopies({
    engine: {
      updateSettings: async (patch) => { calls.settings.push(patch); },
      syncLibrary: async (list) => { calls.syncs.push(list); return { added: 0, released: 0 }; },
    },
    wake: () => { calls.wakes += 1; },
    library: async (refresh) => { calls.reads.push(refresh); return library; },
    readPref: async () => pref,
    alarm: (on) => calls.alarms.push(on),
  });
  return { copies, calls, setLibrary: (value) => { library = value; } };
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
  assert.deepEqual(calls.syncs, [{ keep: [{ workId: "71", chapters: null }], drop: ["72"], whole: true }]);
  assert.equal(calls.wakes, 1);
});

test("a Library that cannot be read lets nothing go; an account that leaves stops every update", async () => {
  const { copies, calls, setLibrary } = copiesHarness({ pref: true, overlay: OVERLAY });
  await copies.start();
  // A background starting reads the Library kept here; only the reader's switch or the alarm asks Trace.
  assert.deepEqual(calls.reads, [false]);
  setLibrary(null);
  await copies.sync(true);
  assert.equal(calls.syncs.length, 1);
  await copies.accountLeft();
  assert.deepEqual(calls.syncs.at(-1), { keep: [], drop: [], whole: true });
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
  t.after(() => { globalThis.fetch = realFetch; });
  installTraceKeepACopy(extension, {
    libraryOverlay: async (refresh) => { reads.push(refresh); return OVERLAY; },
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
  await settle();
  assert.equal(view.settings.enabled, false);
  assert.equal(view.settings.triggers.bookmark, false);
  assert.deepEqual(reads, []);
  assert.equal(extension.alarmSet.size, 0, "an alarm runs for a switch that is off");

  // Turned on: the Library is read and its work queued; the alarms run.
  extension.store[KEEP_A_COPY_PREF_KEY] = true;
  for (const changed of extension.listeners.changed) changed({ [KEEP_A_COPY_PREF_KEY]: { newValue: true } }, "local");
  await settle();
  assert.deepEqual(reads, [true]);
  assert.equal(extension.alarmSet.has(LIBRARY_SYNC_ALARM), true);
  assert.deepEqual(fetched, [`${AO3_ORIGIN}/works/71?view_adult=true`]);
  // A save in Trace reads the Library again.
  for (const changed of extension.listeners.changed) changed({ [ACCOUNT_PROJECTION_REVISION_KEY]: { newValue: 2 } }, "local");
  await settle();
  assert.deepEqual(reads, [true, true]);
  // Turned off: its alarm stops.
  for (const changed of extension.listeners.changed) changed({ [KEEP_A_COPY_PREF_KEY]: { newValue: false } }, "local");
  await settle();
  assert.equal(extension.alarmSet.has(LIBRARY_SYNC_ALARM), false);
});
