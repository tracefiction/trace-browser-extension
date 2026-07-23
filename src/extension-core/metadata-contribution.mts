import {
  sameAccountScope,
  type AccountScope,
} from "./session-model.mjs";
import type {
  AuthenticatedEffectResult,
  AuthenticatedExecutionResult,
} from "./session-service.mjs";

export type MetadataContributionCommand =
  | {
      readonly kind: "story_metadata";
      readonly hostKind: "ao3" | "ffn";
      readonly workKeys: readonly [string];
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "library_metadata_refresh";
      readonly hostKind: "ao3" | "ffn";
      readonly workKeys: readonly string[];
      readonly payload: Readonly<Record<string, unknown>>;
    };

export type MetadataContributionFailure =
  | "not_authenticated"
  | "auth_expired"
  | "rate_limited"
  | "invalid_request"
  | "invalid_response"
  | "unavailable"
  | "stale";

export type MetadataContributionResult =
  | {
      readonly kind: "accepted";
      readonly updated: boolean;
      readonly projection: "invalidated" | "unavailable" | "not_needed";
      readonly notification: "published" | "unavailable" | "not_needed";
    }
  | { readonly kind: "skipped"; readonly reason: "preference_disabled" }
  | { readonly kind: "failed"; readonly reason: MetadataContributionFailure };

export type MetadataContributionApiOutcome =
  | { readonly kind: "accepted"; readonly updated: boolean }
  | {
      readonly kind: "rejected";
      readonly reason: "rate_limited" | "invalid_request";
    }
  | { readonly kind: "invalid_response" }
  | { readonly kind: "unavailable" };

export interface MetadataContributionApiPort {
  contribute(
    credential: string,
    command: MetadataContributionCommand,
  ): Promise<AuthenticatedEffectResult<MetadataContributionApiOutcome>>;
}

export interface MetadataContributionSessionPort {
  publicationScope(): AccountScope | null;
  executeAuthenticated<T>(
    effect: (credential: string) => Promise<AuthenticatedEffectResult<T>>,
  ): Promise<AuthenticatedExecutionResult<T>>;
}

export interface MetadataContributionPreferencePort {
  enabled(): Promise<boolean>;
}

export interface MetadataContributionAuthorityPort {
  prepare(): Promise<void>;
}

export interface MetadataProjectionInvalidationPort {
  invalidate(): void;
}

export interface MetadataNotificationPort {
  publish(): Promise<boolean>;
}

interface MetadataContributionPorts {
  readonly session: MetadataContributionSessionPort;
  readonly api: MetadataContributionApiPort;
  readonly preference: MetadataContributionPreferencePort;
  readonly authority: MetadataContributionAuthorityPort;
  readonly projection: MetadataProjectionInvalidationPort;
  readonly notification: MetadataNotificationPort;
}

function failure(reason: MetadataContributionFailure): MetadataContributionResult {
  return Object.freeze({ kind: "failed", reason });
}

function executionFailure<T>(
  result: Exclude<AuthenticatedExecutionResult<T>, { readonly kind: "published" }>,
): MetadataContributionResult {
  if (result.kind === "stale") return failure("stale");
  if (result.kind === "auth_rejected") return failure("auth_expired");
  return failure("not_authenticated");
}

/**
 * Owns authenticated passive metadata contribution without owning DOM
 * extraction. Payload validation and transport-supplied sender validation happen
 * at the runtime boundary before this service is called.
 */
export class MetadataContributionService {
  readonly #ports: MetadataContributionPorts;

  constructor(ports: MetadataContributionPorts) {
    this.#ports = ports;
  }

  async execute(
    command: MetadataContributionCommand,
  ): Promise<MetadataContributionResult> {
    let enabled = true;
    try {
      enabled = await this.#ports.preference.enabled();
    } catch {
      // Match the existing fail-open preference read: a transient local
      // storage error must not silently change the user's default setting.
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

    const scope = this.#ports.session.publicationScope();
    if (scope === null) return failure("not_authenticated");

    let contribution = await this.#executeAuthenticated(command);
    if (
      contribution.kind === "auth_rejected" &&
      contribution.recovery === "connected"
    ) {
      // A 401/403 is definitive proof the first request did not mutate. It is
      // therefore safe to retry once with the refreshed capability.
      contribution = await this.#executeAuthenticated(command);
    }
    if (contribution.kind !== "published") return executionFailure(contribution);
    if (contribution.value.kind === "rejected") {
      return failure(contribution.value.reason);
    }
    if (contribution.value.kind === "invalid_response") {
      return failure("invalid_response");
    }
    if (contribution.value.kind === "unavailable") return failure("unavailable");
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return failure("stale");
    }
    if (!contribution.value.updated) {
      return Object.freeze({
        kind: "accepted",
        updated: false,
        projection: "not_needed",
        notification: "not_needed",
      });
    }

    let projection: "invalidated" | "unavailable" = "invalidated";
    try {
      this.#ports.projection.invalidate();
    } catch {
      projection = "unavailable";
    }
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return failure("stale");
    }

    let notification: "published" | "unavailable" = "unavailable";
    try {
      notification = await this.#ports.notification.publish()
        ? "published"
        : "unavailable";
    } catch {
      notification = "unavailable";
    }
    return Object.freeze({
      kind: "accepted",
      updated: true,
      projection,
      notification,
    });
  }

  #executeAuthenticated(
    command: MetadataContributionCommand,
  ): Promise<AuthenticatedExecutionResult<MetadataContributionApiOutcome>> {
    return this.#ports.session.executeAuthenticated((credential) =>
      this.#ports.api.contribute(credential, command)
    );
  }
}
