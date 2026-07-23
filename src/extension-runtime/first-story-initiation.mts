import type {
  BrowserTab,
  RuntimeMessageSender,
  RuntimePort,
  TabsPort,
} from "./browser-platform.mjs";
import { extensionCall } from "./browser-platform.mjs";

const MAX_IMPORT_PAYLOAD_BYTES = 512 * 1_024;
const MAX_IMPORT_ITEMS = 250;
const MAX_FIRST_STORY_URL_LENGTH = 4_096;
const FIRST_STORY_FOCUS_RETRY_ATTEMPTS = 24;
const FIRST_STORY_FOCUS_RETRY_MS = 250;
const HANDOFF_NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SUCCESS_STATES = Object.freeze(["saved", "already_saved"] as const);

export type ArchiveSite = "ao3" | "ffn";

export type ActiveTabContext =
  | Readonly<{ kind: "unknown" | "trace" | "unsupported" }>
  | Readonly<{
      kind: "blocked_archive";
      site: ArchiveSite;
      canImport: false;
    }>
  | Readonly<{
      kind: "supported_story" | "supported_archive";
      site: ArchiveSite;
      canImport: true;
    }>;

export type FirstStoryInitiation =
  | Readonly<{ kind: "popup_import" }>
  | Readonly<{ kind: "invalid"; error: "invalid_url" }>
  | Readonly<{
      kind: "web_save";
      nonce: string;
      url: string;
    }>;

export type FirstStoryInitiationError =
  | "not_authenticated"
  | "invalid_url"
  | "no_active_tab"
  | "unsupported_page"
  | "permission_required"
  | "collect_failed"
  | "open_failed"
  | "save_failed"
  | "free_limit_reached"
  | "auth_expired"
  | "rate_limited"
  | "unavailable";

export type FirstStoryInitiationResult =
  | Readonly<{ ok: true; state: "opened" | "saved" | "already_saved" }>
  | Readonly<{ ok: false; error: FirstStoryInitiationError }>;

interface FirstStoryInitiatorOptions {
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly mode: "callback" | "promise";
  readonly webOrigin: string;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAo3Host(host: string): boolean {
  return (
    host === "archiveofourown.org" ||
    host.endsWith(".archiveofourown.org") ||
    host === "archiveofourown.gay" ||
    host.endsWith(".archiveofourown.gay") ||
    host === "archive.transformativeworks.org" ||
    host === "ao3.org" ||
    host.endsWith(".ao3.org")
  );
}

function isFfnHost(host: string): boolean {
  return host === "www.fanfiction.net" || host === "m.fanfiction.net";
}

function isTopFrame(sender: RuntimeMessageSender | undefined): boolean {
  return (
    sender !== undefined &&
    (sender.frameId === undefined || sender.frameId === 0) &&
    (sender.documentLifecycle === undefined || sender.documentLifecycle === "active")
  );
}

export function classifyActiveTabUrl(
  rawUrl: unknown,
  webOrigin: string,
): ActiveTabContext {
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
        kind: /^\/works\/\d+(?:\/chapters\/\d+)?\/?$/i.test(url.pathname)
          ? "supported_story"
          : "supported_archive",
        site: "ao3",
        canImport: true,
      });
    }
    if (isFfnHost(host)) {
      if (/^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(url.pathname)) {
        return Object.freeze({ kind: "blocked_archive", site: "ffn", canImport: false });
      }
      return Object.freeze({
        kind: /^\/s\/[1-9][0-9]{0,19}(?:\/|$)/i.test(url.pathname)
          ? "supported_story"
          : "supported_archive",
        site: "ffn",
        canImport: true,
      });
    }
    return Object.freeze({ kind: "unsupported" });
  } catch {
    return Object.freeze({ kind: "unsupported" });
  }
}

