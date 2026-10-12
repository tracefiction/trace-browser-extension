import { archiveHostKindFromSender, isBlockedArchivePath, isStorySitePattern } from "./archive-sender.mjs";
import { extensionCall, type BrowserTab, type RuntimePort, type TabsPort, type PermissionsPort, type ScriptingPort } from "./browser-platform.mjs";

type PageScript = { readonly matches?: readonly string[]; readonly exclude_matches?: readonly string[]; readonly js?: readonly string[] };
/**
 * Scripts this build registers once the reader allows its story sites, where
 * the manifest declares none. They run only under the complete grant.
 */
export type RegisteredArchiveScripts = Readonly<{
  origins: readonly string[];
  registrations: readonly Readonly<{ matches: readonly string[]; js: readonly string[]; excludeMatches?: readonly string[] }>[];
}>;
type Environment = { runtime: RuntimePort; tabs: TabsPort; permissions: PermissionsPort | undefined; scripting: ScriptingPort | undefined; mode: "promise" | "callback"; registered?: RegisteredArchiveScripts };

function matches(pattern: string, url: URL): boolean {
  const match = /^https:\/\/(\*\.)?([^/]+)(\/.*)$/.exec(pattern);
  if (!match || url.protocol !== "https:") return false;
  if (url.hostname !== match[2] && !(match[1] && url.hostname.endsWith(`.${match[2]}`))) return false;
  const path = match[3]!.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${path}$`).test(url.pathname + url.search);
}

/** Restore only existing grants. No permission prompts, tab navigation, or URL storage. */
export function installArchiveRecovery(environment: Environment): () => Promise<void> {
  const { runtime, tabs, permissions, scripting, mode, registered } = environment;
  const call = <T,>(target: object, method: string, args: unknown[]) => extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  let pending: Promise<void> | null = null;
  const recover = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      if (!scripting?.executeScript || !permissions?.contains) return;
      let scripts: readonly PageScript[];
      if (registered) {
        // Registered scripts belong to the complete grant. With anything less,
        // or with no answer, no tab is asked for and nothing is injected.
        if (!registered.origins.length ||
            await call<boolean>(permissions, "contains", [{ origins: [...registered.origins] }]) !== true) return;
        scripts = registered.registrations.map(({ matches, js, excludeMatches }) => ({
          matches, js, ...(excludeMatches === undefined ? {} : { exclude_matches: excludeMatches }),
        }));
      } else {
        if (!runtime.getManifest) return;
        scripts = runtime.getManifest().content_scripts ?? [];
      }
      // Ask only for story-site tabs. A query with no address filter reads as
      // a wish to see every open tab, and Safari may then ask the reader about
      // a site that has nothing to do with Trace.
      const storySites = [...new Set(scripts.flatMap(script => script.matches ?? []))].filter(isStorySitePattern);
      if (!storySites.length) return;
      const openTabs = await call<readonly BrowserTab[]>(tabs, "query", [{ url: storySites }]);
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
