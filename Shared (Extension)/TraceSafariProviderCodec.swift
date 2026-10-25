import Foundation
import CryptoKit

/// Canonical validation for the credential record shared by the containing
/// app and Safari extension. This source is compiled into both targets so the
/// writer, app-side status check, and extension reader cannot drift.
enum TraceSafariProviderCodec {
    struct DeviceSession: Equatable {
        let sessionId: String
        let credential: String
        let expiresAt: String
    }

    static func deviceSession(
        sessionId rawSessionId: String,
        credential rawCredential: String,
        expiresAt: String
    ) -> DeviceSession? {
        guard let sessionId = UUID(uuidString: rawSessionId)?.uuidString.lowercased(),
              parseISO8601Date(expiresAt) != nil
        else {
            return nil
        }
        let credential = rawCredential.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard credential.range(
            of: "^trd_v1_[A-Za-z0-9_-]{43}$",
            options: .regularExpression
        ) != nil else {
            return nil
        }
        return DeviceSession(
            sessionId: sessionId,
            credential: credential,
            expiresAt: expiresAt
        )
    }

    struct ImportBinding: Codable, Equatable, Sendable {
        let sessionID: String
        let recordDigest: String
    }

    /// A freshness and equality fence, not independent authentication. Both
    /// producer and containing app use the same canonical record bytes.
    static func importBinding(session: DeviceSession, now: Date) -> ImportBinding? {
        guard let canonical = deviceSession(sessionId: session.sessionId,
                credential: session.credential, expiresAt: session.expiresAt),
              let expiry = parseISO8601Date(canonical.expiresAt), expiry > now,
              let bytes = try? JSONSerialization.data(withJSONObject: [
                "trace-safari-import-provider-v1", "2", "device_session",
                canonical.sessionId, canonical.credential, canonical.expiresAt
              ], options: [.fragmentsAllowed, .withoutEscapingSlashes]) else { return nil }
        return ImportBinding(sessionID: canonical.sessionId,
            recordDigest: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    }

    /// JavaScript `Date#toISOString` and the extension API contract include
    /// fractional seconds. Retain support for valid timestamps without them.
    static func parseISO8601Date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// v0.6.0 stored raw Auth0 JWT bytes under the provider-v2 account. Only
    /// that known three-segment format is eligible for in-place replacement.
    static func isLegacyV060RawAccessToken(_ data: Data) -> Bool {
        guard data.count >= 32, data.count <= 16_384,
              let token = String(data: data, encoding: .utf8)
        else {
            return false
        }
        return token.range(
            of: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
            options: .regularExpression
        ) != nil
    }
}

/// Local, opt-in first-save handoff. Contains no credential, page URL or story
/// text. The native account owner must verify the provider and read the exact
/// Library entry before presenting a success. A heartbeat is not a prerequisite.
enum TraceSafariOnboardingReceipt {
    static let productionAPIOrigin = "https://api.tracefiction.com"
    #if TRACE_INTERNAL_REVIEW && TRACE_NATIVE_DEVELOPMENT_API
    static let developmentAPIOrigin: String = {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "TraceDevelopmentAPIOrigin") else {
            return "https://api.development.example.test"
        }
        // Invalid supplied metadata fails closed; only absence uses the fixture.
        return validatedDevelopmentAPIOrigin(value) ?? ""
    }()

    static func validatedDevelopmentAPIOrigin(_ value: Any) -> String? {
        guard let value = value as? String, value.utf8.count <= 253,
              value.range(of: "^https://[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$", options: .regularExpression) != nil,
              let components = URLComponents(string: value), let host = components.host,
              components.scheme == "https", components.user == nil, components.password == nil,
              components.port == nil, components.path.isEmpty, components.query == nil, components.fragment == nil
        else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, !labels.contains("localhost"),
              host.range(of: "^[0-9.]+$", options: .regularExpression) == nil,
              labels.allSatisfy({ $0.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil })
        else { return nil }
        return value
    }
    #else
    static let developmentAPIOrigin = "https://api.development.example.test"
    #endif

