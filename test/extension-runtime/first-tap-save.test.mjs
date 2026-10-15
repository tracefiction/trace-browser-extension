import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { StoryCommandService } from "../../.trace-build/extension-core/story-command.mjs";
import {
  FIRST_TAP_RECORD_LIMIT,
  FIRST_TAP_RECORD_TTL_MS,
  FIRST_TAP_RESULT_FRESH_MS,
  FIRST_TAP_UNPLACED_DOUBT_TTL_MS,
  FirstTapSave,
  storySaveModeAtAdmission,
} from "../../.trace-build/extension-runtime/first-tap-save.mjs";
import { readStoryMembership } from "../../.trace-build/extension-runtime/story-membership.mjs";

// These tests run the first-tap save over the real guarded save. Only the
// network, the page and storage are stood in for.

const ENTRY_ID = "00000000-0000-4000-8000-000000000123";
const ENTRY = Object.freeze({
  status: "READING",
  readerStatus: "READING",
  canonicalReaderStatus: "READING",
  chapters: Object.freeze({ current: 3, total: 40 }),
  entryId: ENTRY_ID,
});
const urlOf = (workKey) => `https://archiveofourown.org/works/${workKey.slice(4)}/chapters/9`;
const A = "ao3:123";
const B = "ao3:456";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function turns() {
  for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * One install: a Library on the server, storage, the open tabs, and the
 * account. `worker()` starts a background over it, as Safari does each time
 * it wakes the extension; everything held only in memory starts empty.
 */
function install(options = {}) {
  // Each account has its own Library on the server. `library` is the first
  // account's, the one most tests are about.
  const library = new Map(options.library ?? []);
  const libraries = new Map([["account-a", library]]);
  const libraryNow = () => {
    const accountId = world.scope?.accountId ?? "account-a";
    if (!libraries.has(accountId)) libraries.set(accountId, new Map());
    return libraries.get(accountId);
  };
  const net = { lookups: 0, writes: 0, memberships: 0, lookup: null, track: null, membership: null };
  const world = {
    library, libraries, net,
    scope: { accountId: "account-a", epoch: 1 },
    grant: false,
    account: null,
    automaticSaving: "on",
    tabs: new Map([[7, { id: 7, url: urlOf(A), active: true, incognito: false }]]),
    page: { injects: true, collected: null, private: undefined, story: null, names: null },
    storage: { value: undefined, readable: true, writes: 0 },
    now: 1_800_000_000_000,
    calls: { inject: [], collect: [], mark: [], receipts: [] },
  };
  const binding = () => world.scope === null ? null : `${world.scope.epoch}.${world.scope.accountId}`;
  const confirmationFor = (workKey) => ({
    workKey, entryId: ENTRY_ID, entry: libraryNow().get(workKey), syncVersion: "2026-10-12T12:00:00.000Z",
  });
  world.binding = binding;
  world.worker = () => {
    const session = {
      publicationScope: () => world.scope,
      async executeAuthenticated(effect) {
        if (world.scope === null) return { kind: "unavailable" };
        const starting = world.scope;
        const result = await effect("private-token");
        if (world.scope === null || world.scope.accountId !== starting.accountId || world.scope.epoch !== starting.epoch) {
          return { kind: "stale" };
        }
        if (result.kind === "success") return { kind: "published", value: result.value };
        if (result.kind === "auth_rejected") return { kind: "auth_rejected", recovery: "reconnect_required" };
        return { kind: "unavailable" };
      },
    };
    const service = new StoryCommandService({
      session,
      api: {
        async lookup(_credential, workKey) {
          net.lookups += 1;
          const scripted = net.lookup ? await net.lookup(workKey) : null;
          if (scripted) return scripted;
          return {
            kind: "success",
            value: libraryNow().has(workKey) ? { kind: "found", confirmation: confirmationFor(workKey) } : { kind: "absent" },
          };
        },
        async track(_credential, command) {
          net.writes += 1;
          // A write lands in the Library of the account that sent it.
          const mine = libraryNow();
          const scripted = net.track ? await net.track(command) : null;
          if (scripted) return scripted;
          mine.set(command.workKey, ENTRY);
          return { kind: "success", value: { kind: "confirmed", confirmation: confirmationFor(command.workKey) } };
        },
      },
      projection: { async publishConfirmed() { return { kind: "published" }; } },
      receipt: { async publishSaveReceipt(receipt) { world.calls.receipts.push(receipt); return true; } },
      handoff: { async clearExpected() { return true; } },
      clock: { now: () => world.now },
    });
    const firstTap = new FirstTapSave({
      saveOnOpen: options.saveOnOpen ?? true,
      async grantComplete() { return world.grant; },
      async account() { return world.account ?? { state: "verified", binding: binding(), owner: world.scope.accountId }; },
      binding,
      async automaticSaving() { return world.automaticSaving; },
      async inject(tabId) { world.calls.inject.push(tabId); return world.page.injects; },
      async collect(tabId) {
        world.calls.collect.push(tabId);
        if (world.page.collected !== null) return world.page.collected;
        // The page answers for the story it is on, which the reader may have
        // changed since the popup read the tab.
        const story = world.page.story ?? new URL(world.tabs.get(tabId).url).pathname.split("/")[2];
        return {
          ok: true, workKey: world.page.names ?? `ao3:${story}`, title: "The Long Way", author: "someone",
          ...(world.page.private === undefined ? {} : { private: world.page.private }),
          payload: {
            s: "ao3", at: "2026-10-12T12:00:00.000Z",
            item: { src: "ao3", ctx: "story", u: `https://archiveofourown.org/works/${story}`, t: "The Long Way" },
          },
        };
      },
      save: (command, observer) => service.executeWithEvidence(command, observer),
      presence: (workKey) => service.presence(workKey),
      // Trace's own answer about one story, for the account that asks.
      membership: (workKey) => readStoryMembership(session, {
        async read(_credential, asked) {
          net.memberships += 1;
          const scripted = net.membership ? await net.membership(asked) : null;
          if (scripted) return scripted;
          const entry = libraryNow().get(asked);
          return {
            kind: "success",
            value: entry === undefined
              ? { kind: "absent" }
              : { kind: "present", entry: { status: entry.status, readerStatus: entry.readerStatus, canonicalReaderStatus: entry.canonicalReaderStatus } },
          };
        },
      }, workKey),
      async mark(tabId, workKey) { world.calls.mark.push({ tabId, workKey }); },
      async readStore() {
        if (!world.storage.readable) throw new Error("storage unavailable");
        return world.storage.value;
      },
      async writeStore(value) {
        if (!world.storage.readable) throw new Error("storage unavailable");
        world.storage.writes += 1;
        world.storage.value = JSON.parse(JSON.stringify(value));
      },
      async digest(text) { return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32); },
      randomSalt: () => crypto.randomBytes(16).toString("hex"),
      now: () => world.now,
    });
    const popup = (tabId = 7) => {
      const views = [];
      const listener = (view) => views.push(view);
      return {
        views, listener, tabId,
        get last() { return views.at(-1); },
        open: async (opts) => { const view = await firstTap.opened(listener, world.tapped(tabId), opts); views.push(view); return view; },
        check: async () => { const view = await firstTap.check(listener); views.push(view); return view; },
        close: () => firstTap.closed(listener),
      };
    };
    return { firstTap, service, popup };
  };
  /** What the popup read, in the reader's tap, of the tab it was opened on. */
  world.tapped = (tabId) => {
    const tab = world.tabs.get(tabId);
    return { tabId, url: tab?.url, private: typeof tab?.incognito === "boolean" ? tab.incognito : null };
  };
  /** Points tab 7 at another story, as the reader moving on. */
  world.goTo = (workKey) => world.tabs.set(7, { ...world.tabs.get(7), url: urlOf(workKey) });
  return world;
}

