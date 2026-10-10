# Changelog

This file lists the changes that matter to people using the Chrome, Edge and
Firefox extension. The Safari extension ships inside the Trace iPhone app, and
its notes go with each app release.

## 1.0

### Your Library

- **Stories you start part-way through get their description.** AO3 shows a story's summary only on its first chapter. If you're on a later chapter when Trace first sees a story, Trace now quietly reads the summary from the first chapter in the background, so the story's description is filled in. It never reads a chapter's own summary as the story's.
- **Importing from your AO3 History keeps when you last read each story.** On your own AO3 History page, Trace now reads each story's **Last visited** date. When you import from that page, Trace uses it as the story's last-read date, unless it has seen you read the story more recently. If you choose, it can also stand in as an approximate finish date for finished stories that have none. Stories marked for later are left out, and the visit count isn't kept.

### On the page

- **No more bare “Error”.** When a story can't be saved automatically, the page now says **Not saved**. A story you tried to add says **Couldn’t add**, and a connection problem says **Try again**.
- **A save that didn't go through gets a second chance.** If Trace couldn't check your Library at that moment, it quietly tries the save once more before saying anything. If the page does show **Not saved** and the story turns out to be saved after all, the page corrects itself.

- **A story is only marked Finished for the reader who read it.** If a different Trace account is connected while a story page is open, the page forgets the previous account's reading: its end-of-story note and **Undo** go away, nothing unconfirmed is carried over, and the page shows the new account's Library. The story is marked Finished only once the connected reader reaches the end themselves. Lists that were already open show the new account's marks too.

### The popup

- **Connecting for the first time says Connect.** If a first attempt to connect doesn't go through, the popup and Trace's notes on the page read **Connect Trace**, not **Reconnect Trace**. Reconnect is only for a browser that was connected before.
- **The Free count comes from your account.** The Library size in **64 of 100 stories kept** is read from your Trace account instead of being fixed in the extension. Until the account has reported it, the line stays hidden.
- **One way of saying your Library is full.** The popup and the notices on AO3 and FanFiction.net now use the same words as the Trace app. Under **Your Library is full**, the popup reads **100 stories on Free. Everything saved stays. See Trace Unlimited, or remove a story to make room.** The page notices say the same without the number. They still appear at most once a day, and **Not now** still quiets them for a week.
- **Plainer words.** **Improve story metadata** is now **Improve story details**, and the extension's description says what it does: save stories, keep your place as you read, and see your Library while you browse.

### iPhone and iPad

- **The popup checks the Trace app before asking you to sign in.** While it reads your account from the app it says **Connecting to your account…**. It asks you to create an account or sign in only when the app has none. If it still can't connect after a few seconds it says so, with **Open Trace** and **Try again**.
- **A story that's slow to save says what to do.** **Still confirming your story** now reads **Keep reading; it’ll appear in Trace. If it hasn’t after a minute, reload this page.**
- **Open any story.** On a page with no story open, including a site's home page, the popup reads **Open any story. Trace saves it when it opens.** and no longer points at titles that may not be there. It also stays on that message instead of changing to **Still confirming your story** after a while.
- **A first save is confirmed on FanFiction.net too.** When the popup that finishes setup finds your story already saved, it shows **Saved to your Library** with the story, on AO3 and FanFiction.net alike, instead of opening on the everyday view.
- **No stand-in titles.** If the page hasn't named your story yet, the popup says **Saved to your Library** on its own and adds the title when it has it.
- **Trace tells its app when Safari stops allowing it.** If an **Allow for One Day** grant runs out, the extension lets the Trace app know when its popup next opens, when Safari reports the change, and about once a day, so the app can say so. Nothing leaves your iPhone for this.
- **A tab left open across an app update picks Trace back up.** The next scroll or tap brings Trace back on that page, without a reload.
- **Import from this page.** On an AO3 or FanFiction.net list, your History or Bookmarks, or a saved story, the popup shows **Import from this page** above **Settings**. Tap it, then **Open in Trace** to choose what to import. It also works in a tab that was open during an app update.

