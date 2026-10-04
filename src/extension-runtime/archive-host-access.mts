import { archiveHostKindFromSender, isBlockedArchivePath } from "./archive-sender.mjs";
import { extensionCall, type BrowserTab, type PermissionsPort, type RuntimeMessageSender, type RuntimePort, type TabsPort } from "./browser-platform.mjs";

type Site = "ao3" | "ffn";
type Access = Readonly<{ site: Site; label: string; origins: readonly string[]; granted: boolean | null }>;
type Environment = { runtime: RuntimePort; tabs: TabsPort; permissions: PermissionsPort | undefined; mode: "promise" | "callback"; recover: () => Promise<void> };

/** Only declared archive hosts; no optional hosts, Trace origins, or page data. */
export function declaredArchiveAccess(runtime: RuntimePort): readonly Omit<Access, "granted">[] {
  const hosts = runtime.getManifest?.().host_permissions ?? [];
  return (["ao3", "ffn"] as const).map(site => ({
    site,
    label: site === "ao3" ? "AO3" : "FanFiction.net",
    origins: hosts.filter(pattern => {
      const url = pattern.replace("*.", "");
      return archiveHostKindFromSender({ url }) === site;
    }),
  })).filter(access => access.origins.length > 0);
}

export function installArchiveHostAccess(environment: Environment): (() => Promise<readonly Access[]>) | null {
  const { runtime, tabs, permissions, mode, recover } = environment;
  const root = runtime.getURL?.("");
  // Safari owns Website Access through its existing app/popup flow.
  if (typeof root !== "string" || !/^(?:moz|chrome)-extension:\/\//.test(root) || !permissions?.contains) return null;
  const sites = declaredArchiveAccess(runtime);
  const call = <T,>(target: object, method: string, args: unknown[]) => extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  const isUi = (sender: RuntimeMessageSender) => {
    if (sender.id !== runtime.id) return false;
    return (!sender.tab && sender.url === runtime.getURL?.("popup.html")) ||
      sender.url?.split("?")[0] === runtime.getURL?.("archive-access.html");
  };
  const siteFor = (sender: RuntimeMessageSender): Site | null => {
    if (sender.id !== runtime.id) return null;
    const site = archiveHostKindFromSender(sender);
    if (!site || isBlockedArchivePath(sender.tab?.url ?? sender.url, site)) return null;
    const raw = sender.tab?.url ?? sender.url;
    if (!raw) return null;
    const host = new URL(raw).hostname;
    return sites.some(access => access.site === site && access.origins.some(pattern => {
      const declared = /^https:\/\/(\*\.)?([^/]+)\//.exec(pattern);
      return declared && (host === declared[2] || (declared[1] && host.endsWith(`.${declared[2]}`)));
    })) ? site : null;
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
  const refresh = async (): Promise<readonly Access[]> => {
    const current = ++generation;
    const access = await read();
    if (current !== generation) return access;
    const message = { type: "TRACE_ARCHIVE_HOST_ACCESS_CHANGED", access };
    if (runtime.sendMessage) void call(runtime, "sendMessage", [message]).catch(() => undefined);
    try {
      const openTabs = await call<readonly BrowserTab[]>(tabs, "query", [{}]);
      if (current !== generation) return access;
      await Promise.all(openTabs.map(async tab => {
        if (!Number.isInteger(tab.id)) return;
        const site = siteFor({ id: runtime.id!, tab: { id: tab.id!, ...(tab.url ? { url: tab.url } : {}) }, frameId: 0 });
        if (!site) return;
        await call(tabs, "sendMessage", [tab.id, { ...message, access: access.filter(item => item.site === site) }, { frameId: 0 }]).catch(() => undefined);
      }));
    } catch { /* No open archive tabs need an update. */ }
    return access;
  };
  runtime.onMessage.addListener((raw, sender, respond) => {
    const type = (raw as { type?: unknown } | null)?.type;
    if (type !== "TRACE_ARCHIVE_HOST_ACCESS_GET" && type !== "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") return;
    const ui = isUi(sender);
    const site = siteFor(sender);
    if (!ui && !site) { respond({ ok: false }); return; }
    if (type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH" && !ui) { respond({ ok: false }); return; }
    void (type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH" ? refresh().then(async access => { await recover(); return access; }) : read()).then(
      access => respond({ ok: true, access: ui ? access : access.filter(item => item.site === site) }),
      () => respond({ ok: false }),
    );
    return true;
  });
  runtime.onInstalled?.addListener(details => {
    if (details.reason === "install" || details.reason === "update") void refresh();
  });
  runtime.onStartup?.addListener(() => { void refresh(); });
  permissions.onAdded?.addListener(() => { void refresh().then(recover); });
  permissions.onRemoved?.addListener(() => { void refresh(); });
  void refresh();
  return refresh;
}
