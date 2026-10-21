// Import your whole AO3 History: the sheet's section. Copied into the
// extension only by a build with TRACE_AO3_HISTORY_IMPORT (scripts/build.mjs)
// and loaded only by its sheet. It shows what the run reports and sends it
// Start, Pause, Carry on and Delete; the background does the work
// (src/extension-runtime/ao3-history-import.mts). It reuses the sheet's own
// classes, so it reads as part of the sheet.
(function () {
  "use strict";
  var MESSAGE = "TRACE_AO3_HISTORY_IMPORT";
  var POLL_MS = 2000;
  var extension = globalThis.browser || globalThis.chrome;
  if (!extension || !extension.runtime || !globalThis.document) return;

  function plural(count, one, many) {
    return count.toLocaleString("en") + " " + (count === 1 ? one : many);
  }

  function about(ms) {
    var minutes = Math.round(ms / 60000);
    return minutes < 1 ? "less than a minute" : plural(minutes, "minute", "minutes");
  }

  /** Why a run is paused, in the reader's words, and whether Carry on can help. */
  var PAUSED = {
    signed_out: ["Sign in to AO3 in this tab, then tap Carry on.", true],
    challenge: ["AO3 wants to check this browser. Open any AO3 page, finish the check, then tap Carry on.", true],
    rate_limited: ["AO3 asked Trace to slow down several times. Wait a while, then tap Carry on.", true],
    unavailable: ["AO3 isn’t answering properly right now. Try Carry on later.", true],
    server_error: ["AO3 isn’t answering properly right now. Try Carry on later.", true],
    incomplete_page: ["AO3 isn’t answering properly right now. Try Carry on later.", true],
    empty_page: ["AO3 isn’t answering properly right now. Try Carry on later.", true],
    retry_later: ["AO3 asked Trace to wait a while. Tap Carry on later; Trace waits until AO3 is ready.", true],
    network: ["Trace lost its connection. Check it, then tap Carry on.", true],
    history_empty: ["Your AO3 History is empty or turned off. You can turn it on in AO3’s Preferences.", false],
    storage_full: ["This device has no room to keep more. Free some space, then tap Carry on.", true],
    storage_write_failed: ["Trace couldn’t keep what it found. Tap Carry on to try again.", true],
    tab_gone: ["Open AO3 and tap Carry on.", true],
    tab_not_ao3: ["Open AO3 and tap Carry on.", true],
    tab_no_result: ["Open AO3 and tap Carry on.", true],
    no_site_access: ["Trace isn’t allowed on AO3. Allow it, then tap Carry on.", true],
    page_limit: ["Trace stopped at its limit of pages. Your stories so far are kept.", false],
  };
  var CANT_READ = "Trace can’t read AO3’s History right now. Nothing was added to your Library.";

  var START_ERROR = {
    no_site_access: "Allow Trace on AO3 first, then try again.",
    open_ao3_first: "Open AO3 in this tab first, then try again.",
    signed_out: "Sign in to AO3 in this tab first, then try again.",
    username_unclear: "Trace couldn’t tell which AO3 account is signed in here.",
    not_connected: "Connect Trace first, then try again.",
    already_started: "Trace is already reading your History.",
    storage_full: "This device has no room to keep your History.",
    storage_write_failed: "Trace couldn’t keep your History on this device. Try again.",
  };

  var WAITING = {
    slow_down: "AO3 asked Trace to slow down. Trying again in ",
    ao3_unwell: "AO3 isn’t answering. Trace will try again shortly.",
    network: "No connection. Trace will try again shortly.",
    save: "Waiting while Trace saves your story.",
  };

  var lastView = null;
  var startable = false;
  var mode = "auto"; // "auto", "confirm-start" or "confirm-delete"
  var busy = false;
  var note = "";
  var poll = null;

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(className, emphasis, label, onClick) {
    var node = element("button", className, label);
    node.type = "button";
    if (emphasis) node.setAttribute("data-emphasis", emphasis);
    node.addEventListener("click", onClick);
    return node;
  }

  var style = element("style");
  // The sheet's own tokens and type; the run reads as one more quiet block
  // above Settings, its controls the sheet's own pills.
  style.textContent = [
    ".popup-history{display:grid;gap:0}",
    ".popup-history[hidden],.popup-history [hidden]{display:none}",
    ".popup-history-card{display:grid;gap:4px;margin-top:14px;padding-top:14px;border-top:1px solid var(--rule)}",
    ".popup-history-card .popup-status{font-size:1em}",
    ".popup-history-track{height:3px;margin:6px 0 2px;border-radius:2px;background:var(--rule);overflow:hidden}",
    ".popup-history-fill{height:100%;width:0;border-radius:2px;background:var(--action);transition:width .3s}",
    ".popup-history-buttons{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 14px}",
    ".popup-history-buttons .popup-cta{flex:1 0 100%}",
    ".popup-history-buttons [data-tone=\"warning\"]{color:var(--warning)}",
    ".popup-history .popup-import-recovery-help{margin:0 0 12px}",
    "@media (prefers-reduced-motion:reduce){.popup-history-fill{transition:none}}",
  ].join("");
  document.head.appendChild(style);

  var root = element("section", "popup-history");
  root.id = "popup-history";
  root.setAttribute("aria-labelledby", "popup-history-heading");
  root.hidden = true;

  var entry = button("popup-import", null, "Import your whole History", function () {
    mode = "confirm-start";
    note = "";
    render();
  });
  entry.id = "popup-history-entry";
  var entryHelp = element(
    "p",
    "popup-import-recovery-help",
    "Trace reads every page of your AO3 History. Nothing is added until you choose in Trace.",
  );

  var card = element("div", "popup-history-card");
  var heading = element("p", "popup-status");
  heading.id = "popup-history-heading";
  var lineOne = element("p", "popup-lead");
  var lineTwo = element("p", "popup-lead");
  var track = element("div", "popup-history-track");
  var fill = element("div", "popup-history-fill");
  track.appendChild(fill);
  track.setAttribute("aria-hidden", "true");
  var noteLine = element("p", "popup-import-recovery-help");
  noteLine.setAttribute("role", "status");
  noteLine.setAttribute("aria-live", "polite");
  var actions = element("div", "popup-history-buttons");
  var primary = button("popup-cta", "primary", "", function () { act(primary.dataset.action); });
  var secondary = button("popup-earned-status-control", null, "", function () { act(secondary.dataset.action); });
  var tertiary = button("popup-earned-status-control", null, "", function () { act(tertiary.dataset.action); });
  actions.append(primary, secondary, tertiary);
  card.append(heading, lineOne, lineTwo, track, noteLine, actions);
  root.append(entry, entryHelp, card);

  function currentTabId() {
    try {
      return Promise.resolve(extension.tabs.query({ active: true, currentWindow: true }))
        .then(function (tabs) { return tabs && tabs[0] && typeof tabs[0].id === "number" ? tabs[0].id : null; })
        .catch(function () { return null; });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function send(action) {
    return currentTabId().then(function (tabId) {
      var message = { type: MESSAGE, action: action };
      if (typeof tabId === "number") message.tabId = tabId;
      return extension.runtime.sendMessage(message);
    });
  }

  function act(action) {
    if (busy || !action) return;
    if (action === "not_now" || action === "keep") {
      mode = "auto";
      render();
      return;
    }
    if (action === "ask_delete") {
      mode = "confirm-delete";
      render();
      return;
    }
    busy = true;
    note = "";
    render();
    send(action).then(function (reply) {
      busy = false;
      // A start that could not happen stays on the start screen, saying why.
      if (reply && reply.ok === false && reply.error) note = START_ERROR[reply.error] || "That didn’t work. Try again.";
      else mode = "auto";
      if (reply && reply.view) lastView = reply.view;
      if (reply && typeof reply.startable === "boolean") startable = reply.startable;
      render();
    }, function () {
      busy = false;
      note = "Trace didn’t answer. Close and reopen this sheet.";
      render();
    });
  }

  function setButton(node, label, action) {
    delete node.dataset.tone;
    node.hidden = !label;
    node.textContent = label || "";
    node.dataset.action = action || "";
    node.disabled = busy;
  }

  function progressLine(view) {
    var read = view.pagesRead || 0;
    var total = typeof view.totalPages === "number" ? view.totalPages : null;
    var page = total === null ? read + 1 : Math.min(read + 1, total);
    return "Page " + page + (total === null ? "" : " of " + total) + " · " + plural(view.works || 0, "story", "stories") + " so far";
  }

  function render() {
    place();
    var view = lastView || { status: "idle" };
    var status = view.status;
    var showCard = status !== "idle" || mode === "confirm-start";
    root.hidden = !showCard && !startable;
    entry.hidden = showCard;
    entryHelp.hidden = showCard;
    entry.disabled = busy;
    card.hidden = !showCard;
    track.hidden = true;
    lineTwo.hidden = true;
    noteLine.hidden = !note;
    noteLine.textContent = note;
    if (!showCard) return;

    if (mode === "confirm-delete") {
      heading.textContent = "Delete what Trace found?";
      lineOne.textContent = plural(view.works || 0, "story", "stories") + " from your History will be removed from this device. Nothing in your Library changes.";
      setButton(primary, "", "");
      setButton(secondary, "Delete", "delete");
      secondary.dataset.tone = "warning";
      setButton(tertiary, "Keep", "keep");
      return;
    }
    if (status === "idle") {
      heading.textContent = "Import your AO3 History";
      lineOne.textContent = "Trace reads your History page by page from this tab, about one page every 10 seconds.";
      lineTwo.textContent = "Nothing is added to your Library until you choose. You can keep reading AO3 while it runs.";
      lineTwo.hidden = false;
      setButton(primary, busy ? "Starting…" : "Start reading", "start");
      setButton(secondary, "", "");
      setButton(tertiary, "Not now", "not_now");
      return;
    }
    track.hidden = (view.pagesRead || 0) === 0 && status !== "finished";
    var total = typeof view.totalPages === "number" ? view.totalPages : 0;
    var share = status === "finished" ? 1 : total > 0 ? Math.min(1, (view.pagesRead || 0) / total) : 0;
    fill.style.width = Math.round(share * 1000) / 10 + "%";
    if (status === "running") {
      heading.textContent = "Reading your History";
      lineOne.textContent = progressLine(view);
      var waiting = view.waitingFor && WAITING[view.waitingFor];
      if (waiting) {
        lineTwo.textContent = view.waitingFor === "slow_down"
          ? waiting + about(Math.max(0, (view.waitingUntil || 0) - Date.now())) + "."
          : waiting;
      } else if (typeof view.remainingMs === "number" && (view.pagesRead || 0) > 0) {
        lineTwo.textContent = "About " + about(view.remainingMs) + " left. Keep this AO3 tab open; reading pauses while it’s hidden.";
      } else {
        lineTwo.textContent = "Keep this AO3 tab open; reading pauses while it’s hidden.";
      }
      lineTwo.hidden = false;
      setButton(primary, "", "");
      setButton(secondary, "Pause", "pause");
      setButton(tertiary, "Stop and delete", "ask_delete");
      return;
    }
    if (status === "paused") {
      var reason = view.reason === "paused_by_you" ? null : PAUSED[view.reason] || [CANT_READ, true];
      heading.textContent = "Paused";
      lineOne.textContent = reason === null
        ? "Paused on page " + ((view.pagesRead || 0) + 1) + ". Your stories so far are kept."
        : reason[0];
      lineTwo.textContent = plural(view.works || 0, "story", "stories") + " found so far.";
      lineTwo.hidden = !view.works;
      setButton(primary, reason === null || reason[1] ? (busy ? "Carrying on…" : "Carry on") : "", "resume");
      setButton(secondary, "", "");
      setButton(tertiary, "Stop and delete", "ask_delete");
      return;
    }
    heading.textContent = "Your History is ready";
    var skipped = [];
    if (view.later) skipped.push(plural(view.later, "marked for later", "marked for later"));
    if (view.deleted) skipped.push(plural(view.deleted, "deleted work left out", "deleted works left out"));
    if (view.unreadable) skipped.push(plural(view.unreadable, "row Trace couldn’t read", "rows Trace couldn’t read"));
    lineOne.textContent = plural(view.works || 0, "story", "stories") + " found." + (skipped.length ? " " + skipped.join(" · ") + "." : "");
    lineTwo.textContent = "Reviewing them in Trace comes in the next update. They stay on this device until then.";
    lineTwo.hidden = false;
    setButton(primary, "", "");
    setButton(secondary, "", "");
    setButton(tertiary, "Delete", "ask_delete");
  }

  /** In the reader view, above Settings; in the ordinary sheet, after the other imports. */
  function place() {
    var extras = document.getElementById("popup-earned-extras");
    var settings = document.getElementById("popup-earned-settings-row");
    if (extras && !extras.hidden && settings && settings.parentNode === extras) {
      if (root.parentNode !== extras || root.nextSibling !== settings) extras.insertBefore(root, settings);
      return;
    }
    var holder = document.querySelector(".popup-actions");
    if (!holder) return;
    var after = document.getElementById("popup-open-tabs-help");
    if (after && after.parentNode === holder) {
      if (root.previousSibling !== after) holder.insertBefore(root, after.nextSibling);
    } else if (root.parentNode !== holder) {
      holder.appendChild(root);
    }
  }

  function refresh() {
    if (busy) return;
    send("status").then(function (reply) {
      if (!reply || reply.ok !== true) return;
      lastView = reply.view || null;
      startable = reply.startable === true;
      if (mode === "confirm-start" && lastView && lastView.status !== "idle") mode = "auto";
      render();
    }, function () {});
  }

  function start() {
    refresh();
    if (poll === null) poll = setInterval(refresh, POLL_MS);
  }

  function stopPolling() {
    if (poll !== null) clearInterval(poll);
    poll = null;
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") start();
    else stopPolling();
  });
  render();
  start();
  globalThis.__traceAo3HistoryImportPanel = { refresh: refresh, render: render };
})();
