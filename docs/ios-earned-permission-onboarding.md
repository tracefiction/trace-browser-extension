# iOS earned-permission onboarding

The Safari extension requires complete Website Access before saving a story.

## Permission model

The iPhone and iPad build declares:

- `permissions`: `alarms`, `storage`, `nativeMessaging`, `activeTab`,
  `scripting`. There is no `tabs` permission.
- `host_permissions`: none.
- `optional_host_permissions`: the five story-site patterns listed below.
  Trace's own website is not named.
- no `content_scripts`.

With no required website and no `tabs`, opening Trace from Safari raises no
website question. `activeTab` covers only the tab Trace was opened on, and is
used to read that tab's address. Nothing is injected and nothing is saved
before the five story sites are allowed.

The background worker registers the two page scripts
(`trace-archive-automation-v1`, `trace-ao3-saved-filters-v1`) when
`permissions.contains` confirms all five patterns. It checks on worker start,
on install and update, when website access is added or removed, and each time
the popup opens. Story tabs that are already open get the same scripts, under
the same complete grant: after an update, and when the reader allows the sites
from the popup or in Safari's settings.

A check that cannot finish (Safari did not answer, the registration was
refused, or a reader who had the grant read once as not having it) is tried
again by alarm after 1, 5, 30 and 180 minutes, then once a day. The alarm's
name carries how far the retries have got, so the bound holds even when
nothing can be stored. An update or a new grant starts the count afresh; a
complete registration or a settled "not allowed" ends the retries.

A reader whose access has ended pays the pause between two readings once: the
confirmed ending is recorded, and until access returns or Safari reports a new
grant, one incomplete reading with no script left to remove needs no second.

The scripts are removed when that access ends. Because nothing on a story page
can wake the worker once they are gone, an ending is acted on only when two
readings two seconds apart both report incomplete access and Safari listed
what is granted both times. A reading that cannot be taken removes nothing.

A reader who finished setup under an earlier build keeps that record when the
scripts are registered for them: an update never asks for website access and
never sends them through setup again. A reader whose access is incomplete after
an update gets no script and no question; opening Trace offers the same
recovery as before.

Background code asks Safari only for tabs at story-site addresses, and only
under the complete grant. It never asks for every open tab and, in this build,
never for a tab of Trace's own website, and it never opens Trace's setup page;
that holds on an iPad that reports itself as a Mac.

Mac Safari, Chrome and Firefox are built with `npm run build:release` and keep
required story sites, `tabs`, and manifest-declared scripts.

### Saving on the first tap (development switch)

`TRACE_IOS_FIRST_TAP_SAVE=1` turns on a save made when the reader opens Trace
on a story before the story sites are allowed. Every state of it has its
wording; it has not yet been proven end to end in Safari. On a sheet too
short to show a state whole, the rule line and the main button stay pinned
and the quieter button scrolls with the content; at the largest text sizes
nothing is pinned. Three rules keep it
a development switch:

- No release build can turn it on, whatever else is set. Shipping it is a
  change to `scripts/build.mjs`, made on purpose.
- A development build that talks to the production service can turn it on only
  with `TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF=1` given on the command line. A
  line in `.env` is not enough. `npm run build:ios-first-tap-proof` is that
  build. Any build with the switch on names itself "Trace (first-tap proof)"
  in its manifest and says so in the build log.
- With it off, its background wiring and `page-manual-mode.js` are left out of
  the package. The popup's and the page script's own code for it stays in
  `popup.js` and `collector.js`, which are shipped as written; it does nothing
  without the build's configuration or the injected file.

It asks Safari for nothing more: the manifest is the same.

With it on, opening Trace on a story page does this:

1. The popup opens a port to the background and names the tab it was opened
   on: its id, its address and whether it is private, as the popup read them
   in the reader's tap. Only Trace's own popup can open that port. The
   background looks no tab up for itself, by id or by search: a tab lookup
   with no address filter can make Safari ask the reader about website
   access. Injection itself works only in the tab the reader opened Trace
   on, because that is all `activeTab` covers, and the page reached there has
   to name the same story as the address the popup gave, or nothing is sent.
