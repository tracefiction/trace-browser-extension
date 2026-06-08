# Extension UI Design Contract

This document defines the current Trace browser extension UI contract. It covers
the UI injected into AO3 and FanFiction.net pages, plus the toolbar popup.

The design direction is called D1, or "Quiet Margin": Trace should feel like a
small reading annotation in the host page rather than a separate app embedded in
the page.

## Product Principles

- Preserve current behavior and data boundaries before visual fidelity.
- Keep injected UI low-footprint: small status dots, text actions, quiet labels,
  and minimal chrome.
- Keep Trace controls close to the content they affect.
- Avoid dominant warnings unless the state is actually an error.
- Do not introduce new host permissions, content-script matches, or collection
  behavior as part of visual work.

## Core Tokens

Use these values for extension-owned surfaces unless a host-page constraint
requires a local fallback.

Light surface:

- `paper`: `#f3efe4`
- `paper-2`: `#ebe6d7`
- `card`: `#f7f3e9`
- `card-2`: `#ede8d8`
- `ink`: `#1c2722`
- `ink-2`: `#3a4339`
- `ink-3`: `#6e6a5b`
- `ink-4`: `#9a9583`
- `ink-5`: `#c4bea8`
- `line`: `rgba(28, 39, 34, 0.10)`
- `line-strong`: `rgba(28, 39, 34, 0.18)`
- `forest`: `#1f4d3f`
- `forest-deep`: `#133029`
- `forest-soft`: `#d8e3d5`
- `rust`: `#b54a30`
- `rust-soft`: `#f1d8c8`
- `honey`: `#8a6e2a`
- `honey-soft`: `#ebdcab`

Status mapping:

- `READING`: honey
- `PLANNING`: muted ink
- `PAUSED`: muted ink
- `COMPLETED`: forest
- `DROPPED`: rust
- hidden/preference states: muted ink with forest actions

Typography:

- UI: `Geist`, then system sans-serif fallbacks
- Accent headings: `Fraunces`, then `Georgia`
- Mono labels/progress: `Geist Mono`, then system monospace fallbacks

## Listing Overlay

Placement remains owned by the existing collectors:

- AO3 listings: action row after the work header, with heading fallback.
- FFN listings: after the metadata row where available.
- Single-work pages do not use `library-overlay.js`; `collector.js` owns those.

Unknown works:

- Show `Add to Trace` as a forest text action with a small plus affordance.
- Show `Hide` as a muted text action.
- Do not use filled buttons or card-like chips in collapsed listing rows.

Known works:

- Show an inline lens: status dot, status label, optional mono progress.
- Do not show progress bars, chevrons, or full cards in collapsed listing rows.
- Keep update attention quiet in collapsed rows; detailed context belongs in the
  action surface.

Hidden works:

- Collapse the host row to a minimal `Hidden by Trace` placeholder.
- Use `Unhide` for the visible restore action.

Required state coverage:

- unknown
- adding
- known status with optional progress
- hidden and unhide
- auth failure connect/sign-in action
- free limit reached
- network/error retry
- rate limited

## Listing Action Surface

The listing action surface uses the same sheet grammar as story sheets because
it has more behavior than a collapsed row can safely expose.

Must preserve:

- lens click toggles the surface
- outside click and Escape close it
- desktop popover and mobile bottom-sheet positioning
- reading status choices
- reading position
- catch-up/new-chapter context
- private note preview and private tag pills when provided by the API
- hide/unhide
- `Open in Trace`

Visual rules:

- Keep it compact, flat, and text-led.
- Use the forest filled button only for the primary Trace action.
- Avoid nested cards and decorative sections.

## Story Handle

Placement remains owned by `collector.js`:

- AO3 story pages: near the story title/byline.
- FFN desktop/mobile: near the story header.

Collapsed handle:

- Inline, not a pill.
- Status dot, label, optional mono progress, and quiet chevron.
- Add state: `+ Add to Trace` as forest underlined text.
- Saving/error/free-limit/auth states use the same inline grammar.

Behavior to preserve:

- unknown authenticated stories can quick-add directly when safe.
- existing, hidden, signed-out, reconnect, and error states toggle the sheet.
- disabled behavior remains for free-limit and auth-expired auto-track errors.

## Story Sheet

The story sheet uses the shared sheet grammar:

- desktop: fixed popover near the story handle
- mobile: bottom sheet
- warm card background
- compact header
- segmented reading-status control
- reading-position block
- private note preview and private tag pills where available
- footer with `Open in Trace` and hide/unhide controls

Intentional product choices:

- Do not add chapter stepper controls until the extension supports that behavior.
- If the API does not provide note text or tag names, do not fabricate them.
- Long notes and tags must be truncated so the sheet does not require awkward
  internal scrolling.

## Toolbar Popup

The popup follows the same D1 visual language, with one browser-specific
constraint: Chromium extension popups are hosted in a rectangular window, so the
outer popup shell is intentionally rectangular. Inner controls still use D1
spacing, color, and typography.

State mapping:

- signed out: `Connect Trace`, no import, no preferences, sign-in CTA
- reconnect required: `Sign in again`, no import, no preferences
- error: `Check Trace connection`, no import, no preferences
- upgrade/free limit: `Library full`, upgrade CTA
- first story/listing: primary import action, secondary library action
- unsupported first run: AO3/FFN guidance links, no import
- connected after first save/library count: header connection state, preferences,
  open library, and import only when the current tab is importable

Popup rules:

- Show connection state only in the header for connected saved state.
- Preferences use check-square controls.
- Do not let system dark mode switch the popup to an unreviewed dark theme.

## Connection Notice

The page-level connection notice appears when the listing overlay cannot act due
to auth state.

Must preserve:

- shows for `signed_out`, `reconnect_required`, `error`, or missing auth
- does not show for `connected` with token
- does not show for `upgrade_required`
- dismisses by signature in session storage
- CTA opens the relevant Trace/help URL

Visual target:

- warm card, small serif title, concise body, one forest CTA, dismiss affordance
- rust/honey title tint only where the state needs it

## Privacy And Permissions

UI changes must not change what Trace can access or send.

Do not:

- add host permissions without a separate privacy review
- add content-script matches without a separate privacy review
- collect story text, full page HTML, cookies, credentials, private messages,
  drafts, comments, account settings, or unrelated browsing history
- show UI on AO3/FFN credential or password pages
- imply a story is saved before the server confirms it, except for existing
  tested optimistic states

The `TRACE_OPEN_TRACE_URL` message is intentionally limited to validated Trace
origins before opening a browser tab.

## Visual QA

Run visual fixtures for visible UI changes:

```bash
npm run visual:screenshots
```

Important generated screenshots include:

- `popup-connected-light.png`
- `popup-signed-out.png`
- `popup-reconnect-required.png`
- `popup-error.png`
- `ao3-desktop-known-action-row.png`
- `ao3-unknown-add-hide.png`
- `ao3-listing-action-surface.png`
- `ao3-story-top.png`
- `ao3-story-sheet.png`
- `ao3-story-signed-out-sheet.png`
- `ao3-listing-signed-out-notice.png`
- `ao3-listing-quick-add-free-limit.png`

## Validation

Use focused tests while iterating, then run the broader suite before handoff.

Focused commands:

```bash
node --test test/popup.test.js
node --test test/collector.test.js
node --test test/library-overlay-runtime.test.js test/library-overlay.test.js
node --test test/background-runtime.test.js
```

Full validation:

```bash
npm test
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://tracefiction.com npm run build:release
git diff --check
```
