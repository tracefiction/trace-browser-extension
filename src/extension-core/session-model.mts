export const SESSION_ENVELOPE_VERSION = 1 as const;

export type DesiredSession = "disconnected" | "connected";

export interface SessionEnvelope {
  readonly version: typeof SESSION_ENVELOPE_VERSION;
  readonly epoch: number;
  readonly desired: DesiredSession;
  readonly accountId: string | null;
  readonly credentialRef: string | null;
}

export interface AccountScope {
  readonly accountId: string;
  readonly epoch: number;
}

export type SessionState =
  | "initializing"
  | "signed_out"
  | "connecting"
  | "verifying"
  | "connected"
  | "degraded"
  | "reconnect_required";

export type SessionReason =
  | "none"
  | "credential_absent"
  | "credential_rejected"
  | "provider_unavailable"
  | "account_unavailable"
  | "invalid_account_response"
  | "identity_conflict"
  | "malformed_envelope"
  | "unsupported_envelope"
  | "storage_unavailable"
  | "storage_write_failed"
  | "verification_unavailable";

export interface SessionModel {
  readonly state: SessionState;
  readonly epoch: number;
  readonly accountId: string | null;
  readonly publicationScope: AccountScope | null;
  readonly displayScope: AccountScope | null;
  readonly reason: SessionReason;
}

export interface SessionSnapshot {
  readonly state: SessionState;
  readonly accountId: string | null;
  readonly canExecuteAuthenticated: boolean;
  readonly reason: SessionReason;
}

export type SessionEvent =
  | {
      readonly type: "signed_out";
      readonly epoch: number;
      readonly reason?: "none" | "provider_unavailable";
    }
  | { readonly type: "connecting"; readonly epoch: number }
  | {
      readonly type: "verifying";
      readonly epoch: number;
      readonly accountId: string | null;
    }
  | { readonly type: "connected"; readonly scope: AccountScope }
  | {
      readonly type: "degraded";
      readonly epoch: number;
      readonly displayScope: AccountScope | null;
      readonly reason: "storage_unavailable" | "verification_unavailable";
    }
  | {
      readonly type: "reconnect_required";
      readonly epoch: number;
      readonly reason: Exclude<
        SessionReason,
        "none" | "storage_unavailable" | "verification_unavailable"
      >;
    };

export type ParsedEnvelope =
  | { readonly kind: "missing" }
  | {
      readonly kind: "invalid";
      readonly reason: "malformed_envelope" | "unsupported_envelope";
    }
  | { readonly kind: "valid"; readonly envelope: SessionEnvelope };

export const INITIAL_SESSION_ENVELOPE: SessionEnvelope = Object.freeze({
  version: SESSION_ENVELOPE_VERSION,
  epoch: 0,
  desired: "disconnected",
  accountId: null,
  credentialRef: null,
});

export const INITIAL_SESSION_MODEL: SessionModel = Object.freeze({
  state: "initializing",
  epoch: 0,
  accountId: null,
  publicationScope: null,
  displayScope: null,
  reason: "none",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

export function parseSessionEnvelope(raw: unknown): ParsedEnvelope {
  if (raw === null || raw === undefined) return { kind: "missing" };
  if (!isRecord(raw)) {
    return { kind: "invalid", reason: "malformed_envelope" };
  }
  if (raw.version !== SESSION_ENVELOPE_VERSION) {
    return { kind: "invalid", reason: "unsupported_envelope" };
  }
  if (!Number.isSafeInteger(raw.epoch) || (raw.epoch as number) < 0) {
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
      epoch: raw.epoch as number,
      desired: raw.desired,
      accountId: raw.accountId,
      credentialRef: raw.credentialRef,
    }),
  };
}

export function reduceSession(_model: SessionModel, event: SessionEvent): SessionModel {
  switch (event.type) {
    case "signed_out":
      return {
        state: "signed_out",
        epoch: event.epoch,
        accountId: null,
        publicationScope: null,
        displayScope: null,
        reason: event.reason ?? "none",
      };
    case "connecting":
      return {
        state: "connecting",
        epoch: event.epoch,
        accountId: null,
        publicationScope: null,
        displayScope: null,
        reason: "none",
      };
    case "verifying":
      return {
        state: "verifying",
        epoch: event.epoch,
        accountId: event.accountId,
        publicationScope: null,
        displayScope: null,
        reason: "none",
      };
    case "connected":
      return {
        state: "connected",
        epoch: event.scope.epoch,
        accountId: event.scope.accountId,
        publicationScope: event.scope,
        displayScope: event.scope,
        reason: "none",
      };
    case "degraded":
      return {
        state: "degraded",
        epoch: event.epoch,
        accountId: event.displayScope?.accountId ?? null,
        publicationScope: null,
        displayScope: event.displayScope,
        reason: event.reason,
      };
    case "reconnect_required":
      return {
        state: "reconnect_required",
        epoch: event.epoch,
        accountId: null,
        publicationScope: null,
        displayScope: null,
        reason: event.reason,
      };
  }
}

export function toSessionSnapshot(model: SessionModel): SessionSnapshot {
  return Object.freeze({
    state: model.state,
    accountId: model.accountId,
    canExecuteAuthenticated: model.publicationScope !== null,
    reason: model.reason,
  });
}

export function sameAccountScope(left: AccountScope | null, right: AccountScope | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.accountId === right.accountId &&
    left.epoch === right.epoch
  );
}