    static func allowsAPIOrigin(_ origin: String) -> Bool {
        if origin == productionAPIOrigin { return true }
        #if TRACE_INTERNAL_REVIEW && TRACE_NATIVE_DEVELOPMENT_API
        return !developmentAPIOrigin.isEmpty && origin == developmentAPIOrigin
        #else
        return false
        #endif
    }
    static let attemptKey = "traceNativeOnboardingAttemptV1"
    static let receiptKey = "traceNativeOnboardingSaveV1"
    static let maximumSaves = 32
    struct Batch: Codable { let version: Int; let saves: [Save] }
    static let previousAttemptKey = "traceNativeOnboardingPreviousAttemptV1"
    struct Attempt: Codable, Equatable {
        let id: String
        let accountID: String
        let apiOrigin: String
        let provider: TraceSafariProviderCodec.ImportBinding
        let startedAt: Double
        let expiresAt: Double
        var measurementAttemptID: String? = nil
        func valid(apiOrigin expectedOrigin: String = productionAPIOrigin) -> Bool {
            UUID(uuidString: id) != nil && !accountID.isEmpty && accountID.utf8.count <= 256 &&
            allowsAPIOrigin(expectedOrigin) &&
            apiOrigin == expectedOrigin && UUID(uuidString: provider.sessionID) != nil &&
            provider.recordDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
            startedAt.isFinite && expiresAt.isFinite && startedAt > 0 &&
            expiresAt > startedAt && expiresAt - startedAt <= 86_400_000
        }
    }
    struct Context: Codable, Equatable {
        let attemptID: String
        let operationID: String
        let initiatedAt: Double
    }
    struct Save: Codable, Equatable {
        let attempt: Attempt
        let context: Context
        let entryID: String
        let workKey: String
        let confirmedAt: Double
        let source: String
        /// How the save came about, as the extension's background established
        /// it: `bounded_manual` (the reader opened Trace on the story before
        /// the story sites were allowed) or `normal_automatic` (the sites were
        /// allowed and the page scripts registered). Absent when neither was
        /// established. A reader of this record that predates the field
        /// decodes the record unchanged.
        var mode: String? = nil
        static let modes: Set<String> = ["bounded_manual", "normal_automatic"]
        func valid(now: Double, apiOrigin: String = productionAPIOrigin) -> Bool {
            attempt.valid(apiOrigin: apiOrigin) && context.attemptID == attempt.id &&
            UUID(uuidString: context.operationID) != nil && UUID(uuidString: entryID) != nil &&
            workKey.range(of: "^(ao3|ffn):[1-9][0-9]{0,19}$", options: .regularExpression) != nil &&
            ["preflight", "mutation", "reconciliation"].contains(source) &&
            context.initiatedAt.isFinite && confirmedAt.isFinite &&
            context.initiatedAt >= attempt.startedAt && context.initiatedAt <= attempt.expiresAt &&
            confirmedAt >= context.initiatedAt && confirmedAt <= now &&
            now - confirmedAt <= 86_400_000
        }
    }
    static func decode<T: Decodable>(_ type: T.Type, data: Data?) -> T? {
        guard let data, data.count <= 8192 else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
    static func readSaves(_ data: Data?) -> [Save] {
        guard let data, data.count <= 32768 else { return [] }
        if let batch = try? JSONDecoder().decode(Batch.self, from: data),
           batch.version == 1, batch.saves.count <= maximumSaves { return batch.saves }
        // Compatibility with the initial internal single-save candidate.
        return decode(Save.self, data: data).map { [$0] } ?? []
    }
    static func handle(_ payload: [String: Any], defaults: UserDefaults,
                       provider: TraceSafariProviderCodec.ImportBinding?, now: Double,
                       configuredAPIOrigin: String = productionAPIOrigin) -> [String: Any] {
        let current = decode(Attempt.self, data: defaults.data(forKey: attemptKey))
        let previous = decode(Attempt.self, data: defaults.data(forKey: previousAttemptKey))
        let contextID = (payload["context"] as? [String: Any])?["attemptID"] as? String
        let preparing = payload["type"] as? String == "TRACE_IOS_SAVE_PREPARE"
        let selected = preparing || contextID == current?.id ? current : previous
        guard let attempt = selected, preparing || contextID == attempt.id,
              attempt.valid(apiOrigin: configuredAPIOrigin), now <= attempt.expiresAt + 86_400_000, attempt.provider == provider,
              payload["accountID"] as? String == attempt.accountID,
              payload["apiOrigin"] as? String == attempt.apiOrigin else { return ["ok": false] }
        if payload["type"] as? String == "TRACE_IOS_SAVE_PREPARE" {
            guard now >= attempt.startedAt, now <= attempt.expiresAt else { return ["ok": false] }
            var context: [String: Any] = ["attemptID": attempt.id,
                "operationID": UUID().uuidString.lowercased(), "initiatedAt": now]
            if let measurementID = attempt.measurementAttemptID, UUID(uuidString: measurementID) != nil {
                context["setupAttemptID"] = measurementID.lowercased()
                context["setupAttemptExpiresAt"] = attempt.expiresAt
            }
            return ["ok": true, "context": context]
        }
        guard let raw = payload["context"] as? [String: Any],
              let bytes = try? JSONSerialization.data(withJSONObject: raw),
              let context = decode(Context.self, data: bytes),
              let entryID = payload["entryID"] as? String,
              let workKey = payload["workKey"] as? String,
              let source = payload["source"] as? String else { return ["ok": false] }
        // An unrecognised mode is dropped, not refused: the save is still a save.
        let mode = (payload["mode"] as? String).flatMap { Save.modes.contains($0) ? $0 : nil }
        let save = Save(attempt: attempt, context: context, entryID: entryID,
            workKey: workKey, confirmedAt: now, source: source, mode: mode)
        guard save.valid(now: now, apiOrigin: configuredAPIOrigin) else { return ["ok": false] }
        var saves = readSaves(defaults.data(forKey: receiptKey)).filter {
            $0.valid(now: now, apiOrigin: configuredAPIOrigin) && $0.attempt.accountID == attempt.accountID &&
            $0.attempt.apiOrigin == attempt.apiOrigin && $0.attempt.provider == attempt.provider
        }
        if let prior = saves.first(where: { $0.context.operationID == save.context.operationID }) {
            // Native delivery retries neither change identity nor renew evidence.
            return ["ok": prior.entryID == save.entryID && prior.workKey == save.workKey]
        }
        // One current record per story. Preserve the first arrival and the most
        // recent activity in a bounded batch; this is never a total-save count.
        if let index = saves.firstIndex(where: { $0.entryID == save.entryID }) { saves[index] = save }
        else { saves.append(save) }
        if saves.count > maximumSaves { saves.removeSubrange(1..<(saves.count - maximumSaves + 1)) }
        guard let data = try? JSONEncoder().encode(Batch(version: 1, saves: saves)) else { return ["ok": false] }
        defaults.set(data, forKey: receiptKey)
        return ["ok": defaults.data(forKey: receiptKey) == data]
    }
}

/// Local automatic-saving preference evidence. No access, activation or save
/// is implied. Unknown/expired/other-account evidence must never mean off.
enum TraceSafariTrackingPreference {
    static let key = "traceSafariTrackingPreferenceV1"
    static let maxAge: Double = 86_400_000
    struct Snapshot: Codable, Equatable {
        let version: Int
        let accountID: String
        let apiOrigin: String
        let provider: TraceSafariProviderCodec.ImportBinding
        let enabled: Bool
        let setAt: Double
        let observedAt: Double
    }

