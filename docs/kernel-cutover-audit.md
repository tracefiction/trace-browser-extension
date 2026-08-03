# Kernel Cutover Audit

Date: 2026-07-20
Branch: `codex/extension-onboarding-archive-readiness`
Baseline: `cff5118`

## Decision Scope

This audit covers the accumulated modular-extension rebuild, including
behavioral parity with the legacy background owner, architecture and code
quality, sender and privacy boundaries, account-transition safety, failure
semantics, package modes, and installed-browser behavior.

The audit first preserved the legacy production owner while parity and
installed behavior were assessed. The final cutover slice changes
`build:release` to the kernel owner and preserves `build:legacy:release` as the
explicit rollback command.

## Ownership And Parity

| Surface | Kernel owner | Audit result |
| --- | --- | --- |
| Session Connect, Retry, Reconnect, Cancel, Disconnect | `SessionService` through the runtime controller | Owned; persistent epoch and credential fencing retained |
| Trace status query and settled-state push | Exact-origin Trace bridge plus serialized notifier | Parity restored; sender is validated and pushes cannot overtake one another |
| Archive permission/readiness evidence | Archive-run controller plus coarse local readiness repository | Parity restored without URLs, story data, account data, or raw errors |
| Story quick-add, Connect-and-save, and auto-track | `StoryCommandService` | Owned; authoritative confirmation required before saved state or receipt |
| Account/library projection reads | `AccountProjectionService` and private account repository | Owned; work-key bounded and account/epoch scoped |
| Library entry and work-preference writes | `LibraryMutationService` | Owned; sender/work/entry identity and post-write projection are authoritative |
| Finish qualification | `FinishQualificationService` | Owned; documented idempotent route and exact projected entry required |
| Metadata contribution and listing refresh | `MetadataContributionService` | Owned; preference, sender, byte/item, account, and notification boundaries retained |
| AO3 saved-filter sync | `SavedFilterSyncService` | Owned; local-first behavior, batching, conflict rules, and account fencing retained |
| Popup import and first-story handoff | `BrowserFirstStoryInitiator` plus story-command owner | Owned; missing archive receiver maps to site permission |
| Open-Trace reconnect actions | Exact-origin navigation adapter | Parity restored; supported archive sender and configured-origin URL required |
| Local UI preferences and archive DOM rendering | Popup/content scripts | Intentionally local; no credential or account authority |
| Disabled package | Disabled controller and empty `content_scripts` manifest | No page injection; private and local feature/readiness state is deleted |

Legacy-only messages left in the source are gated legacy paths or
background-to-content-script implementation details. Kernel content scripts no
longer invoke the retired iOS auth-refresh message.

## Architecture And Simplicity Assessment

The rebuild keeps the intended three layers:

1. `extension-core` contains browser-neutral state machines, commands,
   account-scope rules, and deterministic result types.
2. `extension-runtime` contains browser/API/native/storage adapters, strict
   sender parsing, and the composition controller.
3. Content scripts and the popup remain presentation and page-extraction
   surfaces; they do not receive credentials or account identifiers.

Canonical HTTP contracts remain owned by
`../ff/docs/extension-api-contract.md`. Route-specific adapters deliberately
retain their own validation and error mapping; a generic request abstraction
would currently hide meaningful differences between track, projection,
metadata, library mutation, finish qualification, and saved-filter sync.

The controller now has one message-type switch and delegates each branch to a
private method grouped by surface. Public message validation and projection are
isolated in `runtime-messages.mts`; the controller remains the explicit
composition root instead of gaining a handler registry or dependency
container. Low-level browser callback/promise compatibility is isolated in
`browser-platform.mts`, while the session and native-authority adapters stay
together in `browser-adapters.mts`.

The audit deliberately rejected abstractions that would add indirection without
removing a present source of errors: a generic HTTP client, one class per
message, a handler registry, a dependency-injection container, and splitting
cohesive state machines solely to reduce file length. `SessionService` and the
saved-filter domain remain cohesive because their transition ordering and
account fences are easier to verify in one place.

