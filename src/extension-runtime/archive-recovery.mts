import { archiveHostKindFromSender, isBlockedArchivePath } from "./archive-sender.mjs";
import { extensionCall, type BrowserTab, type RuntimePort, type TabsPort, type PermissionsPort, type ScriptingPort } from "./browser-platform.mjs";

type Environment = { runtime: RuntimePort; tabs: TabsPort; permissions: PermissionsPort | undefined; scripting: ScriptingPort | undefined; mode: "promise" | "callback" };

function matches(pattern: string, url: URL): boolean {
  const match = /^https:\/\/(\*\.)?([^/]+)(\/.*)$/.exec(pattern);
  if (!match || url.protocol !== "https:") return false;
  if (url.hostname !== match[2] && !(match[1] && url.hostname.endsWith(`.${match[2]}`))) return false;
  const path = match[3]!.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${path}$`).test(url.pathname + url.search);
}

/** Restore only existing grants. No permission prompts, tab navigation, or URL storage. */
export function installArchiveRecovery(environment: Environment): () => Promise<void> {
  const { runtime, tabs, permissions, scripting, mode } = environment;
  const call = <T,>(target: object, method: string, args: unknown[]) => extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  let pending: Promise<void> | null = null;
  const recover = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      if (!scripting?.executeScript || !permissions?.contains || !runtime.getManifest) return;
      const scripts = runtime.getManifest().content_scripts ?? [];
      const openTabs = await call<readonly BrowserTab[]>(tabs, "query", [{}]);
      await Promise.all(openTabs.map(async tab => {
        try {
          if (!Number.isInteger(tab.id) || !tab.url) return;
          const host = archiveHostKindFromSender({ url: tab.url });
          if (!host || isBlockedArchivePath(tab.url, host)) return;
          const url = new URL(tab.url);
          const files = scripts.filter(script => script.matches?.some(pattern => matches(pattern, url)) &&
            !script.exclude_matches?.some(pattern => matches(pattern, url))).flatMap(script => script.js ?? []);
          if (!files.length || !await call<boolean>(permissions, "contains", [{ origins: [`${url.origin}/*`] }])) return;
          await call(scripting, "executeScript", [{ target: { tabId: tab.id, frameIds: [0] }, files: [...new Set(files)] }]);
        } catch { /* A closed, navigating, or newly denied tab uses the popup fallback. */ }
      }));
    })().catch(() => undefined).finally(() => { pending = null; });
    return pending;
  };
  runtime.onInstalled?.addListener(details => {
    if (details.reason === "install" || details.reason === "update") void recover();
  });
  runtime.onStartup?.addListener(() => { void recover(); });
  void recover();
  return recover;
}