    static func read(defaults: UserDefaults, accountID: String, apiOrigin: String,
                     provider: TraceSafariProviderCodec.ImportBinding?, now: Double) -> Snapshot? {
        guard let data = defaults.data(forKey: key),
              let value = try? JSONDecoder().decode(Snapshot.self, from: data),
              value.version == 1, value.accountID == accountID, !accountID.isEmpty,
              value.apiOrigin == apiOrigin, TraceSafariOnboardingReceipt.allowsAPIOrigin(apiOrigin),
              let provider, value.provider == provider,
              validTimes(setAt: value.setAt, observedAt: value.observedAt, now: now) else { return nil }
        return value
    }

    private static func validTimes(setAt: Double, observedAt: Double, now: Double) -> Bool {
        now.isFinite && setAt.isFinite && observedAt.isFinite && setAt > 0 &&
        setAt <= observedAt && observedAt <= now && now - observedAt <= maxAge
    }

    static func handle(_ payload: [String: Any], defaults: UserDefaults,
                       provider: TraceSafariProviderCodec.ImportBinding?, now: Double,
                       configuredAPIOrigin: String) -> [String: Any] {
        guard let provider, TraceSafariOnboardingReceipt.allowsAPIOrigin(configuredAPIOrigin),
              payload["apiOrigin"] as? String == configuredAPIOrigin else { return ["ok": false] }
        if payload["type"] as? String == "TRACE_IOS_TRACKING_PREFERENCE_PREPARE" {
            return ["ok": true, "provider": ["sessionID": provider.sessionID, "recordDigest": provider.recordDigest]]
        }
        guard payload["type"] as? String == "TRACE_IOS_TRACKING_PREFERENCE",
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let value = try? JSONDecoder().decode(Snapshot.self, from: data),
              value.version == 1, !value.accountID.isEmpty, value.accountID.utf8.count <= 256,
              value.provider == provider,
              validTimes(setAt: value.setAt, observedAt: value.observedAt, now: now),
              now - value.observedAt <= 300_000 else { return ["ok": false] }
        if let previous = read(defaults: defaults, accountID: value.accountID,
                               apiOrigin: configuredAPIOrigin, provider: provider, now: now),
           previous.setAt > value.setAt || previous.observedAt > value.observedAt ||
           (previous.setAt == value.setAt && previous.enabled != value.enabled) {
            return ["ok": false]
        }
        guard let encoded = try? JSONEncoder().encode(value) else { return ["ok": false] }
        defaults.set(encoded, forKey: key)
        return ["ok": true]
    }
}

/// Whether Trace in Safari is ready to save by itself, as the extension last
/// established it for the app's open cycle. Four things are answered apart:
/// website access, the page scripts, the account and the automatic-saving
/// preference; each is positive, a known blocker or not known, with a reason
/// and the time it was read.
///
/// A report never says how long the reader's website access lasts, that a
/// story was saved, that the next save will work, that an open page was taken
/// over, or anything about Private Browsing. It holds no credential, address
/// or story. A missing, other-cycle or other-provider report is not known; it
/// is never "not ready".
///
/// The app opens a cycle (`startCycle`) before it sends the reader to Safari,
/// and looks at it with `state`: answered, still waiting, or ended. Nothing
/// here expires by age: a report is current for the cycle it answers and
/// history for any other, and it says what held at `observedAt`, not now.
///
/// A cycle belongs to the provider it was opened under. When the app replaces
/// or refreshes that provider the cycle has ended, and no answer will come for
/// it: the provider record names no account, so this side cannot tell a
/// refresh for the same account from another account's provider, and does not
/// carry a cycle across. The app opens a new cycle.
enum TraceSafariReadinessReport {
    static let cycleKey = "traceSafariReadinessCycleV1"
    static let reportKey = "traceSafariReadinessReportV1"
    static let endedKey = "traceSafariReadinessCycleEndedV1"
    static let prepareMessage = "TRACE_IOS_SAFARI_READINESS_PREPARE"
    static let reportMessage = "TRACE_IOS_SAFARI_READINESS_REPORT"

