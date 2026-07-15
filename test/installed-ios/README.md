# Installed iOS session lifecycle

This harness builds the kernel-mode Safari extension, installs it in a booted
iOS Simulator, and drives its public popup through XCUITest. It covers Connect,
restart verification, temporary unavailability and Retry, credential rejection,
explicit provider replacement, Disconnect, and missing-provider failure.

Run it from the repository root with Xcode, XcodeGen, Node dependencies, and one
booted Simulator available:

```sh
TRACE_IOS_SIMULATOR_ID=<simulator-udid> \
  npm run test:session:installed:ios
```

Set `TRACE_IOS_EVIDENCE_PATH` to retain screenshots, XCTest result bundles, and
the redacted JSON summary in a specific directory. The test enables Trace in
the Simulator's Safari settings when installation disables it.

The fixture credential is available only in DEBUG Simulator compilation. The
runner builds a Release app and fails if that fixture key is present in the
extension binary. It does not replace the release-candidate smoke on a real
device: that smoke remains responsible for proving the app-owned shared
Keychain boundary in a signed/TestFlight build.
