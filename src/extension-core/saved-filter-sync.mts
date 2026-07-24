import {
  sameAccountScope,
  type AccountScope,
} from "./session-model.mjs";
import type {
  AuthenticatedEffectResult,
  AuthenticatedExecutionResult,
} from "./session-service.mjs";

export const SAVED_FILTER_ACTIVE_LIMIT = 250;
export const SAVED_FILTER_SYNC_BATCH_LIMIT = 100;
export const SAVED_FILTER_SYNC_MAX_ITERATIONS = 10;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const PARAM_KEY_PATTERN =
  /^(?:work_search|include_work_search|exclude_work_search)\[[a-z0-9_]+\](?:\[\])?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REMOTE_ROWS = SAVED_FILTER_ACTIVE_LIMIT * 2;
const MAX_LOCAL_TOMBSTONES = 10_000;

export interface SavedFilterPreset {
  readonly id: string;
  readonly clientId: string;
  readonly serverId: string;
  readonly name: string;
  readonly params: readonly (readonly [string, string])[];
  readonly scope: "context" | "global";
  readonly contextKey: string;
  readonly contextLabel: string;
  readonly summary: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly clientUpdatedAt: string;
  readonly dirty: boolean;
}

export interface SavedFilterDeletion {
  readonly id: string;
  readonly clientId: string;
  readonly serverId: string;
  readonly clientUpdatedAt: string;
}

export interface SavedFilterActiveMeta {
  readonly id: string;
  readonly signature: string;
  readonly contextKey: string;
  readonly appliedAt: string;
}

export interface SavedFilterSnapshot {
  readonly presets: readonly SavedFilterPreset[];
  readonly deleted: readonly SavedFilterDeletion[];
  readonly activeMeta: SavedFilterActiveMeta | null;
  readonly syncVersion: string | null;
  readonly lastSyncedAt: string | null;
  readonly clientId: string | null;
}

export interface SavedFilterUpsert {
  readonly id?: string;
  readonly clientId: string;
  readonly name: string;
  readonly scope: "context" | "global";
  readonly contextKey: string | null;
  readonly contextLabel: string | null;
  readonly params: readonly (readonly [string, string])[];
  readonly summary: readonly string[];
  readonly createdAt: string;
  readonly clientUpdatedAt: string;
}

export interface SavedFilterDelete {
  readonly id?: string;
  readonly clientId: string;
  readonly clientUpdatedAt: string;
}

export interface SavedFilterSyncRequest {
  readonly clientId: string;
  readonly since: string | null;
  readonly upserts: readonly SavedFilterUpsert[];
  readonly deletes: readonly SavedFilterDelete[];
}

export interface RemoteSavedFilterPreset {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly scope: "context" | "global";
  readonly contextKey: string | null;
  readonly contextLabel: string | null;
  readonly params: readonly (readonly [string, string])[];
  readonly summary: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly clientUpdatedAt: string;
}

export interface RemoteSavedFilterDeletion {
  readonly id: string;
  readonly clientId: string;
  readonly deletedAt: string;
  readonly updatedAt: string;
  readonly clientUpdatedAt: string;
}

export interface SavedFilterSyncData {
  readonly serverTime: string;
  readonly syncVersion: string;
  readonly presets: readonly RemoteSavedFilterPreset[];
  readonly deleted: readonly RemoteSavedFilterDeletion[];
}

export type SavedFilterSyncFailure =
  | "not_authenticated"
  | "auth_expired"
  | "rate_limited"
  | "limit_reached"
  | "invalid_request"
  | "invalid_response"
  | "storage_unavailable"
  | "unavailable"
  | "stale";

export type SavedFilterSyncResult =
  | {
      readonly kind: "completed" | "partial";
      readonly syncVersion: string;
      readonly requests: number;
    }
  | {
      readonly kind: "failed";
      readonly reason: SavedFilterSyncFailure;
      readonly limit?: number;
    };

export type SavedFilterSyncApiOutcome =
  | { readonly kind: "accepted"; readonly data: SavedFilterSyncData }
  | {
      readonly kind: "rejected";
      readonly reason: "rate_limited" | "limit_reached" | "invalid_request";
      readonly limit?: number;
    }
  | { readonly kind: "invalid_response" }
  | { readonly kind: "unavailable" };

