import { type AccountScope } from "./session-model.mjs";

const WORK_KEY_PATTERN = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_OVERLAY_RECORDS = 10_000;

const LEGACY_STATUSES = Object.freeze([
  "PLANNING",
  "READING",
  "PAUSED",
  "COMPLETED",
  "DROPPED",
] as const);
const CANONICAL_STATUSES = Object.freeze([
  "SAVED",
  "READING",
  "CAUGHT_UP",
  "PAUSED",
  "FINISHED",
  "DROPPED",
] as const);
const WORK_STATUSES = Object.freeze([
  "complete",
  "wip",
  "hiatus",
  "abandoned",
  "unknown",
] as const);
const WORK_STATUS_PROVENANCE = Object.freeze(["source", "override", "unknown"] as const);
const CATCHUP_STATES = Object.freeze(["UP", "BEHIND", "UNKNOWN"] as const);

type LegacyStatus = (typeof LEGACY_STATUSES)[number];
type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];
type WorkStatus = (typeof WORK_STATUSES)[number];
type WorkStatusProvenance = (typeof WORK_STATUS_PROVENANCE)[number];
type CatchupState = (typeof CATCHUP_STATES)[number];

export interface AccountSummary {
  readonly pro: boolean;
  readonly libraryCount: number;
  readonly firstStoryCompleted: boolean;
}

export interface LibraryOverlayEntry {
  readonly status: LegacyStatus;
  readonly chapters?: Readonly<{ current: number; total: number | null }>;
  readonly readerStatus?: LegacyStatus;
  readonly canonicalReaderStatus?: CanonicalStatus;
  readonly entryId?: string;
  readonly browsePreference?: Readonly<{ hidden: boolean }>;
  readonly workMark?: Readonly<{
    kind: "abandoned" | "hiatus";
    challenge?: Readonly<{
      kind: "source-updated" | "chapter-count-changed";
      chapterDelta?: number;
    }>;
  }>;
  readonly workStatus?: WorkStatus;
  readonly workStatusProvenance?: WorkStatusProvenance;
  readonly catchupState?: CatchupState;
  readonly newChapterCount?: number;
  readonly rating?: number;
  readonly privateContext?: Readonly<{
    hasNotes: boolean;
    tagCount: number;
    notePreview?: string;
    tags?: readonly string[];
  }>;
}

export interface LibraryWorkPreference {
  readonly browsePreference: Readonly<{ hidden: boolean }>;
}

export interface AccountOverlay {
  readonly entries: Readonly<Record<string, LibraryOverlayEntry>>;
  readonly workPreferences: Readonly<Record<string, LibraryWorkPreference>>;
  /** Opaque response metadata; it is not a monotonic ordering revision. */
  readonly syncVersion: string;
}

export interface AccountCapacityRecovery {
  readonly blockedAt: number;
  readonly blockedLibraryCount: number;
  readonly nextPromptAt: number;
}

export interface AccountDataV1 {
  readonly version: 1;
  readonly scope: AccountScope;
  readonly summary: AccountSummary | null;
  readonly overlay: AccountOverlay | null;
  readonly capacityRecovery: AccountCapacityRecovery | null;
}

export type ParsedAccountData =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly value: AccountDataV1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function enumValue<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && values.includes(value as T) ? value as T : null;
}

function copyScope(value: unknown): AccountScope | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["accountId", "epoch"])) return null;
  if (typeof value.accountId !== "string" || value.accountId.trim() !== value.accountId) return null;
  if (value.accountId.length === 0 || !isSafeInteger(value.epoch)) return null;
  return Object.freeze({ accountId: value.accountId, epoch: value.epoch });
}

function copySummary(value: unknown): AccountSummary | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pro", "libraryCount", "firstStoryCompleted"])) {
    return null;
  }
  if (
    typeof value.pro !== "boolean" ||
    !isSafeInteger(value.libraryCount) ||
    typeof value.firstStoryCompleted !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    pro: value.pro,
    libraryCount: value.libraryCount,
    firstStoryCompleted: value.firstStoryCompleted,
  });
}

function copyCapacityRecovery(value: unknown): AccountCapacityRecovery | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["blockedAt", "blockedLibraryCount", "nextPromptAt"]) ||
    !isSafeInteger(value.blockedAt) ||
    !isSafeInteger(value.blockedLibraryCount) ||
    !isSafeInteger(value.nextPromptAt)
  ) {
    return null;
  }
  return Object.freeze({
    blockedAt: value.blockedAt,
    blockedLibraryCount: value.blockedLibraryCount,
    nextPromptAt: value.nextPromptAt,
  });
}

function copyBrowsePreference(value: unknown): Readonly<{ hidden: boolean }> | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["hidden"]) ||
    typeof value.hidden !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({ hidden: value.hidden });
}

