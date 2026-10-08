// End-of-story placement and trigger, against synthetic AO3/FFN fixtures.
//
// The finish note sits right after the final chapter's text (before end
// notes, kudos and comments) and only qualifies once the last lines have
// stayed in view for a short dwell after the reader's own navigation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { withDefaultScopedStorageContext } = require("./collector-functions.js");

const RESOURCES = path.join(__dirname, "..", "Shared (Extension)", "Resources");
const FIXTURES = path.join(__dirname, "fixtures", "end-of-story");
const COLLECTOR_SRC = fs.readFileSync(path.join(RESOURCES, "collector.js"), "utf8");
const FINISH_SRC = fs.readFileSync(path.join(RESOURCES, "trace-finish-qualify.js"), "utf8");
const DWELL_MS = 2_000;
const VIEWPORT = 800;

function plainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function entryFor(entryId, status, chapters) {
  return {
    entryId,
    status,
    readerStatus: status,
    canonicalReaderStatus: status,
    chapters,
  };
}

// Loads a fixture with the real collector and finish module. The finish
// module runs on an injected clock; the test owns the final text geometry.
function openStory({
  fixture,
  url,
  workKey,
  entry,
  bodySelector,
  initialRect,
  finishResponder,
  statusResponder,
  prepare,
}) {
  const html = fs.readFileSync(path.join(FIXTURES, fixture), "utf8");
  const dom = new JSDOM(html, { url, contentType: "text/html", runScripts: "outside-only" });
  const { window } = dom;
  const sent = [];
  const clock = { now: 10_000, timers: new Map(), nextId: 1 };
  let rect = Object.assign({}, initialRect);
  const geometry = {
    set(next) {
      rect = Object.assign({}, next);
    },
  };

  if (typeof prepare === "function") prepare(window.document);
  const body = window.document.querySelector(bodySelector);
  assert.ok(body, `fixture ${fixture} has ${bodySelector}`);
  body.getBoundingClientRect = () => Object.assign({ left: 0, right: 600 }, rect);
  // AO3's guarded fallback watches #chapters too; keep it consistent with the
  // text so jsdom's zero rect cannot stand in for reading evidence.
  const chapters = window.document.querySelector("#chapters");
  if (chapters && chapters !== body) {
    chapters.getBoundingClientRect = () => ({
      top: rect.top - 600,
      bottom: rect.bottom + 180,
      left: 0,
      right: 600,
    });
  }
  Object.defineProperty(window, "innerHeight", { value: VIEWPORT, configurable: true });
  Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });

  const storage = {
    authToken: "test-token",
    libraryOverlayCache: { entries: { [workKey]: entry } },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" && callback) {
          callback(finishResponder(message.payload));
          return;
        }
        if (message.type === "TRACE_SET_READER_STATUS" && callback) {
          callback(statusResponder ? statusResponder(message.payload) : { ok: true });
        }
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback(storage);
        },
        set(_value, callback) {
          if (callback) callback();
        },
      },
      onChanged: { addListener() {} },
    },
  };
  window.chrome = withDefaultScopedStorageContext(chrome);
  delete window.browser;

  window.eval(FINISH_SRC);
  const onReachEnd = window.TraceFinishQualify.onReachEnd;
  window.TraceFinishQualify.onReachEnd = (element, callback) =>
    onReachEnd(element, callback, {
      now: () => clock.now,
      setTimer(fn, delay) {
        const id = clock.nextId++;
        clock.timers.set(id, { fn, at: clock.now + delay });
        return id;
      },
      clearTimer(id) {
        clock.timers.delete(id);
      },
    });
  window.eval(COLLECTOR_SRC);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));

  function advance(ms) {
    const target = clock.now + ms;
    for (;;) {
      const due = [...clock.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock.timers.delete(due[0]);
      clock.now = due[1].at;
      due[1].fn();
    }
    clock.now = target;
  }

  function wheel() {
    body.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true }));
  }

  function touch() {
    const target = body.querySelector("p") || body;
    target.dispatchEvent(new window.Event("touchend", { bubbles: true }));
  }

  function scrollTo(next) {
    geometry.set(next);
    window.dispatchEvent(new window.Event("scroll"));
  }

  function finishSignals(state) {
    return sent.filter(
      (message) =>
        message.type === "TRACE_FINISH_QUALIFICATION_SIGNAL" &&
        (!state || message.payload.state === state),
    );
  }

  return { dom, window, document: window.document, body, sent, advance, wheel, touch, scrollTo, finishSignals };
}

