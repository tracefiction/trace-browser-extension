import {
  sameAccountScope,
  type AuthenticatedEffectResult,
  type AuthenticatedExecutionResult,
  type AuthenticatedStoryCommandPort,
} from "../extension-core/index.mjs";

/**
 * Whether one exact story is in the signed-in reader's Library, asked of
 * Trace. Unlike the whole-Library read, which is capped, this read's "absent"
 * is an answer. It reads and nothing else: nothing is saved, published or
 * told to the app, and nothing is taken from a kept copy of the Library.
 *
 * Only an answer of "present" or "absent" for the story asked about is one.
 * A request that failed, was turned away as too many, met a server error or
 * came back unreadable leaves the story's place not known, never absent.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_KEY_PATTERN = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
const REQUEST_TIMEOUT_MS = 12_000;
const STATUS_LIMIT = 40;

/** The Library entry's own status, as Trace reported it. */
export type StoryMembershipEntry = Readonly<{
  status: string | null;
  readerStatus: string | null;
  canonicalReaderStatus: string | null;
}>;

export type StoryMembershipOutcome =
  | { readonly kind: "present"; readonly entry: StoryMembershipEntry }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid_response" }
  | { readonly kind: "unavailable" };

/** What the read established for the account that asked. */
export type StoryMembership =
  | { readonly kind: "present"; readonly entry: StoryMembershipEntry }
  | { readonly kind: "absent" }
  /** Trace turned the account's sign-in down, and it could not be renewed. */
  | { readonly kind: "account_refused" }
  | { readonly kind: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function status(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= STATUS_LIMIT
    ? value.trim()
    : null;
}

function membershipFrom(value: unknown, expectedWorkKey: string): StoryMembershipOutcome {
  const invalid: StoryMembershipOutcome = { kind: "invalid_response" };
  if (!isRecord(value) || value.work_key !== expectedWorkKey) return invalid;
  if (value.membership === "absent") return { kind: "absent" };
  if (value.membership !== "present" || !isRecord(value.entry)) return invalid;
  const entryId = typeof value.entry_id === "string" ? value.entry_id.trim() : "";
  if (!UUID_PATTERN.test(entryId) || value.entry.entryId !== entryId) return invalid;
  const entry: StoryMembershipEntry = Object.freeze({
    status: status(value.entry.status),
    readerStatus: status(value.entry.readerStatus),
    canonicalReaderStatus: status(value.entry.canonicalReaderStatus),
  });
  // An entry with no status at all could only be shown with a made-up one.
  return entry.status === null && entry.readerStatus === null && entry.canonicalReaderStatus === null
    ? invalid
    : { kind: "present", entry };
}

export class StoryMembershipApi {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/library-membership`;
  }

  async read(
    credential: string,
    workKey: string,
  ): Promise<AuthenticatedEffectResult<StoryMembershipOutcome>> {
    // The key is the only thing sent. One that is not a story's key is not
    // sent at all, and so is never answered as absent.
    if (!WORK_KEY_PATTERN.test(workKey)) return { kind: "success", value: { kind: "unavailable" } };
    const abort = new AbortController();
    const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#endpoint}?work_key=${workKey}`, {
        method: "GET",
        cache: "no-store",
        signal: abort.signal,
        headers: { Authorization: `Bearer ${credential}` },
      });
    } catch {
      return { kind: "success", value: { kind: "unavailable" } };
    } finally {
      globalThis.clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
    // Too many requests, a server error, a refused request: none says where
    // the story is.
    if (!response.ok) return { kind: "success", value: { kind: "unavailable" } };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      kind: "success",
      value: membershipFrom(isRecord(body) && body.success === true ? body.data : null, workKey),
    };
  }
}

/**
 * Asks once for the account now signed in. A second request is made only
 * when Trace turned the sign-in down and the account then reconnected: the
 * first was refused before it was read, so it answered nothing. An answer for
 * an account that changed meanwhile is not known.
 */
export async function readStoryMembership(
  session: AuthenticatedStoryCommandPort,
  api: Pick<StoryMembershipApi, "read">,
  workKey: string,
): Promise<StoryMembership> {
  const unknown: StoryMembership = Object.freeze({ kind: "unknown" });
  const scope = session.publicationScope();
  if (scope === null) return unknown;
  const ask = (): Promise<AuthenticatedExecutionResult<StoryMembershipOutcome>> =>
    session.executeAuthenticated((credential) => api.read(credential, workKey));
  let result: AuthenticatedExecutionResult<StoryMembershipOutcome>;
  try {
    result = await ask();
    if (result.kind === "auth_rejected" && result.recovery === "connected") result = await ask();
  } catch {
    return unknown;
  }
  if (result.kind === "auth_rejected") {
    return result.recovery === "reconnect_required"
      ? Object.freeze({ kind: "account_refused" })
      : unknown;
  }
  if (result.kind !== "published" || !sameAccountScope(session.publicationScope(), scope)) {
    return unknown;
  }
  if (result.value.kind === "present") {
    return Object.freeze({ kind: "present", entry: result.value.entry });
  }
  return result.value.kind === "absent" ? Object.freeze({ kind: "absent" }) : unknown;
}