    struct Cycle: Codable, Equatable {
        let version: Int
        let id: String
        let accountID: String
        let apiOrigin: String
        let provider: TraceSafariProviderCodec.ImportBinding
        let startedAt: Double
        func valid(apiOrigin expected: String) -> Bool {
            version == 1 && UUID(uuidString: id) != nil && !accountID.isEmpty && accountID.utf8.count <= 256 &&
            apiOrigin == expected && TraceSafariOnboardingReceipt.allowsAPIOrigin(expected) &&
            startedAt.isFinite && startedAt > 0
        }
    }
    /// Why a cycle is no longer open.
    enum EndReason: String, Codable {
        /// The provider it was opened under is no longer the one issued.
        case providerChanged = "provider_changed"
        /// The app has opened another cycle since.
        case replaced
        /// No cycle is stored.
        case missing
    }
    /// The handler's own word that a cycle ended, left for the app.
    struct Ended: Codable, Equatable {
        let version: Int
        let id: String
        let reason: EndReason
        let at: Double
    }
    /// What the app finds when it looks at a cycle it opened.
    enum CycleState: Equatable {
        /// The extension has answered this cycle.
        case answered(Report)
        /// Open and not yet answered. Not known; never "not ready".
        case waiting
        /// No longer open. No answer will come: open a new cycle.
        case ended(EndReason)
    }
    enum Answer: String, Codable { case positive, blocker, unknown }
    enum Result: String, Codable { case ready, notReady = "not_ready", unknown }
    struct Component: Codable, Equatable {
        let answer: Answer
        /// A short token; see the public contract for the ones in use. An
        /// unrecognised reason leaves the answer as stated.
        let reason: String
        let observedAt: Double
    }
    struct Components: Codable, Equatable {
        let websiteAccess: Component
        let scriptRegistration: Component
        let account: Component
        let automaticSaving: Component
        var all: [Component] { [websiteAccess, scriptRegistration, account, automaticSaving] }
    }
    struct Report: Codable, Equatable {
        let version: Int
        let apiOrigin: String
        let provider: TraceSafariProviderCodec.ImportBinding
        /// The cycle this answers; absent when the app had none open.
        let cycleID: String?
        /// Present only when the account component is positive.
        let accountID: String?
        let observedAt: Double
        let result: Result
        let components: Components
    }