export interface SavedFilterSyncApiPort {
  sync(
    credential: string,
    request: SavedFilterSyncRequest,
  ): Promise<AuthenticatedEffectResult<SavedFilterSyncApiOutcome>>;
}

export interface SavedFilterSyncSessionPort {
  publicationScope(): AccountScope | null;
  executeAuthenticated<T>(
    effect: (credential: string) => Promise<AuthenticatedEffectResult<T>>,
  ): Promise<AuthenticatedExecutionResult<T>>;
}

export interface SavedFilterSyncRepositoryPort {
  read(): Promise<SavedFilterSnapshot | null>;
  merge(
    requestedScope: AccountScope,
    data: SavedFilterSyncData,
    sentDeleteClientIds: ReadonlySet<string>,
    syncedAt: string,
  ): Promise<
    | { readonly kind: "published"; readonly snapshot: SavedFilterSnapshot }
    | { readonly kind: "stale" | "unavailable" }
  >;
}

interface SavedFilterSyncPorts {
  readonly session: SavedFilterSyncSessionPort;
  readonly api: SavedFilterSyncApiPort;
  readonly repository: SavedFilterSyncRepositoryPort;
  readonly clock: { now(): string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function copyPairs(value: unknown): readonly (readonly [string, string])[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 80) return null;
  const pairs: [string, string][] = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const key = typeof pair[0] === "string" ? pair[0].trim() : "";
    const item = typeof pair[1] === "string" ? pair[1].trim() : "";
    if (!PARAM_KEY_PATTERN.test(key) || item.length === 0 || item.length > 300) return null;
    pairs.push([key, item]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return Object.freeze(pairs.map((pair) => Object.freeze(pair)));
}

function copySummary(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const summary: string[] = [];
  for (const item of value) {
    const text = cleanText(item, 64);
    if (!text || text !== item) return null;
    summary.push(text);
  }
  return Object.freeze(summary);
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function copyLocalPreset(value: unknown, now: string): SavedFilterPreset | null {
  if (!isRecord(value)) return null;
  const id = cleanText(value.id, 120);
  const clientId = validClientId(value.clientId)
    ? value.clientId
    : validClientId(id)
      ? id
      : "";
  const params = copyPairs(value.params);
  const summary = copySummary(Array.isArray(value.summary) ? value.summary : []);
  if (!id || !clientId || params === null || summary === null) return null;
  const scope = value.scope === "global" ? "global" : "context";
  const updatedAt = isIso(value.updatedAt) ? value.updatedAt : now;
  return Object.freeze({
    id,
    clientId,
    serverId: validUuid(value.serverId) ? value.serverId : "",
    name: cleanText(value.name, 96) || "AO3 filter",
    params,
    scope,
    contextKey: scope === "context" ? cleanText(value.contextKey, 240) : "",
    contextLabel: scope === "context" ? cleanText(value.contextLabel, 120) : "",
    summary,
    createdAt: isIso(value.createdAt) ? value.createdAt : now,
    updatedAt,
    clientUpdatedAt: isIso(value.clientUpdatedAt) ? value.clientUpdatedAt : updatedAt,
    dirty: value.dirty === true,
  });
}

function copyLocalDeletion(value: unknown, now: string): SavedFilterDeletion | null {
  if (!isRecord(value)) return null;
  const id = cleanText(value.id, 120);
  const clientId = validClientId(value.clientId)
    ? value.clientId
    : validClientId(id)
      ? id
      : "";
  if (!clientId) return null;
  return Object.freeze({
    id: id || clientId,
    clientId,
    serverId: validUuid(value.serverId) ? value.serverId : "",
    clientUpdatedAt: isIso(value.clientUpdatedAt) ? value.clientUpdatedAt : now,
  });
}

function copyActiveMeta(value: unknown): SavedFilterActiveMeta | null {
  if (!isRecord(value)) return null;
  const id = cleanText(value.id, 120);
  const signature = cleanText(value.signature, 4_096);
  const contextKey = cleanText(value.contextKey, 240);
  if (!id || !signature || !contextKey) return null;
  return Object.freeze({
    id,
    signature,
    contextKey,
    appliedAt: isIso(value.appliedAt) ? value.appliedAt : "",
  });
}

export function normalizeSavedFilterSnapshot(
  raw: unknown,
  now: string,
): SavedFilterSnapshot {
  const root = isRecord(raw) ? raw : {};
  const presets: SavedFilterPreset[] = [];
  const presetIds = new Set<string>();
  const presetClientIds = new Set<string>();
  if (Array.isArray(root.presets)) {
    for (const value of root.presets.slice(0, SAVED_FILTER_ACTIVE_LIMIT)) {
      const preset = copyLocalPreset(value, now);
      if (
        preset === null ||
        presetIds.has(preset.id) ||
        presetClientIds.has(preset.clientId)
      ) {
        continue;
      }
      presetIds.add(preset.id);
      presetClientIds.add(preset.clientId);
      presets.push(preset);
    }
  }
  const deleted: SavedFilterDeletion[] = [];
  const deletedClientIds = new Set<string>();
  if (Array.isArray(root.deleted)) {
    for (const value of root.deleted.slice(0, MAX_LOCAL_TOMBSTONES)) {
      const item = copyLocalDeletion(value, now);
      if (item === null || deletedClientIds.has(item.clientId)) continue;
      deletedClientIds.add(item.clientId);
      deleted.push(item);
    }
  }
  return Object.freeze({
    presets: Object.freeze(presets),
    deleted: Object.freeze(deleted),
    activeMeta: copyActiveMeta(root.activeMeta),
    syncVersion: isIso(root.syncVersion) ? root.syncVersion : null,
    lastSyncedAt: isIso(root.lastSyncedAt) ? root.lastSyncedAt : null,
    clientId: validClientId(root.clientId) ? root.clientId : null,
  });
}

function copyRemotePreset(value: unknown): RemoteSavedFilterPreset | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "clientId",
      "name",
      "scope",
      "contextKey",
      "contextLabel",
      "params",
      "summary",
      "createdAt",
      "updatedAt",
      "clientUpdatedAt",
    ]) ||
    !validUuid(value.id) ||
    !validClientId(value.clientId) ||
    (value.scope !== "context" && value.scope !== "global") ||
    !isIso(value.createdAt) ||
    !isIso(value.updatedAt) ||
    !isIso(value.clientUpdatedAt)
  ) {
    return null;
  }
  const name = cleanText(value.name, 96);
  const params = copyPairs(value.params);
  const summary = copySummary(value.summary);
  if (!name || name !== value.name || params === null || summary === null) return null;
  if (
    value.contextKey !== null &&
    (typeof value.contextKey !== "string" || value.contextKey.length > 240)
  ) {
    return null;
  }
  if (
    value.contextLabel !== null &&
    (typeof value.contextLabel !== "string" || value.contextLabel.length > 120)
  ) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    clientId: value.clientId,
    name,
    scope: value.scope,
    contextKey: value.contextKey,
    contextLabel: value.contextLabel,
    params,
    summary,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    clientUpdatedAt: value.clientUpdatedAt,
  });
}

