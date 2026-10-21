import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { BrowserStorage } from "../../.trace-build/extension-runtime/browser-platform.mjs";
import {
  EARNED_PERMISSION_STATE_KEY,
  installEarnedPermissionRegistrationRuntime,
} from "../../.trace-build/extension-runtime/earned-permission-registration.mjs";
import {
  SAFARI_READINESS_MESSAGES,
  SAFARI_READINESS_SESSION_KEY,
  installSafariReadinessReport,
} from "../../.trace-build/extension-runtime/safari-readiness-report.mjs";

// These tests run the report through the real runtime module. Only the
// browser, the Trace app's side of native messaging and the session are
// stood in for.

const FIVE = [
  "https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*", "https://www.fanfiction.net/*", "https://m.fanfiction.net/*",
];
const IDS = ["trace-archive-automation-v1", "trace-ao3-saved-filters-v1"];
const CONFIG = Object.freeze({
  version: 4,
  registrationMode: "dynamic",
  origins: FIVE,
  registrations: IDS.map((id) => ({ id, matches: FIVE, js: ["collector.js"], runAt: "document_end", persistAcrossSessions: true })),
});
const API = "https://api.tracefiction.com";
const PROVIDER = Object.freeze({ sessionID: "8a0ead75-6a99-4380-a175-bb97331f48e7", recordDigest: "a".repeat(64) });
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const popup = { id: "trace-extension", url: "safari-web-extension://trace/popup.html" };
const OPEN_POPUP = { type: "TRACE_ARCHIVE_ACCESS_REPORT" };

async function settle() {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A reader with everything in place, unless a test says otherwise. */
function install(options = {}) {
  const state = {
    now: 1_800_000_000_000,
    granted: [...FIVE],
    containsAnswers: true,
    listAnswers: true,
    registered: [...IDS],
    registeredAnswers: true,
    stored: { [EARNED_PERMISSION_STATE_KEY]: { registrationVersion: 4, promptResult: "granted", completedAt: 1 } },
    provider: PROVIDER,
    cycle: { id: "0b7c5a52-7c1d-4a52-9b43-1d6f8f0a2c11", accountID: "account-a" },
    reportResponse: { ok: true },
    account: { state: "verified" },
    binding: "1.aaa",
    accountId: "account-a",
    sessionState: "connected",
    saving: "on",
    ...(typeof options === "function" ? {} : options),
  };
  // A test may arrange the reader's state before the background starts.
  if (typeof options === "function") options(state);
  const calls = { native: [], waits: [], tabs: 0, executed: 0, requested: 0 };
  const listeners = { message: [], added: [], removed: [] };
  const runtime = {
    id: "trace-extension",
    onMessage: { addListener: (listener) => listeners.message.push(listener) },
    getManifest: () => state.manifest ?? {},
    async getPlatformInfo() { return { os: state.os ?? "ios" }; },
    ...(state.withoutNativeMessaging ? {} : {
      async sendNativeMessage(...args) {
        const message = args.find((value) => value && typeof value === "object");
        calls.native.push(JSON.parse(JSON.stringify(message)));
        if (message.type === SAFARI_READINESS_MESSAGES.prepare) {
          const reply = state.provider === null
            ? { ok: false }
            : { ok: true, provider: state.provider, ...(state.cycle === null ? {} : { cycle: state.cycle }) };
          state.afterPrepare?.();
          return reply;
        }
        if (message.type === SAFARI_READINESS_MESSAGES.report) {
          return Array.isArray(state.reportResponse) && state.reportResponse.length > 1
            ? state.reportResponse.shift()
            : [state.reportResponse].flat()[0];
        }
        return { ok: true };
      },
    }),
  };
  const permissions = {
    async getAll() {
      if (!state.listAnswers) throw new Error("no answer");
      return { origins: [...state.granted] };
    },
    async contains({ origins }) {
      if (!state.containsAnswers) throw new Error("no answer");
      return state.granted.includes("*://*/*") || origins.every((origin) => state.granted.includes(origin));
    },
    request() { calls.requested += 1; assert.fail("the report never asks Safari for access"); },
    onAdded: { addListener: (listener) => listeners.added.push(listener) },
    onRemoved: { addListener: (listener) => listeners.removed.push(listener) },
  };
  const scripting = {
    async getRegisteredContentScripts() {
      if (!state.registeredAnswers) throw new Error("no answer");
      return state.registered.map((id) => ({ id }));
    },
    async executeScript() { calls.executed += 1; assert.fail("the report runs nothing on a page"); },
    async registerContentScripts() { assert.fail("the report registers nothing"); },
    async unregisterContentScripts() { assert.fail("the report unregisters nothing"); },
  };
  const storageArea = {
    async get(keys) {
      if (state.storageFails) throw new Error("storage unavailable");
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in state.stored).map((key) => [key, state.stored[key]]));
    },
    async set(patch) { Object.assign(state.stored, patch); },
    async remove(key) { delete state.stored[key]; },
  };
  const session = {
    async accountForThisOpen() {
      return state.account.state === "verified" ? { state: "verified", binding: state.binding } : state.account;
    },
    snapshot: () => ({ state: state.sessionState, accountId: state.accountId }),
    pageBinding: () => state.binding,
    async automaticSaving() { return state.saving; },
  };
  const reporter = installSafariReadinessReport({
    runtime,
    permissions,
    ...(state.withoutScripting ? {} : { scripting }),
    storage: new BrowserStorage(storageArea, runtime, "promise"),
    storageMode: "promise",
    apiOrigin: API,
    config: state.config ?? CONFIG,
    session: () => (state.noSession ? undefined : session),
    now: () => state.now,
    wait: async (ms) => { calls.waits.push(ms); state.now += ms; await state.duringWait?.(); },
    platform: { userAgent: state.userAgent ?? IPHONE_UA },
    ...(state.registration ? { registration: state.registration } : {}),
  });
  const reports = () => calls.native.filter(({ type }) => type === SAFARI_READINESS_MESSAGES.report);
  const answers = (report) => Object.fromEntries(
    Object.entries(report.components).map(([name, { answer, reason }]) => [name, `${answer}:${reason}`]),
  );
  const fromPopup = (message = OPEN_POPUP, sender = popup) => new Promise((resolve) => {
    let handled = false;
    for (const listener of listeners.message) {
      if (listener(message, sender, resolve) === true) handled = true;
    }
    if (!handled) setImmediate(() => resolve(undefined));
  });
  return { state, calls, listeners, reporter, reports, answers, fromPopup, storageArea };
}

