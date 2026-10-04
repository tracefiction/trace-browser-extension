# Changelog

Trace is in beta. This file lists the changes that matter to people using the
Chrome, Edge and Firefox extension. The Safari extension ships inside the Trace
iPhone app, and its notes go with each app release.

## 0.7.1

### Connecting

- **Connect on AO3 and FanFiction.net now connects.** The Connect button in Trace's notice, on a story and on listing rows works like Connect in the toolbar popup. If you're signed in to Trace in an open tab, Trace connects straight away. If not, Trace opens so you can sign in, and the extension connects as soon as you do.
- **No refresh needed.** Open AO3 and FanFiction.net tabs update as soon as the extension connects or disconnects.
- **Signing in after installing always connects.** Before, the extension connected only if you signed in on the exact setup page it opened. Now signing in anywhere on Trace within 30 minutes of installing connects it.

## 0.7.0

This is the first Chrome Web Store and Firefox Add-ons release since 0.5.14, published in July 2026.

- **What's live now:** both stores still list 0.5.14.
- **Versions in between:** 0.5.15 to 0.6.6 shipped only as the Safari extension inside the Trace iPhone app. Some 0.6.x versions were never published to a store.
- **What that means:** everything below is new for Chrome, Edge and Firefox.

### New look

- **A redesigned popup and story sheet.** They are quieter and easier to scan:
  - plain text actions;
  - one type scale;
  - your private rating, note and tags grouped together under "Your record".
- **The popup only says what it knows.** For example, it doesn't show "Saving" for a story that's already in your library.
- **A new icon**, matching the Trace app's fingerprint icon.
- **Dark mode now uses the same palette as the Trace app.** On a dark archive skin, such as AO3 Reversi, every piece of text meets WCAG AA contrast. Light mode is unchanged.

### Connecting and staying signed in

- **After a first install, Trace opens its setup page and connects to your Trace account straight away.**
- **The extension stays matched to the Trace account you're signed in to,** including after you reconnect or switch accounts.
- **A save is reported only after Trace confirms it in your library.**
- **More consistent across account and network changes.** This covers your library status, reading progress, metadata contributions and AO3 saved filters.

### More reliable

- **Faster chapter tracking.** Trace no longer re-reads your whole library before it records your place.
- **Trace controls come back on their own.** This covers pages restored with the browser's Back button and tabs that were already open when the extension updated. You no longer need to reload them.
- **A clearer message when your library reaches the Free limit**, with a direct way to make room or upgrade.

### Reading updates

- **Each reading update now carries a one-time ID, plus the local date and time zone it happened in.** A retried update is never counted twice, and each read is recorded on the right day.

### Diagnostics (Chrome and Edge only)

- **Signed-in requests to Trace now include three coarse fields:**
  - the browser family;
  - whether it is mobile or desktop;
  - the extension version.

  Trace uses them only to see which releases are in use and whether they're working. They include no browsing history, page content or device identifier. Firefox sends none of these fields.

### Permissions

- **Chrome, Edge and Firefox now request the `scripting` permission.** When the extension starts, installs or updates, Trace uses it only to restore its own scripts in AO3 and FanFiction.net tabs that are already open, on sites Trace already has access to. Website access is unchanged. Neither Chrome nor Firefox shows a new install or update prompt for this permission.
