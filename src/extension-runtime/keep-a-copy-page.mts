/**
 * The standalone Keep a Copy extension's AO3 page script. It tells the
 * background who is signed in, and, on a work's page, what the page's
 * Download menu offers and what the reader just did: bookmarked it, marked
 * it for later, subscribed or left kudos. Each is a form on AO3's pages, so
 * a submit is what is watched. Only the work's preface and its Download menu leave the
 * page, never its text.
 */

import { KEEP_A_COPY_MESSAGE, formTriggerFor } from "./keep-a-copy.mjs";

type PageTrigger = "bookmark" | "later" | "subscribe" | "kudos" | "visit";

const scope = globalThis as unknown as {
  browser?: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
  chrome?: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
};
const runtime = (scope.browser ?? scope.chrome)?.runtime;

/**
 * The name the reader is signed in as; null only when the page shows AO3's
 * login link; undefined when it says neither, as a 429 or a check page does.
 */
export function signedInUser(page: Pick<Document, "querySelector">): string | null | undefined {
  const href = page.querySelector('#greeting a[href^="/users/"]')?.getAttribute("href") ?? "";
  const name = /^\/users\/([A-Za-z0-9_]{1,40})(?:\/|$)/.exec(href)?.[1];
  if (name) return name;
  return page.querySelector('#login-dropdown, #header a[href^="/users/login"]') ? null : undefined;
}

// A work's own page, in a collection or not, and the pages of its chapters and bookmarks.
const WORK_PATH = /^\/(?:collections\/[^/]+\/)?works\/([1-9][0-9]{0,19})(\/chapters\/[0-9]+|\/bookmarks(?:\/new)?)?\/?$/;

function workParts(): string {
  if (!WORK_PATH.test(location.pathname)) return "";
  return ["h2.title", ".preface a[rel=author]", "dl.work.meta", "li.download"]
    .map((selector) => document.querySelector(selector)?.outerHTML ?? "")
    .join("\n");
}

function tell(trigger: PageTrigger): void {
  const workId = WORK_PATH.exec(location.pathname)?.[1];
  void runtime?.sendMessage({ type: KEEP_A_COPY_MESSAGE.page, trigger, user: signedInUser(document), html: workParts(), ...(workId ? { workId } : {}) }).catch(() => undefined);
}

/** What a form on the work's page does, from where it posts. */
function formTrigger(form: HTMLFormElement): PageTrigger | null {
  try {
    return formTriggerFor(new URL(form.action, location.href).pathname);
  } catch {
    return null;
  }
}

if (runtime) {
  document.addEventListener("submit", (event) => {
    const trigger = event.target instanceof HTMLFormElement ? formTrigger(event.target) : null;
    if (trigger) tell(trigger);
  }, true);
  tell("visit");
}