Kernel and disabled bundles no longer embed a dormant copy of the legacy
background runtime. Legacy rollback remains a separate deterministic build
mode, so removing that dead code does not remove rollback capability. This
reduced the generated kernel background from approximately 361 KB to 215 KB
and removed two runtime owners from the production bundle.

## Robustness And Security Invariants

- Credentials and account-private projection data stay in the
  extension-origin IndexedDB database.
- Every authenticated result is fenced by exact account id and epoch before it
  can publish.
- Uncertain writes reconcile through an authoritative read and are not blindly
  repeated.
- Network calls are bounded by timeouts; retry behavior is explicit and
  route-specific.
- Saved-filter merges remain serialized against account transitions.
  Disconnect and other manual transitions now cancel an in-flight sync before
  waiting on that fence.
- iOS mutation entry points share one native-provider synchronization. An
  unchanged credential is a no-op, same-account rotation preserves the
  account epoch and projection, a different verified account takes one fenced
  transition, and temporary provider failure refuses the new mutation without
  deleting the last verified session.
- Archive story UI retries only a failed projection read during cold-worker
  startup. The retry is bounded to three delays and never repeats auto-track,
  quick-add, metadata, or another write.
- Popup/session actions, Trace status, Trace first-story requests, archive
  commands, and saved-filter sync each have explicit trusted-sender rules.
- Trace status exposes only known coarse fields. Readiness storage sanitizes
  old or malformed data and expires public issue evidence after 24 hours.
- Status publications are serialized and deduplicated.
- Credential-entry pages are excluded in the manifest and rejected again at
  runtime.
- Disabled builds inject no scripts into Archive or Trace pages.
- Unexpected runtime failures return `ok: false` with
  `runtime_unavailable`; they are not mislabeled as successful degraded work.

## Audit Findings Resolved

1. Added the missing kernel owner for `TRACE_OPEN_TRACE_URL`.
2. Restricted status queries to the exact configured Trace origin and
   extension id.
3. Restored settled status pushes with ordering and duplicate suppression.
4. Restored coarse first-save and archive-readiness fields used by web
   onboarding.
5. Made disabled packages omit all content-script injection and clear
   readiness state.
6. Prevented kernel collector resume from calling the retired legacy native
   auth-refresh route.
7. Replaced hard-coded archive reconnect URLs with the generated configured
   Trace origin.
8. Restricted session actions/snapshots to trusted popup or Trace surfaces and
   made their envelopes exact.
9. Made the installed listener report unexpected failures as failures.
10. Added cooperative saved-filter cancellation without weakening the
    account-transition fence.
11. Made package generation independent of the previously generated manifest,
    so a disabled build cannot remove content scripts from a later legacy or
    kernel package.
12. Kept exact extension-popup URL validation compatible with installed-browser
    harnesses that load the popup document in a tab, without widening the
    missing-URL fallback.
13. Removed the dormant legacy background owner from kernel and disabled
    bundles while preserving the explicit legacy rollback build.
14. Replaced multi-pass controller routing with one message-type switch and
    surface-grouped private methods.
15. Isolated the public message boundary and the low-level browser API shim
    without introducing a handler framework or generic transport layer.
16. Replaced destructive iOS reconnect-before-every-mutation behavior with one
    coalesced provider synchronization and preserved same-account projection
    state.
17. Added bounded recovery for an initially unavailable story projection so a
    cold Safari worker cannot permanently suppress the story status component.
18. Added fixed-destination native logging for AO3 and FanFiction.net onboarding
    launches. The production launcher remains one allowlisted
    `UIApplication.open` route; no generic URL opening surface was added.

## Device Finding Follow-up

The first 0.6.0 device pass found a missing initial story component, a transient
chapter-three error that recovered only after Safari restarted, and an archive
button that appeared to return to Trace instead of the selected archive.

