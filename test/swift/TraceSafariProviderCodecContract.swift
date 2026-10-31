import Foundation

@main
struct TraceSafariProviderCodecContract {
    static func main() {
        require(
            TraceSafariProviderCodec.parseISO8601Date(
                "2027-08-02T00:00:00.000Z"
            ) != nil,
            "API fractional-seconds timestamp must parse"
        )
        require(
            TraceSafariProviderCodec.parseISO8601Date(
                "2027-08-02T00:00:00Z"
            ) != nil,
            "non-fractional ISO-8601 timestamp must parse"
        )
        require(
            TraceSafariProviderCodec.parseISO8601Date("not-a-date") == nil,
            "malformed timestamp must fail closed"
        )

        let credential = "trd_v1_" + String(repeating: "A", count: 43)
        let session = TraceSafariProviderCodec.deviceSession(
            sessionId: "8A0EAD75-6A99-4380-A175-BB97331F48E7",
            credential: "  \(credential)  ",
            expiresAt: "2027-08-02T00:00:00.000Z"
        )
        require(session?.sessionId == "8a0ead75-6a99-4380-a175-bb97331f48e7", "UUID must normalize")
        require(session?.credential == credential, "credential must trim and validate")
        require(
            TraceSafariProviderCodec.deviceSession(
                sessionId: "not-a-uuid",
                credential: credential,
                expiresAt: "2027-08-02T00:00:00.000Z"
            ) == nil,
            "malformed session ID must fail closed"
        )
        require(
            TraceSafariProviderCodec.deviceSession(
                sessionId: "8a0ead75-6a99-4380-a175-bb97331f48e7",
                credential: "trd_v1_too-short",
                expiresAt: "2027-08-02T00:00:00.000Z"
            ) == nil,
            "malformed credential must fail closed"
        )

        let legacy = Data(
            "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0cmFjZS12MC02LTAifQ.signature_fixture".utf8
        )
        require(
            TraceSafariProviderCodec.isLegacyV060RawAccessToken(legacy),
            "known three-segment v0.6.0 provider must be replaceable"
        )
        require(
            !TraceSafariProviderCodec.isLegacyV060RawAccessToken(Data("corrupt".utf8)),
            "arbitrary corrupt data must remain unavailable"
        )

        checkOnboardingReceipts()
        trackingPreference()
        saveMode()
        readinessReport()
        readinessCycleEnds()
        providerBoundRouting()
        readingNow()
        print("TraceSafariProviderCodec contract passed")
    }

