import {
  INITIAL_SESSION_ENVELOPE,
  INITIAL_SESSION_MODEL,
  SESSION_ENVELOPE_VERSION,
  parseSessionEnvelope,
  reduceSession,
  toSessionSnapshot,
  type AccountScope,
  type ParsedEnvelope,
  type SessionEnvelope,
  type SessionEvent,
  type SessionModel,
  type SessionSnapshot,
} from "./session-model.mjs";

export type CredentialAcquisition =
  | { readonly kind: "credential"; readonly credential: string }
  | { readonly kind: "absent" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" };

export type VerificationResult =
  | { readonly kind: "verified"; readonly accountId: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "account_unavailable" }
  | { readonly kind: "invalid_response" }
  | { readonly kind: "unavailable" };

export type AuthenticatedEffectResult<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "auth_rejected" }
  | { readonly kind: "unavailable" };

export type AuthenticatedExecutionResult<T> =
  | { readonly kind: "published"; readonly value: T }
  | { readonly kind: "stale" | "unavailable" }
  | {
      readonly kind: "auth_rejected";
      readonly recovery: "connected" | "reconnect_required" | "stale";
    };

export type SessionActionResult =
  | {
      readonly kind: "completed";
      readonly state: "signed_out" | "connected" | "reconnect_required";
    }
  | { readonly kind: "ignored" | "stale" | "storage_error" | "unavailable" };

export interface SessionStoragePort {
  read(): Promise<unknown | null>;
  write(envelope: SessionEnvelope): Promise<void>;
}

export interface CredentialPort {
  acquire(purpose: "connect" | "refresh"): Promise<CredentialAcquisition>;
  cancelAcquisition?(): void;
  load(reference: string): Promise<string | null>;
  /**
   * Store an immutable credential value and return a reference unique to this
   * invocation. Deleting one reference must never delete or overwrite a value
   * stored by another invocation, including another refresh in the same epoch.
   */
  storeUnique(credential: string, epoch: number): Promise<string>;
  delete(reference: string): Promise<void>;
  /** Enqueue whole-store cleanup on the same lock as storeUnique. */
  clearAll(): Promise<void>;
}

export interface SessionApiPort {
  verifyCredential(credential: string): Promise<VerificationResult>;
}

export type DiagnosticCode =
  | "session_state_changed"
  | "storage_read_failed"
  | "storage_write_failed"
  | "credential_cleanup_failed"
  | "credential_provider_failed"
  | "verification_failed"
  | "stale_effect_discarded";

export interface DiagnosticEvent {
  readonly code: DiagnosticCode;
  readonly state: SessionModel["state"];
  readonly epoch: number;
}

export interface DiagnosticsPort {
  record(event: DiagnosticEvent): void;
}

export interface SessionServicePorts {
  readonly storage: SessionStoragePort;
  readonly credentials: CredentialPort;
  readonly api: SessionApiPort;
  readonly diagnostics: DiagnosticsPort;
}

interface PersistedVerificationPlan {
  readonly epoch: number;
  readonly credentialRef: string;
  readonly expectedAccountId: string | null;
  readonly rejectionPolicy: "reconnect" | "refresh";
}

interface RefreshPlan {
  readonly epoch: number;
  readonly expectedAccountId: string;
  readonly oldCredentialRef: string;
  readonly reason: "expiry" | "rejection";
}

const CAPABILITY_MARKER = Symbol("trace.extension.session-capability");

interface ExecutionCapability {
  readonly [CAPABILITY_MARKER]: true;
  readonly accountId: string;
  readonly epoch: number;
  readonly credential: string;
}

function disconnectedEnvelope(epoch: number): SessionEnvelope {
  return Object.freeze({
    version: SESSION_ENVELOPE_VERSION,
    epoch,
    desired: "disconnected",
    accountId: null,
    credentialRef: null,
  });
}

