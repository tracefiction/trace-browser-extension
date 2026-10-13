import {
  SafariReadinessService,
  type SafariReadinessAccount,
  type SafariReadinessOutcome,
  type SafariReadinessPreparation,
  type SafariReadinessReport,
  type SafariWebsiteAccessReading,
  type ScriptRegistrationReason,
} from "../extension-core/index.mjs";
import { ARCHIVE_READINESS_MESSAGE_TYPES, runsBesideTraceApp } from "./archive-readiness.mjs";
import { sendNativeMessageWithFallback } from "./browser-adapters.mjs";
import {
  extensionCall,
  type BrowserStorage,
  type PermissionsPort,
  type RuntimePort,
  type ScriptingPort,
} from "./browser-platform.mjs";
import {
  EARNED_PERMISSION_STATE_KEY,
  type EarnedPermissionRegistrationResult,
} from "./earned-permission-registration.mjs";
import { isPopupSender } from "./first-story-initiation.mjs";

/**
 * The readiness report's two messages to the Trace app's side. They sit
 * beside the run receipt, the permission snapshot, the automatic-saving
 * preference and the save confirmation, and change none of them.
 */
export const SAFARI_READINESS_MESSAGES = Object.freeze({
  /** Which provider does the app hold, and which cycle has it open? */
  prepare: "TRACE_IOS_SAFARI_READINESS_PREPARE",
  /** One report, bound to that provider and that cycle. */
  report: "TRACE_IOS_SAFARI_READINESS_REPORT",
});

/**
 * The account session the last report about an account change was made for:
 * the opaque token pages are given, which names no account. It tells a change
 * of account from a background that has merely started again.
 */
export const SAFARI_READINESS_SESSION_KEY = "traceSafariReadinessSessionV1";

const NATIVE_TIMEOUT_MS = 2_000;
const BROWSER_READ_TIMEOUT_MS = 2_000;

/** What the report asks of the session that owns the account. */
export interface SafariReadinessSession {
  accountForThisOpen(): Promise<
    | { readonly state: "verified"; readonly binding: string }
    | { readonly state: "missing" | "reconnect_required" | "unknown" }
  >;
  snapshot(): { readonly state: string; readonly accountId: string | null };
  pageBinding(): string | null;
  automaticSaving(): Promise<"on" | "off" | "unknown">;
}

type Environment = Readonly<{
  runtime: RuntimePort;
  permissions: PermissionsPort;
  scripting?: ScriptingPort;
  storage: BrowserStorage;
  storageMode: "callback" | "promise";
  apiOrigin: string;
  /** The story sites automatic saving needs, and how this build puts its scripts on them. */
  config: Readonly<{
    version: number;
    registrationMode?: "dynamic" | "static";
    origins: readonly string[];
    registrations: readonly Readonly<{ id: string }>[];
  }>;
  /** Resolves once no registration of the page scripts is under way. */
  registrationIdle?: () => Promise<void>;
  /** Read when a report is made; the session is created after this is installed. */
  session: () => SafariReadinessSession | undefined;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Defaults to this context's `navigator`. */
  platform?: { readonly userAgent?: string };
}>;

