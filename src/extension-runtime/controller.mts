import {
  AccountProjectionService,
  SessionService,
  type DiagnosticEvent,
  type DiagnosticsPort,
  FinishQualificationService,
  LibraryMutationService,
  MetadataContributionService,
  SavedFilterSyncService,
  type FinishQualificationResult,
  type LibraryMutationResult,
  type MetadataContributionCommand,
  type MetadataContributionFailure,
  type MetadataContributionResult,
  type SavedFilterSyncResult,
  type SessionActionResult,
  type SessionSnapshot,
  StoryCommandService,
  type StoryCommandFailure,
  type StoryCommandResult,
  type StoryTrackCommand,
} from "../extension-core/index.mjs";
import {
  BrowserCredentialPort,
  BrowserSessionStoragePort,
  ExplicitCredentialProvider,
  KernelAlarmState,
  LegacyAccountState,
  NativePendingFirstStoryReader,
  NativePendingStoryHandoffPort,
  NativeStorySaveReceiptPort,
  VerificationApi,
  type PendingFirstStoryResponse,
} from "./browser-adapters.mjs";
import {
  BrowserStorage,
  type AlarmsPort,
  type RuntimePort,
  type StorageArea,
  type TabsPort,
} from "./browser-platform.mjs";
import {
  BrowserPrivateRecordDatabase,
  type PrivateRecordDatabase,
} from "./private-database.mjs";
import { AccountDataRepository } from "./account-data-repository.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
  workKeyFromArchiveUrl,
} from "./archive-sender.mjs";
import {
  AccountStoryProjectionPort,
  StoryCommandApi,
} from "./story-command.mjs";
import { AccountProjectionApi } from "./account-projection.mjs";
import {
  AccountLibraryCommandProjection,
  LibraryCommandApi,
} from "./library-command.mjs";
import {
  finishQualificationCommandFromMessage,
  libraryMutationCommandFromMessage,
} from "./library-command-sender.mjs";
import {
  BrowserFirstStoryInitiator,
  classifyActiveTabUrl,
  firstStoryInitiationFromMessage,
  isPopupSender,
  isTraceWebSender,
  type FirstStoryInitiation,
  type FirstStoryInitiationResult,
} from "./first-story-initiation.mjs";
import {
  BrowserMetadataPreferencePort,
  MetadataContributionApi,
  TraceWebMetadataNotificationPort,
} from "./metadata-contribution.mjs";
import {
  metadataContributionCommandFromMessage,
} from "./metadata-contribution-sender.mjs";
import {
  BrowserSavedFilterRepository,
  SavedFilterSyncAlarm,
  SavedFilterSyncApi,
} from "./saved-filter-sync.mjs";
import {
  isSavedFilterSyncRequest,
} from "./saved-filter-sync-sender.mjs";
import { storyTrackCommandFromMessage } from "./story-command-sender.mjs";
import {
  BrowserTraceWebNavigation,
  traceWebNavigationRequestFromMessage,
} from "./trace-web-navigation.mjs";
import {
  TraceWebStatusNotification,
} from "./trace-web-status.mjs";
import {
  BrowserArchiveReadinessStatus,
  type ArchiveErrorKind,
  type PublicArchiveReadiness,
} from "./archive-readiness-status.mjs";
import {
  POPUP_PREFERENCE_KEYS,
  SESSION_MESSAGE_TYPES,
  WORK_KEY_PATTERN,
  boundedProjectionWorkKeys,
  browserKind,
  isRecord,
  isSessionAction,
  publicProjection,
  publicWorkState,
  toExtensionStatus,
  toPublicSessionSnapshot,
  type ExtensionStatusResponse,
  type FirstStoryResponse,
  type PopupStateResponse,
  type ProjectionResponse,
  type RuntimeResponse,
  type SavedFilterRuntimeResponse,
  type SessionAction,
  type SessionMode,
  type TraceWebNavigationResponse,
  type WorkStateResponse,
} from "./runtime-messages.mjs";

export {
  SESSION_MESSAGE_TYPES,
  type SessionMode,
} from "./runtime-messages.mjs";

interface RuntimeEnvironment {
  readonly mode: SessionMode;
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly alarms: AlarmsPort;
  readonly storageArea: StorageArea;
  readonly databaseFactory: IDBFactory;
  readonly privateDatabase?: PrivateRecordDatabase;
  readonly storageMode: "callback" | "promise";
  readonly fetch: typeof fetch;
  readonly apiBase: string;
  readonly webOrigin: string;
  readonly randomId: () => string;
  readonly retryClock?: RetryClock;
  readonly firstStoryDelay?: (milliseconds: number) => Promise<void>;
  readonly archiveReadinessStatus?: BrowserArchiveReadinessStatus;
}

interface RetryClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface NativeAuthorityPreparation {
  readonly ready: boolean;
  readonly action?: SessionActionResult;
}

type RuntimeHandleResponse =
  | RuntimeResponse
  | ExtensionStatusResponse
  | PendingFirstStoryResponse
  | ProjectionResponse
  | WorkStateResponse
  | PopupStateResponse
  | FirstStoryResponse
  | SavedFilterRuntimeResponse
  | TraceWebNavigationResponse
  | null;

const DEGRADED_STORAGE_SNAPSHOT: SessionSnapshot = Object.freeze({
  state: "degraded",
  accountId: null,
  canExecuteAuthenticated: false,
  reason: "storage_unavailable",
});

