# Extension UI Design Contract

This contract covers the iOS Safari popup and Trace controls injected into AO3
and FanFiction.net. The iOS popup follows the native Story Ink
field. Host-page controls use the native D1 status dots and D7 teal actions.
Chromium and Firefox retain their existing session and import flows, with the
shared token updates.

## Colour and type

| Token | Light | Dark |
| --- | --- | --- |
| Ground | `#F8FAFC` | `#111922` |
| Surface | `#FFFFFF` | `#19232D` |
| Raised | `#E9EEF3` | `#24323F` |
| Rule | `#D8E0E7` | `#344451` |
| Ink | `#18232D` | `#F2F6FA` |
| Secondary | `#5F6B76` | `#AEBBC5` |
| Tertiary | `#7A8590` | `#8D9AA5` |
| Popup action | `#C24C22` | `#FF986B` |
| Page action | `#176E72` | `#8BCDC8` |
| Warning ink | `#9B4146` | `#E7A19F` |

The iOS popup inherits `-apple-system-body`; its type, spacing and buttons
scale with the user's text setting. Page controls use the SF system stack and
never set visible text below 12 px. Repeated UI has no mono or editorial
serif face. Popup primary actions use vermilion; page actions use teal.
Confirmation checks use ink. Status colour belongs to the dot only.

| Status | Light dot | Dark dot |
| --- | --- | --- |
| Saved | `#666E68` | `#B4BDAF` |
| Reading | `#246DCC` | `#7DB8FF` |
| Caught up | `#4C6F88` | `#91B4CE` |
| Paused | `#82651E` | `#D4B76C` |
| Finished | `#197A5B` | `#8BD8B6` |
| Dropped | `#7C5282` | `#B99BC2` |

Page tone follows the host page's computed background, including a transparent
body resolved through `<html>`. It does not follow the phone's appearance.
A white AO3 page therefore receives light Trace tokens even on a dark phone.
Closed shadow notes receive the resolved variables directly.

## iOS Safari popup

Safari owns the sheet title, Done control, current-site question and the
five-site permission sheet. Trace owns only the web viewport underneath.
The popup has no brand row, connection label, Site settings, Disconnect or
Import in P1–P10. Its document scrolls; the action area stays at the visible
bottom when it fits within 30% of the viewport. At accessibility sizes or
when the area grows beyond 30%, it flows after the copy. Buttons keep a
single-line label and no horizontal overflow. P11 alone adds the status menu
and Settings row.

| State | Heading or record | Actions |
| --- | --- | --- |
| P1 Saving | Saving your story… | Raised Keep reading |
| P2 Saved | Story title, byline, Saved record | Raised Keep reading |
| P3 More access | Next, tap **Always Allow**. | Filled Allow story sites |
| P3 lapse | Next, tap **Always Allow**. | Filled Allow story sites |
| P4 Safari prompt | Tap **Always Allow**, not the blue button. | Disabled Waiting for Safari… |
| P5 Delayed | Still confirming your story | Raised Keep reading; text Check again |
| P6 Unlinked | Finish setup in the Trace app | Filled Open Trace |
| P7 Denied | Nothing was saved | Filled Try again; text Not now |
| P8 Listing | Open any story to save it | None |
| P9 Unavailable | This story isn’t available | Text Close |
| P10 Tracking off | Automatic saving is off; unsaved story record | Filled Save this story; text Turn automatic saving on |
| P11 Returning | Story title, byline, status and chapter record | Status menu; Settings row; no primary action |

P2 has no Open Trace app action. P11 has no Open Trace app or Import action.
The status menu is Saved, Reading, Caught up, Paused, Finished, Dropped. It
uses `menuitemradio`, marks the selected status, returns focus on Escape, and
changes the record only after the existing `TRACE_SET_READER_STATUS` command
confirms. A move from Saved to Reading retains the story sheet's chapter-one
correction. Errors use the story sheet's status error copy. Settings is a
second view with the existing four switches and Disconnect; Back returns to
the record. Disconnect is not part of first run.

