/** The standalone Keep a Copy extension's popup: settings, the count and the backup. */

import { KEEP_A_COPY_MESSAGE, type CopyFormat, type KeepView, type Settings, type SkipCode, type StopCode, type Trigger } from "./keep-a-copy.mjs";

type PopupView = KeepView & { readonly canHideDownloads: boolean };

const scope = globalThis as unknown as {
  browser?: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
  chrome?: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
};
const runtime = (scope.browser ?? scope.chrome)?.runtime;

const STOPPED: Record<StopCode, string> = {
  challenge: "AO3 asked for a check",
  forbidden: "AO3 refused a request",
  wrong_host: "AO3 sent a request elsewhere",
  unreadable: "Several works in a row could not be read",
  slow_down: "AO3 asked to slow down",
  save_failed: "Several files in a row could not be saved (is the disk full?)",
};
const SKIPPED: Record<SkipCode, string> = {
  gone: "no longer on AO3",
  needs_sign_in: "locked: Sign in to AO3 to copy locked works",
  no_download: "have no download",
  not_a_file: "came back as something other than the file",
  too_large: "are too large",
  http_error: "got an error from AO3",
  save_failed: "could not be saved",
  failed: "could not be fetched",
};
const LISTS = { bookmarks: "Bookmarks", later: "Marked for Later", subscriptions: "Subscriptions" } as const;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (message: unknown) => runtime?.sendMessage(message) as Promise<PopupView | string | null>;

function render(view: PopupView): void {
  byId<HTMLInputElement>("enabled").checked = view.settings.enabled;
  byId<HTMLInputElement>("weeklyCheck").checked = view.settings.weeklyCheck;
  byId<HTMLSelectElement>("format").value = view.settings.format;
  for (const box of document.querySelectorAll<HTMLInputElement>("[data-trigger]")) {
    box.checked = view.settings.triggers[box.dataset.trigger as Trigger] === true;
  }
  byId("count").textContent = view.kept === 0
    ? "No works kept yet."
    : `${view.withCopy} of ${view.kept} works have a copy` + (view.waiting ? ` · ${view.waiting} waiting` : "") +
      Object.entries(view.skipped).map(([code, count]) => ` · ${count} ${SKIPPED[code as SkipCode]}`).join("");
  byId("status").textContent = view.stopped
    ? `${STOPPED[view.stopped.code]}. Paused until ${new Date(view.stopped.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
    : "";
  byId("downloadsNote").hidden = view.canHideDownloads;
  const run = view.run?.purpose === "backup" ? view.run : null;
  byId("backupStatus").textContent = !run ? "" : run.status === "finished"
    ? `Backup finished: ${run.found} works found.`
    : `Reading ${run.list ? LISTS[run.list] : "lists"}, page ${run.page} · ${run.found} works found so far.`;
}

async function refresh(): Promise<void> {
  const view = await send({ type: KEEP_A_COPY_MESSAGE.view });
  if (view && typeof view === "object") render(view);
}

async function change(patch: Partial<Settings>): Promise<void> {
  await send({ type: KEEP_A_COPY_MESSAGE.settings, patch });
  await refresh();
}

byId<HTMLInputElement>("enabled").addEventListener("change", (event) => void change({ enabled: (event.target as HTMLInputElement).checked }));
byId<HTMLInputElement>("weeklyCheck").addEventListener("change", (event) => void change({ weeklyCheck: (event.target as HTMLInputElement).checked }));
byId<HTMLSelectElement>("format").addEventListener("change", (event) => void change({ format: (event.target as HTMLSelectElement).value as CopyFormat }));
for (const box of document.querySelectorAll<HTMLInputElement>("[data-trigger]")) {
  box.addEventListener("change", () => void change({ triggers: { [box.dataset.trigger as Trigger]: box.checked } as Settings["triggers"] }));
}
byId("backup").addEventListener("click", async () => {
  const started = await send({ type: KEEP_A_COPY_MESSAGE.backup });
  if (started === "no_user") byId("backupStatus").textContent = "Open any AO3 page while signed in first, then try again.";
  else await refresh();
});

void refresh();
setInterval(() => void refresh(), 5_000);