    /// Ready only when all four are positive; not ready when at least one is
    /// a known blocker; otherwise not known. A report whose account changed
    /// while it was read is not known whatever else it found.
    static func result(of components: Components) -> Result {
        if components.account.reason == "changed" { return .unknown }
        let answers = components.all.map(\.answer)
        if answers.allSatisfy({ $0 == .positive }) { return .ready }
        return answers.contains(.blocker) ? .notReady : .unknown
    }

    private static func coherent(_ report: Report, now: Double) -> Bool {
        report.version == 1 && report.result == result(of: report.components) &&
        report.observedAt.isFinite && report.observedAt > 0 && report.observedAt <= now &&
        report.components.all.allSatisfy {
            $0.observedAt.isFinite && $0.observedAt > 0 && $0.observedAt <= report.observedAt &&
            $0.reason.range(of: "^[a-z_]{1,48}$", options: .regularExpression) != nil
        } &&
        (report.components.account.answer == .positive
            ? !(report.accountID ?? "").isEmpty && (report.accountID ?? "").utf8.count <= 256
            : report.accountID == nil) &&
        (report.cycleID == nil || UUID(uuidString: report.cycleID ?? "") != nil)
    }

    /// The app: opens a new cycle for the account and provider it holds. Any
    /// report already stored answers an earlier cycle and becomes history.
    @discardableResult
    static func startCycle(defaults: UserDefaults, accountID: String, apiOrigin: String,
                           provider: TraceSafariProviderCodec.ImportBinding, now: Double) -> Cycle? {
        let cycle = Cycle(version: 1, id: UUID().uuidString.lowercased(), accountID: accountID,
            apiOrigin: apiOrigin, provider: provider, startedAt: now)
        guard cycle.valid(apiOrigin: apiOrigin), let data = try? JSONEncoder().encode(cycle) else { return nil }
        defaults.set(data, forKey: cycleKey)
        return defaults.data(forKey: cycleKey) == data ? cycle : nil
    }

    /// The cycle now open for this provider and environment, if any.
    static func currentCycle(defaults: UserDefaults, apiOrigin: String,
                             provider: TraceSafariProviderCodec.ImportBinding?) -> Cycle? {
        guard let provider, let data = defaults.data(forKey: cycleKey), data.count <= 4096,
              let cycle = try? JSONDecoder().decode(Cycle.self, from: data),
              cycle.valid(apiOrigin: apiOrigin), cycle.provider == provider else { return nil }
        return cycle
    }

    /// The app: the answer to `cycle`, or nil when there is none yet. Nil is
    /// not known. A report for another cycle, provider, environment or
    /// account, or one read before the cycle began, is never returned here.
    static func read(defaults: UserDefaults, cycle: Cycle,
                     provider: TraceSafariProviderCodec.ImportBinding?, now: Double) -> Report? {
        guard let report = latest(defaults: defaults, apiOrigin: cycle.apiOrigin, provider: provider, now: now),
              cycle.valid(apiOrigin: cycle.apiOrigin), cycle.provider == report.provider,
              report.cycleID == cycle.id,
              report.accountID == nil || report.accountID == cycle.accountID,
              report.components.all.allSatisfy({ $0.observedAt >= cycle.startedAt }) else { return nil }
        return report
    }

