import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { COPY_FOLDER, AO3_ORIGIN, lockedFileURL, lockedVersion } from "../../.trace-build/extension-runtime/keep-a-copy.mjs";
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
import { IndexedDbKeepStore } from "../../.trace-build/extension-runtime/keep-a-copy-store.mjs";
import { SETTLE_MAX_MS, WANT_MEMORY_MS } from "../../.trace-build/extension-runtime/keep-a-copy.mjs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

// Invented works throughout, as in keep-a-copy.test.mjs. The app is a fake that keeps to
// docs/keep-a-copy-native-protocol.md.
const NOW = Date.parse("2026-10-29T10:00:00Z");
const INBOX_MAX = 512 * 1_024;

function workPage(id, { updatedAt = "1761700000", restricted = false } = {}) {
  return `<html><body class="logged-out">` +
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

const navigateURL = (id) => `${AO3_ORIGIN}/works/${id}/navigate`;
/** A route answered with the sign-in page. */
const LOGIN = Symbol("login");
/** A route that sends the request to the work's page: followed only by a request that may follow it. */
const REDIRECT = Symbol("redirect");

/** A work's Chapter Index: `chapters` as [chapter id, YYYY-MM-DD]. */
function chapterIndex(id, { chapters = [["101", "2026-10-01"]], signedIn = true } = {}) {
  return `<html><body class="${signedIn ? "logged-in" : "logged-out"}"><h2 class="heading">Chapter Index for <a href="/works/${id}">Invented work ${id}</a>` +
    ` by <a rel="author" href="/users/Quill/pseuds/Quill">Synthetic_Quill</a></h2><ol class="chapter index group" role="navigation">` +
    chapters.map(([cid, date], i) => `<li><a href="/works/${id}/chapters/${cid}">${i + 1}. Chapter</a> <span class="datetime">(${date})</span></li>`).join("") + "</ol></body></html>";
}

/**
 * AO3 as the reader's tab reaches it: the real in-tab functions run against
 * this. `modes`: each request's credentials mode. A request that is not
 * signed in is sent to the sign-in page for a locked work's page, and no
 * work or chapter page is ever read signed in.
 */
function ao3(routes) {
  const requests = [];
  const modes = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push(String(url));
    modes.push(init.credentials);
    assert.ok(init.credentials !== "include" || !/\/works\/[0-9]+(?:[?#]|$|\/chapters\/)/.test(String(url)), `${url} read signed in`);
    const body = routes[String(url)];
    if (body === undefined) return new Response("<h2>Error 404</h2>", { status: 404, headers: { "content-type": "text/html" } });
    if (body === REDIRECT) {
      if (init.redirect === "manual") return { type: "opaqueredirect", status: 0, url: String(url), headers: new Headers(), body: null };
      return fetchImpl(String(url).replace(/\/(?:navigate|chapters\/.*)$|\/downloads\/([0-9]+)\/.*$/, "").replace(/\/downloads\/([0-9]+)$/, "/works/$1"), init);
    }
    if (body === LOGIN || (typeof body === "string" && init.credentials !== "include" && body.includes('alt="(Restricted)"'))) {
      const login = new Response('<body class="logged-out"><form action="/users/login" method="post"></form></body>', { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(login, "url", { value: `${AO3_ORIGIN}/users/login?restricted=true` });
      return login;
    }
    return typeof body === "string"
      ? new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response(body, { status: 200, headers: { "content-type": "application/epub+zip" } });
  };
  return { requests, modes, fetchImpl };
}

/** The Trace app's side, as the hand-off protocol says it behaves. */
function fakeApp({ works = [], enabled = true, drop = () => false, refuseBegin = false, stoppedUntil = null } = {}) {
  const app = { messages: [], transfers: new Map(), completed: new Set(), saved: [], skipped: [], aborted: [], works, enabled, stoppedUntil,
    leases: [], leaseHeld: false, appHoldsAO3: false, disabledBegin: false };
  app.send = async (message) => {
    // The AO3 lease, kept apart so the transfer's own messages read as before.
    if (message.type === KEEP_COPY_NATIVE.lock) {
      app.leases.push(message);
      if (app.disabledBegin) return { ok: false, error: "disabled" };
      if (app.oldHandler) return { type: "error", status: "error", error: "unknown_message_type", receivedType: message.type };
      if (app.appHoldsAO3 || app.leaseHeld) return { ok: true, granted: false, until: 0 };
      app.leaseHeld = true;
      return { ok: true, granted: true };
    }
    if (message.type === KEEP_COPY_NATIVE.unlock) { app.leaseHeld = false; return { ok: true }; }
    app.messages.push(message);
    assert.equal(message.protocolVersion, 1);
    assert.ok(JSON.stringify(message).length < INBOX_MAX, `${message.type} is over the inbox's 512 KiB`);
    const answer = await respond(message);
    // The app did the work, but its answer never arrived.
    return drop(message, app) ? null : answer;
  };
  const respond = async (message) => {
    // A repeat of any message of a transfer it completed: done.
    if (message.transferId && app.completed.has(message.transferId) && message.type !== KEEP_COPY_NATIVE.abort) {
      return { ok: true, transferId: message.transferId, saved: true };
    }
    if (app.hold && message.type === KEEP_COPY_NATIVE.part) await app.hold;
    switch (message.type) {
      case KEEP_COPY_NATIVE.queue:
        return { ok: true, enabled: app.enabled, format: "epub", works: app.works,
          ...(app.stoppedUntil === null ? {} : { stoppedUntil: app.stoppedUntil, stopReason: "challenge" }) };
      case KEEP_COPY_NATIVE.begin: {
        if (refuseBegin) return { ok: false, error: "not_wanted" };
        if (app.disabledBegin) return { ok: false, error: "disabled" };
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
        app.completed.add(message.transferId);
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

const TAB = { id: 7, windowId: 1, incognito: false, workId: null };

/** Runs `step` until `ready()` holds, however slow the machine; fails after ten seconds. */
async function until(ready, what, step = async () => undefined) {
  for (const started = Date.now(); !(await ready()); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() - started > 10_000) assert.fail(`still waiting: ${what}`);
    await step();
  }
}

function harness({ app, site, store = new IndexedDbKeepStore(new IDBFactory(), IDBKeyRange), tab = TAB }) {
  const box = { now: NOW, store, site, app, partReads: [], tab };
  let ids = 0;
  const realFetch = globalThis.fetch;
  box.handoff = new NativeCopyHandoff({
    native: { send: (message) => app.send(structuredClone(message)) },
    tabs: {
      find: async () => box.tab,
      async run(tabId, func, args) {
        box.ran = [...(box.ran ?? []), tabId];
        // The script could not run in the tab.
        if (box.scriptFails) return null;
        if (func === keepCopyPartInTab) box.partReads.push(args[1]);
        globalThis.fetch = site.fetchImpl;
        try {
          return structuredClone(await func(...args));
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    },
    store,
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
    enabled: true, format: "epub", works: [{ workId: "11", have: null, pace: "check", reason: "locked" }], stopped: null,
  });
  assert.deepEqual(readQueueAnswer({ ok: true, enabled: true, works: [], stoppedUntil: 9_000, stopReason: "challenge" }).stopped,
    { code: "challenge", until: 9_000 });
  assert.deepEqual(readQueueAnswer({ ok: true, enabled: true, works: [], stoppedUntil: 9_000, stopReason: "?" }).stopped,
    { code: "forbidden", until: 9_000 }, "an unknown reason still stops");
  assert.deepEqual(readQueueAnswer({ ok: true, enabled: false, works: [{ workId: "11", reason: "locked" }] }).works, []);
  for (const bad of [
    null,
    { ok: false },
    { ok: true },
    { ok: true, enabled: true, format: "docx", works: [] },
    // Only EPUB is handed over.
    ...["azw3", "mobi", "pdf", "html"].map((format) => ({ ok: true, enabled: true, format, works: [] })),
    { ok: true, enabled: true, works: [{ workId: "0", reason: "locked" }] },
    { ok: true, enabled: true, works: [{ workId: "11", reason: "public" }] },
    { ok: true, enabled: true, works: [{ workId: "11", reason: "refused", have: "yesterday" }] },
    { ok: true, enabled: true, works: [{ workId: "11", reason: "refused", url: "https://example.invalid/x.epub", pace: "now" }] },
    { ok: true, enabled: true, works: Array.from({ length: MAX_QUEUE_WORKS + 1 }, (_, i) => ({ workId: String(i + 1), reason: "locked" })) },
    { ok: true, enabled: true, works: [], stoppedUntil: "soon" },
  ]) assert.equal(readQueueAnswer(bad), null, JSON.stringify(bad)?.slice(0, 80));
  assert.equal(ackedIndex({ ok: true, transferId: "t", nextIndex: 3 }, "t", 3), 3);
  assert.equal(ackedIndex({ ok: true, transferId: "t", nextIndex: 4 }, "t", 3), null);
  assert.equal(ackedIndex({ ok: true, transferId: "other", nextIndex: 1 }, "t", 3), null);
  assert.equal(partCount(1), 1);
  assert.equal(partCount(PART_BYTES * 2 + 1), 3);
});

test("a stop the app met holds this extension too: nothing is read from AO3 until it is over", async () => {
  const file = epub(1_000);
  const site = ao3({ [workURL("31")]: workPage("31"), [fileURL("31")]: file });
  const app = fakeApp({ works: [{ workId: "31", reason: "refused", pace: "reader" }], stoppedUntil: 0 });
  const box = harness({ app, site });
  app.stoppedUntil = box.now + 60 * 60_000;
  await box.handoff.askQueue(true);
  assert.equal(await box.handoff.engine.tick() > 59 * 60_000, true);
  assert.deepEqual(site.requests, []);
  assert.equal((await box.handoff.engine.view()).stopped.code, "challenge");
  box.now += 60 * 60_000 + 1;
  await box.drain();
  assert.deepEqual(site.requests, [workURL("31"), fileURL("31")]);
});

test("AO3 is asked only under the lease the app shares: while the app holds it, nothing is read, and no stop follows", async () => {
  const file = epub(1_000);
  const site = ao3({ [workURL("32")]: workPage("32"), [fileURL("32")]: file });
  const app = fakeApp({ works: [{ workId: "32", reason: "locked", pace: "reader" }] });
  const box = harness({ app, site });
  app.appHoldsAO3 = true;
  await box.handoff.askQueue(true);
  for (let i = 0; i < 5; i += 1) box.now += (await box.handoff.engine.tick()) ?? 0;
  assert.deepEqual(site.requests, []);
  assert.equal((await box.handoff.engine.view()).stopped, null, "waiting for the app is never a stop");
  app.appHoldsAO3 = false;
  await box.drain();
  assert.deepEqual(site.requests, [workURL("32"), fileURL("32")]);
  assert.equal(app.leases.length >= 2 && app.leaseHeld, false, "each lease is given back");
});

test("the app's \"disabled\" turns Keep a Copy off here at once: nothing more fetched, the list dropped", async () => {
  const site = ao3({ [workURL("33")]: workPage("33"), [fileURL("33")]: epub(1_000) });
  const app = fakeApp({ works: [{ workId: "33", reason: "locked", pace: "reader" }, { workId: "34", reason: "locked" }] });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  app.disabledBegin = true;
  await box.drain();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await box.handoff.engine.enabled(), false);
  assert.equal((await box.handoff.engine.view()).waiting, 0);
  assert.equal(app.saved.length, 0);
});

test("an app that doesn't know AO3's lease turns Keep a Copy off here, said once, never retried for ever", async () => {
  const site = ao3({ [workURL("35")]: workPage("35"), [fileURL("35")]: epub(1_000) });
  const app = fakeApp({ works: [{ workId: "35", reason: "locked", pace: "reader" }] });
  const box = harness({ app, site });
  app.oldHandler = true;
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    await box.handoff.askQueue(true);
    await box.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await box.drain();
  } finally { console.warn = warn; }
  assert.deepEqual(site.requests, []);
  assert.equal(await box.handoff.engine.enabled(), false);
  assert.equal(warned.length, 1);
  assert.equal(app.leases.length, 1, "asked once");
});

test("the reader leaving the tab, or a script that cannot run there, is never a stop, nor shared with the app", async () => {
  const site = ao3({ [workURL("36")]: workPage("36"), [fileURL("36")]: epub(1_000) });
  const app = fakeApp({ works: [{ workId: "36", reason: "refused", pace: "reader" }] });
  const box = harness({ app, site });
  const fetchImpl = site.fetchImpl;
  // Each time the page is read, the reader moves to their other AO3 tab.
  site.fetchImpl = async (url, init) => {
    const answer = await fetchImpl(url, init);
    if (String(url) === workURL("36")) box.tab = { ...TAB, id: box.tab.id === 7 ? 8 : 7 };
    return answer;
  };
  await box.handoff.askQueue(true);
  for (let i = 0; i < 5; i += 1) box.now += (await box.handoff.engine.tick()) ?? 0;
  site.fetchImpl = fetchImpl;
  box.scriptFails = true;
  for (let i = 0; i < 5; i += 1) box.now += (await box.handoff.engine.tick()) ?? 0;
  assert.deepEqual(site.requests, Array(5).fill(workURL("36")));
  assert.equal((await box.handoff.engine.view()).stopped, null);
  await box.handoff.askQueue(true);
  assert.equal(app.messages.filter((m) => m.type === KEEP_COPY_NATIVE.queue).at(-1).stopped, null);
  box.scriptFails = false;
  await box.drain();
  assert.equal(app.saved.length, 1);
});

test("only a stop AO3's own answer set is shared with the app, never one from tries that got no answer", async () => {
  const site = ao3({ [fileURL("37")]: epub(1_000) });
  const app = fakeApp({ works: [{ workId: "37", reason: "refused", pace: "reader" }] });
  const box = harness({ app, site });
  const fetchImpl = site.fetchImpl;
  site.fetchImpl = async () => { throw new TypeError("Load failed"); };
  await box.handoff.askQueue(true);
  for (let i = 0; i < 3; i += 1) {
    const wait = await box.handoff.engine.tick();
    if (i < 2) box.now += wait ?? 0;
  }
  const unanswered = (await box.handoff.engine.view()).stopped;
  assert.equal(unanswered.code, "slow_down");
  assert.equal(unanswered.fromAO3, undefined);
  await box.handoff.askQueue(true);
  assert.equal(app.messages.filter((m) => m.type === KEEP_COPY_NATIVE.queue).at(-1).stopped, null);
  // AO3 refuses: that stop is AO3's own, and the app is told.
  box.now = unanswered.until;
  site.fetchImpl = async (url, init) => (String(url) === workURL("37")
    ? new Response("<h2>Error 403</h2>", { status: 403, headers: { "content-type": "text/html" } })
    : fetchImpl(url, init));
  await box.handoff.engine.tick();
  const refused = (await box.handoff.engine.view()).stopped;
  assert.equal(refused.code, "forbidden");
  await box.handoff.askQueue(true);
  assert.deepEqual(app.messages.filter((m) => m.type === KEEP_COPY_NATIVE.queue).at(-1).stopped, { code: "forbidden", until: refused.until });
});

test("the reader's AO3 tab is the one they are on, else the last they used", () => {
  assert.deepEqual(readerTab([
    { id: 1, url: "https://example.invalid/" , active: true },
    { id: 2, url: "https://archiveofourown.org/works/1", lastAccessed: 5 },
    { id: 3, url: "https://archiveofourown.org/works/2/chapters/9", lastAccessed: 9, windowId: 4, incognito: true },
  ]), { id: 3, windowId: 4, incognito: true, workId: "2" });
  assert.equal(readerTab([{ id: 2, url: "https://archiveofourown.org/", lastAccessed: 9 }, { id: 4, url: "https://archiveofourown.org/", active: true }]).id, 4);
  assert.equal(readerTab([{ id: 5, url: "https://archiveofourown.org.example.invalid/" }]), null);
});

test("a work AO3 refused the app is read from its page in the tab, signed out, then handed over in parts the app checks", async () => {
  const file = epub(PART_BYTES * 2 + 1_000);
  const site = ao3({ [workURL("21")]: workPage("21"), [fileURL("21")]: file });
  const app = fakeApp({ works: [{ workId: "21", reason: "refused", pace: "reader" }] });
  const box = harness({ app, site });
  assert.equal(await box.handoff.askQueue(true), true);
  await box.drain();
  assert.deepEqual(site.requests, [workURL("21"), fileURL("21")]);
  assert.deepEqual(site.modes, ["omit", "omit"]);
  assert.equal(app.saved.length, 1);
  assert.equal(app.saved[0].bytes.equals(Buffer.from(file)), true);
  assert.equal(app.saved[0].updatedAt, "1761700000");
  assert.equal(app.saved[0].fileName, `${COPY_FOLDER}/Invented Lanterns/Invented work 21 – Synthetic_Quill (21).epub`);
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
  assert.equal(await keepCopyPartInTab((await box.store.getMeta(TRANSFER_KEY)).handle, 0, PART_BYTES), null);
});

test("a background stopped mid-transfer resumes where the app has it, and sends no part twice", async () => {
  const file = epub(PART_BYTES * 3);
  const site = ao3({ [workURL("31")]: workPage("31"), [fileURL("31")]: file });
  let dropped = false;
  // The app's answer to part 1 never arrives, and the background stops.
  const app = fakeApp({ works: [{ workId: "31", reason: "refused" }], drop: (message) => message.type === KEEP_COPY_NATIVE.part && message.index === 1 && !dropped && (dropped = true) });
  const first = harness({ app, site });
  await first.handoff.askQueue(true);
  // Ticks until the unanswered part is recorded, then this background is gone.
  await until(async () => (await first.store.getMeta(TRANSFER_KEY))?.failures === 1, "the unanswered part", async () => {
    first.now += (await first.handoff.engine.tick()) ?? 0;
  });
  const open = await first.store.getMeta(TRANSFER_KEY);
  assert.equal(open.state, "open");
  assert.equal(open.failures, 1);

  const second = harness({ app, site, store: first.store });
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
  assert.equal((await box.store.getMeta(TRANSFER_KEY)).state, "failed");
});

test("a locked work is copied from its Chapter Index in the tab, signed in, then its file, and handed over", async () => {
  const file = epub(2_000);
  const version = lockedVersion({ latestAt: Date.parse("2026-10-20T00:00:00Z") / 1_000, chapters: 2 });
  const lockedFile = lockedFileURL("51", "Invented work 51", "epub", version);
  const site = ao3({
    [workURL("51")]: workPage("51", { restricted: true }),
    [navigateURL("51")]: chapterIndex("51", { chapters: [["511", "2026-10-01"], ["512", "2026-10-20"]] }),
    [lockedFile]: file,
  });
  const app = fakeApp({ works: [{ workId: "51", reason: "locked" }] });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.deepEqual(site.requests, [workURL("51"), navigateURL("51"), lockedFile]);
  assert.deepEqual(site.modes, ["omit", "include", "include"]);
  assert.equal(app.saved.length, 1);
  assert.equal(app.saved[0].updatedAt, version);
  assert.equal(app.saved[0].bytes.equals(Buffer.from(file)), true);
});

test("a locked work's Chapter Index on the sign-in page, sent elsewhere, or of another work, fetches no file", async () => {
  const site = ao3({
    [workURL("52")]: workPage("52", { restricted: true }),
    [navigateURL("52")]: LOGIN,
    [workURL("53")]: workPage("53", { restricted: true }),
    [navigateURL("53")]: chapterIndex("54"),
    [workURL("55")]: workPage("55", { restricted: true }),
    [navigateURL("55")]: REDIRECT,
  });
  const app = fakeApp({ works: [{ workId: "52", reason: "locked" }, { workId: "53", reason: "locked" }, { workId: "55", reason: "locked" }] });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(site.requests.some((url) => url.includes("/downloads/")), false);
  assert.deepEqual(app.skipped.map(({ workId, code }) => [workId, code]).sort(), [["52", "needs_sign_in"], ["53", "no_download"], ["55", "needs_sign_in"]]);
  // The index sent elsewhere is not followed: one request for it.
  assert.equal(site.requests.filter((url) => url.startsWith(`${AO3_ORIGIN}/works/55`)).length, 2);
  assert.equal(app.messages.some((message) => message.type === KEEP_COPY_NATIVE.begin), false);
  assert.equal((await box.handoff.engine.view()).stopped, null);
});

test("a work the app holds at the same updated_at is only looked at; switched off in the app, the queue empties", async () => {
  const site = ao3({ [workURL("61")]: workPage("61"), [fileURL("61")]: epub(3_000) });
  const app = fakeApp({ works: [{ workId: "61", reason: "refused" }] });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(app.saved.length, 1);
  // Asked again with the copy it holds: the page is read, no file is fetched.
  app.works = [{ workId: "61", reason: "refused", have: "1761700000" }];
  await box.handoff.askQueue(true);
  await box.drain();
  assert.deepEqual(site.requests, [workURL("61"), fileURL("61"), workURL("61")]);
  // The app lost its copy: fetched again.
  app.works = [{ workId: "61", reason: "refused", have: null }];
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(app.saved.length, 2);
  app.enabled = false;
  app.works = [{ workId: "61", reason: "refused" }];
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
  const answer = await keepCopyFetchInTab(fileURL("71"), "file", 5_000, 50 * 1_024 * 1_024, "keep-copy:7:a", "omit");
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
  assert.deepEqual(await keepCopyFetchInTab("https://example.invalid/x.epub", "file", 5_000, 1_000, "keep-copy:7:b", "omit"), { kind: "failed", code: "network" });
  assert.deepEqual(await keepCopyFetchInTab(fileURL("71"), "file", 5_000, 1_000, "keep-copy:7:c", "omit"), { kind: "failed", code: "too_large" });
  await keepCopyFetchInTab(workURL("71"), "text", 5_000, 1_000, "", "omit");
  await keepCopyFetchInTab(navigateURL("71"), "text", 5_000, 1_000, "", "include");
  // Each request from the tab goes with the credentials it is given, and anything else is signed out.
  await keepCopyFetchInTab(workURL("71"), "text", 5_000, 1_000, "", "same-origin");
  assert.deepEqual(site.modes, ["omit", "omit", "omit", "include", "omit"]);
});

test("a slow transfer that keeps moving is waited on past the 15 minutes, and AO3 is asked for the file once", async () => {
  const file = epub(PART_BYTES * 4);
  const site = ao3({ [workURL("81")]: workPage("81"), [fileURL("81")]: file });
  const app = fakeApp({ works: [{ workId: "81", reason: "refused" }] });
  const box = harness({ app, site });
  // Each part takes the app six minutes: 24 minutes in all.
  const send = app.send;
  app.send = async (message) => {
    if (message.type === KEEP_COPY_NATIVE.part) box.now += 6 * 60_000;
    return send(message);
  };
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(app.saved.length, 1);
  assert.ok(box.now - NOW > SETTLE_MAX_MS);
  assert.equal(site.requests.filter((url) => url === fileURL("81")).length, 1);
});

test("a transfer given up while a part is on its way is never written open again", async () => {
  const file = epub(PART_BYTES * 2);
  const site = ao3({ [workURL("82")]: workPage("82"), [fileURL("82")]: file, [workURL("84")]: workPage("84"), [fileURL("84")]: epub(PART_BYTES + 5) });
  const app = fakeApp({ works: [{ workId: "82", reason: "refused" }, { workId: "84", reason: "refused" }] });
  let release;
  app.hold = new Promise((resolve) => { release = resolve; });
  // Every answer the app gives back, as it reaches the extension.
  const answered = [];
  const send = app.send;
  app.send = async (message) => {
    const answer = await send(message);
    answered.push(message.type);
    return answer;
  };
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await until(() => app.messages.some((m) => m.type === KEEP_COPY_NATIVE.part), "a part on its way", async () => {
    box.now += (await box.handoff.engine.tick()) ?? 0;
  });
  const given = app.messages.find((m) => m.type === KEEP_COPY_NATIVE.begin).transferId;
  // No progress for longer than the limit: the queue gives the transfer up.
  box.now += SETTLE_MAX_MS + 1;
  await box.handoff.engine.tick();
  assert.equal((await box.store.getMeta(TRANSFER_KEY)).state, "failed");
  assert.ok(app.aborted.length >= 1);
  app.hold = null;
  const sent = app.messages.length;
  // The held part's answer reaches the extension. Files go to the app one at a time, so the next
  // work's BEGIN is the sign that the given-up transfer's sending has ended.
  release();
  await until(() => answered.includes(KEEP_COPY_NATIVE.part), "the held part's answer");
  await until(() => app.messages.some((m) => m.type === KEEP_COPY_NATIVE.begin && m.transferId !== given), "the next work's BEGIN", async () => {
    box.now += (await box.handoff.engine.tick()) ?? 0;
  });
  // Nothing more of the given-up transfer followed, and it was never written open again.
  assert.deepEqual(app.messages.slice(sent).filter((m) => m.transferId === given), []);
  assert.notEqual((await box.store.getMeta(TRANSFER_KEY)).transferId, given);
  // Both copies are made in the end: the work given up, in a transfer of its own.
  await box.drain();
  assert.deepEqual(app.messages.slice(sent).filter((m) => m.transferId === given), []);
  assert.deepEqual(app.saved.map((copy) => copy.workId).sort(), ["82", "84"]);
});

test("a repeated message for a transfer the app completed counts as saved", async () => {
  const file = epub(PART_BYTES + 3);
  const site = ao3({ [workURL("83")]: workPage("83"), [fileURL("83")]: file });
  // The app saves the file, but its answer to END is lost.
  let lost = false;
  const app = fakeApp({ works: [{ workId: "83", reason: "refused" }], drop: (message) => message.type === KEEP_COPY_NATIVE.end && !lost && (lost = true) });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(app.saved.length, 1);
  assert.equal((await box.store.getMeta(TRANSFER_KEY)).state, "saved");
  assert.equal((await box.handoff.engine.view()).withCopy, 1);
  assert.equal(app.aborted.length, 0);
});

test("a work skipped, or found unchanged, is not read again for the same copy within a day", async () => {
  // Gone from AO3: a 404.
  const site = ao3({});
  const app = fakeApp({ works: [{ workId: "84", reason: "refused" }] });
  const box = harness({ app, site });
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(site.requests.length, 1);
  box.now += 60 * 60_000;
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(site.requests.length, 1, "asked again within the day");
  box.now += WANT_MEMORY_MS;
  await box.handoff.askQueue(true);
  await box.drain();
  assert.equal(site.requests.length, 2);
});

test("only the work open in the reader's tab goes at the reader's pace; the app's other asks go slowly", async () => {
  const site = ao3({});
  const app = fakeApp({ works: [{ workId: "85", reason: "locked", pace: "reader" }, { workId: "86", reason: "refused", pace: "reader" }] });
  const box = harness({ app, site, tab: { ...TAB, workId: "86" } });
  await box.handoff.askQueue(true);
  const { queue } = await box.store.read("");
  assert.deepEqual(queue.map(({ workId, pace }) => [workId, pace]), [["85", "check"], ["86", "reader"]]);
});

test("a page and its file come from one tab: a reader who switched tabs ends the step, and no other tab is used", async () => {
  const site = ao3({ [workURL("87")]: workPage("87"), [fileURL("87")]: epub(3_000) });
  const app = fakeApp({ works: [{ workId: "87", reason: "refused" }] });
  const box = harness({ app, site });
  const fetchImpl = site.fetchImpl;
  site.fetchImpl = async (url, init) => {
    const answer = await fetchImpl(url, init);
    // The reader moves to another AO3 tab while the page is read.
    if (String(url) === workURL("87")) box.tab = { ...TAB, id: 8 };
    return answer;
  };
  await box.handoff.askQueue(true);
  await box.handoff.engine.tick();
  assert.deepEqual(site.requests, [workURL("87")]);
  assert.deepEqual(box.ran, [7]);
  assert.equal(app.messages.some((m) => m.type === KEEP_COPY_NATIVE.begin), false);
});

test("the tab's running hash matches SHA-256 at every block boundary", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  for (const size of [1, 55, 56, 63, 64, 65, 119, 120, 128, 70_001, 5 * 1_024 * 1_024 + 17]) {
    const bytes = epub(Math.max(size, 59)).subarray(0, size);
    // Sent in uneven chunks, as a network would.
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (let at = 0, step = 1; at < bytes.length; at += step, step = (step * 7) % 100_003 + 1) controller.enqueue(bytes.slice(at, at + step));
        controller.close();
      },
    }), { status: 200 });
    const answer = await keepCopyFetchInTab(fileURL("88"), "file", 5_000, 50 * 1_024 * 1_024, `keep-copy:7:${size}`);
    assert.equal(answer.sha256, sha(bytes), `size ${size}`);
    assert.equal(answer.size, size);
    const back = Buffer.from(await keepCopyPartInTab(`keep-copy:7:${size}`, 0, PART_BYTES), "base64");
    assert.equal(back.equals(Buffer.from(bytes.subarray(0, PART_BYTES))), true);
    assert.equal(keepCopyReleaseInTab(`keep-copy:7:${size}`), true);
  }
});
