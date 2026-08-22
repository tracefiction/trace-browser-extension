# Installed iOS session lifecycle

This harness builds the kernel-mode Safari extension, installs it in a booted
iOS Simulator, and drives both the containing app and Safari popup through
XCUITest. It covers the app-owned provider lifecycle, browser-only sign-in
rejection, the in-app recovery route, explicit Connect, restart verification,
temporary unavailability and Retry, credential rejection, same/different/missing
provider Reconnect, installed AO3 Connect-and-save, app sign-out, clear failure,
app resume, and Disconnect.

Run it from the repository root with Xcode, XcodeGen, Node dependencies, and one
booted Simulator available:

```sh
TRACE_IOS_SIMULATOR_ID=<simulator-udid> \
  npm run test:session:installed:ios
```

Set `TRACE_IOS_EVIDENCE_PATH` to retain screenshots, XCTest result bundles, and
the redacted JSON summary in a specific directory. The test enables Trace in
the Simulator's Safari settings when installation disables it. Each run
reboots the selected test Simulator before installation so interrupted prior
runs cannot leak stale XCTest or Safari processes into the evidence. The runner
preloads each test URL with `simctl openurl`; XCUITest never depends on Safari's
flaky software-keyboard navigation. Do not interact with the selected Simulator
while the run is active.

For constrained runners, `TRACE_IOS_JOURNEY_PHASE=app` and
`TRACE_IOS_JOURNEY_PHASE=session` execute the two independently isolated
halves and write phase-prefixed result bundles plus `summary-app.json` and
`summary-session.json`. Omitting it runs the complete matrix and writes
`summary.json`.

Failed runs keep the raw `.xcresult` in the evidence directory but delete their
large temporary Xcode workspace by default. Set
`TRACE_IOS_PRESERVE_FAILED_WORKSPACE=1` only when that workspace is needed for
local diagnosis; remove it after inspection.

The app/extension fixture credentials are available only in DEBUG Simulator
compilation. The app seam is reached only through the real v2 native
update/clear handlers; the runner mirrors an
acknowledged value into the unsigned extension fixture only at the explicit
app-to-extension boundary. The runner builds a Release app and fails if any
fixture key is present in either binary. It does not replace the
release-candidate smoke on a real device: that smoke remains responsible for
proving the app-owned shared Keychain boundary in a signed/TestFlight build.

The redacted summary records the native provider request count and only the
`present`/`missing` outcome, proving that both successful and browser-only
Connect attempts crossed that boundary. The cold-start probe loads a web mode
that cannot mutate provider state and separately records the native bootstrap
clear result, so a later web clear cannot mask a failed boot-time clear.

The session phase also appends a DEBUG-run-only content driver after the real
archive collector in the temporary build copy. It invokes the installed
collector/controller path from an authorized FanFiction.net story sender and records the
`connected / saved` boundary against the local authenticated track fixture.
With automatic tracking enabled, the fixture requires the bounded pair of one
onboarding save and one automatic progress mutation for the same account and
work, while the UI must settle on one authoritative `Saved` entry. A third
mutation or any stale-account/work write fails the run. The fixture returns the
production authoritative-entry response shape without retaining story content.
The runner removes the driver before the Release build and verifies that
neither its resource nor its manifest entry is present in that build. FFN is
used because a fresh Safari simulator can redirect AO3 works to a separate
Terms/content-policy consent page; that cookie gate is not part of Trace's
installed extension contract. This journey requires the selected Simulator to
reach `www.fanfiction.net`.
