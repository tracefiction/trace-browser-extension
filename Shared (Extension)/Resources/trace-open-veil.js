// trace-open-veil.js — runs at document_start on the story sites, before the
// page draws anything.
// A story link the Trace app opens carries #trace-open. When Safari has just
// opened a tab for that link, collector.js (at document_end) asks the
// background whether a tab is already on the same story and chapter; if one
// is, that tab comes forward and this one closes (story-tab-reuse.mts). This
// keeps the new tab's page from being seen while that question is open.
// The page is hidden only when it arrives as such a link: the top frame,
// the mark, and a tab just opened for it, not prerendered. collector.js
// shows it again as soon as its own checks say not to ask, or the answer is
// anything but "closed". Whatever happens, it is shown again after
// TRACE_OPEN_VEIL_LONGEST_MS, or when the page comes back from the
// back-forward cache. It is not shown on the way out, so a tab that closes
// is never drawn again. Showing it is immediate, with no transition or
// animation, so Reduce Motion changes nothing.
// The mark itself stays for collector.js, which takes it off the address.
(function () {
  var TRACE_OPEN_MARK = "#trace-open";
  var TRACE_OPEN_VEIL_ID = "trace-open-veil";
  // The same window collector.js allows for a tab that has just opened.
  var TRACE_OPEN_JUST_OPENED_MS = 10000;
  var TRACE_OPEN_VEIL_LONGEST_MS = 1200;

  try {
    if (window.top !== window || location.hash !== TRACE_OPEN_MARK) return;
    if (history.length > 1 || document.referrer) return;
    if (document.prerendering === true) return;
    var since =
      typeof performance !== "undefined" && performance && typeof performance.now === "function"
        ? performance.now()
        : NaN;
    if (!Number.isFinite(since) || since > TRACE_OPEN_JUST_OPENED_MS) return;
    var root = document.documentElement;
    if (!root || document.getElementById(TRACE_OPEN_VEIL_ID)) return;

    var veil = document.createElement("style");
    veil.id = TRACE_OPEN_VEIL_ID;
    veil.textContent = "html,html *{visibility:hidden!important}";
    var timer = null;
    var lift = function () {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try {
        window.removeEventListener("pageshow", restored);
      } catch (_) {
        /* The veil still comes off below. */
      }
      if (veil.parentNode) veil.parentNode.removeChild(veil);
    };
    var restored = function (event) {
      if (event && event.persisted === true) lift();
    };
    timer = setTimeout(lift, TRACE_OPEN_VEIL_LONGEST_MS);
    window.addEventListener("pageshow", restored);
    root.appendChild(veil);
  } catch (_) {
    // Nothing is hidden, or the timer set above shows it again.
  }
})();