const READY = {
  websiteAccess: "positive:allowed",
  scriptRegistration: "positive:registered",
  account: "positive:connected",
  automaticSaving: "positive:on",
};

test("a ready report: first which provider and cycle, then one report bound to both, holding nothing but the four answers", async () => {
  const h = install();
  const outcome = await h.reporter.report();
  assert.equal(outcome.kind, "delivered");
  assert.deepEqual(h.calls.native.map(({ type }) => type), [
    "TRACE_IOS_SAFARI_READINESS_PREPARE",
    "TRACE_IOS_SAFARI_READINESS_REPORT",
  ]);
  assert.deepEqual(h.calls.native[0], { type: "TRACE_IOS_SAFARI_READINESS_PREPARE", apiOrigin: API });
  const report = h.reports()[0];
  assert.deepEqual(Object.keys(report).sort(), [
    "accountID", "apiOrigin", "components", "cycleID", "observedAt", "provider", "result", "type", "version",
  ]);
  assert.equal(report.version, 1);
  assert.equal(report.apiOrigin, API);
  assert.deepEqual(report.provider, PROVIDER, "the provider the app's side named, passed back as it was");
  assert.equal(report.cycleID, h.state.cycle.id);
  assert.equal(report.accountID, "account-a");
  assert.equal(report.result, "ready");
  assert.deepEqual(h.answers(report), READY);
  for (const part of Object.values(report.components)) {
    assert.deepEqual(Object.keys(part).sort(), ["answer", "observedAt", "reason"]);
    assert.equal(part.observedAt <= report.observedAt, true);
  }
  // No address, credential, story, or claim beyond the four answers.
  const sent = JSON.stringify(h.calls.native);
  for (const forbidden of [
    "archiveofourown", "fanfiction", "http://", "trd_v1_", "token", "workKey", "ao3:", "ffn:",
    "always", "one_day", "duration", "saved", "private", "incognito",
  ]) {
    assert.equal(sent.replace(API, "").includes(forbidden), false, `${forbidden} is not sent`);
  }
  assert.equal(h.calls.tabs + h.calls.executed + h.calls.requested, 0);
});

test("the message is the one the native codec's contract test reads", async () => {
  const h = install();
  await h.reporter.report();
  const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/safari-readiness-report-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(h.reports()[0], fixture);
});

test("website access is read twice before it is called a blocker, and unknown when Safari does not answer", async () => {
  for (const [arrange, expected, waits] of [
    [(state) => { state.granted = []; }, "blocker:not_allowed", [2_000]],
    [(state) => { state.granted = FIVE.slice(0, 2); }, "blocker:partly_allowed", [2_000]],
    // "Every website" allows them all without naming them.
    [(state) => { state.granted = ["*://*/*"]; }, "positive:allowed", []],
    [(state) => { state.containsAnswers = false; state.listAnswers = false; }, "unknown:unreadable", []],
    // Read as incomplete, with no list to go with it: not an answer.
    [(state) => { state.granted = []; state.listAnswers = false; }, "unknown:unconfirmed", []],
    // The list alone, complete, is enough to know.
    [(state) => { state.containsAnswers = false; }, "positive:allowed", []],
    // The second reading differs: allowed in the meantime.
    [(state) => { state.granted = []; state.duringWait = () => { state.granted = [...FIVE]; }; }, "positive:allowed", [2_000]],
    // The second reading does not answer.
    [(state) => { state.granted = []; state.duringWait = () => { state.listAnswers = false; }; }, "unknown:unconfirmed", [2_000]],
  ]) {
    const h = install();
    arrange(h.state);
    await h.reporter.report();
    assert.equal(h.answers(h.reports()[0]).websiteAccess, expected);
    assert.deepEqual(h.calls.waits, waits);
  }
});

