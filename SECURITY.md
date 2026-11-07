# Security

If anything claiming to be Trace asks for your AO3 or FanFiction.net password, it isn't Trace. The extension never needs it.

## Reporting a problem

If you've found a security or privacy problem, please email me at `support@tracefiction.com` rather than opening a public issue. Don't include passwords, sign-in tokens, cookies or private account details in the email. I'll reply as soon as I can.

## What the extension is allowed to do

The extension asks for access to AO3 and FanFiction.net so it can read story details and show your Trace library on those pages. It also asks for access to the Trace website, to pick up your sign-in. Chrome and Firefox need access to Trace's API address too; Safari doesn't, because Trace's server allows the Safari extension's requests directly.

It doesn't ask for permission to read cookies, and it doesn't need your AO3 or FanFiction.net login.

Login, sign-up and password pages on AO3 and FanFiction.net are excluded in the manifest (see `SITE_AUTH_EXCLUDE_MATCHES` in `scripts/build.mjs`). On top of that, the page scripts switch themselves off on any page with a password box they don't recognise. The one exception is the login form in AO3's header, which appears on ordinary story pages, so Trace ignores just that form.

In Safari, the extension also talks to the Trace app it ships with. It does that to set up, to get the key it uses for Trace's servers, and to hand over the first story you save. The extension's side of this is in this repo (`Shared (Extension)/*.swift`); the app's side is private.

On iPhone and iPad, AO3 and FanFiction.net access is optional. The extension asks for it before the first save and saves nothing until Safari has granted all of it.

## What gets sent to Trace

The README has the full list of what's sent and what never is: [What it sends to Trace](README.md#what-it-sends-to-trace).

## Keys and sign-in

On Chrome, Firefox and Safari on Mac, the extension swaps your Trace website sign-in for its own key, which only works for the extension's requests. The key stays in the extension's private storage and is never passed to the Trace website or to AO3 and FanFiction.net pages. Trace's server only keeps a hash of it. **Disconnect** removes it straight away and asks the server to cancel it.

On iPhone and iPad the Trace app holds the key in the shared Keychain and the extension never sees your Trace sign-in.

## Limits

A browser extension can only do what the browser lets it, so it's worth checking the manifest's permissions when a new version comes out. Having the source public helps, but it doesn't replace the stores' own reviews or checking that a release matches its tag.

The full detail on how accounts, saves and the Safari app link are kept separate is in [docs/technical-notes.md](docs/technical-notes.md).