/** A write that reaches Trace but whose answer never arrives. */
const landsUnanswered = (world) => {
  world.net.track = (command) => {
    world.library.set(command.workKey, ENTRY);
    return new Promise(() => {});
  };
};

// --- What a tap does ----------------------------------------------------------

test("opening Trace on a story saves it once, through the guarded save, before any lasting access", async () => {
  const world = install();
  const popup = world.worker().popup();
  assert.deepEqual(await popup.open(), { state: "saving", workKey: A, startedAt: world.now, story: null });
  await turns();

  assert.deepEqual(world.calls.inject, [7]);
  assert.deepEqual(world.calls.collect, [7]);
  assert.equal(world.net.lookups, 1, "it looks first");
  assert.equal(world.net.writes, 1, "and writes once");
  assert.deepEqual(popup.last, {
    state: "confirmed", workKey: A, provenance: "saved_now", mode: "bounded_manual",
    story: { title: "The Long Way", author: "someone", site: "AO3" },
    entry: { status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", chapters: { current: 3, total: 40 } },
  });
  assert.equal(world.calls.receipts[0].mode, "bounded_manual");
});

test("nothing is injected or saved off a story page, for a tab the popup could not read, or once the sites are allowed", async () => {
  for (const [change, expected] of [
    [(world) => world.tabs.set(7, { id: 7, url: "https://archiveofourown.org/works", incognito: false }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 7, url: "https://archiveofourown.org/users/login", incognito: false }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 7, url: "https://example.com/works/123", incognito: false }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 7, incognito: false }), "not_applicable"],
    [(world) => world.tabs.delete(7), "not_applicable"],
    [(world) => { world.grant = true; }, "automatic"],
  ]) {
    const world = install();
    change(world);
    assert.deepEqual(await world.worker().popup().open(), { state: expected });
    await turns();
    assert.deepEqual(world.calls.inject, []);
    assert.equal(world.net.writes, 0);
  }
});

test("the account is read afresh on every open, and one that cannot be read is never shown as signed out", async () => {
  for (const [state, expected] of [
    ["missing", "account_missing"],
    ["reconnect_required", "account_reconnect_required"],
    ["unknown", "account_unknown"],
  ]) {
    const world = install();
    world.account = { state };
    const popup = world.worker().popup();
    assert.deepEqual(await popup.open(), { state: expected, workKey: A });
    await turns();
    assert.deepEqual(world.calls.inject, [], "nothing is injected without a verified account");
    assert.equal(world.net.writes, 0);
    assert.equal(world.storage.writes, 0, "and nothing is recorded");

    world.account = null;
    assert.equal((await popup.open()).state, "saving");
  }
});

test("with automatic saving off, or unreadable, opening Trace saves nothing until the reader asks", async () => {
  for (const preference of ["off", "unknown"]) {
    const world = install();
    world.automaticSaving = preference;
    const popup = world.worker().popup();
    assert.deepEqual(await popup.open(), { state: "awaiting_request", workKey: A, preference, story: STORY });
    await turns();
    assert.equal(world.net.writes, 0);

    assert.equal((await popup.open({ requested: true })).state, "saving");
    await turns();
    assert.equal(world.net.writes, 1);
    assert.equal(popup.last.state, "confirmed");
  }
});

const STORY = Object.freeze({ title: "The Long Way", author: "someone", site: "AO3" });

test("a build that saves only on the reader's tap offers the save on opening, and saves only when asked", async () => {
  const world = install({ saveOnOpen: false });
  const popup = world.worker().popup();
  const offer = { state: "awaiting_request", workKey: A, preference: "on", story: STORY };
  assert.deepEqual(await popup.open(), offer, "the offer names the story, as its page says");
  assert.deepEqual(await popup.open(), offer, "however often it is opened");
  await turns();
  assert.deepEqual(world.calls.collect, [7, 7], "the page is read for the sheet");
  assert.equal(world.net.writes, 0, "and nothing is written");
  assert.equal(world.net.lookups, 2, "Trace is only asked, read only, whether the story is there");
  assert.equal(world.storage.writes, 0, "and nothing is kept");

  // The reader's "Save this story": the same guarded save as a first tap.
  assert.equal((await popup.open({ requested: true })).state, "saving");
  await turns();
  assert.equal(world.net.writes, 1);
  assert.equal(popup.last.state, "confirmed");
  assert.equal(popup.last.mode, "bounded_manual");

  // With automatic saving off it is offered the same way, under that name,
  // and Trace is not asked about the story.
  const off = install({ saveOnOpen: false });
  off.automaticSaving = "off";
  assert.deepEqual(await off.worker().popup().open(), { state: "awaiting_request", workKey: A, preference: "off", story: STORY });
  await turns();
  assert.equal(off.net.writes + off.net.lookups, 0);
});