    /// The app: where a cycle it opened stands. `ended` is said when the
    /// provider is no longer the one the cycle was opened under, when another
    /// cycle has replaced it, or when the handler has recorded its end.
    static func state(defaults: UserDefaults, cycle: Cycle,
                      provider: TraceSafariProviderCodec.ImportBinding?, now: Double) -> CycleState {
        guard let provider, cycle.provider == provider else { return .ended(.providerChanged) }
        if let data = defaults.data(forKey: endedKey), data.count <= 1024,
           let ended = try? JSONDecoder().decode(Ended.self, from: data),
           ended.version == 1, ended.id == cycle.id { return .ended(ended.reason) }
        guard let data = defaults.data(forKey: cycleKey), data.count <= 4096,
              let stored = try? JSONDecoder().decode(Cycle.self, from: data) else { return .ended(.missing) }
        guard stored.id == cycle.id else { return .ended(.replaced) }
        if let report = read(defaults: defaults, cycle: cycle, provider: provider, now: now) {
            return .answered(report)
        }
        return .waiting
    }

    /// A cycle is stored for this environment under a provider that is no
    /// longer the one issued: it has ended, and the app is left word of it.
    private static func noteEndedCycle(defaults: UserDefaults, apiOrigin: String,
                                       provider: TraceSafariProviderCodec.ImportBinding, now: Double) {
        guard let data = defaults.data(forKey: cycleKey), data.count <= 4096,
              let stored = try? JSONDecoder().decode(Cycle.self, from: data),
              stored.valid(apiOrigin: apiOrigin), stored.provider != provider else { return }
        if let previous = defaults.data(forKey: endedKey),
           let ended = try? JSONDecoder().decode(Ended.self, from: previous), ended.id == stored.id { return }
        if let encoded = try? JSONEncoder().encode(
            Ended(version: 1, id: stored.id, reason: .providerChanged, at: now)) {
            defaults.set(encoded, forKey: endedKey)
        }
    }

    /// The last report stored for this provider and environment, whichever
    /// cycle it answered. History: it says what was observed then, not now,
    /// and must never be treated as the answer to a cycle or as current.
    static func latest(defaults: UserDefaults, apiOrigin: String,
                       provider: TraceSafariProviderCodec.ImportBinding?, now: Double) -> Report? {
        guard let provider, let data = defaults.data(forKey: reportKey), data.count <= 8192,
              let report = try? JSONDecoder().decode(Report.self, from: data),
              report.apiOrigin == apiOrigin, TraceSafariOnboardingReceipt.allowsAPIOrigin(apiOrigin),
              report.provider == provider, coherent(report, now: now) else { return nil }
        return report
    }

