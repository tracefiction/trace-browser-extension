# Reading recording transport proposal

Accepted extension base: `c5beaad11feda2bd3cc8828857d35821619e225e`.
API public contract commit: `3f137731` on the independent Reading API branch.
This source change does not enable recording or change permissions, origins, host ownership, or session policy.

The kernel owns a fresh command object for each execute. Runtime adapters retain a
UUID, original occurrence timestamp, numeric timezone offset, and matching local
calendar date across authentication retries. Track and progress patches use that
context. Resolved finish qualification preserves its existing operation UUID and
adds the original calendar. Open finish prompts remain non-reading signals.
The legacy background paths retain the same serialized context during retry.
There is no durable retry queue across worker or account lifetimes; existing
uncertain-result reconciliation is retained.

Validation (2026-09-12): focused Story/Library runtime and legacy background tests
146 passed; `npm run agent:lint` passed. The accepted earned-permission release
resource build passed with `npm run build:ios-earned-permission-onboarding:release`.
Only the tracked background resource changed; manifest/permissions/origins are
unchanged. Generic release with an implicit localhost base was refused by the
existing release guard before the explicit accepted build was used.
Logs: `/private/tmp/trace-reading-recording-20260912/extension-focused-final.log`
and `extension-build-final.log` in that directory.

Integration owner must update Apple's `Vendor/trace-browser-extension` gitlink to
this branch's final commit and perform the smallest joined native/Safari journey.
No installed-browser, simulator, device, Xcode build, publishing, or pin change
was performed here. Required-mode activation remains blocked until every writer,
including the separately pinned Reader app, is delivered and verified.
