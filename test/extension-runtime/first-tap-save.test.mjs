import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_TAP_RECORD_TTL_MS,
  FirstTapSave,
  storySaveModeAtAdmission,
} from "../../.trace-build/extension-runtime/first-tap-save.mjs";

const STORY_URL = "https://archiveofourown.org/works/123/chapters/456";
const WORK_KEY = "ao3:123";
const ENTRY_ID = "00000000-0000-4000-8000-000000000123";
const ENTRY = Object.freeze({
  status: "READING",
  readerStatus: "READING",
  canonicalReaderStatus: "READING",
  chapters: Object.freeze({ current: 3, total: 40 }),
  entryId: ENTRY_ID,
});
const CONFIRMATION = Object.freeze({
  workKey: WORK_KEY, entryId: ENTRY_ID, entry: ENTRY, syncVersion: "2026-10-12T12:00:00.000Z",
});
const COLLECTED = Object.freeze({
  ok: true,
  title: "The Long Way",
  author: "someone",
  payload: Object.freeze({
    s: "ao3",
    at: "2026-10-12T12:00:00.000Z",
    item: Object.freeze({ src: "ao3", ctx: "story", u: "https://archiveofourown.org/works/123", t: "The Long Way" }),
  }),
});

const confirmed = (source) => ({
  result: {
    kind: "confirmed", intent: "ensure_saved", confirmation: CONFIRMATION, source,
    projection: "published", receipt: "published", handoff: "not_present",
  },
  dispatch: "confirmed",
});
const failed = (reason, dispatch) => ({ result: { kind: "failed", reason }, dispatch });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function turns() {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

function harness(options = {}) {
  const state = {
    tab: "tab" in options ? options.tab : { id: 7, url: STORY_URL },
    grant: "grant" in options ? options.grant : false,
    account: options.account ?? { state: "verified", binding: "1.aaa" },
    binding: "binding" in options ? options.binding : "1.aaa",
    automaticSaving: options.automaticSaving ?? "on",
    injects: options.injects ?? true,
    collected: "collected" in options ? options.collected : COLLECTED,
    save: options.save ?? (async () => confirmed("mutation")),
    presence: options.presence ?? (async () => ({ kind: "unknown" })),
    record: options.record ?? null,
    now: options.now ?? 1_800_000_000_000,
  };
  const calls = { inject: [], collect: [], save: [], presence: [], mark: [], accountReads: 0, records: [] };
  const firstTap = new FirstTapSave({
    async activeTab() { return state.tab; },
    async grantComplete() { return state.grant; },
    async account() { calls.accountReads += 1; return state.account; },
    binding() { return state.binding; },
    async automaticSaving() { return state.automaticSaving; },
    async inject(tabId) { calls.inject.push(tabId); return state.injects; },
    async collect(tabId) { calls.collect.push(tabId); return state.collected; },
    async save(command) { calls.save.push(command); return state.save(command); },
    async presence(workKey) { calls.presence.push(workKey); return state.presence(workKey); },
    async mark(tabId, workKey) { calls.mark.push({ tabId, workKey }); },
    async readRecord() { return state.record; },
    async writeRecord(record) { calls.records.push(record); state.record = record; },
    now() { return state.now; },
  });
  const popup = () => {
    const views = [];
    const listener = (view) => views.push(view);
    return { views, listener, get last() { return views.at(-1); } };
  };
  return { firstTap, state, calls, popup };
}

// --- What a tap does ----------------------------------------------------------

test("opening Trace on a story saves it once, through the guarded save, before any lasting access", async () => {
  const h = harness();
  const popup = h.popup();
  const first = await h.firstTap.opened(popup.listener);
  assert.deepEqual(first, { state: "saving", workKey: WORK_KEY, startedAt: 1_800_000_000_000 });
  await turns();

  assert.deepEqual(h.calls.inject, [7]);
  assert.deepEqual(h.calls.collect, [7]);
  assert.equal(h.calls.save.length, 1);
  assert.equal(h.calls.save[0].intent, "ensure_saved");
  assert.equal(h.calls.save[0].workKey, WORK_KEY);
  assert.equal(h.calls.save[0].hostKind, "ao3");
  assert.equal(h.calls.save[0].mode, "bounded_manual");
  assert.deepEqual(popup.last, {
    state: "confirmed", workKey: WORK_KEY, provenance: "saved_now", mode: "bounded_manual",
    story: { title: "The Long Way", author: "someone", site: "AO3" },
    entry: { status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING", chapters: { current: 3, total: 40 } },
  });
});

test("nothing is injected or saved on a page that is not a story, or once the sites are allowed", async () => {
  for (const [options, expected] of [
    [{ tab: { id: 7, url: "https://archiveofourown.org/works" } }, "not_applicable"],
    [{ tab: { id: 7, url: "https://archiveofourown.org/users/login" } }, "not_applicable"],
    [{ tab: { id: 7, url: "https://example.com/works/123" } }, "not_applicable"],
    [{ tab: { id: 7 } }, "not_applicable"],
    [{ tab: null }, "not_applicable"],
    [{ grant: true }, "automatic"],
  ]) {
    const h = harness(options);
    assert.deepEqual(await h.firstTap.opened(h.popup().listener), { state: expected });
    await turns();
    assert.deepEqual(h.calls.inject, []);
    assert.deepEqual(h.calls.save, []);
  }
});

// --- The account, read for this open -------------------------------------------

test("the account is read afresh on every open, and one that cannot be read is never shown as signed out", async () => {
  for (const [account, expected] of [
    [{ state: "missing" }, "account_missing"],
    [{ state: "reconnect_required" }, "account_reconnect_required"],
    [{ state: "unknown" }, "account_unknown"],
  ]) {
    const h = harness({ account });
    assert.deepEqual(await h.firstTap.opened(h.popup().listener), { state: expected, workKey: WORK_KEY });
    await turns();
    assert.deepEqual(h.calls.inject, [], "nothing is injected without a verified account");
    assert.deepEqual(h.calls.save, []);
    assert.deepEqual(h.calls.records, [], "and no attempt is recorded");

    h.state.account = { state: "verified", binding: "1.aaa" };
    assert.equal((await h.firstTap.opened(h.popup().listener)).state, "saving");
    assert.equal(h.calls.accountReads, 2);
  }
  // A read that fails outright is also "not known".
  const view = await new FirstTapSave({
    async activeTab() { return { id: 7, url: STORY_URL }; },
    async grantComplete() { return false; },
    async account() { throw new Error("unavailable"); },
    binding() { return null; },
  }).opened(() => {});
  assert.deepEqual(view, { state: "account_unknown", workKey: WORK_KEY });
});

test("with automatic saving off, or unreadable, opening Trace saves nothing until the reader asks", async () => {
  for (const preference of ["off", "unknown"]) {
    const h = harness({ automaticSaving: preference });
    const popup = h.popup();
    assert.deepEqual(await h.firstTap.opened(popup.listener), {
      state: "awaiting_request", workKey: WORK_KEY, preference,
    });
    await turns();
    assert.deepEqual(h.calls.save, []);

    assert.equal((await h.firstTap.opened(popup.listener, { requested: true })).state, "saving");
    await turns();
    assert.equal(h.calls.save.length, 1);
    assert.equal(popup.last.state, "confirmed");
  }
});

// --- Saved, already there, or found (CX-18) -----------------------------------

test("saved, already in the Library and found come from the save's own outcome", async () => {
  for (const [source, provenance] of [
    ["mutation", "saved_now"],
    ["preflight", "already"],
    ["reconciliation", "found"],
  ]) {
    const h = harness({ save: async () => confirmed(source) });
    const popup = h.popup();
    await h.firstTap.opened(popup.listener);
    await turns();
    assert.equal(popup.last.provenance, provenance);
    assert.equal(h.calls.presence.length, 0, "no separate look-up decides it");
  }
});

test("a story found after an earlier attempt of unknown fate is found, not already there", async () => {
  for (const record of [
    { tabId: 7, workKey: WORK_KEY, binding: "1.aaa", at: 1_799_999_990_000, phase: "started" },
    {
      tabId: 9, workKey: WORK_KEY, binding: "1.aaa", at: 1_799_999_990_000, phase: "failed",
      view: { state: "failed", workKey: WORK_KEY, reason: "unavailable", dispatch: "sent_unconfirmed", story: null },
    },
  ]) {
    const h = harness({ record, save: async () => confirmed("preflight") });
    const popup = h.popup();
    await h.firstTap.opened(popup.listener, { requested: record.phase === "failed" });
    await turns();
    assert.equal(popup.last.provenance, "found");
  }
  // An earlier attempt known not to have been sent, or another account's, changes nothing.
  for (const record of [
    {
      tabId: 9, workKey: WORK_KEY, binding: "1.aaa", at: 1_799_999_990_000, phase: "failed",
      view: { state: "failed", workKey: WORK_KEY, reason: "unavailable", dispatch: "never_sent", story: null },
    },
    { tabId: 7, workKey: WORK_KEY, binding: "2.bbb", at: 1_799_999_990_000, phase: "started" },
    { tabId: 7, workKey: "ao3:999", binding: "1.aaa", at: 1_799_999_990_000, phase: "started" },
  ]) {
    const h = harness({ record, save: async () => confirmed("preflight") });
    const popup = h.popup();
    await h.firstTap.opened(popup.listener);
    await turns();
    assert.equal(popup.last.provenance, "already");
  }
});

// --- Never sent, refused, or sent and unconfirmed (CX-21) ---------------------

test("a failure is never sent only when nothing was handed to the network", async () => {
  for (const [options, reason, dispatch, saves] of [
    [{ injects: false }, "page_unreachable", "never_sent", 0],
    [{ collected: null }, "page_unreachable", "never_sent", 0],
    [{ collected: { ok: false, error: "story_unavailable", title: null } }, "story_unavailable", "never_sent", 0],
    [{ collected: { ...COLLECTED, payload: { ...COLLECTED.payload, item: { ...COLLECTED.payload.item, u: "https://archiveofourown.org/works/999" } } } }, "page_unreachable", "never_sent", 0],
    [{ save: async () => failed("unavailable", "never_sent") }, "unavailable", "never_sent", 1],
    [{ save: async () => failed("free_limit_reached", "refused") }, "free_limit_reached", "refused", 1],
    [{ save: async () => failed("confirmation_missing", "sent_unconfirmed") }, "unavailable", "sent_unconfirmed", 1],
    [{ save: async () => { throw new Error("lost"); } }, "unavailable", "sent_unconfirmed", 1],
  ]) {
    const h = harness(options);
    const popup = h.popup();
    await h.firstTap.opened(popup.listener);
    await turns();
    assert.equal(popup.last.state, "failed");
    assert.equal(popup.last.reason, reason);
    assert.equal(popup.last.dispatch, dispatch);
    assert.equal(h.calls.save.length, saves);
    assert.deepEqual(h.calls.mark, [], "the page shows no mark for a save that is not confirmed");
  }
});

// --- One result, for the sheet and the page -----------------------------------

test("the page is asked for its mark only for a confirmed save, and only once the sheet has closed", async () => {
  const h = harness();
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  assert.equal(popup.last.state, "confirmed");
  assert.deepEqual(h.calls.mark, [], "not while the sheet is open");

  h.firstTap.closed(popup.listener);
  await turns();
  assert.deepEqual(h.calls.mark, [{ tabId: 7, workKey: WORK_KEY }]);

  const again = h.popup();
  await h.firstTap.opened(again.listener);
  h.firstTap.closed(again.listener);
  await turns();
  assert.equal(h.calls.mark.length, 1, "and only once");
});

test("a sheet closed while the save is out lets the page show its mark as soon as it is confirmed", async () => {
  const save = deferred();
  const h = harness({ save: () => save.promise });
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  h.firstTap.closed(popup.listener);
  assert.deepEqual(h.calls.mark, []);

  const reopened = h.popup();
  assert.equal((await h.firstTap.opened(reopened.listener)).state, "saving", "the same operation, not a second save");
  h.firstTap.closed(reopened.listener);
  save.resolve(confirmed("mutation"));
  await turns();

  assert.equal(h.calls.save.length, 1);
  assert.deepEqual(h.calls.mark, [{ tabId: 7, workKey: WORK_KEY }]);
  const later = h.popup();
  assert.equal((await h.firstTap.opened(later.listener)).provenance, "saved_now");
  assert.equal(h.calls.save.length, 1);
});

test("a popup reopened after the background slept is given the same result, without the story's title kept", async () => {
  const h = harness();
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  const record = h.state.record;
  assert.equal(record.phase, "confirmed");
  assert.equal(record.view.story, null, "title and author are shown, never stored");

  const woken = harness({ record });
  const view = await woken.firstTap.opened(woken.popup().listener);
  assert.equal(view.state, "confirmed");
  assert.equal(view.provenance, "saved_now");
  await turns();
  assert.deepEqual(woken.calls.save, [], "no second save");

  const stale = harness({ record, now: record.at + FIRST_TAP_RECORD_TTL_MS + 1, save: async () => confirmed("preflight") });
  const stalePopup = stale.popup();
  assert.equal((await stale.firstTap.opened(stalePopup.listener)).state, "saving");
  await turns();
  assert.equal(stalePopup.last.provenance, "already", "an old result is not shown again as this tap's");
  assert.equal(stale.calls.records[0], null, "and the old record is removed");
});

test("a result is discarded when the account or its provider changes during the operation", async () => {
  for (const when of ["collect", "save"]) {
    const gate = deferred();
    const h = harness(when === "save" ? { save: () => gate.promise } : {});
    if (when === "collect") h.state.collected = gate.promise;
    const popup = h.popup();
    await h.firstTap.opened(popup.listener);
    await turns();
    h.state.binding = "2.bbb";
    gate.resolve(when === "save" ? confirmed("mutation") : COLLECTED);
    await turns();

    assert.equal(popup.last.state, "account_unknown", "the sheet is told to read the account again");
    assert.equal(h.calls.save.length, when === "save" ? 1 : 0, "nothing is sent for an account that changed first");
    h.firstTap.closed(popup.listener);
    await turns();
    assert.deepEqual(h.calls.mark, [], "the page shows nothing for another account's result");
    assert.notEqual(h.state.record?.phase, "confirmed");
  }
});

test("a result held for one account is not shown to another", async () => {
  const h = harness();
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  h.firstTap.closed(popup.listener);
  h.state.account = { state: "verified", binding: "2.bbb" };
  h.state.binding = "2.bbb";
  h.state.save = async () => confirmed("preflight");
  const other = h.popup();
  assert.equal((await h.firstTap.opened(other.listener)).state, "saving");
  await turns();
  assert.equal(h.calls.save.length, 2);
  assert.equal(other.last.provenance, "already");
});

// --- Check again (CX-16) -------------------------------------------------------

test("Check again only looks: it finds or it does not know, and it has no way to save", async () => {
  const h = harness({ save: async () => failed("confirmation_missing", "sent_unconfirmed") });
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  assert.equal(h.calls.save.length, 1);

  assert.deepEqual(await h.firstTap.check(), { state: "presence_unknown", workKey: WORK_KEY });
  h.state.presence = async () => { throw new Error("offline"); };
  assert.deepEqual(await h.firstTap.check(), { state: "presence_unknown", workKey: WORK_KEY });
  assert.equal(popup.last.state, "failed", "not finding it changes nothing that is shown");

  h.state.presence = async () => ({ kind: "found", confirmation: CONFIRMATION });
  const found = await h.firstTap.check();
  assert.equal(found.state, "confirmed");
  assert.equal(found.provenance, "found", "found now; not claimed as this tap's save");
  assert.equal(found.mode, null);
  assert.equal(found.story.title, "The Long Way");
  assert.equal(popup.last.state, "confirmed");
  assert.equal(h.calls.save.length, 1, "no look ever sent a save");
  assert.equal(h.calls.inject.length, 1);
});

test("Check again for an account that changes while it looks does not know", async () => {
  const look = deferred();
  const h = harness({ presence: () => look.promise });
  const pending = h.firstTap.check();
  await turns();
  h.state.binding = "2.bbb";
  look.resolve({ kind: "found", confirmation: CONFIRMATION });
  assert.deepEqual(await pending, { state: "presence_unknown", workKey: WORK_KEY });
  const none = harness({ binding: null, presence: async () => ({ kind: "found", confirmation: CONFIRMATION }) });
  assert.deepEqual(await none.firstTap.check(), { state: "presence_unknown", workKey: WORK_KEY });
  assert.deepEqual(none.calls.presence, []);
});

// --- Try again, and the page's own saves ---------------------------------------

test("Try again is a new attempt through the same guarded save; a plain reopen is not", async () => {
  let attempt = 0;
  const h = harness({
    save: async () => (attempt += 1) === 1 ? failed("unavailable", "never_sent") : confirmed("mutation"),
  });
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  assert.equal(popup.last.dispatch, "never_sent");

  assert.equal((await h.firstTap.opened(popup.listener)).state, "failed");
  await turns();
  assert.equal(h.calls.save.length, 1);

  assert.equal((await h.firstTap.opened(popup.listener, { requested: true })).state, "saving");
  await turns();
  assert.equal(h.calls.save.length, 2);
  assert.equal(popup.last.provenance, "saved_now");
});

test("a page's own save for the story clears a first tap's unconfirmed word, and leaves a confirmed one", async () => {
  const h = harness({ save: async () => failed("not_authenticated", "never_sent") });
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  assert.equal(popup.last.dispatch, "never_sent");
  h.firstTap.closed(popup.listener);

  h.firstTap.pageSaveAdmitted(7, "ao3:999");
  assert.equal((await h.firstTap.opened(h.popup().listener)).state, "failed", "another story's save changes nothing");

  h.firstTap.pageSaveAdmitted(7, WORK_KEY);
  await turns();
  assert.equal(h.state.record, null);
  h.state.save = async () => confirmed("preflight");
  const after = h.popup();
  assert.equal((await h.firstTap.opened(after.listener)).state, "saving", "the sheet asks again instead of repeating never sent");
  await turns();
  assert.equal(after.last.state, "confirmed");

  h.firstTap.pageSaveAdmitted(7, WORK_KEY);
  assert.equal((await h.firstTap.opened(h.popup().listener)).state, "confirmed");
});

// --- Manual or automatic, stamped at admission (CX-20) ------------------------

test("the mode is what the background established, and nothing when it could not", () => {
  const mode = (injectedForFirstTap, grantComplete, registered) =>
    storySaveModeAtAdmission({ injectedForFirstTap, grantComplete, registered });
  assert.equal(mode(true, false, null), "bounded_manual");
  assert.equal(mode(true, false, false), "bounded_manual");
  assert.equal(mode(false, true, true), "normal_automatic");
  // A page the background injected, whose debt is paid after the grant, is
  // stamped by what holds when it is paid.
  assert.equal(mode(true, true, true), "normal_automatic");
  for (const [injected, grant, registered] of [
    [false, false, false], [false, false, null], [false, null, null], [true, null, null],
    [false, true, false], [false, true, null], [true, true, false],
  ]) {
    assert.equal(mode(injected, grant, registered), null);
  }
});

test("a first tap whose grant could not be read is saved without a claimed mode", async () => {
  const h = harness({ grant: null });
  const popup = h.popup();
  await h.firstTap.opened(popup.listener);
  await turns();
  assert.equal(Object.hasOwn(h.calls.save[0], "mode"), false);
  assert.equal(popup.last.mode, null);
  assert.equal(h.firstTap.injectedFor(7, WORK_KEY), true);
  assert.equal(h.firstTap.injectedFor(7, "ao3:999"), false);
  assert.equal(h.firstTap.injectedFor(8, WORK_KEY), false);
});