const DISABLED_SNAPSHOT: SessionSnapshot = Object.freeze({
  state: "signed_out",
  accountId: null,
  canExecuteAuthenticated: false,
  reason: "none",
});

const RETRY_DELAYS_MS = Object.freeze([750, 2_500, 8_000] as const);

const DEFAULT_RETRY_CLOCK: RetryClock = Object.freeze({
  setTimeout(callback: () => void, delayMs: number) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle: unknown) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

type RuntimeSender = Parameters<Parameters<RuntimePort["onMessage"]["addListener"]>[0]>[1];

function isSupportedArchiveSender(sender: RuntimeSender | undefined): boolean {
  return archiveHostKindFromSender(sender) !== null;
}

class MemoryDiagnostics implements DiagnosticsPort {
  readonly #events: DiagnosticEvent[] = [];

  record(event: DiagnosticEvent): void {
    this.#events.push(Object.freeze({ ...event }));
    if (this.#events.length > 80) this.#events.shift();
  }
}

export class SessionRuntimeController {
  readonly #mode: SessionMode;
  readonly #sessionStorage: BrowserSessionStoragePort;
  readonly #credentials: BrowserCredentialPort;
  readonly #database: PrivateRecordDatabase;
  readonly #legacy: LegacyAccountState;
  readonly #alarms: KernelAlarmState;
  readonly #pendingFirstStory: NativePendingFirstStoryReader;
  readonly #service: SessionService;
  readonly #accountData: AccountDataRepository;
  readonly #storyCommands: StoryCommandService;
  readonly #libraryMutations: LibraryMutationService;
  readonly #finishQualification: FinishQualificationService;
  readonly #metadataContributions: MetadataContributionService;
  readonly #savedFilters: SavedFilterSyncService;
  readonly #savedFilterApi: SavedFilterSyncApi;
  readonly #firstStoryInitiator: BrowserFirstStoryInitiator;
  readonly #traceWebNavigation: BrowserTraceWebNavigation;
  readonly #traceWebStatus: TraceWebStatusNotification;
  readonly #archiveReadinessStatus: BrowserArchiveReadinessStatus;
  readonly #projection: AccountProjectionService;
  readonly #storage: BrowserStorage;
  readonly #runtime: RuntimePort;
  readonly #tabs: TabsPort;
  readonly #storageMode: "callback" | "promise";
  readonly #webOrigin: string;
  readonly #retryClock: RetryClock;
  #initialization: Promise<void> | null = null;
  #storageFailure = false;
  #automaticVerificationRetry = false;
  #retryAttempt = 0;
  #retryGeneration = 0;
  #retryTimer: unknown | null = null;
  #isIos: Promise<boolean> | null = null;
  #nativeAuthorityPreparation: Promise<NativeAuthorityPreparation> | null = null;
  #accountTransitionTail: Promise<void> = Promise.resolve();
  #savedFilterSyncInFlight: Promise<SavedFilterSyncResult> | null = null;
  #savedFilterSyncQueued = false;
  #savedFilterSyncQueuedWithCurrentAuthority = false;
  #lastPublishedStatusKey: string | null = null;
  #statusPublicationTail: Promise<void> = Promise.resolve();

  constructor(environment: RuntimeEnvironment) {
    this.#mode = environment.mode;
    const storage = new BrowserStorage(
      environment.storageArea,
      environment.runtime,
      environment.storageMode,
    );
    this.#storage = storage;
    this.#archiveReadinessStatus =
      environment.archiveReadinessStatus ??
      new BrowserArchiveReadinessStatus(storage);
    this.#runtime = environment.runtime;
    this.#tabs = environment.tabs;
    this.#storageMode = environment.storageMode;
    this.#webOrigin = new URL(environment.webOrigin).origin;
    this.#database = environment.privateDatabase ?? new BrowserPrivateRecordDatabase(
      environment.databaseFactory,
    );
    this.#sessionStorage = new BrowserSessionStoragePort(this.#database);
    this.#legacy = new LegacyAccountState(storage);
    this.#alarms = new KernelAlarmState(
      environment.alarms,
      environment.runtime,
      environment.storageMode,
    );
    this.#pendingFirstStory = new NativePendingFirstStoryReader(
      environment.runtime,
      environment.storageMode,
    );
    this.#retryClock = environment.retryClock ?? DEFAULT_RETRY_CLOCK;
    this.#credentials = new BrowserCredentialPort(
      this.#database,
      new ExplicitCredentialProvider({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin,
        randomId: environment.randomId,
      }),
      environment.randomId,
    );
    this.#service = new SessionService({
      storage: this.#sessionStorage,
      credentials: this.#credentials,
      api: new VerificationApi(environment.fetch, environment.apiBase, (disposition) => {
        this.#automaticVerificationRetry = disposition === "automatic";
      }),
      diagnostics: new MemoryDiagnostics(),
    });
    this.#savedFilterApi = new SavedFilterSyncApi(
      environment.fetch,
      environment.apiBase,
    );
    this.#savedFilters = new SavedFilterSyncService({
      session: this.#service,
      api: this.#savedFilterApi,
      repository: new BrowserSavedFilterRepository({
        storage,
        session: this.#service,
        randomId: environment.randomId,
      }),
      clock: { now: () => new Date().toISOString() },
    });
    this.#accountData = new AccountDataRepository(this.#database, this.#service);
    this.#projection = new AccountProjectionService({
      session: this.#service,
      api: new AccountProjectionApi(environment.fetch, environment.apiBase),
      repository: this.#accountData,
      clock: { now: () => Date.now() },
    });
    this.#metadataContributions = new MetadataContributionService({
      session: this.#service,
      api: new MetadataContributionApi(environment.fetch, environment.apiBase),
      preference: new BrowserMetadataPreferencePort(storage),
      authority: {
        prepare: async () => {
          const preparation = await this.#prepareNativeAuthority();
          if (!preparation.ready) throw new Error("native authority unavailable");
        },
      },
      projection: {
        invalidate: () => this.#projection.invalidate(),
      },
      notification: new TraceWebMetadataNotificationPort({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin,
      }),
    });
    const libraryCommandPorts = {
      session: this.#service,
      api: new LibraryCommandApi(environment.fetch, environment.apiBase),
      projection: new AccountLibraryCommandProjection(this.#projection),
    };
    this.#libraryMutations = new LibraryMutationService(libraryCommandPorts);
    this.#finishQualification = new FinishQualificationService(libraryCommandPorts);
    this.#firstStoryInitiator = new BrowserFirstStoryInitiator({
      runtime: environment.runtime,
      tabs: environment.tabs,
      mode: environment.storageMode,
      webOrigin: environment.webOrigin,
      ...(environment.firstStoryDelay === undefined
        ? {}
        : { delay: environment.firstStoryDelay }),
    });
    this.#traceWebNavigation = new BrowserTraceWebNavigation({
      runtime: environment.runtime,
      tabs: environment.tabs,
      mode: environment.storageMode,
    });
    this.#traceWebStatus = new TraceWebStatusNotification({
      runtime: environment.runtime,
      tabs: environment.tabs,
      mode: environment.storageMode,
      webOrigin: environment.webOrigin,
    });
    this.#storyCommands = new StoryCommandService({
      session: this.#service,
      api: new StoryCommandApi(environment.fetch, environment.apiBase),
      projection: new AccountStoryProjectionPort(this.#accountData),
      receipt: new NativeStorySaveReceiptPort(
        environment.runtime,
        environment.storageMode,
      ),
      handoff: new NativePendingStoryHandoffPort(
        environment.runtime,
        environment.storageMode,
      ),
      clock: { now: () => Date.now() },
    });
  }

  start(): Promise<void> {
    this.#initialization ??= this.#startOnce();
    return this.#initialization;
  }

  snapshot(): SessionSnapshot {
    if (this.#storageFailure) return DEGRADED_STORAGE_SNAPSHOT;
    if (this.#mode === "disabled") return DISABLED_SNAPSHOT;
    return this.#service.snapshot();
  }

  async handle(
    message: unknown,
    sender?: RuntimeSender,
  ): Promise<RuntimeHandleResponse> {
    if (!isRecord(message) || typeof message.type !== "string") return null;
    if (!Object.values(SESSION_MESSAGE_TYPES).includes(message.type as never)) return null;
    switch (message.type) {
      case SESSION_MESSAGE_TYPES.snapshot:
      case SESSION_MESSAGE_TYPES.action:
        return this.#handleSessionMessage(message, sender);
      case SESSION_MESSAGE_TYPES.status:
        return this.#handleStatusMessage(message, sender);
      case SESSION_MESSAGE_TYPES.openTraceUrl:
        return this.#handleTraceNavigationMessage(message, sender);
      case SESSION_MESSAGE_TYPES.pendingFirstStory:
      case SESSION_MESSAGE_TYPES.projection:
      case SESSION_MESSAGE_TYPES.workState:
      case SESSION_MESSAGE_TYPES.popupState:
        return this.#handleReadMessage(message, sender);
      case SESSION_MESSAGE_TYPES.savedFilterSync:
        return this.#handleSavedFilterMessage(message, sender);
      case SESSION_MESSAGE_TYPES.importTrigger:
      case SESSION_MESSAGE_TYPES.firstStoryAdd:
        return this.#handleFirstStoryMessage(message, sender);
      case SESSION_MESSAGE_TYPES.metadataBroadcast:
      case SESSION_MESSAGE_TYPES.libraryMetadataRefresh:
        return this.#handleMetadataMessage(message, sender);
      case SESSION_MESSAGE_TYPES.setHiddenWork:
      case SESSION_MESSAGE_TYPES.setReaderStatus:
      case SESSION_MESSAGE_TYPES.patchLibraryEntry:
      case SESSION_MESSAGE_TYPES.finishQualification:
        return this.#handleLibraryMessage(message, sender);
      case SESSION_MESSAGE_TYPES.connectAndSave:
      case SESSION_MESSAGE_TYPES.quickAdd:
      case SESSION_MESSAGE_TYPES.autoTrack:
        return this.#handleStoryMessage(message, sender);
      default:
        return null;
    }
  }

  async #handleSessionMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<RuntimeResponse | null> {
    if (
      !isPopupSender(sender, this.#runtime.id) &&
      !isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)
    ) {
      return null;
    }
    if (
      (message.type === SESSION_MESSAGE_TYPES.snapshot &&
        Object.keys(message).length !== 1) ||
      (message.type === SESSION_MESSAGE_TYPES.action &&
        Object.keys(message).length !== 2)
    ) {
      return null;
    }
    await this.start();
    if (message.type === SESSION_MESSAGE_TYPES.snapshot) return this.#response();
    if (!isSessionAction(message.action)) return this.#response({ kind: "ignored" });
    return this.#response(await this.#runManualAction(message.action, true));
  }

  async #handleStatusMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<ExtensionStatusResponse | null> {
    await this.start();
    if (
      Object.keys(message).length !== 2 ||
      typeof message.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(message.nonce) ||
      !isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)
    ) {
      return null;
    }
    return this.#extensionStatus();
  }

  async #handleTraceNavigationMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<TraceWebNavigationResponse | null> {
    const request = traceWebNavigationRequestFromMessage(
      message,
      sender,
      this.#webOrigin,
    );
    if (request === null) return null;
    await this.start();
    if (this.#mode === "disabled") {
      return Object.freeze({ ok: false, error: "commands_unavailable" });
    }
    if (request.kind === "invalid") {
      return Object.freeze({ ok: false, error: "invalid_trace_url" });
    }
    return await this.#traceWebNavigation.open(request.url)
      ? Object.freeze({ ok: true })
      : Object.freeze({ ok: false, error: "open_failed" });
  }

  async #handleReadMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<
    | PendingFirstStoryResponse
    | ProjectionResponse
    | WorkStateResponse
    | PopupStateResponse
    | null
  > {
    await this.start();
    if (message.type === SESSION_MESSAGE_TYPES.pendingFirstStory) {
      return isSupportedArchiveSender(sender)
        ? this.#pendingFirstStory.read()
        : { ok: false, error: "native_unavailable" };
    }
    if (message.type === SESSION_MESSAGE_TYPES.projection) {
      const workKeys = boundedProjectionWorkKeys(message.workKeys, sender);
      if (workKeys === null) return null;
      await this.#bootstrapNativeAuthorityForArchiveRead();
      const accountData = await this.#projection.read();
      return Object.freeze({
        ok: true,
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        projection: publicProjection(accountData, workKeys),
      });
    }
    if (message.type === SESSION_MESSAGE_TYPES.workState) {
      const host = archiveHostKindFromSender(sender);
      const workKey = typeof message.workKey === "string" ? message.workKey : "";
      const senderUrl = sender?.tab?.url ?? sender?.url;
      if (
        host === null ||
        isBlockedArchivePath(senderUrl, host) ||
        !WORK_KEY_PATTERN.test(workKey) ||
        workKey !== workKeyFromArchiveUrl(senderUrl, host)
      ) {
        return null;
      }
      await this.#bootstrapNativeAuthorityForArchiveRead();
      const accountData = await this.#projection.read();
      return Object.freeze({
        ok: true,
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        state: publicWorkState(accountData, workKey),
      });
    }
    if (!isPopupSender(sender, this.#runtime.id)) return null;
    return this.#popupState();
  }

  async #handleSavedFilterMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<SavedFilterRuntimeResponse | null> {
    if (!isSavedFilterSyncRequest(message, sender)) return null;
    await this.start();
    return this.#savedFilterResponse(await this.#runSavedFilterSync());
  }

  async #handleFirstStoryMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<FirstStoryResponse | null> {
    const initiation = firstStoryInitiationFromMessage(
      message,
      sender,
      this.#runtime.id,
      this.#webOrigin,
    );
    if (initiation === null) return null;
    await this.start();
    if (initiation.kind === "invalid") {
      return this.#firstStoryResponse({
        ok: false,
        error: initiation.error,
      }, undefined, initiation);
    }
    const preparation = initiation.kind === "web_save"
      ? await this.#prepareNativeAuthority()
      : { ready: true as const };
    const action = preparation.action;
    if (!preparation.ready || this.snapshot().state !== "connected") {
      return this.#firstStoryResponse(
        { ok: false, error: "not_authenticated" },
        action,
        initiation,
      );
    }
    const result = initiation.kind === "popup_import"
      ? await this.#firstStoryInitiator.importActivePage()
      : await this.#firstStoryInitiator.saveFromTrace(initiation.url);
    return this.#firstStoryResponse(result, action, initiation);
  }

  async #handleMetadataMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<RuntimeResponse | null> {
    const command = metadataContributionCommandFromMessage(message, sender);
    if (command === null) return null;
    await this.start();
    return this.#metadataContributionResponse(
      await this.#metadataContributions.execute(command),
      command,
    );
  }

  async #handleLibraryMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<RuntimeResponse | null> {
    const finishCommand = message.type === SESSION_MESSAGE_TYPES.finishQualification
      ? finishQualificationCommandFromMessage(message, sender)
      : null;
    const libraryCommand = message.type === SESSION_MESSAGE_TYPES.finishQualification
      ? null
      : libraryMutationCommandFromMessage(message, sender);
    if (finishCommand === null && libraryCommand === null) return null;
    await this.start();
    const preparation = await this.#prepareNativeAuthority();
    const action = preparation.action;
    if (!preparation.ready || this.snapshot().state !== "connected") {
      const reason = action?.kind === "unavailable"
        ? "unavailable" as const
        : "not_authenticated" as const;
      return finishCommand === null
        ? this.#libraryCommandResponse(
            { kind: "failed", reason },
            action,
          )
        : this.#finishQualificationResponse(
            { kind: "failed", reason },
            action,
          );
    }
    return finishCommand === null
      ? this.#libraryCommandResponse(
          await this.#libraryMutations.execute(libraryCommand!),
          action,
        )
      : this.#finishQualificationResponse(
          await this.#finishQualification.execute(finishCommand),
          action,
        );
  }

  async #handleStoryMessage(
    message: Record<string, unknown>,
    sender: RuntimeSender | undefined,
  ): Promise<RuntimeResponse | null> {
    const command = storyTrackCommandFromMessage(message, sender);
    if (command === null) return null;
    await this.start();
    if (message.type === SESSION_MESSAGE_TYPES.connectAndSave) {
      const preparation = await this.#prepareNativeAuthority();
      const action = preparation.action ??
        await this.#runManualAction(
          this.snapshot().state === "connected" ? "reconnect" : "connect",
        );
      if (!preparation.ready && preparation.action !== undefined) {
        return this.#commandResponse(
          {
            kind: "failed",
            reason: action.kind === "unavailable"
              ? "unavailable"
              : "not_authenticated",
          },
          action,
          command,
        );
      }
      if (this.snapshot().state !== "connected") {
        return this.#commandResponse(
          { kind: "failed", reason: "not_authenticated" },
          action,
          command,
        );
      }
      return this.#commandResponse(
        await this.#storyCommands.execute(command),
        action,
        command,
      );
    }
    if (message.type === SESSION_MESSAGE_TYPES.quickAdd) {
      const preparation = await this.#prepareNativeAuthority();
      if (!preparation.ready) {
        return this.#commandResponse(
          {
            kind: "failed",
            reason: preparation.action?.kind === "unavailable"
              ? "unavailable"
              : "not_authenticated",
          },
          preparation.action,
          command,
        );
      }
      return this.#commandResponse(
        await this.#storyCommands.execute(command),
        preparation.action,
        command,
      );
    }
    const preferences = await this.#storage
      .get("prefAutoTrackEnabled")
      .catch((): Record<string, unknown> => ({}));
    if (preferences.prefAutoTrackEnabled === false) {
      return this.#response(undefined, "auto_track_disabled");
    }
    const preparation = await this.#prepareNativeAuthority();
    const action = preparation.action;
    if (!preparation.ready || this.snapshot().state !== "connected") {
      return this.#commandResponse(
        {
          kind: "failed",
          reason: action?.kind === "unavailable"
            ? "unavailable"
            : "not_authenticated",
        },
        action,
        command,
      );
    }
    return this.#commandResponse(
      await this.#storyCommands.execute(command),
      action,
      command,
    );
  }

  async #startOnce(): Promise<void> {
    try {
      if (this.#mode === "disabled") {
        await this.#legacy.clearAll();
        await this.#alarms.clearAll();
        await this.#database.deleteDatabase();
      } else {
        await this.#legacy.clear();
        await this.#alarms.clearRetired();
        this.#automaticVerificationRetry = false;
        await this.#service.start();
      }
      this.#storageFailure = false;
    } catch {
      this.#storageFailure = true;
    }
    this.#reconcileAutomaticRetry();
  }

  async #retryInitialization(): Promise<SessionActionResult> {
    if (!this.#storageFailure) return { kind: "ignored" };
    try {
      if (this.#mode === "disabled") {
        await this.#legacy.clearAll();
        await this.#alarms.clearAll();
        await this.#database.deleteDatabase();
      } else {
        await this.#legacy.clear();
        await this.#alarms.clearRetired();
        await this.#service.start();
      }
      this.#storageFailure = false;
      return this.#mode === "disabled"
        ? { kind: "completed", state: "signed_out" }
        : { kind: "ignored" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async #runAction(action: SessionAction): Promise<SessionActionResult> {
    if (action === "connect" || action === "retry" || action === "reconnect") {
      this.#automaticVerificationRetry = false;
    }
    if (action === "retry" && this.#storageFailure) return this.#retryInitialization();
    if (this.#storageFailure || this.#mode === "disabled") return { kind: "ignored" };

    if (action === "connect") return this.#service.connect();
    if (action === "retry") return this.#service.retry();
    if (action === "cancel") {
      const result = await this.#service.cancelConnect();
      await this.#clearLegacyAfterDisconnect(result);
      return result;
    }
    if (action === "disconnect") {
      const result = await this.#service.disconnect();
      await this.#clearLegacyAfterDisconnect(result);
      return result;
    }

    const disconnected = await this.#service.disconnect();
    await this.#clearLegacyAfterDisconnect(disconnected);
    if (disconnected.kind !== "completed" || disconnected.state !== "signed_out") {
      return disconnected;
    }
    return this.#service.connect();
  }

  async #runManualAction(
    action: SessionAction,
    scheduleSavedFilters = false,
  ): Promise<SessionActionResult> {
    if (this.#savedFilterSyncInFlight !== null) {
      this.#savedFilters.cancel();
      this.#savedFilterApi.cancelPending();
    }
    const result = await this.#withAccountTransitionLock(
      () => this.#runManualActionUnlocked(action),
    );
    this.#publishStatus();
    if (
      scheduleSavedFilters &&
      result.kind === "completed" &&
      result.state === "connected"
    ) {
      this.#queueSavedFilterSync(true);
    }
    return result;
  }

  async #runManualActionUnlocked(action: SessionAction): Promise<SessionActionResult> {
    this.#cancelAutomaticRetry(true);
    const result = await this.#runAction(action);
    this.#reconcileAutomaticRetry();
    return result;
  }

  #automaticRetryIsEligible(): boolean {
    const snapshot = this.snapshot();
    return (
      snapshot.state === "degraded" &&
      (
        snapshot.reason === "storage_unavailable" ||
        (snapshot.reason === "verification_unavailable" && this.#automaticVerificationRetry)
      )
    );
  }

  #reconcileAutomaticRetry(): void {
    if (!this.#automaticRetryIsEligible()) {
      this.#cancelAutomaticRetry(true);
      return;
    }
    if (this.#retryTimer !== null || this.#retryAttempt >= RETRY_DELAYS_MS.length) return;
    const generation = this.#retryGeneration;
    const delayMs = RETRY_DELAYS_MS[this.#retryAttempt]!;
    this.#retryAttempt += 1;
    this.#retryTimer = this.#retryClock.setTimeout(() => {
      this.#retryTimer = null;
      void this.#runAutomaticRetry(generation);
    }, delayMs);
  }

  async #runAutomaticRetry(generation: number): Promise<void> {
    if (generation !== this.#retryGeneration || !this.#automaticRetryIsEligible()) return;
    await this.#withAccountTransitionLock(() => this.#runAction("retry"));
    this.#publishStatus();
    if (generation !== this.#retryGeneration) return;
    this.#reconcileAutomaticRetry();
  }

  #cancelAutomaticRetry(resetAttempt: boolean): void {
    this.#retryGeneration += 1;
    if (this.#retryTimer !== null) {
      this.#retryClock.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (resetAttempt) this.#retryAttempt = 0;
  }

  async #clearLegacyAfterDisconnect(result: SessionActionResult): Promise<void> {
    if (result.kind !== "completed" || result.state !== "signed_out") return;
    try {
      await this.#accountData.clear();
    } catch {
      // Exact publication scopes still fence any stale account root. Cleanup is
      // retried by later disconnect/disabled-mode database deletion.
    }
    try {
      await this.#legacy.clear();
    } catch {
      // The higher persisted epoch owns correctness. Legacy cleanup is retried
      // on every boot and never permits the gated legacy owner to run.
    }
  }

  #response(action?: SessionActionResult, error?: RuntimeResponse["error"]): RuntimeResponse {
    return Object.freeze({
      ok: true as const,
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      ...(action === undefined ? {} : { action }),
      ...(error === undefined ? {} : { error }),
    });
  }

  async #commandResponse(
    command: StoryCommandResult,
    action?: SessionActionResult,
    request?: StoryTrackCommand,
  ): Promise<RuntimeResponse> {
    if (request !== undefined) {
      await this.#recordStoryReadiness(request, command);
    }
    this.#publishStatus();
    return Object.freeze({
      ok: command.kind === "confirmed",
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      ...(action === undefined ? {} : { action }),
      command,
      ...(command.kind === "confirmed"
        ? {
            entryId: command.confirmation.entryId,
            state: Object.freeze({
              workKey: command.confirmation.workKey,
              status: "saved" as const,
              entryId: command.confirmation.entryId,
              entry: command.confirmation.entry,
              syncVersion: command.confirmation.syncVersion,
            }),
          }
        : { error: command.reason }),
    });
  }

  #libraryCommandResponse(
    command: LibraryMutationResult,
    action?: SessionActionResult,
  ): RuntimeResponse {
    this.#publishStatus();
    return Object.freeze({
      ok: command.kind === "confirmed",
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      ...(action === undefined ? {} : { action }),
      command,
      ...(command.kind === "confirmed"
        ? {
            ...(command.entryId === undefined ? {} : { entryId: command.entryId }),
          }
        : { error: command.reason }),
    });
  }

  #finishQualificationResponse(
    command: FinishQualificationResult,
    action?: SessionActionResult,
  ): RuntimeResponse {
    this.#publishStatus();
    return Object.freeze({
      ok: command.kind === "acknowledged",
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      ...(action === undefined ? {} : { action }),
      command,
      ...(command.kind === "failed" ? { error: command.reason } : {}),
    });
  }

  async #metadataContributionResponse(
    command: MetadataContributionResult,
    request: MetadataContributionCommand,
  ): Promise<RuntimeResponse> {
    await this.#recordMetadataReadiness(request, command);
    this.#publishStatus();
    return Object.freeze({
      ok: command.kind !== "failed",
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      command,
      ...(command.kind === "failed" ? { error: command.reason } : {}),
    });
  }

  #savedFilterResponse(sync: SavedFilterSyncResult): SavedFilterRuntimeResponse {
    this.#publishStatus();
    return Object.freeze({
      ok: sync.kind !== "failed",
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      sync,
      ...(sync.kind === "failed" ? { error: sync.reason } : {}),
    });
  }

  async #firstStoryResponse(
    result: FirstStoryInitiationResult,
    action?: SessionActionResult,
    initiation?: FirstStoryInitiation,
  ): Promise<FirstStoryResponse> {
    if (initiation?.kind === "popup_import") {
      await this.#recordImportReadiness(result);
    }
    this.#publishStatus();
    return Object.freeze({
      ok: result.ok,
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      ...(action === undefined ? {} : { action }),
      ...(result.ok ? { state: result.state } : { error: result.error }),
    });
  }

  async #recordStoryReadiness(
    request: StoryTrackCommand,
    result: StoryCommandResult,
  ): Promise<void> {
    try {
      if (result.kind === "confirmed") {
        await this.#archiveReadinessStatus.record({
          hostKind: request.hostKind,
          actionKind: request.intent === "record_progress" ? "track" : "quick_add",
        });
        return;
      }
      const errorKind = this.#archiveErrorKind(result.reason);
      if (errorKind !== null) {
        await this.#archiveReadinessStatus.record({
          hostKind: request.hostKind,
          errorKind,
        });
      }
    } catch {
      // Coarse onboarding evidence cannot change a command's confirmed result.
    }
  }

  async #recordMetadataReadiness(
    request: MetadataContributionCommand,
    result: MetadataContributionResult,
  ): Promise<void> {
    try {
      if (
        result.kind === "accepted" &&
        (request.kind === "story_metadata" || result.updated)
      ) {
        await this.#archiveReadinessStatus.record({
          hostKind: request.hostKind,
          actionKind: "metadata",
        });
        return;
      }
      if (result.kind === "failed") {
        const errorKind = this.#archiveErrorKind(result.reason);
        if (errorKind !== null) {
          await this.#archiveReadinessStatus.record({
            hostKind: request.hostKind,
            errorKind,
          });
        }
      }
    } catch {
      // Metadata success and failure semantics do not depend on status hints.
    }
  }

  async #recordImportReadiness(result: FirstStoryInitiationResult): Promise<void> {
    let hostKind: "ao3" | "ffn" | "unknown" = "unknown";
    try {
      const tabs = await this.#callTabsQuery({ active: true, currentWindow: true });
      const context = classifyActiveTabUrl(tabs[0]?.url, this.#webOrigin);
      if ("site" in context) hostKind = context.site;
      if (result.ok && result.state === "opened") {
        await this.#archiveReadinessStatus.record({ hostKind, actionKind: "import" });
        return;
      }
      if (!result.ok) {
        const errorKind: ArchiveErrorKind =
          result.error === "permission_required"
            ? "permission"
            : result.error === "unsupported_page" ||
                result.error === "no_active_tab" ||
                result.error === "invalid_url"
              ? "unsupported_page"
              : result.error === "collect_failed"
                ? "parser"
                : "unknown";
        await this.#archiveReadinessStatus.record({ hostKind, errorKind });
      }
    } catch {
      // The primary import response remains authoritative.
    }
  }

  #archiveErrorKind(
    reason:
      | StoryCommandFailure
      | MetadataContributionFailure,
  ): ArchiveErrorKind | null {
    if (reason === "not_authenticated" || reason === "auth_expired") return "auth";
    if (reason === "invalid_request" || reason === "invalid_response") return "parser";
    if (
      reason === "unavailable" ||
      reason === "rate_limited" ||
      reason === "confirmation_missing"
    ) {
      return "network";
    }
    return null;
  }

  async #bootstrapNativeAuthorityForArchiveRead(): Promise<void> {
    const state = this.snapshot().state;
    if (state !== "signed_out" && state !== "reconnect_required") return;
    if (!(await this.#usesNativeAccountAuthority())) return;
    await this.#prepareNativeAuthority();
  }

  #prepareNativeAuthority(): Promise<NativeAuthorityPreparation> {
    if (this.#nativeAuthorityPreparation !== null) {
      return this.#nativeAuthorityPreparation;
    }
    const operation = this.#prepareNativeAuthorityOnce();
    this.#nativeAuthorityPreparation = operation;
    void operation.then(
      () => {
        if (this.#nativeAuthorityPreparation === operation) {
          this.#nativeAuthorityPreparation = null;
        }
      },
      () => {
        if (this.#nativeAuthorityPreparation === operation) {
          this.#nativeAuthorityPreparation = null;
        }
      },
    );
    return operation;
  }

  async #prepareNativeAuthorityOnce(): Promise<NativeAuthorityPreparation> {
    if (!(await this.#usesNativeAccountAuthority())) {
      return Object.freeze({ ready: true });
    }
    return this.#withAccountTransitionLock(
      () => this.#prepareNativeAuthorityUnlocked(),
    );
  }

  async #prepareNativeAuthorityUnlocked(): Promise<NativeAuthorityPreparation> {
    const before = this.#service.publicationScope();
    const action = await this.#service.synchronizeProviderCredential();
    const after = this.#service.publicationScope();
    const scopeChanged =
      before?.accountId !== after?.accountId ||
      before?.epoch !== after?.epoch;

    if (scopeChanged) {
      try {
        await this.#accountData.clear();
      } catch {
        // Scope fencing already makes the old record unreadable. Cleanup is
        // hygiene and must not weaken the durable session transition.
      }
      this.#projection.invalidate();
    }

    return Object.freeze({
      ready:
        action.kind === "completed" &&
        action.state === "connected" &&
        after !== null,
      action,
    });
  }

  requestSavedFilterSync(): void {
    if (this.#mode === "kernel") this.#queueSavedFilterSync();
  }

  #queueSavedFilterSync(nativeAuthorityCurrent = false): void {
    if (this.#mode !== "kernel") return;
    this.#savedFilterSyncQueuedWithCurrentAuthority ||= nativeAuthorityCurrent;
    if (this.#savedFilterSyncQueued) return;
    this.#savedFilterSyncQueued = true;
    queueMicrotask(() => {
      const authorityCurrent = this.#savedFilterSyncQueuedWithCurrentAuthority;
      this.#savedFilterSyncQueued = false;
      this.#savedFilterSyncQueuedWithCurrentAuthority = false;
      void this.#runSavedFilterSync(authorityCurrent);
    });
  }

  #runSavedFilterSync(
    nativeAuthorityCurrent = false,
  ): Promise<SavedFilterSyncResult> {
    this.#savedFilterSyncInFlight ??= this.#withAccountTransitionLock(async () => {
      if (!nativeAuthorityCurrent && await this.#usesNativeAccountAuthority()) {
        const preparation = await this.#prepareNativeAuthorityUnlocked();
        if (!preparation.ready) {
          return Object.freeze({
            kind: "failed" as const,
            reason:
              preparation.action?.kind === "unavailable"
                ? "unavailable" as const
                : "not_authenticated" as const,
          });
        }
      }
      if (this.snapshot().state !== "connected") {
        return Object.freeze({
          kind: "failed" as const,
          reason: "not_authenticated" as const,
        });
      }
      return this.#savedFilters.sync();
    }).finally(() => {
      this.#savedFilterSyncInFlight = null;
    });
    return this.#savedFilterSyncInFlight;
  }

  async #withAccountTransitionLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#accountTransitionTail;
    let release = (): void => {};
    this.#accountTransitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  #publishStatus(): void {
    this.#statusPublicationTail = this.#statusPublicationTail
      .then(async () => {
        const status = await this.#extensionStatus();
        const statusKey = JSON.stringify(status);
        if (statusKey === this.#lastPublishedStatusKey) return;
        this.#lastPublishedStatusKey = statusKey;
        await this.#traceWebStatus.publish(status);
      })
      .catch(() => {
        // Trace-page notification is best effort and never changes account
        // state or the outcome returned to the initiating extension surface.
      });
  }

  async #extensionStatus(): Promise<ExtensionStatusResponse> {
    const [accountData, readiness] = await Promise.all([
      this.#accountData.read().catch(() => null),
      this.#archiveReadinessStatus.read().catch(
        (): PublicArchiveReadiness => Object.freeze({}),
      ),
    ]);
    return toExtensionStatus(this.snapshot(), {
      firstSaveSeen:
        accountData?.summary?.firstStoryCompleted === true ||
        Object.keys(accountData?.overlay?.entries ?? {}).length > 0,
      browserKind: browserKind(this.#runtime),
      readiness,
    });
  }

  async #popupState(): Promise<PopupStateResponse> {
    const [accountData, preferences, activeTab] = await Promise.all([
      this.#projection.read(),
      this.#storage
        .get(POPUP_PREFERENCE_KEYS)
        .catch((): Record<string, unknown> => ({})),
      this.#activeTabContext(),
    ]);
    return Object.freeze({
      ok: true,
      authState: toPublicSessionSnapshot(this.snapshot()),
      firstSaveSeen: accountData?.summary?.firstStoryCompleted === true,
      libraryCount: accountData?.summary?.libraryCount ?? null,
      activeTab,
      pro: accountData?.summary?.pro === true,
      autoTrackEnabled: preferences.prefAutoTrackEnabled !== false,
      libraryInlayEnabled: preferences.prefLibraryInlayEnabled !== false,
      ao3SavedFiltersEnabled: preferences.prefAo3SavedFiltersEnabled !== false,
      metadataImproveEnabled: preferences.prefMetadataImproveEnabled !== false,
    });
  }

  async #activeTabContext(): Promise<Readonly<Record<string, unknown>>> {
    try {
      const tabs = await this.#callTabsQuery({ active: true, currentWindow: true });
      return classifyActiveTabUrl(tabs[0]?.url, this.#webOrigin);
    } catch {
      return Object.freeze({ kind: "unknown" });
    }
  }

  #callTabsQuery(query: Readonly<Record<string, unknown>>): Promise<readonly {
    readonly url?: string;
  }[]> {
    if (this.#storageMode === "promise") {
      try {
        return Promise.resolve(
          this.#tabs.query(query) as
            | readonly { readonly url?: string }[]
            | PromiseLike<readonly { readonly url?: string }[]>,
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      try {
        this.#tabs.query(query, (tabs: readonly { readonly url?: string }[]) => {
          const message = this.#runtime.lastError?.message;
          if (message) reject(new Error(message));
          else resolve(tabs);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  #usesNativeAccountAuthority(): Promise<boolean> {
    this.#isIos ??= (async () => {
      if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) return true;
      if (typeof this.#runtime.getPlatformInfo !== "function") return false;
      try {
        let value: unknown;
        if (this.#storageMode === "promise") {
          value = await this.#runtime.getPlatformInfo();
        } else {
          value = await new Promise((resolve, reject) => {
            this.#runtime.getPlatformInfo!((info: unknown) => {
              const message = this.#runtime.lastError?.message;
              if (message) reject(new Error(message));
              else resolve(info);
            });
          });
        }
        return isRecord(value) && value.os === "ios";
      } catch {
        return false;
      }
    })();
    return this.#isIos;
  }
}

export function installSessionRuntime(environment: RuntimeEnvironment): SessionRuntimeController {
  const controller = new SessionRuntimeController(environment);
  if (environment.mode === "kernel") {
    SavedFilterSyncAlarm.install(
      environment.alarms,
      environment.runtime,
      () => controller.requestSavedFilterSync(),
    );
  }
  environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message) || !Object.values(SESSION_MESSAGE_TYPES).includes(message.type as never)) {
      return false;
    }
    void controller.handle(message, sender).then(
      (response) => sendResponse(response),
      () => sendResponse({
        ok: false,
        snapshot: toPublicSessionSnapshot(DEGRADED_STORAGE_SNAPSHOT),
        error: "runtime_unavailable",
      }),
    );
    return true;
  });
  void controller.start();
  return controller;
}