2. The background reads the account for this open. An account it could not
   read is reported as not known, never as signed out. With automatic saving
   off, nothing is saved until the reader asks.
3. The background injects `page-manual-mode.js` and the page script into that
   one tab. In manual mode the page script starts nothing by itself: no
   automatic save, no report that it ran, no story details sent. It reads the
   mode each time it is about to send.
4. The page hands the background the story's details. The background checks
   them exactly as a save the page had sent, and makes the save through the
   same guarded path as every other: look first, write only if absent, look
   again if the write's answer is uncertain.
5. After a confirmed save the popup offers the ask for lasting access,
   described below.
6. When the story sites are allowed and the page scripts registered, a page
   in manual mode is told to leave it. The same script carries on as on any
   page, with no reload: no second one is started, the story is not saved
   again, and what it sends from then on is stamped automatic.

#### The ask for lasting access

The request (`permissions.request` for the five story-site patterns) is made
by the popup, in the reader's tap on the popup's own button and before
anything is awaited: Safari raises its question only for a request made that
way. A second tap while one is out does nothing.

What came of it is said by the background, from what it reads afterwards. What
the request returned is passed along as evidence and is never the answer:

| State | When |
| --- | --- |
| waiting | The request is out. While it is, the popup reads what Safari allows again every 2 seconds, and when it comes back into view. |
| allowed | All five story sites read back as allowed just now, and the page scripts are registered. It carries what was read of the account and of the automatic-saving preference, so the popup claims saving is automatic only when both were read as so. |
| registration failed / not known | The sites are allowed; the page scripts are not registered, or that could not be read. Trying again asks Safari for nothing. |
| partly allowed | Fewer than five. Never drawn as allowed. |
| not allowed | The request came back false, and the sites do not read as allowed. |
| could not ask | The request threw. The popup shows this exactly as it shows not allowed. |
| not known | What Safari allows could not be read; the request came back true and the read says no; it came back with neither; or it did not come back within a minute. Never drawn as not allowed. The reader can ask again. |
| not asked | Not allowed, with no request made by this popup. The save is shown with the ask. |

No state says how long the access lasts. Safari reports a grant for one day
and a lasting one the same way, so Trace cannot tell them apart. Nor can it
tell a reader who answered "no" from Safari answering "no" without showing its
question: both are a request that came back false. Nothing is read into how
long a request took.

The wait does not depend on the request ever coming back. If the sites read as
allowed while it is out, the popup goes on as allowed. After 60 seconds with
neither an answer nor the sites allowed it says it does not know, and offers
the ask again; a request that comes back later is still passed to the
background. A minute is far longer than Safari's question takes to answer, and
since a later answer is still read, the deadline costs a slow reader nothing.
No wait, however long, is taken as "no".

#### What the sheet shows

Each state is one arrangement of the same parts: a short confirmation line,
the story's record (title, author and site, and the entry's real status), a
headline and body, a rule line above a button that leads to Safari's question,
and at most two buttons. All of its words are in `FIRST_TAP_WORDS` in
`popup.js`; the ones still to be reviewed are marked there.

- A confirmed save, while the story sites are not allowed, is one line that
  says so ("Saved to your Library"), and under it the ask is the sheet's
  headline and body, with the picture of Safari's question beside the body.
  Both arrive together in one cross-fade, so nothing moves when the ask comes.
  On an iPhone-sized sheet at its first height and the default text size, the
  line, the ask, the whole picture and both buttons fit without scrolling.
  Opening Trace never raises Safari's question; only the reader's tap on the
  ask does.
- "Not allowed" and "could not ask" are one state for the reader. The save is
  kept and said to be, saving stays one tap away, and "Try again" goes back to
  the ask. Trace cannot tell a reader's "no" from Safari's, so it does not try
  to describe either.