function resolvedResponder(entryId, workKey, status, chapters) {
  return (payload) => ({
    ok: true,
    command: {
      kind: "acknowledged",
      state: payload.state,
      eventId: null,
      workKey,
      entry: entryFor(entryId, payload.state === "resolved" ? status : "READING", chapters),
    },
  });
}

function follows(a, b) {
  // true when b comes after a in document order
  return !!(a.compareDocumentPosition(b) & 4);
}

// The reader is mid-way through the final text; its end is below the fold.
const BELOW = { top: -300, bottom: 2_400 };
const END_IN_VIEW = { top: -700, bottom: 760 };
const SCROLLED_PAST = { top: -2_100, bottom: -600 };

test("AO3 last chapter: the note sits right after the final text, before chapter and work end notes", () => {
  const entryId = "00000000-0000-4000-8000-00000000e001";
  const page = openStory({
    fixture: "ao3_last_chapter.html",
    url: "https://archiveofourown.org/works/5550001/chapters/7770003",
    workKey: "ao3:5550001",
    entry: entryFor(entryId, "READING", { current: 3, total: 3 }),
    bodySelector: "[data-fixture-final-text]",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ao3:5550001", "FINISHED", { current: 3, total: 3 }),
  });

  assert.equal(page.finishSignals().length, 0, "opening the last chapter does not finish it");
  page.wheel();
  page.scrollTo(END_IN_VIEW);
  assert.equal(page.finishSignals().length, 0, "arriving at the last lines starts a dwell, not a finish");
  page.advance(DWELL_MS - 1);
  assert.equal(page.finishSignals().length, 0);
  page.advance(1);

  const signals = page.finishSignals();
  assert.equal(signals.length, 1);
  assert.deepEqual(plainJson(signals[0].payload), {
    entryId,
    workKey: "ao3:5550001",
    source: "ao3",
    chapter: 3,
    total: 3,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });

  const note = page.document.querySelector("[data-trace-finish-done]");
  assert.ok(note, "the automatic finish is confirmed inline");
  assert.equal(page.document.querySelector("[data-trace-finish-toast]"), null, "no floating toast");
  assert.equal(page.body.nextElementSibling, note, "note directly follows the chapter text");
  assert.ok(follows(note, page.document.querySelector("#chapter_3_endnotes")), "before chapter end notes");
  assert.ok(follows(note, page.document.querySelector("#work_endnotes")), "before work end notes");
  assert.ok(follows(note, page.document.querySelector("#feedback")), "before kudos and comments");
  assert.equal(note.getAttribute("data-trace-finish-done"), "finished");
  assert.match(note.textContent, /You’ve reached the end/);
  assert.match(note.textContent, /Marked\s*Finished/);
  assert.ok(note.querySelector("[data-trace-finish-undo]"), "Undo is offered");
  assert.ok(note.querySelector("[data-trace-finish-open]"), "Open in Trace is offered");
  assert.equal(note.getAttribute("role"), "group");
  assert.doesNotMatch(note.getAttribute("style") || "", /position:\s*fixed/);
  const live = page.document.querySelector("[data-trace-page-live-region]");
  assert.ok(live, "the page live region exists");
  assert.ok(!note.contains(page.document.activeElement), "the note never steals focus");
});

test("AO3 last chapter: scrolling straight past the last lines does not finish", () => {
  const entryId = "00000000-0000-4000-8000-00000000e002";
  const page = openStory({
    fixture: "ao3_last_chapter.html",
    url: "https://archiveofourown.org/works/5550001/chapters/7770003",
    workKey: "ao3:5550001",
    entry: entryFor(entryId, "READING", { current: 3, total: 3 }),
    bodySelector: "[data-fixture-final-text]",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ao3:5550001", "FINISHED", { current: 3, total: 3 }),
  });

  // A fling from mid-chapter to the comments.
  page.wheel();
  page.scrollTo(SCROLLED_PAST);
  page.advance(10_000);
  assert.equal(page.finishSignals().length, 0, "passing the end is not reading it");

  // Glancing at the end and moving on before the dwell is not enough either.
  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS / 2);
  page.wheel();
  page.scrollTo(SCROLLED_PAST);
  page.advance(10_000);
  assert.equal(page.finishSignals().length, 0, "a brief pass resets the dwell");
  assert.equal(page.document.querySelector("[data-trace-finish-done]"), null);

  // Coming back up and staying on the last lines qualifies once the reader's
  // own scrolling continues over the text.
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS);
  assert.equal(page.finishSignals().length, 0, "an unattributed return does not qualify");
  page.wheel();
  page.advance(DWELL_MS);
  assert.equal(page.finishSignals().length, 1);
});