test("website access gone after an update: said only for a grant recorded by an earlier generation and not yet by this one", async () => {
  for (const [record, mode, expected] of [
    // 0.6.6 recorded its grant under the generation that declared its scripts.
    [{ grantAt: 1, registrationVersion: 3, promptResult: "granted" }, "dynamic", "blocker:not_allowed_since_update"],
    [{ grantAt: 1, registrationVersion: 3, promptResult: "granted", completedAt: 1 }, "dynamic", "blocker:not_allowed_since_update"],
    // This version's own grant: an ending is not an update's.
    [{ grantAt: 1, registrationVersion: 4, promptResult: "granted" }, "dynamic", "blocker:not_allowed"],
    // No grant was recorded, or it was declined.
    [{ registrationVersion: 3, promptResult: "declined" }, "dynamic", "blocker:not_allowed"],
    [{ registrationVersion: 3 }, "dynamic", "blocker:not_allowed"],
    [undefined, "dynamic", "blocker:not_allowed"],
    // A build that declares its scripts has no earlier generation to compare.
    [{ grantAt: 1, registrationVersion: 3, promptResult: "granted" }, "static", "blocker:not_allowed"],
  ]) {
    const h = install((state) => {
      state.granted = [];
      if (record === undefined) delete state.stored[EARNED_PERMISSION_STATE_KEY];
      else state.stored[EARNED_PERMISSION_STATE_KEY] = record;
      if (mode === "static") state.config = { ...CONFIG, version: 3, registrationMode: "static" };
    });
    await h.reporter.report();
    assert.equal(h.answers(h.reports()[0]).websiteAccess, expected, JSON.stringify([record, mode]));
  }
  // Some of the sites allowed stays partly allowed.
  const partly = install((state) => {
    state.granted = FIVE.slice(0, 2);
    state.stored[EARNED_PERMISSION_STATE_KEY] = { grantAt: 1, registrationVersion: 3, promptResult: "granted" };
  });
  await partly.reporter.report();
  assert.equal(partly.answers(partly.reports()[0]).websiteAccess, "blocker:partly_allowed");
});

test("script registration: both scripts at this build's generation, or a blocker with its reason, or unknown", async () => {
  for (const [arrange, expected] of [
    [() => {}, "positive:registered"],
    [(state) => { state.registered = []; }, "blocker:not_registered"],
    [(state) => { state.registered = [IDS[0]]; }, "blocker:not_registered"],
    // Present, and registered by an earlier generation.
    [(state) => { state.stored[EARNED_PERMISSION_STATE_KEY] = { registrationVersion: 3 }; }, "blocker:not_registered"],
    [(state) => { delete state.stored[EARNED_PERMISSION_STATE_KEY]; }, "blocker:not_registered"],
    [(state) => { state.registeredAnswers = false; }, "unknown:unreadable"],
    [(state) => { state.storageFails = true; }, "unknown:unreadable"],
    [(state) => { state.withoutScripting = true; }, "blocker:registration_failed"],
    // A build that declares its page scripts in its manifest.
    [(state) => {
      state.config = { ...CONFIG, version: 3, registrationMode: "static" };
      state.manifest = { content_scripts: [{ matches: FIVE, js: ["collector.js"] }] };
      state.registered = [];
    }, "positive:declared"],
    [(state) => { state.config = { ...CONFIG, registrationMode: "static" }; state.manifest = {}; }, "blocker:not_registered"],
  ]) {
    const h = install(arrange);
    await h.reporter.report();
    assert.equal(h.answers(h.reports()[0]).scriptRegistration, expected);
  }
});

test("a reader who finished setup and whose scripts keep failing to register is told to the app as a blocker it can act on", async () => {
  const h = install({ registered: [] });
  assert.deepEqual(h.reports(), [], "nothing is sent just because the background started");
  // The story sites are allowed, setup was finished long ago, and the attempt
  // to put the scripts back has failed.
  h.reporter.registrationEnded({ ok: false, completeGrant: true, registered: false, changed: false, error: "registration_failed" });
  await settle();
  assert.equal(h.reports().length, 1);
  const report = h.reports()[0];
  assert.equal(report.result, "not_ready");
  assert.deepEqual(h.answers(report), {
    ...READY, scriptRegistration: "blocker:registration_failed",
  }, "access, account and preference are fine: the scripts are the one cause");

  // Each further failed try says so again; it is not reported as merely absent.
  h.reporter.registrationEnded({ ok: false, completeGrant: true, registered: false, changed: false, error: "registration_failed" });
  await settle();
  assert.equal(h.reports().length, 2);
  assert.equal(h.answers(h.reports()[1]).scriptRegistration, "blocker:registration_failed");

  // The scripts go in: ready, and no longer a failure.
  h.state.registered = [...IDS];
  h.reporter.registrationEnded({ ok: true, completeGrant: true, registered: true, changed: true });
  await settle();
  assert.equal(h.reports().at(-1).result, "ready");

  // A reconcile that found everything as it was says nothing new.
  const before = h.reports().length;
  h.reporter.registrationEnded({ ok: true, completeGrant: true, registered: true, changed: false });
  h.reporter.registrationEnded(null);
  await settle();
  assert.equal(h.reports().length, before);
});

