/* ============================================================================
 * trace-finish-qualify.js
 * Drop-in, style-isolated end-of-story notes for AO3 / FFN.
 * Vanilla DOM, no framework, no shadow root; matches collector.js style.
 *
 * The last few lines of the LAST POSTED chapter stay in view for a short
 * dwell after the reader's own navigation (scrolling past does not count):
 *   - work-state KNOWN (e.g. AO3 "Complete Work")  -> set silently, then a
 *     quiet inline note with Undo right after the text (`done`)
 *   - work-state UNKNOWN                           -> ask with this band
 * Answer records work status and derives reader status: complete/abandoned => Finished, else => Caught up.
 *
 * USAGE (wire into your content scripts):
 *   const band = TraceFinishQualify.mount({
 *     anchorEl,                       // insert AFTER this (see anchors below)
 *     placement: 'inline',            // 'inline' (in flow) | 'corner' (fixed)
 *     align: 'center'|'start',        // inline only; start aligns with the host text column
 *     story: { src:'AO3', title:'…', chapter:33, total:33 },
 *     onQualify(workState){…},        // 'complete'|'wip'|'hiatus'|'abandoned'
 *     onDismiss(){…},
 *     onOpenInTrace(){…},             // optional quiet link; omit to hide
 *   });
 *   band.remove();
 *
 *   // Silent path (work-state known) — inline note after the text, with Undo:
 *   TraceFinishQualify.done({ anchorEl, align, kind:'finished'|'caughtup', story,
 *     previousLabel:'Reading', onUndo(controls){…}, onOpenInTrace });
 *
 * END TRIGGER helper:
 *   TraceFinishQualify.onReachEnd(chapterBodyEl, () => { …decide silent vs band… });
 *
 * ANCHORS (host pages) — every note sits right after the final chapter's
 * text, before end notes, kudos and comments:
 *   AO3 chapter : insertAfter the last chapter-text article, else #chapters
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
    control: tok('control', '#D8E0E7'),
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
    light: { surface: '#FFFFFF', raised: '#E9EEF3', rule: '#D8E0E7', control: '#D8E0E7', ink: '#18232D', secondary: '#5F6B76',
      tertiary: '#7B8792', teal: '#176E72', warning: '#9B4146', 'status-finished': '#197A5B', 'status-caught-up': '#4C6F88' },
    dark: { surface: '#121418', raised: '#1D1F23', rule: '#212429', control: '#686D75', ink: '#F2F5F8', secondary: '#B4BCC6',
      tertiary: '#9AA3AE', teal: '#8BCDC8', warning: '#E7A19F', 'status-finished': '#8ACDB2', 'status-caught-up': '#93BCCB' }
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

  // The end-of-story note is quiet: a surface with a hairline ring, no drop
  // shadow, sitting in the story's own column right after the final lines.
  // The fixed corner variant keeps its shadow because it floats over content.
  function surfaceStyle(corner) {
    return 'display:block;background:' + T.surface + ';border:0;border-radius:14px;overflow:hidden;'
      + '-webkit-font-smoothing:antialiased;animation:traceFinishArrive .3s ease-out both;'
      + (corner
          ? 'box-shadow:' + SHADOW + ';position:fixed;z-index:' + Z + ';width:340px;max-width:calc(100vw - 24px);right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));'
          : 'box-shadow:inset 0 0 0 1px ' + T.rule + ';position:relative;width:100%;max-width:520px;margin:16px auto;');
  }

  function ensureMotionStyle() {
    if (document.getElementById('trace-finish-motion')) return;
    var style = document.createElement('style');
    style.id = 'trace-finish-motion';
    style.textContent = '@keyframes traceFinishArrive{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}'
      + '@media(prefers-reduced-motion:reduce){@keyframes traceFinishArrive{from{opacity:0}to{opacity:1}}}'
      + '[data-trace-finish-qualify] :focus-visible,[data-trace-finish-recovery] :focus-visible,'
      + '[data-trace-finish-done] :focus-visible,[data-trace-finish-toast] :focus-visible{'
      + 'outline:3px solid ' + T.teal + '!important;outline-offset:2px!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  // Inline notes sit in the host's text column: `start` aligns with the
  // anchor's own text inset (AO3 pads its chapter article), `center` centres.
  function alignInline(node, opts) {
    if (opts.placement === 'corner' || opts.align !== 'start') return;
    var inset = 0;
    try {
      if (opts.anchorEl && typeof window.getComputedStyle === 'function') {
        inset = parseFloat(window.getComputedStyle(opts.anchorEl).paddingLeft) || 0;
      }
    } catch (_) { inset = 0; }
    node.style.margin = '16px 0';
    // Auto width fills the column after the inset, still capped at 520.
    node.style.width = 'auto';
    if (inset > 0) node.style.marginLeft = Math.min(inset, 64) + 'px';
  }

  function statusLine(prefix, accent, label, suffix) {
    var line = el('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:0 6px;font:400 13px/1.4 ' + T.sans + ';color:' + T.secondary + ';margin-top:1px;');
    line.setAttribute('data-trace-finish-status-line', '1');
    if (prefix) line.appendChild(el('span', 'font:inherit;color:inherit;', prefix));
    var status = el('span', 'display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit;');
    status.appendChild(statusDot(accent));
    status.appendChild(el('span', 'font:500 13px/1.4 ' + T.sans + ';color:' + T.ink + ';', label));
    line.appendChild(status);
    if (suffix) line.appendChild(el('span', 'font:inherit;color:inherit;', suffix));
    return line;
  }

  // ---- the qualify band -----------------------------------------------------
  // Shown only when the archive does not say whether the work is complete.
  // It never says "the end": the reader is at the latest posted chapter.
  function buildBand(opts) {
    var s = opts.story || {};
    var corner = opts.placement === 'corner';

    ensureMotionStyle();
    var wrap = el('aside', surfaceStyle(corner));
    wrap.setAttribute('data-trace-finish-qualify', s.handle || '1');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Trace: latest chapter');

    var pad = el('div', 'padding:10px 4px 12px 14px;');
    var headRow = el('div', 'display:flex;align-items:flex-start;gap:4px;');
    var headText = el('div', 'min-width:0;flex:1;padding-top:2px;');
    var head = el('div', 'font:600 15px/1.3 ' + T.sans + ';color:' + T.ink + ';');
    head.textContent = 'You’ve reached the latest chapter';
    headText.appendChild(head);
    var sub = el('div', 'font:400 13px/1.4 ' + T.sans + ';color:' + T.secondary + ';margin-top:1px;');
    sub.textContent = s.src ? 'Is this story complete on ' + s.src + '?' : 'Is this story complete?';
    headText.appendChild(sub);
    headRow.appendChild(headText);

    // A dismissal never spends teal: a tertiary × with a spoken action.
    var dis = el('button',
      'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer;'
      + 'width:44px;height:44px;margin:-8px 0 0;background:transparent;border:0;border-radius:12px;color:' + T.tertiary + ';');
    dis.type = 'button';
    dis.setAttribute('aria-label', corner ? 'Dismiss' : 'Decide later');
    dis.setAttribute('data-trace-finish-dismiss', '1');
    dis.appendChild(svg('0 0 16 16', ['M4 4l8 8M12 4l-8 8'], 14));
    dis.addEventListener('click', function () {
      if (typeof opts.onDismiss === 'function') opts.onDismiss();
      removeNode(wrap);
    });
    headRow.appendChild(dis);
    pad.appendChild(headRow);

    // B2-style cells: surface with a control-edge ring (3:1), text only, 44 pt
    // targets. One row on a desktop column, wrapping to two on a phone.
    var opt = el('div', 'display:grid;grid-template-columns:repeat(4,auto);gap:6px;margin-top:10px;padding-right:10px;');
    opt.setAttribute('data-trace-work-choices', '1');
    opt.setAttribute('role', 'group');
    opt.setAttribute('aria-label', 'Work status');
    WORK.forEach(function (w) {
      var b = el('button',
        'display:flex;align-items:center;justify-content:center;cursor:pointer;min-width:0;min-height:44px;'
        + 'background:' + T.surface + ';box-shadow:inset 0 0 0 1px ' + T.control + ';border-radius:12px;'
        + 'padding:6px 12px;font:500 14px/1.2 ' + T.sans + ';color:' + T.ink + ';text-align:center;');
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

    wrap.appendChild(pad);
    return wrap;
  }

  function buildRecoveryBand(opts) {
    var s = opts.story || {};
    ensureMotionStyle();
    var wrap = el('aside', surfaceStyle(false));
    wrap.setAttribute('data-trace-finish-recovery', s.handle || '1');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Trace couldn’t save the update');

    var pad = el('div', 'padding:10px 14px 2px;display:flex;gap:8px;align-items:flex-start;');
    var glyph = el('span', 'display:inline-flex;margin-top:2px;color:' + T.warning + ';');
    glyph.appendChild(alertGlyph(16));
    pad.appendChild(glyph);
    var body = el('div', 'min-width:0;flex:1;');
    body.appendChild(el('div',
      'font:600 15px/1.3 ' + T.sans + ';color:' + T.ink + ';',
      'Trace couldn’t save the update'));
    var message = el('div', 'font:400 13px/1.4 ' + T.sans + ';color:' + T.secondary + ';margin-top:1px;',
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
  function errorRow(message) {
    var err = el('div', 'display:flex;gap:6px;align-items:flex-start;margin-top:4px;font:500 13px/1.35 ' + T.sans + ';color:' + T.ink + ';');
    var glyph = el('span', 'display:inline-flex;margin-top:1px;color:' + T.warning + ';');
    glyph.appendChild(alertGlyph(14));
    err.appendChild(glyph);
    err.appendChild(el('span', '', message));
    return err;
  }

  function showError(pad, message) {
    var prev = pad.querySelector('[data-trace-finish-qualify-error]');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var err = errorRow(message);
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

  function openInTraceAction(opts) {
    var link = el('a',
      'display:inline-flex;align-items:center;min-height:44px;padding:0 8px;margin-left:-8px;cursor:pointer;'
      + 'font:500 14px/1.2 ' + T.sans + ';color:' + T.teal + ';text-decoration:none;');
    link.href = opts.traceHref || '#';
    link.textContent = 'Open in Trace';
    link.setAttribute('data-trace-finish-open', '1');
    link.addEventListener('click', function (e) {
      if (!opts.traceHref) e.preventDefault();
      opts.onOpenInTrace();
    });
    return link;
  }

  // ---- resolved confirmation (replaces band body in place) ------------------
  // Confirmation is an ink check; the only colour is the reader-status dot.
  function showResolved(wrap, pad, workState, opts) {
    var result = workStatusResult(workState);
    pad.textContent = '';
    pad.style.padding = '10px 14px 2px';
    wrap.setAttribute('aria-label', 'Trace: ' + result.title);
    var row = el('div', 'display:flex;align-items:flex-start;gap:10px;');
    var ic = el('span', 'display:inline-flex;color:' + T.ink + ';margin-top:2px;');
    ic.appendChild(checkGlyph(16));
    var txt = el('div', 'min-width:0;flex:1;');
    var t1 = el('div', 'font:600 15px/1.3 ' + T.sans + ';color:' + T.ink + ';');
    t1.textContent = result.title;
    txt.appendChild(t1);
    txt.appendChild(statusLine('Your status is now', result.accent, result.reader));

    if (typeof opts.onOpenInTrace === 'function') {
      txt.appendChild(openInTraceAction(opts));
    } else {
      txt.style.paddingBottom = '8px';
    }
    row.appendChild(ic); row.appendChild(txt);
    pad.appendChild(row);
    announce(result.title + '. Your status is now ' + result.reader + '.');

    if (opts.autoDismissMs !== 0) {
      setTimeout(function () { removeNode(wrap); }, opts.autoDismissMs || CONFIRMATION_AUTO_DISMISS_MS);
    }
  }

  // ---- automatic finish note (work state known) -----------------------------
  // The archive said whether the work is complete, so Trace already saved the
  // result. The note confirms it in the story column and offers Undo; it stays
  // until the reader leaves the page so Undo is never on a timer.
  var DONE_COPY = {
    finished: {
      title: 'You’ve reached the end', reader: 'Finished', accent: T.finished, suffix: null
    },
    caughtup: {
      title: 'You’re caught up', reader: 'Caught up', accent: T.caughtup, suffix: '· More chapters may follow'
    }
  };

  function buildDone(opts) {
    var s = opts.story || {};
    var copy = DONE_COPY[opts.kind === 'finished' ? 'finished' : 'caughtup'];
    ensureMotionStyle();
    var wrap = el('aside', surfaceStyle(false));
    wrap.setAttribute('data-trace-finish-done', opts.kind === 'finished' ? 'finished' : 'caughtup');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Trace: marked ' + copy.reader);

    var pad = el('div', 'padding:10px 14px 2px;display:flex;flex-wrap:wrap;align-items:flex-start;column-gap:16px;');
    var lead = el('div', 'display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1 1 220px;padding-bottom:8px;');
    var ic = el('span', 'display:inline-flex;color:' + T.ink + ';margin-top:2px;');
    ic.appendChild(checkGlyph(16));
    lead.appendChild(ic);
    var txt = el('div', 'min-width:0;flex:1;');
    var title = el('div', 'font:600 15px/1.3 ' + T.sans + ';color:' + T.ink + ';', copy.title);
    title.setAttribute('data-trace-finish-done-title', '1');
    txt.appendChild(title);
    var line = statusLine('Marked', copy.accent, copy.reader, copy.suffix);
    txt.appendChild(line);
    lead.appendChild(txt);
    pad.appendChild(lead);

    var actions = el('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;margin:-4px 0 0 34px;');
    var undo = null;
    if (typeof opts.onUndo === 'function') {
      undo = textAction('Undo');
      undo.setAttribute('data-trace-finish-undo', '1');
      undo.setAttribute('aria-label', 'Undo, keep this story as ' + (opts.previousLabel || 'it was'));
      actions.appendChild(undo);
    }
    if (typeof opts.onOpenInTrace === 'function') actions.appendChild(openInTraceAction(opts));
    if (actions.childNodes.length) pad.appendChild(actions);
    wrap.appendChild(pad);

    announce(copy.title + '. Marked ' + copy.reader + (s.title ? ': ' + s.title : '') + '.');

    if (undo) {
      undo.addEventListener('click', function () {
        if (undo.disabled) return;
        undo.disabled = true;
        undo.style.cursor = 'wait';
        undo.textContent = 'Undoing…';
        var prevErr = pad.querySelector('[data-trace-finish-undo-error]');
        if (prevErr && prevErr.parentNode) prevErr.parentNode.removeChild(prevErr);
        opts.onUndo({
          resolve: function (restoredLabel, restoredAccent) {
            var label = restoredLabel || opts.previousLabel || 'Reading';
            title.textContent = 'Undone';
            line.parentNode.replaceChild(
              statusLine('Your status is', restoredAccent || T.secondary, label), line);
            if (actions.parentNode) actions.parentNode.removeChild(actions);
            wrap.setAttribute('aria-label', 'Trace: undone');
            // Keep focus inside the note so a keyboard reader is not dropped
            // to the top of the page when the Undo button disappears.
            // The note is not a control, so it draws no ring of its own.
            wrap.setAttribute('tabindex', '-1');
            wrap.style.outline = 'none';
            try { wrap.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
            announce('Undone. Your status is ' + label + '.');
            setTimeout(function () { removeNode(wrap); }, opts.undoneDismissMs || 6000);
          },
          fail: function (message) {
            undo.disabled = false;
            undo.style.cursor = 'pointer';
            undo.textContent = 'Undo';
            var err = errorRow(message || 'Couldn’t undo. Try again.');
            err.setAttribute('data-trace-finish-undo-error', '1');
            err.style.flexBasis = '100%';
            err.style.margin = '0 0 8px 26px';
            pad.appendChild(err);
            announce(message || 'Couldn’t undo. Try again.');
          }
        });
      });
    }
    return wrap;
  }

  function removeNode(n) {
    if (!n || !n.parentNode) return;
    n.style.transition = 'opacity .2s ease';
    n.style.opacity = '0';
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 220);
  }

  // ---- fixed confirmation toast (fallback when no story anchor exists) ------
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

  // ---- end-of-text trigger --------------------------------------------------
  // The reader qualifies when the last few lines of the final chapter's text
  // have stayed in view for a short visible dwell. Scrolling straight past
  // the end, a browser restoring scroll position, or a deep link below the
  // story never qualifies on its own: the arrival must follow the reader's own
  // navigation in the story, and the end must then stay on screen.
  var END_ZONE_PX = 96;
  var END_DWELL_MS = 2000;

  function onReachEnd(bodyEl, cb, options) {
    if (!bodyEl) return function () {};
    var config = typeof options === 'number' ? { thresholdPx: options } : (options || {});
    var th = typeof config.thresholdPx === 'number' ? config.thresholdPx : 60;
    var endZonePx = typeof config.endZonePx === 'number' && config.endZonePx >= 0
      ? config.endZonePx
      : END_ZONE_PX;
    var dwellMs = typeof config.dwellMs === 'number' && config.dwellMs >= 0
      ? config.dwellMs
      : END_DWELL_MS;
    var now = typeof config.now === 'function' ? config.now : function () { return Date.now(); };
    var setTimer = typeof config.setTimer === 'function' ? config.setTimer : setTimeout;
    var clearTimer = typeof config.clearTimer === 'function' ? config.clearTimer : clearTimeout;
    var navigationEvidenceWindowMs =
      typeof config.navigationEvidenceWindowMs === 'number' && config.navigationEvidenceWindowMs >= 0
        ? config.navigationEvidenceWindowMs
        : 5000;
    var fired = false, cleaned = false, interactionAt = null, dwellTimer = null;
    // Visible time the end zone has spent on screen in its current stay.
    var inViewElapsedMs = 0, inViewSince = null;
    // Whether the current stay is the reader's own doing.
    var attributed = false;

    function documentIsVisible() {
      return typeof document.visibilityState !== 'string' || document.visibilityState === 'visible';
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

    // The last lines are in view when the text's bottom edge sits on screen
    // (within the threshold) and the final `endZonePx` of text has not yet
    // scrolled above the top edge. A short body counts as all end zone.
    function endZoneInView(rect) {
      var bottom = typeof rect.bottom === 'number' ? rect.bottom : Infinity;
      var top = typeof rect.top === 'number' ? rect.top : bottom;
      var zone = Math.min(endZonePx, Math.max(0, bottom - top));
      return bottom - window.innerHeight <= th && bottom - zone >= 0;
    }

    function inViewDwell() {
      if (inViewSince === null) return inViewElapsedMs;
      return inViewElapsedMs + Math.max(0, now() - inViewSince);
    }

    function hasRecentNavigationEvidence() {
      return interactionAt !== null && now() - interactionAt <= navigationEvidenceWindowMs;
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

    function cancelDwellTimer() {
      if (dwellTimer !== null) {
        clearTimer(dwellTimer);
        dwellTimer = null;
      }
    }

    function leaveEndZone() {
      inViewElapsedMs = 0;
      inViewSince = null;
      attributed = false;
      cancelDwellTimer();
    }

    function check() {
      if (fired || cleaned || !documentIsVisible()) return;
      var rect = bodyEl.getBoundingClientRect();
      if (!endZoneInView(rect)) {
        // Scrolling past (or back above) the last lines ends this stay.
        leaveEndZone();
        return;
      }
      if (inViewSince === null) inViewSince = now();
      if (!attributed && hasRecentNavigationEvidence()) attributed = true;
      // An unattributed stay (scroll restoration, a script) keeps counting
      // dwell, but only the reader's own story interaction can qualify it.
      if (!attributed) return;
      var remaining = dwellMs - inViewDwell();
      if (remaining > 0) {
        if (dwellTimer === null) {
          dwellTimer = setTimer(function () {
            dwellTimer = null;
            check();
          }, remaining);
        }
        return;
      }
      fired = true;
      cleanup();
      cb();
    }

    function handleVisibilityChange() {
      var timestamp = now();
      if (documentIsVisible()) {
        check();
        return;
      }
      if (inViewSince !== null) {
        inViewElapsedMs += Math.max(0, timestamp - inViewSince);
        inViewSince = null;
      }
      cancelDwellTimer();
    }

    function recordEvidence() {
      interactionAt = now();
      check();
    }

    function recordPointerEvidence(event) {
      var rect = bodyEl.getBoundingClientRect();
      if (
        !documentIsVisible() ||
        !bodyIntersectsViewport(rect) ||
        !targetIsInsideStory(event && event.target)
      ) return;
      recordEvidence();
    }

    function recordKeyboardEvidence(event) {
      var rect = bodyEl.getBoundingClientRect();
      if (
        !documentIsVisible() ||
        !documentReadingContext(event, rect) ||
        !isReadingNavigationKey(event)
      ) return;
      recordEvidence();
    }

    function recordWheelEvidence(event) {
      var rect = bodyEl.getBoundingClientRect();
      if (!documentIsVisible() || !documentReadingContext(event, rect)) return;
      recordEvidence();
    }

    function handleScroll() { check(); }
    function handleResize() { check(); }

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
      document.removeEventListener('focusin', recordPointerEvidence, true);
      cancelDwellTimer();
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
    document.addEventListener('focusin', recordPointerEvidence, true);
    check();
    return cleanup;
  }

  // ---- public mount ---------------------------------------------------------
  function place(node, opts) {
    if (opts.anchorEl && opts.anchorEl.parentNode && opts.placement !== 'corner') {
      alignInline(node, opts);
      // If the story text has already scrolled above the viewport (the AO3
      // chapter-wrapper fallback), keep what the reader is looking at still:
      // Safari has no scroll anchoring, so offset the inserted height.
      var anchorBottom = opts.anchorEl.getBoundingClientRect().bottom;
      insertAfter(opts.anchorEl, node);
      if (typeof anchorBottom === 'number' && anchorBottom < 0 && typeof window.scrollBy === 'function') {
        var shift = node.getBoundingClientRect().bottom - anchorBottom;
        if (shift > 0) {
          try { window.scrollBy(0, shift); } catch (_) { /* ignore */ }
        }
      }
    } else {
      document.body.appendChild(node);
    }
    return { node: node, remove: function () { removeNode(node); } };
  }

  // Four choices fit one row in a desktop column; a phone column gets 2 × 2
  // rather than an orphaned fourth cell.
  function layoutChoices(node) {
    var grid = node.querySelector('[data-trace-work-choices]');
    if (!grid) return;
    var width = node.getBoundingClientRect().width;
    grid.style.gridTemplateColumns = width && width < 470 ? 'repeat(2,minmax(0,1fr))' : 'repeat(4,auto)';
  }

  function mount(opts) {
    var handle = place(applyTone(buildBand(opts)), opts);
    layoutChoices(handle.node);
    return handle;
  }

  function recovery(opts) {
    return place(applyTone(buildRecoveryBand(opts)), opts);
  }

  function done(opts) {
    if (!opts || !opts.anchorEl || !opts.anchorEl.parentNode) return toast(opts || {});
    return place(applyTone(buildDone(opts)), opts);
  }

  root.TraceFinishQualify = {
    mount: mount,
    recovery: recovery,
    done: done,
    toast: toast,
    onReachEnd: onReachEnd,
    _palette: T
  };
})(typeof window !== 'undefined' ? window : this);
