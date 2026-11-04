/** The standalone extension's popup: its status, its settings, a backup and what was skipped. */

import {
  COPY_FOLDER,
  KEEP_A_COPY_MESSAGE,
  RETRYABLE_SKIPS,
  type CopyFormat,
  type KeepView,
  type Settings,
  type SkipCode,
  type Trigger,
} from "./keep-a-copy.mjs";

type PopupView = KeepView & { readonly canHideDownloads: boolean };
type Screen = "home" | "skipped" | "triggers";

const scope = globalThis as unknown as {
  browser?: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
  chrome?: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
};
const runtime = (scope.browser ?? scope.chrome)?.runtime;

const LOCKED: readonly SkipCode[] = ["needs_sign_in"];
const GONE: readonly SkipCode[] = ["gone", "no_download"];

const number = /* @__PURE__ */ new Intl.NumberFormat("en-US");
const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const works = (count: number) => `${number.format(count)} ${count === 1 ? "work" : "works"}`;

/** "14:02", "yesterday, 21:40" or "29 Oct, 21:40". */
export function lastCopyWhen(at: number, now: number): string {
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(at) === day(now)) return clock(at);
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  if (day(at) === before.toDateString()) return `yesterday, ${clock(at)}`;
  return `${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${clock(at)}`;
}

/** Rounded, never a countdown: "About 40 minutes", "About 2 hours". */
export function roughDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1.5) return "About a minute";
  if (minutes < 10) return `About ${Math.round(minutes)} minutes`;
  if (minutes < 57.5) return `About ${Math.round(minutes / 5) * 5} minutes`;
  const hours = minutes / 60;
  if (hours < 1.5) return "About 1 hour";
  if (hours < 47.5) return `About ${Math.round(hours)} hours`;
  return `About ${Math.round(hours / 24)} days`;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (message: unknown) => runtime?.sendMessage(message) as Promise<PopupView | string | null>;
// The attribute, not the property: the marks are SVG, which has no `hidden`.
const show = (id: string, on: boolean) => { document.getElementById(id)?.toggleAttribute("hidden", !on); };

let screen: Screen = "home";
let latest: PopupView | null = null;
let needsSignIn = false;

function count(view: PopupView, codes: readonly SkipCode[]): number {
  return codes.reduce((sum, code) => sum + (view.skipped[code] ?? 0), 0);
}

function renderBackup(view: PopupView): void {
  const { backup, stopped } = view;
  if (!backup) return;
  const running = backup.state === "running";
  const browser = view.canHideDownloads ? "Chrome" : "Firefox";
  const held = `${number.format(backup.done)} of ${number.format(backup.total)}`;
  byId("backupBlock").dataset.state = backup.state;
  byId("backupEyebrow").textContent = running ? "Backing up my lists" : "Back up my lists";
  byId("backupCount").textContent = running ? `${held} works` : `Stopped at ${held}`;
  byId("backupBar").style.width = `${backup.total > 0 ? Math.round((backup.done / backup.total) * 100) : 0}%`;
  const carries = `It carries on while ${browser} is open.`;
  const line = !running ? "Resume picks up where it stopped. Works already copied stay as they are."
    : stopped ? ""
    : backup.estimateMs === null ? carries
    : `${roughDuration(backup.estimateMs)} at AO3's pace. ${carries}`;
  byId("backupLine").textContent = line;
  show("backupLine", line !== "");
  show("downloadsLine", running && !stopped && !view.canHideDownloads);
  const toggle = byId("backupToggle");
  toggle.textContent = running ? "Pause" : "Resume";
  toggle.classList.toggle("fill", !running);
}

function renderSkipped(view: PopupView): void {
  const locked = count(view, LOCKED);
  const gone = count(view, GONE);
  const file = count(view, RETRYABLE_SKIPS);
  show("skippedLocked", screen === "skipped" && locked > 0);
  show("skippedGone", screen === "skipped" && gone > 0);
  show("skippedFile", screen === "skipped" && file > 0);
  byId("skippedLockedText").textContent = `${works(locked)}. ${locked === 1 ? "It copies on its own" : "They copy on their own"} once you're signed in.`;
  byId("skippedGoneText").textContent = `${works(gone)}. There's nothing to copy right now.`;
  byId("skippedFileText").textContent = `${works(file)}.`;
}

