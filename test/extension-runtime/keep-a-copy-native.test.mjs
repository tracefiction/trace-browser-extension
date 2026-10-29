import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { AO3_ORIGIN } from "../../.trace-build/extension-runtime/keep-a-copy.mjs";
import {
  KEEP_COPY_NATIVE,
  MAX_QUEUE_WORKS,
  NativeCopyHandoff,
  PART_BYTES,
  TRANSFER_KEY,
  ackedIndex,
  partCount,
  readQueueAnswer,
  readerTab,
} from "../../.trace-build/extension-runtime/keep-a-copy-native.mjs";
import { keepCopyFetchInTab, keepCopyPartInTab, keepCopyReleaseInTab } from "../../.trace-build/extension-runtime/keep-a-copy-tab.mjs";

// Invented works throughout, as in keep-a-copy.test.mjs. The app is a fake that keeps to
// the hand-off protocol.
const NOW = Date.parse("2026-10-29T10:00:00Z");
const INBOX_MAX = 512 * 1_024;

function workPage(id, { updatedAt = "1761700000", restricted = true, signedIn = true } = {}) {
  return `<html><body class="${signedIn ? "logged-in" : "logged-out"}">` +
    `<ul class="work navigation actions"><li class="download"><button>Download</button><ul class="expandable secondary">` +
    `<li><a href="/downloads/${id}/Invented_work.epub?updated_at=${updatedAt}">EPUB</a></li></ul></li></ul>` +
    `<dl class="work meta group"><dd class="fandom tags"><ul><li><a class="tag" href="/tags/x/works">Invented Lanterns</a></li></ul></dd>` +
    `<dd class="chapters">3/10</dd></dl><div class="preface group"><h2 class="title heading">` +
    `${restricted ? '<img alt="(Restricted)" src="/images/lockblue.png" />' : ""}Invented work ${id}</h2>` +
    `<h3 class="byline heading"><a rel="author" href="/users/Quill/pseuds/Quill">Synthetic_Quill</a></h3></div></body></html>`;
}

/** An EPUB-shaped file of `size` bytes with varied content, so parts differ. */
function epub(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  bytes.set(new TextEncoder().encode("mimetypeapplication/epub+zip"), 30);
  return bytes;
}

const workURL = (id) => `${AO3_ORIGIN}/works/${id}?view_adult=true`;
const fileURL = (id, updatedAt = "1761700000") => `${AO3_ORIGIN}/downloads/${id}/Invented_work.epub?updated_at=${updatedAt}`;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** AO3 as the reader's tab reaches it: the real in-tab functions run against this. */
function ao3(routes) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return new Response("<h2>Error 404</h2>", { status: 404, headers: { "content-type": "text/html" } });
    return typeof body === "string"
      ? new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response(body, { status: 200, headers: { "content-type": "application/epub+zip" } });
  };
  return { requests, fetchImpl };
}

/** The Trace app's side, as the hand-off protocol says it behaves. */
function fakeApp({ works = [], enabled = true, drop = () => false, refuseBegin = false } = {}) {
  const app = { messages: [], transfers: new Map(), saved: [], skipped: [], aborted: [], works, enabled };
  app.send = async (message) => {
    app.messages.push(message);
    assert.equal(message.protocolVersion, 1);
    assert.ok(JSON.stringify(message).length < INBOX_MAX, `${message.type} is over the inbox's 512 KiB`);
    if (drop(message, app)) return null;
    switch (message.type) {
      case KEEP_COPY_NATIVE.queue:
        return { ok: true, enabled: app.enabled, format: "epub", works: app.works };
      case KEEP_COPY_NATIVE.begin: {
        if (refuseBegin) return { ok: false, error: "not_wanted" };
        const known = app.transfers.get(message.transferId);
        if (!known) app.transfers.set(message.transferId, { begin: message, parts: [] });
        return { ok: true, transferId: message.transferId, nextIndex: known ? known.parts.length : 0 };
      }
      case KEEP_COPY_NATIVE.part: {
        const transfer = app.transfers.get(message.transferId);
        if (!transfer) return { ok: false, error: "unknown_transfer" };
        if (message.index === transfer.parts.length) transfer.parts.push(Buffer.from(message.base64, "base64"));
        return { ok: true, transferId: message.transferId, nextIndex: transfer.parts.length };
      }
      case KEEP_COPY_NATIVE.end: {
        const transfer = app.transfers.get(message.transferId);
        const bytes = Buffer.concat(transfer.parts);
        if (bytes.length !== transfer.begin.byteLength || sha(bytes) !== transfer.begin.sha256) return { ok: false, error: "checksum_mismatch" };
        app.saved.push({ workId: transfer.begin.workId, updatedAt: transfer.begin.updatedAt, fileName: transfer.begin.fileName, bytes });
        app.transfers.delete(message.transferId);
        return { ok: true, transferId: message.transferId, saved: true };
      }
      case KEEP_COPY_NATIVE.abort:
        app.aborted.push(message);
        app.transfers.delete(message.transferId);
        return { ok: true };
      case KEEP_COPY_NATIVE.skipped:
        app.skipped.push(message);
        return { ok: true };
      default:
        return null;
    }
  };
  return app;
}

