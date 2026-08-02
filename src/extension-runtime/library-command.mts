import type {
  AccountDataV1,
  AccountProjectionRefreshResult,
  AuthenticatedEffectResult,
  FinishQualificationCommand,
  FinishQualificationOutcome,
  LibraryCommandApiPort,
  LibraryCommandProjectionPort,
  LibraryMutationCommand,
  LibraryMutationOutcome,
  LibraryProjectionReadResult,
} from "../extension-core/index.mjs";
import { AccountProjectionService } from "../extension-core/index.mjs";

const REQUEST_TIMEOUT_MS = 12_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LibraryCommandApi implements LibraryCommandApiPort {
  readonly #fetch: typeof fetch;
  readonly #libraryEndpoint: string;
  readonly #preferenceEndpoint: string;
  readonly #finishEndpoint: string;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    const base = apiBase.replace(/\/$/, "");
    this.#libraryEndpoint = `${base}/api/extension/library`;
    this.#preferenceEndpoint = `${base}/api/extension/work-preferences`;
    this.#finishEndpoint = `${base}/api/extension/finish-qualification`;
  }

  async mutate(
    credential: string,
    command: LibraryMutationCommand,
  ): Promise<AuthenticatedEffectResult<LibraryMutationOutcome>> {
    const url = command.kind === "entry_patch"
      ? `${this.#libraryEndpoint}/${encodeURIComponent(command.entryId)}`
      : this.#preferenceEndpoint;
    const response = await this.#request(url, credential, {
      method: command.kind === "entry_patch" ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        command.kind === "entry_patch"
          ? command.patch
          : { key: command.workKey, hidden: command.hidden },
      ),
    });
    if (response === null) return { kind: "success", value: { kind: "uncertain" } };
    if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
    if (response.status === 400 || response.status === 404) {
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
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    const confirmed = command.kind === "entry_patch"
      ? data !== null &&
        typeof data.entry_id === "string" &&
        UUID_PATTERN.test(data.entry_id) &&
        data.entry_id === command.entryId
      : data !== null &&
        data.key === command.workKey &&
        isRecord(data.browsePreference) &&
        data.browsePreference.hidden === command.hidden;
    return {
      kind: "success",
      value: confirmed ? { kind: "accepted" } : { kind: "uncertain" },
    };
  }

  async qualifyFinish(
    credential: string,
    command: FinishQualificationCommand,
  ): Promise<AuthenticatedEffectResult<FinishQualificationOutcome>> {
    const response = await this.#request(this.#finishEndpoint, credential, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryId: command.entryId,
        workKey: command.workKey,
        source: command.source,
        chapter: command.chapter,
        total: command.total,
        state: command.state,
        ...(command.state === "resolved"
          ? {
              workStatus: command.workStatus,
              readerStatus: command.readerStatus,
            }
          : {}),
      }),
    });
    if (response === null) return { kind: "success", value: { kind: "uncertain" } };
    if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
    if (response.status === 400 || response.status === 404) {
      return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
    }
    if (response.status === 429) {
      return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
    }
    if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };
    const body = await this.#json(response);
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    if (
      data === null ||
      (
        data.state !== "open" &&
        data.state !== "resolved" &&
        data.state !== "ignored"
      ) ||
      (
        data.eventId !== null &&
        (typeof data.eventId !== "string" || !UUID_PATTERN.test(data.eventId))
      )
    ) {
      return { kind: "success", value: { kind: "uncertain" } };
    }
    return {
      kind: "success",
      value: {
        kind: "acknowledged",
        state: data.state,
        eventId: data.eventId as string | null,
      },
    };
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

function refreshFailure(
  result: AccountProjectionRefreshResult,
): Exclude<LibraryProjectionReadResult, { readonly kind: "value" }> | null {
  if (result.kind === "not_authenticated") return { kind: "not_authenticated" };
  if (result.kind === "auth_expired") return { kind: "auth_expired" };
  if (result.kind === "stale") return { kind: "stale" };
  if (result.kind === "unavailable") return { kind: "unavailable" };
  if (
    result.kind === "refreshed" &&
    result.overlay !== "published" &&
    result.overlay !== "stale"
  ) {
    return { kind: "unavailable" };
  }
  return null;
}

export class AccountLibraryCommandProjection implements LibraryCommandProjectionPort {
  readonly #projection: AccountProjectionService;

  constructor(projection: AccountProjectionService) {
    this.#projection = projection;
  }

  async refreshAndRead(): Promise<LibraryProjectionReadResult> {
    const refreshed = await this.#projection.refreshIfNeeded(true);
    const failure = refreshFailure(refreshed);
    if (failure !== null) return failure;
    const value: AccountDataV1 | null = await this.#projection.read({ refresh: false });
    return value === null ? { kind: "unavailable" } : { kind: "value", value };
  }
}
