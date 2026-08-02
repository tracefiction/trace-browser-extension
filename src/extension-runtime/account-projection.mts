import {
  copyAccountOverlay,
  copyAccountSummary,
  type AccountProjectionApiPort,
  type AccountProjectionFetch,
  type AuthenticatedEffectResult,
  type ProjectionPart,
  type AccountOverlay,
  type AccountSummary,
} from "../extension-core/index.mjs";

const REQUEST_TIMEOUT_MS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResponseResult =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "unavailable" };

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class AccountProjectionApi implements AccountProjectionApiPort {
  readonly #fetch: typeof fetch;
  readonly #overlayEndpoint: string;
  readonly #accountEndpoint: string;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    const base = apiBase.replace(/\/$/, "");
    this.#overlayEndpoint = `${base}/api/extension/library-overlay`;
    this.#accountEndpoint = `${base}/api/extension/account`;
  }

  async load(
    credential: string,
  ): Promise<AuthenticatedEffectResult<AccountProjectionFetch>> {
    const [overlayResult, accountResult] = await Promise.all([
      this.#request(this.#overlayEndpoint, credential),
      this.#request(this.#accountEndpoint, credential),
    ]);
    const responses = [overlayResult, accountResult];
    if (
      responses.some(
        (result) =>
          result.kind === "response" &&
          (result.response.status === 401 || result.response.status === 403),
      )
    ) {
      return { kind: "auth_rejected" };
    }
    if (responses.every((result) => result.kind === "unavailable")) {
      return { kind: "unavailable" };
    }

    const overlay = await this.#overlayPart(overlayResult);
    const summary = await this.#summaryPart(accountResult);
    return {
      kind: "success",
      value: Object.freeze({ overlay, summary }),
    };
  }

  async #overlayPart(result: ResponseResult): Promise<ProjectionPart<AccountOverlay>> {
    if (result.kind === "unavailable") return { kind: "unavailable" };
    if (!result.response.ok) {
      return result.response.status === 429 || result.response.status >= 500
        ? { kind: "unavailable" }
        : { kind: "invalid_response" };
    }
    const body = await responseJson(result.response);
    const overlay = copyAccountOverlay(
      isRecord(body) && isRecord(body.data) ? body.data : null,
    );
    return overlay === null
      ? { kind: "invalid_response" }
      : { kind: "value", value: overlay };
  }

  async #summaryPart(
    result: ResponseResult,
  ): Promise<ProjectionPart<Readonly<{ accountId: string; value: AccountSummary }>>> {
    if (result.kind === "unavailable") return { kind: "unavailable" };
    if (!result.response.ok) {
      return result.response.status === 429 || result.response.status >= 500
        ? { kind: "unavailable" }
        : { kind: "invalid_response" };
    }
    const body = await responseJson(result.response);
    if (
      !isRecord(body) ||
      typeof body.account_id !== "string" ||
      !body.account_id.trim()
    ) {
      return { kind: "invalid_response" };
    }
    const libraryCount = body.library_count;
    const summary = copyAccountSummary({
      pro: body.pro,
      libraryCount,
      firstStoryCompleted:
        (typeof body.first_story_completed_at === "string" &&
          body.first_story_completed_at.trim().length > 0) ||
        (Number.isSafeInteger(libraryCount) && (libraryCount as number) > 0),
    });
    return summary === null
      ? { kind: "invalid_response" }
      : {
          kind: "value",
          value: Object.freeze({
            accountId: body.account_id.trim(),
            value: summary,
          }),
        };
  }

  async #request(url: string, credential: string): Promise<ResponseResult> {
    const abort = new AbortController();
    const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${credential}` },
        signal: abort.signal,
      });
      return { kind: "response", response };
    } catch {
      return { kind: "unavailable" };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}