function copyRemoteDeletion(value: unknown): RemoteSavedFilterDeletion | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "clientId",
      "deletedAt",
      "updatedAt",
      "clientUpdatedAt",
    ]) ||
    !validUuid(value.id) ||
    !validClientId(value.clientId) ||
    !isIso(value.deletedAt) ||
    !isIso(value.updatedAt) ||
    !isIso(value.clientUpdatedAt)
  ) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    clientId: value.clientId,
    deletedAt: value.deletedAt,
    updatedAt: value.updatedAt,
    clientUpdatedAt: value.clientUpdatedAt,
  });
}

export function parseSavedFilterSyncData(value: unknown): SavedFilterSyncData | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["serverTime", "syncVersion", "presets", "deleted"]) ||
    !isIso(value.serverTime) ||
    !isIso(value.syncVersion) ||
    !Array.isArray(value.presets) ||
    !Array.isArray(value.deleted) ||
    value.presets.length > MAX_REMOTE_ROWS ||
    value.deleted.length > MAX_REMOTE_ROWS
  ) {
    return null;
  }
  const presets: RemoteSavedFilterPreset[] = [];
  const deleted: RemoteSavedFilterDeletion[] = [];
  const seenPresets = new Set<string>();
  const seenDeleted = new Set<string>();
  for (const raw of value.presets) {
    const preset = copyRemotePreset(raw);
    if (preset === null || seenPresets.has(preset.clientId)) return null;
    seenPresets.add(preset.clientId);
    presets.push(preset);
  }
  for (const raw of value.deleted) {
    const item = copyRemoteDeletion(raw);
    if (item === null || seenDeleted.has(item.clientId)) return null;
    seenDeleted.add(item.clientId);
    deleted.push(item);
  }
  return Object.freeze({
    serverTime: value.serverTime,
    syncVersion: value.syncVersion,
    presets: Object.freeze(presets),
    deleted: Object.freeze(deleted),
  });
}