test("a build that saves only on the tap names the story only from its own page, and offers the save when it cannot", async () => {
  for (const [change, why] of [
    [(world) => { world.page.injects = false; }, "the page could not be reached"],
    [(world) => { world.page.collected = { ok: false, error: "story_unavailable" }; }, "the page could not read its story"],
    [(world) => { world.page.names = B; }, "the page names another story"],
  ]) {
    const world = install({ saveOnOpen: false });
    change(world);
    assert.deepEqual(
      await world.worker().popup().open(),
      { state: "awaiting_request", workKey: A, preference: "on", story: null },
      why,
    );
    assert.equal(world.net.writes, 0);
  }
});

test("a build that saves only on the tap shows a story already in the Library as there, never the offer to save it", async () => {
  const world = install({ saveOnOpen: false, library: [[A, ENTRY]] });
  const worker = world.worker();
  const popup = worker.popup();
  assert.deepEqual(await popup.open(), {
    state: "confirmed", workKey: A, provenance: "already", mode: null, story: STORY,
    entry: { status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", chapters: { current: 3, total: 40 } },
  });
  assert.equal(world.net.writes, 0, "found by a read, not a save");
  popup.close();
  await turns();
  assert.deepEqual(world.calls.mark, [{ tabId: 7, workKey: A }], "the page shows its mark once the sheet closes");

  // Saved by the reader's tap, then opened again long after: still there.
  const saved = install({ saveOnOpen: false });
  const again = saved.worker();
  assert.equal((await again.popup().open({ requested: true })).state, "saving");
  await turns();
  assert.equal(saved.net.writes, 1);
  saved.now += FIRST_TAP_RESULT_FRESH_MS + 1;
  const later = await saved.worker().popup().open();
  assert.equal(later.state, "confirmed");
  assert.equal(later.provenance, "already");
  assert.equal(saved.net.writes, 1, "opening again saves nothing");
});

// --- Saved, already there, or found --------------------------------------------

test("a story that was in the Library before this reader ever tapped is already there; one this tap wrote is saved", async () => {
  const there = install({ library: [[A, ENTRY]] });
  const popup = there.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.provenance, "already");
  assert.equal(there.net.writes, 0, "nothing is written for a story found first");

  const fresh = install();
  const saved = fresh.worker().popup();
  await saved.open();
  await turns();
  assert.equal(saved.last.provenance, "saved_now");
});

test("a write that landed with no answer, then found by the save's own second look, is found", async () => {
  const world = install();
  world.net.track = (command) => {
    world.library.set(command.workKey, ENTRY);
    return { kind: "success", value: { kind: "uncertain" } };
  };
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.provenance, "found");
  assert.equal(world.net.writes, 1);
});

test("a tap whose save was cut off is never later called already there, whatever happened in between", async () => {
  for (const between of ["another story", "eleven minutes", "two days"]) {
    const world = install();
    landsUnanswered(world);
    await world.worker().popup().open();
    await turns();
    assert.equal(world.net.writes, 1, "the write went out; its answer never came");

    // Safari puts the background to sleep. A new one starts with no memory.
    world.net.track = null;
    const second = world.worker();
    if (between === "another story") {
      world.goTo(B);
      const other = second.popup();
      await other.open();
      await turns();
      assert.equal(other.last.provenance, "saved_now");
      other.close();
      world.goTo(A);
    } else {
      world.now += between === "eleven minutes" ? FIRST_TAP_RESULT_FRESH_MS + 60_000 : 2 * FIRST_TAP_RECORD_TTL_MS;
    }
    const again = second.popup();
    await again.open();
    await turns();
    assert.equal(again.last.state, "confirmed", between);
    assert.equal(again.last.provenance, "found", `${between}: this reader's own tap may have added it`);
    assert.equal(world.net.writes, between === "another story" ? 2 : 1, "and the story is not written again");
  }
});

test("when a record still in doubt had to be dropped, a story found with no record is found, not already", async () => {
  const world = install({ library: [["ao3:999", ENTRY]] });
  // More cut-off saves, none landing, than the store keeps.
  world.net.track = () => new Promise(() => {});
  for (let story = 1; story <= FIRST_TAP_RECORD_LIMIT + 1; story += 1) {
    world.goTo(`ao3:${1000 + story}`);
    await world.worker().popup().open();
    await turns();
  }
  assert.equal(world.storage.value.records.length, FIRST_TAP_RECORD_LIMIT);
  assert.equal(world.storage.value.forgot.length, 1);

  world.net.track = null;
  world.goTo("ao3:999");
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.provenance, "found");
});

test("a write in doubt, then a new session for the same reader: the same story found is found, never already there", async () => {
  // Same background, and a background that started after the sign-in.
  for (const restart of [false, true]) {
    const world = install({ library: [[B, ENTRY]] });
    // The write reaches Trace. Its answer comes too late, or never.
    const late = deferred();
    world.net.track = (command) => {
      world.library.set(command.workKey, ENTRY);
      return late.promise;
    };
    const first = world.worker();
    await first.popup().open();
    await turns();
    assert.equal(world.net.writes, 1, "the write went out");

    // The reader signs out and in again. Trace sees a new session, and cannot
    // know it is the same reader.
    world.net.track = null;
    world.scope = { accountId: "account-a", epoch: 2 };
    if (!restart) {
      late.resolve({ kind: "success", value: { kind: "uncertain" } });
      await turns();
    }
    const worker = restart ? world.worker() : first;
    const again = worker.popup();
    await again.open();
    await turns();
    assert.equal(again.last.state, "confirmed");
    assert.equal(again.last.provenance, "found", "the earlier session's write may be what added it");
    assert.equal(world.net.writes, 1, "and it is not written again");
    again.close();

    const kept = JSON.stringify(world.storage.value);
    for (const readable of ["ao3", "works", "archiveofourown", "account-a"]) {
      assert.equal(kept.includes(readable), false, `${readable} is not kept`);
    }
    assert.equal(world.storage.value.records.every(({ s }) => s === world.storage.value.records[0].s), true,
      "the ended session's records are gone");

    // The doubt was about that one story. Another, in the Library all along,
    // is still already there.
    world.goTo(B);
    const other = worker.popup();
    await other.open();
    await turns();
    assert.equal(other.last.provenance, "already");
    other.close();

    // Once Trace has itself confirmed the story for this session, the doubt
    // has no more to say.
    assert.deepEqual(world.storage.value.doubts, []);
    world.goTo(A);
    world.now += FIRST_TAP_RESULT_FRESH_MS + 60_000;
    const later = world.worker().popup();
    await later.open();
    await turns();
    assert.equal(later.last.provenance, "already");
  }
});

