import { archiveHostKindFromSender, isBlockedArchivePath } from "./archive-sender.mjs";
import { extensionCall, type ActionPort, type BrowserTab, type PermissionsPort, type RuntimeMessageSender, type RuntimePort, type TabsPort } from "./browser-platform.mjs";

type Access = Readonly<{ site: "all"; label: string; origins: readonly string[]; granted: boolean | null }>;
type Environment = { runtime: RuntimePort; tabs: TabsPort; action: ActionPort | undefined; permissions: PermissionsPort | undefined; mode: "promise" | "callback"; recover: () => Promise<void> };

/** One atomic grant for every declared host, including Trace connection hosts. */
export function declaredArchiveAccess(runtime: RuntimePort): readonly Omit<Access, "granted">[] {
  const origins = [...new Set(runtime.getManifest?.().host_permissions ?? [])];
  return origins.length ? [{ site: "all", label: "AO3 and FanFiction.net", origins }] : [];
}

export function installArchiveHostAccess(environment: Environment): (() => Promise<readonly Access[]>) | null {
  const { runtime, tabs, action, permissions, mode, recover } = environment;
  const root = runtime.getURL?.("");
  // Safari owns Website Access through its existing app/popup flow.
  if (typeof root !== "string" || !/^(?:moz|chrome)-extension:\/\//.test(root) || !permissions?.contains) return null;
  const sites = declaredArchiveAccess(runtime);
  const defaultTitle = runtime.getManifest?.().action?.default_title ?? "Trace";
  const call = <T,>(target: object, method: string, args: unknown[]) => extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  const isPopup = (sender: RuntimeMessageSender) => sender.id === runtime.id && !sender.tab && sender.url === runtime.getURL?.("popup.html");
  const archiveSite = (sender: RuntimeMessageSender) => {
    if (sender.id !== runtime.id || !Number.isInteger(sender.tab?.id)) return null;
    const site = archiveHostKindFromSender(sender);
    const raw = sender.tab?.url ?? sender.url;
    if (!site || !raw || isBlockedArchivePath(raw, site)) return null;
    const host = new URL(raw).hostname;
    return sites[0]?.origins.some(pattern => {
      const match = /^https:\/\/(\*\.)?([^/]+)\//.exec(pattern);
      return match && (host === match[2] || (match[1] && host.endsWith(`.${match[2]}`)));
    }) ? site : null;
  };
  const read = async (): Promise<readonly Access[]> => Promise.all(sites.map(async access => {
    try {
      return { ...access, granted: await call<boolean>(permissions, "contains", [{ origins: access.origins }]) === true };
    } catch {
      // Unavailable permission evidence is not a denial.
      return { ...access, granted: null };
    }
  }));
  let generation = 0;
  let badgeUpdate = Promise.resolve();
  const refresh = async (): Promise<readonly Access[]> => {
    const current = ++generation;
    const access = await read();
    if (current !== generation) return access;
    const missing = access.some(item => item.granted === false);
    // Content scripts cannot show a notice without host access. The global
    // toolbar badge supplies discovery even before any archive page runs.
    // Serialize action writes so a stale removal cannot overwrite a new grant.
    badgeUpdate = badgeUpdate.then(async () => {
      if (!action || current !== generation || !access.length) return;
      if (!missing && access.some(item => item.granted === null)) return;
      const write = (method: string, details: object) => call(action, method, [details]).catch(() => undefined);
      if (missing) {
        await write("setBadgeBackgroundColor", { color: "#9B4146" });
        if (action.setBadgeTextColor) await write("setBadgeTextColor", { color: "#FFFFFF" });
      }
      if (current !== generation) return;
      await write("setBadgeText", { text: missing ? "!" : "" });
      await write("setTitle", { title: missing ? "Site access is off — click to allow" : defaultTitle });
    });
    await badgeUpdate;
    if (current === generation && runtime.sendMessage) {
      void call(runtime, "sendMessage", [{ type: "TRACE_ARCHIVE_HOST_ACCESS_CHANGED", access }]).catch(() => undefined);
    }
    if (current === generation) {
      try {
        const openTabs = await call<readonly BrowserTab[]>(tabs, "query", [{}]);
        if (current === generation) await Promise.all(openTabs.map(async tab => {
          if (!archiveSite({ id: runtime.id!, tab, frameId: 0 })) return;
          // Pages need only grant evidence, never the manifest origin inventory.
          await call(tabs, "sendMessage", [tab.id, {
            type: "TRACE_ARCHIVE_HOST_ACCESS_CHANGED", granted: access[0]?.granted ?? null,
          }, { frameId: 0 }]).catch(() => undefined);
        }));
      } catch { /* Closed or unavailable tabs recheck when their overlay starts. */ }
    }
    return access;
  };
  runtime.onMessage.addListener((raw, sender, respond) => {
    const type = (raw as { type?: unknown } | null)?.type;
    if (type !== "TRACE_ARCHIVE_HOST_ACCESS_GET" && type !== "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") return;
    const popup = isPopup(sender);
    if (!popup && (!archiveSite(sender) || type !== "TRACE_ARCHIVE_HOST_ACCESS_GET")) { respond({ ok: false }); return; }
    void refresh().then(async access => {
      if (type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") await recover();
      return popup ? { ok: true, access } : { ok: true, granted: access[0]?.granted ?? null };
    }).then(respond, () => respond({ ok: false }));
    return true;
  });
  runtime.onInstalled?.addListener(details => {
    if (details.reason === "install" || details.reason === "update") void refresh();
  });
  runtime.onStartup?.addListener(() => { void refresh(); });
  permissions.onAdded?.addListener(() => { void refresh().then(recover).catch(() => undefined); });
  permissions.onRemoved?.addListener(() => { void refresh(); });
  void refresh();
  return refresh;
}