test("AO3 last chapter: Undo restores the previous status and does not re-finish on this page", () => {
  const entryId = "00000000-0000-4000-8000-00000000e003";
  const statusRequests = [];
  const page = openStory({
    fixture: "ao3_last_chapter.html",
    url: "https://archiveofourown.org/works/5550001/chapters/7770003",
    workKey: "ao3:5550001",
    entry: entryFor(entryId, "READING", { current: 3, total: 3 }),
    bodySelector: "[data-fixture-final-text]",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ao3:5550001", "FINISHED", { current: 3, total: 3 }),
    statusResponder(payload) {
      statusRequests.push(payload);
      return { ok: true };
    },
  });

  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS);
  const note = page.document.querySelector("[data-trace-finish-done]");
  const undo = note.querySelector("[data-trace-finish-undo]");
  assert.match(undo.getAttribute("aria-label"), /^Undo, keep this story as Reading$/);
  undo.click();

  assert.deepEqual(plainJson(statusRequests), [
    { workKey: "ao3:5550001", entryId, status: "READING" },
  ]);
  assert.match(note.textContent, /Undone/);
  assert.match(note.textContent, /Your status is\s*Reading/);
  assert.equal(note.querySelector("[data-trace-finish-undo]"), null);
  assert.equal(page.document.activeElement, note, "focus stays on the note after Undo removes its button");

  page.scrollTo(BELOW);
  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS * 3);
  assert.equal(page.finishSignals().length, 1, "the spent evidence does not finish the work again");
});

test("AO3 last chapter: a failed Undo keeps the finish and offers Undo again", () => {
  const entryId = "00000000-0000-4000-8000-00000000e004";
  const page = openStory({
    fixture: "ao3_last_chapter.html",
    url: "https://archiveofourown.org/works/5550001/chapters/7770003",
    workKey: "ao3:5550001",
    entry: entryFor(entryId, "PAUSED", { current: 3, total: 3 }),
    bodySelector: "[data-fixture-final-text]",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ao3:5550001", "FINISHED", { current: 3, total: 3 }),
    statusResponder: () => ({ ok: false, error: "network_error" }),
  });

  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS);
  const note = page.document.querySelector("[data-trace-finish-done]");
  const undo = note.querySelector("[data-trace-finish-undo]");
  assert.match(undo.getAttribute("aria-label"), /Paused$/);
  undo.click();
  assert.ok(note.querySelector("[data-trace-finish-undo-error]"));
  assert.match(note.textContent, /Couldn’t undo/);
  assert.equal(undo.disabled, false);
  assert.equal(undo.textContent, "Undo");
  assert.match(note.textContent, /Marked\s*Finished/);
});

test("AO3 Entire Work: only the final chapter's last lines count, and the note precedes its end notes", () => {
  const entryId = "00000000-0000-4000-8000-00000000e005";
  const page = openStory({
    fixture: "ao3_entire_work.html",
    url: "https://archiveofourown.org/works/5550001?view_full_work=true",
    workKey: "ao3:5550001",
    entry: entryFor(entryId, "READING", { current: 3, total: 3 }),
    bodySelector: "[data-fixture-final-text]",
    initialRect: { top: 2_600, bottom: 4_100 },
    finishResponder: resolvedResponder(entryId, "ao3:5550001", "FINISHED", { current: 3, total: 3 }),
  });

  page.advance(DWELL_MS * 2);
  assert.equal(page.finishSignals().length, 0, "rendering the full work does not finish it");
  page.scrollTo({ top: 200, bottom: 1_700 });
  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS);

  const signals = page.finishSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].payload.chapter, 3);
  assert.equal(signals[0].payload.total, 3);
  const note = page.document.querySelector("[data-trace-finish-done]");
  const articles = page.document.querySelectorAll("#chapters [role='article']");
  assert.equal(articles.length, 3);
  assert.equal(articles[2].nextElementSibling, note);
  assert.ok(follows(note, page.document.querySelector("#chapter_3_endnotes")));
  assert.ok(follows(note, page.document.querySelector("#work_endnotes")));
});