function render(view: PopupView): void {
  latest = view;
  const on = view.settings.enabled;
  const skipped = Object.values(view.skipped).reduce((sum, each) => sum + (each ?? 0), 0);
  const stopped = view.stopped;
  // While a backup or a pause shows, what starts a copy folds into one row.
  const folded = view.backup !== null || stopped !== null;
  if (!on || (screen === "skipped" && skipped === 0) || (screen === "triggers" && !folded)) screen = "home";
  const home = screen === "home";

  show("homeHead", home);
  show("subHead", !home);
  byId("subTitle").textContent = screen === "skipped" ? `${number.format(skipped)} skipped` : "What starts a copy";
  const enabled = byId("enabled");
  enabled.setAttribute("aria-pressed", String(on));

  show("off", !on);
  show("notice", on && home && stopped !== null);
  if (stopped) {
    show("noticePause", !stopped.unavailable);
    show("noticeClock", stopped.unavailable === true);
    byId("noticeText").textContent = stopped.code === "save_failed" ? "Several files could not be saved. Check free space and your browser's download settings."
      : stopped.code === "signed_out" ? "Sign in to AO3 to carry on backing up your lists."
      : stopped.code === "unreadable" ? "AO3 couldn't make the file"
      : stopped.unavailable ? "AO3 isn't available right now. Copies carry on when it's back."
      : `AO3 asked to slow down. Resuming around ${clock(stopped.until)}.`;
  }
  show("status", on && home && view.backup === null);
  byId("kept").textContent = `${works(view.withCopy)} kept`;
  const lastCopy = view.lastCopyAt === null ? "" : `Last copy ${lastCopyWhen(view.lastCopyAt, Date.now())}, in Downloads › ${COPY_FOLDER}`;
  byId("lastCopy").textContent = lastCopy;
  show("lastCopy", lastCopy !== "");
  show("backupBlock", on && home && view.backup !== null);
  renderBackup(view);

  const settings = on && (screen === "triggers" || (home && !folded));
  show("triggers", settings);
  show("formatRow", settings);
  for (const box of document.querySelectorAll<HTMLInputElement>("[data-trigger]")) {
    box.checked = view.settings.triggers[box.dataset.trigger as Trigger] === true;
  }
  byId<HTMLSelectElement>("format").value = view.settings.format;
  show("backupStart", on && home && !folded);
  byId("backupCaption").textContent = needsSignIn ? "Open any AO3 page while signed in first, then try again." : "Bookmarks, Marked for Later and Subscriptions.";
  show("skippedRow", on && home && !folded && skipped > 0);
  byId("skippedRowText").textContent = `${number.format(skipped)} skipped`;
  show("foldRow", on && home && folded);
  renderSkipped(view);
}

async function refresh(): Promise<void> {
  const view = await send({ type: KEEP_A_COPY_MESSAGE.view });
  if (view && typeof view === "object") render(view);
}

async function change(patch: Partial<Settings>): Promise<void> {
  await send({ type: KEEP_A_COPY_MESSAGE.settings, patch });
  await refresh();
}

function go(next: Screen): void {
  screen = next;
  if (latest) render(latest);
}

if (runtime) {
  byId("name").textContent = COPY_FOLDER;
  document.title = COPY_FOLDER;
  byId("enabled").addEventListener("click", () => void change({ enabled: byId("enabled").getAttribute("aria-pressed") !== "true" }));
  byId<HTMLSelectElement>("format").addEventListener("change", (event) => void change({ format: (event.target as HTMLSelectElement).value as CopyFormat }));
  for (const box of document.querySelectorAll<HTMLInputElement>("[data-trigger]")) {
    box.addEventListener("change", () => void change({ triggers: { [box.dataset.trigger as Trigger]: box.checked } as Settings["triggers"] }));
  }
  byId("backup").addEventListener("click", async () => {
    needsSignIn = (await send({ type: KEEP_A_COPY_MESSAGE.backup })) === "no_user";
    await refresh();
  });
  byId("backupToggle").addEventListener("click", async () => {
    await send({ type: latest?.backup?.state === "running" ? KEEP_A_COPY_MESSAGE.stopBackup : KEEP_A_COPY_MESSAGE.resumeBackup });
    await refresh();
  });
  byId("tryAgain").addEventListener("click", async () => {
    await send({ type: KEEP_A_COPY_MESSAGE.retrySkipped });
    await refresh();
  });
  byId("skippedRow").addEventListener("click", () => go("skipped"));
  byId("foldRow").addEventListener("click", () => go("triggers"));
  byId("back").addEventListener("click", () => go("home"));
  void refresh();
  setInterval(() => void refresh(), 5_000);
}
