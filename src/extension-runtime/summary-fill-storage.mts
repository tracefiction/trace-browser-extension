/**
 * Storage shared by the summary fills (ffn-summary-fill.mts,
 * ao3-summary-fill.mts): a fill's session state in one storage area, and the
 * ids of stories it already tried. Each fill names its own keys and says
 * what a valid state is; nothing here knows either site.
 */

export interface StorageAreaLike {
  get(keys: string): Promise<Record<string, unknown>> | unknown;
  set(items: Record<string, unknown>): Promise<void> | unknown;
  remove(keys: string): Promise<void> | unknown;
}

/** What every stored fill state carries: when it expires in local storage. */
export interface ExpiringState {
  readonly exp?: number;
}

export interface SessionStatePort<T extends ExpiringState> {
  /** Whether the state outlives this background, so the caps and the work hold. */
  readonly durable: boolean;
  read(): Promise<T | null>;
  write(state: T): Promise<void>;
  clear(): Promise<void>;
}

function usableArea(area: StorageAreaLike | null | undefined): StorageAreaLike | null {
  return area && typeof area.get === "function" ? area : null;
}

/**
 * A fill's state in one storage area: session-only storage
 * (`storage.session`, kept in memory by the browser and gone when it quits),
 * or, where a browser has none, local storage with an expiry. With no area
 * at all it lives in this background's memory and is not durable. A stored
 * value `validate` refuses reads as no state.
 */
export class StoredSessionState<T extends ExpiringState> implements SessionStatePort<T> {
  readonly #area: StorageAreaLike | null;
  readonly #key: string;
  readonly #validate: (value: unknown) => T | null;
  readonly #ttlMs: number | null;
  readonly #now: () => number;
  #memory: T | null = null;

  constructor(
    area: StorageAreaLike | null | undefined,
    key: string,
    validate: (value: unknown) => T | null,
    options: { readonly ttlMs?: number; readonly now?: () => number } = {},
  ) {
    this.#area = usableArea(area);
    this.#key = key;
    this.#validate = validate;
    this.#ttlMs = options.ttlMs ?? null;
    this.#now = options.now ?? (() => Date.now());
  }

  get durable(): boolean {
    return this.#area !== null;
  }

  async read(): Promise<T | null> {
    let state: T | null;
    if (this.#area === null) {
      state = this.#memory;
    } else {
      try {
        const values = await this.#area.get(this.#key) as Record<string, unknown> | undefined;
        state = this.#validate(values?.[this.#key]);
      } catch {
        state = this.#memory;
      }
    }
    if (state !== null && state.exp !== undefined && state.exp <= this.#now()) {
      await this.clear();
      return null;
    }
    return state;
  }

  async write(state: T): Promise<void> {
    const stored: T = this.#ttlMs === null
      ? state
      : Object.freeze({ ...state, exp: state.exp ?? this.#now() + this.#ttlMs });
    this.#memory = stored;
    if (this.#area === null) return;
    try {
      await this.#area.set({ [this.#key]: stored });
    } catch {
      // Memory keeps the pacing while storage is unavailable.
    }
  }

  async clear(): Promise<void> {
    this.#memory = null;
    if (this.#area === null) return;
    try {
      await this.#area.remove(this.#key);
    } catch {
      // Nothing else to remove.
    }
  }
}

/**
 * Story ids already tried for an account, newest last, at most `max`: ids
 * only, kept across sessions so a story that cannot be filled does not come
 * first every time. Removed on sign-out.
 */
export interface AttemptedPort {
  read(account: string): Promise<readonly string[]>;
  add(account: string, storyIds: readonly string[]): Promise<void>;
  /** Removes the list when it belongs to another account. */
  keepOnly(account: string): Promise<void>;
  clear(): Promise<void>;
}

/** The attempted ids under one key of one storage area (the extension's local storage). */
export class StoredAttemptedIds implements AttemptedPort {
  readonly #area: StorageAreaLike | null;
  readonly #key: string;
  readonly #idPattern: RegExp;
  readonly #max: number;
  #memory: { account: string; ids: string[] } | null = null;

  constructor(
    area: StorageAreaLike | null | undefined,
    options: { readonly key: string; readonly idPattern: RegExp; readonly max: number },
  ) {
    this.#area = usableArea(area);
    this.#key = options.key;
    this.#idPattern = options.idPattern;
    this.#max = options.max;
  }

  async #load(): Promise<{ account: string; ids: string[] } | null> {
    if (this.#area === null) return this.#memory;
    try {
      const values = await this.#area.get(this.#key) as Record<string, unknown> | undefined;
      const value = values?.[this.#key] as Record<string, unknown> | undefined;
      if (
        !value ||
        typeof value.account !== "string" ||
        !Array.isArray(value.ids) ||
        !value.ids.every((id) => typeof id === "string" && this.#idPattern.test(id))
      ) {
        return null;
      }
      return { account: value.account, ids: (value.ids as string[]).slice(-this.#max) };
    } catch {
      return this.#memory;
    }
  }

  async read(account: string): Promise<readonly string[]> {
    const stored = await this.#load();
    return stored !== null && stored.account === account ? stored.ids : [];
  }

  async add(account: string, storyIds: readonly string[]): Promise<void> {
    const previous = await this.read(account);
    const ids = [...previous.filter((id) => !storyIds.includes(id)), ...storyIds]
      .filter((id) => this.#idPattern.test(id))
      .slice(-this.#max);
    const next = { account, ids };
    this.#memory = next;
    if (this.#area === null) return;
    try {
      await this.#area.set({ [this.#key]: next });
    } catch {
      // Memory keeps it for this background.
    }
  }

  async keepOnly(account: string): Promise<void> {
    const stored = await this.#load();
    if (stored !== null && stored.account !== account) await this.clear();
  }

  async clear(): Promise<void> {
    this.#memory = null;
    if (this.#area === null) return;
    try {
      await this.#area.remove(this.#key);
    } catch {
      // Nothing else to remove.
    }
  }
}