test("a doubt that cannot be placed on a story after a session change is carried as one about every story", async () => {
  const world = install({ library: [[B, ENTRY]] });
  // More cut-off saves than the store keeps, so one is dropped in doubt.
  world.net.track = () => new Promise(() => {});
  for (let story = 1; story <= FIRST_TAP_RECORD_LIMIT + 1; story += 1) {
    world.goTo(`ao3:${1000 + story}`);
    await world.worker().popup().open();
    await turns();
  }
  assert.equal(world.storage.value.forgot.length, 1);
  const forgotten = world.storage.value.forgot[0];

  world.net.track = null;
  world.scope = { accountId: "account-a", epoch: 2 };
  world.goTo(B);
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.provenance, "found");
  assert.equal(world.storage.value.forgot.includes(forgotten), false, "the ended session is not named");
  assert.equal(world.storage.value.unplacedAt, world.now, "only that a doubt was lost, and when");
  assert.equal(world.storage.value.doubts.length <= FIRST_TAP_RECORD_LIMIT, true);
});

test("a write in doubt from a private tab, then a new background: the same story in an ordinary tab is found, never already there", async () => {
  const world = install();
  world.tabs.set(7, { id: 7, url: urlOf(A), incognito: true });
  landsUnanswered(world);
  await world.worker().popup().open();
  await turns();
  assert.equal(world.net.writes, 1, "the write went out; its answer never came");
  assert.deepEqual(world.storage.value.records, [], "no record is kept for the private tab");
  assert.deepEqual(world.storage.value.doubts, [], "nor its story's digest");
  assert.equal(world.storage.value.unkept, 1, "only that a write is out, for no story and no account");
  assert.equal(world.storage.value.unkeptAt, world.now, "and when");
  assert.deepEqual(
    Object.keys(world.storage.value).sort(),
    ["doubts", "forgot", "records", "salt", "unkept", "unkeptAt", "unplacedAt"],
  );

  // Safari puts the background to sleep. The reader opens the same story in
  // an ordinary tab.
  world.net.track = null;
  world.tabs.set(7, { id: 7, url: urlOf(A), incognito: false });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.state, "confirmed");
  assert.equal(popup.last.provenance, "found", "the private tab's write may be what added it");
  assert.equal(world.net.writes, 1);
});

test("a doubt that can no longer be placed holds for thirty days from the write, and no longer", async () => {
  const DAY = 24 * 60 * 60 * 1_000;
  assert.equal(FIRST_TAP_UNPLACED_DOUBT_TTL_MS, 30 * DAY);
  for (const [later, expected] of [
    [DAY, "found"],
    [30 * DAY - 1, "found"],
    [30 * DAY, "already"],
    [400 * DAY, "already"],
    // A clock set back does not end it early.
    [-5 * DAY, "found"],
  ]) {
    // A save cut off in a private tab, and its background gone: nothing says
    // which story or account it was for.
    const world = install({ library: [[B, ENTRY]] });
    world.tabs.set(7, { id: 7, url: urlOf(A), incognito: true });
    world.net.track = () => new Promise(() => {});
    await world.worker().popup().open();
    await turns();
    assert.equal(world.storage.value.unkept, 1);

    // Another story, in the Library all along, in an ordinary tab.
    world.net.track = null;
    world.now += later;
    world.tabs.set(7, { id: 7, url: urlOf(B), incognito: false });
    const popup = world.worker().popup();
    await popup.open();
    await turns();
    assert.equal(popup.last.provenance, expected, `${later / DAY} days on`);
    assert.equal(world.storage.value.unkept, 0, "the count itself is settled by the background that found it");
  }

  // The thirty days run from the write, not from when a background noticed.
  const world = install({ library: [[B, ENTRY]] });
  world.tabs.set(7, { id: 7, url: urlOf(A), incognito: true });
  world.net.track = () => new Promise(() => {});
  await world.worker().popup().open();
  await turns();
  world.net.track = null;
  world.tabs.set(7, { id: 7, url: urlOf(B), incognito: false });
  world.now += 20 * DAY;
  const noticed = world.worker().popup();
  await noticed.open();
  await turns();
  assert.equal(noticed.last.provenance, "found");
  world.goTo("ao3:777");
  world.library.set("ao3:777", ENTRY);
  world.now += 11 * DAY;
  const after = world.worker().popup();
  await after.open();
  await turns();
  assert.equal(after.last.provenance, "already", "thirty-one days after the write");
});

test("another account's save of the same story neither raises nor clears a doubt", async () => {
  // Reader A's write for the story reaches Trace; its answer never comes.
  const world = install();
  landsUnanswered(world);
  await world.worker().popup().open();
  await turns();
  assert.equal(world.library.has(A), true);

  // Reader B signs in on the same phone and saves the same story. It was not
  // in B's Library, and nothing about A's write concerns B.
  world.net.track = null;
  world.scope = { accountId: "account-b", epoch: 2 };
  const b = world.worker().popup();
  await b.open();
  await turns();
  assert.equal(b.last.provenance, "saved_now");
  b.close();
  world.now += FIRST_TAP_RESULT_FRESH_MS + 60_000;
  const bAgain = world.worker().popup();
  await bAgain.open();
  await turns();
  assert.equal(bAgain.last.provenance, "already", "B's own Library is known: A's doubt is not B's");
  bAgain.close();

  // A signs back in. B's confirmed save said nothing about A's write.
  world.scope = { accountId: "account-a", epoch: 3 };
  const a = world.worker().popup();
  await a.open();
  await turns();
  assert.equal(a.last.state, "confirmed");
  assert.equal(a.last.provenance, "found", "A's own cut-off write may be what added it");
  assert.equal(world.net.writes, 2, "one write each, and none now");
  a.close();

  // Trace has now confirmed it for A, and only that clears A's doubt.
  world.now += FIRST_TAP_RESULT_FRESH_MS + 60_000;
  const aLater = world.worker().popup();
  await aLater.open();
  await turns();
  assert.equal(aLater.last.provenance, "already");
  const kept = JSON.stringify(world.storage.value);
  for (const readable of ["account-a", "account-b", "ao3", "works"]) {
    assert.equal(kept.includes(readable), false, `${readable} is not kept`);
  }
});