    private static func checkOnboardingReceipts() {
        typealias R = TraceSafariOnboardingReceipt
        let suite = "trace.onboarding.contract." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let provider = TraceSafariProviderCodec.ImportBinding(sessionID: UUID().uuidString,
            recordDigest: String(repeating: "a", count: 64))
        let attempt = R.Attempt(id: UUID().uuidString, accountID: "reader-a",
            apiOrigin: "https://api.tracefiction.com", provider: provider,
            startedAt: 1_700_000_000_000, expiresAt: 1_700_000_010_000)
        defaults.set(try! JSONEncoder().encode(attempt), forKey: R.attemptKey)
        var payload: [String: Any] = ["type": "TRACE_IOS_SAVE_PREPARE",
            "accountID": attempt.accountID, "apiOrigin": attempt.apiOrigin]
        let prepared = R.handle(payload, defaults: defaults, provider: provider, now: attempt.startedAt + 1)
        require(prepared["ok"] as? Bool == true, "Current attempt prepares")
        payload["context"] = prepared["context"]
        payload["type"] = "TRACE_IOS_SAVE_CONFIRMED"
        payload["entryID"] = UUID().uuidString
        payload["workKey"] = "ffn:7038840"
        payload["source"] = "mutation"
        require(R.handle(payload, defaults: defaults, provider: nil, now: attempt.startedAt + 2)["ok"] as? Bool == false, "Missing provider rejects")
        var mismatch = payload; mismatch["accountID"] = "reader-b"
        require(R.handle(mismatch, defaults: defaults, provider: provider, now: attempt.startedAt + 2)["ok"] as? Bool == false, "Wrong account rejects")
        mismatch = payload; mismatch["apiOrigin"] = "https://other.invalid"
        require(R.handle(mismatch, defaults: defaults, provider: provider, now: attempt.startedAt + 2)["ok"] as? Bool == false, "Wrong environment rejects")
        mismatch = payload; mismatch["entryID"] = "invalid"
        require(R.handle(mismatch, defaults: defaults, provider: provider, now: attempt.startedAt + 2)["ok"] as? Bool == false, "Invalid identity rejects")
        // A write begun inside the attempt may finish after its help/window ends.
        let late = attempt.expiresAt + 1000
        require(R.handle(payload, defaults: defaults, provider: provider, now: late)["ok"] as? Bool == true, "Late committed save survives without heartbeat")
        var measured = attempt
        measured.measurementAttemptID = UUID().uuidString.lowercased()
        defaults.set(try! JSONEncoder().encode(measured), forKey: R.attemptKey)
        let prepareMeasurement: [String: Any] = ["type": "TRACE_IOS_SAVE_PREPARE", "accountID": attempt.accountID, "apiOrigin": attempt.apiOrigin]
        let reply = R.handle(prepareMeasurement, defaults: defaults, provider: provider, now: attempt.startedAt + 1)
        let measurementContext = reply["context"] as! [String: Any]
        require(measurementContext["setupAttemptID"] as? String == measured.measurementAttemptID, "Carry opaque measurement ID")
        require(measurementContext["setupAttemptExpiresAt"] as? Double == attempt.expiresAt, "Bound correlation to attempt lifetime")
        require(R.handle(prepareMeasurement, defaults: defaults, provider: provider, now: attempt.expiresAt + 1)["ok"] as? Bool == false, "Expired correlation withheld")
        defaults.set(try! JSONEncoder().encode(attempt), forKey: R.attemptKey)
        let oldReply = R.handle(prepareMeasurement, defaults: defaults, provider: provider, now: attempt.startedAt + 1)
        require((oldReply["context"] as? [String: Any])?["setupAttemptID"] == nil, "Old and flag-off records stay unattributed")
        let original = defaults.data(forKey: R.receiptKey)!
        let next = R.Attempt(id: UUID().uuidString, accountID: attempt.accountID, apiOrigin: attempt.apiOrigin,
            provider: provider, startedAt: late, expiresAt: late + 10000)
        defaults.set(try! JSONEncoder().encode(attempt), forKey: R.previousAttemptKey)
        defaults.set(try! JSONEncoder().encode(next), forKey: R.attemptKey)
        require(R.handle(payload, defaults: defaults, provider: provider, now: late + 1)["ok"] as? Bool == true, "Explicit restart retains old in-flight confirmation")
        defaults.set(try! JSONEncoder().encode(attempt), forKey: R.attemptKey)
        payload["entryID"] = UUID().uuidString
        payload["context"] = ["attemptID": attempt.id, "operationID": UUID().uuidString, "initiatedAt": attempt.startedAt + 2]
        require(R.handle(payload, defaults: defaults, provider: provider, now: late + 1)["ok"] as? Bool == true, "Second confirmation accepted")
        let batch = R.readSaves(defaults.data(forKey: R.receiptKey))
        require(batch.count == 2 && batch[0].entryID == R.readSaves(original)[0].entryID, "Several stories retain first arrival")
        let reopened = UserDefaults(suiteName: suite)!
        let saved = R.readSaves(reopened.data(forKey: R.receiptKey))[0]
        require(saved.valid(now: late + 1), "Exact persisted receipt survives reopening")
        for _ in 0..<40 {
            payload["context"] = ["attemptID": attempt.id, "operationID": UUID().uuidString, "initiatedAt": attempt.startedAt + 2]
            payload["entryID"] = UUID().uuidString
            _ = R.handle(payload, defaults: defaults, provider: provider, now: late + 2)
        }
        let bounded = R.readSaves(defaults.data(forKey: R.receiptKey))
        require(bounded.count == R.maximumSaves && bounded[0].entryID == saved.entryID, "Bounded batch retains first and latest stories")
        require(!saved.valid(now: late + 86_400_001), "Expired receipt is not current evidence")
        payload["type"] = "TRACE_IOS_SAVE_PREPARE"
        require(R.handle(payload, defaults: defaults, provider: provider, now: late)["ok"] as? Bool == false, "Expired authority cannot start another operation")
        let replacement = TraceSafariProviderCodec.ImportBinding(sessionID: provider.sessionID,
            recordDigest: String(repeating: "b", count: 64))
        require(R.handle(payload, defaults: defaults, provider: replacement, now: attempt.startedAt + 1)["ok"] as? Bool == false, "Replacement provider rejects")

        #if TRACE_INTERNAL_REVIEW && TRACE_NATIVE_DEVELOPMENT_API
        let expected = ProcessInfo.processInfo.environment["EXPECTED_DEV_ORIGIN"]!
        require(R.developmentAPIOrigin == expected, "Built bundle metadata selects the exact origin")
        for invalid in ["http://api.example.test", "https://localhost", "https://127.0.0.1", "https://*.example.test", "https://user@api.example.test", "https://api.example.test/", "https://api.example.test?q=1", "https://api.example.test#x", "https://api.example.test:443", "https://bad..test"] {
            require(R.validatedDevelopmentAPIOrigin(invalid) == nil, "Invalid origin rejected")
        }
        if expected.isEmpty { return }
        let dev = R.Attempt(id: UUID().uuidString, accountID: attempt.accountID,
            apiOrigin: R.developmentAPIOrigin, provider: provider,
            startedAt: attempt.startedAt, expiresAt: attempt.expiresAt)
        defaults.set(try! JSONEncoder().encode(dev), forKey: R.attemptKey)
        let prepare: [String: Any] = ["type": "TRACE_IOS_SAVE_PREPARE", "accountID": dev.accountID, "apiOrigin": dev.apiOrigin]
        require(!dev.valid() && dev.valid(apiOrigin: R.developmentAPIOrigin), "Development attempt requires exact environment opt-in")
        require(R.handle(prepare, defaults: defaults, provider: provider, now: dev.startedAt + 1)["ok"] as? Bool == false, "Ordinary production package rejects development")
        let devPrepared = R.handle(prepare, defaults: defaults, provider: provider, now: dev.startedAt + 1, configuredAPIOrigin: R.developmentAPIOrigin)
        require(devPrepared["ok"] as? Bool == true, "Paired development package prepares")
        var confirmed = prepare
        confirmed["type"] = "TRACE_IOS_SAVE_CONFIRMED"
        confirmed["context"] = devPrepared["context"]
        confirmed["entryID"] = UUID().uuidString
        confirmed["workKey"] = "ffn:7038840"
        confirmed["source"] = "mutation"
        require(R.handle(confirmed, defaults: defaults, provider: provider, now: dev.startedAt + 2, configuredAPIOrigin: R.developmentAPIOrigin)["ok"] as? Bool == true, "Development save persists")
        let devSaved = R.readSaves(defaults.data(forKey: R.receiptKey))
        require(devSaved.count == 1 && devSaved[0].valid(now: dev.startedAt + 2, apiOrigin: R.developmentAPIOrigin), "Environment change cannot mix prior production saves")
        require(!devSaved[0].valid(now: dev.startedAt + 2), "Production consumer rejects development save")
        require(!attempt.valid(apiOrigin: R.developmentAPIOrigin), "Development consumer rejects production attempt")
        require(R.handle(prepare, defaults: defaults, provider: provider, now: dev.startedAt + 1, configuredAPIOrigin: "https://other.invalid")["ok"] as? Bool == false, "Unapproved package environment fails closed")
        #else
        require(!R.allowsAPIOrigin("https://api.synthetic.example.test"), "Production ignores bundle development metadata")
        require(!R.allowsAPIOrigin(R.developmentAPIOrigin), "Production rejects fixture development origin")
        #endif
    }