test("the report lets a registration under way finish before it reads the scripts", async () => {
  let release;
  let pending = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = install({ registered: [], registration: { idle: () => gate, pending: () => pending } });
  const reporting = h.reporter.report();
  await settle();
  assert.deepEqual(h.reports(), [], "nothing is reported while the scripts are being put in");
  h.state.registered = [...IDS];
  pending = false;
  release();
  await reporting;
  assert.equal(h.reports()[0].result, "ready");
});

test("the account: connected, a known blocker, or unknown; and an account is named only when it is the one confirmed", async () => {
  for (const [arrange, expected, named] of [
    [() => {}, "positive:connected", true],
    [(state) => { state.account = { state: "reconnect_required" }; state.sessionState = "reconnect_required"; }, "blocker:reconnect_required", false],
    [(state) => { state.account = { state: "missing" }; state.sessionState = "signed_out"; }, "blocker:no_account", false],
    [(state) => { state.account = { state: "unknown" }; state.sessionState = "verifying"; }, "unknown:pending", false],
    [(state) => { state.account = { state: "unknown" }; state.sessionState = "connecting"; }, "unknown:pending", false],
    [(state) => { state.account = { state: "unknown" }; state.sessionState = "degraded"; }, "unknown:unreachable", false],
    [(state) => { state.account = { state: "unknown" }; state.sessionState = "signed_out"; }, "unknown:unreachable", false],
    [(state) => { state.noSession = true; }, "unknown:pending", false],
    // Confirmed here, and not the account the app's cycle is for.
    [(state) => { state.cycle = { ...state.cycle, accountID: "account-b" }; }, "unknown:mismatch", false],
    // Confirmed, with no account identity to go with it.
    [(state) => { state.accountId = null; }, "unknown:changed", false],
  ]) {
    const h = install();
    arrange(h.state);
    await h.reporter.report();
    const report = h.reports()[0];
    assert.equal(h.answers(report).account, expected);
    assert.equal(Object.hasOwn(report, "accountID"), named, expected);
  }
});

test("an account that changes while the report is read: unknown, with neither account named", async () => {
  const h = install({ granted: [] });
  h.state.duringWait = () => { h.state.binding = "2.bbb"; h.state.accountId = "account-b"; };
  await h.reporter.report();
  const first = h.reports()[0];
  assert.equal(h.answers(first).account, "unknown:changed");
  assert.equal(first.result, "unknown", "access is a blocker, and still nothing is claimed for an account that changed");
  assert.equal(Object.hasOwn(first, "accountID"), false);
  // It then reads again, under the account there is now.
  const last = h.reports().at(-1);
  assert.equal(h.reports().length > 1, true);
  assert.equal(last.accountID ?? "account-b", "account-b");
  assert.notEqual(last.accountID, "account-a");
});

test("the automatic-saving preference: on, off, or unknown", async () => {
  for (const [saving, expected, result] of [
    ["on", "positive:on", "ready"], ["off", "blocker:off", "not_ready"], ["unknown", "unknown:unreadable", "unknown"],
  ]) {
    const h = install({ saving });
    await h.reporter.report();
    assert.equal(h.answers(h.reports()[0]).automaticSaving, expected);
    assert.equal(h.reports()[0].result, result);
  }
});

test("with no provider nothing is read and nothing is sent beyond the question", async () => {
  const h = install({ provider: null });
  assert.deepEqual(await h.reporter.report(), { kind: "no_provider" });
  assert.deepEqual(h.calls.native, [{ type: "TRACE_IOS_SAFARI_READINESS_PREPARE", apiOrigin: API }]);
  assert.deepEqual(h.calls.waits, []);
});

