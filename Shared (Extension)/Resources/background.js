// Generated kernel runtime. Do not edit by hand.
const TRACE_API_BASE = "https://api.tracefiction.com";
const TRACE_WEB_ORIGIN = "https://www.tracefiction.com";
(() => {
  // <define:__TRACE_IOS_EARNED_PERMISSION_CONFIG__>
  var define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default = { version: 4, registrationMode: "dynamic", origins: ["https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*", "https://www.fanfiction.net/*", "https://m.fanfiction.net/*"], registrations: [{ id: "trace-archive-automation-v1", matches: ["https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*", "https://www.fanfiction.net/*", "https://m.fanfiction.net/*"], js: ["content-config.js", "trace-finish-qualify.js", "collector.js", "library-overlay-keys.js", "library-overlay.js"], runAt: "document_end", persistAcrossSessions: true, excludeMatches: ["https://archiveofourown.org/users/login*", "https://*.archiveofourown.org/users/login*", "https://archiveofourown.org/users/sign_up*", "https://*.archiveofourown.org/users/sign_up*", "https://archiveofourown.org/users/password*", "https://*.archiveofourown.org/users/password*", "https://archiveofourown.org/users/auth/*", "https://*.archiveofourown.org/users/auth/*", "https://archiveofourown.org/users/logout*", "https://*.archiveofourown.org/users/logout*", "https://archiveofourown.gay/users/login*", "https://*.archiveofourown.gay/users/login*", "https://archiveofourown.gay/users/sign_up*", "https://*.archiveofourown.gay/users/sign_up*", "https://archiveofourown.gay/users/password*", "https://*.archiveofourown.gay/users/password*", "https://archiveofourown.gay/users/auth/*", "https://*.archiveofourown.gay/users/auth/*", "https://archiveofourown.gay/users/logout*", "https://*.archiveofourown.gay/users/logout*", "https://archive.transformativeworks.org/users/login*", "https://archive.transformativeworks.org/users/sign_up*", "https://archive.transformativeworks.org/users/password*", "https://archive.transformativeworks.org/users/auth/*", "https://archive.transformativeworks.org/users/logout*", "https://ao3.org/users/login*", "https://*.ao3.org/users/login*", "https://ao3.org/users/sign_up*", "https://*.ao3.org/users/sign_up*", "https://ao3.org/users/password*", "https://*.ao3.org/users/password*", "https://ao3.org/users/auth/*", "https://*.ao3.org/users/auth/*", "https://ao3.org/users/logout*", "https://*.ao3.org/users/logout*", "https://www.fanfiction.net/login.php*", "https://www.fanfiction.net/signup.php*", "https://www.fanfiction.net/account/login*", "https://www.fanfiction.net/account/signup*", "https://www.fanfiction.net/auth/*", "https://m.fanfiction.net/login.php*", "https://m.fanfiction.net/signup.php*", "https://m.fanfiction.net/account/login*", "https://m.fanfiction.net/account/signup*", "https://m.fanfiction.net/auth/*"] }, { id: "trace-ao3-saved-filters-v1", matches: ["https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*"], js: ["ao3-saved-filters.js"], runAt: "document_end", persistAcrossSessions: true, excludeMatches: ["https://archiveofourown.org/users/login*", "https://*.archiveofourown.org/users/login*", "https://archiveofourown.org/users/sign_up*", "https://*.archiveofourown.org/users/sign_up*", "https://archiveofourown.org/users/password*", "https://*.archiveofourown.org/users/password*", "https://archiveofourown.org/users/auth/*", "https://*.archiveofourown.org/users/auth/*", "https://archiveofourown.org/users/logout*", "https://*.archiveofourown.org/users/logout*", "https://archiveofourown.gay/users/login*", "https://*.archiveofourown.gay/users/login*", "https://archiveofourown.gay/users/sign_up*", "https://*.archiveofourown.gay/users/sign_up*", "https://archiveofourown.gay/users/password*", "https://*.archiveofourown.gay/users/password*", "https://archiveofourown.gay/users/auth/*", "https://*.archiveofourown.gay/users/auth/*", "https://archiveofourown.gay/users/logout*", "https://*.archiveofourown.gay/users/logout*", "https://archive.transformativeworks.org/users/login*", "https://archive.transformativeworks.org/users/sign_up*", "https://archive.transformativeworks.org/users/password*", "https://archive.transformativeworks.org/users/auth/*", "https://archive.transformativeworks.org/users/logout*", "https://ao3.org/users/login*", "https://*.ao3.org/users/login*", "https://ao3.org/users/sign_up*", "https://*.ao3.org/users/sign_up*", "https://ao3.org/users/password*", "https://*.ao3.org/users/password*", "https://ao3.org/users/auth/*", "https://*.ao3.org/users/auth/*", "https://ao3.org/users/logout*", "https://*.ao3.org/users/logout*"] }], optionalRegistrations: [{ id: "trace-story-open-veil-v1", matches: ["https://*.archiveofourown.org/*", "https://*.archiveofourown.gay/*", "https://archive.transformativeworks.org/*", "https://www.fanfiction.net/*", "https://m.fanfiction.net/*"], js: ["trace-open-veil.js"], runAt: "document_start", persistAcrossSessions: true, excludeMatches: ["https://archiveofourown.org/users/login*", "https://*.archiveofourown.org/users/login*", "https://archiveofourown.org/users/sign_up*", "https://*.archiveofourown.org/users/sign_up*", "https://archiveofourown.org/users/password*", "https://*.archiveofourown.org/users/password*", "https://archiveofourown.org/users/auth/*", "https://*.archiveofourown.org/users/auth/*", "https://archiveofourown.org/users/logout*", "https://*.archiveofourown.org/users/logout*", "https://archiveofourown.gay/users/login*", "https://*.archiveofourown.gay/users/login*", "https://archiveofourown.gay/users/sign_up*", "https://*.archiveofourown.gay/users/sign_up*", "https://archiveofourown.gay/users/password*", "https://*.archiveofourown.gay/users/password*", "https://archiveofourown.gay/users/auth/*", "https://*.archiveofourown.gay/users/auth/*", "https://archiveofourown.gay/users/logout*", "https://*.archiveofourown.gay/users/logout*", "https://archive.transformativeworks.org/users/login*", "https://archive.transformativeworks.org/users/sign_up*", "https://archive.transformativeworks.org/users/password*", "https://archive.transformativeworks.org/users/auth/*", "https://archive.transformativeworks.org/users/logout*", "https://ao3.org/users/login*", "https://*.ao3.org/users/login*", "https://ao3.org/users/sign_up*", "https://*.ao3.org/users/sign_up*", "https://ao3.org/users/password*", "https://*.ao3.org/users/password*", "https://ao3.org/users/auth/*", "https://*.ao3.org/users/auth/*", "https://ao3.org/users/logout*", "https://*.ao3.org/users/logout*", "https://www.fanfiction.net/login.php*", "https://www.fanfiction.net/signup.php*", "https://www.fanfiction.net/account/login*", "https://www.fanfiction.net/account/signup*", "https://www.fanfiction.net/auth/*", "https://m.fanfiction.net/login.php*", "https://m.fanfiction.net/signup.php*", "https://m.fanfiction.net/account/login*", "https://m.fanfiction.net/account/signup*", "https://m.fanfiction.net/auth/*"] }] };

  // src/extension-runtime/browser-platform.mts
  var BrowserStorage = class {
    #area;
    #runtime;
    #mode;
    constructor(area, runtime, mode) {
      this.#area = area;
      this.#runtime = runtime;
      this.#mode = mode;
    }
    get(keys) {
      return this.#call("get", [keys]);
    }
    set(patch) {
      return this.#call("set", [patch]);
    }
    remove(keys) {
      return this.#call("remove", [keys]);
    }
    #call(method, args) {
      if (this.#mode === "promise") {
        try {
          return Promise.resolve(this.#area[method](...args));
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return new Promise((resolve, reject) => {
        try {
          this.#area[method](...args, (value) => {
            const message = this.#runtime.lastError?.message;
            if (message) reject(new Error(message));
            else resolve(value);
          });
        } catch (error) {
          reject(error);
        }
      });
    }
  };
  function extensionCall(target, method, args, runtime, mode) {
    if (mode === "promise") {
      try {
        return Promise.resolve(target[method](...args));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      try {
        target[method](...args, (value) => {
          const message = runtime.lastError?.message;
          if (message) reject(new Error(message));
          else resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  function declaresHostPattern(runtime, pattern) {
    const manifest = runtime.getManifest?.();
    if (!manifest) return true;
    return (manifest.host_permissions ?? []).includes(pattern);
  }

  // src/extension-runtime/activity-fetch.mts
  function activityHeaders(runtime, os, userAgent) {
    const scheme = String(runtime.getURL?.("") ?? "");
    if (!/^(chrome|safari-web)-extension:/.test(scheme)) return {};
    const ios = os === "ios" || /iPhone|iPad|iPod/i.test(userAgent);
    const mobile = ios || os === "android" || /Android/i.test(userAgent);
    const headers = {
      "X-Trace-Platform": mobile ? "web_mobile" : "web_desktop"
    };
    const browser = scheme.startsWith("moz-extension:") ? "firefox" : scheme.startsWith("chrome-extension:") ? /Edg\//.test(userAgent) ? "edge" : "chrome" : scheme.startsWith("safari-web-extension:") ? ios ? "safari_ios" : os === "mac" ? "safari_macos" : null : null;
    if (browser) headers["X-Trace-Extension-Browser"] = browser;
    const version = runtime.getManifest?.().version;
    if (typeof version === "string" && /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/.test(version))
      headers["X-Trace-Extension-Version"] = version;
    return headers;
  }
  function createActivityFetch(fetchImpl, runtime, mode, apiBase, storage) {
    const apiOrigin = new URL(apiBase).origin;
    const cacheKey = `traceActivityCorsV1:${apiOrigin}`;
    const ttl = 60 * 6e4;
    let acceptedUntil = 0;
    let loaded = false;
    let probe;
    const remember = (until) => optionalCache(() => storage?.set({ [cacheKey]: until }));
    const accepts = (url, headers, credentials) => {
      if (acceptedUntil > Date.now()) return Promise.resolve(true);
      return probe ??= (async () => {
        if (!loaded) {
          loaded = true;
          const snapshot = await optionalCache(() => storage?.get(cacheKey));
          const until = snapshot?.[cacheKey];
          if (typeof until === "number" && until > Date.now() && until <= Date.now() + ttl) acceptedUntil = until;
        }
        if (acceptedUntil > Date.now()) return true;
        const allowed = await acceptsActivityHeaders(
          fetchImpl,
          url,
          headers,
          credentials
        );
        if (allowed) {
          acceptedUntil = Date.now() + ttl;
          await remember(acceptedUntil);
        } else metadataDisabled = true;
        return allowed;
      })().finally(() => {
        probe = void 0;
      });
    };
    const invalidate = async () => {
      acceptedUntil = 0;
      await remember(0);
    };
    let metadataDisabled = false;
    let dimensions;
    const metadata = () => dimensions ??= (async () => {
      try {
        if (!/^(chrome|safari-web)-extension:/.test(
          String(runtime.getURL?.("") ?? "")
        ))
          return {};
      } catch {
        return {};
      }
      let os = "unknown";
      let timer;
      try {
        if (runtime.getPlatformInfo) {
          const info = await Promise.race([
            extensionCall(
              runtime,
              "getPlatformInfo",
              [],
              runtime,
              mode
            ),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), 250);
            })
          ]);
          os = info?.os ?? "unknown";
        }
      } catch {
      } finally {
        if (timer) clearTimeout(timer);
      }
      try {
        return activityHeaders(
          runtime,
          os,
          globalThis.navigator?.userAgent ?? ""
        );
      } catch {
        return {};
      }
    })();
    return async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      );
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : void 0)
      );
      if (url.origin === apiOrigin && url.pathname.startsWith("/api/extension/") && headers.has("Authorization")) {
        for (const name of ACTIVITY_HEADERS) headers.delete(name);
        const baseline = new Headers(headers);
        const extra = metadataDisabled ? {} : await metadata();
        if (Object.keys(extra).length) {
          for (const [name, value] of Object.entries(extra))
            headers.set(name, value);
          const signal = init?.signal ?? (input instanceof Request ? input.signal : void 0);
          const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : void 0);
          signal?.throwIfAborted();
          const allowed = await accepts(url.href, headers, credentials);
          signal?.throwIfAborted();
          if (!allowed) {
            metadataDisabled = true;
            return fetchImpl(input, { ...init, headers: baseline });
          }
        }
        try {
          const response = await fetchImpl(input, { ...init, headers });
          if (Object.keys(extra).length && !response.ok) await invalidate();
          return response;
        } catch (error) {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : void 0);
          if (Object.keys(extra).length && !signal?.aborted) await invalidate();
          throw error;
        }
      }
      return fetchImpl(input, init);
    };
  }
  var ACTIVITY_HEADERS = [
    "X-Trace-Platform",
    "X-Trace-App-Version",
    "X-Trace-Extension-Browser",
    "X-Trace-Extension-Version"
  ];
  async function acceptsActivityHeaders(send, url, headers, credentials) {
    const controller = new AbortController();
    let timer;
    try {
      const allowed = await Promise.race([
        send(url, {
          method: "OPTIONS",
          headers,
          mode: "cors",
          redirect: "error",
          ...credentials ? { credentials } : {},
          signal: controller.signal
        }).then(
          (response) => response.ok,
          () => false
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, 1e3);
        })
      ]);
      return allowed;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function optionalCache(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation).catch(() => void 0),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 250);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // src/extension-runtime/archive-sender.mts
  function isInactiveSender(sender) {
    if (typeof sender?.frameId === "number" && sender.frameId !== 0) return true;
    const lifecycle = typeof sender?.documentLifecycle === "string" ? sender.documentLifecycle.toLowerCase() : "";
    return lifecycle === "prerender" || lifecycle === "pending_deletion";
  }
  function archiveHostKindFromSender(sender) {
    if (isInactiveSender(sender)) return null;
    const rawUrl = sender?.tab?.url ?? sender?.url;
    if (typeof rawUrl !== "string") return null;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      if (host === "archiveofourown.org" || host.endsWith(".archiveofourown.org") || host === "archiveofourown.gay" || host.endsWith(".archiveofourown.gay") || host === "archive.transformativeworks.org" || host === "ao3.org" || host.endsWith(".ao3.org")) {
        return "ao3";
      }
      if (host === "www.fanfiction.net" || host === "m.fanfiction.net") {
        return "ffn";
      }
    } catch {
    }
    return null;
  }
  function isStorySitePattern(pattern) {
    const match = /^https:\/\/(?:\*\.)?([^/*]+)\/\*$/.exec(pattern);
    return match !== null && archiveHostKindFromSender({ url: `https://${match[1]}/` }) !== null;
  }
  function isBlockedArchivePath(rawUrl, hostKind2) {
    if (typeof rawUrl !== "string") return true;
    try {
      const pathname = new URL(rawUrl).pathname;
      return hostKind2 === "ao3" ? /^\/users\/(?:login|sign_up|password|auth\/|logout)/i.test(pathname) : /^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(pathname);
    } catch {
      return true;
    }
  }
  var AO3_COLLECTION_PREFIX = /^\/collections\/[A-Za-z0-9_]{1,255}(?=\/works\/)/;
  function ao3WorkPath(pathname) {
    return pathname.replace(AO3_COLLECTION_PREFIX, "");
  }
  function workKeyFromArchiveUrl(rawUrl, expectedHost) {
    if (typeof rawUrl !== "string" || rawUrl.length > 4096) return null;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      if (expectedHost === "ao3") {
        const supported = host === "archiveofourown.org" || host.endsWith(".archiveofourown.org") || host === "archiveofourown.gay" || host.endsWith(".archiveofourown.gay") || host === "archive.transformativeworks.org" || host === "ao3.org" || host.endsWith(".ao3.org");
        if (!supported) return null;
        const match2 = ao3WorkPath(url.pathname).match(/^\/works\/([1-9][0-9]{0,19})(?:\/|$)/);
        return match2?.[1] ? `ao3:${match2[1]}` : null;
      }
      if (host !== "www.fanfiction.net" && host !== "m.fanfiction.net") return null;
      const match = url.pathname.match(/^\/s\/([1-9][0-9]{0,19})(?:\/|$)/);
      return match?.[1] ? `ffn:${match[1]}` : null;
    } catch {
      return null;
    }
  }
  function sourceMatchesArchiveHost(source, hostKind2) {
    if (typeof source !== "string") return false;
    const normalized = source.trim().toLowerCase();
    return hostKind2 === "ao3" ? normalized === "ao3" || normalized === "archiveofourown.org" || normalized === "archiveofourown.gay" || normalized === "archive.transformativeworks.org" : normalized === "ffn" || normalized === "fanfiction.net";
  }

  // src/extension-runtime/archive-host-access.mts
  function declaredArchiveAccess(runtime) {
    const origins = [...new Set(runtime.getManifest?.().host_permissions ?? [])];
    return origins.length ? [{ site: "all", label: "AO3 and FanFiction.net", origins }] : [];
  }
  function installArchiveHostAccess(environment) {
    const { runtime, tabs, action, permissions, mode, recover } = environment;
    const root = runtime.getURL?.("");
    if (typeof root !== "string" || !/^(?:moz|chrome)-extension:\/\//.test(root) || !permissions?.contains) return null;
    const sites = declaredArchiveAccess(runtime);
    const defaultTitle = runtime.getManifest?.().action?.default_title ?? "Trace";
    const call = (target, method, args) => extensionCall(target, method, args, runtime, mode);
    const isPopup = (sender) => sender.id === runtime.id && !sender.tab && sender.url === runtime.getURL?.("popup.html");
    const archiveSite = (sender) => {
      if (sender.id !== runtime.id || !Number.isInteger(sender.tab?.id)) return null;
      const site = archiveHostKindFromSender(sender);
      const raw = sender.tab?.url ?? sender.url;
      if (!site || !raw || isBlockedArchivePath(raw, site)) return null;
      const host = new URL(raw).hostname;
      return sites[0]?.origins.some((pattern) => {
        const match = /^https:\/\/(\*\.)?([^/]+)\//.exec(pattern);
        return match && (host === match[2] || match[1] && host.endsWith(`.${match[2]}`));
      }) ? site : null;
    };
    const read = async () => Promise.all(sites.map(async (access) => {
      try {
        return { ...access, granted: await call(permissions, "contains", [{ origins: access.origins }]) === true };
      } catch {
        return { ...access, granted: null };
      }
    }));
    let generation = 0;
    let badgeUpdate = Promise.resolve();
    const popups = /* @__PURE__ */ new Set();
    const refresh = async () => {
      const current = ++generation;
      const access = await read();
      if (current !== generation) return access;
      const missing = access.some((item) => item.granted === false);
      badgeUpdate = badgeUpdate.then(async () => {
        if (!action || current !== generation || !access.length) return;
        if (!missing && access.some((item) => item.granted === null)) return;
        const write = (method, details) => call(action, method, [details]).catch(() => void 0);
        if (missing) {
          await write("setBadgeBackgroundColor", { color: "#9B4146" });
          if (action.setBadgeTextColor) await write("setBadgeTextColor", { color: "#FFFFFF" });
        }
        if (current !== generation) return;
        await write("setBadgeText", { text: missing ? "!" : "" });
        await write("setTitle", { title: missing ? "Site access is off \u2014 click to allow" : defaultTitle });
      });
      await badgeUpdate;
      if (current === generation && runtime.sendMessage) {
        void call(runtime, "sendMessage", [{ type: "TRACE_ARCHIVE_HOST_ACCESS_CHANGED", access }]).catch(() => void 0);
      }
      if (current === generation) {
        try {
          const storySites = (sites[0]?.origins ?? []).filter(isStorySitePattern);
          const openTabs = storySites.length ? await call(tabs, "query", [{ url: storySites }]) : [];
          if (current === generation) await Promise.all(openTabs.map(async (tab) => {
            if (!archiveSite({ id: runtime.id, tab, frameId: 0 })) return;
            await call(tabs, "sendMessage", [tab.id, {
              type: "TRACE_ARCHIVE_HOST_ACCESS_CHANGED",
              granted: access[0]?.granted ?? null,
              popupOpen: popups.size > 0
            }, { frameId: 0 }]).catch(() => void 0);
          }));
        } catch {
        }
      }
      return access;
    };
    runtime.onMessage.addListener((raw, sender, respond) => {
      const type = raw?.type;
      if (type !== "TRACE_ARCHIVE_HOST_ACCESS_GET" && type !== "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") return;
      const popup = isPopup(sender);
      if (!popup && (!archiveSite(sender) || type !== "TRACE_ARCHIVE_HOST_ACCESS_GET")) {
        respond({ ok: false });
        return;
      }
      void refresh().then(async (access) => {
        if (type === "TRACE_ARCHIVE_HOST_ACCESS_REFRESH") await recover();
        return popup ? { ok: true, access } : { ok: true, granted: access[0]?.granted ?? null, popupOpen: popups.size > 0 };
      }).then(respond, () => respond({ ok: false }));
      return true;
    });
    runtime.onConnect?.addListener((port) => {
      if (port.name !== "trace-archive-access-popup" || !port.sender || !isPopup(port.sender) || port.sender.frameId !== void 0 && port.sender.frameId !== 0) return;
      popups.add(port);
      void refresh();
      port.onDisconnect.addListener(() => {
        popups.delete(port);
        void refresh();
      });
    });
    runtime.onInstalled?.addListener((details) => {
      if (details.reason === "install" || details.reason === "update") void refresh();
    });
    runtime.onStartup?.addListener(() => {
      void refresh();
    });
    permissions.onAdded?.addListener(() => {
      void refresh().then(recover).catch(() => void 0);
    });
    permissions.onRemoved?.addListener(() => {
      void refresh();
    });
    void refresh();
    return refresh;
  }

  // src/extension-runtime/archive-recovery.mts
  function matches(pattern, url) {
    const match = /^https:\/\/(\*\.)?([^/]+)(\/.*)$/.exec(pattern);
    if (!match || url.protocol !== "https:") return false;
    if (url.hostname !== match[2] && !(match[1] && url.hostname.endsWith(`.${match[2]}`))) return false;
    const path = match[3].split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${path}$`).test(url.pathname + url.search);
  }
  function installArchiveRecovery(environment) {
    const { runtime, tabs, permissions, scripting, mode, registered } = environment;
    const call = (target, method, args) => extensionCall(target, method, args, runtime, mode);
    let pending = null;
    const recover = () => {
      if (pending) return pending;
      pending = (async () => {
        if (!scripting?.executeScript || !permissions?.contains) return;
        let scripts;
        if (registered) {
          if (!registered.origins.length || await call(permissions, "contains", [{ origins: [...registered.origins] }]) !== true) return;
          scripts = registered.registrations.map(({ matches: matches2, js, excludeMatches }) => ({
            matches: matches2,
            js,
            ...excludeMatches === void 0 ? {} : { exclude_matches: excludeMatches }
          }));
        } else {
          if (!runtime.getManifest) return;
          scripts = runtime.getManifest().content_scripts ?? [];
        }
        const storySites = [...new Set(scripts.flatMap((script) => script.matches ?? []))].filter(isStorySitePattern);
        if (!storySites.length) return;
        const openTabs = await call(tabs, "query", [{ url: storySites }]);
        await Promise.all(openTabs.map(async (tab) => {
          try {
            if (!Number.isInteger(tab.id) || !tab.url) return;
            const host = archiveHostKindFromSender({ url: tab.url });
            if (!host || isBlockedArchivePath(tab.url, host)) return;
            const url = new URL(tab.url);
            const files = scripts.filter((script) => script.matches?.some((pattern) => matches(pattern, url)) && !script.exclude_matches?.some((pattern) => matches(pattern, url))).flatMap((script) => script.js ?? []);
            if (!files.length || !await call(permissions, "contains", [{ origins: [`${url.origin}/*`] }])) return;
            await call(scripting, "executeScript", [{ target: { tabId: tab.id, frameIds: [0] }, files: [...new Set(files)] }]);
          } catch {
          }
        }));
      })().catch(() => void 0).finally(() => {
        pending = null;
      });
      return pending;
    };
    runtime.onInstalled?.addListener((details) => {
      if (details.reason === "install" || details.reason === "update") void recover();
    });
    runtime.onStartup?.addListener(() => {
      void recover();
    });
    void recover();
    return recover;
  }

  // src/extension-runtime/open-story-tabs.mts
  var LIMIT = 250;
  var pendingReads = /* @__PURE__ */ new WeakMap();
  function openStoryIdentity(raw) {
    if (typeof raw !== "string" || raw.length > 4096) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
      const ao3 = /^(?:[^.]+\.)*(?:archiveofourown\.(?:org|gay)|ao3\.org)$/.test(url.hostname) || url.hostname === "archive.transformativeworks.org";
      const ffn = ["www.fanfiction.net", "m.fanfiction.net"].includes(url.hostname);
      const path = url.pathname.replace(/^\/collections\/[^/]+(?=\/works\/)/, "");
      const match = path.match(ao3 ? /^\/works\/([1-9]\d{0,19})(?:\/chapters\/[1-9]\d{0,19})?\/?$/ : /^\/s\/([1-9]\d{0,19})(?:\/[1-9]\d{0,9})?(?:\/[^/]*)?\/?$/);
      return (ao3 || ffn) && match ? `${ao3 ? "ao3" : "ffn"}:${match[1]}` : null;
    } catch {
      return null;
    }
  }
  function readOpenStory(expectedKey, deadline) {
    if (Date.now() >= deadline) return null;
    const host = location.hostname;
    const ao3 = /^(?:[^.]+\.)*(?:archiveofourown\.(?:org|gay)|ao3\.org)$/.test(host) || host === "archive.transformativeworks.org";
    const ffn = ["www.fanfiction.net", "m.fanfiction.net"].includes(host);
    const path = location.pathname.replace(/^\/collections\/[^/]+(?=\/works\/)/, "");
    const match = path.match(ao3 ? /^\/works\/([1-9]\d{0,19})(?:\/chapters\/[1-9]\d{0,19})?\/?$/ : /^\/s\/([1-9]\d{0,19})(?:\/[1-9]\d{0,9})?(?:\/[^/]*)?\/?$/);
    if (location.protocol !== "https:" || location.port || !ao3 && !ffn || !match || `${ao3 ? "ao3" : "ffn"}:${match[1]}` !== expectedKey) return null;
    for (const input of Array.from(document.querySelectorAll('input[type="password"]'))) {
      const form = input.closest("form");
      let knownHeader = false;
      if (ao3 && form?.id === "new_user_session_small" && form.closest("#header")) {
        try {
          const action = new URL(form.getAttribute("action") ?? "", location.href);
          knownHeader = action.origin === location.origin && action.pathname === "/users/login";
        } catch {
        }
      }
      if (!knownHeader) return null;
    }
    const text2 = (selector, maximum = 512) => {
      const node = Array.from(document.querySelectorAll(selector)).find((node2) => !node2.closest("#storytext, .storytext, #storycontent, .storycontent, .chapter .userstuff"));
      return (node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
    };
    const integer = (value) => {
      if (!value.trim()) return null;
      const number = Number(value.replace(/,/g, ""));
      return Number.isSafeInteger(number) && number >= 0 && number <= 1e7 ? number : null;
    };
    let mobileStats = "", mobileChapter = "";
    if (host === "m.fanfiction.net") {
      let rules = 0, visited = 0;
      for (const node of document.querySelector("#content")?.childNodes ?? []) {
        if (++visited > 80) break;
        if (rules === 2 && node.nodeType === 1 && node.tagName === "BR") break;
        if (node.nodeType === 1 && node.tagName === "HR") {
          if (++rules > 2) break;
        } else if (node.nodeType === 3) {
          if (rules === 1) mobileStats += (node.textContent ?? "").slice(0, 2048 - mobileStats.length);
          if (rules === 2) mobileChapter += (node.textContent ?? "").slice(0, 512 - mobileChapter.length);
        }
      }
    }
    const author = ao3 ? text2('h3.byline a[rel="author"]') : text2('#profile_top a[href*="/u/"], #content a[href*="/u/"]');
    const mobileTitle = host === "m.fanfiction.net" && author ? document.title.replace(/\s*[-|]\s*FanFiction(?:\.net)?\s*$/i, "").replace(/^Fanfic:\s*/i, "").replace(/\s+Ch\s+\d+,.*$/i, "").trim().slice(0, 512) : "";
    const title = ao3 ? text2("#workskin h2.title, h2.title.heading") : text2("#profile_top b.xcontrast_txt, #content b.xcontrast_txt") || (host === "m.fanfiction.net" ? text2('#content > div[align="center"] > b') : "") || mobileTitle;
    const stats = ao3 ? text2("dl.work.meta.group dd.words, dl.meta.group dd.words") : text2("#profile_top .xgray, #content .gray, #content .xgray", 2048) || mobileStats;
    const wordCount = stats.match(/Words:\s*([\d,]+(?:\.\d+)?)\s*([km])?\+?(?=\s|,|$)/i);
    const wordUnit = wordCount?.[2]?.toLowerCase();
    const words = ao3 ? integer(stats) : wordCount ? integer(String(Number(wordCount[1].replace(/,/g, "")) * (wordUnit === "k" ? 1e3 : wordUnit === "m" ? 1e6 : 1))) : null;
    const chapterText = ao3 ? text2("dl.work.meta.group dd.chapters, dl.meta.group dd.chapters") : "";
    const published = integer(ao3 ? chapterText.match(/^([\d,]+)\s*\//)?.[1] ?? "NaN" : stats.match(/Chapters:\s*([\d,]+)/i)?.[1] ?? "NaN");
    const planned = ao3 ? chapterText.match(/\/\s*([\d,]+|\?)/)?.[1] : void 0;
    const complete = ao3 ? published !== null && planned !== void 0 && planned !== "?" && published === integer(planned) : /Status:\s*Complete\b/i.test(stats);
    const chapter = integer(ao3 ? text2("#selected_id option:checked, #chapter_index option:checked, .chapter h3.title").match(/(?:Chapter\s+)?(\d+)/i)?.[1] ?? "NaN" : text2("#chap_select option:checked, select[name=chapter] option:checked").match(/^(\d+)/)?.[1] ?? mobileChapter.match(/^\s*Chapter\s+(\d+)\s*:/i)?.[1] ?? "NaN");
    if (!title || !author && words === null && published === null) return null;
    return {
      src: ao3 ? "ao3" : "ffn",
      ctx: "tab",
      key: expectedKey,
      u: ao3 ? `https://archiveofourown.org/works/${match[1]}` : `https://www.fanfiction.net/s/${match[1]}/`,
      chu: location.origin + location.pathname,
      t: title,
      a: author || void 0,
      w: words ?? void 0,
      chPub: published ?? void 0,
      cht: ao3 ? planned === "?" ? "?" : planned ? integer(planned) ?? void 0 : void 0 : complete ? published ?? void 0 : void 0,
      chn: chapter && chapter > 0 ? chapter : void 0,
      s: complete ? "complete" : ao3 && planned || /Status:\s*In-Progress/i.test(stats) ? "wip" : void 0
    };
  }
  async function bounded(operation, milliseconds) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      })]);
    } catch {
      return null;
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  async function collectOpenStoryTabs(ports) {
    if (!ports.scripting?.executeScript) return null;
    const deadline = Date.now() + 15e3;
    const call = (target, method, args) => extensionCall(
      target,
      method,
      args,
      ports.runtime,
      ports.mode
    );
    const grants = ports.permissions ? await bounded(call(ports.permissions, "getAll", []), 2e3) : null;
    const storySites = (grants?.origins ?? []).filter(isStorySitePattern);
    const [granted, active] = await Promise.all([
      storySites.length ? bounded(call(ports.tabs, "query", [{ url: storySites }]), 2e3) : null,
      bounded(call(ports.tabs, "query", [{ active: true, currentWindow: true }]), 2e3)
    ]);
    if (!Array.isArray(granted) && !Array.isArray(active)) return null;
    const seenTabs = /* @__PURE__ */ new Set();
    const candidates = [...Array.isArray(active) ? active : [], ...Array.isArray(granted) ? granted : []].filter((tab) => {
      if (tab.incognito === true || typeof tab.id !== "number" || !openStoryIdentity(tab.url) || seenTabs.has(tab.id)) return false;
      seenTabs.add(tab.id);
      return true;
    });
    const selected = candidates.slice(0, LIMIT);
    let pending = pendingReads.get(ports.scripting);
    if (!pending) {
      pending = /* @__PURE__ */ new Set();
      pendingReads.set(ports.scripting, pending);
    }
    const reads = pending;
    const captured = Array(selected.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length && Date.now() < deadline) {
        if (reads.size >= 4) {
          await bounded(Promise.race(reads), deadline - Date.now());
          continue;
        }
        const index = next++, tab = selected[index];
        if (tab.discarded === true) continue;
        const key = openStoryIdentity(tab.url);
        const readDeadline = Math.min(deadline, Date.now() + 2e3);
        const operation = extensionCall(
          ports.scripting,
          "executeScript",
          [{ target: { tabId: tab.id }, func: readOpenStory, args: [key, readDeadline] }],
          ports.runtime,
          ports.mode
        ).catch(() => null);
        reads.add(operation);
        void operation.then(() => reads.delete(operation));
        const results = await bounded(operation, readDeadline - Date.now());
        if (Date.now() >= readDeadline) continue;
        const result = Array.isArray(results) ? results.find((frame) => frame.frameId === 0)?.result : null;
        if (result && result.key === key && openStoryIdentity(result.u) === key && typeof result.t === "string" && result.t.trim()) {
          captured[index] = result;
        }
      }
    }));
    const items = [];
    const unreadableTabs = [];
    const seen = /* @__PURE__ */ new Set();
    let unreadable = 0, duplicates = 0;
    for (const [index, item] of captured.entries()) {
      if (!item) {
        unreadable++;
        const tab = selected[index];
        const url = new URL(tab.url);
        const [site, work] = openStoryIdentity(tab.url).split(":");
        const path = url.origin + url.pathname;
        const u = path.length <= 2048 ? path : site === "ao3" ? `https://archiveofourown.org/works/${work}` : `https://www.fanfiction.net/s/${work}/`;
        const t = typeof tab.title === "string" ? tab.title.replace(/\s+/g, " ").trim().slice(0, 512) : "";
        unreadableTabs.push({ u, t });
      } else if (seen.has(item.key)) duplicates++;
      else {
        seen.add(item.key);
        items.push(item);
      }
    }
    return {
      s: "tabs",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      items,
      unreadableTabs,
      scan: { considered: selected.length, unreadable, duplicates, limited: Math.max(0, candidates.length - LIMIT) }
    };
  }
  function encodeOpenStoryTabs(payload) {
    if (payload.items.length === 0 && !payload.unreadableTabs?.length) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.length > 512 * 1024) return null;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  // src/extension-runtime/private-database.mts
  var PRIVATE_DATABASE_NAME = "traceKernelPrivateV1";
  var PRIVATE_DATABASE_VERSION = 1;
  var PRIVATE_RECORD_STORE = "records";
  var PRIVATE_RECORD_KEYS = Object.freeze({
    browserInstallationId: "browser-installation-id",
    sessionEnvelope: "session-envelope",
    sessionCredentials: "session-credentials",
    accountData: "account-data"
  });
  function databaseError(message, error = null) {
    const detail = error?.message?.trim();
    return new Error(detail ? `${message}: ${detail}` : message, { cause: error ?? void 0 });
  }
  var PRIVATE_DATABASE_OPEN_TIMEOUT_MS = 5e3;
  var PRIVATE_DATABASE_TRANSACTION_TIMEOUT_MS = 5e3;
  var ConnectionLost = class extends Error {
  };
  var BrowserPrivateRecordDatabase = class {
    #factory;
    #openTimeoutMs;
    #transactionTimeoutMs;
    #openPromise = null;
    /** The connection the cache holds once its open has answered. */
    #connection = null;
    constructor(factory, options = {}) {
      this.#factory = factory;
      this.#openTimeoutMs = options.openTimeoutMs ?? PRIVATE_DATABASE_OPEN_TIMEOUT_MS;
      this.#transactionTimeoutMs = options.transactionTimeoutMs ?? PRIVATE_DATABASE_TRANSACTION_TIMEOUT_MS;
    }
    get(key) {
      return this.#runTransaction("readonly", (store) => store.get(key), (request) => request.result === void 0 ? null : request.result);
    }
    put(key, value) {
      return this.#runTransaction("readwrite", (store) => store.put(value, key), () => void 0);
    }
    delete(key) {
      return this.#runTransaction("readwrite", (store) => store.delete(key), () => void 0);
    }
    async deleteDatabase() {
      const pending = this.#openPromise;
      this.#openPromise = null;
      this.#connection = null;
      if (pending !== null) {
        try {
          (await pending).close();
        } catch {
        }
      }
      await new Promise((resolve, reject) => {
        let settled = false;
        const request = this.#factory.deleteDatabase(PRIVATE_DATABASE_NAME);
        const finish = (result, error) => {
          if (settled) return;
          settled = true;
          if (result === "resolve") resolve();
          else reject(error);
        };
        request.onsuccess = () => finish("resolve");
        request.onerror = () => finish(
          "reject",
          databaseError("private database deletion failed", request.error)
        );
        request.onblocked = () => finish(
          "reject",
          databaseError("private database deletion blocked")
        );
      });
    }
    /**
     * One transaction. A connection that has stopped working is dropped and the
     * transaction is tried once more on a fresh one, so a lost connection never
     * fails every later read and write of this background. Each record is
     * written whole under its own key, so trying a write again is harmless.
     */
    async #runTransaction(mode, start, readResult) {
      const database = await this.#open();
      try {
        return await this.#runTransactionOn(database, mode, start, readResult);
      } catch (error) {
        if (!(error instanceof ConnectionLost)) throw error;
        this.#dropConnection(database);
        const fresh = await this.#open();
        try {
          return await this.#runTransactionOn(fresh, mode, start, readResult);
        } catch (retryError) {
          if (retryError instanceof ConnectionLost) this.#dropConnection(fresh);
          throw retryError;
        }
      }
    }
    /**
     * Closes a connection that failed. The cache is cleared only when it still
     * holds that connection, so requests that failed together open one new
     * connection between them, not one each.
     */
    #dropConnection(failed2) {
      if (this.#connection === failed2) {
        this.#connection = null;
        this.#openPromise = null;
      }
      try {
        failed2.close();
      } catch {
      }
    }
    #runTransactionOn(database, mode, start, readResult) {
      return new Promise((resolve, reject) => {
        let request;
        let result;
        let requestSucceeded = false;
        let settled = false;
        let transaction;
        try {
          transaction = database.transaction(PRIVATE_RECORD_STORE, mode);
        } catch (error) {
          reject(new ConnectionLost(
            databaseError("private database connection lost", error instanceof DOMException ? error : null).message
          ));
          return;
        }
        const timer = globalThis.setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            transaction.abort();
          } catch {
          }
          reject(new ConnectionLost("private database transaction timed out"));
        }, this.#transactionTimeoutMs);
        const finishReject = (message, error = null) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          reject(databaseError(message, error));
        };
        try {
          request = start(transaction.objectStore(PRIVATE_RECORD_STORE));
        } catch (error) {
          try {
            transaction.abort();
          } catch {
          }
          finishReject(
            "private database request failed",
            error instanceof DOMException ? error : null
          );
          return;
        }
        request.onsuccess = () => {
          try {
            result = readResult(request);
            requestSucceeded = true;
          } catch (error) {
            try {
              transaction.abort();
            } catch {
            }
            finishReject(
              "private database result invalid",
              error instanceof DOMException ? error : null
            );
          }
        };
        request.onerror = () => {
          const name = request.error?.name;
          if (name === "AbortError" || name === "UnknownError") return;
          finishReject("private database request failed", request.error);
        };
        transaction.onabort = () => {
          if (!settled && (transaction.error === null || transaction.error.name === "UnknownError")) {
            settled = true;
            globalThis.clearTimeout(timer);
            reject(new ConnectionLost(
              databaseError("private database connection lost", transaction.error).message
            ));
            return;
          }
          finishReject("private database transaction aborted", transaction.error);
        };
        transaction.onerror = () => {
        };
        transaction.oncomplete = () => {
          if (settled) return;
          if (!requestSucceeded) {
            finishReject("private database request completed without a result");
            return;
          }
          settled = true;
          globalThis.clearTimeout(timer);
          resolve(result);
        };
      });
    }
    #open() {
      if (this.#openPromise !== null) return this.#openPromise;
      const opening = new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finishReject = (message, error = null) => {
          if (settled) return;
          settled = true;
          if (timer !== null) globalThis.clearTimeout(timer);
          reject(databaseError(message, error));
        };
        let request;
        try {
          request = this.#factory.open(PRIVATE_DATABASE_NAME, PRIVATE_DATABASE_VERSION);
        } catch (error) {
          finishReject("private database open failed", error instanceof DOMException ? error : null);
          return;
        }
        timer = globalThis.setTimeout(
          () => finishReject("private database open timed out"),
          this.#openTimeoutMs
        );
        request.onupgradeneeded = (event) => {
          const database = request.result;
          if (event.oldVersion !== 0 || database.objectStoreNames.length !== 0) {
            request.transaction?.abort();
            return;
          }
          database.createObjectStore(PRIVATE_RECORD_STORE);
        };
        request.onerror = () => finishReject("private database open failed", request.error);
        request.onblocked = () => finishReject("private database open blocked");
        request.onsuccess = () => {
          const database = request.result;
          if (settled) {
            database.close();
            return;
          }
          if (database.version !== PRIVATE_DATABASE_VERSION || !database.objectStoreNames.contains(PRIVATE_RECORD_STORE) || database.objectStoreNames.length !== 1) {
            database.close();
            finishReject("private database schema invalid");
            return;
          }
          settled = true;
          if (timer !== null) globalThis.clearTimeout(timer);
          const forget = () => {
            if (this.#openPromise === cached) this.#openPromise = null;
            if (this.#connection === database) this.#connection = null;
          };
          database.onversionchange = () => {
            database.close();
            forget();
          };
          database.onclose = forget;
          if (this.#openPromise === cached) this.#connection = database;
          resolve(database);
        };
      });
      const cached = opening.catch((error) => {
        if (this.#openPromise === cached) this.#openPromise = null;
        throw error;
      });
      this.#openPromise = cached;
      return cached;
    }
  };

  // src/extension-runtime/browser-device-session.mts
  var DEVICE_TOKEN = /^trd_v1_[A-Za-z0-9_-]{43}$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var BrowserDeviceSessionProvider = class {
    constructor(options) {
      this.options = options;
    }
    #generation = 0;
    cancel() {
      this.#generation += 1;
      this.options.provider.cancel();
    }
    async acquire(purpose) {
      const generation = this.#generation;
      const native = await this.options.isNative();
      const grant = await this.options.provider.acquire(purpose);
      if (grant.kind !== "credential" || native) return grant;
      if (generation !== this.#generation) return { kind: "cancelled" };
      return this.#exchange(grant.credential, generation);
    }
    async upgrade(credential) {
      if (DEVICE_TOKEN.test(credential) || await this.options.isNative()) return credential;
      const result = await this.#exchange(credential, this.#generation);
      return result.kind === "credential" ? result.credential : credential;
    }
    async release(credential) {
      if (!DEVICE_TOKEN.test(credential) || await this.options.isNative()) return;
      try {
        await this.options.fetch(`${this.options.apiBase}/api/extension/session`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${credential}` },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(1e4)
        });
      } catch {
      }
    }
    async #exchange(accessToken, generation) {
      try {
        let installationId = await this.options.database.get(PRIVATE_RECORD_KEYS.browserInstallationId);
        if (typeof installationId !== "string" || !UUID.test(installationId)) {
          installationId = crypto.randomUUID();
          await this.options.database.put(PRIVATE_RECORD_KEYS.browserInstallationId, installationId);
        }
        if (generation !== this.#generation) return { kind: "cancelled" };
        const response = await this.options.fetch(`${this.options.apiBase}/api/extension/device-sessions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ installationId, platform: "browser", ...this.options.clientVersion ? { clientVersion: this.options.clientVersion } : {} }),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(1e4)
        });
        if (!response.ok) return { kind: "unavailable" };
        const body = await response.json();
        if (body?.status !== "issued" || typeof body.credential !== "string" || !DEVICE_TOKEN.test(body.credential)) return { kind: "unavailable" };
        if (generation !== this.#generation || body.session?.installationId !== installationId || typeof body.session?.id !== "string" || !UUID.test(body.session.id) || typeof body.session?.absoluteExpiresAt !== "string" || !(Date.parse(body.session.absoluteExpiresAt) > Date.now())) {
          void this.release(body.credential);
          return { kind: generation !== this.#generation ? "cancelled" : "unavailable" };
        }
        return { kind: "credential", credential: body.credential };
      } catch {
        return { kind: "unavailable" };
      }
    }
  };

  // src/extension-core/archive-readiness.mts
  var ARCHIVE_RUN_THROTTLE_MS = 5 * 60 * 1e3;
  var ARCHIVE_ACCESS_CONFIRM_DELAY_MS = 2e3;
  var ARCHIVE_ACCESS_REPEAT_AFTER_MS = 5 * 60 * 1e3;
  var ARCHIVE_ACCESS_RETRY_DELAYS_MS = Object.freeze([
    6e4,
    5 * 6e4,
    30 * 6e4
  ]);
  var ARCHIVE_ACCESS_REPORT_MAX_PASSES = 3;
  function accessFingerprint(complete, origins) {
    let hash = 2166136261;
    for (const character of [...origins].sort().join(" ")) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${complete ? "complete" : "incomplete"}:${origins.length}:${hash.toString(16)}`;
  }
  var SYSTEM_CLOCK = Object.freeze({
    now: () => Date.now()
  });
  var ArchiveReadinessService = class {
    #receipts;
    #permissions;
    #clock;
    #lastRunAttemptByHost = /* @__PURE__ */ new Map();
    #requiredOrigins;
    #wait;
    #ledger;
    #settled;
    #accessReport = null;
    #accessReportRequestedAgain = false;
    #accessReportReaderPresent = false;
    constructor(options) {
      this.#receipts = options.receipts;
      this.#permissions = options.permissions;
      this.#clock = options.clock ?? SYSTEM_CLOCK;
      this.#requiredOrigins = Object.freeze([...options.requiredOrigins ?? []]);
      this.#settled = options.settled;
      this.#wait = options.wait ?? ((ms) => new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
      let remembered = Object.freeze({ grantSeen: false });
      this.#ledger = options.accessLedger ?? {
        read: async () => remembered,
        write: async (ledger) => {
          remembered = ledger;
        }
      };
    }
    async recordRun(input) {
      const at = this.#clock.now();
      const lastAttempt = this.#lastRunAttemptByHost.get(input.hostKind);
      if (input.handoffId === void 0 && lastAttempt !== void 0 && at - lastAttempt < ARCHIVE_RUN_THROTTLE_MS) {
        return { kind: "throttled" };
      }
      this.#lastRunAttemptByHost.set(input.hostKind, at);
      const receipt = Object.freeze({
        hostKind: input.hostKind,
        at,
        ...input.handoffId === void 0 ? {} : { handoffId: input.handoffId }
      });
      let published = false;
      try {
        published = await this.#receipts.publishRunReceipt(receipt);
      } catch {
        published = false;
      }
      if (!published) {
        if (this.#lastRunAttemptByHost.get(input.hostKind) === at) {
          this.#lastRunAttemptByHost.delete(input.hostKind);
        }
        return { kind: "unavailable" };
      }
      void this.#publishPermissionSnapshot(input.hostKind);
      return { kind: "published" };
    }
    /**
     * Publishes what access is granted right now, on its own rather than
     * after a run. A run can only ever prove access; this is the reading that
     * can show access has ended (for example, a one-day grant running out),
     * because no page script runs to say so.
     *
     * It must not raise a false alarm. Access is reported missing only when
     * this install has held the grant before, two readings in a row say it is
     * gone, and the list of what is granted came with them. An install that
     * has never held the grant has nothing to lose, so it sends nothing. When
     * the required origins are confirmed they are listed by name, since a
     * broader grant need not spell them out.
     *
     * It is also quiet: a reading equal to the last one delivered is not sent
     * again within a few minutes, and a failed delivery is left alone for
     * longer after each failure in a row. `readerPresent` (the popup is open)
     * skips that wait: the reader is here and the app is very likely reachable.
     */
    reportAccess(options = {}) {
      if (options.readerPresent === true) this.#accessReportReaderPresent = true;
      if (this.#accessReport !== null) {
        this.#accessReportRequestedAgain = true;
        return this.#accessReport;
      }
      const report = (async () => {
        let result = { kind: "unknown" };
        for (let pass = 0; pass < ARCHIVE_ACCESS_REPORT_MAX_PASSES; pass += 1) {
          this.#accessReportRequestedAgain = false;
          const readerPresent = this.#accessReportReaderPresent;
          this.#accessReportReaderPresent = false;
          result = await this.#reportAccessOnce(readerPresent);
          if (!this.#accessReportRequestedAgain) break;
        }
        return result;
      })().finally(() => {
        this.#accessReport = null;
      });
      this.#accessReport = report;
      return report;
    }
    async #reportAccessOnce(readerPresent) {
      const ledger = await this.#readLedger();
      const startedAt = this.#clock.now();
      const longestWait = ARCHIVE_ACCESS_RETRY_DELAYS_MS.at(-1);
      if (!readerPresent && typeof ledger.retryAt === "number" && startedAt < ledger.retryAt && // A clock that moved backwards must not silence readings for good.
      ledger.retryAt - startedAt <= longestWait) {
        return { kind: "deferred" };
      }
      let reading = await this.#readAccess();
      if (reading === null) return { kind: "unknown" };
      if (!reading.complete) {
        if (!ledger.grantSeen) return { kind: "withheld" };
        if (this.#settled !== void 0 && !await this.#settled().catch(() => false)) {
          return { kind: "unknown" };
        }
        await this.#wait(ARCHIVE_ACCESS_CONFIRM_DELAY_MS);
        reading = await this.#readAccess();
        if (reading === null) return { kind: "unknown" };
      }
      const grantSeen = true;
      const fingerprint = accessFingerprint(reading.complete, reading.grantedOrigins);
      const now = this.#clock.now();
      if (ledger.delivered === fingerprint && typeof ledger.deliveredAt === "number" && now >= ledger.deliveredAt && now - ledger.deliveredAt < ARCHIVE_ACCESS_REPEAT_AFTER_MS) {
        if (!ledger.grantSeen) await this.#writeLedger({ ...ledger, grantSeen });
        return { kind: "current" };
      }
      let published = false;
      try {
        published = await this.#receipts.publishPermissionSnapshot(Object.freeze({
          at: now,
          grantedOrigins: reading.grantedOrigins
        }));
      } catch {
        published = false;
      }
      if (published) {
        await this.#writeLedger({ grantSeen, deliveredAt: now, delivered: fingerprint });
        return { kind: "published", complete: reading.complete };
      }
      const failures = (ledger.failures ?? 0) + 1;
      const retryAfter = ARCHIVE_ACCESS_RETRY_DELAYS_MS[Math.min(failures, ARCHIVE_ACCESS_RETRY_DELAYS_MS.length) - 1];
      await this.#writeLedger({ ...ledger, grantSeen, failures, retryAt: now + retryAfter });
      return { kind: "unavailable" };
    }
    async #readLedger() {
      try {
        return await this.#ledger.read();
      } catch {
        return { grantSeen: false };
      }
    }
    async #writeLedger(ledger) {
      try {
        await this.#ledger.write(Object.freeze(ledger));
      } catch {
      }
    }
    async #readAccess() {
      const contains = this.#permissions.containsOrigins;
      if (this.#requiredOrigins.length === 0 || contains === void 0) return null;
      const [listed, complete] = await Promise.all([
        this.#permissions.readGrantedOrigins().catch(() => null),
        contains.call(this.#permissions, this.#requiredOrigins).catch(() => null)
      ]);
      if (typeof complete !== "boolean") return null;
      if (complete) {
        return {
          complete: true,
          grantedOrigins: Object.freeze(
            Array.from(/* @__PURE__ */ new Set([...this.#requiredOrigins, ...listed ?? []]))
          )
        };
      }
      if (listed === null) return null;
      return { complete: false, grantedOrigins: Object.freeze([...listed]) };
    }
    async #publishPermissionSnapshot(hostKind2) {
      let grantedOrigins = null;
      try {
        grantedOrigins = await this.#permissions.readGrantedOrigins();
      } catch {
        return;
      }
      if (grantedOrigins === null) return;
      try {
        await this.#receipts.publishPermissionSnapshot(Object.freeze({
          hostKind: hostKind2,
          at: this.#clock.now(),
          grantedOrigins: Object.freeze([...grantedOrigins])
        }));
      } catch {
      }
    }
  };

  // src/extension-core/session-model.mts
  var SESSION_ENVELOPE_VERSION = 1;
  var INITIAL_SESSION_ENVELOPE = Object.freeze({
    version: SESSION_ENVELOPE_VERSION,
    epoch: 0,
    desired: "disconnected",
    accountId: null,
    credentialRef: null
  });
  var INITIAL_SESSION_MODEL = Object.freeze({
    state: "initializing",
    epoch: 0,
    accountId: null,
    publicationScope: null,
    displayScope: null,
    reason: "none"
  });
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isNullableIdentifier(value) {
    return value === null || typeof value === "string" && value.length > 0;
  }
  function parseSessionEnvelope(raw) {
    if (raw === null || raw === void 0) return { kind: "missing" };
    if (!isRecord(raw)) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (raw.version !== SESSION_ENVELOPE_VERSION) {
      return { kind: "invalid", reason: "unsupported_envelope" };
    }
    if (!Number.isSafeInteger(raw.epoch) || raw.epoch < 0) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (raw.desired !== "disconnected" && raw.desired !== "connected") {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (!isNullableIdentifier(raw.accountId) || !isNullableIdentifier(raw.credentialRef)) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (raw.desired === "disconnected" && (raw.accountId !== null || raw.credentialRef !== null)) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    return {
      kind: "valid",
      envelope: Object.freeze({
        version: SESSION_ENVELOPE_VERSION,
        epoch: raw.epoch,
        desired: raw.desired,
        accountId: raw.accountId,
        credentialRef: raw.credentialRef
      })
    };
  }
  function reduceSession(_model, event) {
    switch (event.type) {
      case "signed_out":
        return {
          state: "signed_out",
          epoch: event.epoch,
          accountId: null,
          publicationScope: null,
          displayScope: null,
          reason: event.reason ?? "none"
        };
      case "connecting":
        return {
          state: "connecting",
          epoch: event.epoch,
          accountId: null,
          publicationScope: null,
          displayScope: null,
          reason: "none"
        };
      case "verifying":
        return {
          state: "verifying",
          epoch: event.epoch,
          accountId: event.accountId,
          publicationScope: null,
          displayScope: null,
          reason: "none"
        };
      case "connected":
        return {
          state: "connected",
          epoch: event.scope.epoch,
          accountId: event.scope.accountId,
          publicationScope: event.scope,
          displayScope: event.scope,
          reason: "none"
        };
      case "degraded":
        return {
          state: "degraded",
          epoch: event.epoch,
          accountId: event.displayScope?.accountId ?? null,
          publicationScope: null,
          displayScope: event.displayScope,
          reason: event.reason
        };
      case "reconnect_required":
        return {
          state: "reconnect_required",
          epoch: event.epoch,
          accountId: null,
          publicationScope: null,
          displayScope: null,
          reason: event.reason
        };
    }
  }
  function toSessionSnapshot(model) {
    return Object.freeze({
      state: model.state,
      accountId: model.accountId,
      canExecuteAuthenticated: model.publicationScope !== null,
      reason: model.reason
    });
  }
  function sameAccountScope(left, right) {
    return left !== null && right !== null && left.accountId === right.accountId && left.epoch === right.epoch;
  }

  // src/extension-core/account-scope.mts
  function canSyncSavedFilters(publicationScope, repositoryScope) {
    return sameAccountScope(publicationScope, repositoryScope);
  }

  // src/extension-core/account-data.mts
  var WORK_KEY_PATTERN = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  var MAX_OVERLAY_RECORDS = 1e4;
  var LEGACY_STATUSES = Object.freeze([
    "PLANNING",
    "READING",
    "PAUSED",
    "COMPLETED",
    "DROPPED"
  ]);
  var CANONICAL_STATUSES = Object.freeze([
    "SAVED",
    "READING",
    "CAUGHT_UP",
    "PAUSED",
    "FINISHED",
    "DROPPED"
  ]);
  var WORK_STATUSES = Object.freeze([
    "complete",
    "wip",
    "hiatus",
    "abandoned",
    "unknown"
  ]);
  var WORK_STATUS_PROVENANCE = Object.freeze(["source", "override", "unknown"]);
  var CATCHUP_STATES = Object.freeze(["UP", "BEHIND", "UNKNOWN"]);
  function isRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
  }
  function isSafeInteger(value, minimum = 0) {
    return Number.isSafeInteger(value) && value >= minimum;
  }
  function enumValue(values, value) {
    return typeof value === "string" && values.includes(value) ? value : null;
  }
  function copyScope(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["accountId", "epoch"])) return null;
    if (typeof value.accountId !== "string" || value.accountId.trim() !== value.accountId) return null;
    if (value.accountId.length === 0 || !isSafeInteger(value.epoch)) return null;
    return Object.freeze({ accountId: value.accountId, epoch: value.epoch });
  }
  function copySummary(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["pro", "libraryCount", "firstStoryCompleted", "libraryLimit"])) {
      return null;
    }
    if (typeof value.pro !== "boolean" || !isSafeInteger(value.libraryCount) || typeof value.firstStoryCompleted !== "boolean" || value.libraryLimit !== void 0 && !isSafeInteger(value.libraryLimit, 1)) {
      return null;
    }
    return Object.freeze({
      pro: value.pro,
      libraryCount: value.libraryCount,
      firstStoryCompleted: value.firstStoryCompleted,
      ...value.libraryLimit === void 0 ? {} : { libraryLimit: value.libraryLimit }
    });
  }
  function copyCapacityRecovery(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["blockedAt", "blockedLibraryCount", "nextPromptAt"]) || !isSafeInteger(value.blockedAt) || !isSafeInteger(value.blockedLibraryCount) || !isSafeInteger(value.nextPromptAt)) {
      return null;
    }
    return Object.freeze({
      blockedAt: value.blockedAt,
      blockedLibraryCount: value.blockedLibraryCount,
      nextPromptAt: value.nextPromptAt
    });
  }
  function copyBrowsePreference(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["hidden"]) || typeof value.hidden !== "boolean") {
      return null;
    }
    return Object.freeze({ hidden: value.hidden });
  }
  function copyChapters(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["current", "total"])) return null;
    if (!isSafeInteger(value.current)) return null;
    if (value.total !== null && !isSafeInteger(value.total, 1)) return null;
    return Object.freeze({ current: value.current, total: value.total });
  }
  function copyWorkMark(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["kind", "challenge"])) return null;
    if (value.kind !== "abandoned" && value.kind !== "hiatus") return null;
    let challenge;
    if (Object.hasOwn(value, "challenge")) {
      const raw = value.challenge;
      if (!isRecord2(raw) || !hasOnlyKeys(raw, ["kind", "chapterDelta"])) return null;
      if (raw.kind !== "source-updated" && raw.kind !== "chapter-count-changed") return null;
      if (Object.hasOwn(raw, "chapterDelta") && !isSafeInteger(raw.chapterDelta, 1)) return null;
      challenge = Object.freeze({
        kind: raw.kind,
        ...Object.hasOwn(raw, "chapterDelta") ? { chapterDelta: raw.chapterDelta } : {}
      });
    }
    return Object.freeze({
      kind: value.kind,
      ...challenge === void 0 ? {} : { challenge }
    });
  }
  function copyPrivateContext(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["hasNotes", "tagCount", "notePreview", "tags"]) || typeof value.hasNotes !== "boolean" || !isSafeInteger(value.tagCount)) {
      return null;
    }
    let notePreview;
    if (Object.hasOwn(value, "notePreview")) {
      if (typeof value.notePreview !== "string" || value.notePreview.length > 180 || value.notePreview.trim() !== value.notePreview) {
        return null;
      }
      notePreview = value.notePreview;
    }
    let tags;
    if (Object.hasOwn(value, "tags")) {
      if (!Array.isArray(value.tags) || value.tags.length > 5) return null;
      const copied = [];
      for (const tag of value.tags) {
        if (typeof tag !== "string" || tag.length === 0 || tag.length > 100 || tag.trim() !== tag) {
          return null;
        }
        copied.push(tag);
      }
      tags = Object.freeze(copied);
    }
    return Object.freeze({
      hasNotes: value.hasNotes,
      tagCount: value.tagCount,
      ...notePreview === void 0 ? {} : { notePreview },
      ...tags === void 0 ? {} : { tags }
    });
  }
  function copyEntry(value) {
    if (!isRecord2(value)) return null;
    const status2 = enumValue(LEGACY_STATUSES, value.status);
    if (status2 === null) return null;
    const result = { status: status2 };
    if (Object.hasOwn(value, "chapters")) {
      const chapters = copyChapters(value.chapters);
      if (chapters === null) return null;
      result.chapters = chapters;
    }
    if (Object.hasOwn(value, "readerStatus")) {
      const readerStatus = enumValue(LEGACY_STATUSES, value.readerStatus);
      if (readerStatus === null || readerStatus !== status2) return null;
      result.readerStatus = readerStatus;
    }
    if (Object.hasOwn(value, "canonicalReaderStatus")) {
      const canonical = enumValue(CANONICAL_STATUSES, value.canonicalReaderStatus);
      if (canonical === null) return null;
      result.canonicalReaderStatus = canonical;
    }
    if (Object.hasOwn(value, "entryId")) {
      if (typeof value.entryId !== "string" || !UUID_PATTERN.test(value.entryId)) return null;
      result.entryId = value.entryId;
    }
    if (Object.hasOwn(value, "browsePreference")) {
      const preference = copyBrowsePreference(value.browsePreference);
      if (preference === null) return null;
      result.browsePreference = preference;
    }
    if (Object.hasOwn(value, "workMark")) {
      const mark = copyWorkMark(value.workMark);
      if (mark === null) return null;
      result.workMark = mark;
    }
    if (Object.hasOwn(value, "workStatus")) {
      const workStatus = enumValue(WORK_STATUSES, value.workStatus);
      if (workStatus === null) return null;
      result.workStatus = workStatus;
    }
    if (Object.hasOwn(value, "workStatusProvenance")) {
      const provenance = enumValue(WORK_STATUS_PROVENANCE, value.workStatusProvenance);
      if (provenance === null) return null;
      result.workStatusProvenance = provenance;
    }
    if (Object.hasOwn(value, "catchupState")) {
      const catchup = enumValue(CATCHUP_STATES, value.catchupState);
      if (catchup === null) return null;
      result.catchupState = catchup;
    }
    if (Object.hasOwn(value, "newChapterCount")) {
      if (!isSafeInteger(value.newChapterCount)) return null;
      result.newChapterCount = value.newChapterCount;
    }
    if (Object.hasOwn(value, "rating")) {
      if (!isSafeInteger(value.rating) || value.rating > 5) return null;
      result.rating = value.rating;
    }
    if (Object.hasOwn(value, "privateContext")) {
      const context = copyPrivateContext(value.privateContext);
      if (context === null) return null;
      result.privateContext = context;
    }
    return Object.freeze(result);
  }
  function copyEntryMap(value) {
    if (!isRecord2(value) || Object.keys(value).length > MAX_OVERLAY_RECORDS) return null;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key.length > 32 || !WORK_KEY_PATTERN.test(key)) return null;
      const entry = copyEntry(raw);
      if (entry === null) return null;
      result[key] = entry;
    }
    return Object.freeze(result);
  }
  function copyPreferenceMap(value) {
    if (!isRecord2(value) || Object.keys(value).length > MAX_OVERLAY_RECORDS) return null;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key.length > 32 || !WORK_KEY_PATTERN.test(key) || !isRecord2(raw)) return null;
      if (!hasOnlyKeys(raw, ["browsePreference"])) return null;
      const preference = copyBrowsePreference(raw.browsePreference);
      if (preference === null) return null;
      result[key] = Object.freeze({ browsePreference: preference });
    }
    return Object.freeze(result);
  }
  function copyOverlay(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["entries", "workPreferences", "syncVersion"])) {
      return null;
    }
    const entries = copyEntryMap(value.entries);
    const workPreferences = copyPreferenceMap(value.workPreferences);
    if (entries === null || workPreferences === null) return null;
    if (typeof value.syncVersion !== "string" || !ISO_TIMESTAMP_PATTERN.test(value.syncVersion) || !Number.isFinite(Date.parse(value.syncVersion)) || new Date(value.syncVersion).toISOString() !== value.syncVersion) {
      return null;
    }
    return Object.freeze({ entries, workPreferences, syncVersion: value.syncVersion });
  }
  function parseAccountData(value) {
    if (value === null || value === void 0) return { kind: "missing" };
    if (!isRecord2(value) || !hasOnlyKeys(value, [
      "version",
      "scope",
      "summary",
      "overlay",
      "capacityRecovery"
    ]) || value.version !== 1 || !Object.hasOwn(value, "summary") || !Object.hasOwn(value, "overlay")) {
      return { kind: "invalid" };
    }
    const scope2 = copyScope(value.scope);
    if (scope2 === null) return { kind: "invalid" };
    const summary = value.summary === null ? null : copySummary(value.summary);
    if (value.summary !== null && summary === null) return { kind: "invalid" };
    const overlay = value.overlay === null ? null : copyOverlay(value.overlay);
    if (value.overlay !== null && overlay === null) return { kind: "invalid" };
    const rawCapacityRecovery = Object.hasOwn(value, "capacityRecovery") ? value.capacityRecovery : null;
    const capacityRecovery = rawCapacityRecovery === null ? null : copyCapacityRecovery(rawCapacityRecovery);
    if (rawCapacityRecovery !== null && capacityRecovery === null) {
      return { kind: "invalid" };
    }
    return {
      kind: "valid",
      value: Object.freeze({
        version: 1,
        scope: scope2,
        summary,
        overlay,
        capacityRecovery
      })
    };
  }
  function createEmptyAccountData(scope2) {
    const parsed = parseAccountData({
      version: 1,
      scope: scope2,
      summary: null,
      overlay: null,
      capacityRecovery: null
    });
    if (parsed.kind !== "valid") throw new TypeError("invalid account scope");
    return parsed.value;
  }
  function copyAccountSummary(value) {
    return copySummary(value);
  }
  function copyAccountOverlay(value) {
    return copyOverlay(value);
  }
  function copyLibraryOverlayEntry(value) {
    return copyEntry(value);
  }

  // src/extension-core/account-projection.mts
  function scopeKey(scope2) {
    return `${scope2.accountId}:${scope2.epoch}`;
  }
  var AccountProjectionService = class {
    #ports;
    #maxAgeMs;
    #lastRefresh = null;
    #inflight = null;
    #invalidationGeneration = 0;
    constructor(ports) {
      this.#ports = ports;
      this.#maxAgeMs = ports.maxAgeMs ?? 3e4;
    }
    async read(options = {}) {
      if (options.refresh !== false) await this.refreshIfNeeded();
      return this.#ports.repository.read();
    }
    invalidate() {
      this.#invalidationGeneration += 1;
      this.#lastRefresh = null;
    }
    refreshIfNeeded(force = false) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) {
        return Promise.resolve({ kind: "not_authenticated" });
      }
      const key = scopeKey(scope2);
      const generation = this.#invalidationGeneration;
      if (this.#inflight?.scope === key) {
        if (this.#inflight.generation === generation) return this.#inflight.promise;
        return this.#inflight.promise.then(() => this.refreshIfNeeded(true));
      }
      if (!force && this.#lastRefresh?.scope === key && this.#ports.clock.now() - this.#lastRefresh.at < this.#maxAgeMs) {
        return Promise.resolve({ kind: "current" });
      }
      const promise = this.#refresh(scope2, generation).finally(() => {
        if (this.#inflight?.promise === promise) this.#inflight = null;
      });
      this.#inflight = Object.freeze({ scope: key, generation, promise });
      return promise;
    }
    async #refresh(scope2, generation) {
      let reservation = this.#ports.repository.reserveOverlayWrite();
      let fetched = await this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.load(credential)
      );
      if (fetched.kind === "auth_rejected" && fetched.recovery === "connected") {
        reservation = this.#ports.repository.reserveOverlayWrite();
        fetched = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.load(credential)
        );
      }
      if (fetched.kind === "auth_rejected") return { kind: "auth_expired" };
      if (fetched.kind === "stale") return { kind: "stale" };
      if (fetched.kind !== "published") return { kind: "unavailable" };
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return { kind: "stale" };
      }
      let overlay;
      if (fetched.value.overlay.kind === "value") {
        try {
          const result = await this.#ports.repository.publishOverlay(
            scope2,
            fetched.value.overlay.value,
            reservation
          );
          overlay = result.kind === "published" ? "published" : result.kind === "stale_write" ? "stale" : result.kind === "invalid_model" ? "invalid" : "stale";
        } catch {
          overlay = "unavailable";
        }
      } else {
        overlay = fetched.value.overlay.kind === "invalid_response" ? "invalid" : "unavailable";
      }
      let summary;
      if (fetched.value.summary.kind === "value") {
        if (fetched.value.summary.value.accountId !== scope2.accountId) {
          summary = "invalid";
        } else {
          try {
            const result = await this.#ports.repository.publishSummary(
              scope2,
              fetched.value.summary.value.value
            );
            summary = result.kind === "published" ? "published" : result.kind === "invalid_model" ? "invalid" : "unavailable";
          } catch {
            summary = "unavailable";
          }
        }
      } else {
        summary = fetched.value.summary.kind === "invalid_response" ? "invalid" : "unavailable";
      }
      if (sameAccountScope(this.#ports.session.displayScope(), scope2) && generation === this.#invalidationGeneration && (overlay === "published" || summary === "published")) {
        this.#lastRefresh = Object.freeze({
          scope: scopeKey(scope2),
          at: this.#ports.clock.now()
        });
      }
      return Object.freeze({ kind: "refreshed", overlay, summary });
    }
  };

  // src/extension-core/library-command.mts
  function failed(reason) {
    return Object.freeze({ kind: "failed", reason });
  }
  function executionFailure(result) {
    if (result.kind === "stale") return failed("stale");
    if (result.kind === "auth_rejected") return failed("auth_expired");
    return failed("not_authenticated");
  }
  function projectionFailure(result) {
    return failed(result.kind);
  }
  function canonicalReaderStatus(entry) {
    if (entry.canonicalReaderStatus !== void 0) {
      return entry.canonicalReaderStatus;
    }
    const legacy = entry.readerStatus ?? entry.status;
    if (legacy === "PLANNING") return "SAVED";
    if (legacy === "COMPLETED") return "FINISHED";
    return legacy === "READING" || legacy === "PAUSED" || legacy === "DROPPED" ? legacy : null;
  }
  function entryForCommand(data, command) {
    const entry = data.overlay?.entries[command.workKey];
    if (entry === void 0 || entry.entryId !== command.entryId) return null;
    return entry;
  }
  function entryPatchSatisfied(entry, patch) {
    if (patch.status !== void 0 && canonicalReaderStatus(entry) !== patch.status) {
      return false;
    }
    if (patch.progress !== void 0) {
      if (entry.chapters === void 0 || entry.chapters.current !== patch.progress.value || entry.chapters.total !== patch.progress.total) {
        return false;
      }
    }
    if (patch.rating !== void 0 && entry.rating !== patch.rating) return false;
    const override = patch.story_snapshot?.work_status_override;
    if (override !== void 0) {
      if (override === null) {
        if (entry.workStatusProvenance === "override") return false;
      } else if (entry.workStatus !== override || entry.workStatusProvenance !== "override") {
        return false;
      }
    }
    return true;
  }
  function preferenceSatisfied(data, command) {
    const hidden = data.overlay?.workPreferences[command.workKey]?.browsePreference.hidden === true;
    return hidden === command.hidden;
  }
  function libraryMutationSatisfied(data, command) {
    if (command.kind === "work_preference") return preferenceSatisfied(data, command);
    const entry = entryForCommand(data, command);
    return entry !== null && entryPatchSatisfied(entry, command.patch);
  }
  function confirmedMutation(data, command, source) {
    const entry = command.kind === "entry_patch" ? entryForCommand(data, command) ?? void 0 : data.overlay?.entries[command.workKey];
    return Object.freeze({
      kind: "confirmed",
      commandKind: command.kind,
      workKey: command.workKey,
      ...command.kind === "entry_patch" ? { entryId: command.entryId } : {},
      ...entry === void 0 ? {} : { entry },
      source
    });
  }
  var LibraryMutationService = class {
    #ports;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    execute(command) {
      const ownedCommand = { ...command };
      return this.#withLock(() => this.#execute(ownedCommand));
    }
    async #execute(command) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failed("not_authenticated");
      let projection = await this.#ports.projection.refreshAndRead();
      if (projection.kind !== "value") return projectionFailure(projection);
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failed("stale");
      }
      if (command.kind === "entry_patch" && entryForCommand(projection.value, command) === null) {
        return failed("invalid_request");
      }
      if (libraryMutationSatisfied(projection.value, command)) {
        return confirmedMutation(projection.value, command, "preflight");
      }
      let mutation = await this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.mutate(credential, command)
      );
      if (mutation.kind === "auth_rejected" && mutation.recovery === "connected") {
        projection = await this.#ports.projection.refreshAndRead();
        if (projection.kind !== "value") return projectionFailure(projection);
        if (libraryMutationSatisfied(projection.value, command)) {
          return confirmedMutation(projection.value, command, "preflight");
        }
        mutation = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.mutate(credential, command)
        );
      }
      if (mutation.kind !== "published") return executionFailure(mutation);
      if (mutation.value.kind === "rejected") return failed(mutation.value.reason);
      projection = await this.#ports.projection.refreshAndRead();
      if (projection.kind !== "value") return projectionFailure(projection);
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failed("stale");
      }
      if (!libraryMutationSatisfied(projection.value, command)) {
        return failed("confirmation_missing");
      }
      return confirmedMutation(
        projection.value,
        command,
        mutation.value.kind === "accepted" ? "mutation" : "reconciliation"
      );
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
  var FinishQualificationService = class {
    #ports;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    execute(command) {
      const publicationReservation = this.#ports.projection.reserveFinishPublication();
      return this.#withLock(() => this.#execute(command, publicationReservation));
    }
    async #execute(command, publicationReservation) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failed("not_authenticated");
      let operation;
      if (command.state === "resolved") {
        let operationId;
        try {
          operationId = this.#ports.finishOperationIds.create().trim();
        } catch {
          return failed("unavailable");
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
          return failed("unavailable");
        }
        operation = Object.freeze({ ...command, operationId });
      } else {
        operation = command;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let signal = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.qualifyFinish(credential, operation)
        );
        if (signal.kind === "auth_rejected" && signal.recovery === "connected") {
          signal = await this.#ports.session.executeAuthenticated(
            (credential) => this.#ports.api.qualifyFinish(credential, operation)
          );
        }
        if (signal.kind !== "published") return executionFailure(signal);
        if (signal.value.kind === "rejected") return failed(signal.value.reason);
        if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
          return failed("stale");
        }
        if (signal.value.kind === "uncertain") {
          if (command.state === "resolved" && attempt === 0) continue;
          return failed("unavailable");
        }
        if (signal.value.kind === "invalid_response") {
          return failed("invalid_response");
        }
        if (signal.value.state !== "ignored" && signal.value.state !== command.state) {
          return failed("invalid_response");
        }
        if (signal.value.operationId !== (operation.state === "resolved" ? operation.operationId : null)) {
          return failed("invalid_response");
        }
        let publication;
        try {
          publication = await this.#ports.projection.publishFinishAcknowledgement(
            scope2,
            operation,
            signal.value,
            publicationReservation
          );
        } catch {
          publication = { kind: "unavailable" };
        }
        if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
          return failed("stale");
        }
        if (publication.kind === "published") return signal.value;
        if (publication.kind === "rejected_scope" || publication.kind === "stale_write") {
          return failed("stale");
        }
        if (publication.kind === "invalid_model") return failed("invalid_response");
        return failed("unavailable");
      }
      return failed("unavailable");
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-core/metadata-contribution.mts
  function failure(reason) {
    return Object.freeze({ kind: "failed", reason });
  }
  function executionFailure2(result) {
    if (result.kind === "stale") return failure("stale");
    if (result.kind === "auth_rejected") return failure("auth_expired");
    return failure("not_authenticated");
  }
  var MetadataContributionService = class {
    #ports;
    constructor(ports) {
      this.#ports = ports;
    }
    async execute(command) {
      let enabled = true;
      try {
        enabled = await this.#ports.preference.enabled();
      } catch {
        enabled = true;
      }
      if (!enabled) {
        return Object.freeze({ kind: "skipped", reason: "preference_disabled" });
      }
      try {
        await this.#ports.authority.prepare();
      } catch {
        return failure("unavailable");
      }
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failure("not_authenticated");
      let contribution = await this.#executeAuthenticated(command);
      if (contribution.kind === "auth_rejected" && contribution.recovery === "connected") {
        contribution = await this.#executeAuthenticated(command);
      }
      if (contribution.kind !== "published") return executionFailure2(contribution);
      if (contribution.value.kind === "rejected") {
        return failure(contribution.value.reason);
      }
      if (contribution.value.kind === "invalid_response") {
        return failure("invalid_response");
      }
      if (contribution.value.kind === "unavailable") return failure("unavailable");
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure("stale");
      }
      if (!contribution.value.updated) {
        return Object.freeze({
          kind: "accepted",
          updated: false,
          projection: "not_needed",
          notification: "not_needed"
        });
      }
      let projection = "invalidated";
      try {
        this.#ports.projection.invalidate();
      } catch {
        projection = "unavailable";
      }
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure("stale");
      }
      let notification = "unavailable";
      try {
        notification = await this.#ports.notification.publish() ? "published" : "unavailable";
      } catch {
        notification = "unavailable";
      }
      return Object.freeze({
        kind: "accepted",
        updated: true,
        projection,
        notification
      });
    }
    #executeAuthenticated(command) {
      return this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.contribute(credential, command)
      );
    }
  };

  // src/extension-core/safari-readiness.mts
  var SAFARI_READINESS_REPORT_VERSION = 1;
  var ANSWERS = Object.freeze({
    allowed: "positive",
    not_allowed: "blocker",
    partly_allowed: "blocker",
    not_allowed_since_update: "blocker",
    registered: "positive",
    declared: "positive",
    not_registered: "blocker",
    registration_failed: "blocker",
    connected: "positive",
    no_account: "blocker",
    reconnect_required: "blocker",
    on: "positive",
    off: "blocker"
  });
  function component(reason, observedAt) {
    return Object.freeze({ answer: ANSWERS[reason] ?? "unknown", reason, observedAt });
  }
  function safariReadinessResult(components) {
    if (components.account.reason === "changed") return "unknown";
    const answers = [
      components.websiteAccess,
      components.scriptRegistration,
      components.account,
      components.automaticSaving
    ].map(({ answer }) => answer);
    if (answers.every((answer) => answer === "positive")) return "ready";
    return answers.includes("blocker") ? "not_ready" : "unknown";
  }
  var MAX_PASSES = 3;
  var SafariReadinessService = class {
    #ports;
    #running = null;
    #askedAgain = false;
    constructor(ports) {
      this.#ports = ports;
    }
    /**
     * Reads the four things and sends the app one report. A request that
     * arrives while one is being read is answered by reading again afterwards,
     * since what it was asked about may have changed since.
     */
    report() {
      if (this.#running !== null) {
        this.#askedAgain = true;
        return this.#running;
      }
      const running = (async () => {
        let outcome = { kind: "no_provider" };
        for (let pass = 0; pass < MAX_PASSES; pass += 1) {
          this.#askedAgain = false;
          const once = await this.#reportOnce();
          outcome = once.outcome;
          if (!once.again && !this.#askedAgain) break;
        }
        return outcome;
      })().finally(() => {
        this.#running = null;
      });
      this.#running = running;
      return running;
    }
    async #reportOnce() {
      const preparation = await this.#ports.prepare().catch(() => null);
      if (preparation === null) return { outcome: { kind: "no_provider" }, again: false };
      const account = await this.#ports.account().catch(
        () => ({ state: "unreachable" })
      );
      const accountAt = this.#ports.now();
      const session = this.#ports.session();
      const [websiteAccess, scriptRegistration, automaticSaving] = await Promise.all([
        this.#websiteAccess(),
        this.#ports.scriptRegistration().then(
          (reason) => component(reason, this.#ports.now()),
          () => component("unreadable", this.#ports.now())
        ),
        this.#ports.automaticSaving().then(
          (value) => component(value === "unknown" ? "unreadable" : value, this.#ports.now()),
          () => component("unreadable", this.#ports.now())
        )
      ]);
      let accountReason = account.state;
      if (this.#ports.session() !== session || account.state === "connected" && account.session !== session) {
        accountReason = "changed";
      } else if (account.state === "connected" && preparation.cycle !== null && preparation.cycle.accountId !== null && preparation.cycle.accountId !== account.accountId) {
        accountReason = "mismatch";
      }
      const components = Object.freeze({
        websiteAccess,
        scriptRegistration,
        account: component(accountReason, accountReason === account.state ? accountAt : this.#ports.now()),
        automaticSaving
      });
      const report = Object.freeze({
        version: SAFARI_READINESS_REPORT_VERSION,
        observedAt: this.#ports.now(),
        result: safariReadinessResult(components),
        components,
        ...accountReason === "connected" && account.state === "connected" ? { accountId: account.accountId } : {}
      });
      const delivered = await this.#ports.deliver(report, preparation).catch(() => "refused");
      const again = accountReason === "changed" || delivered === "stale_cycle";
      return {
        outcome: delivered === "stored" ? { kind: "delivered", report } : { kind: "refused", report },
        again
      };
    }
    /**
     * Allowed on one fresh reading. Not allowed only on two readings a moment
     * apart that both say so, with Safari listing what is allowed both
     * times: a single reading, or one without the list, is not an answer.
     */
    async #websiteAccess() {
      const read = () => this.#ports.websiteAccess().catch(() => ({ complete: null, granted: null }));
      const done = (reason) => component(reason, this.#ports.now());
      const first = await read();
      if (first.complete === true) return done("allowed");
      if (first.complete === null) return done("unreadable");
      if (first.granted === null) return done("unconfirmed");
      await this.#ports.wait(ARCHIVE_ACCESS_CONFIRM_DELAY_MS);
      const second = await read();
      if (second.complete === true) return done("allowed");
      if (second.complete === null || second.granted === null) return done("unconfirmed");
      if (second.granted > 0) return done("partly_allowed");
      const before = await (this.#ports.allowedBeforeUpdate?.() ?? Promise.resolve(false)).catch(() => false);
      return done(before === true ? "not_allowed_since_update" : "not_allowed");
    }
  };

  // src/extension-core/saved-filter-sync.mts
  var SAVED_FILTER_ACTIVE_LIMIT = 250;
  var SAVED_FILTER_SYNC_BATCH_LIMIT = 100;
  var SAVED_FILTER_SYNC_MAX_ITERATIONS = 10;
  var CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
  var PARAM_KEY_PATTERN = /^(?:work_search|include_work_search|exclude_work_search)\[[a-z0-9_]+\](?:\[\])?$/;
  var UUID_PATTERN2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var MAX_REMOTE_ROWS = SAVED_FILTER_ACTIVE_LIMIT * 2;
  var MAX_LOCAL_TOMBSTONES = 1e4;
  function isRecord3(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys2(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
  }
  function isIso(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }
  function cleanText(value, maxLength) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
  }
  function copyPairs(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 80) return null;
    const pairs = [];
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const key = typeof pair[0] === "string" ? pair[0].trim() : "";
      const item = typeof pair[1] === "string" ? pair[1].trim() : "";
      if (!PARAM_KEY_PATTERN.test(key) || item.length === 0 || item.length > 300) return null;
      pairs.push([key, item]);
    }
    pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    return Object.freeze(pairs.map((pair) => Object.freeze(pair)));
  }
  function copySummary2(value) {
    if (!Array.isArray(value) || value.length > 5) return null;
    const summary = [];
    for (const item of value) {
      const text2 = cleanText(item, 64);
      if (!text2 || text2 !== item) return null;
      summary.push(text2);
    }
    return Object.freeze(summary);
  }
  function validClientId(value) {
    return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
  }
  function validUuid(value) {
    return typeof value === "string" && UUID_PATTERN2.test(value);
  }
  function copyLocalPreset(value, now) {
    if (!isRecord3(value)) return null;
    const id = cleanText(value.id, 120);
    const clientId = validClientId(value.clientId) ? value.clientId : validClientId(id) ? id : "";
    const params = copyPairs(value.params);
    const summary = copySummary2(Array.isArray(value.summary) ? value.summary : []);
    if (!id || !clientId || params === null || summary === null) return null;
    const scope2 = value.scope === "global" ? "global" : "context";
    const updatedAt = isIso(value.updatedAt) ? value.updatedAt : now;
    return Object.freeze({
      id,
      clientId,
      serverId: validUuid(value.serverId) ? value.serverId : "",
      name: cleanText(value.name, 96) || "AO3 filter",
      params,
      scope: scope2,
      contextKey: scope2 === "context" ? cleanText(value.contextKey, 240) : "",
      contextLabel: scope2 === "context" ? cleanText(value.contextLabel, 120) : "",
      summary,
      createdAt: isIso(value.createdAt) ? value.createdAt : now,
      updatedAt,
      clientUpdatedAt: isIso(value.clientUpdatedAt) ? value.clientUpdatedAt : updatedAt,
      dirty: value.dirty === true
    });
  }
  function copyLocalDeletion(value, now) {
    if (!isRecord3(value)) return null;
    const id = cleanText(value.id, 120);
    const clientId = validClientId(value.clientId) ? value.clientId : validClientId(id) ? id : "";
    if (!clientId) return null;
    return Object.freeze({
      id: id || clientId,
      clientId,
      serverId: validUuid(value.serverId) ? value.serverId : "",
      clientUpdatedAt: isIso(value.clientUpdatedAt) ? value.clientUpdatedAt : now
    });
  }
  function copyActiveMeta(value) {
    if (!isRecord3(value)) return null;
    const id = cleanText(value.id, 120);
    const signature = cleanText(value.signature, 4096);
    const contextKey = cleanText(value.contextKey, 240);
    if (!id || !signature || !contextKey) return null;
    return Object.freeze({
      id,
      signature,
      contextKey,
      appliedAt: isIso(value.appliedAt) ? value.appliedAt : ""
    });
  }
  function normalizeSavedFilterSnapshot(raw, now) {
    const root = isRecord3(raw) ? raw : {};
    const presets = [];
    const presetIds = /* @__PURE__ */ new Set();
    const presetClientIds = /* @__PURE__ */ new Set();
    if (Array.isArray(root.presets)) {
      for (const value of root.presets.slice(0, SAVED_FILTER_ACTIVE_LIMIT)) {
        const preset = copyLocalPreset(value, now);
        if (preset === null || presetIds.has(preset.id) || presetClientIds.has(preset.clientId)) {
          continue;
        }
        presetIds.add(preset.id);
        presetClientIds.add(preset.clientId);
        presets.push(preset);
      }
    }
    const deleted = [];
    const deletedClientIds = /* @__PURE__ */ new Set();
    if (Array.isArray(root.deleted)) {
      for (const value of root.deleted.slice(0, MAX_LOCAL_TOMBSTONES)) {
        const item = copyLocalDeletion(value, now);
        if (item === null || deletedClientIds.has(item.clientId)) continue;
        deletedClientIds.add(item.clientId);
        deleted.push(item);
      }
    }
    return Object.freeze({
      presets: Object.freeze(presets),
      deleted: Object.freeze(deleted),
      activeMeta: copyActiveMeta(root.activeMeta),
      syncVersion: isIso(root.syncVersion) ? root.syncVersion : null,
      lastSyncedAt: isIso(root.lastSyncedAt) ? root.lastSyncedAt : null,
      syncAccountId: typeof root.syncAccountId === "string" && root.syncAccountId ? root.syncAccountId.slice(0, 200) : null,
      clientId: validClientId(root.clientId) ? root.clientId : null
    });
  }
  function copyRemotePreset(value) {
    if (!isRecord3(value) || !hasOnlyKeys2(value, [
      "id",
      "clientId",
      "name",
      "scope",
      "contextKey",
      "contextLabel",
      "params",
      "summary",
      "createdAt",
      "updatedAt",
      "clientUpdatedAt"
    ]) || !validUuid(value.id) || !validClientId(value.clientId) || value.scope !== "context" && value.scope !== "global" || !isIso(value.createdAt) || !isIso(value.updatedAt) || !isIso(value.clientUpdatedAt)) {
      return null;
    }
    const name = cleanText(value.name, 96);
    const params = copyPairs(value.params);
    const summary = copySummary2(value.summary);
    if (!name || name !== value.name || params === null || summary === null) return null;
    if (value.contextKey !== null && (typeof value.contextKey !== "string" || value.contextKey.length > 240)) {
      return null;
    }
    if (value.contextLabel !== null && (typeof value.contextLabel !== "string" || value.contextLabel.length > 120)) {
      return null;
    }
    return Object.freeze({
      id: value.id,
      clientId: value.clientId,
      name,
      scope: value.scope,
      contextKey: value.contextKey,
      contextLabel: value.contextLabel,
      params,
      summary,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      clientUpdatedAt: value.clientUpdatedAt
    });
  }
  function copyRemoteDeletion(value) {
    if (!isRecord3(value) || !hasOnlyKeys2(value, [
      "id",
      "clientId",
      "deletedAt",
      "updatedAt",
      "clientUpdatedAt"
    ]) || !validUuid(value.id) || !validClientId(value.clientId) || !isIso(value.deletedAt) || !isIso(value.updatedAt) || !isIso(value.clientUpdatedAt)) {
      return null;
    }
    return Object.freeze({
      id: value.id,
      clientId: value.clientId,
      deletedAt: value.deletedAt,
      updatedAt: value.updatedAt,
      clientUpdatedAt: value.clientUpdatedAt
    });
  }
  function parseSavedFilterSyncData(value) {
    if (!isRecord3(value) || !hasOnlyKeys2(value, ["serverTime", "syncVersion", "presets", "deleted"]) || !isIso(value.serverTime) || !isIso(value.syncVersion) || !Array.isArray(value.presets) || !Array.isArray(value.deleted) || value.presets.length > MAX_REMOTE_ROWS || value.deleted.length > MAX_REMOTE_ROWS) {
      return null;
    }
    const presets = [];
    const deleted = [];
    const seenPresets = /* @__PURE__ */ new Set();
    const seenDeleted = /* @__PURE__ */ new Set();
    for (const raw of value.presets) {
      const preset = copyRemotePreset(raw);
      if (preset === null || seenPresets.has(preset.clientId)) return null;
      seenPresets.add(preset.clientId);
      presets.push(preset);
    }
    for (const raw of value.deleted) {
      const item = copyRemoteDeletion(raw);
      if (item === null || seenDeleted.has(item.clientId)) return null;
      seenDeleted.add(item.clientId);
      deleted.push(item);
    }
    return Object.freeze({
      serverTime: value.serverTime,
      syncVersion: value.syncVersion,
      presets: Object.freeze(presets),
      deleted: Object.freeze(deleted)
    });
  }
  function needsSync(preset) {
    return preset.dirty || !validUuid(preset.serverId);
  }
  function upsertFromPreset(preset) {
    return Object.freeze({
      ...validUuid(preset.serverId) ? { id: preset.serverId } : {},
      clientId: preset.clientId,
      name: preset.name,
      scope: preset.scope,
      contextKey: preset.scope === "context" ? preset.contextKey || null : null,
      contextLabel: preset.scope === "context" ? preset.contextLabel || null : null,
      params: preset.params,
      summary: preset.summary,
      createdAt: preset.createdAt,
      clientUpdatedAt: preset.clientUpdatedAt
    });
  }
  function deleteFromLocal(item) {
    return Object.freeze({
      ...validUuid(item.serverId) ? { id: item.serverId } : {},
      clientId: item.clientId,
      clientUpdatedAt: item.clientUpdatedAt
    });
  }
  function savedFilterSyncRequest(snapshot, accountId) {
    if (snapshot.clientId === null) return null;
    const since = accountId === void 0 || snapshot.syncAccountId === accountId ? snapshot.syncVersion : null;
    return Object.freeze({
      clientId: snapshot.clientId,
      since,
      upserts: Object.freeze(
        snapshot.presets.filter(needsSync).slice(0, SAVED_FILTER_SYNC_BATCH_LIMIT).map(upsertFromPreset)
      ),
      deletes: Object.freeze(
        snapshot.deleted.slice(0, SAVED_FILTER_SYNC_BATCH_LIMIT).map(deleteFromLocal)
      )
    });
  }
  function localIsNewer(local, remoteClientUpdatedAt) {
    if (local?.dirty !== true) return false;
    return Date.parse(local.clientUpdatedAt) > Date.parse(remoteClientUpdatedAt);
  }
  function mergeSavedFilterSyncData(snapshot, data, sentDeleteClientIds, syncedAt, accountId = snapshot.syncAccountId) {
    const byClientId = new Map(snapshot.presets.map((item) => [item.clientId, item]));
    const localIdByClientId = new Map(
      snapshot.presets.map((item) => [item.clientId, item.id])
    );
    const deletedByClientId = new Map(
      snapshot.deleted.map((item) => [item.clientId, item])
    );
    for (const clientId of sentDeleteClientIds) deletedByClientId.delete(clientId);
    for (const remote of data.presets) {
      const existing = byClientId.get(remote.clientId);
      if (localIsNewer(existing, remote.clientUpdatedAt)) continue;
      byClientId.set(remote.clientId, Object.freeze({
        id: existing?.id ?? remote.clientId,
        clientId: remote.clientId,
        serverId: remote.id,
        name: remote.name,
        params: remote.params,
        scope: remote.scope,
        contextKey: remote.scope === "context" ? remote.contextKey ?? "" : "",
        contextLabel: remote.scope === "context" ? remote.contextLabel ?? "" : "",
        summary: remote.summary,
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
        clientUpdatedAt: remote.clientUpdatedAt,
        dirty: false
      }));
      deletedByClientId.delete(remote.clientId);
    }
    for (const remote of data.deleted) {
      const existing = byClientId.get(remote.clientId);
      if (localIsNewer(existing, remote.clientUpdatedAt)) continue;
      byClientId.delete(remote.clientId);
      deletedByClientId.delete(remote.clientId);
    }
    const presets = Array.from(byClientId.values()).sort(
      (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
    );
    let activeMeta = snapshot.activeMeta;
    if (activeMeta !== null && !presets.some((item) => item.id === activeMeta.id)) {
      const activeClientId = Array.from(localIdByClientId.entries()).find(([, localId]) => localId === activeMeta.id)?.[0];
      const replacement = activeClientId === void 0 ? void 0 : presets.find((item) => item.clientId === activeClientId);
      activeMeta = replacement === void 0 ? null : Object.freeze({ ...activeMeta, id: replacement.id });
    }
    return Object.freeze({
      presets: Object.freeze(presets),
      deleted: Object.freeze(Array.from(deletedByClientId.values())),
      activeMeta,
      syncVersion: data.syncVersion,
      lastSyncedAt: syncedAt,
      syncAccountId: accountId,
      clientId: snapshot.clientId
    });
  }
  function savedFilterSnapshotHasPending(snapshot) {
    return snapshot.presets.some(needsSync) || snapshot.deleted.length > 0;
  }
  function failure2(reason, limit) {
    return Object.freeze({
      kind: "failed",
      reason,
      ...limit === void 0 ? {} : { limit }
    });
  }
  var SavedFilterSyncService = class {
    #ports;
    #inFlight = null;
    #generation = 0;
    constructor(ports) {
      this.#ports = ports;
    }
    sync() {
      const generation = this.#generation;
      this.#inFlight ??= this.#syncOnce(generation).finally(() => {
        this.#inFlight = null;
      });
      return this.#inFlight;
    }
    cancel() {
      this.#generation += 1;
    }
    async #syncOnce(generation) {
      let scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failure2("not_authenticated");
      let requests = 0;
      let lastSyncVersion = "";
      for (let iteration = 0; iteration < SAVED_FILTER_SYNC_MAX_ITERATIONS; iteration += 1) {
        if (generation !== this.#generation) return failure2("stale");
        let snapshot;
        try {
          snapshot = await this.#ports.repository.read();
        } catch {
          return failure2("storage_unavailable");
        }
        if (snapshot === null || snapshot.clientId === null) {
          return failure2("storage_unavailable");
        }
        if (snapshot.syncAccountId !== null && snapshot.syncAccountId !== scope2.accountId && this.#ports.repository.clearAccountData) {
          try {
            await this.#ports.repository.clearAccountData();
            snapshot = await this.#ports.repository.read();
          } catch {
            return failure2("storage_unavailable");
          }
          if (snapshot === null || snapshot.clientId === null) {
            return failure2("storage_unavailable");
          }
        }
        const request = savedFilterSyncRequest(snapshot, scope2.accountId);
        if (request === null) return failure2("storage_unavailable");
        let execution = await this.#execute(request);
        if (generation !== this.#generation) return failure2("stale");
        if (execution.kind === "auth_rejected" && execution.recovery === "connected") {
          const recoveredScope = this.#ports.session.publicationScope();
          if (recoveredScope === null || recoveredScope.accountId !== scope2.accountId) {
            return failure2("stale");
          }
          scope2 = recoveredScope;
          execution = await this.#execute(request);
          if (generation !== this.#generation) return failure2("stale");
        }
        if (execution.kind === "auth_rejected") return failure2("auth_expired");
        if (execution.kind !== "published") {
          return failure2(execution.kind === "stale" ? "stale" : "unavailable");
        }
        const outcome = execution.value;
        if (outcome.kind === "rejected") {
          return failure2(outcome.reason, outcome.limit);
        }
        if (outcome.kind === "invalid_response") return failure2("invalid_response");
        if (outcome.kind === "unavailable") return failure2("unavailable");
        if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
          return failure2("stale");
        }
        const merged = await this.#ports.repository.merge(
          scope2,
          outcome.data,
          new Set(request.deletes.map((item) => item.clientId)),
          this.#ports.clock.now()
        );
        if (merged.kind !== "published") {
          return failure2(
            merged.kind === "stale" ? "stale" : "storage_unavailable"
          );
        }
        requests += 1;
        lastSyncVersion = merged.snapshot.syncVersion ?? "";
        if (!savedFilterSnapshotHasPending(merged.snapshot)) {
          return Object.freeze({
            kind: "completed",
            syncVersion: lastSyncVersion,
            requests
          });
        }
      }
      return Object.freeze({
        kind: "partial",
        syncVersion: lastSyncVersion,
        requests
      });
    }
    #execute(request) {
      return this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.sync(credential, request)
      );
    }
  };

  // src/extension-core/session-service.mts
  var CAPABILITY_MARKER = Symbol("trace.extension.session-capability");
  function disconnectedEnvelope(epoch) {
    return Object.freeze({
      version: SESSION_ENVELOPE_VERSION,
      epoch,
      desired: "disconnected",
      accountId: null,
      credentialRef: null
    });
  }
  function connectedEnvelope(epoch, credentialRef, accountId) {
    return Object.freeze({
      version: SESSION_ENVELOPE_VERSION,
      epoch,
      desired: "connected",
      accountId,
      credentialRef
    });
  }
  function isRecord4(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isNonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0;
  }
  function normalizeAcquisition(value) {
    if (!isRecord4(value)) return { kind: "unavailable" };
    if (value.kind === "credential") {
      return isNonEmpty(value.credential) ? { kind: "credential", credential: value.credential } : { kind: "unavailable" };
    }
    if (value.kind === "absent" || value.kind === "cancelled" || value.kind === "unavailable") {
      return { kind: value.kind };
    }
    return { kind: "unavailable" };
  }
  function normalizeVerification(value) {
    if (!isRecord4(value)) return { kind: "invalid_response" };
    if (value.kind === "verified") {
      return isNonEmpty(value.accountId) ? { kind: "verified", accountId: value.accountId } : { kind: "invalid_response" };
    }
    if (value.kind === "rejected" || value.kind === "account_unavailable" || value.kind === "invalid_response" || value.kind === "unavailable") {
      return { kind: value.kind };
    }
    return { kind: "invalid_response" };
  }
  function normalizeEffectResult(value) {
    if (!isRecord4(value)) return { kind: "unavailable" };
    if (value.kind === "success" && Object.hasOwn(value, "value")) {
      return { kind: "success", value: value.value };
    }
    if (value.kind === "auth_rejected" || value.kind === "unavailable") {
      return { kind: value.kind };
    }
    return { kind: "unavailable" };
  }
  function createCapability(accountId, epoch, credential) {
    return Object.freeze({
      [CAPABILITY_MARKER]: true,
      accountId,
      epoch,
      credential
    });
  }
  var SessionService = class {
    #ports;
    #model = INITIAL_SESSION_MODEL;
    #envelope = INITIAL_SESSION_ENVELOPE;
    #reservation = 0;
    #capability = null;
    #activeAcquisitionEpoch = null;
    #lockTail = Promise.resolve();
    #initialization = null;
    #start = null;
    #providerSynchronization = null;
    constructor(ports) {
      this.#ports = ports;
    }
    snapshot() {
      return toSessionSnapshot(this.#model);
    }
    /**
     * Whether the stored session remembers an account it has verified. A
     * session that needs recovery before any account was verified belongs to a
     * reader who is still connecting for the first time.
     */
    hasVerifiedAccount() {
      return this.#envelope.accountId !== null;
    }
    publicationScope() {
      return this.#copyScope(this.#model.publicationScope);
    }
    displayScope() {
      return this.#copyScope(this.#model.displayScope);
    }
    start() {
      this.#start ??= this.#startOnce();
      return this.#start.then(() => this.snapshot());
    }
    async connect() {
      await this.#ensureInitialized();
      const start = await this.#withLock(async () => {
        if (this.#model.state !== "signed_out") return null;
        const epoch = this.#reserveNextEpoch();
        const persisted = await this.#persist(disconnectedEnvelope(epoch));
        if (!persisted) return { epoch, persisted: false };
        this.#transition({ type: "connecting", epoch });
        this.#activeAcquisitionEpoch = epoch;
        return { epoch, persisted: true };
      });
      if (start === null) return { kind: "ignored" };
      if (!start.persisted) return { kind: "storage_error" };
      let acquisition;
      try {
        acquisition = normalizeAcquisition(
          await this.#ports.credentials.acquire("connect")
        );
      } catch {
        this.#record("credential_provider_failed");
        acquisition = { kind: "unavailable" };
      }
      if (acquisition.kind === "unavailable") {
        this.#record("credential_provider_failed");
      }
      if (acquisition.kind === "cancelled") {
        return this.#disconnectInternal(true, start.epoch);
      }
      if (acquisition.kind !== "credential") {
        const reason = acquisition.kind === "absent" ? "credential_absent" : "provider_unavailable";
        return this.#withLock(async () => {
          if (!this.#isCurrentAcquisition(start.epoch)) return { kind: "stale" };
          this.#activeAcquisitionEpoch = null;
          this.#transition({ type: "signed_out", epoch: start.epoch, reason });
          return { kind: "unavailable" };
        });
      }
      const stillCurrent = await this.#withLock(async () => this.#isCurrentAcquisition(start.epoch));
      if (!stillCurrent) {
        this.#record("stale_effect_discarded");
        return { kind: "stale" };
      }
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          acquisition.credential,
          start.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        this.#record("credential_provider_failed");
        return this.#withLock(async () => {
          if (!this.#isCurrentAcquisition(start.epoch)) return { kind: "stale" };
          this.#activeAcquisitionEpoch = null;
          this.#transition({
            type: "signed_out",
            epoch: start.epoch,
            reason: "provider_unavailable"
          });
          return { kind: "unavailable" };
        });
      }
      const admission = await this.#withLock(async () => {
        if (!this.#isCurrentAcquisition(start.epoch)) {
          this.#scheduleCredentialDelete(credentialRef);
          return "stale";
        }
        this.#activeAcquisitionEpoch = null;
        const persisted = await this.#persist(
          connectedEnvelope(start.epoch, credentialRef, null)
        );
        if (!persisted) {
          this.#scheduleCredentialDelete(credentialRef);
          return "storage_error";
        }
        this.#transition({ type: "verifying", epoch: start.epoch, accountId: null });
        return "admitted";
      });
      if (admission !== "admitted") {
        this.#record("stale_effect_discarded");
        return { kind: admission };
      }
      return this.#verifyCredential({
        epoch: start.epoch,
        credentialRef,
        expectedAccountId: null,
        rejectionPolicy: "reconnect"
      }, acquisition.credential);
    }
    async cancelConnect() {
      await this.#ensureInitialized();
      return this.#disconnectInternal(true);
    }
    async disconnect() {
      await this.#ensureInitialized();
      return this.#disconnectInternal(false);
    }
    async reconnect() {
      const disconnected = await this.disconnect();
      if (disconnected.kind !== "completed" || disconnected.state !== "signed_out") {
        return disconnected;
      }
      return this.connect();
    }
    /**
     * Aligns an authenticated worker with its external credential provider
     * without treating every check as an account transition.
     *
     * A matching credential is a no-op. A rotated credential for the same
     * account replaces only the private capability and keeps the account epoch
     * stable. A genuinely different account takes a fenced account-transition
     * path. Temporary provider failures refuse the caller's mutation but retain
     * the last verified display/session state.
     */
    synchronizeProviderCredential() {
      if (this.#providerSynchronization !== null) {
        return this.#providerSynchronization;
      }
      const operation = this.#synchronizeProviderCredentialOnce();
      this.#providerSynchronization = operation;
      void operation.then(
        () => {
          if (this.#providerSynchronization === operation) {
            this.#providerSynchronization = null;
          }
        },
        () => {
          if (this.#providerSynchronization === operation) {
            this.#providerSynchronization = null;
          }
        }
      );
      return operation;
    }
    async retry() {
      await this.#ensureInitialized();
      const storageRetry = await this.#withLock(async () => this.#model.state === "degraded" && this.#model.reason === "storage_unavailable" ? { epoch: this.#reservation } : null);
      if (storageRetry !== null) return this.#retryStorageRead(storageRetry.epoch);
      const plan = await this.#withLock(async () => {
        if (this.#model.state !== "degraded" || this.#envelope.desired !== "connected" || this.#envelope.credentialRef === null) {
          return null;
        }
        this.#transition({
          type: "verifying",
          epoch: this.#reservation,
          accountId: this.#envelope.accountId
        });
        return {
          epoch: this.#reservation,
          credentialRef: this.#envelope.credentialRef,
          expectedAccountId: this.#envelope.accountId,
          rejectionPolicy: this.#envelope.accountId === null ? "reconnect" : "refresh"
        };
      });
      if (plan === null) return { kind: "ignored" };
      return this.#verifyPersisted(plan);
    }
    async refreshForExpiry() {
      await this.#ensureInitialized();
      const capability = await this.#withLock(async () => this.#capability);
      if (capability === null) return { kind: "ignored" };
      return this.#refreshFromCapability(capability, "expiry");
    }
    async #synchronizeProviderCredentialOnce() {
      await this.#ensureInitialized();
      const capability = await this.#withLock(async () => this.#capability);
      if (capability === null) {
        return this.#model.state === "signed_out" ? this.connect() : this.reconnect();
      }
      let acquisition;
      try {
        acquisition = normalizeAcquisition(
          await this.#ports.credentials.acquire("refresh")
        );
      } catch {
        this.#record("credential_provider_failed");
        return { kind: "unavailable" };
      }
      if (acquisition.kind === "unavailable" || acquisition.kind === "cancelled") {
        this.#record("credential_provider_failed");
        return { kind: "unavailable" };
      }
      if (acquisition.kind === "absent") {
        return this.disconnect();
      }
      if (acquisition.credential === capability.credential) {
        return this.#withLock(
          async () => this.#isCurrentCapability(capability) ? { kind: "completed", state: "connected" } : { kind: "stale" }
        );
      }
      let verification;
      try {
        verification = normalizeVerification(
          await this.#ports.api.verifyCredential(acquisition.credential)
        );
      } catch {
        this.#record("verification_failed");
        return { kind: "unavailable" };
      }
      if (verification.kind === "unavailable" || verification.kind === "invalid_response") {
        this.#record("verification_failed");
        return { kind: "unavailable" };
      }
      if (verification.kind === "rejected" || verification.kind === "account_unavailable") {
        return this.disconnect();
      }
      if (verification.accountId !== capability.accountId) {
        return this.#switchToVerifiedProviderCredential(
          capability,
          acquisition.credential,
          verification.accountId
        );
      }
      const stillCurrent = await this.#withLock(
        async () => this.#isCurrentCapability(capability)
      );
      if (!stillCurrent) {
        this.#record("stale_effect_discarded");
        return { kind: "stale" };
      }
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          acquisition.credential,
          capability.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        this.#record("credential_provider_failed");
        return { kind: "unavailable" };
      }
      const committed = await this.#commitSynchronizedCredential(
        capability,
        credentialRef,
        acquisition.credential
      );
      if (committed.kind !== "completed" || committed.state !== "connected") {
        this.#scheduleCredentialDelete(credentialRef);
      }
      return committed;
    }
    /** Credential-free private-controller fence for native handoffs. Captures
     * capability identity, including same-account provider replacement, without
     * lending credentials or degrading connectivity on local transport errors. */
    async executeCurrentScope(effect) {
      await this.#ensureInitialized();
      const capability = await this.#withLock(async () => this.#capability);
      if (capability === null) return { kind: "unavailable" };
      const isCurrent = () => this.#withLock(async () => this.#isCurrentCapability(capability));
      try {
        const value = await effect(Object.freeze({
          accountId: capability.accountId,
          epoch: capability.epoch
        }), isCurrent);
        return await isCurrent() ? { kind: "published", value } : { kind: "stale" };
      } catch {
        return { kind: await isCurrent() ? "unavailable" : "stale" };
      }
    }
    // This boundary is for the authenticated API adapter, not UI/content
    // surfaces. The production import gate must keep raw credentials confined to
    // that adapter when the kernel is wired in a later slice.
    async executeAuthenticated(effect) {
      await this.#ensureInitialized();
      const capability = await this.#withLock(async () => this.#capability);
      if (capability === null) return { kind: "unavailable" };
      let result;
      try {
        result = normalizeEffectResult(await effect(capability.credential));
      } catch {
        result = { kind: "unavailable" };
      }
      if (result.kind === "success") {
        return this.#withLock(async () => {
          if (!this.#isCurrentCapability(capability)) {
            this.#record("stale_effect_discarded");
            return { kind: "stale" };
          }
          return { kind: "published", value: result.value };
        });
      }
      if (result.kind === "unavailable") {
        return this.#withLock(async () => {
          if (!this.#isCurrentCapability(capability)) return { kind: "stale" };
          this.#capability = null;
          const scope2 = {
            accountId: capability.accountId,
            epoch: capability.epoch
          };
          this.#transition({
            type: "degraded",
            epoch: capability.epoch,
            displayScope: scope2,
            reason: "verification_unavailable"
          });
          return { kind: "unavailable" };
        });
      }
      const refresh = await this.#refreshFromCapability(capability, "rejection");
      if (refresh.kind === "stale" || refresh.kind === "ignored") {
        return { kind: "auth_rejected", recovery: "stale" };
      }
      return {
        kind: "auth_rejected",
        recovery: this.#model.state === "connected" ? "connected" : "reconnect_required"
      };
    }
    async #startOnce() {
      const plan = await this.#ensureInitialized();
      if (plan !== null) await this.#verifyPersisted(plan);
      return this.snapshot();
    }
    #ensureInitialized() {
      this.#initialization ??= this.#initializeEnvelope();
      return this.#initialization;
    }
    async #initializeEnvelope() {
      let raw;
      try {
        raw = await this.#ports.storage.read();
      } catch {
        return this.#withLock(async () => {
          this.#record("storage_read_failed");
          this.#transition({
            type: "degraded",
            epoch: this.#reservation,
            displayScope: null,
            reason: "storage_unavailable"
          });
          return null;
        });
      }
      const parsed = parseSessionEnvelope(raw);
      return this.#withLock(async () => this.#applyParsedEnvelope(parsed));
    }
    async #retryStorageRead(expectedEpoch) {
      let raw;
      try {
        raw = await this.#ports.storage.read();
      } catch {
        this.#record("storage_read_failed");
        return { kind: "unavailable" };
      }
      const parsed = parseSessionEnvelope(raw);
      const applied = await this.#withLock(async () => {
        if (this.#reservation !== expectedEpoch || this.#model.state !== "degraded" || this.#model.reason !== "storage_unavailable") {
          return { kind: "stale", plan: null };
        }
        return { kind: "applied", plan: this.#applyParsedEnvelope(parsed) };
      });
      if (applied.kind === "stale") return { kind: "stale" };
      if (applied.plan === null) {
        const state = this.#model.state;
        if (state === "signed_out" || state === "reconnect_required") {
          return { kind: "completed", state };
        }
        return { kind: "ignored" };
      }
      return this.#verifyPersisted(applied.plan);
    }
    #applyParsedEnvelope(parsed) {
      if (parsed.kind === "missing") {
        this.#envelope = INITIAL_SESSION_ENVELOPE;
        this.#reservation = 0;
        this.#transition({ type: "signed_out", epoch: 0 });
        return null;
      }
      if (parsed.kind === "invalid") {
        this.#envelope = INITIAL_SESSION_ENVELOPE;
        this.#reservation = 0;
        this.#transition({
          type: "reconnect_required",
          epoch: 0,
          reason: parsed.reason
        });
        return null;
      }
      this.#envelope = parsed.envelope;
      this.#reservation = parsed.envelope.epoch;
      if (parsed.envelope.desired === "disconnected") {
        this.#transition({ type: "signed_out", epoch: this.#reservation });
        return null;
      }
      if (parsed.envelope.credentialRef === null) {
        this.#transition({
          type: "reconnect_required",
          epoch: this.#reservation,
          reason: "credential_absent"
        });
        return null;
      }
      this.#transition({
        type: "verifying",
        epoch: this.#reservation,
        accountId: parsed.envelope.accountId
      });
      return {
        epoch: this.#reservation,
        credentialRef: parsed.envelope.credentialRef,
        expectedAccountId: parsed.envelope.accountId,
        rejectionPolicy: parsed.envelope.accountId === null ? "reconnect" : "refresh"
      };
    }
    async #verifyPersisted(plan) {
      let credential;
      try {
        credential = await this.#ports.credentials.load(plan.credentialRef);
      } catch {
        this.#record("credential_provider_failed");
        return this.#degradeVerification(plan);
      }
      if (credential === null || !isNonEmpty(credential)) {
        return this.#clearCredentialReference(plan.epoch, "credential_absent");
      }
      return this.#verifyCredential(plan, credential);
    }
    async #verifyCredential(plan, credential) {
      let verification;
      try {
        verification = normalizeVerification(
          await this.#ports.api.verifyCredential(credential)
        );
      } catch {
        verification = { kind: "unavailable" };
      }
      if (verification.kind === "unavailable") {
        this.#record("verification_failed");
        return this.#degradeVerification(plan);
      }
      if (verification.kind === "invalid_response") {
        return this.#clearCredentialReference(plan.epoch, "invalid_account_response");
      }
      if (verification.kind === "account_unavailable") {
        return this.#clearCredentialReference(plan.epoch, "account_unavailable");
      }
      if (verification.kind === "rejected") {
        if (plan.rejectionPolicy === "reconnect") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        const refreshPlan = await this.#withLock(async () => {
          if (!this.#isCurrentEpoch(plan.epoch)) return null;
          return {
            epoch: plan.epoch,
            expectedAccountId: plan.expectedAccountId ?? "",
            oldCredentialRef: plan.credentialRef,
            reason: "rejection"
          };
        });
        if (refreshPlan === null) return { kind: "stale" };
        return this.#performRefresh(refreshPlan);
      }
      if (!isNonEmpty(verification.accountId)) {
        return this.#clearCredentialReference(plan.epoch, "identity_conflict");
      }
      if (plan.expectedAccountId !== null && verification.accountId !== plan.expectedAccountId) {
        return this.#clearCredentialReference(plan.epoch, "identity_conflict");
      }
      return this.#commitVerified(
        plan.epoch,
        plan.credentialRef,
        verification.accountId,
        credential
      );
    }
    async #refreshFromCapability(capability, reason) {
      const plan = await this.#withLock(async () => {
        if (!this.#isCurrentCapability(capability)) return null;
        if (this.#envelope.credentialRef === null) return null;
        this.#capability = null;
        this.#transition({
          type: "verifying",
          epoch: capability.epoch,
          accountId: capability.accountId
        });
        return {
          epoch: capability.epoch,
          expectedAccountId: capability.accountId,
          oldCredentialRef: this.#envelope.credentialRef,
          reason
        };
      });
      if (plan === null) return { kind: "stale" };
      return this.#performRefresh(plan);
    }
    async #performRefresh(plan) {
      let acquisition;
      try {
        acquisition = normalizeAcquisition(
          await this.#ports.credentials.acquire("refresh")
        );
      } catch {
        this.#record("credential_provider_failed");
        acquisition = { kind: "unavailable" };
      }
      if (acquisition.kind === "unavailable") {
        this.#record("credential_provider_failed");
      }
      if (acquisition.kind !== "credential") {
        if (plan.reason === "rejection") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        return this.#degradeRefresh(plan);
      }
      let verification;
      try {
        verification = normalizeVerification(
          await this.#ports.api.verifyCredential(acquisition.credential)
        );
      } catch {
        verification = { kind: "unavailable" };
      }
      if (verification.kind === "unavailable") {
        if (plan.reason === "rejection") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        return this.#degradeRefresh(plan);
      }
      if (verification.kind === "invalid_response") {
        return this.#clearCredentialReference(plan.epoch, "invalid_account_response");
      }
      if (verification.kind === "account_unavailable") {
        return this.#clearCredentialReference(plan.epoch, "account_unavailable");
      }
      if (verification.kind === "rejected" || plan.expectedAccountId.length > 0 && verification.accountId !== plan.expectedAccountId) {
        return this.#clearCredentialReference(
          plan.epoch,
          verification.kind === "rejected" ? "credential_rejected" : "identity_conflict"
        );
      }
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          acquisition.credential,
          plan.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        if (plan.reason === "rejection") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        return this.#degradeRefresh(plan);
      }
      const accountId = plan.expectedAccountId.length > 0 ? plan.expectedAccountId : verification.accountId;
      const committed = await this.#commitVerified(
        plan.epoch,
        credentialRef,
        accountId,
        acquisition.credential,
        plan.oldCredentialRef
      );
      if (committed.kind !== "completed" || committed.state !== "connected") {
        this.#scheduleCredentialDelete(credentialRef);
        return committed;
      }
      return committed;
    }
    async #degradeVerification(plan) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(plan.epoch)) return { kind: "stale" };
        const displayScope = plan.expectedAccountId === null ? null : { accountId: plan.expectedAccountId, epoch: plan.epoch };
        this.#transition({
          type: "degraded",
          epoch: plan.epoch,
          displayScope,
          reason: "verification_unavailable"
        });
        return { kind: "unavailable" };
      });
    }
    async #degradeRefresh(plan) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(plan.epoch)) return { kind: "stale" };
        this.#transition({
          type: "degraded",
          epoch: plan.epoch,
          displayScope: {
            accountId: plan.expectedAccountId,
            epoch: plan.epoch
          },
          reason: "verification_unavailable"
        });
        return { kind: "unavailable" };
      });
    }
    async #commitVerified(epoch, credentialRef, accountId, credential, cleanupReference = null) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(epoch)) {
          this.#record("stale_effect_discarded");
          return { kind: "stale" };
        }
        const persisted = await this.#persist(
          connectedEnvelope(epoch, credentialRef, accountId)
        );
        if (!persisted) return { kind: "storage_error" };
        this.#capability = createCapability(accountId, epoch, credential);
        this.#transition({ type: "connected", scope: { accountId, epoch } });
        if (cleanupReference !== null && cleanupReference !== credentialRef) {
          this.#scheduleCredentialDelete(cleanupReference);
        }
        return { kind: "completed", state: "connected" };
      });
    }
    async #commitSynchronizedCredential(expectedCapability, credentialRef, credential) {
      return this.#withLock(async () => {
        if (!this.#isCurrentCapability(expectedCapability)) {
          this.#record("stale_effect_discarded");
          return { kind: "stale" };
        }
        const oldReference = this.#envelope.credentialRef;
        const persisted = await this.#persist(
          connectedEnvelope(
            expectedCapability.epoch,
            credentialRef,
            expectedCapability.accountId
          )
        );
        if (!persisted) return { kind: "storage_error" };
        this.#capability = createCapability(
          expectedCapability.accountId,
          expectedCapability.epoch,
          credential
        );
        this.#transition({
          type: "connected",
          scope: {
            accountId: expectedCapability.accountId,
            epoch: expectedCapability.epoch
          }
        });
        if (oldReference !== null && oldReference !== credentialRef) {
          this.#scheduleCredentialDelete(oldReference);
        }
        return { kind: "completed", state: "connected" };
      });
    }
    async #switchToVerifiedProviderCredential(expectedCapability, credential, accountId) {
      const transition = await this.#withLock(async () => {
        if (!this.#isCurrentCapability(expectedCapability)) {
          this.#record("stale_effect_discarded");
          return { kind: "stale" };
        }
        const oldReference = this.#envelope.credentialRef;
        const epoch = this.#reserveNextEpoch();
        const persisted = await this.#persist(disconnectedEnvelope(epoch));
        if (!persisted) return { kind: "storage_error" };
        this.#transition({ type: "connecting", epoch });
        this.#activeAcquisitionEpoch = epoch;
        return { kind: "ready", epoch, oldReference };
      });
      if (transition.kind !== "ready") return transition;
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          credential,
          transition.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        this.#record("credential_provider_failed");
        return this.#withLock(async () => {
          if (!this.#isCurrentAcquisition(transition.epoch)) {
            return { kind: "stale" };
          }
          this.#activeAcquisitionEpoch = null;
          this.#transition({
            type: "signed_out",
            epoch: transition.epoch,
            reason: "provider_unavailable"
          });
          if (transition.oldReference !== null) {
            this.#scheduleCredentialDelete(transition.oldReference);
          }
          return { kind: "unavailable" };
        });
      }
      const admitted = await this.#withLock(async () => {
        if (!this.#isCurrentAcquisition(transition.epoch)) {
          this.#record("stale_effect_discarded");
          this.#scheduleCredentialDelete(credentialRef);
          return false;
        }
        this.#activeAcquisitionEpoch = null;
        return true;
      });
      if (!admitted) return { kind: "stale" };
      const committed = await this.#commitVerified(
        transition.epoch,
        credentialRef,
        accountId,
        credential,
        transition.oldReference
      );
      if (committed.kind !== "completed" || committed.state !== "connected") {
        this.#scheduleCredentialDelete(credentialRef);
        if (transition.oldReference !== null) {
          this.#scheduleCredentialDelete(transition.oldReference);
        }
      }
      return committed;
    }
    async #clearCredentialReference(epoch, reason) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(epoch)) return { kind: "stale" };
        const oldReference = this.#envelope.credentialRef;
        this.#capability = null;
        const persisted = await this.#persist(
          connectedEnvelope(epoch, null, this.#envelope.accountId)
        );
        const result = persisted ? { kind: "completed", state: "reconnect_required" } : { kind: "storage_error" };
        if (persisted) {
          this.#transition({ type: "reconnect_required", epoch, reason });
        }
        if (oldReference !== null) {
          if (persisted) {
            this.#scheduleCredentialDelete(oldReference);
          } else {
            await this.#deleteCredential(oldReference);
          }
        }
        return result;
      });
    }
    async #disconnectInternal(onlyConnecting, expectedAcquisitionEpoch) {
      return this.#withLock(async () => {
        const isUnverifiedConnect = this.#model.state === "connecting" || this.#model.state === "verifying" && this.#envelope.accountId === null;
        if (onlyConnecting && !isUnverifiedConnect) {
          return expectedAcquisitionEpoch !== void 0 && !this.#isCurrentEpoch(expectedAcquisitionEpoch) ? { kind: "stale" } : { kind: "ignored" };
        }
        if (expectedAcquisitionEpoch !== void 0 && this.#activeAcquisitionEpoch !== expectedAcquisitionEpoch) {
          return { kind: "stale" };
        }
        const oldReference = this.#envelope.credentialRef;
        const epoch = this.#reserveNextEpoch();
        this.#capability = null;
        this.#activeAcquisitionEpoch = null;
        try {
          this.#ports.credentials.cancelAcquisition?.();
        } catch {
          this.#record("credential_provider_failed");
        }
        const persisted = await this.#persist(disconnectedEnvelope(epoch));
        const result = persisted ? { kind: "completed", state: "signed_out" } : { kind: "storage_error" };
        if (persisted) this.#transition({ type: "signed_out", epoch });
        if (persisted) {
          this.#scheduleCredentialClearAll();
        } else if (oldReference !== null) {
          await this.#deleteCredential(oldReference);
        }
        return result;
      });
    }
    #reserveNextEpoch() {
      if (!Number.isSafeInteger(this.#reservation + 1)) {
        throw new RangeError("session epoch exhausted");
      }
      this.#reservation += 1;
      this.#capability = null;
      return this.#reservation;
    }
    async #persist(envelope) {
      try {
        await this.#ports.storage.write(envelope);
        this.#envelope = envelope;
        return true;
      } catch {
        this.#capability = null;
        this.#transition({
          type: "reconnect_required",
          epoch: this.#reservation,
          reason: "storage_write_failed"
        });
        this.#record("storage_write_failed");
        return false;
      }
    }
    async #deleteCredential(reference) {
      try {
        await this.#ports.credentials.delete(reference);
      } catch {
        this.#record("credential_cleanup_failed");
      }
    }
    #scheduleCredentialDelete(reference) {
      void this.#deleteCredential(reference);
    }
    #scheduleCredentialClearAll() {
      try {
        void this.#ports.credentials.clearAll().catch(() => {
          this.#record("credential_cleanup_failed");
        });
      } catch {
        this.#record("credential_cleanup_failed");
      }
    }
    #copyScope(scope2) {
      return scope2 === null ? null : Object.freeze({ accountId: scope2.accountId, epoch: scope2.epoch });
    }
    #isCurrentEpoch(epoch) {
      return this.#reservation === epoch && this.#envelope.epoch === epoch;
    }
    #isCurrentAcquisition(epoch) {
      return this.#isCurrentEpoch(epoch) && this.#activeAcquisitionEpoch === epoch && this.#model.state === "connecting";
    }
    #isCurrentCapability(capability) {
      return this.#capability === capability && this.#reservation === capability.epoch && this.#model.state === "connected";
    }
    #transition(event) {
      this.#model = reduceSession(this.#model, event);
      this.#record("session_state_changed");
    }
    #record(code) {
      try {
        this.#ports.diagnostics.record({
          code,
          state: this.#model.state,
          epoch: this.#reservation
        });
      } catch {
      }
    }
    async #withLock(work) {
      const previous = this.#lockTail;
      let release = () => {
      };
      this.#lockTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-core/story-command.mts
  function failure3(reason) {
    return Object.freeze({ kind: "failed", reason });
  }
  function executionFailure3(result) {
    if (result.kind === "stale") return failure3("stale");
    if (result.kind === "auth_rejected") return failure3("auth_expired");
    return failure3("not_authenticated");
  }
  function confirmationSatisfiesStoryCommand(command, confirmation) {
    if (confirmation.workKey !== command.workKey) return false;
    if (command.intent === "ensure_saved") return true;
    const target = command.progress;
    const chapters = confirmation.entry.chapters;
    if (target === void 0 || chapters === void 0) return false;
    if (chapters.current < target.current) return false;
    return target.total === null || chapters.total !== null && chapters.total >= target.total;
  }
  var StoryCommandService = class {
    #ports;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    execute(command) {
      return this.executeWithEvidence(command).then(({ result }) => result);
    }
    /**
     * The same save, with what is known about its write to Trace. `beforeWrite`
     * is awaited just before each write is handed to the network, so a caller
     * can record that a write is going out; what it does cannot stop the save.
     */
    executeWithEvidence(command, observer) {
      const ownedCommand = { ...command, payload: { ...command.payload } };
      return this.#withLock(async () => {
        const write = {
          handedOver: false,
          refused: false,
          before: async () => {
            try {
              await observer?.beforeWrite?.();
            } catch {
            }
          }
        };
        const result = await this.#execute(ownedCommand, write);
        const dispatch = result.kind === "confirmed" ? "confirmed" : !write.handedOver ? "never_sent" : write.refused ? "refused" : "sent_unconfirmed";
        return Object.freeze({ result, dispatch });
      });
    }
    /**
     * Whether the story is in the current account's Library right now. It reads
     * and nothing else: no save is sent, nothing is published, no receipt goes
     * to the app. An answer for an account that changed meanwhile is unknown.
     */
    async presence(workKey) {
      const unknown = Object.freeze({ kind: "unknown" });
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return unknown;
      let lookup;
      try {
        lookup = await this.#lookup(workKey, true);
      } catch {
        return unknown;
      }
      if (lookup.kind !== "published" || lookup.value.kind !== "found" || lookup.value.confirmation.workKey !== workKey || !sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return unknown;
      }
      return Object.freeze({ kind: "found", confirmation: lookup.value.confirmation });
    }
    async #execute(command, write) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failure3("not_authenticated");
      let context;
      try {
        context = await this.#ports.receipt.prepareSaveReceipt?.(scope2.accountId);
      } catch {
      }
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) return failure3("stale");
      if (command.intent === "ensure_saved") {
        const lookup = await this.#lookup(command.workKey, true);
        if (lookup.kind !== "published") return executionFailure3(lookup);
        if (lookup.value.kind === "found" && confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)) {
          return this.#finalize(scope2, command, lookup.value.confirmation, "preflight", context);
        }
        if (lookup.value.kind === "invalid_response") return failure3("invalid_response");
        if (lookup.value.kind === "unavailable") return failure3("unavailable");
      }
      const { mode: stampedMode, ...unstamped } = command;
      void stampedMode;
      const trackCommand = { ...unstamped };
      const track = async (credential) => {
        const { attempt_id: ignored, ...payload } = command.payload;
        const id = context?.setupAttemptID;
        const expiresAt = context?.setupAttemptExpiresAt;
        const now = this.#ports.clock.now();
        const valid = sameAccountScope(this.#ports.session.publicationScope(), scope2) && typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > now && expiresAt - now <= 864e5;
        trackCommand.payload = { ...payload, ...valid ? { attempt_id: id.toLowerCase() } : {} };
        write.handedOver = true;
        write.refused = false;
        await write.before();
        return this.#ports.api.track(credential, trackCommand).then((outcome) => {
          write.refused = outcome.kind === "auth_rejected" || outcome.kind === "success" && outcome.value.kind === "rejected";
          return outcome;
        });
      };
      let mutation = await this.#ports.session.executeAuthenticated(track);
      if (mutation.kind === "auth_rejected" && mutation.recovery === "connected") {
        if (command.intent === "ensure_saved") {
          const lookup = await this.#lookup(command.workKey, false);
          if (lookup.kind !== "published") return executionFailure3(lookup);
          if (lookup.value.kind === "found" && confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)) {
            return this.#finalize(scope2, command, lookup.value.confirmation, "preflight", context);
          }
          if (lookup.value.kind === "invalid_response") return failure3("invalid_response");
          if (lookup.value.kind === "unavailable") return failure3("unavailable");
        }
        mutation = await this.#ports.session.executeAuthenticated(track);
      }
      if (mutation.kind !== "published") return executionFailure3(mutation);
      if (mutation.value.kind === "confirmed") {
        if (!confirmationSatisfiesStoryCommand(command, mutation.value.confirmation)) {
          return failure3("confirmation_missing");
        }
        return this.#finalize(scope2, command, mutation.value.confirmation, "mutation", context);
      }
      if (mutation.value.kind === "rejected") return failure3(mutation.value.reason);
      if (mutation.value.kind === "invalid_response") return failure3("invalid_response");
      const reconciliation = await this.#lookup(command.workKey, false);
      if (reconciliation.kind !== "published") return executionFailure3(reconciliation);
      if (reconciliation.value.kind === "found" && confirmationSatisfiesStoryCommand(
        command,
        reconciliation.value.confirmation
      )) {
        return this.#finalize(
          scope2,
          command,
          reconciliation.value.confirmation,
          "reconciliation",
          context
        );
      }
      if (reconciliation.value.kind === "invalid_response") {
        return failure3("invalid_response");
      }
      return failure3(
        reconciliation.value.kind === "unavailable" ? "unavailable" : "confirmation_missing"
      );
    }
    async #lookup(workKey, allowAuthRecovery) {
      let result = await this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.lookup(credential, workKey)
      );
      if (allowAuthRecovery && result.kind === "auth_rejected" && result.recovery === "connected") {
        result = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.lookup(credential, workKey)
        );
      }
      return result;
    }
    async #finalize(scope2, command, confirmation, source, context) {
      if (confirmation.workKey !== command.workKey || !sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure3("stale");
      }
      let projection;
      try {
        projection = await this.#ports.projection.publishConfirmed(scope2, confirmation);
      } catch {
        projection = { kind: "unavailable" };
      }
      if (projection.kind === "rejected_scope") return failure3("stale");
      if (projection.kind === "stale_write") return failure3("stale");
      if (projection.kind === "invalid_model") return failure3("invalid_response");
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure3("stale");
      }
      let receipt;
      try {
        receipt = await this.#ports.receipt.publishSaveReceipt({
          accountID: scope2.accountId,
          entryID: confirmation.entryId,
          workKey: confirmation.workKey,
          source,
          ...command.mode === void 0 ? {} : { mode: command.mode },
          ...context === void 0 ? {} : { context },
          hostKind: command.hostKind,
          action: command.intent === "ensure_saved" ? "quick_add" : "read",
          at: this.#ports.clock.now(),
          ...command.handoffId === void 0 ? {} : { handoffId: command.handoffId }
        }) ? "published" : "unavailable";
      } catch {
        receipt = "unavailable";
      }
      let handoff = "not_present";
      if (command.intent === "ensure_saved" && command.handoffId !== void 0) {
        try {
          handoff = await this.#ports.handoff.clearExpected(command.handoffId) ? "cleared" : "unavailable";
        } catch {
          handoff = "unavailable";
        }
      }
      return Object.freeze({
        kind: "confirmed",
        intent: command.intent,
        confirmation,
        source,
        projection: projection.kind === "published" ? "published" : "unavailable",
        receipt,
        handoff
      });
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-runtime/browser-adapters.mts
  var LEGACY_SESSION_ENVELOPE_KEY = "traceSessionEnvelopeV1";
  var LEGACY_SESSION_CREDENTIALS_KEY = "traceSessionCredentialsV1";
  var UUID_PATTERN3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var ACCOUNT_DATA_ALARM = "traceAccountDataRefresh";
  var SAVED_FILTER_SYNC_ALARM = "traceAo3SavedFiltersSync";
  var ARCHIVE_ACCESS_REPORT_ALARM = "traceArchiveAccessReport";
  var LEGACY_ACCOUNT_ALARMS = Object.freeze([
    "traceLibraryOverlay"
  ]);
  var SAVED_FILTER_LOCAL_KEYS = Object.freeze({
    presets: "traceAo3SavedFiltersV1",
    deleted: "traceAo3SavedFiltersDeletedV1",
    syncMeta: "traceAo3SavedFiltersSyncV1",
    clientId: "traceAo3SavedFiltersClientIdV1",
    activeMeta: "traceAo3SavedFiltersActiveV1"
  });
  var LEGACY_ACCOUNT_KEYS = Object.freeze([
    LEGACY_SESSION_ENVELOPE_KEY,
    LEGACY_SESSION_CREDENTIALS_KEY,
    "authToken",
    "traceAuthState",
    "traceAccountId",
    "libraryOverlayCache",
    "libraryOverlayFetchedAt",
    "traceWorkStatesV1",
    "traceUserPro",
    "traceLibraryCount",
    "traceFirstSaveSeen",
    // The AO3 summary fill, removed in 1.0.5: its work ids and local state.
    "traceAo3SummaryAttemptedV1",
    "traceAo3SummaryFillV1"
  ]);
  var DISABLED_LOCAL_KEYS = Object.freeze([
    ...LEGACY_ACCOUNT_KEYS,
    ...Object.values(SAVED_FILTER_LOCAL_KEYS),
    "traceArchiveReadiness",
    "traceArchiveAccessReportedAtV1",
    "traceArchiveAccessStateV1"
  ]);
  var BrowserSessionStoragePort = class {
    #database;
    constructor(database) {
      this.#database = database;
    }
    read() {
      return this.#database.get(PRIVATE_RECORD_KEYS.sessionEnvelope);
    }
    write(envelope) {
      return this.#database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, envelope);
    }
    clearAll() {
      return this.#database.delete(PRIVATE_RECORD_KEYS.sessionEnvelope);
    }
  };
  function isRecord5(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function parseCredentialStore(raw) {
    if (!isRecord5(raw) || raw.version !== 1 || !isRecord5(raw.entries)) return {};
    const entries = {};
    for (const [reference, credential] of Object.entries(raw.entries)) {
      if (reference.trim() && typeof credential === "string" && credential.trim()) {
        entries[reference] = credential;
      }
    }
    return entries;
  }
  var BrowserCredentialPort = class {
    #database;
    #provider;
    #randomId;
    #tail = Promise.resolve();
    constructor(database, provider, randomId) {
      this.#database = database;
      this.#provider = provider;
      this.#randomId = randomId;
    }
    acquire(purpose) {
      return this.#provider.acquire(purpose);
    }
    cancelAcquisition() {
      this.#provider.cancel();
    }
    load(reference) {
      return this.#withLock(async () => {
        const entries = await this.#readEntries();
        const credential = entries[reference];
        if (credential === void 0) return null;
        const upgraded = await this.#provider.upgrade?.(credential) ?? credential;
        if (upgraded !== credential) {
          entries[reference] = upgraded;
          try {
            await this.#writeEntries(entries);
          } catch (error) {
            void this.#provider.release?.(upgraded);
            throw error;
          }
        }
        return upgraded;
      });
    }
    storeUnique(credential, epoch) {
      return this.#withLock(async () => {
        const suffix = this.#randomId().trim();
        if (!suffix) throw new TypeError("credential reference is empty");
        const reference = `session:${epoch}:${suffix}`;
        const entries = await this.#readEntries();
        entries[reference] = credential;
        try {
          await this.#writeEntries(entries);
        } catch (error) {
          void this.#provider.release?.(credential);
          throw error;
        }
        return reference;
      });
    }
    delete(reference) {
      return this.#withLock(async () => {
        const entries = await this.#readEntries();
        const removed = entries[reference];
        delete entries[reference];
        if (Object.keys(entries).length === 0) {
          await this.#database.delete(PRIVATE_RECORD_KEYS.sessionCredentials);
        } else {
          await this.#writeEntries(entries);
        }
        if (removed && !Object.values(entries).includes(removed)) void this.#provider.release?.(removed);
      });
    }
    clearAll() {
      return this.#withLock(async () => {
        const entries = await this.#readEntries();
        await this.#database.delete(PRIVATE_RECORD_KEYS.sessionCredentials);
        for (const credential of new Set(Object.values(entries))) void this.#provider.release?.(credential);
      });
    }
    async #readEntries() {
      return parseCredentialStore(
        await this.#database.get(PRIVATE_RECORD_KEYS.sessionCredentials)
      );
    }
    #writeEntries(entries) {
      const value = Object.freeze({
        version: 1,
        entries: Object.freeze({ ...entries })
      });
      return this.#database.put(PRIVATE_RECORD_KEYS.sessionCredentials, value);
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
  var LegacyAccountState = class {
    #storage;
    constructor(storage) {
      this.#storage = storage;
    }
    clear() {
      return this.#storage.remove(LEGACY_ACCOUNT_KEYS);
    }
    clearAll() {
      return this.#storage.remove(DISABLED_LOCAL_KEYS);
    }
  };
  var KernelAlarmState = class {
    #alarms;
    #runtime;
    #mode;
    constructor(alarms, runtime, mode) {
      this.#alarms = alarms;
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async clearRetired() {
      for (const name of LEGACY_ACCOUNT_ALARMS) await this.#clear(name);
    }
    async clearAll() {
      await this.#clear(ACCOUNT_DATA_ALARM);
      await this.#clear(SAVED_FILTER_SYNC_ALARM);
      await this.#clear(ARCHIVE_ACCESS_REPORT_ALARM);
      await this.clearRetired();
    }
    async #clear(name) {
      await extensionCall(
        this.#alarms,
        "clear",
        [name],
        this.#runtime,
        this.#mode
      );
    }
  };
  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      promise.then((value) => finish(value), () => finish(null));
    });
  }
  async function sendNativeMessageWithFallback(runtime, mode, message, timeoutMs = 5e3, options) {
    if (typeof runtime.sendNativeMessage !== "function") return null;
    const attempts = [
      [message],
      ["com.tracefiction.trace", message]
    ];
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (const [index, args] of attempts.entries()) {
      if (index > 0 && options?.mayFallback && !await options.mayFallback()) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const response = await withTimeout(
        extensionCall(
          runtime,
          "sendNativeMessage",
          args,
          runtime,
          mode
        ).then((response2) => {
          options?.observeResponse?.(response2);
          return response2;
        }),
        remainingMs
      );
      if (response !== null) return response;
    }
    return null;
  }
  var IOS_NATIVE_CREDENTIAL_READ_BUDGET_MS = 2500;
  var IOS_NATIVE_CREDENTIAL_READ_ATTEMPT_TIMEOUT_MS = 1e3;
  var IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS = 150;
  var NativeArchiveReadinessReceiptPort = class {
    #runtime;
    #mode;
    constructor(runtime, mode) {
      this.#runtime = runtime;
      this.#mode = mode;
    }
    publishRunReceipt(receipt) {
      return this.#publish({
        type: "TRACE_IOS_EXTENSION_HEARTBEAT",
        hostKind: receipt.hostKind,
        at: receipt.at,
        ...receipt.handoffId === void 0 ? {} : { handoffId: receipt.handoffId }
      });
    }
    publishPermissionSnapshot(snapshot) {
      return this.#publish({
        type: "TRACE_IOS_EXTENSION_HEARTBEAT",
        ...snapshot.hostKind === void 0 ? {} : { hostKind: snapshot.hostKind },
        at: snapshot.at,
        permissionSnapshot: true,
        grantedOrigins: [...snapshot.grantedOrigins]
      });
    }
    async #publish(message) {
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        message
      );
      return isRecord5(response) && (response.ok === true || response.ok === "true");
    }
  };
  var NativeStorySaveReceiptPort = class {
    constructor(runtime, mode, apiOrigin = "", publishTrackingPreference) {
      this.publishTrackingPreference = publishTrackingPreference;
      this.#runtime = runtime;
      this.#mode = mode;
      this.#apiOrigin = apiOrigin;
    }
    #runtime;
    #mode;
    #apiOrigin;
    async prepareSaveReceipt(accountID) {
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        { type: "TRACE_IOS_SAVE_PREPARE", accountID, apiOrigin: this.#apiOrigin },
        1e3
      );
      return isRecord5(response) && response.ok === true && isRecord5(response.context) ? response.context : void 0;
    }
    async publishSaveReceipt(receipt) {
      let recorded = false;
      if (receipt.context !== void 0) {
        const saved = await sendNativeMessageWithFallback(this.#runtime, this.#mode, {
          type: "TRACE_IOS_SAVE_CONFIRMED",
          apiOrigin: this.#apiOrigin,
          accountID: receipt.accountID,
          entryID: receipt.entryID,
          workKey: receipt.workKey,
          source: receipt.source,
          context: receipt.context,
          ...receipt.mode === void 0 ? {} : { mode: receipt.mode }
        }, 1e3).catch(() => void 0);
        recorded = isRecord5(saved) && saved.ok === true;
      }
      const preference = this.publishTrackingPreference?.().catch(() => {
      });
      if (receipt.action === "read") {
        await preference;
        return recorded;
      }
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        {
          type: "TRACE_IOS_EXTENSION_HEARTBEAT",
          hostKind: receipt.hostKind,
          action: receipt.action,
          at: receipt.at,
          ...receipt.handoffId === void 0 ? {} : { handoffId: receipt.handoffId }
        }
      );
      await preference;
      return recorded || isRecord5(response) && (response.ok === true || response.ok === "true");
    }
  };
  var NativePendingStoryHandoffPort = class {
    #runtime;
    #mode;
    constructor(runtime, mode) {
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async clearExpected(handoffId) {
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        {
          type: "TRACE_IOS_PENDING_FIRST_STORY_CLEAR",
          handoffId
        }
      );
      return isRecord5(response) && (response.ok === true || response.ok === "true") && response.cleared !== false && response.cleared !== "false";
    }
  };
  var BrowserArchivePermissionSnapshotPort = class {
    #permissions;
    #runtime;
    #mode;
    constructor(permissions, runtime, mode) {
      this.#permissions = permissions;
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async readGrantedOrigins() {
      if (this.#permissions === void 0) return null;
      const response = await withTimeout(
        extensionCall(
          this.#permissions,
          "getAll",
          [],
          this.#runtime,
          this.#mode
        ),
        2e3
      );
      if (!isRecord5(response) || !Array.isArray(response.origins)) return null;
      return Object.freeze(
        Array.from(new Set(
          response.origins.filter((origin) => typeof origin === "string").map((origin) => origin.trim().slice(0, 256)).filter(Boolean)
        )).slice(0, 64)
      );
    }
    async containsOrigins(origins) {
      if (this.#permissions === void 0 || typeof this.#permissions.contains !== "function") {
        return null;
      }
      const response = await withTimeout(
        extensionCall(
          this.#permissions,
          "contains",
          [{ origins: [...origins] }],
          this.#runtime,
          this.#mode
        ),
        2e3
      );
      return typeof response === "boolean" ? response : null;
    }
  };
  var ExplicitCredentialProvider = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #webTabPattern;
    #randomId;
    #generation = 0;
    #isIos = null;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      const webUrl = new URL(options.webOrigin);
      this.#webOrigin = webUrl.origin;
      this.#webTabPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
      this.#randomId = options.randomId;
    }
    async acquire(purpose) {
      const generation = ++this.#generation;
      const result = await this.#detectIos() ? await this.#acquireNative(generation) : await this.#acquireFromTraceTab(purpose);
      return generation === this.#generation ? result : { kind: "cancelled" };
    }
    cancel() {
      this.#generation += 1;
    }
    isNative() {
      return this.#detectIos();
    }
    async #detectIos() {
      this.#isIos ??= (async () => {
        if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) return true;
        if (typeof this.#runtime.getPlatformInfo !== "function") return false;
        try {
          const info = await extensionCall(
            this.#runtime,
            "getPlatformInfo",
            [],
            this.#runtime,
            this.#mode
          );
          return info?.os === "ios";
        } catch {
          return false;
        }
      })();
      return this.#isIos;
    }
    async #acquireFromTraceTab(purpose) {
      if (!declaresHostPattern(this.#runtime, this.#webTabPattern)) {
        return { kind: "unavailable" };
      }
      let tabs;
      try {
        tabs = await extensionCall(
          this.#tabs,
          "query",
          [{ url: [this.#webTabPattern] }],
          this.#runtime,
          this.#mode
        );
      } catch {
        return { kind: "unavailable" };
      }
      const candidates = tabs.filter((tab) => {
        if (typeof tab.id !== "number" || typeof tab.url !== "string") return false;
        try {
          return new URL(tab.url).origin === this.#webOrigin;
        } catch {
          return false;
        }
      }).sort(
        (left, right) => Number(right.active === true) - Number(left.active === true) || (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0)
      );
      const deadline = Date.now() + 1e4;
      for (const tab of candidates) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const requestId = this.#randomId();
        const response = await withTimeout(
          extensionCall(
            this.#tabs,
            "sendMessage",
            [tab.id, {
              type: "TRACE_CREDENTIAL_GRANT_REQUEST",
              protocolVersion: 1,
              requestId,
              purpose
            }],
            this.#runtime,
            this.#mode
          ),
          remainingMs
        );
        if (!isRecord5(response) || response.requestId !== requestId) continue;
        const credential = typeof response.token === "string" ? response.token.trim() : "";
        if (response.ok === true && credential) return { kind: "credential", credential };
      }
      return { kind: "absent" };
    }
    async #acquireNativeOnce(timeoutMs) {
      const request = { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", protocolVersion: 3 };
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        request,
        timeoutMs
      );
      if (!isRecord5(response)) return { kind: "unavailable" };
      const credential = typeof response.credential === "string" ? response.credential.trim() : typeof response.token === "string" ? response.token.trim() : "";
      const credentialKind = response.credentialKind;
      const validKind = credentialKind === "device_session" || credentialKind === "access_token";
      const validDeviceMetadata = credentialKind !== "device_session" || typeof response.sessionId === "string" && UUID_PATTERN3.test(response.sessionId) && typeof response.expiresAt === "string" && Number.isFinite(Date.parse(response.expiresAt));
      if ((response.ok === true || response.ok === "true") && credential && validKind && validDeviceMetadata) {
        return { kind: "credential", credential };
      }
      return response.error === "missing_token" ? { kind: "absent" } : { kind: "unavailable" };
    }
    async #acquireNative(generation) {
      const deadline = Date.now() + IOS_NATIVE_CREDENTIAL_READ_BUDGET_MS;
      const read = () => this.#acquireNativeOnce(
        Math.min(
          IOS_NATIVE_CREDENTIAL_READ_ATTEMPT_TIMEOUT_MS,
          Math.max(0, deadline - Date.now())
        )
      );
      const first = await read();
      if (first.kind !== "unavailable" || generation !== this.#generation) {
        return first;
      }
      const remainingBeforeDelay = deadline - Date.now();
      if (remainingBeforeDelay <= IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS) {
        return first;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS);
      });
      if (generation !== this.#generation || Date.now() >= deadline) {
        return { kind: "cancelled" };
      }
      return read();
    }
  };
  function sanitizePendingFirstStoryResponse(response) {
    if (!isRecord5(response)) return { ok: false, error: "native_unavailable" };
    if (response.ok !== true && response.ok !== "true") {
      return { ok: false, error: "native_error" };
    }
    const sanitized = { ok: true, url: "" };
    if (typeof response.url === "string" && response.url.length <= 4096) {
      sanitized.url = response.url.trim();
    }
    if (response.mode === "story" || response.mode === "browse") {
      sanitized.mode = response.mode;
    }
    if (response.hostKind === "ao3" || response.hostKind === "ffn") {
      sanitized.hostKind = response.hostKind;
    }
    if (typeof response.handoffId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(response.handoffId.trim())) {
      sanitized.handoffId = response.handoffId.trim();
    }
    const expiresAt = typeof response.expiresAt === "number" ? response.expiresAt : typeof response.expiresAt === "string" ? Number(response.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt)) sanitized.expiresAt = expiresAt;
    if (response.expired === true || response.expired === "true") sanitized.expired = true;
    return Object.freeze(sanitized);
  }
  var NativePendingFirstStoryReader = class {
    #runtime;
    #mode;
    constructor(runtime, mode) {
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async read() {
      const request = { type: "TRACE_IOS_PENDING_FIRST_STORY_GET" };
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        request
      );
      return response === null ? { ok: false, error: "native_unavailable" } : sanitizePendingFirstStoryResponse(response);
    }
  };
  var VerificationApi = class {
    #fetch;
    #endpoint;
    #onRetryDisposition;
    constructor(fetchImpl, apiBase, onRetryDisposition = () => {
    }) {
      this.#fetch = fetchImpl;
      this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/account`;
      this.#onRetryDisposition = onRetryDisposition;
    }
    async verifyCredential(credential) {
      const response = await withTimeout(
        this.#fetch(this.#endpoint, {
          method: "GET",
          cache: "no-store",
          headers: { Authorization: `Bearer ${credential}` }
        }),
        1e4
      );
      if (response === null) {
        this.#onRetryDisposition("automatic");
        return { kind: "unavailable" };
      }
      if (response.status === 429) {
        this.#onRetryDisposition("manual");
        return { kind: "unavailable" };
      }
      if (response.status >= 500) {
        this.#onRetryDisposition("automatic");
        return { kind: "unavailable" };
      }
      this.#onRetryDisposition("none");
      if (response.status === 401 || response.status === 403) return { kind: "rejected" };
      if (!response.ok) return { kind: "account_unavailable" };
      let body;
      try {
        body = await response.json();
      } catch {
        return { kind: "invalid_response" };
      }
      if (!isRecord5(body) || typeof body.account_id !== "string" || !body.account_id.trim()) {
        return { kind: "invalid_response" };
      }
      return { kind: "verified", accountId: body.account_id.trim() };
    }
  };

  // src/extension-runtime/account-data-repository.mts
  var CAPACITY_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1e3;
  var CAPACITY_DISMISSAL_MS = 7 * 24 * 60 * 60 * 1e3;
  var AccountDataRepository = class {
    #database;
    #scopes;
    #tail = Promise.resolve();
    #overlayReservation = 0;
    #appliedOverlayReservation = 0;
    constructor(database, scopes) {
      this.#database = database;
      this.#scopes = scopes;
    }
    read() {
      return this.#withLock(async () => {
        const startingScope = this.#scopes.displayScope();
        if (startingScope === null) return null;
        const parsed = parseAccountData(
          await this.#database.get(PRIVATE_RECORD_KEYS.accountData)
        );
        if (parsed.kind === "invalid") {
          try {
            await this.#database.delete(PRIVATE_RECORD_KEYS.accountData);
          } catch {
          }
          return null;
        }
        if (parsed.kind !== "valid") return null;
        const currentScope = this.#scopes.displayScope();
        return sameAccountScope(startingScope, currentScope) && sameAccountScope(parsed.value.scope, currentScope) ? parsed.value : null;
      });
    }
    ensureScope(requestedScope) {
      return this.#publish(requestedScope, (current) => current);
    }
    publishSummary(requestedScope, value) {
      const summary = copyAccountSummary(value);
      if (summary === null) return Promise.resolve({ kind: "invalid_model" });
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        summary,
        capacityRecovery: summary.pro || current.capacityRecovery !== null && summary.libraryCount < current.capacityRecovery.blockedLibraryCount ? null : current.capacityRecovery
      }));
    }
    publishCapacityBlocked(requestedScope, at) {
      if (!Number.isSafeInteger(at) || at < 0) {
        return Promise.resolve({ kind: "invalid_model" });
      }
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        capacityRecovery: current.capacityRecovery ?? Object.freeze({
          blockedAt: at,
          blockedLibraryCount: current.summary?.libraryCount ?? 0,
          nextPromptAt: 0
        })
      }));
    }
    acknowledgeCapacityRecovery(requestedScope, acknowledgement, at) {
      if (acknowledgement !== "shown" && acknowledgement !== "dismissed" || !Number.isSafeInteger(at) || at < 0) {
        return Promise.resolve({ kind: "invalid_model" });
      }
      const delay = acknowledgement === "dismissed" ? CAPACITY_DISMISSAL_MS : CAPACITY_PROMPT_COOLDOWN_MS;
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        capacityRecovery: current.capacityRecovery === null ? null : Object.freeze({
          ...current.capacityRecovery,
          nextPromptAt: Math.max(
            current.capacityRecovery.nextPromptAt,
            at + delay
          )
        })
      }));
    }
    clearCapacityRecovery(requestedScope) {
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        capacityRecovery: null
      }));
    }
    publishOverlay(requestedScope, value, reservation = this.reserveOverlayWrite()) {
      const overlay = copyAccountOverlay(value);
      if (overlay === null) return Promise.resolve({ kind: "invalid_model" });
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        overlay
      }), reservation);
    }
    publishConfirmedStory(requestedScope, confirmation) {
      return this.publishAuthoritativeStory(requestedScope, confirmation);
    }
    /**
     * Publishes an exact server acknowledgement into the account-scoped root.
     * Finish qualification responses from the first additive server release may
     * omit syncVersion, so preserve the current opaque version in that case.
     */
    publishAuthoritativeStory(requestedScope, confirmation, reservation = this.reserveOverlayWrite()) {
      const entry = copyLibraryOverlayEntry(confirmation.entry);
      if (entry === null || entry.entryId === void 0 || entry.entryId !== confirmation.entryId) {
        return Promise.resolve({ kind: "invalid_model" });
      }
      return this.#publish(requestedScope, (current) => {
        const overlay = current.overlay ?? Object.freeze({
          entries: Object.freeze({}),
          workPreferences: Object.freeze({}),
          syncVersion: (/* @__PURE__ */ new Date(0)).toISOString()
        });
        return Object.freeze({
          ...current,
          overlay: Object.freeze({
            entries: Object.freeze({
              ...overlay.entries,
              [confirmation.workKey]: entry
            }),
            workPreferences: overlay.workPreferences,
            syncVersion: confirmation.syncVersion ?? overlay.syncVersion
          })
        });
      }, reservation);
    }
    removeAuthoritativeStory(requestedScope, identity, reservation = this.reserveOverlayWrite()) {
      return this.#publish(requestedScope, (current) => {
        const overlay = current.overlay;
        const stored = overlay?.entries[identity.workKey];
        if (overlay === null || stored?.entryId !== identity.entryId) return current;
        const entries = { ...overlay.entries };
        delete entries[identity.workKey];
        return Object.freeze({
          ...current,
          overlay: Object.freeze({
            ...overlay,
            entries: Object.freeze(entries)
          })
        });
      }, reservation);
    }
    /**
     * Reserve before starting an overlay request. A command confirmation that
     * publishes while that request is in flight receives a newer reservation,
     * so the older full response cannot erase the command's exact entry.
     */
    reserveOverlayWrite() {
      this.#overlayReservation += 1;
      return this.#overlayReservation;
    }
    /**
     * Calling this mutates the lock tail synchronously. Disconnect can therefore
     * detach the returned promise while still ordering an immediate Reconnect's
     * later account-root write after this deletion.
     */
    clear() {
      return this.#withLock(async () => {
        await this.#database.delete(PRIVATE_RECORD_KEYS.accountData);
      });
    }
    #publish(requestedScope, update, overlayReservation) {
      return this.#withLock(async () => {
        if (!sameAccountScope(this.#scopes.publicationScope(), requestedScope)) {
          return { kind: "rejected_scope" };
        }
        if (overlayReservation !== void 0 && overlayReservation < this.#appliedOverlayReservation) {
          return { kind: "stale_write" };
        }
        const parsed = parseAccountData(
          await this.#database.get(PRIVATE_RECORD_KEYS.accountData)
        );
        if (!sameAccountScope(this.#scopes.publicationScope(), requestedScope)) {
          return { kind: "rejected_scope" };
        }
        const current = parsed.kind === "valid" && sameAccountScope(parsed.value.scope, requestedScope) ? parsed.value : createEmptyAccountData(requestedScope);
        const next = update(current);
        const validated = parseAccountData(next);
        if (validated.kind !== "valid" || !sameAccountScope(validated.value.scope, requestedScope)) {
          return { kind: "invalid_model" };
        }
        await this.#database.put(PRIVATE_RECORD_KEYS.accountData, validated.value);
        if (overlayReservation !== void 0) {
          this.#appliedOverlayReservation = overlayReservation;
        }
        return { kind: "published", value: validated.value };
      });
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-runtime/reading-activity.mts
  var READING_ACTIVITY_CLOCK_AHEAD = "READING_ACTIVITY_CLOCK_AHEAD";
  var MAX_CLOCK_LEAD_MS = 3e5;
  function readingActivityContext(now, operationId) {
    const offset = -now.getTimezoneOffset();
    const absolute = Math.abs(offset);
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
    const minutes = String(absolute % 60).padStart(2, "0");
    return {
      operationId,
      occurredAt: now.toISOString(),
      calendarDate: new Date(now.getTime() + offset * 6e4).toISOString().slice(0, 10),
      timeZone: { kind: "OFFSET", value: `${offset < 0 ? "-" : "+"}${hours}:${minutes}` }
    };
  }
  function readingActivityClockAheadServerTime(body) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const { code, server_time: serverTime } = body;
    if (code !== READING_ACTIVITY_CLOCK_AHEAD || typeof serverTime !== "string") return null;
    const parsed = new Date(serverTime);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  var ReadingActivityCommands = class {
    #contexts = /* @__PURE__ */ new WeakMap();
    #reanchored = /* @__PURE__ */ new WeakSet();
    #now;
    constructor(now = () => /* @__PURE__ */ new Date()) {
      this.#now = now;
    }
    context(command, operationId) {
      const previous = this.#contexts.get(command);
      if (previous) return previous;
      const context = readingActivityContext(this.#now(), operationId ?? crypto.randomUUID());
      this.#contexts.set(command, context);
      return context;
    }
    /**
     * Re-anchor a command the API rejected as ahead of its clock. The rejected
     * command committed nothing, so it keeps its operation id; the device offset
     * at the server instant derives the local date. Returns false when the
     * command was already re-anchored (including before an authentication
     * retry) or its context was one the API could have accepted, so an exact
     * retry still replays.
     */
    reanchor(command, serverTime) {
      const context = this.#contexts.get(command);
      if (!context || this.#reanchored.has(command) || !(Date.parse(context.occurredAt) > serverTime.getTime() + MAX_CLOCK_LEAD_MS)) {
        return false;
      }
      this.#reanchored.add(command);
      this.#contexts.set(
        command,
        readingActivityContext(new Date(serverTime.getTime()), context.operationId)
      );
      return true;
    }
    /**
     * Send one reading command. On a clock-ahead rejection, re-anchor it and
     * send it exactly once more; `send` rebuilds its body from `context`.
     */
    async send(command, send) {
      const response = await send();
      if (response?.status !== 400) return response;
      let body = null;
      try {
        body = await response.clone().json();
      } catch {
        return response;
      }
      const serverTime = readingActivityClockAheadServerTime(body);
      if (serverTime === null || !this.reanchor(command, serverTime)) return response;
      return send();
    }
  };

  // src/extension-runtime/story-command.mts
  var UUID_PATTERN4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var WORK_KEY_PATTERN2 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var REQUEST_TIMEOUT_MS = 12e3;
  function isRecord6(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isIsoTimestamp(value) {
    return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function confirmedStorySave(value, expectedWorkKey) {
    if (!isRecord6(value)) return null;
    const workKey = typeof value.work_key === "string" ? value.work_key.trim() : "";
    const entryId = typeof value.entry_id === "string" ? value.entry_id.trim() : "";
    const entry = copyLibraryOverlayEntry(value.entry);
    if (workKey !== expectedWorkKey || !WORK_KEY_PATTERN2.test(workKey) || !UUID_PATTERN4.test(entryId) || entry === null || entry.entryId !== entryId || !isIsoTimestamp(value.syncVersion)) {
      return null;
    }
    return Object.freeze({
      workKey,
      entryId,
      entry,
      syncVersion: value.syncVersion,
      ...typeof value.summary_known === "boolean" ? { summaryKnown: value.summary_known } : {}
    });
  }
  var StoryCommandApi = class {
    #readingCommands = new ReadingActivityCommands();
    #fetch;
    #trackEndpoint;
    #overlayEndpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      const base = apiBase.replace(/\/$/, "");
      this.#trackEndpoint = `${base}/api/extension/track`;
      this.#overlayEndpoint = `${base}/api/extension/library-overlay`;
    }
    async lookup(credential, workKey) {
      const response = await this.#request(this.#overlayEndpoint, credential, {
        method: "GET",
        cache: "no-store"
      });
      if (response === null) return { kind: "success", value: { kind: "unavailable" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (!response.ok) return { kind: "success", value: { kind: "unavailable" } };
      const body = await this.#json(response);
      const data = isRecord6(body) && isRecord6(body.data) ? body.data : null;
      if (data === null || !isRecord6(data.entries) || !isIsoTimestamp(data.syncVersion)) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      const rawEntry = data.entries[workKey];
      if (rawEntry === void 0) return { kind: "success", value: { kind: "absent" } };
      const entry = copyLibraryOverlayEntry(rawEntry);
      const entryId = entry?.entryId;
      if (entry === null || typeof entryId !== "string" || !UUID_PATTERN4.test(entryId)) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      return {
        kind: "success",
        value: {
          kind: "found",
          confirmation: Object.freeze({
            workKey,
            entryId,
            entry,
            syncVersion: data.syncVersion
          })
        }
      };
    }
    async track(credential, command) {
      const response = await this.#readingCommands.send(command, () => this.#request(this.#trackEndpoint, credential, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...command.payload, readingActivity: this.#readingCommands.context(command) })
      }));
      if (response === null) return { kind: "success", value: { kind: "uncertain" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (response.status === 400) {
        return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
      }
      if (response.status === 402) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "free_limit_reached" }
        };
      }
      if (response.status === 429) {
        return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
      }
      if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };
      const body = await this.#json(response);
      const confirmation = confirmedStorySave(
        isRecord6(body) ? body.data : null,
        command.workKey
      );
      return confirmation === null ? { kind: "success", value: { kind: "uncertain" } } : { kind: "success", value: { kind: "confirmed", confirmation } };
    }
    async #request(url, credential, init) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await this.#fetch(url, {
          ...init,
          signal: abort.signal,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${credential}`
          }
        });
      } catch {
        return null;
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  var AccountStoryProjectionPort = class {
    #repository;
    constructor(repository) {
      this.#repository = repository;
    }
    async publishConfirmed(scope2, confirmation) {
      try {
        const result = await this.#repository.publishConfirmedStory(scope2, confirmation);
        return result.kind === "published" ? { kind: "published" } : result;
      } catch {
        return { kind: "unavailable" };
      }
    }
  };

  // src/extension-runtime/account-projection.mts
  var REQUEST_TIMEOUT_MS2 = 12e3;
  function isRecord7(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  async function responseJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  var AccountProjectionApi = class {
    #fetch;
    #overlayEndpoint;
    #accountEndpoint;
    #timeoutMs;
    constructor(fetchImpl, apiBase, timeoutMs = REQUEST_TIMEOUT_MS2) {
      this.#fetch = fetchImpl;
      this.#timeoutMs = timeoutMs;
      const base = apiBase.replace(/\/$/, "");
      this.#overlayEndpoint = `${base}/api/extension/library-overlay`;
      this.#accountEndpoint = `${base}/api/extension/account`;
    }
    async load(credential) {
      const [overlayResult, accountResult] = await Promise.all([
        this.#request(this.#overlayEndpoint, credential),
        this.#request(this.#accountEndpoint, credential)
      ]);
      const responses = [overlayResult, accountResult];
      if (responses.some(
        (result) => result.kind === "response" && (result.response.status === 401 || result.response.status === 403)
      )) {
        return { kind: "auth_rejected" };
      }
      if (responses.every((result) => result.kind === "unavailable")) {
        return { kind: "unavailable" };
      }
      const overlay = await this.#overlayPart(overlayResult);
      const summary = await this.#summaryPart(accountResult);
      return {
        kind: "success",
        value: Object.freeze({ overlay, summary })
      };
    }
    async #overlayPart(result) {
      if (result.kind === "unavailable") return { kind: "unavailable" };
      if (!result.response.ok) {
        return result.response.status === 429 || result.response.status >= 500 ? { kind: "unavailable" } : { kind: "invalid_response" };
      }
      const body = result.body;
      const data = isRecord7(body) && isRecord7(body.data) ? body.data : null;
      const overlay = copyAccountOverlay(
        data === null || Object.hasOwn(data, "workPreferences") ? data : { ...data, workPreferences: {} }
      );
      return overlay === null ? { kind: "invalid_response" } : { kind: "value", value: overlay };
    }
    async #summaryPart(result) {
      if (result.kind === "unavailable") return { kind: "unavailable" };
      if (!result.response.ok) {
        return result.response.status === 429 || result.response.status >= 500 ? { kind: "unavailable" } : { kind: "invalid_response" };
      }
      const body = result.body;
      if (!isRecord7(body) || typeof body.account_id !== "string" || !body.account_id.trim()) {
        return { kind: "invalid_response" };
      }
      const libraryCount = body.library_count;
      const libraryLimit = isRecord7(body.cap) ? body.cap.limit : void 0;
      const summary = copyAccountSummary({
        pro: body.pro,
        libraryCount,
        firstStoryCompleted: typeof body.first_story_completed_at === "string" && body.first_story_completed_at.trim().length > 0 || Number.isSafeInteger(libraryCount) && libraryCount > 0,
        ...Number.isSafeInteger(libraryLimit) && libraryLimit > 0 ? { libraryLimit } : {}
      });
      return summary === null ? { kind: "invalid_response" } : {
        kind: "value",
        value: Object.freeze({
          accountId: body.account_id.trim(),
          value: summary
        })
      };
    }
    async #request(url, credential) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(url, {
          method: "GET",
          cache: "no-store",
          headers: { Authorization: `Bearer ${credential}` },
          signal: abort.signal
        });
        const body = response.ok ? await responseJson(response) : null;
        if (abort.signal.aborted) return { kind: "unavailable" };
        return { kind: "response", response, body };
      } catch {
        return { kind: "unavailable" };
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
  };

  // src/extension-runtime/billing-conversion.mts
  var REQUEST_TIMEOUT_MS3 = 5e3;
  var ExtensionCapacityEventApi = class {
    #fetch;
    #endpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/capacity-events`;
    }
    async record(credential, event) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS3);
      try {
        const response = await this.#fetch(this.#endpoint, {
          method: "POST",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(event),
          signal: abort.signal
        });
        if (response.status === 401 || response.status === 403) {
          return { kind: "auth_rejected" };
        }
        return { kind: "success", value: void 0 };
      } catch {
        return { kind: "success", value: void 0 };
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
  };

  // src/extension-runtime/library-command.mts
  var REQUEST_TIMEOUT_MS4 = 12e3;
  var UUID_PATTERN5 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var WORK_KEY_PATTERN3 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  function isRecord8(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isIsoTimestamp2(value) {
    return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  var LibraryCommandApi = class {
    #readingCommands = new ReadingActivityCommands();
    #fetch;
    #libraryEndpoint;
    #preferenceEndpoint;
    #finishEndpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      const base = apiBase.replace(/\/$/, "");
      this.#libraryEndpoint = `${base}/api/extension/library`;
      this.#preferenceEndpoint = `${base}/api/extension/work-preferences`;
      this.#finishEndpoint = `${base}/api/extension/finish-qualification`;
    }
    async mutate(credential, command) {
      const url = command.kind === "entry_patch" ? `${this.#libraryEndpoint}/${encodeURIComponent(command.entryId)}` : this.#preferenceEndpoint;
      const reading = command.kind === "entry_patch" && (command.patch.progress !== void 0 || command.patch.status !== void 0);
      const send = () => this.#request(url, credential, {
        method: command.kind === "entry_patch" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          command.kind === "entry_patch" ? reading ? { ...command.patch, readingActivity: this.#readingCommands.context(command) } : command.patch : { key: command.workKey, hidden: command.hidden }
        )
      });
      const response = reading ? await this.#readingCommands.send(command, send) : await send();
      if (response === null) return { kind: "success", value: { kind: "uncertain" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (response.status === 400 || response.status === 404) {
        return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
      }
      if (response.status === 402) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "free_limit_reached" }
        };
      }
      if (response.status === 429) {
        return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
      }
      if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };
      const body = await this.#json(response);
      const data = isRecord8(body) && isRecord8(body.data) ? body.data : null;
      const confirmed = command.kind === "entry_patch" ? data !== null && typeof data.entry_id === "string" && UUID_PATTERN5.test(data.entry_id) && data.entry_id === command.entryId : data !== null && data.key === command.workKey && isRecord8(data.browsePreference) && data.browsePreference.hidden === command.hidden;
      return {
        kind: "success",
        value: confirmed ? { kind: "accepted" } : { kind: "uncertain" }
      };
    }
    async qualifyFinish(credential, command) {
      const send = () => this.#request(this.#finishEndpoint, credential, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          entryId: command.entryId,
          workKey: command.workKey,
          source: command.source,
          chapter: command.chapter,
          total: command.total,
          state: command.state,
          ...command.state === "resolved" ? {
            operationId: command.operationId,
            readingActivity: (() => {
              const { operationId: _, ...calendar } = this.#readingCommands.context(command, command.operationId);
              return calendar;
            })(),
            workStatus: command.workStatus,
            resolutionSource: command.resolutionSource
          } : {}
        })
      });
      const response = command.state === "resolved" ? await this.#readingCommands.send(command, send) : await send();
      if (response === null) return { kind: "success", value: { kind: "uncertain" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (response.status === 400 || response.status === 404 || response.status === 409) {
        return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
      }
      if (response.status === 429) {
        return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
      }
      if (response.status === 503) {
        const error = await this.#json(response);
        if (isRecord8(error) && error.code === "EXTENSION_FINISH_QUALIFICATION_DISABLED" && error.retryable === false) {
          return {
            kind: "success",
            value: {
              kind: "rejected",
              reason: "finish_qualification_disabled"
            }
          };
        }
        return { kind: "success", value: { kind: "uncertain" } };
      }
      if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };
      const body = await this.#json(response);
      const data = isRecord8(body) && isRecord8(body.data) ? body.data : null;
      const workKey = data === null ? void 0 : data.workKey;
      const entry = data === null ? null : copyLibraryOverlayEntry(data.entry);
      const syncVersion = data !== null && Object.hasOwn(data, "syncVersion") ? data.syncVersion : void 0;
      const terminalWithoutProjection = (data?.state === "resolved" || data?.state === "ignored") && workKey === null && data.entry === null && syncVersion === null;
      const expectedOperationId = command.state === "resolved" ? command.operationId : null;
      const responseOperationId = data !== null && Object.hasOwn(data, "operationId") ? data.operationId : null;
      if (data === null || data.state !== "ignored" && data.state !== command.state || responseOperationId !== expectedOperationId || data.eventId !== null && (typeof data.eventId !== "string" || !UUID_PATTERN5.test(data.eventId)) || !terminalWithoutProjection && (typeof workKey !== "string" || workKey !== command.workKey || !WORK_KEY_PATTERN3.test(workKey) || entry === null || entry.entryId !== command.entryId || syncVersion !== void 0 && !isIsoTimestamp2(syncVersion))) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      if (terminalWithoutProjection) {
        return {
          kind: "success",
          value: {
            kind: "acknowledged",
            state: data.state,
            eventId: data.eventId,
            operationId: expectedOperationId,
            workKey: null,
            entry: null,
            syncVersion: null
          }
        };
      }
      return {
        kind: "success",
        value: {
          kind: "acknowledged",
          state: data.state,
          eventId: data.eventId,
          operationId: expectedOperationId,
          workKey,
          entry,
          ...typeof syncVersion === "string" ? { syncVersion } : {}
        }
      };
    }
    async #request(url, credential, init) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS4);
      try {
        return await this.#fetch(url, {
          ...init,
          signal: abort.signal,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${credential}`
          }
        });
      } catch {
        return null;
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  function refreshFailure(result) {
    if (result.kind === "not_authenticated") return { kind: "not_authenticated" };
    if (result.kind === "auth_expired") return { kind: "auth_expired" };
    if (result.kind === "stale") return { kind: "stale" };
    if (result.kind === "unavailable") return { kind: "unavailable" };
    if (result.kind === "refreshed" && result.overlay !== "published" && result.overlay !== "stale") {
      return { kind: "unavailable" };
    }
    return null;
  }
  var AccountLibraryCommandProjection = class {
    #projection;
    #repository;
    constructor(projection, repository) {
      this.#projection = projection;
      this.#repository = repository;
    }
    reserveFinishPublication() {
      return this.#repository.reserveOverlayWrite();
    }
    async publishFinishAcknowledgement(scope2, command, acknowledgement, reservation) {
      try {
        const result = acknowledgement.workKey === null || acknowledgement.entry === null ? await this.#repository.removeAuthoritativeStory(scope2, {
          workKey: command.workKey,
          entryId: command.entryId
        }, reservation) : await this.#repository.publishAuthoritativeStory(scope2, {
          workKey: acknowledgement.workKey,
          entryId: acknowledgement.entry.entryId ?? "",
          entry: acknowledgement.entry,
          ...acknowledgement.syncVersion === void 0 ? {} : { syncVersion: acknowledgement.syncVersion }
        }, reservation);
        return result.kind === "published" ? { kind: "published" } : result;
      } catch {
        return { kind: "unavailable" };
      }
    }
    async refreshAndRead() {
      const refreshed = await this.#projection.refreshIfNeeded(true);
      const failure6 = refreshFailure(refreshed);
      if (failure6 !== null) return failure6;
      const value = await this.#projection.read({ refresh: false });
      return value === null ? { kind: "unavailable" } : { kind: "value", value };
    }
  };

  // src/extension-runtime/library-command-sender.mts
  var UUID_PATTERN6 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var WORK_KEY_PATTERN4 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var MAX_COMMAND_BYTES = 8 * 1024;
  var MAX_CHAPTER = 1e7;
  function isRecord9(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function cloneBoundedRecord(value) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return null;
    }
    if (!serialized || serialized.length > MAX_COMMAND_BYTES) return null;
    try {
      const parsed = JSON.parse(serialized);
      return isRecord9(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  function canonicalStatus(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toUpperCase();
    if (normalized === "PLANNING") return "SAVED";
    if (normalized === "COMPLETED") return "FINISHED";
    return normalized === "SAVED" || normalized === "READING" || normalized === "CAUGHT_UP" || normalized === "PAUSED" || normalized === "FINISHED" || normalized === "DROPPED" ? normalized : null;
  }
  function chapterProgress(value) {
    if (!isRecord9(value) || value.unit !== "CHAPTER") return null;
    if (!Number.isSafeInteger(value.value) || value.value < 0 || value.value > MAX_CHAPTER) {
      return null;
    }
    if (value.total !== null && value.total !== void 0 && (!Number.isSafeInteger(value.total) || value.total < 0 || value.total > MAX_CHAPTER)) {
      return null;
    }
    return Object.freeze({
      unit: "CHAPTER",
      value: value.value,
      total: value.total === void 0 ? null : value.total
    });
  }
  function libraryPatch(value) {
    if (!isRecord9(value)) return null;
    const patch = {};
    if (Object.hasOwn(value, "status")) {
      const status2 = canonicalStatus(value.status);
      if (status2 === null) return null;
      patch.status = status2;
    }
    if (Object.hasOwn(value, "progress")) {
      const progress = chapterProgress(value.progress);
      if (progress === null) return null;
      patch.progress = progress;
    }
    if (Object.hasOwn(value, "rating")) {
      if (!Number.isSafeInteger(value.rating) || value.rating < 0 || value.rating > 5) {
        return null;
      }
      patch.rating = value.rating;
    }
    if (Object.hasOwn(value, "story_snapshot")) {
      if (!isRecord9(value.story_snapshot)) return null;
      const keys = Object.keys(value.story_snapshot);
      if (keys.length !== 1 || keys[0] !== "work_status_override") return null;
      const override = value.story_snapshot.work_status_override;
      if (override !== null && override !== "wip" && override !== "complete" && override !== "hiatus" && override !== "abandoned") {
        return null;
      }
      patch.story_snapshot = Object.freeze({ work_status_override: override });
    }
    return Object.keys(patch).length === 0 ? null : Object.freeze(patch);
  }
  function senderCommandScope(sender, claimedWorkKey) {
    const hostKind2 = archiveHostKindFromSender(sender);
    if (hostKind2 === null) return null;
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, hostKind2)) return null;
    const workKey = typeof claimedWorkKey === "string" ? claimedWorkKey.trim().toLowerCase() : "";
    if (!WORK_KEY_PATTERN4.test(workKey) || !workKey.startsWith(`${hostKind2}:`)) {
      return null;
    }
    const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind2);
    if (senderWorkKey !== null && senderWorkKey !== workKey) return null;
    return Object.freeze({ hostKind: hostKind2, workKey });
  }
  function libraryMutationCommandFromMessage(message, sender) {
    if (!isRecord9(message) || typeof message.type !== "string") return null;
    const payload = cloneBoundedRecord(message.payload);
    if (payload === null) return null;
    const claimedWorkKey = message.type === "TRACE_SET_HIDDEN_WORK" ? payload.key : payload.workKey;
    const scope2 = senderCommandScope(sender, claimedWorkKey);
    if (scope2 === null) return null;
    if (message.type === "TRACE_SET_HIDDEN_WORK") {
      if (typeof payload.hidden !== "boolean") return null;
      return Object.freeze({
        kind: "work_preference",
        ...scope2,
        hidden: payload.hidden
      });
    }
    const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
    if (!UUID_PATTERN6.test(entryId)) return null;
    if (message.type === "TRACE_SET_READER_STATUS") {
      const status2 = canonicalStatus(payload.status);
      if (status2 === null) return null;
      let progress;
      if (Object.hasOwn(payload, "progress")) {
        const parsed = chapterProgress(payload.progress);
        if (parsed === null) return null;
        progress = parsed;
      }
      return Object.freeze({
        kind: "entry_patch",
        ...scope2,
        entryId,
        patch: Object.freeze({
          status: status2,
          ...progress === void 0 ? {} : { progress }
        })
      });
    }
    if (message.type !== "TRACE_PATCH_LIBRARY_ENTRY") return null;
    const patch = libraryPatch(payload.patch);
    if (patch === null) return null;
    return Object.freeze({
      kind: "entry_patch",
      ...scope2,
      entryId,
      patch
    });
  }
  function finishQualificationCommandFromMessage(message, sender) {
    if (!isRecord9(message) || message.type !== "TRACE_FINISH_QUALIFICATION_SIGNAL") {
      return null;
    }
    const payload = cloneBoundedRecord(message.payload);
    if (payload === null) return null;
    const scope2 = senderCommandScope(sender, payload.workKey);
    if (scope2 === null || payload.source !== scope2.hostKind) return null;
    const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
    if (!UUID_PATTERN6.test(entryId)) return null;
    if (!Number.isSafeInteger(payload.chapter) || payload.chapter < 1 || payload.chapter > MAX_CHAPTER || !Number.isSafeInteger(payload.total) || payload.total < 1 || payload.total > MAX_CHAPTER || payload.chapter !== payload.total) {
      return null;
    }
    if (payload.state !== "open" && payload.state !== "resolved") return null;
    const commandBase = {
      kind: "finish_qualification",
      ...scope2,
      entryId,
      source: scope2.hostKind,
      chapter: payload.chapter,
      total: payload.total
    };
    if (payload.state === "open") {
      if (Object.hasOwn(payload, "workStatus") || Object.hasOwn(payload, "readerStatus") || Object.hasOwn(payload, "resolutionSource")) {
        return null;
      }
      return Object.freeze({ ...commandBase, state: "open" });
    }
    if (payload.workStatus !== "complete" && payload.workStatus !== "wip" && payload.workStatus !== "hiatus" && payload.workStatus !== "abandoned") {
      return null;
    }
    if (payload.readerStatus !== void 0 && canonicalStatus(payload.readerStatus) === null) return null;
    if (payload.resolutionSource !== void 0 && payload.resolutionSource !== "source" && payload.resolutionSource !== "reader") {
      return null;
    }
    if (payload.resolutionSource === "source" && payload.workStatus === "abandoned") {
      return null;
    }
    return Object.freeze({
      ...commandBase,
      state: "resolved",
      workStatus: payload.workStatus,
      resolutionSource: payload.resolutionSource ?? "reader"
    });
  }

  // src/extension-runtime/first-story-initiation.mts
  var MAX_IMPORT_PAYLOAD_BYTES = 512 * 1024;
  var MAX_IMPORT_ITEMS = 250;
  var MAX_FIRST_STORY_URL_LENGTH = 4096;
  var FIRST_STORY_FOCUS_RETRY_ATTEMPTS = 24;
  var FIRST_STORY_FOCUS_RETRY_MS = 250;
  var HANDOFF_NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  var SUCCESS_STATES = Object.freeze(["saved", "already_saved"]);
  function isRecord10(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isAo3Host(host) {
    return host === "archiveofourown.org" || host.endsWith(".archiveofourown.org") || host === "archiveofourown.gay" || host.endsWith(".archiveofourown.gay") || host === "archive.transformativeworks.org" || host === "ao3.org" || host.endsWith(".ao3.org");
  }
  function isFfnHost(host) {
    return host === "www.fanfiction.net" || host === "m.fanfiction.net";
  }
  function isTopFrame(sender) {
    return sender !== void 0 && (sender.frameId === void 0 || sender.frameId === 0) && (sender.documentLifecycle === void 0 || sender.documentLifecycle === "active");
  }
  function classifyActiveTabUrl(rawUrl, webOrigin) {
    if (typeof rawUrl !== "string") return Object.freeze({ kind: "unknown" });
    try {
      const url = new URL(rawUrl);
      if (url.origin === new URL(webOrigin).origin) return Object.freeze({ kind: "trace" });
      const host = url.hostname.toLowerCase();
      if (isAo3Host(host)) {
        if (/^\/users\/(?:login|sign_up|password|auth\/|logout)/i.test(url.pathname)) {
          return Object.freeze({ kind: "blocked_archive", site: "ao3", canImport: false });
        }
        return Object.freeze({
          // A work's own page or one of its chapters, directly or through a collection.
          kind: /^\/works\/\d+(?:\/chapters\/\d+)?\/?$/i.test(ao3WorkPath(url.pathname)) ? "supported_story" : "supported_archive",
          site: "ao3",
          canImport: true
        });
      }
      if (isFfnHost(host)) {
        if (/^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(url.pathname)) {
          return Object.freeze({ kind: "blocked_archive", site: "ffn", canImport: false });
        }
        return Object.freeze({
          kind: /^\/s\/[1-9][0-9]{0,19}(?:\/|$)/i.test(url.pathname) ? "supported_story" : "supported_archive",
          site: "ffn",
          canImport: true
        });
      }
      return Object.freeze({ kind: "unsupported" });
    } catch {
      return Object.freeze({ kind: "unsupported" });
    }
  }
  function normalizeFirstStoryUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > MAX_FIRST_STORY_URL_LENGTH) {
      return null;
    }
    try {
      const url = new URL(rawUrl.trim());
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const host = url.hostname.toLowerCase();
      if (isAo3Host(host) && /^\/works\/[1-9][0-9]{0,19}(?:\/chapters\/[1-9][0-9]{0,19})?\/?$/i.test(
        url.pathname
      )) {
        return url.href;
      }
      if (isFfnHost(host) && /^\/s\/[1-9][0-9]{0,19}(?:\/[1-9][0-9]{0,9})?(?:\/|$)/i.test(url.pathname)) {
        return url.href;
      }
    } catch {
      return null;
    }
    return null;
  }
  function isPopupSender(sender, runtimeId) {
    if (typeof sender?.url !== "string") {
      return (sender?.tab === void 0 || sender.tab === null) && runtimeId !== void 0 && sender?.id === runtimeId;
    }
    try {
      const url = new URL(sender.url);
      return ["chrome-extension:", "moz-extension:", "safari-web-extension:"].includes(url.protocol) && url.pathname.endsWith("/popup.html");
    } catch {
      return false;
    }
  }
  function isTraceWebSender(sender, runtimeId, webOrigin) {
    if (!isTopFrame(sender)) return false;
    if (runtimeId !== void 0 && sender?.id !== runtimeId) return false;
    const rawUrl = sender?.url ?? sender?.tab?.url;
    if (typeof rawUrl !== "string") return false;
    try {
      return new URL(rawUrl).origin === new URL(webOrigin).origin;
    } catch {
      return false;
    }
  }
  function firstStoryInitiationFromMessage(message, sender, runtimeId, webOrigin) {
    if (!isRecord10(message) || typeof message.type !== "string") return null;
    if (message.type === "TRACE_IMPORT_OPEN_TABS") {
      return isPopupSender(sender, runtimeId) ? Object.freeze({ kind: "popup_open_tabs" }) : null;
    }
    if (message.type === "TRACE_IMPORT_TRIGGER") {
      return isPopupSender(sender, runtimeId) ? Object.freeze({ kind: "popup_import" }) : null;
    }
    if (message.type !== "TRACE_FIRST_STORY_ADD") return null;
    if (!isTraceWebSender(sender, runtimeId, webOrigin)) return null;
    const nonce = typeof message.nonce === "string" ? message.nonce.trim() : "";
    if (!HANDOFF_NONCE_PATTERN.test(nonce)) return null;
    const url = normalizeFirstStoryUrl(message.url);
    if (url === null) return Object.freeze({ kind: "invalid", error: "invalid_url" });
    return Object.freeze({ kind: "web_save", nonce, url });
  }
  function isMissingReceiverError(error) {
    const value = [
      typeof error === "string" ? error : "",
      isRecord10(error) && typeof error.message === "string" ? error.message : "",
      String(error ?? "")
    ].join("\n");
    return /receiving end does not exist|could not establish connection|message port closed/i.test(
      value
    );
  }
  function sourceMatchesSite(value, site) {
    if (typeof value !== "string") return false;
    const source = value.trim().toLowerCase();
    return site === "ao3" ? source === "ao3" || source === "archiveofourown.org" || source === "archiveofourown.gay" || source === "archive.transformativeworks.org" : source === "ffn" || source === "fanfiction.net";
  }
  function boundedImportPayload(response, site) {
    if (!isRecord10(response) || response.ok !== true || !isRecord10(response.payload)) {
      return null;
    }
    if (!sourceMatchesSite(response.payload.s, site)) return null;
    if (typeof response.payload.at !== "string" || !response.payload.at || response.payload.at.length > 128) {
      return null;
    }
    if (!Array.isArray(response.payload.items) || response.payload.items.length === 0 || response.payload.items.length > MAX_IMPORT_ITEMS || !response.payload.items.every((item) => isRecord10(item) && sourceMatchesSite(item.src, site) && normalizeFirstStoryUrl(item.u) !== null)) {
      return null;
    }
    let serialized;
    try {
      serialized = JSON.stringify(response.payload);
    } catch {
      return null;
    }
    if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_PAYLOAD_BYTES) {
      return null;
    }
    try {
      const parsed = JSON.parse(serialized);
      return isRecord10(parsed) ? Object.freeze(parsed) : null;
    } catch {
      return null;
    }
  }
  function encodeImportPayload(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function responseError(response) {
    if (!isRecord10(response) || typeof response.error !== "string") return "save_failed";
    if (response.error === "not_authenticated" || response.error === "free_limit_reached" || response.error === "auth_expired" || response.error === "rate_limited") {
      return response.error;
    }
    if (response.error === "page_contains_password_field") return "unsupported_page";
    return "save_failed";
  }
  var BrowserFirstStoryInitiator = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #delay;
    #collectFromPage;
    constructor(options) {
      this.#collectFromPage = options.collectFromPage ?? null;
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      this.#webOrigin = new URL(options.webOrigin).origin;
      this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)));
    }
    async importActivePage(nativeStage) {
      let tabs;
      try {
        tabs = await this.#call("query", [{
          active: true,
          currentWindow: true
        }]);
      } catch {
        return Object.freeze({ ok: false, error: "unavailable" });
      }
      const tab = tabs[0];
      if (typeof tab?.id !== "number") {
        return Object.freeze({ ok: false, error: "no_active_tab" });
      }
      const context = classifyActiveTabUrl(tab.url, this.#webOrigin);
      if (context.kind !== "supported_story" && context.kind !== "supported_archive") {
        return Object.freeze({ ok: false, error: "unsupported_page" });
      }
      let response;
      let directError = null;
      try {
        response = await this.#call("sendMessage", [tab.id, { type: "TRACE_COLLECT" }]);
      } catch (error) {
        directError = error ?? new Error("collect_failed");
      }
      if ((directError !== null || !isRecord10(response)) && this.#collectFromPage !== null) {
        try {
          const relayed = await this.#collectFromPage(tab.id);
          if (isRecord10(relayed) && (relayed.ok === true || relayed.error !== "page_unavailable")) {
            response = relayed;
            directError = null;
          }
        } catch {
        }
      }
      if (directError !== null) {
        return Object.freeze({
          ok: false,
          error: isMissingReceiverError(directError) ? "permission_required" : "collect_failed"
        });
      }
      const payload = boundedImportPayload(response, context.site);
      if (payload === null) {
        const error = isRecord10(response) && response.error === "page_contains_password_field" ? "unsupported_page" : "collect_failed";
        return Object.freeze({ ok: false, error });
      }
      if (nativeStage !== void 0) return nativeStage(encodeImportPayload(payload));
      const importUrl = `${this.#webOrigin}/import#U${encodeURIComponent(
        encodeImportPayload(payload)
      )}`;
      try {
        await this.#call("create", [{ url: importUrl }]);
        return Object.freeze({ ok: true, state: "opened" });
      } catch {
        return Object.freeze({ ok: false, error: "open_failed" });
      }
    }
    async saveFromTrace(url) {
      const normalized = normalizeFirstStoryUrl(url);
      if (normalized === null) return Object.freeze({ ok: false, error: "invalid_url" });
      let tab;
      try {
        tab = await this.#call("create", [{ url: normalized, active: true }]);
      } catch {
        return Object.freeze({ ok: false, error: "open_failed" });
      }
      if (typeof tab?.id !== "number") {
        return Object.freeze({ ok: false, error: "open_failed" });
      }
      for (let attempt = 0; attempt <= FIRST_STORY_FOCUS_RETRY_ATTEMPTS; attempt += 1) {
        try {
          const response = await this.#call("sendMessage", [
            tab.id,
            { type: "TRACE_FIRST_STORY_FOCUS_ADD" }
          ]);
          if (isRecord10(response) && response.ok === true) {
            const state = SUCCESS_STATES.find((candidate) => candidate === response.state);
            return state === void 0 ? Object.freeze({ ok: false, error: "save_failed" }) : Object.freeze({ ok: true, state });
          }
          return Object.freeze({ ok: false, error: responseError(response) });
        } catch (error) {
          if (!isMissingReceiverError(error)) {
            return Object.freeze({ ok: false, error: "save_failed" });
          }
          if (attempt === FIRST_STORY_FOCUS_RETRY_ATTEMPTS) {
            return Object.freeze({ ok: false, error: "permission_required" });
          }
          await this.#delay(FIRST_STORY_FOCUS_RETRY_MS);
        }
      }
      return Object.freeze({ ok: false, error: "save_failed" });
    }
    #call(method, args) {
      return extensionCall(
        this.#tabs,
        method,
        args,
        this.#runtime,
        this.#mode
      );
    }
  };

  // src/extension-runtime/metadata-contribution.mts
  var REQUEST_TIMEOUT_MS5 = 12e3;
  var METADATA_PREFERENCE_KEY = "prefMetadataImproveEnabled";
  function isRecord11(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function validCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }
  var MetadataContributionApi = class {
    #fetch;
    #storyEndpoint;
    #libraryEndpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      const base = apiBase.replace(/\/$/, "");
      this.#storyEndpoint = `${base}/api/extension/metadata`;
      this.#libraryEndpoint = `${base}/api/extension/library/metadata-refresh`;
    }
    async contribute(credential, command) {
      const response = await this.#request(
        command.kind === "story_metadata" ? this.#storyEndpoint : this.#libraryEndpoint,
        credential,
        command.payload
      );
      if (response === null) {
        return { kind: "success", value: { kind: "unavailable" } };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_rejected" };
      }
      if (response.status === 400) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "invalid_request" }
        };
      }
      if (response.status === 429) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "rate_limited" }
        };
      }
      if (!response.ok) {
        return { kind: "success", value: { kind: "unavailable" } };
      }
      const body = await this.#json(response);
      const data = isRecord11(body) && body.success === true && isRecord11(body.data) ? body.data : null;
      if (data === null) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      if (command.kind === "story_metadata") {
        return Number.isSafeInteger(data.story_id) && data.story_id > 0 ? { kind: "success", value: { kind: "accepted", updated: true } } : { kind: "success", value: { kind: "invalid_response" } };
      }
      return validCount(data.updated) && validCount(data.ignored) ? {
        kind: "success",
        value: { kind: "accepted", updated: data.updated > 0 }
      } : { kind: "success", value: { kind: "invalid_response" } };
    }
    async #request(url, credential, payload) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS5);
      try {
        return await this.#fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential}`
          },
          body: JSON.stringify(payload),
          signal: abort.signal
        });
      } catch {
        return null;
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  var BrowserMetadataPreferencePort = class {
    #storage;
    constructor(storage) {
      this.#storage = storage;
    }
    async enabled() {
      const value = await this.#storage.get(METADATA_PREFERENCE_KEY);
      return value[METADATA_PREFERENCE_KEY] !== false;
    }
  };
  var TraceWebMetadataNotificationPort = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #queryPattern;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      const webUrl = new URL(options.webOrigin);
      this.#webOrigin = webUrl.origin;
      this.#queryPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
    }
    async publish() {
      if (!declaresHostPattern(this.#runtime, this.#queryPattern)) return false;
      let tabs;
      try {
        tabs = await extensionCall(
          this.#tabs,
          "query",
          [{ url: [this.#queryPattern] }],
          this.#runtime,
          this.#mode
        );
      } catch {
        return false;
      }
      const message = Object.freeze({
        type: "TRACE_LIBRARY_INVALIDATED",
        reason: "metadata",
        at: (/* @__PURE__ */ new Date()).toISOString()
      });
      for (const tab of tabs) {
        if (typeof tab.id !== "number" || !this.#isTraceWebUrl(tab.url)) continue;
        try {
          await extensionCall(
            this.#tabs,
            "sendMessage",
            [tab.id, message],
            this.#runtime,
            this.#mode
          );
        } catch {
        }
      }
      return true;
    }
    #isTraceWebUrl(rawUrl) {
      if (typeof rawUrl !== "string") return false;
      try {
        return new URL(rawUrl).origin === this.#webOrigin;
      } catch {
        return false;
      }
    }
  };

  // src/extension-runtime/metadata-contribution-sender.mts
  var MAX_STORY_METADATA_BYTES = 64 * 1024;
  var MAX_LIBRARY_REFRESH_BYTES = 512 * 1024;
  var MAX_LIBRARY_REFRESH_ITEMS = 100;
  var MAX_METADATA_ARRAY_ITEMS = 200;
  var MAX_METADATA_INTEGER = 1e8;
  var SOURCE_STORY_ID_PATTERN = /^[1-9][0-9]{0,39}$/;
  var LIBRARY_REFRESH_FIELDS = /* @__PURE__ */ new Set([
    "source",
    "sourceStoryId",
    "url",
    "title",
    "author",
    "summary",
    "chapters",
    "chaptersPublished",
    "chaptersPlanned",
    "words",
    "status",
    "updatedAt",
    "publishedAt",
    "rating",
    "language",
    "fandoms",
    "characters",
    "relationships",
    "genre"
  ]);
  var STRING_LIMITS = Object.freeze({
    title: 300,
    author: 120,
    summary: 2e4,
    status: 60,
    updatedAt: 50,
    publishedAt: 50,
    rating: 60,
    language: 60,
    genre: 100
  });
  var INTEGER_FIELDS = Object.freeze([
    "chapters",
    "chaptersPublished",
    "chaptersPlanned",
    "words"
  ]);
  var ARRAY_FIELDS = Object.freeze([
    "fandoms",
    "characters",
    "relationships"
  ]);
  function isRecord12(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function cloneBoundedRecord2(value, maxBytes) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return null;
    }
    if (!serialized || new TextEncoder().encode(serialized).byteLength > maxBytes) {
      return null;
    }
    try {
      const parsed = JSON.parse(serialized);
      return isRecord12(parsed) ? Object.freeze(parsed) : null;
    } catch {
      return null;
    }
  }
  function validOptionalString(value, maxLength) {
    return value === void 0 || value === null || typeof value === "string" && value.length <= maxLength;
  }
  function validOptionalInteger(value) {
    return value === void 0 || value === null || Number.isSafeInteger(value) && value >= 0 && value <= MAX_METADATA_INTEGER;
  }
  function validOptionalStringArray(value) {
    return value === void 0 || Array.isArray(value) && value.length <= MAX_METADATA_ARRAY_ITEMS && value.every(
      (item) => item === null || typeof item === "string" && item.length <= 255
    );
  }
  function refreshItemWorkKey(item, hostKind2) {
    if (item.source !== hostKind2 || Object.keys(item).some((key) => !LIBRARY_REFRESH_FIELDS.has(key))) {
      return null;
    }
    const rawId = typeof item.sourceStoryId === "string" ? item.sourceStoryId.trim() : "";
    if (rawId && !SOURCE_STORY_ID_PATTERN.test(rawId)) return null;
    const urlWorkKey = item.url === void 0 ? null : workKeyFromArchiveUrl(item.url, hostKind2);
    if (item.url !== void 0 && urlWorkKey === null) return null;
    const idWorkKey = rawId ? `${hostKind2}:${rawId}` : null;
    if (urlWorkKey !== null && idWorkKey !== null && urlWorkKey !== idWorkKey) {
      return null;
    }
    const workKey = urlWorkKey ?? idWorkKey;
    if (workKey === null) return null;
    for (const [field, maxLength] of Object.entries(STRING_LIMITS)) {
      if (!validOptionalString(item[field], maxLength)) return null;
    }
    for (const field of INTEGER_FIELDS) {
      if (!validOptionalInteger(item[field])) return null;
    }
    for (const field of ARRAY_FIELDS) {
      if (!validOptionalStringArray(item[field])) return null;
    }
    return workKey;
  }
  function storyMetadataCommand(message, hostKind2, senderUrl) {
    const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind2);
    if (senderWorkKey === null) return null;
    const payload = cloneBoundedRecord2(message.payload, MAX_STORY_METADATA_BYTES);
    if (payload === null || !sourceMatchesArchiveHost(payload.s, hostKind2) || typeof payload.at !== "string" || payload.at.length === 0 || payload.at.length > 500 || !isRecord12(payload.item) || payload.item.ctx !== "story" || typeof payload.item.t !== "string" || payload.item.t.trim().length === 0 || payload.item.t.length > 300 || !sourceMatchesArchiveHost(payload.item.src, hostKind2) || workKeyFromArchiveUrl(payload.item.u, hostKind2) !== senderWorkKey) {
      return null;
    }
    return Object.freeze({
      kind: "story_metadata",
      hostKind: hostKind2,
      workKeys: Object.freeze([senderWorkKey]),
      payload
    });
  }
  function libraryMetadataRefreshCommand(message, hostKind2, senderUrl) {
    if (workKeyFromArchiveUrl(senderUrl, hostKind2) !== null) return null;
    const payload = cloneBoundedRecord2(message.payload, MAX_LIBRARY_REFRESH_BYTES);
    if (payload === null || Object.keys(payload).length !== 1 || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > MAX_LIBRARY_REFRESH_ITEMS) {
      return null;
    }
    const workKeys = [];
    const seen = /* @__PURE__ */ new Set();
    for (const item of payload.items) {
      if (!isRecord12(item)) return null;
      const workKey = refreshItemWorkKey(item, hostKind2);
      if (workKey === null) return null;
      if (!seen.has(workKey)) {
        seen.add(workKey);
        workKeys.push(workKey);
      }
    }
    return Object.freeze({
      kind: "library_metadata_refresh",
      hostKind: hostKind2,
      workKeys: Object.freeze(workKeys),
      payload
    });
  }
  function metadataContributionCommandFromMessage(message, sender) {
    if (!isRecord12(message)) return null;
    const hostKind2 = archiveHostKindFromSender(sender);
    if (hostKind2 === null) return null;
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, hostKind2)) return null;
    if (message.type === "TRACE_METADATA_BROADCAST") {
      return storyMetadataCommand(message, hostKind2, senderUrl);
    }
    if (message.type === "TRACE_LIBRARY_METADATA_REFRESH") {
      return libraryMetadataRefreshCommand(message, hostKind2, senderUrl);
    }
    return null;
  }

  // src/extension-runtime/saved-filter-sync.mts
  var REQUEST_TIMEOUT_MS6 = 12e3;
  var SAVED_FILTER_LAST_USED_KEY = "traceAo3SavedFiltersLastUsedV1";
  var SAVED_FILTER_STORAGE_KEYS = SAVED_FILTER_LOCAL_KEYS;
  function isRecord13(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys3(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
  }
  var SavedFilterSyncApi = class {
    #fetch;
    #endpoint;
    #activeAbort = null;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/ao3-saved-filters/sync`;
    }
    async sync(credential, request) {
      const abort = new AbortController();
      this.#activeAbort = abort;
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS6);
      let response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential}`
          },
          body: JSON.stringify(request),
          signal: abort.signal
        });
      } catch {
        return { kind: "success", value: { kind: "unavailable" } };
      } finally {
        globalThis.clearTimeout(timer);
        if (this.#activeAbort === abort) this.#activeAbort = null;
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_rejected" };
      }
      if (response.status === 400) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "invalid_request" }
        };
      }
      if (response.status === 429) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "rate_limited" }
        };
      }
      if (response.status === 422) {
        const body2 = await this.#json(response);
        if (isRecord13(body2) && body2.code === "AO3_SAVED_FILTER_LIMIT_REACHED" && Number.isSafeInteger(body2.limit) && body2.limit > 0 && body2.limit <= 250) {
          return {
            kind: "success",
            value: {
              kind: "rejected",
              reason: "limit_reached",
              limit: body2.limit
            }
          };
        }
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      if (!response.ok) {
        return { kind: "success", value: { kind: "unavailable" } };
      }
      const body = await this.#json(response);
      if (!isRecord13(body) || !hasOnlyKeys3(body, ["success", "data"]) || body.success !== true) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      const data = parseSavedFilterSyncData(body.data);
      return data === null ? { kind: "success", value: { kind: "invalid_response" } } : { kind: "success", value: { kind: "accepted", data } };
    }
    cancelPending() {
      this.#activeAbort?.abort();
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  var BrowserSavedFilterRepository = class {
    #storage;
    #session;
    #randomId;
    #tail = Promise.resolve();
    constructor(options) {
      this.#storage = options.storage;
      this.#session = options.session;
      this.#randomId = options.randomId;
    }
    read() {
      return this.#withLock(async () => {
        const snapshot = await this.#readUnlocked();
        if (snapshot.clientId !== null) return snapshot;
        const generated = `device:${this.#randomId()}`.slice(0, 80);
        const clientId = /^[A-Za-z0-9._:-]{1,80}$/.test(generated) ? generated : null;
        if (clientId === null) return null;
        await this.#storage.set({ [SAVED_FILTER_STORAGE_KEYS.clientId]: clientId });
        return Object.freeze({ ...snapshot, clientId });
      });
    }
    /**
     * The account left (signed out, or another took its place): its saved
     * filters, where they were, which one was on and its sync point go. The
     * device's own id stays.
     */
    clearAccountData() {
      return this.#withLock(() => this.#storage.remove([
        SAVED_FILTER_STORAGE_KEYS.presets,
        SAVED_FILTER_STORAGE_KEYS.deleted,
        SAVED_FILTER_STORAGE_KEYS.syncMeta,
        SAVED_FILTER_STORAGE_KEYS.activeMeta,
        SAVED_FILTER_LAST_USED_KEY
      ]));
    }
    /** When this device last pulled its saved filters, or null for never. */
    async lastSyncedAt() {
      return (await this.#readUnlocked()).lastSyncedAt;
    }
    merge(requestedScope, data, sentDeleteClientIds, syncedAt) {
      return this.#withLock(async () => {
        if (!canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
          return { kind: "stale" };
        }
        let current;
        try {
          current = await this.#readUnlocked();
        } catch {
          return { kind: "unavailable" };
        }
        if (current.clientId === null || !canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
          return { kind: "stale" };
        }
        const next = mergeSavedFilterSyncData(
          current,
          data,
          sentDeleteClientIds,
          syncedAt,
          requestedScope.accountId
        );
        if (!canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
          return { kind: "stale" };
        }
        try {
          await this.#storage.set({
            [SAVED_FILTER_STORAGE_KEYS.presets]: next.presets,
            [SAVED_FILTER_STORAGE_KEYS.deleted]: next.deleted,
            [SAVED_FILTER_STORAGE_KEYS.activeMeta]: next.activeMeta,
            [SAVED_FILTER_STORAGE_KEYS.syncMeta]: {
              syncVersion: next.syncVersion,
              lastSyncedAt: next.lastSyncedAt,
              accountId: next.syncAccountId
            },
            [SAVED_FILTER_STORAGE_KEYS.clientId]: next.clientId
          });
        } catch {
          return { kind: "unavailable" };
        }
        return canSyncSavedFilters(this.#session.publicationScope(), requestedScope) ? { kind: "published", snapshot: next } : { kind: "stale" };
      });
    }
    async #readUnlocked() {
      const raw = await this.#storage.get(Object.values(SAVED_FILTER_STORAGE_KEYS));
      const rawSyncMeta = raw[SAVED_FILTER_STORAGE_KEYS.syncMeta];
      const syncMeta = isRecord13(rawSyncMeta) ? rawSyncMeta : {};
      return normalizeSavedFilterSnapshot({
        presets: raw[SAVED_FILTER_STORAGE_KEYS.presets],
        deleted: raw[SAVED_FILTER_STORAGE_KEYS.deleted],
        activeMeta: raw[SAVED_FILTER_STORAGE_KEYS.activeMeta],
        syncVersion: syncMeta.syncVersion,
        lastSyncedAt: syncMeta.lastSyncedAt,
        syncAccountId: syncMeta.accountId,
        clientId: raw[SAVED_FILTER_STORAGE_KEYS.clientId]
      }, (/* @__PURE__ */ new Date()).toISOString());
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
  var SavedFilterSyncAlarm = class _SavedFilterSyncAlarm {
    static name = SAVED_FILTER_SYNC_ALARM;
    static install(alarms, runtime, onAlarm, mode = "promise") {
      alarms.onAlarm?.addListener((alarm) => {
        if (alarm?.name === _SavedFilterSyncAlarm.name) onAlarm();
      });
      return _SavedFilterSyncAlarm.#ensure(alarms, runtime, mode).catch(() => void 0);
    }
    // An existing alarm keeps its schedule. Safari restarts the background
    // often, and creating the alarm again on each start would push the next
    // pull a full period away every time, so it would never fire.
    static async #ensure(alarms, runtime, mode) {
      const existing = typeof alarms.get === "function" ? await extensionCall(
        alarms,
        "get",
        [_SavedFilterSyncAlarm.name],
        runtime,
        mode
      ).catch(() => void 0) : void 0;
      if (isRecord13(existing)) return;
      try {
        const result = alarms.create?.(
          _SavedFilterSyncAlarm.name,
          { periodInMinutes: 30 }
        );
        if (result && typeof result.then === "function") {
          await Promise.resolve(result).catch(() => void 0);
        }
      } catch {
        void runtime.lastError;
      }
    }
  };

  // src/extension-runtime/saved-filter-sync-sender.mts
  var SAVED_FILTER_SYNC_MESSAGE = "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST";
  function isRecord14(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSavedFilterSyncRequest(message, sender) {
    if (!isRecord14(message) || Object.keys(message).length !== 1 || message.type !== SAVED_FILTER_SYNC_MESSAGE || archiveHostKindFromSender(sender) !== "ao3") {
      return false;
    }
    const senderUrl = sender?.tab?.url ?? sender?.url;
    return !isBlockedArchivePath(senderUrl, "ao3");
  }

  // src/extension-runtime/story-command-sender.mts
  var MAX_TRACK_PAYLOAD_BYTES = 64 * 1024;
  var HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  var FFN_AUTHOR_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
  var COMMAND_TYPES = Object.freeze({
    connectAndSave: "TRACE_CONNECT_AND_SAVE",
    quickAdd: "TRACE_QUICK_ADD",
    autoTrack: "TRACE_AUTO_TRACK"
  });
  function isRecord15(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function progressTarget(item) {
    if (!Number.isSafeInteger(item.chn) || item.chn < 1) return null;
    const chapter = item.chn;
    const rawTotal = Number.isSafeInteger(item.cht) && item.cht > 0 ? item.cht : Number.isSafeInteger(item.chPub) && item.chPub > 0 ? item.chPub : null;
    return Object.freeze({
      current: chapter > 1 ? chapter : 0,
      total: rawTotal
    });
  }
  function cloneBoundedPayload(value) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return null;
    }
    if (!serialized || serialized.length > MAX_TRACK_PAYLOAD_BYTES) return null;
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return null;
    }
    return isRecord15(parsed) ? Object.freeze(parsed) : null;
  }
  function storyTrackCommandFromMessage(message, sender) {
    if (!isRecord15(message)) return null;
    const hostKind2 = archiveHostKindFromSender(sender);
    if (hostKind2 === null) return null;
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, hostKind2)) return null;
    const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind2);
    const payload = cloneBoundedPayload(message.payload);
    if (payload === null || !sourceMatchesArchiveHost(payload.s, hostKind2)) return null;
    if (typeof payload.at !== "string" || payload.at.length === 0 || payload.at.length > 128) {
      return null;
    }
    if (!isRecord15(payload.item)) return null;
    if (!sourceMatchesArchiveHost(payload.item.src, hostKind2)) return null;
    const payloadWorkKey = workKeyFromArchiveUrl(payload.item.u, hostKind2);
    if (payloadWorkKey === null) return null;
    const messageType = typeof message.type === "string" ? message.type : "";
    const context = payload.item.ctx;
    let intent;
    let progress;
    if (messageType === COMMAND_TYPES.autoTrack) {
      if (context !== "story" || senderWorkKey === null || payloadWorkKey !== senderWorkKey) {
        return null;
      }
      const target = progressTarget(payload.item);
      if (target === null) return null;
      intent = "record_progress";
      progress = target;
    } else if (messageType === COMMAND_TYPES.connectAndSave) {
      if (context !== "story" || senderWorkKey === null || payloadWorkKey !== senderWorkKey) {
        return null;
      }
      intent = "ensure_saved";
    } else if (messageType === COMMAND_TYPES.quickAdd) {
      if (context !== "story" && context !== "listing" && context !== "bookmark") return null;
      if (senderWorkKey !== null && (context !== "story" || payloadWorkKey !== senderWorkKey)) {
        return null;
      }
      if (senderWorkKey === null && context === "story") return null;
      intent = "ensure_saved";
    } else {
      return null;
    }
    const claimedWorkKey = typeof message.workKey === "string" ? message.workKey.trim() : "";
    if (claimedWorkKey && claimedWorkKey !== payloadWorkKey) return null;
    const rawHandoffId = typeof message.handoffId === "string" ? message.handoffId.trim() : "";
    const handoffId = messageType === COMMAND_TYPES.connectAndSave && HANDOFF_ID_PATTERN.test(rawHandoffId) ? rawHandoffId : void 0;
    const ffnAuthorId = hostKind2 === "ffn" && context === "story" && typeof message.ffnAuthorId === "string" && FFN_AUTHOR_ID_PATTERN.test(message.ffnAuthorId) ? message.ffnAuthorId : void 0;
    return Object.freeze({
      intent,
      hostKind: hostKind2,
      workKey: payloadWorkKey,
      payload,
      ...progress === void 0 ? {} : { progress },
      ...handoffId === void 0 ? {} : { handoffId },
      ...ffnAuthorId === void 0 ? {} : { ffnAuthorId }
    });
  }

  // src/extension-runtime/trace-web-navigation.mts
  var TRACE_WEB_OPEN_MESSAGE = "TRACE_OPEN_TRACE_URL";
  var MAX_TRACE_WEB_URL_LENGTH = 2048;
  var FIRST_INSTALL_ACTIVATION_PATH = "/?activation=extension-installed";
  function isRecord16(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function traceWebNavigationRequestFromMessage(message, sender, webOrigin) {
    if (!isRecord16(message) || Object.keys(message).length !== 2 || message.type !== TRACE_WEB_OPEN_MESSAGE || !isRecord16(message.payload) || Object.keys(message.payload).length !== 1) {
      return null;
    }
    const hostKind2 = archiveHostKindFromSender(sender);
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (hostKind2 === null || isBlockedArchivePath(senderUrl, hostKind2)) return null;
    const rawUrl = message.payload.url;
    if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_TRACE_WEB_URL_LENGTH) {
      return Object.freeze({ kind: "invalid" });
    }
    try {
      const configuredOrigin = new URL(webOrigin).origin;
      const url = new URL(rawUrl, configuredOrigin);
      if (url.origin !== configuredOrigin || url.username || url.password || url.protocol !== "https:" && url.protocol !== "http:") {
        return Object.freeze({ kind: "invalid" });
      }
      return Object.freeze({ kind: "open", url: url.href });
    } catch {
      return Object.freeze({ kind: "invalid" });
    }
  }
  var BrowserTraceWebNavigation = class {
    #runtime;
    #tabs;
    #mode;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
    }
    async open(url) {
      return await this.openTab(url) !== null;
    }
    async openTab(url) {
      try {
        return await extensionCall(
          this.#tabs,
          "create",
          [{ url }],
          this.#runtime,
          this.#mode
        ) ?? {};
      } catch {
        return null;
      }
    }
    async returnToArchive(sourceTabId, connectTabId) {
      if (!this.#tabs.get || !this.#tabs.update || sourceTabId === connectTabId) return;
      const tabs = this.#tabs;
      try {
        const [source, connect] = await Promise.all([
          extensionCall(tabs, "get", [sourceTabId], this.#runtime, this.#mode),
          extensionCall(tabs, "get", [connectTabId], this.#runtime, this.#mode)
        ]);
        const host = archiveHostKindFromSender({ tab: source });
        if (connect?.active !== true || host === null || isBlockedArchivePath(source?.url, host)) return;
        await extensionCall(tabs, "update", [sourceTabId, { active: true }], this.#runtime, this.#mode);
      } catch {
      }
    }
  };
  function activationTarget(webOrigin) {
    try {
      const configured = new URL(webOrigin);
      if (configured.protocol !== "https:" && configured.protocol !== "http:" || configured.username || configured.password) {
        return null;
      }
      return Object.freeze({
        origin: configured.origin,
        queryPattern: `${configured.protocol}//${configured.hostname}/*`,
        url: new URL(FIRST_INSTALL_ACTIVATION_PATH, configured.origin).href
      });
    } catch {
      return null;
    }
  }
  function tabUsesOrigin(tab, origin) {
    if (typeof tab !== "object" || tab === null || typeof tab.id !== "number" || typeof tab.url !== "string") {
      return false;
    }
    try {
      return new URL(tab.url).origin === origin;
    } catch {
      return false;
    }
  }
  async function platformIsIos(runtime, mode) {
    if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) {
      return true;
    }
    if (typeof runtime.getPlatformInfo !== "function") return false;
    try {
      const info = await extensionCall(
        runtime,
        "getPlatformInfo",
        [],
        runtime,
        mode
      );
      return typeof info === "object" && info !== null && info.os === "ios";
    } catch {
      return false;
    }
  }
  function installTraceFirstInstallActivation(options) {
    const target = activationTarget(options.webOrigin);
    if (!target || !options.runtime.onInstalled) return;
    options.runtime.onInstalled.addListener((details) => {
      if (details.reason !== "install") return;
      void (async () => {
        if (await platformIsIos(options.runtime, options.mode)) return;
        if (!declaresHostPattern(options.runtime, target.queryPattern)) return;
        try {
          void Promise.resolve(options.onActivation?.()).catch(() => void 0);
        } catch {
        }
        try {
          const tabs = await extensionCall(
            options.tabs,
            "query",
            [{ url: [target.queryPattern] }],
            options.runtime,
            options.mode
          );
          const existing = tabs.find((tab) => tabUsesOrigin(tab, target.origin));
          if (existing && typeof options.tabs.update === "function") {
            try {
              await extensionCall(
                options.tabs,
                "update",
                [existing.id, { url: target.url, active: true }],
                options.runtime,
                options.mode
              );
              return;
            } catch {
            }
          }
        } catch {
        }
        try {
          await extensionCall(
            options.tabs,
            "create",
            [{ url: target.url, active: true }],
            options.runtime,
            options.mode
          );
        } catch {
        }
      })();
    });
  }

  // src/extension-runtime/connect-intent.mts
  var CONNECT_INTENT_KEY = "traceConnectIntentV1";
  var CONNECT_RETURN_KEY = "traceConnectReturnV1";
  var CONNECT_INTENT_TTL_MS = 30 * 6e4;
  async function rememberConnectIntent(storage, now = Date.now()) {
    try {
      await storage.set({ [CONNECT_INTENT_KEY]: now + CONNECT_INTENT_TTL_MS });
    } catch {
    }
  }
  async function hasConnectIntent(storage, now = Date.now()) {
    try {
      const values = await storage.get(CONNECT_INTENT_KEY);
      const expiresAt = values[CONNECT_INTENT_KEY];
      if (typeof expiresAt === "number" && expiresAt > now && expiresAt <= now + CONNECT_INTENT_TTL_MS) {
        return true;
      }
      if (expiresAt !== void 0) await clearConnectIntent(storage);
      return false;
    } catch {
      return false;
    }
  }
  async function clearConnectIntent(storage) {
    try {
      await storage.remove([CONNECT_INTENT_KEY, CONNECT_RETURN_KEY]);
    } catch {
    }
  }
  async function rememberConnectReturn(storage, sourceTabId, connectTabId) {
    try {
      await storage.set({ [CONNECT_RETURN_KEY]: { sourceTabId, connectTabId, expiresAt: Date.now() + CONNECT_INTENT_TTL_MS } });
    } catch {
    }
  }
  async function readConnectReturn(storage) {
    try {
      const value = (await storage.get(CONNECT_RETURN_KEY))[CONNECT_RETURN_KEY];
      if (value && Number.isInteger(value.sourceTabId) && Number.isInteger(value.connectTabId) && typeof value.expiresAt === "number" && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + CONNECT_INTENT_TTL_MS) {
        return { sourceTabId: value.sourceTabId, connectTabId: value.connectTabId };
      }
    } catch {
    }
    return null;
  }

  // src/extension-runtime/trace-web-status.mts
  var TraceWebStatusNotification = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #queryPattern;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      const webUrl = new URL(options.webOrigin);
      this.#webOrigin = webUrl.origin;
      this.#queryPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
    }
    async publish(state) {
      if (!declaresHostPattern(this.#runtime, this.#queryPattern)) return false;
      let tabs;
      try {
        tabs = await extensionCall(
          this.#tabs,
          "query",
          [{ url: [this.#queryPattern] }],
          this.#runtime,
          this.#mode
        );
      } catch {
        return false;
      }
      const message = Object.freeze({
        type: "TRACE_EXTENSION_STATUS_PUSH",
        state
      });
      for (const tab of tabs) {
        if (typeof tab.id !== "number" || !this.#isTraceWebUrl(tab.url)) continue;
        try {
          await extensionCall(
            this.#tabs,
            "sendMessage",
            [tab.id, message],
            this.#runtime,
            this.#mode
          );
        } catch {
        }
      }
      return true;
    }
    #isTraceWebUrl(rawUrl) {
      if (typeof rawUrl !== "string") return false;
      try {
        return new URL(rawUrl).origin === this.#webOrigin;
      } catch {
        return false;
      }
    }
  };

  // src/extension-runtime/archive-readiness-status.mts
  var ARCHIVE_READINESS_STATUS_KEY = "traceArchiveReadiness";
  var ARCHIVE_READINESS_ERROR_RECENT_MS = 24 * 60 * 60 * 1e3;
  function isRecord17(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function epochMillis(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }
  function hostKind(value) {
    return value === "ao3" || value === "ffn" || value === "unknown" ? value : null;
  }
  function actionKind(value) {
    return value === "track" || value === "quick_add" || value === "import" || value === "metadata" ? value : null;
  }
  function errorKind(value) {
    return value === "permission" || value === "unsupported_page" || value === "auth" || value === "parser" || value === "network" || value === "unknown" ? value : null;
  }
  function storedReadiness(value) {
    if (!isRecord17(value)) return Object.freeze({});
    const seenAt = epochMillis(value.lastArchiveSeenAt);
    const seenHost = hostKind(value.lastArchiveHostKind);
    const actionAt = epochMillis(value.lastArchiveActionAt);
    const action = actionKind(value.lastArchiveActionKind);
    const errorAt = epochMillis(value.lastArchiveErrorAt);
    const error = errorKind(value.lastArchiveErrorKind);
    return Object.freeze({
      ...seenAt === null ? {} : { lastArchiveSeenAt: seenAt },
      ...seenHost === null ? {} : { lastArchiveHostKind: seenHost },
      ...actionAt === null ? {} : { lastArchiveActionAt: actionAt },
      ...action === null ? {} : { lastArchiveActionKind: action },
      ...errorAt === null ? {} : { lastArchiveErrorAt: errorAt },
      ...error === null ? {} : { lastArchiveErrorKind: error }
    });
  }
  var BrowserArchiveReadinessStatus = class {
    #storage;
    #clock;
    #tail = Promise.resolve();
    constructor(storage, clock = { now: () => Date.now() }) {
      this.#storage = storage;
      this.#clock = clock;
    }
    record(event) {
      return this.#withLock(async () => {
        const at = Math.max(0, Math.trunc(this.#clock.now()));
        const values = await this.#storage.get(ARCHIVE_READINESS_STATUS_KEY);
        const previous = storedReadiness(values[ARCHIVE_READINESS_STATUS_KEY]);
        const next = { ...previous };
        if (event.seen !== false) {
          next.lastArchiveSeenAt = at;
          next.lastArchiveHostKind = event.hostKind;
        }
        if (event.actionKind !== void 0) {
          next.lastArchiveActionAt = at;
          next.lastArchiveActionKind = event.actionKind;
          delete next.lastArchiveErrorAt;
          delete next.lastArchiveErrorKind;
        }
        if (event.errorKind !== void 0) {
          next.lastArchiveErrorAt = at;
          next.lastArchiveErrorKind = event.errorKind;
        }
        await this.#storage.set({
          [ARCHIVE_READINESS_STATUS_KEY]: Object.freeze(next)
        });
      });
    }
    read() {
      return this.#withLock(async () => {
        const values = await this.#storage.get(ARCHIVE_READINESS_STATUS_KEY);
        const stored = storedReadiness(values[ARCHIVE_READINESS_STATUS_KEY]);
        const {
          lastArchiveErrorAt,
          lastArchiveErrorKind,
          ...publicFields
        } = stored;
        const errorIsRecent = lastArchiveErrorAt !== void 0 && lastArchiveErrorKind !== void 0 && this.#clock.now() - lastArchiveErrorAt <= ARCHIVE_READINESS_ERROR_RECENT_MS;
        return Object.freeze({
          ...publicFields,
          ...errorIsRecent ? { lastArchiveErrorKind } : {}
        });
      });
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-runtime/runtime-messages.mts
  var SESSION_MESSAGE_TYPES = Object.freeze({
    snapshot: "TRACE_SESSION_GET_SNAPSHOT",
    action: "TRACE_SESSION_ACTION",
    // Connect from an AO3/FFN page: the popup's Connect, plus opening Trace
    // when no signed-in Trace page can answer.
    archiveConnect: "TRACE_ARCHIVE_CONNECT",
    // A Trace page is signed in. Carries no credential; the background asks
    // the page for one only while a connect request is waiting.
    traceWebReady: "TRACE_WEB_READY",
    connectAndSave: "TRACE_CONNECT_AND_SAVE",
    quickAdd: "TRACE_QUICK_ADD",
    autoTrack: "TRACE_AUTO_TRACK",
    metadataBroadcast: "TRACE_METADATA_BROADCAST",
    libraryMetadataRefresh: "TRACE_LIBRARY_METADATA_REFRESH",
    savedFilterSync: SAVED_FILTER_SYNC_MESSAGE,
    projection: "TRACE_ACCOUNT_PROJECTION_GET",
    workState: "TRACE_WORK_STATE_GET",
    popupState: "TRACE_POPUP_GET_STATE",
    capacityRecovery: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE",
    importTrigger: "TRACE_IMPORT_TRIGGER",
    importOpenTabs: "TRACE_IMPORT_OPEN_TABS",
    firstStoryAdd: "TRACE_FIRST_STORY_ADD",
    setHiddenWork: "TRACE_SET_HIDDEN_WORK",
    setReaderStatus: "TRACE_SET_READER_STATUS",
    patchLibraryEntry: "TRACE_PATCH_LIBRARY_ENTRY",
    finishQualification: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    pendingFirstStory: "TRACE_IOS_PENDING_FIRST_STORY_GET",
    status: "TRACE_EXTENSION_STATUS_QUERY",
    openTraceUrl: TRACE_WEB_OPEN_MESSAGE
  });
  var ACCOUNT_PROJECTION_REVISION_KEY = "traceAccountProjectionRevisionV1";
  var WORK_KEY_PATTERN5 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var MAX_PROJECTION_WORK_KEYS = 250;
  var POPUP_PREFERENCE_KEYS = Object.freeze([
    "prefAutoTrackEnabled",
    "prefLibraryInlayEnabled",
    "prefAo3SavedFiltersEnabled",
    "prefMetadataImproveEnabled"
  ]);
  function isRecord18(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSessionAction(value) {
    return value === "connect" || value === "cancel" || value === "disconnect" || value === "retry" || value === "reconnect";
  }
  function pageAccountBinding(scope2) {
    if (scope2 === null) return null;
    let hash = 2166136261;
    const input = `${scope2.epoch}:${scope2.accountId}`;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${scope2.epoch.toString(36)}.${hash.toString(36)}`;
  }
  var PAGE_BINDING_PATTERN = /^[0-9a-z]{1,12}\.[0-9a-z]{1,8}$/;
  function toPublicSessionSnapshot(snapshot, options = {}) {
    return Object.freeze({
      state: snapshot.state,
      reason: snapshot.reason,
      canExecuteAuthenticated: snapshot.canExecuteAuthenticated,
      ...snapshot.state === "reconnect_required" && options.hasVerifiedAccount === false ? { neverConnected: true } : {}
    });
  }
  function toExtensionStatus(snapshot, options = {}) {
    const authState = snapshot.state === "connected" ? "connected" : snapshot.state === "signed_out" ? "signed_out" : snapshot.state === "reconnect_required" ? "reconnect_required" : "unknown";
    return Object.freeze({
      installed: true,
      connected: snapshot.state === "connected",
      authState,
      ...options.firstSaveSeen === void 0 ? {} : { firstSaveSeen: options.firstSaveSeen },
      ...options.browserKind === void 0 ? {} : { browserKind: options.browserKind },
      capabilities: Object.freeze({ firstStoryAdd: true }),
      ...options.readiness ?? {}
    });
  }
  function browserKind(runtime) {
    if (typeof runtime.getURL !== "function") return "unknown";
    try {
      const value = runtime.getURL("");
      if (typeof value !== "string") return "unknown";
      if (value.startsWith("chrome-extension://")) return "chrome";
      if (value.startsWith("moz-extension://")) return "firefox";
      if (value.startsWith("safari-web-extension://")) return "safari";
    } catch {
    }
    return "unknown";
  }
  function boundedProjectionWorkKeys(value, sender) {
    const host = archiveHostKindFromSender(sender);
    if (host === null || !Array.isArray(value) || value.length > MAX_PROJECTION_WORK_KEYS) {
      return null;
    }
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, host)) return null;
    const keys = [];
    const seen = /* @__PURE__ */ new Set();
    for (const candidate of value) {
      if (typeof candidate !== "string" || !WORK_KEY_PATTERN5.test(candidate) || !candidate.startsWith(`${host}:`)) {
        return null;
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        keys.push(candidate);
      }
    }
    return Object.freeze(keys);
  }
  function publicProjection(accountData, workKeys, now = Date.now()) {
    const entries = {};
    const workPreferences = {};
    const overlay = accountData?.overlay;
    if (overlay !== null && overlay !== void 0) {
      for (const workKey of workKeys) {
        const entry = overlay.entries[workKey];
        const preference = overlay.workPreferences[workKey];
        if (entry !== void 0) entries[workKey] = entry;
        if (preference !== void 0) workPreferences[workKey] = preference;
      }
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      workPreferences: Object.freeze(workPreferences),
      syncVersion: overlay?.syncVersion ?? null,
      capacity: publicCapacityRecovery(accountData, now)
    });
  }
  function publicCapacityRecovery(accountData, now = Date.now()) {
    const capacity = accountData?.capacityRecovery;
    if (capacity === null || capacity === void 0) return null;
    return Object.freeze({
      blocked: true,
      prompt: now >= capacity.nextPromptAt
    });
  }
  function publicWorkState(accountData, workKey) {
    const overlay = accountData?.overlay;
    const entry = overlay?.entries[workKey];
    if (overlay === null || overlay === void 0 || entry === void 0) return null;
    return Object.freeze({
      workKey,
      status: "saved",
      ...entry.entryId === void 0 ? {} : { entryId: entry.entryId },
      entry,
      syncVersion: overlay.syncVersion
    });
  }

  // src/extension-runtime/native-import.mts
  var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var MESSAGE_ATTEMPT_MS = 2500;
  var REQUEST_LIFETIME_MS = 6e5;
  var failure4 = () => Object.freeze({ ok: false, error: "native_import_unavailable" });
  var record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var NativeLibraryImportProducer = class {
    #runtime;
    #mode;
    #apiOrigin;
    #randomID;
    #now;
    #active = false;
    #reservation = null;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#mode = options.mode;
      this.#apiOrigin = new URL(options.apiOrigin).origin;
      this.#randomID = options.randomID;
      this.#now = options.now ?? Date.now;
    }
    async run(scope2, isCurrent, collect) {
      if (this.#active) return failure4();
      this.#active = true;
      let reservation = null;
      let staged = false;
      try {
        const previous = this.#reservation;
        if (previous !== null) {
          previous.abandoned = true;
          if (previous.handoffID === null) await this.#prepare(previous);
          await this.#cancel(previous);
          if (this.#reservation !== null) return failure4();
        }
        if (!scope2.accountId || new TextEncoder().encode(scope2.accountId).length > 256 || !Number.isSafeInteger(scope2.epoch) || scope2.epoch < 0 || !await isCurrent()) return failure4();
        const requestID = this.#randomID();
        const issued = this.#now();
        if (!UUID2.test(requestID) || !Number.isSafeInteger(issued)) return failure4();
        reservation = {
          requestID,
          issued,
          isCurrent,
          handoffID: null,
          // A request can first reach native just before its ten-minute admission
          // deadline; that reservation then has its own ten-minute lifetime.
          expiresAtMs: issued + 2 * REQUEST_LIFETIME_MS,
          abandoned: false,
          cancellation: null,
          prepare: Object.freeze({
            type: "TRACE_IOS_IMPORT_PREPARE",
            protocolVersion: 1,
            requestID,
            requestIssuedAtMs: issued,
            accountID: scope2.accountId,
            accountEpoch: scope2.epoch,
            apiOrigin: this.#apiOrigin
          })
        };
        this.#reservation = reservation;
        await this.#prepare(reservation);
        const { handoffID, expiresAtMs } = reservation;
        if (handoffID === null || !await isCurrent() || this.#now() >= expiresAtMs) return failure4();
        const result = await collect(async (payloadBase64) => {
          const current = async () => await isCurrent() && this.#now() < expiresAtMs;
          if (payloadBase64.length > 699052 || !await current()) return failure4();
          const ready = await this.#send({
            type: "TRACE_IOS_IMPORT_STAGE",
            protocolVersion: 1,
            requestID,
            handoffID,
            payloadBase64
          }, current);
          if (!record(ready) || ready.type !== "TRACE_IOS_IMPORT_STAGE" || ready.protocolVersion !== 1 || ready.ok !== true || ready.state !== "ready_to_open" || ready.handoffID !== handoffID || ready.expiresAtMs !== expiresAtMs || !await current()) return failure4();
          staged = true;
          return Object.freeze({ ok: true, state: "ready_to_open", handoffID, expiresAtMs });
        });
        return result;
      } catch {
        return failure4();
      } finally {
        if (!staged && reservation !== null) {
          reservation.abandoned = true;
          await this.#cancel(reservation).catch(() => void 0);
        }
        this.#active = false;
      }
    }
    async discardUnpublished(handoffID) {
      const reservation = this.#reservation;
      if (reservation?.handoffID !== handoffID) return;
      reservation.abandoned = true;
      await this.#cancel(reservation);
    }
    async #prepare(reservation) {
      await this.#send(
        reservation.prepare,
        async () => await reservation.isCurrent() && this.#now() < reservation.issued + REQUEST_LIFETIME_MS,
        (prepared) => {
          if (!record(prepared) || prepared.type !== "TRACE_IOS_IMPORT_PREPARE" || prepared.protocolVersion !== 1 || prepared.ok !== true || prepared.state !== "prepared" || typeof prepared.handoffID !== "string" || !UUID2.test(prepared.handoffID) || typeof prepared.expiresAtMs !== "number" || !Number.isSafeInteger(prepared.expiresAtMs) || prepared.expiresAtMs > reservation.issued + 2 * REQUEST_LIFETIME_MS || prepared.maximumPayloadBytes !== 524288 || prepared.maximumItems !== 250 || reservation.handoffID !== null && (reservation.handoffID !== prepared.handoffID || reservation.expiresAtMs !== prepared.expiresAtMs)) return;
          reservation.handoffID = prepared.handoffID;
          reservation.expiresAtMs = prepared.expiresAtMs;
          if (reservation.abandoned) void this.#cancel(reservation).catch(() => void 0);
        }
      );
    }
    #cancel(reservation) {
      if (this.#reservation !== reservation) return Promise.resolve();
      if (reservation.cancellation !== null) return reservation.cancellation;
      const operation = (async () => {
        if (this.#now() >= reservation.expiresAtMs) {
          if (this.#reservation === reservation) this.#reservation = null;
          return;
        }
        if (reservation.handoffID === null) return;
        const cancelled = await this.#send({
          type: "TRACE_IOS_IMPORT_CANCEL",
          protocolVersion: 1,
          requestID: reservation.requestID,
          handoffID: reservation.handoffID
        });
        if (record(cancelled) && cancelled.type === "TRACE_IOS_IMPORT_CANCEL" && cancelled.protocolVersion === 1 && (cancelled.ok === true && cancelled.state === "cancelled" || cancelled.ok === false && (cancelled.error === "expired" || cancelled.error === "replayed"))) {
          if (this.#reservation === reservation) this.#reservation = null;
        }
      })();
      reservation.cancellation = operation;
      void operation.finally(() => {
        reservation.cancellation = null;
      }).catch(() => void 0);
      return operation;
    }
    async #send(message, isCurrent = async () => true, observeResponse) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!await isCurrent()) return null;
        const response = await sendNativeMessageWithFallback(
          this.#runtime,
          this.#mode,
          message,
          MESSAGE_ATTEMPT_MS,
          {
            mayFallback: isCurrent,
            ...observeResponse === void 0 ? {} : { observeResponse }
          }
        );
        if (response !== null) return response;
      }
      return null;
    }
  };

  // src/extension-runtime/summary-fill-storage.mts
  function usableArea(area) {
    return area && typeof area.get === "function" ? area : null;
  }
  var StoredSessionState = class {
    #area;
    #key;
    #validate;
    #ttlMs;
    #now;
    #memory = null;
    constructor(area, key, validate, options = {}) {
      this.#area = usableArea(area);
      this.#key = key;
      this.#validate = validate;
      this.#ttlMs = options.ttlMs ?? null;
      this.#now = options.now ?? (() => Date.now());
    }
    get durable() {
      return this.#area !== null;
    }
    async read() {
      let state;
      if (this.#area === null) {
        state = this.#memory;
      } else {
        try {
          const values = await this.#area.get(this.#key);
          state = this.#validate(values?.[this.#key]);
        } catch {
          state = this.#memory;
        }
      }
      if (state !== null && state.exp !== void 0 && state.exp <= this.#now()) {
        await this.clear();
        return null;
      }
      return state;
    }
    async write(state) {
      const stored = this.#ttlMs === null ? state : Object.freeze({ ...state, exp: state.exp ?? this.#now() + this.#ttlMs });
      this.#memory = stored;
      if (this.#area === null) return;
      try {
        await this.#area.set({ [this.#key]: stored });
      } catch {
      }
    }
    async clear() {
      this.#memory = null;
      if (this.#area === null) return;
      try {
        await this.#area.remove(this.#key);
      } catch {
      }
    }
  };
  var StoredAttemptedIds = class {
    #area;
    #key;
    #idPattern;
    #max;
    #memory = null;
    constructor(area, options) {
      this.#area = usableArea(area);
      this.#key = options.key;
      this.#idPattern = options.idPattern;
      this.#max = options.max;
    }
    async #load() {
      if (this.#area === null) return this.#memory;
      try {
        const values = await this.#area.get(this.#key);
        const value = values?.[this.#key];
        if (!value || typeof value.account !== "string" || !Array.isArray(value.ids) || !value.ids.every((id) => typeof id === "string" && this.#idPattern.test(id))) {
          return null;
        }
        return { account: value.account, ids: value.ids.slice(-this.#max) };
      } catch {
        return this.#memory;
      }
    }
    async read(account) {
      const stored = await this.#load();
      return stored !== null && stored.account === account ? stored.ids : [];
    }
    async add(account, storyIds) {
      const previous = await this.read(account);
      const ids = [...previous.filter((id) => !storyIds.includes(id)), ...storyIds].filter((id) => this.#idPattern.test(id)).slice(-this.#max);
      const next = { account, ids };
      this.#memory = next;
      if (this.#area === null) return;
      try {
        await this.#area.set({ [this.#key]: next });
      } catch {
      }
    }
    async keepOnly(account) {
      const stored = await this.#load();
      if (stored !== null && stored.account !== account) await this.clear();
    }
    async clear() {
      this.#memory = null;
      if (this.#area === null) return;
      try {
        await this.#area.remove(this.#key);
      } catch {
      }
    }
  };

  // src/extension-runtime/ffn-summary-fill.mts
  var FFN_SUMMARY_STATE_KEY = "traceFfnSummaryFillV1";
  var FFN_SUMMARY_ATTEMPTED_KEY = "traceFfnSummaryAttemptedV1";
  var REQUEST_GAP_MS = 3e4;
  var SAVE_SETTLE_MS = 2e4;
  var BACKFILL_GAP_MS = 3 * 6e4;
  var BACKFILL_MAX_PER_SESSION = 10;
  var ON_SAVE_MAX_PER_SESSION = 30;
  var STOP_MS = 60 * 6e4;
  var PENDING_MAX = 5;
  var PENDING_TRIES_MAX = 2;
  var QUEUE_MAX = 50;
  var LOCAL_STATE_TTL_MS = 12 * 60 * 6e4;
  var RECENT_TAB_MS = 2 * 6e4;
  var ATTEMPTED_MAX = 200;
  var TAB_READ_TIMEOUT_MS = 15e3;
  var MAX_TAB_READ_BYTES = 2 * 1024 * 1024;
  var MAX_RETURN_CHARS = 256 * 1024;
  var ROW_MAX_CHARS = 8192;
  var SUMMARY_MAX_CHARS = 4e3;
  var ID_PATTERN = /^[1-9][0-9]{0,19}$/;
  var FFN_HOSTS = Object.freeze(["www.fanfiction.net", "m.fanfiction.net"]);
  var RECENT_MAX = 50;
  var NAMED_ENTITIES = Object.freeze({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "\u2026",
    mdash: "\u2014",
    ndash: "\u2013",
    lsquo: "\u2018",
    rsquo: "\u2019",
    ldquo: "\u201C",
    rdquo: "\u201D"
  });
  function decodeEntities(text2) {
    return text2.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
        return Number.isSafeInteger(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
  }
  function plainText(markup) {
    return decodeEntities(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  }
  function classTokens(startTag) {
    const value = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(startTag);
    return (value?.[1] ?? value?.[2] ?? value?.[3] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  }
  var STORY_CONTENT_PATTERN = /<div\b[^>]*\bid\s*=\s*["']?(?:content|profile_top)\b[^>]*>/i;
  var AUTHOR_LINK_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']?[^"'\s>]*\/u\/([1-9][0-9]{0,19})(?:[/?#"'\s>])/i;
  var STORY_LINK_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']?[^"'\s>]*\/s\/([1-9][0-9]{0,19})\/[^>]*>/i;
  var DIV_START_PATTERN = /<div\b[^>]*>/gi;
  function ffnAuthorIdFromStoryHtml(html) {
    if (typeof html !== "string") return null;
    const content = STORY_CONTENT_PATTERN.exec(html);
    if (content === null) return null;
    const block = html.slice(content.index, content.index + ROW_MAX_CHARS);
    return AUTHOR_LINK_PATTERN.exec(block)?.[1] ?? null;
  }
  function divWithClasses(markup, names) {
    const pattern = new RegExp(DIV_START_PATTERN.source, "gi");
    for (let match = pattern.exec(markup); match !== null; match = pattern.exec(markup)) {
      const classes = classTokens(match[0]);
      if (names.every((name) => classes.includes(name))) {
        return { index: match.index, end: match.index + match[0].length };
      }
    }
    return null;
  }
  function summaryFromRow(row, kind) {
    if (kind === "mobile") {
      const gray = divWithClasses(row, ["gray"]);
      if (gray === null) return null;
      const beforeGray = row.slice(0, gray.index);
      const lastLinkEnd = beforeGray.toLowerCase().lastIndexOf("</a>");
      return lastLinkEnd === -1 ? "" : plainText(beforeGray.slice(lastLinkEnd + 4));
    }
    const indent = divWithClasses(row, ["z-indent"]);
    if (indent === null) return null;
    const inside = row.slice(indent.end);
    const details = divWithClasses(inside, ["z-padtop2"]) ?? divWithClasses(inside, ["xgray"]);
    if (details === null) return null;
    return plainText(inside.slice(0, details.index));
  }
  function ffnSummariesFromStoryListHtml(html) {
    const summaries = /* @__PURE__ */ new Map();
    if (typeof html !== "string") return { rows: 0, summaries };
    const starts = [];
    const pattern = new RegExp(DIV_START_PATTERN.source, "gi");
    for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
      const classes = classTokens(match[0]);
      if (classes.includes("bs")) starts.push({ index: match.index, kind: "mobile" });
      else if (classes.includes("z-list") && classes.includes("mystories")) {
        starts.push({ index: match.index, kind: "desktop" });
      }
    }
    let rows = 0;
    starts.forEach((start, index) => {
      const end = Math.min(starts[index + 1]?.index ?? html.length, start.index + ROW_MAX_CHARS);
      const row = html.slice(start.index, end);
      const story = STORY_LINK_PATTERN.exec(row);
      if (story === null) return;
      const summary = summaryFromRow(row, start.kind);
      if (summary === null) return;
      rows += 1;
      const storyId = story[1];
      const text2 = summary.slice(0, SUMMARY_MAX_CHARS);
      if (text2 && !summaries.has(storyId)) summaries.set(storyId, text2);
    });
    return { rows, summaries };
  }
  function isFfnStoryNotFoundPage(html) {
    if (typeof html !== "string") return false;
    const warning = /<[^>]*\bclass\s*=\s*["']?[^"'>]*\bgui_warning\b[^>]*>([\s\S]{0,400})/i.exec(html);
    const text2 = warning?.[1] ?? "";
    return /Story\s+Not\s+Found/i.test(text2) || /Unable\s+to\s+locate\s+story/i.test(text2);
  }
  function isChallengePage(html, headers) {
    if (headers?.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
    const head = html.slice(0, 8192);
    return /<title>\s*(?:just a moment|attention required|please wait)/i.test(head) || /\/cdn-cgi\/challenge-platform\//i.test(head) || /\bcf[-_]chl[-_]/i.test(head) || /\bchallenge-form\b/i.test(head);
  }
  var NO_NOTE = Object.freeze({ status: null, host: null, path: null, cf: null });
  function ffnPathType(pathname) {
    if (/^\/u\/[1-9][0-9]{0,19}(?:\/|$)/.test(pathname)) return "author";
    if (/^\/s\/[1-9][0-9]{0,19}(?:\/|$)/.test(pathname)) return "story";
    return "other";
  }
  function cfNote(value) {
    if (value === null || value === "") return null;
    const lower = value.trim().toLowerCase();
    return /^[a-z_-]{1,20}$/.test(lower) ? lower : "other";
  }
  function classifyFfnAnswer(answer, host, expectedPath, requestedPath) {
    if (answer.kind === "failed") {
      const note2 = { ...NO_NOTE, host, path: requestedPath };
      return answer.code === "timeout" || answer.code === "network" ? { kind: "stop", reason: "error", note: note2 } : { kind: "tab", code: answer.code, note: note2 };
    }
    let landed = null;
    try {
      landed = new URL(answer.url);
    } catch {
      landed = null;
    }
    const note = {
      status: Number.isSafeInteger(answer.status) ? answer.status : null,
      host: landed !== null && /^[a-z0-9.-]{1,80}$/i.test(landed.hostname) ? landed.hostname.toLowerCase() : host,
      path: landed !== null ? ffnPathType(landed.pathname) : requestedPath,
      cf: cfNote(answer.cfMitigated)
    };
    if (note.cf === "challenge") return { kind: "stop", reason: "challenge", note };
    if (landed === null || landed.protocol !== "https:" || landed.hostname !== host || !expectedPath(landed.pathname)) {
      return { kind: "stop", reason: isChallengePage(answer.html) ? "challenge" : "redirect", note };
    }
    if (answer.status !== 200) {
      return { kind: "stop", reason: isChallengePage(answer.html) ? "challenge" : "status", note };
    }
    if (!/text\/html/i.test(answer.contentType ?? "")) return { kind: "stop", reason: "not_html", note };
    if (isChallengePage(answer.html)) return { kind: "stop", reason: "challenge", note };
    return { kind: "page", html: answer.html, note };
  }
  async function readFfnPageInTab(host, path, maxBytes, maxChars) {
    if (location.protocol !== "https:" || location.hostname !== host) return { ok: false, error: "moved" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15e3);
    try {
      const response = await fetch(`https://${host}${path}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "follow",
        headers: { Accept: "text/html" },
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type");
      let text2 = "";
      const body = response.body;
      if (/text\/html/i.test(contentType || "") && body && typeof body.getReader === "function") {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
          for (; ; ) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            text2 += decoder.decode(chunk.value, { stream: true });
            if (bytes >= maxBytes) break;
          }
        } finally {
          reader.cancel().catch(() => void 0);
        }
      } else if (body) {
        body.cancel().catch(() => void 0);
      }
      const own = text2.search(/<div\b[^>]*\bclass\s*=\s*["']?z-list mystories\b/i);
      const html = text2.slice(Math.max(0, own), Math.max(0, own) + maxChars);
      return {
        ok: true,
        status: response.status,
        url: response.url,
        html,
        contentType,
        cfMitigated: response.headers.get("cf-mitigated")
      };
    } catch (_) {
      return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }
  function isRecord19(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function stringOrNull(value) {
    return typeof value === "string" ? value.slice(0, 200) : null;
  }
  function createFfnTabReader(environment) {
    const timeoutMs = environment.timeoutMs ?? TAB_READ_TIMEOUT_MS + 5e3;
    return {
      async tabHost(tabId) {
        if (!environment.hasScripting) return { code: "no_result" };
        let tab;
        try {
          tab = await environment.getTab(tabId);
        } catch {
          return { code: "tab_gone" };
        }
        if (!isRecord19(tab) || typeof tab.url !== "string") return { code: "tab_not_ffn" };
        let url;
        try {
          url = new URL(tab.url);
        } catch {
          return { code: "tab_not_ffn" };
        }
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || !FFN_HOSTS.includes(host)) return { code: "tab_not_ffn" };
        const allowed = await environment.containsOrigin(`https://${host}/*`).catch(() => false);
        return allowed ? { host } : { code: "not_allowed" };
      },
      async readInTab(tabId, host, path) {
        let results;
        try {
          results = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve("timeout"), timeoutMs);
            environment.executeScript({
              target: { tabId, frameIds: [0] },
              func: readFfnPageInTab,
              args: [host, path, MAX_TAB_READ_BYTES, MAX_RETURN_CHARS]
            }).then(
              (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              (error) => {
                clearTimeout(timer);
                reject(error);
              }
            );
          });
        } catch {
          return { kind: "failed", code: "no_result" };
        }
        if (results === "timeout") return { kind: "failed", code: "timeout" };
        const first = Array.isArray(results) ? results[0] : void 0;
        const result = isRecord19(first) ? first.result : void 0;
        if (!isRecord19(result)) return { kind: "failed", code: "no_result" };
        if (result.ok !== true) {
          if (result.error === "moved") return { kind: "failed", code: "tab_not_ffn" };
          return { kind: "failed", code: result.error === "timeout" ? "timeout" : "network" };
        }
        if (typeof result.status !== "number" || typeof result.url !== "string" || typeof result.html !== "string") {
          return { kind: "failed", code: "no_result" };
        }
        return {
          kind: "response",
          status: result.status,
          url: result.url,
          html: result.html.slice(0, MAX_RETURN_CHARS),
          contentType: stringOrNull(result.contentType),
          cfMitigated: stringOrNull(result.cfMitigated)
        };
      }
    };
  }
  var StoredAttempted = class extends StoredAttemptedIds {
    constructor(area) {
      super(area, { key: FFN_SUMMARY_ATTEMPTED_KEY, idPattern: ID_PATTERN, max: ATTEMPTED_MAX });
    }
  };
  var CODE_PATTERN = /^[a-z_]{1,32}$/;
  function validStory(value, withTries) {
    if (!isRecord19(value)) return false;
    return Object.keys(value).every((key) => key === "s" || key === "a" || withTries && key === "n") && typeof value.s === "string" && ID_PATTERN.test(value.s) && (value.a === void 0 || typeof value.a === "string" && ID_PATTERN.test(value.a)) && (value.n === void 0 || Number.isSafeInteger(value.n) && value.n >= 0);
  }
  function validNote(value) {
    return (value.status === null || Number.isSafeInteger(value.status)) && (value.host === null || typeof value.host === "string" && /^[a-z0-9.-]{1,80}$/.test(value.host)) && (value.path === null || value.path === "author" || value.path === "story" || value.path === "other") && (value.cf === null || typeof value.cf === "string" && /^[a-z_-]{1,20}$/.test(value.cf));
  }
  var finite = (value) => typeof value === "number" && Number.isFinite(value);
  function validStop(value) {
    if (value === null) return true;
    return isRecord19(value) && validNote(value) && typeof value.reason === "string" && CODE_PATTERN.test(value.reason) && finite(value.at) && finite(value.until);
  }
  function validLast(value) {
    if (value === null) return true;
    return isRecord19(value) && validNote(value) && (value.trigger === "save" || value.trigger === "page") && typeof value.stage === "string" && CODE_PATTERN.test(value.stage) && typeof value.outcome === "string" && CODE_PATTERN.test(value.outcome) && (value.rows === null || Number.isSafeInteger(value.rows)) && (value.found === null || Number.isSafeInteger(value.found)) && (value.send === null || value.send === "accepted" || value.send === "skipped" || value.send === "failed") && finite(value.at);
  }
  function validState(value) {
    if (!isRecord19(value)) return null;
    if (value.v !== 3 || typeof value.account !== "string" || !Array.isArray(value.pending) || value.pending.length > PENDING_MAX || !value.pending.every((item) => validStory(item, true)) || !Array.isArray(value.queue) || value.queue.length > QUEUE_MAX || !value.queue.every((item) => validStory(item, false)) || typeof value.listed !== "boolean" || !Number.isSafeInteger(value.backfills) || !Number.isSafeInteger(value.saves) || !finite(value.lastRequestAt) || !finite(value.lastBackfillAt) || !validStop(value.stop) || !validLast(value.last) || value.exp !== void 0 && !finite(value.exp)) {
      return null;
    }
    return value;
  }
  var StoredFillState = class extends StoredSessionState {
    constructor(area, options = {}) {
      super(area, FFN_SUMMARY_STATE_KEY, validState, options);
    }
  };
  function freshState(account) {
    return Object.freeze({
      v: 3,
      account,
      pending: Object.freeze([]),
      queue: Object.freeze([]),
      listed: false,
      backfills: 0,
      saves: 0,
      lastRequestAt: Number.MIN_SAFE_INTEGER,
      lastBackfillAt: Number.MIN_SAFE_INTEGER,
      stop: null,
      last: null
    });
  }
  function storyIdFromWorkKey(workKey) {
    const match = /^ffn:([1-9][0-9]{0,19})$/.exec(workKey);
    return match?.[1] ?? null;
  }
  var FfnSummaryFill = class {
    #ports;
    #tail = Promise.resolve();
    /** A step waiting its turn, and what it should run with. */
    #queued = null;
    #next = null;
    #savesInFlight = 0;
    #lastSaveAt = Number.NEGATIVE_INFINITY;
    /** The FanFiction.net tab that last spoke to Trace, and when. */
    #tab = null;
    /** Raised by every sign-out, account change or reset; a step from before writes nothing. */
    #generation = 0;
    /** The generation the running step started in. */
    #runGeneration = 0;
    /** Stories added on save in this background's lifetime, so a later chapter does not add again. */
    #recent = [];
    constructor(ports) {
      this.#ports = ports;
    }
    /** A save to Trace is starting. */
    saveStarted() {
      this.#savesInFlight += 1;
      this.#lastSaveAt = this.#ports.clock.now();
    }
    /** A save to Trace has ended. */
    saveEnded() {
      this.#savesInFlight = Math.max(0, this.#savesInFlight - 1);
      this.#lastSaveAt = this.#ports.clock.now();
    }
    /**
     * A save to Trace was confirmed. When it was a new FFN story saved from a
     * story page that showed no summary, its read is added to the stored work
     * and tried now in the tab it was saved from, when there is one.
     */
    storySaved(story, alreadyInLibrary, tabId) {
      if (story.hostKind !== "ffn" || alreadyInLibrary) return Promise.resolve();
      const item = story.payload.item;
      if (item === void 0 || item === null || typeof item !== "object" || item.ctx !== "story") {
        return Promise.resolve();
      }
      if (typeof item.sm === "string" && item.sm.trim().length > 0) return Promise.resolve();
      const storyId = storyIdFromWorkKey(story.workKey);
      if (storyId === null || this.#recent.includes(storyId)) return Promise.resolve();
      const authorId = typeof story.ffnAuthorId === "string" && ID_PATTERN.test(story.ffnAuthorId) ? story.ffnAuthorId : void 0;
      this.#recent.push(storyId);
      if (this.#recent.length > RECENT_MAX) this.#recent.shift();
      const tab = typeof tabId === "number" && Number.isSafeInteger(tabId) ? tabId : this.#recentTab();
      return this.#serial(() => this.#addPending(storyId, authorId)).then(() => tab === null ? void 0 : this.#kick("save", tab));
    }
    /**
     * A FanFiction.net page spoke to Trace (it loaded, or the reader moved on
     * it): any work due is done now, in that page's tab.
     */
    ffnPageActivity(tabId) {
      if (!Number.isSafeInteger(tabId)) return Promise.resolve();
      this.#tab = { id: tabId, at: this.#ports.clock.now() };
      return this.#kick("page", tabId);
    }
    /** The fill's stored state, for a test build's status line. */
    async status() {
      try {
        return await this.#ports.state.read();
      } catch {
        return null;
      }
    }
    /** Sign-out or another account: forget everything. */
    async clear() {
      await this.reset();
      await this.#ports.attempted.clear();
    }
    /** Forgets the session's state (work, counters, stop and record); the tried list stays. */
    async reset() {
      this.#generation += 1;
      this.#recent.length = 0;
      this.#tab = null;
      await this.#ports.state.clear();
    }
    #recentTab() {
      if (this.#tab === null) return null;
      return this.#ports.clock.now() - this.#tab.at <= RECENT_TAB_MS ? this.#tab.id : null;
    }
    /** Runs a step in `tabId`; steps asked for while one waits share it. */
    #kick(trigger, tabId) {
      if (this.#next === null || trigger === "save" || this.#next.trigger !== "save") {
        this.#next = { trigger, tabId };
      }
      this.#queued ??= this.#serial(async () => {
        this.#queued = null;
        const next = this.#next;
        this.#next = null;
        if (next !== null) await this.#step(next.trigger, next.tabId);
      });
      return this.#queued;
    }
    #serial(work) {
      const run = this.#tail.then(async () => {
        this.#runGeneration = this.#generation;
        try {
          await work();
        } catch {
        }
      });
      this.#tail = run;
      return run;
    }
    /** Whether the running step still belongs to the current sign-in. */
    #current() {
      return this.#runGeneration === this.#generation;
    }
    /** Writes state only for the current sign-in; false when the step is stale. */
    async #write(state) {
      if (!this.#current()) return false;
      await this.#ports.state.write(state);
      return this.#current();
    }
    /** The session's state for the signed-in account, or null when signed out. */
    async #state() {
      const account = this.#ports.account();
      if (account === null) {
        await this.clear();
        return null;
      }
      const stored = await this.#ports.state.read();
      if (!this.#current()) return null;
      if (stored !== null && stored.account === account) return stored;
      await this.#ports.attempted.keepOnly(account).catch(() => void 0);
      const fresh = freshState(account);
      return await this.#write(fresh) ? fresh : null;
    }
    /** Remembers stories tried, for the signed-in account only. */
    async #attempt(state, storyIds) {
      if (!this.#current() || storyIds.length === 0) return;
      try {
        await this.#ports.attempted.add(state.account, storyIds);
      } catch {
      }
    }
    #shuffled(items) {
      const random = this.#ports.random ?? Math.random;
      const out = [...items];
      for (let index = out.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [out[index], out[other]] = [out[other], out[index]];
      }
      return out;
    }
    async #addPending(storyId, authorId) {
      const state = await this.#state();
      if (state === null) return;
      const known = state.pending.find(({ s }) => s === storyId);
      if (known !== void 0 && (known.a !== void 0 || authorId === void 0)) return;
      if (known === void 0 && state.pending.length >= PENDING_MAX) return;
      const entry = Object.freeze({
        s: storyId,
        ...authorId === void 0 ? {} : { a: authorId },
        ...known?.n === void 0 ? {} : { n: known.n }
      });
      const pending = known === void 0 ? [...state.pending, entry] : state.pending.map((story) => story.s === storyId ? entry : story);
      await this.#write(Object.freeze({
        ...state,
        pending: Object.freeze(pending),
        // A save's read comes first; the backfill does not read it again.
        queue: Object.freeze(state.queue.filter(({ s }) => s !== storyId))
      }));
    }
    /** What is due now, if anything. */
    #due(state, now) {
      if (state.stop !== null && now < state.stop.until) return null;
      if (now - state.lastRequestAt < REQUEST_GAP_MS) return null;
      if (this.#savesInFlight > 0) return null;
      const waiting = state.pending[0];
      if (waiting !== void 0 && state.saves < ON_SAVE_MAX_PER_SESSION) {
        return { kind: "read", from: "pending", story: waiting };
      }
      if (!this.#ports.state.durable) return null;
      if (now - this.#lastSaveAt < SAVE_SETTLE_MS) return null;
      if (state.backfills >= BACKFILL_MAX_PER_SESSION) return null;
      if (now - state.lastBackfillAt < BACKFILL_GAP_MS) return null;
      if (!state.listed) return { kind: "list" };
      const head = state.queue[0];
      return head === void 0 ? null : { kind: "read", from: "queue", story: head };
    }
    #last(trigger, stage, outcome, note = NO_NOTE, extra = {}) {
      return Object.freeze({
        trigger,
        stage,
        outcome,
        ...note,
        rows: extra.rows ?? null,
        found: extra.found ?? null,
        send: extra.send ?? null,
        at: this.#ports.clock.now()
      });
    }
    /** Pauses the fill for `STOP_MS`, with what stopped it; the work is kept. */
    async #stop(state, work, reason, note, last) {
      const now = this.#ports.clock.now();
      let pending = state.pending;
      if (work.kind === "read" && work.from === "pending") {
        const tries = (work.story.n ?? 0) + 1;
        pending = tries >= PENDING_TRIES_MAX ? state.pending.filter(({ s }) => s !== work.story.s) : state.pending.map((story) => story.s === work.story.s ? Object.freeze({ ...story, n: tries }) : story);
      }
      await this.#write(Object.freeze({
        ...state,
        pending: Object.freeze(pending),
        stop: Object.freeze({ reason, ...note, at: now, until: now + STOP_MS }),
        last
      }));
    }
    async #step(trigger, tabId) {
      const state = await this.#state();
      if (state === null) return;
      const now = this.#ports.clock.now();
      const work = this.#due(state, now);
      if (work === null) return;
      let enabled = false;
      try {
        enabled = await this.#ports.contributionsEnabled();
      } catch {
        enabled = false;
      }
      if (!enabled) {
        await this.#write(Object.freeze({
          ...state,
          pending: Object.freeze([]),
          queue: Object.freeze([]),
          listed: false,
          lastBackfillAt: now,
          last: this.#last(trigger, "check", "off")
        }));
        return;
      }
      if (work.kind === "list") {
        await this.#list(state, trigger, now);
        return;
      }
      const tab = await this.#ports.tabs.tabHost(tabId);
      if (!this.#current()) return;
      if ("code" in tab) {
        await this.#write(Object.freeze({ ...state, last: this.#last(trigger, "check", tab.code) }));
        return;
      }
      const counted = Object.freeze({
        ...state,
        lastRequestAt: now,
        ...work.from === "pending" ? { saves: state.saves + 1 } : { backfills: state.backfills + 1, lastBackfillAt: now }
      });
      if (!await this.#write(counted)) return;
      if (work.story.a === void 0) {
        await this.#lookUpAuthor(counted, work, trigger, tabId, tab.host);
      } else {
        await this.#readAuthor(counted, work, work.story.a, trigger, tabId, tab.host);
      }
    }
    async #list(state, trigger, now) {
      const gaps = await this.#ports.listGaps().catch(() => null);
      if (!this.#current()) return;
      const listedAt = Object.freeze({ ...state, lastBackfillAt: now });
      if (gaps === null) {
        await this.#stop(listedAt, { kind: "list" }, "gaps", NO_NOTE, this.#last(trigger, "gaps", "gaps"));
        return;
      }
      let attempted = [];
      try {
        attempted = await this.#ports.attempted.read(state.account);
      } catch {
        attempted = [];
      }
      const waiting = new Set(state.pending.map(({ s }) => s));
      const fresh = gaps.filter((id) => typeof id === "string" && ID_PATTERN.test(id)).filter((id, index, all) => all.indexOf(id) === index && !waiting.has(id) && !this.#recent.includes(id));
      const queue = [
        ...this.#shuffled(fresh.filter((id) => !attempted.includes(id))),
        ...fresh.filter((id) => attempted.includes(id)).sort((a, b) => attempted.indexOf(a) - attempted.indexOf(b))
      ].slice(0, QUEUE_MAX).map((s) => Object.freeze({ s }));
      await this.#write(Object.freeze({
        ...listedAt,
        listed: true,
        queue: Object.freeze(queue),
        last: this.#last(trigger, "gaps", "listed", NO_NOTE, { rows: queue.length })
      }));
    }
    /** Drops stories from the work, wherever they wait. */
    #without(state, storyIds) {
      return Object.freeze({
        ...state,
        pending: Object.freeze(state.pending.filter(({ s }) => !storyIds.has(s))),
        queue: Object.freeze(state.queue.filter(({ s }) => !storyIds.has(s)))
      });
    }
    /** This step's one request: the story's own page, for its author. */
    async #lookUpAuthor(state, work, trigger, tabId, host) {
      const storyId = work.story.s;
      await this.#attempt(state, [storyId]);
      const answer = await this.#ports.tabs.readInTab(tabId, host, `/s/${storyId}/1/`);
      if (!this.#current()) return;
      const read = classifyFfnAnswer(
        answer,
        host,
        (pathname) => pathname === `/s/${storyId}` || pathname.startsWith(`/s/${storyId}/`),
        "story"
      );
      if (read.kind === "tab") {
        await this.#write(Object.freeze({ ...state, last: this.#last(trigger, "story_page", read.code, read.note) }));
        return;
      }
      if (read.kind === "stop") {
        await this.#stop(state, work, read.reason, read.note, this.#last(trigger, "story_page", read.reason, read.note));
        return;
      }
      const authorId = ffnAuthorIdFromStoryHtml(read.html);
      if (authorId === null) {
        if (isFfnStoryNotFoundPage(read.html)) {
          await this.#write(Object.freeze({
            ...this.#without(state, /* @__PURE__ */ new Set([storyId])),
            last: this.#last(trigger, "story_page", "gone", read.note)
          }));
          return;
        }
        await this.#stop(state, work, "missing", read.note, this.#last(trigger, "story_page", "missing", read.note));
        return;
      }
      const named = (story) => story.s === storyId ? Object.freeze({ ...story, a: authorId }) : story;
      await this.#write(Object.freeze({
        ...state,
        pending: Object.freeze(state.pending.map(named)),
        queue: Object.freeze(state.queue.map(named)),
        last: this.#last(trigger, "story_page", "author_found", read.note)
      }));
    }
    /**
     * Reads one author's story list and sends the summaries of every waiting
     * story of theirs on it.
     */
    async #readAuthor(state, work, authorId, trigger, tabId, host) {
      const storyIds = [
        work.story.s,
        ...[...state.pending, ...state.queue].filter(({ s, a }) => a === authorId && s !== work.story.s).map(({ s }) => s)
      ].filter((id, index, all) => all.indexOf(id) === index);
      await this.#attempt(state, storyIds);
      const answer = await this.#ports.tabs.readInTab(tabId, host, `/u/${authorId}/?a=s`);
      if (!this.#current()) return;
      const read = classifyFfnAnswer(
        answer,
        host,
        (pathname) => pathname === `/u/${authorId}` || pathname.startsWith(`/u/${authorId}/`),
        "author"
      );
      if (read.kind === "tab") {
        await this.#write(Object.freeze({ ...state, last: this.#last(trigger, "author_list", read.code, read.note) }));
        return;
      }
      if (read.kind === "stop") {
        await this.#stop(state, work, read.reason, read.note, this.#last(trigger, "author_list", read.reason, read.note));
        return;
      }
      const { rows, summaries } = ffnSummariesFromStoryListHtml(read.html);
      if (rows === 0) {
        await this.#stop(state, work, "missing", read.note, this.#last(trigger, "author_list", "missing", read.note, { rows: 0 }));
        return;
      }
      const found = [];
      for (const storyId of storyIds) {
        const summary = summaries.get(storyId);
        if (summary !== void 0) found.push(Object.freeze({ storyId, summary }));
      }
      const next = this.#without(state, new Set(storyIds));
      if (found.length === 0) {
        await this.#write(Object.freeze({
          ...next,
          last: this.#last(trigger, "author_list", "not_listed", read.note, { rows, found: 0 })
        }));
        return;
      }
      if (!await this.#write(next)) return;
      if (this.#ports.account() !== state.account || !this.#current()) return;
      let outcome = "failed";
      try {
        outcome = await this.#ports.contribute(found);
      } catch {
        outcome = "failed";
      }
      if (!this.#current()) return;
      const last = this.#last(trigger, "send", outcome === "accepted" ? "filled" : "send", read.note, {
        rows,
        found: found.length,
        send: outcome
      });
      if (outcome !== "accepted") {
        await this.#stop(next, work, "send", read.note, last);
        return;
      }
      await this.#write(Object.freeze({ ...next, last }));
    }
  };

  // src/extension-runtime/popup-page-relay.mts
  var POPUP_PAGE_PORT = "trace-popup-page-v1";
  var POPUP_PAGE_RELAY = "TRACE_POPUP_PAGE_RELAY";
  var FAILURE = Object.freeze({ ok: false, error: "page_unavailable" });
  var COMMANDS = /* @__PURE__ */ new Set(["TRACE_STORY_IDENTITY_GET", "TRACE_SAVED_NOTE_DISMISS", "TRACE_POPUP_QUICK_ADD", "TRACE_POPUP_SET_READER_STATUS", "TRACE_SCHEDULE_AUTO_TRACK"]);
  var COLLECT_COMMAND = Object.freeze({ type: "TRACE_COLLECT" });
  var record2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  function pageUrl(value) {
    try {
      const url = new URL(String(value));
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }
  var PopupPageRelay = class {
    #pages = /* @__PURE__ */ new Map();
    #options;
    #sequence = 0;
    constructor(options) {
      this.#options = options;
      options.runtime.onConnect?.addListener((port) => this.#connect(port));
    }
    accepts(message, sender) {
      return record2(message) && message.type === POPUP_PAGE_RELAY && typeof this.#options.runtime.id === "string" && sender?.tab == null && sender?.id === this.#options.runtime.id && isPopupSender(sender, this.#options.runtime.id);
    }
    /** The active page's Import data, for the background's Import controller. */
    collect(tabId) {
      return this.#request(tabId, COLLECT_COMMAND);
    }
    async request(tabId, command) {
      if (!record2(command) || !COMMANDS.has(String(command.type))) return FAILURE;
      return this.#request(tabId, command);
    }
    async #request(tabId, command) {
      if (!Number.isInteger(tabId)) return FAILURE;
      const tab = await this.#activeTab();
      const page = this.#pages.get(tabId);
      if (!page || tab?.id !== tabId || pageUrl(tab?.url) !== page.url || page.pending.size >= 8) return FAILURE;
      const id = ++this.#sequence;
      const scope2 = this.#options.scope();
      if ((command.type === "TRACE_POPUP_QUICK_ADD" || command.type === "TRACE_POPUP_SET_READER_STATUS") && scope2 === null) return FAILURE;
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(FAILURE), this.#options.timeoutMs ?? (command.type === "TRACE_STORY_IDENTITY_GET" ? 1e3 : command === COLLECT_COMMAND ? 5e3 : 22e3));
        const finish = (value) => {
          clearTimeout(timer);
          page.pending.delete(id);
          resolve(value);
        };
        page.pending.set(id, { command, scope: scope2, finish, executed: false });
        try {
          page.port.postMessage({ kind: "request", id, command });
        } catch {
          finish(FAILURE);
        }
      });
    }
    #connect(port) {
      const sender = port.sender;
      const tabId = sender?.tab?.id;
      const host = archiveHostKindFromSender(sender);
      const url = pageUrl(sender?.url);
      if (port.name !== POPUP_PAGE_PORT || typeof this.#options.runtime.id !== "string" || sender?.id !== this.#options.runtime.id || sender?.frameId !== 0 || !Number.isInteger(tabId) || host === null || url === null || pageUrl(sender?.tab?.url) !== url || isBlockedArchivePath(url, host)) return;
      const previous = this.#pages.get(tabId);
      if (previous) this.#remove(tabId, previous);
      const page = { port, sender, url, pending: /* @__PURE__ */ new Map() };
      this.#pages.set(tabId, page);
      port.onDisconnect.addListener(() => this.#remove(tabId, page));
      port.onMessage.addListener((message) => {
        void this.#receive(tabId, page, message).catch(() => this.#remove(tabId, page));
      });
    }
    #remove(tabId, page) {
      if (this.#pages.get(tabId) === page) this.#pages.delete(tabId);
      for (const pending of page.pending.values()) pending.finish(FAILURE);
    }
    async #receive(tabId, page, message) {
      if (!record2(message) || typeof message.id !== "number") return;
      const pending = page.pending.get(message.id);
      if (!pending) return;
      const tab = await this.#activeTab();
      if (page.pending.get(message.id) !== pending) return;
      const scope2 = this.#options.scope();
      if (this.#pages.get(tabId) !== page || tab?.id !== tabId || pageUrl(tab?.url) !== page.url || !(pending.scope === null && scope2 === null) && !sameAccountScope(pending.scope, scope2)) {
        pending.finish(FAILURE);
        return;
      }
      if (message.kind === "command") {
        const expected = pending.command.type === "TRACE_POPUP_QUICK_ADD" ? "TRACE_QUICK_ADD" : pending.command.type === "TRACE_POPUP_SET_READER_STATUS" ? "TRACE_SET_READER_STATUS" : null;
        if (pending.executed || !expected || !record2(message.command) || message.command.type !== expected || !pending.scope) {
          pending.finish(FAILURE);
          return;
        }
        pending.executed = true;
        const response2 = await this.#options.execute(message.command, page.sender, pending.scope);
        if (!page.pending.has(message.id)) return;
        if (!sameAccountScope(pending.scope, this.#options.scope())) {
          pending.finish(FAILURE);
          return;
        }
        page.port.postMessage({ kind: "commandResult", id: message.id, response: this.#publicResult(response2) });
        return;
      }
      if (message.kind !== "response") return;
      const response = message.response;
      if (pending.command.type === "TRACE_STORY_IDENTITY_GET" && record2(response)) {
        pending.finish(response.ok === true && typeof response.title === "string" && ["AO3", "FanFiction.net"].includes(String(response.site)) ? { ok: true, title: response.title.slice(0, 300), author: typeof response.author === "string" ? response.author.slice(0, 200) : null, site: response.site } : { ok: false, unavailable: response.unavailable === true });
      } else if (pending.command === COLLECT_COMMAND) {
        pending.finish(record2(response) ? response : FAILURE);
      } else pending.finish(this.#publicResult(response));
    }
    #publicResult(response) {
      if (!record2(response)) return FAILURE;
      if (response.ok === true) return { ok: true };
      const allowed = ["not_authenticated", "auth_expired", "free_limit_reached", "rate_limited", "unavailable", "save_pending", "website_access_incomplete"];
      return { ok: false, error: allowed.includes(String(response.error)) ? response.error : "page_unavailable" };
    }
    async #activeTab() {
      try {
        return (await extensionCall(this.#options.tabs, "query", [{ active: true, currentWindow: true }], this.#options.runtime, this.#options.mode))[0] ?? null;
      } catch {
        return null;
      }
    }
  };

  // src/extension-runtime/story-save-activity.mts
  var inFlight = 0;
  var lastEndedAt = 0;
  function storySaveStarted() {
    inFlight += 1;
  }
  function storySaveEnded() {
    inFlight = Math.max(0, inFlight - 1);
    lastEndedAt = Date.now();
  }
  function storySaveActivity() {
    return { inFlight, lastEndedAt };
  }

  // src/extension-runtime/controller.mts
  var DEGRADED_STORAGE_SNAPSHOT = Object.freeze({
    state: "degraded",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "storage_unavailable"
  });
  var DISABLED_SNAPSHOT = Object.freeze({
    state: "signed_out",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "none"
  });
  var RETRY_DELAYS_MS = Object.freeze([750, 2500, 8e3]);
  var DEFAULT_RETRY_CLOCK = Object.freeze({
    setTimeout(callback, delayMs) {
      return globalThis.setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      globalThis.clearTimeout(handle);
    }
  });
  function isSupportedArchiveSender(sender) {
    return archiveHostKindFromSender(sender) !== null;
  }
  function connectActionForState(state) {
    if (state === "signed_out") return "connect";
    if (state === "reconnect_required") return "reconnect";
    if (state === "degraded") return "retry";
    return null;
  }
  var MemoryDiagnostics = class {
    #events = [];
    record(event) {
      this.#events.push(Object.freeze({ ...event }));
      if (this.#events.length > 80) this.#events.shift();
    }
  };
  var SessionRuntimeController = class {
    #trackingAPIOrigin;
    #trackingTail = Promise.resolve();
    #mode;
    #sessionStorage;
    #credentials;
    #database;
    #legacy;
    #alarms;
    #pendingFirstStory;
    #service;
    #accountData;
    #capacityEvents;
    #storyCommands;
    #storyAdmission = null;
    #libraryMutations;
    #finishQualification;
    #metadataContributions;
    #ffnSummaries;
    /** State kept for one account, cleared when that account signs out or another replaces it. */
    #accountCleanups = [];
    #savedFilters;
    #savedFilterApi;
    #savedFilterRepository;
    #nativeImportEnabled;
    #nativeImport;
    /** Only a build with the whole-History import has one (index.mts). */
    #nativeHistory;
    #webHistory;
    #firstStoryInitiator;
    #openTabs;
    #traceWebNavigation;
    #traceWebStatus;
    #archiveReadinessStatus;
    #projection;
    #storage;
    #runtime;
    #tabs;
    #popupRelay;
    #storageMode;
    #webOrigin;
    #retryClock;
    #initialization = null;
    #storageFailure = false;
    #automaticVerificationRetry = false;
    #archiveConnectFlight = null;
    #openingConnectTab = null;
    #retryAttempt = 0;
    #retryGeneration = 0;
    #retryTimer = null;
    #platform = null;
    #nativeAuthorityPreparation = null;
    #accountTransitionTail = Promise.resolve();
    #savedFilterSyncInFlight = null;
    #savedFilterSyncQueued = false;
    #savedFilterSyncQueuedWithCurrentAuthority = false;
    #savedFilterAdoptedScope = null;
    #lastPublishedStatusKey = null;
    #statusPublicationTail = Promise.resolve();
    constructor(environment) {
      this.#trackingAPIOrigin = environment.apiBase;
      this.#mode = environment.mode;
      this.#nativeImportEnabled = environment.nativeImportHandoff === true;
      this.#nativeImport = new NativeLibraryImportProducer({
        runtime: environment.runtime,
        mode: environment.storageMode,
        apiOrigin: environment.apiBase,
        randomID: environment.randomId
      });
      this.#nativeHistory = environment.nativeHistoryHandoff ?? null;
      this.#webHistory = environment.webHistoryHandoff ?? null;
      const storage = new BrowserStorage(
        environment.storageArea,
        environment.runtime,
        environment.storageMode
      );
      this.#storage = storage;
      this.#archiveReadinessStatus = environment.archiveReadinessStatus ?? new BrowserArchiveReadinessStatus(storage);
      this.#runtime = environment.runtime;
      this.#tabs = environment.tabs;
      this.#popupRelay = new PopupPageRelay({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        scope: () => this.#service.publicationScope(),
        execute: (message, sender, scope2) => this.#executeRelayedCommand(message, sender, scope2)
      });
      this.#storageMode = environment.storageMode;
      this.#webOrigin = new URL(environment.webOrigin).origin;
      this.#database = environment.privateDatabase ?? new BrowserPrivateRecordDatabase(
        environment.databaseFactory
      );
      this.#sessionStorage = new BrowserSessionStoragePort(this.#database);
      this.#legacy = new LegacyAccountState(storage);
      this.#alarms = new KernelAlarmState(
        environment.alarms,
        environment.runtime,
        environment.storageMode
      );
      this.#pendingFirstStory = new NativePendingFirstStoryReader(
        environment.runtime,
        environment.storageMode
      );
      this.#retryClock = environment.retryClock ?? DEFAULT_RETRY_CLOCK;
      const pageProvider = new ExplicitCredentialProvider({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin,
        randomId: environment.randomId
      });
      const provider = environment.browserDeviceSessions ? new BrowserDeviceSessionProvider({
        provider: pageProvider,
        isNative: () => pageProvider.isNative(),
        database: this.#database,
        fetch: environment.fetch,
        apiBase: environment.apiBase,
        ...environment.runtime.getManifest?.().version ? { clientVersion: environment.runtime.getManifest().version } : {}
      }) : pageProvider;
      this.#credentials = new BrowserCredentialPort(this.#database, provider, environment.randomId);
      this.#service = new SessionService({
        storage: this.#sessionStorage,
        credentials: this.#credentials,
        api: new VerificationApi(environment.fetch, environment.apiBase, (disposition) => {
          this.#automaticVerificationRetry = disposition === "automatic";
        }),
        diagnostics: new MemoryDiagnostics()
      });
      this.#capacityEvents = new ExtensionCapacityEventApi(
        environment.fetch,
        environment.apiBase
      );
      this.#savedFilterApi = new SavedFilterSyncApi(
        environment.fetch,
        environment.apiBase
      );
      this.#savedFilterRepository = new BrowserSavedFilterRepository({
        storage,
        session: this.#service,
        randomId: environment.randomId
      });
      this.whenAccountLeaves(() => this.#savedFilterRepository.clearAccountData());
      const webHistory = this.#webHistory;
      if (webHistory !== null) this.whenAccountLeaves(() => webHistory.discard());
      this.#savedFilters = new SavedFilterSyncService({
        session: this.#service,
        api: this.#savedFilterApi,
        repository: this.#savedFilterRepository,
        clock: { now: () => (/* @__PURE__ */ new Date()).toISOString() }
      });
      this.#accountData = new AccountDataRepository(this.#database, this.#service);
      this.#projection = new AccountProjectionService({
        session: this.#service,
        api: new AccountProjectionApi(environment.fetch, environment.apiBase),
        repository: this.#accountData,
        clock: { now: () => Date.now() }
      });
      this.#metadataContributions = new MetadataContributionService({
        session: this.#service,
        api: new MetadataContributionApi(environment.fetch, environment.apiBase),
        preference: new BrowserMetadataPreferencePort(storage),
        authority: {
          prepare: async () => {
            const preparation = await this.#prepareNativeAuthority();
            if (!preparation.ready) throw new Error("native authority unavailable");
          }
        },
        projection: {
          invalidate: () => this.#projection.invalidate()
        },
        notification: new TraceWebMetadataNotificationPort({
          runtime: environment.runtime,
          tabs: environment.tabs,
          mode: environment.storageMode,
          webOrigin: environment.webOrigin
        })
      });
      const libraryCommandPorts = {
        session: this.#service,
        api: new LibraryCommandApi(environment.fetch, environment.apiBase),
        projection: new AccountLibraryCommandProjection(
          this.#projection,
          this.#accountData
        ),
        finishOperationIds: {
          create: environment.randomId
        }
      };
      this.#libraryMutations = new LibraryMutationService(libraryCommandPorts);
      this.#finishQualification = new FinishQualificationService(libraryCommandPorts);
      this.#openTabs = async () => {
        const payload = await collectOpenStoryTabs({
          runtime: environment.runtime,
          tabs: environment.tabs,
          ...environment.scripting ? { scripting: environment.scripting } : {},
          ...environment.permissions ? { permissions: environment.permissions } : {},
          mode: environment.storageMode
        });
        const encoded = payload ? encodeOpenStoryTabs(payload) : null;
        return payload && encoded ? { encoded, found: { stories: payload.items.length, tabs: payload.scan.considered } } : null;
      };
      this.#firstStoryInitiator = new BrowserFirstStoryInitiator({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin,
        ...environment.firstStoryDelay === void 0 ? {} : { delay: environment.firstStoryDelay },
        ...environment.mode === "kernel" ? { collectFromPage: (tabId) => this.#popupRelay.collect(tabId) } : {}
      });
      this.#traceWebNavigation = new BrowserTraceWebNavigation({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode
      });
      this.#traceWebStatus = new TraceWebStatusNotification({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin
      });
      this.#ffnSummaries = environment.ffnSummaryFill === void 0 || environment.mode !== "kernel" ? null : this.#createFfnSummaryFill(environment, environment.ffnSummaryFill, storage);
      this.#storyCommands = new StoryCommandService({
        session: this.#service,
        api: new StoryCommandApi(environment.fetch, environment.apiBase),
        projection: new AccountStoryProjectionPort(this.#accountData),
        receipt: new NativeStorySaveReceiptPort(
          environment.runtime,
          environment.storageMode,
          environment.apiBase,
          () => this.publishTrackingPreference()
        ),
        handoff: new NativePendingStoryHandoffPort(
          environment.runtime,
          environment.storageMode
        ),
        clock: { now: () => Date.now() }
      });
    }
    /**
     * What both summary fills share: where their state and tried ids are kept,
     * how a page is read in the reader's tab, who is signed in, the
     * contribution preference, the server's list of gaps for one site, and
     * sending summaries for that site, identity and summary only.
     */
    #summaryFillShared(environment, sessionArea, storage, source) {
      const preference = new BrowserMetadataPreferencePort(storage);
      const apiBase = environment.apiBase.replace(/\/$/, "");
      const call = (target, method, args) => extensionCall(
        target,
        method,
        args,
        environment.runtime,
        environment.storageMode
      );
      const { tabs, scripting, permissions } = environment;
      const localArea = {
        get: (key) => storage.get(key),
        set: (items) => storage.set(items),
        remove: (key) => storage.remove(key)
      };
      return {
        // Session-only where the browser has it; otherwise local storage that
        // expires, and is removed on sign-out like the rest.
        stateArea: sessionArea !== null ? {
          get: (key) => call(sessionArea, "get", [key]),
          set: (items) => call(sessionArea, "set", [items]),
          remove: (key) => call(sessionArea, "remove", [key])
        } : localArea,
        stateTtl: sessionArea !== null ? null : LOCAL_STATE_TTL_MS,
        // Ids only, capped, removed on sign-out.
        attemptedArea: localArea,
        tabReader: {
          hasScripting: typeof scripting?.executeScript === "function" && typeof tabs.get === "function",
          // Only the tab a story-site page spoke from, or the sheet's own.
          getTab: (sourceTabId) => call(tabs, "get", [sourceTabId]),
          executeScript: (details) => call(scripting, "executeScript", [details]),
          containsOrigin: async (origin) => typeof permissions?.contains === "function" && await call(permissions, "contains", [{ origins: [origin] }]) === true
        },
        account: () => {
          const scope2 = this.#service.publicationScope();
          return scope2 === null ? null : `${scope2.accountId}:${scope2.epoch}`;
        },
        contributionsEnabled: () => preference.enabled(),
        listGaps: async () => {
          const result = await this.#service.executeAuthenticated(async (credential) => {
            let response;
            try {
              response = await environment.fetch(`${apiBase}/api/extension/library/summary-gaps`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${credential}`
                },
                body: JSON.stringify({ source })
              });
            } catch {
              return { kind: "success", value: null };
            }
            if (response.status === 401 || response.status === 403) {
              return { kind: "auth_rejected" };
            }
            if (response.status !== 200) return { kind: "success", value: null };
            const body = await response.json().catch(() => null);
            const ids = isRecord18(body) && body.success === true && isRecord18(body.data) ? body.data.sourceStoryIds : null;
            return {
              kind: "success",
              value: Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : null
            };
          });
          return result.kind === "published" ? result.value : null;
        },
        contribute: async (summaries) => {
          const result = await this.#metadataContributions.execute(Object.freeze({
            kind: "library_metadata_refresh",
            hostKind: source,
            workKeys: Object.freeze(summaries.map(({ storyId }) => `${source}:${storyId}`)),
            // Identity and the summary only. The address is the form every
            // save from that site already records.
            payload: Object.freeze({
              items: Object.freeze(summaries.map(({ storyId, summary }) => Object.freeze({
                source,
                sourceStoryId: storyId,
                url: source === "ffn" ? `https://www.fanfiction.net/s/${storyId}/` : `https://archiveofourown.org/works/${storyId}`,
                summary
              })))
            })
          }));
          return result.kind === "accepted" ? "accepted" : result.kind === "skipped" ? "skipped" : "failed";
        }
      };
    }
    #createFfnSummaryFill(environment, options, storage) {
      const shared = this.#summaryFillShared(environment, options.sessionArea ?? null, storage, "ffn");
      return new FfnSummaryFill({
        clock: { now: () => Date.now() },
        state: new StoredFillState(shared.stateArea, shared.stateTtl === null ? {} : { ttlMs: shared.stateTtl }),
        tabs: createFfnTabReader(shared.tabReader),
        attempted: new StoredAttempted(shared.attemptedArea),
        account: shared.account,
        contributionsEnabled: shared.contributionsEnabled,
        listGaps: shared.listGaps,
        contribute: shared.contribute
      });
    }
    start() {
      this.#initialization ??= this.#startOnce();
      return this.#initialization;
    }
    // Best effort local evidence; never blocks run receipts or changes preferences.
    publishTrackingPreference() {
      const operation = this.#trackingTail.then(async () => {
        if (this.#mode !== "kernel" || !await this.#usesNativeAccountAuthority()) return;
        await this.start();
        const context = await sendNativeMessageWithFallback(
          this.#runtime,
          this.#storageMode,
          { type: "TRACE_IOS_TRACKING_PREFERENCE_PREPARE", apiOrigin: this.#trackingAPIOrigin }
        );
        if (!isRecord18(context) || context.ok !== true || !isRecord18(context.provider)) return;
        const preparation = await this.#prepareNativeAuthority();
        const scope2 = this.#service.publicationScope();
        if (!preparation.ready || !scope2) return;
        let values = await this.#storage.get(["prefAutoTrackEnabled", "prefAutoTrackSetAt", "prefAutoTrackFirstObservedAt"]);
        let setAt = values.prefAutoTrackSetAt ?? values.prefAutoTrackFirstObservedAt;
        if (typeof setAt !== "number" || !Number.isFinite(setAt) || setAt <= 0) {
          setAt = Date.now();
          await this.#storage.set({ prefAutoTrackFirstObservedAt: setAt });
          values = await this.#storage.get(["prefAutoTrackEnabled", "prefAutoTrackSetAt"]);
          setAt = values.prefAutoTrackSetAt ?? setAt;
        }
        if (!sameAccountScope(scope2, this.#service.publicationScope())) return;
        await sendNativeMessageWithFallback(this.#runtime, this.#storageMode, {
          type: "TRACE_IOS_TRACKING_PREFERENCE",
          version: 1,
          apiOrigin: this.#trackingAPIOrigin,
          accountID: scope2.accountId,
          provider: context.provider,
          enabled: values.prefAutoTrackEnabled !== false,
          setAt,
          observedAt: Date.now()
        });
      }).catch(() => {
      });
      this.#trackingTail = operation;
      return operation;
    }
    snapshot() {
      if (this.#storageFailure) return DEGRADED_STORAGE_SNAPSHOT;
      if (this.#mode === "disabled") return DISABLED_SNAPSHOT;
      return this.#service.snapshot();
    }
    async handle(message, sender) {
      const response = await this.#dispatch(message, sender);
      if (typeof sender?.tab?.id === "number") {
        const hostKind2 = archiveHostKindFromSender(sender);
        if (hostKind2 === "ffn" && this.#ffnSummaries !== null) {
          void this.#ffnSummaries.ffnPageActivity(sender.tab.id);
        }
      }
      if (this.#mode !== "kernel" || !isRecord18(response) || !isRecord18(response.snapshot) || !isSupportedArchiveSender(sender)) {
        return response;
      }
      return Object.freeze({ ...response, binding: this.#pageBinding() });
    }
    /** The account session a page reply came from; see `pageAccountBinding`. */
    #pageBinding() {
      if (this.#storageFailure || this.#mode !== "kernel") return null;
      return pageAccountBinding(this.#service.displayScope());
    }
    async #dispatch(message, sender) {
      if (!isRecord18(message) || typeof message.type !== "string") return null;
      if (message.type === POPUP_PAGE_RELAY) {
        if (this.#mode !== "kernel" || !this.#popupRelay.accepts(message, sender)) return null;
        await this.start();
        await this.#prepareNativeAuthority();
        return await this.#popupRelay.request(message.tabId, message.command);
      }
      if (!Object.values(SESSION_MESSAGE_TYPES).includes(message.type)) return null;
      switch (message.type) {
        case SESSION_MESSAGE_TYPES.snapshot:
        case SESSION_MESSAGE_TYPES.action:
          return this.#handleSessionMessage(message, sender);
        case SESSION_MESSAGE_TYPES.status:
          return this.#handleStatusMessage(message, sender);
        case SESSION_MESSAGE_TYPES.archiveConnect:
          return this.#handleArchiveConnectMessage(message, sender);
        case SESSION_MESSAGE_TYPES.traceWebReady:
          return this.#handleTraceWebReadyMessage(message, sender);
        case SESSION_MESSAGE_TYPES.openTraceUrl:
          return this.#handleTraceNavigationMessage(message, sender);
        case SESSION_MESSAGE_TYPES.pendingFirstStory:
        case SESSION_MESSAGE_TYPES.projection:
        case SESSION_MESSAGE_TYPES.workState:
        case SESSION_MESSAGE_TYPES.popupState:
          return this.#handleReadMessage(message, sender);
        case SESSION_MESSAGE_TYPES.capacityRecovery:
          return this.#handleCapacityRecoveryMessage(message, sender);
        case SESSION_MESSAGE_TYPES.savedFilterSync:
          return this.#handleSavedFilterMessage(message, sender);
        case SESSION_MESSAGE_TYPES.importTrigger:
        case SESSION_MESSAGE_TYPES.importOpenTabs:
        case SESSION_MESSAGE_TYPES.firstStoryAdd:
          return this.#handleFirstStoryMessage(message, sender);
        case SESSION_MESSAGE_TYPES.metadataBroadcast:
        case SESSION_MESSAGE_TYPES.libraryMetadataRefresh:
          return this.#handleMetadataMessage(message, sender);
        case SESSION_MESSAGE_TYPES.setHiddenWork:
        case SESSION_MESSAGE_TYPES.setReaderStatus:
        case SESSION_MESSAGE_TYPES.patchLibraryEntry:
        case SESSION_MESSAGE_TYPES.finishQualification:
          return this.#handleLibraryMessage(message, sender);
        case SESSION_MESSAGE_TYPES.connectAndSave:
        case SESSION_MESSAGE_TYPES.quickAdd:
        case SESSION_MESSAGE_TYPES.autoTrack:
          return this.#handleStoryMessage(message, sender);
        default:
          return null;
      }
    }
    async #handleSessionMessage(message, sender) {
      if (!isPopupSender(sender, this.#runtime.id) && !isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)) {
        return null;
      }
      if (message.type === SESSION_MESSAGE_TYPES.snapshot && Object.keys(message).length !== 1 || message.type === SESSION_MESSAGE_TYPES.action && Object.keys(message).length !== 2) {
        return null;
      }
      await this.start();
      if (message.type === SESSION_MESSAGE_TYPES.snapshot) {
        const state = this.snapshot().state;
        if (isPopupSender(sender, this.#runtime.id) && (state === "signed_out" || state === "reconnect_required") && await this.#usesNativeAccountAuthority()) {
          const preparation = await this.#prepareNativeAuthority();
          return this.#response(preparation.action);
        }
        if (isPopupSender(sender, this.#runtime.id) && state === "degraded" && await this.#usesNativeAccountAuthority()) {
          return this.#response(await this.#connectForCurrentState() ?? void 0);
        }
        return this.#response();
      }
      if (!isSessionAction(message.action)) return this.#response({ kind: "ignored" });
      if (message.action === "disconnect" || message.action === "cancel") {
        await clearConnectIntent(this.#storage);
      }
      return this.#response(await this.#runManualAction(message.action, true));
    }
    // An AO3/FFN page's Connect runs the popup's Connect. When no signed-in
    // Trace page answered, it opens Trace and remembers the request, so signing
    // in there finishes the connection without another click.
    async #handleArchiveConnectMessage(message, sender) {
      const host = archiveHostKindFromSender(sender);
      if (Object.keys(message).length !== 1 || host === null || isBlockedArchivePath(sender?.tab?.url ?? sender?.url, host)) {
        return null;
      }
      if (this.#archiveConnectFlight) return this.#archiveConnectFlight;
      const flight = this.#connectFromArchive(sender);
      this.#archiveConnectFlight = flight;
      try {
        return await flight;
      } finally {
        if (this.#archiveConnectFlight === flight) this.#archiveConnectFlight = null;
      }
    }
    async #connectFromArchive(sender) {
      await this.start();
      if (this.#mode === "disabled") return this.#response(void 0, "commands_unavailable");
      const action = await this.#connectForCurrentState();
      const state = this.snapshot().state;
      if (state === "connected" || state === "degraded" || action === null || action.kind === "stale" || action.kind === "ignored" || action.kind === "storage_error" || await this.#usesNativeAccountAuthority()) {
        return this.#response(action ?? void 0);
      }
      await rememberConnectIntent(this.#storage);
      let traceOpened = false;
      const opening = (async () => {
        const tab = await this.#traceWebNavigation.openTab(`${this.#webOrigin}/`);
        traceOpened = tab !== null;
        if (typeof sender?.tab?.id === "number" && typeof tab?.id === "number" && await hasConnectIntent(this.#storage)) {
          await rememberConnectReturn(this.#storage, sender.tab.id, tab.id);
        }
      })();
      this.#openingConnectTab = opening;
      try {
        await opening;
      } finally {
        if (this.#openingConnectTab === opening) this.#openingConnectTab = null;
      }
      return Object.freeze({ ...this.#response(action), traceOpened });
    }
    // A Trace page is signed in while a connect request is waiting.
    async #handleTraceWebReadyMessage(message, sender) {
      if (Object.keys(message).length !== 1 || !isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)) {
        return null;
      }
      await this.start();
      await this.#openingConnectTab;
      if (this.#mode !== "kernel" || !await hasConnectIntent(this.#storage)) {
        return this.#response();
      }
      if (this.snapshot().state === "connected") {
        await clearConnectIntent(this.#storage);
        return this.#response();
      }
      const returnTarget = await readConnectReturn(this.#storage);
      const action = await this.#connectForCurrentState();
      if (this.snapshot().state === "connected" && returnTarget !== null && returnTarget.connectTabId === sender?.tab?.id) {
        await this.#traceWebNavigation.returnToArchive(returnTarget.sourceTabId, returnTarget.connectTabId);
      }
      return this.#response(action ?? void 0);
    }
    async #handleStatusMessage(message, sender) {
      await this.start();
      if (Object.keys(message).length !== 2 || typeof message.nonce !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.nonce) || !isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)) {
        return null;
      }
      return this.#extensionStatus();
    }
    async #handleTraceNavigationMessage(message, sender) {
      const request = traceWebNavigationRequestFromMessage(
        message,
        sender,
        this.#webOrigin
      );
      if (request === null) return null;
      await this.start();
      if (this.#mode === "disabled") {
        return Object.freeze({ ok: false, error: "commands_unavailable" });
      }
      if (request.kind === "invalid") {
        return Object.freeze({ ok: false, error: "invalid_trace_url" });
      }
      return await this.#traceWebNavigation.open(request.url) ? Object.freeze({ ok: true }) : Object.freeze({ ok: false, error: "open_failed" });
    }
    async #handleReadMessage(message, sender) {
      await this.start();
      if (message.type === SESSION_MESSAGE_TYPES.pendingFirstStory) {
        return isSupportedArchiveSender(sender) ? this.#pendingFirstStory.read() : { ok: false, error: "native_unavailable" };
      }
      if (message.type === SESSION_MESSAGE_TYPES.projection) {
        const workKeys = boundedProjectionWorkKeys(message.workKeys, sender);
        if (workKeys === null) return null;
        await this.#bootstrapNativeAuthorityForArchiveRead();
        const accountData = await this.#projection.read();
        return Object.freeze({
          ok: true,
          snapshot: this.#publicSnapshot(),
          projection: publicProjection(accountData, workKeys)
        });
      }
      if (message.type === SESSION_MESSAGE_TYPES.workState) {
        const host = archiveHostKindFromSender(sender);
        const workKey = typeof message.workKey === "string" ? message.workKey : "";
        const senderUrl = sender?.tab?.url ?? sender?.url;
        if (host === null || isBlockedArchivePath(senderUrl, host) || !WORK_KEY_PATTERN5.test(workKey) || workKey !== workKeyFromArchiveUrl(senderUrl, host)) {
          return null;
        }
        await this.#bootstrapNativeAuthorityForArchiveRead();
        const accountData = await this.#projection.read();
        return Object.freeze({
          ok: true,
          snapshot: this.#publicSnapshot(),
          state: publicWorkState(accountData, workKey)
        });
      }
      if (!isPopupSender(sender, this.#runtime.id)) return null;
      return this.#popupState();
    }
    async #handleSavedFilterMessage(message, sender) {
      if (!isSavedFilterSyncRequest(message, sender)) return null;
      await this.start();
      return this.#savedFilterResponse(await this.#runSavedFilterSync());
    }
    async #handleCapacityRecoveryMessage(message, sender) {
      const host = archiveHostKindFromSender(sender);
      const senderUrl = sender?.tab?.url ?? sender?.url;
      if (host === null || isBlockedArchivePath(senderUrl, host) || Object.keys(message).length !== 3 || message.action !== "shown" && message.action !== "dismissed" || message.surface !== "story" && message.surface !== "listing") {
        return null;
      }
      await this.start();
      const preparation = await this.#prepareNativeAuthority();
      const scope2 = this.#service.publicationScope();
      if (!preparation.ready || scope2 === null) {
        return this.#response(
          preparation.action,
          preparation.action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
        );
      }
      const result = await this.#accountData.acknowledgeCapacityRecovery(
        scope2,
        message.action,
        Date.now()
      );
      const accountData = result.kind === "published" ? result.value : await this.#accountData.read().catch(() => null);
      if (result.kind === "published") {
        await this.#service.executeAuthenticated(
          (credential) => this.#capacityEvents.record(credential, {
            event: message.action === "shown" ? "prompt_viewed" : "prompt_dismissed",
            surface: message.surface
          })
        );
      }
      return Object.freeze({
        ok: result.kind === "published",
        snapshot: this.#publicSnapshot(),
        ...preparation.action === void 0 ? {} : { action: preparation.action },
        capacity: publicCapacityRecovery(accountData),
        ...result.kind === "published" ? {} : { error: "unavailable" }
      });
    }
    async #handleFirstStoryMessage(message, sender) {
      const initiation = firstStoryInitiationFromMessage(
        message,
        sender,
        this.#runtime.id,
        this.#webOrigin
      );
      if (initiation === null) return null;
      await this.start();
      if (initiation.kind === "invalid") {
        return this.#firstStoryResponse({
          ok: false,
          error: initiation.error
        }, void 0, initiation);
      }
      const importPlatform = (initiation.kind === "popup_import" || initiation.kind === "popup_open_tabs") && this.#nativeImportEnabled ? await this.#nativePlatform() : null;
      if (importPlatform === "unknown" || initiation.kind === "popup_open_tabs" && importPlatform !== "ios") {
        return this.#firstStoryResponse({ ok: false, error: "native_import_unavailable" }, void 0, initiation);
      }
      const nativeImport = importPlatform === "ios";
      const preparation = initiation.kind === "web_save" || nativeImport ? await this.#prepareNativeAuthority() : { ready: true };
      const action = preparation.action;
      if (!preparation.ready || this.snapshot().state !== "connected") {
        return this.#firstStoryResponse(
          { ok: false, error: "not_authenticated" },
          action,
          initiation
        );
      }
      if (nativeImport) {
        let preparedHandoff = null;
        let found;
        const fenced = await this.#service.executeCurrentScope(async (scope2, isCurrent) => {
          const result2 = await this.#nativeImport.run(scope2, async () => {
            const current = await this.#prepareNativeAuthority();
            return current.ready && await isCurrent();
          }, async (stage) => {
            if (initiation.kind !== "popup_open_tabs") return this.#firstStoryInitiator.importActivePage(stage);
            const scan = await this.#openTabs();
            if (!scan) return { ok: false, error: "no_readable_tabs" };
            found = scan.found;
            return stage(scan.encoded);
          });
          if (result2.ok && result2.state === "ready_to_open") preparedHandoff = result2.handoffID;
          return result2;
        });
        if (fenced.kind !== "published" && preparedHandoff !== null) {
          await this.#nativeImport.discardUnpublished(preparedHandoff);
        }
        const response = await this.#firstStoryResponse(fenced.kind === "published" ? fenced.value : { ok: false, error: "native_import_unavailable" }, action, initiation);
        return found && response.ok && response.state === "ready_to_open" ? Object.freeze({ ...response, found: Object.freeze({ ...found }) }) : response;
      }
      const result = initiation.kind !== "web_save" ? await this.#firstStoryInitiator.importActivePage() : await this.#firstStoryInitiator.saveFromTrace(initiation.url);
      return this.#firstStoryResponse(result, action, initiation);
    }
    async #handleMetadataMessage(message, sender) {
      const command = metadataContributionCommandFromMessage(message, sender);
      if (command === null) return null;
      await this.start();
      return this.#metadataContributionResponse(
        await this.#metadataContributions.execute(command),
        command
      );
    }
    async #executeRelayedCommand(message, sender, scope2) {
      await this.#prepareNativeAuthority();
      return this.#withAccountTransitionLock(async () => {
        if (!isRecord18(message) || !sameAccountScope(scope2, this.#service.publicationScope())) return null;
        if (message.type === SESSION_MESSAGE_TYPES.setReaderStatus) {
          const command = libraryMutationCommandFromMessage(message, sender);
          return command === null ? null : this.#libraryCommandResponse(await this.#libraryMutations.execute(command));
        }
        if (message.type === SESSION_MESSAGE_TYPES.quickAdd) {
          const command = storyTrackCommandFromMessage(message, sender);
          return command === null ? null : this.#commandResponse(await this.#executeStoryCommand(command), void 0, command);
        }
        return null;
      });
    }
    async #handleLibraryMessage(message, sender) {
      const finishCommand = message.type === SESSION_MESSAGE_TYPES.finishQualification ? finishQualificationCommandFromMessage(message, sender) : null;
      const libraryCommand = message.type === SESSION_MESSAGE_TYPES.finishQualification ? null : libraryMutationCommandFromMessage(message, sender);
      if (finishCommand === null && libraryCommand === null) return null;
      await this.start();
      const preparation = await this.#prepareNativeAuthority();
      const action = preparation.action;
      if (!preparation.ready || this.snapshot().state !== "connected") {
        const reason = action?.kind === "unavailable" ? "unavailable" : "not_authenticated";
        return finishCommand === null ? this.#libraryCommandResponse(
          { kind: "failed", reason },
          action
        ) : this.#finishQualificationResponse(
          { kind: "failed", reason },
          action
        );
      }
      if (finishCommand !== null && this.#pageBindingIsStale(message.binding)) {
        return this.#finishQualificationResponse(
          { kind: "failed", reason: "stale" },
          action
        );
      }
      return finishCommand === null ? this.#libraryCommandResponse(
        await this.#libraryMutations.execute(libraryCommand),
        action
      ) : this.#finishQualificationResponse(
        await this.#finishQualification.execute(finishCommand),
        action
      );
    }
    /**
     * A page that names the account session it observed is refused once that
     * session is no longer the current one. A page that names none (an older
     * content script still running in an open tab) is not fenced here.
     */
    #pageBindingIsStale(claimed) {
      if (claimed === void 0) return false;
      return typeof claimed !== "string" || !PAGE_BINDING_PATTERN.test(claimed) || claimed !== this.#pageBinding();
    }
    async #handleStoryMessage(message, sender) {
      const admitted = storyTrackCommandFromMessage(message, sender);
      if (admitted === null) return null;
      await this.start();
      const tabId = sender?.tab?.id;
      const mode = this.#storyAdmission === null || typeof tabId !== "number" ? null : await this.#storyAdmission.modeFor(tabId, admitted.workKey).catch(() => null);
      if (typeof tabId === "number") this.#storyAdmission?.pageSaveAdmitted(tabId, admitted.workKey);
      const command = mode === null ? admitted : Object.freeze({ ...admitted, mode });
      if (message.type === SESSION_MESSAGE_TYPES.connectAndSave) {
        const preparation2 = await this.#prepareNativeAuthority();
        const action2 = preparation2.action ?? await this.#runManualAction(
          this.snapshot().state === "connected" ? "reconnect" : "connect"
        );
        if (!preparation2.ready && preparation2.action !== void 0) {
          return this.#commandResponse(
            {
              kind: "failed",
              reason: action2.kind === "unavailable" ? "unavailable" : "not_authenticated"
            },
            action2,
            command
          );
        }
        if (this.snapshot().state !== "connected") {
          return this.#commandResponse(
            { kind: "failed", reason: "not_authenticated" },
            action2,
            command
          );
        }
        return this.#commandResponse(
          await this.#executeStoryCommand(command),
          action2,
          command
        );
      }
      if (message.type === SESSION_MESSAGE_TYPES.quickAdd) {
        const preparation2 = await this.#prepareNativeAuthority();
        if (!preparation2.ready) {
          return this.#commandResponse(
            {
              kind: "failed",
              reason: preparation2.action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
            },
            preparation2.action,
            command
          );
        }
        return this.#commandResponse(
          await this.#executeStoryCommand(command),
          preparation2.action,
          command
        );
      }
      const preferences = await this.#storage.get("prefAutoTrackEnabled").catch(() => ({}));
      if (preferences.prefAutoTrackEnabled === false) {
        return this.#response(void 0, "auto_track_disabled");
      }
      const preparation = await this.#prepareNativeAuthority();
      const action = preparation.action;
      if (!preparation.ready || this.snapshot().state !== "connected") {
        return this.#commandResponse(
          {
            kind: "failed",
            reason: action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
          },
          action,
          command
        );
      }
      return this.#commandResponse(
        await this.#executeStoryCommand(command),
        action,
        command
      );
    }
    async #executeStoryCommand(command) {
      return (await this.#executeStoryCommandWithEvidence(command)).result;
    }
    async #executeStoryCommandWithEvidence(command, observer, tabId) {
      storySaveStarted();
      try {
        return await this.#runStoryCommandWithEvidence(command, observer, tabId);
      } finally {
        storySaveEnded();
      }
    }
    async #runStoryCommandWithEvidence(command, observer, tabId) {
      let accountData = await this.#accountData.read().catch(() => null);
      if (accountData?.capacityRecovery !== null && accountData?.capacityRecovery !== void 0 && accountData.overlay === null) {
        accountData = await this.#projection.read().catch(() => accountData);
      }
      if (accountData?.capacityRecovery !== null && accountData?.capacityRecovery !== void 0 && accountData.overlay !== null && accountData.overlay.entries[command.workKey] === void 0) {
        return Object.freeze({
          result: Object.freeze({ kind: "failed", reason: "free_limit_reached" }),
          dispatch: "never_sent"
        });
      }
      const ffn = this.#ffnSummaries;
      if (ffn === null) return this.#storyCommands.executeWithEvidence(command, observer);
      const alreadyInLibrary = accountData?.overlay?.entries[command.workKey] !== void 0;
      ffn.saveStarted();
      let evidence;
      try {
        evidence = await this.#storyCommands.executeWithEvidence(command, observer);
      } finally {
        ffn.saveEnded();
      }
      if (evidence.result.kind === "confirmed" && // Trace already has this story's summary: nothing to read.
      evidence.result.confirmation.summaryKnown !== true) {
        void ffn.storySaved(command, alreadyInLibrary, tabId);
      }
      return evidence;
    }
    // --- What the first-tap save needs from the session -------------------------
    /** Hooks called as a page's own save is admitted. Absent on builds without the first-tap save. */
    attachStoryAdmission(hooks) {
      this.#storyAdmission = hooks;
    }
    pageBinding() {
      return this.#pageBinding();
    }
    /** The account, read for this call and never from a kept snapshot. */
    async accountForThisOpen() {
      await this.start();
      const preparation = await this.#prepareNativeAuthority();
      const binding = this.#pageBinding();
      if (preparation.ready && this.snapshot().state === "connected" && binding !== null) {
        return Object.freeze({ state: "verified", binding });
      }
      const snapshot = this.snapshot();
      if (snapshot.state === "signed_out" && snapshot.reason === "credential_absent") {
        return Object.freeze({ state: "missing" });
      }
      if (snapshot.state === "reconnect_required") {
        return Object.freeze({ state: "reconnect_required" });
      }
      return Object.freeze({ state: "unknown" });
    }
    /**
     * Called when the account signed in signs out, or another account takes its
     * place: whatever was kept for it is to be dropped. Never awaited for long:
     * a cleanup that fails is let go.
     */
    whenAccountLeaves(cleanup) {
      this.#accountCleanups.push(cleanup);
    }
    async #accountLeft() {
      await Promise.all(this.#accountCleanups.map((cleanup) => cleanup().catch(() => void 0)));
    }
    /** The automatic-saving preference: a failed read is unknown, never "on". */
    async automaticSaving() {
      try {
        const stored = await this.#storage.get("prefAutoTrackEnabled");
        return stored.prefAutoTrackEnabled === false ? "off" : "on";
      } catch {
        return "unknown";
      }
    }
    async saveStoryWithEvidence(command, observer, tabId) {
      await this.start();
      return this.#executeStoryCommandWithEvidence(command, observer, tabId);
    }
    /**
     * Hands the reader's whole AO3 History to Trace for review: on iPhone,
     * to the app through the paired History inbox, fenced to the account as
     * the import handoff is; on a computer, to Trace's review page, which asks
     * for it a part at a time (`answerWebHistory`). `build` makes the parts
     * only once the account is known to be connected.
     */
    async handOffHistory(build) {
      await this.start();
      const unavailable = Object.freeze({ ok: false, error: "history_handoff_unavailable" });
      const platform = await this.#nativePlatform();
      const web = this.#webHistory;
      if (platform === "desktop" && web !== null) {
        const site = new URL(this.#webOrigin);
        if (!declaresHostPattern(this.#runtime, `${site.protocol}//${site.hostname}/*`)) return unavailable;
        if (this.snapshot().state !== "connected") return Object.freeze({ ok: false, error: "not_authenticated" });
        const history2 = await build().catch(() => null);
        if (history2 === null) return unavailable;
        const fenced2 = await this.#service.executeCurrentScope(async (scope2, isCurrent) => await isCurrent() ? web.offer(scope2.accountId, history2) : unavailable);
        if (fenced2.kind !== "published") {
          await web.discard();
          return unavailable;
        }
        return fenced2.value;
      }
      const producer = this.#nativeHistory;
      if (producer === null || !this.#nativeImportEnabled || platform !== "ios") return unavailable;
      const preparation = await this.#prepareNativeAuthority();
      if (!preparation.ready || this.snapshot().state !== "connected") {
        return Object.freeze({ ok: false, error: "not_authenticated" });
      }
      const history = await build().catch(() => null);
      if (history === null) return unavailable;
      const fenced = await this.#service.executeCurrentScope((scope2, isCurrent) => producer.run(scope2, async () => {
        const current = await this.#prepareNativeAuthority();
        return current.ready && await isCurrent();
      }, history));
      if (fenced.kind !== "published") {
        if (fenced.kind === "stale") await producer.discardUnpublished();
        return unavailable;
      }
      return fenced.value;
    }
    /** A Trace page's request for the History on offer, answered only for the account signed in now. */
    async answerWebHistory(message) {
      await this.start();
      const web = this.#webHistory;
      if (web === null) return null;
      const scope2 = this.snapshot().state === "connected" ? this.#service.publicationScope() : null;
      return web.answer(message, scope2?.accountId ?? null);
    }
    /** Looks for one story in the Library. It cannot save. */
    async storyPresence(workKey) {
      await this.start();
      return this.#storyCommands.presence(workKey);
    }
    /** The account an answer from Trace belongs to, or null for none. */
    publicationScope() {
      return this.#service.publicationScope();
    }
    /** Runs one request to Trace as the account now signed in. */
    async executeAuthenticated(effect) {
      await this.start();
      return this.#service.executeAuthenticated(effect);
    }
    async #startOnce() {
      try {
        if (this.#mode === "disabled") {
          await this.#legacy.clearAll();
          await this.#alarms.clearAll();
          await this.#database.deleteDatabase();
        } else {
          await this.#legacy.clear();
          await this.#alarms.clearRetired();
          this.#automaticVerificationRetry = false;
          await this.#service.start();
        }
        this.#storageFailure = false;
      } catch {
        this.#storageFailure = true;
      }
      this.#reconcileAutomaticRetry();
    }
    async #retryInitialization() {
      if (!this.#storageFailure) return { kind: "ignored" };
      try {
        if (this.#mode === "disabled") {
          await this.#legacy.clearAll();
          await this.#alarms.clearAll();
          await this.#database.deleteDatabase();
        } else {
          await this.#legacy.clear();
          await this.#alarms.clearRetired();
          await this.#service.start();
        }
        this.#storageFailure = false;
        return this.#mode === "disabled" ? { kind: "completed", state: "signed_out" } : { kind: "ignored" };
      } catch {
        return { kind: "unavailable" };
      }
    }
    async #runAction(action) {
      if (action === "connect" || action === "retry" || action === "reconnect") {
        this.#automaticVerificationRetry = false;
      }
      if (action === "retry" && this.#storageFailure) return this.#retryInitialization();
      if (this.#storageFailure || this.#mode === "disabled") return { kind: "ignored" };
      if (action === "connect") return this.#service.connect();
      if (action === "retry") return this.#service.retry();
      if (action === "cancel") {
        const result = await this.#service.cancelConnect();
        await this.#clearLegacyAfterDisconnect(result);
        return result;
      }
      if (action === "disconnect") {
        const result = await this.#service.disconnect();
        await this.#clearLegacyAfterDisconnect(result);
        return result;
      }
      const disconnected = await this.#service.disconnect();
      await this.#clearLegacyAfterDisconnect(disconnected);
      if (disconnected.kind !== "completed" || disconnected.state !== "signed_out") {
        return disconnected;
      }
      return this.#service.connect();
    }
    async #runManualAction(action, scheduleSavedFilters = false) {
      if (this.#savedFilterSyncInFlight !== null) {
        this.#savedFilters.cancel();
        this.#savedFilterApi.cancelPending();
      }
      const previousState = this.snapshot().state;
      const result = await this.#withAccountTransitionLock(
        () => this.#runManualActionUnlocked(action)
      );
      this.#publishStatus();
      await this.#settleSessionTransition(previousState, action === "reconnect");
      if (scheduleSavedFilters && result.kind === "completed" && result.state === "connected") {
        this.#queueSavedFilterSync(true);
      }
      return result;
    }
    // Runs the connect action that fits the state when the lock is taken, so a
    // request queued behind another connect never disconnects its result.
    async #connectForCurrentState() {
      if (connectActionForState(this.snapshot().state) === null) return null;
      if (this.#savedFilterSyncInFlight !== null) {
        this.#savedFilters.cancel();
        this.#savedFilterApi.cancelPending();
      }
      const previousState = this.snapshot().state;
      const ran = await this.#withAccountTransitionLock(async () => {
        const action = connectActionForState(this.snapshot().state);
        return action === null ? null : { action, result: await this.#runManualActionUnlocked(action) };
      });
      if (ran === null) return null;
      this.#publishStatus();
      await this.#settleSessionTransition(previousState, ran.action === "reconnect");
      if (ran.result.kind === "completed" && ran.result.state === "connected") {
        this.#queueSavedFilterSync(true);
      }
      return ran.result;
    }
    // Archive pages re-read their account view when this content-free revision
    // changes, so they show the new connection state without a reload.
    async #settleSessionTransition(previousState, accountMayHaveChanged) {
      const state = this.snapshot().state;
      if (state === "connected") await clearConnectIntent(this.#storage);
      if (state !== previousState || accountMayHaveChanged) {
        await this.#publishAccountProjectionRevision();
      }
    }
    async #runManualActionUnlocked(action) {
      this.#cancelAutomaticRetry(true);
      const result = await this.#runAction(action);
      this.#reconcileAutomaticRetry();
      return result;
    }
    #automaticRetryIsEligible() {
      const snapshot = this.snapshot();
      return snapshot.state === "degraded" && (snapshot.reason === "storage_unavailable" || snapshot.reason === "verification_unavailable" && this.#automaticVerificationRetry);
    }
    #reconcileAutomaticRetry() {
      if (!this.#automaticRetryIsEligible()) {
        this.#cancelAutomaticRetry(true);
        return;
      }
      if (this.#retryTimer !== null || this.#retryAttempt >= RETRY_DELAYS_MS.length) return;
      const generation = this.#retryGeneration;
      const delayMs = RETRY_DELAYS_MS[this.#retryAttempt];
      this.#retryAttempt += 1;
      this.#retryTimer = this.#retryClock.setTimeout(() => {
        this.#retryTimer = null;
        void this.#runAutomaticRetry(generation);
      }, delayMs);
    }
    async #runAutomaticRetry(generation) {
      if (generation !== this.#retryGeneration || !this.#automaticRetryIsEligible()) return;
      await this.#withAccountTransitionLock(() => this.#runAction("retry"));
      this.#publishStatus();
      if (generation !== this.#retryGeneration) return;
      this.#reconcileAutomaticRetry();
    }
    #cancelAutomaticRetry(resetAttempt) {
      this.#retryGeneration += 1;
      if (this.#retryTimer !== null) {
        this.#retryClock.clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
      }
      if (resetAttempt) this.#retryAttempt = 0;
    }
    async #clearLegacyAfterDisconnect(result) {
      if (result.kind !== "completed" || result.state !== "signed_out") return;
      await this.#accountLeft();
      try {
        await this.#ffnSummaries?.clear();
      } catch {
      }
      try {
        await this.#accountData.clear();
      } catch {
      }
      try {
        await this.#legacy.clear();
      } catch {
      }
    }
    #publicSnapshot() {
      return toPublicSessionSnapshot(this.snapshot(), {
        hasVerifiedAccount: this.#service.hasVerifiedAccount()
      });
    }
    #response(action, error) {
      return Object.freeze({
        ok: true,
        snapshot: this.#publicSnapshot(),
        ...action === void 0 ? {} : { action },
        ...error === void 0 ? {} : { error }
      });
    }
    async #commandResponse(command, action, request) {
      if (request !== void 0) {
        await this.#recordStoryReadiness(request, command);
      }
      let accountData = await this.#accountData.read().catch(() => null);
      const scope2 = this.#service.publicationScope();
      if (command.kind === "failed" && command.reason === "free_limit_reached" && scope2 !== null) {
        const result = await this.#accountData.publishCapacityBlocked(
          scope2,
          Date.now()
        );
        if (result.kind === "published") accountData = result.value;
      } else if (command.kind === "confirmed" && command.intent === "ensure_saved" && command.source !== "preflight" && scope2 !== null) {
        const result = await this.#accountData.clearCapacityRecovery(scope2);
        if (result.kind === "published") accountData = result.value;
      }
      if (command.kind === "confirmed" && command.projection === "published") {
        await this.#publishAccountProjectionRevision();
      }
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind === "confirmed",
        snapshot: this.#publicSnapshot(),
        ...action === void 0 ? {} : { action },
        command,
        capacity: publicCapacityRecovery(accountData),
        ...command.kind === "confirmed" ? {
          entryId: command.confirmation.entryId,
          state: Object.freeze({
            workKey: command.confirmation.workKey,
            status: "saved",
            entryId: command.confirmation.entryId,
            entry: command.confirmation.entry,
            syncVersion: command.confirmation.syncVersion
          })
        } : { error: command.reason }
      });
    }
    async #publishAccountProjectionRevision() {
      try {
        const values = await this.#storage.get(ACCOUNT_PROJECTION_REVISION_KEY);
        const current = values[ACCOUNT_PROJECTION_REVISION_KEY];
        const revision = typeof current === "number" && Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
        await this.#storage.set({ [ACCOUNT_PROJECTION_REVISION_KEY]: revision });
      } catch {
      }
    }
    #libraryCommandResponse(command, action) {
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind === "confirmed",
        snapshot: this.#publicSnapshot(),
        ...action === void 0 ? {} : { action },
        command,
        ...command.kind === "confirmed" ? {
          ...command.entryId === void 0 ? {} : { entryId: command.entryId }
        } : { error: command.reason }
      });
    }
    #finishQualificationResponse(command, action) {
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind === "acknowledged",
        snapshot: this.#publicSnapshot(),
        ...action === void 0 ? {} : { action },
        command,
        ...command.kind === "failed" ? { error: command.reason } : {}
      });
    }
    async #metadataContributionResponse(command, request) {
      await this.#recordMetadataReadiness(request, command);
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind !== "failed",
        snapshot: this.#publicSnapshot(),
        command,
        ...command.kind === "failed" ? { error: command.reason } : {}
      });
    }
    #savedFilterResponse(sync) {
      this.#publishStatus();
      return Object.freeze({
        ok: sync.kind !== "failed",
        snapshot: this.#publicSnapshot(),
        sync,
        ...sync.kind === "failed" ? { error: sync.reason } : {}
      });
    }
    async #firstStoryResponse(result, action, initiation) {
      if (initiation?.kind === "popup_import" && !(result.ok && result.state === "ready_to_open")) {
        await this.#recordImportReadiness(result);
      }
      this.#publishStatus();
      return Object.freeze({
        ok: result.ok,
        snapshot: this.#publicSnapshot(),
        ...action === void 0 ? {} : { action },
        ...result.ok ? { state: result.state } : { error: result.error },
        ...result.ok && result.state === "ready_to_open" ? { handoffID: result.handoffID, expiresAtMs: result.expiresAtMs } : {}
      });
    }
    async #recordStoryReadiness(request, result) {
      try {
        if (result.kind === "confirmed") {
          await this.#archiveReadinessStatus.record({
            hostKind: request.hostKind,
            actionKind: request.intent === "record_progress" ? "track" : "quick_add"
          });
          return;
        }
        const errorKind2 = this.#archiveErrorKind(result.reason);
        if (errorKind2 !== null) {
          await this.#archiveReadinessStatus.record({
            hostKind: request.hostKind,
            errorKind: errorKind2
          });
        }
      } catch {
      }
    }
    async #recordMetadataReadiness(request, result) {
      try {
        if (result.kind === "accepted" && (request.kind === "story_metadata" || result.updated)) {
          await this.#archiveReadinessStatus.record({
            hostKind: request.hostKind,
            actionKind: "metadata"
          });
          return;
        }
        if (result.kind === "failed") {
          const errorKind2 = this.#archiveErrorKind(result.reason);
          if (errorKind2 !== null) {
            await this.#archiveReadinessStatus.record({
              hostKind: request.hostKind,
              errorKind: errorKind2
            });
          }
        }
      } catch {
      }
    }
    async #recordImportReadiness(result) {
      let hostKind2 = "unknown";
      try {
        const tabs = await this.#callTabsQuery({ active: true, currentWindow: true });
        const context = classifyActiveTabUrl(tabs[0]?.url, this.#webOrigin);
        if ("site" in context) hostKind2 = context.site;
        if (result.ok && result.state === "opened") {
          await this.#archiveReadinessStatus.record({ hostKind: hostKind2, actionKind: "import" });
          return;
        }
        if (!result.ok) {
          const errorKind2 = result.error === "permission_required" ? "permission" : result.error === "unsupported_page" || result.error === "no_active_tab" || result.error === "invalid_url" ? "unsupported_page" : result.error === "collect_failed" ? "parser" : "unknown";
          await this.#archiveReadinessStatus.record({ hostKind: hostKind2, errorKind: errorKind2 });
        }
      } catch {
      }
    }
    #archiveErrorKind(reason) {
      if (reason === "not_authenticated" || reason === "auth_expired") return "auth";
      if (reason === "invalid_request" || reason === "invalid_response") return "parser";
      if (reason === "unavailable" || reason === "rate_limited" || reason === "confirmation_missing") {
        return "network";
      }
      return null;
    }
    async #bootstrapNativeAuthorityForArchiveRead() {
      const state = this.snapshot().state;
      if (state !== "signed_out" && state !== "reconnect_required") return;
      if (!await this.#usesNativeAccountAuthority()) return;
      await this.#prepareNativeAuthority();
    }
    #prepareNativeAuthority() {
      if (this.#nativeAuthorityPreparation !== null) {
        return this.#nativeAuthorityPreparation;
      }
      const operation = this.#prepareNativeAuthorityOnce();
      this.#nativeAuthorityPreparation = operation;
      void operation.then(
        () => {
          if (this.#nativeAuthorityPreparation === operation) {
            this.#nativeAuthorityPreparation = null;
          }
        },
        () => {
          if (this.#nativeAuthorityPreparation === operation) {
            this.#nativeAuthorityPreparation = null;
          }
        }
      );
      return operation;
    }
    async #prepareNativeAuthorityOnce() {
      if (!await this.#usesNativeAccountAuthority()) {
        return Object.freeze({ ready: true });
      }
      return this.#withAccountTransitionLock(
        () => this.#prepareNativeAuthorityUnlocked()
      );
    }
    async #prepareNativeAuthorityUnlocked() {
      const before = this.#service.publicationScope();
      const action = await this.#service.synchronizeProviderCredential();
      const after = this.#service.publicationScope();
      const scopeChanged = before?.accountId !== after?.accountId || before?.epoch !== after?.epoch;
      if (scopeChanged) {
        if (before !== null && before.accountId !== after?.accountId) await this.#accountLeft();
        try {
          await this.#accountData.clear();
        } catch {
        }
        this.#projection.invalidate();
        await this.#publishAccountProjectionRevision();
      }
      const ready = action.kind === "completed" && action.state === "connected" && after !== null;
      if (ready) await this.#pullSavedFiltersForAdoptedScope(after, scopeChanged);
      return Object.freeze({ ready, action });
    }
    // Adopting the app's account is the iPhone's sign-in, so it pulls the
    // account's saved filters as a desktop sign-in does: when the account
    // changed, or when this device has never synced them. Once per account in
    // each background life, so a failing pull is not retried on every message.
    async #pullSavedFiltersForAdoptedScope(scope2, scopeChanged) {
      if (this.#mode !== "kernel") return;
      const key = `${scope2.accountId}:${scope2.epoch}`;
      if (this.#savedFilterAdoptedScope === key) return;
      if (!scopeChanged) {
        const lastSyncedAt = await this.#savedFilterRepository.lastSyncedAt().catch(() => null);
        if (lastSyncedAt !== null) {
          this.#savedFilterAdoptedScope = key;
          return;
        }
      }
      this.#savedFilterAdoptedScope = key;
      this.#queueSavedFilterSync(true);
    }
    requestSavedFilterSync() {
      if (this.#mode === "kernel") this.#queueSavedFilterSync();
    }
    #queueSavedFilterSync(nativeAuthorityCurrent = false) {
      if (this.#mode !== "kernel") return;
      this.#savedFilterSyncQueuedWithCurrentAuthority ||= nativeAuthorityCurrent;
      if (this.#savedFilterSyncQueued) return;
      this.#savedFilterSyncQueued = true;
      queueMicrotask(() => {
        const authorityCurrent = this.#savedFilterSyncQueuedWithCurrentAuthority;
        this.#savedFilterSyncQueued = false;
        this.#savedFilterSyncQueuedWithCurrentAuthority = false;
        void this.#runSavedFilterSync(authorityCurrent);
      });
    }
    #runSavedFilterSync(nativeAuthorityCurrent = false) {
      this.#savedFilterSyncInFlight ??= this.#withAccountTransitionLock(async () => {
        if (!nativeAuthorityCurrent && await this.#usesNativeAccountAuthority()) {
          const preparation = await this.#prepareNativeAuthorityUnlocked();
          if (!preparation.ready) {
            return Object.freeze({
              kind: "failed",
              reason: preparation.action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
            });
          }
        }
        if (this.snapshot().state !== "connected") {
          return Object.freeze({
            kind: "failed",
            reason: "not_authenticated"
          });
        }
        return this.#savedFilters.sync();
      }).finally(() => {
        this.#savedFilterSyncInFlight = null;
      });
      return this.#savedFilterSyncInFlight;
    }
    async #withAccountTransitionLock(work) {
      const previous = this.#accountTransitionTail;
      let release = () => {
      };
      this.#accountTransitionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
    #publishStatus() {
      this.#statusPublicationTail = this.#statusPublicationTail.then(async () => {
        const status2 = await this.#extensionStatus();
        const statusKey = JSON.stringify(status2);
        if (statusKey === this.#lastPublishedStatusKey) return;
        this.#lastPublishedStatusKey = statusKey;
        await this.#traceWebStatus.publish(status2);
      }).catch(() => {
      });
    }
    async #extensionStatus() {
      const [accountData, readiness] = await Promise.all([
        this.#accountData.read().catch(() => null),
        this.#archiveReadinessStatus.read().catch(
          () => Object.freeze({})
        )
      ]);
      return toExtensionStatus(this.snapshot(), {
        firstSaveSeen: accountData?.summary?.firstStoryCompleted === true || Object.keys(accountData?.overlay?.entries ?? {}).length > 0,
        browserKind: browserKind(this.#runtime),
        readiness
      });
    }
    async #popupState() {
      const [accountData, preferences, activeBrowserTab] = await Promise.all([
        this.#projection.read(),
        this.#storage.get(POPUP_PREFERENCE_KEYS).catch(() => ({})),
        this.#activeTab()
      ]);
      const activeTabUrl = activeBrowserTab?.url;
      const activeTab = classifyActiveTabUrl(activeTabUrl, this.#webOrigin);
      const nativeImport = this.#nativeImportEnabled && await this.#nativePlatform() !== "desktop";
      const activeWorkKey = this.#storyWorkKey(activeTabUrl);
      const connected = this.snapshot().state === "connected";
      const activeWork = activeWorkKey === null || !connected ? null : publicWorkState(accountData, activeWorkKey);
      let activeStoryUnavailable = false;
      const activeTabId = activeBrowserTab?.id;
      if (connected && activeTab.kind === "supported_story" && activeWork === null && typeof activeTabId === "number" && Number.isInteger(activeTabId)) {
        try {
          let timeoutId;
          const response = await Promise.race([
            this.#popupRelay.request(activeTabId, { type: "TRACE_STORY_IDENTITY_GET" }),
            new Promise((resolve) => {
              timeoutId = globalThis.setTimeout(() => resolve(null), 1e3);
            })
          ]).finally(() => globalThis.clearTimeout(timeoutId));
          activeStoryUnavailable = isRecord18(response) && response.ok === false && response.unavailable === true;
        } catch {
        }
      }
      return Object.freeze({
        ok: true,
        authState: this.#publicSnapshot(),
        firstSaveSeen: accountData?.summary?.firstStoryCompleted === true,
        libraryCount: accountData?.summary?.libraryCount ?? null,
        libraryLimit: accountData?.summary?.libraryLimit ?? null,
        activeTab,
        pro: accountData?.summary?.pro === true,
        capacity: publicCapacityRecovery(accountData),
        autoTrackEnabled: preferences.prefAutoTrackEnabled !== false,
        libraryInlayEnabled: preferences.prefLibraryInlayEnabled !== false,
        ao3SavedFiltersEnabled: preferences.prefAo3SavedFiltersEnabled !== false,
        metadataImproveEnabled: preferences.prefMetadataImproveEnabled !== false,
        activeWork,
        activeStoryUnavailable,
        nativeImport
      });
    }
    async #activeTab() {
      try {
        const tabs = await this.#callTabsQuery({ active: true, currentWindow: true });
        return tabs[0] ?? null;
      } catch {
        return null;
      }
    }
    /** Work key for a supported, non-credential story URL; null otherwise. */
    #storyWorkKey(rawUrl) {
      if (rawUrl === void 0) return null;
      const host = archiveHostKindFromSender({ url: rawUrl });
      if (host === null || isBlockedArchivePath(rawUrl, host)) return null;
      const workKey = workKeyFromArchiveUrl(rawUrl, host);
      return workKey !== null && WORK_KEY_PATTERN5.test(workKey) ? workKey : null;
    }
    #callTabsQuery(query) {
      if (this.#storageMode === "promise") {
        try {
          return Promise.resolve(
            this.#tabs.query(query)
          );
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return new Promise((resolve, reject) => {
        try {
          this.#tabs.query(query, (tabs) => {
            const message = this.#runtime.lastError?.message;
            if (message) reject(new Error(message));
            else resolve(tabs);
          });
        } catch (error) {
          reject(error);
        }
      });
    }
    async #usesNativeAccountAuthority() {
      return await this.#nativePlatform() === "ios";
    }
    #nativePlatform() {
      this.#platform ??= (async () => {
        if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) return "ios";
        if (typeof this.#runtime.getPlatformInfo !== "function") return "unknown";
        try {
          let value;
          if (this.#storageMode === "promise") {
            value = await this.#runtime.getPlatformInfo();
          } else {
            value = await new Promise((resolve, reject) => {
              this.#runtime.getPlatformInfo((info) => {
                const message = this.#runtime.lastError?.message;
                if (message) reject(new Error(message));
                else resolve(info);
              });
            });
          }
          if (isRecord18(value) && value.os === "ios") return "ios";
          if (isRecord18(value) && ["mac", "win", "linux", "openbsd", "cros"].includes(value.os)) return "desktop";
          return "unknown";
        } catch {
          return "unknown";
        }
      })();
      const platform = this.#platform;
      void platform.then((value) => {
        if (value === "unknown" && this.#platform === platform) this.#platform = null;
      });
      return platform;
    }
  };
  function installSessionRuntime(environment) {
    const controller = new SessionRuntimeController(environment);
    if (environment.mode === "kernel") {
      void SavedFilterSyncAlarm.install(
        environment.alarms,
        environment.runtime,
        () => controller.requestSavedFilterSync(),
        environment.storageMode
      );
    }
    environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord18(message) || message.type !== POPUP_PAGE_RELAY && !Object.values(SESSION_MESSAGE_TYPES).includes(message.type)) {
        return false;
      }
      void controller.handle(message, sender).then(
        (response) => sendResponse(response),
        () => sendResponse({
          ok: false,
          snapshot: toPublicSessionSnapshot(DEGRADED_STORAGE_SNAPSHOT),
          error: "runtime_unavailable"
        })
      );
      return true;
    });
    void controller.start();
    return controller;
  }

  // src/extension-runtime/earned-permission-registration.mts
  var EARNED_PERMISSION_REGISTRATION_MESSAGE = "TRACE_EARNED_PERMISSION_RECONCILE";
  var EARNED_PERMISSION_STATE_KEY = "traceEarnedPermissionOnboardingV1";
  var POPUP_OPENED_MESSAGE = "TRACE_ARCHIVE_ACCESS_REPORT";
  var EARNED_PERMISSION_RETRY_ALARM = "traceEarnedPermissionRetry";
  var EARNED_PERMISSION_RETRY_DELAYS_MINUTES = Object.freeze([1, 5, 30, 180]);
  var EARNED_PERMISSION_RETRY_REST_MINUTES = 24 * 60;
  var EARNED_PERMISSION_ENDED_KEY = "traceEarnedPermissionEndedV1";
  var EARNED_PERMISSION_OPTIONAL_ATTEMPT_KEY = "traceEarnedPermissionOptionalAttemptV1";
  var OPTIONAL_REGISTRATION_TIMEOUT_MS = 5e3;
  var DEFAULT_RECONCILE_TIMEOUT_MS = 5e3;
  var DEFAULT_ENDED_GRANT_CONFIRM_DELAY_MS = 2e3;
  var UNKNOWN_PERMISSION_STATE = Symbol("unknown permission state");
  function isRecord20(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function callExtensionApi(target, method, args, runtime, mode) {
    if (mode === "promise") {
      try {
        return Promise.resolve(target[method](...args));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      try {
        target[method](...args, (value) => {
          const message = runtime.lastError?.message;
          if (message) reject(new Error(message));
          else resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  function storedState(value) {
    if (!isRecord20(value)) return Object.freeze({});
    return Object.freeze({
      ...typeof value.grantAt === "number" && value.grantAt > 0 ? { grantAt: value.grantAt } : {},
      ...Number.isInteger(value.registrationVersion) && Number(value.registrationVersion) > 0 ? { registrationVersion: Number(value.registrationVersion) } : {},
      ...value.promptResult === "granted" || value.promptResult === "declined" ? { promptResult: value.promptResult } : {},
      ...typeof value.completedAt === "number" && value.completedAt > 0 ? { completedAt: value.completedAt } : {}
    });
  }
  var EarnedPermissionRegistrationController = class {
    #environment;
    #generation = 0;
    #running = 0;
    #expected = /* @__PURE__ */ new Set();
    #optional = Promise.resolve();
    #tail = Promise.resolve({
      ok: false,
      completeGrant: false,
      registered: false,
      changed: false,
      error: "permission_incomplete"
    });
    constructor(environment) {
      this.#environment = environment;
    }
    /**
     * Work that will reconcile, made known the moment it is set off. An event
     * that leads to a reconcile does other things first; without this, someone
     * asking in between would be told nothing is under way.
     */
    expect(work) {
      this.#expected.add(work);
      const done = () => {
        this.#expected.delete(work);
      };
      work.then(done, done);
      return work;
    }
    /** Whether a reconcile is running, waiting its turn, or about to be asked for. */
    pending() {
      return this.#running > 0 || this.#expected.size > 0;
    }
    /** Resolves once `pending()` is false. */
    async idle() {
      while (this.pending()) {
        await Promise.allSettled([this.#tail, ...this.#expected]);
      }
    }
    /** True once nothing is pending; false if that takes longer than `limitMs`. */
    settled(limitMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), limitMs);
        void this.idle().then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    }
    /** Resolves once the latest attempt at the optional page scripts has ended. */
    optionalSettled() {
      return this.#optional;
    }
    // Never awaited by a reconcile, so an optional script that the browser
    // refuses, or a call that never answers, cannot hold back or fail the
    // registration of the others.
    #addOptional(currentIds, afterFullRegistration, generation) {
      const missing = (this.#environment.config.optionalRegistrations ?? []).filter(
        ({ id }) => !currentIds.has(id)
      );
      if (missing.length === 0) return;
      const attempt = this.#attemptOptional(missing, afterFullRegistration, generation).catch(() => void 0);
      this.#optional = this.#optional.then(() => attempt);
    }
    async #attemptOptional(missing, afterFullRegistration, generation) {
      const { runtime, scripting, storage, storageMode } = this.#environment;
      if (!scripting) return;
      let extensionVersion = "";
      try {
        extensionVersion = runtime.getManifest?.().version ?? "";
      } catch {
        extensionVersion = "";
      }
      const stamp = `${extensionVersion}|${missing.map(({ id }) => id).join(",")}`;
      if (!afterFullRegistration) {
        const tried = await storage.get(EARNED_PERMISSION_OPTIONAL_ATTEMPT_KEY).then((value) => value[EARNED_PERMISSION_OPTIONAL_ATTEMPT_KEY]).catch(() => null);
        if (tried === stamp) return;
      }
      if (this.#generation !== generation) return;
      await storage.set({ [EARNED_PERMISSION_OPTIONAL_ATTEMPT_KEY]: stamp }).catch(() => void 0);
      let timer;
      try {
        await Promise.race([
          callExtensionApi(
            scripting,
            "registerContentScripts",
            [missing],
            runtime,
            storageMode
          ),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("optional_registration_timeout")),
              this.#environment.optionalRegistrationTimeoutMs ?? OPTIONAL_REGISTRATION_TIMEOUT_MS
            );
          })
        ]);
      } catch (error) {
        console.warn(
          "[Trace] An optional page script was not registered; the others are unaffected:",
          missing.map(({ id }) => id).join(", "),
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        clearTimeout(timer);
      }
    }
    reconcile() {
      this.#running += 1;
      const next = this.#tail.then(
        () => this.#bounded(),
        () => this.#bounded()
      );
      this.#tail = next;
      const ended = () => {
        this.#running -= 1;
      };
      next.then(ended, ended);
      return next;
    }
    // Safari can leave an extension API call unanswered after it suspends and
    // wakes the background. Serialized reconciles would then wait behind it for
    // the rest of the worker's life, and every archive page would stay gated
    // until Safari restarts. Settle each run so the next one can proceed.
    //
    // Settling does not cancel the slow run, so every run carries a generation.
    // A run applies side effects (state writes, script registration changes)
    // only while it is still the latest; once it times out or a newer run has
    // started, whatever it finds later is dropped.
    #bounded() {
      this.#generation += 1;
      const generation = this.#generation;
      const timeoutMs = this.#environment.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (this.#generation === generation) this.#generation += 1;
          reject(new Error("reconcile_timeout"));
        }, timeoutMs);
      });
      return Promise.race([this.#reconcile(generation), timeout]).finally(() => {
        clearTimeout(timer);
      });
    }
    #assertCurrent(generation) {
      if (this.#generation !== generation) throw new Error("reconcile_superseded");
    }
    async #readGrant() {
      const { config, permissions, runtime, storageMode } = this.#environment;
      const [permissionSnapshot, semanticGrant] = await Promise.all([
        callExtensionApi(
          permissions,
          "getAll",
          [],
          runtime,
          storageMode
        ).catch(() => UNKNOWN_PERMISSION_STATE),
        typeof permissions.contains === "function" ? callExtensionApi(
          permissions,
          "contains",
          [{ origins: config.origins }],
          runtime,
          storageMode
        ).catch(() => null) : Promise.resolve(null)
      ]);
      if (permissionSnapshot === UNKNOWN_PERMISSION_STATE && typeof semanticGrant !== "boolean") {
        throw new Error("permission_state_unavailable");
      }
      const snapshotOrigins = typeof permissionSnapshot === "symbol" ? void 0 : permissionSnapshot.origins;
      const granted = new Set(
        Array.isArray(snapshotOrigins) ? snapshotOrigins.filter((origin) => typeof origin === "string") : []
      );
      return Object.freeze({
        complete: config.origins.length > 0 && (typeof semanticGrant === "boolean" ? semanticGrant : config.origins.every((origin) => granted.has(origin))),
        listed: typeof permissionSnapshot !== "symbol"
      });
    }
    // Once the scripts are gone, nothing on a story page wakes this worker, so
    // a grant wrongly read as ended would stop saving without a word until
    // something else started the worker. Take the reading again after a pause,
    // and end the grant only when both readings say so and the browser listed
    // what is granted both times.
    async #grantHasEnded(first, generation) {
      if (first.complete || !first.listed) return false;
      const delayMs = this.#environment.endedGrantConfirmDelayMs ?? DEFAULT_ENDED_GRANT_CONFIRM_DELAY_MS;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      this.#assertCurrent(generation);
      const second = await this.#readGrant().catch(() => null);
      return second !== null && !second.complete && second.listed;
    }
    async #reconcile(generation) {
      const { config, runtime, scripting, storageMode, storage } = this.#environment;
      const [reading, stored, endedConfirmed] = await Promise.all([
        this.#readGrant(),
        storage.get(EARNED_PERMISSION_STATE_KEY).then((value) => storedState(value[EARNED_PERMISSION_STATE_KEY])).catch(() => Object.freeze({})),
        storage.get(EARNED_PERMISSION_ENDED_KEY).then((value) => typeof value[EARNED_PERMISSION_ENDED_KEY] === "number").catch(() => false)
      ]);
      if (reading.complete && endedConfirmed) {
        await storage.remove(EARNED_PERMISSION_ENDED_KEY).catch(() => void 0);
      }
      const completeGrant = reading.complete;
      const staticRegistration = config.registrationMode === "static";
      if (staticRegistration) {
        if (!completeGrant) {
          return Object.freeze({
            ok: false,
            completeGrant: false,
            registered: false,
            changed: false,
            error: "permission_incomplete"
          });
        }
        const grantAt = typeof stored.grantAt === "number" ? stored.grantAt : this.#environment.clock?.() ?? Date.now();
        if (stored.grantAt !== grantAt || stored.registrationVersion !== config.version || stored.promptResult !== "granted") {
          this.#assertCurrent(generation);
          await storage.set({
            [EARNED_PERMISSION_STATE_KEY]: {
              ...stored,
              grantAt,
              registrationVersion: config.version,
              promptResult: "granted"
            }
          });
        }
        return Object.freeze({
          ok: true,
          completeGrant: true,
          registered: true,
          changed: false,
          grantAt
        });
      }
      if (!scripting) {
        return Object.freeze({
          ok: false,
          completeGrant: true,
          registered: false,
          changed: false,
          error: "registration_failed"
        });
      }
      const configuredIds = config.registrations.map(({ id }) => id);
      const current = await callExtensionApi(
        scripting,
        "getRegisteredContentScripts",
        [],
        runtime,
        storageMode
      ).catch(() => []);
      const currentIds = new Set(
        current.map(({ id }) => id).filter((id) => typeof id === "string")
      );
      const registered = configuredIds.every((id) => currentIds.has(id));
      if (!completeGrant) {
        const staleIds = configuredIds.filter((id) => currentIds.has(id));
        const staleOptionalIds = (config.optionalRegistrations ?? []).map(({ id }) => id).filter((id) => currentIds.has(id));
        const hadGrant = staleIds.length > 0 || stored.promptResult === "granted" || typeof stored.completedAt === "number";
        const alreadyConfirmed = endedConfirmed && staleIds.length === 0;
        if (hadGrant && !alreadyConfirmed) {
          if (!await this.#grantHasEnded(reading, generation)) {
            throw new Error("permission_state_unconfirmed");
          }
          this.#assertCurrent(generation);
          await storage.set({ [EARNED_PERMISSION_ENDED_KEY]: this.#environment.clock?.() ?? Date.now() }).catch(() => void 0);
        }
        const removable = [...staleIds, ...staleOptionalIds];
        if (removable.length > 0) {
          this.#assertCurrent(generation);
          await callExtensionApi(
            scripting,
            "unregisterContentScripts",
            [{ ids: removable }],
            runtime,
            storageMode
          ).catch(() => void 0);
        }
        return Object.freeze({
          ok: false,
          completeGrant: false,
          registered: false,
          changed: removable.length > 0,
          error: "permission_incomplete"
        });
      }
      const versionCurrent = stored.registrationVersion === config.version;
      if (registered && versionCurrent) {
        const grantAt = typeof stored.grantAt === "number" ? stored.grantAt : this.#environment.clock?.() ?? Date.now();
        if (stored.grantAt !== grantAt || stored.promptResult !== "granted") {
          this.#assertCurrent(generation);
          await storage.set({
            [EARNED_PERMISSION_STATE_KEY]: {
              ...stored,
              grantAt,
              registrationVersion: config.version,
              promptResult: "granted"
            }
          });
        }
        this.#addOptional(currentIds, false, generation);
        return Object.freeze({
          ok: true,
          completeGrant: true,
          registered: true,
          changed: false,
          grantAt
        });
      }
      try {
        const staleIds = configuredIds.filter((id) => currentIds.has(id));
        if (staleIds.length > 0) {
          this.#assertCurrent(generation);
          await callExtensionApi(
            scripting,
            "unregisterContentScripts",
            [{ ids: staleIds }],
            runtime,
            storageMode
          );
        }
        this.#assertCurrent(generation);
        await callExtensionApi(
          scripting,
          "registerContentScripts",
          [config.registrations],
          runtime,
          storageMode
        );
        const confirmed = await callExtensionApi(
          scripting,
          "getRegisteredContentScripts",
          [],
          runtime,
          storageMode
        );
        const confirmedIds = new Set(
          confirmed.map(({ id }) => id).filter((id) => typeof id === "string")
        );
        if (!configuredIds.every((id) => confirmedIds.has(id))) {
          throw new Error("registration_not_confirmed");
        }
        const completedAt = typeof stored.completedAt === "number" ? stored.completedAt : null;
        const grantAt = completedAt !== null && typeof stored.grantAt === "number" ? stored.grantAt : this.#environment.clock?.() ?? Date.now();
        this.#assertCurrent(generation);
        await storage.set({
          [EARNED_PERMISSION_STATE_KEY]: {
            ...stored,
            grantAt,
            registrationVersion: config.version,
            promptResult: "granted",
            completedAt
          }
        });
        this.#addOptional(currentIds, true, generation);
        return Object.freeze({
          ok: true,
          completeGrant: true,
          registered: true,
          changed: true,
          grantAt
        });
      } catch {
        return Object.freeze({
          ok: false,
          completeGrant: true,
          registered: false,
          changed: false,
          error: "registration_failed"
        });
      }
    }
  };
  function installEarnedPermissionRegistrationRuntime(environment) {
    const controller = new EarnedPermissionRegistrationController(environment);
    const { alarms, runtime, storage, storageMode } = environment;
    const alarm = (method, args) => alarms === void 0 ? Promise.resolve() : callExtensionApi(
      alarms,
      method,
      args,
      runtime,
      storageMode
    ).catch(() => void 0);
    const RETRY_PREFIX = `${EARNED_PERMISSION_RETRY_ALARM}:`;
    const REST_ALARM = `${RETRY_PREFIX}rest`;
    const RETRIES = EARNED_PERMISSION_RETRY_DELAYS_MINUTES.length;
    const ALL_RETRY_ALARMS = [
      ...EARNED_PERMISSION_RETRY_DELAYS_MINUTES.map((_, index) => `${RETRY_PREFIX}${index}`),
      REST_ALARM
    ];
    const waitingRetries = async () => {
      if (typeof alarms?.getAll !== "function") return null;
      try {
        const all = await callExtensionApi(
          alarms,
          "getAll",
          [],
          runtime,
          storageMode
        );
        return all.map(({ name }) => name).filter((name) => typeof name === "string" && name.startsWith(RETRY_PREFIX));
      } catch {
        return null;
      }
    };
    let nextRetry = null;
    const clearRetries = async () => {
      nextRetry = null;
      for (const name of await waitingRetries() ?? ALL_RETRY_ALARMS) {
        await alarm("clear", [name]);
      }
    };
    let unfinished = false;
    const finished = async (registered, changed) => {
      const late = unfinished;
      unfinished = false;
      if (registered && (changed || late)) environment.onScriptsRegistered?.();
      await clearRetries();
    };
    const tryLater = async () => {
      unfinished = true;
      if (typeof alarms?.create !== "function") return;
      let next = nextRetry;
      nextRetry = null;
      if (next === null) {
        const waiting = await waitingRetries();
        if (waiting === null || waiting.length > 0) return;
        next = 0;
      }
      await alarm("create", next < RETRIES ? [`${RETRY_PREFIX}${next}`, { delayInMinutes: EARNED_PERMISSION_RETRY_DELAYS_MINUTES[next] }] : [REST_ALARM, { delayInMinutes: EARNED_PERMISSION_RETRY_REST_MINUTES }]);
    };
    const reconcile = () => {
      const result = controller.reconcile();
      const ended = (value) => {
        try {
          environment.onReconcileEnded?.(value);
        } catch {
        }
      };
      void result.then(
        (value) => {
          ended(value);
          return value.ok || value.error === "permission_incomplete" ? finished(value.ok, value.changed) : tryLater();
        },
        () => {
          ended(null);
          return tryLater();
        }
      ).catch(() => void 0);
      return result;
    };
    const reconcileAfresh = async (newGrant) => {
      await clearRetries();
      if (newGrant) await storage.remove(EARNED_PERMISSION_ENDED_KEY).catch(() => void 0);
      await reconcile().catch(() => void 0);
    };
    alarms?.onAlarm?.addListener((fired) => {
      const name = fired?.name;
      if (typeof name !== "string" || !ALL_RETRY_ALARMS.includes(name)) return;
      nextRetry = name === REST_ALARM ? RETRIES : Number(name.slice(RETRY_PREFIX.length)) + 1;
      void reconcile().catch(() => void 0);
    });
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord20(message)) return false;
      if (message.type === POPUP_OPENED_MESSAGE && isPopupSender(sender, runtime.id)) {
        void reconcile().catch(() => void 0);
        return false;
      }
      if (message.type !== EARNED_PERMISSION_REGISTRATION_MESSAGE) return false;
      void reconcile().then(
        (response) => sendResponse(response),
        () => sendResponse({
          ok: false,
          completeGrant: false,
          registered: false,
          changed: false,
          error: "registration_failed"
        })
      );
      return true;
    });
    environment.permissions.onAdded?.addListener(() => {
      void controller.expect(reconcileAfresh(true));
    });
    environment.permissions.onRemoved?.addListener(() => {
      void reconcile().catch(() => void 0);
    });
    runtime.onInstalled?.addListener((details) => {
      if (details.reason === "install" || details.reason === "update") {
        void controller.expect(reconcileAfresh(false));
      }
    });
    void reconcile().catch(() => void 0);
    return controller;
  }

  // src/extension-runtime/archive-readiness.mts
  var ARCHIVE_READINESS_MESSAGE_TYPES = Object.freeze({
    archiveSeen: "TRACE_ARCHIVE_SEEN",
    accessReport: "TRACE_ARCHIVE_ACCESS_REPORT"
  });
  var ARCHIVE_ACCESS_REPORTED_AT_KEY = "traceArchiveAccessReportedAtV1";
  var ARCHIVE_ACCESS_STATE_KEY = "traceArchiveAccessStateV1";
  var ARCHIVE_ACCESS_REPORT_PERIOD_MINUTES = 24 * 60;
  var ARCHIVE_ACCESS_REPORT_STALE_MS = 20 * 60 * 60 * 1e3;
  var BrowserArchiveAccessLedger = class {
    #storage;
    constructor(storage) {
      this.#storage = storage;
    }
    async read() {
      const stored = await this.#storage.get([
        ARCHIVE_ACCESS_REPORTED_AT_KEY,
        ARCHIVE_ACCESS_STATE_KEY,
        EARNED_PERMISSION_STATE_KEY
      ]);
      const deliveredAt = stored[ARCHIVE_ACCESS_REPORTED_AT_KEY];
      const state = isRecord21(stored[ARCHIVE_ACCESS_STATE_KEY]) ? stored[ARCHIVE_ACCESS_STATE_KEY] : {};
      const setup = isRecord21(stored[EARNED_PERMISSION_STATE_KEY]) ? stored[EARNED_PERMISSION_STATE_KEY] : {};
      const grantedBefore = setup.promptResult === "granted" || typeof setup.completedAt === "number" && setup.completedAt > 0;
      const time = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
      return Object.freeze({
        grantSeen: state.grantSeen === true || grantedBefore,
        ...time(deliveredAt) ? { deliveredAt } : {},
        ...typeof state.delivered === "string" ? { delivered: state.delivered.slice(0, 64) } : {},
        ...Number.isInteger(state.failures) && state.failures > 0 ? { failures: state.failures } : {},
        ...time(state.retryAt) ? { retryAt: state.retryAt } : {}
      });
    }
    async write(ledger) {
      await this.#storage.set({
        ...ledger.deliveredAt === void 0 ? {} : { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: ledger.deliveredAt },
        [ARCHIVE_ACCESS_STATE_KEY]: {
          grantSeen: ledger.grantSeen,
          ...ledger.delivered === void 0 ? {} : { delivered: ledger.delivered },
          ...ledger.failures === void 0 ? {} : { failures: ledger.failures },
          ...ledger.retryAt === void 0 ? {} : { retryAt: ledger.retryAt }
        }
      });
    }
  };
  function isRecord21(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function normalizeHandoffId(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null;
  }
  var ArchiveReadinessRuntimeController = class {
    #publishTrackingPreference;
    #service;
    #status;
    constructor(environment) {
      this.#status = environment.status;
      this.#publishTrackingPreference = environment.publishTrackingPreference;
      this.#service = new ArchiveReadinessService({
        receipts: new NativeArchiveReadinessReceiptPort(
          environment.runtime,
          environment.storageMode
        ),
        permissions: new BrowserArchivePermissionSnapshotPort(
          environment.permissions,
          environment.runtime,
          environment.storageMode
        ),
        ...environment.clock === void 0 ? {} : { clock: environment.clock },
        ...environment.requiredOrigins === void 0 ? {} : { requiredOrigins: environment.requiredOrigins },
        ...environment.accessConfirmWait === void 0 ? {} : { wait: environment.accessConfirmWait },
        ...environment.accessLedger === void 0 ? {} : { accessLedger: environment.accessLedger },
        ...environment.accessSettled === void 0 ? {} : { settled: environment.accessSettled }
      });
    }
    /** See `ArchiveReadinessService.reportAccess`. */
    reportAccess(options = {}) {
      return this.#service.reportAccess(options);
    }
    async handle(message, sender) {
      if (!isRecord21(message) || message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.archiveSeen) {
        return null;
      }
      const hostKind2 = archiveHostKindFromSender(sender);
      if (hostKind2 === null) return { ok: true, receipt: "ignored" };
      void this.#status?.record({ hostKind: hostKind2 }).catch(() => {
      });
      const preference = this.#publishTrackingPreference?.().catch(() => {
      });
      const handoffId = normalizeHandoffId(message.handoffId);
      const result = await this.#service.recordRun({
        hostKind: hostKind2,
        ...handoffId === null ? {} : { handoffId }
      });
      await preference;
      return { ok: true, receipt: result.kind };
    }
  };
  function installArchiveReadinessRuntime(environment) {
    const controller = new ArchiveReadinessRuntimeController(environment);
    environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord21(message) || message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.archiveSeen) {
        return false;
      }
      void controller.handle(message, sender).then(
        (response) => sendResponse(response),
        () => sendResponse({ ok: true, receipt: "unavailable" })
      );
      return true;
    });
    return controller;
  }
  function runsBesideTraceApp(runtime, mode, userAgent) {
    if (typeof runtime.sendNativeMessage !== "function") return false;
    if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
    if (!/Macintosh/i.test(userAgent) || typeof runtime.getPlatformInfo !== "function") {
      return false;
    }
    return extensionCall(
      runtime,
      "getPlatformInfo",
      [],
      runtime,
      mode
    ).then((info) => info?.os === "ios", () => false);
  }
  function installArchiveAccessReport(controller, environment) {
    const { accessLedger, alarms, permissions, runtime, storageMode } = environment;
    const now = () => environment.clock?.now() ?? Date.now();
    const beside = runsBesideTraceApp(
      runtime,
      storageMode,
      environment.platform?.userAgent ?? globalThis.navigator?.userAgent ?? ""
    );
    if (beside === false) return { report: async () => ({ kind: "unknown" }) };
    const supported = Promise.resolve(beside);
    const report = async (options = {}) => await supported ? controller.reportAccess(options) : { kind: "unknown" };
    const reportQuietly = () => {
      void report().catch(() => void 0);
    };
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord21(message) || message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.accessReport) {
        return false;
      }
      if (Object.keys(message).length !== 1 || !isPopupSender(sender, runtime.id)) {
        sendResponse({ ok: false });
        return false;
      }
      void report({ readerPresent: true }).then(
        (result) => sendResponse({ ok: true, report: result.kind }),
        () => sendResponse({ ok: true, report: "unavailable" })
      );
      return true;
    });
    permissions?.onAdded?.addListener(reportQuietly);
    permissions?.onRemoved?.addListener(reportQuietly);
    alarms?.onAlarm?.addListener((alarm) => {
      if (alarm?.name === ARCHIVE_ACCESS_REPORT_ALARM) reportQuietly();
    });
    void supported.then(async (yes) => {
      if (!yes) return;
      const existing = typeof alarms?.get === "function" ? await extensionCall(
        alarms,
        "get",
        [ARCHIVE_ACCESS_REPORT_ALARM],
        runtime,
        storageMode
      ).catch(() => void 0) : void 0;
      if (!isRecord21(existing)) {
        try {
          const created = alarms?.create?.(ARCHIVE_ACCESS_REPORT_ALARM, {
            periodInMinutes: ARCHIVE_ACCESS_REPORT_PERIOD_MINUTES
          });
          if (created && typeof created.then === "function") {
            await Promise.resolve(created).catch(() => void 0);
          }
        } catch {
          void runtime.lastError;
        }
      }
      const ledger = await accessLedger.read().catch(() => null);
      if (ledger === null) return;
      const deliveredAt = ledger.deliveredAt;
      if (typeof deliveredAt === "number" && deliveredAt <= now() && now() - deliveredAt < ARCHIVE_ACCESS_REPORT_STALE_MS) {
        return;
      }
      reportQuietly();
    }).catch(() => void 0);
    return { report };
  }

  // src/extension-runtime/first-tap-save.mts
  var FIRST_TAP_POPUP_PORT = "trace-first-tap-popup-v1";
  var FIRST_TAP_COLLECT_MESSAGE = "TRACE_FIRST_TAP_COLLECT";
  var FIRST_TAP_MARK_MESSAGE = "TRACE_FIRST_TAP_MARK";
  var FIRST_TAP_MANUAL_MODE_END_MESSAGE = "TRACE_PAGE_MANUAL_MODE_END";
  var FIRST_TAP_MANUAL_MODE_QUERY_MESSAGE = "TRACE_PAGE_MANUAL_MODE_QUERY";
  var FIRST_TAP_STORE_KEY = "traceFirstTapSaveV2";
  var FIRST_TAP_RESULT_FRESH_MS = 10 * 60 * 1e3;
  var FIRST_TAP_RECORD_TTL_MS = 24 * 60 * 60 * 1e3;
  var FIRST_TAP_RECORD_LIMIT = 20;
  var FIRST_TAP_UNPLACED_DOUBT_TTL_MS = 2592e6;
  var FIRST_TAP_OPEN_READ_MS = 2500;
  function within(work, ms, fallback) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer));
  }
  var isTapped = (value) => isRecord22(value) && Number.isInteger(value.tabId) && typeof value.url === "string" && (value.private === null || typeof value.private === "boolean");
  function isRecord22(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function text(value, limit) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
  }
  function storyFrom(collected, hostKind2) {
    return Object.freeze({
      title: text(collected.title, 300),
      author: text(collected.author, 200),
      site: hostKind2 === "ffn" ? "FanFiction.net" : "AO3"
    });
  }
  function entryFrom(confirmation) {
    const entry = confirmation.entry;
    return Object.freeze({
      status: text(entry.status, 40),
      readerStatus: text(entry.readerStatus, 40),
      canonicalReaderStatus: text(entry.canonicalReaderStatus, 40),
      chapters: entry.chapters === void 0 ? null : Object.freeze({ current: entry.chapters.current, total: entry.chapters.total })
    });
  }
  function weight(outcome) {
    if (outcome === null || outcome.kind === "saving") return 0;
    if (outcome.kind === "failed") return 1;
    return outcome.provenance === "found" ? 2 : 3;
  }
  function settledFrom(value) {
    if (!isRecord22(value)) return null;
    if (value.kind === "confirmed" && isRecord22(value.entry) && ["saved_now", "already", "found"].includes(String(value.provenance))) {
      return value;
    }
    if (value.kind === "failed" && typeof value.reason === "string" && ["never_sent", "refused", "sent_unconfirmed", "not_in_library"].includes(String(value.dispatch))) {
      return value;
    }
    return null;
  }
  function storedFrom(value) {
    if (!isRecord22(value) || typeof value.salt !== "string" || value.salt.length < 16) return null;
    const records = [];
    for (const item of Array.isArray(value.records) ? value.records : []) {
      if (!isRecord22(item) || typeof item.k !== "string" || typeof item.s !== "string" || typeof item.at !== "number") continue;
      records.push({
        k: item.k,
        s: item.s,
        at: item.at,
        inDoubt: item.inDoubt === true,
        outcome: settledFrom(item.outcome),
        ...typeof item.w === "string" ? { w: item.w } : {}
      });
    }
    const strings = (list) => (Array.isArray(list) ? list : []).filter((item) => typeof item === "string");
    return {
      salt: value.salt,
      forgot: strings(value.forgot),
      records,
      doubts: strings(value.doubts),
      unkept: Number.isInteger(value.unkept) && value.unkept > 0 ? value.unkept : 0,
      unkeptAt: typeof value.unkeptAt === "number" ? value.unkeptAt : null,
      unplacedAt: typeof value.unplacedAt === "number" ? value.unplacedAt : null
    };
  }
  function emptyStore(salt) {
    return { salt, forgot: [], records: [], doubts: [], unkept: 0, unkeptAt: null, unplacedAt: null };
  }
  function storySaveModeAtAdmission(evidence) {
    if (evidence.grantComplete === true && evidence.registered === true) {
      return "normal_automatic";
    }
    if (evidence.injectedForFirstTap && evidence.grantComplete === false) {
      return "bounded_manual";
    }
    return null;
  }
  var FirstTapSave = class {
    #ports;
    /** Records by key. Each belongs to one account and one story. */
    #records = /* @__PURE__ */ new Map();
    /** Open popups, and the record each is showing. */
    #sheets = /* @__PURE__ */ new Map();
    /** Tabs whose page script this background injected, and for which story. */
    #injected = /* @__PURE__ */ new Map();
    /** The kept records; `readable` is false when storage could not be read. */
    #store = null;
    #writes = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    /** Whether the background injected this tab's page script for this story. */
    injectedFor(tabId, workKey) {
      return this.#injected.get(tabId) === workKey;
    }
    /** Tabs whose page script this background injected, while it has been awake. */
    injectedTabs() {
      return [...this.#injected.keys()];
    }
    /**
     * The reader opened Trace on `tapped`. Returns what is known now; later
     * changes to the same record reach `listener` until `closed` is called.
     */
    async opened(listener, tapped, options = {}) {
      const page = this.#storyPage(tapped);
      if (page === null) return Object.freeze({ state: "not_applicable" });
      let opened = () => void 0;
      const opening = new Promise((resolve) => {
        opened = resolve;
      });
      const sheet = this.#sheets.get(listener) ?? { tabId: page.tabId, key: null, workKey: null, opening };
      sheet.tabId = page.tabId;
      sheet.key = null;
      sheet.workKey = page.workKey;
      sheet.opening = opening;
      this.#sheets.set(listener, sheet);
      let record5;
      let grant;
      try {
        grant = await this.#ports.grantComplete().catch(() => null);
        if (grant === true) return Object.freeze({ state: "automatic" });
        const account = await this.#ports.account().catch(
          () => Object.freeze({ state: "unknown" })
        );
        if (account.state !== "verified") {
          return Object.freeze({
            state: account.state === "missing" ? "account_missing" : account.state === "reconnect_required" ? "account_reconnect_required" : "account_unknown",
            workKey: page.workKey
          });
        }
        record5 = await this.#recordFor(account, page);
        if (this.#sheets.get(listener) === sheet) sheet.key = record5.key;
      } finally {
        opened();
      }
      const decided = record5.deciding.then(() => this.#decide(record5, page, grant, options));
      record5.deciding = decided.then(() => void 0, () => void 0);
      return decided;
    }
    /** What an open comes to, worked out with no other open of the record under way. */
    async #decide(record5, page, grant, options) {
      if (record5.running) return this.#view(record5);
      const age = this.#ports.now() - record5.at;
      const fresh = age >= 0 && age < FIRST_TAP_RESULT_FRESH_MS;
      if (fresh && record5.outcome?.kind === "confirmed") return this.#view(record5);
      if (fresh && record5.outcome?.kind === "failed" && options.requested !== true) {
        return this.#view(record5);
      }
      if (record5.inDoubt) {
        const found = await this.#look(record5);
        if (found === "account_changed") return this.#accountChanged(record5);
        if (found !== null) {
          this.#begin(record5, page);
          if (await this.#ports.inject(page.tabId).catch(() => false)) {
            this.#injected.set(page.tabId, page.workKey);
          }
          return this.#settle(record5, { kind: "confirmed", provenance: "found", mode: null, entry: found });
        }
      }
      if (options.requested !== true) {
        const preference = await this.#ports.automaticSaving().catch(() => "unknown");
        if (preference !== "on" || this.#ports.saveOnOpen !== true) {
          if (record5.inDoubt) {
            return Object.freeze({
              state: "failed",
              workKey: page.workKey,
              reason: "unavailable",
              dispatch: "sent_unconfirmed",
              story: record5.story
            });
          }
          const [found] = await Promise.all([
            preference === "off" ? Promise.resolve(null) : within(this.#look(record5), FIRST_TAP_OPEN_READ_MS, null),
            within(this.#readForSheet(record5, page), FIRST_TAP_OPEN_READ_MS, void 0)
          ]);
          if (found === "account_changed") return this.#accountChanged(record5);
          if (found !== null) {
            this.#begin(record5, page);
            return this.#settle(record5, {
              kind: "confirmed",
              provenance: record5.priorKnown && !record5.pageSave ? "already" : "found",
              mode: null,
              entry: found
            });
          }
          return Object.freeze({ state: "awaiting_request", workKey: page.workKey, preference, story: record5.story });
        }
      }
      this.#begin(record5, page);
      record5.running = true;
      record5.outcome = Object.freeze({ kind: "saving", startedAt: this.#ports.now() });
      void this.#run(record5, page, grant);
      return this.#view(record5);
    }
    /**
     * "Check again": asks Trace, once, whether this one story is in the
     * account's Library. It has no path to a save. A story Trace has improves
     * the record. One Trace says it does not have is said to be absent only
     * when no save of it is still out. A request that could not be made or
     * read, or that Trace turned away, leaves the story's place not known.
     * A look asked for while one is still out joins it: one request, one answer.
     */
    async check(listener) {
      const sheet = this.#sheets.get(listener);
      if (!sheet || sheet.workKey === null) return Object.freeze({ state: "not_applicable" });
      await sheet.opening;
      if (sheet.workKey === null) return Object.freeze({ state: "not_applicable" });
      const unknown = Object.freeze({ state: "presence_unknown", workKey: sheet.workKey });
      const record5 = sheet.key === null ? null : this.#records.get(sheet.key) ?? null;
      if (record5 === null || record5.binding !== this.#ports.binding()) return unknown;
      if (record5.outcome?.kind === "confirmed") return this.#view(record5);
      if (record5.checking !== null) return record5.checking;
      const asking = this.#askTrace(record5, unknown);
      record5.checking = asking;
      const done = () => {
        if (record5.checking === asking) record5.checking = null;
      };
      void asking.then(done, done);
      return asking;
    }
    async #askTrace(record5, unknown) {
      const membership = await this.#ports.membership(record5.workKey).catch(
        () => ({ kind: "unknown" })
      );
      if (membership.kind === "account_refused") {
        return Object.freeze({ state: "account_reconnect_required", workKey: record5.workKey });
      }
      if (this.#ports.binding() !== record5.binding) return this.#accountChanged(record5);
      if (membership.kind === "present") {
        return this.#settle(record5, {
          kind: "confirmed",
          provenance: "found",
          mode: null,
          entry: Object.freeze({ ...membership.entry, chapters: null })
        });
      }
      if (membership.kind !== "absent") return unknown;
      if (record5.running) return this.#view(record5);
      return this.#settle(record5, { kind: "failed", reason: "unavailable", dispatch: "not_in_library" });
    }
    /** Trace's popup closed. The page it was over may now show its mark. */
    closed(listener) {
      const sheet = this.#sheets.get(listener);
      if (!sheet) return;
      this.#sheets.delete(listener);
      const record5 = sheet.key === null ? null : this.#records.get(sheet.key);
      if (record5) void this.#markIfDue(record5);
    }
    /**
     * A page script's own save for this story was admitted for the current
     * account. It may add the story, so the record can no longer say "already",
     * and a failure it showed is no longer the last word.
     */
    pageSaveAdmitted(workKey) {
      const binding = this.#ports.binding();
      for (const record5 of this.#records.values()) {
        if (record5.workKey !== workKey || record5.binding !== binding) continue;
        if (record5.outcome?.kind === "confirmed") continue;
        record5.inDoubt = true;
        record5.pageSave = true;
        if (!record5.running && record5.outcome?.kind === "failed") record5.outcome = null;
        void this.#persist(record5);
      }
    }
    #storyPage(tapped) {
      if (!isTapped(tapped)) return null;
      const hostKind2 = archiveHostKindFromSender({ url: tapped.url });
      if (hostKind2 === null || isBlockedArchivePath(tapped.url, hostKind2)) return null;
      const workKey = workKeyFromArchiveUrl(tapped.url, hostKind2);
      return workKey === null ? null : { tabId: tapped.tabId, workKey, url: tapped.url, hostKind: hostKind2, persist: tapped.private === false };
    }
    // --- Records ----------------------------------------------------------------
    #loadStore() {
      this.#store ??= this.#ports.readStore().then(
        async (value) => {
          const stored = storedFrom(value) ?? emptyStore(this.#ports.randomSalt());
          if (stored.unkept > 0) {
            this.#unplaced(stored, stored.unkeptAt ?? this.#ports.now());
            stored.unkept = 0;
            stored.unkeptAt = null;
            await this.#write(stored);
          }
          return { stored, readable: true };
        },
        // Storage could not be read. A salt for this worker's life still keeps
        // records apart; nothing is kept, and nothing earlier is known.
        () => ({ stored: emptyStore(this.#ports.randomSalt()), readable: false })
      );
      return this.#store;
    }
    /** The record for this account and story, from memory, storage, or new. */
    async #recordFor({ binding, owner }, page) {
      const { stored, readable } = await this.#loadStore();
      const scope2 = await this.#ports.digest(`${stored.salt}\0account\0${binding}`);
      const key = await this.#ports.digest(`${stored.salt}\0story\0${binding}\0${page.workKey}`);
      const work = await this.#ports.digest(`${stored.salt}\0work\0${owner}\0${page.workKey}`);
      let changed = false;
      for (const [otherKey, other] of this.#records) {
        if (other.binding === binding) continue;
        if (other.inDoubt && this.#carryDoubt(stored, other)) changed = true;
        if (!other.running) this.#records.delete(otherKey);
      }
      for (const item of stored.records) {
        if (item.s === scope2) continue;
        changed = true;
        if (item.inDoubt) this.#carryDoubt(stored, { persist: true, work: item.w });
      }
      if (stored.forgot.some((item) => item !== scope2)) {
        changed = true;
        this.#carryDoubt(stored, { persist: false, work: void 0 });
      }
      if (changed) {
        stored.records = stored.records.filter((item) => item.s === scope2);
        stored.forgot = stored.forgot.filter((item) => item === scope2);
        if (readable) await this.#write(stored);
      }
      const priorKnown = page.persist && readable && !stored.forgot.includes(scope2) && !this.#unplacedHolds(stored) && !stored.doubts.includes(work);
      const existing = this.#records.get(key);
      if (existing) {
        existing.persist = existing.persist && page.persist;
        existing.priorKnown = existing.priorKnown && priorKnown;
        return existing;
      }
      const kept = page.persist ? stored.records.find((item) => item.k === key) : void 0;
      const record5 = {
        key,
        scope: scope2,
        binding,
        workKey: page.workKey,
        work,
        persist: page.persist,
        unkept: false,
        at: kept?.at ?? this.#ports.now(),
        outcome: kept?.outcome ?? null,
        inDoubt: kept?.inDoubt === true,
        pageSave: false,
        priorKnown,
        running: false,
        deciding: Promise.resolve(),
        checking: null,
        story: null,
        tabs: /* @__PURE__ */ new Set([page.tabId]),
        marked: /* @__PURE__ */ new Set()
      };
      this.#records.set(key, record5);
      return record5;
    }
    /** Starts a new attempt on a record. Only what is still in doubt carries over. */
    #begin(record5, page) {
      record5.outcome = null;
      record5.at = this.#ports.now();
      record5.pageSave = false;
      record5.tabs = /* @__PURE__ */ new Set([page.tabId]);
      record5.marked = /* @__PURE__ */ new Set();
    }
    #view(record5) {
      const outcome = record5.outcome;
      if (outcome === null || outcome.kind === "saving") {
        return Object.freeze({
          state: "saving",
          workKey: record5.workKey,
          startedAt: outcome?.kind === "saving" ? outcome.startedAt : record5.at,
          story: record5.story
        });
      }
      return outcome.kind === "confirmed" ? Object.freeze({
        state: "confirmed",
        workKey: record5.workKey,
        provenance: outcome.provenance,
        mode: outcome.mode,
        story: record5.story,
        entry: outcome.entry
      }) : Object.freeze({
        state: "failed",
        workKey: record5.workKey,
        reason: outcome.reason,
        dispatch: outcome.dispatch,
        story: record5.story
      });
    }
    /**
     * Records an answer. Within an attempt the record only moves up: a
     * confirmation is never replaced by a failure, and a known origin is never
     * replaced by an unknown one. Returns what the record now says.
     */
    async #settle(record5, answer) {
      if (this.#ports.binding() !== record5.binding) return this.#accountChanged(record5);
      const before = weight(record5.outcome);
      const after = weight(answer);
      if (after > before || after === before && answer.kind === "failed") {
        record5.outcome = Object.freeze(answer);
        record5.at = this.#ports.now();
      }
      if (record5.outcome?.kind === "confirmed") {
        record5.inDoubt = false;
        record5.pageSave = false;
        await this.#doubtSettled(record5);
      }
      await this.#persist(record5);
      const view2 = this.#show(record5);
      await this.#markIfDue(record5);
      return view2;
    }
    /** Tells every popup open on a record what it now says. */
    #show(record5) {
      const view2 = this.#view(record5);
      for (const [listener, sheet] of this.#sheets) {
        if (sheet.key !== record5.key) continue;
        try {
          listener(view2);
        } catch {
        }
      }
      return view2;
    }
    /**
     * Reads the story's page for the sheet to name it, under the access the
     * reader's tap gave the tab. Nothing is sent to Trace and nothing is kept:
     * the page's own word is believed only for the story the popup named.
     */
    async #readForSheet(record5, page) {
      if (!await this.#ports.inject(page.tabId).catch(() => false)) return;
      this.#injected.set(page.tabId, page.workKey);
      const collected = await this.#ports.collect(page.tabId).catch(() => null);
      if (!isRecord22(collected) || collected.ok !== true || collected.workKey !== record5.workKey) return;
      if (collected.private === true && record5.persist) {
        record5.persist = false;
        record5.priorKnown = false;
      }
      record5.story = storyFrom(collected, page.hostKind);
    }
    /** A read-only look: the entry, nothing, or word that the account changed. */
    async #look(record5) {
      const presence = await this.#ports.presence(record5.workKey).catch(
        () => ({ kind: "unknown" })
      );
      if (this.#ports.binding() !== record5.binding) return "account_changed";
      return presence.kind === "found" ? entryFrom(presence.confirmation) : null;
    }
    /** The account changed: nothing held for the old one is shown or kept. */
    #accountChanged(record5) {
      const view2 = Object.freeze({ state: "account_changed", workKey: record5.workKey });
      this.#records.delete(record5.key);
      for (const [listener, sheet] of this.#sheets) {
        if (sheet.key !== record5.key) continue;
        sheet.key = null;
        try {
          listener(view2);
        } catch {
        }
      }
      void this.#drop(record5);
      return view2;
    }
    // --- Storage ----------------------------------------------------------------
    #write(stored) {
      this.#writes = this.#writes.then(() => this.#ports.writeStore({
        salt: stored.salt,
        forgot: [...stored.forgot],
        records: [...stored.records],
        doubts: [...stored.doubts],
        unkept: stored.unkept,
        unkeptAt: stored.unkeptAt,
        unplacedAt: stored.unplacedAt
      })).catch(() => void 0);
      return this.#writes;
    }
    /**
     * This story is confirmed in the Library for the account now signed in. A
     * doubt an ended session of this same account left about it has nothing
     * more to say. A doubt another account left about the same story has a
     * different digest and is not touched.
     */
    async #doubtSettled(record5) {
      const { stored, readable } = await this.#loadStore();
      if (!stored.doubts.includes(record5.work)) return;
      stored.doubts = stored.doubts.filter((item) => item !== record5.work);
      if (readable) await this.#write(stored);
    }
    /**
     * A record that is not kept still counts its write while that write is out
     * and unanswered. The count says nothing of the story, the tab or the
     * account; it is what lets a later background know something went missing.
     */
    async #countUnkept(record5) {
      if (record5.unkept === record5.inDoubt) return;
      const { stored, readable } = await this.#loadStore();
      if (!readable) return;
      record5.unkept = record5.inDoubt;
      stored.unkept = Math.max(0, stored.unkept + (record5.inDoubt ? 1 : -1));
      if (record5.inDoubt) stored.unkeptAt = this.#ports.now();
      await this.#write(stored);
    }
    /** Notes a doubt that can no longer be placed, as of `at` or later. */
    #unplaced(stored, at) {
      stored.unplacedAt = Math.max(stored.unplacedAt ?? at, at);
    }
    /** Whether such a doubt still holds. A clock set back does not end it early. */
    #unplacedHolds(stored) {
      return stored.unplacedAt !== null && this.#ports.now() - stored.unplacedAt < FIRST_TAP_UNPLACED_DOUBT_TTL_MS;
    }
    async #drop(record5) {
      const { stored, readable } = await this.#loadStore();
      let changed = stored.records.some((item) => item.k === record5.key);
      stored.records = stored.records.filter((item) => item.k !== record5.key);
      if (record5.inDoubt && this.#carryDoubt(stored, record5)) changed = true;
      if (changed && readable) await this.#write(stored);
    }
    /**
     * Keeps a doubt past the account session it arose under: by the digest of
     * its account and story where one may be kept, and otherwise, or past the
     * limit, as a doubt about every story that holds for a while.
     */
    #carryDoubt(stored, from) {
      if (from.persist && from.work !== void 0) {
        if (stored.doubts.includes(from.work)) return false;
        stored.doubts.push(from.work);
        if (stored.doubts.length <= FIRST_TAP_RECORD_LIMIT) return true;
        stored.doubts = stored.doubts.slice(-FIRST_TAP_RECORD_LIMIT);
      }
      this.#unplaced(stored, this.#ports.now());
      return true;
    }
    /** Writes what a record now says. No work key, title, author or address. */
    async #persist(record5) {
      if (!record5.persist) return this.#countUnkept(record5);
      const { stored, readable } = await this.#loadStore();
      if (!readable) return;
      const now = this.#ports.now();
      const outcome = record5.outcome === null || record5.outcome.kind === "saving" ? null : record5.outcome;
      let records = stored.records.filter((item) => item.k !== record5.key);
      if (outcome !== null || record5.inDoubt) {
        records.push({
          k: record5.key,
          s: record5.scope,
          at: record5.at,
          inDoubt: record5.inDoubt,
          outcome,
          ...record5.inDoubt ? { w: record5.work } : {}
        });
      }
      records = records.filter((item) => item.inDoubt || now - item.at >= 0 && now - item.at < FIRST_TAP_RECORD_TTL_MS);
      while (records.length > FIRST_TAP_RECORD_LIMIT) {
        const settled = records.findIndex((item) => !item.inDoubt);
        const [dropped] = records.splice(settled === -1 ? 0 : settled, 1);
        if (dropped?.inDoubt && !stored.forgot.includes(dropped.s)) stored.forgot.push(dropped.s);
      }
      stored.records = records;
      await this.#write(stored);
    }
    // --- One attempt ------------------------------------------------------------
    async #run(record5, page, grantAtStart) {
      const earlierInDoubt = record5.inDoubt;
      const fail = async (reason, dispatch) => {
        record5.running = false;
        record5.inDoubt = earlierInDoubt || record5.pageSave || dispatch === "sent_unconfirmed";
        if (record5.pageSave) {
          const found = await this.#look(record5);
          if (found === "account_changed") {
            this.#accountChanged(record5);
            return;
          }
          if (found !== null) {
            await this.#settle(record5, { kind: "confirmed", provenance: "found", mode: null, entry: found });
            return;
          }
        }
        await this.#settle(record5, { kind: "failed", reason, dispatch });
      };
      try {
        if (!await this.#ports.inject(page.tabId).catch(() => false)) {
          return await fail("page_unreachable", "never_sent");
        }
        this.#injected.set(page.tabId, page.workKey);
        const collected = await this.#ports.collect(page.tabId).catch(() => null);
        if (!isRecord22(collected)) return await fail("page_unreachable", "never_sent");
        record5.story = storyFrom(collected, page.hostKind);
        if (collected.ok !== true) {
          return await fail(
            collected.error === "story_unavailable" ? "story_unavailable" : "page_unreachable",
            "never_sent"
          );
        }
        if (collected.workKey !== record5.workKey) return await fail("page_unreachable", "never_sent");
        if (record5.story.title !== null && record5.outcome?.kind === "saving") this.#show(record5);
        if (collected.private === true && record5.persist) {
          record5.persist = false;
          record5.priorKnown = false;
        }
        const command = storyTrackCommandFromMessage(
          {
            type: "TRACE_CONNECT_AND_SAVE",
            workKey: record5.workKey,
            payload: collected.payload,
            ...typeof collected.ffnAuthorId === "string" ? { ffnAuthorId: collected.ffnAuthorId } : {}
          },
          { tab: { url: page.url }, url: page.url, frameId: 0 }
        );
        if (command === null || command.workKey !== record5.workKey) {
          return await fail("page_unreachable", "never_sent");
        }
        if (this.#ports.binding() !== record5.binding) {
          record5.running = false;
          this.#accountChanged(record5);
          return;
        }
        const mode = storySaveModeAtAdmission({
          injectedForFirstTap: true,
          grantComplete: grantAtStart,
          registered: null
        });
        const { result, dispatch } = await this.#ports.save(
          mode === null ? command : { ...command, mode },
          {
            // Written down before the write goes out, so that a background put
            // to sleep mid-save is known afterwards to have a write in doubt.
            beforeWrite: async () => {
              record5.inDoubt = true;
              await this.#persist(record5);
            }
          },
          page.tabId
        );
        if (result.kind === "confirmed") {
          record5.running = false;
          const provenance = result.source === "mutation" ? "saved_now" : result.source === "preflight" && record5.priorKnown && !earlierInDoubt && !record5.pageSave ? "already" : "found";
          await this.#settle(record5, {
            kind: "confirmed",
            provenance,
            mode,
            entry: entryFrom(result.confirmation)
          });
          return;
        }
        const reason = result.reason === "free_limit_reached" || result.reason === "rate_limited" ? result.reason : result.reason === "not_authenticated" || result.reason === "auth_expired" ? "not_authenticated" : "unavailable";
        await fail(reason, dispatch === "confirmed" ? "sent_unconfirmed" : dispatch);
      } catch {
        await fail("unavailable", "sent_unconfirmed").catch(() => void 0);
      }
    }
    // The page shows its mark only for a confirmed story, and only once no
    // popup is open over it. Both read the same record.
    async #markIfDue(record5) {
      if (record5.outcome?.kind !== "confirmed" || this.#ports.binding() !== record5.binding) return;
      for (const tabId of record5.tabs) {
        if (record5.marked.has(tabId)) continue;
        if ([...this.#sheets.values()].some((sheet) => sheet.tabId === tabId)) continue;
        record5.marked.add(tabId);
        await this.#ports.mark(tabId, record5.workKey).catch(() => void 0);
      }
    }
  };

  // src/extension-runtime/story-membership.mts
  var UUID_PATTERN7 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var WORK_KEY_PATTERN6 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var REQUEST_TIMEOUT_MS7 = 12e3;
  var STATUS_LIMIT = 40;
  function isRecord23(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function status(value) {
    return typeof value === "string" && value.trim() && value.trim().length <= STATUS_LIMIT ? value.trim() : null;
  }
  function membershipFrom(value, expectedWorkKey) {
    const invalid = { kind: "invalid_response" };
    if (!isRecord23(value) || value.work_key !== expectedWorkKey) return invalid;
    if (value.membership === "absent") return { kind: "absent" };
    if (value.membership !== "present" || !isRecord23(value.entry)) return invalid;
    const entryId = typeof value.entry_id === "string" ? value.entry_id.trim() : "";
    if (!UUID_PATTERN7.test(entryId) || value.entry.entryId !== entryId) return invalid;
    const entry = Object.freeze({
      status: status(value.entry.status),
      readerStatus: status(value.entry.readerStatus),
      canonicalReaderStatus: status(value.entry.canonicalReaderStatus)
    });
    return entry.status === null && entry.readerStatus === null && entry.canonicalReaderStatus === null ? invalid : { kind: "present", entry };
  }
  var StoryMembershipApi = class {
    #fetch;
    #endpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/library-membership`;
    }
    async read(credential, workKey) {
      if (!WORK_KEY_PATTERN6.test(workKey)) return { kind: "success", value: { kind: "unavailable" } };
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS7);
      let response;
      try {
        response = await this.#fetch(`${this.#endpoint}?work_key=${workKey}`, {
          method: "GET",
          cache: "no-store",
          signal: abort.signal,
          headers: { Authorization: `Bearer ${credential}` }
        });
      } catch {
        return { kind: "success", value: { kind: "unavailable" } };
      } finally {
        globalThis.clearTimeout(timer);
      }
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (!response.ok) return { kind: "success", value: { kind: "unavailable" } };
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return {
        kind: "success",
        value: membershipFrom(isRecord23(body) && body.success === true ? body.data : null, workKey)
      };
    }
  };
  async function readStoryMembership(session, api, workKey) {
    const unknown = Object.freeze({ kind: "unknown" });
    const scope2 = session.publicationScope();
    if (scope2 === null) return unknown;
    const ask = () => session.executeAuthenticated((credential) => api.read(credential, workKey));
    let result;
    try {
      result = await ask();
      if (result.kind === "auth_rejected" && result.recovery === "connected") result = await ask();
    } catch {
      return unknown;
    }
    if (result.kind === "auth_rejected") {
      return result.recovery === "reconnect_required" ? Object.freeze({ kind: "account_refused" }) : unknown;
    }
    if (result.kind !== "published" || !sameAccountScope(session.publicationScope(), scope2)) {
      return unknown;
    }
    if (result.value.kind === "present") {
      return Object.freeze({ kind: "present", entry: result.value.entry });
    }
    return result.value.kind === "absent" ? Object.freeze({ kind: "absent" }) : unknown;
  }

  // src/extension-runtime/setup-milestones.mts
  var SETUP_STEP_MESSAGE = "TRACE_SETUP_STEP";
  var SETUP_MILESTONES_KEY = "traceSetupMilestonesV1";
  var PENDING_MAX_AGE_MS = 864e5;
  var MAX_PENDING = 8;
  var MAX_SENDS = 2;
  var REQUEST_TIMEOUT_MS8 = 1e4;
  var ATTEMPT_MAX_AHEAD_MS = 864e5;
  var UUID_PATTERN8 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function setupMilestoneReport(step) {
    if (step.kind === "sheet_opened") {
      return Object.freeze({
        milestone: "safari_sheet_opened",
        outcome: "confirmed",
        evidence_source: step.page === "story" ? "extension_sheet_story_page" : "extension_sheet_other_page"
      });
    }
    switch (step.answer) {
      case "granted":
        return Object.freeze({
          milestone: "safari_access_answered",
          outcome: "confirmed",
          evidence_source: "extension_permission_granted"
        });
      case "declined":
        return Object.freeze({
          milestone: "safari_access_answered",
          outcome: "failed",
          evidence_source: "extension_permission_declined"
        });
      case "partial":
        return Object.freeze({
          milestone: "safari_access_answered",
          outcome: "failed",
          evidence_source: "extension_permission_partial"
        });
      default:
        return Object.freeze({
          milestone: "safari_access_answered",
          outcome: "unknown",
          evidence_source: "extension_permission_unanswered"
        });
    }
  }
  function setupStepFromMessage(message) {
    if (!isRecord24(message) || message.type !== SETUP_STEP_MESSAGE) return null;
    if (message.step === "sheet_opened" && (message.page === "story" || message.page === "other")) {
      return Object.freeze({ kind: "sheet_opened", page: message.page });
    }
    if (message.step === "access_answered" && (message.answer === "granted" || message.answer === "declined" || message.answer === "partial" || message.answer === "unanswered")) {
      return Object.freeze({ kind: "access_answered", answer: message.answer });
    }
    return null;
  }
  function safariAccessAnswer(view2) {
    switch (view2.state) {
      case "allowed":
      case "registration_failed":
      case "registration_unknown":
        return "granted";
      case "partial":
        return "partial";
      case "not_allowed":
        return "declined";
      case "not_known":
      case "could_not_ask":
        return "unanswered";
      default:
        return null;
    }
  }
  var SetupMilestoneReporter = class {
    #ports;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    /** Keeps the step for the setup under way, if any, then sends what is kept. Never throws. */
    async record(step) {
      try {
        const account = this.#ports.account();
        if (account === null) return;
        const context = await this.#ports.attempt(account).catch(() => void 0);
        const attempt = this.#liveAttempt(context);
        if (attempt === null || this.#ports.account() !== account) return;
        const report = setupMilestoneReport(step);
        await this.#locked(async () => {
          const stored = await this.#read();
          if (this.#ports.account() !== account) return;
          const current = stored !== null && stored.account === account ? stored.attempt === attempt ? stored : { account, attempt, reported: [], pending: stored.pending } : { account, attempt, reported: [], pending: [] };
          const key = step.kind === "sheet_opened" ? report.milestone : `${report.milestone}:${report.evidence_source}`;
          if (current.reported.includes(key)) return;
          if (step.kind === "access_answered" && step.answer === "unanswered" && current.reported.some((done) => done.startsWith("safari_access_answered:"))) {
            return;
          }
          await this.#write({
            ...current,
            reported: [...current.reported, key],
            pending: [...current.pending, { attempt, ...report, at: this.#ports.now(), sends: 0 }].slice(-MAX_PENDING)
          });
        });
      } catch {
      }
      await this.flush();
    }
    /** One pass over what is kept: each report goes once now. Never throws. */
    flush() {
      return this.#locked(async () => {
        const stored = await this.#read();
        if (stored === null || stored.pending.length === 0) return;
        const account = this.#ports.account();
        if (account === null) return;
        if (account !== stored.account) {
          await this.#ports.storage.remove(SETUP_MILESTONES_KEY);
          return;
        }
        const now = this.#ports.now();
        const due = stored.pending.filter((item) => item.sends < MAX_SENDS && now - item.at >= 0 && now - item.at <= PENDING_MAX_AGE_MS);
        for (const item of due) item.sends += 1;
        await this.#write({ ...stored, pending: due });
        const left = [];
        for (const item of due) {
          if (this.#ports.account() !== account) break;
          const outcome = await this.#ports.send(Object.freeze({
            attempt_id: item.attempt,
            milestone: item.milestone,
            outcome: item.outcome,
            evidence_source: item.evidence_source
          })).catch(() => "unreached");
          if (outcome === "unreached" && item.sends < MAX_SENDS) left.push(item);
        }
        if (this.#ports.account() !== account) await this.#ports.storage.remove(SETUP_MILESTONES_KEY);
        else await this.#write({ ...stored, pending: left });
      }).catch(() => void 0);
    }
    /**
     * Forgets every report and what was reported: on sign-out or a change of
     * account. It does not wait for a report on its way; that pass finds the
     * account gone and writes nothing back.
     */
    clear() {
      return this.#ports.storage.remove(SETUP_MILESTONES_KEY).catch(() => void 0);
    }
    #liveAttempt(context) {
      const id = context?.setupAttemptID;
      const expiresAt = context?.setupAttemptExpiresAt;
      const now = this.#ports.now();
      return typeof id === "string" && UUID_PATTERN8.test(id) && typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > now && expiresAt - now <= ATTEMPT_MAX_AHEAD_MS ? id.toLowerCase() : null;
    }
    #locked(work) {
      const run = this.#tail.then(work, work);
      this.#tail = run.then(() => void 0, () => void 0);
      return run;
    }
    async #read() {
      const raw = (await this.#ports.storage.get(SETUP_MILESTONES_KEY))[SETUP_MILESTONES_KEY];
      if (!isRecord24(raw) || typeof raw.account !== "string" || typeof raw.attempt !== "string" || !Array.isArray(raw.reported) || !Array.isArray(raw.pending)) {
        return null;
      }
      return {
        account: raw.account,
        attempt: raw.attempt,
        reported: raw.reported.filter((key) => typeof key === "string"),
        pending: raw.pending.filter(isPending).map((item) => ({ ...item }))
      };
    }
    #write(stored) {
      return this.#ports.storage.set({ [SETUP_MILESTONES_KEY]: stored });
    }
  };
  var SetupMilestoneApi = class {
    #fetch;
    #endpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/setup-milestones`;
    }
    /**
     * Any answer is final and reported as such, a refused credential included:
     * a report never makes the session look at its sign-in again.
     */
    async send(credential, body) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS8);
      try {
        await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
          body: JSON.stringify(body),
          signal: abort.signal
        });
        return { kind: "success", value: "answered" };
      } catch {
        return { kind: "success", value: "unreached" };
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
  };
  function sendAsSignedIn(execute, api) {
    return async (body) => {
      const result = await execute((credential) => api.send(credential, body));
      return result.kind === "published" ? result.value : "unreached";
    };
  }
  function isPending(value) {
    return isRecord24(value) && typeof value.attempt === "string" && UUID_PATTERN8.test(value.attempt) && (value.milestone === "safari_sheet_opened" || value.milestone === "safari_access_answered") && (value.outcome === "confirmed" || value.outcome === "failed" || value.outcome === "unknown") && typeof value.evidence_source === "string" && value.evidence_source.startsWith("extension_") && typeof value.at === "number" && Number.isFinite(value.at) && typeof value.sends === "number" && Number.isInteger(value.sends) && value.sends >= 0;
  }
  function isRecord24(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/extension-runtime/story-site-access.mts
  var HAND_OVER_BY_RELOADING_THE_PAGE = false;
  var STORY_SITE_SETTLE_DELAYS_MS = Object.freeze([300, 700]);
  var view = (value) => Object.freeze(value);
  var pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var StorySiteAccess = class {
    #ports;
    /** Popups with a request out. */
    #asking = /* @__PURE__ */ new Set();
    constructor(ports) {
      this.#ports = ports;
    }
    /**
     * The popup made its request. Returns the waiting state, or null when this
     * popup already has one out: a second tap changes nothing.
     */
    asking(popup) {
      if (this.#asking.has(popup)) return null;
      this.#asking.add(popup);
      return view({ state: "waiting" });
    }
    /**
     * The popup has word of its request, or looks while it waits. The outcome
     * is read, not taken from that word. A look that finds the request still
     * out and the sites not yet allowed leaves the popup waiting.
     */
    async answered(popup, ask) {
      let outcome = null;
      try {
        outcome = await this.observe(ask);
        return outcome;
      } finally {
        if (outcome?.state !== "waiting") this.#asking.delete(popup);
      }
    }
    /** A popup that closes mid-ask leaves nothing behind; the next one looks afresh. */
    closed(popup) {
      this.#asking.delete(popup);
    }
    /** What holds now. With no request made, pass nothing. */
    async observe(ask = { kind: "none" }) {
      const delays = this.#ports.settleDelaysMs ?? STORY_SITE_SETTLE_DELAYS_MS;
      let reading = await this.#ports.access().catch(() => null);
      if (ask.kind === "returned" && ask.value === true) {
        for (const delay of delays) {
          if (reading?.complete === true) break;
          await pause(delay);
          reading = await this.#ports.access().catch(() => null);
        }
      }
      if (reading?.complete === true) {
        let registered = await this.#ports.registered().catch(() => null);
        if (registered !== true && ask.kind !== "waiting") {
          if (this.#ports.registrationSettled) {
            await this.#ports.registrationSettled().catch(() => false);
            registered = await this.#ports.registered().catch(() => null);
          }
          for (const delay of delays) {
            if (registered === true) break;
            await pause(delay);
            registered = await this.#ports.registered().catch(() => null);
          }
        }
        if (registered === false) return view({ state: "registration_failed" });
        if (registered !== true) return view({ state: "registration_unknown" });
        const [account, automaticSaving] = await Promise.all([
          this.#ports.account().then(
            ({ state }) => state === "verified" ? "connected" : state,
            () => "unknown"
          ),
          this.#ports.automaticSaving().catch(() => "unknown"),
          this.#ports.handOver().catch(() => void 0)
        ]);
        return view({
          state: "allowed",
          account,
          automaticSaving,
          handOver: HAND_OVER_BY_RELOADING_THE_PAGE ? "reload" : "in_place"
        });
      }
      if (reading !== null && reading.granted > 0) {
        return view({ state: "partial", granted: reading.granted, total: reading.total });
      }
      if (ask.kind === "waiting") return view({ state: "waiting" });
      if (ask.kind === "threw") {
        return view({ state: "could_not_ask", automaticSaving: await this.#automaticSaving() });
      }
      if (reading === null) return view({ state: "not_known" });
      if (ask.kind === "none") return view({ state: "not_asked" });
      if (ask.kind === "unanswered") return view({ state: "not_known" });
      if (ask.value !== false) return view({ state: "not_known" });
      return view({ state: "not_allowed", automaticSaving: await this.#automaticSaving() });
    }
    #automaticSaving() {
      return this.#ports.automaticSaving().catch(() => "unknown");
    }
  };

  // src/extension-runtime/first-tap-runtime.mts
  var FIRST_TAP_PAGE_FILES = Object.freeze([
    "page-manual-mode.js",
    "content-config.js",
    "trace-finish-qualify.js",
    "collector.js"
  ]);
  var hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  function installFirstTapSave(environment) {
    const { runtime, tabs, permissions, scripting, storage, mode, origins, session } = environment;
    const cryptography = environment.crypto ?? globalThis.crypto;
    const call = (target, method, args) => extensionCall(target, method, args, runtime, mode);
    const grantComplete = async () => {
      if (origins.length === 0 || typeof permissions.contains !== "function") return null;
      try {
        const answer = await call(permissions, "contains", [{ origins: [...origins] }]);
        return typeof answer === "boolean" ? answer : null;
      } catch {
        return null;
      }
    };
    const registered = async () => {
      try {
        const current = await call(scripting, "getRegisteredContentScripts", []);
        const ids = new Set(current.map(({ id }) => id));
        return environment.registrationIds.every((id) => ids.has(id));
      } catch {
        return null;
      }
    };
    const access = async () => {
      const [complete, listed] = await Promise.all([
        grantComplete(),
        typeof permissions.getAll !== "function" ? Promise.resolve(null) : call(permissions, "getAll", []).then(
          (all) => Array.isArray(all?.origins) ? new Set(all.origins) : null,
          () => null
        )
      ]);
      if (complete === null && listed === null) return null;
      const granted = listed === null ? 0 : origins.filter((origin) => listed.has(origin)).length;
      return Object.freeze({
        complete: origins.length > 0 && (complete ?? granted === origins.length),
        granted,
        total: origins.length
      });
    };
    const account = async () => {
      const read = await session.accountForThisOpen();
      if (read.state !== "verified") return read;
      const owner = session.snapshot().accountId;
      return typeof owner === "string" && owner.length > 0 && session.pageBinding() === read.binding ? Object.freeze({ state: "verified", binding: read.binding, owner }) : Object.freeze({ state: "unknown" });
    };
    const membershipApi = new StoryMembershipApi(environment.fetch, environment.apiBase);
    const firstTap = new FirstTapSave({
      saveOnOpen: environment.saveOnOpen === true,
      grantComplete,
      account,
      binding: () => session.pageBinding(),
      automaticSaving: () => session.automaticSaving(),
      async inject(tabId) {
        if (typeof scripting.executeScript !== "function") return false;
        await call(scripting, "executeScript", [{
          target: { tabId, frameIds: [0] },
          files: [...FIRST_TAP_PAGE_FILES]
        }]);
        return true;
      },
      collect: (tabId) => call(tabs, "sendMessage", [tabId, { type: FIRST_TAP_COLLECT_MESSAGE }, { frameId: 0 }]),
      save: (command, observer, tabId) => session.saveStoryWithEvidence(command, observer, tabId),
      presence: (workKey) => session.storyPresence(workKey),
      membership: (workKey) => readStoryMembership(session, membershipApi, workKey),
      async mark(tabId, workKey) {
        await call(tabs, "sendMessage", [tabId, { type: FIRST_TAP_MARK_MESSAGE, workKey }, { frameId: 0 }]);
      },
      async readStore() {
        return (await storage.get(FIRST_TAP_STORE_KEY))[FIRST_TAP_STORE_KEY];
      },
      async writeStore(value) {
        await storage.set({ [FIRST_TAP_STORE_KEY]: value });
      },
      async digest(text2) {
        const bytes = await cryptography.subtle.digest("SHA-256", new TextEncoder().encode(text2));
        return hex(new Uint8Array(bytes)).slice(0, 32);
      },
      randomSalt: () => hex(cryptography.getRandomValues(new Uint8Array(16))),
      now: environment.now ?? (() => Date.now())
    });
    session.attachStoryAdmission({
      async modeFor(tabId, workKey) {
        const [grant, scripts] = await Promise.all([grantComplete(), registered()]);
        return storySaveModeAtAdmission({
          injectedForFirstTap: firstTap.injectedFor(tabId, workKey),
          grantComplete: grant,
          registered: scripts
        });
      },
      pageSaveAdmitted: (_tabId, workKey) => firstTap.pageSaveAdmitted(workKey)
    });
    const savesByItself = async () => {
      const [grant, scripts] = await Promise.all([grantComplete(), registered()]);
      return grant === true && scripts === true;
    };
    const handOver = async () => {
      if (!await savesByItself()) return;
      const ids = new Set(firstTap.injectedTabs());
      const storySites = origins.filter(isStorySitePattern);
      if (storySites.length > 0) {
        const open = await call(tabs, "query", [{ url: storySites }]).catch(
          () => []
        );
        for (const tab of open) {
          if (typeof tab.id === "number" && Number.isInteger(tab.id)) ids.add(tab.id);
        }
      }
      await Promise.all([...ids].map((tabId) => call(tabs, "sendMessage", [
        tabId,
        { type: FIRST_TAP_MANUAL_MODE_END_MESSAGE, reload: HAND_OVER_BY_RELOADING_THE_PAGE },
        { frameId: 0 }
      ]).catch(() => void 0)));
    };
    const setupMilestones = environment.setupAttempt === void 0 ? null : new SetupMilestoneReporter({
      account: () => session.publicationScope()?.accountId ?? null,
      attempt: environment.setupAttempt,
      send: sendAsSignedIn(
        (effect) => session.executeAuthenticated(effect),
        new SetupMilestoneApi(environment.fetch, environment.apiBase)
      ),
      storage: {
        get: (key) => storage.get(key),
        set: (patch) => storage.set(patch),
        remove: (key) => storage.remove(key)
      },
      now: environment.now ?? (() => Date.now())
    });
    if (setupMilestones !== null) session.whenAccountLeaves?.(() => setupMilestones.clear());
    const setupStep = (step) => {
      if (setupMilestones === null) return;
      void account().then(
        (read) => read.state === "verified" ? setupMilestones.record(step) : void 0
      ).catch(() => void 0);
    };
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== SETUP_STEP_MESSAGE) return false;
      const step = sender?.id === runtime.id && isPopupSender(sender, runtime.id) ? setupStepFromMessage(message) : null;
      if (step !== null) setupStep(step);
      sendResponse({ ok: step !== null });
      return false;
    });
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== FIRST_TAP_MANUAL_MODE_QUERY_MESSAGE) return false;
      if (sender?.id !== runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== void 0 && sender.frameId !== 0) {
        sendResponse({ ok: false });
        return false;
      }
      void savesByItself().then(
        (ready) => sendResponse({ ok: true, manual: !ready, reload: ready && HAND_OVER_BY_RELOADING_THE_PAGE }),
        () => sendResponse({ ok: true, manual: true, reload: false })
      );
      return true;
    });
    const siteAccess = new StorySiteAccess({
      access,
      registered,
      account,
      automaticSaving: () => session.automaticSaving(),
      handOver,
      ...environment.registrationSettled ? { registrationSettled: environment.registrationSettled } : {},
      ...environment.accessSettleDelaysMs ? { settleDelaysMs: environment.accessSettleDelaysMs } : {}
    });
    runtime.onConnect?.addListener((port) => {
      if (port.name !== FIRST_TAP_POPUP_PORT || !port.sender || port.sender.id !== runtime.id || port.sender.tab !== void 0 && port.sender.tab !== null || !isPopupSender(port.sender, runtime.id) || port.sender.frameId !== void 0 && port.sender.frameId !== 0) {
        return;
      }
      let open = true;
      let tapped = null;
      const post = (message) => {
        if (!open) return;
        try {
          port.postMessage(message);
        } catch {
        }
      };
      const show = (view2) => post({ view: view2 });
      port.onDisconnect.addListener(() => {
        open = false;
        siteAccess.closed(show);
        firstTap.closed(show);
      });
      port.onMessage.addListener((message) => {
        const request = typeof message === "object" && message !== null ? message : {};
        const answered = Number.isSafeInteger(request.look) ? { answered: request.look } : {};
        const order = Number.isSafeInteger(request.order) ? { order: request.order } : {};
        if (tapped === null && Number.isInteger(request.tabId) && typeof request.url === "string") {
          tapped = Object.freeze({
            tabId: request.tabId,
            url: request.url,
            private: typeof request.private === "boolean" ? request.private : null
          });
        }
        if (tapped === null) return;
        if (request.command === "access_asking") {
          const waiting = siteAccess.asking(show);
          if (waiting !== null) post({ access: waiting, ...order });
          return;
        }
        const ask = (
          // A look with no request made, for a popup that shows a state of the ask.
          request.command === "access_check" ? { kind: "none" } : request.command === "access_waiting" ? { kind: "waiting" } : request.command === "access_unanswered" ? { kind: "unanswered" } : request.command !== "access_answered" ? null : request.threw === true ? { kind: "threw" } : { kind: "returned", value: request.returned }
        );
        if (ask !== null) {
          if (request.command === "access_answered" && order.order !== void 0) post({ checking: order.order });
          const resolves = request.command === "access_answered" || request.command === "access_unanswered";
          void siteAccess.answered(show, ask).then(
            (access2) => {
              post({ access: access2, ...answered, ...order });
              const answer = resolves || request.command === "access_waiting" && access2.state === "allowed" ? safariAccessAnswer(access2) : null;
              if (answer !== null) setupStep({ kind: "access_answered", answer });
            },
            () => post({ access: Object.freeze({ state: "not_known" }), ...answered, ...order })
          );
          return;
        }
        const work = request.command === "open" ? firstTap.opened(show, tapped) : request.command === "save" ? firstTap.opened(show, tapped, { requested: true }) : request.command === "check" ? firstTap.check(show) : null;
        if (work === null) return;
        void work.then(
          async (view2) => {
            if (view2.state !== "automatic") return post({ view: view2, ...answered });
            const allowed = await siteAccess.observe().catch(
              () => Object.freeze({ state: "not_known" })
            );
            post({ view: view2, access: allowed, ...answered, ...order });
          },
          () => post({ view: Object.freeze({ state: "not_applicable" }), ...answered })
        ).then(() => {
          if (!open) firstTap.closed(show);
        });
      });
    });
    void handOver().catch(() => void 0);
    return handOver;
  }

  // src/extension-runtime/safari-readiness-report.mts
  var SAFARI_READINESS_MESSAGES = Object.freeze({
    /** Which provider does the app hold, and which cycle has it open? */
    prepare: "TRACE_IOS_SAFARI_READINESS_PREPARE",
    /** One report, bound to that provider and that cycle. */
    report: "TRACE_IOS_SAFARI_READINESS_REPORT"
  });
  var SAFARI_READINESS_SESSION_KEY = "traceSafariReadinessSessionV1";
  var NATIVE_TIMEOUT_MS = 2e3;
  var BROWSER_READ_TIMEOUT_MS = 2e3;
  function isRecord25(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function bounded2(work, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        }
      );
    });
  }
  function installSafariReadinessReport(environment) {
    const { runtime, permissions, scripting, storage, storageMode, apiOrigin, config } = environment;
    const now = environment.now ?? (() => Date.now());
    const call = (target, method, args) => extensionCall(target, method, args, runtime, storageMode);
    const beside = runsBesideTraceApp(
      runtime,
      storageMode,
      environment.platform?.userAgent ?? globalThis.navigator?.userAgent ?? ""
    );
    if (beside === false) {
      return Object.freeze({
        report: async () => ({ kind: "no_provider" }),
        registrationEnded() {
        },
        preferenceChanged() {
        },
        accountMayHaveChanged() {
        }
      });
    }
    const supported = Promise.resolve(beside);
    let lastRegistration;
    let lastScriptReason = null;
    const wait = environment.wait ?? ((ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }));
    const websiteAccess = async () => {
      if (config.origins.length === 0) return { complete: null, granted: null };
      const [complete, listed] = await Promise.all([
        typeof permissions.contains !== "function" ? Promise.resolve(null) : bounded2(call(permissions, "contains", [{ origins: [...config.origins] }]), BROWSER_READ_TIMEOUT_MS),
        bounded2(call(permissions, "getAll", []), BROWSER_READ_TIMEOUT_MS)
      ]);
      const origins = isRecord25(listed) && Array.isArray(listed.origins) ? new Set(listed.origins) : null;
      const granted = origins === null ? null : config.origins.filter((origin) => origins.has(origin)).length;
      return {
        // The browser's own answer where it gives one: a broader grant need not
        // list the story sites by name.
        complete: typeof complete === "boolean" ? complete : granted === null ? null : granted === config.origins.length,
        granted
      };
    };
    const readScripts = async () => {
      if (scripting === void 0) return "absent";
      const [current, stored] = await Promise.all([
        bounded2(call(scripting, "getRegisteredContentScripts", []), BROWSER_READ_TIMEOUT_MS),
        bounded2(storage.get(EARNED_PERMISSION_STATE_KEY), BROWSER_READ_TIMEOUT_MS)
      ]);
      if (!Array.isArray(current) || stored === null) return "unreadable";
      const ids = new Set(current.map((script) => isRecord25(script) ? script.id : void 0));
      const state = stored[EARNED_PERMISSION_STATE_KEY];
      const generation = isRecord25(state) ? state.registrationVersion : void 0;
      return config.registrations.every(({ id }) => ids.has(id)) && generation === config.version ? "registered" : "absent";
    };
    const readScriptRegistration = async () => {
      if (config.registrationMode === "static") {
        const declared = runtime.getManifest?.().content_scripts;
        return Array.isArray(declared) && declared.length > 0 ? "declared" : "not_registered";
      }
      if (scripting === void 0) return "registration_failed";
      const registration = environment.registration;
      const underWay = () => registration?.pending() === true;
      if (registration !== void 0) {
        const settled = await bounded2(registration.idle().then(() => true), environment.settleLimitMs ?? 6e3);
        if (settled !== true || underWay()) return "pending";
      }
      const first = await readScripts();
      if (first !== "absent") return first;
      if (underWay()) return "pending";
      if (lastRegistration != null && !lastRegistration.registered) {
        return lastRegistration.error === "registration_failed" ? "registration_failed" : "not_registered";
      }
      await wait(ARCHIVE_ACCESS_CONFIRM_DELAY_MS);
      if (underWay()) return "pending";
      const second = await readScripts();
      if (second === "registered") return "registered";
      if (underWay()) return "pending";
      return second === "absent" ? "not_registered" : "unconfirmed";
    };
    const scriptRegistration = async () => {
      const reason = await readScriptRegistration();
      lastScriptReason = reason;
      return reason;
    };
    const allowedBeforeUpdate = async () => {
      if (config.registrationMode !== "dynamic") return false;
      const stored = await bounded2(storage.get(EARNED_PERMISSION_STATE_KEY), BROWSER_READ_TIMEOUT_MS);
      const state = stored?.[EARNED_PERMISSION_STATE_KEY];
      if (!isRecord25(state) || state.promptResult !== "granted") return false;
      const generation = state.registrationVersion;
      return Number.isInteger(generation) && Number(generation) > 0 && Number(generation) < config.version;
    };
    const account = async () => {
      const session = environment.session();
      if (session === void 0) return { state: "pending" };
      const read = await session.accountForThisOpen();
      if (read.state === "verified") {
        const accountId = session.snapshot().accountId;
        return typeof accountId === "string" && accountId.length > 0 && session.pageBinding() === read.binding ? { state: "connected", session: read.binding, accountId } : { state: "changed" };
      }
      if (read.state === "missing") return { state: "no_account" };
      if (read.state === "reconnect_required") return { state: "reconnect_required" };
      const state = session.snapshot().state;
      return {
        state: state === "initializing" || state === "connecting" || state === "verifying" ? "pending" : "unreachable"
      };
    };
    const prepare = async () => {
      const response = await sendNativeMessageWithFallback(
        runtime,
        storageMode,
        { type: SAFARI_READINESS_MESSAGES.prepare, apiOrigin },
        NATIVE_TIMEOUT_MS
      );
      if (!isRecord25(response) || response.ok !== true || !isRecord25(response.provider)) return null;
      const cycle = isRecord25(response.cycle) && typeof response.cycle.id === "string" ? {
        id: response.cycle.id,
        accountId: typeof response.cycle.accountID === "string" ? response.cycle.accountID : null
      } : null;
      return { provider: response.provider, cycle };
    };
    const deliver = async (report2, preparation) => {
      const response = await sendNativeMessageWithFallback(runtime, storageMode, {
        type: SAFARI_READINESS_MESSAGES.report,
        version: report2.version,
        apiOrigin,
        provider: preparation.provider,
        ...preparation.cycle === null ? {} : { cycleID: preparation.cycle.id },
        ...report2.accountId === void 0 ? {} : { accountID: report2.accountId },
        observedAt: report2.observedAt,
        result: report2.result,
        components: report2.components
      }, NATIVE_TIMEOUT_MS);
      if (isRecord25(response) && response.ok === true) return "stored";
      return isRecord25(response) && response.error === "stale_cycle" ? "stale_cycle" : "refused";
    };
    const service = new SafariReadinessService({
      prepare,
      deliver,
      websiteAccess,
      allowedBeforeUpdate,
      scriptRegistration,
      account,
      session: () => environment.session()?.pageBinding() ?? null,
      automaticSaving: async () => await environment.session()?.automaticSaving() ?? "unknown",
      wait,
      now
    });
    const report = async () => await supported ? service.report() : { kind: "no_provider" };
    const reportQuietly = () => {
      void report().catch(() => void 0);
    };
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord25(message) || message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.accessReport || Object.keys(message).length !== 1 || !isPopupSender(sender, runtime.id)) {
        return false;
      }
      void report().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
      return true;
    });
    runtime.onInstalled?.addListener((details) => {
      if (details?.reason !== "update") return;
      void allowedBeforeUpdate().then((before) => {
        if (before) reportQuietly();
      }, () => void 0);
    });
    permissions.onAdded?.addListener(reportQuietly);
    permissions.onRemoved?.addListener(reportQuietly);
    environment.alarms?.onAlarm?.addListener((alarm) => {
      if (alarm?.name === ARCHIVE_ACCESS_REPORT_ALARM) reportQuietly();
    });
    let lastSession;
    return Object.freeze({
      report,
      registrationEnded(result) {
        const failed2 = result !== null && result.error === "registration_failed";
        const failedBefore = lastRegistration != null && lastRegistration.error === "registration_failed";
        lastRegistration = result;
        if (result !== null && result.changed || failed2 || failed2 !== failedBefore || lastScriptReason === "pending") {
          reportQuietly();
        }
      },
      preferenceChanged: reportQuietly,
      accountMayHaveChanged() {
        const session = environment.session();
        if (session === void 0) return;
        const state = session.snapshot().state;
        if (state === "initializing" || state === "connecting" || state === "verifying") return;
        const token = session.pageBinding() ?? "";
        if (token === lastSession) return;
        lastSession = token;
        void (async () => {
          if (!await supported) return;
          const stored = await storage.get(SAFARI_READINESS_SESSION_KEY);
          if (stored[SAFARI_READINESS_SESSION_KEY] === token) return;
          await storage.set({ [SAFARI_READINESS_SESSION_KEY]: token });
          await report();
        })().catch(() => void 0);
      }
    });
  }

  // src/extension-runtime/story-tab-reuse.mts
  var STORY_TAB_REUSE_MESSAGE = "TRACE_STORY_TAB_REUSE";
  var STEP_TIMEOUT_MS = 2e3;
  var ACT_WITHIN_MS = 5e3;
  var RECENT_ASKER_MS = 3e4;
  function storyTabKey(raw) {
    if (typeof raw !== "string" || raw.length > 4096) return null;
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
    } catch {
      return null;
    }
  }
  function isWholeStoryLink(raw) {
    const key = storyTabKey(raw);
    if (key === null) return false;
    if (key.startsWith("ao3:")) return key.endsWith(":work");
    return /^\/s\/[1-9]\d{0,19}\/?$/.test(new URL(raw).pathname);
  }
  function storyOf(key) {
    return key.slice(0, key.lastIndexOf(":"));
  }
  function isRecord26(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  async function bounded3(operation, milliseconds) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      })]);
    } catch {
      return null;
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  var NOTHING = Object.freeze({ ok: true, reused: false, closed: false });
  var REFUSED = Object.freeze({ ok: false, reused: false, closed: false });
  function installStoryTabReuse(environment) {
    const { runtime, tabs, permissions, mode } = environment;
    const now = environment.now ?? (() => Date.now());
    const call = (target, method, args) => extensionCall(
      target,
      method,
      args,
      runtime,
      mode
    );
    const recent = /* @__PURE__ */ new Map();
    let queue = Promise.resolve();
    const reuse = async (senderTabId, key, anyPlace, deadline) => {
      if (!permissions) return NOTHING;
      const grants = await bounded3(call(permissions, "getAll", []), STEP_TIMEOUT_MS);
      const storySites = (grants?.origins ?? []).filter(isStorySitePattern);
      if (!storySites.length) return NOTHING;
      const open = await bounded3(call(tabs, "query", [{ url: storySites }]), STEP_TIMEOUT_MS);
      if (!Array.isArray(open)) return NOTHING;
      const story = storyOf(key);
      const matches2 = (tabKey) => tabKey !== null && (anyPlace ? storyOf(tabKey) === story : tabKey === key);
      const existing = open.filter((tab) => Number.isInteger(tab.id) && tab.id !== senderTabId && tab.incognito !== true && !recent.has(tab.id) && matches2(storyTabKey(tab.url))).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
      if (!existing || !tabs.update || now() > deadline) return NOTHING;
      const shown = await bounded3(call(tabs, "update", [existing.id, { active: true }]).then(() => true), STEP_TIMEOUT_MS);
      if (shown !== true) return NOTHING;
      const closed = tabs.remove && now() <= deadline ? await bounded3(call(tabs, "remove", [senderTabId]).then(() => true), STEP_TIMEOUT_MS) === true : false;
      return Object.freeze({ ok: true, reused: true, closed });
    };
    const handle = async (message, sender) => {
      if (!isRecord26(message) || Object.keys(message).length !== 2 || message.type !== STORY_TAB_REUSE_MESSAGE || !isRecord26(message.payload) || Object.keys(message.payload).length !== 1) return REFUSED;
      if (!sender) return REFUSED;
      const tabId = sender.tab?.id;
      if (sender.id !== runtime.id || !Number.isInteger(tabId) || sender.frameId !== void 0 && sender.frameId !== 0 || archiveHostKindFromSender(sender) === null) return REFUSED;
      const key = storyTabKey(sender.tab?.url ?? sender.url);
      if (key === null || storyTabKey(message.payload.url) !== key) return REFUSED;
      const at = now();
      for (const [id, asked] of recent) if (at - asked > RECENT_ASKER_MS) recent.delete(id);
      if (recent.has(tabId)) return NOTHING;
      recent.set(tabId, at);
      const deadline = at + ACT_WITHIN_MS;
      const anyPlace = isWholeStoryLink(message.payload.url);
      const turn = queue.then(() => reuse(tabId, key, anyPlace, deadline)).catch(() => NOTHING);
      queue = turn;
      return turn;
    };
    runtime.onMessage.addListener((message, sender, respond) => {
      if (!isRecord26(message) || message.type !== STORY_TAB_REUSE_MESSAGE) return;
      void handle(message, sender).then(respond, () => respond(NOTHING));
      return true;
    });
    return handle;
  }

  // src/extension-runtime/web-history-handoff.mts
  var WEB_HISTORY_LIFETIME_MS = 18e5;
  var WEB_HISTORY_REQUEST = "TRACE_WEB_HISTORY_REQUEST";
  var WEB_HISTORY_RECEIVED = "TRACE_WEB_HISTORY_RECEIVED";
  var UUID3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var KEEP_KEY = "traceWebHistoryOfferV1";
  var record3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  function offerRecord(value) {
    if (!record3(value) || value.v !== 1 || typeof value.handoffID !== "string" || !UUID3.test(value.handoffID) || typeof value.accountId !== "string" || !value.accountId || typeof value.capturedAt !== "string" || typeof value.sha256 !== "string" || typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs)) return null;
    return value;
  }
  function capturedAtOf(history) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(history.parts[0]));
      return record3(parsed) && typeof parsed.at === "string" ? parsed.at : null;
    } catch {
      return null;
    }
  }
  var WebHistoryHandoff = class {
    #webOrigin;
    #randomID;
    #now;
    #keep;
    /** Makes the parts again from the History store, for when they were read. */
    #source = null;
    #offered = null;
    /** The parts of `#offered`, by its id: never another offer's. */
    #parts = null;
    /** Reading the kept offer after a restart, once; an offer or discard meanwhile wins. */
    #loading = null;
    #rebuilding = null;
    /** Bumped by every offer and discard: work begun before one never lands after it. */
    #generation = 0;
    constructor(options) {
      this.#webOrigin = new URL(options.webOrigin).origin;
      this.#randomID = options.randomID;
      this.#now = options.now ?? Date.now;
      this.#keep = options.keep ?? null;
    }
    /** The History store the parts are made from, after a restart. */
    useSource(source) {
      this.#source = source;
    }
    /** The review page for a handoff. The id rides in the fragment, never to a server. */
    reviewUrl(handoffID) {
      return `${this.#webOrigin}/import/history#handoff=${handoffID}`;
    }
    /** Makes `history` the one History on offer, for `accountId`, replacing any earlier one. */
    async offer(accountId, history) {
      const handoffID = this.#randomID();
      const now = this.#now();
      const capturedAt = history.parts.length ? capturedAtOf(history) : null;
      if (!accountId || !UUID3.test(handoffID) || !Number.isSafeInteger(now) || capturedAt === null) {
        return Object.freeze({ ok: false, error: "history_handoff_unavailable" });
      }
      const offered = {
        v: 1,
        handoffID,
        accountId,
        expiresAtMs: now + WEB_HISTORY_LIFETIME_MS,
        capturedAt,
        sha256: history.sha256
      };
      this.#generation += 1;
      this.#offered = offered;
      this.#parts = { handoffID, history };
      this.#rebuilding = null;
      await this.#keep?.save(offered).catch(() => void 0);
      return Object.freeze({
        ok: true,
        state: "opened_on_web",
        handoffID,
        expiresAtMs: offered.expiresAtMs,
        url: this.reviewUrl(handoffID)
      });
    }
    /** Forgets the History on offer (its account left, or the reader deleted it). */
    async discard() {
      this.#generation += 1;
      this.#offered = null;
      this.#parts = null;
      this.#rebuilding = null;
      await this.#keep?.clear().catch(() => void 0);
    }
    /**
     * Answers a Trace page's request. `currentAccountId` is the account signed
     * in to the extension now, or null while it isn't connected; a History
     * started by another account is never given out.
     */
    async answer(message, currentAccountId) {
      if (!record3(message) || typeof message.handoffID !== "string" || !UUID3.test(message.handoffID)) {
        return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
      }
      this.#loading ??= this.#load();
      await this.#loading;
      const offered = this.#offered;
      if (offered === null || offered.handoffID !== message.handoffID) {
        return Object.freeze({ ok: false, error: "history_handoff_unknown" });
      }
      if (this.#now() >= offered.expiresAtMs) {
        await this.discard();
        return Object.freeze({ ok: false, error: "history_handoff_expired" });
      }
      if (currentAccountId === null) return Object.freeze({ ok: false, error: "history_handoff_not_connected" });
      if (currentAccountId !== offered.accountId) {
        return Object.freeze({ ok: false, error: "history_handoff_account_changed" });
      }
      if (message.type === WEB_HISTORY_RECEIVED) {
        await this.discard();
        return Object.freeze({ ok: true, kind: "received" });
      }
      if (message.type !== WEB_HISTORY_REQUEST) return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
      const history = await this.#history(offered);
      if (history === null || this.#offered?.handoffID !== offered.handoffID) {
        return Object.freeze({ ok: false, error: "history_handoff_unknown" });
      }
      if (message.part === "declaration") {
        return Object.freeze({
          ok: true,
          kind: "declaration",
          handoffID: offered.handoffID,
          accountId: offered.accountId,
          partCount: history.parts.length,
          byteCount: history.byteCount,
          itemCount: history.itemCount,
          sha256: history.sha256,
          expiresAtMs: offered.expiresAtMs
        });
      }
      const partIndex = message.part;
      if (typeof partIndex !== "number" || !Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= history.parts.length) {
        return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
      }
      return Object.freeze({
        ok: true,
        kind: "part",
        handoffID: offered.handoffID,
        partIndex,
        text: new TextDecoder().decode(history.parts[partIndex])
      });
    }
    /** The offer kept before a restart, unless an offer or discard came first. */
    async #load() {
      const generation = this.#generation;
      const kept = offerRecord(await this.#keep?.load().catch(() => null));
      if (generation === this.#generation && this.#offered === null) this.#offered = kept;
    }
    /**
     * The parts on offer, made again after a restart (once, shared by every
     * request while it runs); null when the works have changed since.
     */
    async #history(offered) {
      if (this.#parts?.handoffID === offered.handoffID) return this.#parts.history;
      const source = this.#source;
      if (source === null) return null;
      if (this.#rebuilding?.handoffID !== offered.handoffID) {
        this.#rebuilding = { handoffID: offered.handoffID, history: source(offered.capturedAt).catch(() => null) };
      }
      const generation = this.#generation;
      const rebuilt = await this.#rebuilding.history;
      if (rebuilt === null || rebuilt.sha256 !== offered.sha256) return null;
      if (generation === this.#generation && this.#offered?.handoffID === offered.handoffID) {
        this.#parts = { handoffID: offered.handoffID, history: rebuilt };
      }
      return rebuilt;
    }
  };
  function sessionKeep(area) {
    return {
      load: async () => (await area.get(KEEP_KEY))[KEEP_KEY] ?? null,
      save: (value) => area.set({ [KEEP_KEY]: value }),
      clear: () => area.remove(KEEP_KEY)
    };
  }

  // src/extension-runtime/ao3-history-page.mts
  var AO3_HISTORY_ORIGIN = "https://archiveofourown.org";
  var MAX_HISTORY_PAGE_CHARS = 2097152;
  var AO3_USERNAME_PATTERN = /^[A-Za-z0-9_]{1,40}$/;
  var ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "\u2026",
    mdash: "\u2014",
    ndash: "\u2013",
    lsquo: "\u2018",
    rsquo: "\u2019",
    ldquo: "\u201C",
    rdquo: "\u201D"
  };
  function decodeEntities2(text2) {
    return text2.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
        return Number.isSafeInteger(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    });
  }
  function plainText2(markup, max = 4e3) {
    return decodeEntities2(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, max);
  }
  function classTokens2(startTag) {
    const value = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(startTag);
    return (value?.[1] ?? value?.[2] ?? "").split(/\s+/).filter(Boolean);
  }
  function elements(html, tag, tokens, limit = 50) {
    const out = [];
    const start = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    const end = new RegExp(`</${tag}\\s*>`, "i");
    for (let match = start.exec(html); match !== null && out.length < limit; match = start.exec(html)) {
      const classes = classTokens2(match[0]);
      if (!tokens.every((token) => classes.includes(token))) continue;
      const from = match.index + match[0].length;
      const close = end.exec(html.slice(from));
      if (close === null) break;
      out.push(html.slice(from, from + close.index));
    }
    return out;
  }
  function anchorTexts(html, test, limit) {
    const out = [];
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    for (let match = anchor.exec(html); match !== null && out.length < limit; match = anchor.exec(html)) {
      if (!test(`<a ${match[1] ?? ""}>`)) continue;
      const text2 = plainText2(match[2] ?? "", 300);
      if (text2 && !out.includes(text2)) out.push(text2);
    }
    return out;
  }
  function attribute(startTag, name) {
    const value = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(startTag);
    return value === null ? null : decodeEntities2(value[1] ?? value[2] ?? "");
  }
  function wholeNumber(text2) {
    const trimmed = text2.trim();
    if (!/^(?:[1-9]\d{0,2}(?:,\d{3})+|\d{1,12})$/.test(trimmed)) return null;
    const value = Number(trimmed.replaceAll(",", ""));
    return Number.isSafeInteger(value) ? value : null;
  }
  var MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  };
  function historyDay(text2) {
    const match = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(text2.trim());
    if (match === null) return null;
    const day = Number(match[1]);
    const month = MONTHS[match[2].toLowerCase()];
    const year = Number(match[3]);
    if (month === void 0 || year < 2e3) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  function readRow(row, startTag) {
    const classes = classTokens2(startTag);
    if (classes.includes("deleted")) return "deleted";
    const id = /\bid\s*=\s*["']work_([1-9]\d{0,11})["']/i.exec(startTag)?.[1];
    if (id === void 0) return "unreadable";
    const heading = elements(row, "h4", ["heading"], 1)[0];
    if (heading === void 0) return "unreadable";
    const titleLink = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(heading);
    const href = titleLink ? attribute(`<a ${titleLink[1] ?? ""}>`, "href") : null;
    const title = titleLink ? plainText2(titleLink[2] ?? "", 500) : "";
    if (href === null || !new RegExp(`^(?:https://archiveofourown\\.org)?/works/${id}(?:[/?#]|$)`).test(href) || !title) {
      return "unreadable";
    }
    const viewed = plainText2(elements(row, "h4", ["viewed"], 1)[0] ?? "", 500);
    const later = /\(Marked for Later\.\)/i.test(viewed);
    const visited = later ? null : /Last visited:\s*(\d{1,2} [A-Z][a-z]{2} \d{4})/.exec(viewed)?.[1] ?? null;
    const visits = later ? null : /\bVisited once\b/i.test(viewed) ? 1 : wholeNumber(/\bVisited\s+([\d,]+)\s+times?\b/i.exec(viewed)?.[1] ?? "");
    const words = wholeNumber(plainText2(elements(row, "dd", ["words"], 1)[0] ?? "", 40));
    const chapters = plainText2(elements(row, "dd", ["chapters"], 1)[0] ?? "", 40).replace(/\s+/g, "");
    return {
      id,
      title,
      authors: anchorTexts(heading, (tag) => attribute(tag, "rel") === "author", 20),
      fandoms: anchorTexts(elements(row, "h5", ["fandoms"], 1)[0] ?? "", (tag) => classTokens2(tag).includes("tag"), 20),
      tags: anchorTexts(elements(row, "ul", ["tags", "commas"], 1)[0] ?? "", (tag) => classTokens2(tag).includes("tag"), 75),
      summary: plainText2(elements(row, "blockquote", ["summary"], 1)[0] ?? "", 4e3),
      words,
      chapters: /^\d+\/(?:\d+|\?)$/.test(chapters) ? chapters : null,
      lastVisited: visited === null ? null : historyDay(visited),
      visits: visits !== null && visits > 0 ? visits : null,
      later
    };
  }
  function historyPageURL(user, page) {
    if (!AO3_USERNAME_PATTERN.test(user) || !Number.isSafeInteger(page) || page < 1) throw new Error("invalid history page");
    return `${AO3_HISTORY_ORIGIN}/users/${user}/readings${page === 1 ? "" : `?page=${page}`}`;
  }
  function historyPageNumber(href, user) {
    let url;
    try {
      url = new URL(href, AO3_HISTORY_ORIGIN);
    } catch {
      return null;
    }
    if (url.origin !== AO3_HISTORY_ORIGIN || url.username || url.password || url.hash) return null;
    if (url.pathname.replace(/\/$/, "").toLowerCase() !== `/users/${user}/readings`.toLowerCase()) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== "page") || url.searchParams.getAll("page").length > 1) return null;
    const raw = url.searchParams.get("page");
    if (raw === null) return 1;
    return /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : null;
  }
  var LOGIN_MARKERS = /<form\b[^>]*\baction\s*=\s*["'][^"']*\/users\/login\b|<body\b[^>]*\bclass\s*=\s*["'][^"']*\blogged-out\b/i;
  function readHistoryPage(html, user, page) {
    if (typeof html !== "string") return { kind: "stop", code: "unrecognized_page" };
    if (isChallengePage(html)) return { kind: "stop", code: "challenge" };
    const main = /<div\b[^>]*\bid\s*=\s*["']main["'][^>]*>/i.exec(html);
    if (main === null || !classTokens2(main[0]).includes("readings-index")) {
      return { kind: "stop", code: LOGIN_MARKERS.test(html) ? "signed_out" : "unrecognized_page" };
    }
    const whole = html.slice(main.index);
    const footer = whole.search(/<div\b[^>]*\bid\s*=\s*["']footer["']/i);
    if (footer <= 0) return { kind: "incomplete" };
    const after = whole.slice(0, footer);
    let list = "";
    const listTag = /<ol\b[^>]*>/gi;
    for (let match = listTag.exec(after); match !== null; match = listTag.exec(after)) {
      const classes = classTokens2(match[0]);
      if (!classes.includes("reading") || !classes.includes("index")) continue;
      const rest = after.slice(match.index + match[0].length);
      const end = rest.search(/<ol\b[^>]*\bclass\s*=\s*["'][^"']*\bpagination\b/i);
      list = end >= 0 ? rest.slice(0, end) : rest;
      break;
    }
    const rowStart = /<li\b[^>]*>/gi;
    const starts = [];
    for (let match = rowStart.exec(list); match !== null; match = rowStart.exec(list)) {
      const classes = classTokens2(match[0]);
      if (classes.includes("reading") && classes.includes("work")) starts.push({ index: match.index, tag: match[0] });
    }
    const works = [];
    let deleted = 0;
    let unreadable = 0;
    starts.forEach((start, index) => {
      const row = list.slice(start.index + start.tag.length, starts[index + 1]?.index ?? list.length);
      const read = readRow(row, start.tag);
      if (read === "deleted") deleted += 1;
      else if (read === "unreadable") unreadable += 1;
      else works.push(read);
    });
    const nexts = /* @__PURE__ */ new Set();
    let highest = page;
    const anchor = /<a\b[^>]*>/gi;
    for (let match = anchor.exec(after); match !== null; match = anchor.exec(after)) {
      const href = attribute(match[0], "href");
      const number = href === null ? null : historyPageNumber(href, user);
      if (number !== null) highest = Math.max(highest, number);
      if (attribute(match[0], "rel") === "next") nexts.add(number);
    }
    let disabledNexts = 0;
    let otherNexts = 0;
    const nextItem = /<li\b[^>]*>/gi;
    for (let match = nextItem.exec(after); match !== null; match = nextItem.exec(after)) {
      if (!classTokens2(match[0]).includes("next")) continue;
      const item = after.slice(match.index + match[0].length);
      const close = item.search(/<\/li\s*>/i);
      const body = close >= 0 ? item.slice(0, close) : item;
      const link = /<a\b[^>]*>/i.exec(body);
      const href = link === null ? null : attribute(link[0], "href");
      if (href !== null) nexts.add(historyPageNumber(href, user));
      else if (link === null && elements(body, "span", ["disabled"], 1).length === 1) disabledNexts += 1;
      else otherNexts += 1;
    }
    if (nexts.size > 1 || nexts.has(null) || nexts.size === 1 && !nexts.has(page + 1) || nexts.size === 1 && disabledNexts > 0 || otherNexts > 0) {
      return { kind: "stop", code: "pagination_unexpected" };
    }
    const pageLinks = /<ol\b[^>]*\bclass\s*=\s*["'][^"']*\bpagination\b/i.test(after);
    if (nexts.size === 0 && pageLinks && disabledNexts === 0) {
      return { kind: "stop", code: "pagination_unexpected" };
    }
    if (starts.length === 0) return { kind: "empty" };
    if (unreadable * 2 > starts.length) return { kind: "stop", code: "rows_unreadable" };
    const nextPage = nexts.size ? page + 1 : null;
    const totalPages = nextPage === null ? page : Math.max(highest, nextPage);
    return { kind: "page", works, deleted, unreadable, nextPage, totalPages };
  }
  function retryAfterMs(value, now) {
    if (typeof value !== "string" || !value.trim()) return null;
    const trimmed = value.trim();
    if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed) * 1e3;
    if (!/^[A-Za-z]{3},\s/.test(trimmed)) return null;
    const date = Date.parse(trimmed);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
  }
  function classifyHistoryAnswer(answer, user, page, now) {
    if (answer.kind === "failed") {
      return answer.code === "timeout" || answer.code === "network" ? { kind: "retry", code: answer.code, retryAfterMs: null } : { kind: "stop", code: answer.code };
    }
    if (answer.cfMitigated?.toLowerCase() === "challenge") return { kind: "stop", code: "challenge" };
    if (answer.status === 429) return { kind: "retry", code: "rate_limited", retryAfterMs: retryAfterMs(answer.retryAfter, now) };
    if (answer.status === 503) {
      if (isChallengePage(answer.html)) return { kind: "stop", code: "challenge" };
      return { kind: "retry", code: "unavailable", retryAfterMs: retryAfterMs(answer.retryAfter, now) };
    }
    if (answer.status === 502 || answer.status === 504 || answer.status >= 520 && answer.status <= 526) {
      return { kind: "retry", code: "server_error", retryAfterMs: retryAfterMs(answer.retryAfter, now) };
    }
    if (isChallengePage(answer.html)) return { kind: "stop", code: "challenge" };
    let landed;
    try {
      landed = new URL(answer.url);
    } catch {
      return { kind: "stop", code: "redirected" };
    }
    if (landed.protocol !== "https:" || landed.hostname !== "archiveofourown.org") return { kind: "stop", code: "wrong_host" };
    if (/^\/users\/(?:login|sign_in)\b|^\/login\b/i.test(landed.pathname)) return { kind: "stop", code: "signed_out" };
    if (answer.status === 401) return { kind: "stop", code: "signed_out" };
    if (answer.status === 403) return { kind: "stop", code: LOGIN_MARKERS.test(answer.html) ? "signed_out" : "forbidden" };
    if (answer.status !== 200) return { kind: "stop", code: "http_error" };
    if (historyPageNumber(answer.url, user) !== page) {
      return { kind: "stop", code: LOGIN_MARKERS.test(answer.html) ? "signed_out" : "redirected" };
    }
    if (answer.contentType !== null && !/text\/html/i.test(answer.contentType)) return { kind: "stop", code: "unrecognized_page" };
    const read = readHistoryPage(answer.html, user, page);
    if (read.kind === "empty") return { kind: "retry", code: "empty_page", retryAfterMs: null };
    if (read.kind === "incomplete") return { kind: "retry", code: "incomplete_page", retryAfterMs: null };
    return read.kind === "page" ? { kind: "page", read } : { kind: "stop", code: read.code };
  }

  // src/extension-runtime/ao3-history-store.mts
  var HISTORY_DATABASE_NAME = "traceAo3HistoryImportV1";
  var HISTORY_DATABASE_VERSION = 1;
  var RUN_STORE = "run";
  var WORK_STORE = "works";
  var RUN_KEY = "current";
  var HISTORY_DATABASE_TIMEOUT_MS = 5e3;
  var HistoryStoreFull = class extends Error {
  };
  function mergeHistoryWork(kept, seen) {
    const later = (a, b) => a === null ? b : b === null ? a : a >= b ? a : b;
    const most = (a, b) => a === null ? b : b === null ? a : Math.max(a, b);
    return {
      id: kept.id,
      title: kept.title || seen.title,
      authors: kept.authors.length ? kept.authors : seen.authors,
      fandoms: kept.fandoms.length ? kept.fandoms : seen.fandoms,
      tags: kept.tags.length ? kept.tags : seen.tags,
      summary: kept.summary || seen.summary,
      words: kept.words ?? seen.words,
      chapters: kept.chapters ?? seen.chapters,
      lastVisited: later(kept.lastVisited, seen.lastVisited),
      visits: most(kept.visits, seen.visits),
      later: kept.later && seen.later
    };
  }
  var clone = (value) => structuredClone(value);
  var MemoryHistoryStore = class {
    run = null;
    works = /* @__PURE__ */ new Map();
    /** Makes the next writes fail, as a full device would. */
    failWrites = null;
    async readRun() {
      return this.run === null ? null : clone(this.run);
    }
    async writeRun(run) {
      this.#check();
      this.run = clone(run);
    }
    async admit(works, runFor) {
      this.#check();
      let fresh = 0;
      let repeats = 0;
      const next = new Map(this.works);
      for (const work of works) {
        const kept = next.get(work.id);
        if (kept === void 0) {
          fresh += 1;
          next.set(work.id, clone(work));
        } else {
          repeats += 1;
          next.set(work.id, mergeHistoryWork(kept, work));
        }
      }
      const run = clone(runFor({ fresh, repeats }));
      this.works.clear();
      for (const [id, work] of next) this.works.set(id, work);
      this.run = run;
      return { fresh, repeats };
    }
    async readWorks() {
      return [...this.works.values()].map(clone);
    }
    async clear() {
      this.run = null;
      this.works.clear();
    }
    #check() {
      if (this.failWrites === "full") throw new HistoryStoreFull("history storage full");
      if (this.failWrites === "error") throw new Error("history storage failed");
    }
  };
  var ConnectionLost2 = class extends Error {
  };
  var IndexedDbHistoryStore = class {
    #factory;
    #timeoutMs;
    #openPromise = null;
    constructor(factory, options = {}) {
      this.#factory = factory;
      this.#timeoutMs = options.timeoutMs ?? HISTORY_DATABASE_TIMEOUT_MS;
    }
    readRun() {
      return this.#transaction("readonly", ({ run }) => {
        const request = run.get(RUN_KEY);
        return () => request.result === void 0 ? null : request.result;
      });
    }
    writeRun(value) {
      return this.#transaction("readwrite", ({ run }) => {
        run.put(value, RUN_KEY);
        return () => void 0;
      });
    }
    admit(works, runFor) {
      return this.#transaction("readwrite", ({ run, works: store }) => {
        let fresh = 0;
        let repeats = 0;
        const unique = /* @__PURE__ */ new Map();
        for (const work of works) {
          const before = unique.get(work.id);
          if (before === void 0) unique.set(work.id, work);
          else {
            repeats += 1;
            unique.set(work.id, mergeHistoryWork(before, work));
          }
        }
        let waiting = unique.size;
        const putRun = () => run.put(runFor({ fresh, repeats }), RUN_KEY);
        for (const work of unique.values()) {
          const request = store.get(work.id);
          request.onsuccess = () => {
            const kept = request.result;
            if (kept === void 0) {
              fresh += 1;
              store.put(work);
            } else {
              repeats += 1;
              store.put(mergeHistoryWork(kept, work));
            }
            waiting -= 1;
            if (waiting === 0) putRun();
          };
        }
        if (waiting === 0) putRun();
        return () => ({ fresh, repeats });
      });
    }
    readWorks() {
      return this.#transaction("readonly", ({ works }) => {
        const request = works.getAll();
        return () => Array.isArray(request.result) ? request.result : [];
      });
    }
    clear() {
      return this.#transaction("readwrite", ({ run, works }) => {
        run.clear();
        works.clear();
        return () => void 0;
      });
    }
    async #transaction(mode, work) {
      const database = await this.#open();
      try {
        return await this.#transactionOn(database, mode, work);
      } catch (error) {
        if (!(error instanceof ConnectionLost2)) throw error;
        this.#drop(database);
        const fresh = await this.#open();
        try {
          return await this.#transactionOn(fresh, mode, work);
        } catch (retryError) {
          if (retryError instanceof ConnectionLost2) this.#drop(fresh);
          throw retryError;
        }
      }
    }
    #drop(failed2) {
      this.#openPromise = null;
      try {
        failed2.close();
      } catch {
      }
    }
    #transactionOn(database, mode, work) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let transaction;
        try {
          transaction = database.transaction([RUN_STORE, WORK_STORE], mode);
        } catch {
          reject(new ConnectionLost2("history database connection lost"));
          return;
        }
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          if (error === null) resolve(value);
          else reject(error);
        };
        const timer = globalThis.setTimeout(() => {
          try {
            transaction.abort();
          } catch {
          }
          finish(new ConnectionLost2("history database transaction timed out"));
        }, this.#timeoutMs);
        let result;
        try {
          result = work({ run: transaction.objectStore(RUN_STORE), works: transaction.objectStore(WORK_STORE) });
        } catch (error) {
          try {
            transaction.abort();
          } catch {
          }
          finish(error instanceof DOMException && error.name === "QuotaExceededError" ? new HistoryStoreFull("history storage full") : new Error("history database request failed", { cause: error }));
          return;
        }
        transaction.oncomplete = () => {
          try {
            finish(null, result());
          } catch (error) {
            finish(new Error("history database result invalid", { cause: error }));
          }
        };
        transaction.onabort = () => {
          const error = transaction.error;
          if (error?.name === "QuotaExceededError") finish(new HistoryStoreFull("history storage full"));
          else if (error === null || error.name === "UnknownError") finish(new ConnectionLost2("history database connection lost"));
          else finish(new Error(`history database transaction aborted: ${error.message}`, { cause: error }));
        };
      });
    }
    #open() {
      if (this.#openPromise !== null) return this.#openPromise;
      const opening = new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          reject(new Error(message));
        };
        let request;
        try {
          request = this.#factory.open(HISTORY_DATABASE_NAME, HISTORY_DATABASE_VERSION);
        } catch {
          reject(new Error("history database open failed"));
          return;
        }
        const timer = globalThis.setTimeout(() => fail("history database open timed out"), this.#timeoutMs);
        request.onupgradeneeded = (event) => {
          const database = request.result;
          if (event.oldVersion !== 0 || database.objectStoreNames.length !== 0) {
            request.transaction?.abort();
            return;
          }
          database.createObjectStore(RUN_STORE);
          database.createObjectStore(WORK_STORE, { keyPath: "id" });
        };
        request.onerror = () => fail("history database open failed");
        request.onblocked = () => fail("history database open blocked");
        request.onsuccess = () => {
          const database = request.result;
          if (settled) {
            database.close();
            return;
          }
          if (database.version !== HISTORY_DATABASE_VERSION || !database.objectStoreNames.contains(RUN_STORE) || !database.objectStoreNames.contains(WORK_STORE)) {
            database.close();
            fail("history database schema invalid");
            return;
          }
          settled = true;
          globalThis.clearTimeout(timer);
          const forget = () => {
            if (this.#openPromise === cached) this.#openPromise = null;
          };
          database.onversionchange = () => {
            database.close();
            forget();
          };
          database.onclose = forget;
          resolve(database);
        };
      });
      const cached = opening.catch((error) => {
        if (this.#openPromise === cached) this.#openPromise = null;
        throw error;
      });
      this.#openPromise = cached;
      return cached;
    }
  };

  // src/extension-runtime/ao3-history-import.mts
  var AO3_HISTORY_IMPORT_MESSAGE = "TRACE_AO3_HISTORY_IMPORT";
  var PAGE_GAP_MS = 6e3;
  var PAGE_GAP_JITTER_MS = 1e3;
  var MAX_PAGE_GAP_MS = 6e4;
  var RETRY_BASE_MS = 6e4;
  var RETRY_MAX_MS = 9e5;
  var NETWORK_RETRY_MS = 3e4;
  var MAX_CONSECUTIVE_RETRIES = 3;
  var SAVE_SETTLE_MS2 = 1e4;
  var SAVE_RECHECK_MS = 5e3;
  var REQUEST_TIMEOUT_MS9 = 2e4;
  var LOST_AFTER_MS = 3e4;
  var MAX_PAGES = 5e3;
  var clone2 = (value) => structuredClone(value);
  function isRun(value) {
    if (!value || typeof value !== "object") return false;
    const run = value;
    return run.v === 1 && typeof run.runId === "string" && typeof run.account === "string" && typeof run.user === "string" && AO3_USERNAME_PATTERN.test(run.user) && ["running", "paused", "finished"].includes(run.status) && Number.isSafeInteger(run.nextPage) && typeof run.counts === "object" && run.counts !== null && typeof run.timing === "object" && run.timing !== null && typeof run.retry === "object" && run.retry !== null;
  }
  function newRun(runId, account, user, tabId, now) {
    return {
      v: 1,
      runId,
      account,
      user,
      status: "running",
      reason: null,
      tabId,
      nextPage: 1,
      totalPages: null,
      lastPageDigest: null,
      inFlight: null,
      counts: { pages: 0, works: 0, later: 0, deleted: 0, unreadable: 0, repeats: 0 },
      timing: {
        startedAt: now,
        finishedAt: null,
        pausedAt: null,
        pausedMs: 0,
        dueAt: now,
        gapMs: PAGE_GAP_MS,
        lastKeptAt: null,
        keptGapMsTotal: 0,
        keptGapCount: 0
      },
      retry: { consecutive: 0, code: null }
    };
  }
  var WAIT_OF = {
    rate_limited: "slow_down",
    unavailable: "slow_down",
    server_error: "ao3_unwell",
    empty_page: "ao3_unwell",
    incomplete_page: "ao3_unwell",
    network: "network",
    timeout: "network"
  };
  function describeRun(run, now, saving = false) {
    if (run === null) {
      return {
        status: "idle",
        reason: null,
        pagesRead: 0,
        totalPages: null,
        works: 0,
        later: 0,
        deleted: 0,
        unreadable: 0,
        waitingFor: null,
        waitingUntil: null,
        remainingMs: null,
        startedAt: null,
        finishedAt: null
      };
    }
    const running = run.status === "running";
    const waitingUntil = running && run.inFlight === null && run.timing.dueAt > now ? run.timing.dueAt : null;
    const waitingFor = !running ? null : saving ? "save" : run.retry.code !== null && waitingUntil !== null ? WAIT_OF[run.retry.code] : null;
    let remainingMs = null;
    if (run.status !== "finished" && run.totalPages !== null) {
      const left = Math.max(0, run.totalPages - run.counts.pages);
      const perPage = run.timing.keptGapCount >= 2 ? run.timing.keptGapMsTotal / run.timing.keptGapCount : run.timing.gapMs + PAGE_GAP_JITTER_MS / 2 + 1500;
      remainingMs = Math.round(left * perPage);
    }
    return {
      status: run.status,
      reason: run.reason,
      pagesRead: run.counts.pages,
      totalPages: run.totalPages,
      works: run.counts.works,
      later: run.counts.later,
      deleted: run.counts.deleted,
      unreadable: run.counts.unreadable,
      waitingFor,
      waitingUntil,
      remainingMs,
      startedAt: run.timing.startedAt,
      finishedAt: run.timing.finishedAt
    };
  }
  var Ao3HistoryImport = class {
    #ports;
    #run = null;
    #loaded = false;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    /** Runs changes to the run one after another. */
    #serial(work) {
      const next = this.#tail.then(work, work);
      this.#tail = next.catch(() => void 0);
      return next;
    }
    /** The stored run, if it is the signed-in account's. Another account's is deleted. */
    async #load() {
      if (!this.#loaded) {
        const value = await this.#ports.store.readRun().catch(() => null);
        this.#run = isRun(value) ? clone2(value) : null;
        this.#loaded = true;
      }
      if (this.#run !== null) {
        const account = await this.#ports.account().catch(() => null);
        if (account !== null && account !== this.#run.account) await this.#forget();
      }
      return this.#run;
    }
    async #forget() {
      await this.#ports.store.clear().catch(() => void 0);
      this.#run = null;
      this.#loaded = true;
    }
    /** Writes `next`; on failure the stored run stays as it was. */
    async #write(next) {
      return await this.#writeFailure(next) === null;
    }
    /** Writes `next`, and says why it could not be kept, if it could not. */
    async #writeFailure(next) {
      try {
        await this.#ports.store.writeRun(next);
        this.#run = next;
        return null;
      } catch (error) {
        return error instanceof HistoryStoreFull ? "storage_full" : "storage_write_failed";
      }
    }
    async #alarm(on) {
      try {
        await (on ? this.#ports.alarm?.start() : this.#ports.alarm?.stop());
      } catch {
      }
    }
    async #ensureLoop(tabId) {
      if (tabId === null || this.#ports.ensureLoop === void 0) return;
      try {
        await this.#ports.ensureLoop(tabId);
      } catch {
      }
    }
    #saving(now) {
      const saves = this.#ports.saveActivity();
      return saves.inFlight > 0 || now - saves.lastEndedAt < SAVE_SETTLE_MS2;
    }
    #instruction(run) {
      if (run === null || run.status !== "running") return { stop: true };
      return { wait: Math.max(0, run.timing.dueAt - this.#ports.clock.now()) };
    }
    #gap(run) {
      return run.timing.gapMs + Math.floor(Math.max(0, Math.min(1, this.#ports.random())) * PAGE_GAP_JITTER_MS);
    }
    async view() {
      const run = await this.#serial(() => this.#load());
      const now = this.#ports.clock.now();
      return describeRun(run, now, run?.status === "running" && this.#saving(now));
    }
    /** Every work the run has kept, for the review. Another account gets none. */
    async works() {
      const run = await this.#serial(() => this.#load());
      return run === null ? [] : this.#ports.store.readWorks();
    }
    /** Starts a run for `user`; the page loop in `tabId` carries it. */
    async start(user, tabId) {
      if (!AO3_USERNAME_PATTERN.test(user)) return { error: "username_unclear" };
      const started = await this.#serial(async () => {
        const account = await this.#ports.account().catch(() => null);
        if (account === null) return "not_connected";
        const current = await this.#load();
        if (current !== null) return "already_started";
        const run = newRun(this.#ports.newId(), account, user, tabId, this.#ports.clock.now());
        try {
          await this.#ports.store.clear();
          await this.#ports.store.writeRun(run);
        } catch (error) {
          return error instanceof HistoryStoreFull ? "storage_full" : "storage_write_failed";
        }
        this.#run = run;
        return true;
      });
      if (started !== true) return { error: started };
      await this.#alarm(true);
      await this.#ensureLoop(tabId);
      return this.view();
    }
    async pause() {
      await this.#serial(async () => {
        const run = await this.#load();
        if (run === null || run.status !== "running") return;
        const next = clone2(run);
        next.status = "paused";
        next.reason = "paused_by_you";
        next.timing.pausedAt = this.#ports.clock.now();
        await this.#write(next);
      });
      await this.#alarm(false);
      return this.view();
    }
    async resume(tabId) {
      const resumed = await this.#serial(async () => {
        const run = await this.#load();
        if (run === null || run.status !== "paused") return false;
        const next = clone2(run);
        const now = this.#ports.clock.now();
        next.status = "running";
        next.reason = null;
        if (next.timing.pausedAt !== null) next.timing.pausedMs += Math.max(0, now - next.timing.pausedAt);
        next.timing.pausedAt = null;
        next.timing.lastKeptAt = null;
        next.timing.dueAt = Math.max(next.timing.dueAt, now);
        next.retry.consecutive = 0;
        if (tabId !== null) next.tabId = tabId;
        return await this.#write(next);
      });
      if (resumed) {
        await this.#alarm(true);
        await this.#ensureLoop(this.#run?.tabId ?? null);
      }
      return this.view();
    }
    /** Stop and delete: the run and everything it found are gone. */
    async delete() {
      await this.#serial(() => this.#forget());
      await this.#alarm(false);
      return this.view();
    }
    /** The signed-in account left: whatever was kept for it goes too. */
    async accountLeft() {
      await this.#serial(() => this.#forget());
      await this.#alarm(false);
    }
    /**
     * Something other than the page loop woke the background: the alarm, the
     * sheet, an AO3 page, the background starting. A running run's page loop
     * is put (back) into the AO3 tab. It never reads.
     */
    async wake(tabId = null) {
      const loopTab = await this.#serial(async () => {
        const run = await this.#load();
        if (run === null || run.status !== "running") return null;
        if (tabId !== null && tabId !== run.tabId) {
          const next = clone2(run);
          next.tabId = tabId;
          await this.#write(next);
        }
        return tabId ?? run.tabId;
      });
      if (loopTab === null) {
        if (this.#run?.status !== "running") await this.#alarm(false);
        return;
      }
      await this.#ensureLoop(loopTab);
    }
    /** The page loop's tick from the visible AO3 tab `tabId`. */
    async tick(tabId) {
      const instruction = await this.#serial(async () => {
        const run = await this.#load();
        if (run === null || run.status !== "running") return { stop: true };
        const now = this.#ports.clock.now();
        const next = clone2(run);
        if (tabId !== null) next.tabId = tabId;
        if (next.inFlight !== null) {
          if (now - next.inFlight.at <= LOST_AFTER_MS) {
            return { wait: Math.max(1e3, next.inFlight.at + LOST_AFTER_MS - now) };
          }
          next.inFlight = null;
        }
        if (next.nextPage > MAX_PAGES) return this.#pauseWith(next, "page_limit", now);
        if (this.#saving(now)) {
          if (tabId !== null && tabId !== run.tabId) await this.#write(next);
          return { wait: SAVE_RECHECK_MS };
        }
        if (now < next.timing.dueAt) {
          if (tabId !== null && tabId !== run.tabId) await this.#write(next);
          return { wait: next.timing.dueAt - now };
        }
        const token = this.#ports.newId();
        next.inFlight = { token, at: now, page: next.nextPage };
        next.timing.dueAt = now + LOST_AFTER_MS;
        const failure6 = await this.#writeFailure(next);
        if (failure6 !== null) return this.#pauseWith(next, failure6, now);
        return { fetch: historyPageURL(next.user, next.nextPage), token };
      });
      if ("stop" in instruction) await this.#alarm(false);
      return instruction;
    }
    /** The answer to the request `token`, from the page loop. */
    async answer(token, answer) {
      const instruction = await this.#serial(async () => {
        const current = await this.#load();
        if (current === null || current.inFlight === null || current.inFlight.token !== token) {
          return this.#instruction(current);
        }
        const next = clone2(current);
        const { page } = current.inFlight;
        next.inFlight = null;
        const now = this.#ports.clock.now();
        if (next.status !== "running") {
          await this.#write(next);
          return this.#instruction(next);
        }
        const result = classifyHistoryAnswer(answer, next.user, page, now);
        if (result.kind === "page") return this.#keep(next, page, result.read, now);
        if (result.kind === "retry") return this.#retry(next, page, result, now);
        return this.#pauseWith(next, result.code, now);
      });
      if ("stop" in instruction) await this.#alarm(false);
      return instruction;
    }
    async #pauseWith(next, reason, now) {
      next.status = "paused";
      next.reason = reason;
      next.inFlight = null;
      next.timing.pausedAt ??= now;
      if (!await this.#write(next)) {
        this.#run = next;
      }
      return { stop: true };
    }
    async #retry(next, page, result, now) {
      next.retry.consecutive += 1;
      next.retry.code = result.code;
      const network = result.code === "network" || result.code === "timeout";
      const base = network ? NETWORK_RETRY_MS : RETRY_BASE_MS * 2 ** (next.retry.consecutive - 1);
      const retryAfter = result.retryAfterMs ?? 0;
      next.timing.dueAt = now + Math.max(Math.min(RETRY_MAX_MS, base), retryAfter);
      if (next.retry.consecutive >= MAX_CONSECUTIVE_RETRIES) {
        const reason = result.code === "timeout" ? "network" : result.code === "empty_page" && page === 1 ? "history_empty" : result.code;
        return this.#pauseWith(next, reason, now);
      }
      if (retryAfter > RETRY_MAX_MS) return this.#pauseWith(next, "retry_later", now);
      if (result.code === "rate_limited" || result.code === "unavailable" || result.code === "server_error") {
        next.timing.gapMs = Math.min(MAX_PAGE_GAP_MS, next.timing.gapMs * 2);
      }
      const failure6 = await this.#writeFailure(next);
      if (failure6 !== null) return this.#pauseWith(next, failure6, now);
      return this.#instruction(next);
    }
    async #keep(next, page, read, now) {
      const digest = read.works.length ? `${read.works[0].id}|${read.works.at(-1).id}|${read.works.length}` : null;
      if (digest !== null && digest === next.lastPageDigest) return this.#pauseWith(next, "pagination_repeat", now);
      next.lastPageDigest = digest;
      next.counts.pages += 1;
      next.counts.later += read.works.filter((work) => work.later).length;
      next.counts.deleted += read.deleted;
      next.counts.unreadable += read.unreadable;
      next.totalPages = Math.max(next.totalPages ?? 0, read.totalPages);
      next.retry = { consecutive: 0, code: null };
      if (next.timing.lastKeptAt !== null) {
        next.timing.keptGapMsTotal += now - next.timing.lastKeptAt;
        next.timing.keptGapCount += 1;
      }
      next.timing.lastKeptAt = now;
      if (read.nextPage === null) {
        next.status = "finished";
        next.reason = "reached_last_page";
        next.timing.finishedAt = now;
        next.totalPages = page;
      } else {
        next.nextPage = read.nextPage;
        next.timing.dueAt = now + this.#gap(next);
      }
      let kept = next;
      try {
        await this.#ports.store.admit(read.works, ({ fresh, repeats }) => {
          kept = {
            ...next,
            counts: { ...next.counts, works: next.counts.works + fresh, repeats: next.counts.repeats + repeats }
          };
          return kept;
        });
      } catch (error) {
        const failed2 = clone2(this.#run ?? next);
        failed2.inFlight = null;
        return this.#pauseWith(failed2, error instanceof HistoryStoreFull ? "storage_full" : "storage_write_failed", now);
      }
      this.#run = clone2(kept);
      return this.#instruction(this.#run);
    }
  };

  // src/extension-runtime/native-history-handoff.mts
  var HISTORY_SOURCE = "ao3-history";
  var HISTORY_MAXIMUM_PART_BYTES = 393216;
  var HISTORY_MAXIMUM_PARTS = 128;
  var HISTORY_MAXIMUM_ITEMS = 25e3;
  var HISTORY_MAXIMUM_PART_ITEMS = 1e3;
  var HISTORY_LIFETIME_MS = 18e5;
  var REQUEST_ADMISSION_MS = 6e5;
  var MESSAGE_ATTEMPT_MS2 = 2500;
  var UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var record4 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  function historyImportItem(work) {
    const item = {
      src: "ao3",
      ctx: "listing",
      u: `https://archiveofourown.org/works/${work.id}`,
      t: work.title
    };
    if (work.authors[0]) item.a = work.authors[0];
    if (work.fandoms.length) item.fms = [...work.fandoms];
    if (work.tags.length) item.tags = [...work.tags];
    if (work.summary) item.sm = work.summary;
    if (work.words !== null) item.w = work.words;
    const chapters = /^(\d+)\/(\d+|\?)$/.exec(work.chapters ?? "");
    if (chapters) {
      const published = Number(chapters[1]);
      item.chPub = published;
      item.cht = chapters[2] === "?" ? "?" : Number(chapters[2]);
      item.s = chapters[2] !== "?" && Number(chapters[2]) === published ? "complete" : "wip";
    }
    if (work.later) item.ml = true;
    else {
      if (work.lastVisited !== null) item.lv = work.lastVisited;
      if (work.visits !== null) item.vc = work.visits;
    }
    return item;
  }
  async function historyParts(works, capturedAt, digest = sha256Hex) {
    if (works.length === 0 || works.length > HISTORY_MAXIMUM_ITEMS) return null;
    const ordered = [...works].sort((a, b) => (b.lastVisited ?? "").localeCompare(a.lastVisited ?? "") || Number(b.id) - Number(a.id));
    const encoder = new TextEncoder();
    const encode = (items) => encoder.encode(`{"s":${JSON.stringify(HISTORY_SOURCE)},"at":${JSON.stringify(capturedAt)},"items":[${items.join(",")}]}`);
    const envelope = encode([]).byteLength;
    const parts = [];
    let current = [];
    let currentBytes = envelope;
    for (const work of ordered) {
      const item = JSON.stringify(historyImportItem(work));
      const itemBytes = encoder.encode(item).byteLength;
      if (envelope + itemBytes > HISTORY_MAXIMUM_PART_BYTES) return null;
      const withItem = currentBytes + itemBytes + (current.length > 0 ? 1 : 0);
      if (current.length > 0 && (withItem > HISTORY_MAXIMUM_PART_BYTES || current.length >= HISTORY_MAXIMUM_PART_ITEMS)) {
        parts.push(encode(current));
        current = [item];
        currentBytes = envelope + itemBytes;
      } else {
        current.push(item);
        currentBytes = withItem;
      }
    }
    if (current.length > 0) parts.push(encode(current));
    if (parts.length > HISTORY_MAXIMUM_PARTS) return null;
    const byteCount = parts.reduce((total, part) => total + part.byteLength, 0);
    const whole = new Uint8Array(byteCount);
    let offset = 0;
    for (const part of parts) {
      whole.set(part, offset);
      offset += part.byteLength;
    }
    return { parts, byteCount, itemCount: ordered.length, sha256: await digest(whole) };
  }
  async function sha256Hex(bytes) {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function base64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32768) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    }
    return btoa(binary);
  }
  var failure5 = () => Object.freeze({ ok: false, error: "history_handoff_unavailable" });
  var NativeHistoryHandoffProducer = class {
    #runtime;
    #mode;
    #apiOrigin;
    #randomID;
    #now;
    #active = false;
    /** The last History staged, until another run or its discard. */
    #staged = null;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#mode = options.mode;
      this.#apiOrigin = new URL(options.apiOrigin).origin;
      this.#randomID = options.randomID;
      this.#now = options.now ?? Date.now;
    }
    /** Cancels the History last staged, when its account left before it was published. */
    async discardUnpublished() {
      const staged = this.#staged;
      this.#staged = null;
      if (staged?.handoffID) {
        await this.#send({
          type: "TRACE_IOS_HISTORY_CANCEL",
          protocolVersion: 1,
          requestID: staged.requestID,
          handoffID: staged.handoffID
        }).catch(() => null);
      }
    }
    async run(scope2, isCurrent, history) {
      if (this.#active) return failure5();
      this.#active = true;
      let reservation = null;
      let staged = false;
      try {
        if (!scope2.accountId || new TextEncoder().encode(scope2.accountId).length > 256 || !Number.isSafeInteger(scope2.epoch) || scope2.epoch < 0 || !await isCurrent()) return failure5();
        const requestID = this.#randomID();
        const issued = this.#now();
        if (!UUID4.test(requestID) || !Number.isSafeInteger(issued)) return failure5();
        const pending = { requestID, issued, handoffID: null, expiresAtMs: issued + REQUEST_ADMISSION_MS + HISTORY_LIFETIME_MS };
        reservation = pending;
        const prepared = await this.#send({
          type: "TRACE_IOS_HISTORY_PREPARE",
          protocolVersion: 1,
          requestID,
          requestIssuedAtMs: issued,
          accountID: scope2.accountId,
          accountEpoch: scope2.epoch,
          apiOrigin: this.#apiOrigin,
          partCount: history.parts.length,
          byteCount: history.byteCount,
          itemCount: history.itemCount,
          sha256: history.sha256
        }, async () => await isCurrent() && this.#now() < issued + REQUEST_ADMISSION_MS);
        if (!record4(prepared) || prepared.type !== "TRACE_IOS_HISTORY_PREPARE" || prepared.protocolVersion !== 1 || prepared.ok !== true || prepared.state !== "prepared" || typeof prepared.handoffID !== "string" || !UUID4.test(prepared.handoffID) || typeof prepared.expiresAtMs !== "number" || !Number.isSafeInteger(prepared.expiresAtMs) || prepared.expiresAtMs > pending.expiresAtMs || prepared.maximumPartBytes !== HISTORY_MAXIMUM_PART_BYTES || prepared.maximumParts !== HISTORY_MAXIMUM_PARTS || prepared.maximumItems !== HISTORY_MAXIMUM_ITEMS) return failure5();
        pending.handoffID = prepared.handoffID;
        pending.expiresAtMs = prepared.expiresAtMs;
        const handoffID = prepared.handoffID;
        const current = async () => await isCurrent() && this.#now() < pending.expiresAtMs;
        let ready = null;
        for (const [partIndex, part] of history.parts.entries()) {
          if (!await current()) return failure5();
          ready = await this.#send({
            type: "TRACE_IOS_HISTORY_STAGE",
            protocolVersion: 1,
            requestID,
            handoffID,
            partIndex,
            partBase64: base64(part)
          }, current);
          const last = partIndex === history.parts.length - 1;
          if (!record4(ready) || ready.type !== "TRACE_IOS_HISTORY_STAGE" || ready.protocolVersion !== 1 || ready.ok !== true || ready.handoffID !== handoffID || ready.expiresAtMs !== pending.expiresAtMs || ready.state !== (last ? "ready_to_open" : "staging")) return failure5();
        }
        if (!await current()) return failure5();
        staged = true;
        this.#staged = pending;
        return Object.freeze({ ok: true, state: "ready_to_open", handoffID, expiresAtMs: pending.expiresAtMs });
      } catch {
        return failure5();
      } finally {
        if (!staged && reservation?.handoffID) {
          await this.#send({
            type: "TRACE_IOS_HISTORY_CANCEL",
            protocolVersion: 1,
            requestID: reservation.requestID,
            handoffID: reservation.handoffID
          }).catch(() => null);
        }
        this.#active = false;
      }
    }
    async #send(message, isCurrent = async () => true) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!await isCurrent()) return null;
        const response = await sendNativeMessageWithFallback(
          this.#runtime,
          this.#mode,
          message,
          MESSAGE_ATTEMPT_MS2,
          { mayFallback: isCurrent }
        );
        if (response !== null) return response;
      }
      return null;
    }
  };

  // src/extension-runtime/ao3-history-import-runtime.mts
  var AO3_HISTORY_IMPORT_ALARM = "trace-ao3-history-import";
  var AO3_SITE_PATTERN = "https://*.archiveofourown.org/*";
  function ao3HistoryLoopInTab(message, maxChars, timeoutMs) {
    const scope2 = globalThis;
    const key = "__traceAo3HistoryImportLoopV1";
    const existing = scope2[key];
    if (existing) {
      existing.poke();
      return "running";
    }
    const api = scope2.browser ?? scope2.chrome;
    if (!api?.runtime) return "no_runtime";
    let timer = null;
    let busy = false;
    let stopped = false;
    const send = (body) => {
      try {
        return Promise.resolve(api.runtime.sendMessage({ type: message, ...body })).then((reply) => reply && typeof reply === "object" ? reply : null, () => null);
      } catch (_) {
        return Promise.resolve(null);
      }
    };
    const barKey = "__traceAo3HistoryImportBarV1";
    let bar = null;
    let hidden = false;
    let buttonAction = "pause";
    const plural = (count, one, many) => `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
    const removeBar = () => {
      bar?.host.remove();
      bar = null;
    };
    const makeBar = () => {
      const old = document.getElementById(barKey);
      if (old) old.remove();
      const host = document.createElement("div");
      host.id = barKey;
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = [
        ":host{all:initial}",
        ".bar{--surface:#ffffff;--text:#18232d;--text-2:#5f6b76;--track:#d8e0e7;--action:#c24c22;position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483646;max-width:560px;margin:0 auto;box-sizing:border-box;padding:12px 14px 14px;border-radius:14px;background:var(--surface);color:var(--text);box-shadow:0 1px 0 rgba(24,35,45,.04),0 12px 28px -12px rgba(24,35,45,.42);font:15px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:grid;grid-template-columns:1fr auto;gap:2px 12px;align-items:center}",
        "@media (prefers-color-scheme:dark){.bar{--surface:#121418;--text:#f2f5f8;--text-2:#b4bcc6;--track:#2b2f35;--action:#ff8458}}",
        ".title{font-weight:600;margin:0}",
        ".line{grid-column:1;color:var(--text-2);font-size:13px;margin:0}",
        "button{grid-row:1/3;grid-column:2;min-height:44px;padding:0 14px;border:0;border-radius:10px;font:600 15px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--text);background:var(--track);cursor:pointer}",
        ".track{grid-column:1/3;height:3px;margin-top:8px;border-radius:2px;background:var(--track);overflow:hidden}",
        ".fill{height:100%;width:0;background:var(--action);border-radius:2px;transition:width .3s}",
        "@media (prefers-reduced-motion:reduce){.fill{transition:none}}"
      ].join("");
      const box = document.createElement("div");
      box.className = "bar";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      const title = document.createElement("p");
      title.className = "title";
      const line = document.createElement("p");
      line.className = "line";
      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", () => {
        if (buttonAction === "hide") {
          hidden = true;
          removeBar();
          return;
        }
        button.disabled = true;
        void send({ action: "tab_pause" }).then((reply) => {
          stop();
          if (reply && reply.view) render(reply.view);
          button.disabled = false;
        });
      });
      const track = document.createElement("div");
      track.className = "track";
      const fill = document.createElement("div");
      fill.className = "fill";
      track.appendChild(fill);
      box.append(title, line, button, track);
      root.append(style, box);
      (document.body ?? document.documentElement).appendChild(host);
      return { host, title, line, button, fill };
    };
    function render(view2) {
      if (hidden || !view2 || typeof view2 !== "object") return;
      const v = view2;
      const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
      const works = number(v.works) ?? 0;
      const read2 = number(v.pagesRead) ?? 0;
      const total = number(v.totalPages);
      if (v.status !== "running" && v.status !== "paused" && v.status !== "finished") {
        removeBar();
        return;
      }
      bar ??= makeBar();
      let title = "Reading your History";
      let line = "";
      if (v.status === "running") {
        const page = total === null ? read2 + 1 : Math.min(read2 + 1, total);
        const waiting = v.waitingFor;
        line = waiting === "slow_down" ? "AO3 asked Trace to slow down. Trying again soon." : waiting === "ao3_unwell" ? "AO3 isn't answering. Trace will try again shortly." : waiting === "network" ? "No connection. Trace will try again shortly." : `Page ${page}${total === null ? "" : ` of ${total}`} \xB7 ${plural(works, "story", "stories")}`;
        buttonAction = "pause";
      } else if (v.status === "paused") {
        title = "Paused";
        line = `${plural(works, "story", "stories")} kept. Open Trace to carry on.`;
        buttonAction = "hide";
      } else {
        title = "Your History is ready";
        line = `${plural(works, "story", "stories")}. Open Trace to review them.`;
        buttonAction = "hide";
      }
      bar.title.textContent = title;
      bar.line.textContent = line;
      bar.button.textContent = buttonAction === "pause" ? "Pause" : "Hide";
      const share = v.status === "finished" ? 1 : total === null || total === 0 ? 0 : Math.min(1, read2 / total);
      bar.fill.style.width = `${Math.round(share * 1e3) / 10}%`;
    }
    const read = async (url) => {
      const controller = new AbortController();
      const limit = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "follow", signal: controller.signal });
        const text2 = await response.text();
        return {
          kind: "response",
          status: response.status,
          url: response.url,
          html: text2.length > maxChars ? text2.slice(0, maxChars) : text2,
          chars: text2.length,
          retryAfter: response.headers.get("retry-after"),
          cfMitigated: response.headers.get("cf-mitigated"),
          contentType: response.headers.get("content-type")
        };
      } catch (_) {
        return { kind: "failed", code: controller.signal.aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(limit);
      }
    };
    const schedule = (ms) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, ms);
    };
    function stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
      delete scope2[key];
    }
    async function run() {
      timer = null;
      if (stopped || busy || document.visibilityState !== "visible") return;
      busy = true;
      let next = null;
      try {
        next = await send({ action: "tab_tick" });
        if (next?.view) render(next.view);
        if (next && typeof next.fetch === "string" && typeof next.token === "string") {
          const answer = await read(next.fetch);
          next = await send({ action: "tab_answer", token: next.token, answer });
          if (next?.view) render(next.view);
        }
      } finally {
        busy = false;
      }
      if (stopped) return;
      if (next === null) {
        schedule(1e4);
        return;
      }
      if (next.stop === true) {
        stop();
        return;
      }
      const wait = typeof next.wait === "number" && Number.isFinite(next.wait) ? next.wait : 1e4;
      schedule(Math.min(Math.max(wait, 500), 16 * 6e4));
    }
    function shown() {
      if (document.visibilityState === "visible" && !busy) schedule(500);
    }
    document.addEventListener("visibilitychange", shown);
    scope2[key] = { poke: () => {
      if (!busy) schedule(500);
    } };
    schedule(0);
    return "started";
  }
  function signedInNamesInTab() {
    const names = /* @__PURE__ */ new Set();
    for (const link of Array.from(document.querySelectorAll("a[href]"))) {
      const match = /^\/users\/([A-Za-z0-9_]{1,40})\/readings\/?$/.exec(link.getAttribute("href") ?? "");
      if (match?.[1]) names.add(match[1]);
    }
    const toggle = document.querySelector("#greeting a.dropdown-toggle[href^='/users/']");
    const own = /^\/users\/([A-Za-z0-9_]{1,40})\/?$/.exec(toggle?.getAttribute("href") ?? "");
    if (own?.[1]) names.add(own[1]);
    return Array.from(names);
  }
  function isRecord27(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function stringOrNull2(value) {
    return typeof value === "string" ? value.slice(0, 200) : null;
  }
  function loadedPageFromTab(value) {
    if (!isRecord27(value)) return { kind: "failed", code: "tab_no_result" };
    if (value.kind === "failed") return { kind: "failed", code: value.code === "timeout" ? "timeout" : "network" };
    if (value.kind !== "response" || typeof value.status !== "number" || typeof value.url !== "string" || typeof value.html !== "string") {
      return { kind: "failed", code: "tab_no_result" };
    }
    const html = value.html.length > MAX_HISTORY_PAGE_CHARS ? value.html.slice(0, MAX_HISTORY_PAGE_CHARS) : value.html;
    return {
      kind: "response",
      status: value.status,
      url: value.url,
      html,
      chars: typeof value.chars === "number" && Number.isSafeInteger(value.chars) ? value.chars : html.length,
      retryAfter: stringOrNull2(value.retryAfter),
      cfMitigated: stringOrNull2(value.cfMitigated),
      contentType: stringOrNull2(value.contentType)
    };
  }
  function traceWebSender(sender, extensionId, webOrigin) {
    if (!isRecord27(sender) || !isRecord27(sender.tab) || typeof sender.tab.id !== "number") return false;
    if (typeof extensionId === "string" && sender.id !== extensionId) return false;
    const raw = typeof sender.url === "string" ? sender.url : sender.tab.url;
    try {
      return typeof raw === "string" && new URL(raw).origin === new URL(webOrigin).origin;
    } catch {
      return false;
    }
  }
  function ao3TabSender(sender, extensionId) {
    if (!isRecord27(sender) || !isRecord27(sender.tab) || typeof sender.tab.id !== "number") return null;
    if (typeof extensionId === "string" && sender.id !== extensionId) return null;
    const raw = typeof sender.url === "string" ? sender.url : sender.tab.url;
    try {
      const url = new URL(String(raw));
      return url.protocol === "https:" && url.hostname === "archiveofourown.org" ? sender.tab.id : null;
    } catch {
      return null;
    }
  }
  function withTimeout2(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      promise.then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  function randomToken() {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function installAo3HistoryImport(environment) {
    const { runtime, tabs, scripting, permissions, alarms, storageMode } = environment;
    const call = (target, method, args) => extensionCall(target, method, args, runtime, storageMode);
    async function ao3Tab(sourceTabId) {
      if (sourceTabId === null || tabs.get === void 0) return "tab_gone";
      let tab;
      try {
        tab = await call(tabs, "get", [sourceTabId]);
      } catch {
        return "tab_gone";
      }
      if (!isRecord27(tab) || typeof tab.url !== "string") return "no_site_access";
      let url;
      try {
        url = new URL(tab.url);
      } catch {
        return "tab_not_ao3";
      }
      return url.protocol === "https:" && url.hostname === "archiveofourown.org" ? { id: sourceTabId, url } : "tab_not_ao3";
    }
    async function inTab(tabId, func, args) {
      if (scripting?.executeScript === void 0) return "tab_no_result";
      try {
        const results = await withTimeout2(
          call(scripting, "executeScript", [{ target: { tabId, frameIds: [0] }, func, args }]),
          REQUEST_TIMEOUT_MS9 + 5e3
        );
        if (results === "timeout") return "timeout";
        const first = Array.isArray(results) ? results[0] : void 0;
        return isRecord27(first) && "result" in first ? first.result : "tab_no_result";
      } catch {
        return "tab_no_result";
      }
    }
    const store = environment.store ?? (environment.databaseFactory === null ? new MemoryHistoryStore() : new IndexedDbHistoryStore(environment.databaseFactory));
    const history = new Ao3HistoryImport({
      store,
      clock: { now: () => Date.now() },
      random: () => Math.random(),
      newId: randomToken,
      account: environment.account,
      saveActivity: environment.saveActivity,
      async ensureLoop(sourceTabId) {
        const tab = await ao3Tab(sourceTabId);
        if (typeof tab === "string") return "failed";
        const result = await inTab(
          tab.id,
          ao3HistoryLoopInTab,
          [AO3_HISTORY_IMPORT_MESSAGE, MAX_HISTORY_PAGE_CHARS, REQUEST_TIMEOUT_MS9]
        );
        return result === "started" || result === "running" ? result : "failed";
      },
      ...alarms.create === void 0 ? {} : {
        alarm: {
          start: () => call(alarms, "create", [AO3_HISTORY_IMPORT_ALARM, { periodInMinutes: 1 }]),
          stop: () => call(alarms, "clear", [AO3_HISTORY_IMPORT_ALARM]).then(() => void 0)
        }
      }
    });
    environment.whenAccountLeaves(() => history.accountLeft());
    async function signedInUser(tabId) {
      if (permissions?.contains !== void 0) {
        const allowed = await call(permissions, "contains", [{ origins: [AO3_SITE_PATTERN] }]).catch(() => false);
        if (allowed !== true) return { error: "no_site_access" };
      }
      const tab = await ao3Tab(tabId);
      if (tab === "no_site_access") return { error: "no_site_access" };
      if (typeof tab === "string") return { error: "open_ao3_first" };
      const names = await inTab(tab.id, signedInNamesInTab, []);
      if (!Array.isArray(names)) return { error: names === "timeout" ? "open_ao3_first" : "no_site_access" };
      const valid = names.filter((name) => typeof name === "string" && AO3_USERNAME_PATTERN.test(name));
      const unique = [...new Set(valid.map((name) => name.toLowerCase()))];
      if (unique.length === 0) return { error: "signed_out" };
      if (unique.length > 1) return { error: "username_unclear" };
      return valid[0];
    }
    async function handle(message) {
      const tabId = typeof message.tabId === "number" && Number.isSafeInteger(message.tabId) ? message.tabId : null;
      switch (message.action) {
        case "status": {
          void history.wake(tabId);
          const [account, tab] = await Promise.all([environment.account().catch(() => null), ao3Tab(tabId)]);
          return { ok: true, view: await history.view(), startable: account !== null && typeof tab !== "string" };
        }
        case "start": {
          const user = await signedInUser(tabId);
          if (typeof user !== "string") return { ok: false, error: user.error, view: await history.view() };
          const started = await history.start(user, tabId);
          return "error" in started ? { ok: false, error: started.error, view: await history.view() } : { ok: true, view: started };
        }
        case "pause":
          return { ok: true, view: await history.pause() };
        case "resume":
          return { ok: true, view: await history.resume(tabId) };
        case "delete": {
          await environment.webHistory?.discard().catch(() => void 0);
          return { ok: true, view: await history.delete() };
        }
        case "review": {
          const view2 = await history.view();
          if (view2.status !== "finished" && view2.status !== "paused" || view2.works === 0) {
            return { ok: false, error: "review_not_ready", view: view2 };
          }
          if (environment.handOffHistory === void 0) return { ok: false, error: "history_handoff_unavailable", view: view2 };
          const result = await environment.handOffHistory(async () => historyParts(await history.works(), (/* @__PURE__ */ new Date()).toISOString()));
          if (!result.ok) return { ok: false, error: result.error, view: view2 };
          return result.state === "opened_on_web" ? { ok: true, view: view2, handoff: { handoffID: result.handoffID, expiresAtMs: result.expiresAtMs, url: result.url } } : { ok: true, view: view2, handoff: { handoffID: result.handoffID, expiresAtMs: result.expiresAtMs } };
        }
        default:
          return { ok: false, error: "unknown_action" };
      }
    }
    const loopOffered = /* @__PURE__ */ new Map();
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord27(message)) return false;
      const pageTab = ao3TabSender(sender, runtime.id);
      if (message.type === AO3_HISTORY_IMPORT_MESSAGE && pageTab !== null) {
        const withView = (instruction) => history.view().then((view2) => ({ ...instruction, view: view2 }), () => instruction);
        if (message.action === "tab_tick") {
          void history.tick(pageTab).then(withView).then(sendResponse, () => sendResponse({ wait: 1e4 }));
          return true;
        }
        if (message.action === "tab_answer" && typeof message.token === "string") {
          void history.answer(message.token, loadedPageFromTab(message.answer)).then(withView).then(sendResponse, () => sendResponse({ wait: 1e4 }));
          return true;
        }
        if (message.action === "tab_pause") {
          void history.pause().then((view2) => sendResponse({ stop: true, view: view2 }), () => sendResponse({ stop: true }));
          return true;
        }
        return false;
      }
      if (pageTab !== null) {
        const now = Date.now();
        if (now - (loopOffered.get(pageTab) ?? 0) >= 5e3) {
          loopOffered.set(pageTab, now);
          void history.wake(pageTab);
        }
        return false;
      }
      if ((message.type === WEB_HISTORY_REQUEST || message.type === WEB_HISTORY_RECEIVED) && environment.webHistory !== void 0) {
        if (!traceWebSender(sender, runtime.id, environment.webHistory.origin)) return false;
        void environment.webHistory.answer(message).then(
          (answer) => sendResponse(answer ?? { ok: false, error: "history_handoff_unknown" }),
          () => sendResponse({ ok: false, error: "history_handoff_unknown" })
        );
        return true;
      }
      if (message.type !== AO3_HISTORY_IMPORT_MESSAGE) return false;
      if (!isPopupSender(sender, runtime.id)) return false;
      void handle(message).then(sendResponse, () => sendResponse({ ok: false, error: "unknown_action" }));
      return true;
    });
    alarms.onAlarm?.addListener((alarm) => {
      if (alarm.name === AO3_HISTORY_IMPORT_ALARM) void history.wake();
    });
    globalThis.setTimeout(() => void history.wake(), 1500);
    return history;
  }

  // src/extension-runtime/index.mts
  var UUID_PATTERN9 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function fallbackUuid(seed) {
    let hash = 2166136261;
    const bytes = [];
    for (let index = 0; index < 16; index += 1) {
      for (let offset = 0; offset < seed.length; offset += 1) {
        hash ^= seed.charCodeAt(offset) + index;
        hash = Math.imul(hash, 16777619);
      }
      bytes.push(hash >>> index % 4 * 8 & 255);
    }
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    const hex2 = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex2.slice(0, 8)}-${hex2.slice(8, 12)}-${hex2.slice(12, 16)}-${hex2.slice(16, 20)}-${hex2.slice(20)}`;
  }
  var scope = globalThis;
  scope.TRACE_SESSION_MODE = "kernel";
  try {
    const extension = scope.browser ?? scope.chrome;
    if (!extension) throw new Error("extension environment unavailable");
    const storageMode = scope.browser ? "promise" : "callback";
    const archiveReadinessStatus = new BrowserArchiveReadinessStatus(
      new BrowserStorage(extension.storage.local, extension.runtime, storageMode)
    );
    let session;
    let afterScriptsRegistered = null;
    let readiness = null;
    let registrationSettled = null;
    let sheetRegistrationSettled = null;
    if (true) {
      const recover = installArchiveRecovery({
        runtime: extension.runtime,
        tabs: extension.tabs,
        permissions: extension.permissions,
        scripting: extension.scripting,
        mode: storageMode,
        // A build that registers its page scripts after the grant has none in
        // its manifest for recovery to read.
        ...define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default !== null && define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default.registrationMode !== "static" ? { registered: define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default } : {}
      });
      installArchiveHostAccess({ runtime: extension.runtime, tabs: extension.tabs, action: extension.action, permissions: extension.permissions, mode: storageMode, recover });
      installTraceFirstInstallActivation({
        runtime: extension.runtime,
        tabs: extension.tabs,
        mode: storageMode,
        webOrigin: "https://www.tracefiction.com",
        // Signing in anywhere on Trace after installing finishes the connect,
        // not only on the setup page's own address.
        onActivation: () => rememberConnectIntent(
          new BrowserStorage(extension.storage.local, extension.runtime, storageMode)
        )
      });
      const accessLedger = new BrowserArchiveAccessLedger(
        new BrowserStorage(extension.storage.local, extension.runtime, storageMode)
      );
      const archiveReadiness = installArchiveReadinessRuntime({
        runtime: extension.runtime,
        ...extension.permissions === void 0 ? {} : { permissions: extension.permissions },
        storageMode,
        status: archiveReadinessStatus,
        publishTrackingPreference: () => session?.publishTrackingPreference() ?? Promise.resolve(),
        ...define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default === null ? {} : { requiredOrigins: define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default.origins },
        accessLedger,
        // Access is not reported as ended while an update's or a start's own
        // registration is still settling.
        accessSettled: () => registrationSettled?.() ?? Promise.resolve(true)
      });
      if (define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default !== null && extension.permissions !== void 0) {
        installArchiveAccessReport(archiveReadiness, {
          runtime: extension.runtime,
          permissions: extension.permissions,
          alarms: extension.alarms,
          accessLedger,
          storageMode
        });
      }
      if (define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default !== null && extension.permissions !== void 0 && (define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default.registrationMode === "static" || extension.scripting !== void 0)) {
        const registration = installEarnedPermissionRegistrationRuntime({
          runtime: extension.runtime,
          permissions: extension.permissions,
          ...extension.scripting === void 0 ? {} : { scripting: extension.scripting },
          storage: new BrowserStorage(
            extension.storage.local,
            extension.runtime,
            storageMode
          ),
          storageMode,
          config: define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default,
          alarms: extension.alarms,
          // Story tabs that are already open get the scripts too, whether the
          // reader allowed the sites from the popup or in Safari's settings.
          // A page that was saved on a first tap is told to carry on by itself.
          onScriptsRegistered: () => {
            void recover();
            void afterScriptsRegistered?.().catch(() => void 0);
          },
          onReconcileEnded: (result) => readiness?.registrationEnded(result)
        });
        registrationSettled = () => registration.settled(8e3);
        sheetRegistrationSettled = () => registration.settled(2e3);
        readiness = installSafariReadinessReport({
          runtime: extension.runtime,
          permissions: extension.permissions,
          ...extension.scripting === void 0 ? {} : { scripting: extension.scripting },
          storage: new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
          storageMode,
          apiOrigin: "https://api.tracefiction.com",
          config: define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default,
          registration,
          alarms: extension.alarms,
          session: () => session
        });
      }
    }
    if (!scope.indexedDB) throw new Error("private database unavailable");
    installStoryTabReuse({ runtime: extension.runtime, tabs: extension.tabs, permissions: extension.permissions, mode: storageMode });
    let fallbackId = 0;
    const randomId = () => {
      const uuid = scope.crypto?.randomUUID?.();
      if (typeof uuid === "string" && UUID_PATTERN9.test(uuid)) return uuid;
      fallbackId += 1;
      return fallbackUuid(`${Date.now()}:${fallbackId}`);
    };
    const apiFetch = createActivityFetch(
      globalThis.fetch.bind(globalThis),
      extension.runtime,
      storageMode,
      "https://api.tracefiction.com",
      new BrowserStorage(extension.storage.local, extension.runtime, storageMode)
    );
    const webHistoryHandoff = true ? new WebHistoryHandoff({
      webOrigin: "https://www.tracefiction.com",
      randomID: randomId,
      ...extension.storage.session ? { keep: sessionKeep(new BrowserStorage(extension.storage.session, extension.runtime, storageMode)) } : {}
    }) : null;
    session = installSessionRuntime({
      browserDeviceSessions: true,
      mode: "kernel",
      runtime: extension.runtime,
      tabs: extension.tabs,
      alarms: extension.alarms,
      storageArea: extension.storage.local,
      databaseFactory: scope.indexedDB,
      storageMode,
      fetch: apiFetch,
      apiBase: "https://api.tracefiction.com",
      nativeImportHandoff: true,
      // A build-time constant: only a build with the whole-History import carries it.
      ...true ? {
        nativeHistoryHandoff: new NativeHistoryHandoffProducer({
          runtime: extension.runtime,
          mode: storageMode,
          apiOrigin: "https://api.tracefiction.com",
          randomID: randomId
        }),
        webHistoryHandoff
      } : {},
      ...extension.scripting ? { scripting: extension.scripting } : {},
      ...extension.permissions ? { permissions: extension.permissions } : {},
      webOrigin: "https://www.tracefiction.com",
      randomId,
      archiveReadinessStatus,
      // Missing FanFiction.net summaries are read in the reader's own
      // FanFiction.net tab, slowly (ffn-summary-fill.mts).
      ffnSummaryFill: {
        sessionArea: extension.storage.session ?? null
      }
    });
    if (extension.scripting !== void 0) {
      const historySession = session;
      const historyImport = installAo3HistoryImport({
        runtime: extension.runtime,
        tabs: extension.tabs,
        scripting: extension.scripting,
        ...extension.permissions ? { permissions: extension.permissions } : {},
        alarms: extension.alarms,
        storageMode,
        databaseFactory: scope.indexedDB,
        account: async () => {
          await historySession.start();
          return historySession.publicationScope()?.accountId ?? null;
        },
        whenAccountLeaves: (cleanup) => historySession.whenAccountLeaves(cleanup),
        saveActivity: storySaveActivity,
        handOffHistory: (build) => historySession.handOffHistory(build),
        ...webHistoryHandoff ? { webHistory: {
          origin: "https://www.tracefiction.com",
          answer: (message) => historySession.answerWebHistory(message),
          discard: () => webHistoryHandoff.discard()
        } } : {}
      });
      webHistoryHandoff?.useSource(async (capturedAt) => historyParts(await historyImport.works(), capturedAt));
    }
    if (
      // A build-time constant: a build without optional story sites leaves this
      // block and the modules only it uses out of the bundle altogether.
      define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default !== null && define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default.registrationMode === "dynamic" && extension.permissions !== void 0 && extension.scripting !== void 0
    ) {
      afterScriptsRegistered = installFirstTapSave({
        runtime: extension.runtime,
        tabs: extension.tabs,
        permissions: extension.permissions,
        scripting: extension.scripting,
        storage: new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
        mode: storageMode,
        origins: define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default.origins,
        registrationIds: define_TRACE_IOS_EARNED_PERMISSION_CONFIG_default.registrations.map(({ id }) => id),
        // Saving on opening is a development switch, never on in a release
        // build. Without it the sheet is the same and the reader's tap saves.
        saveOnOpen: false,
        session,
        fetch: apiFetch,
        apiBase: "https://api.tracefiction.com",
        // After Always Allow the registration runs on Safari's word of the new
        // access; what the sheet reads waits for it rather than racing it.
        ...sheetRegistrationSettled ? { registrationSettled: sheetRegistrationSettled } : {},
        // The setup the Trace app has under way, as a save reads it.
        setupAttempt: (accountId) => new NativeStorySaveReceiptPort(extension.runtime, storageMode, "https://api.tracefiction.com").prepareSaveReceipt(accountId)
      });
    }
    extension.storage.onChanged?.addListener((changes, area) => {
      if (area === "local" && "prefAutoTrackEnabled" in changes) void session?.publishTrackingPreference();
      if (area !== "local" || readiness === null) return;
      if ("prefAutoTrackEnabled" in changes) readiness.preferenceChanged();
      if (ACCOUNT_PROJECTION_REVISION_KEY in changes) readiness.accountMayHaveChanged();
    });
  } catch {
    scope.__traceSessionRuntimeBootFailed = true;
  }
})();