function needsSync(preset: SavedFilterPreset): boolean {
  return preset.dirty || !validUuid(preset.serverId);
}

function upsertFromPreset(preset: SavedFilterPreset): SavedFilterUpsert {
  return Object.freeze({
    ...(validUuid(preset.serverId) ? { id: preset.serverId } : {}),
    clientId: preset.clientId,
    name: preset.name,
    scope: preset.scope,
    contextKey: preset.scope === "context" ? preset.contextKey || null : null,
    contextLabel: preset.scope === "context" ? preset.contextLabel || null : null,
    params: preset.params,
    summary: preset.summary,
    createdAt: preset.createdAt,
    clientUpdatedAt: preset.clientUpdatedAt,
  });
}

function deleteFromLocal(item: SavedFilterDeletion): SavedFilterDelete {
  return Object.freeze({
    ...(validUuid(item.serverId) ? { id: item.serverId } : {}),
    clientId: item.clientId,
    clientUpdatedAt: item.clientUpdatedAt,
  });
}

export function savedFilterSyncRequest(
  snapshot: SavedFilterSnapshot,
): SavedFilterSyncRequest | null {
  if (snapshot.clientId === null) return null;
  return Object.freeze({
    clientId: snapshot.clientId,
    since: snapshot.syncVersion,
    upserts: Object.freeze(
      snapshot.presets
        .filter(needsSync)
        .slice(0, SAVED_FILTER_SYNC_BATCH_LIMIT)
        .map(upsertFromPreset),
    ),
    deletes: Object.freeze(
      snapshot.deleted
        .slice(0, SAVED_FILTER_SYNC_BATCH_LIMIT)
        .map(deleteFromLocal),
    ),
  });
}

function localIsNewer(
  local: SavedFilterPreset | undefined,
  remoteClientUpdatedAt: string,
): boolean {
  if (local?.dirty !== true) return false;
  return Date.parse(local.clientUpdatedAt) > Date.parse(remoteClientUpdatedAt);
}