test("an answer for a cycle the app has replaced is not taken as current: the report is read again for the cycle now open", async () => {
  const h = install({ reportResponse: [{ ok: false, error: "stale_cycle" }, { ok: true }] });
  const next = { id: "5d1f0f3e-2a4b-4c6d-8e9f-0a1b2c3d4e5f", accountID: "account-a" };
  const first = h.state.cycle.id;
  // The app opens another cycle just after this reading began.
  h.state.afterPrepare = () => { h.state.cycle = next; h.state.afterPrepare = null; };
  const outcome = await h.reporter.report();
  assert.equal(outcome.kind, "delivered");
  assert.deepEqual(h.reports().map(({ cycleID }) => cycleID), [first, next.id]);

  // With no cycle open the report names none.
  const bare = install({ cycle: null });
  await bare.reporter.report();
  assert.equal(Object.hasOwn(bare.reports()[0], "cycleID"), false);
  assert.equal(bare.reports()[0].result, "ready");

  // A refusal for any other reason is not retried.
  const refused = install({ reportResponse: { ok: false } });
  assert.equal((await refused.reporter.report()).kind, "refused");
  assert.equal(refused.reports().length, 1);
});

test("the extension answers when the popup opens, when access is added or removed, and when the preference changes", async () => {
  const h = install();
  await settle();
  assert.deepEqual(h.calls.native, [], "a background that only started sends nothing");

  assert.deepEqual(await h.fromPopup(), { ok: true });
  assert.equal(h.reports().length, 1);
  // Only the extension's own popup, and only its plain opening message.
  assert.equal(await h.fromPopup(OPEN_POPUP, { id: "trace-extension", tab: { url: "https://archiveofourown.org/works/1" }, url: "https://archiveofourown.org/works/1" }), undefined);
  assert.equal(await h.fromPopup({ ...OPEN_POPUP, extra: true }), undefined);
  assert.equal(await h.fromPopup({ type: "TRACE_SOMETHING_ELSE" }), undefined);
  assert.equal(h.reports().length, 1);

  h.state.granted = [];
  h.listeners.removed[0]();
  await settle();
  assert.equal(h.reports().length, 2);
  assert.equal(h.reports()[1].result, "not_ready");
  assert.equal(h.answers(h.reports()[1]).websiteAccess, "blocker:not_allowed");

  h.state.granted = [...FIVE];
  h.listeners.added[0]();
  await settle();
  assert.equal(h.reports().at(-1).result, "ready");

  h.state.saving = "off";
  const before = h.reports().length;
  h.reporter.preferenceChanged();
  await settle();
  assert.equal(h.reports().length, before + 1);
  assert.equal(h.answers(h.reports().at(-1)).automaticSaving, "blocker:off");
});

test("an account change is reported once; a background that merely started again, or a Library that changed, is not", async () => {
  const h = install();
  // The first settled session this install sees is told once.
  h.reporter.accountMayHaveChanged();
  await settle();
  assert.equal(h.reports().length, 1);
  assert.equal(h.state.stored[SAFARI_READINESS_SESSION_KEY], "1.aaa");
  // The same session again (a save, a Library refresh): nothing.
  h.reporter.accountMayHaveChanged();
  h.reporter.accountMayHaveChanged();
  await settle();
  assert.equal(h.reports().length, 1);

  // A new background over the same storage and the same session: nothing.
  const restarted = install({ stored: h.state.stored });
  restarted.reporter.accountMayHaveChanged();
  await settle();
  assert.deepEqual(restarted.reports(), []);

  // Still being confirmed is not yet another account.
  h.state.sessionState = "verifying";
  h.state.binding = null;
  h.reporter.accountMayHaveChanged();
  await settle();
  assert.equal(h.reports().length, 1);

  // Another account signs in.
  h.state.sessionState = "connected";
  h.state.binding = "2.bbb";
  h.state.accountId = "account-b";
  h.state.cycle = null;
  h.reporter.accountMayHaveChanged();
  await settle();
  assert.equal(h.reports().length, 2);
  assert.equal(h.reports()[1].accountID, "account-b");
  assert.equal(h.state.stored[SAFARI_READINESS_SESSION_KEY], "2.bbb");
  const kept = JSON.stringify(h.state.stored[SAFARI_READINESS_SESSION_KEY]);
  assert.equal(kept.includes("account"), false, "what is kept names no account");

  // Signed out.
  h.state.sessionState = "signed_out";
  h.state.binding = null;
  h.state.account = { state: "missing" };
  h.reporter.accountMayHaveChanged();
  await settle();
  assert.equal(h.reports().length, 3);
  assert.equal(h.answers(h.reports()[2]).account, "blocker:no_account");
});

