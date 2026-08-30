import type { AuthenticatedEffectResult } from "../extension-core/index.mjs";

const REQUEST_TIMEOUT_MS = 5_000;

export type ExtensionCapacityEvent = Readonly<{
  event: "prompt_viewed" | "prompt_dismissed";
  surface: "story" | "listing";
}>;

export class ExtensionCapacityEventApi {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/capacity-events`;
  }

  async record(
    credential: string,
    event: ExtensionCapacityEvent,
  ): Promise<AuthenticatedEffectResult<void>> {
    const abort = new AbortController();
    const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
        signal: abort.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_rejected" };
      }
      return { kind: "success", value: undefined };
    } catch {
      // Conversion telemetry is intentionally best-effort and must not alter
      // the session or suppress the already-rendered recovery prompt.
      return { kind: "success", value: undefined };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}