export type SafariReadinessReporter = Readonly<{
  /** Reads and sends one report. Nothing is sent where there is no Trace app beside this background. */
  report(): Promise<SafariReadinessOutcome>;
  /** The page scripts were registered, removed, or an attempt to register them ended. */
  registrationEnded(result: EarnedPermissionRegistrationResult | null): void;
  /** The automatic-saving preference changed. */
  preferenceChanged(): void;
  /** The account may have changed; a report follows only if its session did. */
  accountMayHaveChanged(): void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * Tells the Trace app, when it asks, whether Trace in Safari is ready to save
 * by itself. The app opens a cycle before it sends the reader to Safari. This
 * background answers when Trace's popup opens, when website access is added
 * or removed, when the page scripts are registered or fail to be, and when
 * the automatic-saving preference or the account changes. Each answer is
 * bound to the provider the app issued and to the cycle that was open when
 * the reading began.
 *
 * iPhone and iPad only. It reads permissions, the registered scripts, the
 * account and one preference: no tab is looked up, nothing runs on a page,
 * and Safari is asked for nothing. With no provider nothing is sent.
 */
export function installSafariReadinessReport(environment: Environment): SafariReadinessReporter {
  const { runtime, permissions, scripting, storage, storageMode, apiOrigin, config } = environment;
  const now = environment.now ?? (() => Date.now());
  const call = <T,>(target: object, method: string, args: unknown[]) =>
    extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, storageMode);
  const beside = runsBesideTraceApp(
    runtime,
    storageMode,
    environment.platform?.userAgent ?? globalThis.navigator?.userAgent ?? "",
  );
  if (beside === false) {
    return Object.freeze({
      report: async (): Promise<SafariReadinessOutcome> => ({ kind: "no_provider" }),
      registrationEnded() {},
      preferenceChanged() {},
      accountMayHaveChanged() {},
    });
  }
  const supported = Promise.resolve(beside);

  /** The last attempt to register the page scripts failed with the sites allowed. */
  let registrationFailed = false;

  const websiteAccess = async (): Promise<SafariWebsiteAccessReading> => {
    if (config.origins.length === 0) return { complete: null, granted: null };
    const [complete, listed] = await Promise.all([
      typeof permissions.contains !== "function"
        ? Promise.resolve(null)
        : bounded(call<unknown>(permissions, "contains", [{ origins: [...config.origins] }]), BROWSER_READ_TIMEOUT_MS),
      bounded(call<unknown>(permissions, "getAll", []), BROWSER_READ_TIMEOUT_MS),
    ]);
    const origins = isRecord(listed) && Array.isArray(listed.origins) ? new Set<unknown>(listed.origins) : null;
    const granted = origins === null ? null : config.origins.filter((origin) => origins.has(origin)).length;
    return {
      // The browser's own answer where it gives one: a broader grant need not
      // list the story sites by name.
      complete: typeof complete === "boolean"
        ? complete
        : granted === null ? null : granted === config.origins.length,
      granted,
    };
  };

  const scriptRegistration = async (): Promise<ScriptRegistrationReason> => {
    if (config.registrationMode === "static") {
      const declared = runtime.getManifest?.().content_scripts;
      return Array.isArray(declared) && declared.length > 0 ? "declared" : "not_registered";
    }
    if (scripting === undefined) return "registration_failed";
    // A registration under way is let finish, so that a grant just made is
    // not reported as having no scripts in the moment before they are in.
    await bounded(environment.registrationIdle?.() ?? Promise.resolve(), 6_000);
    const [current, stored] = await Promise.all([
      bounded(call<unknown>(scripting, "getRegisteredContentScripts", []), BROWSER_READ_TIMEOUT_MS),
      bounded(storage.get(EARNED_PERMISSION_STATE_KEY), BROWSER_READ_TIMEOUT_MS),
    ]);
    if (!Array.isArray(current) || stored === null) return "unreadable";
    const ids = new Set(current.map((script) => (isRecord(script) ? script.id : undefined)));
    const state = stored[EARNED_PERMISSION_STATE_KEY];
    const generation = isRecord(state) ? state.registrationVersion : undefined;
    if (config.registrations.every(({ id }) => ids.has(id)) && generation === config.version) {
      return "registered";
    }
    return registrationFailed ? "registration_failed" : "not_registered";
  };

  const account = async (): Promise<SafariReadinessAccount> => {
    const session = environment.session();
    if (session === undefined) return { state: "pending" };
    const read = await session.accountForThisOpen();
    if (read.state === "verified") {
      const accountId = session.snapshot().accountId;
      return typeof accountId === "string" && accountId.length > 0 && session.pageBinding() === read.binding
        ? { state: "connected", session: read.binding, accountId }
        : { state: "changed" };
    }
    if (read.state === "missing") return { state: "no_account" };
    if (read.state === "reconnect_required") return { state: "reconnect_required" };
    const state = session.snapshot().state;
    return {
      state: state === "initializing" || state === "connecting" || state === "verifying"
        ? "pending"
        : "unreachable",
    };
  };

  const prepare = async (): Promise<SafariReadinessPreparation | null> => {
    const response = await sendNativeMessageWithFallback(
      runtime, storageMode, { type: SAFARI_READINESS_MESSAGES.prepare, apiOrigin }, NATIVE_TIMEOUT_MS,
    );
    if (!isRecord(response) || response.ok !== true || !isRecord(response.provider)) return null;
    const cycle = isRecord(response.cycle) && typeof response.cycle.id === "string"
      ? {
          id: response.cycle.id,
          accountId: typeof response.cycle.accountID === "string" ? response.cycle.accountID : null,
        }
      : null;
    return { provider: response.provider, cycle };
  };

  const deliver = async (
    report: SafariReadinessReport,
    preparation: SafariReadinessPreparation,
  ): Promise<"stored" | "stale_cycle" | "refused"> => {
    const response = await sendNativeMessageWithFallback(runtime, storageMode, {
      type: SAFARI_READINESS_MESSAGES.report,
      version: report.version,
      apiOrigin,
      provider: preparation.provider,
      ...(preparation.cycle === null ? {} : { cycleID: preparation.cycle.id }),
      ...(report.accountId === undefined ? {} : { accountID: report.accountId }),
      observedAt: report.observedAt,
      result: report.result,
      components: report.components,
    }, NATIVE_TIMEOUT_MS);
    if (isRecord(response) && response.ok === true) return "stored";
    return isRecord(response) && response.error === "stale_cycle" ? "stale_cycle" : "refused";
  };

  const service = new SafariReadinessService({
    prepare,
    deliver,
    websiteAccess,
    scriptRegistration,
    account,
    session: () => environment.session()?.pageBinding() ?? null,
    automaticSaving: async () => (await environment.session()?.automaticSaving()) ?? "unknown",
    wait: environment.wait ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
    now,
  });

  const report = async (): Promise<SafariReadinessOutcome> =>
    (await supported) ? service.report() : { kind: "no_provider" };
  const reportQuietly = (): void => {
    void report().catch(() => undefined);
  };

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    // The popup says so each time it opens. Its own listener answers the
    // message; this one only keeps the background awake until the report,
    // which may wait a moment on a second reading, has gone.
    if (
      !isRecord(message) || message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.accessReport ||
      Object.keys(message).length !== 1 || !isPopupSender(sender, runtime.id)
    ) {
      return false;
    }
    void report().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
    return true;
  });
  permissions.onAdded?.addListener(reportQuietly);
  permissions.onRemoved?.addListener(reportQuietly);

  /** The account session the last look found in this background's life. */
  let lastSession: string | null | undefined;
  return Object.freeze({
    report,
    registrationEnded(result) {
      const failed = result !== null && result.error === "registration_failed";
      const changed = failed !== registrationFailed || (result !== null && result.changed);
      registrationFailed = failed;
      // Scripts registered or removed, or an attempt that failed. A reconcile
      // that found everything as it was says nothing new.
      if (changed || failed) reportQuietly();
    },
    preferenceChanged: reportQuietly,
    accountMayHaveChanged() {
      const session = environment.session();
      if (session === undefined) return;
      // An account still being confirmed is not yet a different one.
      const state = session.snapshot().state;
      if (state === "initializing" || state === "connecting" || state === "verifying") return;
      const token = session.pageBinding() ?? "";
      if (token === lastSession) return;
      lastSession = token;
      void (async () => {
        if (!(await supported)) return;
        // A background that has only started again finds the session it last
        // reported for, and says nothing.
        const stored = await storage.get(SAFARI_READINESS_SESSION_KEY);
        if (stored[SAFARI_READINESS_SESSION_KEY] === token) return;
        await storage.set({ [SAFARI_READINESS_SESSION_KEY]: token });
        await report();
      })().catch(() => undefined);
    },
  });
}
