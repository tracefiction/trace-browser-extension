import type {
  RuntimeMessageSender,
  RuntimePort,
  TabsPort,
} from "./browser-platform.mjs";
import { extensionCall } from "./browser-platform.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
} from "./archive-sender.mjs";

export const TRACE_WEB_OPEN_MESSAGE = "TRACE_OPEN_TRACE_URL" as const;

const MAX_TRACE_WEB_URL_LENGTH = 2_048;
const FIRST_INSTALL_ACTIVATION_PATH = "/?activation=extension-installed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type TraceWebNavigationRequest =
  | Readonly<{ kind: "open"; url: string }>
  | Readonly<{ kind: "invalid" }>;

export function traceWebNavigationRequestFromMessage(
  message: unknown,
  sender: RuntimeMessageSender | undefined,
  webOrigin: string,
): TraceWebNavigationRequest | null {
  if (
    !isRecord(message) ||
    Object.keys(message).length !== 2 ||
    message.type !== TRACE_WEB_OPEN_MESSAGE ||
    !isRecord(message.payload) ||
    Object.keys(message.payload).length !== 1
  ) {
    return null;
  }
  const hostKind = archiveHostKindFromSender(sender);
  const senderUrl = sender?.tab?.url ?? sender?.url;
  if (hostKind === null || isBlockedArchivePath(senderUrl, hostKind)) return null;

  const rawUrl = message.payload.url;
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_TRACE_WEB_URL_LENGTH
  ) {
    return Object.freeze({ kind: "invalid" });
  }
  try {
    const configuredOrigin = new URL(webOrigin).origin;
    const url = new URL(rawUrl, configuredOrigin);
    if (
      url.origin !== configuredOrigin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    return Object.freeze({ kind: "open", url: url.href });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

export class BrowserTraceWebNavigation {
  readonly #runtime: RuntimePort;
  readonly #tabs: TabsPort;
  readonly #mode: "callback" | "promise";

  constructor(options: {
    runtime: RuntimePort;
    tabs: TabsPort;
    mode: "callback" | "promise";
  }) {
    this.#runtime = options.runtime;
    this.#tabs = options.tabs;
    this.#mode = options.mode;
  }

  async open(url: string): Promise<boolean> {
    try {
      await extensionCall<unknown>(
        this.#tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
        "create",
        [{ url }],
        this.#runtime,
        this.#mode,
      );
      return true;
    } catch {
      return false;
    }
  }
}

function activationTarget(webOrigin: string): Readonly<{
  origin: string;
  queryPattern: string;
  url: string;
}> | null {
  try {
    const configured = new URL(webOrigin);
    if (
      (configured.protocol !== "https:" && configured.protocol !== "http:") ||
      configured.username ||
      configured.password
    ) {
      return null;
    }
    return Object.freeze({
      origin: configured.origin,
      queryPattern: `${configured.protocol}//${configured.hostname}/*`,
      url: new URL(FIRST_INSTALL_ACTIVATION_PATH, configured.origin).href,
    });
  } catch {
    return null;
  }
}

function tabUsesOrigin(tab: unknown, origin: string): tab is {
  readonly id: number;
  readonly url: string;
} {
  if (
    typeof tab !== "object" ||
    tab === null ||
    typeof (tab as { readonly id?: unknown }).id !== "number" ||
    typeof (tab as { readonly url?: unknown }).url !== "string"
  ) {
    return false;
  }
  try {
    return new URL((tab as { readonly url: string }).url).origin === origin;
  } catch {
    return false;
  }
}

async function platformIsIos(
  runtime: RuntimePort,
  mode: "callback" | "promise",
): Promise<boolean> {
  if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) {
    return true;
  }
  if (typeof runtime.getPlatformInfo !== "function") return false;
  try {
    const info = await extensionCall<unknown>(
      runtime as unknown as Record<string, (...args: unknown[]) => unknown>,
      "getPlatformInfo",
      [],
      runtime,
      mode,
    );
    return (
      typeof info === "object" &&
      info !== null &&
      (info as { readonly os?: unknown }).os === "ios"
    );
  } catch {
    return false;
  }
}

export function installTraceFirstInstallActivation(options: {
  runtime: RuntimePort;
  tabs: TabsPort;
  mode: "callback" | "promise";
  webOrigin: string;
}): void {
  const target = activationTarget(options.webOrigin);
  if (!target || !options.runtime.onInstalled) return;

  options.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") return;
    void (async () => {
      if (await platformIsIos(options.runtime, options.mode)) return;

      try {
        const tabs = await extensionCall<readonly unknown[]>(
          options.tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
          "query",
          [{ url: [target.queryPattern] }],
          options.runtime,
          options.mode,
        );
        const existing = tabs.find((tab) => tabUsesOrigin(tab, target.origin));
        if (existing && typeof options.tabs.update === "function") {
          try {
            await extensionCall<unknown>(
              options.tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
              "update",
              [existing.id, { url: target.url, active: true }],
              options.runtime,
              options.mode,
            );
            return;
          } catch {
            // Fall through to a fresh activation tab.
          }
        }
      } catch {
        // A tab query failure must not suppress first-install onboarding.
      }

      try {
        await extensionCall<unknown>(
          options.tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
          "create",
          [{ url: target.url, active: true }],
          options.runtime,
          options.mode,
        );
      } catch {
        // First-install activation is best effort.
      }
    })();
  });
}