test("off iPhone and iPad nothing is installed and nothing is sent", async () => {
  for (const options of [
    { withoutNativeMessaging: true },
    { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" },
    { userAgent: MAC_UA, os: "mac" },
  ]) {
    const h = install(options);
    assert.deepEqual(await h.reporter.report(), { kind: "no_provider" });
    h.reporter.preferenceChanged();
    h.reporter.accountMayHaveChanged();
    h.reporter.registrationEnded({ ok: false, completeGrant: true, registered: false, changed: false, error: "registration_failed" });
    for (const listener of [...h.listeners.added, ...h.listeners.removed]) listener();
    await h.fromPopup();
    await settle();
    assert.deepEqual(h.calls.native, [], JSON.stringify(options));
  }
  // An iPad that calls itself a Mac is still beside the app.
  const ipad = install({ userAgent: MAC_UA, os: "ios" });
  assert.equal((await ipad.reporter.report()).kind, "delivered");
});

/**
 * The report and the real registration runtime over one stand-in browser, as
 * the background wires them. `slow` holds each browser call the registration
 * makes for that long, as a busy phone does.
 */
function installWithRegistration(options = {}) {
  const state = {
    now: 1_800_000_000_000, granted: [], registered: [], stored: {}, failRegistration: false,
    holdRegistration: null, ...options,
  };
  const native = [];
  const listeners = { message: [], added: [], removed: [], installed: [], alarm: [] };
  const event = (list) => ({ addListener: (listener) => list.push(listener) });
  const runtime = {
    id: "trace-extension",
    onMessage: event(listeners.message),
    onInstalled: event(listeners.installed),
    getManifest: () => ({}),
    async getPlatformInfo() { return { os: "ios" }; },
    async sendNativeMessage(...args) {
      const message = args.find((value) => value && typeof value === "object");
      native.push(JSON.parse(JSON.stringify(message)));
      return message.type === SAFARI_READINESS_MESSAGES.prepare
        ? { ok: true, provider: PROVIDER, cycle: { id: "0b7c5a52-7c1d-4a52-9b43-1d6f8f0a2c11", accountID: "account-a" } }
        : { ok: true };
    },
  };
  const permissions = {
    async getAll() { return { origins: [...state.granted] }; },
    async contains({ origins }) { return origins.every((origin) => state.granted.includes(origin)); },
    onAdded: event(listeners.added),
    onRemoved: event(listeners.removed),
  };
  const scripting = {
    async getRegisteredContentScripts() { return state.registered.map((id) => ({ id })); },
    async registerContentScripts(scripts) {
      if (state.holdRegistration) await state.holdRegistration;
      if (state.failRegistration) throw new Error("registration refused");
      state.registered.push(...scripts.map(({ id }) => id));
    },
    async unregisterContentScripts({ ids }) {
      state.registered = state.registered.filter((id) => !ids.includes(id));
    },
  };
  const area = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in state.stored).map((key) => [key, state.stored[key]]));
    },
    async set(patch) { Object.assign(state.stored, patch); },
    async remove(key) { delete state.stored[key]; },
  };
  const storage = () => new BrowserStorage(area, runtime, "promise");
  const session = {
    async accountForThisOpen() { return { state: "verified", binding: "1.aaa" }; },
    snapshot: () => ({ state: "connected", accountId: "account-a" }),
    pageBinding: () => "1.aaa",
    async automaticSaving() { return "on"; },
  };
  let reporter = null;
  // The report is wired first here, so that its listeners hear each event
  // before the registration's do: the order must not matter.
  const waits = [];
  const wire = () => {
    reporter = installSafariReadinessReport({
      runtime, permissions, scripting, storage: storage(), storageMode: "promise", apiOrigin: API, config: CONFIG,
      alarms: { onAlarm: event(listeners.alarm) },
      registration: {
        idle: () => registration.idle(),
        pending: () => registration.pending(),
      },
      session: () => session,
      now: () => state.now,
      wait: async (ms) => { waits.push(ms); state.now += ms; await state.duringWait?.(); },
      settleLimitMs: state.settleLimitMs ?? 6_000,
      platform: { userAgent: IPHONE_UA },
    });
  };
  if (state.reportFirst !== false) wire();
  const registration = installEarnedPermissionRegistrationRuntime({
    runtime, permissions, scripting, storage: storage(), storageMode: "promise", config: CONFIG,
    endedGrantConfirmDelayMs: 0,
    alarms: {
      async clear() {}, async create() {},
      async getAll() { if (state.holdAlarms) await state.holdAlarms; return []; },
      onAlarm: event([]),
    },
    onReconcileEnded: (result) => reporter?.registrationEnded(result),
  });
  if (state.reportFirst === false) wire();
  const reports = () => native.filter(({ type }) => type === SAFARI_READINESS_MESSAGES.report);
  const summary = () => reports().map(({ result, components }) =>
    `${result} [scripts ${components.scriptRegistration.answer}:${components.scriptRegistration.reason}]`);
  return { state, native, listeners, reporter: () => reporter, registration, reports, summary, waits };
}

test("the moment the reader allows the story sites is never reported as not ready: the report waits for the registration the grant sets off", async () => {
  for (const reportFirst of [true, false]) {
    const h = installWithRegistration({ reportFirst });
    await settle();
    assert.deepEqual(h.summary(), [], "nothing allowed and nothing changed: nothing reported");

    // The reader taps Always Allow. Safari tells every listener at once.
    h.state.granted = [...FIVE];
    for (const listener of h.listeners.added) listener();
    await settle();
    await settle();
    assert.deepEqual(h.state.registered, IDS);
    assert.equal(h.summary().length >= 1, true, "a grant is answered");
    for (const line of h.summary()) {
      assert.equal(line, "ready [scripts positive:registered]", `${reportFirst ? "report" : "registration"} wired first`);
    }
  }
});

