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
