// Generated kernel runtime. Do not edit by hand.
const TRACE_API_BASE = "https://api.tracefiction.com";
const TRACE_WEB_ORIGIN = "https://www.tracefiction.com";
(() => {
  // src/extension-core/archive-readiness.mts
  var ARCHIVE_RUN_THROTTLE_MS = 5 * 60 * 1e3;
  var SYSTEM_CLOCK = Object.freeze({
    now: () => Date.now()
  });
  var ArchiveReadinessService = class {
    #receipts;
    #permissions;
    #clock;
    #lastRunAttemptByHost = /* @__PURE__ */ new Map();
    constructor(options) {
      this.#receipts = options.receipts;
      this.#permissions = options.permissions;
      this.#clock = options.clock ?? SYSTEM_CLOCK;
    }
    async recordRun(input) {
      const at = this.#clock.now();
      const lastAttempt = this.#lastRunAttemptByHost.get(input.hostKind);
      if (input.handoffId === void 0 && lastAttempt !== void 0 && at - lastAttempt < ARCHIVE_RUN_THROTTLE_MS) {
        return { kind: "throttled" };
      }
      this.#lastRunAttemptByHost.set(input.hostKind, at);
      const receipt = Object.freeze({
        hostKind: input.hostKind,
        at,
        ...input.handoffId === void 0 ? {} : { handoffId: input.handoffId }
      });
      let published = false;
      try {
        published = await this.#receipts.publishRunReceipt(receipt);
      } catch {
        published = false;
      }
      if (!published) {
        if (this.#lastRunAttemptByHost.get(input.hostKind) === at) {
          this.#lastRunAttemptByHost.delete(input.hostKind);
        }
        return { kind: "unavailable" };
      }
      void this.#publishPermissionSnapshot(input.hostKind);
      return { kind: "published" };
    }
    async #publishPermissionSnapshot(hostKind2) {
      let grantedOrigins = null;
      try {
        grantedOrigins = await this.#permissions.readGrantedOrigins();
      } catch {
        return;
      }
      if (grantedOrigins === null) return;
      try {
        await this.#receipts.publishPermissionSnapshot(Object.freeze({
          hostKind: hostKind2,
          at: this.#clock.now(),
          grantedOrigins: Object.freeze([...grantedOrigins])
        }));
      } catch {
      }
    }
  };

  // src/extension-core/session-model.mts
  var SESSION_ENVELOPE_VERSION = 1;
  var INITIAL_SESSION_ENVELOPE = Object.freeze({
    version: SESSION_ENVELOPE_VERSION,
    epoch: 0,
    desired: "disconnected",
    accountId: null,
    credentialRef: null
  });
  var INITIAL_SESSION_MODEL = Object.freeze({
    state: "initializing",
    epoch: 0,
    accountId: null,
    publicationScope: null,
    displayScope: null,
    reason: "none"
  });
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isNullableIdentifier(value) {
    return value === null || typeof value === "string" && value.length > 0;
  }
  function parseSessionEnvelope(raw) {
    if (raw === null || raw === void 0) return { kind: "missing" };
    if (!isRecord(raw)) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (raw.version !== SESSION_ENVELOPE_VERSION) {
      return { kind: "invalid", reason: "unsupported_envelope" };
    }
    if (!Number.isSafeInteger(raw.epoch) || raw.epoch < 0) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (raw.desired !== "disconnected" && raw.desired !== "connected") {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (!isNullableIdentifier(raw.accountId) || !isNullableIdentifier(raw.credentialRef)) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    if (raw.desired === "disconnected" && (raw.accountId !== null || raw.credentialRef !== null)) {
      return { kind: "invalid", reason: "malformed_envelope" };
    }
    return {
      kind: "valid",
      envelope: Object.freeze({
        version: SESSION_ENVELOPE_VERSION,
        epoch: raw.epoch,
        desired: raw.desired,
        accountId: raw.accountId,
        credentialRef: raw.credentialRef
      })
    };
  }
  function reduceSession(_model, event) {
    switch (event.type) {
      case "signed_out":
        return {
          state: "signed_out",
          epoch: event.epoch,
          accountId: null,
          publicationScope: null,
          displayScope: null,
          reason: event.reason ?? "none"
        };
      case "connecting":
        return {
          state: "connecting",
          epoch: event.epoch,
          accountId: null,
          publicationScope: null,
          displayScope: null,
          reason: "none"
        };
      case "verifying":
        return {
          state: "verifying",
          epoch: event.epoch,
          accountId: event.accountId,
          publicationScope: null,
          displayScope: null,
          reason: "none"
        };
      case "connected":
        return {
          state: "connected",
          epoch: event.scope.epoch,
          accountId: event.scope.accountId,
          publicationScope: event.scope,
          displayScope: event.scope,
          reason: "none"
        };
      case "degraded":
        return {
          state: "degraded",
          epoch: event.epoch,
          accountId: event.displayScope?.accountId ?? null,
          publicationScope: null,
          displayScope: event.displayScope,
          reason: event.reason
        };
      case "reconnect_required":
        return {
          state: "reconnect_required",
          epoch: event.epoch,
          accountId: null,
          publicationScope: null,
          displayScope: null,
          reason: event.reason
        };
    }
  }
  function toSessionSnapshot(model) {
    return Object.freeze({
      state: model.state,
      accountId: model.accountId,
      canExecuteAuthenticated: model.publicationScope !== null,
      reason: model.reason
    });
  }
  function sameAccountScope(left, right) {
    return left !== null && right !== null && left.accountId === right.accountId && left.epoch === right.epoch;
  }

  // src/extension-core/account-scope.mts
  function canSyncSavedFilters(publicationScope, repositoryScope) {
    return sameAccountScope(publicationScope, repositoryScope);
  }

  // src/extension-core/account-data.mts
  var WORK_KEY_PATTERN = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  var MAX_OVERLAY_RECORDS = 1e4;
  var LEGACY_STATUSES = Object.freeze([
    "PLANNING",
    "READING",
    "PAUSED",
    "COMPLETED",
    "DROPPED"
  ]);
  var CANONICAL_STATUSES = Object.freeze([
    "SAVED",
    "READING",
    "CAUGHT_UP",
    "PAUSED",
    "FINISHED",
    "DROPPED"
  ]);
  var WORK_STATUSES = Object.freeze([
    "complete",
    "wip",
    "hiatus",
    "abandoned",
    "unknown"
  ]);
  var WORK_STATUS_PROVENANCE = Object.freeze(["source", "override", "unknown"]);
  var CATCHUP_STATES = Object.freeze(["UP", "BEHIND", "UNKNOWN"]);
  function isRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
  }
  function isSafeInteger(value, minimum = 0) {
    return Number.isSafeInteger(value) && value >= minimum;
  }
  function enumValue(values, value) {
    return typeof value === "string" && values.includes(value) ? value : null;
  }
  function copyScope(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["accountId", "epoch"])) return null;
    if (typeof value.accountId !== "string" || value.accountId.trim() !== value.accountId) return null;
    if (value.accountId.length === 0 || !isSafeInteger(value.epoch)) return null;
    return Object.freeze({ accountId: value.accountId, epoch: value.epoch });
  }
  function copySummary(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["pro", "libraryCount", "firstStoryCompleted"])) {
      return null;
    }
    if (typeof value.pro !== "boolean" || !isSafeInteger(value.libraryCount) || typeof value.firstStoryCompleted !== "boolean") {
      return null;
    }
    return Object.freeze({
      pro: value.pro,
      libraryCount: value.libraryCount,
      firstStoryCompleted: value.firstStoryCompleted
    });
  }
  function copyCapacityRecovery(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["blockedAt", "blockedLibraryCount", "nextPromptAt"]) || !isSafeInteger(value.blockedAt) || !isSafeInteger(value.blockedLibraryCount) || !isSafeInteger(value.nextPromptAt)) {
      return null;
    }
    return Object.freeze({
      blockedAt: value.blockedAt,
      blockedLibraryCount: value.blockedLibraryCount,
      nextPromptAt: value.nextPromptAt
    });
  }
  function copyBrowsePreference(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["hidden"]) || typeof value.hidden !== "boolean") {
      return null;
    }
    return Object.freeze({ hidden: value.hidden });
  }
  function copyChapters(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["current", "total"])) return null;
    if (!isSafeInteger(value.current)) return null;
    if (value.total !== null && !isSafeInteger(value.total, 1)) return null;
    return Object.freeze({ current: value.current, total: value.total });
  }
  function copyWorkMark(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["kind", "challenge"])) return null;
    if (value.kind !== "abandoned" && value.kind !== "hiatus") return null;
    let challenge;
    if (Object.hasOwn(value, "challenge")) {
      const raw = value.challenge;
      if (!isRecord2(raw) || !hasOnlyKeys(raw, ["kind", "chapterDelta"])) return null;
      if (raw.kind !== "source-updated" && raw.kind !== "chapter-count-changed") return null;
      if (Object.hasOwn(raw, "chapterDelta") && !isSafeInteger(raw.chapterDelta, 1)) return null;
      challenge = Object.freeze({
        kind: raw.kind,
        ...Object.hasOwn(raw, "chapterDelta") ? { chapterDelta: raw.chapterDelta } : {}
      });
    }
    return Object.freeze({
      kind: value.kind,
      ...challenge === void 0 ? {} : { challenge }
    });
  }
  function copyPrivateContext(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["hasNotes", "tagCount", "notePreview", "tags"]) || typeof value.hasNotes !== "boolean" || !isSafeInteger(value.tagCount)) {
      return null;
    }
    let notePreview;
    if (Object.hasOwn(value, "notePreview")) {
      if (typeof value.notePreview !== "string" || value.notePreview.length > 180 || value.notePreview.trim() !== value.notePreview) {
        return null;
      }
      notePreview = value.notePreview;
    }
    let tags;
    if (Object.hasOwn(value, "tags")) {
      if (!Array.isArray(value.tags) || value.tags.length > 5) return null;
      const copied = [];
      for (const tag of value.tags) {
        if (typeof tag !== "string" || tag.length === 0 || tag.length > 100 || tag.trim() !== tag) {
          return null;
        }
        copied.push(tag);
      }
      tags = Object.freeze(copied);
    }
    return Object.freeze({
      hasNotes: value.hasNotes,
      tagCount: value.tagCount,
      ...notePreview === void 0 ? {} : { notePreview },
      ...tags === void 0 ? {} : { tags }
    });
  }
  function copyEntry(value) {
    if (!isRecord2(value)) return null;
    const status = enumValue(LEGACY_STATUSES, value.status);
    if (status === null) return null;
    const result = { status };
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
  function copyEntryMap(value) {
    if (!isRecord2(value) || Object.keys(value).length > MAX_OVERLAY_RECORDS) return null;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key.length > 32 || !WORK_KEY_PATTERN.test(key)) return null;
      const entry = copyEntry(raw);
      if (entry === null) return null;
      result[key] = entry;
    }
    return Object.freeze(result);
  }
  function copyPreferenceMap(value) {
    if (!isRecord2(value) || Object.keys(value).length > MAX_OVERLAY_RECORDS) return null;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key.length > 32 || !WORK_KEY_PATTERN.test(key) || !isRecord2(raw)) return null;
      if (!hasOnlyKeys(raw, ["browsePreference"])) return null;
      const preference = copyBrowsePreference(raw.browsePreference);
      if (preference === null) return null;
      result[key] = Object.freeze({ browsePreference: preference });
    }
    return Object.freeze(result);
  }
  function copyOverlay(value) {
    if (!isRecord2(value) || !hasOnlyKeys(value, ["entries", "workPreferences", "syncVersion"])) {
      return null;
    }
    const entries = copyEntryMap(value.entries);
    const workPreferences = copyPreferenceMap(value.workPreferences);
    if (entries === null || workPreferences === null) return null;
    if (typeof value.syncVersion !== "string" || !ISO_TIMESTAMP_PATTERN.test(value.syncVersion) || !Number.isFinite(Date.parse(value.syncVersion)) || new Date(value.syncVersion).toISOString() !== value.syncVersion) {
      return null;
    }
    return Object.freeze({ entries, workPreferences, syncVersion: value.syncVersion });
  }
  function parseAccountData(value) {
    if (value === null || value === void 0) return { kind: "missing" };
    if (!isRecord2(value) || !hasOnlyKeys(value, [
      "version",
      "scope",
      "summary",
      "overlay",
      "capacityRecovery"
    ]) || value.version !== 1 || !Object.hasOwn(value, "summary") || !Object.hasOwn(value, "overlay")) {
      return { kind: "invalid" };
    }
    const scope2 = copyScope(value.scope);
    if (scope2 === null) return { kind: "invalid" };
    const summary = value.summary === null ? null : copySummary(value.summary);
    if (value.summary !== null && summary === null) return { kind: "invalid" };
    const overlay = value.overlay === null ? null : copyOverlay(value.overlay);
    if (value.overlay !== null && overlay === null) return { kind: "invalid" };
    const rawCapacityRecovery = Object.hasOwn(value, "capacityRecovery") ? value.capacityRecovery : null;
    const capacityRecovery = rawCapacityRecovery === null ? null : copyCapacityRecovery(rawCapacityRecovery);
    if (rawCapacityRecovery !== null && capacityRecovery === null) {
      return { kind: "invalid" };
    }
    return {
      kind: "valid",
      value: Object.freeze({
        version: 1,
        scope: scope2,
        summary,
        overlay,
        capacityRecovery
      })
    };
  }
  function createEmptyAccountData(scope2) {
    const parsed = parseAccountData({
      version: 1,
      scope: scope2,
      summary: null,
      overlay: null,
      capacityRecovery: null
    });
    if (parsed.kind !== "valid") throw new TypeError("invalid account scope");
    return parsed.value;
  }
  function copyAccountSummary(value) {
    return copySummary(value);
  }
  function copyAccountOverlay(value) {
    return copyOverlay(value);
  }
  function copyLibraryOverlayEntry(value) {
    return copyEntry(value);
  }

  // src/extension-core/account-projection.mts
  function scopeKey(scope2) {
    return `${scope2.accountId}:${scope2.epoch}`;
  }
  var AccountProjectionService = class {
    #ports;
    #maxAgeMs;
    #lastRefresh = null;
    #inflight = null;
    #invalidationGeneration = 0;
    constructor(ports) {
      this.#ports = ports;
      this.#maxAgeMs = ports.maxAgeMs ?? 3e4;
    }
    async read(options = {}) {
      if (options.refresh !== false) await this.refreshIfNeeded();
      return this.#ports.repository.read();
    }
    invalidate() {
      this.#invalidationGeneration += 1;
      this.#lastRefresh = null;
    }
    refreshIfNeeded(force = false) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) {
        return Promise.resolve({ kind: "not_authenticated" });
      }
      const key = scopeKey(scope2);
      const generation = this.#invalidationGeneration;
      if (this.#inflight?.scope === key) {
        if (this.#inflight.generation === generation) return this.#inflight.promise;
        return this.#inflight.promise.then(() => this.refreshIfNeeded(true));
      }
      if (!force && this.#lastRefresh?.scope === key && this.#ports.clock.now() - this.#lastRefresh.at < this.#maxAgeMs) {
        return Promise.resolve({ kind: "current" });
      }
      const promise = this.#refresh(scope2, generation).finally(() => {
        if (this.#inflight?.promise === promise) this.#inflight = null;
      });
      this.#inflight = Object.freeze({ scope: key, generation, promise });
      return promise;
    }
    async #refresh(scope2, generation) {
      let reservation = this.#ports.repository.reserveOverlayWrite();
      let fetched = await this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.load(credential)
      );
      if (fetched.kind === "auth_rejected" && fetched.recovery === "connected") {
        reservation = this.#ports.repository.reserveOverlayWrite();
        fetched = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.load(credential)
        );
      }
      if (fetched.kind === "auth_rejected") return { kind: "auth_expired" };
      if (fetched.kind === "stale") return { kind: "stale" };
      if (fetched.kind !== "published") return { kind: "unavailable" };
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return { kind: "stale" };
      }
      let overlay;
      if (fetched.value.overlay.kind === "value") {
        try {
          const result = await this.#ports.repository.publishOverlay(
            scope2,
            fetched.value.overlay.value,
            reservation
          );
          overlay = result.kind === "published" ? "published" : result.kind === "stale_write" ? "stale" : result.kind === "invalid_model" ? "invalid" : "stale";
        } catch {
          overlay = "unavailable";
        }
      } else {
        overlay = fetched.value.overlay.kind === "invalid_response" ? "invalid" : "unavailable";
      }
      let summary;
      if (fetched.value.summary.kind === "value") {
        if (fetched.value.summary.value.accountId !== scope2.accountId) {
          summary = "invalid";
        } else {
          try {
            const result = await this.#ports.repository.publishSummary(
              scope2,
              fetched.value.summary.value.value
            );
            summary = result.kind === "published" ? "published" : result.kind === "invalid_model" ? "invalid" : "unavailable";
          } catch {
            summary = "unavailable";
          }
        }
      } else {
        summary = fetched.value.summary.kind === "invalid_response" ? "invalid" : "unavailable";
      }
      if (sameAccountScope(this.#ports.session.displayScope(), scope2) && generation === this.#invalidationGeneration && (overlay === "published" || summary === "published")) {
        this.#lastRefresh = Object.freeze({
          scope: scopeKey(scope2),
          at: this.#ports.clock.now()
        });
      }
      return Object.freeze({ kind: "refreshed", overlay, summary });
    }
  };

  // src/extension-core/library-command.mts
  function failed(reason) {
    return Object.freeze({ kind: "failed", reason });
  }
  function executionFailure(result) {
    if (result.kind === "stale") return failed("stale");
    if (result.kind === "auth_rejected") return failed("auth_expired");
    return failed("not_authenticated");
  }
  function projectionFailure(result) {
    return failed(result.kind);
  }
  function canonicalReaderStatus(entry) {
    if (entry.canonicalReaderStatus !== void 0) {
      return entry.canonicalReaderStatus;
    }
    const legacy = entry.readerStatus ?? entry.status;
    if (legacy === "PLANNING") return "SAVED";
    if (legacy === "COMPLETED") return "FINISHED";
    return legacy === "READING" || legacy === "PAUSED" || legacy === "DROPPED" ? legacy : null;
  }
  function entryForCommand(data, command) {
    const entry = data.overlay?.entries[command.workKey];
    if (entry === void 0 || entry.entryId !== command.entryId) return null;
    return entry;
  }
  function entryPatchSatisfied(entry, patch) {
    if (patch.status !== void 0 && canonicalReaderStatus(entry) !== patch.status) {
      return false;
    }
    if (patch.progress !== void 0) {
      if (entry.chapters === void 0 || entry.chapters.current !== patch.progress.value || entry.chapters.total !== patch.progress.total) {
        return false;
      }
    }
    if (patch.rating !== void 0 && entry.rating !== patch.rating) return false;
    const override = patch.story_snapshot?.work_status_override;
    if (override !== void 0) {
      if (override === null) {
        if (entry.workStatusProvenance === "override") return false;
      } else if (entry.workStatus !== override || entry.workStatusProvenance !== "override") {
        return false;
      }
    }
    return true;
  }
  function preferenceSatisfied(data, command) {
    const hidden = data.overlay?.workPreferences[command.workKey]?.browsePreference.hidden === true;
    return hidden === command.hidden;
  }
  function libraryMutationSatisfied(data, command) {
    if (command.kind === "work_preference") return preferenceSatisfied(data, command);
    const entry = entryForCommand(data, command);
    return entry !== null && entryPatchSatisfied(entry, command.patch);
  }
  function confirmedMutation(data, command, source) {
    const entry = command.kind === "entry_patch" ? entryForCommand(data, command) ?? void 0 : data.overlay?.entries[command.workKey];
    return Object.freeze({
      kind: "confirmed",
      commandKind: command.kind,
      workKey: command.workKey,
      ...command.kind === "entry_patch" ? { entryId: command.entryId } : {},
      ...entry === void 0 ? {} : { entry },
      source
    });
  }
  var LibraryMutationService = class {
    #ports;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    execute(command) {
      return this.#withLock(() => this.#execute(command));
    }
    async #execute(command) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failed("not_authenticated");
      let projection = await this.#ports.projection.refreshAndRead();
      if (projection.kind !== "value") return projectionFailure(projection);
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failed("stale");
      }
      if (command.kind === "entry_patch" && entryForCommand(projection.value, command) === null) {
        return failed("invalid_request");
      }
      if (libraryMutationSatisfied(projection.value, command)) {
        return confirmedMutation(projection.value, command, "preflight");
      }
      let mutation = await this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.mutate(credential, command)
      );
      if (mutation.kind === "auth_rejected" && mutation.recovery === "connected") {
        projection = await this.#ports.projection.refreshAndRead();
        if (projection.kind !== "value") return projectionFailure(projection);
        if (libraryMutationSatisfied(projection.value, command)) {
          return confirmedMutation(projection.value, command, "preflight");
        }
        mutation = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.mutate(credential, command)
        );
      }
      if (mutation.kind !== "published") return executionFailure(mutation);
      if (mutation.value.kind === "rejected") return failed(mutation.value.reason);
      projection = await this.#ports.projection.refreshAndRead();
      if (projection.kind !== "value") return projectionFailure(projection);
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failed("stale");
      }
      if (!libraryMutationSatisfied(projection.value, command)) {
        return failed("confirmation_missing");
      }
      return confirmedMutation(
        projection.value,
        command,
        mutation.value.kind === "accepted" ? "mutation" : "reconciliation"
      );
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
  var FinishQualificationService = class {
    #ports;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    execute(command) {
      const publicationReservation = this.#ports.projection.reserveFinishPublication();
      return this.#withLock(() => this.#execute(command, publicationReservation));
    }
    async #execute(command, publicationReservation) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failed("not_authenticated");
      let operation;
      if (command.state === "resolved") {
        let operationId;
        try {
          operationId = this.#ports.finishOperationIds.create().trim();
        } catch {
          return failed("unavailable");
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
          return failed("unavailable");
        }
        operation = Object.freeze({ ...command, operationId });
      } else {
        operation = command;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let signal = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.qualifyFinish(credential, operation)
        );
        if (signal.kind === "auth_rejected" && signal.recovery === "connected") {
          signal = await this.#ports.session.executeAuthenticated(
            (credential) => this.#ports.api.qualifyFinish(credential, operation)
          );
        }
        if (signal.kind !== "published") return executionFailure(signal);
        if (signal.value.kind === "rejected") return failed(signal.value.reason);
        if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
          return failed("stale");
        }
        if (signal.value.kind === "uncertain") {
          if (command.state === "resolved" && attempt === 0) continue;
          return failed("unavailable");
        }
        if (signal.value.kind === "invalid_response") {
          return failed("invalid_response");
        }
        if (signal.value.state !== "ignored" && signal.value.state !== command.state) {
          return failed("invalid_response");
        }
        if (signal.value.operationId !== (operation.state === "resolved" ? operation.operationId : null)) {
          return failed("invalid_response");
        }
        let publication;
        try {
          publication = await this.#ports.projection.publishFinishAcknowledgement(
            scope2,
            operation,
            signal.value,
            publicationReservation
          );
        } catch {
          publication = { kind: "unavailable" };
        }
        if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
          return failed("stale");
        }
        if (publication.kind === "published") return signal.value;
        if (publication.kind === "rejected_scope" || publication.kind === "stale_write") {
          return failed("stale");
        }
        if (publication.kind === "invalid_model") return failed("invalid_response");
        return failed("unavailable");
      }
      return failed("unavailable");
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-core/metadata-contribution.mts
  function failure(reason) {
    return Object.freeze({ kind: "failed", reason });
  }
  function executionFailure2(result) {
    if (result.kind === "stale") return failure("stale");
    if (result.kind === "auth_rejected") return failure("auth_expired");
    return failure("not_authenticated");
  }
  var MetadataContributionService = class {
    #ports;
    constructor(ports) {
      this.#ports = ports;
    }
    async execute(command) {
      let enabled = true;
      try {
        enabled = await this.#ports.preference.enabled();
      } catch {
        enabled = true;
      }
      if (!enabled) {
        return Object.freeze({ kind: "skipped", reason: "preference_disabled" });
      }
      try {
        await this.#ports.authority.prepare();
      } catch {
        return failure("unavailable");
      }
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failure("not_authenticated");
      let contribution = await this.#executeAuthenticated(command);
      if (contribution.kind === "auth_rejected" && contribution.recovery === "connected") {
        contribution = await this.#executeAuthenticated(command);
      }
      if (contribution.kind !== "published") return executionFailure2(contribution);
      if (contribution.value.kind === "rejected") {
        return failure(contribution.value.reason);
      }
      if (contribution.value.kind === "invalid_response") {
        return failure("invalid_response");
      }
      if (contribution.value.kind === "unavailable") return failure("unavailable");
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure("stale");
      }
      if (!contribution.value.updated) {
        return Object.freeze({
          kind: "accepted",
          updated: false,
          projection: "not_needed",
          notification: "not_needed"
        });
      }
      let projection = "invalidated";
      try {
        this.#ports.projection.invalidate();
      } catch {
        projection = "unavailable";
      }
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure("stale");
      }
      let notification = "unavailable";
      try {
        notification = await this.#ports.notification.publish() ? "published" : "unavailable";
      } catch {
        notification = "unavailable";
      }
      return Object.freeze({
        kind: "accepted",
        updated: true,
        projection,
        notification
      });
    }
    #executeAuthenticated(command) {
      return this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.contribute(credential, command)
      );
    }
  };

  // src/extension-core/saved-filter-sync.mts
  var SAVED_FILTER_ACTIVE_LIMIT = 250;
  var SAVED_FILTER_SYNC_BATCH_LIMIT = 100;
  var SAVED_FILTER_SYNC_MAX_ITERATIONS = 10;
  var CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
  var PARAM_KEY_PATTERN = /^(?:work_search|include_work_search|exclude_work_search)\[[a-z0-9_]+\](?:\[\])?$/;
  var UUID_PATTERN2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var MAX_REMOTE_ROWS = SAVED_FILTER_ACTIVE_LIMIT * 2;
  var MAX_LOCAL_TOMBSTONES = 1e4;
  function isRecord3(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys2(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
  }
  function isIso(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }
  function cleanText(value, maxLength) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
  }
  function copyPairs(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 80) return null;
    const pairs = [];
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const key = typeof pair[0] === "string" ? pair[0].trim() : "";
      const item = typeof pair[1] === "string" ? pair[1].trim() : "";
      if (!PARAM_KEY_PATTERN.test(key) || item.length === 0 || item.length > 300) return null;
      pairs.push([key, item]);
    }
    pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    return Object.freeze(pairs.map((pair) => Object.freeze(pair)));
  }
  function copySummary2(value) {
    if (!Array.isArray(value) || value.length > 5) return null;
    const summary = [];
    for (const item of value) {
      const text = cleanText(item, 64);
      if (!text || text !== item) return null;
      summary.push(text);
    }
    return Object.freeze(summary);
  }
  function validClientId(value) {
    return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
  }
  function validUuid(value) {
    return typeof value === "string" && UUID_PATTERN2.test(value);
  }
  function copyLocalPreset(value, now) {
    if (!isRecord3(value)) return null;
    const id = cleanText(value.id, 120);
    const clientId = validClientId(value.clientId) ? value.clientId : validClientId(id) ? id : "";
    const params = copyPairs(value.params);
    const summary = copySummary2(Array.isArray(value.summary) ? value.summary : []);
    if (!id || !clientId || params === null || summary === null) return null;
    const scope2 = value.scope === "global" ? "global" : "context";
    const updatedAt = isIso(value.updatedAt) ? value.updatedAt : now;
    return Object.freeze({
      id,
      clientId,
      serverId: validUuid(value.serverId) ? value.serverId : "",
      name: cleanText(value.name, 96) || "AO3 filter",
      params,
      scope: scope2,
      contextKey: scope2 === "context" ? cleanText(value.contextKey, 240) : "",
      contextLabel: scope2 === "context" ? cleanText(value.contextLabel, 120) : "",
      summary,
      createdAt: isIso(value.createdAt) ? value.createdAt : now,
      updatedAt,
      clientUpdatedAt: isIso(value.clientUpdatedAt) ? value.clientUpdatedAt : updatedAt,
      dirty: value.dirty === true
    });
  }
  function copyLocalDeletion(value, now) {
    if (!isRecord3(value)) return null;
    const id = cleanText(value.id, 120);
    const clientId = validClientId(value.clientId) ? value.clientId : validClientId(id) ? id : "";
    if (!clientId) return null;
    return Object.freeze({
      id: id || clientId,
      clientId,
      serverId: validUuid(value.serverId) ? value.serverId : "",
      clientUpdatedAt: isIso(value.clientUpdatedAt) ? value.clientUpdatedAt : now
    });
  }
  function copyActiveMeta(value) {
    if (!isRecord3(value)) return null;
    const id = cleanText(value.id, 120);
    const signature = cleanText(value.signature, 4096);
    const contextKey = cleanText(value.contextKey, 240);
    if (!id || !signature || !contextKey) return null;
    return Object.freeze({
      id,
      signature,
      contextKey,
      appliedAt: isIso(value.appliedAt) ? value.appliedAt : ""
    });
  }
  function normalizeSavedFilterSnapshot(raw, now) {
    const root = isRecord3(raw) ? raw : {};
    const presets = [];
    const presetIds = /* @__PURE__ */ new Set();
    const presetClientIds = /* @__PURE__ */ new Set();
    if (Array.isArray(root.presets)) {
      for (const value of root.presets.slice(0, SAVED_FILTER_ACTIVE_LIMIT)) {
        const preset = copyLocalPreset(value, now);
        if (preset === null || presetIds.has(preset.id) || presetClientIds.has(preset.clientId)) {
          continue;
        }
        presetIds.add(preset.id);
        presetClientIds.add(preset.clientId);
        presets.push(preset);
      }
    }
    const deleted = [];
    const deletedClientIds = /* @__PURE__ */ new Set();
    if (Array.isArray(root.deleted)) {
      for (const value of root.deleted.slice(0, MAX_LOCAL_TOMBSTONES)) {
        const item = copyLocalDeletion(value, now);
        if (item === null || deletedClientIds.has(item.clientId)) continue;
        deletedClientIds.add(item.clientId);
        deleted.push(item);
      }
    }
    return Object.freeze({
      presets: Object.freeze(presets),
      deleted: Object.freeze(deleted),
      activeMeta: copyActiveMeta(root.activeMeta),
      syncVersion: isIso(root.syncVersion) ? root.syncVersion : null,
      lastSyncedAt: isIso(root.lastSyncedAt) ? root.lastSyncedAt : null,
      clientId: validClientId(root.clientId) ? root.clientId : null
    });
  }
  function copyRemotePreset(value) {
    if (!isRecord3(value) || !hasOnlyKeys2(value, [
      "id",
      "clientId",
      "name",
      "scope",
      "contextKey",
      "contextLabel",
      "params",
      "summary",
      "createdAt",
      "updatedAt",
      "clientUpdatedAt"
    ]) || !validUuid(value.id) || !validClientId(value.clientId) || value.scope !== "context" && value.scope !== "global" || !isIso(value.createdAt) || !isIso(value.updatedAt) || !isIso(value.clientUpdatedAt)) {
      return null;
    }
    const name = cleanText(value.name, 96);
    const params = copyPairs(value.params);
    const summary = copySummary2(value.summary);
    if (!name || name !== value.name || params === null || summary === null) return null;
    if (value.contextKey !== null && (typeof value.contextKey !== "string" || value.contextKey.length > 240)) {
      return null;
    }
    if (value.contextLabel !== null && (typeof value.contextLabel !== "string" || value.contextLabel.length > 120)) {
      return null;
    }
    return Object.freeze({
      id: value.id,
      clientId: value.clientId,
      name,
      scope: value.scope,
      contextKey: value.contextKey,
      contextLabel: value.contextLabel,
      params,
      summary,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      clientUpdatedAt: value.clientUpdatedAt
    });
  }
  function copyRemoteDeletion(value) {
    if (!isRecord3(value) || !hasOnlyKeys2(value, [
      "id",
      "clientId",
      "deletedAt",
      "updatedAt",
      "clientUpdatedAt"
    ]) || !validUuid(value.id) || !validClientId(value.clientId) || !isIso(value.deletedAt) || !isIso(value.updatedAt) || !isIso(value.clientUpdatedAt)) {
      return null;
    }
    return Object.freeze({
      id: value.id,
      clientId: value.clientId,
      deletedAt: value.deletedAt,
      updatedAt: value.updatedAt,
      clientUpdatedAt: value.clientUpdatedAt
    });
  }
  function parseSavedFilterSyncData(value) {
    if (!isRecord3(value) || !hasOnlyKeys2(value, ["serverTime", "syncVersion", "presets", "deleted"]) || !isIso(value.serverTime) || !isIso(value.syncVersion) || !Array.isArray(value.presets) || !Array.isArray(value.deleted) || value.presets.length > MAX_REMOTE_ROWS || value.deleted.length > MAX_REMOTE_ROWS) {
      return null;
    }
    const presets = [];
    const deleted = [];
    const seenPresets = /* @__PURE__ */ new Set();
    const seenDeleted = /* @__PURE__ */ new Set();
    for (const raw of value.presets) {
      const preset = copyRemotePreset(raw);
      if (preset === null || seenPresets.has(preset.clientId)) return null;
      seenPresets.add(preset.clientId);
      presets.push(preset);
    }
    for (const raw of value.deleted) {
      const item = copyRemoteDeletion(raw);
      if (item === null || seenDeleted.has(item.clientId)) return null;
      seenDeleted.add(item.clientId);
      deleted.push(item);
    }
    return Object.freeze({
      serverTime: value.serverTime,
      syncVersion: value.syncVersion,
      presets: Object.freeze(presets),
      deleted: Object.freeze(deleted)
    });
  }
  function needsSync(preset) {
    return preset.dirty || !validUuid(preset.serverId);
  }
  function upsertFromPreset(preset) {
    return Object.freeze({
      ...validUuid(preset.serverId) ? { id: preset.serverId } : {},
      clientId: preset.clientId,
      name: preset.name,
      scope: preset.scope,
      contextKey: preset.scope === "context" ? preset.contextKey || null : null,
      contextLabel: preset.scope === "context" ? preset.contextLabel || null : null,
      params: preset.params,
      summary: preset.summary,
      createdAt: preset.createdAt,
      clientUpdatedAt: preset.clientUpdatedAt
    });
  }
  function deleteFromLocal(item) {
    return Object.freeze({
      ...validUuid(item.serverId) ? { id: item.serverId } : {},
      clientId: item.clientId,
      clientUpdatedAt: item.clientUpdatedAt
    });
  }
  function savedFilterSyncRequest(snapshot) {
    if (snapshot.clientId === null) return null;
    return Object.freeze({
      clientId: snapshot.clientId,
      since: snapshot.syncVersion,
      upserts: Object.freeze(
        snapshot.presets.filter(needsSync).slice(0, SAVED_FILTER_SYNC_BATCH_LIMIT).map(upsertFromPreset)
      ),
      deletes: Object.freeze(
        snapshot.deleted.slice(0, SAVED_FILTER_SYNC_BATCH_LIMIT).map(deleteFromLocal)
      )
    });
  }
  function localIsNewer(local, remoteClientUpdatedAt) {
    if (local?.dirty !== true) return false;
    return Date.parse(local.clientUpdatedAt) > Date.parse(remoteClientUpdatedAt);
  }
  function mergeSavedFilterSyncData(snapshot, data, sentDeleteClientIds, syncedAt) {
    const byClientId = new Map(snapshot.presets.map((item) => [item.clientId, item]));
    const localIdByClientId = new Map(
      snapshot.presets.map((item) => [item.clientId, item.id])
    );
    const deletedByClientId = new Map(
      snapshot.deleted.map((item) => [item.clientId, item])
    );
    for (const clientId of sentDeleteClientIds) deletedByClientId.delete(clientId);
    for (const remote of data.presets) {
      const existing = byClientId.get(remote.clientId);
      if (localIsNewer(existing, remote.clientUpdatedAt)) continue;
      byClientId.set(remote.clientId, Object.freeze({
        id: existing?.id ?? remote.clientId,
        clientId: remote.clientId,
        serverId: remote.id,
        name: remote.name,
        params: remote.params,
        scope: remote.scope,
        contextKey: remote.scope === "context" ? remote.contextKey ?? "" : "",
        contextLabel: remote.scope === "context" ? remote.contextLabel ?? "" : "",
        summary: remote.summary,
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
        clientUpdatedAt: remote.clientUpdatedAt,
        dirty: false
      }));
      deletedByClientId.delete(remote.clientId);
    }
    for (const remote of data.deleted) {
      const existing = byClientId.get(remote.clientId);
      if (localIsNewer(existing, remote.clientUpdatedAt)) continue;
      byClientId.delete(remote.clientId);
      deletedByClientId.delete(remote.clientId);
    }
    const presets = Array.from(byClientId.values()).sort(
      (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
    );
    let activeMeta = snapshot.activeMeta;
    if (activeMeta !== null && !presets.some((item) => item.id === activeMeta.id)) {
      const activeClientId = Array.from(localIdByClientId.entries()).find(([, localId]) => localId === activeMeta.id)?.[0];
      const replacement = activeClientId === void 0 ? void 0 : presets.find((item) => item.clientId === activeClientId);
      activeMeta = replacement === void 0 ? null : Object.freeze({ ...activeMeta, id: replacement.id });
    }
    return Object.freeze({
      presets: Object.freeze(presets),
      deleted: Object.freeze(Array.from(deletedByClientId.values())),
      activeMeta,
      syncVersion: data.syncVersion,
      lastSyncedAt: syncedAt,
      clientId: snapshot.clientId
    });
  }
  function savedFilterSnapshotHasPending(snapshot) {
    return snapshot.presets.some(needsSync) || snapshot.deleted.length > 0;
  }
  function failure2(reason, limit) {
    return Object.freeze({
      kind: "failed",
      reason,
      ...limit === void 0 ? {} : { limit }
    });
  }
  var SavedFilterSyncService = class {
    #ports;
    #inFlight = null;
    #generation = 0;
    constructor(ports) {
      this.#ports = ports;
    }
    sync() {
      const generation = this.#generation;
      this.#inFlight ??= this.#syncOnce(generation).finally(() => {
        this.#inFlight = null;
      });
      return this.#inFlight;
    }
    cancel() {
      this.#generation += 1;
    }
    async #syncOnce(generation) {
      let scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failure2("not_authenticated");
      let requests = 0;
      let lastSyncVersion = "";
      for (let iteration = 0; iteration < SAVED_FILTER_SYNC_MAX_ITERATIONS; iteration += 1) {
        if (generation !== this.#generation) return failure2("stale");
        let snapshot;
        try {
          snapshot = await this.#ports.repository.read();
        } catch {
          return failure2("storage_unavailable");
        }
        if (snapshot === null || snapshot.clientId === null) {
          return failure2("storage_unavailable");
        }
        const request = savedFilterSyncRequest(snapshot);
        if (request === null) return failure2("storage_unavailable");
        let execution = await this.#execute(request);
        if (generation !== this.#generation) return failure2("stale");
        if (execution.kind === "auth_rejected" && execution.recovery === "connected") {
          const recoveredScope = this.#ports.session.publicationScope();
          if (recoveredScope === null || recoveredScope.accountId !== scope2.accountId) {
            return failure2("stale");
          }
          scope2 = recoveredScope;
          execution = await this.#execute(request);
          if (generation !== this.#generation) return failure2("stale");
        }
        if (execution.kind === "auth_rejected") return failure2("auth_expired");
        if (execution.kind !== "published") {
          return failure2(execution.kind === "stale" ? "stale" : "unavailable");
        }
        const outcome = execution.value;
        if (outcome.kind === "rejected") {
          return failure2(outcome.reason, outcome.limit);
        }
        if (outcome.kind === "invalid_response") return failure2("invalid_response");
        if (outcome.kind === "unavailable") return failure2("unavailable");
        if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
          return failure2("stale");
        }
        const merged = await this.#ports.repository.merge(
          scope2,
          outcome.data,
          new Set(request.deletes.map((item) => item.clientId)),
          this.#ports.clock.now()
        );
        if (merged.kind !== "published") {
          return failure2(
            merged.kind === "stale" ? "stale" : "storage_unavailable"
          );
        }
        requests += 1;
        lastSyncVersion = merged.snapshot.syncVersion ?? "";
        if (!savedFilterSnapshotHasPending(merged.snapshot)) {
          return Object.freeze({
            kind: "completed",
            syncVersion: lastSyncVersion,
            requests
          });
        }
      }
      return Object.freeze({
        kind: "partial",
        syncVersion: lastSyncVersion,
        requests
      });
    }
    #execute(request) {
      return this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.sync(credential, request)
      );
    }
  };

  // src/extension-core/session-service.mts
  var CAPABILITY_MARKER = Symbol("trace.extension.session-capability");
  function disconnectedEnvelope(epoch) {
    return Object.freeze({
      version: SESSION_ENVELOPE_VERSION,
      epoch,
      desired: "disconnected",
      accountId: null,
      credentialRef: null
    });
  }
  function connectedEnvelope(epoch, credentialRef, accountId) {
    return Object.freeze({
      version: SESSION_ENVELOPE_VERSION,
      epoch,
      desired: "connected",
      accountId,
      credentialRef
    });
  }
  function isRecord4(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isNonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0;
  }
  function normalizeAcquisition(value) {
    if (!isRecord4(value)) return { kind: "unavailable" };
    if (value.kind === "credential") {
      return isNonEmpty(value.credential) ? { kind: "credential", credential: value.credential } : { kind: "unavailable" };
    }
    if (value.kind === "absent" || value.kind === "cancelled" || value.kind === "unavailable") {
      return { kind: value.kind };
    }
    return { kind: "unavailable" };
  }
  function normalizeVerification(value) {
    if (!isRecord4(value)) return { kind: "invalid_response" };
    if (value.kind === "verified") {
      return isNonEmpty(value.accountId) ? { kind: "verified", accountId: value.accountId } : { kind: "invalid_response" };
    }
    if (value.kind === "rejected" || value.kind === "account_unavailable" || value.kind === "invalid_response" || value.kind === "unavailable") {
      return { kind: value.kind };
    }
    return { kind: "invalid_response" };
  }
  function normalizeEffectResult(value) {
    if (!isRecord4(value)) return { kind: "unavailable" };
    if (value.kind === "success" && Object.hasOwn(value, "value")) {
      return { kind: "success", value: value.value };
    }
    if (value.kind === "auth_rejected" || value.kind === "unavailable") {
      return { kind: value.kind };
    }
    return { kind: "unavailable" };
  }
  function createCapability(accountId, epoch, credential) {
    return Object.freeze({
      [CAPABILITY_MARKER]: true,
      accountId,
      epoch,
      credential
    });
  }
  var SessionService = class {
    #ports;
    #model = INITIAL_SESSION_MODEL;
    #envelope = INITIAL_SESSION_ENVELOPE;
    #reservation = 0;
    #capability = null;
    #activeAcquisitionEpoch = null;
    #lockTail = Promise.resolve();
    #initialization = null;
    #start = null;
    #providerSynchronization = null;
    constructor(ports) {
      this.#ports = ports;
    }
    snapshot() {
      return toSessionSnapshot(this.#model);
    }
    publicationScope() {
      return this.#copyScope(this.#model.publicationScope);
    }
    displayScope() {
      return this.#copyScope(this.#model.displayScope);
    }
    start() {
      this.#start ??= this.#startOnce();
      return this.#start.then(() => this.snapshot());
    }
    async connect() {
      await this.#ensureInitialized();
      const start = await this.#withLock(async () => {
        if (this.#model.state !== "signed_out") return null;
        const epoch = this.#reserveNextEpoch();
        const persisted = await this.#persist(disconnectedEnvelope(epoch));
        if (!persisted) return { epoch, persisted: false };
        this.#transition({ type: "connecting", epoch });
        this.#activeAcquisitionEpoch = epoch;
        return { epoch, persisted: true };
      });
      if (start === null) return { kind: "ignored" };
      if (!start.persisted) return { kind: "storage_error" };
      let acquisition;
      try {
        acquisition = normalizeAcquisition(
          await this.#ports.credentials.acquire("connect")
        );
      } catch {
        this.#record("credential_provider_failed");
        acquisition = { kind: "unavailable" };
      }
      if (acquisition.kind === "unavailable") {
        this.#record("credential_provider_failed");
      }
      if (acquisition.kind === "cancelled") {
        return this.#disconnectInternal(true, start.epoch);
      }
      if (acquisition.kind !== "credential") {
        return this.#withLock(async () => {
          if (!this.#isCurrentAcquisition(start.epoch)) return { kind: "stale" };
          this.#activeAcquisitionEpoch = null;
          this.#transition({
            type: "signed_out",
            epoch: start.epoch,
            reason: "provider_unavailable"
          });
          return { kind: "unavailable" };
        });
      }
      const stillCurrent = await this.#withLock(async () => this.#isCurrentAcquisition(start.epoch));
      if (!stillCurrent) {
        this.#record("stale_effect_discarded");
        return { kind: "stale" };
      }
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          acquisition.credential,
          start.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        this.#record("credential_provider_failed");
        return this.#withLock(async () => {
          if (!this.#isCurrentAcquisition(start.epoch)) return { kind: "stale" };
          this.#activeAcquisitionEpoch = null;
          this.#transition({
            type: "signed_out",
            epoch: start.epoch,
            reason: "provider_unavailable"
          });
          return { kind: "unavailable" };
        });
      }
      const admission = await this.#withLock(async () => {
        if (!this.#isCurrentAcquisition(start.epoch)) {
          this.#scheduleCredentialDelete(credentialRef);
          return "stale";
        }
        this.#activeAcquisitionEpoch = null;
        const persisted = await this.#persist(
          connectedEnvelope(start.epoch, credentialRef, null)
        );
        if (!persisted) {
          this.#scheduleCredentialDelete(credentialRef);
          return "storage_error";
        }
        this.#transition({ type: "verifying", epoch: start.epoch, accountId: null });
        return "admitted";
      });
      if (admission !== "admitted") {
        this.#record("stale_effect_discarded");
        return { kind: admission };
      }
      return this.#verifyCredential({
        epoch: start.epoch,
        credentialRef,
        expectedAccountId: null,
        rejectionPolicy: "reconnect"
      }, acquisition.credential);
    }
    async cancelConnect() {
      await this.#ensureInitialized();
      return this.#disconnectInternal(true);
    }
    async disconnect() {
      await this.#ensureInitialized();
      return this.#disconnectInternal(false);
    }
    async reconnect() {
      const disconnected = await this.disconnect();
      if (disconnected.kind !== "completed" || disconnected.state !== "signed_out") {
        return disconnected;
      }
      return this.connect();
    }
    /**
     * Aligns an authenticated worker with its external credential provider
     * without treating every check as an account transition.
     *
     * A matching credential is a no-op. A rotated credential for the same
     * account replaces only the private capability and keeps the account epoch
     * stable. A genuinely different account takes a fenced account-transition
     * path. Temporary provider failures refuse the caller's mutation but retain
     * the last verified display/session state.
     */
    synchronizeProviderCredential() {
      if (this.#providerSynchronization !== null) {
        return this.#providerSynchronization;
      }
      const operation = this.#synchronizeProviderCredentialOnce();
      this.#providerSynchronization = operation;
      void operation.then(
        () => {
          if (this.#providerSynchronization === operation) {
            this.#providerSynchronization = null;
          }
        },
        () => {
          if (this.#providerSynchronization === operation) {
            this.#providerSynchronization = null;
          }
        }
      );
      return operation;
    }
    async retry() {
      await this.#ensureInitialized();
      const storageRetry = await this.#withLock(async () => this.#model.state === "degraded" && this.#model.reason === "storage_unavailable" ? { epoch: this.#reservation } : null);
      if (storageRetry !== null) return this.#retryStorageRead(storageRetry.epoch);
      const plan = await this.#withLock(async () => {
        if (this.#model.state !== "degraded" || this.#envelope.desired !== "connected" || this.#envelope.credentialRef === null) {
          return null;
        }
        this.#transition({
          type: "verifying",
          epoch: this.#reservation,
          accountId: this.#envelope.accountId
        });
        return {
          epoch: this.#reservation,
          credentialRef: this.#envelope.credentialRef,
          expectedAccountId: this.#envelope.accountId,
          rejectionPolicy: this.#envelope.accountId === null ? "reconnect" : "refresh"
        };
      });
      if (plan === null) return { kind: "ignored" };
      return this.#verifyPersisted(plan);
    }
    async refreshForExpiry() {
      await this.#ensureInitialized();
      const capability = await this.#withLock(async () => this.#capability);
      if (capability === null) return { kind: "ignored" };
      return this.#refreshFromCapability(capability, "expiry");
    }
    async #synchronizeProviderCredentialOnce() {
      await this.#ensureInitialized();
      const capability = await this.#withLock(async () => this.#capability);
      if (capability === null) {
        return this.#model.state === "signed_out" ? this.connect() : this.reconnect();
      }
      let acquisition;
      try {
        acquisition = normalizeAcquisition(
          await this.#ports.credentials.acquire("refresh")
        );
      } catch {
        this.#record("credential_provider_failed");
        return { kind: "unavailable" };
      }
      if (acquisition.kind === "unavailable" || acquisition.kind === "cancelled") {
        this.#record("credential_provider_failed");
        return { kind: "unavailable" };
      }
      if (acquisition.kind === "absent") {
        return this.disconnect();
      }
      if (acquisition.credential === capability.credential) {
        return this.#withLock(
          async () => this.#isCurrentCapability(capability) ? { kind: "completed", state: "connected" } : { kind: "stale" }
        );
      }
      let verification;
      try {
        verification = normalizeVerification(
          await this.#ports.api.verifyCredential(acquisition.credential)
        );
      } catch {
        this.#record("verification_failed");
        return { kind: "unavailable" };
      }
      if (verification.kind === "unavailable" || verification.kind === "invalid_response") {
        this.#record("verification_failed");
        return { kind: "unavailable" };
      }
      if (verification.kind === "rejected" || verification.kind === "account_unavailable") {
        return this.disconnect();
      }
      if (verification.accountId !== capability.accountId) {
        return this.#switchToVerifiedProviderCredential(
          capability,
          acquisition.credential,
          verification.accountId
        );
      }
      const stillCurrent = await this.#withLock(
        async () => this.#isCurrentCapability(capability)
      );
      if (!stillCurrent) {
        this.#record("stale_effect_discarded");
        return { kind: "stale" };
      }
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          acquisition.credential,
          capability.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        this.#record("credential_provider_failed");
        return { kind: "unavailable" };
      }
      const committed = await this.#commitSynchronizedCredential(
        capability,
        credentialRef,
        acquisition.credential
      );
      if (committed.kind !== "completed" || committed.state !== "connected") {
        this.#scheduleCredentialDelete(credentialRef);
      }
      return committed;
    }
    // This boundary is for the authenticated API adapter, not UI/content
    // surfaces. The production import gate must keep raw credentials confined to
    // that adapter when the kernel is wired in a later slice.
    async executeAuthenticated(effect) {
      await this.#ensureInitialized();
      const capability = await this.#withLock(async () => this.#capability);
      if (capability === null) return { kind: "unavailable" };
      let result;
      try {
        result = normalizeEffectResult(await effect(capability.credential));
      } catch {
        result = { kind: "unavailable" };
      }
      if (result.kind === "success") {
        return this.#withLock(async () => {
          if (!this.#isCurrentCapability(capability)) {
            this.#record("stale_effect_discarded");
            return { kind: "stale" };
          }
          return { kind: "published", value: result.value };
        });
      }
      if (result.kind === "unavailable") {
        return this.#withLock(async () => {
          if (!this.#isCurrentCapability(capability)) return { kind: "stale" };
          this.#capability = null;
          const scope2 = {
            accountId: capability.accountId,
            epoch: capability.epoch
          };
          this.#transition({
            type: "degraded",
            epoch: capability.epoch,
            displayScope: scope2,
            reason: "verification_unavailable"
          });
          return { kind: "unavailable" };
        });
      }
      const refresh = await this.#refreshFromCapability(capability, "rejection");
      if (refresh.kind === "stale" || refresh.kind === "ignored") {
        return { kind: "auth_rejected", recovery: "stale" };
      }
      return {
        kind: "auth_rejected",
        recovery: this.#model.state === "connected" ? "connected" : "reconnect_required"
      };
    }
    async #startOnce() {
      const plan = await this.#ensureInitialized();
      if (plan !== null) await this.#verifyPersisted(plan);
      return this.snapshot();
    }
    #ensureInitialized() {
      this.#initialization ??= this.#initializeEnvelope();
      return this.#initialization;
    }
    async #initializeEnvelope() {
      let raw;
      try {
        raw = await this.#ports.storage.read();
      } catch {
        return this.#withLock(async () => {
          this.#record("storage_read_failed");
          this.#transition({
            type: "degraded",
            epoch: this.#reservation,
            displayScope: null,
            reason: "storage_unavailable"
          });
          return null;
        });
      }
      const parsed = parseSessionEnvelope(raw);
      return this.#withLock(async () => this.#applyParsedEnvelope(parsed));
    }
    async #retryStorageRead(expectedEpoch) {
      let raw;
      try {
        raw = await this.#ports.storage.read();
      } catch {
        this.#record("storage_read_failed");
        return { kind: "unavailable" };
      }
      const parsed = parseSessionEnvelope(raw);
      const applied = await this.#withLock(async () => {
        if (this.#reservation !== expectedEpoch || this.#model.state !== "degraded" || this.#model.reason !== "storage_unavailable") {
          return { kind: "stale", plan: null };
        }
        return { kind: "applied", plan: this.#applyParsedEnvelope(parsed) };
      });
      if (applied.kind === "stale") return { kind: "stale" };
      if (applied.plan === null) {
        const state = this.#model.state;
        if (state === "signed_out" || state === "reconnect_required") {
          return { kind: "completed", state };
        }
        return { kind: "ignored" };
      }
      return this.#verifyPersisted(applied.plan);
    }
    #applyParsedEnvelope(parsed) {
      if (parsed.kind === "missing") {
        this.#envelope = INITIAL_SESSION_ENVELOPE;
        this.#reservation = 0;
        this.#transition({ type: "signed_out", epoch: 0 });
        return null;
      }
      if (parsed.kind === "invalid") {
        this.#envelope = INITIAL_SESSION_ENVELOPE;
        this.#reservation = 0;
        this.#transition({
          type: "reconnect_required",
          epoch: 0,
          reason: parsed.reason
        });
        return null;
      }
      this.#envelope = parsed.envelope;
      this.#reservation = parsed.envelope.epoch;
      if (parsed.envelope.desired === "disconnected") {
        this.#transition({ type: "signed_out", epoch: this.#reservation });
        return null;
      }
      if (parsed.envelope.credentialRef === null) {
        this.#transition({
          type: "reconnect_required",
          epoch: this.#reservation,
          reason: "credential_absent"
        });
        return null;
      }
      this.#transition({
        type: "verifying",
        epoch: this.#reservation,
        accountId: parsed.envelope.accountId
      });
      return {
        epoch: this.#reservation,
        credentialRef: parsed.envelope.credentialRef,
        expectedAccountId: parsed.envelope.accountId,
        rejectionPolicy: parsed.envelope.accountId === null ? "reconnect" : "refresh"
      };
    }
    async #verifyPersisted(plan) {
      let credential;
      try {
        credential = await this.#ports.credentials.load(plan.credentialRef);
      } catch {
        this.#record("credential_provider_failed");
        return this.#degradeVerification(plan);
      }
      if (credential === null || !isNonEmpty(credential)) {
        return this.#clearCredentialReference(plan.epoch, "credential_absent");
      }
      return this.#verifyCredential(plan, credential);
    }
    async #verifyCredential(plan, credential) {
      let verification;
      try {
        verification = normalizeVerification(
          await this.#ports.api.verifyCredential(credential)
        );
      } catch {
        verification = { kind: "unavailable" };
      }
      if (verification.kind === "unavailable") {
        this.#record("verification_failed");
        return this.#degradeVerification(plan);
      }
      if (verification.kind === "invalid_response") {
        return this.#clearCredentialReference(plan.epoch, "invalid_account_response");
      }
      if (verification.kind === "account_unavailable") {
        return this.#clearCredentialReference(plan.epoch, "account_unavailable");
      }
      if (verification.kind === "rejected") {
        if (plan.rejectionPolicy === "reconnect") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        const refreshPlan = await this.#withLock(async () => {
          if (!this.#isCurrentEpoch(plan.epoch)) return null;
          return {
            epoch: plan.epoch,
            expectedAccountId: plan.expectedAccountId ?? "",
            oldCredentialRef: plan.credentialRef,
            reason: "rejection"
          };
        });
        if (refreshPlan === null) return { kind: "stale" };
        return this.#performRefresh(refreshPlan);
      }
      if (!isNonEmpty(verification.accountId)) {
        return this.#clearCredentialReference(plan.epoch, "identity_conflict");
      }
      if (plan.expectedAccountId !== null && verification.accountId !== plan.expectedAccountId) {
        return this.#clearCredentialReference(plan.epoch, "identity_conflict");
      }
      return this.#commitVerified(
        plan.epoch,
        plan.credentialRef,
        verification.accountId,
        credential
      );
    }
    async #refreshFromCapability(capability, reason) {
      const plan = await this.#withLock(async () => {
        if (!this.#isCurrentCapability(capability)) return null;
        if (this.#envelope.credentialRef === null) return null;
        this.#capability = null;
        this.#transition({
          type: "verifying",
          epoch: capability.epoch,
          accountId: capability.accountId
        });
        return {
          epoch: capability.epoch,
          expectedAccountId: capability.accountId,
          oldCredentialRef: this.#envelope.credentialRef,
          reason
        };
      });
      if (plan === null) return { kind: "stale" };
      return this.#performRefresh(plan);
    }
    async #performRefresh(plan) {
      let acquisition;
      try {
        acquisition = normalizeAcquisition(
          await this.#ports.credentials.acquire("refresh")
        );
      } catch {
        this.#record("credential_provider_failed");
        acquisition = { kind: "unavailable" };
      }
      if (acquisition.kind === "unavailable") {
        this.#record("credential_provider_failed");
      }
      if (acquisition.kind !== "credential") {
        if (plan.reason === "rejection") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        return this.#degradeRefresh(plan);
      }
      let verification;
      try {
        verification = normalizeVerification(
          await this.#ports.api.verifyCredential(acquisition.credential)
        );
      } catch {
        verification = { kind: "unavailable" };
      }
      if (verification.kind === "unavailable") {
        if (plan.reason === "rejection") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        return this.#degradeRefresh(plan);
      }
      if (verification.kind === "invalid_response") {
        return this.#clearCredentialReference(plan.epoch, "invalid_account_response");
      }
      if (verification.kind === "account_unavailable") {
        return this.#clearCredentialReference(plan.epoch, "account_unavailable");
      }
      if (verification.kind === "rejected" || plan.expectedAccountId.length > 0 && verification.accountId !== plan.expectedAccountId) {
        return this.#clearCredentialReference(
          plan.epoch,
          verification.kind === "rejected" ? "credential_rejected" : "identity_conflict"
        );
      }
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          acquisition.credential,
          plan.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        if (plan.reason === "rejection") {
          return this.#clearCredentialReference(plan.epoch, "credential_rejected");
        }
        return this.#degradeRefresh(plan);
      }
      const accountId = plan.expectedAccountId.length > 0 ? plan.expectedAccountId : verification.accountId;
      const committed = await this.#commitVerified(
        plan.epoch,
        credentialRef,
        accountId,
        acquisition.credential,
        plan.oldCredentialRef
      );
      if (committed.kind !== "completed" || committed.state !== "connected") {
        this.#scheduleCredentialDelete(credentialRef);
        return committed;
      }
      return committed;
    }
    async #degradeVerification(plan) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(plan.epoch)) return { kind: "stale" };
        const displayScope = plan.expectedAccountId === null ? null : { accountId: plan.expectedAccountId, epoch: plan.epoch };
        this.#transition({
          type: "degraded",
          epoch: plan.epoch,
          displayScope,
          reason: "verification_unavailable"
        });
        return { kind: "unavailable" };
      });
    }
    async #degradeRefresh(plan) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(plan.epoch)) return { kind: "stale" };
        this.#transition({
          type: "degraded",
          epoch: plan.epoch,
          displayScope: {
            accountId: plan.expectedAccountId,
            epoch: plan.epoch
          },
          reason: "verification_unavailable"
        });
        return { kind: "unavailable" };
      });
    }
    async #commitVerified(epoch, credentialRef, accountId, credential, cleanupReference = null) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(epoch)) {
          this.#record("stale_effect_discarded");
          return { kind: "stale" };
        }
        const persisted = await this.#persist(
          connectedEnvelope(epoch, credentialRef, accountId)
        );
        if (!persisted) return { kind: "storage_error" };
        this.#capability = createCapability(accountId, epoch, credential);
        this.#transition({ type: "connected", scope: { accountId, epoch } });
        if (cleanupReference !== null && cleanupReference !== credentialRef) {
          this.#scheduleCredentialDelete(cleanupReference);
        }
        return { kind: "completed", state: "connected" };
      });
    }
    async #commitSynchronizedCredential(expectedCapability, credentialRef, credential) {
      return this.#withLock(async () => {
        if (!this.#isCurrentCapability(expectedCapability)) {
          this.#record("stale_effect_discarded");
          return { kind: "stale" };
        }
        const oldReference = this.#envelope.credentialRef;
        const persisted = await this.#persist(
          connectedEnvelope(
            expectedCapability.epoch,
            credentialRef,
            expectedCapability.accountId
          )
        );
        if (!persisted) return { kind: "storage_error" };
        this.#capability = createCapability(
          expectedCapability.accountId,
          expectedCapability.epoch,
          credential
        );
        this.#transition({
          type: "connected",
          scope: {
            accountId: expectedCapability.accountId,
            epoch: expectedCapability.epoch
          }
        });
        if (oldReference !== null && oldReference !== credentialRef) {
          this.#scheduleCredentialDelete(oldReference);
        }
        return { kind: "completed", state: "connected" };
      });
    }
    async #switchToVerifiedProviderCredential(expectedCapability, credential, accountId) {
      const transition = await this.#withLock(async () => {
        if (!this.#isCurrentCapability(expectedCapability)) {
          this.#record("stale_effect_discarded");
          return { kind: "stale" };
        }
        const oldReference = this.#envelope.credentialRef;
        const epoch = this.#reserveNextEpoch();
        const persisted = await this.#persist(disconnectedEnvelope(epoch));
        if (!persisted) return { kind: "storage_error" };
        this.#transition({ type: "connecting", epoch });
        this.#activeAcquisitionEpoch = epoch;
        return { kind: "ready", epoch, oldReference };
      });
      if (transition.kind !== "ready") return transition;
      let credentialRef;
      try {
        credentialRef = await this.#ports.credentials.storeUnique(
          credential,
          transition.epoch
        );
        if (!isNonEmpty(credentialRef)) throw new TypeError("empty credential reference");
      } catch {
        this.#record("credential_provider_failed");
        return this.#withLock(async () => {
          if (!this.#isCurrentAcquisition(transition.epoch)) {
            return { kind: "stale" };
          }
          this.#activeAcquisitionEpoch = null;
          this.#transition({
            type: "signed_out",
            epoch: transition.epoch,
            reason: "provider_unavailable"
          });
          if (transition.oldReference !== null) {
            this.#scheduleCredentialDelete(transition.oldReference);
          }
          return { kind: "unavailable" };
        });
      }
      const admitted = await this.#withLock(async () => {
        if (!this.#isCurrentAcquisition(transition.epoch)) {
          this.#record("stale_effect_discarded");
          this.#scheduleCredentialDelete(credentialRef);
          return false;
        }
        this.#activeAcquisitionEpoch = null;
        return true;
      });
      if (!admitted) return { kind: "stale" };
      const committed = await this.#commitVerified(
        transition.epoch,
        credentialRef,
        accountId,
        credential,
        transition.oldReference
      );
      if (committed.kind !== "completed" || committed.state !== "connected") {
        this.#scheduleCredentialDelete(credentialRef);
        if (transition.oldReference !== null) {
          this.#scheduleCredentialDelete(transition.oldReference);
        }
      }
      return committed;
    }
    async #clearCredentialReference(epoch, reason) {
      return this.#withLock(async () => {
        if (!this.#isCurrentEpoch(epoch)) return { kind: "stale" };
        const oldReference = this.#envelope.credentialRef;
        this.#capability = null;
        const persisted = await this.#persist(
          connectedEnvelope(epoch, null, this.#envelope.accountId)
        );
        const result = persisted ? { kind: "completed", state: "reconnect_required" } : { kind: "storage_error" };
        if (persisted) {
          this.#transition({ type: "reconnect_required", epoch, reason });
        }
        if (oldReference !== null) {
          if (persisted) {
            this.#scheduleCredentialDelete(oldReference);
          } else {
            await this.#deleteCredential(oldReference);
          }
        }
        return result;
      });
    }
    async #disconnectInternal(onlyConnecting, expectedAcquisitionEpoch) {
      return this.#withLock(async () => {
        const isUnverifiedConnect = this.#model.state === "connecting" || this.#model.state === "verifying" && this.#envelope.accountId === null;
        if (onlyConnecting && !isUnverifiedConnect) {
          return expectedAcquisitionEpoch !== void 0 && !this.#isCurrentEpoch(expectedAcquisitionEpoch) ? { kind: "stale" } : { kind: "ignored" };
        }
        if (expectedAcquisitionEpoch !== void 0 && this.#activeAcquisitionEpoch !== expectedAcquisitionEpoch) {
          return { kind: "stale" };
        }
        const oldReference = this.#envelope.credentialRef;
        const epoch = this.#reserveNextEpoch();
        this.#capability = null;
        this.#activeAcquisitionEpoch = null;
        try {
          this.#ports.credentials.cancelAcquisition?.();
        } catch {
          this.#record("credential_provider_failed");
        }
        const persisted = await this.#persist(disconnectedEnvelope(epoch));
        const result = persisted ? { kind: "completed", state: "signed_out" } : { kind: "storage_error" };
        if (persisted) this.#transition({ type: "signed_out", epoch });
        if (persisted) {
          this.#scheduleCredentialClearAll();
        } else if (oldReference !== null) {
          await this.#deleteCredential(oldReference);
        }
        return result;
      });
    }
    #reserveNextEpoch() {
      if (!Number.isSafeInteger(this.#reservation + 1)) {
        throw new RangeError("session epoch exhausted");
      }
      this.#reservation += 1;
      this.#capability = null;
      return this.#reservation;
    }
    async #persist(envelope) {
      try {
        await this.#ports.storage.write(envelope);
        this.#envelope = envelope;
        return true;
      } catch {
        this.#capability = null;
        this.#transition({
          type: "reconnect_required",
          epoch: this.#reservation,
          reason: "storage_write_failed"
        });
        this.#record("storage_write_failed");
        return false;
      }
    }
    async #deleteCredential(reference) {
      try {
        await this.#ports.credentials.delete(reference);
      } catch {
        this.#record("credential_cleanup_failed");
      }
    }
    #scheduleCredentialDelete(reference) {
      void this.#deleteCredential(reference);
    }
    #scheduleCredentialClearAll() {
      try {
        void this.#ports.credentials.clearAll().catch(() => {
          this.#record("credential_cleanup_failed");
        });
      } catch {
        this.#record("credential_cleanup_failed");
      }
    }
    #copyScope(scope2) {
      return scope2 === null ? null : Object.freeze({ accountId: scope2.accountId, epoch: scope2.epoch });
    }
    #isCurrentEpoch(epoch) {
      return this.#reservation === epoch && this.#envelope.epoch === epoch;
    }
    #isCurrentAcquisition(epoch) {
      return this.#isCurrentEpoch(epoch) && this.#activeAcquisitionEpoch === epoch && this.#model.state === "connecting";
    }
    #isCurrentCapability(capability) {
      return this.#capability === capability && this.#reservation === capability.epoch && this.#model.state === "connected";
    }
    #transition(event) {
      this.#model = reduceSession(this.#model, event);
      this.#record("session_state_changed");
    }
    #record(code) {
      try {
        this.#ports.diagnostics.record({
          code,
          state: this.#model.state,
          epoch: this.#reservation
        });
      } catch {
      }
    }
    async #withLock(work) {
      const previous = this.#lockTail;
      let release = () => {
      };
      this.#lockTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-core/story-command.mts
  function failure3(reason) {
    return Object.freeze({ kind: "failed", reason });
  }
  function executionFailure3(result) {
    if (result.kind === "stale") return failure3("stale");
    if (result.kind === "auth_rejected") return failure3("auth_expired");
    return failure3("not_authenticated");
  }
  function confirmationSatisfiesStoryCommand(command, confirmation) {
    if (confirmation.workKey !== command.workKey) return false;
    if (command.intent === "ensure_saved") return true;
    const target = command.progress;
    const chapters = confirmation.entry.chapters;
    if (target === void 0 || chapters === void 0) return false;
    if (chapters.current < target.current) return false;
    return target.total === null || chapters.total !== null && chapters.total >= target.total;
  }
  var StoryCommandService = class {
    #ports;
    #tail = Promise.resolve();
    constructor(ports) {
      this.#ports = ports;
    }
    execute(command) {
      return this.#withLock(() => this.#execute(command));
    }
    async #execute(command) {
      const scope2 = this.#ports.session.publicationScope();
      if (scope2 === null) return failure3("not_authenticated");
      if (command.intent === "ensure_saved") {
        const lookup = await this.#lookup(command.workKey, true);
        if (lookup.kind !== "published") return executionFailure3(lookup);
        if (lookup.value.kind === "found" && confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)) {
          return this.#finalize(scope2, command, lookup.value.confirmation, "preflight");
        }
        if (lookup.value.kind === "invalid_response") return failure3("invalid_response");
        if (lookup.value.kind === "unavailable") return failure3("unavailable");
      }
      let mutation = await this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.track(credential, command)
      );
      if (mutation.kind === "auth_rejected" && mutation.recovery === "connected") {
        if (command.intent === "ensure_saved") {
          const lookup = await this.#lookup(command.workKey, false);
          if (lookup.kind !== "published") return executionFailure3(lookup);
          if (lookup.value.kind === "found" && confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)) {
            return this.#finalize(scope2, command, lookup.value.confirmation, "preflight");
          }
          if (lookup.value.kind === "invalid_response") return failure3("invalid_response");
          if (lookup.value.kind === "unavailable") return failure3("unavailable");
        }
        mutation = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.track(credential, command)
        );
      }
      if (mutation.kind !== "published") return executionFailure3(mutation);
      if (mutation.value.kind === "confirmed") {
        if (!confirmationSatisfiesStoryCommand(command, mutation.value.confirmation)) {
          return failure3("confirmation_missing");
        }
        return this.#finalize(scope2, command, mutation.value.confirmation, "mutation");
      }
      if (mutation.value.kind === "rejected") return failure3(mutation.value.reason);
      if (mutation.value.kind === "invalid_response") return failure3("invalid_response");
      const reconciliation = await this.#lookup(command.workKey, false);
      if (reconciliation.kind !== "published") return executionFailure3(reconciliation);
      if (reconciliation.value.kind === "found" && confirmationSatisfiesStoryCommand(
        command,
        reconciliation.value.confirmation
      )) {
        return this.#finalize(
          scope2,
          command,
          reconciliation.value.confirmation,
          "reconciliation"
        );
      }
      if (reconciliation.value.kind === "invalid_response") {
        return failure3("invalid_response");
      }
      return failure3(
        reconciliation.value.kind === "unavailable" ? "unavailable" : "confirmation_missing"
      );
    }
    async #lookup(workKey, allowAuthRecovery) {
      let result = await this.#ports.session.executeAuthenticated(
        (credential) => this.#ports.api.lookup(credential, workKey)
      );
      if (allowAuthRecovery && result.kind === "auth_rejected" && result.recovery === "connected") {
        result = await this.#ports.session.executeAuthenticated(
          (credential) => this.#ports.api.lookup(credential, workKey)
        );
      }
      return result;
    }
    async #finalize(scope2, command, confirmation, source) {
      if (confirmation.workKey !== command.workKey || !sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure3("stale");
      }
      let projection;
      try {
        projection = await this.#ports.projection.publishConfirmed(scope2, confirmation);
      } catch {
        projection = { kind: "unavailable" };
      }
      if (projection.kind === "rejected_scope") return failure3("stale");
      if (projection.kind === "stale_write") return failure3("stale");
      if (projection.kind === "invalid_model") return failure3("invalid_response");
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope2)) {
        return failure3("stale");
      }
      let receipt = "not_applicable";
      if (command.intent === "ensure_saved") {
        try {
          receipt = await this.#ports.receipt.publishSaveReceipt({
            hostKind: command.hostKind,
            action: "quick_add",
            at: this.#ports.clock.now(),
            ...command.handoffId === void 0 ? {} : { handoffId: command.handoffId }
          }) ? "published" : "unavailable";
        } catch {
          receipt = "unavailable";
        }
      }
      let handoff = "not_present";
      if (command.intent === "ensure_saved" && command.handoffId !== void 0) {
        try {
          handoff = await this.#ports.handoff.clearExpected(command.handoffId) ? "cleared" : "unavailable";
        } catch {
          handoff = "unavailable";
        }
      }
      return Object.freeze({
        kind: "confirmed",
        intent: command.intent,
        confirmation,
        source,
        projection: projection.kind === "published" ? "published" : "unavailable",
        receipt,
        handoff
      });
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-runtime/private-database.mts
  var PRIVATE_DATABASE_NAME = "traceKernelPrivateV1";
  var PRIVATE_DATABASE_VERSION = 1;
  var PRIVATE_RECORD_STORE = "records";
  var PRIVATE_RECORD_KEYS = Object.freeze({
    sessionEnvelope: "session-envelope",
    sessionCredentials: "session-credentials",
    accountData: "account-data"
  });
  function databaseError(message, error = null) {
    const detail = error?.message?.trim();
    return new Error(detail ? `${message}: ${detail}` : message, { cause: error ?? void 0 });
  }
  var BrowserPrivateRecordDatabase = class {
    #factory;
    #openPromise = null;
    constructor(factory) {
      this.#factory = factory;
    }
    get(key) {
      return this.#runTransaction("readonly", (store) => store.get(key), (request) => request.result === void 0 ? null : request.result);
    }
    put(key, value) {
      return this.#runTransaction("readwrite", (store) => store.put(value, key), () => void 0);
    }
    delete(key) {
      return this.#runTransaction("readwrite", (store) => store.delete(key), () => void 0);
    }
    async deleteDatabase() {
      const pending = this.#openPromise;
      this.#openPromise = null;
      if (pending !== null) {
        try {
          (await pending).close();
        } catch {
        }
      }
      await new Promise((resolve, reject) => {
        let settled = false;
        const request = this.#factory.deleteDatabase(PRIVATE_DATABASE_NAME);
        const finish = (result, error) => {
          if (settled) return;
          settled = true;
          if (result === "resolve") resolve();
          else reject(error);
        };
        request.onsuccess = () => finish("resolve");
        request.onerror = () => finish(
          "reject",
          databaseError("private database deletion failed", request.error)
        );
        request.onblocked = () => finish(
          "reject",
          databaseError("private database deletion blocked")
        );
      });
    }
    async #runTransaction(mode, start, readResult) {
      const database = await this.#open();
      return new Promise((resolve, reject) => {
        let request;
        let result;
        let requestSucceeded = false;
        let settled = false;
        const transaction = database.transaction(PRIVATE_RECORD_STORE, mode);
        const finishReject = (message, error = null) => {
          if (settled) return;
          settled = true;
          reject(databaseError(message, error));
        };
        try {
          request = start(transaction.objectStore(PRIVATE_RECORD_STORE));
        } catch (error) {
          try {
            transaction.abort();
          } catch {
          }
          finishReject(
            "private database request failed",
            error instanceof DOMException ? error : null
          );
          return;
        }
        request.onsuccess = () => {
          try {
            result = readResult(request);
            requestSucceeded = true;
          } catch (error) {
            try {
              transaction.abort();
            } catch {
            }
            finishReject(
              "private database result invalid",
              error instanceof DOMException ? error : null
            );
          }
        };
        request.onerror = () => finishReject(
          "private database request failed",
          request.error
        );
        transaction.onabort = () => finishReject(
          "private database transaction aborted",
          transaction.error
        );
        transaction.onerror = () => {
        };
        transaction.oncomplete = () => {
          if (settled) return;
          if (!requestSucceeded) {
            finishReject("private database request completed without a result");
            return;
          }
          settled = true;
          resolve(result);
        };
      });
    }
    #open() {
      if (this.#openPromise !== null) return this.#openPromise;
      const opening = new Promise((resolve, reject) => {
        let settled = false;
        const request = this.#factory.open(PRIVATE_DATABASE_NAME, PRIVATE_DATABASE_VERSION);
        const finishReject = (message, error = null) => {
          if (settled) return;
          settled = true;
          reject(databaseError(message, error));
        };
        request.onupgradeneeded = (event) => {
          const database = request.result;
          if (event.oldVersion !== 0 || database.objectStoreNames.length !== 0) {
            request.transaction?.abort();
            return;
          }
          database.createObjectStore(PRIVATE_RECORD_STORE);
        };
        request.onerror = () => finishReject("private database open failed", request.error);
        request.onblocked = () => finishReject("private database open blocked");
        request.onsuccess = () => {
          const database = request.result;
          if (settled) {
            database.close();
            return;
          }
          if (database.version !== PRIVATE_DATABASE_VERSION || !database.objectStoreNames.contains(PRIVATE_RECORD_STORE) || database.objectStoreNames.length !== 1) {
            database.close();
            finishReject("private database schema invalid");
            return;
          }
          settled = true;
          database.onversionchange = () => {
            database.close();
            if (this.#openPromise === cached) this.#openPromise = null;
          };
          resolve(database);
        };
      });
      const cached = opening.catch((error) => {
        if (this.#openPromise === cached) this.#openPromise = null;
        throw error;
      });
      this.#openPromise = cached;
      return cached;
    }
  };

  // src/extension-runtime/browser-platform.mts
  var BrowserStorage = class {
    #area;
    #runtime;
    #mode;
    constructor(area, runtime, mode) {
      this.#area = area;
      this.#runtime = runtime;
      this.#mode = mode;
    }
    get(keys) {
      return this.#call("get", [keys]);
    }
    set(patch) {
      return this.#call("set", [patch]);
    }
    remove(keys) {
      return this.#call("remove", [keys]);
    }
    #call(method, args) {
      if (this.#mode === "promise") {
        try {
          return Promise.resolve(this.#area[method](...args));
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return new Promise((resolve, reject) => {
        try {
          this.#area[method](...args, (value) => {
            const message = this.#runtime.lastError?.message;
            if (message) reject(new Error(message));
            else resolve(value);
          });
        } catch (error) {
          reject(error);
        }
      });
    }
  };
  function extensionCall(target, method, args, runtime, mode) {
    if (mode === "promise") {
      try {
        return Promise.resolve(target[method](...args));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      try {
        target[method](...args, (value) => {
          const message = runtime.lastError?.message;
          if (message) reject(new Error(message));
          else resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // src/extension-runtime/browser-adapters.mts
  var LEGACY_SESSION_ENVELOPE_KEY = "traceSessionEnvelopeV1";
  var LEGACY_SESSION_CREDENTIALS_KEY = "traceSessionCredentialsV1";
  var UUID_PATTERN3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var ACCOUNT_DATA_ALARM = "traceAccountDataRefresh";
  var SAVED_FILTER_SYNC_ALARM = "traceAo3SavedFiltersSync";
  var LEGACY_ACCOUNT_ALARMS = Object.freeze([
    "traceLibraryOverlay"
  ]);
  var SAVED_FILTER_LOCAL_KEYS = Object.freeze({
    presets: "traceAo3SavedFiltersV1",
    deleted: "traceAo3SavedFiltersDeletedV1",
    syncMeta: "traceAo3SavedFiltersSyncV1",
    clientId: "traceAo3SavedFiltersClientIdV1",
    activeMeta: "traceAo3SavedFiltersActiveV1"
  });
  var LEGACY_ACCOUNT_KEYS = Object.freeze([
    LEGACY_SESSION_ENVELOPE_KEY,
    LEGACY_SESSION_CREDENTIALS_KEY,
    "authToken",
    "traceAuthState",
    "traceAccountId",
    "libraryOverlayCache",
    "libraryOverlayFetchedAt",
    "traceWorkStatesV1",
    "traceUserPro",
    "traceLibraryCount",
    "traceFirstSaveSeen"
  ]);
  var DISABLED_LOCAL_KEYS = Object.freeze([
    ...LEGACY_ACCOUNT_KEYS,
    ...Object.values(SAVED_FILTER_LOCAL_KEYS),
    "traceArchiveReadiness"
  ]);
  var BrowserSessionStoragePort = class {
    #database;
    constructor(database) {
      this.#database = database;
    }
    read() {
      return this.#database.get(PRIVATE_RECORD_KEYS.sessionEnvelope);
    }
    write(envelope) {
      return this.#database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, envelope);
    }
    clearAll() {
      return this.#database.delete(PRIVATE_RECORD_KEYS.sessionEnvelope);
    }
  };
  function isRecord5(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function parseCredentialStore(raw) {
    if (!isRecord5(raw) || raw.version !== 1 || !isRecord5(raw.entries)) return {};
    const entries = {};
    for (const [reference, credential] of Object.entries(raw.entries)) {
      if (reference.trim() && typeof credential === "string" && credential.trim()) {
        entries[reference] = credential;
      }
    }
    return entries;
  }
  var BrowserCredentialPort = class {
    #database;
    #provider;
    #randomId;
    #tail = Promise.resolve();
    constructor(database, provider, randomId) {
      this.#database = database;
      this.#provider = provider;
      this.#randomId = randomId;
    }
    acquire(purpose) {
      return this.#provider.acquire(purpose);
    }
    cancelAcquisition() {
      this.#provider.cancel();
    }
    load(reference) {
      return this.#withLock(async () => {
        const entries = await this.#readEntries();
        return entries[reference] ?? null;
      });
    }
    storeUnique(credential, epoch) {
      return this.#withLock(async () => {
        const suffix = this.#randomId().trim();
        if (!suffix) throw new TypeError("credential reference is empty");
        const reference = `session:${epoch}:${suffix}`;
        const entries = await this.#readEntries();
        entries[reference] = credential;
        await this.#writeEntries(entries);
        return reference;
      });
    }
    delete(reference) {
      return this.#withLock(async () => {
        const entries = await this.#readEntries();
        delete entries[reference];
        if (Object.keys(entries).length === 0) {
          await this.#database.delete(PRIVATE_RECORD_KEYS.sessionCredentials);
        } else {
          await this.#writeEntries(entries);
        }
      });
    }
    clearAll() {
      return this.#withLock(async () => {
        await this.#database.delete(PRIVATE_RECORD_KEYS.sessionCredentials);
      });
    }
    async #readEntries() {
      return parseCredentialStore(
        await this.#database.get(PRIVATE_RECORD_KEYS.sessionCredentials)
      );
    }
    #writeEntries(entries) {
      const value = Object.freeze({
        version: 1,
        entries: Object.freeze({ ...entries })
      });
      return this.#database.put(PRIVATE_RECORD_KEYS.sessionCredentials, value);
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
  var LegacyAccountState = class {
    #storage;
    constructor(storage) {
      this.#storage = storage;
    }
    clear() {
      return this.#storage.remove(LEGACY_ACCOUNT_KEYS);
    }
    clearAll() {
      return this.#storage.remove(DISABLED_LOCAL_KEYS);
    }
  };
  var KernelAlarmState = class {
    #alarms;
    #runtime;
    #mode;
    constructor(alarms, runtime, mode) {
      this.#alarms = alarms;
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async clearRetired() {
      for (const name of LEGACY_ACCOUNT_ALARMS) await this.#clear(name);
    }
    async clearAll() {
      await this.#clear(ACCOUNT_DATA_ALARM);
      await this.#clear(SAVED_FILTER_SYNC_ALARM);
      await this.clearRetired();
    }
    async #clear(name) {
      await extensionCall(
        this.#alarms,
        "clear",
        [name],
        this.#runtime,
        this.#mode
      );
    }
  };
  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      promise.then((value) => finish(value), () => finish(null));
    });
  }
  async function sendNativeMessageWithFallback(runtime, mode, message, timeoutMs = 5e3) {
    if (typeof runtime.sendNativeMessage !== "function") return null;
    const attempts = [
      [message],
      ["com.tracefiction.trace", message]
    ];
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (const args of attempts) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const response = await withTimeout(
        extensionCall(
          runtime,
          "sendNativeMessage",
          args,
          runtime,
          mode
        ),
        remainingMs
      );
      if (response !== null) return response;
    }
    return null;
  }
  var IOS_NATIVE_CREDENTIAL_READ_BUDGET_MS = 2500;
  var IOS_NATIVE_CREDENTIAL_READ_ATTEMPT_TIMEOUT_MS = 1e3;
  var IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS = 150;
  var NativeArchiveReadinessReceiptPort = class {
    #runtime;
    #mode;
    constructor(runtime, mode) {
      this.#runtime = runtime;
      this.#mode = mode;
    }
    publishRunReceipt(receipt) {
      return this.#publish({
        type: "TRACE_IOS_EXTENSION_HEARTBEAT",
        hostKind: receipt.hostKind,
        at: receipt.at,
        ...receipt.handoffId === void 0 ? {} : { handoffId: receipt.handoffId }
      });
    }
    publishPermissionSnapshot(snapshot) {
      return this.#publish({
        type: "TRACE_IOS_EXTENSION_HEARTBEAT",
        hostKind: snapshot.hostKind,
        at: snapshot.at,
        permissionSnapshot: true,
        grantedOrigins: [...snapshot.grantedOrigins]
      });
    }
    async #publish(message) {
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        message
      );
      return isRecord5(response) && (response.ok === true || response.ok === "true");
    }
  };
  var NativeStorySaveReceiptPort = class {
    #runtime;
    #mode;
    constructor(runtime, mode) {
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async publishSaveReceipt(receipt) {
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        {
          type: "TRACE_IOS_EXTENSION_HEARTBEAT",
          hostKind: receipt.hostKind,
          action: receipt.action,
          at: receipt.at,
          ...receipt.handoffId === void 0 ? {} : { handoffId: receipt.handoffId }
        }
      );
      return isRecord5(response) && (response.ok === true || response.ok === "true");
    }
  };
  var NativePendingStoryHandoffPort = class {
    #runtime;
    #mode;
    constructor(runtime, mode) {
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async clearExpected(handoffId) {
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        {
          type: "TRACE_IOS_PENDING_FIRST_STORY_CLEAR",
          handoffId
        }
      );
      return isRecord5(response) && (response.ok === true || response.ok === "true") && response.cleared !== false && response.cleared !== "false";
    }
  };
  var BrowserArchivePermissionSnapshotPort = class {
    #permissions;
    #runtime;
    #mode;
    constructor(permissions, runtime, mode) {
      this.#permissions = permissions;
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async readGrantedOrigins() {
      if (this.#permissions === void 0) return null;
      const response = await withTimeout(
        extensionCall(
          this.#permissions,
          "getAll",
          [],
          this.#runtime,
          this.#mode
        ),
        2e3
      );
      if (!isRecord5(response) || !Array.isArray(response.origins)) return null;
      return Object.freeze(
        Array.from(new Set(
          response.origins.filter((origin) => typeof origin === "string").map((origin) => origin.trim().slice(0, 256)).filter(Boolean)
        )).slice(0, 64)
      );
    }
  };
  var ExplicitCredentialProvider = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #webTabPattern;
    #randomId;
    #generation = 0;
    #isIos = null;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      const webUrl = new URL(options.webOrigin);
      this.#webOrigin = webUrl.origin;
      this.#webTabPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
      this.#randomId = options.randomId;
    }
    async acquire(purpose) {
      const generation = ++this.#generation;
      const result = await this.#detectIos() ? await this.#acquireNative(generation) : await this.#acquireFromTraceTab(purpose);
      return generation === this.#generation ? result : { kind: "cancelled" };
    }
    cancel() {
      this.#generation += 1;
    }
    async #detectIos() {
      this.#isIos ??= (async () => {
        if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) return true;
        if (typeof this.#runtime.getPlatformInfo !== "function") return false;
        try {
          const info = await extensionCall(
            this.#runtime,
            "getPlatformInfo",
            [],
            this.#runtime,
            this.#mode
          );
          return info?.os === "ios";
        } catch {
          return false;
        }
      })();
      return this.#isIos;
    }
    async #acquireFromTraceTab(purpose) {
      let tabs;
      try {
        tabs = await extensionCall(
          this.#tabs,
          "query",
          [{ url: [this.#webTabPattern] }],
          this.#runtime,
          this.#mode
        );
      } catch {
        return { kind: "unavailable" };
      }
      const candidates = tabs.filter((tab) => {
        if (typeof tab.id !== "number" || typeof tab.url !== "string") return false;
        try {
          return new URL(tab.url).origin === this.#webOrigin;
        } catch {
          return false;
        }
      }).sort(
        (left, right) => Number(right.active === true) - Number(left.active === true) || (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0)
      );
      const deadline = Date.now() + 1e4;
      for (const tab of candidates) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const requestId = this.#randomId();
        const response = await withTimeout(
          extensionCall(
            this.#tabs,
            "sendMessage",
            [tab.id, {
              type: "TRACE_CREDENTIAL_GRANT_REQUEST",
              protocolVersion: 1,
              requestId,
              purpose
            }],
            this.#runtime,
            this.#mode
          ),
          remainingMs
        );
        if (!isRecord5(response) || response.requestId !== requestId) continue;
        const credential = typeof response.token === "string" ? response.token.trim() : "";
        if (response.ok === true && credential) return { kind: "credential", credential };
      }
      return { kind: "absent" };
    }
    async #acquireNativeOnce(timeoutMs) {
      const request = { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", protocolVersion: 3 };
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        request,
        timeoutMs
      );
      if (!isRecord5(response)) return { kind: "unavailable" };
      const credential = typeof response.credential === "string" ? response.credential.trim() : typeof response.token === "string" ? response.token.trim() : "";
      const credentialKind = response.credentialKind;
      const validKind = credentialKind === "device_session" || credentialKind === "access_token";
      const validDeviceMetadata = credentialKind !== "device_session" || typeof response.sessionId === "string" && UUID_PATTERN3.test(response.sessionId) && typeof response.expiresAt === "string" && Number.isFinite(Date.parse(response.expiresAt));
      if ((response.ok === true || response.ok === "true") && credential && validKind && validDeviceMetadata) {
        return { kind: "credential", credential };
      }
      return response.error === "missing_token" ? { kind: "absent" } : { kind: "unavailable" };
    }
    async #acquireNative(generation) {
      const deadline = Date.now() + IOS_NATIVE_CREDENTIAL_READ_BUDGET_MS;
      const read = () => this.#acquireNativeOnce(
        Math.min(
          IOS_NATIVE_CREDENTIAL_READ_ATTEMPT_TIMEOUT_MS,
          Math.max(0, deadline - Date.now())
        )
      );
      const first = await read();
      if (first.kind !== "unavailable" || generation !== this.#generation) {
        return first;
      }
      const remainingBeforeDelay = deadline - Date.now();
      if (remainingBeforeDelay <= IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS) {
        return first;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS);
      });
      if (generation !== this.#generation || Date.now() >= deadline) {
        return { kind: "cancelled" };
      }
      return read();
    }
  };
  function sanitizePendingFirstStoryResponse(response) {
    if (!isRecord5(response)) return { ok: false, error: "native_unavailable" };
    if (response.ok !== true && response.ok !== "true") {
      return { ok: false, error: "native_error" };
    }
    const sanitized = { ok: true, url: "" };
    if (typeof response.url === "string" && response.url.length <= 4096) {
      sanitized.url = response.url.trim();
    }
    if (response.mode === "story" || response.mode === "browse") {
      sanitized.mode = response.mode;
    }
    if (response.hostKind === "ao3" || response.hostKind === "ffn") {
      sanitized.hostKind = response.hostKind;
    }
    if (typeof response.handoffId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(response.handoffId.trim())) {
      sanitized.handoffId = response.handoffId.trim();
    }
    const expiresAt = typeof response.expiresAt === "number" ? response.expiresAt : typeof response.expiresAt === "string" ? Number(response.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt)) sanitized.expiresAt = expiresAt;
    if (response.expired === true || response.expired === "true") sanitized.expired = true;
    return Object.freeze(sanitized);
  }
  var NativePendingFirstStoryReader = class {
    #runtime;
    #mode;
    constructor(runtime, mode) {
      this.#runtime = runtime;
      this.#mode = mode;
    }
    async read() {
      const request = { type: "TRACE_IOS_PENDING_FIRST_STORY_GET" };
      const response = await sendNativeMessageWithFallback(
        this.#runtime,
        this.#mode,
        request
      );
      return response === null ? { ok: false, error: "native_unavailable" } : sanitizePendingFirstStoryResponse(response);
    }
  };
  var VerificationApi = class {
    #fetch;
    #endpoint;
    #onRetryDisposition;
    constructor(fetchImpl, apiBase, onRetryDisposition = () => {
    }) {
      this.#fetch = fetchImpl;
      this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/account`;
      this.#onRetryDisposition = onRetryDisposition;
    }
    async verifyCredential(credential) {
      const response = await withTimeout(
        this.#fetch(this.#endpoint, {
          method: "GET",
          cache: "no-store",
          headers: { Authorization: `Bearer ${credential}` }
        }),
        1e4
      );
      if (response === null) {
        this.#onRetryDisposition("automatic");
        return { kind: "unavailable" };
      }
      if (response.status === 429) {
        this.#onRetryDisposition("manual");
        return { kind: "unavailable" };
      }
      if (response.status >= 500) {
        this.#onRetryDisposition("automatic");
        return { kind: "unavailable" };
      }
      this.#onRetryDisposition("none");
      if (response.status === 401 || response.status === 403) return { kind: "rejected" };
      if (!response.ok) return { kind: "account_unavailable" };
      let body;
      try {
        body = await response.json();
      } catch {
        return { kind: "invalid_response" };
      }
      if (!isRecord5(body) || typeof body.account_id !== "string" || !body.account_id.trim()) {
        return { kind: "invalid_response" };
      }
      return { kind: "verified", accountId: body.account_id.trim() };
    }
  };

  // src/extension-runtime/account-data-repository.mts
  var CAPACITY_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1e3;
  var CAPACITY_DISMISSAL_MS = 7 * 24 * 60 * 60 * 1e3;
  var AccountDataRepository = class {
    #database;
    #scopes;
    #tail = Promise.resolve();
    #overlayReservation = 0;
    #appliedOverlayReservation = 0;
    constructor(database, scopes) {
      this.#database = database;
      this.#scopes = scopes;
    }
    read() {
      return this.#withLock(async () => {
        const startingScope = this.#scopes.displayScope();
        if (startingScope === null) return null;
        const parsed = parseAccountData(
          await this.#database.get(PRIVATE_RECORD_KEYS.accountData)
        );
        if (parsed.kind === "invalid") {
          try {
            await this.#database.delete(PRIVATE_RECORD_KEYS.accountData);
          } catch {
          }
          return null;
        }
        if (parsed.kind !== "valid") return null;
        const currentScope = this.#scopes.displayScope();
        return sameAccountScope(startingScope, currentScope) && sameAccountScope(parsed.value.scope, currentScope) ? parsed.value : null;
      });
    }
    ensureScope(requestedScope) {
      return this.#publish(requestedScope, (current) => current);
    }
    publishSummary(requestedScope, value) {
      const summary = copyAccountSummary(value);
      if (summary === null) return Promise.resolve({ kind: "invalid_model" });
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        summary,
        capacityRecovery: summary.pro || current.capacityRecovery !== null && summary.libraryCount < current.capacityRecovery.blockedLibraryCount ? null : current.capacityRecovery
      }));
    }
    publishCapacityBlocked(requestedScope, at) {
      if (!Number.isSafeInteger(at) || at < 0) {
        return Promise.resolve({ kind: "invalid_model" });
      }
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        capacityRecovery: current.capacityRecovery ?? Object.freeze({
          blockedAt: at,
          blockedLibraryCount: current.summary?.libraryCount ?? 0,
          nextPromptAt: 0
        })
      }));
    }
    acknowledgeCapacityRecovery(requestedScope, acknowledgement, at) {
      if (acknowledgement !== "shown" && acknowledgement !== "dismissed" || !Number.isSafeInteger(at) || at < 0) {
        return Promise.resolve({ kind: "invalid_model" });
      }
      const delay = acknowledgement === "dismissed" ? CAPACITY_DISMISSAL_MS : CAPACITY_PROMPT_COOLDOWN_MS;
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        capacityRecovery: current.capacityRecovery === null ? null : Object.freeze({
          ...current.capacityRecovery,
          nextPromptAt: Math.max(
            current.capacityRecovery.nextPromptAt,
            at + delay
          )
        })
      }));
    }
    clearCapacityRecovery(requestedScope) {
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        capacityRecovery: null
      }));
    }
    publishOverlay(requestedScope, value, reservation = this.reserveOverlayWrite()) {
      const overlay = copyAccountOverlay(value);
      if (overlay === null) return Promise.resolve({ kind: "invalid_model" });
      return this.#publish(requestedScope, (current) => Object.freeze({
        ...current,
        overlay
      }), reservation);
    }
    publishConfirmedStory(requestedScope, confirmation) {
      return this.publishAuthoritativeStory(requestedScope, confirmation);
    }
    /**
     * Publishes an exact server acknowledgement into the account-scoped root.
     * Finish qualification responses from the first additive server release may
     * omit syncVersion, so preserve the current opaque version in that case.
     */
    publishAuthoritativeStory(requestedScope, confirmation, reservation = this.reserveOverlayWrite()) {
      const entry = copyLibraryOverlayEntry(confirmation.entry);
      if (entry === null || entry.entryId === void 0 || entry.entryId !== confirmation.entryId) {
        return Promise.resolve({ kind: "invalid_model" });
      }
      return this.#publish(requestedScope, (current) => {
        const overlay = current.overlay ?? Object.freeze({
          entries: Object.freeze({}),
          workPreferences: Object.freeze({}),
          syncVersion: (/* @__PURE__ */ new Date(0)).toISOString()
        });
        return Object.freeze({
          ...current,
          overlay: Object.freeze({
            entries: Object.freeze({
              ...overlay.entries,
              [confirmation.workKey]: entry
            }),
            workPreferences: overlay.workPreferences,
            syncVersion: confirmation.syncVersion ?? overlay.syncVersion
          })
        });
      }, reservation);
    }
    removeAuthoritativeStory(requestedScope, identity, reservation = this.reserveOverlayWrite()) {
      return this.#publish(requestedScope, (current) => {
        const overlay = current.overlay;
        const stored = overlay?.entries[identity.workKey];
        if (overlay === null || stored?.entryId !== identity.entryId) return current;
        const entries = { ...overlay.entries };
        delete entries[identity.workKey];
        return Object.freeze({
          ...current,
          overlay: Object.freeze({
            ...overlay,
            entries: Object.freeze(entries)
          })
        });
      }, reservation);
    }
    /**
     * Reserve before starting an overlay request. A command confirmation that
     * publishes while that request is in flight receives a newer reservation,
     * so the older full response cannot erase the command's exact entry.
     */
    reserveOverlayWrite() {
      this.#overlayReservation += 1;
      return this.#overlayReservation;
    }
    /**
     * Calling this mutates the lock tail synchronously. Disconnect can therefore
     * detach the returned promise while still ordering an immediate Reconnect's
     * later account-root write after this deletion.
     */
    clear() {
      return this.#withLock(async () => {
        await this.#database.delete(PRIVATE_RECORD_KEYS.accountData);
      });
    }
    #publish(requestedScope, update, overlayReservation) {
      return this.#withLock(async () => {
        if (!sameAccountScope(this.#scopes.publicationScope(), requestedScope)) {
          return { kind: "rejected_scope" };
        }
        if (overlayReservation !== void 0 && overlayReservation < this.#appliedOverlayReservation) {
          return { kind: "stale_write" };
        }
        const parsed = parseAccountData(
          await this.#database.get(PRIVATE_RECORD_KEYS.accountData)
        );
        if (!sameAccountScope(this.#scopes.publicationScope(), requestedScope)) {
          return { kind: "rejected_scope" };
        }
        const current = parsed.kind === "valid" && sameAccountScope(parsed.value.scope, requestedScope) ? parsed.value : createEmptyAccountData(requestedScope);
        const next = update(current);
        const validated = parseAccountData(next);
        if (validated.kind !== "valid" || !sameAccountScope(validated.value.scope, requestedScope)) {
          return { kind: "invalid_model" };
        }
        await this.#database.put(PRIVATE_RECORD_KEYS.accountData, validated.value);
        if (overlayReservation !== void 0) {
          this.#appliedOverlayReservation = overlayReservation;
        }
        return { kind: "published", value: validated.value };
      });
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-runtime/archive-sender.mts
  function isInactiveSender(sender) {
    if (typeof sender?.frameId === "number" && sender.frameId !== 0) return true;
    const lifecycle = typeof sender?.documentLifecycle === "string" ? sender.documentLifecycle.toLowerCase() : "";
    return lifecycle === "prerender" || lifecycle === "pending_deletion";
  }
  function archiveHostKindFromSender(sender) {
    if (isInactiveSender(sender)) return null;
    const rawUrl = sender?.tab?.url ?? sender?.url;
    if (typeof rawUrl !== "string") return null;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      if (host === "archiveofourown.org" || host.endsWith(".archiveofourown.org") || host === "archiveofourown.gay" || host.endsWith(".archiveofourown.gay") || host === "archive.transformativeworks.org" || host === "ao3.org" || host.endsWith(".ao3.org")) {
        return "ao3";
      }
      if (host === "www.fanfiction.net" || host === "m.fanfiction.net") {
        return "ffn";
      }
    } catch {
    }
    return null;
  }
  function isBlockedArchivePath(rawUrl, hostKind2) {
    if (typeof rawUrl !== "string") return true;
    try {
      const pathname = new URL(rawUrl).pathname;
      return hostKind2 === "ao3" ? /^\/users\/(?:login|sign_up|password|auth\/|logout)/i.test(pathname) : /^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(pathname);
    } catch {
      return true;
    }
  }
  function workKeyFromArchiveUrl(rawUrl, expectedHost) {
    if (typeof rawUrl !== "string" || rawUrl.length > 4096) return null;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      if (expectedHost === "ao3") {
        const supported = host === "archiveofourown.org" || host.endsWith(".archiveofourown.org") || host === "archiveofourown.gay" || host.endsWith(".archiveofourown.gay") || host === "archive.transformativeworks.org" || host === "ao3.org" || host.endsWith(".ao3.org");
        if (!supported) return null;
        const match2 = url.pathname.match(/^\/works\/([1-9][0-9]{0,19})(?:\/|$)/);
        return match2?.[1] ? `ao3:${match2[1]}` : null;
      }
      if (host !== "www.fanfiction.net" && host !== "m.fanfiction.net") return null;
      const match = url.pathname.match(/^\/s\/([1-9][0-9]{0,19})(?:\/|$)/);
      return match?.[1] ? `ffn:${match[1]}` : null;
    } catch {
      return null;
    }
  }
  function sourceMatchesArchiveHost(source, hostKind2) {
    if (typeof source !== "string") return false;
    const normalized = source.trim().toLowerCase();
    return hostKind2 === "ao3" ? normalized === "ao3" || normalized === "archiveofourown.org" || normalized === "archiveofourown.gay" || normalized === "archive.transformativeworks.org" : normalized === "ffn" || normalized === "fanfiction.net";
  }

  // src/extension-runtime/story-command.mts
  var UUID_PATTERN4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var WORK_KEY_PATTERN2 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var REQUEST_TIMEOUT_MS = 12e3;
  function isRecord6(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isIsoTimestamp(value) {
    return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function confirmedStorySave(value, expectedWorkKey) {
    if (!isRecord6(value)) return null;
    const workKey = typeof value.work_key === "string" ? value.work_key.trim() : "";
    const entryId = typeof value.entry_id === "string" ? value.entry_id.trim() : "";
    const entry = copyLibraryOverlayEntry(value.entry);
    if (workKey !== expectedWorkKey || !WORK_KEY_PATTERN2.test(workKey) || !UUID_PATTERN4.test(entryId) || entry === null || entry.entryId !== entryId || !isIsoTimestamp(value.syncVersion)) {
      return null;
    }
    return Object.freeze({
      workKey,
      entryId,
      entry,
      syncVersion: value.syncVersion
    });
  }
  var StoryCommandApi = class {
    #fetch;
    #trackEndpoint;
    #overlayEndpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      const base = apiBase.replace(/\/$/, "");
      this.#trackEndpoint = `${base}/api/extension/track`;
      this.#overlayEndpoint = `${base}/api/extension/library-overlay`;
    }
    async lookup(credential, workKey) {
      const response = await this.#request(this.#overlayEndpoint, credential, {
        method: "GET",
        cache: "no-store"
      });
      if (response === null) return { kind: "success", value: { kind: "unavailable" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (!response.ok) return { kind: "success", value: { kind: "unavailable" } };
      const body = await this.#json(response);
      const data = isRecord6(body) && isRecord6(body.data) ? body.data : null;
      if (data === null || !isRecord6(data.entries) || !isIsoTimestamp(data.syncVersion)) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      const rawEntry = data.entries[workKey];
      if (rawEntry === void 0) return { kind: "success", value: { kind: "absent" } };
      const entry = copyLibraryOverlayEntry(rawEntry);
      const entryId = entry?.entryId;
      if (entry === null || typeof entryId !== "string" || !UUID_PATTERN4.test(entryId)) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      return {
        kind: "success",
        value: {
          kind: "found",
          confirmation: Object.freeze({
            workKey,
            entryId,
            entry,
            syncVersion: data.syncVersion
          })
        }
      };
    }
    async track(credential, command) {
      const response = await this.#request(this.#trackEndpoint, credential, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command.payload)
      });
      if (response === null) return { kind: "success", value: { kind: "uncertain" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (response.status === 400) {
        return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
      }
      if (response.status === 402) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "free_limit_reached" }
        };
      }
      if (response.status === 429) {
        return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
      }
      if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };
      const body = await this.#json(response);
      const confirmation = confirmedStorySave(
        isRecord6(body) ? body.data : null,
        command.workKey
      );
      return confirmation === null ? { kind: "success", value: { kind: "uncertain" } } : { kind: "success", value: { kind: "confirmed", confirmation } };
    }
    async #request(url, credential, init) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await this.#fetch(url, {
          ...init,
          signal: abort.signal,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${credential}`
          }
        });
      } catch {
        return null;
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  var AccountStoryProjectionPort = class {
    #repository;
    constructor(repository) {
      this.#repository = repository;
    }
    async publishConfirmed(scope2, confirmation) {
      try {
        const result = await this.#repository.publishConfirmedStory(scope2, confirmation);
        return result.kind === "published" ? { kind: "published" } : result;
      } catch {
        return { kind: "unavailable" };
      }
    }
  };

  // src/extension-runtime/account-projection.mts
  var REQUEST_TIMEOUT_MS2 = 12e3;
  function isRecord7(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  async function responseJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  var AccountProjectionApi = class {
    #fetch;
    #overlayEndpoint;
    #accountEndpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      const base = apiBase.replace(/\/$/, "");
      this.#overlayEndpoint = `${base}/api/extension/library-overlay`;
      this.#accountEndpoint = `${base}/api/extension/account`;
    }
    async load(credential) {
      const [overlayResult, accountResult] = await Promise.all([
        this.#request(this.#overlayEndpoint, credential),
        this.#request(this.#accountEndpoint, credential)
      ]);
      const responses = [overlayResult, accountResult];
      if (responses.some(
        (result) => result.kind === "response" && (result.response.status === 401 || result.response.status === 403)
      )) {
        return { kind: "auth_rejected" };
      }
      if (responses.every((result) => result.kind === "unavailable")) {
        return { kind: "unavailable" };
      }
      const overlay = await this.#overlayPart(overlayResult);
      const summary = await this.#summaryPart(accountResult);
      return {
        kind: "success",
        value: Object.freeze({ overlay, summary })
      };
    }
    async #overlayPart(result) {
      if (result.kind === "unavailable") return { kind: "unavailable" };
      if (!result.response.ok) {
        return result.response.status === 429 || result.response.status >= 500 ? { kind: "unavailable" } : { kind: "invalid_response" };
      }
      const body = await responseJson(result.response);
      const overlay = copyAccountOverlay(
        isRecord7(body) && isRecord7(body.data) ? body.data : null
      );
      return overlay === null ? { kind: "invalid_response" } : { kind: "value", value: overlay };
    }
    async #summaryPart(result) {
      if (result.kind === "unavailable") return { kind: "unavailable" };
      if (!result.response.ok) {
        return result.response.status === 429 || result.response.status >= 500 ? { kind: "unavailable" } : { kind: "invalid_response" };
      }
      const body = await responseJson(result.response);
      if (!isRecord7(body) || typeof body.account_id !== "string" || !body.account_id.trim()) {
        return { kind: "invalid_response" };
      }
      const libraryCount = body.library_count;
      const summary = copyAccountSummary({
        pro: body.pro,
        libraryCount,
        firstStoryCompleted: typeof body.first_story_completed_at === "string" && body.first_story_completed_at.trim().length > 0 || Number.isSafeInteger(libraryCount) && libraryCount > 0
      });
      return summary === null ? { kind: "invalid_response" } : {
        kind: "value",
        value: Object.freeze({
          accountId: body.account_id.trim(),
          value: summary
        })
      };
    }
    async #request(url, credential) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS2);
      try {
        const response = await this.#fetch(url, {
          method: "GET",
          cache: "no-store",
          headers: { Authorization: `Bearer ${credential}` },
          signal: abort.signal
        });
        return { kind: "response", response };
      } catch {
        return { kind: "unavailable" };
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
  };

  // src/extension-runtime/library-command.mts
  var REQUEST_TIMEOUT_MS3 = 12e3;
  var UUID_PATTERN5 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var WORK_KEY_PATTERN3 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  function isRecord8(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isIsoTimestamp2(value) {
    return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  var LibraryCommandApi = class {
    #fetch;
    #libraryEndpoint;
    #preferenceEndpoint;
    #finishEndpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      const base = apiBase.replace(/\/$/, "");
      this.#libraryEndpoint = `${base}/api/extension/library`;
      this.#preferenceEndpoint = `${base}/api/extension/work-preferences`;
      this.#finishEndpoint = `${base}/api/extension/finish-qualification`;
    }
    async mutate(credential, command) {
      const url = command.kind === "entry_patch" ? `${this.#libraryEndpoint}/${encodeURIComponent(command.entryId)}` : this.#preferenceEndpoint;
      const response = await this.#request(url, credential, {
        method: command.kind === "entry_patch" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          command.kind === "entry_patch" ? command.patch : { key: command.workKey, hidden: command.hidden }
        )
      });
      if (response === null) return { kind: "success", value: { kind: "uncertain" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (response.status === 400 || response.status === 404) {
        return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
      }
      if (response.status === 402) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "free_limit_reached" }
        };
      }
      if (response.status === 429) {
        return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
      }
      if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };
      const body = await this.#json(response);
      const data = isRecord8(body) && isRecord8(body.data) ? body.data : null;
      const confirmed = command.kind === "entry_patch" ? data !== null && typeof data.entry_id === "string" && UUID_PATTERN5.test(data.entry_id) && data.entry_id === command.entryId : data !== null && data.key === command.workKey && isRecord8(data.browsePreference) && data.browsePreference.hidden === command.hidden;
      return {
        kind: "success",
        value: confirmed ? { kind: "accepted" } : { kind: "uncertain" }
      };
    }
    async qualifyFinish(credential, command) {
      const response = await this.#request(this.#finishEndpoint, credential, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          entryId: command.entryId,
          workKey: command.workKey,
          source: command.source,
          chapter: command.chapter,
          total: command.total,
          state: command.state,
          ...command.state === "resolved" ? {
            operationId: command.operationId,
            workStatus: command.workStatus,
            resolutionSource: command.resolutionSource
          } : {}
        })
      });
      if (response === null) return { kind: "success", value: { kind: "uncertain" } };
      if (response.status === 401 || response.status === 403) return { kind: "auth_rejected" };
      if (response.status === 400 || response.status === 404 || response.status === 409) {
        return { kind: "success", value: { kind: "rejected", reason: "invalid_request" } };
      }
      if (response.status === 429) {
        return { kind: "success", value: { kind: "rejected", reason: "rate_limited" } };
      }
      if (response.status === 503) {
        const error = await this.#json(response);
        if (isRecord8(error) && error.code === "EXTENSION_FINISH_QUALIFICATION_DISABLED" && error.retryable === false) {
          return {
            kind: "success",
            value: {
              kind: "rejected",
              reason: "finish_qualification_disabled"
            }
          };
        }
        return { kind: "success", value: { kind: "uncertain" } };
      }
      if (!response.ok) return { kind: "success", value: { kind: "uncertain" } };
      const body = await this.#json(response);
      const data = isRecord8(body) && isRecord8(body.data) ? body.data : null;
      const workKey = data === null ? void 0 : data.workKey;
      const entry = data === null ? null : copyLibraryOverlayEntry(data.entry);
      const syncVersion = data !== null && Object.hasOwn(data, "syncVersion") ? data.syncVersion : void 0;
      const terminalWithoutProjection = (data?.state === "resolved" || data?.state === "ignored") && workKey === null && data.entry === null && syncVersion === null;
      const expectedOperationId = command.state === "resolved" ? command.operationId : null;
      const responseOperationId = data !== null && Object.hasOwn(data, "operationId") ? data.operationId : null;
      if (data === null || data.state !== "ignored" && data.state !== command.state || responseOperationId !== expectedOperationId || data.eventId !== null && (typeof data.eventId !== "string" || !UUID_PATTERN5.test(data.eventId)) || !terminalWithoutProjection && (typeof workKey !== "string" || workKey !== command.workKey || !WORK_KEY_PATTERN3.test(workKey) || entry === null || entry.entryId !== command.entryId || syncVersion !== void 0 && !isIsoTimestamp2(syncVersion))) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      if (terminalWithoutProjection) {
        return {
          kind: "success",
          value: {
            kind: "acknowledged",
            state: data.state,
            eventId: data.eventId,
            operationId: expectedOperationId,
            workKey: null,
            entry: null,
            syncVersion: null
          }
        };
      }
      return {
        kind: "success",
        value: {
          kind: "acknowledged",
          state: data.state,
          eventId: data.eventId,
          operationId: expectedOperationId,
          workKey,
          entry,
          ...typeof syncVersion === "string" ? { syncVersion } : {}
        }
      };
    }
    async #request(url, credential, init) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS3);
      try {
        return await this.#fetch(url, {
          ...init,
          signal: abort.signal,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${credential}`
          }
        });
      } catch {
        return null;
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  function refreshFailure(result) {
    if (result.kind === "not_authenticated") return { kind: "not_authenticated" };
    if (result.kind === "auth_expired") return { kind: "auth_expired" };
    if (result.kind === "stale") return { kind: "stale" };
    if (result.kind === "unavailable") return { kind: "unavailable" };
    if (result.kind === "refreshed" && result.overlay !== "published" && result.overlay !== "stale") {
      return { kind: "unavailable" };
    }
    return null;
  }
  var AccountLibraryCommandProjection = class {
    #projection;
    #repository;
    constructor(projection, repository) {
      this.#projection = projection;
      this.#repository = repository;
    }
    reserveFinishPublication() {
      return this.#repository.reserveOverlayWrite();
    }
    async publishFinishAcknowledgement(scope2, command, acknowledgement, reservation) {
      try {
        const result = acknowledgement.workKey === null || acknowledgement.entry === null ? await this.#repository.removeAuthoritativeStory(scope2, {
          workKey: command.workKey,
          entryId: command.entryId
        }, reservation) : await this.#repository.publishAuthoritativeStory(scope2, {
          workKey: acknowledgement.workKey,
          entryId: acknowledgement.entry.entryId ?? "",
          entry: acknowledgement.entry,
          ...acknowledgement.syncVersion === void 0 ? {} : { syncVersion: acknowledgement.syncVersion }
        }, reservation);
        return result.kind === "published" ? { kind: "published" } : result;
      } catch {
        return { kind: "unavailable" };
      }
    }
    async refreshAndRead() {
      const refreshed = await this.#projection.refreshIfNeeded(true);
      const failure4 = refreshFailure(refreshed);
      if (failure4 !== null) return failure4;
      const value = await this.#projection.read({ refresh: false });
      return value === null ? { kind: "unavailable" } : { kind: "value", value };
    }
  };

  // src/extension-runtime/library-command-sender.mts
  var UUID_PATTERN6 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var WORK_KEY_PATTERN4 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var MAX_COMMAND_BYTES = 8 * 1024;
  var MAX_CHAPTER = 1e7;
  function isRecord9(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function cloneBoundedRecord(value) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return null;
    }
    if (!serialized || serialized.length > MAX_COMMAND_BYTES) return null;
    try {
      const parsed = JSON.parse(serialized);
      return isRecord9(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  function canonicalStatus(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toUpperCase();
    if (normalized === "PLANNING") return "SAVED";
    if (normalized === "COMPLETED") return "FINISHED";
    return normalized === "SAVED" || normalized === "READING" || normalized === "CAUGHT_UP" || normalized === "PAUSED" || normalized === "FINISHED" || normalized === "DROPPED" ? normalized : null;
  }
  function chapterProgress(value) {
    if (!isRecord9(value) || value.unit !== "CHAPTER") return null;
    if (!Number.isSafeInteger(value.value) || value.value < 0 || value.value > MAX_CHAPTER) {
      return null;
    }
    if (value.total !== null && value.total !== void 0 && (!Number.isSafeInteger(value.total) || value.total < 0 || value.total > MAX_CHAPTER)) {
      return null;
    }
    return Object.freeze({
      unit: "CHAPTER",
      value: value.value,
      total: value.total === void 0 ? null : value.total
    });
  }
  function libraryPatch(value) {
    if (!isRecord9(value)) return null;
    const patch = {};
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
      if (!Number.isSafeInteger(value.rating) || value.rating < 0 || value.rating > 5) {
        return null;
      }
      patch.rating = value.rating;
    }
    if (Object.hasOwn(value, "story_snapshot")) {
      if (!isRecord9(value.story_snapshot)) return null;
      const keys = Object.keys(value.story_snapshot);
      if (keys.length !== 1 || keys[0] !== "work_status_override") return null;
      const override = value.story_snapshot.work_status_override;
      if (override !== null && override !== "wip" && override !== "complete" && override !== "hiatus" && override !== "abandoned") {
        return null;
      }
      patch.story_snapshot = Object.freeze({ work_status_override: override });
    }
    return Object.keys(patch).length === 0 ? null : Object.freeze(patch);
  }
  function senderCommandScope(sender, claimedWorkKey) {
    const hostKind2 = archiveHostKindFromSender(sender);
    if (hostKind2 === null) return null;
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, hostKind2)) return null;
    const workKey = typeof claimedWorkKey === "string" ? claimedWorkKey.trim().toLowerCase() : "";
    if (!WORK_KEY_PATTERN4.test(workKey) || !workKey.startsWith(`${hostKind2}:`)) {
      return null;
    }
    const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind2);
    if (senderWorkKey !== null && senderWorkKey !== workKey) return null;
    return Object.freeze({ hostKind: hostKind2, workKey });
  }
  function libraryMutationCommandFromMessage(message, sender) {
    if (!isRecord9(message) || typeof message.type !== "string") return null;
    const payload = cloneBoundedRecord(message.payload);
    if (payload === null) return null;
    const claimedWorkKey = message.type === "TRACE_SET_HIDDEN_WORK" ? payload.key : payload.workKey;
    const scope2 = senderCommandScope(sender, claimedWorkKey);
    if (scope2 === null) return null;
    if (message.type === "TRACE_SET_HIDDEN_WORK") {
      if (typeof payload.hidden !== "boolean") return null;
      return Object.freeze({
        kind: "work_preference",
        ...scope2,
        hidden: payload.hidden
      });
    }
    const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
    if (!UUID_PATTERN6.test(entryId)) return null;
    if (message.type === "TRACE_SET_READER_STATUS") {
      const status = canonicalStatus(payload.status);
      if (status === null) return null;
      let progress;
      if (Object.hasOwn(payload, "progress")) {
        const parsed = chapterProgress(payload.progress);
        if (parsed === null) return null;
        progress = parsed;
      }
      return Object.freeze({
        kind: "entry_patch",
        ...scope2,
        entryId,
        patch: Object.freeze({
          status,
          ...progress === void 0 ? {} : { progress }
        })
      });
    }
    if (message.type !== "TRACE_PATCH_LIBRARY_ENTRY") return null;
    const patch = libraryPatch(payload.patch);
    if (patch === null) return null;
    return Object.freeze({
      kind: "entry_patch",
      ...scope2,
      entryId,
      patch
    });
  }
  function finishQualificationCommandFromMessage(message, sender) {
    if (!isRecord9(message) || message.type !== "TRACE_FINISH_QUALIFICATION_SIGNAL") {
      return null;
    }
    const payload = cloneBoundedRecord(message.payload);
    if (payload === null) return null;
    const scope2 = senderCommandScope(sender, payload.workKey);
    if (scope2 === null || payload.source !== scope2.hostKind) return null;
    const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
    if (!UUID_PATTERN6.test(entryId)) return null;
    if (!Number.isSafeInteger(payload.chapter) || payload.chapter < 1 || payload.chapter > MAX_CHAPTER || !Number.isSafeInteger(payload.total) || payload.total < 1 || payload.total > MAX_CHAPTER || payload.chapter !== payload.total) {
      return null;
    }
    if (payload.state !== "open" && payload.state !== "resolved") return null;
    const commandBase = {
      kind: "finish_qualification",
      ...scope2,
      entryId,
      source: scope2.hostKind,
      chapter: payload.chapter,
      total: payload.total
    };
    if (payload.state === "open") {
      if (Object.hasOwn(payload, "workStatus") || Object.hasOwn(payload, "readerStatus") || Object.hasOwn(payload, "resolutionSource")) {
        return null;
      }
      return Object.freeze({ ...commandBase, state: "open" });
    }
    if (payload.workStatus !== "complete" && payload.workStatus !== "wip" && payload.workStatus !== "hiatus" && payload.workStatus !== "abandoned") {
      return null;
    }
    if (payload.readerStatus !== void 0 && canonicalStatus(payload.readerStatus) === null) return null;
    if (payload.resolutionSource !== void 0 && payload.resolutionSource !== "source" && payload.resolutionSource !== "reader") {
      return null;
    }
    if (payload.resolutionSource === "source" && payload.workStatus === "abandoned") {
      return null;
    }
    return Object.freeze({
      ...commandBase,
      state: "resolved",
      workStatus: payload.workStatus,
      resolutionSource: payload.resolutionSource ?? "reader"
    });
  }

  // src/extension-runtime/first-story-initiation.mts
  var MAX_IMPORT_PAYLOAD_BYTES = 512 * 1024;
  var MAX_IMPORT_ITEMS = 250;
  var MAX_FIRST_STORY_URL_LENGTH = 4096;
  var FIRST_STORY_FOCUS_RETRY_ATTEMPTS = 24;
  var FIRST_STORY_FOCUS_RETRY_MS = 250;
  var HANDOFF_NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  var SUCCESS_STATES = Object.freeze(["saved", "already_saved"]);
  function isRecord10(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isAo3Host(host) {
    return host === "archiveofourown.org" || host.endsWith(".archiveofourown.org") || host === "archiveofourown.gay" || host.endsWith(".archiveofourown.gay") || host === "archive.transformativeworks.org" || host === "ao3.org" || host.endsWith(".ao3.org");
  }
  function isFfnHost(host) {
    return host === "www.fanfiction.net" || host === "m.fanfiction.net";
  }
  function isTopFrame(sender) {
    return sender !== void 0 && (sender.frameId === void 0 || sender.frameId === 0) && (sender.documentLifecycle === void 0 || sender.documentLifecycle === "active");
  }
  function classifyActiveTabUrl(rawUrl, webOrigin) {
    if (typeof rawUrl !== "string") return Object.freeze({ kind: "unknown" });
    try {
      const url = new URL(rawUrl);
      if (url.origin === new URL(webOrigin).origin) return Object.freeze({ kind: "trace" });
      const host = url.hostname.toLowerCase();
      if (isAo3Host(host)) {
        if (/^\/users\/(?:login|sign_up|password|auth\/|logout)/i.test(url.pathname)) {
          return Object.freeze({ kind: "blocked_archive", site: "ao3", canImport: false });
        }
        return Object.freeze({
          kind: /^\/works\/\d+(?:\/chapters\/\d+)?\/?$/i.test(url.pathname) ? "supported_story" : "supported_archive",
          site: "ao3",
          canImport: true
        });
      }
      if (isFfnHost(host)) {
        if (/^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(url.pathname)) {
          return Object.freeze({ kind: "blocked_archive", site: "ffn", canImport: false });
        }
        return Object.freeze({
          kind: /^\/s\/[1-9][0-9]{0,19}(?:\/|$)/i.test(url.pathname) ? "supported_story" : "supported_archive",
          site: "ffn",
          canImport: true
        });
      }
      return Object.freeze({ kind: "unsupported" });
    } catch {
      return Object.freeze({ kind: "unsupported" });
    }
  }
  function normalizeFirstStoryUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > MAX_FIRST_STORY_URL_LENGTH) {
      return null;
    }
    try {
      const url = new URL(rawUrl.trim());
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const host = url.hostname.toLowerCase();
      if (isAo3Host(host) && /^\/works\/[1-9][0-9]{0,19}(?:\/chapters\/[1-9][0-9]{0,19})?\/?$/i.test(
        url.pathname
      )) {
        return url.href;
      }
      if (isFfnHost(host) && /^\/s\/[1-9][0-9]{0,19}(?:\/[1-9][0-9]{0,9})?(?:\/|$)/i.test(url.pathname)) {
        return url.href;
      }
    } catch {
      return null;
    }
    return null;
  }
  function isPopupSender(sender, runtimeId) {
    if (runtimeId !== void 0 && sender?.id !== runtimeId) return false;
    if (typeof sender?.url !== "string") {
      return (sender?.tab === void 0 || sender.tab === null) && runtimeId !== void 0 && sender?.id === runtimeId;
    }
    try {
      const url = new URL(sender.url);
      return ["chrome-extension:", "moz-extension:", "safari-web-extension:"].includes(url.protocol) && url.pathname === "/popup.html";
    } catch {
      return false;
    }
  }
  function isTraceWebSender(sender, runtimeId, webOrigin) {
    if (!isTopFrame(sender)) return false;
    if (runtimeId !== void 0 && sender?.id !== runtimeId) return false;
    const rawUrl = sender?.url ?? sender?.tab?.url;
    if (typeof rawUrl !== "string") return false;
    try {
      return new URL(rawUrl).origin === new URL(webOrigin).origin;
    } catch {
      return false;
    }
  }
  function firstStoryInitiationFromMessage(message, sender, runtimeId, webOrigin) {
    if (!isRecord10(message) || typeof message.type !== "string") return null;
    if (message.type === "TRACE_IMPORT_TRIGGER") {
      return isPopupSender(sender, runtimeId) ? Object.freeze({ kind: "popup_import" }) : null;
    }
    if (message.type !== "TRACE_FIRST_STORY_ADD") return null;
    if (!isTraceWebSender(sender, runtimeId, webOrigin)) return null;
    const nonce = typeof message.nonce === "string" ? message.nonce.trim() : "";
    if (!HANDOFF_NONCE_PATTERN.test(nonce)) return null;
    const url = normalizeFirstStoryUrl(message.url);
    if (url === null) return Object.freeze({ kind: "invalid", error: "invalid_url" });
    return Object.freeze({ kind: "web_save", nonce, url });
  }
  function isMissingReceiverError(error) {
    const value = [
      typeof error === "string" ? error : "",
      isRecord10(error) && typeof error.message === "string" ? error.message : "",
      String(error ?? "")
    ].join("\n");
    return /receiving end does not exist|could not establish connection|message port closed/i.test(
      value
    );
  }
  function sourceMatchesSite(value, site) {
    if (typeof value !== "string") return false;
    const source = value.trim().toLowerCase();
    return site === "ao3" ? source === "ao3" || source === "archiveofourown.org" || source === "archiveofourown.gay" || source === "archive.transformativeworks.org" : source === "ffn" || source === "fanfiction.net";
  }
  function boundedImportPayload(response, site) {
    if (!isRecord10(response) || response.ok !== true || !isRecord10(response.payload)) {
      return null;
    }
    if (!sourceMatchesSite(response.payload.s, site)) return null;
    if (typeof response.payload.at !== "string" || !response.payload.at || response.payload.at.length > 128) {
      return null;
    }
    if (!Array.isArray(response.payload.items) || response.payload.items.length === 0 || response.payload.items.length > MAX_IMPORT_ITEMS || !response.payload.items.every((item) => isRecord10(item) && sourceMatchesSite(item.src, site) && normalizeFirstStoryUrl(item.u) !== null)) {
      return null;
    }
    let serialized;
    try {
      serialized = JSON.stringify(response.payload);
    } catch {
      return null;
    }
    if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_PAYLOAD_BYTES) {
      return null;
    }
    try {
      const parsed = JSON.parse(serialized);
      return isRecord10(parsed) ? Object.freeze(parsed) : null;
    } catch {
      return null;
    }
  }
  function encodeImportPayload(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function responseError(response) {
    if (!isRecord10(response) || typeof response.error !== "string") return "save_failed";
    if (response.error === "not_authenticated" || response.error === "free_limit_reached" || response.error === "auth_expired" || response.error === "rate_limited") {
      return response.error;
    }
    if (response.error === "page_contains_password_field") return "unsupported_page";
    return "save_failed";
  }
  var BrowserFirstStoryInitiator = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #delay;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      this.#webOrigin = new URL(options.webOrigin).origin;
      this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)));
    }
    async importActivePage() {
      let tabs;
      try {
        tabs = await this.#call("query", [{
          active: true,
          currentWindow: true
        }]);
      } catch {
        return Object.freeze({ ok: false, error: "unavailable" });
      }
      const tab = tabs[0];
      if (typeof tab?.id !== "number") {
        return Object.freeze({ ok: false, error: "no_active_tab" });
      }
      const context = classifyActiveTabUrl(tab.url, this.#webOrigin);
      if (context.kind !== "supported_story" && context.kind !== "supported_archive") {
        return Object.freeze({ ok: false, error: "unsupported_page" });
      }
      let response;
      try {
        response = await this.#call("sendMessage", [tab.id, { type: "TRACE_COLLECT" }]);
      } catch (error) {
        return Object.freeze({
          ok: false,
          error: isMissingReceiverError(error) ? "permission_required" : "collect_failed"
        });
      }
      const payload = boundedImportPayload(response, context.site);
      if (payload === null) {
        const error = isRecord10(response) && response.error === "page_contains_password_field" ? "unsupported_page" : "collect_failed";
        return Object.freeze({ ok: false, error });
      }
      const importUrl = `${this.#webOrigin}/import#U${encodeURIComponent(
        encodeImportPayload(payload)
      )}`;
      try {
        await this.#call("create", [{ url: importUrl }]);
        return Object.freeze({ ok: true, state: "opened" });
      } catch {
        return Object.freeze({ ok: false, error: "open_failed" });
      }
    }
    async saveFromTrace(url) {
      const normalized = normalizeFirstStoryUrl(url);
      if (normalized === null) return Object.freeze({ ok: false, error: "invalid_url" });
      let tab;
      try {
        tab = await this.#call("create", [{ url: normalized, active: true }]);
      } catch {
        return Object.freeze({ ok: false, error: "open_failed" });
      }
      if (typeof tab?.id !== "number") {
        return Object.freeze({ ok: false, error: "open_failed" });
      }
      for (let attempt = 0; attempt <= FIRST_STORY_FOCUS_RETRY_ATTEMPTS; attempt += 1) {
        try {
          const response = await this.#call("sendMessage", [
            tab.id,
            { type: "TRACE_FIRST_STORY_FOCUS_ADD" }
          ]);
          if (isRecord10(response) && response.ok === true) {
            const state = SUCCESS_STATES.find((candidate) => candidate === response.state);
            return state === void 0 ? Object.freeze({ ok: false, error: "save_failed" }) : Object.freeze({ ok: true, state });
          }
          return Object.freeze({ ok: false, error: responseError(response) });
        } catch (error) {
          if (!isMissingReceiverError(error)) {
            return Object.freeze({ ok: false, error: "save_failed" });
          }
          if (attempt === FIRST_STORY_FOCUS_RETRY_ATTEMPTS) {
            return Object.freeze({ ok: false, error: "permission_required" });
          }
          await this.#delay(FIRST_STORY_FOCUS_RETRY_MS);
        }
      }
      return Object.freeze({ ok: false, error: "save_failed" });
    }
    #call(method, args) {
      return extensionCall(
        this.#tabs,
        method,
        args,
        this.#runtime,
        this.#mode
      );
    }
  };

  // src/extension-runtime/metadata-contribution.mts
  var REQUEST_TIMEOUT_MS4 = 12e3;
  var METADATA_PREFERENCE_KEY = "prefMetadataImproveEnabled";
  function isRecord11(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function validCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }
  var MetadataContributionApi = class {
    #fetch;
    #storyEndpoint;
    #libraryEndpoint;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      const base = apiBase.replace(/\/$/, "");
      this.#storyEndpoint = `${base}/api/extension/metadata`;
      this.#libraryEndpoint = `${base}/api/extension/library/metadata-refresh`;
    }
    async contribute(credential, command) {
      const response = await this.#request(
        command.kind === "story_metadata" ? this.#storyEndpoint : this.#libraryEndpoint,
        credential,
        command.payload
      );
      if (response === null) {
        return { kind: "success", value: { kind: "unavailable" } };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_rejected" };
      }
      if (response.status === 400) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "invalid_request" }
        };
      }
      if (response.status === 429) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "rate_limited" }
        };
      }
      if (!response.ok) {
        return { kind: "success", value: { kind: "unavailable" } };
      }
      const body = await this.#json(response);
      const data = isRecord11(body) && body.success === true && isRecord11(body.data) ? body.data : null;
      if (data === null) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      if (command.kind === "story_metadata") {
        return Number.isSafeInteger(data.story_id) && data.story_id > 0 ? { kind: "success", value: { kind: "accepted", updated: true } } : { kind: "success", value: { kind: "invalid_response" } };
      }
      return validCount(data.updated) && validCount(data.ignored) ? {
        kind: "success",
        value: { kind: "accepted", updated: data.updated > 0 }
      } : { kind: "success", value: { kind: "invalid_response" } };
    }
    async #request(url, credential, payload) {
      const abort = new AbortController();
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS4);
      try {
        return await this.#fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential}`
          },
          body: JSON.stringify(payload),
          signal: abort.signal
        });
      } catch {
        return null;
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  var BrowserMetadataPreferencePort = class {
    #storage;
    constructor(storage) {
      this.#storage = storage;
    }
    async enabled() {
      const value = await this.#storage.get(METADATA_PREFERENCE_KEY);
      return value[METADATA_PREFERENCE_KEY] !== false;
    }
  };
  var TraceWebMetadataNotificationPort = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #queryPattern;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      const webUrl = new URL(options.webOrigin);
      this.#webOrigin = webUrl.origin;
      this.#queryPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
    }
    async publish() {
      let tabs;
      try {
        tabs = await extensionCall(
          this.#tabs,
          "query",
          [{ url: [this.#queryPattern] }],
          this.#runtime,
          this.#mode
        );
      } catch {
        return false;
      }
      const message = Object.freeze({
        type: "TRACE_LIBRARY_INVALIDATED",
        reason: "metadata",
        at: (/* @__PURE__ */ new Date()).toISOString()
      });
      for (const tab of tabs) {
        if (typeof tab.id !== "number" || !this.#isTraceWebUrl(tab.url)) continue;
        try {
          await extensionCall(
            this.#tabs,
            "sendMessage",
            [tab.id, message],
            this.#runtime,
            this.#mode
          );
        } catch {
        }
      }
      return true;
    }
    #isTraceWebUrl(rawUrl) {
      if (typeof rawUrl !== "string") return false;
      try {
        return new URL(rawUrl).origin === this.#webOrigin;
      } catch {
        return false;
      }
    }
  };

  // src/extension-runtime/metadata-contribution-sender.mts
  var MAX_STORY_METADATA_BYTES = 64 * 1024;
  var MAX_LIBRARY_REFRESH_BYTES = 512 * 1024;
  var MAX_LIBRARY_REFRESH_ITEMS = 100;
  var MAX_METADATA_ARRAY_ITEMS = 200;
  var MAX_METADATA_INTEGER = 1e8;
  var SOURCE_STORY_ID_PATTERN = /^[1-9][0-9]{0,39}$/;
  var LIBRARY_REFRESH_FIELDS = /* @__PURE__ */ new Set([
    "source",
    "sourceStoryId",
    "url",
    "title",
    "author",
    "summary",
    "chapters",
    "chaptersPublished",
    "chaptersPlanned",
    "words",
    "status",
    "updatedAt",
    "publishedAt",
    "rating",
    "language",
    "fandoms",
    "characters",
    "relationships",
    "genre"
  ]);
  var STRING_LIMITS = Object.freeze({
    title: 300,
    author: 120,
    summary: 2e4,
    status: 60,
    updatedAt: 50,
    publishedAt: 50,
    rating: 60,
    language: 60,
    genre: 100
  });
  var INTEGER_FIELDS = Object.freeze([
    "chapters",
    "chaptersPublished",
    "chaptersPlanned",
    "words"
  ]);
  var ARRAY_FIELDS = Object.freeze([
    "fandoms",
    "characters",
    "relationships"
  ]);
  function isRecord12(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function cloneBoundedRecord2(value, maxBytes) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return null;
    }
    if (!serialized || new TextEncoder().encode(serialized).byteLength > maxBytes) {
      return null;
    }
    try {
      const parsed = JSON.parse(serialized);
      return isRecord12(parsed) ? Object.freeze(parsed) : null;
    } catch {
      return null;
    }
  }
  function validOptionalString(value, maxLength) {
    return value === void 0 || value === null || typeof value === "string" && value.length <= maxLength;
  }
  function validOptionalInteger(value) {
    return value === void 0 || value === null || Number.isSafeInteger(value) && value >= 0 && value <= MAX_METADATA_INTEGER;
  }
  function validOptionalStringArray(value) {
    return value === void 0 || Array.isArray(value) && value.length <= MAX_METADATA_ARRAY_ITEMS && value.every(
      (item) => item === null || typeof item === "string" && item.length <= 255
    );
  }
  function refreshItemWorkKey(item, hostKind2) {
    if (item.source !== hostKind2 || Object.keys(item).some((key) => !LIBRARY_REFRESH_FIELDS.has(key))) {
      return null;
    }
    const rawId = typeof item.sourceStoryId === "string" ? item.sourceStoryId.trim() : "";
    if (rawId && !SOURCE_STORY_ID_PATTERN.test(rawId)) return null;
    const urlWorkKey = item.url === void 0 ? null : workKeyFromArchiveUrl(item.url, hostKind2);
    if (item.url !== void 0 && urlWorkKey === null) return null;
    const idWorkKey = rawId ? `${hostKind2}:${rawId}` : null;
    if (urlWorkKey !== null && idWorkKey !== null && urlWorkKey !== idWorkKey) {
      return null;
    }
    const workKey = urlWorkKey ?? idWorkKey;
    if (workKey === null) return null;
    for (const [field, maxLength] of Object.entries(STRING_LIMITS)) {
      if (!validOptionalString(item[field], maxLength)) return null;
    }
    for (const field of INTEGER_FIELDS) {
      if (!validOptionalInteger(item[field])) return null;
    }
    for (const field of ARRAY_FIELDS) {
      if (!validOptionalStringArray(item[field])) return null;
    }
    return workKey;
  }
  function storyMetadataCommand(message, hostKind2, senderUrl) {
    const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind2);
    if (senderWorkKey === null) return null;
    const payload = cloneBoundedRecord2(message.payload, MAX_STORY_METADATA_BYTES);
    if (payload === null || !sourceMatchesArchiveHost(payload.s, hostKind2) || typeof payload.at !== "string" || payload.at.length === 0 || payload.at.length > 500 || !isRecord12(payload.item) || payload.item.ctx !== "story" || typeof payload.item.t !== "string" || payload.item.t.trim().length === 0 || payload.item.t.length > 300 || !sourceMatchesArchiveHost(payload.item.src, hostKind2) || workKeyFromArchiveUrl(payload.item.u, hostKind2) !== senderWorkKey) {
      return null;
    }
    return Object.freeze({
      kind: "story_metadata",
      hostKind: hostKind2,
      workKeys: Object.freeze([senderWorkKey]),
      payload
    });
  }
  function libraryMetadataRefreshCommand(message, hostKind2, senderUrl) {
    if (workKeyFromArchiveUrl(senderUrl, hostKind2) !== null) return null;
    const payload = cloneBoundedRecord2(message.payload, MAX_LIBRARY_REFRESH_BYTES);
    if (payload === null || Object.keys(payload).length !== 1 || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > MAX_LIBRARY_REFRESH_ITEMS) {
      return null;
    }
    const workKeys = [];
    const seen = /* @__PURE__ */ new Set();
    for (const item of payload.items) {
      if (!isRecord12(item)) return null;
      const workKey = refreshItemWorkKey(item, hostKind2);
      if (workKey === null) return null;
      if (!seen.has(workKey)) {
        seen.add(workKey);
        workKeys.push(workKey);
      }
    }
    return Object.freeze({
      kind: "library_metadata_refresh",
      hostKind: hostKind2,
      workKeys: Object.freeze(workKeys),
      payload
    });
  }
  function metadataContributionCommandFromMessage(message, sender) {
    if (!isRecord12(message)) return null;
    const hostKind2 = archiveHostKindFromSender(sender);
    if (hostKind2 === null) return null;
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, hostKind2)) return null;
    if (message.type === "TRACE_METADATA_BROADCAST") {
      return storyMetadataCommand(message, hostKind2, senderUrl);
    }
    if (message.type === "TRACE_LIBRARY_METADATA_REFRESH") {
      return libraryMetadataRefreshCommand(message, hostKind2, senderUrl);
    }
    return null;
  }

  // src/extension-runtime/saved-filter-sync.mts
  var REQUEST_TIMEOUT_MS5 = 12e3;
  var SAVED_FILTER_STORAGE_KEYS = SAVED_FILTER_LOCAL_KEYS;
  function isRecord13(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys3(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
  }
  var SavedFilterSyncApi = class {
    #fetch;
    #endpoint;
    #activeAbort = null;
    constructor(fetchImpl, apiBase) {
      this.#fetch = fetchImpl;
      this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/ao3-saved-filters/sync`;
    }
    async sync(credential, request) {
      const abort = new AbortController();
      this.#activeAbort = abort;
      const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS5);
      let response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential}`
          },
          body: JSON.stringify(request),
          signal: abort.signal
        });
      } catch {
        return { kind: "success", value: { kind: "unavailable" } };
      } finally {
        globalThis.clearTimeout(timer);
        if (this.#activeAbort === abort) this.#activeAbort = null;
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_rejected" };
      }
      if (response.status === 400) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "invalid_request" }
        };
      }
      if (response.status === 429) {
        return {
          kind: "success",
          value: { kind: "rejected", reason: "rate_limited" }
        };
      }
      if (response.status === 422) {
        const body2 = await this.#json(response);
        if (isRecord13(body2) && body2.code === "AO3_SAVED_FILTER_LIMIT_REACHED" && Number.isSafeInteger(body2.limit) && body2.limit > 0 && body2.limit <= 250) {
          return {
            kind: "success",
            value: {
              kind: "rejected",
              reason: "limit_reached",
              limit: body2.limit
            }
          };
        }
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      if (!response.ok) {
        return { kind: "success", value: { kind: "unavailable" } };
      }
      const body = await this.#json(response);
      if (!isRecord13(body) || !hasOnlyKeys3(body, ["success", "data"]) || body.success !== true) {
        return { kind: "success", value: { kind: "invalid_response" } };
      }
      const data = parseSavedFilterSyncData(body.data);
      return data === null ? { kind: "success", value: { kind: "invalid_response" } } : { kind: "success", value: { kind: "accepted", data } };
    }
    cancelPending() {
      this.#activeAbort?.abort();
    }
    async #json(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  var BrowserSavedFilterRepository = class {
    #storage;
    #session;
    #randomId;
    #tail = Promise.resolve();
    constructor(options) {
      this.#storage = options.storage;
      this.#session = options.session;
      this.#randomId = options.randomId;
    }
    read() {
      return this.#withLock(async () => {
        const snapshot = await this.#readUnlocked();
        if (snapshot.clientId !== null) return snapshot;
        const generated = `device:${this.#randomId()}`.slice(0, 80);
        const clientId = /^[A-Za-z0-9._:-]{1,80}$/.test(generated) ? generated : null;
        if (clientId === null) return null;
        await this.#storage.set({ [SAVED_FILTER_STORAGE_KEYS.clientId]: clientId });
        return Object.freeze({ ...snapshot, clientId });
      });
    }
    merge(requestedScope, data, sentDeleteClientIds, syncedAt) {
      return this.#withLock(async () => {
        if (!canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
          return { kind: "stale" };
        }
        let current;
        try {
          current = await this.#readUnlocked();
        } catch {
          return { kind: "unavailable" };
        }
        if (current.clientId === null || !canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
          return { kind: "stale" };
        }
        const next = mergeSavedFilterSyncData(
          current,
          data,
          sentDeleteClientIds,
          syncedAt
        );
        if (!canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
          return { kind: "stale" };
        }
        try {
          await this.#storage.set({
            [SAVED_FILTER_STORAGE_KEYS.presets]: next.presets,
            [SAVED_FILTER_STORAGE_KEYS.deleted]: next.deleted,
            [SAVED_FILTER_STORAGE_KEYS.activeMeta]: next.activeMeta,
            [SAVED_FILTER_STORAGE_KEYS.syncMeta]: {
              syncVersion: next.syncVersion,
              lastSyncedAt: next.lastSyncedAt
            },
            [SAVED_FILTER_STORAGE_KEYS.clientId]: next.clientId
          });
        } catch {
          return { kind: "unavailable" };
        }
        return canSyncSavedFilters(this.#session.publicationScope(), requestedScope) ? { kind: "published", snapshot: next } : { kind: "stale" };
      });
    }
    async #readUnlocked() {
      const raw = await this.#storage.get(Object.values(SAVED_FILTER_STORAGE_KEYS));
      const rawSyncMeta = raw[SAVED_FILTER_STORAGE_KEYS.syncMeta];
      const syncMeta = isRecord13(rawSyncMeta) ? rawSyncMeta : {};
      return normalizeSavedFilterSnapshot({
        presets: raw[SAVED_FILTER_STORAGE_KEYS.presets],
        deleted: raw[SAVED_FILTER_STORAGE_KEYS.deleted],
        activeMeta: raw[SAVED_FILTER_STORAGE_KEYS.activeMeta],
        syncVersion: syncMeta.syncVersion,
        lastSyncedAt: syncMeta.lastSyncedAt,
        clientId: raw[SAVED_FILTER_STORAGE_KEYS.clientId]
      }, (/* @__PURE__ */ new Date()).toISOString());
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
  var SavedFilterSyncAlarm = class _SavedFilterSyncAlarm {
    static name = SAVED_FILTER_SYNC_ALARM;
    static install(alarms, runtime, onAlarm) {
      alarms.onAlarm?.addListener((alarm) => {
        if (alarm?.name === _SavedFilterSyncAlarm.name) onAlarm();
      });
      try {
        const result = alarms.create?.(
          _SavedFilterSyncAlarm.name,
          { periodInMinutes: 30 }
        );
        if (result && typeof result.then === "function") {
          void Promise.resolve(result).catch(() => void 0);
        }
      } catch {
        void runtime.lastError;
      }
    }
  };

  // src/extension-runtime/saved-filter-sync-sender.mts
  var SAVED_FILTER_SYNC_MESSAGE = "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST";
  function isRecord14(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSavedFilterSyncRequest(message, sender) {
    if (!isRecord14(message) || Object.keys(message).length !== 1 || message.type !== SAVED_FILTER_SYNC_MESSAGE || archiveHostKindFromSender(sender) !== "ao3") {
      return false;
    }
    const senderUrl = sender?.tab?.url ?? sender?.url;
    return !isBlockedArchivePath(senderUrl, "ao3");
  }

  // src/extension-runtime/story-command-sender.mts
  var MAX_TRACK_PAYLOAD_BYTES = 64 * 1024;
  var HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  var COMMAND_TYPES = Object.freeze({
    connectAndSave: "TRACE_CONNECT_AND_SAVE",
    quickAdd: "TRACE_QUICK_ADD",
    autoTrack: "TRACE_AUTO_TRACK"
  });
  function isRecord15(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function progressTarget(item) {
    if (!Number.isSafeInteger(item.chn) || item.chn < 1) return null;
    const chapter = item.chn;
    const rawTotal = Number.isSafeInteger(item.cht) && item.cht > 0 ? item.cht : Number.isSafeInteger(item.chPub) && item.chPub > 0 ? item.chPub : null;
    return Object.freeze({
      current: chapter > 1 ? chapter : 0,
      total: rawTotal
    });
  }
  function cloneBoundedPayload(value) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return null;
    }
    if (!serialized || serialized.length > MAX_TRACK_PAYLOAD_BYTES) return null;
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return null;
    }
    return isRecord15(parsed) ? Object.freeze(parsed) : null;
  }
  function storyTrackCommandFromMessage(message, sender) {
    if (!isRecord15(message)) return null;
    const hostKind2 = archiveHostKindFromSender(sender);
    if (hostKind2 === null) return null;
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, hostKind2)) return null;
    const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind2);
    const payload = cloneBoundedPayload(message.payload);
    if (payload === null || !sourceMatchesArchiveHost(payload.s, hostKind2)) return null;
    if (typeof payload.at !== "string" || payload.at.length === 0 || payload.at.length > 128) {
      return null;
    }
    if (!isRecord15(payload.item)) return null;
    if (!sourceMatchesArchiveHost(payload.item.src, hostKind2)) return null;
    const payloadWorkKey = workKeyFromArchiveUrl(payload.item.u, hostKind2);
    if (payloadWorkKey === null) return null;
    const messageType = typeof message.type === "string" ? message.type : "";
    const context = payload.item.ctx;
    let intent;
    let progress;
    if (messageType === COMMAND_TYPES.autoTrack) {
      if (context !== "story" || senderWorkKey === null || payloadWorkKey !== senderWorkKey) {
        return null;
      }
      const target = progressTarget(payload.item);
      if (target === null) return null;
      intent = "record_progress";
      progress = target;
    } else if (messageType === COMMAND_TYPES.connectAndSave) {
      if (context !== "story" || senderWorkKey === null || payloadWorkKey !== senderWorkKey) {
        return null;
      }
      intent = "ensure_saved";
    } else if (messageType === COMMAND_TYPES.quickAdd) {
      if (context !== "story" && context !== "listing" && context !== "bookmark") return null;
      if (senderWorkKey !== null && (context !== "story" || payloadWorkKey !== senderWorkKey)) {
        return null;
      }
      if (senderWorkKey === null && context === "story") return null;
      intent = "ensure_saved";
    } else {
      return null;
    }
    const claimedWorkKey = typeof message.workKey === "string" ? message.workKey.trim() : "";
    if (claimedWorkKey && claimedWorkKey !== payloadWorkKey) return null;
    const rawHandoffId = typeof message.handoffId === "string" ? message.handoffId.trim() : "";
    const handoffId = messageType === COMMAND_TYPES.connectAndSave && HANDOFF_ID_PATTERN.test(rawHandoffId) ? rawHandoffId : void 0;
    return Object.freeze({
      intent,
      hostKind: hostKind2,
      workKey: payloadWorkKey,
      payload,
      ...progress === void 0 ? {} : { progress },
      ...handoffId === void 0 ? {} : { handoffId }
    });
  }

  // src/extension-runtime/trace-web-navigation.mts
  var TRACE_WEB_OPEN_MESSAGE = "TRACE_OPEN_TRACE_URL";
  var MAX_TRACE_WEB_URL_LENGTH = 2048;
  var FIRST_INSTALL_ACTIVATION_PATH = "/?activation=extension-installed";
  function isRecord16(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function traceWebNavigationRequestFromMessage(message, sender, webOrigin) {
    if (!isRecord16(message) || Object.keys(message).length !== 2 || message.type !== TRACE_WEB_OPEN_MESSAGE || !isRecord16(message.payload) || Object.keys(message.payload).length !== 1) {
      return null;
    }
    const hostKind2 = archiveHostKindFromSender(sender);
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (hostKind2 === null || isBlockedArchivePath(senderUrl, hostKind2)) return null;
    const rawUrl = message.payload.url;
    if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_TRACE_WEB_URL_LENGTH) {
      return Object.freeze({ kind: "invalid" });
    }
    try {
      const configuredOrigin = new URL(webOrigin).origin;
      const url = new URL(rawUrl, configuredOrigin);
      if (url.origin !== configuredOrigin || url.username || url.password || url.protocol !== "https:" && url.protocol !== "http:") {
        return Object.freeze({ kind: "invalid" });
      }
      return Object.freeze({ kind: "open", url: url.href });
    } catch {
      return Object.freeze({ kind: "invalid" });
    }
  }
  var BrowserTraceWebNavigation = class {
    #runtime;
    #tabs;
    #mode;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
    }
    async open(url) {
      try {
        await extensionCall(
          this.#tabs,
          "create",
          [{ url }],
          this.#runtime,
          this.#mode
        );
        return true;
      } catch {
        return false;
      }
    }
  };
  function activationTarget(webOrigin) {
    try {
      const configured = new URL(webOrigin);
      if (configured.protocol !== "https:" && configured.protocol !== "http:" || configured.username || configured.password) {
        return null;
      }
      return Object.freeze({
        origin: configured.origin,
        queryPattern: `${configured.protocol}//${configured.hostname}/*`,
        url: new URL(FIRST_INSTALL_ACTIVATION_PATH, configured.origin).href
      });
    } catch {
      return null;
    }
  }
  function tabUsesOrigin(tab, origin) {
    if (typeof tab !== "object" || tab === null || typeof tab.id !== "number" || typeof tab.url !== "string") {
      return false;
    }
    try {
      return new URL(tab.url).origin === origin;
    } catch {
      return false;
    }
  }
  async function platformIsIos(runtime, mode) {
    if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) {
      return true;
    }
    if (typeof runtime.getPlatformInfo !== "function") return false;
    try {
      const info = await extensionCall(
        runtime,
        "getPlatformInfo",
        [],
        runtime,
        mode
      );
      return typeof info === "object" && info !== null && info.os === "ios";
    } catch {
      return false;
    }
  }
  function installTraceFirstInstallActivation(options) {
    const target = activationTarget(options.webOrigin);
    if (!target || !options.runtime.onInstalled) return;
    options.runtime.onInstalled.addListener((details) => {
      if (details.reason !== "install") return;
      void (async () => {
        if (await platformIsIos(options.runtime, options.mode)) return;
        try {
          const tabs = await extensionCall(
            options.tabs,
            "query",
            [{ url: [target.queryPattern] }],
            options.runtime,
            options.mode
          );
          const existing = tabs.find((tab) => tabUsesOrigin(tab, target.origin));
          if (existing && typeof options.tabs.update === "function") {
            try {
              await extensionCall(
                options.tabs,
                "update",
                [existing.id, { url: target.url, active: true }],
                options.runtime,
                options.mode
              );
              return;
            } catch {
            }
          }
        } catch {
        }
        try {
          await extensionCall(
            options.tabs,
            "create",
            [{ url: target.url, active: true }],
            options.runtime,
            options.mode
          );
        } catch {
        }
      })();
    });
  }

  // src/extension-runtime/trace-web-status.mts
  var TraceWebStatusNotification = class {
    #runtime;
    #tabs;
    #mode;
    #webOrigin;
    #queryPattern;
    constructor(options) {
      this.#runtime = options.runtime;
      this.#tabs = options.tabs;
      this.#mode = options.mode;
      const webUrl = new URL(options.webOrigin);
      this.#webOrigin = webUrl.origin;
      this.#queryPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
    }
    async publish(state) {
      let tabs;
      try {
        tabs = await extensionCall(
          this.#tabs,
          "query",
          [{ url: [this.#queryPattern] }],
          this.#runtime,
          this.#mode
        );
      } catch {
        return false;
      }
      const message = Object.freeze({
        type: "TRACE_EXTENSION_STATUS_PUSH",
        state
      });
      for (const tab of tabs) {
        if (typeof tab.id !== "number" || !this.#isTraceWebUrl(tab.url)) continue;
        try {
          await extensionCall(
            this.#tabs,
            "sendMessage",
            [tab.id, message],
            this.#runtime,
            this.#mode
          );
        } catch {
        }
      }
      return true;
    }
    #isTraceWebUrl(rawUrl) {
      if (typeof rawUrl !== "string") return false;
      try {
        return new URL(rawUrl).origin === this.#webOrigin;
      } catch {
        return false;
      }
    }
  };

  // src/extension-runtime/archive-readiness-status.mts
  var ARCHIVE_READINESS_STATUS_KEY = "traceArchiveReadiness";
  var ARCHIVE_READINESS_ERROR_RECENT_MS = 24 * 60 * 60 * 1e3;
  function isRecord17(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function epochMillis(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }
  function hostKind(value) {
    return value === "ao3" || value === "ffn" || value === "unknown" ? value : null;
  }
  function actionKind(value) {
    return value === "track" || value === "quick_add" || value === "import" || value === "metadata" ? value : null;
  }
  function errorKind(value) {
    return value === "permission" || value === "unsupported_page" || value === "auth" || value === "parser" || value === "network" || value === "unknown" ? value : null;
  }
  function storedReadiness(value) {
    if (!isRecord17(value)) return Object.freeze({});
    const seenAt = epochMillis(value.lastArchiveSeenAt);
    const seenHost = hostKind(value.lastArchiveHostKind);
    const actionAt = epochMillis(value.lastArchiveActionAt);
    const action = actionKind(value.lastArchiveActionKind);
    const errorAt = epochMillis(value.lastArchiveErrorAt);
    const error = errorKind(value.lastArchiveErrorKind);
    return Object.freeze({
      ...seenAt === null ? {} : { lastArchiveSeenAt: seenAt },
      ...seenHost === null ? {} : { lastArchiveHostKind: seenHost },
      ...actionAt === null ? {} : { lastArchiveActionAt: actionAt },
      ...action === null ? {} : { lastArchiveActionKind: action },
      ...errorAt === null ? {} : { lastArchiveErrorAt: errorAt },
      ...error === null ? {} : { lastArchiveErrorKind: error }
    });
  }
  var BrowserArchiveReadinessStatus = class {
    #storage;
    #clock;
    #tail = Promise.resolve();
    constructor(storage, clock = { now: () => Date.now() }) {
      this.#storage = storage;
      this.#clock = clock;
    }
    record(event) {
      return this.#withLock(async () => {
        const at = Math.max(0, Math.trunc(this.#clock.now()));
        const values = await this.#storage.get(ARCHIVE_READINESS_STATUS_KEY);
        const previous = storedReadiness(values[ARCHIVE_READINESS_STATUS_KEY]);
        const next = { ...previous };
        if (event.seen !== false) {
          next.lastArchiveSeenAt = at;
          next.lastArchiveHostKind = event.hostKind;
        }
        if (event.actionKind !== void 0) {
          next.lastArchiveActionAt = at;
          next.lastArchiveActionKind = event.actionKind;
          delete next.lastArchiveErrorAt;
          delete next.lastArchiveErrorKind;
        }
        if (event.errorKind !== void 0) {
          next.lastArchiveErrorAt = at;
          next.lastArchiveErrorKind = event.errorKind;
        }
        await this.#storage.set({
          [ARCHIVE_READINESS_STATUS_KEY]: Object.freeze(next)
        });
      });
    }
    read() {
      return this.#withLock(async () => {
        const values = await this.#storage.get(ARCHIVE_READINESS_STATUS_KEY);
        const stored = storedReadiness(values[ARCHIVE_READINESS_STATUS_KEY]);
        const {
          lastArchiveErrorAt,
          lastArchiveErrorKind,
          ...publicFields
        } = stored;
        const errorIsRecent = lastArchiveErrorAt !== void 0 && lastArchiveErrorKind !== void 0 && this.#clock.now() - lastArchiveErrorAt <= ARCHIVE_READINESS_ERROR_RECENT_MS;
        return Object.freeze({
          ...publicFields,
          ...errorIsRecent ? { lastArchiveErrorKind } : {}
        });
      });
    }
    async #withLock(work) {
      const previous = this.#tail;
      let release = () => {
      };
      this.#tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };

  // src/extension-runtime/runtime-messages.mts
  var SESSION_MESSAGE_TYPES = Object.freeze({
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
    capacityRecovery: "TRACE_CAPACITY_RECOVERY_ACKNOWLEDGE",
    importTrigger: "TRACE_IMPORT_TRIGGER",
    firstStoryAdd: "TRACE_FIRST_STORY_ADD",
    setHiddenWork: "TRACE_SET_HIDDEN_WORK",
    setReaderStatus: "TRACE_SET_READER_STATUS",
    patchLibraryEntry: "TRACE_PATCH_LIBRARY_ENTRY",
    finishQualification: "TRACE_FINISH_QUALIFICATION_SIGNAL",
    pendingFirstStory: "TRACE_IOS_PENDING_FIRST_STORY_GET",
    status: "TRACE_EXTENSION_STATUS_QUERY",
    openTraceUrl: TRACE_WEB_OPEN_MESSAGE
  });
  var WORK_KEY_PATTERN5 = /^(ao3|ffn):[1-9][0-9]{0,19}$/;
  var MAX_PROJECTION_WORK_KEYS = 250;
  var POPUP_PREFERENCE_KEYS = Object.freeze([
    "prefAutoTrackEnabled",
    "prefLibraryInlayEnabled",
    "prefAo3SavedFiltersEnabled",
    "prefMetadataImproveEnabled"
  ]);
  function isRecord18(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSessionAction(value) {
    return value === "connect" || value === "cancel" || value === "disconnect" || value === "retry" || value === "reconnect";
  }
  function toPublicSessionSnapshot(snapshot) {
    return Object.freeze({
      state: snapshot.state,
      reason: snapshot.reason,
      canExecuteAuthenticated: snapshot.canExecuteAuthenticated
    });
  }
  function toExtensionStatus(snapshot, options = {}) {
    const authState = snapshot.state === "connected" ? "connected" : snapshot.state === "signed_out" ? "signed_out" : snapshot.state === "reconnect_required" ? "reconnect_required" : "unknown";
    return Object.freeze({
      installed: true,
      connected: snapshot.state === "connected",
      authState,
      ...options.firstSaveSeen === void 0 ? {} : { firstSaveSeen: options.firstSaveSeen },
      ...options.browserKind === void 0 ? {} : { browserKind: options.browserKind },
      capabilities: Object.freeze({ firstStoryAdd: true }),
      ...options.readiness ?? {}
    });
  }
  function browserKind(runtime) {
    if (typeof runtime.getURL !== "function") return "unknown";
    try {
      const value = runtime.getURL("");
      if (typeof value !== "string") return "unknown";
      if (value.startsWith("chrome-extension://")) return "chrome";
      if (value.startsWith("moz-extension://")) return "firefox";
      if (value.startsWith("safari-web-extension://")) return "safari";
    } catch {
    }
    return "unknown";
  }
  function boundedProjectionWorkKeys(value, sender) {
    const host = archiveHostKindFromSender(sender);
    if (host === null || !Array.isArray(value) || value.length > MAX_PROJECTION_WORK_KEYS) {
      return null;
    }
    const senderUrl = sender?.tab?.url ?? sender?.url;
    if (isBlockedArchivePath(senderUrl, host)) return null;
    const keys = [];
    const seen = /* @__PURE__ */ new Set();
    for (const candidate of value) {
      if (typeof candidate !== "string" || !WORK_KEY_PATTERN5.test(candidate) || !candidate.startsWith(`${host}:`)) {
        return null;
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        keys.push(candidate);
      }
    }
    return Object.freeze(keys);
  }
  function publicProjection(accountData, workKeys, now = Date.now()) {
    const entries = {};
    const workPreferences = {};
    const overlay = accountData?.overlay;
    if (overlay !== null && overlay !== void 0) {
      for (const workKey of workKeys) {
        const entry = overlay.entries[workKey];
        const preference = overlay.workPreferences[workKey];
        if (entry !== void 0) entries[workKey] = entry;
        if (preference !== void 0) workPreferences[workKey] = preference;
      }
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      workPreferences: Object.freeze(workPreferences),
      syncVersion: overlay?.syncVersion ?? null,
      capacity: publicCapacityRecovery(accountData, now)
    });
  }
  function publicCapacityRecovery(accountData, now = Date.now()) {
    const capacity = accountData?.capacityRecovery;
    if (capacity === null || capacity === void 0) return null;
    return Object.freeze({
      blocked: true,
      prompt: now >= capacity.nextPromptAt
    });
  }
  function publicWorkState(accountData, workKey) {
    const overlay = accountData?.overlay;
    const entry = overlay?.entries[workKey];
    if (overlay === null || overlay === void 0 || entry === void 0) return null;
    return Object.freeze({
      workKey,
      status: "saved",
      ...entry.entryId === void 0 ? {} : { entryId: entry.entryId },
      entry,
      syncVersion: overlay.syncVersion
    });
  }

  // src/extension-runtime/controller.mts
  var DEGRADED_STORAGE_SNAPSHOT = Object.freeze({
    state: "degraded",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "storage_unavailable"
  });
  var DISABLED_SNAPSHOT = Object.freeze({
    state: "signed_out",
    accountId: null,
    canExecuteAuthenticated: false,
    reason: "none"
  });
  var RETRY_DELAYS_MS = Object.freeze([750, 2500, 8e3]);
  var DEFAULT_RETRY_CLOCK = Object.freeze({
    setTimeout(callback, delayMs) {
      return globalThis.setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      globalThis.clearTimeout(handle);
    }
  });
  function isSupportedArchiveSender(sender) {
    return archiveHostKindFromSender(sender) !== null;
  }
  var MemoryDiagnostics = class {
    #events = [];
    record(event) {
      this.#events.push(Object.freeze({ ...event }));
      if (this.#events.length > 80) this.#events.shift();
    }
  };
  var SessionRuntimeController = class {
    #mode;
    #sessionStorage;
    #credentials;
    #database;
    #legacy;
    #alarms;
    #pendingFirstStory;
    #service;
    #accountData;
    #storyCommands;
    #libraryMutations;
    #finishQualification;
    #metadataContributions;
    #savedFilters;
    #savedFilterApi;
    #firstStoryInitiator;
    #traceWebNavigation;
    #traceWebStatus;
    #archiveReadinessStatus;
    #projection;
    #storage;
    #runtime;
    #tabs;
    #storageMode;
    #webOrigin;
    #retryClock;
    #initialization = null;
    #storageFailure = false;
    #automaticVerificationRetry = false;
    #retryAttempt = 0;
    #retryGeneration = 0;
    #retryTimer = null;
    #isIos = null;
    #nativeAuthorityPreparation = null;
    #accountTransitionTail = Promise.resolve();
    #savedFilterSyncInFlight = null;
    #savedFilterSyncQueued = false;
    #savedFilterSyncQueuedWithCurrentAuthority = false;
    #lastPublishedStatusKey = null;
    #statusPublicationTail = Promise.resolve();
    constructor(environment) {
      this.#mode = environment.mode;
      const storage = new BrowserStorage(
        environment.storageArea,
        environment.runtime,
        environment.storageMode
      );
      this.#storage = storage;
      this.#archiveReadinessStatus = environment.archiveReadinessStatus ?? new BrowserArchiveReadinessStatus(storage);
      this.#runtime = environment.runtime;
      this.#tabs = environment.tabs;
      this.#storageMode = environment.storageMode;
      this.#webOrigin = new URL(environment.webOrigin).origin;
      this.#database = environment.privateDatabase ?? new BrowserPrivateRecordDatabase(
        environment.databaseFactory
      );
      this.#sessionStorage = new BrowserSessionStoragePort(this.#database);
      this.#legacy = new LegacyAccountState(storage);
      this.#alarms = new KernelAlarmState(
        environment.alarms,
        environment.runtime,
        environment.storageMode
      );
      this.#pendingFirstStory = new NativePendingFirstStoryReader(
        environment.runtime,
        environment.storageMode
      );
      this.#retryClock = environment.retryClock ?? DEFAULT_RETRY_CLOCK;
      this.#credentials = new BrowserCredentialPort(
        this.#database,
        new ExplicitCredentialProvider({
          runtime: environment.runtime,
          tabs: environment.tabs,
          mode: environment.storageMode,
          webOrigin: environment.webOrigin,
          randomId: environment.randomId
        }),
        environment.randomId
      );
      this.#service = new SessionService({
        storage: this.#sessionStorage,
        credentials: this.#credentials,
        api: new VerificationApi(environment.fetch, environment.apiBase, (disposition) => {
          this.#automaticVerificationRetry = disposition === "automatic";
        }),
        diagnostics: new MemoryDiagnostics()
      });
      this.#savedFilterApi = new SavedFilterSyncApi(
        environment.fetch,
        environment.apiBase
      );
      this.#savedFilters = new SavedFilterSyncService({
        session: this.#service,
        api: this.#savedFilterApi,
        repository: new BrowserSavedFilterRepository({
          storage,
          session: this.#service,
          randomId: environment.randomId
        }),
        clock: { now: () => (/* @__PURE__ */ new Date()).toISOString() }
      });
      this.#accountData = new AccountDataRepository(this.#database, this.#service);
      this.#projection = new AccountProjectionService({
        session: this.#service,
        api: new AccountProjectionApi(environment.fetch, environment.apiBase),
        repository: this.#accountData,
        clock: { now: () => Date.now() }
      });
      this.#metadataContributions = new MetadataContributionService({
        session: this.#service,
        api: new MetadataContributionApi(environment.fetch, environment.apiBase),
        preference: new BrowserMetadataPreferencePort(storage),
        authority: {
          prepare: async () => {
            const preparation = await this.#prepareNativeAuthority();
            if (!preparation.ready) throw new Error("native authority unavailable");
          }
        },
        projection: {
          invalidate: () => this.#projection.invalidate()
        },
        notification: new TraceWebMetadataNotificationPort({
          runtime: environment.runtime,
          tabs: environment.tabs,
          mode: environment.storageMode,
          webOrigin: environment.webOrigin
        })
      });
      const libraryCommandPorts = {
        session: this.#service,
        api: new LibraryCommandApi(environment.fetch, environment.apiBase),
        projection: new AccountLibraryCommandProjection(
          this.#projection,
          this.#accountData
        ),
        finishOperationIds: {
          create: environment.randomId
        }
      };
      this.#libraryMutations = new LibraryMutationService(libraryCommandPorts);
      this.#finishQualification = new FinishQualificationService(libraryCommandPorts);
      this.#firstStoryInitiator = new BrowserFirstStoryInitiator({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin,
        ...environment.firstStoryDelay === void 0 ? {} : { delay: environment.firstStoryDelay }
      });
      this.#traceWebNavigation = new BrowserTraceWebNavigation({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode
      });
      this.#traceWebStatus = new TraceWebStatusNotification({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin
      });
      this.#storyCommands = new StoryCommandService({
        session: this.#service,
        api: new StoryCommandApi(environment.fetch, environment.apiBase),
        projection: new AccountStoryProjectionPort(this.#accountData),
        receipt: new NativeStorySaveReceiptPort(
          environment.runtime,
          environment.storageMode
        ),
        handoff: new NativePendingStoryHandoffPort(
          environment.runtime,
          environment.storageMode
        ),
        clock: { now: () => Date.now() }
      });
    }
    start() {
      this.#initialization ??= this.#startOnce();
      return this.#initialization;
    }
    snapshot() {
      if (this.#storageFailure) return DEGRADED_STORAGE_SNAPSHOT;
      if (this.#mode === "disabled") return DISABLED_SNAPSHOT;
      return this.#service.snapshot();
    }
    async handle(message, sender) {
      if (!isRecord18(message) || typeof message.type !== "string") return null;
      if (!Object.values(SESSION_MESSAGE_TYPES).includes(message.type)) return null;
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
        case SESSION_MESSAGE_TYPES.capacityRecovery:
          return this.#handleCapacityRecoveryMessage(message, sender);
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
    async #handleSessionMessage(message, sender) {
      if (!isPopupSender(sender, this.#runtime.id) && !isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)) {
        return null;
      }
      if (message.type === SESSION_MESSAGE_TYPES.snapshot && Object.keys(message).length !== 1 || message.type === SESSION_MESSAGE_TYPES.action && Object.keys(message).length !== 2) {
        return null;
      }
      await this.start();
      if (message.type === SESSION_MESSAGE_TYPES.snapshot) return this.#response();
      if (!isSessionAction(message.action)) return this.#response({ kind: "ignored" });
      return this.#response(await this.#runManualAction(message.action, true));
    }
    async #handleStatusMessage(message, sender) {
      await this.start();
      if (Object.keys(message).length !== 2 || typeof message.nonce !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.nonce) || !isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)) {
        return null;
      }
      return this.#extensionStatus();
    }
    async #handleTraceNavigationMessage(message, sender) {
      const request = traceWebNavigationRequestFromMessage(
        message,
        sender,
        this.#webOrigin
      );
      if (request === null) return null;
      await this.start();
      if (this.#mode === "disabled") {
        return Object.freeze({ ok: false, error: "commands_unavailable" });
      }
      if (request.kind === "invalid") {
        return Object.freeze({ ok: false, error: "invalid_trace_url" });
      }
      return await this.#traceWebNavigation.open(request.url) ? Object.freeze({ ok: true }) : Object.freeze({ ok: false, error: "open_failed" });
    }
    async #handleReadMessage(message, sender) {
      await this.start();
      if (message.type === SESSION_MESSAGE_TYPES.pendingFirstStory) {
        return isSupportedArchiveSender(sender) ? this.#pendingFirstStory.read() : { ok: false, error: "native_unavailable" };
      }
      if (message.type === SESSION_MESSAGE_TYPES.projection) {
        const workKeys = boundedProjectionWorkKeys(message.workKeys, sender);
        if (workKeys === null) return null;
        await this.#bootstrapNativeAuthorityForArchiveRead();
        const accountData = await this.#projection.read();
        return Object.freeze({
          ok: true,
          snapshot: toPublicSessionSnapshot(this.snapshot()),
          projection: publicProjection(accountData, workKeys)
        });
      }
      if (message.type === SESSION_MESSAGE_TYPES.workState) {
        const host = archiveHostKindFromSender(sender);
        const workKey = typeof message.workKey === "string" ? message.workKey : "";
        const senderUrl = sender?.tab?.url ?? sender?.url;
        if (host === null || isBlockedArchivePath(senderUrl, host) || !WORK_KEY_PATTERN5.test(workKey) || workKey !== workKeyFromArchiveUrl(senderUrl, host)) {
          return null;
        }
        await this.#bootstrapNativeAuthorityForArchiveRead();
        const accountData = await this.#projection.read();
        return Object.freeze({
          ok: true,
          snapshot: toPublicSessionSnapshot(this.snapshot()),
          state: publicWorkState(accountData, workKey)
        });
      }
      if (!isPopupSender(sender, this.#runtime.id)) return null;
      return this.#popupState();
    }
    async #handleSavedFilterMessage(message, sender) {
      if (!isSavedFilterSyncRequest(message, sender)) return null;
      await this.start();
      return this.#savedFilterResponse(await this.#runSavedFilterSync());
    }
    async #handleCapacityRecoveryMessage(message, sender) {
      const host = archiveHostKindFromSender(sender);
      const senderUrl = sender?.tab?.url ?? sender?.url;
      if (host === null || isBlockedArchivePath(senderUrl, host) || Object.keys(message).length !== 2 || message.action !== "shown" && message.action !== "dismissed") {
        return null;
      }
      await this.start();
      const preparation = await this.#prepareNativeAuthority();
      const scope2 = this.#service.publicationScope();
      if (!preparation.ready || scope2 === null) {
        return this.#response(
          preparation.action,
          preparation.action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
        );
      }
      const result = await this.#accountData.acknowledgeCapacityRecovery(
        scope2,
        message.action,
        Date.now()
      );
      const accountData = result.kind === "published" ? result.value : await this.#accountData.read().catch(() => null);
      return Object.freeze({
        ok: result.kind === "published",
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        ...preparation.action === void 0 ? {} : { action: preparation.action },
        capacity: publicCapacityRecovery(accountData),
        ...result.kind === "published" ? {} : { error: "unavailable" }
      });
    }
    async #handleFirstStoryMessage(message, sender) {
      const initiation = firstStoryInitiationFromMessage(
        message,
        sender,
        this.#runtime.id,
        this.#webOrigin
      );
      if (initiation === null) return null;
      await this.start();
      if (initiation.kind === "invalid") {
        return this.#firstStoryResponse({
          ok: false,
          error: initiation.error
        }, void 0, initiation);
      }
      const preparation = initiation.kind === "web_save" ? await this.#prepareNativeAuthority() : { ready: true };
      const action = preparation.action;
      if (!preparation.ready || this.snapshot().state !== "connected") {
        return this.#firstStoryResponse(
          { ok: false, error: "not_authenticated" },
          action,
          initiation
        );
      }
      const result = initiation.kind === "popup_import" ? await this.#firstStoryInitiator.importActivePage() : await this.#firstStoryInitiator.saveFromTrace(initiation.url);
      return this.#firstStoryResponse(result, action, initiation);
    }
    async #handleMetadataMessage(message, sender) {
      const command = metadataContributionCommandFromMessage(message, sender);
      if (command === null) return null;
      await this.start();
      return this.#metadataContributionResponse(
        await this.#metadataContributions.execute(command),
        command
      );
    }
    async #handleLibraryMessage(message, sender) {
      const finishCommand = message.type === SESSION_MESSAGE_TYPES.finishQualification ? finishQualificationCommandFromMessage(message, sender) : null;
      const libraryCommand = message.type === SESSION_MESSAGE_TYPES.finishQualification ? null : libraryMutationCommandFromMessage(message, sender);
      if (finishCommand === null && libraryCommand === null) return null;
      await this.start();
      const preparation = await this.#prepareNativeAuthority();
      const action = preparation.action;
      if (!preparation.ready || this.snapshot().state !== "connected") {
        const reason = action?.kind === "unavailable" ? "unavailable" : "not_authenticated";
        return finishCommand === null ? this.#libraryCommandResponse(
          { kind: "failed", reason },
          action
        ) : this.#finishQualificationResponse(
          { kind: "failed", reason },
          action
        );
      }
      return finishCommand === null ? this.#libraryCommandResponse(
        await this.#libraryMutations.execute(libraryCommand),
        action
      ) : this.#finishQualificationResponse(
        await this.#finishQualification.execute(finishCommand),
        action
      );
    }
    async #handleStoryMessage(message, sender) {
      const command = storyTrackCommandFromMessage(message, sender);
      if (command === null) return null;
      await this.start();
      if (message.type === SESSION_MESSAGE_TYPES.connectAndSave) {
        const preparation2 = await this.#prepareNativeAuthority();
        const action2 = preparation2.action ?? await this.#runManualAction(
          this.snapshot().state === "connected" ? "reconnect" : "connect"
        );
        if (!preparation2.ready && preparation2.action !== void 0) {
          return this.#commandResponse(
            {
              kind: "failed",
              reason: action2.kind === "unavailable" ? "unavailable" : "not_authenticated"
            },
            action2,
            command
          );
        }
        if (this.snapshot().state !== "connected") {
          return this.#commandResponse(
            { kind: "failed", reason: "not_authenticated" },
            action2,
            command
          );
        }
        return this.#commandResponse(
          await this.#executeStoryCommand(command),
          action2,
          command
        );
      }
      if (message.type === SESSION_MESSAGE_TYPES.quickAdd) {
        const preparation2 = await this.#prepareNativeAuthority();
        if (!preparation2.ready) {
          return this.#commandResponse(
            {
              kind: "failed",
              reason: preparation2.action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
            },
            preparation2.action,
            command
          );
        }
        return this.#commandResponse(
          await this.#executeStoryCommand(command),
          preparation2.action,
          command
        );
      }
      const preferences = await this.#storage.get("prefAutoTrackEnabled").catch(() => ({}));
      if (preferences.prefAutoTrackEnabled === false) {
        return this.#response(void 0, "auto_track_disabled");
      }
      const preparation = await this.#prepareNativeAuthority();
      const action = preparation.action;
      if (!preparation.ready || this.snapshot().state !== "connected") {
        return this.#commandResponse(
          {
            kind: "failed",
            reason: action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
          },
          action,
          command
        );
      }
      return this.#commandResponse(
        await this.#executeStoryCommand(command),
        action,
        command
      );
    }
    async #executeStoryCommand(command) {
      let accountData = await this.#accountData.read().catch(() => null);
      if (accountData?.capacityRecovery !== null && accountData?.capacityRecovery !== void 0 && accountData.overlay === null) {
        accountData = await this.#projection.read().catch(() => accountData);
      }
      if (accountData?.capacityRecovery !== null && accountData?.capacityRecovery !== void 0 && accountData.overlay !== null && accountData.overlay.entries[command.workKey] === void 0) {
        return Object.freeze({ kind: "failed", reason: "free_limit_reached" });
      }
      return this.#storyCommands.execute(command);
    }
    async #startOnce() {
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
    async #retryInitialization() {
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
        return this.#mode === "disabled" ? { kind: "completed", state: "signed_out" } : { kind: "ignored" };
      } catch {
        return { kind: "unavailable" };
      }
    }
    async #runAction(action) {
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
    async #runManualAction(action, scheduleSavedFilters = false) {
      if (this.#savedFilterSyncInFlight !== null) {
        this.#savedFilters.cancel();
        this.#savedFilterApi.cancelPending();
      }
      const result = await this.#withAccountTransitionLock(
        () => this.#runManualActionUnlocked(action)
      );
      this.#publishStatus();
      if (scheduleSavedFilters && result.kind === "completed" && result.state === "connected") {
        this.#queueSavedFilterSync(true);
      }
      return result;
    }
    async #runManualActionUnlocked(action) {
      this.#cancelAutomaticRetry(true);
      const result = await this.#runAction(action);
      this.#reconcileAutomaticRetry();
      return result;
    }
    #automaticRetryIsEligible() {
      const snapshot = this.snapshot();
      return snapshot.state === "degraded" && (snapshot.reason === "storage_unavailable" || snapshot.reason === "verification_unavailable" && this.#automaticVerificationRetry);
    }
    #reconcileAutomaticRetry() {
      if (!this.#automaticRetryIsEligible()) {
        this.#cancelAutomaticRetry(true);
        return;
      }
      if (this.#retryTimer !== null || this.#retryAttempt >= RETRY_DELAYS_MS.length) return;
      const generation = this.#retryGeneration;
      const delayMs = RETRY_DELAYS_MS[this.#retryAttempt];
      this.#retryAttempt += 1;
      this.#retryTimer = this.#retryClock.setTimeout(() => {
        this.#retryTimer = null;
        void this.#runAutomaticRetry(generation);
      }, delayMs);
    }
    async #runAutomaticRetry(generation) {
      if (generation !== this.#retryGeneration || !this.#automaticRetryIsEligible()) return;
      await this.#withAccountTransitionLock(() => this.#runAction("retry"));
      this.#publishStatus();
      if (generation !== this.#retryGeneration) return;
      this.#reconcileAutomaticRetry();
    }
    #cancelAutomaticRetry(resetAttempt) {
      this.#retryGeneration += 1;
      if (this.#retryTimer !== null) {
        this.#retryClock.clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
      }
      if (resetAttempt) this.#retryAttempt = 0;
    }
    async #clearLegacyAfterDisconnect(result) {
      if (result.kind !== "completed" || result.state !== "signed_out") return;
      try {
        await this.#accountData.clear();
      } catch {
      }
      try {
        await this.#legacy.clear();
      } catch {
      }
    }
    #response(action, error) {
      return Object.freeze({
        ok: true,
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        ...action === void 0 ? {} : { action },
        ...error === void 0 ? {} : { error }
      });
    }
    async #commandResponse(command, action, request) {
      if (request !== void 0) {
        await this.#recordStoryReadiness(request, command);
      }
      let accountData = await this.#accountData.read().catch(() => null);
      const scope2 = this.#service.publicationScope();
      if (command.kind === "failed" && command.reason === "free_limit_reached" && scope2 !== null) {
        const result = await this.#accountData.publishCapacityBlocked(
          scope2,
          Date.now()
        );
        if (result.kind === "published") accountData = result.value;
      } else if (command.kind === "confirmed" && command.intent === "ensure_saved" && command.source !== "preflight" && scope2 !== null) {
        const result = await this.#accountData.clearCapacityRecovery(scope2);
        if (result.kind === "published") accountData = result.value;
      }
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind === "confirmed",
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        ...action === void 0 ? {} : { action },
        command,
        capacity: publicCapacityRecovery(accountData),
        ...command.kind === "confirmed" ? {
          entryId: command.confirmation.entryId,
          state: Object.freeze({
            workKey: command.confirmation.workKey,
            status: "saved",
            entryId: command.confirmation.entryId,
            entry: command.confirmation.entry,
            syncVersion: command.confirmation.syncVersion
          })
        } : { error: command.reason }
      });
    }
    #libraryCommandResponse(command, action) {
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind === "confirmed",
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        ...action === void 0 ? {} : { action },
        command,
        ...command.kind === "confirmed" ? {
          ...command.entryId === void 0 ? {} : { entryId: command.entryId }
        } : { error: command.reason }
      });
    }
    #finishQualificationResponse(command, action) {
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind === "acknowledged",
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        ...action === void 0 ? {} : { action },
        command,
        ...command.kind === "failed" ? { error: command.reason } : {}
      });
    }
    async #metadataContributionResponse(command, request) {
      await this.#recordMetadataReadiness(request, command);
      this.#publishStatus();
      return Object.freeze({
        ok: command.kind !== "failed",
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        command,
        ...command.kind === "failed" ? { error: command.reason } : {}
      });
    }
    #savedFilterResponse(sync) {
      this.#publishStatus();
      return Object.freeze({
        ok: sync.kind !== "failed",
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        sync,
        ...sync.kind === "failed" ? { error: sync.reason } : {}
      });
    }
    async #firstStoryResponse(result, action, initiation) {
      if (initiation?.kind === "popup_import") {
        await this.#recordImportReadiness(result);
      }
      this.#publishStatus();
      return Object.freeze({
        ok: result.ok,
        snapshot: toPublicSessionSnapshot(this.snapshot()),
        ...action === void 0 ? {} : { action },
        ...result.ok ? { state: result.state } : { error: result.error }
      });
    }
    async #recordStoryReadiness(request, result) {
      try {
        if (result.kind === "confirmed") {
          await this.#archiveReadinessStatus.record({
            hostKind: request.hostKind,
            actionKind: request.intent === "record_progress" ? "track" : "quick_add"
          });
          return;
        }
        const errorKind2 = this.#archiveErrorKind(result.reason);
        if (errorKind2 !== null) {
          await this.#archiveReadinessStatus.record({
            hostKind: request.hostKind,
            errorKind: errorKind2
          });
        }
      } catch {
      }
    }
    async #recordMetadataReadiness(request, result) {
      try {
        if (result.kind === "accepted" && (request.kind === "story_metadata" || result.updated)) {
          await this.#archiveReadinessStatus.record({
            hostKind: request.hostKind,
            actionKind: "metadata"
          });
          return;
        }
        if (result.kind === "failed") {
          const errorKind2 = this.#archiveErrorKind(result.reason);
          if (errorKind2 !== null) {
            await this.#archiveReadinessStatus.record({
              hostKind: request.hostKind,
              errorKind: errorKind2
            });
          }
        }
      } catch {
      }
    }
    async #recordImportReadiness(result) {
      let hostKind2 = "unknown";
      try {
        const tabs = await this.#callTabsQuery({ active: true, currentWindow: true });
        const context = classifyActiveTabUrl(tabs[0]?.url, this.#webOrigin);
        if ("site" in context) hostKind2 = context.site;
        if (result.ok && result.state === "opened") {
          await this.#archiveReadinessStatus.record({ hostKind: hostKind2, actionKind: "import" });
          return;
        }
        if (!result.ok) {
          const errorKind2 = result.error === "permission_required" ? "permission" : result.error === "unsupported_page" || result.error === "no_active_tab" || result.error === "invalid_url" ? "unsupported_page" : result.error === "collect_failed" ? "parser" : "unknown";
          await this.#archiveReadinessStatus.record({ hostKind: hostKind2, errorKind: errorKind2 });
        }
      } catch {
      }
    }
    #archiveErrorKind(reason) {
      if (reason === "not_authenticated" || reason === "auth_expired") return "auth";
      if (reason === "invalid_request" || reason === "invalid_response") return "parser";
      if (reason === "unavailable" || reason === "rate_limited" || reason === "confirmation_missing") {
        return "network";
      }
      return null;
    }
    async #bootstrapNativeAuthorityForArchiveRead() {
      const state = this.snapshot().state;
      if (state !== "signed_out" && state !== "reconnect_required") return;
      if (!await this.#usesNativeAccountAuthority()) return;
      await this.#prepareNativeAuthority();
    }
    #prepareNativeAuthority() {
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
        }
      );
      return operation;
    }
    async #prepareNativeAuthorityOnce() {
      if (!await this.#usesNativeAccountAuthority()) {
        return Object.freeze({ ready: true });
      }
      return this.#withAccountTransitionLock(
        () => this.#prepareNativeAuthorityUnlocked()
      );
    }
    async #prepareNativeAuthorityUnlocked() {
      const before = this.#service.publicationScope();
      const action = await this.#service.synchronizeProviderCredential();
      const after = this.#service.publicationScope();
      const scopeChanged = before?.accountId !== after?.accountId || before?.epoch !== after?.epoch;
      if (scopeChanged) {
        try {
          await this.#accountData.clear();
        } catch {
        }
        this.#projection.invalidate();
      }
      return Object.freeze({
        ready: action.kind === "completed" && action.state === "connected" && after !== null,
        action
      });
    }
    requestSavedFilterSync() {
      if (this.#mode === "kernel") this.#queueSavedFilterSync();
    }
    #queueSavedFilterSync(nativeAuthorityCurrent = false) {
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
    #runSavedFilterSync(nativeAuthorityCurrent = false) {
      this.#savedFilterSyncInFlight ??= this.#withAccountTransitionLock(async () => {
        if (!nativeAuthorityCurrent && await this.#usesNativeAccountAuthority()) {
          const preparation = await this.#prepareNativeAuthorityUnlocked();
          if (!preparation.ready) {
            return Object.freeze({
              kind: "failed",
              reason: preparation.action?.kind === "unavailable" ? "unavailable" : "not_authenticated"
            });
          }
        }
        if (this.snapshot().state !== "connected") {
          return Object.freeze({
            kind: "failed",
            reason: "not_authenticated"
          });
        }
        return this.#savedFilters.sync();
      }).finally(() => {
        this.#savedFilterSyncInFlight = null;
      });
      return this.#savedFilterSyncInFlight;
    }
    async #withAccountTransitionLock(work) {
      const previous = this.#accountTransitionTail;
      let release = () => {
      };
      this.#accountTransitionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
    #publishStatus() {
      this.#statusPublicationTail = this.#statusPublicationTail.then(async () => {
        const status = await this.#extensionStatus();
        const statusKey = JSON.stringify(status);
        if (statusKey === this.#lastPublishedStatusKey) return;
        this.#lastPublishedStatusKey = statusKey;
        await this.#traceWebStatus.publish(status);
      }).catch(() => {
      });
    }
    async #extensionStatus() {
      const [accountData, readiness] = await Promise.all([
        this.#accountData.read().catch(() => null),
        this.#archiveReadinessStatus.read().catch(
          () => Object.freeze({})
        )
      ]);
      return toExtensionStatus(this.snapshot(), {
        firstSaveSeen: accountData?.summary?.firstStoryCompleted === true || Object.keys(accountData?.overlay?.entries ?? {}).length > 0,
        browserKind: browserKind(this.#runtime),
        readiness
      });
    }
    async #popupState() {
      const [accountData, preferences, activeTab] = await Promise.all([
        this.#projection.read(),
        this.#storage.get(POPUP_PREFERENCE_KEYS).catch(() => ({})),
        this.#activeTabContext()
      ]);
      return Object.freeze({
        ok: true,
        authState: toPublicSessionSnapshot(this.snapshot()),
        firstSaveSeen: accountData?.summary?.firstStoryCompleted === true,
        libraryCount: accountData?.summary?.libraryCount ?? null,
        activeTab,
        pro: accountData?.summary?.pro === true,
        capacity: publicCapacityRecovery(accountData),
        autoTrackEnabled: preferences.prefAutoTrackEnabled !== false,
        libraryInlayEnabled: preferences.prefLibraryInlayEnabled !== false,
        ao3SavedFiltersEnabled: preferences.prefAo3SavedFiltersEnabled !== false,
        metadataImproveEnabled: preferences.prefMetadataImproveEnabled !== false
      });
    }
    async #activeTabContext() {
      try {
        const tabs = await this.#callTabsQuery({ active: true, currentWindow: true });
        return classifyActiveTabUrl(tabs[0]?.url, this.#webOrigin);
      } catch {
        return Object.freeze({ kind: "unknown" });
      }
    }
    #callTabsQuery(query) {
      if (this.#storageMode === "promise") {
        try {
          return Promise.resolve(
            this.#tabs.query(query)
          );
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return new Promise((resolve, reject) => {
        try {
          this.#tabs.query(query, (tabs) => {
            const message = this.#runtime.lastError?.message;
            if (message) reject(new Error(message));
            else resolve(tabs);
          });
        } catch (error) {
          reject(error);
        }
      });
    }
    #usesNativeAccountAuthority() {
      this.#isIos ??= (async () => {
        if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) return true;
        if (typeof this.#runtime.getPlatformInfo !== "function") return false;
        try {
          let value;
          if (this.#storageMode === "promise") {
            value = await this.#runtime.getPlatformInfo();
          } else {
            value = await new Promise((resolve, reject) => {
              this.#runtime.getPlatformInfo((info) => {
                const message = this.#runtime.lastError?.message;
                if (message) reject(new Error(message));
                else resolve(info);
              });
            });
          }
          return isRecord18(value) && value.os === "ios";
        } catch {
          return false;
        }
      })();
      return this.#isIos;
    }
  };
  function installSessionRuntime(environment) {
    const controller = new SessionRuntimeController(environment);
    if (environment.mode === "kernel") {
      SavedFilterSyncAlarm.install(
        environment.alarms,
        environment.runtime,
        () => controller.requestSavedFilterSync()
      );
    }
    environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord18(message) || !Object.values(SESSION_MESSAGE_TYPES).includes(message.type)) {
        return false;
      }
      void controller.handle(message, sender).then(
        (response) => sendResponse(response),
        () => sendResponse({
          ok: false,
          snapshot: toPublicSessionSnapshot(DEGRADED_STORAGE_SNAPSHOT),
          error: "runtime_unavailable"
        })
      );
      return true;
    });
    void controller.start();
    return controller;
  }

  // src/extension-runtime/archive-readiness.mts
  var ARCHIVE_READINESS_MESSAGE_TYPES = Object.freeze({
    archiveSeen: "TRACE_ARCHIVE_SEEN"
  });
  function isRecord19(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function normalizeHandoffId(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null;
  }
  var ArchiveReadinessRuntimeController = class {
    #service;
    #status;
    constructor(environment) {
      this.#status = environment.status;
      this.#service = new ArchiveReadinessService({
        receipts: new NativeArchiveReadinessReceiptPort(
          environment.runtime,
          environment.storageMode
        ),
        permissions: new BrowserArchivePermissionSnapshotPort(
          environment.permissions,
          environment.runtime,
          environment.storageMode
        ),
        ...environment.clock === void 0 ? {} : { clock: environment.clock }
      });
    }
    async handle(message, sender) {
      if (!isRecord19(message) || message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.archiveSeen) {
        return null;
      }
      const hostKind2 = archiveHostKindFromSender(sender);
      if (hostKind2 === null) return { ok: true, receipt: "ignored" };
      void this.#status?.record({ hostKind: hostKind2 }).catch(() => {
      });
      const handoffId = normalizeHandoffId(message.handoffId);
      const result = await this.#service.recordRun({
        hostKind: hostKind2,
        ...handoffId === null ? {} : { handoffId }
      });
      return { ok: true, receipt: result.kind };
    }
  };
  function installArchiveReadinessRuntime(environment) {
    const controller = new ArchiveReadinessRuntimeController(environment);
    environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isRecord19(message) || message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.archiveSeen) {
        return false;
      }
      void controller.handle(message, sender).then(
        (response) => sendResponse(response),
        () => sendResponse({ ok: true, receipt: "unavailable" })
      );
      return true;
    });
    return controller;
  }

  // src/extension-runtime/index.mts
  var UUID_PATTERN7 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function fallbackUuid(seed) {
    let hash = 2166136261;
    const bytes = [];
    for (let index = 0; index < 16; index += 1) {
      for (let offset = 0; offset < seed.length; offset += 1) {
        hash ^= seed.charCodeAt(offset) + index;
        hash = Math.imul(hash, 16777619);
      }
      bytes.push(hash >>> index % 4 * 8 & 255);
    }
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    const hex = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  var scope = globalThis;
  scope.TRACE_SESSION_MODE = "kernel";
  try {
    const extension = scope.browser ?? scope.chrome;
    if (!extension) throw new Error("extension environment unavailable");
    const storageMode = scope.browser ? "promise" : "callback";
    const archiveReadinessStatus = new BrowserArchiveReadinessStatus(
      new BrowserStorage(extension.storage.local, extension.runtime, storageMode)
    );
    if (true) {
      installTraceFirstInstallActivation({
        runtime: extension.runtime,
        tabs: extension.tabs,
        mode: storageMode,
        webOrigin: "https://www.tracefiction.com"
      });
      installArchiveReadinessRuntime({
        runtime: extension.runtime,
        ...extension.permissions === void 0 ? {} : { permissions: extension.permissions },
        storageMode,
        status: archiveReadinessStatus
      });
    }
    if (!scope.indexedDB) throw new Error("private database unavailable");
    let fallbackId = 0;
    const randomId = () => {
      const uuid = scope.crypto?.randomUUID?.();
      if (typeof uuid === "string" && UUID_PATTERN7.test(uuid)) return uuid;
      fallbackId += 1;
      return fallbackUuid(`${Date.now()}:${fallbackId}`);
    };
    installSessionRuntime({
      mode: "kernel",
      runtime: extension.runtime,
      tabs: extension.tabs,
      alarms: extension.alarms,
      storageArea: extension.storage.local,
      databaseFactory: scope.indexedDB,
      storageMode,
      fetch: globalThis.fetch.bind(globalThis),
      apiBase: "https://api.tracefiction.com",
      webOrigin: "https://www.tracefiction.com",
      randomId,
      archiveReadinessStatus
    });
  } catch {
    scope.__traceSessionRuntimeBootFailed = true;
  }
})();
