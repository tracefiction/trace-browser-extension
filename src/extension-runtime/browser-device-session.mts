import type { CredentialAcquisition } from "../extension-core/index.mjs";
import type { CredentialProvider } from "./browser-adapters.mjs";
import { PRIVATE_RECORD_KEYS, type PrivateRecordDatabase } from "./private-database.mjs";

const DEVICE_TOKEN = /^trd_v1_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The background exchanges the page grant once; no scoped credential ever
 * crosses the Trace-page bridge. Native iOS remains app-owned. */
export class BrowserDeviceSessionProvider implements CredentialProvider {
  #generation = 0;
  constructor(private readonly options: {
    provider: CredentialProvider;
    isNative: () => Promise<boolean>;
    database: PrivateRecordDatabase;
    fetch: typeof fetch;
    apiBase: string;
    clientVersion?: string;
  }) {}

  cancel(): void {
    this.#generation += 1;
    this.options.provider.cancel();
  }

  async acquire(purpose: "connect" | "refresh"): Promise<CredentialAcquisition> {
    const generation = this.#generation;
    const native = await this.options.isNative();
    const grant = await this.options.provider.acquire(purpose);
    if (grant.kind !== "credential" || native) return grant;
    if (generation !== this.#generation) return { kind: "cancelled" };
    return this.#exchange(grant.credential, generation);
  }

  async upgrade(credential: string): Promise<string> {
    if (DEVICE_TOKEN.test(credential) || await this.options.isNative()) return credential;
    const result = await this.#exchange(credential, this.#generation);
    // An existing access token is still verified by the normal owner. A
    // server-first rollout or temporary outage must not discard valid access.
    return result.kind === "credential" ? result.credential : credential;
  }

  async release(credential: string): Promise<void> {
    if (!DEVICE_TOKEN.test(credential) || await this.options.isNative()) return;
    try {
      await this.options.fetch(`${this.options.apiBase}/api/extension/session`, {
        method: "DELETE", headers: { Authorization: `Bearer ${credential}` },
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Local authority is already cleared. Offline deletion is best effort;
      // the server still enforces revocation, idle and absolute expiration.
    }
  }

  async #exchange(accessToken: string, generation: number): Promise<CredentialAcquisition> {
    try {
      let installationId = await this.options.database.get(PRIVATE_RECORD_KEYS.browserInstallationId);
      if (typeof installationId !== "string" || !UUID.test(installationId)) {
        installationId = crypto.randomUUID();
        await this.options.database.put(PRIVATE_RECORD_KEYS.browserInstallationId, installationId);
      }
      if (generation !== this.#generation) return { kind: "cancelled" };
      const response = await this.options.fetch(`${this.options.apiBase}/api/extension/device-sessions`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ installationId, platform: "browser", ...(this.options.clientVersion ? { clientVersion: this.options.clientVersion } : {}) }),
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { kind: "unavailable" };
      const body = await response.json() as { status?: unknown; credential?: unknown; session?: { installationId?: unknown; id?: unknown; absoluteExpiresAt?: unknown } };
      if (body?.status !== "issued" || typeof body.credential !== "string" || !DEVICE_TOKEN.test(body.credential)) return { kind: "unavailable" };
      if (generation !== this.#generation || body.session?.installationId !== installationId ||
          typeof body.session?.id !== "string" || !UUID.test(body.session.id) ||
          typeof body.session?.absoluteExpiresAt !== "string" || !(Date.parse(body.session.absoluteExpiresAt) > Date.now())) {
        void this.release(body.credential);
        return { kind: generation !== this.#generation ? "cancelled" : "unavailable" };
      }
      return { kind: "credential", credential: body.credential };
    } catch { return { kind: "unavailable" }; }
  }
}