The chapter progression failure exposed a concrete race: metadata and
auto-track could both trigger destructive native-account reconnection while
the story projection was loading. The missing initial component also exposed a
separate cold-worker path where one failed projection read was silently
abandoned. The corrective slice now distinguishes credential confirmation from
an account transition and adds bounded read-only cold-worker recovery. Focused
tests cover unchanged credentials, same-account rotation, genuine account
changes, unavailable providers, failed credential storage, concurrent metadata
plus auto-track, and a failed-then-successful projection read.

The archive destination mapping remains one fixed native policy:
`https://archiveofourown.org/` for AO3 and `https://m.fanfiction.net/` for the
mobile FFN handoff. Desktop popup navigation and canonical FFN story URLs remain
on `www.fanfiction.net`. The device build records the selected host, exact
attempted URL, and UIKit completion result under the `SafariBridge` log
category. Actual Safari navigation remains a device acceptance check.

The next TestFlight pass exposed two further onboarding/listing defects after
archive permission was granted late. A fresh extension-private session could
remain signed out even though the containing iOS app still held the canonical
account credential, so the first AO3 projection rendered a false **Connect
Trace** prompt. Trusted AO3/FFN projection reads now adopt native authority only
from the signed-out or reconnect-required states before returning public
projection data. The path reuses the existing coalesced account-transition
owner; it does not add ambient website auth, a second credential store, or
mutation retry behavior.

The follow-up device pass showed that the native credential premise above was
not actually satisfied. The production web shell sent
`TRACE_IOS_AUTH_TOKEN_UPDATE` without the `protocolVersion: 2` field required
by the rebuilt native handler, and the fire-and-forget sender discarded the
native `unsupported_protocol` response. The companion `ff` correction restores
the versioned envelope and makes story/archive onboarding handoffs await the
existing provider-update acknowledgement before opening Safari. The extension
read bootstrap remains necessary for a newly permissioned private session, but
it can now receive the credential it was designed to adopt.

AO3 Recent Works also exposed an over-broad saved-filter mount fallback. Its
header search posts to `/works/search`, which made a generic
`form[action*='/works']` selector mistake the site header for AO3's filter
drawer. Saved filters now mount only in the canonical `#work-filters` form or a
real `form.filters` containing AO3 work-search controls. Pages without a filter
drawer receive no saved-filter UI.

## Validation

- The pre-device audit `agent:check` passed from production release artifacts:
  509 tests (74 core, 82 runtime, 1 package-mode, and 352
  content/UI/legacy-integration tests), both release builds, and both
  architecture/release lint passes.
- The first corrective slice added nine core/runtime cases and one
  content-script cold-worker case.
- The delayed-permission, Recent Works, onboarding-action, and mobile FFN
  regression slices bring the final aggregate to 523 passing tests (81 core,
  85 runtime, 1 package-mode, and 356 content/UI/legacy-integration tests).
- The production kernel bundle and both browser distributions were regenerated
  with `https://api.tracefiction.com` and
  `https://www.tracefiction.com`; the final architecture/release lint passed.
- The replacement Apple archive is pinned to marketing version 0.6.0, build 5.
  A fresh signing-free iOS simulator build succeeded from the production-origin
  release candidate.
- Debug and Release iOS simulator app builds succeeded after the native
  archive-destination diagnostics were added.
- Installed Chrome kernel lifecycle passed, including AO3 saved-filter sync,
  desktop first-story handoff, metadata contribution, and library mutation
  (8 verification reads and 5 projection reads).
- Installed Firefox kernel Connect/Disconnect lifecycle passed.
- Installed iOS lifecycle passed on the booted Trace Reader Parity simulator,
  including app-provider transitions, explicit reconnect behavior,
  Connect-and-save from an installed archive sender, reset/disconnect paths,
  fail-closed missing-provider behavior, and a release-configuration app build.
- After the simplicity refactor, the installed Chrome, Firefox, and complete
  iOS suites all passed again.
- Both store zip commands completed from `build:release` as kernel packages.
- The iPhone kernel first-story popup was fixture-rendered and visually
  inspected. It keeps the primary import action and explicitly tells readers
  to allow Trace for the archive site and refresh when Add to Trace is missing.