test("AO3 one-shot: the note follows the work text, before the work end notes", () => {
  const entryId = "00000000-0000-4000-8000-00000000e006";
  const page = openStory({
    fixture: "ao3_oneshot.html",
    url: "https://archiveofourown.org/works/5550002",
    workKey: "ao3:5550002",
    entry: entryFor(entryId, "SAVED", { current: 0, total: 1 }),
    bodySelector: "#chapters",
    initialRect: { top: 300, bottom: 1_500 },
    finishResponder: resolvedResponder(entryId, "ao3:5550002", "FINISHED", { current: 1, total: 1 }),
  });

  page.wheel();
  page.scrollTo({ top: -200, bottom: 700 });
  page.advance(DWELL_MS);
  const signals = page.finishSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].payload.chapter, 1);
  assert.equal(signals[0].payload.total, 1);
  assert.equal(signals[0].payload.workStatus, "complete");
  const note = page.document.querySelector("[data-trace-finish-done]");
  assert.equal(page.document.querySelector("#chapters").nextElementSibling, note);
  assert.ok(follows(note, page.document.querySelector("#work_endnotes")));
  assert.match(
    note.querySelector("[data-trace-finish-undo]").getAttribute("aria-label"),
    /Saved$/,
    "Undo returns a story that was only Saved to Saved",
  );
});

test("AO3 WIP at its last posted chapter: marked Caught up, never Finished", () => {
  const entryId = "00000000-0000-4000-8000-00000000e007";
  const page = openStory({
    fixture: "ao3_wip_last_posted.html",
    url: "https://archiveofourown.org/works/5550003/chapters/9990004",
    workKey: "ao3:5550003",
    entry: entryFor(entryId, "READING", { current: 4, total: 7 }),
    bodySelector: "[data-fixture-final-text]",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ao3:5550003", "CAUGHT_UP", { current: 4, total: 7 }),
  });

  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS);
  const signals = page.finishSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].payload.workStatus, "wip");
  assert.equal(signals[0].payload.chapter, 4);
  assert.equal(signals[0].payload.total, 4, "total is the last posted chapter");
  const note = page.document.querySelector("[data-trace-finish-done]");
  assert.equal(note.getAttribute("data-trace-finish-done"), "caughtup");
  assert.match(note.textContent, /You’re caught up/);
  assert.match(note.textContent, /Marked\s*Caught up/);
  assert.match(note.textContent, /More chapters may follow/);
  assert.doesNotMatch(note.textContent, /reached the end|Finished/);
  assert.ok(follows(note, page.document.querySelector("#chapter_4_endnotes")));
});

test("AO3 mid-story chapter keeps today's behaviour: no end-of-story note or signal", () => {
  const entryId = "00000000-0000-4000-8000-00000000e008";
  const page = openStory({
    fixture: "ao3_wip_last_posted.html",
    url: "https://archiveofourown.org/works/5550003/chapters/9990004",
    workKey: "ao3:5550003",
    entry: entryFor(entryId, "READING", { current: 4, total: 7 }),
    bodySelector: "[data-fixture-final-text]",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ao3:5550003", "CAUGHT_UP", { current: 5, total: 7 }),
    prepare(document) {
      // Five chapters are posted; the reader is on chapter four.
      document.querySelector("dd.chapters").textContent = "5/7";
    },
  });

  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS * 3);
  assert.equal(page.finishSignals().length, 0);
  assert.equal(page.document.querySelector("[data-trace-finish-done],[data-trace-finish-qualify]"), null);
});

test("FFN last chapter of a complete story: note after the text, before chapter navigation and reviews", () => {
  const entryId = "00000000-0000-4000-8000-00000000e009";
  const page = openStory({
    fixture: "ffn_last_chapter.html",
    url: "https://www.fanfiction.net/s/13500001/5/Letters-from-Pemberley",
    workKey: "ffn:13500001",
    entry: entryFor(entryId, "READING", { current: 5, total: 5 }),
    bodySelector: "#storytextp",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ffn:13500001", "FINISHED", { current: 5, total: 5 }),
  });

  page.wheel();
  page.scrollTo(END_IN_VIEW);
  page.advance(DWELL_MS);
  const signals = page.finishSignals();
  assert.equal(signals.length, 1);
  assert.deepEqual(plainJson(signals[0].payload), {
    entryId,
    workKey: "ffn:13500001",
    source: "ffn",
    chapter: 5,
    total: 5,
    state: "resolved",
    workStatus: "complete",
    resolutionSource: "source",
  });
  const note = page.document.querySelector("[data-trace-finish-done]");
  assert.equal(page.body.nextElementSibling, note);
  assert.ok(follows(note, page.document.querySelector("#review")));
  assert.match(note.getAttribute("style") || "", /margin:\s*16px auto/, "FFN centres the note on its column");
});

