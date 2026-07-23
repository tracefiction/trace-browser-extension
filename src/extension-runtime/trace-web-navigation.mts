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