    static func trackingPreference() {
        typealias T = TraceSafariTrackingPreference
        let suite = "tracking-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let provider = TraceSafariProviderCodec.ImportBinding(sessionID: UUID().uuidString,
            recordDigest: String(repeating: "a", count: 64))
        let now = 1_800_000_000_000.0
        let origin = TraceSafariOnboardingReceipt.productionAPIOrigin
        func read(_ account: String = "account-a", _ time: Double = now) -> T.Snapshot? {
            T.read(defaults: defaults, accountID: account, apiOrigin: origin, provider: provider, now: time)
        }
        require(read() == nil, "Missing snapshot is unknown")
        var payload: [String: Any] = ["type": "TRACE_IOS_TRACKING_PREFERENCE", "version": 1,
            "apiOrigin": origin, "accountID": "account-a", "enabled": false,
            "setAt": now - 1000, "observedAt": now,
            "provider": ["sessionID": provider.sessionID, "recordDigest": provider.recordDigest]]
        func write() -> Bool {
            T.handle(payload, defaults: defaults, provider: provider, now: now, configuredAPIOrigin: origin)["ok"] as? Bool == true
        }
        require(write(), "Off snapshot accepted")
        require(read()?.enabled == false, "Explicit off survives readback")
        require(read("account-b") == nil, "Other account is unknown")
        require(read("account-a", now + T.maxAge + 1) == nil, "Stale is unknown")
        require(read("account-a", now - 1) == nil, "Future evidence is unknown")
        require(T.read(defaults: defaults, accountID: "account-a", apiOrigin: origin, provider: nil, now: now) == nil, "Missing provider is unknown")
        payload["enabled"] = true; payload["setAt"] = now
        require(write() && read()?.enabled == true, "Newer on replaces off")
        payload["setAt"] = now - 2000; payload["enabled"] = false
        require(!write() && read()?.enabled == true, "Out of order off cannot replace on")
        payload["setAt"] = now; payload["enabled"] = "false"
        require(!write(), "String boolean rejected")
        payload["enabled"] = 0
        require(!write(), "Numeric boolean rejected")
        payload["enabled"] = false; payload["observedAt"] = now + 1
        require(!write(), "Future timestamps rejected")
        payload["observedAt"] = now; payload["apiOrigin"] = "https://wrong.example"
        require(!write(), "Other environment rejected")
        payload["apiOrigin"] = origin; payload["provider"] = ["sessionID": UUID().uuidString, "recordDigest": provider.recordDigest]
        require(!write(), "Replaced provider rejects in-flight snapshot")
    }

    /// The save record as a reader built before `mode` existed declares it.
    private struct SaveBeforeMode: Codable {
        let attempt: TraceSafariOnboardingReceipt.Attempt
        let context: TraceSafariOnboardingReceipt.Context
        let entryID: String
        let workKey: String
        let confirmedAt: Double
        let source: String
    }
    private struct BatchBeforeMode: Codable { let version: Int; let saves: [SaveBeforeMode] }

    static func saveMode() {
        typealias R = TraceSafariOnboardingReceipt
        let suite = "trace.save-mode.contract." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let provider = TraceSafariProviderCodec.ImportBinding(sessionID: UUID().uuidString,
            recordDigest: String(repeating: "a", count: 64))
        let attempt = R.Attempt(id: UUID().uuidString, accountID: "reader-a",
            apiOrigin: R.productionAPIOrigin, provider: provider,
            startedAt: 1_700_000_000_000, expiresAt: 1_700_000_010_000)
        defaults.set(try! JSONEncoder().encode(attempt), forKey: R.attemptKey)
        let now = attempt.startedAt + 2
        func confirm(_ mode: Any?) -> R.Save {
            var payload: [String: Any] = ["type": "TRACE_IOS_SAVE_CONFIRMED",
                "accountID": attempt.accountID, "apiOrigin": attempt.apiOrigin,
                "context": ["attemptID": attempt.id, "operationID": UUID().uuidString.lowercased(), "initiatedAt": attempt.startedAt + 1],
                "entryID": UUID().uuidString, "workKey": "ao3:123", "source": "mutation"]
            if let mode { payload["mode"] = mode }
            require(R.handle(payload, defaults: defaults, provider: provider, now: now)["ok"] as? Bool == true, "A save is accepted with or without a mode")
            return R.readSaves(defaults.data(forKey: R.receiptKey)).last!
        }
        require(confirm(nil).mode == nil, "A save with no mode established carries none")
        require(confirm("bounded_manual").mode == "bounded_manual", "Manual survives readback")
        require(confirm("normal_automatic").mode == "normal_automatic", "Automatic survives readback")
        require(confirm("always_allowed").mode == nil, "An unrecognised mode is dropped and the save kept")
        require(confirm(true).mode == nil, "A mode that is not a string is dropped")
        require(confirm("normal_automatic").valid(now: now), "A save with a mode is as valid as one without")

        // A reader built before the field existed reads the same bytes.
        let stored = defaults.data(forKey: R.receiptKey)!
        let older = try? JSONDecoder().decode(BatchBeforeMode.self, from: stored)
        require(older?.saves.count == 6, "An older reader decodes every save, ignoring the mode")
        require(older?.saves.last?.workKey == "ao3:123" && older?.saves.last?.source == "mutation",
            "and reads the fields it knows unchanged")
        // And a record written before the field existed is read by this one.
        let before = try! JSONEncoder().encode(BatchBeforeMode(version: 1, saves: older!.saves))
        let read = R.readSaves(before)
        require(read.count == 6 && read.allSatisfy { $0.mode == nil && $0.valid(now: now) },
            "A record with no mode decodes with none")
    }

    static func readinessReport() {
        typealias Q = TraceSafariReadinessReport
        let suite = "trace.readiness.contract." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let provider = TraceSafariProviderCodec.ImportBinding(sessionID: UUID().uuidString,
            recordDigest: String(repeating: "a", count: 64))
        let other = TraceSafariProviderCodec.ImportBinding(sessionID: UUID().uuidString,
            recordDigest: String(repeating: "b", count: 64))
        let origin = TraceSafariOnboardingReceipt.productionAPIOrigin
        let start = 1_800_000_000_000.0
        var now = start + 10_000
        let binding: [String: Any] = ["sessionID": provider.sessionID, "recordDigest": provider.recordDigest]
        func send(_ payload: [String: Any], as current: TraceSafariProviderCodec.ImportBinding? = provider) -> [String: Any] {
            Q.handle(payload, defaults: defaults, provider: current, now: now, configuredAPIOrigin: origin)
        }
        func part(_ answer: String, _ reason: String, at: Double? = nil) -> [String: Any] {
            ["answer": answer, "reason": reason, "observedAt": at ?? now - 100]
        }
        func report(cycle: String?, result: String = "ready", access: [String: Any]? = nil,
                    scripts: [String: Any]? = nil, account: [String: Any]? = nil,
                    saving: [String: Any]? = nil, accountID: String? = "reader-a") -> [String: Any] {
            var payload: [String: Any] = ["type": Q.reportMessage, "version": 1, "apiOrigin": origin,
                "provider": binding, "observedAt": now, "result": result,
                "components": ["websiteAccess": access ?? part("positive", "allowed"),
                    "scriptRegistration": scripts ?? part("positive", "registered"),
                    "account": account ?? part("positive", "connected"),
                    "automaticSaving": saving ?? part("positive", "on")]]
            if let cycle { payload["cycleID"] = cycle }
            if let accountID { payload["accountID"] = accountID }
            return payload
        }
        func ok(_ response: [String: Any]) -> Bool { response["ok"] as? Bool == true }
        let prepare: [String: Any] = ["type": Q.prepareMessage, "apiOrigin": origin]

        // With no provider nothing is prepared and nothing is stored.
        require(!ok(send(prepare, as: nil)), "No provider: nothing to bind a report to")
        require(!ok(send(report(cycle: nil), as: nil)) && defaults.data(forKey: Q.reportKey) == nil, "No provider: nothing stored")

        // Before the app has opened a cycle: a report is kept as history only.
        let bare = send(prepare)
        require(ok(bare) && bare["cycle"] == nil, "Prepare names the provider, and no cycle when none is open")
        require((bare["provider"] as? [String: String])?["sessionID"] == provider.sessionID, "Prepare returns the issued provider")
        require(ok(send(report(cycle: nil))), "A report with no cycle open is stored")
        require(Q.latest(defaults: defaults, apiOrigin: origin, provider: provider, now: now)?.result == .ready, "and can be read as history")

        // The app opens a cycle. What was stored before answers no cycle.
        let cycle = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: provider, now: start)!
        require(Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now) == nil, "History is not the answer to a new cycle")
        let prepared = send(prepare)
        let named = prepared["cycle"] as? [String: String]
        require(named?["id"] == cycle.id && named?["accountID"] == "reader-a", "Prepare names the open cycle and its account")
        require(send(report(cycle: nil))["error"] as? String == "stale_cycle", "A report for no cycle is not accepted while one is open")
        require(send(report(cycle: UUID().uuidString.lowercased()))["error"] as? String == "stale_cycle", "A report for another cycle is not accepted as current")
        require(Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now) == nil, "and nothing answers the cycle yet")

        require(ok(send(report(cycle: cycle.id))), "The answer to the open cycle is stored")
        let read = Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now)
        require(read?.result == .ready && read?.accountID == "reader-a", "and read back as ready for that account")
        require(read?.components.websiteAccess.reason == "allowed", "with each component's reason")
        require(Q.read(defaults: defaults, cycle: cycle, provider: other, now: now) == nil, "Another provider reads nothing")
        require(Q.read(defaults: defaults, cycle: cycle, provider: nil, now: now) == nil, "No provider reads nothing")
        require(Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now + 365 * 86_400_000) != nil, "Nothing expires by age: it answers its cycle for as long as that cycle is open")
        require(Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now - 1) == nil, "A report from the future is not read")

        // Every blocker is kept, and the result has to follow from the parts.
        now += 1_000
        let blocked = report(cycle: cycle.id, result: "not_ready",
            access: part("blocker", "partly_allowed"), scripts: part("blocker", "registration_failed"),
            saving: part("unknown", "unreadable"))
        require(ok(send(blocked)), "Not ready with two blockers and one unknown is stored")
        let notReady = Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now)
        require(notReady?.result == .notReady && notReady?.components.websiteAccess.answer == .blocker &&
            notReady?.components.scriptRegistration.reason == "registration_failed" &&
            notReady?.components.automaticSaving.answer == .unknown, "Every cause is kept")
        now += 1_000
        require(ok(send(report(cycle: cycle.id, result: "unknown", saving: part("unknown", "unreadable")))), "One unknown and no blocker is unknown")
        require(!ok(send(report(cycle: cycle.id, result: "ready", saving: part("unknown", "unreadable")))), "Ready with an unknown part is refused")
        require(!ok(send(report(cycle: cycle.id, result: "unknown", access: part("blocker", "not_allowed")))), "A blocker cannot be reported as unknown")
        require(!ok(send(report(cycle: cycle.id, result: "not_ready"))), "Four positives cannot be reported as not ready")
        require(Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now)?.result == .unknown, "A refused report replaces nothing")

        // An account that changed while the report was read: unknown, whatever else.
        now += 1_000
        require(ok(send(report(cycle: cycle.id, result: "unknown", access: part("blocker", "not_allowed"),
            account: part("unknown", "changed"), accountID: nil))), "An account change is unknown even beside a blocker")
        require(!ok(send(report(cycle: cycle.id, result: "not_ready", access: part("blocker", "not_allowed"),
            account: part("unknown", "changed"), accountID: nil))), "and is never reported as not ready")

        // The account the report names.
        require(!ok(send(report(cycle: cycle.id, accountID: nil))), "A connected account must be named")
        require(!ok(send(report(cycle: cycle.id, accountID: "reader-b"))), "Another account's report does not answer this cycle")
        require(!ok(send(report(cycle: cycle.id, result: "not_ready", account: part("blocker", "reconnect_required"), accountID: "reader-a"))), "No account is named unless it is connected")
        require(ok(send(report(cycle: cycle.id, result: "not_ready", account: part("blocker", "reconnect_required"), accountID: nil))), "A refused account is a blocker with no account named")

        // Bound to the provider, the environment and the cycle's start.
        now += 1_000
        require(!ok(send(report(cycle: cycle.id), as: other)), "A replaced provider refuses an in-flight report")
        var wrong = report(cycle: cycle.id); wrong["apiOrigin"] = "https://wrong.example"
        require(!ok(send(wrong)), "Another environment is refused")
        wrong = report(cycle: cycle.id); wrong["version"] = 2
        require(!ok(send(wrong)), "Another version is refused")
        require(!ok(send(report(cycle: cycle.id, access: part("positive", "allowed", at: start - 1)))), "A reading older than the cycle is not its answer")
        require(!ok(send(report(cycle: cycle.id, access: part("positive", "allowed", at: now + 1)))), "A part read after the report is refused")
        wrong = report(cycle: cycle.id); wrong["observedAt"] = now + 1
        require(!ok(send(wrong)), "A report from the future is refused")
        require(!ok(send(report(cycle: cycle.id, access: part("positive", "Always Allow")))), "A reason is a short token, never free text")
        require(!ok(send(report(cycle: cycle.id, access: part("yes", "allowed")))), "An answer outside the three is refused")

        // Only the fields of the contract are kept.
        var extra = report(cycle: cycle.id)
        extra["grantedOrigins"] = ["https://www.fanfiction.net/*"]; extra["duration"] = "always"
        extra["credential"] = "trd_v1_" + String(repeating: "A", count: 43); extra["workKey"] = "ao3:123"
        require(ok(send(extra)), "Extra fields do not make a report invalid")
        let kept = String(data: defaults.data(forKey: Q.reportKey)!, encoding: .utf8)!
        for forbidden in ["fanfiction", "duration", "always", "trd_v1_", "ao3:123", "credential"] {
            require(!kept.contains(forbidden), "Nothing beyond the contract is stored")
        }

        // A later reading is not replaced by an earlier one.
        var earlier = report(cycle: cycle.id, result: "not_ready", access: part("positive", "allowed", at: now - 700),
            scripts: part("positive", "registered", at: now - 700), account: part("positive", "connected", at: now - 700),
            saving: part("blocker", "off", at: now - 700))
        earlier["observedAt"] = now - 500
        require(!ok(send(earlier)), "An earlier reading does not replace a later one")
        require(Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now)?.result == .ready, "The later one stands")

        // The app opens another cycle: the old answer is history, and an
        // answer still in flight for the old cycle is not accepted.
        let next = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: provider, now: now)!
        require(next.id != cycle.id, "Each cycle has its own identifier")
        require(Q.read(defaults: defaults, cycle: next, provider: provider, now: now) == nil, "The earlier cycle's answer does not answer the new one")
        require(Q.latest(defaults: defaults, apiOrigin: origin, provider: provider, now: now)?.cycleID == cycle.id, "It remains readable as history")
        now += 1_000
        require(send(report(cycle: cycle.id))["error"] as? String == "stale_cycle", "An answer for the old cycle is told so")
        require(ok(send(report(cycle: next.id))) && Q.read(defaults: defaults, cycle: next, provider: provider, now: now)?.result == .ready, "and the new cycle's own answer is accepted")
        require(Q.read(defaults: defaults, cycle: cycle, provider: provider, now: now) == nil, "The old cycle no longer has a current answer")

        // The message exactly as the extension's background sends it.
        let fixtureURL = URL(fileURLWithPath: "test/fixtures/safari-readiness-report-v1.json")
        let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: Any]
        let sentProvider = fixture["provider"] as! [String: String]
        let sender = TraceSafariProviderCodec.ImportBinding(sessionID: sentProvider["sessionID"]!,
            recordDigest: sentProvider["recordDigest"]!)
        let sentAt = fixture["observedAt"] as! Double
        let sentCycle = Q.Cycle(version: 1, id: fixture["cycleID"] as! String, accountID: fixture["accountID"] as! String,
            apiOrigin: origin, provider: sender, startedAt: sentAt - 5_000)
        let fixtureSuite = "trace.readiness.fixture." + UUID().uuidString
        let fixtureDefaults = UserDefaults(suiteName: fixtureSuite)!
        defer { fixtureDefaults.removePersistentDomain(forName: fixtureSuite) }
        fixtureDefaults.set(try! JSONEncoder().encode(sentCycle), forKey: Q.cycleKey)
        require(Q.handle(fixture, defaults: fixtureDefaults, provider: sender, now: sentAt + 1,
            configuredAPIOrigin: origin)["ok"] as? Bool == true, "The extension's own message is accepted")
        let fromExtension = Q.read(defaults: fixtureDefaults, cycle: sentCycle, provider: sender, now: sentAt + 1)
        require(fromExtension?.result == .ready && fromExtension?.accountID == "account-a" &&
            fromExtension?.components.scriptRegistration.reason == "registered", "and read back as the app reads it")

        // A cycle opened under a provider that has since been replaced is not open.
        require(Q.currentCycle(defaults: defaults, apiOrigin: origin, provider: other) == nil, "A cycle belongs to its provider")
        require((send(prepare, as: other))["cycle"] == nil, "and is not named to another")
        require(Q.startCycle(defaults: defaults, accountID: "", apiOrigin: origin, provider: provider, now: now) == nil, "A cycle needs an account")
        require(Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: "https://wrong.example", provider: provider, now: now) == nil, "and an approved environment")
    }

    /// A cycle the app opened, as the app sees it: waiting, answered, or ended.
    static func readinessCycleEnds() {
        typealias Q = TraceSafariReadinessReport
        let suite = "trace.readiness.cycle." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let session = UUID().uuidString.lowercased()
        let provider = TraceSafariProviderCodec.ImportBinding(sessionID: session, recordDigest: String(repeating: "a", count: 64))
        // The same device session with a refreshed credential: a new digest.
        let refreshed = TraceSafariProviderCodec.ImportBinding(sessionID: session, recordDigest: String(repeating: "c", count: 64))
        let origin = TraceSafariOnboardingReceipt.productionAPIOrigin
        let start = 1_800_000_000_000.0
        var now = start + 1_000
        func message(_ type: String, cycle: String?, by binding: TraceSafariProviderCodec.ImportBinding) -> [String: Any] {
            func part(_ reason: String) -> [String: Any] { ["answer": "positive", "reason": reason, "observedAt": now - 10] }
            var payload: [String: Any] = ["type": type, "version": 1, "apiOrigin": origin,
                "provider": ["sessionID": binding.sessionID, "recordDigest": binding.recordDigest],
                "accountID": "reader-a", "observedAt": now, "result": "ready",
                "components": ["websiteAccess": part("allowed"), "scriptRegistration": part("registered"),
                    "account": part("connected"), "automaticSaving": part("on")]]
            if let cycle { payload["cycleID"] = cycle }
            return payload
        }
        func send(_ payload: [String: Any], as current: TraceSafariProviderCodec.ImportBinding) -> [String: Any] {
            Q.handle(payload, defaults: defaults, provider: current, now: now, configuredAPIOrigin: origin)
        }

        let cycle = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: provider, now: start)!
        require(Q.state(defaults: defaults, cycle: cycle, provider: provider, now: now) == .waiting, "A cycle just opened is waiting, which is not known")
        require(send(message(Q.reportMessage, cycle: cycle.id, by: provider), as: provider)["ok"] as? Bool == true, "It is answered")
        guard case .answered(let answer) = Q.state(defaults: defaults, cycle: cycle, provider: provider, now: now) else {
            return require(false, "An answered cycle reads as answered")
        }
        require(answer.result == .ready, "with its report")

        // The app refreshes the provider. The cycle was opened under the old one.
        now += 1_000
        require(Q.state(defaults: defaults, cycle: cycle, provider: refreshed, now: now) == .ended(.providerChanged),
            "The app is told the cycle ended, not left waiting or shown the old answer")
        require(Q.state(defaults: defaults, cycle: cycle, provider: nil, now: now) == .ended(.providerChanged), "No provider ends it too")
        require(Q.read(defaults: defaults, cycle: cycle, provider: refreshed, now: now) == nil, "and no report answers it")
        // The handler, asked under the new provider, names no cycle and leaves word that the old one ended.
        let prepared = send(["type": Q.prepareMessage, "apiOrigin": origin], as: refreshed)
        require(prepared["ok"] as? Bool == true && prepared["cycle"] == nil, "Prepare names no cycle under a provider it was not opened under")
        let word = try? JSONDecoder().decode(Q.Ended.self, from: defaults.data(forKey: Q.endedKey) ?? Data())
        require(word?.id == cycle.id && word?.reason == .providerChanged && word?.at == now, "The handler records that the cycle ended, and why")
        require(send(message(Q.reportMessage, cycle: cycle.id, by: refreshed), as: refreshed)["error"] as? String == "stale_cycle",
            "An answer naming the ended cycle is not stored as its answer")
        require(send(message(Q.reportMessage, cycle: nil, by: refreshed), as: refreshed)["ok"] as? Bool == true, "Reports go on, as history")
        require(Q.state(defaults: defaults, cycle: cycle, provider: refreshed, now: now) == .ended(.providerChanged), "History does not reopen the cycle")
        require(Q.latest(defaults: defaults, apiOrigin: origin, provider: refreshed, now: now)?.cycleID == nil, "and history names no cycle")

        // The app opens a new cycle under the provider it now holds.
        now += 1_000
        let next = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: refreshed, now: now)!
        require(Q.state(defaults: defaults, cycle: next, provider: refreshed, now: now) == .waiting, "A new cycle is waiting, whatever history holds")
        require(Q.state(defaults: defaults, cycle: cycle, provider: provider, now: now) == .ended(.providerChanged),
            "The old one stays ended, for the reason the handler recorded")
        let third = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: refreshed, now: now)!
        require(Q.state(defaults: defaults, cycle: next, provider: refreshed, now: now) == .ended(.replaced),
            "A cycle the app has opened another over is replaced")
        _ = third
        let reopened = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: refreshed, now: now)!
        require(reopened.id != next.id, "Each cycle is its own")
        now += 1_000
        require(send(message(Q.reportMessage, cycle: reopened.id, by: refreshed), as: refreshed)["ok"] as? Bool == true, "and the newest one is answered")
        guard case .answered = Q.state(defaults: defaults, cycle: reopened, provider: refreshed, now: now) else {
            return require(false, "The newest cycle reads as answered")
        }
        defaults.removeObject(forKey: Q.cycleKey)
        require(Q.state(defaults: defaults, cycle: reopened, provider: refreshed, now: now) == .ended(.missing), "A cycle that is no longer stored has ended")
    }

    /// The handler's routing of the messages bound to the provider, driven as
    /// the handler drives it: a device session, the shared defaults, a clock.
    static func providerBoundRouting() {
        typealias M = TraceSafariProviderBoundMessages
        typealias Q = TraceSafariReadinessReport
        let suite = "trace.provider-bound." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let origin = TraceSafariOnboardingReceipt.productionAPIOrigin
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var ms: Double { now.timeIntervalSince1970 * 1000 }
        let session = TraceSafariProviderCodec.deviceSession(sessionId: UUID().uuidString,
            credential: "trd_v1_" + String(repeating: "A", count: 43), expiresAt: "2099-01-01T00:00:00.000Z")!
        let issued = TraceSafariProviderCodec.importBinding(session: session, now: now)!
        func route(_ payload: [String: Any], session current: TraceSafariProviderCodec.DeviceSession? = nil) -> [String: Any] {
            M.respond(to: payload, type: payload["type"] as? String ?? "", defaults: defaults,
                session: current ?? session, now: now, configuredAPIOrigin: origin)
        }
        func report(cycle: String?, provider: TraceSafariProviderCodec.ImportBinding? = nil, at: Double? = nil) -> [String: Any] {
            let observed = at ?? ms
            func part(_ reason: String) -> [String: Any] { ["answer": "positive", "reason": reason, "observedAt": observed - 10] }
            let binding = provider ?? issued
            var payload: [String: Any] = ["type": Q.reportMessage, "version": 1, "apiOrigin": origin,
                "provider": ["sessionID": binding.sessionID, "recordDigest": binding.recordDigest],
                "accountID": "reader-a", "observedAt": observed, "result": "ready",
                "components": ["websiteAccess": part("allowed"), "scriptRegistration": part("registered"),
                    "account": part("connected"), "automaticSaving": part("on")]]
            if let cycle { payload["cycleID"] = cycle }
            return payload
        }
        func stored() -> Q.Report? { Q.latest(defaults: defaults, apiOrigin: origin, provider: issued, now: ms) }

        // Prepare: the provider is the one read by the handler, never one a message names.
        var prepare: [String: Any] = ["type": Q.prepareMessage, "apiOrigin": origin,
            "provider": ["sessionID": UUID().uuidString, "recordDigest": String(repeating: "f", count: 64)]]
        var prepared = route(prepare)
        require(prepared["ok"] as? Bool == true, "Prepare is routed to the readiness report")
        require((prepared["provider"] as? [String: String])?["recordDigest"] == issued.recordDigest, "and answers with the issued provider")
        require(prepared["cycle"] == nil, "naming no cycle before the app opens one")
        prepare["apiOrigin"] = "https://wrong.example"
        require(route(prepare)["ok"] as? Bool == false, "Another environment is refused at the route")
        prepare["apiOrigin"] = origin

        let cycle = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: issued, now: ms)!
        prepared = route(prepare)
        require((prepared["cycle"] as? [String: String])?["id"] == cycle.id, "Prepare names the cycle the app opened")

        // Report: stored for the issued provider and the open cycle.
        now += 2
        let first = report(cycle: cycle.id)
        require(route(first)["ok"] as? Bool == true && stored()?.cycleID == cycle.id, "A report for the issued provider and open cycle is stored")
        let kept = defaults.data(forKey: Q.reportKey)

        // A provider the app never issued.
        let never = TraceSafariProviderCodec.ImportBinding(sessionID: UUID().uuidString, recordDigest: String(repeating: "e", count: 64))
        now += 2
        require(route(report(cycle: cycle.id, provider: never))["ok"] as? Bool == false, "A report naming a provider the app never issued is refused")
        // A cycle the app never issued.
        require(route(report(cycle: UUID().uuidString.lowercased()))["error"] as? String == "stale_cycle", "A report naming a cycle the app never opened is refused")
        require(route(report(cycle: "not-a-cycle"))["ok"] as? Bool == false, "as is one naming no cycle at all")
        require(defaults.data(forKey: Q.reportKey) == kept, "and none of them changes what is stored")

        // A newer report, then a replay of the first one.
        require(route(report(cycle: cycle.id))["ok"] as? Bool == true, "A later report replaces the earlier")
        let newer = defaults.data(forKey: Q.reportKey)
        require(route(first)["ok"] as? Bool == false && defaults.data(forKey: Q.reportKey) == newer, "A replay of the earlier report does not")

        // The app opens another cycle. The old report is replayed with the new cycle's id.
        now += 2
        let next = Q.startCycle(defaults: defaults, accountID: "reader-a", apiOrigin: origin, provider: issued, now: ms)!
        var replay = first
        replay["cycleID"] = next.id
        require(route(replay)["ok"] as? Bool == false, "An old report replayed under the current cycle's id is refused: it was read before the cycle began")
        require(route(first)["error"] as? String == "stale_cycle", "and under its own id it is for a cycle since replaced")
        require(Q.state(defaults: defaults, cycle: next, provider: issued, now: ms) == .waiting, "The new cycle is still unanswered")
        now += 2
        require(route(report(cycle: next.id))["ok"] as? Bool == true, "until its own answer arrives")

        // A session that has expired issues nothing.
        let expired = TraceSafariProviderCodec.deviceSession(sessionId: session.sessionId,
            credential: session.credential, expiresAt: "2020-01-01T00:00:00.000Z")!
        require(route(prepare, session: expired)["ok"] as? Bool == false, "An expired provider prepares nothing")
        require(route(report(cycle: next.id), session: expired)["ok"] as? Bool == false, "and stores nothing")

        // The other provider-bound messages are routed as before.
        let preference = route(["type": "TRACE_IOS_TRACKING_PREFERENCE_PREPARE", "apiOrigin": origin])
        require(preference["ok"] as? Bool == true && preference["cycle"] == nil &&
            (preference["provider"] as? [String: String])?["sessionID"] == issued.sessionID, "The preference's prepare still answers as the preference")
        require(route(["type": "TRACE_IOS_SAVE_PREPARE", "accountID": "reader-a", "apiOrigin": origin])["ok"] as? Bool == false,
            "The save receipt still answers as the save receipt: no attempt, no context")
        require(route(["type": "TRACE_IOS_EXTENSION_HEARTBEAT"])["ok"] as? Bool == false, "A message that is not provider-bound is not routed here")
        require(M.types.count == 7, "Seven messages are bound to the provider")
    }

    /// What is being read: the extension's message, exactly, stored for the
    /// provider the app issued and read back only under it.
    static func readingNow() {
        typealias M = TraceSafariProviderBoundMessages
        typealias R = TraceSafariReadingNow
        let suite = "trace.reading-now." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let origin = TraceSafariOnboardingReceipt.productionAPIOrigin
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var ms: Double { now.timeIntervalSince1970 * 1000 }
        let session = TraceSafariProviderCodec.deviceSession(sessionId: UUID().uuidString,
            credential: "trd_v1_" + String(repeating: "B", count: 43), expiresAt: "2099-01-01T00:00:00.000Z")!
        let issued = TraceSafariProviderCodec.importBinding(session: session, now: now)!
        func route(_ payload: [String: Any], session current: TraceSafariProviderCodec.DeviceSession? = nil) -> [String: Any] {
            M.respond(to: payload, type: payload["type"] as? String ?? "", defaults: defaults,
                session: current ?? session, now: now, configuredAPIOrigin: origin)
        }
        let entry = "9F1C2B3A-4D5E-4F60-8A7B-1C2D3E4F5A6B"
        func message(_ changes: [String: Any?] = [:]) -> [String: Any] {
            var payload: [String: Any] = ["type": R.message, "entryId": entry, "workKey": "ao3:123456",
                "chapter": 4, "chapterTotal": 12, "at": ms - 500]
            for (key, value) in changes { payload[key] = value }
            return payload
        }
        func stored() -> R.Record? { R.read(defaults: defaults, provider: issued, now: ms) }

        // Valid: stored for the issued provider, identifiers normalised.
        require(M.types.contains(R.message), "What is being read is bound to the provider")
        require(route(message())["ok"] as? Bool == true, "A well-formed reading message is stored")
        let first = stored()
        require(first?.entryID == entry.lowercased() && first?.workKey == "ao3:123456" &&
            first?.chapter == 4 && first?.chapterTotal == 12 && first?.at == ms - 500 && first?.receivedAt == ms,
            "It reads back exactly, the entry lowercased, with the time it arrived")
        now += 1
        require(route(message(["chapterTotal": nil]))["ok"] as? Bool == true && stored()?.chapterTotal == nil,
            "An unknown chapter count is left out, not refused")
        require(route(message(["chapter": 5.0, "chapterTotal": 12.0]))["ok"] as? Bool == true && stored()?.chapter == 5,
            "A whole number sent as a double is a whole number")
        now += 1
        require(route(message(["workKey": "ffn:7038840", "chapter": R.maximumChapter, "chapterTotal": R.maximumChapter]))["ok"] as? Bool == true,
            "A FanFiction.net story at the largest chapter is stored")

        // Invalid: each refused, and none changes what is stored.
        now += 1
        let kept = defaults.data(forKey: R.key)
        let invalid: [(String, [String: Any?])] = [
            ("a missing entry", ["entryId": nil]),
            ("a missing story", ["workKey": nil]),
            ("a missing chapter", ["chapter": nil]),
            ("a missing time", ["at": nil]),
            ("an entry that is not a UUID", ["entryId": "not-an-entry-id-but-thirty-six-chars"]),
            ("an entry UUID without hyphens", ["entryId": "9F1C2B3A4D5E4F608A7B1C2D3E4F5A6B"]),
            ("an entry of another type", ["entryId": 12]),
            ("another archive", ["workKey": "wattpad:123"]),
            ("a story with a leading zero", ["workKey": "ao3:0123"]),
            ("a story address", ["workKey": "https://archiveofourown.org/works/123456"]),
            ("chapter zero", ["chapter": 0]),
            ("a negative chapter", ["chapter": -1]),
            ("a fractional chapter", ["chapter": 2.5]),
            ("a chapter as text", ["chapter": "4"]),
            ("a chapter as a boolean", ["chapter": true]),
            ("a count below the chapter", ["chapterTotal": 3]),
            ("a count as a boolean", ["chapterTotal": false]),
            ("a null count", ["chapterTotal": NSNull()]),
            ("a time as text", ["at": "1800000000000"]),
            ("a time as a boolean", ["at": true]),
            ("a time that is not finite", ["at": Double.infinity]),
            ("a time far in the future", ["at": ms + R.allowedSkew + 1_000]),
            ("a time too old to be news", ["at": ms - R.maximumArrivalAge - 1]),
            ("another message type", ["type": "TRACE_IOS_SAVE_CONFIRMED"]),
        ]
        for (name, changes) in invalid {
            var payload = message(changes)
            if name == "another message type" {
                require(TraceSafariReadingNow.handle(payload, defaults: defaults, provider: issued, now: ms)["ok"] as? Bool == false,
                    "Refused: \(name)")
                continue
            }
            payload["type"] = R.message
            require(route(payload)["ok"] as? Bool == false, "Refused: \(name)")
        }
        // Oversized: bounded strings and ints.
        require(route(message(["entryId": entry + "0"]))["ok"] as? Bool == false, "Refused: an entry one character too long")
        require(route(message(["workKey": "ao3:" + String(repeating: "9", count: 21)]))["ok"] as? Bool == false,
            "Refused: a story number over twenty digits")
        require(route(message(["workKey": "ao3:1" + String(repeating: " ", count: 4096)]))["ok"] as? Bool == false,
            "Refused: a padded story")
        require(route(message(["chapter": R.maximumChapter + 1, "chapterTotal": nil]))["ok"] as? Bool == false,
            "Refused: a chapter over the largest")
        require(route(message(["chapterTotal": R.maximumChapter + 1]))["ok"] as? Bool == false,
            "Refused: a count over the largest")
        require(route(message(["chapter": Double(Int.max)]))["ok"] as? Bool == false, "Refused: an enormous chapter")
        // Extra fields: nothing beyond the message's own.
        for extra in ["title", "url", "text", "selection", "accountID", "apiOrigin", "provider", "progress"] {
            require(route(message([extra: "x"]))["ok"] as? Bool == false, "Refused: an extra field (\(extra))")
        }
        require(defaults.data(forKey: R.key) == kept, "No refused message changes what is stored")

        // Order: a later write is never replaced by an earlier one.
        now += 1
        require(route(message(["at": ms - 100]))["ok"] as? Bool == true, "A later write replaces the record")
        let later = defaults.data(forKey: R.key)
        require(route(message(["at": ms - 200]))["error"] as? String == "stale" && defaults.data(forKey: R.key) == later,
            "An earlier write arriving late is refused")

        // Equal times: the one that arrives last is kept.
        now += 1
        let same = ms - 50
        require(route(message(["at": same, "chapter": 6, "chapterTotal": nil]))["ok"] as? Bool == true, "A write is stored")
        require(route(message(["at": same, "chapter": 7, "chapterTotal": nil]))["ok"] as? Bool == true && stored()?.chapter == 7,
            "Another with the same time, arriving after it, replaces it")

        // Concurrent writes in one process: the latest time is what remains.
        now += 1
        let base = ms - 1_000
        DispatchQueue.concurrentPerform(iterations: 64) { index in
            _ = R.handle(message(["at": base + Double(index), "chapter": 1 + index, "chapterTotal": nil]),
                defaults: defaults, provider: issued, now: ms)
        }
        require(stored()?.at == base + 63 && stored()?.chapter == 64, "Of writes handled at once, the latest is kept")

        // Provider: another provider never reads it, and an expired session stores nothing.
        let other = TraceSafariProviderCodec.ImportBinding(sessionID: UUID().uuidString, recordDigest: String(repeating: "c", count: 64))
        require(R.read(defaults: defaults, provider: other, now: ms) == nil, "Another provider's app reads nothing")
        require(R.read(defaults: defaults, provider: nil, now: ms) == nil, "No provider, nothing read")
        let expired = TraceSafariProviderCodec.deviceSession(sessionId: session.sessionId,
            credential: session.credential, expiresAt: "2020-01-01T00:00:00.000Z")!
        require(route(message(), session: expired)["ok"] as? Bool == false, "An expired provider stores nothing")
        let replaced = TraceSafariProviderCodec.deviceSession(sessionId: UUID().uuidString,
            credential: "trd_v1_" + String(repeating: "C", count: 43), expiresAt: "2099-01-01T00:00:00.000Z")!
        let replacement = TraceSafariProviderCodec.importBinding(session: replaced, now: now)!
        now += 1
        require(route(message(["at": ms - 300]), session: replaced)["ok"] as? Bool == true,
            "A replaced provider's first record is stored, whatever the old one held")
        require(stored() == nil && R.read(defaults: defaults, provider: replacement, now: ms)?.at == ms - 300,
            "and only the replacement reads it")

        // Stored bytes: a tampered record is not read; clear removes it.
        defaults.set(Data(#"{"version":1}"#.utf8), forKey: R.key)
        require(R.read(defaults: defaults, provider: replacement, now: ms) == nil, "A malformed record is not read")
        require(route(message(), session: replaced)["ok"] as? Bool == true, "and is replaced by the next message")
        R.clear(defaults: defaults)
        require(defaults.data(forKey: R.key) == nil && R.read(defaults: defaults, provider: replacement, now: ms) == nil,
            "Clear leaves nothing of the reading")
    }

    private static func require(
        _ condition: @autoclosure () -> Bool,
        _ message: String
    ) {
        guard condition() else {
            fputs("TraceSafariProviderCodec contract failed: \(message)\n", stderr)
            exit(1)
        }
    }
}
