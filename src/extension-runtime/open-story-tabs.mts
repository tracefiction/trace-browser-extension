import { extensionCall } from "./browser-platform.mjs";
import { isStorySitePattern } from "./archive-sender.mjs";
import type { BrowserTab, PermissionsPort, RuntimePort, ScriptingPort, TabsPort } from "./browser-platform.mjs";

// Wider scans use only the reader's existing site grants. The explicit popup
// action can also inspect the active tab through temporary activeTab access.
const LIMIT = 250;
// Browser injections cannot be cancelled. Keep their capacity reserved even
// after a read or scan times out, including across a reader's retry.
const pendingReads = new WeakMap<ScriptingPort, Set<Promise<unknown>>>();

export function openStoryIdentity(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    const ao3 = /^(?:[^.]+\.)*(?:archiveofourown\.(?:org|gay)|ao3\.org)$/.test(url.hostname)
      || url.hostname === "archive.transformativeworks.org";
    const ffn = ["www.fanfiction.net", "m.fanfiction.net"].includes(url.hostname);
    const path = url.pathname.replace(/^\/collections\/[^/]+(?=\/works\/)/, "");
    const match = path.match(ao3 ? /^\/works\/([1-9]\d{0,19})(?:\/chapters\/[1-9]\d{0,19})?\/?$/
      : /^\/s\/([1-9]\d{0,19})(?:\/[1-9]\d{0,9})?(?:\/[^/]*)?\/?$/);
    return (ao3 || ffn) && match ? `${ao3 ? "ao3" : "ffn"}:${match[1]}` : null;
  } catch { return null; }
}

