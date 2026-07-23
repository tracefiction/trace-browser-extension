import type {
  AuthenticatedEffectResult,
  MetadataContributionApiOutcome,
  MetadataContributionApiPort,
  MetadataContributionCommand,
  MetadataContributionPreferencePort,
  MetadataNotificationPort,
} from "../extension-core/index.mjs";
import {
  BrowserStorage,
  extensionCall,
  type BrowserTab,
  type RuntimePort,
  type TabsPort,
} from "./browser-platform.mjs";

const REQUEST_TIMEOUT_MS = 12_000;
const METADATA_PREFERENCE_KEY = "prefMetadataImproveEnabled";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export class MetadataContributionApi implements MetadataContributionApiPort {
  readonly #fetch: typeof fetch;
  readonly #storyEndpoint: string;
  readonly #libraryEndpoint: string;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    const base = apiBase.replace(/\/$/, "");
    this.#storyEndpoint = `${base}/api/extension/metadata`;
    this.#libraryEndpoint = `${base}/api/extension/library/metadata-refresh`;
  }

  async contribute(
    credential: string,
    command: MetadataContributionCommand,
  ): Promise<AuthenticatedEffectResult<MetadataContributionApiOutcome>> {
    const response = await this.#request(
      command.kind === "story_metadata"
        ? this.#storyEndpoint
        : this.#libraryEndpoint,
      credential,
      command.payload,
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
        value: { kind: "rejected", reason: "invalid_request" },
      };
    }
    if (response.status === 429) {
      return {
        kind: "success",
        value: { kind: "rejected", reason: "rate_limited" },
      };
    }
    if (!response.ok) {
      return { kind: "success", value: { kind: "unavailable" } };
    }

    const body = await this.#json(response);
    const data = isRecord(body) && body.success === true && isRecord(body.data)
      ? body.data
      : null;
    if (data === null) {
      return { kind: "success", value: { kind: "invalid_response" } };
    }
    if (command.kind === "story_metadata") {
      return Number.isSafeInteger(data.story_id) && (data.story_id as number) > 0
        ? { kind: "success", value: { kind: "accepted", updated: true } }
        : { kind: "success", value: { kind: "invalid_response" } };
    }
    return validCount(data.updated) && validCount(data.ignored)
      ? {
          kind: "success",
          value: { kind: "accepted", updated: data.updated > 0 },
        }
      : { kind: "success", value: { kind: "invalid_response" } };
  }

  async #request(
    url: string,
    credential: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<Response | null> {
    const abort = new AbortController();
    const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.#fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
    } catch {
      return null;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

export class BrowserMetadataPreferencePort
implements MetadataContributionPreferencePort {
  readonly #storage: BrowserStorage;

  constructor(storage: BrowserStorage) {
    this.#storage = storage;
  }

  async enabled(): Promise<boolean> {
    const value = await this.#storage.get(METADATA_PREFERENCE_KEY);
    return value[METADATA_PREFERENCE_KEY] !== false;
  }
}

export class TraceWebMetadataNotificationPort implements MetadataNotificationPort {
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

  async publish(): Promise<boolean> {
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
      type: "TRACE_LIBRARY_INVALIDATED",
      reason: "metadata",
      at: new Date().toISOString(),
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
        // A Trace tab without the bridge receiver does not make the metadata
        // contribution fail and must not trigger another API write.
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