## 0.7.3

- **Trace stays connected.** The extension now keeps its own sign-in instead of borrowing a short-lived one from an open Trace tab. You no longer need a Trace tab open, and Firefox on Android no longer asks you to reconnect several times a day. After updating, you may need to connect once more; after that the connection lasts until you choose **Disconnect** or stop using Trace for 90 days.
- **Connecting takes you back to your story.** When you connect from Trace's notice on AO3 or FanFiction.net, Trace returns you to the tab you were reading, at the same place on the page, once you've signed in.
- **The end-of-story note now sits right after the last line.** On the last posted chapter, Trace's note appears directly after the chapter text, before end notes, kudos and comments, on AO3 (chapter view, **Entire Work** and one-shots) and FanFiction.net. It appears once the last few lines have stayed on screen for about two seconds; scrolling straight past the end no longer counts. When the site says a work is complete, the note reads **You’ve reached the end · Marked Finished** with **Undo**, which returns the story to its previous status. An ongoing work reads **You’re caught up**. If the site doesn't say, Trace asks **Is this story complete?** as before. The corner toast is gone.
- **The popup shows how full a Free Library is.** It reads, for example, **64 of 100 stories kept**. At 80% it says **You’re at 80 of 100 stories. Unlimited keeps every story.** for a day, then goes back to the count. Nothing is shown for Unlimited.
- **The Library full notice no longer follows every new story.** After an automatic save is refused, the notice appears at most once a day, and **Not now** quiets it for a week. Adding a story yourself still explains why it wasn't added.

## 0.7.2

- **Trace makes missing site access visible on its toolbar icon.** A **!** badge and **Site access is off — click to allow** tooltip lead to **Allow Trace on AO3 and FanFiction.net** in the popup. One click requests all declared hosts together: AO3 and its mirrors, FanFiction.net, and Trace's web/API origins needed to connect. The popup closes immediately so Firefox's permission prompt is unobstructed. The badge clears only when all are granted; declining leaves Allow available when you reopen the popup.
- **One-page activation explains its limits.** If clicking the toolbar activates Trace on the current page while persistent access is missing, a non-dismissable line says **Trace is only on for this page. Allow it on AO3 to keep it on — click the Trace icon.** FFN pages name FanFiction.net. The line stays hidden while the toolbar popup is open, returns when it closes without a grant, and disappears as soon as the full grant arrives, without a reload.
- **Site access is checked when Trace installs, updates, starts, and when you open its popup, and after permission changes.** Firefox, Chrome and Edge show recovery only when access is missing. Existing Safari setup is unchanged.

## 0.7.1

### Connecting

- **Connect on AO3 and FanFiction.net now connects.** The Connect button in Trace's notice, on a story and on listing rows works like Connect in the toolbar popup. If you're signed in to Trace in an open tab, Trace connects straight away. If not, Trace opens so you can sign in, and the extension connects as soon as you do.
- **No refresh needed.** Open AO3 and FanFiction.net tabs update as soon as the extension connects or disconnects.
- **Signing in after installing always connects.** Before, the extension connected only if you signed in on the exact setup page it opened. Now signing in anywhere on Trace within 30 minutes of installing connects it.

### On the page

- **The saved note gets out of the way, after you've had time to read it.** The note that confirms a save stays for at least three seconds. After that it leaves about a second after you start scrolling, or at five seconds if you don't scroll. Scrolling that was already under way when it appeared doesn't count. It waits while you point at it or use its buttons, and it still has its close button. With Reduce Motion on, it disappears without fading.
- **Moving to the next chapter in Chrome updates your progress straight away.** AO3 asks Chrome to load the next chapter ahead of time. Trace missed that chapter until you switched tabs and came back; it now records it as soon as you open it.
- **The page keeps scrolling with a story's Trace panel open.** The panel opens next to the story and scrolls with the page. It closes when you click elsewhere, press Escape, or scroll the story out of view. On phones, the bottom sheet is unchanged.

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
