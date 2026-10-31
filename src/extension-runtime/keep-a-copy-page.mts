/**
 * The standalone Keep a Copy extension's AO3 page script. It tells the
 * background who is signed in, and, on a work's page, what the page's
 * Download menu offers and what the reader just did: bookmarked it, marked
 * it for later, subscribed or left kudos. Each is a form on AO3's pages, so
 * its submit button is what is watched: a click on kudos or subscribe may be
 * cancelled by the page's own script, so no submit event comes for those.
 * Only the work's preface and its Download menu leave the page, never its
 * text.
 *
 * A bookmark or Mark for Later navigates at once, and a stopped service worker
 * takes a moment to start: the message can go with the page. So what the reader
 * did is kept in the tab until it is answered, and the next page sends it again,
 * with the same id, so the background handles it once.
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

/** `id`: the same when sent again, so the background handles it once. */
type Unanswered = { readonly type: string; readonly trigger: PageTrigger; readonly html: string; readonly workId?: string; readonly id?: string };
const UNANSWERED_KEY = "keepACopyUnanswered";

/** Sends what the reader did, keeping it in `storage` until it is answered. A repeat changes nothing in the queue. */
export function reliableSender(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, post: (message: unknown) => Promise<unknown>) {
  const held = (): Unanswered[] => {
    try {
      const list: unknown = JSON.parse(storage.getItem(UNANSWERED_KEY) ?? "[]");
      return Array.isArray(list) ? list as Unanswered[] : [];
    } catch {
      return [];
    }
  };
  const hold = (list: Unanswered[]) => {
    try {
      if (list.length > 0) storage.setItem(UNANSWERED_KEY, JSON.stringify(list));
      else storage.removeItem(UNANSWERED_KEY);
    } catch {
      // The tab's storage is full or off: the first try is all there is.
    }
  };
  const deliver = (message: Unanswered, extra: Record<string, unknown>) => {
    const sent = JSON.stringify(message);
    post({ ...message, ...extra }).then(() => hold(held().filter((each) => JSON.stringify(each) !== sent)), () => undefined);
  };
  return {
    send(message: Unanswered, extra: Record<string, unknown>): void {
      hold([...held(), message]);
      deliver(message, extra);
    },
    /** What an earlier page in this tab could not get answered. */
    resend(): void {
      for (const message of held()) deliver(message, {});
    },
  };
}

/** The tab's storage; reading it throws when the reader blocks site data, and the first try is then all there is. */
function tabStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    return sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  }
}

const sender = runtime ? reliableSender(tabStorage(), (message) => runtime.sendMessage(message)) : null;

function tell(trigger: PageTrigger, formWork?: string): void {
  const workId = WORK_PATH.exec(location.pathname)?.[1] ?? formWork;
  const message = { type: KEEP_A_COPY_MESSAGE.page, trigger, html: workParts(), ...(workId ? { workId } : {}) };
  // Who is signed in goes only with this page's own message.
  const user = { user: signedInUser(document) };
  if (trigger !== "visit") sender?.send({ ...message, id: crypto.randomUUID() }, user);
  else void runtime?.sendMessage({ ...message, ...user }).catch(() => undefined);
}

const SUBMIT_BUTTON = 'input[type="submit"], button[type="submit"], button:not([type])';

/**
 * Calls `act` once for each form the reader sends, ahead of the page's own
 * handlers: a click on its submit button (which may be cancelled, and then is
 * all there is), or a submit with no click.
 */
export function watchForms(page: Pick<Document, "addEventListener">, act: (form: HTMLFormElement) => void): void {
  let last: HTMLFormElement | null = null;
  const once = (form: HTMLFormElement) => {
    if (form === last) return;
    last = form;
    // A submit follows its click within this task.
    setTimeout(() => {
      last = null;
    }, 0);
    act(form);
  };
  page.addEventListener("click", (event) => {
    const form = (event.target as Element | null)?.closest?.(SUBMIT_BUTTON)?.closest("form");
    if (form) once(form);
  }, true);
  page.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement | null;
    if (form?.tagName === "FORM") once(form);
  }, true);
}

/** What a form does and, when its path says, to which work: a list's Save form is on no work's page. */
function formAction(form: HTMLFormElement): { trigger: PageTrigger; workId?: string } | null {
  try {
    const path = new URL(form.action, location.href).pathname;
    const trigger = formTriggerFor(path);
    if (!trigger) return null;
    const workId = /\/works\/([1-9][0-9]{0,19})\//.exec(path)?.[1];
    return workId ? { trigger, workId } : { trigger };
  } catch {
    return null;
  }
}

if (runtime) {
  watchForms(document, (form) => {
    const action = formAction(form);
    if (action) tell(action.trigger, action.workId);
  });
  tell("visit");
  sender?.resend();
}
