# iOS WKWebView Shell

The iOS app target includes a small `WKWebView` shell that loads Trace and embeds the Safari Web Extension. The shell exists so the same Trace web experience can be distributed as an iOS app while keeping the browser-extension source inspectable in this repository

I'd like to eventually build a more native iOS app but honestly it's quite a lot of work lol. It's on the list of things I want to do in the future though!

## What This Shell Does

- Loads the configured Trace web origin in a full-screen `WKWebView`.
- Marks the session as the native shell so the web app can show mobile-appropriate auth UI.
- Handles the `traceauth://callback` URL scheme and returns the OAuth result to the web view.
- Opens external non-Trace links outside the shell.
- Uses `ASWebAuthenticationSession` for OAuth flows instead of completing OAuth inside an embedded web view.

## What To Inspect

- `iOS (App)/TraceWebViewController.swift` - web view setup, navigation handling, OAuth callback handling.
- `iOS (App)/TraceWebOrigin.generated.swift` - generated Trace web origin used by the shell.
- `Shared (Extension)/Resources/` - Safari Web Extension resources included in the app build.

The generated web origin is written by `npm run build` / `npm run build:release`.
