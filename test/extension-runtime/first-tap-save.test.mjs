import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { StoryCommandService } from "../../.trace-build/extension-core/story-command.mjs";
import {
  FIRST_TAP_RECORD_LIMIT,
  FIRST_TAP_RECORD_TTL_MS,
  FIRST_TAP_RESULT_FRESH_MS,
  FirstTapSave,
  storySaveModeAtAdmission,
} from "../../.trace-build/extension-runtime/first-tap-save.mjs";

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
  const library = new Map(options.library ?? []);
  const net = { lookups: 0, writes: 0, lookup: null, track: null };
  const world = {
    library, net,
    scope: { accountId: "account-a", epoch: 1 },
    grant: false,
    account: null,
    automaticSaving: "on",
    tabs: new Map([[7, { id: 7, url: urlOf(A), active: true, incognito: false }]]),
    page: { injects: true, collected: null },
    storage: { value: undefined, readable: true, writes: 0 },
    now: 1_800_000_000_000,
    calls: { inject: [], collect: [], mark: [], end: [], receipts: [] },
  };
  const binding = () => world.scope === null ? null : `${world.scope.epoch}.${world.scope.accountId}`;
  const confirmationFor = (workKey) => ({
    workKey, entryId: ENTRY_ID, entry: library.get(workKey), syncVersion: "2026-10-12T12:00:00.000Z",
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
            value: library.has(workKey) ? { kind: "found", confirmation: confirmationFor(workKey) } : { kind: "absent" },
          };
        },
        async track(_credential, command) {
          net.writes += 1;
          const scripted = net.track ? await net.track(command) : null;
          if (scripted) return scripted;
          library.set(command.workKey, ENTRY);
          return { kind: "success", value: { kind: "confirmed", confirmation: confirmationFor(command.workKey) } };
        },
      },
      projection: { async publishConfirmed() { return { kind: "published" }; } },
      receipt: { async publishSaveReceipt(receipt) { world.calls.receipts.push(receipt); return true; } },
      handoff: { async clearExpected() { return true; } },
      clock: { now: () => world.now },
    });
    const firstTap = new FirstTapSave({
      async tab(tabId) { return world.tabs.get(tabId) ?? null; },
      async grantComplete() { return world.grant; },
      async account() { return world.account ?? { state: "verified", binding: binding() }; },
      binding,
      async automaticSaving() { return world.automaticSaving; },
      async inject(tabId) { world.calls.inject.push(tabId); return world.page.injects; },
      async collect(tabId) {
        world.calls.collect.push(tabId);
        if (world.page.collected !== null) return world.page.collected;
        const tab = world.tabs.get(tabId);
        const story = new URL(tab.url).pathname.split("/")[2];
        return {
          ok: true, title: "The Long Way", author: "someone",
          payload: {
            s: "ao3", at: "2026-10-12T12:00:00.000Z",
            item: { src: "ao3", ctx: "story", u: `https://archiveofourown.org/works/${story}`, t: "The Long Way" },
          },
        };
      },
      save: (command, observer) => service.executeWithEvidence(command, observer),
      presence: (workKey) => service.presence(workKey),
      async mark(tabId, workKey) { world.calls.mark.push({ tabId, workKey }); },
      async endManualMode(tabId) { world.calls.end.push(tabId); },
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
        open: async (opts) => { const view = await firstTap.opened(listener, tabId, opts); views.push(view); return view; },
        check: async () => { const view = await firstTap.check(listener); views.push(view); return view; },
        close: () => firstTap.closed(listener),
      };
    };
    return { firstTap, service, popup };
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
  assert.deepEqual(await popup.open(), { state: "saving", workKey: A, startedAt: world.now });
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

test("nothing is injected or saved off a story page, on a tab that is not the one on show, or once the sites are allowed", async () => {
  for (const [change, expected] of [
    [(world) => world.tabs.set(7, { id: 7, url: "https://archiveofourown.org/works", active: true }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 7, url: "https://archiveofourown.org/users/login", active: true }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 7, url: "https://example.com/works/123", active: true }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 7, active: true }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 7, url: urlOf(A), active: false }), "not_applicable"],
    [(world) => world.tabs.set(7, { id: 8, url: urlOf(A), active: true }), "not_applicable"],
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
    assert.deepEqual(await popup.open(), { state: "awaiting_request", workKey: A, preference });
    await turns();
    assert.equal(world.net.writes, 0);

    assert.equal((await popup.open({ requested: true })).state, "saving");
    await turns();
    assert.equal(world.net.writes, 1);
    assert.equal(popup.last.state, "confirmed");
  }
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

test("Check again only looks: it finds or it does not know, and it has no way to save", async () => {
  const world = install();
  world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.dispatch, "sent_unconfirmed");
  assert.equal(world.net.writes, 1);

  assert.deepEqual(await popup.check(), { state: "presence_unknown", workKey: A });
  world.net.lookup = () => { throw new Error("offline"); };
  assert.deepEqual(await popup.check(), { state: "presence_unknown", workKey: A });

  world.net.lookup = null;
  world.library.set(A, ENTRY);
  const found = await popup.check();
  assert.equal(found.state, "confirmed");
  assert.equal(found.provenance, "found", "found now; not claimed as this tap's save");
  assert.equal(found.story.title, "The Long Way");
  assert.equal(world.net.writes, 1, "no look ever sent a save");
  assert.deepEqual(world.calls.receipts, [], "and a look tells the app nothing");
});

test("Check again for an account that changes while it looks says the account changed", async () => {
  const world = install();
  world.net.track = () => ({ kind: "success", value: { kind: "uncertain" } });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  const look = deferred();
  world.net.lookup = async () => { await look.promise; return null; };
  world.library.set(A, ENTRY);
  const pending = popup.check();
  await turns();
  world.scope = { accountId: "account-b", epoch: 2 };
  look.resolve();
  assert.deepEqual(await pending, { state: "account_changed", workKey: A });
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

  const elsewhere = install();
  const other = elsewhere.worker().popup();
  await other.open();
  await turns();
  assert.notEqual(elsewhere.storage.value.records[0].k, world.storage.value.records[0].k, "another install's digest differs");
});

test("nothing is kept for a private tab, and a story found there is never called already there", async () => {
  const world = install({ library: [[A, ENTRY]] });
  world.tabs.set(7, { id: 7, url: urlOf(A), active: true, incognito: true });
  const popup = world.worker().popup();
  await popup.open();
  await turns();
  assert.equal(popup.last.provenance, "found");
  assert.deepEqual(world.storage.value?.records ?? [], []);

  world.tabs.set(7, { id: 7, url: urlOf(B), active: true, incognito: true });
  const saved = world.worker().popup();
  await saved.open();
  await turns();
  assert.equal(saved.last.provenance, "saved_now");
  assert.deepEqual(world.storage.value?.records ?? [], []);
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

test("pages put into manual mode are told to carry on, and only those", async () => {
  const world = install();
  const worker = world.worker();
  await worker.firstTap.leaveManualMode();
  assert.deepEqual(world.calls.end, [], "nothing was injected, so nothing is told");

  const popup = worker.popup();
  await popup.open();
  await turns();
  await worker.firstTap.leaveManualMode();
  assert.deepEqual(world.calls.end, [7]);
});
