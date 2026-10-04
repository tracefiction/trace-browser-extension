import { archiveHostKindFromSender } from "./archive-sender.mjs";
import { extensionCall, type ActionPort, type PermissionsPort, type RuntimeMessageSender, type RuntimePort } from "./browser-platform.mjs";

type Site = "ao3" | "ffn";
type Access = Readonly<{ site: Site; label: string; origins: readonly string[]; granted: boolean | null }>;
type Environment = { runtime: RuntimePort; action: ActionPort | undefined; permissions: PermissionsPort | undefined; mode: "promise" | "callback"; recover: () => Promise<void> };

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
  const { runtime, action, permissions, mode, recover } = environment;
  const root = runtime.getURL?.("");
  // Safari owns Website Access through its existing app/popup flow.
  if (typeof root !== "string" || !/^(?:moz|chrome)-extension:\/\//.test(root) || !permissions?.contains) return null;
  const sites = declaredArchiveAccess(runtime);
  const defaultTitle = runtime.getManifest?.().action?.default_title ?? "Trace";
  const call = <T,>(target: object, method: string, args: unknown[]) => extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  const isPopup = (sender: RuntimeMessageSender) => sender.id === runtime.id && !sender.tab && sender.url === runtime.getURL?.("popup.html");
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
    return access;
  };
  runtime.onMessage.addListener((raw, sender, respond) => {
    const type = (raw as { type?: unknown } | null)?.type;
    if (type !== "TRACE_ARCHIVE_HOST_ACCESS_GET" && type !== "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") return;
    if (!isPopup(sender)) { respond({ ok: false }); return; }
    void refresh().then(async access => {
      if (type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") await recover();
      return { ok: true, access };
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