- "Allowed" says that saving is automatic only when the account and the
  preference were both read as so just now. Otherwise it says the sites are
  allowed and no more. With the preference off it offers to turn it on.
- Nothing sends the reader to Safari's settings to check access, and nothing
  says what that screen shows: it is not a dependable display of what an
  extension has been allowed. The sheet reports what the browser's permission
  reads and confirmed saves say.
- The number of addresses in the ask is counted from the build's own list.
- Before iOS 26 every button in Safari's question is blue, so there the rule
  line does not point at a colour.

For a reader using VoiceOver each state's news is announced through one polite
live region, in a spoken form with no symbols; the record and the rule line
carry spoken alternatives; decorative marks are hidden; and the rule line is
the description of the button it stands over. At the largest text sizes
nothing is pinned, labels wrap, and the rule line and button come last. Both
colour schemes use the popup's own tokens. Under Reduce Motion an arrival is a
short cross-fade and the progress mark stands still.

While the sheet is open the popup listens for Safari adding or removing
website access, and has the background read again when it does or when the
popup comes back into view, so "allowed" is not left on show after the access
it describes has gone.

A popup closed while Safari's question is up loses nothing. Nothing about the
ask is kept; the next popup reads what holds. Opened on a story with the sites
allowed but no page yet seen running under them, the popup shows what the
background read, and does not reload the story.

#### From the first manual save to automatic saving

Which pages are in manual mode is not taken from the background's memory. It
may have slept since it injected them, and the reader may have allowed the
sites in Safari's settings with no popup open. So, once the sites are allowed
and the scripts registered (when the registration finishes, when a background
starts, and when a popup reads "allowed"), the background asks for the open
story-site tabs by address and tells each one; a page that is not in manual
mode refuses. A page in manual mode also asks for itself when the reader comes
back to it, which reaches a background that was asleep when the sites were
allowed. The scripts that were never on that page (the Library overlay, saved
filters) are put in by the same recovery that serves every open story tab
after a grant, each behind its own guard against starting twice.

`HAND_OVER_BY_RELOADING_THE_PAGE` in `story-site-access.mts` is the one switch
for the fallback: when `true`, a page in manual mode is reloaded once instead,
and the registered scripts start in the new document. It is `false`.

There is one record for each account and story, held by the background. The
popup draws it and the page shows its mark from it, once no popup is open over
the page. Within one attempt a later answer for the same account and story can
only improve the record: a confirmation is never replaced by a failure, and a
known origin is never replaced by an unknown one. A change of account is its
own state, and nothing held for the old account is shown or kept.

What a record says:

- **Saved, already there, or found.** From the save's own outcome: its write
  was confirmed; the story was found before anything was written, with nothing
  earlier in doubt; or it is in the Library and whether this reader's tap put
  it there is not known. A write is recorded as in doubt before it goes out.
  While one is in doubt for a story, in a private tab, when storage cannot be
  read, or after a record in doubt had to be dropped, a story found is never
  called already there. A doubt outlives the account session it arose under:
  the same reader may have signed out and in again, so a story with a write
  in doubt from an ended session of an account is found, not already there,
  for that account, until Trace has confirmed it for that account. Another
  account saving the same story neither raises nor clears it.
- **Never sent, refused, or sent and unconfirmed.** Recorded around the write
  itself. Only "never sent" supports saying nothing was sent.
- **Check again** only looks, and has no path to a save. Each tap makes one
  request from the background: `GET /api/extension/library-membership` with
  the story's key (`ao3:<id>` or `ffn:<id>`, the key the save was made under)
  as its only parameter, under the same sign-in as the extension's other
  Library reads. Trace answers for that one story, so unlike the whole-Library
  read its "absent" is an answer. Found improves the record. Absent is
  reported as not in the Library, with the way to save again, and only when
  no save of the story is still out; the write that went unanswered stays in
  doubt, so a story found later is still not called already there. A look
  asked for while one is still out joins it, and the popup's button waits
  until its own answer comes back, so one check is one request. A
  sign-in Trace turns down is reported as an account to reconnect. A request
  that fails, is turned away as too many, meets a server error or comes back
  unreadable or about another story leaves the story's place not known, never
  absent. Nothing is answered from a kept copy of the Library. Only a build
  with the switch on contains this request. A popup reopened after a write in
  doubt looks first, and does not offer to save a story that may be saved.
