import { sameAccountScope, type AccountScope } from "./session-model.mjs";

export interface ScopedValue<T> {
  readonly scope: AccountScope;
  readonly value: T;
}

export type ScopedWriteResult<T> =
  | { readonly kind: "accepted"; readonly entry: ScopedValue<T> }
  | { readonly kind: "rejected_scope" };

function copyScope(scope: AccountScope): AccountScope {
  return Object.freeze({ accountId: scope.accountId, epoch: scope.epoch });
}

export function readScopedValue<T>(
  entry: ScopedValue<T> | null,
  readableScope: AccountScope | null,
): T | null {
  if (entry === null || !sameAccountScope(entry.scope, readableScope)) return null;
  return entry.value;
}

export function writeScopedValue<T>(
  publicationScope: AccountScope | null,
  requestedScope: AccountScope,
  value: T,
): ScopedWriteResult<T> {
  if (!sameAccountScope(publicationScope, requestedScope)) {
    return { kind: "rejected_scope" };
  }
  return {
    kind: "accepted",
    entry: Object.freeze({ scope: copyScope(requestedScope), value }),
  };
}

// AO3 saved filters are the one accepted local-first exception: a local edit
// may use the exact degraded display scope, but remote sync still requires the
// verified publication scope below.
export function writeSavedFilterValue<T>(
  displayScope: AccountScope | null,
  requestedScope: AccountScope,
  value: T,
): ScopedWriteResult<T> {
  if (!sameAccountScope(displayScope, requestedScope)) {
    return { kind: "rejected_scope" };
  }
  return {
    kind: "accepted",
    entry: Object.freeze({ scope: copyScope(requestedScope), value }),
  };
}

export function canSyncSavedFilters(
  publicationScope: AccountScope | null,
  repositoryScope: AccountScope,
): boolean {
  return sameAccountScope(publicationScope, repositoryScope);
}