test("the update itself is reported for a reader whose grant was to an earlier version, and the access it had is said to be gone", async () => {
  const h = installWithRegistration({
    granted: [], stored: { [EARNED_PERMISSION_STATE_KEY]: { grantAt: 1, registrationVersion: 3, promptResult: "granted" } },
  });
  await settle();
  const before = h.reports().length;
  for (const listener of h.listeners.installed) listener({ reason: "update" });
  await settle();
  await settle();
  const after = h.reports().slice(before);
  assert.equal(after.length >= 1, true, "the update is reported without waiting for the popup");
  assert.equal(after.at(-1).components.websiteAccess.reason, "not_allowed_since_update");

  // A first install has no earlier grant to lose.
  const fresh = installWithRegistration({ granted: [], stored: {} });
  await settle();
  const count = fresh.reports().length;
  for (const listener of fresh.listeners.installed) listener({ reason: "update" });
  await settle();
  await settle();
  assert.equal(fresh.reports().slice(count).some((report) => report.components.websiteAccess.reason === "not_allowed_since_update"), false);

  // Allowed again, under this version: the reason goes with the grant.
  h.state.granted = [...FIVE];
  for (const listener of h.listeners.added) listener();
  await settle();
  await settle();
  assert.equal(h.reports().at(-1).components.websiteAccess.reason, "allowed");
  assert.equal(h.state.stored[EARNED_PERMISSION_STATE_KEY].registrationVersion, 4, "the grant is this version's now");
});

test("while the page scripts are still being put in, the report does not know; it never calls them missing", async () => {
  let release;
  const h = installWithRegistration({ settleLimitMs: 30 });
  await settle();
  h.state.holdRegistration = new Promise((resolve) => { release = resolve; });
  h.state.granted = [...FIVE];
  for (const listener of h.listeners.added) listener();
  // The registration outlasts the time the report is willing to wait.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await settle();
  assert.deepEqual(h.summary(), ["unknown [scripts unknown:pending]"], "not known, and not a blocker");

  // It finishes. The report that said "pending" is followed by the answer.
  release();
  await settle();
  await settle();
  assert.equal(h.summary().at(-1), "ready [scripts positive:registered]");
  assert.equal(h.summary().some((line) => line.includes("blocker")), false);
});

test("a report that could only say pending is followed by the answer when the registration ends, even if it changed nothing", async () => {
  const h = installWithRegistration({ granted: [...FIVE], settleLimitMs: 30 });
  await settle();
  await settle();
  assert.equal(h.summary().at(-1), "ready [scripts positive:registered]");
  const before = h.reports().length;

  // An update sets a registration off, and the phone is slow to begin it.
  let release;
  h.state.holdAlarms = new Promise((resolve) => { release = resolve; });
  for (const listener of h.listeners.installed) listener({ reason: "update" });
  await h.reporter().report();
  assert.equal(h.summary().at(-1), "unknown [scripts unknown:pending]", "the scripts are there; with a registration under way it still does not say so");
  assert.equal(h.reports().length, before + 1);

  // The registration runs and finds everything as it was.
  h.state.holdAlarms = null;
  release();
  await settle();
  await settle();
  assert.equal(h.summary().at(-1), "ready [scripts positive:registered]", "and the answer follows by itself");
});

test("the page scripts are a blocker only when a finished registration says so, or two readings agree with none under way", async () => {
  // A registration that finished and failed, with the sites allowed.
  const failed = installWithRegistration({ granted: [...FIVE], failRegistration: true });
  await settle();
  await settle();
  assert.equal(failed.summary().at(-1), "not_ready [scripts blocker:registration_failed]");

  // A registration that finished and found the sites not allowed: the
  // scripts are confirmed absent.
  const absent = installWithRegistration();
  await settle();
  await absent.reporter().report();
  assert.equal(absent.summary().at(-1).endsWith("[scripts blocker:not_registered]"), true);

  // No registration has said anything (its last try could not finish), and
  // the scripts read as absent: two readings a moment apart, both absent.
  const unfinished = installWithRegistration({ granted: [...FIVE], registered: [...IDS],
    stored: { [EARNED_PERMISSION_STATE_KEY]: { registrationVersion: 4, promptResult: "granted" } } });
  await settle();
  unfinished.reporter().registrationEnded(null);
  unfinished.state.registered = [];
  await unfinished.reporter().report();
  assert.equal(unfinished.summary().at(-1), "not_ready [scripts blocker:not_registered]");
  assert.deepEqual(unfinished.waits, [2_000], "read twice, two seconds apart");

  // The second reading finds them: one absent reading was not an answer.
  const flicker = installWithRegistration({ granted: [...FIVE], registered: [...IDS],
    stored: { [EARNED_PERMISSION_STATE_KEY]: { registrationVersion: 4, promptResult: "granted" } } });
  await settle();
  flicker.reporter().registrationEnded(null);
  flicker.state.registered = [];
  flicker.state.duringWait = () => { flicker.state.registered = [...IDS]; };
  await flicker.reporter().report();
  assert.equal(flicker.summary().at(-1), "ready [scripts positive:registered]");

  // A registration starts between the two readings: not known.
  const racing = installWithRegistration({ granted: [...FIVE], registered: [...IDS],
    stored: { [EARNED_PERMISSION_STATE_KEY]: { registrationVersion: 4, promptResult: "granted" } } });
  await settle();
  racing.reporter().registrationEnded(null);
  racing.state.registered = [];
  let hold;
  racing.state.duringWait = () => {
    racing.state.holdRegistration = new Promise((resolve) => { hold = resolve; });
    racing.state.settleLimitMs = 0;
    void racing.registration.reconcile();
  };
  const reporting = racing.reporter().report();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  hold();
  await reporting;
  assert.equal(racing.summary().some((line) => line.includes("blocker")), false, "never a blocker with a registration under way");
});