function connectedEnvelope(
  epoch: number,
  credentialRef: string | null,
  accountId: string | null,
): SessionEnvelope {
  return Object.freeze({
    version: SESSION_ENVELOPE_VERSION,
    epoch,
    desired: "connected",
    accountId,
    credentialRef,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAcquisition(value: unknown): CredentialAcquisition {
  if (!isRecord(value)) return { kind: "unavailable" };
  if (value.kind === "credential") {
    return isNonEmpty(value.credential)
      ? { kind: "credential", credential: value.credential }
      : { kind: "unavailable" };
  }
  if (value.kind === "absent" || value.kind === "cancelled" || value.kind === "unavailable") {
    return { kind: value.kind };
  }
  return { kind: "unavailable" };
}

function normalizeVerification(value: unknown): VerificationResult {
  if (!isRecord(value)) return { kind: "invalid_response" };
  if (value.kind === "verified") {
    return isNonEmpty(value.accountId)
      ? { kind: "verified", accountId: value.accountId }
      : { kind: "invalid_response" };
  }
  if (
    value.kind === "rejected" ||
    value.kind === "account_unavailable" ||
    value.kind === "invalid_response" ||
    value.kind === "unavailable"
  ) {
    return { kind: value.kind };
  }
  return { kind: "invalid_response" };
}

function normalizeEffectResult<T>(value: unknown): AuthenticatedEffectResult<T> {
  if (!isRecord(value)) return { kind: "unavailable" };
  if (value.kind === "success" && Object.hasOwn(value, "value")) {
    return { kind: "success", value: value.value as T };
  }
  if (value.kind === "auth_rejected" || value.kind === "unavailable") {
    return { kind: value.kind };
  }
  return { kind: "unavailable" };
}

function createCapability(
  accountId: string,
  epoch: number,
  credential: string,
): ExecutionCapability {
  return Object.freeze({
    [CAPABILITY_MARKER]: true as const,
    accountId,
    epoch,
    credential,
  });
}

export class SessionService {
  readonly #ports: SessionServicePorts;
  #model: SessionModel = INITIAL_SESSION_MODEL;
  #envelope: SessionEnvelope = INITIAL_SESSION_ENVELOPE;
  #reservation = 0;
  #capability: ExecutionCapability | null = null;
  #activeAcquisitionEpoch: number | null = null;
  #lockTail: Promise<void> = Promise.resolve();
  #initialization: Promise<PersistedVerificationPlan | null> | null = null;
  #start: Promise<SessionSnapshot> | null = null;

  constructor(ports: SessionServicePorts) {
    this.#ports = ports;
  }

  snapshot(): SessionSnapshot {
    return toSessionSnapshot(this.#model);
  }

  publicationScope(): AccountScope | null {
    return this.#copyScope(this.#model.publicationScope);
  }

  displayScope(): AccountScope | null {
    return this.#copyScope(this.#model.displayScope);
  }

  start(): Promise<SessionSnapshot> {
    this.#start ??= this.#startOnce();
    return this.#start.then(() => this.snapshot());
  }

  async connect(): Promise<SessionActionResult> {
    await this.#ensureInitialized();
    const start = await this.#withLock(async () => {
      if (this.#model.state !== "signed_out") return null;
      const epoch = this.#reserveNextEpoch();
      const persisted = await this.#persist(disconnectedEnvelope(epoch));
      if (!persisted) return { epoch, persisted: false as const };
      this.#transition({ type: "connecting", epoch });
      this.#activeAcquisitionEpoch = epoch;
      return { epoch, persisted: true as const };
    });

    if (start === null) return { kind: "ignored" };
    if (!start.persisted) return { kind: "storage_error" };

    let acquisition: CredentialAcquisition;
    try {
      acquisition = normalizeAcquisition(
        await this.#ports.credentials.acquire("connect"),
      );
    } catch {
      this.#record("credential_provider_failed");
      acquisition = { kind: "unavailable" };
    }
    if (acquisition.kind === "unavailable") {
      this.#record("credential_provider_failed");
    }

    if (acquisition.kind === "cancelled") {
      return this.#disconnectInternal(true, start.epoch);
    }
    if (acquisition.kind !== "credential") {
      return this.#withLock(async () => {
        if (!this.#isCurrentAcquisition(start.epoch)) return { kind: "stale" };
        this.#activeAcquisitionEpoch = null;
        this.#transition({
          type: "signed_out",
          epoch: start.epoch,
          reason: "provider_unavailable",
        });
        return { kind: "unavailable" };
      });
    }

    const stillCurrent = await this.#withLock(async () => this.#isCurrentAcquisition(start.epoch));
    if (!stillCurrent) {
      this.#record("stale_effect_discarded");
      return { kind: "stale" };
    }

    let credentialRef: string;
    try {
      credentialRef = await this.#ports.credentials.storeUnique(
        acquisition.credential,
        start.epoch,
      );
      if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
    } catch {
      this.#record("credential_provider_failed");
      return this.#withLock(async () => {
        if (!this.#isCurrentAcquisition(start.epoch)) return { kind: "stale" };
        this.#activeAcquisitionEpoch = null;
        this.#transition({
          type: "signed_out",
          epoch: start.epoch,
          reason: "provider_unavailable",
        });
        return { kind: "unavailable" };
      });
    }

    const admission = await this.#withLock(async () => {
      if (!this.#isCurrentAcquisition(start.epoch)) {
        this.#scheduleCredentialDelete(credentialRef);
        return "stale" as const;
      }
      this.#activeAcquisitionEpoch = null;
      const persisted = await this.#persist(
        connectedEnvelope(start.epoch, credentialRef, null),
      );
      if (!persisted) {
        this.#scheduleCredentialDelete(credentialRef);
        return "storage_error" as const;
      }
      this.#transition({ type: "verifying", epoch: start.epoch, accountId: null });
      return "admitted" as const;
    });
    if (admission !== "admitted") {
      this.#record("stale_effect_discarded");
      return { kind: admission };
    }

    return this.#verifyCredential({
      epoch: start.epoch,
      credentialRef,
      expectedAccountId: null,
      rejectionPolicy: "reconnect",
    }, acquisition.credential);
  }

  async cancelConnect(): Promise<SessionActionResult> {
    await this.#ensureInitialized();
    return this.#disconnectInternal(true);
  }

  async disconnect(): Promise<SessionActionResult> {
    await this.#ensureInitialized();
    return this.#disconnectInternal(false);
  }

  async reconnect(): Promise<SessionActionResult> {
    const disconnected = await this.disconnect();
    if (disconnected.kind !== "completed" || disconnected.state !== "signed_out") {
      return disconnected;
    }
    return this.connect();
  }

  async retry(): Promise<SessionActionResult> {
    await this.#ensureInitialized();
    const storageRetry = await this.#withLock(async () => (
      this.#model.state === "degraded" && this.#model.reason === "storage_unavailable"
        ? { epoch: this.#reservation }
        : null
    ));
    if (storageRetry !== null) return this.#retryStorageRead(storageRetry.epoch);

    const plan = await this.#withLock(async (): Promise<PersistedVerificationPlan | null> => {
      if (
        this.#model.state !== "degraded" ||
        this.#envelope.desired !== "connected" ||
        this.#envelope.credentialRef === null
      ) {
        return null;
      }
      this.#transition({
        type: "verifying",
        epoch: this.#reservation,
        accountId: this.#envelope.accountId,
      });
      return {
        epoch: this.#reservation,
        credentialRef: this.#envelope.credentialRef,
        expectedAccountId: this.#envelope.accountId,
        rejectionPolicy: this.#envelope.accountId === null ? "reconnect" : "refresh",
      };
    });
    if (plan === null) return { kind: "ignored" };
    return this.#verifyPersisted(plan);
  }

  async refreshForExpiry(): Promise<SessionActionResult> {
    await this.#ensureInitialized();
    const capability = await this.#withLock(async () => this.#capability);
    if (capability === null) return { kind: "ignored" };
    return this.#refreshFromCapability(capability, "expiry");
  }

  // This boundary is for the authenticated API adapter, not UI/content
  // surfaces. The production import gate must keep raw credentials confined to
  // that adapter when the kernel is wired in a later slice.
  async executeAuthenticated<T>(
    effect: (credential: string) => Promise<AuthenticatedEffectResult<T>>,
  ): Promise<AuthenticatedExecutionResult<T>> {
    await this.#ensureInitialized();
    const capability = await this.#withLock(async () => this.#capability);
    if (capability === null) return { kind: "unavailable" };

    let result: AuthenticatedEffectResult<T>;
    try {
      result = normalizeEffectResult(await effect(capability.credential));
    } catch {
      result = { kind: "unavailable" };
    }

    if (result.kind === "success") {
      return this.#withLock(async () => {
        if (!this.#isCurrentCapability(capability)) {
          this.#record("stale_effect_discarded");
          return { kind: "stale" };
        }
        return { kind: "published", value: result.value };
      });
    }

    if (result.kind === "unavailable") {
      return this.#withLock(async () => {
        if (!this.#isCurrentCapability(capability)) return { kind: "stale" };
        this.#capability = null;
        const scope: AccountScope = {
          accountId: capability.accountId,
          epoch: capability.epoch,
        };
        this.#transition({
          type: "degraded",
          epoch: capability.epoch,
          displayScope: scope,
          reason: "verification_unavailable",
        });
        return { kind: "unavailable" };
      });
    }

    const refresh = await this.#refreshFromCapability(capability, "rejection");
    if (refresh.kind === "stale" || refresh.kind === "ignored") {
      return { kind: "auth_rejected", recovery: "stale" };
    }
    return {
      kind: "auth_rejected",
      recovery: this.#model.state === "connected" ? "connected" : "reconnect_required",
    };
  }

  async #startOnce(): Promise<SessionSnapshot> {
    const plan = await this.#ensureInitialized();
    if (plan !== null) await this.#verifyPersisted(plan);
    return this.snapshot();
  }

  #ensureInitialized(): Promise<PersistedVerificationPlan | null> {
    this.#initialization ??= this.#initializeEnvelope();
    return this.#initialization;
  }

  async #initializeEnvelope(): Promise<PersistedVerificationPlan | null> {
    let raw: unknown;
    try {
      raw = await this.#ports.storage.read();
    } catch {
      return this.#withLock(async () => {
        this.#record("storage_read_failed");
        this.#transition({
          type: "degraded",
          epoch: this.#reservation,
          displayScope: null,
          reason: "storage_unavailable",
        });
        return null;
      });
    }

    const parsed = parseSessionEnvelope(raw);
    return this.#withLock(async () => this.#applyParsedEnvelope(parsed));
  }

  async #retryStorageRead(expectedEpoch: number): Promise<SessionActionResult> {
    let raw: unknown;
    try {
      raw = await this.#ports.storage.read();
    } catch {
      this.#record("storage_read_failed");
      return { kind: "unavailable" };
    }

    const parsed = parseSessionEnvelope(raw);
    const applied = await this.#withLock(async () => {
      if (
        this.#reservation !== expectedEpoch ||
        this.#model.state !== "degraded" ||
        this.#model.reason !== "storage_unavailable"
      ) {
        return { kind: "stale" as const, plan: null };
      }
      return { kind: "applied" as const, plan: this.#applyParsedEnvelope(parsed) };
    });
    if (applied.kind === "stale") return { kind: "stale" };
    if (applied.plan === null) {
      const state = this.#model.state;
      if (state === "signed_out" || state === "reconnect_required") {
        return { kind: "completed", state };
      }
      return { kind: "ignored" };
    }
    return this.#verifyPersisted(applied.plan);
  }

  #applyParsedEnvelope(parsed: ParsedEnvelope): PersistedVerificationPlan | null {
    if (parsed.kind === "missing") {
      this.#envelope = INITIAL_SESSION_ENVELOPE;
      this.#reservation = 0;
      this.#transition({ type: "signed_out", epoch: 0 });
      return null;
    }
    if (parsed.kind === "invalid") {
      this.#envelope = INITIAL_SESSION_ENVELOPE;
      this.#reservation = 0;
      this.#transition({
        type: "reconnect_required",
        epoch: 0,
        reason: parsed.reason,
      });
      return null;
    }

    this.#envelope = parsed.envelope;
    this.#reservation = parsed.envelope.epoch;
    if (parsed.envelope.desired === "disconnected") {
      this.#transition({ type: "signed_out", epoch: this.#reservation });
      return null;
    }
    if (parsed.envelope.credentialRef === null) {
      this.#transition({
        type: "reconnect_required",
        epoch: this.#reservation,
        reason: "credential_absent",
      });
      return null;
    }

    this.#transition({
      type: "verifying",
      epoch: this.#reservation,
      accountId: parsed.envelope.accountId,
    });
    return {
      epoch: this.#reservation,
      credentialRef: parsed.envelope.credentialRef,
      expectedAccountId: parsed.envelope.accountId,
      rejectionPolicy: parsed.envelope.accountId === null ? "reconnect" : "refresh",
    };
  }

  async #verifyPersisted(plan: PersistedVerificationPlan): Promise<SessionActionResult> {
    let credential: string | null;
    try {
      credential = await this.#ports.credentials.load(plan.credentialRef);
    } catch {
      this.#record("credential_provider_failed");
      return this.#degradeVerification(plan);
    }
    if (credential === null || !isNonEmpty(credential)) {
      return this.#clearCredentialReference(plan.epoch, "credential_absent");
    }
    return this.#verifyCredential(plan, credential);
  }

  async #verifyCredential(
    plan: PersistedVerificationPlan,
    credential: string,
  ): Promise<SessionActionResult> {
    let verification: VerificationResult;
    try {
      verification = normalizeVerification(
        await this.#ports.api.verifyCredential(credential),
      );
    } catch {
      verification = { kind: "unavailable" };
    }

    if (verification.kind === "unavailable") {
      this.#record("verification_failed");
      return this.#degradeVerification(plan);
    }

    if (verification.kind === "invalid_response") {
      return this.#clearCredentialReference(plan.epoch, "invalid_account_response");
    }

    if (verification.kind === "account_unavailable") {
      return this.#clearCredentialReference(plan.epoch, "account_unavailable");
    }

    if (verification.kind === "rejected") {
      if (plan.rejectionPolicy === "reconnect") {
        return this.#clearCredentialReference(plan.epoch, "credential_rejected");
      }
      const refreshPlan = await this.#withLock(async (): Promise<RefreshPlan | null> => {
        if (!this.#isCurrentEpoch(plan.epoch)) return null;
        return {
          epoch: plan.epoch,
          expectedAccountId: plan.expectedAccountId ?? "",
          oldCredentialRef: plan.credentialRef,
          reason: "rejection",
        };
      });
      if (refreshPlan === null) return { kind: "stale" };
      return this.#performRefresh(refreshPlan);
    }

    if (!isNonEmpty(verification.accountId)) {
      return this.#clearCredentialReference(plan.epoch, "identity_conflict");
    }

    if (
      plan.expectedAccountId !== null &&
      verification.accountId !== plan.expectedAccountId
    ) {
      return this.#clearCredentialReference(plan.epoch, "identity_conflict");
    }
    return this.#commitVerified(
      plan.epoch,
      plan.credentialRef,
      verification.accountId,
      credential,
    );
  }

  async #refreshFromCapability(
    capability: ExecutionCapability,
    reason: RefreshPlan["reason"],
  ): Promise<SessionActionResult> {
    const plan = await this.#withLock(async (): Promise<RefreshPlan | null> => {
      if (!this.#isCurrentCapability(capability)) return null;
      if (this.#envelope.credentialRef === null) return null;
      this.#capability = null;
      this.#transition({
        type: "verifying",
        epoch: capability.epoch,
        accountId: capability.accountId,
      });
      return {
        epoch: capability.epoch,
        expectedAccountId: capability.accountId,
        oldCredentialRef: this.#envelope.credentialRef,
        reason,
      };
    });
    if (plan === null) return { kind: "stale" };
    return this.#performRefresh(plan);
  }

  async #performRefresh(plan: RefreshPlan): Promise<SessionActionResult> {
    let acquisition: CredentialAcquisition;
    try {
      acquisition = normalizeAcquisition(
        await this.#ports.credentials.acquire("refresh"),
      );
    } catch {
      this.#record("credential_provider_failed");
      acquisition = { kind: "unavailable" };
    }
    if (acquisition.kind === "unavailable") {
      this.#record("credential_provider_failed");
    }

    if (acquisition.kind !== "credential") {
      if (plan.reason === "rejection") {
        return this.#clearCredentialReference(plan.epoch, "credential_rejected");
      }
      return this.#degradeRefresh(plan);
    }

    let verification: VerificationResult;
    try {
      verification = normalizeVerification(
        await this.#ports.api.verifyCredential(acquisition.credential),
      );
    } catch {
      verification = { kind: "unavailable" };
    }

    if (verification.kind === "unavailable") {
      if (plan.reason === "rejection") {
        return this.#clearCredentialReference(plan.epoch, "credential_rejected");
      }
      return this.#degradeRefresh(plan);
    }
    if (verification.kind === "invalid_response") {
      return this.#clearCredentialReference(plan.epoch, "invalid_account_response");
    }
    if (verification.kind === "account_unavailable") {
      return this.#clearCredentialReference(plan.epoch, "account_unavailable");
    }
    if (
      verification.kind === "rejected" ||
      (plan.expectedAccountId.length > 0 && verification.accountId !== plan.expectedAccountId)
    ) {
      return this.#clearCredentialReference(
        plan.epoch,
        verification.kind === "rejected" ? "credential_rejected" : "identity_conflict",
      );
    }

    let credentialRef: string;
    try {
      credentialRef = await this.#ports.credentials.storeUnique(
        acquisition.credential,
        plan.epoch,
      );
      if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
    } catch {
      if (plan.reason === "rejection") {
        return this.#clearCredentialReference(plan.epoch, "credential_rejected");
      }
      return this.#degradeRefresh(plan);
    }

    const accountId = plan.expectedAccountId.length > 0
      ? plan.expectedAccountId
      : verification.accountId;
    const committed = await this.#commitVerified(
      plan.epoch,
      credentialRef,
      accountId,
      acquisition.credential,
      plan.oldCredentialRef,
    );
    if (committed.kind !== "completed" || committed.state !== "connected") {
      this.#scheduleCredentialDelete(credentialRef);
      return committed;
    }
    return committed;
  }

  async #degradeVerification(
    plan: PersistedVerificationPlan,
  ): Promise<SessionActionResult> {
    return this.#withLock(async () => {
      if (!this.#isCurrentEpoch(plan.epoch)) return { kind: "stale" };
      const displayScope = plan.expectedAccountId === null
        ? null
        : { accountId: plan.expectedAccountId, epoch: plan.epoch };
      this.#transition({
        type: "degraded",
        epoch: plan.epoch,
        displayScope,
        reason: "verification_unavailable",
      });
      return { kind: "unavailable" };
    });
  }

  async #degradeRefresh(plan: RefreshPlan): Promise<SessionActionResult> {
    return this.#withLock(async () => {
      if (!this.#isCurrentEpoch(plan.epoch)) return { kind: "stale" };
      this.#transition({
        type: "degraded",
        epoch: plan.epoch,
        displayScope: {
          accountId: plan.expectedAccountId,
          epoch: plan.epoch,
        },
        reason: "verification_unavailable",
      });
      return { kind: "unavailable" };
    });
  }

  async #commitVerified(
    epoch: number,
    credentialRef: string,
    accountId: string,
    credential: string,
    cleanupReference: string | null = null,
  ): Promise<SessionActionResult> {
    return this.#withLock(async () => {
      if (!this.#isCurrentEpoch(epoch)) {
        this.#record("stale_effect_discarded");
        return { kind: "stale" };
      }
      const persisted = await this.#persist(
        connectedEnvelope(epoch, credentialRef, accountId),
      );
      if (!persisted) return { kind: "storage_error" };
      this.#capability = createCapability(accountId, epoch, credential);
      this.#transition({ type: "connected", scope: { accountId, epoch } });
      if (cleanupReference !== null && cleanupReference !== credentialRef) {
        this.#scheduleCredentialDelete(cleanupReference);
      }
      return { kind: "completed", state: "connected" };
    });
  }

  async #clearCredentialReference(
    epoch: number,
    reason:
      | "credential_absent"
      | "credential_rejected"
      | "identity_conflict"
      | "account_unavailable"
      | "invalid_account_response",
  ): Promise<SessionActionResult> {
    return this.#withLock(async (): Promise<SessionActionResult> => {
      if (!this.#isCurrentEpoch(epoch)) return { kind: "stale" };
      const oldReference = this.#envelope.credentialRef;
      this.#capability = null;
      const persisted = await this.#persist(
        connectedEnvelope(epoch, null, this.#envelope.accountId),
      );
      const result: SessionActionResult = persisted
        ? { kind: "completed", state: "reconnect_required" }
        : { kind: "storage_error" };
      if (persisted) {
        this.#transition({ type: "reconnect_required", epoch, reason });
      }
      if (oldReference !== null) {
        if (persisted) {
          this.#scheduleCredentialDelete(oldReference);
        } else {
          // Without the envelope write, deleting the referenced credential is
          // the restart fence. It must settle before this failed transition
          // returns; platform adapters must apply their own bounded timeout.
          await this.#deleteCredential(oldReference);
        }
      }
      return result;
    });
  }

  async #disconnectInternal(
    onlyConnecting: boolean,
    expectedAcquisitionEpoch?: number,
  ): Promise<SessionActionResult> {
    return this.#withLock(async (): Promise<SessionActionResult> => {
      const isUnverifiedConnect =
        this.#model.state === "connecting" ||
        (this.#model.state === "verifying" && this.#envelope.accountId === null);
      if (onlyConnecting && !isUnverifiedConnect) {
        return expectedAcquisitionEpoch !== undefined &&
          !this.#isCurrentEpoch(expectedAcquisitionEpoch)
          ? { kind: "stale" }
          : { kind: "ignored" };
      }
      if (
        expectedAcquisitionEpoch !== undefined &&
        this.#activeAcquisitionEpoch !== expectedAcquisitionEpoch
      ) {
        return { kind: "stale" };
      }

      const oldReference = this.#envelope.credentialRef;
      const epoch = this.#reserveNextEpoch();
      this.#capability = null;
      this.#activeAcquisitionEpoch = null;
      try {
        this.#ports.credentials.cancelAcquisition?.();
      } catch {
        this.#record("credential_provider_failed");
      }
      const persisted = await this.#persist(disconnectedEnvelope(epoch));
      const result: SessionActionResult = persisted
        ? { kind: "completed", state: "signed_out" }
        : { kind: "storage_error" };
      if (persisted) this.#transition({ type: "signed_out", epoch });
      if (persisted) {
        // Disconnect is destructive even when the current envelope has no
        // reference: stale writes may have left unreferenced credentials.
        this.#scheduleCredentialClearAll();
      } else if (oldReference !== null) {
        // A failed Disconnect write leaves the old envelope durable. The
        // credential deletion is therefore the only restart-safe fence.
        await this.#deleteCredential(oldReference);
      }
      return result;
    });
  }

  #reserveNextEpoch(): number {
    if (!Number.isSafeInteger(this.#reservation + 1)) {
      throw new RangeError("session epoch exhausted");
    }
    this.#reservation += 1;
    this.#capability = null;
    return this.#reservation;
  }

  async #persist(envelope: SessionEnvelope): Promise<boolean> {
    try {
      await this.#ports.storage.write(envelope);
      this.#envelope = envelope;
      return true;
    } catch {
      this.#capability = null;
      this.#transition({
        type: "reconnect_required",
        epoch: this.#reservation,
        reason: "storage_write_failed",
      });
      this.#record("storage_write_failed");
      return false;
    }
  }

  async #deleteCredential(reference: string): Promise<void> {
    try {
      await this.#ports.credentials.delete(reference);
    } catch {
      this.#record("credential_cleanup_failed");
    }
  }

  #scheduleCredentialDelete(reference: string): void {
    // The durable envelope and capability fence own correctness. Cleanup is
    // deliberately detached so a stuck platform store cannot hold the session
    // lock or delay an accepted Disconnect/refresh transition.
    void this.#deleteCredential(reference);
  }

  #scheduleCredentialClearAll(): void {
    // Calling clearAll synchronously enqueues it on the credential adapter's
    // lock before a later Connect can enqueue storeUnique. Do not await it:
    // accepted Disconnect must not hang on best-effort hygiene.
    try {
      void this.#ports.credentials.clearAll().catch(() => {
        this.#record("credential_cleanup_failed");
      });
    } catch {
      this.#record("credential_cleanup_failed");
    }
  }

  #copyScope(scope: AccountScope | null): AccountScope | null {
    return scope === null
      ? null
      : Object.freeze({ accountId: scope.accountId, epoch: scope.epoch });
  }

  #isCurrentEpoch(epoch: number): boolean {
    return this.#reservation === epoch && this.#envelope.epoch === epoch;
  }

  #isCurrentAcquisition(epoch: number): boolean {
    return (
      this.#isCurrentEpoch(epoch) &&
      this.#activeAcquisitionEpoch === epoch &&
      this.#model.state === "connecting"
    );
  }

  #isCurrentCapability(capability: ExecutionCapability): boolean {
    return (
      this.#capability === capability &&
      this.#reservation === capability.epoch &&
      this.#model.state === "connected"
    );
  }

  #transition(event: SessionEvent): void {
    this.#model = reduceSession(this.#model, event);
    this.#record("session_state_changed");
  }

  #record(code: DiagnosticCode): void {
    try {
      this.#ports.diagnostics.record({
        code,
        state: this.#model.state,
        epoch: this.#reservation,
      });
    } catch {
      // Diagnostics can never become a session authority or correctness dependency.
    }
  }

  async #withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#lockTail;
    let release = (): void => {};
    this.#lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
