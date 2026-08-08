/* ============================================================================
 * trace-finish-qualify.js
 * Drop-in, style-isolated "you reached the end" qualify band for AO3 / FFN.
 * Vanilla DOM, no framework, no shadow root; matches collector.js style.
 *
 * The reader hits the bottom of the LAST POSTED chapter:
 *   - work-state KNOWN (e.g. AO3 dd.status "Completed:")  -> set silently, NO band
 *   - work-state UNKNOWN                                  -> show this band, ask
 * Answer records work status and derives reader status: complete/abandoned => Finished, else => Caught up.
 *
 * USAGE (wire into your content scripts):
 *   const band = TraceFinishQualify.mount({
 *     anchorEl,                       // insert AFTER this (see anchors below)
 *     placement: 'inline',            // 'inline' (in flow) | 'corner' (fixed)
 *     align: 'center'|'start',        // inline only; start aligns with the host content column
 *     story: { src:'AO3', title:'…', chapter:33, total:33 },
 *     onQualify(workState){…},        // 'complete'|'wip'|'hiatus'|'abandoned'
 *     onDismiss(){…},
 *     onOpenInTrace(){…},             // optional quiet link; omit to hide
 *   });
 *   band.remove();
 *
 *   // Silent path (work-state known) — no band, just confirm chip if you want:
 *   TraceFinishQualify.toast({ kind:'finished'|'caughtup', story, onOpenInTrace });
 *
 * SCROLL TRIGGER helper (optional):
 *   TraceFinishQualify.onReachEnd(chapterBodyEl, () => { …decide silent vs band… });
 *
 * ANCHORS (host pages):
 *   AO3 chapter : insertAfter the last AO3 end-notes block, else #chapters
 *   FFN desktop : insertAfter #storytextp
 *   FFN mobile  : insertAfter #storycontent's wrapper (before bottom <hr>)
 * ========================================================================== */
