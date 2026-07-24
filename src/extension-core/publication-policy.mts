export interface VersionedServerValue<T> {
  readonly serverVersion: number;
  readonly value: T;
}

export type PublicationDecision<T> =
  | { readonly kind: "published"; readonly current: VersionedServerValue<T> }
  | { readonly kind: "discarded_stale"; readonly current: VersionedServerValue<T> };

function assertServerVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError("serverVersion must be a non-negative safe integer");
  }
}

function copyServerValue<T>(entry: VersionedServerValue<T>): VersionedServerValue<T> {
  return Object.freeze({ serverVersion: entry.serverVersion, value: entry.value });
}

export function publishNonRegressing<T>(
  current: VersionedServerValue<T> | null,
  incoming: VersionedServerValue<T>,
): PublicationDecision<T> {
  assertServerVersion(incoming.serverVersion);
  if (current === null) {
    return { kind: "published", current: copyServerValue(incoming) };
  }
  assertServerVersion(current.serverVersion);
  if (incoming.serverVersion < current.serverVersion) {
    return { kind: "discarded_stale", current: copyServerValue(current) };
  }
  return { kind: "published", current: copyServerValue(incoming) };
}
