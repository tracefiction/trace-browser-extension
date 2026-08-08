import type {
  CanonicalReaderStatus,
  FinishQualificationCommand,
  LibraryEntryPatch,
  LibraryMutationCommand,
  StoryHostKind,
} from "../extension-core/index.mjs";
import type { RuntimeMessageSender } from "./browser-platform.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
  workKeyFromArchiveUrl,
} from "./archive-sender.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_KEY_PATTERN = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
const MAX_COMMAND_BYTES = 8 * 1_024;
const MAX_CHAPTER = 10_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneBoundedRecord(value: unknown): Record<string, unknown> | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!serialized || serialized.length > MAX_COMMAND_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalStatus(value: unknown): CanonicalReaderStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "PLANNING") return "SAVED";
  if (normalized === "COMPLETED") return "FINISHED";
  return (
    normalized === "SAVED" ||
    normalized === "READING" ||
    normalized === "CAUGHT_UP" ||
    normalized === "PAUSED" ||
    normalized === "FINISHED" ||
    normalized === "DROPPED"
  )
    ? normalized
    : null;
}

function chapterProgress(
  value: unknown,
): NonNullable<LibraryEntryPatch["progress"]> | null {
  if (!isRecord(value) || value.unit !== "CHAPTER") return null;
  if (
    !Number.isSafeInteger(value.value) ||
    (value.value as number) < 0 ||
    (value.value as number) > MAX_CHAPTER
  ) {
    return null;
  }
  if (
    value.total !== null &&
    value.total !== undefined &&
    (
      !Number.isSafeInteger(value.total) ||
      (value.total as number) < 0 ||
      (value.total as number) > MAX_CHAPTER
    )
  ) {
    return null;
  }
  return Object.freeze({
    unit: "CHAPTER",
    value: value.value as number,
    total: value.total === undefined ? null : value.total as number | null,
  });
}

function libraryPatch(value: unknown): LibraryEntryPatch | null {
  if (!isRecord(value)) return null;
  const patch: {
    status?: CanonicalReaderStatus;
    progress?: NonNullable<LibraryEntryPatch["progress"]>;
    rating?: number;
    story_snapshot?: NonNullable<LibraryEntryPatch["story_snapshot"]>;
  } = {};
  if (Object.hasOwn(value, "status")) {
    const status = canonicalStatus(value.status);
    if (status === null) return null;
    patch.status = status;
  }
  if (Object.hasOwn(value, "progress")) {
    const progress = chapterProgress(value.progress);
    if (progress === null) return null;
    patch.progress = progress;
  }
  if (Object.hasOwn(value, "rating")) {
    if (
      !Number.isSafeInteger(value.rating) ||
      (value.rating as number) < 0 ||
      (value.rating as number) > 5
    ) {
      return null;
    }
    patch.rating = value.rating as number;
  }
  if (Object.hasOwn(value, "story_snapshot")) {
    if (!isRecord(value.story_snapshot)) return null;
    const keys = Object.keys(value.story_snapshot);
    if (keys.length !== 1 || keys[0] !== "work_status_override") return null;
    const override = value.story_snapshot.work_status_override;
    if (
      override !== null &&
      override !== "wip" &&
      override !== "complete" &&
      override !== "hiatus" &&
      override !== "abandoned"
    ) {
      return null;
    }
    patch.story_snapshot = Object.freeze({ work_status_override: override });
  }
  return Object.keys(patch).length === 0 ? null : Object.freeze(patch);
}

function senderCommandScope(
  sender: RuntimeMessageSender | undefined,
  claimedWorkKey: unknown,
): Readonly<{ hostKind: StoryHostKind; workKey: string }> | null {
  const hostKind = archiveHostKindFromSender(sender);
  if (hostKind === null) return null;
  const senderUrl = sender?.tab?.url ?? sender?.url;
  if (isBlockedArchivePath(senderUrl, hostKind)) return null;
  const workKey =
    typeof claimedWorkKey === "string" ? claimedWorkKey.trim().toLowerCase() : "";
  if (
    !WORK_KEY_PATTERN.test(workKey) ||
    !workKey.startsWith(`${hostKind}:`)
  ) {
    return null;
  }
  const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind);
  if (senderWorkKey !== null && senderWorkKey !== workKey) return null;
  return Object.freeze({ hostKind, workKey });
}

