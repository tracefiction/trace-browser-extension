import type {
  AccountDataV1,
  LibraryCommandFailure,
  LibraryMutationResult,
  LibraryOverlayEntry,
  LibraryWorkPreference,
  MetadataContributionFailure,
  MetadataContributionResult,
  SavedFilterSyncFailure,
  SavedFilterSyncResult,
  SessionActionResult,
  SessionSnapshot,
  StoryCommandFailure,
  StoryCommandResult,
  FinishQualificationResult,
} from "../extension-core/index.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
} from "./archive-sender.mjs";
import type { RuntimeMessageSender, RuntimePort } from "./browser-platform.mjs";
import type {
  FirstStoryInitiationError,
} from "./first-story-initiation.mjs";
import type {
  ArchiveErrorKind,
  PublicArchiveReadiness,
} from "./archive-readiness-status.mjs";
import { SAVED_FILTER_SYNC_MESSAGE } from "./saved-filter-sync-sender.mjs";
import { TRACE_WEB_OPEN_MESSAGE } from "./trace-web-navigation.mjs";

export type SessionMode = "kernel" | "disabled";
export type SessionAction = "connect" | "cancel" | "disconnect" | "retry" | "reconnect";

export const SESSION_MESSAGE_TYPES = Object.freeze({
  snapshot: "TRACE_SESSION_GET_SNAPSHOT",
  action: "TRACE_SESSION_ACTION",
  connectAndSave: "TRACE_CONNECT_AND_SAVE",
  quickAdd: "TRACE_QUICK_ADD",
  autoTrack: "TRACE_AUTO_TRACK",
  metadataBroadcast: "TRACE_METADATA_BROADCAST",
  libraryMetadataRefresh: "TRACE_LIBRARY_METADATA_REFRESH",
  savedFilterSync: SAVED_FILTER_SYNC_MESSAGE,
  projection: "TRACE_ACCOUNT_PROJECTION_GET",
  workState: "TRACE_WORK_STATE_GET",
  popupState: "TRACE_POPUP_GET_STATE",
  importTrigger: "TRACE_IMPORT_TRIGGER",
  firstStoryAdd: "TRACE_FIRST_STORY_ADD",
  setHiddenWork: "TRACE_SET_HIDDEN_WORK",
  setReaderStatus: "TRACE_SET_READER_STATUS",
  patchLibraryEntry: "TRACE_PATCH_LIBRARY_ENTRY",
  finishQualification: "TRACE_FINISH_QUALIFICATION_SIGNAL",
  pendingFirstStory: "TRACE_IOS_PENDING_FIRST_STORY_GET",
  status: "TRACE_EXTENSION_STATUS_QUERY",
  openTraceUrl: TRACE_WEB_OPEN_MESSAGE,
});

export type PublicSessionSnapshot = Pick<
  SessionSnapshot,
  "state" | "reason" | "canExecuteAuthenticated"
>;

export interface PublicWorkState {
  readonly workKey: string;
  readonly status: "saved";
  readonly entryId?: string;
  readonly entry: LibraryOverlayEntry;
  readonly syncVersion: string;
}

interface PublicProjection {
  readonly entries: Readonly<Record<string, LibraryOverlayEntry>>;
  readonly workPreferences: Readonly<Record<string, LibraryWorkPreference>>;
  readonly syncVersion: string | null;
}

export interface RuntimeResponse {
  readonly ok: boolean;
  readonly snapshot: PublicSessionSnapshot;
  readonly action?: SessionActionResult;
  readonly command?:
    | StoryCommandResult
    | LibraryMutationResult
    | FinishQualificationResult
    | MetadataContributionResult;
  readonly entryId?: string;
  readonly state?: PublicWorkState;
  readonly error?:
    | "commands_unavailable"
    | "runtime_unavailable"
    | "auto_track_disabled"
    | StoryCommandFailure
    | LibraryCommandFailure
    | MetadataContributionFailure;
}

export interface ProjectionResponse {
  readonly ok: true;
  readonly snapshot: PublicSessionSnapshot;
  readonly projection: PublicProjection;
}

export interface WorkStateResponse {
  readonly ok: true;
  readonly snapshot: PublicSessionSnapshot;
  readonly state: PublicWorkState | null;
}

export interface SavedFilterRuntimeResponse {
  readonly ok: boolean;
  readonly snapshot: PublicSessionSnapshot;
  readonly sync: SavedFilterSyncResult;
  readonly error?: SavedFilterSyncFailure;
}

export interface TraceWebNavigationResponse {
  readonly ok: boolean;
  readonly error?: "commands_unavailable" | "invalid_trace_url" | "open_failed";
}

export interface FirstStoryResponse {
  readonly ok: boolean;
  readonly snapshot: PublicSessionSnapshot;
  readonly action?: SessionActionResult;
  readonly state?: "opened" | "saved" | "already_saved";
  readonly error?: FirstStoryInitiationError;
}

export interface PopupStateResponse {
  readonly ok: true;
  readonly authState: PublicSessionSnapshot;
  readonly firstSaveSeen: boolean;
  readonly libraryCount: number | null;
  readonly activeTab: Readonly<Record<string, unknown>>;
  readonly pro: boolean;
  readonly autoTrackEnabled: boolean;
  readonly libraryInlayEnabled: boolean;
  readonly ao3SavedFiltersEnabled: boolean;
  readonly metadataImproveEnabled: boolean;
}