- **One save for one story.** Opens of the same account and story are worked
  out one at a time, so two that arrive together (a double tap on a button
  that opens, or two popups) start one save and are both shown it.
- **A save that fails after the ask.** The ask can be made while a save is
  still being confirmed. If the save then fails, the popup shows the save's
  own state, not what came of the ask; only the story sites being allowed
  stands in its place, since from then the page saves the story by itself.
- **Manual or automatic.** Stamped by the background when it admits a save:
  manual when it injected that page itself and the story sites were not
  allowed, automatic when they were allowed and the page scripts registered.
  A page's own claim is never read. The stamp stays in the extension for now.

What is kept in extension storage for this: one random salt for the install,
and at most 20 records. A record holds two digests salted with it (one of the
account's session, one of that and the story's key), a time, whether a write is
in doubt, and the outcome with the Library entry's status and chapter numbers.
It holds no work key, address, title or author. A settled record is dropped
after 24 hours; one still in doubt is kept until the limit forces it out.
A record in doubt also holds a digest, salted the same way, of the account
itself and the story. When its account session ends, that digest is what
stays (at most 20), so that the doubt can still be placed on that account's
story; the session's records go.

Nothing about a story is kept for a tab in Private Browsing, or for a tab the
browser did not report as an ordinary one. While a write from such a tab is
out and unanswered, a count of such writes and the time of the last are kept:
two numbers, with no story, tab or account. A background that starts and finds
the count above zero knows a write of unknown fate went missing with the one
before it, and calls no story on this install already there until 30 days
after that write. The same 30 days apply to any other doubt that can no longer
be placed on an account and a story.

## User contract

When `TRACE_IOS_EARNED_PERMISSION_ONBOARDING=1`:

- the app first asks the user to enable Trace and set Website Access to Allow in
  one Safari Settings visit;
- after the extension is enabled, the user may open any supported AO3 or
  FanFiction.net page to request the five-site grant; on a story, a complete
  Settings grant lets the normal content script start and save automatically;
- if Trace does not start, the app shows a literal Safari extension-button
  guide plus Safari Settings as the alternate recovery;
- opening Trace from Safari obtains only Safari's current-site interaction
  needed to identify the supported page. It does not inject a collector or
  send a save command before complete Website Access;
- one direct action requests exactly five supported origin patterns and tells
  the reader to choose **Always Allow**;
- denial/cancel or an incomplete grant saves nothing and remains retryable;
- a complete existing grant skips the prompt;
- the background worker owns the complete-bundle readiness decision. No
  page script is registered when coverage is partial, so one working
  hostname cannot be presented as complete setup;
- after the complete grant on a story, the popup reloads it. The normal
  pending-handoff path then supplies the fresh run and server-confirmed save;
- after the complete grant and registration on a supported nonstory page,
  permission setup completes without a reload or a save claim. The popup tells
  the reader to open any story, where saving is confirmed separately;
- a story is described as saved only after the current app account's confirmed
  entry exists for that exact story. A loaded FanFiction.net `/s/` page without
  chapter text is unavailable, so the popup shows that state rather than
  waiting indefinitely for confirmation;
- revoked or expired access returns to the same permission recovery on the next
  positive signal; inactivity alone is never treated as permission loss;
- Chrome and Firefox packages remain production-shaped.

The popup requests these five minimized patterns from the bounded required host
set:

- `https://*.archiveofourown.org/*`
- `https://*.archiveofourown.gay/*`
- `https://archive.transformativeworks.org/*`
- `https://www.fanfiction.net/*`
- `https://m.fanfiction.net/*`