    /// The extension's two messages. `provider` is the one the app issued,
    /// read now; a report bound to any other is refused.
    static func handle(_ payload: [String: Any], defaults: UserDefaults,
                       provider: TraceSafariProviderCodec.ImportBinding?, now: Double,
                       configuredAPIOrigin: String) -> [String: Any] {
        guard let provider, TraceSafariOnboardingReceipt.allowsAPIOrigin(configuredAPIOrigin),
              payload["apiOrigin"] as? String == configuredAPIOrigin else { return ["ok": false] }
        noteEndedCycle(defaults: defaults, apiOrigin: configuredAPIOrigin, provider: provider, now: now)
        let cycle = currentCycle(defaults: defaults, apiOrigin: configuredAPIOrigin, provider: provider)
        if payload["type"] as? String == prepareMessage {
            var response: [String: Any] = ["ok": true,
                "provider": ["sessionID": provider.sessionID, "recordDigest": provider.recordDigest]]
            if let cycle { response["cycle"] = ["id": cycle.id, "accountID": cycle.accountID] }
            return response
        }
        guard payload["type"] as? String == reportMessage,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let report = try? JSONDecoder().decode(Report.self, from: data),
              report.provider == provider, coherent(report, now: now) else { return ["ok": false] }
        // An answer belongs to the cycle that was open when its reading began.
        // If the app has opened another since, or closed it, the extension is
        // told so and reads again.
        guard report.cycleID == cycle?.id else { return ["ok": false, "error": "stale_cycle"] }
        if let cycle {
            guard report.accountID == nil || report.accountID == cycle.accountID,
                  report.components.all.allSatisfy({ $0.observedAt >= cycle.startedAt })
            else { return ["ok": false] }
        }
        // A later reading is never replaced by an earlier one for the same cycle.
        if let previous = latest(defaults: defaults, apiOrigin: configuredAPIOrigin, provider: provider, now: now),
           previous.cycleID == report.cycleID, previous.observedAt > report.observedAt {
            return ["ok": false]
        }
        // Stored from the decoded value, so nothing the message carried beyond
        // these fields is kept.
        guard let encoded = try? JSONEncoder().encode(report) else { return ["ok": false] }
        defaults.set(encoded, forKey: reportKey)
        return ["ok": defaults.data(forKey: reportKey) == encoded]
    }
}

/// Which story and chapter the reader's latest confirmed reading write was
/// for, so a running app can bring that story up to date at once (beside
/// Safari both apps stay active, so no return to the app would). Identifiers
/// and chapter numbers only: no title, address, page text or selection.
///
/// One record, the latest, bound to the provider the app issued when it
/// arrived; under any other provider it is not current. It is a hint to read
/// again, never evidence that a save happened or of what Trace holds. After
/// each stored record the handler posts `notification` (a Darwin
/// notification, which carries nothing).
enum TraceSafariReadingNow {
    static let message = "TRACE_IOS_READING_NOW"
    static let key = "traceSafariReadingNowV1"
    static let notification = "com.tracefiction.trace.reading-now"
    static let maximumChapter = 100_000
    /// A write time may be this far ahead of the handler's clock (ms)...
    static let allowedSkew: Double = 60_000
    /// ...and at most this old when it arrives (ms).
    static let maximumArrivalAge: Double = 300_000
    private static let required: Set<String> = ["type", "entryId", "workKey", "chapter", "at"]
    private static let optional: Set<String> = ["chapterTotal"]

    struct Record: Codable, Equatable {
        let version: Int
        let provider: TraceSafariProviderCodec.ImportBinding
        /// The Library entry's ID, lowercased.
        let entryID: String
        let workKey: String
        let chapter: Int
        /// Absent when the story's chapter count is not known.
        let chapterTotal: Int?
        /// When the extension had the write confirmed (epoch ms).
        let at: Double
        /// When the handler stored it (epoch ms).
        let receivedAt: Double

        func valid(now: Double) -> Bool {
            version == 1 && UUID(uuidString: provider.sessionID) != nil &&
            provider.recordDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
            entryID.utf8.count == 36 && UUID(uuidString: entryID)?.uuidString.lowercased() == entryID &&
            workKey.utf8.count <= 24 &&
            workKey.range(of: "^(ao3|ffn):[1-9][0-9]{0,19}$", options: .regularExpression) != nil &&
            (1...maximumChapter).contains(chapter) &&
            (chapterTotal.map { (chapter...maximumChapter).contains($0) } ?? true) &&
            at.isFinite && receivedAt.isFinite && at > 0 && receivedAt > 0 &&
            at <= receivedAt + allowedSkew && receivedAt <= now + allowedSkew
        }
    }

    /// A whole number in range, never a boolean or a fraction.
    private static func whole(_ value: Any?, in range: ClosedRange<Int>) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded() == double,
              double >= Double(range.lowerBound), double <= Double(range.upperBound) else { return nil }
        return Int(double)
    }

    /// The extension's message, exactly: the five fields and an optional
    /// chapter count, nothing else; the identifiers bounded and well formed.
    static func decode(_ payload: [String: Any], provider: TraceSafariProviderCodec.ImportBinding,
                       now: Double) -> Record? {
        let keys = Set(payload.keys)
        guard keys.isSuperset(of: required), keys.isSubset(of: required.union(optional)),
              payload["type"] as? String == message,
              let rawEntry = payload["entryId"] as? String, rawEntry.utf8.count == 36,
              let entry = UUID(uuidString: rawEntry)?.uuidString.lowercased(),
              let workKey = payload["workKey"] as? String,
              let chapter = whole(payload["chapter"], in: 1...maximumChapter),
              let atNumber = payload["at"] as? NSNumber, CFGetTypeID(atNumber) != CFBooleanGetTypeID()
        else { return nil }
        var total: Int?
        if keys.contains("chapterTotal") {
            guard let value = whole(payload["chapterTotal"], in: chapter...maximumChapter) else { return nil }
            total = value
        }
        let at = atNumber.doubleValue
        let record = Record(version: 1, provider: provider, entryID: entry, workKey: workKey,
            chapter: chapter, chapterTotal: total, at: at, receivedAt: now)
        guard record.valid(now: now), now - at <= maximumArrivalAge else { return nil }
        return record
    }