export function mergeSavedFilterSyncData(
  snapshot: SavedFilterSnapshot,
  data: SavedFilterSyncData,
  sentDeleteClientIds: ReadonlySet<string>,
  syncedAt: string,
): SavedFilterSnapshot {
  const byClientId = new Map(snapshot.presets.map((item) => [item.clientId, item]));
  const localIdByClientId = new Map(
    snapshot.presets.map((item) => [item.clientId, item.id]),
  );
  const deletedByClientId = new Map(
    snapshot.deleted.map((item) => [item.clientId, item]),
  );
  for (const clientId of sentDeleteClientIds) deletedByClientId.delete(clientId);

  for (const remote of data.presets) {
    const existing = byClientId.get(remote.clientId);
    if (localIsNewer(existing, remote.clientUpdatedAt)) continue;
    byClientId.set(remote.clientId, Object.freeze({
      id: existing?.id ?? remote.clientId,
      clientId: remote.clientId,
      serverId: remote.id,
      name: remote.name,
      params: remote.params,
      scope: remote.scope,
      contextKey: remote.scope === "context" ? remote.contextKey ?? "" : "",
      contextLabel: remote.scope === "context" ? remote.contextLabel ?? "" : "",
      summary: remote.summary,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      clientUpdatedAt: remote.clientUpdatedAt,
      dirty: false,
    }));
    deletedByClientId.delete(remote.clientId);
  }
  for (const remote of data.deleted) {
    const existing = byClientId.get(remote.clientId);
    if (localIsNewer(existing, remote.clientUpdatedAt)) continue;
    byClientId.delete(remote.clientId);
    deletedByClientId.delete(remote.clientId);
  }

  const presets = Array.from(byClientId.values()).sort(
    (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  );
  let activeMeta = snapshot.activeMeta;
  if (activeMeta !== null && !presets.some((item) => item.id === activeMeta!.id)) {
    const activeClientId = Array.from(localIdByClientId.entries())
      .find(([, localId]) => localId === activeMeta!.id)?.[0];
    const replacement = activeClientId === undefined
      ? undefined
      : presets.find((item) => item.clientId === activeClientId);
    activeMeta = replacement === undefined
      ? null
      : Object.freeze({ ...activeMeta, id: replacement.id });
  }
  return Object.freeze({
    presets: Object.freeze(presets),
    deleted: Object.freeze(Array.from(deletedByClientId.values())),
    activeMeta,
    syncVersion: data.syncVersion,
    lastSyncedAt: syncedAt,
    clientId: snapshot.clientId,
  });
}

export function savedFilterSnapshotHasPending(snapshot: SavedFilterSnapshot): boolean {
  return snapshot.presets.some(needsSync) || snapshot.deleted.length > 0;
}

function failure(
  reason: SavedFilterSyncFailure,
  limit?: number,
): SavedFilterSyncResult {
  return Object.freeze({
    kind: "failed",
    reason,
    ...(limit === undefined ? {} : { limit }),
  });
}

export class SavedFilterSyncService {
  readonly #ports: SavedFilterSyncPorts;
  #inFlight: Promise<SavedFilterSyncResult> | null = null;
  #generation = 0;

  constructor(ports: SavedFilterSyncPorts) {
    this.#ports = ports;
  }

  sync(): Promise<SavedFilterSyncResult> {
    const generation = this.#generation;
    this.#inFlight ??= this.#syncOnce(generation).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  cancel(): void {
    this.#generation += 1;
  }

  async #syncOnce(generation: number): Promise<SavedFilterSyncResult> {
    let scope = this.#ports.session.publicationScope();
    if (scope === null) return failure("not_authenticated");
    let requests = 0;
    let lastSyncVersion = "";

    for (let iteration = 0; iteration < SAVED_FILTER_SYNC_MAX_ITERATIONS; iteration += 1) {
      if (generation !== this.#generation) return failure("stale");
      let snapshot: SavedFilterSnapshot | null;
      try {
        snapshot = await this.#ports.repository.read();
      } catch {
        return failure("storage_unavailable");
      }
      if (snapshot === null || snapshot.clientId === null) {
        return failure("storage_unavailable");
      }
      const request = savedFilterSyncRequest(snapshot);
      if (request === null) return failure("storage_unavailable");

      let execution = await this.#execute(request);
      if (generation !== this.#generation) return failure("stale");
      if (execution.kind === "auth_rejected" && execution.recovery === "connected") {
        const recoveredScope = this.#ports.session.publicationScope();
        if (recoveredScope === null || recoveredScope.accountId !== scope.accountId) {
          return failure("stale");
        }
        scope = recoveredScope;
        execution = await this.#execute(request);
        if (generation !== this.#generation) return failure("stale");
      }
      if (execution.kind === "auth_rejected") return failure("auth_expired");
      if (execution.kind !== "published") {
        return failure(execution.kind === "stale" ? "stale" : "unavailable");
      }
      const outcome = execution.value;
      if (outcome.kind === "rejected") {
        return failure(outcome.reason, outcome.limit);
      }
      if (outcome.kind === "invalid_response") return failure("invalid_response");
      if (outcome.kind === "unavailable") return failure("unavailable");
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
        return failure("stale");
      }

      const merged = await this.#ports.repository.merge(
        scope,
        outcome.data,
        new Set(request.deletes.map((item) => item.clientId)),
        this.#ports.clock.now(),
      );
      if (merged.kind !== "published") {
        return failure(
          merged.kind === "stale" ? "stale" : "storage_unavailable",
        );
      }
      requests += 1;
      lastSyncVersion = merged.snapshot.syncVersion ?? "";
      if (!savedFilterSnapshotHasPending(merged.snapshot)) {
        return Object.freeze({
          kind: "completed",
          syncVersion: lastSyncVersion,
          requests,
        });
      }
    }
    return Object.freeze({
      kind: "partial",
      syncVersion: lastSyncVersion,
      requests,
    });
  }

  #execute(
    request: SavedFilterSyncRequest,
  ): Promise<AuthenticatedExecutionResult<SavedFilterSyncApiOutcome>> {
    return this.#ports.session.executeAuthenticated((credential) =>
      this.#ports.api.sync(credential, request)
    );
  }
}