export interface ExtensionStatusResponse {
  readonly installed: true;
  readonly connected: boolean;
  readonly authState: "connected" | "signed_out" | "reconnect_required" | "error" | "unknown";
  readonly firstSaveSeen?: boolean;
  readonly browserKind?: "chrome" | "firefox" | "safari" | "unknown";
  readonly capabilities?: Readonly<{ firstStoryAdd: true }>;
  readonly lastArchiveSeenAt?: number;
  readonly lastArchiveHostKind?: "ao3" | "ffn" | "unknown";
  readonly lastArchiveActionAt?: number;
  readonly lastArchiveActionKind?: "track" | "quick_add" | "import" | "metadata";
  readonly lastArchiveErrorKind?: ArchiveErrorKind;
}

export const WORK_KEY_PATTERN = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
const MAX_PROJECTION_WORK_KEYS = 250;

export const POPUP_PREFERENCE_KEYS = Object.freeze([
  "prefAutoTrackEnabled",
  "prefLibraryInlayEnabled",
  "prefAo3SavedFiltersEnabled",
  "prefMetadataImproveEnabled",
] as const);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSessionAction(value: unknown): value is SessionAction {
  return (
    value === "connect" ||
    value === "cancel" ||
    value === "disconnect" ||
    value === "retry" ||
    value === "reconnect"
  );
}

export function toPublicSessionSnapshot(snapshot: SessionSnapshot): PublicSessionSnapshot {
  return Object.freeze({
    state: snapshot.state,
    reason: snapshot.reason,
    canExecuteAuthenticated: snapshot.canExecuteAuthenticated,
  });
}

export function toExtensionStatus(
  snapshot: SessionSnapshot,
  options: {
    readonly firstSaveSeen?: boolean;
    readonly browserKind?: ExtensionStatusResponse["browserKind"];
    readonly readiness?: PublicArchiveReadiness;
  } = {},
): ExtensionStatusResponse {
  const authState: ExtensionStatusResponse["authState"] =
    snapshot.state === "connected"
      ? "connected"
      : snapshot.state === "signed_out"
        ? "signed_out"
        : snapshot.state === "reconnect_required"
          ? "reconnect_required"
          : "unknown";
  return Object.freeze({
    installed: true,
    connected: snapshot.state === "connected",
    authState,
    ...(options.firstSaveSeen === undefined
      ? {}
      : { firstSaveSeen: options.firstSaveSeen }),
    ...(options.browserKind === undefined
      ? {}
      : { browserKind: options.browserKind }),
    capabilities: Object.freeze({ firstStoryAdd: true as const }),
    ...(options.readiness ?? {}),
  });
}

export function browserKind(runtime: RuntimePort): ExtensionStatusResponse["browserKind"] {
  if (typeof runtime.getURL !== "function") return "unknown";
  try {
    const value = runtime.getURL("");
    if (typeof value !== "string") return "unknown";
    if (value.startsWith("chrome-extension://")) return "chrome";
    if (value.startsWith("moz-extension://")) return "firefox";
    if (value.startsWith("safari-web-extension://")) return "safari";
  } catch {
    // Unknown browser is a safe additive status value.
  }
  return "unknown";
}

export function boundedProjectionWorkKeys(
  value: unknown,
  sender: RuntimeMessageSender | undefined,
): readonly string[] | null {
  const host = archiveHostKindFromSender(sender);
  if (host === null || !Array.isArray(value) || value.length > MAX_PROJECTION_WORK_KEYS) {
    return null;
  }
  const senderUrl = sender?.tab?.url ?? sender?.url;
  if (isBlockedArchivePath(senderUrl, host)) return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !WORK_KEY_PATTERN.test(candidate) ||
      !candidate.startsWith(`${host}:`)
    ) {
      return null;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      keys.push(candidate);
    }
  }
  return Object.freeze(keys);
}

export function publicProjection(
  accountData: AccountDataV1 | null,
  workKeys: readonly string[],
): PublicProjection {
  const entries: Record<string, LibraryOverlayEntry> = {};
  const workPreferences: Record<string, LibraryWorkPreference> = {};
  const overlay = accountData?.overlay;
  if (overlay !== null && overlay !== undefined) {
    for (const workKey of workKeys) {
      const entry = overlay.entries[workKey];
      const preference = overlay.workPreferences[workKey];
      if (entry !== undefined) entries[workKey] = entry;
      if (preference !== undefined) workPreferences[workKey] = preference;
    }
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    workPreferences: Object.freeze(workPreferences),
    syncVersion: overlay?.syncVersion ?? null,
  });
}

export function publicWorkState(
  accountData: AccountDataV1 | null,
  workKey: string,
): PublicWorkState | null {
  const overlay = accountData?.overlay;
  const entry = overlay?.entries[workKey];
  if (overlay === null || overlay === undefined || entry === undefined) return null;
  return Object.freeze({
    workKey,
    status: "saved",
    ...(entry.entryId === undefined ? {} : { entryId: entry.entryId }),
    entry,
    syncVersion: overlay.syncVersion,
  });
}
