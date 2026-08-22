# iOS earned-permission onboarding

Trace 0.6.4 builds 18–28 established the Safari capabilities needed for the
production permission-first onboarding in build 29. Build 20 proved the Safari
permission flow but failed authentication because its preview shell fell back
to the custom-scheme OAuth return. Build 21 proved the verified HTTPS callback,
but its per-branch Vercel origin was not in Auth0's origin allowlist. Build 22
uses Trace's stable dev deployment so Auth0 needs only one persistent dev
origin. Build 23 also opened Safari Settings with only the extension identifier
actually embedded in the app; build 22 could include a retired probe identifier
and make that recovery action appear to do nothing.

Build 24 removed the previous hybrid deployment: its stable dev web shell,
extension worker, and native API fallback all use Trace's Railway development
API. Ordinary release builds remain pinned to the production web and API
origins.

Build 25 fixes the clean-install connection deadlock found in build 24. The
earned-permission popup now invokes the existing atomic Connect-and-save path,
which adopts and verifies the containing app's account before writing the first
story. It no longer exits after a read-only snapshot reports the freshly
installed extension as not connected.

Build 26 fixes the post-grant registration failure found on device in build 25.
Popup-only probe flags now remain in `popup-config.js`; persistently registered
archive scripts load `content-config.js`, which enables the normal heartbeat,
automatic tracking, and overlay behavior after the five-site grant. The
registration configuration version is bumped so an install over build 25
replaces its stale scripts before asking for a fresh verification reload.

Build 27 makes that successful verification visible without another toolbar
interaction. While the popup remains open across its requested story reload, it
observes the locally persisted archive heartbeat and immediately changes the
pending automatic-tracking row to **Run confirmed**. The timestamp still has to
be newer than the permission grant; no success condition is weakened.

Build 28 changes no onboarding behavior. It gives the embedded Safari extension
the fresh identifier `com.tracefiction.trace.earned-v2` after device testing
showed that deleting and reinstalling build 27 could preserve its granted host
access and registered scripts. The identity reset prevents retained Safari state
from producing a false clean-install pass. The containing app remains
`com.tracefiction.trace`, and the embedded identifier has exactly one component
below it as App Store Connect requires.

Build 28 proved the API surface, exact five-origin grant, dynamic registration,
fresh-run evidence, AO3 variants, FanFiction.net, Safari restart, and device
reboot. The production decision on 2026-08-21 supersedes its save-first product
ordering: active-tab access remains only a recovery bridge, and no story may be
saved before the required Website Access grant.

Build 29 implements that production ordering. It combines extension enablement
and Website Access in one Settings visit, uses a literal Safari toolbar guide
only when the automatic path does not start, requests the exact five-origin
bundle before any save, and requires both a fresh post-registration run and a
server-confirmed save. Its clean-install identifier is
`com.tracefiction.trace.earned-v3` so retained build 28 permissions cannot
produce a false pass.

Build 32 changes no onboarding behavior from build 31. It gives the embedded
Safari extension the fresh identifier `com.tracefiction.trace.earned-v4` after
device testing showed that deleting and reinstalling the build 31 extension
could restore its prior Website Access. The containing app remains
`com.tracefiction.trace`; this reset prevents retained Safari state from
producing a false clean-install result.

## User contract

When `TRACE_IOS_EARNED_PERMISSION_ONBOARDING=1`:

- the app first asks the user to enable Trace and set Website Access to Allow in
  one Safari Settings visit;
- after the extension is enabled, the user chooses an AO3 or FanFiction.net
  story; a complete Settings grant lets the normal content script start and
  save automatically;
- if Trace does not start, the app shows a literal Safari extension-button
  guide plus Safari Settings as the alternate recovery;
- the popup uses `activeTab` only to identify the current supported story. It
  does not inject a collector or send a save command before permission;
- one direct action requests exactly five supported origin patterns and tells
  the reader to choose **Always Allow**;
- denial/cancel or an incomplete grant saves nothing and remains retryable;
- a complete existing grant skips the prompt;
- the background worker owns persistent production-script registration. It
  reconciles at startup, on permission changes, and on popup request;
- partial coverage unregisters the bundle so one working hostname cannot be
  presented as complete setup;
- after registration, the popup reloads the story. The normal pending-handoff
  path then supplies the fresh run and server-confirmed save;
- setup is complete only after both that fresh post-registration run and the
  current app account's server confirmation;
- revoked or expired access returns to the same permission recovery on the next
  positive signal; inactivity alone is never treated as permission loss;
- Chrome and Firefox packages remain production-shaped.

The five optional patterns are:

- `https://*.archiveofourown.org/*`
- `https://*.archiveofourown.gay/*`
- `https://archive.transformativeworks.org/*`
- `https://www.fanfiction.net/*`
- `https://m.fanfiction.net/*`

Archive login, signup, password, authentication, and logout routes are excluded
from the dynamically registered scripts. The flow stores only a bounded local
list of coarse event names and timestamps for device-side diagnosis. It adds no
network telemetry, URLs, story identity, account identity, page HTML, story
text, cookies, or credentials.

## Build

The normal production-origin build is:

```bash
TRACE_API_BASE=https://api.tracefiction.com \
TRACE_WEB_ORIGIN=https://www.tracefiction.com \
npm run build:ios-earned-permission-onboarding:release
```

The build 32 physical-device candidate is paired to the stable Vercel dev
deployment of the web half with:

```bash
npm run build:ios-earned-permission-onboarding:preview-release
```

That script accepts the compiled exact dev origins
`https://trace-git-dev-zacs-projects-378417c9.vercel.app` and
`https://ff-app-development.up.railway.app`. In Release, that exact dev web
deployment is permitted to use `https://www.tracefiction.com/auth/callback`, so
OAuth returns through the same verified HTTPS association as production rather
than `traceauth://`.
Normal release builds reset the generated Swift flag and remain hard-bound to
Trace's production web origin. Ordinary Debug previews still use the custom
scheme and cannot opt into the production callback accidentally.

Archive the **Trace (iOS)** scheme without running another extension build.
`npm run build:release` restores the normal production resources.

## Physical-device protocol

Use a real iPhone or iPad and begin with no grant inherited from an earlier
Trace extension.

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
