import {
  copyLibraryOverlayEntry,
  type AuthenticatedEffectResult,
  type ConfirmedStorySave,
  type StoryCommandApiPort,
  type StoryLookupOutcome,
  type StoryMutationOutcome,
  type StoryProjectionPort,
  type StoryTrackCommand,
  type AccountScope,
} from "../extension-core/index.mjs";
import { AccountDataRepository } from "./account-data-repository.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_KEY_PATTERN = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
const REQUEST_TIMEOUT_MS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function confirmedStorySave(
  value: unknown,
  expectedWorkKey: string,
): ConfirmedStorySave | null {
  if (!isRecord(value)) return null;
  const workKey = typeof value.work_key === "string" ? value.work_key.trim() : "";
  const entryId = typeof value.entry_id === "string" ? value.entry_id.trim() : "";
  const entry = copyLibraryOverlayEntry(value.entry);
  if (
    workKey !== expectedWorkKey ||
    !WORK_KEY_PATTERN.test(workKey) ||
    !UUID_PATTERN.test(entryId) ||
    entry === null ||
    entry.entryId !== entryId ||
    !isIsoTimestamp(value.syncVersion)
  ) {
    return null;
  }
  return Object.freeze({
    workKey,
    entryId,
    entry,
    syncVersion: value.syncVersion,
  });
}

export class StoryCommandApi implements StoryCommandApiPort {
  readonly #fetch: typeof fetch;
  readonly #trackEndpoint: string;
  readonly #overlayEndpoint: string;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    const base = apiBase.replace(/\/$/, "");
    this.#trackEndpoint = `${base}/api/extension/track`;
    this.#overlayEndpoint = `${base}/api/extension/library-overlay`;
  }

  async lookup(
    credential: string,
    workKey: string,
  ): Promise<AuthenticatedEffectResult<StoryLookupOutcome>> {
    const response = await this.#request(this.#overlayEndpoint, credential, {
      method: "GET",
      cache: "no-store",
    });
    if (response === null) return { kind: "success", value: { kind: "unavailable" } };
    if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
    if (!response.ok) return { kind: "success", value: { kind: "unavailable" } };

    const body = await this.#json(response);
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    if (
      data === null ||
      !isRecord(data.entries) ||
      !isIsoTimestamp(data.syncVersion)
    ) {
      return { kind: "success", value: { kind: "invalid_response" } };
    }
    const rawEntry = data.entries[workKey];
    if (rawEntry === undefined) return { kind: "success", value: { kind: "absent" } };
    const entry = copyLibraryOverlayEntry(rawEntry);
    const entryId = entry?.entryId;
    if (entry === null || typeof entryId !== "string" || !UUID_PATTERN.test(entryId)) {
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
          syncVersion: data.syncVersion,
        }),
      },
    };
  }

  async track(
    credential: string,
    command: StoryTrackCommand,
  ): Promise<AuthenticatedEffectResult<StoryMutationOutcome>> {
    const response = await this.#request(this.#trackEndpoint, credential, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command.payload),
    });
    if (response === null) return { kind: "success", value: { kind: "uncertain" } };
    if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
    if (response.status === 400) {
      return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
    }
    if (response.status === 402) {
      return {
        kind: "success",
        value: { kind: "rejected", reason: "free_limit_reached" },
      };
    }
    if (response.status === 429) {
      return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
    }
    if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };

    const body = await this.#json(response);
    const confirmation = confirmedStorySave(
      isRecord(body) ? body.data : null,
      command.workKey,
    );
    return confirmation === null
      ? { kind: "success", value: { kind: "uncertain" } }
      : { kind: "success", value: { kind: "confirmed", confirmation } };
  }

  async #request(
    url: string,
    credential: string,
    init: RequestInit,
  ): Promise<Response | null> {
    const abort = new AbortController();
    const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.#fetch(url, {
        ...init,
        signal: abort.signal,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${credential}`,
        },
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

export class AccountStoryProjectionPort implements StoryProjectionPort {
  readonly #repository: AccountDataRepository;

  constructor(repository: AccountDataRepository) {
    this.#repository = repository;
  }

  async publishConfirmed(
    scope: AccountScope,
    confirmation: ConfirmedStorySave,
  ): Promise<
    | { readonly kind: "published" }
    | {
        readonly kind:
          | "rejected_scope"
          | "invalid_model"
          | "stale_write"
          | "unavailable";
      }
  > {
    try {
      const result = await this.#repository.publishConfirmedStory(scope, confirmation);
      return result.kind === "published" ? { kind: "published" } : result;
    } catch {
      return { kind: "unavailable" };
    }
  }
}
