import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";

const HTML = fs.readFileSync(new URL("../../src/keep-a-copy/popup.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/, "");
const NOW = new Date(2026, 9, 30, 14, 3).getTime();
const at = (hours, minutes, days = 0) => new Date(2026, 9, 30 + days, hours, minutes).getTime();

const SETTINGS = { enabled: true, triggers: { bookmark: true, later: true, subscribe: true, kudos: true, open: false }, weeklyCheck: false, format: "epub" };
const VIEW = {
  settings: SETTINGS, user: "Reader", kept: 1210, withCopy: 1204, waiting: 0, skipped: {}, run: null, stopped: null, backup: null,
  lastCopyAt: at(14, 2), canHideDownloads: true,
};

let imports = 0;

/** Loads the popup against a stand-in background, returning its page and the messages it sent. */
async function open(first, { onMessage } = {}) {
  const dom = new JSDOM(HTML, { url: "chrome-extension://keep/popup.html" });
  const box = { view: first, sent: [], document: dom.window.document };
  const realNow = Date.now;
  Date.now = () => NOW;
  globalThis.document = dom.window.document;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        box.sent.push(message);
        return onMessage?.(message, box) ?? box.view;
      },
    },
  };
  const interval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  imports += 1;
  await import(`../../.trace-build/extension-runtime/keep-a-copy-popup.mjs?open=${imports}`);
  globalThis.setInterval = interval;
  await new Promise((resolve) => setImmediate(resolve));
  box.text = (id) => dom.window.document.getElementById(id).textContent;
  box.shown = (id) => !dom.window.document.getElementById(id).hasAttribute("hidden");
  box.click = async (id) => {
    dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click"));
    await new Promise((resolve) => setImmediate(resolve));
  };
  box.done = () => { Date.now = realNow; };
  return box;
}

const HOME_SECTIONS = ["off", "notice", "status", "backupBlock", "triggers", "formatRow", "backupStart", "skippedRow", "foldRow"];
const shownOf = (box) => HOME_SECTIONS.filter((id) => box.shown(id));

test("off: the one line and the footer", async () => {
  const box = await open({ ...VIEW, settings: { ...SETTINGS, enabled: false } });
  assert.deepEqual(shownOf(box), ["off"]);
  assert.equal(box.text("off"), "Keeps AO3's own file of the works you keep, on this computer.");
  assert.equal(box.document.getElementById("enabled").getAttribute("aria-pressed"), "false");
  assert.equal(box.document.getElementById("enabled").getAttribute("aria-label"), "Keep copies");
  assert.equal(box.text("name"), "NAME");
  assert.match(box.document.querySelector(".foot").textContent, /Open source on GitHub.*From the maker of Trace/);
  box.done();
});

test("on: the status, what starts a copy, the format, the backup, and what was skipped", async () => {
  const box = await open({ ...VIEW, skipped: { needs_sign_in: 4, gone: 1, not_a_file: 1 } });
  assert.deepEqual(shownOf(box), ["status", "triggers", "formatRow", "backupStart", "skippedRow"]);
  assert.equal(box.text("kept"), "1,204 works kept");
  assert.equal(box.text("lastCopy"), "Last copy 14:02, in Downloads › NAME");
  assert.equal(box.text("skippedRowText"), "6 skipped");
  assert.equal(box.text("backupCaption"), "Bookmarks, Marked for Later and Subscriptions.");
  assert.deepEqual([...box.document.querySelectorAll("#triggers label")].map((label) => label.textContent), ["Bookmark it", "Mark it for Later", "Subscribe", "Leave kudos", "Every work I open"]);
  assert.equal(box.document.querySelector('[data-trigger="open"]').checked, false);
  assert.equal(box.document.querySelector('[data-trigger="kudos"]').checked, true);
  box.done();
});

test("no copies yet: no last-copy line, and no skipped row with nothing skipped", async () => {
  const box = await open({ ...VIEW, withCopy: 0, lastCopyAt: null });
  assert.equal(box.text("kept"), "0 works kept");
  assert.equal(box.shown("lastCopy"), false);
  assert.equal(box.shown("skippedRow"), false);
  box.done();
});

