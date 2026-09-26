# iOS earned-permission onboarding

The Safari extension requires complete Website Access before saving a story.
Its permission-bearing manifest remains stable across upgrades; static content
scripts stay inert until the complete five-origin archive bundle is allowed.

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
- the background worker owns the complete-bundle readiness decision. Static
  content scripts remain inert when coverage is partial, so one working
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
from the static scripts. The flow stores only a bounded local
list of coarse event names and timestamps for device-side diagnosis. It adds no
network telemetry, URLs, story identity, account identity, page HTML, story
text, cookies, or credentials.

## Build

The normal production-origin build is:

```bash
npm run build:ios-earned-permission-onboarding:release
```

The script pins both production origins and writes the public extension
resources consumed by Safari. The private Apple client separately verifies
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