    /// The handler: stores the latest record for the issued provider. An
    /// earlier write arriving after a later one is refused.
    static func handle(_ payload: [String: Any], defaults: UserDefaults,
                       provider: TraceSafariProviderCodec.ImportBinding?, now: Double) -> [String: Any] {
        guard let provider, let record = decode(payload, provider: provider, now: now) else { return ["ok": false] }
        if let previous = read(defaults: defaults, provider: provider, now: now), previous.at > record.at {
            return ["ok": false, "error": "stale"]
        }
        guard let encoded = try? JSONEncoder().encode(record) else { return ["ok": false] }
        defaults.set(encoded, forKey: key)
        return ["ok": defaults.data(forKey: key) == encoded]
    }

    /// The app: the latest record, when it was stored under `provider`, the
    /// one the app issued, read now. Nil is not known. Age is the app's call.
    static func read(defaults: UserDefaults, provider: TraceSafariProviderCodec.ImportBinding?,
                     now: Double) -> Record? {
        guard let provider, let data = defaults.data(forKey: key), data.count <= 2048,
              let record = try? JSONDecoder().decode(Record.self, from: data),
              record.provider == provider, record.valid(now: now) else { return nil }
        return record
    }

    /// The app, at sign-out: nothing of the account's reading is left.
    static func clear(defaults: UserDefaults) {
        defaults.removeObject(forKey: key)
    }

    /// Tells a running app that a record was stored. Carries nothing.
    static func post() {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(notification as CFString), nil, nil, true)
    }
}

/// The native messages answered only for the provider the app issued, as it
/// is read at that moment: the save receipt, the automatic-saving preference,
/// the readiness report and what is being read. The handler reads the provider and the paired
/// environment; which of the three answers is decided here, where it can be
/// tested without the extension's host.
enum TraceSafariProviderBoundMessages {
    static let types: Set<String> = [
        "TRACE_IOS_SAVE_PREPARE", "TRACE_IOS_SAVE_CONFIRMED",
        "TRACE_IOS_TRACKING_PREFERENCE_PREPARE", "TRACE_IOS_TRACKING_PREFERENCE",
        TraceSafariReadinessReport.prepareMessage, TraceSafariReadinessReport.reportMessage,
        TraceSafariReadingNow.message,
    ]

    static func respond(to payload: [String: Any], type: String, defaults: UserDefaults,
                        session: TraceSafariProviderCodec.DeviceSession, now: Date,
                        configuredAPIOrigin: String) -> [String: Any] {
        guard types.contains(type) else { return ["ok": false] }
        // A message can never select the provider it is answered for.
        let provider = TraceSafariProviderCodec.importBinding(session: session, now: now)
        let milliseconds = now.timeIntervalSince1970 * 1000
        if type == TraceSafariReadingNow.message {
            return TraceSafariReadingNow.handle(payload, defaults: defaults, provider: provider, now: milliseconds)
        }
        if type.hasPrefix("TRACE_IOS_SAFARI_READINESS") {
            return TraceSafariReadinessReport.handle(payload, defaults: defaults, provider: provider,
                now: milliseconds, configuredAPIOrigin: configuredAPIOrigin)
        }
        if type.hasPrefix("TRACE_IOS_TRACKING_PREFERENCE") {
            return TraceSafariTrackingPreference.handle(payload, defaults: defaults, provider: provider,
                now: milliseconds, configuredAPIOrigin: configuredAPIOrigin)
        }
        return TraceSafariOnboardingReceipt.handle(payload, defaults: defaults, provider: provider,
            now: milliseconds, configuredAPIOrigin: configuredAPIOrigin)
    }
}