- Final generated artifacts use production origins and
  `TRACE_SESSION_MODE=kernel`.

The automated cutover audit has no known code or package blocker. The release
owner is now the kernel locally; no store or App Store publication is performed
by this change. The device observations above remain acceptance gates until
they pass on a newly archived build.

## Cutover Decision

- `build:release`, `package:chrome`, and `package:firefox` select the kernel.
- `build:legacy:release` provides an explicit, tested rollback without changing
  build implementation or source ownership.
- Kernel and disabled packages contain no embedded legacy runtime or runtime
  mode gate.
- The package-mode suite proves legacy, kernel, and disabled builds remain
  deterministic and that a disabled build cannot alter the next release mode.
- Release lint understands both the source-identical legacy artifact and the
  single bundled kernel artifact while retaining origin, private-boundary, and
  generated-owner checks.

## Remaining Release Work

- Before external publication, perform the documented clean
  TestFlight/internal-distribution device acceptance: delete Trace, confirm the
  Safari extension is absent/disabled, reinstall, grant both **Allow
  Extension** and **Other Websites → Allow**, return to Trace, and confirm the
  first archive run plus server-confirmed save.
- Repeat once with archive access set to Ask or Deny and confirm Trace reports
  the missing run instead of claiming success.
- On the rebuilt 0.6.0 archive, use both onboarding archive choices and confirm
  Safari reaches the selected AO3/FFN host. If it does not, capture the
  `SafariBridge` host, destination, and completion lines from the Xcode console.
- Open an AO3 story from a cold Safari state and confirm the Trace story
  component appears without a browser restart. Navigate through at least three
  consecutive chapters and confirm both the component and Trace library
  progress advance without a transient error.
- Repeat the late-permission flow: start with **Other Websites** denied, use
  Trace's guidance to allow it, then open AO3 while still signed into the Trace
  app. The archive UI must render connected without a **Connect Trace** prompt.
  Deploy the companion web-shell provider-envelope correction before this
  acceptance run; an Apple archive alone cannot change the remotely loaded
  onboarding command.
- Open AO3 Recent Works and confirm no Trace saved-filter panel appears in the
  site header. On a tag/search page with AO3's real filter drawer, confirm saved
  filters still render inside that drawer.

No API/server change was required by the original 0.6.0 cutover findings. The
0.6.1 device-session correction below intentionally adds a scoped server auth
boundary.

## 0.6.1 iOS Device-Session Correction

Production retention evidence showed that a short-lived Auth0 access token was
not a durable native provider. Version 0.6.1 replaces it on capable iOS shells
with a revocable opaque device session:

- native protocol v3 and provider record v2 carry a session UUID, scoped opaque
  credential, and expiry;
- the credential is accepted only by `/api/extension/*`, while Auth0 remains
  accepted for desktop and old-binary compatibility;
- account and library-entry operations use scoped extension routes;
- provider acquisition may retry before a request, but no library mutation is
  ever replayed;
- explicit logout revokes server state before native clear and Auth0 logout;
- ambient Auth0 loss preserves the valid device provider.

The server migration and dual-auth extension routes must deploy before the
0.6.1 iOS binary. The release gate includes a physical-device/TestFlight pass
for Keychain sharing, app suspension, add, auto-progress, manual status update,
rotation, and logout.

## Post-Tag Browser Install Correction

The first unpacked Chrome check after tagging 0.6.0 found that a fresh browser
install no longer opened Trace onboarding. The retired legacy background still
owned and tested that listener, but the kernel release bundle did not. Browser
release 0.6.1 restores the behavior inside the existing Trace web-navigation
boundary:

- only `runtime.onInstalled` with reason `install` can trigger it;
- iOS remains app-led and does not open a Safari tab;
- an existing exact-origin Trace tab is reused when possible, otherwise the
  fixed `/?activation=extension-installed` URL opens in a new active tab; and
- the package-mode test executes the listener from the generated kernel bundle
  even when session storage cannot start, preventing another source-only test
  gap.

This correction changes no manifest permission, page scope, collected data, API
request, or authentication boundary.
