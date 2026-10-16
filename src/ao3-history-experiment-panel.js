// AO3 History experiment: the sheet's section. Copied into the extension only
// by the experiment build (scripts/build.mjs) and loaded only by its sheet.
// It shows what the background reports and sends it Start, Pause, Resume and
// Clear; the background does the work (ao3-history-experiment.mts).
(function () {
  "use strict";
  var MESSAGE = "TRACE_AO3_HISTORY_EXPERIMENT";
  var extension = globalThis.browser || globalThis.chrome;
  if (!extension || !extension.runtime) return;

  var STATUS_TEXT = {
    idle: "Not started. Open AO3 in this tab, signed in, then tap Start.",
    running: "Running. Keep Safari open on AO3.",
    finished: "Finished: it reached the last page of your History.",
  };
  var REASON_TEXT = {
    paused_by_you: "Paused. Tap Resume to carry on.",
    signed_out: "Stopped: AO3 shows you signed out. Sign in to AO3 in Safari, then tap Resume.",
    challenge: "Stopped: AO3 asked Safari for a check. Open AO3 in Safari, wait until pages load normally, then tap Resume.",
    rate_limited: "Stopped: AO3 asked Trace to slow down three times in a row. Wait a while before tapping Resume.",
    unavailable: "Stopped: AO3 was unavailable three times in a row. Try Resume later.",
    server_error: "Stopped: AO3 had errors three times in a row. Try Resume later.",
    retry_later: "Stopped: AO3 asked Trace to wait a long time. Resume waits until then.",
    network: "Stopped: three network failures in a row. Check the connection, then tap Resume.",
    wrong_host: "Stopped: the answer came from a site other than AO3.",
    redirected: "Stopped: AO3 sent Trace to a different page.",
    forbidden: "Stopped: AO3 refused the page.",
    http_error: "Stopped: AO3 answered with an error.",
    unrecognized_page: "Stopped: the page did not look like your History.",
    pagination_unexpected: "Stopped: the page links did not lead to the next page.",
    pagination_repeat: "Stopped: AO3 showed the same page twice.",
    page_limit: "Stopped at the page limit.",
    storage_write_failed: "Stopped: Trace could not store more on this iPhone.",
    no_working_path: "Stopped: neither Trace's background nor this AO3 tab could read your History while signed in.",
    tab_gone: "Paused: the AO3 tab closed. Open AO3, open Trace there and tap Resume.",
    tab_not_ao3: "Paused: the tab left AO3. Open AO3, open Trace there and tap Resume.",
    tab_no_result: "Paused: Trace could not read in the AO3 tab. Open Trace on AO3 and tap Resume.",
    no_site_access: "Paused: Trace is not allowed on AO3. Allow it, then tap Resume.",
    reached_last_page: "Finished: it reached the last page of your History.",
  };
  var START_ERROR_TEXT = {
    no_site_access: "Trace is not allowed on AO3 yet. Allow Trace on AO3 first, then tap Start again.",
    open_ao3_first: "Open archiveofourown.org in this tab first, signed in, then open Trace and tap Start.",
    signed_out: "AO3 shows you signed out in this tab. Sign in to AO3, then tap Start again.",
    username_unclear: "Trace could not tell which AO3 account is signed in here.",
    already_started: "A run already exists. Tap Clear experiment data first.",
    storage_write_failed: "Trace could not store anything on this iPhone.",
  };

  var root;
  var statusLine;
  var noteLine;
  var buttons = {};
  var results;
  var lastView = null;
  var poll = null;

  function send(action) {
    var message = { type: MESSAGE, action: action };
    return currentTabId().then(function (tabId) {
      if (typeof tabId === "number") message.tabId = tabId;
      return extension.runtime.sendMessage(message);
    });
  }

  function currentTabId() {
    try {
      return Promise.resolve(extension.tabs.query({ active: true, currentWindow: true }))
        .then(function (tabs) { return tabs && tabs[0] && typeof tabs[0].id === "number" ? tabs[0].id : null; })
        .catch(function () { return null; });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function button(label, action) {
    var element = document.createElement("button");
    element.type = "button";
    element.className = "trace-ao3x-button";
    element.textContent = label;
    element.addEventListener("click", function () { act(action); });
    return element;
  }

  function act(action) {
    noteLine.textContent = "";
    Object.keys(buttons).forEach(function (key) { buttons[key].disabled = true; });
    send(action).then(function (response) {
      if (response && response.ok === false && response.error) {
        noteLine.textContent = START_ERROR_TEXT[response.error] || "That did not work (" + response.error + ").";
      }
      render(response && response.view ? response.view : lastView);
    }, function () {
      noteLine.textContent = "Trace's background did not answer. Close and reopen the sheet.";
      render(lastView);
    });
  }

  function copyResults() {
    var text = lastView && lastView.report ? lastView.report : "";
    if (!text) return;
    var done = function () { noteLine.textContent = "Results copied: counts, times and error codes only."; };
    try {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } catch (_) {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "trace-ao3x-copy";
    root.appendChild(area);
    area.select();
    try {
      if (document.execCommand("copy")) done();
      else noteLine.textContent = "Copy did not work. Select the results text and copy it.";
    } catch (_) {
      noteLine.textContent = "Copy did not work. Select the results text and copy it.";
    }
  }

  function render(view) {
    lastView = view || lastView;
    var status = view && view.status ? view.status : "idle";
    var text = status === "paused" || status === "finished"
      ? REASON_TEXT[view.reason] || "Stopped (" + (view.reason || "unknown") + ")."
      : STATUS_TEXT[status] || status;
    if (status === "running" && view.waitingUntil) {
      var seconds = Math.max(0, Math.round((view.waitingUntil - Date.now()) / 1000));
      text += " Next page (" + view.nextPage + ") in " + seconds + " s.";
    } else if (status === "running" && view.nextPage) {
      text += " Reading page " + view.nextPage + ".";
    }
    statusLine.textContent = text;
    buttons.start.hidden = status !== "idle";
    buttons.pause.hidden = status !== "running";
    buttons.resume.hidden = status !== "paused";
    buttons.cancel.hidden = status !== "running" && status !== "paused";
    buttons.copy.hidden = status === "idle";
    buttons.clear.hidden = status !== "finished";
    Object.keys(buttons).forEach(function (key) { buttons[key].disabled = false; });
    while (results.firstChild) results.removeChild(results.firstChild);
    (view && view.lines ? view.lines : []).forEach(function (line) {
      var term = document.createElement("dt");
      term.textContent = line[0];
      var value = document.createElement("dd");
      value.textContent = line[1];
      results.appendChild(term);
      results.appendChild(value);
    });
  }

  function refresh() {
    send("status").then(function (response) {
      if (response && response.view) render(response.view);
    }, function () {});
  }

  function style() {
    var css = document.createElement("style");
    css.textContent =
      ".trace-ao3x{margin:12px 16px;padding:10px 12px;border:1px solid var(--rule,#d8e0e7);border-radius:12px;background:var(--surface,#fff);color:var(--text,#18232d);font-size:14px}" +
      ".trace-ao3x summary{font-weight:600;cursor:pointer}" +
      ".trace-ao3x p{margin:8px 0}" +
      ".trace-ao3x-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}" +
      ".trace-ao3x-button{font:inherit;padding:8px 12px;border-radius:10px;border:1px solid var(--rule,#d8e0e7);background:var(--ground,#f8fafc);color:inherit}" +
      ".trace-ao3x-button[hidden]{display:none}" +
      ".trace-ao3x dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0;font-variant-numeric:tabular-nums}" +
      ".trace-ao3x dt{color:var(--text-2,#4b5965)}" +
      ".trace-ao3x dd{margin:0;overflow-wrap:anywhere}" +
      ".trace-ao3x-copy{width:100%;height:120px;font:12px var(--trace-mono,monospace)}" +
      "body.trace-ao3x-scroll{overflow-y:auto!important}";
    document.head.appendChild(css);
  }

  function mount() {
    var main = document.querySelector("main.popup") || document.body;
    if (!main || document.getElementById("trace-ao3x")) return;
    style();
    document.body.classList.add("trace-ao3x-scroll");
    root = document.createElement("details");
    root.id = "trace-ao3x";
    root.className = "trace-ao3x";
    var summary = document.createElement("summary");
    summary.textContent = "AO3 History experiment (test build)";
    root.appendChild(summary);
    var intro = document.createElement("p");
    intro.textContent = "Reads your AO3 History pages one at a time, about 10 seconds apart. Nothing goes to Trace or your Library; results stay on this iPhone.";
    root.appendChild(intro);
    statusLine = document.createElement("p");
    statusLine.setAttribute("role", "status");
    root.appendChild(statusLine);
    var actions = document.createElement("div");
    actions.className = "trace-ao3x-actions";
    buttons.start = button("Start", "start");
    buttons.pause = button("Pause", "pause");
    buttons.resume = button("Resume", "resume");
    buttons.cancel = button("Cancel", "clear");
    buttons.copy = document.createElement("button");
    buttons.copy.type = "button";
    buttons.copy.className = "trace-ao3x-button";
    buttons.copy.textContent = "Copy results";
    buttons.copy.addEventListener("click", copyResults);
    buttons.clear = button("Clear experiment data", "clear");
    [buttons.start, buttons.pause, buttons.resume, buttons.cancel, buttons.copy, buttons.clear].forEach(function (element) {
      actions.appendChild(element);
    });
    root.appendChild(actions);
    noteLine = document.createElement("p");
    noteLine.setAttribute("aria-live", "polite");
    root.appendChild(noteLine);
    var warning = document.createElement("p");
    warning.textContent = "Cancel and Clear delete everything this experiment found. Copy the results first.";
    root.appendChild(warning);
    results = document.createElement("dl");
    root.appendChild(results);
    main.insertBefore(root, main.firstChild);
    render(null);
    refresh();
    poll = setInterval(refresh, 2000);
    window.addEventListener("pagehide", function () { if (poll !== null) clearInterval(poll); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
