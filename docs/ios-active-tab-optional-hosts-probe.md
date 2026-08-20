# iOS active-tab optional-host declarations probe

This developer-only Trace 0.6.4 build 19 is Probe 1B of the value-first
onboarding decision ladder. Probe 1A showed that an explicit Safari toolbar
click can save the current AO3 or FanFiction.net story without a website-access
prompt. Probe 1B changes one variable: the manifest now declares the minimized
future automatic-tracking host bundle as optional, but never requests it.

It is not the proposed production onboarding and it does not enable automatic
tracking. On a physical device, Safari sometimes surfaced additional-permission
UI even though active-tab saving continued to work after a restart. Build 20
therefore tests whether a complete [earned, post-save permission
flow](ios-earned-permission-onboarding.md) can make the permission interaction
deliberate and understandable without blocking first value.

## Probe boundary

When `TRACE_IOS_ACTIVE_TAB_OPTIONAL_HOSTS_PROBE=1`:

- Safari declares `activeTab` and `scripting`;
- `host_permissions` remains empty;
- `content_scripts` remains empty;
- `optional_host_permissions` contains exactly five patterns:
  - `https://*.archiveofourown.org/*`
  - `https://*.archiveofourown.gay/*`
  - `https://archive.transformativeworks.org/*`
  - `https://www.fanfiction.net/*`
  - `https://m.fanfiction.net/*`
- no code calls `permissions.request()`;
- opening Trace on a supported story injects only the bounded collector into
  the current tab and reports success only after the Trace API confirms it;
- unrelated pages, ambient tracking, overlays, saved filters, Trace-site sync,
  and archive heartbeats remain excluded;
- Chrome and Firefox packages remain production-shaped.

The build uses the fresh Safari extension identifier
`com.tracefiction.trace.active-tab-optional-probe` so permission state from
Probe 1A cannot make the result appear better than it is.

## Build

```bash
npm run build:ios-active-tab-optional-hosts-probe:release
npm run ios:build
```

Archive the **Trace (iOS)** scheme without running another extension build.
`npm run build:release` restores normal production resources.

## Physical-device protocol

Use a real iPhone or iPad. Do not grant any listed website access.

1. Delete Trace, confirm the old Trace extension is absent from Safari
   Extensions, restart Safari, then install build 19.
2. Sign in inside the Trace app and enable the Trace extension. Leave every
   optional AO3/FFN website at **Ask** or otherwise ungranted.
3. Open a supported AO3 story and invoke Trace from Safari's toolbar or Page
   Menu. If any website-access prompt appears before the popup, record its
   exact text and mark the probe failed.
4. Confirm the popup reports: Trace opened, AO3 identified, current-tab access
   granted by click, and server-confirmed save. Confirm the story exists in the
   signed-in Trace library.
5. Repeat on an AO3 `.gay` or subdomain story, an
   `archive.transformativeworks.org` story when available, and FFN on both
   `www` and mobile where practical. Do not approve a site between runs.
6. Open Trace on an unrelated page such as Google. It must show that no story
   was found, must not inject, and must not produce a website-access prompt.
7. Navigate away from a successfully invoked story without invoking Trace
   again. No overlay, automatic save, or other Trace page behavior may appear.
8. Restart Safari and repeat one AO3 and one FFN save. The optional sites must
   still be ungranted and manual invocation must still work.

Record the iOS version, device, tested host family, whether any Safari prompt
appeared, the first failing popup row, whether each library entry exists, and
the visible Safari Settings state. Do not record private story titles or URLs.

## Decision rule

Probe 1B passes only if the optional declarations introduce no prompt or
warning, every supported invoked story remains server-confirmed, unrelated and
uninvoked pages receive no Trace behavior, and the five optional patterns stay
ungranted. Any current-site prompt, ambient execution, false success, or
host-specific regression blocks the earned-automation probe.
