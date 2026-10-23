import CryptoKit
import Foundation

@main
struct TraceSafariHistoryInboxContract {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let origin = "https://development.example.test"
    static let profile = UUID(uuidString: "00000000-0000-4000-8000-000000000011")!
    static let session = TraceSafariProviderCodec.deviceSession(
        sessionId: "00000000-0000-4000-8000-000000000022",
        credential: "trd_v1_" + String(repeating: "A", count: 43), expiresAt: "2030-01-01T00:00:00Z")!
    static let binding = TraceSafariProviderCodec.importBinding(session: session, now: now)!
    static let expected = TraceSafariHistoryInbox.Expectation(accountID: "synthetic-account", accountEpoch: 4,
        apiOrigin: origin, profileID: profile, providerBinding: binding)
    static var assertions = 0
    static func check(_ value: Bool, _ message: String) {
        assertions += 1
        if !value { fatalError("History inbox contract failed: " + message) }
    }

    /// One part: invented AO3 works, the last-visited day on all but those marked for later.
    static func part(_ first: Int, _ count: Int, later: Set<Int> = []) -> Data {
        let items: [[String: Any]] = (first..<(first + count)).map { id in
            var item: [String: Any] = ["src": "ao3", "ctx": "listing", "u": "https://archiveofourown.org/works/\(id)",
                "t": "Synthetic work \(id) café 📚", "a": "Synthetic_Quill"]
            if later.contains(id) { item["ml"] = true } else { item["lv"] = "2026-10-08"; item["vc"] = 3 }
            return item
        }
        return try! JSONSerialization.data(withJSONObject: ["s": "ao3-history", "at": "synthetic", "items": items],
            options: [.sortedKeys])
    }
    static func sha(_ parts: [Data]) -> String {
        var hasher = SHA256()
        for part in parts { hasher.update(data: part) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
    static func prepare(_ parts: [Data], items: Int, id: String = UUID().uuidString.lowercased(),
                        digest: String? = nil) -> [String: Any] {
        ["type": "TRACE_IOS_HISTORY_PREPARE", "protocolVersion": 1, "requestID": id,
         "requestIssuedAtMs": Int64(now.timeIntervalSince1970 * 1_000),
         "accountID": "synthetic-account", "accountEpoch": 4, "apiOrigin": origin,
         "partCount": parts.count, "byteCount": parts.reduce(0) { $0 + $1.count }, "itemCount": items,
         "sha256": digest ?? sha(parts)]
    }

    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("trace-history-inbox-contract-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let inbox = TraceSafariHistoryInbox(containerURL: directory)
        let partsDirectory = directory.appendingPathComponent("TraceNativeHistoryInboxV1")
        func partFiles() -> [String] {
            ((try? FileManager.default.contentsOfDirectory(atPath: partsDirectory.path)) ?? []).filter { $0.hasSuffix(".part") }
        }
        func handle(_ message: [String: Any], _ supplied: TraceSafariProviderCodec.ImportBinding? = binding,
                    _ suppliedProfile: UUID? = profile, _ time: Date = now) -> [String: Any] {
            inbox.handle(message: message, profileID: suppliedProfile, currentProviderBinding: { _ in supplied },
                configuredAPIOrigin: origin, now: time)
        }
        func stage(_ request: [String: Any], _ ready: [String: Any], _ index: Int, _ bytes: Data) -> [String: Any] {
            ["type": "TRACE_IOS_HISTORY_STAGE", "protocolVersion": 1, "requestID": request["requestID"]!,
             "handoffID": ready["handoffID"]!, "partIndex": index, "partBase64": bytes.base64EncodedString()]
        }
        func cancel(_ request: [String: Any], _ ready: [String: Any]) -> [String: Any] {
            ["type": "TRACE_IOS_HISTORY_CANCEL", "protocolVersion": 1, "requestID": request["requestID"]!,
             "handoffID": ready["handoffID"]!]
        }
        func expectFailure(_ error: TraceSafariHistoryInbox.Failure, _ operation: () throws -> Void) {
            do { try operation(); check(false, "operation unexpectedly succeeded") }
            catch let observed as TraceSafariHistoryInbox.Failure { check(observed == error, "expected \(error), got \(observed)") }
            catch { check(false, "unexpected error") }
        }

        // A History in three parts, arriving out of order and once twice.
        let parts = [part(1, 400, later: [7]), part(401, 400), part(801, 11)]
        let request = prepare(parts, items: 811)
        check(handle(request, nil)["error"] as? String == "provider_unavailable", "no provider, no reservation")
        for (key, value) in [("partCount", 0 as Any), ("partCount", 129), ("itemCount", 25_001), ("itemCount", 0),
            ("sha256", "ABC"), ("byteCount", 0), ("byteCount", 3 * 393_216 + 1), ("accountEpoch", -1),
            ("apiOrigin", "https://other.example.test"), ("protocolVersion", true)] {
            var invalid = request; invalid[key] = value
            check(handle(invalid)["error"] as? String == "invalid_request", "invalid " + key)
        }
        var extra = request; extra["credential"] = "not-accepted"
        check(handle(extra)["error"] as? String == "invalid_request", "extra key rejected")
        var old = request; old["requestIssuedAtMs"] = Int64(now.addingTimeInterval(-601).timeIntervalSince1970 * 1_000)
        check(handle(old)["error"] as? String == "expired", "old request rejected")
        let ready = handle(request)
        check(ready["state"] as? String == "prepared", "reserved")
        check(ready["maximumPartBytes"] as? Int == 393_216 && ready["maximumParts"] as? Int == 128 &&
              ready["maximumItems"] as? Int == 25_000, "limits declared")
        let handoff = ready["handoffID"] as! String
        check(handle(request)["handoffID"] as? String == handoff, "idempotent prepare")
        var changed = request; changed["itemCount"] = 812
        check(handle(changed)["error"] as? String == "conflict", "a changed declaration conflicts")
        check(handle(prepare(parts, items: 811))["error"] as? String == "busy", "one History at a time")
        check(try inbox.peek(handoffID: handoff, now: now) == nil, "nothing to open before every part")

        check(handle(stage(request, ready, 2, parts[2]))["state"] as? String == "staging", "part 3 first")
        check(handle(stage(request, ready, 2, parts[2]))["receivedParts"] as? Int == 1, "the same part again is harmless")
        check(handle(stage(request, ready, 2, parts[1]))["error"] as? String == "conflict", "other bytes for a part conflict")
        check(handle(stage(request, ready, 3, parts[1]))["error"] as? String == "invalid_request", "no part past the count")
        check(handle(stage(request, ready, 0, parts[0]), binding, nil)["error"] as? String == "provider_changed", "another profile cannot stage")
        for bad in [
            try! JSONSerialization.data(withJSONObject: ["s": "ao3", "at": "x", "items": [["src": "ao3", "ctx": "listing", "u": "https://archiveofourown.org/works/1", "t": "x"]]]),
            try! JSONSerialization.data(withJSONObject: ["s": "ao3-history", "at": "x", "items": [["src": "ao3", "ctx": "listing", "u": "https://www.fanfiction.net/s/1", "t": "x"]]]),
            try! JSONSerialization.data(withJSONObject: ["s": "ao3-history", "at": "x", "items": [["src": "ao3", "ctx": "listing", "u": "https://archiveofourown.org/works/1", "t": "x", "ml": true, "lv": "2026-01-01"]]]),
            try! JSONSerialization.data(withJSONObject: ["s": "ao3-history", "at": "x", "items": [["src": "ao3", "ctx": "listing", "u": "https://archiveofourown.org/works/1", "t": ""]]]),
            Data(repeating: 0x41, count: 393_217),
        ] {
            check(handle(stage(request, ready, 0, bad))["error"] as? String == "invalid_request", "a part that is not History works is refused")
        }
        check(handle(stage(request, ready, 0, parts[0]))["state"] as? String == "staging", "part 1")
        let last = handle(stage(request, ready, 1, parts[1]))
        check(last["state"] as? String == "ready_to_open" && last["receivedParts"] as? Int == 3, "every part in: ready")
        check(handle(stage(request, ready, 1, parts[1]))["state"] as? String == "ready_to_open", "a late retry stays ready")
        check(partFiles().count == 3, "three part files")
        let pending = try inbox.peek(handoffID: handoff, now: now)
        check(pending?.itemCount == 811 && pending?.accountID == "synthetic-account", "peek: binding and count, no bytes")

        let wrongAccount = TraceSafariHistoryInbox.Expectation(accountID: "other", accountEpoch: 4, apiOrigin: origin,
            profileID: profile, providerBinding: binding)
        expectFailure(.account_changed) { _ = try inbox.claim(handoffID: handoff, expecting: wrongAccount, now: now, currentProviderBinding: { _ in binding }) }
        let otherSession = TraceSafariProviderCodec.deviceSession(sessionId: "00000000-0000-4000-8000-000000000033",
            credential: "trd_v1_" + String(repeating: "B", count: 43), expiresAt: "2030-01-01T00:00:00Z")!
        let other = TraceSafariProviderCodec.importBinding(session: otherSession, now: now)!
        expectFailure(.provider_changed) { _ = try inbox.claim(handoffID: handoff, expecting: expected, now: now, currentProviderBinding: { _ in other }) }
        let claimed = try inbox.claim(handoffID: handoff, expecting: expected, now: now, currentProviderBinding: { _ in binding })
        check(claimed == parts, "the parts, in order, exactly once")
        check(partFiles().isEmpty, "claimed parts are removed")
        expectFailure(.replayed) { _ = try inbox.claim(handoffID: handoff, expecting: expected, now: now, currentProviderBinding: { _ in binding }) }
        check(handle(stage(request, ready, 0, parts[0]))["error"] as? String == "replayed", "a claimed History cannot be staged again")
        check(handle(request)["error"] as? String == "replayed", "or prepared again")
        let stored = try String(contentsOf: partsDirectory.appendingPathComponent("state.json"), encoding: .utf8)
        check(!stored.contains("synthetic-account") && !stored.contains("Synthetic work"), "nothing private is kept after a claim")

        // Parts that do not add up to the declaration end the History.
        let liar = prepare([parts[0]], items: 400, digest: String(repeating: "0", count: 64))
        let liarReady = handle(liar)
        check(handle(stage(liar, liarReady, 0, parts[0]))["error"] as? String == "conflict", "wrong digest refused")
        let liarPending = try inbox.peek(handoffID: liarReady["handoffID"] as! String, now: now)
        check(partFiles().isEmpty && liarPending == nil, "and nothing kept")
        let miscount = prepare([parts[2]], items: 12)
        let miscountReady = handle(miscount)
        check(handle(stage(miscount, miscountReady, 0, parts[2]))["error"] as? String == "conflict", "wrong item count refused")

        // Cancel, expiry and account departure remove the parts.
        let cancelled = prepare([parts[2]], items: 11)
        let cancelledReady = handle(cancelled)
        _ = handle(stage(cancelled, cancelledReady, 0, parts[2]))
        check(handle(cancel(cancelled, cancelledReady))["state"] as? String == "cancelled" && partFiles().isEmpty, "cancel removes parts")
        let expiring = prepare([parts[2]], items: 11)
        let expiringReady = handle(expiring)
        _ = handle(stage(expiring, expiringReady, 0, parts[2]))
        let later = now.addingTimeInterval(TraceSafariHistoryInbox.lifetime + 1)
        check(handle(stage(expiring, expiringReady, 0, parts[2]), binding, profile, later)["error"] as? String == "expired", "an expired History is gone")
        check(partFiles().isEmpty, "with its parts")
        let departing = prepare([parts[2]], items: 11, id: UUID().uuidString.lowercased())
        var departingAtLater = departing; departingAtLater["requestIssuedAtMs"] = Int64(later.timeIntervalSince1970 * 1_000)
        let departingReady = handle(departingAtLater, binding, profile, later)
        _ = handle(stage(departingAtLater, departingReady, 0, parts[2]), binding, profile, later)
        let captured = try inbox.captureCleanup(accountID: "synthetic-account", apiOrigin: origin, createdNoLaterThan: later.addingTimeInterval(60), now: later)
        check(captured?.handoffID == departingReady["handoffID"] as? String, "departure finds the History")
        check(try inbox.purge(handoffID: captured!.handoffID, now: later) && partFiles().isEmpty, "and purges it")

        // A provider replaced while staging ends the History.
        let replaced = prepare([parts[2]], items: 11)
        let replacedAt = later
        var replacedLater = replaced; replacedLater["requestIssuedAtMs"] = Int64(replacedAt.timeIntervalSince1970 * 1_000)
        let replacedReady = handle(replacedLater, binding, profile, replacedAt)
        check(handle(stage(replacedLater, replacedReady, 0, parts[2]), other, profile, replacedAt)["error"] as? String == "provider_changed", "provider change ends staging")
        check(handle(stage(replacedLater, replacedReady, 0, parts[2]), binding, profile, replacedAt)["error"] as? String == "replayed", "for good")

        print("History inbox contract: \(assertions) assertions passed")
    }
}