test("a private tab's write that is answered leaves nothing behind", async () => {
  const world = install({ library: [[B, ENTRY]] });
  world.tabs.set(7, { id: 7, url: urlOf(A), incognito: true });
  const held = deferred();
  world.net.track = async () => { await held.promise; return null; };
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(world.storage.value.unkept, 1, "counted while it is out");
  held.resolve();
  await turns();
  assert.equal(popup.last.provenance, "saved_now");
  assert.equal(world.storage.value.unkept, 0, "and no longer once it is answered");
  assert.deepEqual(world.storage.value.records, []);

  world.net.track = null;
  world.tabs.set(7, { id: 7, url: urlOf(B), incognito: false });
  const other = world.worker().popup();
  await other.open();
  await turns();
  assert.equal(other.last.provenance, "already", "so what came before is still known");
});

test("a tab the browser did not call ordinary is treated as private; so is one the page itself says is private", async () => {
  for (const arrange of [
    (world) => world.tabs.set(7, { id: 7, url: urlOf(A) }),
    (world) => { world.page.private = true; },
  ]) {
    const world = install({ library: [[A, ENTRY]] });
    arrange(world);
    const popup = world.worker().popup();
    await popup.open();
    await turns();
    assert.equal(popup.last.provenance, "found", "never already there");
    assert.deepEqual(world.storage.value?.records ?? [], [], "and nothing about the story is kept");
  }
});

test("the page reached must name the story the popup named, or nothing is sent", async () => {
  for (const arrange of [
    // The tab moved on to another story between the popup's read and the page's answer.
    (world) => { world.page.story = "456"; },
    // The page names another story than the one it hands over.
    (world) => { world.page.names = B; },
    (world) => { world.page.names = undefined; world.page.collected = { ok: true, title: "The Long Way", payload: {} }; },
  ]) {
    const world = install();
    arrange(world);
    const popup = world.worker().popup();
    await popup.open();
    await turns();
    assert.equal(popup.last.state, "failed");
    assert.equal(popup.last.dispatch, "never_sent");
    assert.equal(world.net.lookups, 0);
    assert.equal(world.net.writes, 0);
  }
});

test("with storage unreadable nothing earlier is known, so a story found is found", async () => {
  const world = install({ library: [[A, ENTRY]] });
  world.storage.readable = false;
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.provenance, "found");
});

// --- One record: later answers only improve it ---------------------------------

test("a slow save and Check again agree: found stays found, improves to saved, and is never taken back", async () => {
  for (const ending of ["confirmed", "unanswered", "lookup lost"]) {
    const world = install();
    const answer = deferred();
    world.net.track = async (command) => {
      world.library.set(command.workKey, ENTRY);
      return answer.promise;
    };
    const popup = world.worker().popup();
    await popup.open();
    await turns();
    assert.equal(popup.last.state, "saving");

    const checked = await popup.check();
    assert.equal(checked.state, "confirmed");
    assert.equal(checked.provenance, "found");

    if (ending === "lookup lost") world.net.lookup = () => ({ kind: "success", value: { kind: "unavailable" } });
    answer.resolve(ending === "confirmed"
      ? { kind: "success", value: { kind: "confirmed", confirmation: { workKey: A, entryId: ENTRY_ID, entry: ENTRY, syncVersion: "2026-10-12T12:00:00.000Z" } } }
      : { kind: "success", value: { kind: "uncertain" } });
    await turns();

    assert.equal(popup.last.state, "confirmed", `${ending}: the popup never falls back from found`);
    assert.equal(popup.last.provenance, ending === "confirmed" ? "saved_now" : "found");
    assert.equal(popup.views.some((view) => view.state.startsWith("account_")), false);
    assert.equal(world.net.writes, 1);
    popup.close();
    await turns();
    assert.deepEqual(world.calls.mark, [{ tabId: 7, workKey: A }], "and the page gets its mark from the same record");
  }
});

test("a page's own save admitted while the first tap's is out changes nothing shown, and the story is found", async () => {
  for (const firstTapEnds of ["finds it", "fails"]) {
    const world = install();
    const gate = deferred();
    let first = true;
    world.net.lookup = async () => {
      if (!first) return null;
      first = false;
      await gate.promise;
      return firstTapEnds === "fails" ? { kind: "success", value: { kind: "unavailable" } } : null;
    };
    const worker = world.worker();
    const popup = worker.popup();
    await popup.open();
    await turns();

    // The page's own save lands while the first tap's is still looking.
    worker.firstTap.pageSaveAdmitted(A);
    world.library.set(A, ENTRY);
    assert.equal(popup.last.state, "saving", "nothing flips when the page's save is admitted");
    gate.resolve();
    await turns();

    assert.equal(popup.last.state, "confirmed", firstTapEnds);
    assert.equal(popup.last.provenance, "found", "another save was admitted: not called already there");
    assert.equal(world.net.writes, 0);
    popup.close();
    await turns();
    assert.deepEqual(world.calls.mark, [{ tabId: 7, workKey: A }]);
  }
});

test("a page's own save clears a first tap's failure; a confirmed result is left alone", async () => {
  const world = install();
  world.net.lookup = () => ({ kind: "success", value: { kind: "unavailable" } });
  const worker = world.worker();
  const popup = worker.popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.state, "failed");
  assert.equal(popup.last.dispatch, "never_sent");

  worker.firstTap.pageSaveAdmitted(B);
  assert.equal((await popup.open()).state, "failed", "another story's save changes nothing");

  world.net.lookup = null;
  world.library.set(A, ENTRY);
  worker.firstTap.pageSaveAdmitted(A);
  const after = await popup.open();
  assert.equal(after.state, "confirmed", "the popup looks instead of repeating never sent");
  assert.equal(after.provenance, "found");
  assert.equal(world.net.writes, 0);

  worker.firstTap.pageSaveAdmitted(A);
  assert.equal((await popup.open()).provenance, "found");
});

test("an account that changes during the save gets its own state, and nothing of the old account's is kept or shown", async () => {
  for (const when of ["while the page is read", "while the write is out"]) {
    const world = install();
    const gate = deferred();
    if (when === "while the page is read") world.page.collected = gate.promise;
    else world.net.track = async () => { await gate.promise; return null; };
    const popup = world.worker().popup();
    await popup.open();
    await turns();

    world.scope = { accountId: "account-b", epoch: 2 };
    gate.resolve(when === "while the page is read"
      ? { ok: true, payload: { s: "ao3", at: "2026-10-12T12:00:00.000Z", item: { src: "ao3", ctx: "story", u: "https://archiveofourown.org/works/123" } } }
      : undefined);
    await turns();

    assert.deepEqual(popup.last, { state: "account_changed", workKey: A }, when);
    assert.equal(world.net.writes, when === "while the write is out" ? 1 : 0);
    popup.close();
    await turns();
    assert.deepEqual(world.calls.mark, [], "the page shows nothing for another account's result");
    assert.deepEqual(world.storage.value?.records ?? [], [], "and nothing of it is kept");

    // The new account's own open is a new record with its own answer.
    world.library.delete(A);
    world.net.track = null;
    world.page.collected = null;
    const next = world.worker().popup();
    await next.open();
    await turns();
    assert.equal(next.last.provenance, "saved_now");
  }
});

