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
 *   // Silent path (work-state known) — no band, just a confirmation toast:
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

  // ---- Page tokens ---------------------------------------------------------
  // Trace page UI follows the host page's tone. collector.js publishes the
  // resolved tokens as --trace-page-* variables before it mounts anything
  // here; the light values are only a fallback.
  function tok(name, light) { return 'var(--trace-page-' + name + ',' + light + ')'; }
  var T = {
    surface: tok('surface', '#FFFFFF'), raised: tok('raised', '#E9EEF3'), rule: tok('rule', '#D8E0E7'),
    ink: tok('ink', '#18232D'), secondary: tok('secondary', '#5F6B76'), tertiary: tok('tertiary', '#7B8792'),
    teal: tok('teal', '#176E72'), warning: tok('warning', '#9B4146'),
    finished: tok('status-finished', '#197A5B'), caughtup: tok('status-caught-up', '#4C6F88'),
    sans: '-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif'
  };
  var SHADOW = '0 0 0 1px color-mix(in srgb,' + T.rule + ' 70%,transparent),0 14px 30px -12px rgba(0,0,0,.35)';
  var Z = 2147483646;
  var CONFIRMATION_AUTO_DISMISS_MS = 14000;

  // Work status is a source fact: the choices are words, never status dots
  //.
  var WORK = [
    ['complete', 'It’s complete'],
    ['wip', 'Still ongoing'],
    ['hiatus', 'On hiatus'],
    ['abandoned', 'Looks abandoned']
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
  function svg(viewBox, d, size, stroke) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', viewBox);
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', stroke || '1.8');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    node.style.cssText = 'display:block;flex:0 0 auto;width:' + size + 'px;height:' + size + 'px';
    [].concat(d).forEach(function (pathData) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      node.appendChild(path);
    });
    return node;
  }
  function checkGlyph(size) { return svg('0 0 20 20', ['M3.5 10.5l4.2 4.2L16.5 5.8'], size); }
  function alertGlyph(size) { return svg('0 0 16 16', ['M8 2l6.5 11.5h-13z', 'M8 6.5v3.2M8 11.7v.2'], size, '1.5'); }
  function statusDot(color) {
    return el('span', 'display:inline-block;flex:0 0 auto;width:7px;height:7px;border-radius:999px;background:' + color + ';');
  }
  function insertAfter(ref, node) { ref.parentNode.insertBefore(node, ref.nextSibling); }

  // Each finish surface resolves the host tone itself, so it is correct even
  // when it is the first Trace surface on the page.
  var TONES = {
    light: { surface: '#FFFFFF', raised: '#E9EEF3', rule: '#D8E0E7', ink: '#18232D', secondary: '#5F6B76',
      tertiary: '#7B8792', teal: '#176E72', warning: '#9B4146', 'status-finished': '#197A5B', 'status-caught-up': '#4C6F88' },
    dark: { surface: '#19232D', raised: '#24323F', rule: '#344451', ink: '#F2F6FA', secondary: '#AEBBC5',
      tertiary: '#8D9AA5', teal: '#8BCDC8', warning: '#E7A19F', 'status-finished': '#8BD8B6', 'status-caught-up': '#91B4CE' }
  };
  function hostTone() {
    function background(element) {
      if (!element || typeof window.getComputedStyle !== 'function') return null;
      var channels = (window.getComputedStyle(element).backgroundColor || '').match(/rgba?\(([^)]+)\)/i);
      if (!channels) return null;
      var parts = channels[1].split(',').map(Number);
      if (parts.length > 3 && parts[3] === 0) return null;
      return parts.slice(0, 3);
    }
    var rgb = background(document.body) || background(document.documentElement) || [255, 255, 255];
    var lin = rgb.map(function (c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722 < 0.18 ? TONES.dark : TONES.light;
  }
  function applyTone(node) {
    var tone = hostTone();
    Object.keys(tone).forEach(function (name) { node.style.setProperty('--trace-page-' + name, tone[name]); });
    return node;
  }

  // Announcements go through the page's one live region, created by
  // collector.js; the finish surfaces are never live regions themselves.
  function announce(message) {
    var live = document.querySelector('[data-trace-page-live-region]');
    if (!live || !message) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = message; }, 0);
  }

  function textAction(label, color) {
    var b = el('button',
      'display:inline-flex;align-items:center;cursor:pointer;background:transparent;border:0;'
      + 'min-height:44px;padding:0 8px;margin-left:-8px;font:500 14px/1.2 ' + T.sans + ';color:' + (color || T.teal) + ';',
      label);
    b.type = 'button';
    return b;
  }

  function surfaceStyle(corner) {
    return 'display:block;background:' + T.surface + ';border:0;border-radius:14px;overflow:hidden;'
      + 'box-shadow:' + SHADOW + ';'
      + '-webkit-font-smoothing:antialiased;animation:traceFinishArrive .3s ease-out both;'
      + (corner
          ? 'position:fixed;z-index:' + Z + ';width:340px;max-width:calc(100vw - 24px);right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));'
          : 'position:relative;width:100%;max-width:520px;margin:22px auto;');
  }

  function ensureMotionStyle() {
    if (document.getElementById('trace-finish-motion')) return;
    var style = document.createElement('style');
    style.id = 'trace-finish-motion';
    style.textContent = '@keyframes traceFinishArrive{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}'
      + '@media(prefers-reduced-motion:reduce){@keyframes traceFinishArrive{from{opacity:0}to{opacity:1}}}'
      + '[data-trace-finish-qualify] :focus-visible,[data-trace-finish-recovery] :focus-visible,[data-trace-finish-toast] :focus-visible{'
      + 'outline:3px solid ' + T.teal + '!important;outline-offset:2px!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- the qualify band -----------------------------------------------------
  function buildBand(opts) {
    var s = opts.story || {};
    var corner = opts.placement === 'corner';
    var inlineStart = !corner && opts.align === 'start';

    ensureMotionStyle();
    var wrap = el('aside', surfaceStyle(corner));
    if (inlineStart) wrap.style.margin = '22px 0';
    wrap.setAttribute('data-trace-finish-qualify', s.handle || '1');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Trace: you reached the end');

    var pad = el('div', 'padding:14px 16px 4px;');
    var head = el('div', 'font:600 17px/1.3 ' + T.sans + ';color:' + T.ink + ';');
    head.textContent = 'You reached the end';
    pad.appendChild(head);

    var sub = el('div', 'font:400 13px/1.4 ' + T.sans + ';color:' + T.secondary + ';margin-top:2px;');
    sub.textContent = s.src ? 'Is this work finished on ' + s.src + '?' : 'What is the work’s current status?';
    pad.appendChild(sub);

    // B2-style cells: surface with a rule ring, text only, 44 pt targets.
    var opt = el('div', 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:12px;');
    opt.setAttribute('role', 'group');
    opt.setAttribute('aria-label', 'Work status');
    WORK.forEach(function (w) {
      var b = el('button',
        'display:flex;align-items:center;cursor:pointer;min-width:0;min-height:44px;'
        + 'background:' + T.surface + ';box-shadow:inset 0 0 0 1px ' + T.rule + ';border-radius:12px;'
        + 'padding:6px 12px;font:500 14px/1.2 ' + T.sans + ';color:' + T.ink + ';');
      b.type = 'button';
      b.setAttribute('data-trace-work-choice', w[0]);
      b.textContent = w[1];
      b.addEventListener('mouseenter', function () { b.style.background = T.raised; });
      b.addEventListener('mouseleave', function () { b.style.background = T.surface; });
      b.addEventListener('click', function () {
        setBusy(wrap, true);
        var controls = {
          resolve: function () { showResolved(wrap, pad, w[0], opts); },
          fail: function (message) {
            setBusy(wrap, false);
            showError(pad, message || 'Your status wasn’t changed. Try again.');
          }
        };
        if (typeof opts.onQualify === 'function' && opts.onQualify(w[0], controls) === false) return;
        showResolved(wrap, pad, w[0], opts);
      });
      opt.appendChild(b);
    });
    pad.appendChild(opt);

    // A dismissal never spends teal.
    var dis = textAction(corner ? 'Dismiss' : 'Decide later', T.secondary);
    dis.style.marginTop = '2px';
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
    ensureMotionStyle();
    var wrap = el('aside', surfaceStyle(false));
    if (inlineStart) wrap.style.margin = '22px 0';
    wrap.setAttribute('data-trace-finish-recovery', s.handle || '1');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Trace couldn’t save the update');

    var pad = el('div', 'padding:14px 16px 4px;display:flex;gap:8px;align-items:flex-start;');
    var glyph = el('span', 'display:inline-flex;margin-top:2px;color:' + T.warning + ';');
    glyph.appendChild(alertGlyph(16));
    pad.appendChild(glyph);
    var body = el('div', 'min-width:0;flex:1;');
    body.appendChild(el('div',
      'font:600 15px/1.3 ' + T.sans + ';color:' + T.ink + ';',
      'Trace couldn’t save the update'));
    var message = el('div', 'font:400 13px/1.4 ' + T.sans + ';color:' + T.secondary + ';margin-top:2px;',
      opts.message || 'Your status wasn’t changed.');
    message.setAttribute('data-trace-finish-recovery-message', '1');
    body.appendChild(message);

    var actions = el('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;');
    var retry = textAction('Try again');
    retry.setAttribute('data-trace-finish-retry', '1');
    actions.appendChild(retry);

    if (typeof opts.onOpenInTrace === 'function') {
      var open = textAction('Open in Trace');
      open.setAttribute('data-trace-finish-open', '1');
      open.addEventListener('click', opts.onOpenInTrace);
      actions.appendChild(open);
    }
    body.appendChild(actions);
    pad.appendChild(body);
    wrap.appendChild(pad);
    announce('Trace couldn’t save the update. ' + message.textContent);

    function setRetryBusy(busy) {
      retry.disabled = busy === true;
      retry.style.cursor = busy === true ? 'wait' : 'pointer';
      retry.style.opacity = busy === true ? '0.55' : '1';
    }

    retry.addEventListener('click', function () {
      setRetryBusy(true);
      var controls = {
        resolve: function () { removeNode(wrap); },
        fail: function (nextMessage) {
          setRetryBusy(false);
          message.textContent = nextMessage || 'Your status wasn’t changed. Try again or open Trace.';
          announce(message.textContent);
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
      buttons[i].style.opacity = busy === true ? '0.55' : '1';
    }
  }

  // A failure is a warning-ink glyph beside ink text.
  function showError(pad, message) {
    var prev = pad.querySelector('[data-trace-finish-qualify-error]');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var err = el('div', 'display:flex;gap:6px;align-items:flex-start;margin-top:4px;font:500 13px/1.35 ' + T.sans + ';color:' + T.ink + ';');
    var glyph = el('span', 'display:inline-flex;margin-top:1px;color:' + T.warning + ';');
    glyph.appendChild(alertGlyph(14));
    err.appendChild(glyph);
    err.appendChild(el('span', '', message));
    err.setAttribute('data-trace-finish-qualify-error', '1');
    pad.appendChild(err);
    announce(message);
  }

  function workStatusResult(workState) {
    if (workState === 'complete') return { accent: T.finished, reader: 'Finished', title: 'Marked complete' };
    if (workState === 'wip') return { accent: T.caughtup, reader: 'Caught up', title: 'Marked ongoing' };
    if (workState === 'hiatus') return { accent: T.caughtup, reader: 'Caught up', title: 'Marked on hiatus' };
    if (workState === 'abandoned') return { accent: T.finished, reader: 'Finished', title: 'Marked abandoned' };
    return { accent: T.caughtup, reader: 'Caught up', title: 'Work status saved' };
  }

  // ---- resolved confirmation (replaces band body in place) ------------------
  // Confirmation is an ink check; the only colour is the reader-status dot.
  function showResolved(wrap, pad, workState, opts) {
    var result = workStatusResult(workState);
    pad.textContent = '';
    pad.style.padding = '14px 16px 4px';
    var row = el('div', 'display:flex;align-items:flex-start;gap:10px;');
    var ic = el('span', 'display:inline-flex;color:' + T.ink + ';margin-top:1px;');
    ic.appendChild(checkGlyph(20));
    var txt = el('div', 'min-width:0;flex:1;');
    var t1 = el('div', 'font:600 15px/1.3 ' + T.sans + ';color:' + T.ink + ';');
    t1.textContent = result.title;
    var t2 = el('div', 'display:flex;align-items:center;gap:6px;font:400 13px/1.4 ' + T.sans + ';color:' + T.secondary + ';margin-top:2px;');
    t2.appendChild(document.createTextNode('Your status is now'));
    t2.appendChild(statusDot(result.accent));
    t2.appendChild(el('span', 'font:500 13px/1.4 ' + T.sans + ';color:' + T.ink + ';', result.reader));
    txt.appendChild(t1); txt.appendChild(t2);

    if (typeof opts.onOpenInTrace === 'function') {
      var link = el('a',
        'display:inline-flex;align-items:center;min-height:44px;padding:0 8px;margin-left:-8px;cursor:pointer;'
        + 'font:500 14px/1.2 ' + T.sans + ';color:' + T.teal + ';text-decoration:none;');
      link.href = opts.traceHref || '#';
      link.textContent = 'Open in Trace';
      link.addEventListener('click', function (e) {
        if (!opts.traceHref) e.preventDefault();
        opts.onOpenInTrace();
      });
      txt.appendChild(link);
    } else {
      txt.style.paddingBottom = '10px';
    }
    row.appendChild(ic); row.appendChild(txt);
    pad.appendChild(row);
    announce(result.title + '. Your status is now ' + result.reader + '.');

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
  // The chapter-note anatomy: an ink check, the result and the story, with a
  // real, focusable Open in Trace button.
  function toast(opts) {
    var s = opts.story || {};
    var finished = opts.kind === 'finished';
    ensureMotionStyle();
    var t = el('div',
      'position:fixed;z-index:' + Z + ';right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));max-width:min(360px,calc(100vw - 36px));'
      + 'display:flex;align-items:center;gap:8px;'
      + 'background:' + T.surface + ';border:0;border-radius:14px;padding:8px 6px 8px 14px;'
      + 'box-shadow:' + SHADOW + ';'
      + 'animation:traceFinishArrive .3s ease-out both;');
    t.setAttribute('data-trace-finish-toast', '1');
    applyTone(t);
    var ic = el('span', 'display:inline-flex;color:' + T.ink + ';');
    ic.appendChild(checkGlyph(16));
    var txt = el('div', 'min-width:0;flex:1;');
    var b = el('span', 'display:block;font:600 14px/1.3 ' + T.sans + ';color:' + T.ink + ';');
    b.textContent = finished ? 'Marked Finished' : 'Marked Caught up';
    txt.appendChild(b);
    if (s.title) {
      txt.appendChild(el('span', 'display:block;font:400 12.5px/1.35 ' + T.sans + ';color:' + T.secondary + ';overflow-wrap:anywhere;', s.title));
    }
    t.appendChild(ic); t.appendChild(txt);
    if (typeof opts.onOpenInTrace === 'function') {
      var u = textAction('Open in Trace');
      u.style.marginLeft = '0';
      u.setAttribute('data-trace-finish-toast-open', '1');
      u.addEventListener('click', opts.onOpenInTrace);
      t.appendChild(u);
    }
    document.body.appendChild(t);
    announce(b.textContent + (s.title ? '. ' + s.title + '.' : '.'));
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
    var band = applyTone(buildBand(opts));
    if (opts.anchorEl && opts.placement !== 'corner') insertAfter(opts.anchorEl, band);
    else document.body.appendChild(band);
    return { node: band, remove: function () { removeNode(band); } };
  }

  function recovery(opts) {
    var band = applyTone(buildRecoveryBand(opts));
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
