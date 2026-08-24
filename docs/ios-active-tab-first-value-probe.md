# iOS active-tab first-value probe

This developer-only Trace 0.6.4 build 18 answers one narrow platform question:
can a user open Trace from Safari on a supported story and receive real value
without first granting persistent website access?

Device result: passed on canonical AO3, AO3 variant hosts, and FanFiction.net.
Every tested story received a server-confirmed save and appeared in the Trace
library without a Safari website-access prompt. Probe 1B now isolates whether
optional host declarations change that behavior.

It is a capability probe, not the proposed production onboarding. A pass would
justify designing and testing an onboarding that delivers the first save before
asking for the durable permissions required by automatic tracking and overlays.

## Probe boundary

When `TRACE_IOS_ACTIVE_TAB_PROBE=1`:

- Safari declares `activeTab` and `scripting`, but no website origins;
- it declares no optional origins or ambient content scripts;
- opening Trace on an AO3 or FanFiction.net story identifies only that active
  tab and injects the bounded story collector into it;
- the collector sends the existing `TRACE_CONNECT_AND_SAVE` command, whose
  sender and work identity are validated by the background runtime;
- success appears only after the Trace API authoritatively confirms the save;
- password/credential pages, listings, unsupported pages, automatic tracking,
  overlays, saved filters, Trace-site sync, and archive heartbeats are excluded;
- the code never calls the website-permission request API;
- Chrome and Firefox packages remain production-shaped.

The probe uses the separate Safari extension identifier
`com.tracefiction.trace.active-tab-probe` so permission state from an
earlier Trace extension build cannot make the result look better than it is.

## Build

```bash
npm run build:ios-active-tab-probe:release
```

This command generates the public extension resources. Trace maintainers then
pin this repository revision in the private Apple client and archive the
containing app without running another extension build. `npm run build:release`
restores normal production resources in this repository.

## Physical-device protocol

Use a real iPhone or iPad. Do not pre-grant Trace access to any website.

1. Install build 18 and sign in inside the Trace app.
2. Enable the Trace extension in Safari Settings. If the settings page lists
   website access, leave every website at **Ask** or ungranted.
3. Open a supported AO3 story in Safari.
4. Open Trace from Safari's toolbar or page menu.
5. If Safari shows any website-access prompt before the Trace popup appears,
   capture the exact prompt and mark the probe **failed**.
6. In the popup, record the four rows: Trace opened, story page identified,
   current-tab access, and server-confirmed save.
7. Confirm the story is present in the signed-in Trace library. A green popup
   without the library entry is a failure.
8. Repeat once on an AO3 variant host and once on `www.fanfiction.net` or
   `m.fanfiction.net`.
9. Open Trace on a non-story page. It must not inject or claim a save.
10. Restart Safari and repeat. This tests a fresh active-tab gesture; the probe
    intentionally does not claim durable access.

Record the iOS version, device, site URL host (not the private story title),
whether any Safari prompt appeared, the first failing row, and whether the
library entry exists.

## Decision rule

Probe 1A passes only if the supported story is server-confirmed and visible in
the library with no Safari website-access prompt and no pre-granted site
permission. Any prompt, missing active-tab URL, injection denial, false success,
or host-specific failure disproves this route for production onboarding.
