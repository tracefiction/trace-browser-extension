import { ao3WorkPath, archiveHostKindFromSender, isStorySitePattern } from "./archive-sender.mjs";
import { extensionCall, type BrowserTab, type PermissionsPort, type RuntimeMessageSender, type RuntimePort, type TabsPort } from "./browser-platform.mjs";

/**
 * The Trace app marks the story links it opens in Safari (`#trace-open`).
 * A page that arrives with the mark asks, once, whether another tab already
 * shows the same story and chapter. If one does, that tab comes forward and
 * the new tab, which the app opened, closes. Nothing else is ever closed: a
 * tab the reader opened carries no mark, and the only tab that may close is
 * the one asking.
 */
export const STORY_TAB_REUSE_MESSAGE = "TRACE_STORY_TAB_REUSE" as const;

const STEP_TIMEOUT_MS = 2_000;
// Past this, nothing is brought forward or closed: the reader has moved on.
const ACT_WITHIN_MS = 5_000;
// A tab that asked recently is never the one brought forward: two links the
// app opened one after the other must not close each other.
const RECENT_ASKER_MS = 30_000;

type Environment = { runtime: RuntimePort; tabs: TabsPort; permissions: PermissionsPort | undefined; mode: "promise" | "callback"; now?: () => number };

/**
 * One story at one place: the site, the story and the chapter. AO3's work
 * page without a chapter, and its whole-work view, are places of their own;
 * FanFiction.net's story page without a chapter is its first chapter.
 */
export function storyTabKey(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4_096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    const site = archiveHostKindFromSender({ url: url.href });
    if (site === "ao3") {
      const match = ao3WorkPath(url.pathname).match(/^\/works\/([1-9]\d{0,19})(?:\/chapters\/([1-9]\d{0,19}))?\/?$/);
      if (!match) return null;
      const place = url.searchParams.get("view_full_work") === "true" ? "full" : match[2] ?? "work";
      return `ao3:${match[1]}:${place}`;
    }
    if (site === "ffn") {
      const match = url.pathname.match(/^\/s\/([1-9]\d{0,19})(?:\/([1-9]\d{0,9})(?:\/[^/]*)?)?\/?$/);
      return match ? `ffn:${match[1]}:${match[2] ?? "1"}` : null;
    }
    return null;
  } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export type StoryTabReuseResult = Readonly<{ ok: boolean; reused: boolean; closed: boolean }>;
const NOTHING: StoryTabReuseResult = Object.freeze({ ok: true, reused: false, closed: false });
const REFUSED: StoryTabReuseResult = Object.freeze({ ok: false, reused: false, closed: false });

export function installStoryTabReuse(environment: Environment): (message: unknown, sender: RuntimeMessageSender | undefined) => Promise<StoryTabReuseResult> {
  const { runtime, tabs, permissions, mode } = environment;
  const now = environment.now ?? (() => Date.now());
  const call = <T,>(target: object, method: string, args: unknown[]) => extensionCall<T>(
    target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  const recent = new Map<number, number>();
  let queue: Promise<unknown> = Promise.resolve();

  const reuse = async (senderTabId: number, key: string, deadline: number): Promise<StoryTabReuseResult> => {
    if (!permissions) return NOTHING;
    // Only the story sites the reader has allowed are looked at: a query with
    // no address filter reads as a wish to see every open tab.
    const grants = await bounded(call<{ origins?: string[] }>(permissions, "getAll", []), STEP_TIMEOUT_MS);
    const storySites = (grants?.origins ?? []).filter(isStorySitePattern);
    if (!storySites.length) return NOTHING;
    const open = await bounded(call<readonly BrowserTab[]>(tabs, "query", [{ url: storySites }]), STEP_TIMEOUT_MS);
    if (!Array.isArray(open)) return NOTHING;
    const existing = open
      .filter(tab => Number.isInteger(tab.id) && tab.id !== senderTabId && tab.incognito !== true
        && !recent.has(tab.id!) && storyTabKey(tab.url) === key)
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (!existing || !tabs.update || now() > deadline) return NOTHING;
    const shown = await bounded(call(tabs, "update", [existing.id, { active: true }]).then(() => true), STEP_TIMEOUT_MS);
    if (shown !== true) return NOTHING;
    const closed = tabs.remove && now() <= deadline
      ? await bounded(call(tabs, "remove", [senderTabId]).then(() => true), STEP_TIMEOUT_MS) === true
      : false;
    return Object.freeze({ ok: true, reused: true, closed });
  };

  const handle = async (message: unknown, sender: RuntimeMessageSender | undefined): Promise<StoryTabReuseResult> => {
    if (!isRecord(message) || Object.keys(message).length !== 2 || message.type !== STORY_TAB_REUSE_MESSAGE
      || !isRecord(message.payload) || Object.keys(message.payload).length !== 1) return REFUSED;
    if (!sender) return REFUSED;
    const tabId = sender.tab?.id;
    if (sender.id !== runtime.id || !Number.isInteger(tabId) || (sender.frameId !== undefined && sender.frameId !== 0)
      || archiveHostKindFromSender(sender) === null) return REFUSED;
    // The page names where it is, and the browser says the same.
    const key = storyTabKey(sender.tab?.url ?? sender.url);
    if (key === null || storyTabKey(message.payload.url) !== key) return REFUSED;
    const at = now();
    for (const [id, asked] of recent) if (at - asked > RECENT_ASKER_MS) recent.delete(id);
    if (recent.has(tabId!)) return NOTHING;
    recent.set(tabId!, at);
    // One question at a time, so two new tabs never settle on each other.
    const deadline = at + ACT_WITHIN_MS;
    const turn = queue.then(() => reuse(tabId!, key, deadline)).catch(() => NOTHING);
    queue = turn;
    return turn;
  };

  runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRecord(message) || message.type !== STORY_TAB_REUSE_MESSAGE) return;
    void handle(message, sender).then(respond, () => respond(NOTHING));
    return true;
  });
  return handle;
}
