# Extension UI Design Contract

This contract covers the iOS Safari popup and Trace controls injected into AO3
and FanFiction.net. The iOS popup follows the native Story Ink
field. Host-page controls use the native D1 status dots and D7 teal actions.
Chromium and Firefox retain their existing session and import flows, with the
shared token updates.

## Colour and type

| Token | Light | Dark |
| --- | --- | --- |
| Ground | `#F8FAFC` | `#07090C` |
| Surface | `#FFFFFF` | `#121418` |
| Raised (the app's `lifted` in dark) | `#E9EEF3` | `#1D1F23` |
| Rule (decorative hairlines and container edges only) | `#D8E0E7` | `#212429` |
| Control edge (the ring that bounds a control: status cells, inputs, scope buttons, the off switch track, the Site settings disclosure) | `#D8E0E7` | `#686D75` |
| Ink | `#18232D` | `#F2F5F8` |
| Secondary | `#5F6B76` | `#B4BCC6` |
| Tertiary | `#7A8590` | `#9AA3AE` |
| Popup action | `#C24C22` | `#FF8458` |
| Page action | `#176E72` | `#8BCDC8` |
| Warning ink | `#9B4146` | `#E7A19F` |

In dark, a control edge is at least 3:1 against the ground, well, surface, raised and lifted surfaces (WCAG 1.4.11). It is 3.17:1 against lifted, the lowest of these. Decorative rules stay faint. The light values are unchanged: the light control edge still equals the light rule (1.33:1 on white), and lifting it to 3:1 is a separate light-mode decision.

Page UI adds the private-record tokens:

| Page token | Light | Dark | Use |
| --- | --- | --- | --- |
| `authored` (brass) | `#9C6212` | `#DDA74E` | Stars, the `#` on private tags and the note rule. **Only** what the reader wrote. |
| `record-well` / `record-well-edge` | `#F1F4F7` / `#E4EAEF` | `#0D0F12` / `#212429` | The Your record well |
| `private-record` | `#696D65` | `#B4BCC6` | The “Your record” label and lock |
| `tertiary` (non-text) | popup `#7A8590`, page `#7B8792` | `#9AA3AE` | Chevrons and the × glyph. **Never text.** |

The earlier brass `#8A6420` / `#DCB976` is retired.

The dark column is the native app's B · Ink palette:
a blue-black near-black ground, near-white primary text, stepped greys, brass
only for what the reader wrote, and no brown or glow. The earlier navy Story
Ink dark (`#111922` ground) is retired.

The iOS popup inherits `-apple-system-body`; its type, spacing and buttons
scale with the user's text setting on one em ladder. The desktop toolbar
popup uses the same ladder on a 16 px base. Both use the system stack
`-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto,
sans-serif` with no stylistic sets. Page controls use the same stack and
never set visible text below 12 px. Repeated UI has no mono or editorial
serif face. Popup primary actions use vermilion; page actions use teal.
Confirmation checks use ink. Status colour belongs to the dot only.

Radii: sheets 20; groups, wells, notes and notices 14; buttons 12; small
controls 8.

| Status | Light dot | Dark dot |
| --- | --- | --- |
| Saved | `#666E68` | `#B5B9C0` |
| Reading | `#246DCC` | `#86B8EC` |
| Caught up | `#4C6F88` | `#93BCCB` |
| Paused | `#82651E` | `#C9BE96` |
| Finished | `#197A5B` | `#8ACDB2` |
| Dropped | `#7C5282` | `#BBA6CB` |

Page tone follows the host page's computed background, including a transparent
body resolved through `<html>`. It does not follow the phone's appearance.
A white AO3 page therefore receives light Trace tokens even on a dark phone.
Closed shadow notes receive the resolved variables directly.

### Status label

The status colour belongs to the dot only. **The label is always ink**, on the
handle, the lens, the sheet and the popup. Progress (“5/12”) is secondary with
tabular figures. These states are words, never dots: Error, Update failed,
Full, Signed out, Hidden, and work status (Complete, Ongoing, Hiatus,
Abandoned).

### Page grammar

Never on a host page:

- chips or pills;
- coloured bars or `border-left` accents;
- tinted fills or filled buttons;
- a Trace logo, fingerprint or “Trace” eyebrow;
- serif or mono type;
- text under 12 px, or uppercase tracked labels;
- truncated story titles or authors;
- an ASCII “...”: write “…”.

**Warning ink** is for failures only. It is never an eyebrow, a star, a bar,
“new chapters” or a heading tint. A failure is a warning-ink glyph beside ink
text.

**Teal** is for Trace's actions only: Add, Details, Open in Trace, Catch up,
Unhide, Connect, Reconnect, See Trace Unlimited. Teal is never used for
confirmation or status. Confirmation is an ink check.

## iOS Safari popup

Safari owns the sheet title, Done control, current-site question and the
five-site permission sheet. Trace owns only the web viewport underneath.
The popup has no brand row, connection label, Site settings, Disconnect or
Import in P1–P10. No popup shows a connection label; the desktop header is the
plain word “Trace” in ink. Its document scrolls; the action area stays at the visible
bottom when it fits within 30% of the viewport. At accessibility sizes or
when the area grows beyond 30%, it flows after the copy. Buttons keep a
single-line label and no horizontal overflow. P11 alone adds the status menu
and Settings row.

| State | Heading or record | Actions |
| --- | --- | --- |
| P1 Saving | Saving your story… | Raised Keep reading |
| P2 Saved | Story title, byline, Saved record | Raised Keep reading |
| P2 Saved, title not read yet | Saved to your Library, with an ink check; site and Saved record | Raised Keep reading |
| P3 More access | Next, tap **Always Allow**. | Filled Allow story sites |
| P3 lapse | Next, tap **Always Allow**. | Filled Allow story sites |
| P4 Safari prompt | Tap **Always Allow**, not the blue button. | Disabled Waiting for Safari… |
| P5 Delayed | Still confirming your story | Raised Keep reading; text Check again |
| P6 No account | Finish setup in the Trace app | Filled Open Trace |
| P7 Denied | Nothing was saved | Filled Try again; text Not now |
| P8 No story open | Open any story | None |
| P9 Unavailable | This story isn’t available | Text Close |
| P10 Tracking off | Automatic saving is off; unsaved story record | Filled Save this story; text Turn automatic saving on |
| P10 saving | As P10 | Disabled Saving…; text Turn automatic saving on |
| P10 failed | As P10, plus “Nothing was saved” with a warning glyph and the reason | Filled Try again; text Turn automatic saving on |
| P11 Returning | Story title and byline; status once, in the control, with chapter progress beside it | Status menu; Settings row; no primary action |

The states the first-run prototype never drew use the same anatomy: a
one-em secondary glyph inline with the headline (warning ink only for a
failure), body copy that says what did and didn't happen, and one action,
filled only when the state is the task. Retries are tertiary.

| State | Heading | Actions |
| --- | --- | --- |
| Other account (`identity_conflict`) | Safari was signed in to another account | Filled Open Trace |
| Connecting to the account | Connecting to your account… | None |
| Account not reached | Trace couldn’t connect to your account | Filled Open Trace; text Try again |
| Registration failure | Trace couldn’t finish setting up | Filled Try again |
| Page needs a reload | Reload this page to keep going | Filled Reload page |
| Library full | Your Library is full | Filled See Trace Unlimited; text Manage library |
| No story on this page | Open a story to finish | Text Close |
| List page after first save | Trace is on here | Settings row; no action |
| Another site | Trace works on AO3 and FanFiction.net | None |
| Trace's setup page, story open | Kicker “Trace is on”; Go to your story | One row per open story tab |
| Trace's setup page, no story open | Kicker “Trace is on”; Open any story | None |
| Trace's setup page, only that page allowed | Kicker “Allowed on this page only”; Next, tap **Always Allow**. | Filled Allow story sites |
| Offline (desktop) | Trace is temporarily offline | Text Try again |

P5 tells the reader to keep reading and, if the story hasn't appeared after a
minute, to reload the page. P8 covers every supported page with no story open,
including a site's home page, so it never points at titles on the page; a page
with no story never waits on one.

P2 never shows a stand-in for a title or author. Until the page has named the
story, the confirmation itself is the headline; the title, byline and kicker
replace it when the page answers. The popup that finishes setup on a story
shows P2 for that story even when the save landed before the popup first
looked, on AO3 and FanFiction.net alike.

On iPhone and iPad the Trace app holds the account, and the popup can learn
one of three things about it: the app has none (`signed_out` with
`credential_absent`), it is connected, or it could not be read
(`signed_out` with any other reason, a session still reading, or no reply).
Only the first shows P6.

A popup has one wait for the account, shared by the general view and the
setup flow; anything that needs the account while it is under way joins it.
While the answer is not known the popup shows “Connecting to your account…”
and asks again 1, 2 and 4 seconds after each answer. Ten seconds after the
wait began, however slow the reads were, it shows “Trace couldn’t connect to
your account” with its buttons, as it does straight away when Trace refuses
the account the app holds. P6 is followed by one quiet second look 1.2 seconds
later, for a reader who has only just signed up. Neither “Connecting…” nor
“couldn’t connect” mentions creating an account.

None of these is final while the popup is open. A read that comes back late
is still taken, and whenever the background publishes that an account
connected the popup asks once more and carries on by itself. A reply that
brings no answer leaves a settled view as it is and starts no timer.

On Trace's own setup page (`/safari-setup` on Trace's origin) the popup has
three things to say, in existing anatomy. With the story sites allowed and the
account connected: the kicker “Trace is on”, the headline “Go to your story”
and one row per open story tab in the same window, in the Settings row's form,
labelled with the tab's title on a single line (“Story on AO3” or “Story on
FanFiction.net” when the tab has none, or when its title is only its address).
The title is always shown as text. Tabs in Private Browsing and in other
windows are never rows. A tap brings that tab to the front and closes the
popup; a tab that has gone is dropped from the list. With no story open: “Open any
story” and “Trace saves it when it opens.” With only that page allowed
(Safari's blue button, or This Website): the P3 request in this page's words,
“Allowed on this page only”, “Next, tap **Always Allow**.”, the same rule line
and Allow story sites, then P4 while Safari asks and P7 if it is declined.
The setup page is never reloaded and nothing is claimed as saved there. Access
is asked for first; once it is given, the account states come before the list,
exactly as on every other page.

The other-account state never names either account and never claims a save.
A failed P10 save states what didn't happen; the button never quietly
re-enables. While the session hands over, a story the last page sync already
listed in the Library shows its record with “Checking your Library…”, not
“Saving your story…”.

P2 has no Open Trace app action. P11 has no Open Trace app or Import action.
The status menu is Saved, Reading, Caught up, Paused, Finished, Dropped. It
uses `menuitemradio`, marks the selected status with an ink check, moves focus
with the arrow keys, returns focus on Escape, and changes the record only after
the existing `TRACE_SET_READER_STATUS` command confirms. The status control is
44 pt tall with radius 12. A move from Saved to Reading retains the story sheet's chapter-one
correction. Errors use the story sheet's status error copy. Settings is a
second view with the existing four switches and Disconnect; Back returns to
the record. Disconnect is not part of first run.

After a complete five-origin grant, an unconfirmed story remains in P1
through session `initializing`, `connecting` and `verifying`; an archive page
shows P8. A confirmed account entry produces P2 on first save and P11 on a
later visit. An unavailable story produces P9. An app with no account produces
P6; an account that cannot be read or is refused produces the connecting and
account-not-reached states above. On each supported site popup open, `permissions.contains` rechecks the
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

N4 is a text-led listing line. A known work shows a status dot, an ink status
label and compact chapter progress; optional work marks are secondary. An
unknown work shows teal `+ Add to Trace` and secondary Hide with the eye-off
glyph. Neither is underlined. Trace's collapsed controls never recolour the
host work title.

### Your record on host pages

The story sheet and the listing action surface draw the reader's private
record in the record well: `record-well` fill with a `record-well-edge` inset,
radius 14, and a lock, “Your record” and “Only you” in `private-record`.
Inside the well:

- editable brass stars as the control, with 44 pt targets, or “Rated n of 5”
  where the entry can't be edited;
- the note preview with a 2 px brass rule;
- private tags as ink text with a brass `#`.

Dotted underlines and “Private context” are retired.

### Sheet anatomy

- Radius 20.
- Title SF 600 17 and author, both wrapping; the site goes in the byline.
- A 44 pt ×.
- The status grid: radius 12 cells on `surface` with a 1 px `control` inset; the
  chosen cell `raised` with a 2 px ink ring; 44 pt cells with radio-group
  semantics.
- Work marks and “n new chapters” sit on one secondary line; Catch up is teal
  text.
- Footer: “Open in Trace” in teal; Hide in secondary text.

### Other page surfaces

| Surface | Rule |
| --- | --- |
| Capacity notice | Radius 14, `surface`, rule ring. SF 600 17 title. Teal “See Trace Unlimited” and “Manage library”; secondary “Not now”. Announced once. |
| Connect / reconnect notice | As above. Refreshes page tokens itself. Safe-area inset; 44 pt ×. Heading in ink. |
| End-of-story notes: finish band, automatic finish note, resolved, recovery (`trace-finish-qualify.js`) | Inline, right after the final chapter's text and before end notes, kudos and comments; never fixed over the page. Radius 14, `surface`, rule ring, no drop shadow, at most 520 wide in the text column. Page tokens and host tone. The automatic note is an ink check, “You’ve reached the end” (or “You’re caught up · More chapters may follow” for an ongoing work) and the status dot, with teal Undo and Open in Trace; it stays until the reader leaves so Undo is never timed. The band asks “Is this story complete on ‹site›?” with text-only work-status choices and a tertiary × (“Decide later”). Warning glyph only on failure. Never takes focus; announced through the one body live region. The fixed toast remains only as a fallback when no story anchor exists. |
| Saved filters (`ao3-saved-filters.js`) | Trace's page register, not AO3's look: Story Ink groups, sentence-case labels, an ink check for the active filter, teal text actions, and an inline confirmation for Delete whose confirm word is warning ink. |

N2 appears once when the first newly saved story is confirmed. N2 and N3 are
radius 14. From 1.75× text, N2 stacks Details and × in a row under the text,
so the title keeps the full width. It says
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
an end-of-story note is visible. N3 lasts four seconds. N2 and N3 pause their
timers while focused. They enter with a 14 px rise and fade over 0.4 s and
leave with a fade; under Reduce Motion they fade only.

## Accessibility and boundaries

The popup has one live region, present empty from load. State announcements
are deduplicated. Page N2 and N3 speak through one empty-at-load body live
region; the visual note has no second `role=status`. Decorative glyphs are
hidden from assistive technology. Buttons keep their visible action phrase
first in the accessible name. Every Trace control on a page uses a visible
3 px teal focus outline with a 2 px offset; popup controls use the system
focus ring (`outline: auto`). Spinners are state feedback and stay under
Reduce Motion; nothing else is ambient.

### Lexicon

| Say | Instead of |
| --- | --- |
| “See Trace Unlimited” | “Get Trace Unlimited” |
| “Saved to your Library” / “In your Library” | “Saved to Trace”, “Your Trace library” |
| “Your record” | “Private context” |
| “Try again” | “Retry”, “Retry update”, “Try reload again” |

Never say “Connected” to a reader.

### Boundaries

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

The matrix index is `index.json`. It lists 288 popup captures (24 states) named
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
saved-filter and connection-notice fixtures. Each page surface family also has
a `-dark-host.png` twin rendered on a `#111` host background: the story top
and sheet, the listing line and action surface, both notices, the end-of-story
notes, and saved filters. The matrix adds the recovery states
(`P1-known-saved`, `P10-saving`, `P10-failed`, `P11-settings`,
`P11-status-error`, `other-account`, `registration-failure`, `reload-page`,
`library-full`, `no-story`, `on-list`).

The automated checks scan every popup rule for px font sizes, `ss01` and
serif faces; scan the page scripts for the retired brass, `border-left`,
`text-transform: uppercase`, ASCII “...” and AO3-red fills; and assert the
record well, brass stars, radio status grid and text-only work-status choices.