test("the last copy says yesterday, or its date", async () => {
  let box = await open({ ...VIEW, lastCopyAt: at(21, 40, -1) });
  assert.equal(box.text("lastCopy"), "Last copy yesterday, 21:40, in Downloads › NAME");
  box.done();
  box = await open({ ...VIEW, lastCopyAt: at(9, 5, -5) });
  assert.equal(box.text("lastCopy"), "Last copy 25 Oct, 09:05, in Downloads › NAME");
  box.done();
});

const running = { state: "running", done: 412, total: 1880, readingLists: false, estimateMs: 2 * 3_600_000 };

test("a backup running in Firefox: the count, the estimate, the Firefox line, Pause, and the fold", async () => {
  const box = await open({ ...VIEW, canHideDownloads: false, backup: running });
  assert.deepEqual(shownOf(box), ["backupBlock", "foldRow"]);
  assert.equal(box.text("backupEyebrow"), "Backing up my lists");
  assert.equal(box.text("backupCount"), "412 of 1,880 works");
  assert.equal(box.document.getElementById("backupBar").style.width, "22%");
  assert.equal(box.text("backupLine"), "About 2 hours at AO3's pace. It carries on while Firefox is open.");
  assert.equal(box.text("downloadsLine"), "Firefox's downloads panel fills up during a backup. That's expected.");
  assert.equal(box.shown("downloadsLine"), true);
  assert.equal(box.text("backupToggle"), "Pause");
  box.done();
});

test("in Chrome: its name, and no Firefox line", async () => {
  const box = await open({ ...VIEW, backup: running });
  assert.equal(box.text("backupLine"), "About 2 hours at AO3's pace. It carries on while Chrome is open.");
  assert.equal(box.shown("downloadsLine"), false);
  box.done();
});

test("estimates are rounded, and absent while the lists are read", async () => {
  for (const [ms, words] of [[40 * 60_000, "About 40 minutes"], [42 * 60_000, "About 40 minutes"], [3 * 60_000, "About 3 minutes"], [60_000, "About a minute"], [70 * 60_000, "About 1 hour"], [50 * 3_600_000, "About 2 days"]]) {
    const box = await open({ ...VIEW, backup: { ...running, estimateMs: ms } });
    assert.equal(box.text("backupLine"), `${words} at AO3's pace. It carries on while Chrome is open.`);
    box.done();
  }
  const box = await open({ ...VIEW, backup: { ...running, done: 0, total: 240, readingLists: true, estimateMs: null } });
  assert.equal(box.text("backupCount"), "0 of 240 works");
  assert.equal(box.text("backupLine"), "It carries on while Chrome is open.");
  box.done();
});

test("stopped: where it stopped, and Resume", async () => {
  const box = await open({ ...VIEW, backup: { ...running, state: "stopped", estimateMs: null } }, {
    onMessage: (message, state) => {
      if (message.type === "KEEP_A_COPY_RESUME_BACKUP") state.view = { ...VIEW, backup: running };
    },
  });
  assert.deepEqual(shownOf(box), ["backupBlock", "foldRow"]);
  assert.equal(box.text("backupEyebrow"), "Back up my lists");
  assert.equal(box.text("backupCount"), "Stopped at 412 of 1,880");
  assert.equal(box.text("backupLine"), "Resume picks up where it stopped. Works already copied stay as they are.");
  assert.equal(box.shown("downloadsLine"), false);
  assert.equal(box.text("backupToggle"), "Resume");
  await box.click("backupToggle");
  assert.equal(box.sent.some((message) => message.type === "KEEP_A_COPY_RESUME_BACKUP"), true);
  assert.equal(box.text("backupToggle"), "Pause");
  await box.click("backupToggle");
  assert.equal(box.sent.some((message) => message.type === "KEEP_A_COPY_STOP_BACKUP"), true);
  box.done();
});

test("paused by AO3: the time to resume, with the pause mark", async () => {
  const box = await open({ ...VIEW, lastCopyAt: at(13, 48), stopped: { code: "slow_down", until: at(14, 5) } });
  assert.deepEqual(shownOf(box), ["notice", "status", "foldRow"]);
  assert.equal(box.text("noticeText"), "AO3 asked to slow down. Resuming around 14:05.");
  assert.equal(box.shown("noticePause"), true);
  assert.equal(box.shown("noticeClock"), false);
  assert.equal(box.text("lastCopy"), "Last copy 13:48, in Downloads › NAME");
  box.done();
});

