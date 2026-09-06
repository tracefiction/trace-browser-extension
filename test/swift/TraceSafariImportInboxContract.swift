import Foundation

@main
struct TraceSafariImportInboxContract {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let origin = "https://development.example.test"
    static let profile = UUID(uuidString: "00000000-0000-4000-8000-000000000011")!
    static let session = TraceSafariProviderCodec.deviceSession(
        sessionId: "00000000-0000-4000-8000-000000000022",
        credential: "trd_v1_" + String(repeating: "A", count: 43), expiresAt: "2030-01-01T00:00:00Z")!
    static let binding = TraceSafariProviderCodec.importBinding(session: session, now: now)!
    static let expected = TraceSafariImportInbox.Expectation(accountID: "synthetic-account", accountEpoch: 4,
        apiOrigin: origin, profileID: profile, providerBinding: binding)
    static var assertions = 0
    static func check(_ value: Bool, _ message: String) {
        assertions += 1
        if !value { fatalError("Inbox contract failed: " + message) }
    }
    static func prepare(_ id: String = UUID().uuidString.lowercased()) -> [String: Any] {
        ["type": "TRACE_IOS_IMPORT_PREPARE", "protocolVersion": 1, "requestID": id,
         "requestIssuedAtMs": Int64(now.timeIntervalSince1970 * 1_000),
         "accountID": "synthetic-account", "accountEpoch": 4, "apiOrigin": origin]
    }
    static func payload(_ note: String = "Synthetic café 📚") -> Data {
        try! JSONSerialization.data(withJSONObject: ["s": "ao3", "at": "synthetic",
            "items": [["src": "ao3", "u": "https://archiveofourown.org/works/123", "notes": note]]],
            options: [.sortedKeys])
    }
    static func main() throws {
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "claim" {
            let inbox = TraceSafariImportInbox(containerURL: URL(fileURLWithPath: CommandLine.arguments[2]))
            do {
                _ = try inbox.claim(handoffID: CommandLine.arguments[3], expecting: expected, now: now, currentProviderBinding: { _ in binding })
                print("claimed")
            } catch TraceSafariImportInbox.Failure.replayed { print("replayed") }
              catch { print("failed") }
            return
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("trace-inbox-contract-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let inbox = TraceSafariImportInbox(containerURL: directory)
        func handle(_ message: [String: Any], _ supplied: TraceSafariProviderCodec.ImportBinding? = binding,
                    _ suppliedProfile: UUID? = profile, _ time: Date = now) -> [String: Any] {
            inbox.handle(message: message, profileID: suppliedProfile, currentProviderBinding: { _ in supplied },
                configuredAPIOrigin: origin, now: time)
        }
        func stage(_ request: [String: Any], _ ready: [String: Any], _ bytes: Data = payload()) -> [String: Any] {
            ["type": "TRACE_IOS_IMPORT_STAGE", "protocolVersion": 1, "requestID": request["requestID"]!,
                "handoffID": ready["handoffID"]!, "payloadBase64": bytes.base64EncodedString()]
        }
        func expectFailure(_ error: TraceSafariImportInbox.Failure, _ operation: () throws -> Void) {
            do { try operation(); check(false, "operation unexpectedly succeeded") }
            catch let observed as TraceSafariImportInbox.Failure { check(observed == error, "expected typed failure") }
            catch { check(false, "unexpected error") }
        }
        var request = prepare()
        let missing = handle(request, nil)["error"] as? String
        check(missing == "provider_unavailable", "missing provider: " + (missing ?? "none"))
        for (key, value) in [("protocolVersion", true as Any), ("accountEpoch", 1.5),
            ("accountEpoch", -1), ("requestID", UUID().uuidString.uppercased()),
            ("accountID", String(repeating: "a", count: 257)), ("apiOrigin", "https://other.example.test")] {
            var invalid = request; invalid[key] = value
            check(handle(invalid)["error"] as? String == "invalid_request", "invalid field " + key)
        }
        var extra = request; extra["credential"] = "not-accepted"
        check(handle(extra)["error"] as? String == "invalid_request", "extra credential rejected")
        var old = request; old["requestIssuedAtMs"] = Int64(now.addingTimeInterval(-601).timeIntervalSince1970 * 1000)
        check(handle(old)["error"] as? String == "expired", "old request rejected")
        let ready = handle(request)
        check(ready["state"] as? String == "prepared", "reservation")
        let handoff = ready["handoffID"] as! String
        check(handle(request)["handoffID"] as? String == handoff, "idempotent prepare")
        check(handle(prepare())["error"] as? String == "busy", "one bounded slot")
        check(try inbox.peek(handoffID: handoff, now: now) == nil, "prepared bytes never exposed")
        let body = stage(request, ready)
        check(handle(body, binding, nil)["error"] as? String == "provider_changed", "profile absence cannot substitute")
        var crossSource = try JSONSerialization.jsonObject(with: payload()) as! [String: Any]
        crossSource["items"] = [["src": "ao3", "u": "https://www.fanfiction.net/s/123/1"]]
        check(handle(stage(request, ready, try JSONSerialization.data(withJSONObject: crossSource)))["error"] as? String == "invalid_request", "cross-source URL rejected")
        check(handle(stage(request, ready, payload(String(repeating: "a", count: 524_288))))["error"] as? String == "invalid_request", "oversize rejected")
        var malformed = body; malformed["payloadBase64"] = payload().base64EncodedString() + "\n"
        check(handle(malformed)["error"] as? String == "invalid_request", "noncanonical base64 rejected")
        check(handle(body)["state"] as? String == "ready_to_open", "staged")
        check(handle(body)["state"] as? String == "ready_to_open", "identical bytes idempotent")
        check(handle(stage(request, ready, payload("changed")))["error"] as? String == "conflict", "changed retry rejected")
        let pending = try inbox.peek(handoffID: handoff, now: now)
        check(pending?.providerBinding == binding && pending?.profileID == profile, "native bindings retained")
        let wrongAccount = TraceSafariImportInbox.Expectation(accountID: "another-synthetic", accountEpoch: 4,
            apiOrigin: origin, profileID: profile, providerBinding: binding)
        expectFailure(.account_changed) { _ = try inbox.claim(handoffID: handoff, expecting: wrongAccount, now: now, currentProviderBinding: { _ in binding }) }
        check(try inbox.claim(handoffID: handoff, expecting: expected, now: now, currentProviderBinding: { _ in binding }) == payload(), "one-use exact UTF-8 bytes")
        expectFailure(.replayed) { _ = try inbox.claim(handoffID: handoff, expecting: expected, now: now, currentProviderBinding: { _ in binding }) }
        check(handle(body)["error"] as? String == "replayed", "claimed stage cannot replay")
        check(handle(request)["error"] as? String == "replayed", "claimed prepare cannot replay")
        let stored = try String(contentsOf: directory.appendingPathComponent("TraceNativeImportInboxV1.json"), encoding: .utf8)
        check(!stored.contains("payloadBase64") && !stored.contains("payloadSHA256") && !stored.contains("synthetic-account"), "claim deletes payload and account metadata")
        check(!stored.contains(session.credential), "credential never persisted")
        check(try inbox.purge(handoffID: handoff, now: now) == false, "purge never restores terminal slot")
        request = prepare(); let rotationReady = handle(request)
        let other = TraceSafariProviderCodec.importBinding(session: .init(sessionId: session.sessionId,
            credential: "trd_v1_" + String(repeating: "B", count: 43), expiresAt: session.expiresAt), now: now)!
        check(other != binding, "same-session credential rotation changes fingerprint")
        check(handle(stage(request, rotationReady), other)["error"] as? String == "provider_changed", "rotation rejects stage")
        check(handle(stage(request, rotationReady))["error"] as? String == "replayed", "provider mismatch terminal")
        request = prepare(); let cancelReady = handle(request)
        let cancel: [String: Any] = ["type": "TRACE_IOS_IMPORT_CANCEL", "protocolVersion": 1,
            "requestID": request["requestID"]!, "handoffID": cancelReady["handoffID"]!]
        check(handle(cancel, nil)["state"] as? String == "cancelled", "exact cancel works after provider loss")
        check(handle(stage(request, cancelReady))["error"] as? String == "replayed", "cancel one-use")
        request = prepare(); let expireReady = handle(request)
        check(handle(stage(request, expireReady), binding, profile, now.addingTimeInterval(601))["error"] as? String == "expired", "reservation expiry")
        check(handle(request, binding, profile, now.addingTimeInterval(601))["error"] as? String == "expired", "expired replay cannot reserve again")
        request = prepare(); let raceReady = handle(request)
        check(handle(stage(request, raceReady))["ok"] as? Bool == true, "race fixture staged")
        let children: [(Process, Pipe)] = (0..<2).map { _ in
            let process = Process(); let output = Pipe()
            process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            process.arguments = ["claim", directory.path, raceReady["handoffID"] as! String]
            process.standardOutput = output
            return (process, output)
        }
        for (process, _) in children { try process.run() }
        let outcomes = children.map { process, output in
            process.waitUntilExit()
            return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
        }.sorted()
        check(outcomes == ["claimed", "replayed"], "two processes deliver bytes exactly once")
        var future = prepare()
        future["requestIssuedAtMs"] = Int64(now.addingTimeInterval(29).timeIntervalSince1970 * 1_000)
        let futureReady = handle(future)
        check(futureReady["ok"] as? Bool == true, "small clock skew accepted")
        _ = try inbox.purge(handoffID: futureReady["handoffID"] as! String, now: now)
        check(handle(future, binding, profile, now.addingTimeInterval(601))["error"] as? String == "replayed", "future-issued request cannot replay after reservation TTL")
        check(handle(future, binding, profile, now.addingTimeInterval(631))["error"] as? String == "expired", "old request stays expired after tombstone cleanup")
        let maximum = payload(String(repeating: "a", count: 524_288 - payload("").count))
        check(maximum.count == 524_288, "maximum payload fixture exact")
        request = prepare(); let maximumReady = handle(request)
        check(handle(stage(request, maximumReady, maximum))["state"] as? String == "ready_to_open", "exact 512 KiB payload staged locally")
        let maximumID = maximumReady["handoffID"] as! String
        expectFailure(.provider_changed) {
            _ = try inbox.claim(handoffID: maximumID, expecting: expected, now: now, currentProviderBinding: { _ in other })
        }
        expectFailure(.provider_unavailable) {
            _ = try inbox.claim(handoffID: maximumID, expecting: expected, now: now, currentProviderBinding: { _ in nil })
        }
        check(try inbox.claim(handoffID: maximumID, expecting: expected, now: now, currentProviderBinding: { _ in binding }) == maximum,
            "exact maximum bytes claimed after in-transaction provider check")
        request = prepare(); let purgedReady = handle(request)
        _ = handle(stage(request, purgedReady))
        let cleanupCutoff = now.addingTimeInterval(10)
        let invalidation = try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin, createdNoLaterThan: cleanupCutoff, now: now)
        _ = try inbox.purge(handoffID: invalidation!.handoffID, now: now)
        check(handle(request)["error"] as? String == "replayed", "account invalidation purges without replay")
        request = prepare(); let cleanupReady = handle(request)
        let captured = try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin, createdNoLaterThan: cleanupCutoff, now: now)
        check(captured?.handoffID == cleanupReady["handoffID"] as? String, "cleanup includes prepared unopened reservation")
        check(try inbox.captureCleanup(accountID: "another-synthetic", apiOrigin: origin, createdNoLaterThan: cleanupCutoff, now: now) == nil, "cleanup capture cannot target other account")
        check(try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: "https://other.example.test", createdNoLaterThan: cleanupCutoff, now: now) == nil, "cleanup capture requires exact API origin")
        _ = handle(stage(request, cleanupReady))
        check(try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin, createdNoLaterThan: cleanupCutoff, now: now) == captured, "cleanup identity unchanged after staging")
        let beforeRead = try Data(contentsOf: directory.appendingPathComponent("TraceNativeImportInboxV1.json"))
        check(try inbox.peek(handoffID: captured!.handoffID, now: now.addingTimeInterval(601)) == nil, "expired payload cannot be peeked")
        check(try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin, createdNoLaterThan: cleanupCutoff, now: now.addingTimeInterval(601)) == captured, "departure can clean expired serialized bytes")
        check(try Data(contentsOf: directory.appendingPathComponent("TraceNativeImportInboxV1.json")) == beforeRead, "peek and cleanup capture do not rewrite file")
        try Data("synthetic unreadable inbox".utf8).write(to: directory.appendingPathComponent("TraceNativeImportInboxV1.json"), options: .atomic)
        expectFailure(.storage_unavailable) {
            _ = try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin,
                createdNoLaterThan: cleanupCutoff, now: now.addingTimeInterval(20))
        }
        try beforeRead.write(to: directory.appendingPathComponent("TraceNativeImportInboxV1.json"), options: .atomic)
        check(try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin,
            createdNoLaterThan: cleanupCutoff, now: now.addingTimeInterval(20)) == captured,
            "fixed cutoff still captures original entry after storage recovers")
        check(try inbox.purge(handoffID: captured!.handoffID, now: now), "captured lifecycle cleanup purges once")
        let replacementRequest = prepare(); let replacementReady = handle(replacementRequest)
        check(replacementReady["ok"] as? Bool == true, "replacement can reserve")
        check(try inbox.purge(handoffID: captured!.handoffID, now: now) == false, "repeated old cleanup cannot purge replacement")
        check(try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin, createdNoLaterThan: cleanupCutoff, now: now)?.handoffID == replacementReady["handoffID"] as? String, "replacement same-account generation retained")
        _ = try inbox.purge(handoffID: replacementReady["handoffID"] as! String, now: now)
        for replacementBinding in [binding, other] {
            let laterRequest = prepare()
            let laterTime = now.addingTimeInterval(20)
            let laterReady = handle(laterRequest, replacementBinding, profile, laterTime)
            check(laterReady["state"] as? String == "prepared", "later same-account replacement prepared")
            check(try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin,
                createdNoLaterThan: cleanupCutoff, now: laterTime) == nil,
                "departure cutoff excludes later preparation even when request issued earlier")
            check(handle(stage(laterRequest, laterReady), replacementBinding, profile, laterTime)["ok"] as? Bool == true,
                "excluded prepared replacement remains stageable")
            let laterBytes = try Data(contentsOf: directory.appendingPathComponent("TraceNativeImportInboxV1.json"))
            check(try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin,
                createdNoLaterThan: cleanupCutoff, now: now.addingTimeInterval(30)) == nil,
                "same or changed provider replacement stays outside original cutoff after staging")
            check(try Data(contentsOf: directory.appendingPathComponent("TraceNativeImportInboxV1.json")) == laterBytes,
                "cutoff mismatch preserves replacement bytes")
            let freshCapture = try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin,
                createdNoLaterThan: now.addingTimeInterval(30), now: now.addingTimeInterval(30))
            check(freshCapture?.handoffID == laterReady["handoffID"] as? String,
                "a later departure can capture its own replacement")
            _ = try inbox.purge(handoffID: freshCapture!.handoffID, now: now.addingTimeInterval(30))
        }
        // Fill the bounded tombstone ledger. IDs are not forgotten early to
        // make space for retries that could otherwise revive a consumed import.
        try? FileManager.default.removeItem(at: directory.appendingPathComponent("TraceNativeImportInboxV1.json"))
        for _ in 0..<64 {
            let next = prepare(); let accepted = handle(next)
            check(accepted["ok"] as? Bool == true, "ledger slot admitted")
            _ = try inbox.purge(handoffID: accepted["handoffID"] as! String, now: now)
        }
        check(handle(prepare())["error"] as? String == "busy", "ledger capacity fails closed")
        print("TraceSafariImportInbox contract: \(assertions) assertions passed (synthetic only; cross-process one-use verified)")
    }
}
