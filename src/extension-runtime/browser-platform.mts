export interface RuntimePort {
  readonly id?: string;
  readonly lastError?: { readonly message?: string };
  readonly onInstalled?: {
    addListener(listener: (details: { readonly reason?: string }) => void): void;
  };
  readonly onMessage: {
    addListener(listener: RuntimeMessageListener): void;
  };
  readonly getPlatformInfo?: (...args: unknown[]) => unknown;
  readonly getURL?: (...args: unknown[]) => unknown;
  readonly sendNativeMessage?: (...args: unknown[]) => unknown;
}

export interface PermissionsPort {
  readonly getAll: (...args: unknown[]) => unknown;
  readonly contains?: (...args: unknown[]) => unknown;
  readonly onAdded?: {
    addListener(listener: () => void): void;
  };
  readonly onRemoved?: {
    addListener(listener: () => void): void;
  };
}

export interface ScriptingPort {
  readonly getRegisteredContentScripts: (...args: unknown[]) => unknown;
  readonly registerContentScripts: (...args: unknown[]) => unknown;
  readonly unregisterContentScripts: (...args: unknown[]) => unknown;
}

export interface RuntimeMessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: { readonly url?: string } | null;
  readonly frameId?: number;
  readonly documentLifecycle?: string;
}

export interface TabsPort {
  readonly query: (...args: unknown[]) => unknown;
  readonly sendMessage: (...args: unknown[]) => unknown;
  readonly create: (...args: unknown[]) => unknown;
  readonly update?: (...args: unknown[]) => unknown;
}

export interface AlarmsPort {
  readonly clear: (...args: unknown[]) => unknown;
  readonly create?: (...args: unknown[]) => unknown;
  readonly onAlarm?: {
    addListener(listener: (alarm: { readonly name?: string }) => void): void;
  };
}

export type RuntimeMessageListener = (
  message: unknown,
  sender: RuntimeMessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

export interface StorageArea {
  readonly get: (...args: unknown[]) => unknown;
  readonly set: (...args: unknown[]) => unknown;
  readonly remove: (...args: unknown[]) => unknown;
}

export interface BrowserTab {
  readonly id?: number;
  readonly url?: string;
  readonly active?: boolean;
  readonly lastAccessed?: number;
}

export class BrowserStorage {
  readonly #area: StorageArea;
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(area: StorageArea, runtime: RuntimePort, mode: "callback" | "promise") {
    this.#area = area;
    this.#runtime = runtime;
    this.#mode = mode;
  }

  get(keys: string | readonly string[]): Promise<Record<string, unknown>> {
    return this.#call<Record<string, unknown>>("get", [keys]);
  }

  set(patch: Record<string, unknown>): Promise<void> {
    return this.#call<void>("set", [patch]);
  }

  remove(keys: string | readonly string[]): Promise<void> {
    return this.#call<void>("remove", [keys]);
  }

  #call<T>(method: "get" | "set" | "remove", args: readonly unknown[]): Promise<T> {
    if (this.#mode === "promise") {
      try {
        return Promise.resolve(this.#area[method](...args) as T | PromiseLike<T>);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<T>((resolve, reject) => {
      try {
        this.#area[method](...args, (value: T) => {
          const message = this.#runtime.lastError?.message;
          if (message) reject(new Error(message));
          else resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
}

export function extensionCall<T>(
  target: Record<string, (...args: unknown[]) => unknown>,
  method: string,
  args: readonly unknown[],
  runtime: RuntimePort,
  mode: "callback" | "promise",
): Promise<T> {
  if (mode === "promise") {
    try {
      return Promise.resolve(target[method]!(...args) as T | PromiseLike<T>);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise<T>((resolve, reject) => {
    try {
      target[method]!(...args, (value: T) => {
        const message = runtime.lastError?.message;
        if (message) reject(new Error(message));
        else resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}