test("one account's records are discarded as soon as another account opens Trace", async () => {
  const world = install();
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  popup.close();
  assert.equal(world.storage.value.records.length, 1);
  const before = world.storage.value.records[0];

  world.scope = { accountId: "account-b", epoch: 2 };
  world.goTo(B);
  const other = world.worker().popup();
  await other.open();
  await turns();
  assert.equal(world.storage.value.records.length, 1);
  assert.notEqual(world.storage.value.records[0].s, before.s);
  assert.notEqual(world.storage.value.records[0].k, before.k);
});

// --- Never sent, refused, or sent and unconfirmed -----------------------------

test("a failure is never sent only when nothing was handed to the network", async () => {
  for (const [name, arrange, reason, dispatch, writes] of [
    ["the page could not be reached", (world) => { world.page.injects = false; }, "page_unreachable", "never_sent", 0],
    ["the page gave nothing", (world) => { world.page.collected = "nothing"; }, "page_unreachable", "never_sent", 0],
    ["no readable story", (world) => { world.page.collected = { ok: false, error: "story_unavailable" }; }, "story_unavailable", "never_sent", 0],
    ["the page named another story", (world) => {
      world.page.collected = { ok: true, payload: { s: "ao3", at: "2026-10-12T12:00:00.000Z", item: { src: "ao3", ctx: "story", u: "https://archiveofourown.org/works/999" } } };
    }, "page_unreachable", "never_sent", 0],
    ["the Library could not be read first", (world) => { world.net.lookup = () => ({ kind: "success", value: { kind: "unavailable" } }); }, "unavailable", "never_sent", 0],
    ["Trace declined it", (world) => { world.net.track = () => ({ kind: "success", value: { kind: "rejected", reason: "free_limit_reached" } }); }, "free_limit_reached", "refused", 1],
    ["no answer and not found after", (world) => { world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } }); }, "unavailable", "sent_unconfirmed", 1],
  ]) {
    const world = install();
    arrange(world);
    const popup = world.worker().popup();
    await popup.open();
    await turns();
    assert.equal(popup.last.state, "failed", name);
    assert.equal(popup.last.reason, reason, name);
    assert.equal(popup.last.dispatch, dispatch, name);
    assert.equal(world.net.writes, writes, name);
    popup.close();
    await turns();
    assert.deepEqual(world.calls.mark, [], "the page shows no mark for a save that is not confirmed");
  }
});

// --- Reopening -----------------------------------------------------------------

test("the page is asked for its mark only for a confirmed save, once, and only when no popup is over it", async () => {
  const world = install();
  const worker = world.worker();
  const popup = worker.popup();
  await popup.open();
  await turns();
  assert.deepEqual(world.calls.mark, [], "not while the popup is open");

  popup.close();
  await turns();
  assert.deepEqual(world.calls.mark, [{ tabId: 7, workKey: A }]);

  const again = worker.popup();
  assert.equal((await again.open()).provenance, "saved_now", "a popup reopened soon after gets the same result");
  again.close();
  await turns();
  assert.equal(world.calls.mark.length, 1);
  assert.equal(world.net.writes, 1);
});

test("a popup closed while the save is out can be reopened onto the same save, and the mark follows when it lands", async () => {
  const world = install();
  const answer = deferred();
  world.net.track = async () => { await answer.promise; return null; };
  const worker = world.worker();
  const popup = worker.popup();
  await popup.open();
  await turns();
  popup.close();

  const reopened = worker.popup();
  assert.equal((await reopened.open()).state, "saving", "the same save, not a second one");
  reopened.close();
  answer.resolve();
  await turns();
  assert.equal(world.net.writes, 1);
  assert.deepEqual(world.calls.mark, [{ tabId: 7, workKey: A }]);
});

test("a result is shown again after the background slept, then a later tap is a new one", async () => {
  const world = install();
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  popup.close();

  const woken = world.worker().popup();
  const view = await woken.open();
  assert.equal(view.state, "confirmed");
  assert.equal(view.provenance, "saved_now");
  assert.equal(world.net.writes, 1, "no second save");

  world.now += FIRST_TAP_RESULT_FRESH_MS + 1;
  const later = world.worker().popup();
  await later.open();
  await turns();
  assert.equal(later.last.provenance, "already", "the earlier save was confirmed, so the story really was there before this tap");
  assert.equal(world.net.writes, 1);
});

// --- The background asleep mid-save, with automatic saving off -----------------

test("after a save cut off mid-write, a reopened popup looks first and never offers to save a story that may be saved", async () => {
  for (const landed of [true, false]) {
    const world = install();
    world.automaticSaving = "off";
    world.net.track = (command) => {
      if (landed) world.library.set(command.workKey, ENTRY);
      return new Promise(() => {});
    };
    const first = world.worker().popup();
    await first.open({ requested: true });
    await turns();
    assert.equal(world.net.writes, 1);
    assert.equal(world.storage.value.records[0].inDoubt, true, "written down before the write went out");

    world.net.track = null;
    const reopened = world.worker().popup();
    const view = await reopened.open();
    await turns();
    assert.equal(world.net.writes, 1, "no second write on reopening");
    if (landed) {
      assert.equal(view.state, "confirmed");
      assert.equal(view.provenance, "found");
    } else {
      assert.equal(view.state, "failed", "not an offer to save");
      assert.equal(view.dispatch, "sent_unconfirmed");
      // The reader may still choose to try again; that is a new save.
      await reopened.open({ requested: true });
      await turns();
      assert.equal(world.net.writes, 2);
      assert.equal(reopened.last.provenance, "saved_now");
    }
  }
});

// --- Check again ---------------------------------------------------------------