export function normalizeFirstStoryUrl(rawUrl: unknown): string | null {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.trim() ||
    rawUrl.length > MAX_FIRST_STORY_URL_LENGTH
  ) {
    return null;
  }
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (
      isAo3Host(host) &&
      /^\/works\/[1-9][0-9]{0,19}(?:\/chapters\/[1-9][0-9]{0,19})?\/?$/i.test(
        url.pathname,
      )
    ) {
      return url.href;
    }
    if (
      isFfnHost(host) &&
      /^\/s\/[1-9][0-9]{0,19}(?:\/[1-9][0-9]{0,9})?(?:\/|$)/i.test(url.pathname)
    ) {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

export function isPopupSender(
  sender: RuntimeMessageSender | undefined,
  runtimeId: string | undefined,
): boolean {
  if (runtimeId !== undefined && sender?.id !== runtimeId) return false;
  if (typeof sender?.url !== "string") {
    return (
      (sender?.tab === undefined || sender.tab === null) &&
      runtimeId !== undefined &&
      sender?.id === runtimeId
    );
  }
  try {
    const url = new URL(sender.url);
    return (
      ["chrome-extension:", "moz-extension:", "safari-web-extension:"].includes(url.protocol) &&
      url.pathname === "/popup.html"
    );
  } catch {
    return false;
  }
}

export function isTraceWebSender(
  sender: RuntimeMessageSender | undefined,
  runtimeId: string | undefined,
  webOrigin: string,
): boolean {
  if (!isTopFrame(sender)) return false;
  if (runtimeId !== undefined && sender?.id !== runtimeId) return false;
  const rawUrl = sender?.url ?? sender?.tab?.url;
  if (typeof rawUrl !== "string") return false;
  try {
    return new URL(rawUrl).origin === new URL(webOrigin).origin;
  } catch {
    return false;
  }
}

export function firstStoryInitiationFromMessage(
  message: unknown,
  sender: RuntimeMessageSender | undefined,
  runtimeId: string | undefined,
  webOrigin: string,
): FirstStoryInitiation | null {
  if (!isRecord(message) || typeof message.type !== "string") return null;
  if (message.type === "TRACE_IMPORT_TRIGGER") {
    return isPopupSender(sender, runtimeId)
      ? Object.freeze({ kind: "popup_import" })
      : null;
  }
  if (message.type !== "TRACE_FIRST_STORY_ADD") return null;
  if (!isTraceWebSender(sender, runtimeId, webOrigin)) return null;
  const nonce = typeof message.nonce === "string" ? message.nonce.trim() : "";
  if (!HANDOFF_NONCE_PATTERN.test(nonce)) return null;
  const url = normalizeFirstStoryUrl(message.url);
  if (url === null) return Object.freeze({ kind: "invalid", error: "invalid_url" });
  return Object.freeze({ kind: "web_save", nonce, url });
}

function isMissingReceiverError(error: unknown): boolean {
  const value = [
    typeof error === "string" ? error : "",
    isRecord(error) && typeof error.message === "string" ? error.message : "",
    String(error ?? ""),
  ].join("\n");
  return /receiving end does not exist|could not establish connection|message port closed/i.test(
    value,
  );
}

function sourceMatchesSite(value: unknown, site: ArchiveSite): boolean {
  if (typeof value !== "string") return false;
  const source = value.trim().toLowerCase();
  return site === "ao3"
    ? source === "ao3" ||
        source === "archiveofourown.org" ||
        source === "archiveofourown.gay" ||
        source === "archive.transformativeworks.org"
    : source === "ffn" || source === "fanfiction.net";
}

function boundedImportPayload(
  response: unknown,
  site: ArchiveSite,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.payload)) {
    return null;
  }
  if (!sourceMatchesSite(response.payload.s, site)) return null;
  if (
    typeof response.payload.at !== "string" ||
    !response.payload.at ||
    response.payload.at.length > 128
  ) {
    return null;
  }
  if (
    !Array.isArray(response.payload.items) ||
    response.payload.items.length === 0 ||
    response.payload.items.length > MAX_IMPORT_ITEMS ||
    !response.payload.items.every((item) => (
      isRecord(item) &&
      sourceMatchesSite(item.src, site) &&
      normalizeFirstStoryUrl(item.u) !== null
    ))
  ) {
    return null;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(response.payload);
  } catch {
    return null;
  }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_PAYLOAD_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? Object.freeze(parsed) : null;
  } catch {
    return null;
  }
}