test("FFN WIP last chapter (status unknown): the compact question follows the text", () => {
  const entryId = "00000000-0000-4000-8000-00000000e010";
  const page = openStory({
    fixture: "ffn_wip_mobile.html",
    url: "https://m.fanfiction.net/s/13500002/6/",
    workKey: "ffn:13500002",
    entry: entryFor(entryId, "READING", { current: 6, total: 6 }),
    bodySelector: "#storycontent",
    initialRect: BELOW,
    finishResponder: resolvedResponder(entryId, "ffn:13500002", "CAUGHT_UP", { current: 6, total: 6 }),
  });

  page.touch();
  page.scrollTo(END_IN_VIEW);
  assert.equal(page.document.querySelector("[data-trace-finish-qualify]"), null);
  page.advance(DWELL_MS);

  assert.equal(page.finishSignals("open").length, 1);
  assert.equal(page.finishSignals("resolved").length, 0, "unknown work state is never resolved silently");
  const band = page.document.querySelector("[data-trace-finish-qualify]");
  assert.ok(band);
  assert.equal(page.body.parentElement.nextElementSibling, band, "after the story wrapper, before the bottom rule");
  assert.match(band.textContent, /You’ve reached the latest chapter/);
  assert.match(band.textContent, /Is this story complete on FFN\?/);
  assert.doesNotMatch(band.textContent, /reached the end/);
  const dismiss = band.querySelector("[data-trace-finish-dismiss]");
  assert.equal(dismiss.getAttribute("aria-label"), "Decide later");
  assert.deepEqual(
    Array.from(band.querySelectorAll("[data-trace-work-choice]")).map((button) => button.textContent),
    ["It’s complete", "Still ongoing", "On hiatus", "Looks abandoned"],
  );

  band.querySelector("[data-trace-work-choice='wip']").click();
  const resolved = page.finishSignals("resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].payload.workStatus, "wip");
  assert.equal(resolved[0].payload.resolutionSource, "reader");
  assert.match(band.textContent, /Marked ongoing/);
  assert.match(band.textContent, /Caught up/);
});

test("short final chapter that fits on one screen: needs the reader's own interaction, then the dwell", () => {
  const entryId = "00000000-0000-4000-8000-00000000e011";
  const page = openStory({
    fixture: "ffn_last_chapter_mobile.html",
    url: "https://m.fanfiction.net/s/13500001/5/",
    workKey: "ffn:13500001",
    entry: entryFor(entryId, "READING", { current: 5, total: 5 }),
    bodySelector: "#storycontent",
    initialRect: { top: 180, bottom: 640 },
    finishResponder: resolvedResponder(entryId, "ffn:13500001", "FINISHED", { current: 5, total: 5 }),
  });

  page.advance(DWELL_MS / 2);
  assert.equal(page.finishSignals().length, 0, "a chapter on screen at load is not yet read");
  page.touch();
  assert.equal(page.finishSignals().length, 0, "the dwell is not complete yet");
  page.advance(DWELL_MS / 2);
  assert.equal(page.finishSignals().length, 1, "time on screen plus the reader's touch qualifies");
  const note = page.document.querySelector("[data-trace-finish-done]");
  assert.equal(page.body.parentElement.nextElementSibling, note);
});

test("short final chapter restored on screen without any interaction never finishes", () => {
  const entryId = "00000000-0000-4000-8000-00000000e012";
  const page = openStory({
    fixture: "ffn_last_chapter_mobile.html",
    url: "https://m.fanfiction.net/s/13500001/5/",
    workKey: "ffn:13500001",
    entry: entryFor(entryId, "READING", { current: 5, total: 5 }),
    bodySelector: "#storycontent",
    initialRect: { top: 180, bottom: 640 },
    finishResponder: resolvedResponder(entryId, "ffn:13500001", "FINISHED", { current: 5, total: 5 }),
  });

  page.window.dispatchEvent(new page.window.Event("scroll"));
  page.advance(DWELL_MS * 10);
  assert.equal(page.finishSignals().length, 0);
});

test("end-of-story surfaces keep the page grammar and a reduced-motion fallback", () => {
  assert.match(FINISH_SRC, /prefers-reduced-motion:reduce\)\{@keyframes traceFinishArrive\{from\{opacity:0\}to\{opacity:1\}\}/);
  assert.doesNotMatch(FINISH_SRC, /border-left/);
  assert.doesNotMatch(FINISH_SRC, /text-transform:\s*uppercase/);
  assert.doesNotMatch(FINISH_SRC, /\.\.\./);
  assert.doesNotMatch(FINISH_SRC, /role', 'status'|aria-live/, "finish notes speak through the one page live region");
});