Archive login, signup, password, authentication, and logout routes are excluded
from the registered scripts. The flow stores a bounded local
list of coarse event names and timestamps for device-side diagnosis and, with
the first-tap switch on, the records described above. It adds no
network telemetry, URLs, readable story identity, account identity, page HTML, story
text, cookies, or credentials.

## Build

The normal production-origin build is:

```bash
npm run build:ios-earned-permission-onboarding:release
```

`npm run build:ios-earned-permission-onboarding:required-hosts:release` builds
the earlier shape instead: the story sites and Trace's website required,
`tabs`, and three manifest-declared scripts that stay inert until the five
patterns are allowed.

The script pins both production origins, opts in to the native Library Import
handoff (`TRACE_NATIVE_IMPORT_CONTRACT=trace-native-library-import-v1`, so the
background carries `nativeImportHandoff: true`), and writes the public extension
resources consumed by Safari. The committed resources are this build's output. The private Apple client separately verifies
that its Xcode target and native Settings bridge use
`com.tracefiction.trace.extension`, and verifies the archived app against this
exact public source revision.

The preview-release script exercises a paired development build using reserved,
non-routable test origins (`https://web.development.example.test` and
`https://api.development.example.test`). These are fixtures, not live services.
A local development deployment must explicitly update the paired build origins
and native receipt allowlist together with the containing app's configuration.
Production builds remain pinned to Trace's production API and web origins.

Run `npm run build:ios-earned-permission-onboarding:release` after any preview
or generic build to restore the Safari resources for this onboarding variant.

## Physical-device protocol

### Existing-user upgrade gate

Use a real iPhone or iPad. Do not uninstall, sign out, disable the extension,
or change Website Access between the baseline and candidate.

The candidate's manifest differs from the public build's: the story sites move
from required to optional, `tabs` goes, and `activeTab` and `scripting` arrive.
Whether Safari keeps a reader's Website Access across that change is decided by
Safari, not by this code, so run the whole gate once for each starting state:

- the five story sites allowed with **Always Allow**;
- **Always Allow on Every Website**;
- one story site only;
- nothing allowed;
- **Allow for One Day**, not yet expired.

For the first two, saving must continue with no prompt. For the next two,
nothing may be saved and no prompt may appear until the reader opens Trace. In
every case the extension must still be enabled after the update, and a story
tab left open across it must record the next chapter. Record what Safari's
settings show for Trace before and after.

1. Install the current public App Store build and sign in to an existing Trace
   account.
2. Confirm a known baseline on AO3 and FFN: existing overlays load, one manual
   add succeeds, one automatic story/progress update succeeds, and the server
   state appears in the Library.
3. Install the production-identity candidate through TestFlight over that baseline.
4. Before opening the updated Trace app, open a supported story in Safari.
   Confirm Trace still runs and no enablement, Website Access, or reconnect
   prompt interrupts the reader.
5. Open Trace. Confirm the same account and Library remain present and the app
   does not restart onboarding.
6. Repeat manual add, automatic tracking, overlay state, and server-confirmed
   sync on canonical AO3, an AO3 variant, desktop/mobile FFN, and a different
   story.
7. Restart Safari and repeat on AO3 and FFN. Reboot the device and repeat once.
8. Sign out and back in only after continuity has passed; confirm the extension
   adopts the current account without stale-account writes.

Any lost permission, unexpected onboarding, missing overlay, disconnected
extension, duplicate/stale write, or tracking/sync regression fails the release
candidate.

### New-user production onboarding gate

After recording the upgrade result, use a clean device/identity when available.
If Safari retains state on the only device, explicitly record the retained
state and use a separately verified fresh-identity result as the clean permission proof;
do not describe an uninstall as clean when Safari restored the grant.

1. Delete the earlier Trace build, confirm its Safari extension has gone, and
   restart Safari.
2. Install the candidate, sign in inside Trace, and open Safari Settings from
   onboarding. Turn on **Allow Extension** and set the listed Website Access
   permissions to **Allow** in that one visit.