export function libraryMutationCommandFromMessage(
  message: unknown,
  sender: RuntimeMessageSender | undefined,
): LibraryMutationCommand | null {
  if (!isRecord(message) || typeof message.type !== "string") return null;
  const payload = cloneBoundedRecord(message.payload);
  if (payload === null) return null;
  const claimedWorkKey = message.type === "TRACE_SET_HIDDEN_WORK"
    ? payload.key
    : payload.workKey;
  const scope = senderCommandScope(sender, claimedWorkKey);
  if (scope === null) return null;

  if (message.type === "TRACE_SET_HIDDEN_WORK") {
    if (typeof payload.hidden !== "boolean") return null;
    return Object.freeze({
      kind: "work_preference",
      ...scope,
      hidden: payload.hidden,
    });
  }

  const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  if (!UUID_PATTERN.test(entryId)) return null;
  if (message.type === "TRACE_SET_READER_STATUS") {
    const status = canonicalStatus(payload.status);
    if (status === null) return null;
    let progress: LibraryEntryPatch["progress"];
    if (Object.hasOwn(payload, "progress")) {
      const parsed = chapterProgress(payload.progress);
      if (parsed === null) return null;
      progress = parsed;
    }
    return Object.freeze({
      kind: "entry_patch",
      ...scope,
      entryId,
      patch: Object.freeze({
        status,
        ...(progress === undefined ? {} : { progress }),
      }),
    });
  }
  if (message.type !== "TRACE_PATCH_LIBRARY_ENTRY") return null;
  const patch = libraryPatch(payload.patch);
  if (patch === null) return null;
  return Object.freeze({
    kind: "entry_patch",
    ...scope,
    entryId,
    patch,
  });
}

export function finishQualificationCommandFromMessage(
  message: unknown,
  sender: RuntimeMessageSender | undefined,
): FinishQualificationCommand | null {
  if (
    !isRecord(message) ||
    message.type !== "TRACE_FINISH_QUALIFICATION_SIGNAL"
  ) {
    return null;
  }
  const payload = cloneBoundedRecord(message.payload);
  if (payload === null) return null;
  const scope = senderCommandScope(sender, payload.workKey);
  if (scope === null || payload.source !== scope.hostKind) return null;
  const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  if (!UUID_PATTERN.test(entryId)) return null;
  if (
    !Number.isSafeInteger(payload.chapter) ||
    (payload.chapter as number) < 1 ||
    (payload.chapter as number) > MAX_CHAPTER ||
    !Number.isSafeInteger(payload.total) ||
    (payload.total as number) < 1 ||
    (payload.total as number) > MAX_CHAPTER ||
    payload.chapter !== payload.total
  ) {
    return null;
  }
  if (payload.state !== "open" && payload.state !== "resolved") return null;
  const commandBase = {
    kind: "finish_qualification" as const,
    ...scope,
    entryId,
    source: scope.hostKind,
    chapter: payload.chapter as number,
    total: payload.total as number,
  };
  if (payload.state === "open") {
    if (
      Object.hasOwn(payload, "workStatus") ||
      Object.hasOwn(payload, "readerStatus") ||
      Object.hasOwn(payload, "resolutionSource")
    ) {
      return null;
    }
    return Object.freeze({ ...commandBase, state: "open" });
  }
  if (
    payload.workStatus !== "complete" &&
    payload.workStatus !== "wip" &&
    payload.workStatus !== "hiatus" &&
    payload.workStatus !== "abandoned"
  ) {
    return null;
  }
  if (
    payload.readerStatus !== undefined &&
    canonicalStatus(payload.readerStatus) === null
  ) return null;
  if (
    payload.resolutionSource !== undefined &&
    payload.resolutionSource !== "source" &&
    payload.resolutionSource !== "reader"
  ) {
    return null;
  }
  if (
    payload.resolutionSource === "source" &&
    payload.workStatus === "abandoned"
  ) {
    return null;
  }
  return Object.freeze({
    ...commandBase,
    state: "resolved",
    workStatus: payload.workStatus,
    resolutionSource: payload.resolutionSource ?? "reader",
  });
}