// Serialized by scripting.executeScript: no closures, imported helpers,
// normal collector installation, input values, network requests or writes.
export function readOpenStory(expectedKey: string, deadline: number) {
  if (Date.now() >= deadline) return null;
  const host = location.hostname;
  const ao3 = /^(?:[^.]+\.)*(?:archiveofourown\.(?:org|gay)|ao3\.org)$/.test(host)
    || host === "archive.transformativeworks.org";
  const ffn = ["www.fanfiction.net", "m.fanfiction.net"].includes(host);
  const path = location.pathname.replace(/^\/collections\/[^/]+(?=\/works\/)/, "");
  const match = path.match(ao3 ? /^\/works\/([1-9]\d{0,19})(?:\/chapters\/[1-9]\d{0,19})?\/?$/
    : /^\/s\/([1-9]\d{0,19})(?:\/[1-9]\d{0,9})?(?:\/[^/]*)?\/?$/);
  if (location.protocol !== "https:" || location.port || (!ao3 && !ffn) || !match
      || `${ao3 ? "ao3" : "ffn"}:${match[1]}` !== expectedKey) return null;
  for (const input of Array.from(document.querySelectorAll('input[type="password"]'))) {
    const form = input.closest("form");
    let knownHeader = false;
    if (ao3 && form?.id === "new_user_session_small" && form.closest("#header")) {
      try {
        const action = new URL(form.getAttribute("action") ?? "", location.href);
        knownHeader = action.origin === location.origin && action.pathname === "/users/login";
      } catch { /* Unrecognized credential pages stay excluded. */ }
    }
    if (!knownHeader) return null;
  }
  const text = (selector: string, maximum = 512) => {
    const node = Array.from(document.querySelectorAll(selector)).find(node =>
      !node.closest("#storytext, .storytext, #storycontent, .storycontent, .chapter .userstuff"));
    return (node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
  };
  const integer = (value: string) => {
    if (!value.trim()) return null;
    const number = Number(value.replace(/,/g, ""));
    return Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000 ? number : null;
  };
  // Mobile FFN puts metadata in direct text nodes between the header's first
  // two rules, followed by a rendered chapter caption. Do not read #content's
  // textContent: it can also contain story prose, forms or unrelated elements.
  let mobileStats = "", mobileChapter = "";
  if (host === "m.fanfiction.net") {
    let rules = 0, visited = 0;
    for (const node of document.querySelector("#content")?.childNodes ?? []) {
      if (++visited > 80) break;
      if (rules === 2 && node.nodeType === 1 && (node as Element).tagName === "BR") break;
      if (node.nodeType === 1 && (node as Element).tagName === "HR") {
        if (++rules > 2) break;
      } else if (node.nodeType === 3) {
        if (rules === 1) mobileStats += (node.textContent ?? "").slice(0, 2048 - mobileStats.length);
        if (rules === 2) mobileChapter += (node.textContent ?? "").slice(0, 512 - mobileChapter.length);
      }
    }
  }
  const author = ao3 ? text('#workskin a[rel="author"], .byline a[rel="author"]')
    : text('#profile_top a[href*="/u/"], #content a[href*="/u/"]');
  const mobileTitle = host === "m.fanfiction.net" && author
    ? document.title.replace(/\s*[-|]\s*FanFiction(?:\.net)?\s*$/i, "")
      .replace(/^Fanfic:\s*/i, "").replace(/\s+Ch\s+\d+,.*$/i, "").trim().slice(0, 512) : "";
  const title = ao3 ? text("#workskin h2.title, h2.title.heading")
    : text("#profile_top b.xcontrast_txt, #content b.xcontrast_txt")
      || (host === "m.fanfiction.net" ? text('#content > div[align="center"] > b') : "") || mobileTitle;
  const stats = ao3 ? text("dl.work.meta.group dd.words, dl.meta.group dd.words")
    : text("#profile_top .xgray, #content .gray, #content .xgray", 2048) || mobileStats;
  const wordCount = stats.match(/Words:\s*([\d,]+(?:\.\d+)?)\s*([km])?\+?(?=\s|,|$)/i);
  const wordUnit = wordCount?.[2]?.toLowerCase();
  const words = ao3 ? integer(stats) : wordCount
    ? integer(String(Number(wordCount[1]!.replace(/,/g, "")) * (wordUnit === "k" ? 1000 : wordUnit === "m" ? 1_000_000 : 1))) : null;
  const chapterText = ao3 ? text("dl.work.meta.group dd.chapters, dl.meta.group dd.chapters") : "";
  const published = integer(ao3 ? chapterText.match(/^([\d,]+)\s*\//)?.[1] ?? "NaN"
    : stats.match(/Chapters:\s*([\d,]+)/i)?.[1] ?? "NaN");
  const planned = ao3 ? chapterText.match(/\/\s*([\d,]+|\?)/)?.[1] : undefined;
  const complete = ao3 ? published !== null && planned !== undefined && planned !== "?" && published === integer(planned)
    : /Status:\s*Complete\b/i.test(stats);
  const chapter = integer(ao3
    ? text("#selected_id option:checked, #chapter_index option:checked, .chapter h3.title").match(/(?:Chapter\s+)?(\d+)/i)?.[1] ?? "NaN"
    : text("#chap_select option:checked, select[name=chapter] option:checked").match(/^(\d+)/)?.[1]
      ?? mobileChapter.match(/^\s*Chapter\s+(\d+)\s*:/i)?.[1] ?? "NaN");
  if (!title || (!author && words === null && published === null)) return null;
  return {
    src: ao3 ? "ao3" : "ffn", ctx: "tab", key: expectedKey,
    u: ao3 ? `https://archiveofourown.org/works/${match[1]}` : `https://www.fanfiction.net/s/${match[1]}/`,
    chu: location.origin + location.pathname, t: title, a: author || undefined,
    w: words ?? undefined, chPub: published ?? undefined,
    cht: ao3 ? (planned === "?" ? "?" : planned ? integer(planned) ?? undefined : undefined)
      : complete ? published ?? undefined : undefined,
    chn: chapter && chapter > 0 ? chapter : undefined,
    s: complete ? "complete" : (ao3 && planned || /Status:\s*In-Progress/i.test(stats)) ? "wip" : undefined,
  };
}

type Ports = { runtime: RuntimePort; tabs: TabsPort; scripting?: ScriptingPort; permissions?: PermissionsPort; mode: "promise" | "callback" };
export type OpenStoryTabsPayload = { s: "tabs"; at: string; items: NonNullable<ReturnType<typeof readOpenStory>>[];
  scan: { considered: number; unreadable: number; duplicates: number; limited: number } };

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function collectOpenStoryTabs(ports: Ports): Promise<OpenStoryTabsPayload | null> {
  if (!ports.scripting?.executeScript) return null;
  const deadline = Date.now() + 15_000;
  const call = <T,>(target: object, method: string, args: unknown[]) => extensionCall<T>(
    target as Record<string, (...args: unknown[]) => unknown>, method, args, ports.runtime, ports.mode);
  const grants = ports.permissions ? await bounded(call<{ origins?: string[] }>(ports.permissions, "getAll", []), 2000) : null;
  const storySites = (grants?.origins ?? []).filter(isStorySitePattern);
  const [granted, active] = await Promise.all([
    storySites.length ? bounded(call<BrowserTab[]>(ports.tabs, "query", [{ url: storySites }]), 2000) : null,
    bounded(call<BrowserTab[]>(ports.tabs, "query", [{ active: true, currentWindow: true }]), 2000),
  ]);
  if (!Array.isArray(granted) && !Array.isArray(active)) return null;
  const seenTabs = new Set<number>();
  const candidates = [...(Array.isArray(active) ? active : []), ...(Array.isArray(granted) ? granted : [])].filter(tab => {
    if (tab.incognito === true || typeof tab.id !== "number" || !openStoryIdentity(tab.url) || seenTabs.has(tab.id)) return false;
    seenTabs.add(tab.id);
    return true;
  });
  const selected = candidates.slice(0, LIMIT);
  let pending = pendingReads.get(ports.scripting);
  if (!pending) { pending = new Set(); pendingReads.set(ports.scripting, pending); }
  const reads = pending;
  const captured: (NonNullable<ReturnType<typeof readOpenStory>> | null)[] = Array(selected.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length && Date.now() < deadline) {
      if (reads.size >= 4) {
        await bounded(Promise.race(reads), deadline - Date.now());
        continue;
      }
      const index = next++, tab = selected[index]!;
      if (tab.discarded === true) continue;
      const key = openStoryIdentity(tab.url)!;
      const readDeadline = Math.min(deadline, Date.now() + 2000);
      const operation = extensionCall<{ frameId?: number; result?: ReturnType<typeof readOpenStory> }[]>(
        ports.scripting! as unknown as Record<string, (...args: unknown[]) => unknown>, "executeScript", [{ target: { tabId: tab.id }, func: readOpenStory, args: [key, readDeadline] }],
        ports.runtime, ports.mode).catch(() => null);
      reads.add(operation);
      void operation.then(() => reads.delete(operation));
      const results = await bounded(operation, readDeadline - Date.now());
      if (Date.now() >= readDeadline) continue;
      const result = Array.isArray(results) ? results.find(frame => frame.frameId === 0)?.result : null;
      if (result && result.key === key && openStoryIdentity(result.u) === key && typeof result.t === "string" && result.t.trim()) {
        captured[index] = result;
      }
    }
  }));
  const items: OpenStoryTabsPayload["items"] = [];
  const seen = new Set<string>();
  let unreadable = 0, duplicates = 0;
  for (const item of captured) {
    if (!item) unreadable++;
    else if (seen.has(item.key)) duplicates++;
    else { seen.add(item.key); items.push(item); }
  }
  return { s: "tabs", at: new Date().toISOString(), items,
    scan: { considered: selected.length, unreadable, duplicates, limited: Math.max(0, candidates.length - LIMIT) } };
}

export function encodeOpenStoryTabs(payload: OpenStoryTabsPayload): string | null {
  if (payload.items.length === 0) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > 512 * 1024) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