3. Return to Trace, choose AO3 or FanFiction.net, and open a story. Confirm Trace
   starts without a toolbar action, the fresh run is received, the server
   confirms the save, and only then does the app complete onboarding.
4. Reset to a clean extension identity. This time enable the extension but leave
   Website Access on Ask. Open a story from Trace. Confirm no story is saved.
5. Follow the app's visual recovery: open Trace from Safari's extension button.
   Confirm the popup identifies the story but sends no save and presents
   **Allow access and add story**.
6. Choose that action and **Always Allow** in every Safari prompt. Confirm the
   exact five-origin bundle is granted, registration succeeds, and the story
   reloads. The reloaded content script must produce the run and save receipts.
7. Repeat the clean recovery but choose Deny/cancel. Confirm the story remains
   absent, **Try again** is available, and the Settings path is visible. Retry
   successfully without restarting onboarding.
8. Start with four of five origins allowed. Confirm Trace treats coverage as
   incomplete, does not save, and requests/reconciles the missing bundle.
9. Grant access but simulate one registration failure. Confirm retry skips the
   permission prompt and retries registration/reload only.
10. Open new stories on canonical AO3, an AO3 variant, and FFN without invoking
   the toolbar. Confirm the overlay/automatic behavior and Trace library saves.
11. Restart Safari and repeat on AO3 and FFN. Reboot the device and repeat once.
    If Safari offers a one-day grant, repeat after expiry and confirm the next
    missing run returns to permission recovery without inferring loss from idle
    time alone.
12. Change one relevant Safari Website Access entry back to Ask or Deny. Confirm
    the dynamic bundle is no longer presented as ready and the next story
    returns to recovery without being saved first.
13. Open Trace on an unrelated site. It must not inject, read, or request
    access to that site.
14. Leave Safari in the background long enough for the extension to be
    suspended. Return, go Back to an AO3 listing, then open a story. Confirm
    the listing overlay returns, the story handle appears, and the story is
    saved without restarting Safari. The page gate asks again on `pageshow`,
    focus, and visibility; the background bounds each permission reconcile.

Record the iOS version, tested host family, prompt wording, first failing row,
visible Safari Settings state, and whether each server-confirmed entry exists.
Do not record private story titles or URLs.

## Decision rule

The candidate passes only if no first-story write occurs before the complete
grant, the permission prompt is caused by the labeled direct action, acceptance
survives Safari restart and device reboot, all five host patterns work without
extra grants, denial and partial coverage stay incomplete and retryable, and
onboarding success is backed by both a fresh post-registration run and current
account server confirmation.

### Private development pairing

Only `build:ios-earned-permission-onboarding:preview-release` accepts the optional
`TRACE_EXTENSION_DEV_CONFIG` absolute path to a JSON file with exactly
`apiOrigin` and `webOrigin`. Both must be canonical HTTPS DNS origins, without
credentials, ports, paths (including a trailing slash), queries, fragments,
wildcards, IP addresses, or localhost. Invalid supplied input fails the build.
With no input, the package uses `https://api.development.example.test` and
`https://web.development.example.test`. This pair supersedes ambient API/web
variables; ordinary production release commands reject the JSON override and
retain their exact production-origin checks.

The containing native app and Safari extension must both compile with
`TRACE_INTERNAL_REVIEW` and `TRACE_NATIVE_DEVELOPMENT_API`, and both built
Info.plists must supply the same API origin as `TraceDevelopmentAPIOrigin`.
The codec reads only its target's bundled metadata, never a message or network
response. Missing metadata uses the public fixture; invalid metadata fails
closed. Without both compile flags the key is ignored and only production
receipts are accepted. Account/provider binding and receipt expiry still apply.
The private build owner must check app, extension, worker, popup, sync matches,
and native import metadata agree before signing or installing.

Keep deployment values and generated development artifacts in private build
storage. Restore committed resources with the ordinary production release
build before preparing public history.