function copyChapters(
  value: unknown,
): Readonly<{ current: number; total: number | null }> | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["current", "total"])) return null;
  if (!isSafeInteger(value.current)) return null;
  if (value.total !== null && !isSafeInteger(value.total, 1)) return null;
  return Object.freeze({ current: value.current, total: value.total });
}

function copyWorkMark(
  value: unknown,
): NonNullable<LibraryOverlayEntry["workMark"]> | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "challenge"])) return null;
  if (value.kind !== "abandoned" && value.kind !== "hiatus") return null;
  let challenge: NonNullable<LibraryOverlayEntry["workMark"]>["challenge"];
  if (Object.hasOwn(value, "challenge")) {
    const raw = value.challenge;
    if (!isRecord(raw) || !hasOnlyKeys(raw, ["kind", "chapterDelta"])) return null;
    if (raw.kind !== "source-updated" && raw.kind !== "chapter-count-changed") return null;
    if (Object.hasOwn(raw, "chapterDelta") && !isSafeInteger(raw.chapterDelta, 1)) return null;
    challenge = Object.freeze({
      kind: raw.kind,
      ...(Object.hasOwn(raw, "chapterDelta") ? { chapterDelta: raw.chapterDelta as number } : {}),
    });
  }
  return Object.freeze({
    kind: value.kind,
    ...(challenge === undefined ? {} : { challenge }),
  });
}

function copyPrivateContext(
  value: unknown,
): NonNullable<LibraryOverlayEntry["privateContext"]> | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["hasNotes", "tagCount", "notePreview", "tags"]) ||
    typeof value.hasNotes !== "boolean" ||
    !isSafeInteger(value.tagCount)
  ) {
    return null;
  }
  let notePreview: string | undefined;
  if (Object.hasOwn(value, "notePreview")) {
    if (
      typeof value.notePreview !== "string" ||
      value.notePreview.length > 180 ||
      value.notePreview.trim() !== value.notePreview
    ) {
      return null;
    }
    notePreview = value.notePreview;
  }
  let tags: readonly string[] | undefined;
  if (Object.hasOwn(value, "tags")) {
    if (!Array.isArray(value.tags) || value.tags.length > 5) return null;
    const copied: string[] = [];
    for (const tag of value.tags) {
      if (
        typeof tag !== "string" ||
        tag.length === 0 ||
        tag.length > 100 ||
        tag.trim() !== tag
      ) {
        return null;
      }
      copied.push(tag);
    }
    tags = Object.freeze(copied);
  }
  return Object.freeze({
    hasNotes: value.hasNotes,
    tagCount: value.tagCount,
    ...(notePreview === undefined ? {} : { notePreview }),
    ...(tags === undefined ? {} : { tags }),
  });
}

function copyEntry(value: unknown): LibraryOverlayEntry | null {
  if (!isRecord(value)) return null;
  const status = enumValue(LEGACY_STATUSES, value.status);
  if (status === null) return null;
  const result: {
    status: LegacyStatus;
    chapters?: NonNullable<LibraryOverlayEntry["chapters"]>;
    readerStatus?: LegacyStatus;
    canonicalReaderStatus?: CanonicalStatus;
    entryId?: string;
    browsePreference?: NonNullable<LibraryOverlayEntry["browsePreference"]>;
    workMark?: NonNullable<LibraryOverlayEntry["workMark"]>;
    workStatus?: WorkStatus;
    workStatusProvenance?: WorkStatusProvenance;
    catchupState?: CatchupState;
    newChapterCount?: number;
    rating?: number;
    privateContext?: NonNullable<LibraryOverlayEntry["privateContext"]>;
  } = { status };

  if (Object.hasOwn(value, "chapters")) {
    const chapters = copyChapters(value.chapters);
    if (chapters === null) return null;
    result.chapters = chapters;
  }
  if (Object.hasOwn(value, "readerStatus")) {
    const readerStatus = enumValue(LEGACY_STATUSES, value.readerStatus);
    if (readerStatus === null || readerStatus !== status) return null;
    result.readerStatus = readerStatus;
  }
  if (Object.hasOwn(value, "canonicalReaderStatus")) {
    const canonical = enumValue(CANONICAL_STATUSES, value.canonicalReaderStatus);
    if (canonical === null) return null;
    result.canonicalReaderStatus = canonical;
  }
  if (Object.hasOwn(value, "entryId")) {
    if (typeof value.entryId !== "string" || !UUID_PATTERN.test(value.entryId)) return null;
    result.entryId = value.entryId;
  }
  if (Object.hasOwn(value, "browsePreference")) {
    const preference = copyBrowsePreference(value.browsePreference);
    if (preference === null) return null;
    result.browsePreference = preference;
  }
  if (Object.hasOwn(value, "workMark")) {
    const mark = copyWorkMark(value.workMark);
    if (mark === null) return null;
    result.workMark = mark;
  }
  if (Object.hasOwn(value, "workStatus")) {
    const workStatus = enumValue(WORK_STATUSES, value.workStatus);
    if (workStatus === null) return null;
    result.workStatus = workStatus;
  }
  if (Object.hasOwn(value, "workStatusProvenance")) {
    const provenance = enumValue(WORK_STATUS_PROVENANCE, value.workStatusProvenance);
    if (provenance === null) return null;
    result.workStatusProvenance = provenance;
  }
  if (Object.hasOwn(value, "catchupState")) {
    const catchup = enumValue(CATCHUP_STATES, value.catchupState);
    if (catchup === null) return null;
    result.catchupState = catchup;
  }
  if (Object.hasOwn(value, "newChapterCount")) {
    if (!isSafeInteger(value.newChapterCount)) return null;
    result.newChapterCount = value.newChapterCount;
  }
  if (Object.hasOwn(value, "rating")) {
    if (!isSafeInteger(value.rating) || value.rating > 5) return null;
    result.rating = value.rating;
  }
  if (Object.hasOwn(value, "privateContext")) {
    const context = copyPrivateContext(value.privateContext);
    if (context === null) return null;
    result.privateContext = context;
  }
  return Object.freeze(result);
}

