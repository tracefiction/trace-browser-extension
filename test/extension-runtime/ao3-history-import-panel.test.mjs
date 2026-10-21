import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { ao3HistoryLoopInTab } from "../../.trace-build/extension-runtime/ao3-history-import-runtime.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PANEL = fs.readFileSync(path.join(ROOT, "src", "ao3-history-import-panel.js"), "utf8");
const MESSAGE = "TRACE_AO3_HISTORY_IMPORT";
const TAB = 7;

const flush = async (window) => {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => window.setTimeout(resolve, 0));
};

// Each sheet polls the run while it is open; closing its window ends that.
const windows = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function view(overrides = {}) {
  return {
    status: "running", reason: null, pagesRead: 11, totalPages: 31, works: 214, later: 0, deleted: 0,
    unreadable: 0, waitingFor: null, waitingUntil: null, remainingMs: 186_000, startedAt: 0, finishedAt: null,
    ...overrides,
  };
}

/**
 * The sheet, as its markup places Import: the reader view's extras with
 * Settings, or the ordinary sheet's actions. `replies` answers each action.
 */
function sheet({ readerView = true, replies = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div id="popup-earned-extras" ${readerView ? "" : "hidden"}><button id="popup-earned-settings-row">Settings</button></div>
    <div class="popup-actions"><button id="popup-import-open-tabs">Import open tabs</button><p id="popup-open-tabs-help"></p></div>
  </body></html>`, { runScripts: "outside-only", url: "safari-web-extension://trace-test/popup.html" });
  const { window } = dom;
  windows.push(window);
  const sent = [];
  window.browser = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        const reply = replies[message.action];
        return typeof reply === "function" ? reply(message) : reply ?? { ok: true, view: { status: "idle" }, startable: true };
      },
    },
    tabs: { async query() { return [{ id: TAB }]; } },
  };
  window.eval(PANEL);
  const $ = (selector) => window.document.querySelector(selector);
  const visible = (node) => Boolean(node) && !node.hidden && !node.closest("[hidden]");
  const buttons = () => [...window.document.querySelectorAll("#popup-history button")]
    .filter(visible).map((node) => node.textContent);
  const text = () => [...window.document.querySelectorAll("#popup-history p")].filter(visible).map((node) => node.textContent);
  const click = async (label) => {
    const target = [...window.document.querySelectorAll("#popup-history button")].find((node) => visible(node) && node.textContent === label);
    assert.ok(target, `no ${label} button among ${buttons().join(", ")}`);
    target.click();
    await flush(window);
  };
  return { window, sent, $, buttons, text, click, visible };
}

test("the sheet offers the import only where it can start, and asks once before it reads", async () => {
  const away = sheet({ replies: { status: { ok: true, view: { status: "idle" }, startable: false } } });
  await flush(away.window);
  assert.equal(away.visible(away.$("#popup-history")), false, "not on AO3, or not connected: nothing shows");

  const s = sheet({ replies: { start: { ok: true, view: view({ pagesRead: 0, works: 0, totalPages: null, remainingMs: null }) } } });
  await flush(s.window);
  assert.deepEqual(s.buttons(), ["Import your whole History"]);
  assert.match(s.text().join(" "), /Nothing is added until you choose in Trace/);
  assert.equal(s.sent.filter((m) => m.action === "start").length, 0);
  await s.click("Import your whole History");
  assert.deepEqual(s.buttons(), ["Start reading", "Not now"]);
  assert.match(s.text().join(" "), /about one page every 10 seconds/);
  await s.click("Not now");
  assert.deepEqual(s.buttons(), ["Import your whole History"]);
  await s.click("Import your whole History");
  await s.click("Start reading");
  const start = s.sent.find((m) => m.action === "start");
  assert.deepEqual({ ...start }, { type: MESSAGE, action: "start", tabId: TAB });
  assert.equal(s.$("#popup-history-heading").textContent, "Reading your History");
});

test("while reading it shows the page, the stories so far and the time left, with Pause and Stop and delete", async () => {
  const s = sheet({
    replies: {
      status: { ok: true, view: view(), startable: true },
      pause: { ok: true, view: view({ status: "paused", reason: "paused_by_you" }) },
    },
  });
  await flush(s.window);
  assert.deepEqual(s.text().slice(1, 3), [
    "Page 12 of 31 · 214 stories so far",
    "About 3 minutes left. Keep this AO3 tab open; reading pauses while it’s hidden.",
  ]);
  assert.equal(s.$(".popup-history-fill").style.width, "35.5%");
  assert.deepEqual(s.buttons(), ["Pause", "Stop and delete"]);
  await s.click("Pause");
  assert.equal(s.$("#popup-history-heading").textContent, "Paused");
  assert.equal(s.text()[1], "Paused on page 12. Your stories so far are kept.");
  assert.deepEqual(s.buttons(), ["Carry on", "Stop and delete"]);
});

test("waiting on AO3 says why, and when", async () => {
  const s = sheet({ replies: { status: { ok: true, view: view({ waitingFor: "slow_down", waitingUntil: Date.now() + 120_000 }), startable: true } } });
  await flush(s.window);
  assert.equal(s.text()[2], "AO3 asked Trace to slow down. Trying again in 2 minutes.");
});

test("Stop and delete asks first, and Keep leaves the run alone", async () => {
  const s = sheet({
    replies: {
      status: { ok: true, view: view(), startable: true },
      delete: { ok: true, view: { status: "idle" }, startable: true },
    },
  });
  await flush(s.window);
  await s.click("Stop and delete");
  assert.equal(s.$("#popup-history-heading").textContent, "Delete what Trace found?");
  assert.match(s.text()[1], /214 stories from your History will be removed from this device\. Nothing in your Library changes\./);
  assert.equal(s.sent.some((m) => m.action === "delete"), false);
  await s.click("Keep");
  assert.equal(s.$("#popup-history-heading").textContent, "Reading your History");
  await s.click("Stop and delete");
  await s.click("Delete");
  assert.equal(s.sent.some((m) => m.action === "delete"), true);
  assert.deepEqual(s.buttons(), ["Import your whole History"]);
});

test("a paused run says what to do in the reader's words, and offers Carry on only when it can help", async () => {
  const signedOut = sheet({ replies: { status: { ok: true, view: view({ status: "paused", reason: "signed_out" }), startable: true } } });
  await flush(signedOut.window);
  assert.equal(signedOut.text()[1], "Sign in to AO3 in this tab, then tap Carry on.");
  assert.deepEqual(signedOut.buttons(), ["Carry on", "Stop and delete"]);

  const empty = sheet({ replies: { status: { ok: true, view: view({ status: "paused", reason: "history_empty", pagesRead: 0, works: 0 }), startable: true } } });
  await flush(empty.window);
  assert.deepEqual(empty.text().slice(1), ["Your AO3 History is empty or turned off. You can turn it on in AO3’s Preferences."]);
  assert.deepEqual(empty.buttons(), ["Stop and delete"]);

  const strange = sheet({ replies: { status: { ok: true, view: view({ status: "paused", reason: "pagination_unexpected" }), startable: true } } });
  await flush(strange.window);
  assert.equal(strange.text()[1], "Trace can’t read AO3’s History right now. Nothing was added to your Library.");
});

test("a finished run says what it found and what it left out", async () => {
  const s = sheet({
    replies: {
      status: {
        ok: true,
        view: view({ status: "finished", reason: "reached_last_page", pagesRead: 31, works: 588, later: 2, deleted: 11, unreadable: 2, remainingMs: null }),
        startable: true,
      },
    },
  });
  await flush(s.window);
  assert.equal(s.$("#popup-history-heading").textContent, "Your History is ready");
  assert.equal(s.text()[1], "588 stories found. 2 marked for later · 11 deleted works left out · 2 rows Trace couldn’t read.");
  assert.equal(s.$(".popup-history-fill").style.width, "100%");
  assert.deepEqual(s.buttons(), ["Delete"]);
});

test("a start that cannot happen says why", async () => {
  const s = sheet({ replies: { start: { ok: false, error: "signed_out", view: { status: "idle" } } } });
  await flush(s.window);
  await s.click("Import your whole History");
  await s.click("Start reading");
  assert.ok(s.text().includes("Sign in to AO3 in this tab first, then try again."));
});

test("it sits above Settings in the reader view, and after the other imports in the ordinary sheet", async () => {
  const reader = sheet();
  await flush(reader.window);
  assert.equal(reader.$("#popup-history").nextElementSibling, reader.$("#popup-earned-settings-row"));
  const ordinary = sheet({ readerView: false });
  await flush(ordinary.window);
  assert.equal(ordinary.$("#popup-history").previousElementSibling, ordinary.$("#popup-open-tabs-help"));
});

// --- The reading bar on the AO3 page ----------------------------------------------

function ao3Page(replies) {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"main\">History</div></body></html>", {
    url: "https://archiveofourown.org/users/Synthetic_Reader/readings",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  windows.push(window);
  const sent = [];
  window.browser = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        return replies.shift() ?? { stop: true };
      },
    },
  };
  const saved = {};
  for (const name of ["document", "browser", "HTMLElement", "fetch"]) saved[name] = globalThis[name];
  globalThis.document = window.document;
  globalThis.browser = window.browser;
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  };
  return { window, sent, restore };
}

function bar(window) {
  const root = window.document.getElementById("__traceAo3HistoryImportBarV1")?.shadowRoot ?? null;
  if (root === null) return null;
  return {
    title: root.querySelector(".title").textContent,
    line: root.querySelector(".line").textContent,
    button: root.querySelector("button"),
    fill: root.querySelector(".fill").style.width,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the reading bar shows the page and stories, and its Pause pauses the run and stops the loop", async () => {
  const page = ao3Page([{ wait: 600_000, view: view() }, { stop: true, view: view({ status: "paused", reason: "paused_by_you" }) }]);
  try {
    assert.equal(ao3HistoryLoopInTab(MESSAGE, 2_097_152, 20_000), "started");
    await settle();
    let shown = bar(page.window);
    assert.deepEqual([shown.title, shown.line, shown.button.textContent], ["Reading your History", "Page 12 of 31 · 214 stories", "Pause"]);
    assert.equal(shown.fill, "35.5%");
    shown.button.click();
    await settle();
    assert.deepEqual(page.sent.map((m) => m.action), ["tab_tick", "tab_pause"]);
    shown = bar(page.window);
    assert.deepEqual([shown.title, shown.line, shown.button.textContent], ["Paused", "214 stories kept. Open Trace to carry on.", "Hide"]);
    shown.button.click();
    assert.equal(bar(page.window), null, "Hide takes the bar away");
    assert.equal(globalThis.__traceAo3HistoryImportLoopV1, undefined, "the loop is gone");
  } finally {
    page.restore();
  }
});

test("the reading bar says when the History is ready, and goes when there is no run", async () => {
  const page = ao3Page([{ stop: true, view: view({ status: "finished", reason: "reached_last_page", pagesRead: 31, works: 588, remainingMs: null }) }]);
  try {
    ao3HistoryLoopInTab(MESSAGE, 2_097_152, 20_000);
    await settle();
    const shown = bar(page.window);
    assert.deepEqual([shown.title, shown.line, shown.fill], ["Your History is ready", "588 stories. Open Trace to review them.", "100%"]);
    assert.equal(page.window.document.getElementById("__traceAo3HistoryImportBarV1").textContent, "", "no work or name on the page itself");
  } finally {
    page.restore();
  }
  const none = ao3Page([{ stop: true, view: { status: "idle" } }]);
  try {
    ao3HistoryLoopInTab(MESSAGE, 2_097_152, 20_000);
    await settle();
    assert.equal(bar(none.window), null);
  } finally {
    none.restore();
  }
});