After a complete five-origin grant, an unconfirmed story remains in P1
through session `initializing`, `connecting` and `verifying`; an archive page
shows P8. A confirmed account entry produces P2 on first save and P11 on a
later visit. An unavailable story produces P9. A credential failure produces
P6. On each supported site popup open, `permissions.contains` rechecks the
five earned origins. An incomplete grant after prior completion produces P3
lapse before any saving or connected copy; completion time remains stored.
Allow story sites makes the synchronous Safari permission request and then
registration. Denial produces P7.

P10 Save this story messages the page's quick-add path, creating one Library
entry for the current work. A second tap while pending does nothing. The
popup waits for a confirmed account projection before P11. Turn automatic
saving on persists `prefAutoTrackEnabled` and starts the P1 watch.

## Host-page controls

N1 is a plain inline story handle near the AO3 or FFN story heading. It has
a D1 status dot, ink label, tabular chapter progress and a chevron; the chevron
opens the existing story sheet. The add state is teal `+ Add to Trace`, with
no underline. The handle's accessible name is “Trace: Saved to your Library”
or “Trace: ‹Status›, chapter ‹n› of ‹m›”. The story sheet keeps its current
modal, focus, pending-mutation and recovery behaviour.

N4 is a text-led listing line. A known work shows a status dot, status and
compact chapter progress; optional work marks are ink. An unknown work shows
teal `+ Add to Trace` and secondary Hide with the eye-off glyph. Neither is
underlined. The action surface retains reading status, position, private
context and hide controls. Private tags use brass marks without dotted
underlines. Trace's collapsed controls never recolour the host work title.

N2 appears once when the first newly saved story is confirmed. It says
“Saved to your Library”, names the story and explains that Trace keeps the
reader's place. Details opens the story sheet; Dismiss ends the note. It is
fixed above Safari's toolbar in a closed shadow root, without moving page
content, and lasts 15 seconds. A tab-scoped marker lets a replaced page finish
the same note without a second announcement. The end-of-story band takes
precedence. The first-note flag stores only a boolean.

N3 says “Chapter ‹n› kept” and names the story. After N2 was shown or
delivered, the next three confirmed chapter rises may show it, once per page
load and never on the page that showed N2. The per-install local counter
`traceChapterKeptNotesShownV1` stops at three. No note appears for an
optimistic update, hidden work, disabled automatic progress, or while N2 or
the finish band is visible. N3 lasts four seconds. N2 and N3 pause their
timers while focused and remove motion when Reduce Motion is active.

## Accessibility and boundaries

The popup has one live region, present empty from load. State announcements
are deduplicated. Page N2 and N3 speak through one empty-at-load body live
region; the visual note has no second `role=status`. Decorative glyphs are
hidden from assistive technology. Buttons keep their visible action phrase
first in the accessible name. Page controls use a visible 3 px teal focus
outline; popup controls use the system focus ring.

These UI changes do not extend host permissions or collection. Do not read
story text, credentials, cookies, private messages, drafts, comments or
unrelated pages for UI state. Trace does not render on credential pages.
Only confirmed account state may be described as saved.

## Verification and captures

Run `npm test`, `npm run agent:check` with the HTTPS release origins, and
`git diff --check`. Use the repository fixture harness:

```bash
TRACE_VISUAL_OUTPUT_DIR=/tmp/trace-popup-page-restyle-evidence npm run visual:screenshots
TRACE_VISUAL_OUTPUT_DIR=/tmp/trace-popup-page-restyle-evidence node scripts/render-visual-fixtures.mjs --restyle-matrix
```

The matrix index is `index.json`. It lists 156 popup captures named
`‹device›-‹appearance›-‹size›__‹state›.png` for 17/SE, light/dark and
Large/xxxLarge/AX5; 72 page captures named
`‹device›-‹host-tone›-‹size›__‹state›.png`; and 12 white-host captures
with a light phone for comparison. The harness uses deterministic fixture
pages and 17/26/36 px text proxies. Safari's permission sheet, detent
behaviour, VoiceOver, Voice Control and actual Dynamic Type require simulator
and physical-device checks; preview captures do not certify them.

The regular visual fixture manifest also covers `popup-connected.png`,
`popup-library-full-dark.png`, `ao3-story-top.png`, `ao3-story-sheet.png`,
`ao3-unknown-add-hide.png`, `ao3-listing-action-surface.png` and the
saved-filter and connection-notice fixtures.