test("AO3 isn't available: no time, no estimate, never \"down\"", async () => {
  const box = await open({ ...VIEW, lastCopyAt: at(21, 40, -1), stopped: { code: "slow_down", until: at(14, 5), unavailable: true } });
  assert.deepEqual(shownOf(box), ["notice", "status", "foldRow"]);
  assert.equal(box.text("noticeText"), "AO3 isn't available right now. Copies carry on when it's back.");
  assert.equal(box.shown("noticePause"), false);
  assert.equal(box.shown("noticeClock"), true);
  assert.doesNotMatch(box.document.body.textContent, /\bdown\b(?!loads|load)/i);
  box.done();
});

test("AO3 pausing a backup: the resume time takes the estimate's place", async () => {
  const box = await open({ ...VIEW, canHideDownloads: false, backup: { ...running, estimateMs: null }, stopped: { code: "slow_down", until: at(14, 5) } });
  assert.deepEqual(shownOf(box), ["notice", "backupBlock", "foldRow"]);
  assert.equal(box.text("noticeText"), "AO3 asked to slow down. Resuming around 14:05.");
  assert.equal(box.shown("backupLine"), false);
  assert.equal(box.shown("downloadsLine"), false);
  box.done();
});

test("what starts a copy opens from its row and back", async () => {
  const box = await open({ ...VIEW, backup: running });
  await box.click("foldRow");
  assert.deepEqual(shownOf(box), ["triggers", "formatRow"]);
  assert.equal(box.text("subTitle"), "What starts a copy");
  assert.equal(box.shown("homeHead"), false);
  await box.click("back");
  assert.deepEqual(shownOf(box), ["backupBlock", "foldRow"]);
  box.done();
});

test("the skipped list: each reason, its count, and Try again only for the file AO3 couldn't make", async () => {
  const box = await open({ ...VIEW, skipped: { needs_sign_in: 4, gone: 1, not_a_file: 1 } }, {
    onMessage: (message, state) => {
      if (message.type === "KEEP_A_COPY_RETRY_SKIPPED") state.view = { ...VIEW, skipped: { needs_sign_in: 4, gone: 1 } };
    },
  });
  await box.click("skippedRow");
  assert.deepEqual(shownOf(box), []);
  assert.equal(box.text("subTitle"), "6 skipped");
  assert.equal(box.text("skippedLockedText"), "4 works. They copy on their own once you're signed in.");
  assert.equal(box.text("skippedGoneText"), "1 work. There's nothing to copy right now.");
  assert.equal(box.text("skippedFileText"), "1 work.");
  assert.equal(box.document.querySelectorAll("#skippedLocked button, #skippedGone button").length, 0);
  await box.click("tryAgain");
  assert.equal(box.sent.some((message) => message.type === "KEEP_A_COPY_RETRY_SKIPPED"), true);
  assert.equal(box.shown("skippedFile"), false);
  assert.equal(box.text("subTitle"), "5 skipped");
  box.done();
});

test("the switch, and Back up my lists before any AO3 page has been seen", async () => {
  const box = await open(VIEW, {
    onMessage: (message, state) => {
      if (message.type === "KEEP_A_COPY_BACKUP") return "no_user";
      if (message.type === "KEEP_A_COPY_SETTINGS") state.view = { ...VIEW, settings: { ...SETTINGS, ...message.patch } };
      return undefined;
    },
  });
  await box.click("backup");
  assert.equal(box.text("backupCaption"), "Open any AO3 page while signed in first, then try again.");
  await box.click("enabled");
  assert.deepEqual(box.sent.find((message) => message.type === "KEEP_A_COPY_SETTINGS").patch, { enabled: false });
  assert.deepEqual(shownOf(box), ["off"]);
  box.done();
});

test("the words the popup shows avoid what the design rules out", () => {
  assert.doesNotMatch(HTML, /\b(we|our team|scrape|download everything|bulk)\b/i);
});