(function (root) {
  'use strict';

  // ---- TRUE Trace injected palette (from shipped data-trace-* elements) ----
  var T = {
    paper:'rgb(247,243,233)', sunk:'rgb(243,239,228)', sunk2:'rgb(235,230,215)',
    ink:'rgb(28,39,34)', muted:'rgb(110,106,91)', faint:'rgb(154,149,131)',
    dotEmpty:'rgb(196,190,168)', line:'rgba(28,39,34,0.18)', lineSoft:'rgba(28,39,34,0.1)',
    rust:'rgb(181,74,48)', forest:'rgb(19,48,41)', finished:'rgb(31,77,63)',
    honey:'rgb(138,110,42)', caughtup:'rgb(47,143,134)',
    sans:'Manrope, system-ui, -apple-system, "Segoe UI", sans-serif',
    serif:'Fraunces, Georgia, "Times New Roman", serif',
    mono:'"Geist Mono", ui-monospace, monospace'
  };
  var Z = 2147483646;
  var CONFIRMATION_AUTO_DISMISS_MS = 14000;

  // work-state options -> dot colour
  var WORK = [
    ['complete','It\u2019s complete', T.finished],
    ['wip','Still ongoing',           T.caughtup],
    ['hiatus','On hiatus',           T.honey],
    ['abandoned','Looks abandoned',   T.rust]
  ];

  // ---- tiny DOM helpers (reset everything we set; never inherit host CSS) --
  function el(tag, css, text) {
    var n = document.createElement(tag);
    // hard reset so host page styles can't bleed in
    n.style.cssText = 'all:revert;margin:0;padding:0;border:0;box-sizing:border-box;'
      + 'font-family:' + T.sans + ';line-height:1.4;color:' + T.ink
      + ';text-align:left;letter-spacing:0;text-transform:none;'
      + (css || '');
    if (text != null) n.textContent = text;
    return n;
  }
  function dot(color, d) {
    d = d || 7;
    return el('span', 'display:inline-block;flex:0 0 auto;width:' + d + 'px;height:' + d
      + 'px;border-radius:999px;background:' + color + ';');
  }
  function insertAfter(ref, node) { ref.parentNode.insertBefore(node, ref.nextSibling); }

  // ---- the qualify band -----------------------------------------------------
  function buildBand(opts) {
    var s = opts.story || {};
    var corner = opts.placement === 'corner';
    var inlineStart = !corner && opts.align === 'start';

    var wrap = el('aside',
      'display:block;background:' + T.paper + ';border:1px solid ' + T.line + ';'
      + 'border-radius:14px;overflow:hidden;'
      + 'box-shadow:0 16px 40px -16px rgba(20,14,0,0.34),0 0 0 1px ' + T.lineSoft + ';'
      + '-webkit-font-smoothing:antialiased;'
      + (corner
          ? 'position:fixed;z-index:' + Z + ';width:330px;max-width:calc(100vw - 24px);right:18px;bottom:18px;'
          : 'position:relative;width:100%;max-width:520px;margin:22px ' + (inlineStart ? '0' : 'auto') + ';'));
    wrap.setAttribute('data-trace-finish-qualify', s.handle || '1');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Trace \u2014 reached the end');

    var pad = el('div', 'padding:15px 17px;');

    // kicker: "AO3 · REACHED THE END"
    var kick = el('div',
      'font:500 9px/1 ' + T.mono + ';letter-spacing:0.14em;text-transform:uppercase;'
      + 'color:' + T.rust + ';margin-bottom:8px;');
    kick.textContent = (s.src ? s.src + ' \u00b7 ' : '') + 'reached the end';
    pad.appendChild(kick);

    // headline
    var head = el('div',
      'font:500 17px/1.2 ' + T.serif + ';color:' + T.ink + ';');
    head.textContent = s.title ? '\u201c' + s.title + '\u201d is\u2026 complete?' : 'Is this story complete?';
    pad.appendChild(head);

    var sub = el('div', 'font-size:12.5px;color:' + T.muted + ';margin-top:4px;');
    sub.textContent = 'You finished the last posted chapter'
      + (s.total ? ' (ch ' + (s.chapter || s.total) + ' of ' + s.total + ')' : '') + '.';
    pad.appendChild(sub);

    // options
    var opt = el('div', 'display:flex;flex-wrap:wrap;gap:7px;margin-top:13px;');
    WORK.forEach(function (w) {
      var b = el('button',
        'display:inline-flex;align-items:center;gap:7px;cursor:pointer;'
        + 'background:' + T.paper + ';border:1px solid ' + T.line + ';border-radius:9px;'
        + 'padding:8px 12px;font:500 12.5px/1 ' + T.sans + ';color:' + T.ink + ';');
      b.type = 'button';
      b.setAttribute('data-trace-work-choice', w[0]);
      b.appendChild(dot(w[2]));
      b.appendChild(el('span', '', w[1]));
      b.addEventListener('mouseenter', function () { b.style.background = T.sunk; b.style.borderColor = T.muted; });
      b.addEventListener('mouseleave', function () { b.style.background = T.paper; b.style.borderColor = T.line; });
      b.addEventListener('click', function () {
        setBusy(wrap, true);
        var controls = {
          resolve: function () { showResolved(wrap, pad, w[0], opts); },
          fail: function (message) {
            setBusy(wrap, false);
            showError(pad, message || 'Could not save. Try again.');
          }
        };
        if (typeof opts.onQualify === 'function' && opts.onQualify(w[0], controls) === false) return;
        showResolved(wrap, pad, w[0], opts);
      });
      opt.appendChild(b);
    });
    pad.appendChild(opt);

    // dismiss
    var dis = el('button',
      'display:inline-block;margin-top:11px;cursor:pointer;background:none;border:0;'
      + 'font-size:11.5px;color:' + T.faint + ';');
    dis.type = 'button';
    dis.textContent = corner ? 'Dismiss' : 'Not sure / later';
    dis.addEventListener('click', function () {
      if (typeof opts.onDismiss === 'function') opts.onDismiss();
      removeNode(wrap);
    });
    pad.appendChild(dis);

    wrap.appendChild(pad);
    return wrap;
  }

  function buildRecoveryBand(opts) {
    var s = opts.story || {};
    var inlineStart = opts.align === 'start';
    var wrap = el('aside',
      'display:block;background:' + T.paper + ';border:1px solid ' + T.line + ';'
      + 'border-radius:14px;overflow:hidden;'
      + 'box-shadow:0 16px 40px -16px rgba(20,14,0,0.34),0 0 0 1px ' + T.lineSoft + ';'
      + '-webkit-font-smoothing:antialiased;position:relative;width:100%;max-width:520px;'
      + 'margin:22px ' + (inlineStart ? '0' : 'auto') + ';');
    wrap.setAttribute('data-trace-finish-recovery', s.handle || '1');
    wrap.setAttribute('role', 'alert');
    wrap.setAttribute('aria-live', 'polite');

    var pad = el('div', 'padding:15px 17px;');
    var kick = el('div',
      'font:500 9px/1 ' + T.mono + ';letter-spacing:0.14em;text-transform:uppercase;'
      + 'color:' + T.rust + ';margin-bottom:8px;',
      (s.src ? s.src + ' \u00b7 ' : '') + 'update needs attention');
    pad.appendChild(kick);
    pad.appendChild(el('div',
      'font:500 17px/1.2 ' + T.serif + ';color:' + T.ink + ';',
      'Trace couldn\u2019t update your reading status'));
    var message = el('div', 'font-size:12.5px;color:' + T.muted + ';margin-top:4px;',
      opts.message || 'Retry the finish update, or open Trace to update it there.');
    message.setAttribute('data-trace-finish-recovery-message', '1');
    pad.appendChild(message);

    var actions = el('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-top:13px;');
    var retry = el('button',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;'
      + 'background:' + T.forest + ';border:1px solid ' + T.forest + ';border-radius:9px;'
      + 'min-height:44px;padding:8px 12px;font:600 12.5px/1 ' + T.sans + ';color:#fff;',
      'Retry update');
    retry.type = 'button';
    retry.setAttribute('data-trace-finish-retry', '1');
    actions.appendChild(retry);

    if (typeof opts.onOpenInTrace === 'function') {
      var open = el('button',
        'display:inline-block;cursor:pointer;background:none;border:0;'
        + 'min-height:44px;padding:8px 4px;font-size:12.5px;color:' + T.forest
        + ';text-decoration:underline;text-underline-offset:2px;',
        'Open in Trace');
      open.type = 'button';
      open.setAttribute('data-trace-finish-open', '1');
      open.addEventListener('click', opts.onOpenInTrace);
      actions.appendChild(open);
    }
    pad.appendChild(actions);
    wrap.appendChild(pad);

    function setRetryBusy(busy) {
      retry.disabled = busy === true;
      retry.style.cursor = busy === true ? 'wait' : 'pointer';
      retry.style.opacity = busy === true ? '0.68' : '1';
    }

    retry.addEventListener('click', function () {
      setRetryBusy(true);
      var controls = {
        resolve: function () { removeNode(wrap); },
        fail: function (nextMessage) {
          setRetryBusy(false);
          message.textContent = nextMessage || 'Could not update. Try again or open Trace.';
        }
      };
      if (typeof opts.onRetry !== 'function') {
        controls.fail();
        return;
      }
      opts.onRetry(controls);
    });

    return wrap;
  }

  function setBusy(wrap, busy) {
    var buttons = wrap ? wrap.querySelectorAll('button[data-trace-work-choice]') : [];
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].disabled = busy === true;
      buttons[i].style.cursor = busy === true ? 'wait' : 'pointer';
      buttons[i].style.opacity = busy === true ? '0.68' : '1';
    }
  }

  function showError(pad, message) {
    var prev = pad.querySelector('[data-trace-finish-qualify-error]');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var err = el('div', 'margin-top:10px;font-size:11.5px;color:' + T.rust + ';', message);
    err.setAttribute('data-trace-finish-qualify-error', '1');
    pad.appendChild(err);
  }

  function workStatusResult(workState) {
    if (workState === 'complete') return { accent: T.finished, reader: 'Finished', work: 'Work is complete.' };
    if (workState === 'wip') return { accent: T.caughtup, reader: 'Caught up', work: 'Work is ongoing.' };
    if (workState === 'hiatus') return { accent: T.honey, reader: 'Caught up', work: 'Work is on hiatus.' };
    if (workState === 'abandoned') return { accent: T.rust, reader: 'Finished', work: 'Work looks abandoned.' };
    return { accent: T.caughtup, reader: 'Caught up', work: 'Work status saved.' };
  }

  // ---- resolved confirmation (replaces band body in place) ------------------
  function showResolved(wrap, pad, workState, opts) {
    var result = workStatusResult(workState);
    var accent = result.accent;
    wrap.style.background = 'color-mix(in oklab,' + accent + ' 8%, ' + T.paper + ')';
    wrap.style.borderColor = 'color-mix(in oklab,' + accent + ' 42%, transparent)';

    pad.textContent = '';
    var row = el('div', 'display:flex;align-items:center;gap:10px;');
    var ic = el('span',
      'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;'
      + 'width:28px;height:28px;border-radius:999px;background:' + accent + ';color:#fff;'
      + 'font:700 15px/1 ' + T.sans + ';');
    ic.textContent = '\u2713';
    var txt = el('div', '');
    var t1 = el('div', 'font:500 16px/1.2 ' + T.serif + ';color:' + T.ink + ';');
    t1.textContent = result.reader;
    var t2 = el('div', 'font-size:12px;color:' + T.muted + ';margin-top:2px;');
    t2.textContent = result.work;
    txt.appendChild(t1); txt.appendChild(t2);
    row.appendChild(ic); row.appendChild(txt);
    pad.appendChild(row);

    if (typeof opts.onOpenInTrace === 'function') {
      var link = el('a',
        'display:inline-block;margin-top:11px;cursor:pointer;'
        + 'font-size:12.5px;color:' + T.forest + ';text-decoration:underline;text-underline-offset:2px;');
      link.href = opts.traceHref || '#';
      link.textContent = 'Rate & note it in your library \u2192';
      link.addEventListener('click', function (e) {
        if (!opts.traceHref) e.preventDefault();
        opts.onOpenInTrace();
      });
      pad.appendChild(link);
    }

    if (opts.autoDismissMs !== 0) {
      setTimeout(function () { removeNode(wrap); }, opts.autoDismissMs || CONFIRMATION_AUTO_DISMISS_MS);
    }
  }

  function removeNode(n) {
    if (!n || !n.parentNode) return;
    n.style.transition = 'opacity .2s ease';
    n.style.opacity = '0';
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 220);
  }

  // ---- silent-path confirmation toast (work-state known) --------------------
  function toast(opts) {
    var s = opts.story || {};
    var finished = opts.kind === 'finished';
    var accent = finished ? T.finished : T.caughtup;
    var t = el('div',
      'position:fixed;z-index:' + Z + ';right:18px;bottom:18px;max-width:300px;'
      + 'display:flex;align-items:center;gap:10px;'
      + 'background:' + T.paper + ';border:1px solid color-mix(in oklab,' + accent + ' 42%,transparent);'
      + 'border-radius:12px;padding:12px 14px;'
      + 'box-shadow:0 16px 40px -16px rgba(20,14,0,0.34);');
    t.setAttribute('data-trace-finish-toast', '1');
    var ic = el('span',
      'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;'
      + 'width:24px;height:24px;border-radius:999px;background:' + accent + ';color:#fff;font:700 13px/1 ' + T.sans + ';');
    ic.textContent = '\u2713';
    var txt = el('div', 'font-size:13px;color:' + T.ink + ';');
    var b = el('span', 'font:500 13.5px/1.2 ' + T.serif + ';');
    b.textContent = finished ? 'Finished' : 'Caught up';
    txt.appendChild(b);
    if (typeof opts.onOpenInTrace === 'function') {
      var u = el('span', 'display:block;font-size:11.5px;color:' + T.forest
        + ';text-decoration:underline;cursor:pointer;margin-top:2px;');
      u.textContent = 'undo \u00b7 open in Trace';
      u.addEventListener('click', opts.onOpenInTrace);
      txt.appendChild(u);
    }
    t.appendChild(ic); t.appendChild(txt);
    document.body.appendChild(t);
    setTimeout(function () { removeNode(t); }, opts.autoDismissMs || CONFIRMATION_AUTO_DISMISS_MS);
    return { remove: function () { removeNode(t); } };
  }

  // ---- scroll-to-end trigger ------------------------------------------------
  function onReachEnd(bodyEl, cb, options) {
    if (!bodyEl) return function () {};
    var config = typeof options === 'number' ? { thresholdPx: options } : (options || {});
    var th = typeof config.thresholdPx === 'number' ? config.thresholdPx : 60;
    var defaultDwell = 2000;
    var dwellMs = typeof config.dwellMs === 'number' && config.dwellMs >= 0
      ? config.dwellMs
      : defaultDwell;
    var now = typeof config.now === 'function' ? config.now : function () { return Date.now(); };
    var setTimer = typeof config.setTimer === 'function' ? config.setTimer : setTimeout;
    var clearTimer = typeof config.clearTimer === 'function' ? config.clearTimer : clearTimeout;
    var navigationEvidenceWindowMs =
      typeof config.navigationEvidenceWindowMs === 'number' && config.navigationEvidenceWindowMs >= 0
        ? config.navigationEvidenceWindowMs
        : 5000;
    var fired = false, cleaned = false, interactionAt = null, dwellTimer = null;
    var visibleElapsedMs = 0, visibleSince = null;
    var initial = bodyEl.getBoundingClientRect();
    var initialBottom = typeof initial.bottom === 'number' ? initial.bottom : Infinity;
    var sawEndBelowViewport = initialBottom - window.innerHeight > th;
    var lastBottom = initialBottom;
    var requiresRestorationEvidence = !sawEndBelowViewport;

    function documentIsVisible() {
      return typeof document.visibilityState !== 'string' || document.visibilityState === 'visible';
    }

    visibleSince = documentIsVisible() ? now() : null;

    function visibleDwellElapsed() {
      if (visibleSince === null) return visibleElapsedMs;
      return visibleElapsedMs + Math.max(0, now() - visibleSince);
    }

    function targetIsEditable(target) {
      return !!(
        target &&
        target.closest &&
        target.closest('input,textarea,select,button,[contenteditable="true"]')
      );
    }

    function targetIsInsideStory(target) {
      if (!target || (target !== bodyEl && !bodyEl.contains(target))) return false;
      return !targetIsEditable(target);
    }

    function isReadingNavigationKey(event) {
      var key = event && event.key;
      return key === 'ArrowDown' || key === 'PageDown' || key === 'End' || key === ' ' || key === 'Spacebar';
    }

    function bodyIntersectsViewport(rect) {
      return rect.bottom >= -th && rect.top <= window.innerHeight + th;
    }

    function bodyIsAtVisibleEnd(rect) {
      return bodyIntersectsViewport(rect) && rect.bottom - window.innerHeight <= th;
    }

    function documentReadingContext(event, rect) {
      if (!bodyIntersectsViewport(rect)) return false;
      var target = event && event.target;
      if (targetIsEditable(target)) return false;
      if (targetIsInsideStory(target)) return true;
      var active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        return targetIsInsideStory(active);
      }
      return target === document || target === document.body || target === document.documentElement;
    }

    function evidenceReady() {
      return interactionAt !== null && visibleDwellElapsed() >= dwellMs;
    }

    function hasRecentNavigationEvidence() {
      return interactionAt !== null && now() - interactionAt <= navigationEvidenceWindowMs;
    }

    function check(cause) {
      if (fired || cleaned || !documentIsVisible()) return;
      var rect = bodyEl.getBoundingClientRect();
      var bottom = typeof rect.bottom === 'number' ? rect.bottom : Infinity;
      var wasBeforeEnd = lastBottom - window.innerHeight > th;
      var isBeforeEnd = bottom - window.innerHeight > th;
      var isAtVisibleEnd = bodyIsAtVisibleEnd(rect);
      var crossedVisibleEnd = sawEndBelowViewport && wasBeforeEnd && isAtVisibleEnd;
      var crossedPastEnd =
        sawEndBelowViewport &&
        wasBeforeEnd &&
        bottom < -th;

      if (isBeforeEnd) sawEndBelowViewport = true;
      lastBottom = bottom;

      var crossedEnd = crossedVisibleEnd || crossedPastEnd;
      var crossedByScroll =
        cause === 'scroll' && crossedEnd && hasRecentNavigationEvidence();
      if (cause === 'scroll' && crossedEnd && !crossedByScroll) {
        // A browser can restore scroll position after the content script has
        // installed. Treat an unattributed arrival as restored state rather
        // than consuming it as proof that the reader traversed the story.
        requiresRestorationEvidence = true;
      }
      var restoredWithEvidence =
        requiresRestorationEvidence && isAtVisibleEnd && evidenceReady();
      if (!crossedByScroll && !restoredWithEvidence) return;
      fired = true;
      cleanup();
      cb();
    }

    function scheduleDwellCheck() {
      if (
        interactionAt === null ||
        dwellTimer !== null ||
        !documentIsVisible()
      ) return;
      var remaining = Math.max(0, dwellMs - visibleDwellElapsed());
      if (remaining === 0) {
        check('evidence');
        return;
      }
      dwellTimer = setTimer(function () {
        dwellTimer = null;
        check('evidence');
      }, remaining);
    }

    function handleVisibilityChange() {
      var timestamp = now();
      if (documentIsVisible()) {
        if (visibleSince === null) visibleSince = timestamp;
        scheduleDwellCheck();
        check('visibility');
        return;
      }
      if (visibleSince !== null) {
        visibleElapsedMs += Math.max(0, timestamp - visibleSince);
        visibleSince = null;
      }
      if (dwellTimer !== null) {
        clearTimer(dwellTimer);
        dwellTimer = null;
      }
    }

    function recordPointerEvidence(event) {
      var rect = bodyEl.getBoundingClientRect();
      if (
        !documentIsVisible() ||
        !bodyIntersectsViewport(rect) ||
        !targetIsInsideStory(event && event.target)
      ) return;
      interactionAt = now();
      scheduleDwellCheck();
      check('evidence');
    }

    function recordKeyboardEvidence(event) {
      var rect = bodyEl.getBoundingClientRect();
      if (
        !documentIsVisible() ||
        !documentReadingContext(event, rect) ||
        !isReadingNavigationKey(event)
      ) return;
      interactionAt = now();
      scheduleDwellCheck();
      check('evidence');
    }

    function recordWheelEvidence(event) {
      var rect = bodyEl.getBoundingClientRect();
      if (!documentIsVisible() || !documentReadingContext(event, rect)) return;
      interactionAt = now();
      scheduleDwellCheck();
      check('evidence');
    }

    function recordFocusEvidence(event) {
      var rect = bodyEl.getBoundingClientRect();
      if (
        !documentIsVisible() ||
        !bodyIntersectsViewport(rect) ||
        !targetIsInsideStory(event && event.target)
      ) return;
      interactionAt = now();
      scheduleDwellCheck();
      check('evidence');
    }

    function handleScroll() {
      check('scroll');
    }

    function handleResize() {
      check('resize');
    }

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('touchstart', recordPointerEvidence, true);
      document.removeEventListener('touchend', recordPointerEvidence, true);
      document.removeEventListener('pointerdown', recordPointerEvidence, true);
      document.removeEventListener('pointerup', recordPointerEvidence, true);
      document.removeEventListener('click', recordPointerEvidence, true);
      document.removeEventListener('wheel', recordWheelEvidence, true);
      document.removeEventListener('keydown', recordKeyboardEvidence, true);
      document.removeEventListener('keyup', recordKeyboardEvidence, true);
      document.removeEventListener('focusin', recordFocusEvidence, true);
      if (dwellTimer !== null) {
        clearTimer(dwellTimer);
        dwellTimer = null;
      }
    }
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    // Capture navigation intent before the browser applies its default scroll.
    // `touchend`/`keyup` can arrive only after a large jump has already moved
    // the story out of the viewport, which is too late to attribute safely.
    document.addEventListener('touchstart', recordPointerEvidence, true);
    document.addEventListener('touchend', recordPointerEvidence, true);
    document.addEventListener('pointerdown', recordPointerEvidence, true);
    document.addEventListener('pointerup', recordPointerEvidence, true);
    document.addEventListener('click', recordPointerEvidence, true);
    document.addEventListener('wheel', recordWheelEvidence, true);
    document.addEventListener('keydown', recordKeyboardEvidence, true);
    document.addEventListener('keyup', recordKeyboardEvidence, true);
    document.addEventListener('focusin', recordFocusEvidence, true);
    check('install');
    return cleanup;
  }

  // ---- public mount ---------------------------------------------------------
  function mount(opts) {
    var band = buildBand(opts);
    if (opts.anchorEl && opts.placement !== 'corner') insertAfter(opts.anchorEl, band);
    else document.body.appendChild(band);
    return { node: band, remove: function () { removeNode(band); } };
  }

  function recovery(opts) {
    var band = buildRecoveryBand(opts);
    if (opts.anchorEl) insertAfter(opts.anchorEl, band);
    else document.body.appendChild(band);
    return { node: band, remove: function () { removeNode(band); } };
  }

  root.TraceFinishQualify = {
    mount: mount,
    recovery: recovery,
    toast: toast,
    onReachEnd: onReachEnd,
    _palette: T
  };
})(typeof window !== 'undefined' ? window : this);