function harness({ app, site, storage = new Map(), tabOpen = true }) {
  const box = { now: NOW, storage, site, app, partReads: [] };
  let ids = 0;
  const realFetch = globalThis.fetch;
  box.handoff = new NativeCopyHandoff({
    native: { send: (message) => app.send(structuredClone(message)) },
    tabs: {
      find: async () => (tabOpen ? 7 : null),
      async run(tabId, func, args) {
        assert.equal(tabId, 7);
        if (func === keepCopyPartInTab) box.partReads.push(args[1]);
        globalThis.fetch = site.fetchImpl;
        try {
          return structuredClone(await func(...args));
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    },
    storage: {
      get: async (key) => structuredClone(storage.get(key)),
      set: async (key, value) => { storage.set(key, structuredClone(value)); },
    },
    clock: { now: () => box.now },
    random: () => 0,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
  });
  box.drain = async (max = 200) => {
    for (let i = 0; i < max; i += 1) {
      const wait = await box.handoff.engine.tick();
      if (wait === null) return;
      box.now += wait;
    }
  };
  return box;
}

test("the app's queue is read strictly: anything malformed fetches nothing", () => {
  assert.deepEqual(readQueueAnswer({ ok: true, enabled: true, works: [{ workId: "11", reason: "locked" }] }), {
    enabled: true, format: "epub", works: [{ workId: "11", have: null, pace: "check", reason: "locked" }],
  });
  assert.deepEqual(readQueueAnswer({ ok: true, enabled: false, works: [{ workId: "11", reason: "locked" }] }).works, []);
  for (const bad of [
    null,
    { ok: false },
    { ok: true },
    { ok: true, enabled: true, format: "docx", works: [] },
    { ok: true, enabled: true, works: [{ workId: "0", reason: "locked" }] },
    { ok: true, enabled: true, works: [{ workId: "11", reason: "public" }] },
    { ok: true, enabled: true, works: [{ workId: "11", reason: "refused", have: "yesterday" }] },
    { ok: true, enabled: true, works: [{ workId: "11", reason: "refused", url: "https://example.invalid/x.epub", pace: "now" }] },
    { ok: true, enabled: true, works: Array.from({ length: MAX_QUEUE_WORKS + 1 }, (_, i) => ({ workId: String(i + 1), reason: "locked" })) },
  ]) assert.equal(readQueueAnswer(bad), null, JSON.stringify(bad)?.slice(0, 80));
  assert.equal(ackedIndex({ ok: true, transferId: "t", nextIndex: 3 }, "t", 3), 3);
  assert.equal(ackedIndex({ ok: true, transferId: "t", nextIndex: 4 }, "t", 3), null);
  assert.equal(ackedIndex({ ok: true, transferId: "other", nextIndex: 1 }, "t", 3), null);
  assert.equal(partCount(1), 1);
  assert.equal(partCount(PART_BYTES * 2 + 1), 3);
});

test("the reader's AO3 tab is the one they are on, else the last they used", () => {
  assert.equal(readerTab([
    { id: 1, url: "https://example.invalid/" , active: true },
    { id: 2, url: "https://archiveofourown.org/works/1", lastAccessed: 5 },
    { id: 3, url: "https://archiveofourown.org/works/2", lastAccessed: 9 },
  ]), 3);
  assert.equal(readerTab([{ id: 2, url: "https://archiveofourown.org/", lastAccessed: 9 }, { id: 4, url: "https://archiveofourown.org/", active: true }]), 4);
  assert.equal(readerTab([{ id: 5, url: "https://archiveofourown.org.example.invalid/" }]), null);
});

test("a locked work the app asks for is read from its page in the tab, then handed over in parts the app checks", async () => {
  const file = epub(PART_BYTES * 2 + 1_000);
  const site = ao3({ [workURL("21")]: workPage("21"), [fileURL("21")]: file });
  const app = fakeApp({ works: [{ workId: "21", reason: "locked", pace: "reader" }] });
  const box = harness({ app, site });
  assert.equal(await box.handoff.askQueue(true), true);
  await box.drain();
  assert.deepEqual(site.requests, [workURL("21"), fileURL("21")]);
  assert.equal(app.saved.length, 1);
  assert.equal(app.saved[0].bytes.equals(Buffer.from(file)), true);
  assert.equal(app.saved[0].updatedAt, "1761700000");
  assert.equal(app.saved[0].fileName, "AO3/Invented Lanterns/Invented work 21 – Synthetic_Quill (21).epub");
  const types = app.messages.map((message) => message.type);
  assert.deepEqual(types, [KEEP_COPY_NATIVE.queue, KEEP_COPY_NATIVE.begin, KEEP_COPY_NATIVE.part, KEEP_COPY_NATIVE.part, KEEP_COPY_NATIVE.part, KEEP_COPY_NATIVE.end]);
  const begin = app.messages[1];
  assert.equal(begin.byteLength, file.length);
  assert.equal(begin.sha256, sha(file));
  assert.equal(begin.partBytes, PART_BYTES);
  assert.equal(begin.partCount, 3);
  // No message carried more than one part.
  for (const message of app.messages) assert.ok(!message.base64 || Buffer.from(message.base64, "base64").length <= PART_BYTES);
  assert.equal((await box.handoff.engine.view()).withCopy, 1);
  // The tab let the file go once it was handed over.
  assert.equal(await keepCopyPartInTab(box.storage.get(TRANSFER_KEY).handle, 0, PART_BYTES), null);
});

test("a background stopped mid-transfer resumes where the app has it, and sends no part twice", async () => {
  const file = epub(PART_BYTES * 3);
  const site = ao3({ [workURL("31")]: workPage("31"), [fileURL("31")]: file });
  let dropped = false;
  // The app's answer to part 1 never arrives, and the background stops.
  const app = fakeApp({ works: [{ workId: "31", reason: "locked" }], drop: (message) => message.type === KEEP_COPY_NATIVE.part && message.index === 1 && !dropped && (dropped = true) });
  const first = harness({ app, site });
  await first.handoff.askQueue(true);
  // Ticks until the unanswered part is recorded, then this background is gone.
  for (let i = 0; i < 10 && first.storage.get(TRANSFER_KEY)?.failures !== 1; i += 1) {
    const wait = await first.handoff.engine.tick();
    first.now += wait ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const open = first.storage.get(TRANSFER_KEY);
  assert.equal(open.state, "open");
  assert.equal(open.failures, 1);

  const second = harness({ app, site, storage: first.storage });
  second.now = first.now;
  await second.drain();
  assert.equal(app.saved.length, 1);
  assert.equal(app.saved[0].bytes.equals(Buffer.from(file)), true);
  const begins = app.messages.filter((message) => message.type === KEEP_COPY_NATIVE.begin);
  assert.ok(begins.length >= 2);
  assert.equal(new Set(begins.map((message) => message.transferId)).size, 1, "the resumed transfer kept its id");
  const parts = app.messages.filter((message) => message.type === KEEP_COPY_NATIVE.part).map((message) => message.index);
  assert.deepEqual(parts.filter((index) => index === 0), [0]);
  assert.equal(site.requests.filter((url) => url === fileURL("31")).length, 1, "the file was fetched again");
});

test("a file the tab lost, or a transfer the app refuses, is aborted and the old copy stays", async () => {
  const file = epub(PART_BYTES + 10);
  const site = ao3({ [workURL("41")]: workPage("41"), [fileURL("41")]: file });
  const app = fakeApp({ works: [{ workId: "41", reason: "refused" }], refuseBegin: true });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(app.saved.length, 0);
  assert.ok(app.aborted.length >= 1);
  assert.equal(app.aborted[0].reason, "not_wanted");
  // Tried MAX_ATTEMPTS times, then the app is told it was not saved.
  assert.deepEqual(app.skipped.map(({ workId, code }) => [workId, code]), [["41", "save_failed"]]);
  assert.equal(box.storage.get(TRANSFER_KEY).state, "failed");
});

test("a locked work whose page does not show the reader signed in fetches no file; the app is told", async () => {
  const site = ao3({ [workURL("51")]: workPage("51", { signedIn: false }), [fileURL("51")]: epub(2_000) });
  const app = fakeApp({ works: [{ workId: "51", reason: "locked" }] });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.deepEqual(site.requests, [workURL("51")]);
  assert.deepEqual(app.skipped.map(({ workId, code }) => [workId, code]), [["51", "needs_sign_in"]]);
  assert.equal(app.messages.some((message) => message.type === KEEP_COPY_NATIVE.begin), false);
});

test("a work the app holds at the same updated_at is only looked at; switched off in the app, the queue empties", async () => {
  const site = ao3({ [workURL("61")]: workPage("61"), [fileURL("61")]: epub(3_000) });
  const app = fakeApp({ works: [{ workId: "61", reason: "locked" }] });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(app.saved.length, 1);
  // Asked again with the copy it holds: the page is read, no file is fetched.
  app.works = [{ workId: "61", reason: "locked", have: "1761700000" }];
  await box.handoff.askQueue(true);
  await box.drain();
  assert.deepEqual(site.requests, [workURL("61"), fileURL("61"), workURL("61")]);
  // The app lost its copy: fetched again.
  app.works = [{ workId: "61", reason: "locked", have: null }];
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(app.saved.length, 2);
  app.enabled = false;
  app.works = [{ workId: "61", reason: "locked" }];
  await box.handoff.askQueue(true);
  assert.equal((await box.handoff.engine.view()).waiting, 0);
  assert.equal(await box.handoff.engine.tick(), null);
});

test("the tab keeps a file as a blob, gives it back a part at a time, and refuses other sites", async (t) => {
  const file = epub(PART_BYTES + 5);
  const site = ao3({ [fileURL("71")]: file });
  const realFetch = globalThis.fetch;
  globalThis.fetch = site.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  const answer = await keepCopyFetchInTab(fileURL("71"), "file", 5_000, 50 * 1_024 * 1_024, "keep-copy:7:a");
  assert.equal(answer.kind, "response");
  assert.equal(answer.size, file.length);
  assert.equal(answer.sha256, sha(file));
  assert.equal(answer.head.length, 8_192);
  const zero = Buffer.from(await keepCopyPartInTab("keep-copy:7:a", 0, PART_BYTES), "base64");
  const one = Buffer.from(await keepCopyPartInTab("keep-copy:7:a", 1, PART_BYTES), "base64");
  assert.equal(Buffer.concat([zero, one]).equals(Buffer.from(file)), true);
  assert.equal(await keepCopyPartInTab("keep-copy:7:a", 2, PART_BYTES), null);
  assert.equal(keepCopyReleaseInTab("keep-copy:7:a"), true);
  assert.equal(await keepCopyPartInTab("keep-copy:7:a", 0, PART_BYTES), null);
  assert.deepEqual(await keepCopyFetchInTab("https://example.invalid/x.epub", "file", 5_000, 1_000, "keep-copy:7:b"), { kind: "failed", code: "network" });
  assert.deepEqual(await keepCopyFetchInTab(fileURL("71"), "file", 5_000, 1_000, "keep-copy:7:c"), { kind: "failed", code: "too_large" });
});
