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

- `paper`: `#fefcf7`
- `paper-2`: `#ece7dd`
- `card`: `#f7f4ed`
- `card-2`: `#efeae1`
- `ink`: `#151e1c`
- `ink-2`: `#27312e`
- `ink-3`: `#5b645f`
- `ink-4`: `#777f7a`
- `ink-5`: `#a5aaa6`
- `line`: `#d4cdc0`
- `line-strong`: `#bbb3a5`
- `forest`: `#2a5d53`
- `forest-deep`: `#183f37`
- `rust`: `#bc4329`
- `honey`: `#996e29`

Status mapping:

- `READING`: honey
- `PLANNING`: muted ink
- `PAUSED`: muted ink
- `COMPLETED`: forest
- `DROPPED`: rust
- hidden/preference states: muted ink with forest actions

Typography:

- UI: `Manrope` or `Geist`, then system sans-serif fallbacks
- Mono labels/progress: `Geist Mono`, then system monospace fallbacks
- Reserve serif type for infrequent editorial/error notices. Management
  surfaces, popup controls, and repeated archive annotations stay sans-serif.

## Ownership Grammar

Trace has two layers on an archive page:

- The archive owns the story facts and surrounding page.
- The reader owns status, place, rating, note, tags, hiding, and work marks.

The collapsed annotation must remain subordinate to the archive. The expanded
surface may become a deliberate Trace surface, but it still cannot restyle or
obscure archive content. Reader-owned context uses one quiet attached record
surface, a short brass rule, and a consistent inset. Do not invent a different
card, icon, or color for every field.

Archive and Trace brand marks must not repeat beside every work. The extension
popup may carry the Trace mark once. Inline actions and saved-filter modules use
plain text ownership where attribution is needed.

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
- Show an `Abandoned` or `Hiatus` work mark when present. If the source now
  challenges that mark, show only the useful delta, such as `+2 ch`.
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
- private note preview and private tags when provided by the API
- abandoned/hiatus work marks and source challenges when provided by the API
- hide/unhide
- `Open in Trace`

Visual rules:

- Keep it compact, flat, and text-led.
- Use the dark ink filled button only for the primary Trace action.
- Avoid nested cards and decorative sections.
- Use a single `Chapter N of total` position line. Do not add a decorative
  progress bar or restate the same progress in multiple controls.
- Render private tags as lightweight dotted-underlined annotations rather than
  generic pills.
- Use six direct status choices in a stable 3-by-2 grid. Status-specific color
  belongs to the dot; the selected control uses one consistent dark treatment.

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
- private note preview and dotted-underlined private tags where available
- abandoned/hiatus work mark where available, with challenge copy only when it
  changes the reader's decision
- footer with `Open in Trace` and hide/unhide controls

Intentional product choices:

- Do not add chapter stepper controls until the extension supports that behavior.
- If the API does not provide note text or tag names, do not fabricate them.
- Long notes and tags must be truncated so the sheet does not require awkward
  internal scrolling.
- Do not explain a work mark merely because it exists. `Marked hiatus` or
  `Marked abandoned` is sufficient until the source provides a meaningful
  challenge.

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
- Preferences use native-looking switch controls with a concise title and one
  line explaining the effect.
- `Saved filters on AO3` is a display preference only. Filter rules are created,
  edited, applied, and deleted inside AO3's real filter panel.
- The popup supports a reviewed light and dark palette while keeping the same
  hierarchy and state model.

## AO3 Saved Filters

- Render inside AO3's actual filters sidebar/panel; never replace it with a
  Trace-owned mock filter screen.
- Keep AO3's spacing, hierarchy, and action grammar recognizable. Trace adds a
  quiet active edge and direct rule controls rather than a separate app shell.
- Use `Saved filters` with quiet `by Trace` attribution. Do not add a repeated
  Trace logo or mark.
- Preserve the existing create, apply, rename, update, and delete behavior.
- Narrow layouts must remain operable inside AO3's own mobile filter flow.

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

- warm, restrained surface; concise sans-serif copy; one dark primary CTA;
  dismiss affordance
- rust/honey title tint only where the state needs it
- dismissal is required. A user may keep Trace installed without connecting it.

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

- `popup-connected.png`
- `popup-library-full-dark.png`
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
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://www.tracefiction.com npm run build:release
git diff --check
```