test("a report said to be ready is read again about once a day, since access can end with no event to say so", async () => {
  const h = installWithRegistration({ granted: [...FIVE] });
  await settle();
  await settle();
  const before = h.reports().length;
  assert.equal(h.summary().at(-1), "ready [scripts positive:registered]");

  // A one-day grant runs out. Safari tells no one.
  h.state.granted = [];
  await settle();
  assert.equal(h.reports().length, before, "nothing prompts a report");

  // The daily alarm the background already keeps.
  for (const listener of h.listeners.alarm) listener({ name: "traceArchiveAccessReport" });
  await settle();
  await settle();
  assert.equal(h.reports().length > before, true);
  assert.equal(h.reports().at(-1).result, "not_ready");
  assert.equal(h.reports().at(-1).components.websiteAccess.reason, "not_allowed");

  // Another alarm is none of its business.
  const after = h.reports().length;
  for (const listener of h.listeners.alarm) listener({ name: "traceAccountDataRefresh" });
  await settle();
  assert.equal(h.reports().length, after);
});

test("an update or a grant is known to be settling from the moment Safari says so, before its reconcile has begun", async () => {
  for (const [name, fire] of [
    ["an update", (h) => { for (const listener of h.listeners.installed) listener({ reason: "update" }); }],
    ["a grant", (h) => { for (const listener of h.listeners.added) listener(); }],
  ]) {
    const h = installWithRegistration({ granted: [...FIVE] });
    await settle();
    await settle();
    assert.equal(h.registration.pending(), false);
    assert.equal(await h.registration.settled(1_000), true);

    let release;
    h.state.registered = [];
    h.state.holdRegistration = new Promise((resolve) => { release = resolve; });
    fire(h);
    assert.equal(h.registration.pending(), true, `${name}: pending at once, with no reconcile yet begun`);
    assert.equal(await h.registration.settled(20), false, "not settled while it runs past the time allowed");
    release();
    assert.equal(await h.registration.settled(1_000), true);
    assert.equal(h.registration.pending(), false);
    assert.deepEqual(h.state.registered, IDS);
  }
});

test("the registration runtime says when each reconcile ends, and when none is under way", async () => {
  const ended = [];
  const stored = {};
  const registered = [];
  const runtime = { id: "trace-extension", onMessage: { addListener() {} } };
  let allowed = false;
  let failRegistration = false;
  const controller = installEarnedPermissionRegistrationRuntime({
    runtime,
    permissions: {
      async getAll() { return { origins: allowed ? [...FIVE] : [] }; },
      async contains() { return allowed; },
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    scripting: {
      async getRegisteredContentScripts() { return registered.map((id) => ({ id })); },
      async registerContentScripts(scripts) {
        if (failRegistration) throw new Error("registration refused");
        registered.push(...scripts.map(({ id }) => id));
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) registered.splice(registered.indexOf(id), 1);
      },
    },
    storage: new BrowserStorage({
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in stored).map((key) => [key, stored[key]]));
      },
      async set(patch) { Object.assign(stored, patch); },
      async remove(key) { delete stored[key]; },
    }, runtime, "promise"),
    storageMode: "promise",
    config: CONFIG,
    endedGrantConfirmDelayMs: 0,
    onReconcileEnded: (result) => ended.push(result),
  });
  await controller.idle();
  await settle();
  assert.equal(ended.length, 1, "the reconcile a background starts with");
  assert.equal(ended[0].error, "permission_incomplete");

  allowed = true;
  failRegistration = true;
  const failing = controller.reconcile();
  let idle = false;
  void controller.idle().then(() => { idle = true; });
  assert.equal(idle, false);
  assert.equal((await failing).error, "registration_failed");
  await settle();
  assert.equal(idle, true, "idle once the reconcile under way has ended");
});