test("Check again asks Trace about this one story: in the Library, not in it, or not known, and it has no way to save", async () => {
  const world = install();
  world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.dispatch, "sent_unconfirmed");
  assert.equal(world.net.writes, 1);
  const lookups = world.net.lookups;

  // A request that could not be made, was turned away, or came back
  // unreadable says nothing about the story: never "not in your Library".
  for (const failure of [
    () => { throw new Error("offline"); },
    () => ({ kind: "success", value: { kind: "unavailable" } }),
    () => ({ kind: "success", value: { kind: "invalid_response" } }),
    () => ({ kind: "unavailable" }),
  ]) {
    world.net.membership = failure;
    assert.deepEqual(await popup.check(), { state: "presence_unknown", workKey: A });
  }
  assert.equal(world.net.memberships, 4, "one request for each time the reader asks");

  // Trace's own word that the story is not there.
  world.net.membership = null;
  assert.deepEqual(await popup.check(), {
    state: "failed", workKey: A, reason: "unavailable", dispatch: "not_in_library",
    story: { title: "The Long Way", author: "someone", site: "AO3" },
  });
  assert.equal(world.net.memberships, 5);
  assert.equal(world.storage.value.records[0].outcome.dispatch, "not_in_library");
  assert.equal(world.storage.value.records[0].inDoubt, true, "the write that went unanswered is still in doubt");
  // A popup reopened on the page is shown the same answer, and nothing is saved for it.
  assert.equal((await world.worker().popup().open()).dispatch, "not_in_library");

  world.library.set(A, ENTRY);
  const found = await popup.check();
  assert.deepEqual(found, {
    state: "confirmed", workKey: A, provenance: "found", mode: null,
    story: { title: "The Long Way", author: "someone", site: "AO3" },
    entry: { status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", chapters: null },
  }, "found now, with the entry's own status; not claimed as this tap's save");
  assert.equal(world.net.writes, 1, "no look ever sent a save");
  assert.equal(world.net.lookups, lookups, "and none read the whole Library or a kept copy of it");
  assert.deepEqual(world.calls.receipts, [], "and a look tells the app nothing");
  // A confirmation is never taken back, and is not asked about again.
  world.library.delete(A);
  assert.equal((await popup.check()).state, "confirmed");
  assert.equal(world.net.memberships, 6);
});

test("Check again while the save is still out: a story Trace does not have yet leaves the wait as it was", async () => {
  const world = install();
  const answer = deferred();
  world.net.track = () => answer.promise;
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.state, "saving");

  const checked = await popup.check();
  assert.equal(checked.state, "saving", "not in the Library yet is not the save's answer");
  assert.equal(checked.startedAt, world.now);
  assert.equal(world.net.memberships, 1);

  answer.resolve(null);
  await turns();
  assert.equal(popup.last.provenance, "saved_now");
  assert.equal(world.net.writes, 1);
});

test("after Trace said the story was not there, a save that finds it is found, never already there", async () => {
  const world = install();
  world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal((await popup.check()).dispatch, "not_in_library");

  // The unanswered write lands after all. The reader then tries again.
  world.library.set(A, ENTRY);
  world.net.track = null;
  await popup.open({ requested: true });
  await turns();
  assert.equal(popup.last.state, "confirmed");
  assert.equal(popup.last.provenance, "found");
  assert.equal(world.net.writes, 1, "the story was found before anything more was written");
});

test("a second Check again while the first is still asking joins it: one request, one answer for both", async () => {
  const world = install();
  world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } });
  const worker = world.worker();
  const popup = worker.popup();
  await popup.open();
  await turns();
  const answer = deferred();
  world.net.membership = async () => { await answer.promise; return null; };

  const first = popup.check();
  await turns();
  const second = popup.check();
  // Another popup on the same story asks too.
  const other = worker.popup();
  await other.open();
  const third = other.check();
  await turns();
  assert.equal(world.net.memberships, 1, "one request while the first is still out");

  answer.resolve();
  const answers = await Promise.all([first, second, third]);
  assert.deepEqual(answers.map((view) => view.dispatch), ["not_in_library", "not_in_library", "not_in_library"]);
  assert.equal(world.net.memberships, 1);

  // Once it has answered, the next tap is a request of its own.
  world.net.membership = null;
  await popup.check();
  assert.equal(world.net.memberships, 2);
  assert.equal(world.net.writes, 1);
});

test("Check again when Trace turns the account down says the account needs reconnecting, and keeps the doubt", async () => {
  const world = install();
  world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  world.net.membership = () => ({ kind: "auth_rejected" });
  assert.deepEqual(await popup.check(), { state: "account_reconnect_required", workKey: A });
  assert.equal(world.storage.value.records[0].inDoubt, true);
  assert.equal(world.net.writes, 1);
});

test("Check again for an account that changes while it looks says the account changed", async () => {
  const world = install();
  world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  const look = deferred();
  world.net.membership = async () => { await look.promise; return null; };
  world.library.set(A, ENTRY);
  const pending = popup.check();
  await turns();
  world.scope = { accountId: "account-b", epoch: 2 };
  look.resolve();
  assert.deepEqual(await pending, { state: "account_changed", workKey: A });
});

// --- Two opens at once ------------------------------------------------------------

test("two opens that arrive together start one save, whichever way each was asked for", async () => {
  for (const [first, second] of [[undefined, undefined], [{ requested: true }, undefined], [undefined, { requested: true }]]) {
    const world = install();
    const worker = world.worker();
    const popup = worker.popup();
    const views = await Promise.all([popup.open(first), popup.open(second)]);
    assert.deepEqual(views.map((view) => view.state), ["saving", "saving"]);
    assert.equal(views[0].startedAt, views[1].startedAt, "both are shown the one save");
    await turns();
    assert.deepEqual(world.calls.inject, [7], "the page script goes in once");
    assert.deepEqual(world.calls.collect, [7]);
    assert.equal(world.net.writes, 1, "and one write is made");
    assert.equal(world.calls.receipts.length, 1);
    assert.equal(popup.last.provenance, "saved_now");

    // A second popup on the same story, opened in the same moment, is the same.
    const other = install();
    const shared = other.worker();
    const [one, two] = [shared.popup(), shared.popup()];
    await Promise.all([one.open(first), two.open(second)]);
    await turns();
    assert.equal(other.net.writes, 1);
    assert.equal(one.last.provenance, "saved_now");
    assert.equal(two.last.provenance, "saved_now");
  }
});

