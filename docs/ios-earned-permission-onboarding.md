# iOS earned-permission onboarding

Trace 0.6.4 build 22 tests the complete value-first Safari onboarding proposed
after the build 18 and 19 capability probes. Build 20 proved the Safari
permission flow but failed authentication because its preview shell fell back
to the custom-scheme OAuth return. Build 21 proved the verified HTTPS callback,
but its per-branch Vercel origin was not in Auth0's origin allowlist. Build 22
uses Trace's stable dev deployment so Auth0 needs only one persistent dev
origin. A user first saves one real story with the access Safari grants from
their explicit toolbar tap. Only after the Trace API confirms that save does
the popup offer the broader website access needed for automatic tracking.

This is a signed physical-device candidate, not yet a production permission
migration. It uses the fresh Safari extension identifier
`com.tracefiction.trace.earned-permission` so an earlier build's grants and
registered scripts cannot make the result look better than it is.

## User contract

When `TRACE_IOS_EARNED_PERMISSION_ONBOARDING=1`:

- the app setup asks the user to enable Trace, choose an AO3 or
  FanFiction.net story, and open Trace from Safari's toolbar;
- the first toolbar action uses `activeTab` to inject only into that story tab;
- the popup reports the story as saved only after the server confirms it;
- no durable website access is requested before that first value;
- a separate direct click offers automatic tracking across exactly five
  supported origin patterns;
- declining leaves a working one-story-at-a-time toolbar path, including for
  later stories;
- accepting registers the production archive scripts persistently and reloads
  the story;
- setup is called complete only after a fresh post-grant archive heartbeat
  proves that the registered script actually ran;
- revoked access or missing registrations produce a recoverable paused state;
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

Build 22 is paired to the stable Vercel dev deployment of the web half with:

```bash
npm run build:ios-earned-permission-onboarding:preview-release
```

That script accepts the compiled exact dev origin and keeps the API on
`https://api.tracefiction.com`. In Release, that exact dev deployment is
permitted to use `https://www.tracefiction.com/auth/callback`, so OAuth returns
through the same verified HTTPS association as production rather than
`traceauth://`.
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
2. Install build 22, sign in inside Trace, and enable the Trace extension. Do
   not pre-approve Website Access in Settings.
3. From Trace, open an AO3 or FanFiction.net story. Open Trace from Safari's
   toolbar. Record any Safari prompt that appears before the Trace popup; none
   is expected for this first toolbar-granted save.
4. Confirm the popup identifies the story and says **Server confirmed**.
   Confirm the story exists in the signed-in Trace library.
5. Choose **Not now**. Open a different supported story and invoke Trace again.
   Confirm that second story is also server-confirmed and appears in the
   library. This proves the manual fallback is real rather than explanatory UI.
6. Reopen Trace and choose **Turn on automatic tracking**. Record Safari's exact
   prompts and choices. Accept the requested supported addresses.
7. Let Trace reload the story. Reopen the popup after the page finishes. It
   must say **Automatic tracking is on** only after **Run confirmed** appears.
8. Open new stories on canonical AO3, an AO3 variant, and FFN without invoking
   the toolbar. Confirm the overlay/automatic behavior and Trace library saves.
9. Restart Safari and repeat on AO3 and FFN. Reboot the device and repeat once.
10. Change one relevant Safari Website Access entry back to Ask or Deny. Confirm
    the popup reports automatic tracking as paused while a deliberate toolbar
    tap can still save the current story.
11. Open Trace on an unrelated site. It must not inject, read, or request
    access to that site.

Record the iOS version, tested host family, prompt wording, first failing row,
visible Safari Settings state, and whether each server-confirmed entry exists.
Do not record private story titles or URLs.

## Decision rule

The candidate passes only if first value arrives before the broad permission
prompt, the optional prompt is caused by the labeled direct click, acceptance
survives Safari restart and device reboot, the five host families work without
extra grants, refusal preserves manual saves, and every success claim is backed
by either server confirmation or the fresh archive heartbeat it describes.
