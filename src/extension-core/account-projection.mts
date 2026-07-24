import type {
  AccountDataV1,
  AccountOverlay,
  AccountSummary,
} from "./account-data.mjs";
import {
  sameAccountScope,
  type AccountScope,
} from "./session-model.mjs";
import type {
  AuthenticatedEffectResult,
  AuthenticatedExecutionResult,
} from "./session-service.mjs";

export type ProjectionPart<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "invalid_response" | "unavailable" };

export interface AccountProjectionFetch {
  readonly overlay: ProjectionPart<AccountOverlay>;
  readonly summary: ProjectionPart<Readonly<{
    accountId: string;
    value: AccountSummary;
  }>>;
}

export interface AccountProjectionApiPort {
  load(credential: string): Promise<AuthenticatedEffectResult<AccountProjectionFetch>>;
}

export type AccountProjectionWriteResult =
  | { readonly kind: "published"; readonly value: AccountDataV1 }
  | { readonly kind: "rejected_scope" | "invalid_model" | "stale_write" };

export interface AccountProjectionRepositoryPort {
  read(): Promise<AccountDataV1 | null>;
  reserveOverlayWrite(): number;
  publishOverlay(
    scope: AccountScope,
    overlay: AccountOverlay,
    reservation: number,
  ): Promise<AccountProjectionWriteResult>;
  publishSummary(
    scope: AccountScope,
    summary: AccountSummary,
  ): Promise<AccountProjectionWriteResult>;
}

export interface AccountProjectionSessionPort {
  displayScope(): AccountScope | null;
  publicationScope(): AccountScope | null;
  executeAuthenticated<T>(
    effect: (credential: string) => Promise<AuthenticatedEffectResult<T>>,
  ): Promise<AuthenticatedExecutionResult<T>>;
}

export interface AccountProjectionClock {
  now(): number;
}

export type AccountProjectionRefreshResult =
  | { readonly kind: "current" }
  | {
      readonly kind: "refreshed";
      readonly overlay: "published" | "stale" | "invalid" | "unavailable";
      readonly summary: "published" | "invalid" | "unavailable";
    }
  | {
      readonly kind:
        | "not_authenticated"
        | "auth_expired"
        | "stale"
        | "unavailable";
    };

interface AccountProjectionPorts {
  readonly session: AccountProjectionSessionPort;
  readonly api: AccountProjectionApiPort;
  readonly repository: AccountProjectionRepositoryPort;
  readonly clock: AccountProjectionClock;
  readonly maxAgeMs?: number;
}

function scopeKey(scope: AccountScope): string {
  return `${scope.accountId}:${scope.epoch}`;
}

export class AccountProjectionService {
  readonly #ports: AccountProjectionPorts;
  readonly #maxAgeMs: number;
  #lastRefresh: Readonly<{ scope: string; at: number }> | null = null;
  #inflight: Readonly<{
    scope: string;
    generation: number;
    promise: Promise<AccountProjectionRefreshResult>;
  }> | null = null;
  #invalidationGeneration = 0;

  constructor(ports: AccountProjectionPorts) {
    this.#ports = ports;
    this.#maxAgeMs = ports.maxAgeMs ?? 30_000;
  }

  async read(options: Readonly<{ refresh?: boolean }> = {}): Promise<AccountDataV1 | null> {
    if (options.refresh !== false) await this.refreshIfNeeded();
    return this.#ports.repository.read();
  }

  invalidate(): void {
    this.#invalidationGeneration += 1;
    this.#lastRefresh = null;
  }

  refreshIfNeeded(force = false): Promise<AccountProjectionRefreshResult> {
    const scope = this.#ports.session.publicationScope();
    if (scope === null) {
      return Promise.resolve({ kind: "not_authenticated" });
    }
    const key = scopeKey(scope);
    const generation = this.#invalidationGeneration;
    if (this.#inflight?.scope === key) {
      if (this.#inflight.generation === generation) return this.#inflight.promise;
      return this.#inflight.promise.then(() => this.refreshIfNeeded(true));
    }
    if (
      !force &&
      this.#lastRefresh?.scope === key &&
      this.#ports.clock.now() - this.#lastRefresh.at < this.#maxAgeMs
    ) {
      return Promise.resolve({ kind: "current" });
    }

    const promise = this.#refresh(scope, generation).finally(() => {
      if (this.#inflight?.promise === promise) this.#inflight = null;
    });
    this.#inflight = Object.freeze({ scope: key, generation, promise });
    return promise;
  }

  async #refresh(
    scope: AccountScope,
    generation: number,
  ): Promise<AccountProjectionRefreshResult> {
    let reservation = this.#ports.repository.reserveOverlayWrite();
    let fetched = await this.#ports.session.executeAuthenticated((credential) =>
      this.#ports.api.load(credential)
    );
    if (fetched.kind === "auth_rejected" && fetched.recovery === "connected") {
      reservation = this.#ports.repository.reserveOverlayWrite();
      fetched = await this.#ports.session.executeAuthenticated((credential) =>
        this.#ports.api.load(credential)
      );
    }
    if (fetched.kind === "auth_rejected") return { kind: "auth_expired" };
    if (fetched.kind === "stale") return { kind: "stale" };
    if (fetched.kind !== "published") return { kind: "unavailable" };
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return { kind: "stale" };
    }

    let overlay: "published" | "stale" | "invalid" | "unavailable";
    if (fetched.value.overlay.kind === "value") {
      try {
        const result = await this.#ports.repository.publishOverlay(
          scope,
          fetched.value.overlay.value,
          reservation,
        );
        overlay = result.kind === "published"
          ? "published"
          : result.kind === "stale_write"
            ? "stale"
            : result.kind === "invalid_model"
              ? "invalid"
              : "stale";
      } catch {
        overlay = "unavailable";
      }
    } else {
      overlay = fetched.value.overlay.kind === "invalid_response"
        ? "invalid"
        : "unavailable";
    }

    let summary: "published" | "invalid" | "unavailable";
    if (fetched.value.summary.kind === "value") {
      if (fetched.value.summary.value.accountId !== scope.accountId) {
        summary = "invalid";
      } else {
        try {
          const result = await this.#ports.repository.publishSummary(
            scope,
            fetched.value.summary.value.value,
          );
          summary = result.kind === "published"
            ? "published"
            : result.kind === "invalid_model"
              ? "invalid"
              : "unavailable";
        } catch {
          summary = "unavailable";
        }
      }
    } else {
      summary = fetched.value.summary.kind === "invalid_response"
        ? "invalid"
        : "unavailable";
    }

    if (
      sameAccountScope(this.#ports.session.displayScope(), scope) &&
      generation === this.#invalidationGeneration &&
      (overlay === "published" || summary === "published")
    ) {
      this.#lastRefresh = Object.freeze({
        scope: scopeKey(scope),
        at: this.#ports.clock.now(),
      });
    }
    return Object.freeze({ kind: "refreshed", overlay, summary });
  }
}