test("turning automatic saving on and opening twice at once still saves once", async () => {
  const world = install();
  world.automaticSaving = "off";
  const popup = world.worker().popup();
  assert.equal((await popup.open()).state, "awaiting_request");
  assert.deepEqual(world.calls.inject, [7], "the page was read for the sheet");
  world.automaticSaving = "on";
  await Promise.all([popup.open(), popup.open()]);
  await turns();
  assert.deepEqual(world.calls.inject, [7, 7], "one attempt was started");
  assert.equal(world.net.lookups, 1);
  assert.equal(world.net.writes, 1);
  assert.equal(popup.last.provenance, "saved_now");
});

test("a save still out names its story as soon as the page has, and only for the story the popup named", async () => {
  const world = install();
  const answer = deferred();
  world.net.track = () => answer.promise;
  const popup = world.worker().popup();
  assert.equal((await popup.open()).story, null, "nothing is known of the story before the page is read");
  await turns();
  assert.deepEqual(popup.last, {
    state: "saving", workKey: A, startedAt: world.now,
    story: { title: "The Long Way", author: "someone", site: "AO3" },
  });
  answer.resolve(null);
  await turns();
  assert.equal(popup.last.provenance, "saved_now");

  // A page that names another story is not believed, and its title is not shown as this save's.
  const other = install();
  other.page.names = B;
  const mismatched = other.worker().popup();
  await mismatched.open();
  await turns();
  assert.deepEqual(mismatched.views.map((view) => view.state), ["saving", "failed"]);
});

test("Try again is a new attempt through the same guarded save; a plain reopen is not", async () => {
  const world = install();
  world.net.lookup = () => ({ kind: "success", value: { kind: "unavailable" } });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.dispatch, "never_sent");

  world.net.lookup = null;
  assert.equal((await popup.open()).state, "failed");
  await turns();
  assert.equal(world.net.writes, 0);

  assert.equal((await popup.open({ requested: true })).state, "saving");
  await turns();
  assert.equal(world.net.writes, 1);
  assert.equal(popup.last.provenance, "saved_now");
});

// --- What is kept ---------------------------------------------------------------

test("what is kept names no story: no work key, title, author or address, only digests salted for this install", async () => {
  const world = install();
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  const kept = JSON.stringify(world.storage.value);
  for (const readable of ["ao3", "works", "archiveofourown", "The Long Way", "someone", "account-a"]) {
    assert.equal(kept.includes(readable), false, `${readable} is not kept`);
  }
  assert.match(world.storage.value.salt, /^[0-9a-f]{32}$/);
  assert.match(world.storage.value.records[0].k, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(world.storage.value.records[0]).sort(), ["at", "inDoubt", "k", "outcome", "s"]);
  assert.deepEqual(world.storage.value.doubts, []);
  assert.equal(world.storage.value.unkept, 0);

  const elsewhere = install();
  const other = elsewhere.worker().popup();
  await other.open();
  await turns();
  assert.notEqual(elsewhere.storage.value.records[0].k, world.storage.value.records[0].k, "another install's digest differs");
});

test("nothing is kept for a private tab, and a story found there is never called already there", async () => {
  const world = install({ library: [[A, ENTRY]] });
  world.tabs.set(7, { id: 7, url: urlOf(A), incognito: true });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.provenance, "found");
  assert.deepEqual(world.storage.value?.records ?? [], []);

  world.tabs.set(7, { id: 7, url: urlOf(B), incognito: true });
  const saved = world.worker().popup();
  await saved.open();
  await turns();
  assert.equal(saved.last.provenance, "saved_now");
  assert.deepEqual(world.storage.value?.records ?? [], []);
  assert.deepEqual(world.storage.value?.doubts ?? [], []);
  assert.equal(world.storage.value?.unkept ?? 0, 0);
  const kept = JSON.stringify(world.storage.value ?? {});
  for (const readable of ["ao3", "works", "archiveofourown", "The Long Way", "someone", "account-a"]) {
    assert.equal(kept.includes(readable), false, `${readable} is not kept`);
  }
});

test("settled records age out; no more than the limit is kept", async () => {
  const world = install();
  for (let story = 1; story <= FIRST_TAP_RECORD_LIMIT + 3; story += 1) {
    world.goTo(`ao3:${2000 + story}`);
    const popup = world.worker().popup();
    await popup.open();
    await turns();
    world.now += 1_000;
  }
  assert.equal(world.storage.value.records.length, FIRST_TAP_RECORD_LIMIT);
  assert.deepEqual(world.storage.value.forgot, [], "settled records dropped leave nothing in doubt");

  world.now += FIRST_TAP_RECORD_TTL_MS;
  world.goTo("ao3:3000");
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(world.storage.value.records.length, 1);
});

// --- Manual or automatic, stamped at admission ---------------------------------

test("the mode is what the background established, and nothing when it could not", () => {
  const mode = (injectedForFirstTap, grantComplete, registered) =>
    storySaveModeAtAdmission({ injectedForFirstTap, grantComplete, registered });
  assert.equal(mode(true, false, null), "bounded_manual");
  assert.equal(mode(true, false, false), "bounded_manual");
  assert.equal(mode(false, true, true), "normal_automatic");
  // A page the background injected, whose save goes out after the grant, is
  // stamped by what holds when it is admitted.
  assert.equal(mode(true, true, true), "normal_automatic");
  for (const [injected, grant, registered] of [
    [false, false, false], [false, false, null], [false, null, null], [true, null, null],
    [false, true, false], [false, true, null], [true, true, false],
  ]) {
    assert.equal(mode(injected, grant, registered), null);
  }
});

test("a first tap whose grant could not be read is saved without a claimed mode", async () => {
  const world = install();
  world.grant = null;
  const worker = world.worker();
  const popup = worker.popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.mode, null);
  assert.equal(Object.hasOwn(world.calls.receipts[0], "mode"), false);
  assert.equal(worker.firstTap.injectedFor(7, A), true);
  assert.equal(worker.firstTap.injectedFor(7, B), false);
  assert.equal(worker.firstTap.injectedFor(8, A), false);
});

// --- After the grant -------------------------------------------------------------

test("the background knows which tabs it injected only while it stays awake", async () => {
  const world = install();
  const worker = world.worker();
  assert.deepEqual(worker.firstTap.injectedTabs(), []);
  const popup = worker.popup();
  await popup.open();
  await turns();
  assert.deepEqual(worker.firstTap.injectedTabs(), [7]);
  assert.deepEqual(world.worker().firstTap.injectedTabs(), [], "a new background starts with none");
});
