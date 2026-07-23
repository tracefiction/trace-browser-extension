import type {
  BrowserTab,
  RuntimePort,
  TabsPort,
} from "./browser-platform.mjs";
import { extensionCall } from "./browser-platform.mjs";

export interface TraceWebStatus {
  readonly installed: true;
  readonly connected: boolean;
  readonly authState:
    | "connected"
    | "signed_out"
    | "reconnect_required"
    | "error"
    | "unknown";
}

export class TraceWebStatusNotification {
  readonly #runtime: RuntimePort;
  readonly #tabs: TabsPort;
  readonly #mode: "callback" | "promise";
  readonly #webOrigin: string;
  readonly #queryPattern: string;

  constructor(options: {
    runtime: RuntimePort;
    tabs: TabsPort;
    mode: "callback" | "promise";
    webOrigin: string;
  }) {
    this.#runtime = options.runtime;
    this.#tabs = options.tabs;
    this.#mode = options.mode;
    const webUrl = new URL(options.webOrigin);
    this.#webOrigin = webUrl.origin;
    this.#queryPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
  }

  async publish(state: TraceWebStatus): Promise<boolean> {
    let tabs: readonly BrowserTab[];
    try {
      tabs = await extensionCall<readonly BrowserTab[]>(
        this.#tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
        "query",
        [{ url: [this.#queryPattern] }],
        this.#runtime,
        this.#mode,
      );
    } catch {
      return false;
    }
    const message = Object.freeze({
      type: "TRACE_EXTENSION_STATUS_PUSH",
      state,
    });
    for (const tab of tabs) {
      if (typeof tab.id !== "number" || !this.#isTraceWebUrl(tab.url)) continue;
      try {
        await extensionCall<unknown>(
          this.#tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
          "sendMessage",
          [tab.id, message],
          this.#runtime,
          this.#mode,
        );
      } catch {
        // A Trace tab without the bridge receiver does not make the session
        // transition fail and must not trigger another account operation.
      }
    }
    return true;
  }

  #isTraceWebUrl(rawUrl: unknown): boolean {
    if (typeof rawUrl !== "string") return false;
    try {
      return new URL(rawUrl).origin === this.#webOrigin;
    } catch {
      return false;
    }
  }
}