function encodeImportPayload(payload: Readonly<Record<string, unknown>>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function responseError(response: unknown): FirstStoryInitiationError {
  if (!isRecord(response) || typeof response.error !== "string") return "save_failed";
  if (
    response.error === "not_authenticated" ||
    response.error === "free_limit_reached" ||
    response.error === "auth_expired" ||
    response.error === "rate_limited"
  ) {
    return response.error;
  }
  if (response.error === "page_contains_password_field") return "unsupported_page";
  return "save_failed";
}

export class BrowserFirstStoryInitiator {
  readonly #runtime: RuntimePort;
  readonly #tabs: TabsPort;
  readonly #mode: "callback" | "promise";
  readonly #webOrigin: string;
  readonly #delay: (milliseconds: number) => Promise<void>;

  constructor(options: FirstStoryInitiatorOptions) {
    this.#runtime = options.runtime;
    this.#tabs = options.tabs;
    this.#mode = options.mode;
    this.#webOrigin = new URL(options.webOrigin).origin;
    this.#delay = options.delay ?? ((milliseconds) =>
      new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  }

  async importActivePage(): Promise<FirstStoryInitiationResult> {
    let tabs: readonly BrowserTab[];
    try {
      tabs = await this.#call<readonly BrowserTab[]>("query", [{
        active: true,
        currentWindow: true,
      }]);
    } catch {
      return Object.freeze({ ok: false, error: "unavailable" });
    }
    const tab = tabs[0];
    if (typeof tab?.id !== "number") {
      return Object.freeze({ ok: false, error: "no_active_tab" });
    }
    const context = classifyActiveTabUrl(tab.url, this.#webOrigin);
    if (
      context.kind !== "supported_story" &&
      context.kind !== "supported_archive"
    ) {
      return Object.freeze({ ok: false, error: "unsupported_page" });
    }

    let response: unknown;
    try {
      response = await this.#call("sendMessage", [tab.id, { type: "TRACE_COLLECT" }]);
    } catch (error) {
      return Object.freeze({
        ok: false,
        error: isMissingReceiverError(error) ? "permission_required" : "collect_failed",
      });
    }
    const payload = boundedImportPayload(response, context.site);
    if (payload === null) {
      const error =
        isRecord(response) && response.error === "page_contains_password_field"
          ? "unsupported_page"
          : "collect_failed";
      return Object.freeze({ ok: false, error });
    }

    const importUrl = `${this.#webOrigin}/import#U${encodeURIComponent(
      encodeImportPayload(payload),
    )}`;
    try {
      await this.#call("create", [{ url: importUrl }]);
      return Object.freeze({ ok: true, state: "opened" });
    } catch {
      return Object.freeze({ ok: false, error: "open_failed" });
    }
  }

  async saveFromTrace(url: string): Promise<FirstStoryInitiationResult> {
    const normalized = normalizeFirstStoryUrl(url);
    if (normalized === null) return Object.freeze({ ok: false, error: "invalid_url" });
    let tab: BrowserTab;
    try {
      tab = await this.#call<BrowserTab>("create", [{ url: normalized, active: true }]);
    } catch {
      return Object.freeze({ ok: false, error: "open_failed" });
    }
    if (typeof tab?.id !== "number") {
      return Object.freeze({ ok: false, error: "open_failed" });
    }

    for (let attempt = 0; attempt <= FIRST_STORY_FOCUS_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.#call<unknown>("sendMessage", [
          tab.id,
          { type: "TRACE_FIRST_STORY_FOCUS_ADD" },
        ]);
        if (isRecord(response) && response.ok === true) {
          const state = SUCCESS_STATES.find((candidate) => candidate === response.state);
          return state === undefined
            ? Object.freeze({ ok: false, error: "save_failed" })
            : Object.freeze({ ok: true, state });
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

  #call<T>(method: "query" | "sendMessage" | "create", args: readonly unknown[]): Promise<T> {
    return extensionCall<T>(
      this.#tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
      method,
      args,
      this.#runtime,
      this.#mode,
    );
  }
}