function copyEntryMap(value: unknown): Readonly<Record<string, LibraryOverlayEntry>> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_OVERLAY_RECORDS) return null;
  const result: Record<string, LibraryOverlayEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.length > 32 || !WORK_KEY_PATTERN.test(key)) return null;
    const entry = copyEntry(raw);
    if (entry === null) return null;
    result[key] = entry;
  }
  return Object.freeze(result);
}

function copyPreferenceMap(
  value: unknown,
): Readonly<Record<string, LibraryWorkPreference>> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_OVERLAY_RECORDS) return null;
  const result: Record<string, LibraryWorkPreference> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.length > 32 || !WORK_KEY_PATTERN.test(key) || !isRecord(raw)) return null;
    if (!hasOnlyKeys(raw, ["browsePreference"])) return null;
    const preference = copyBrowsePreference(raw.browsePreference);
    if (preference === null) return null;
    result[key] = Object.freeze({ browsePreference: preference });
  }
  return Object.freeze(result);
}

function copyOverlay(value: unknown): AccountOverlay | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["entries", "workPreferences", "syncVersion"])) {
    return null;
  }
  const entries = copyEntryMap(value.entries);
  const workPreferences = copyPreferenceMap(value.workPreferences);
  if (entries === null || workPreferences === null) return null;
  if (
    typeof value.syncVersion !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value.syncVersion) ||
    !Number.isFinite(Date.parse(value.syncVersion)) ||
    new Date(value.syncVersion).toISOString() !== value.syncVersion
  ) {
    return null;
  }
  return Object.freeze({ entries, workPreferences, syncVersion: value.syncVersion });
}

export function parseAccountData(value: unknown): ParsedAccountData {
  if (value === null || value === undefined) return { kind: "missing" };
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "scope",
      "summary",
      "overlay",
      "capacityRecovery",
    ]) ||
    value.version !== 1 ||
    !Object.hasOwn(value, "summary") ||
    !Object.hasOwn(value, "overlay")
  ) {
    return { kind: "invalid" };
  }
  const scope = copyScope(value.scope);
  if (scope === null) return { kind: "invalid" };
  const summary = value.summary === null ? null : copySummary(value.summary);
  if (value.summary !== null && summary === null) return { kind: "invalid" };
  const overlay = value.overlay === null ? null : copyOverlay(value.overlay);
  if (value.overlay !== null && overlay === null) return { kind: "invalid" };
  const rawCapacityRecovery = Object.hasOwn(value, "capacityRecovery")
    ? value.capacityRecovery
    : null;
  const capacityRecovery = rawCapacityRecovery === null
    ? null
    : copyCapacityRecovery(rawCapacityRecovery);
  if (rawCapacityRecovery !== null && capacityRecovery === null) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    value: Object.freeze({
      version: 1,
      scope,
      summary,
      overlay,
      capacityRecovery,
    }),
  };
}

export function createEmptyAccountData(scope: AccountScope): AccountDataV1 {
  const parsed = parseAccountData({
    version: 1,
    scope,
    summary: null,
    overlay: null,
    capacityRecovery: null,
  });
  if (parsed.kind !== "valid") throw new TypeError("invalid account scope");
  return parsed.value;
}

export function copyAccountSummary(value: unknown): AccountSummary | null {
  return copySummary(value);
}

export function copyAccountOverlay(value: unknown): AccountOverlay | null {
  return copyOverlay(value);
}

export function copyLibraryOverlayEntry(value: unknown): LibraryOverlayEntry | null {
  return copyEntry(value);
}
