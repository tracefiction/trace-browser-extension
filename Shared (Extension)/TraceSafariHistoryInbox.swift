import Foundation
import CoreFoundation
import CryptoKit

/// Cross-process, one-use transport for a reader's whole AO3 History, from
/// Trace in Safari to the Trace app for review. It is the import inbox's
/// sibling (TraceSafariImportInbox.swift) with the same account, profile and
/// provider fences, for a payload that can be far larger than one page: the
/// History arrives in parts, each its own bounded JSON document, checked as it
/// is staged and, once every part is in, against the digest PREPARE declared.
/// This type never reads credentials or makes network requests.
final class TraceSafariHistoryInbox {
    static let contract = "trace-native-history-import-v1"
    /// One part's decoded bytes, at most. Its Base64 then fits the native
    /// message bound the import inbox uses.
    static let maximumPartBytes = 393_216
    static let maximumParts = 128
    static let maximumItems = 25_000
    static let maximumTotalBytes = maximumPartBytes * maximumParts
    static let maximumPartItems = 1_000
    /// Staging a large History takes many messages; the reader then opens Trace.
    static let lifetime: TimeInterval = 1_800
    static let source = "ao3-history"
    static let messageTypes: Set<String> = [
        "TRACE_IOS_HISTORY_PREPARE", "TRACE_IOS_HISTORY_STAGE", "TRACE_IOS_HISTORY_CANCEL"
    ]
    typealias Failure = TraceSafariImportInbox.Failure
    typealias Expectation = TraceSafariImportInbox.Expectation
    typealias CleanupIdentity = TraceSafariImportInbox.CleanupIdentity

    struct Pending: Equatable, Sendable {
        let handoffID: String
        let accountID: String
        let accountEpoch: Int64
        let apiOrigin: String
        let profileID: UUID?
        let providerBinding: TraceSafariProviderCodec.ImportBinding
        let expiresAt: Date
        let itemCount: Int
    }
    private struct Entry: Codable {
        var state: String
        let requestID: String
        let handoffID: String
        let requestIssuedAtMs: Int64
        let createdAt: Date
        let expiresAt: Date
        let accountID: String
        let accountEpoch: Int64
        let apiOrigin: String
        let profileID: UUID?
        let providerBinding: TraceSafariProviderCodec.ImportBinding
        let partCount: Int
        let byteCount: Int
        let itemCount: Int
        let sha256: String
        /// Each received part's digest and item count, by index.
        var parts: [Part?]
        var pending: Pending {
            Pending(handoffID: handoffID, accountID: accountID, accountEpoch: accountEpoch,
                apiOrigin: apiOrigin, profileID: profileID, providerBinding: providerBinding,
                expiresAt: expiresAt, itemCount: itemCount)
        }
    }
    private struct Part: Codable, Equatable {
        let sha256: String
        let byteCount: Int
        let itemCount: Int
    }
    private struct Tombstone: Codable {
        let requestID: String
        let handoffID: String
        let expiresAt: Date
    }
    private struct Document: Codable {
        let version: Int
        var entry: Entry?
        var terminal: [Tombstone]
    }
    private let directoryURL: URL
    private let stateURL: URL
    init(containerURL: URL) {
        directoryURL = containerURL.appendingPathComponent("TraceNativeHistoryInboxV1", isDirectory: true)
        stateURL = directoryURL.appendingPathComponent("state.json")
    }

    /// Exact keys and bounded messages are checked before inspecting payloads.
    /// `configuredAPIOrigin` is immutable paired-package configuration, never a
    /// defaults value or a value accepted from this message.
    func handle(message: [String: Any], profileID: UUID?,
                currentProviderBinding: (Date) -> TraceSafariProviderCodec.ImportBinding?,
                configuredAPIOrigin: String, now: Date) -> [String: Any] {
        let type = message["type"] as? String ?? "TRACE_IOS_HISTORY_PREPARE"
        func failure(_ error: Failure) -> [String: Any] {
            ["type": Self.messageTypes.contains(type) ? type : "TRACE_IOS_HISTORY_PREPARE",
             "protocolVersion": 1, "ok": false, "error": error.rawValue]
        }
        do {
            let allowed: Set<String> = type == "TRACE_IOS_HISTORY_PREPARE"
                ? ["type", "protocolVersion", "requestID", "requestIssuedAtMs", "accountID", "accountEpoch",
                   "apiOrigin", "partCount", "byteCount", "itemCount", "sha256"]
                : type == "TRACE_IOS_HISTORY_STAGE"
                    ? ["type", "protocolVersion", "requestID", "handoffID", "partIndex", "partBase64"]
                    : ["type", "protocolVersion", "requestID", "handoffID"]
            guard Self.messageTypes.contains(type), Set(message.keys) == allowed,
                  (message["partBase64"] as? String)?.utf8.count ?? 0 <= Self.base64Length(Self.maximumPartBytes),
                  (message["accountID"] as? String)?.utf8.count ?? 0 <= 256,
                  Self.integer(message["protocolVersion"]) == 1,
                  let requestID = Self.identifier(message["requestID"]),
                  JSONSerialization.isValidJSONObject(message),
                  let size = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes]).count,
                  size <= 704 * 1_024,
                  TraceSafariImportInbox.validOrigin(configuredAPIOrigin) else { throw Failure.invalid_request }
            return try coordinated(now: now) { document, now in
                do {
                    let providerBinding = currentProviderBinding(now)
                    if document.terminal.contains(where: { $0.requestID == requestID }) { throw Failure.replayed }
                    if type == "TRACE_IOS_HISTORY_PREPARE" {
                        guard let issued = Self.integer(message["requestIssuedAtMs"]),
                              let epoch = Self.integer(message["accountEpoch"]), epoch >= 0,
                              let account = message["accountID"] as? String, !account.isEmpty,
                              let origin = message["apiOrigin"] as? String, origin == configuredAPIOrigin,
                              let partCount = Self.integer(message["partCount"]).map(Int.init),
                              (1...Self.maximumParts).contains(partCount),
                              let byteCount = Self.integer(message["byteCount"]).map(Int.init),
                              (1...partCount * Self.maximumPartBytes).contains(byteCount),
                              let itemCount = Self.integer(message["itemCount"]).map(Int.init),
                              (1...Self.maximumItems).contains(itemCount),
                              let digest = message["sha256"] as? String, Self.hexDigest(digest) else {
                            throw Failure.invalid_request
                        }
                        let issuedDate = Date(timeIntervalSince1970: Double(issued) / 1_000)
                        guard issuedDate > now.addingTimeInterval(-TraceSafariImportInbox.lifetime),
                              issuedDate <= now.addingTimeInterval(30) else { throw Failure.expired }
                        guard let providerBinding else { throw Failure.provider_unavailable }
                        if let entry = document.entry {
                            guard entry.requestID == requestID else { throw Failure.busy }
                            guard entry.profileID == profileID,
                                  entry.providerBinding == providerBinding else { throw Failure.provider_changed }
                            guard entry.accountID == account, entry.accountEpoch == epoch,
                                  entry.apiOrigin == origin, entry.requestIssuedAtMs == issued,
                                  entry.partCount == partCount, entry.byteCount == byteCount,
                                  entry.itemCount == itemCount, entry.sha256 == digest else { throw Failure.conflict }
                            return Self.ack(type: type, entry: entry)
                        }
                        guard document.terminal.count < 64 else { throw Failure.busy }
                        let entry = Entry(state: "prepared", requestID: requestID,
                            handoffID: UUID().uuidString.lowercased(), requestIssuedAtMs: issued,
                            createdAt: now, expiresAt: now.addingTimeInterval(Self.lifetime),
                            accountID: account, accountEpoch: epoch, apiOrigin: origin,
                            profileID: profileID, providerBinding: providerBinding,
                            partCount: partCount, byteCount: byteCount, itemCount: itemCount,
                            sha256: digest, parts: Array(repeating: nil, count: partCount))
                        document.entry = entry
                        return Self.ack(type: type, entry: entry)
                    }
                    guard let handoffID = Self.identifier(message["handoffID"]) else { throw Failure.invalid_request }
                    if document.terminal.contains(where: { $0.handoffID == handoffID }) { throw Failure.replayed }
                    guard var entry = document.entry,
                          entry.requestID == requestID, entry.handoffID == handoffID else { throw Failure.expired }
                    guard entry.profileID == profileID else { throw Failure.provider_changed }
                    if type == "TRACE_IOS_HISTORY_CANCEL" {
                        finish(&document, entry: entry)
                        return ["type": type, "protocolVersion": 1, "ok": true, "state": "cancelled"]
                    }
                    guard let providerBinding else { throw Failure.provider_unavailable }
                    guard entry.providerBinding == providerBinding,
                          entry.apiOrigin == configuredAPIOrigin else {
                        finish(&document, entry: entry)
                        throw Failure.provider_changed
                    }
                    guard let index = Self.integer(message["partIndex"]).map(Int.init),
                          (0..<entry.partCount).contains(index),
                          let encoded = message["partBase64"] as? String,
                          let bytes = Self.decodedPart(encoded),
                          let items = Self.partItems(bytes) else { throw Failure.invalid_request }
                    let part = Part(sha256: Self.digest(bytes), byteCount: bytes.count, itemCount: items)
                    if let received = entry.parts[index] {
                        // The same part again (a retried message) is accepted; other bytes are not.
                        guard received == part else { throw Failure.conflict }
                    } else {
                        guard entry.state != "staged" else { throw Failure.conflict }
                        try writePart(bytes, handoffID: handoffID, index: index)
                        entry.parts[index] = part
                    }
                    if entry.state != "staged", entry.parts.allSatisfy({ $0 != nil }) {
                        // Every part is in: they must add up to what PREPARE declared.
                        let received = entry.parts.compactMap { $0 }
                        guard received.reduce(0, { $0 + $1.byteCount }) == entry.byteCount,
                              received.reduce(0, { $0 + $1.itemCount }) == entry.itemCount,
                              try wholeDigest(handoffID: handoffID, partCount: entry.partCount) == entry.sha256 else {
                            finish(&document, entry: entry)
                            throw Failure.conflict
                        }
                        entry.state = "staged"
                    } else if entry.state == "prepared" {
                        entry.state = "staging"
                    }
                    document.entry = entry
                    return Self.ack(type: type, entry: entry)
                } catch let error as Failure { return failure(error) }
            }
        } catch let error as Failure { return failure(error) }
          catch { return failure(.storage_unavailable) }
    }

    func peek(handoffID: String, now: Date) throws -> Pending? {
        guard Self.identifier(handoffID) != nil else { throw Failure.invalid_request }
        return try coordinated(now: now, persist: false) { document, currentTime in
            guard let entry = document.entry, entry.handoffID == handoffID,
                  entry.state == "staged", entry.expiresAt > currentTime else { return nil }
            return entry.pending
        }
    }

    /// Consumes the History once, before delivering its parts in order.
    func claim(handoffID: String, expecting expected: Expectation, now: Date,
               currentProviderBinding: (Date) -> TraceSafariProviderCodec.ImportBinding?) throws -> [Data] {
        guard Self.identifier(handoffID) != nil else { throw Failure.invalid_request }
        return try coordinated(now: now) { document, currentTime in
            guard let current = currentProviderBinding(currentTime) else { throw Failure.provider_unavailable }
            guard current == expected.providerBinding else { throw Failure.provider_changed }
            if document.terminal.contains(where: { $0.handoffID == handoffID }) { throw Failure.replayed }
            guard let entry = document.entry, entry.handoffID == handoffID,
                  entry.state == "staged" else { throw Failure.expired }
            guard entry.accountID == expected.accountID, entry.accountEpoch == expected.accountEpoch,
                  entry.apiOrigin == expected.apiOrigin else { throw Failure.account_changed }
            guard entry.profileID == expected.profileID,
                  entry.providerBinding == expected.providerBinding else { throw Failure.provider_changed }
            var parts: [Data] = []
            var hasher = SHA256()
            for index in 0..<entry.partCount {
                guard let recorded = entry.parts[index],
                      let bytes = try? Data(contentsOf: partURL(handoffID: handoffID, index: index)),
                      bytes.count == recorded.byteCount, Self.digest(bytes) == recorded.sha256 else {
                    finish(&document, entry: entry)
                    throw Failure.invalid_request
                }
                hasher.update(data: bytes)
                parts.append(bytes)
            }
            guard Self.hex(hasher.finalize()) == entry.sha256 else {
                finish(&document, entry: entry)
                throw Failure.invalid_request
            }
            finish(&document, entry: entry)
            return parts
        }
    }

    /// Same freeze-then-purge rules as the import inbox's, for account departure.
    func captureCleanup(accountID: String, apiOrigin: String,
                        createdNoLaterThan: Date, now: Date) throws -> CleanupIdentity? {
        guard !accountID.isEmpty, accountID.utf8.count <= 256,
              TraceSafariImportInbox.validOrigin(apiOrigin) else { throw Failure.invalid_request }
        return try coordinated(now: now, persist: false) { document, _ in
            guard let entry = document.entry, entry.accountID == accountID,
                  entry.apiOrigin == apiOrigin, entry.createdAt <= createdNoLaterThan else { return nil }
            return CleanupIdentity(handoffID: entry.handoffID)
        }
    }

    @discardableResult
    func purge(handoffID: String, now: Date) throws -> Bool {
        guard Self.identifier(handoffID) != nil else { throw Failure.invalid_request }
        return try coordinated(now: now) { document, _ in
            guard let entry = document.entry, entry.handoffID == handoffID else { return false }
            finish(&document, entry: entry)
            return true
        }
    }

    // MARK: - Files

    private func partURL(handoffID: String, index: Int) -> URL {
        directoryURL.appendingPathComponent("\(handoffID)-\(index).part")
    }

    private func writePart(_ bytes: Data, handoffID: String, index: Int) throws {
        let url = partURL(handoffID: handoffID, index: index)
        try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        var mutableURL = url
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try mutableURL.setResourceValues(resources)
    }

    private func wholeDigest(handoffID: String, partCount: Int) throws -> String {
        var hasher = SHA256()
        for index in 0..<partCount {
            hasher.update(data: try Data(contentsOf: partURL(handoffID: handoffID, index: index)))
        }
        return Self.hex(hasher.finalize())
    }

    /// Ends an entry: its parts are removed and its IDs can never be used again.
    private func finish(_ document: inout Document, entry: Entry) {
        document.terminal.append(Tombstone(requestID: entry.requestID,
            handoffID: entry.handoffID, expiresAt: max(entry.expiresAt,
                Date(timeIntervalSince1970: Double(entry.requestIssuedAtMs) / 1_000)
                    .addingTimeInterval(TraceSafariImportInbox.lifetime))))
        document.entry = nil
        removeParts(except: nil)
    }

    /// Part files of anything but `keep` are private bytes no entry owns.
    private func removeParts(except keep: String?) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directoryURL.path) else { return }
        for name in names where name.hasSuffix(".part") && (keep == nil || !name.hasPrefix(keep! + "-")) {
            try? FileManager.default.removeItem(at: directoryURL.appendingPathComponent(name))
        }
    }

    private static func ack(type: String, entry: Entry) -> [String: Any] {
        var result: [String: Any] = ["type": type, "protocolVersion": 1, "ok": true,
            "state": entry.state == "staged" ? "ready_to_open" : entry.state == "prepared" ? "prepared" : "staging",
            "handoffID": entry.handoffID,
            "expiresAtMs": Int64(entry.expiresAt.timeIntervalSince1970 * 1_000),
            "receivedParts": entry.parts.filter { $0 != nil }.count]
        if type == "TRACE_IOS_HISTORY_PREPARE" {
            result["maximumPartBytes"] = maximumPartBytes
            result["maximumParts"] = maximumParts
            result["maximumItems"] = maximumItems
        }
        return result
    }

    private func coordinated<T>(now: Date, persist: Bool = true, _ operation: (inout Document, Date) throws -> T) throws -> T {
        let started = ProcessInfo.processInfo.systemUptime
        try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        coordinator.coordinate(writingItemAt: stateURL, options: .forMerging, error: &coordinationError) { url in
            result = Result {
                let currentTime = now.addingTimeInterval(ProcessInfo.processInfo.systemUptime - started)
                var document: Document
                if FileManager.default.fileExists(atPath: url.path) {
                    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                    guard let size = attributes[.size] as? NSNumber, size.intValue <= 1_048_576 else { throw Failure.storage_unavailable }
                    document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: url))
                    guard document.version == 1, document.terminal.count <= 64,
                          document.entry == nil || document.terminal.count < 64,
                          document.entry.map({ $0.parts.count == $0.partCount }) ?? true else { throw Failure.storage_unavailable }
                } else { document = Document(version: 1, entry: nil, terminal: []) }
                if persist {
                    if let entry = document.entry, entry.expiresAt <= currentTime {
                        finish(&document, entry: entry)
                    }
                    document.terminal.removeAll { $0.expiresAt <= currentTime }
                    // A crash between a part's write and the state's can leave
                    // an orphan; nothing but the live entry keeps parts.
                    removeParts(except: document.entry?.handoffID)
                }
                let value = try operation(&document, currentTime)
                if persist {
                    let data = try JSONEncoder().encode(document)
                    guard data.count <= 1_048_576 else { throw Failure.storage_unavailable }
                    try data.write(to: url, options: [.atomic, .completeFileProtection])
                    var mutableURL = url
                    var resources = URLResourceValues()
                    resources.isExcludedFromBackup = true
                    try mutableURL.setResourceValues(resources)
                }
                return value
            }
        }
        guard coordinationError == nil, let result else { throw Failure.storage_unavailable }
        do { return try result.get() }
        catch let error as Failure { throw error }
        catch { throw Failure.storage_unavailable }
    }

    // MARK: - Validation

    private static func base64Length(_ bytes: Int) -> Int { (bytes + 2) / 3 * 4 }

    private static func decodedPart(_ encoded: String) -> Data? {
        guard !encoded.isEmpty, encoded.utf8.count <= base64Length(maximumPartBytes),
              let bytes = Data(base64Encoded: encoded), (1...maximumPartBytes).contains(bytes.count),
              bytes.base64EncodedString() == encoded, String(data: bytes, encoding: .utf8) != nil else { return nil }
        return bytes
    }

    /// One part: `{s:"ao3-history", at, items:[…]}` of AO3 works, as listing
    /// items with History fields. The app's Import DTO checks every field again.
    private static func partItems(_ bytes: Data) -> Int? {
        guard let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(json.keys) == ["s", "at", "items"], json["s"] as? String == source,
              let at = json["at"] as? String, !at.isEmpty, at.utf16.count <= 128,
              let items = json["items"] as? [[String: Any]], (1...maximumPartItems).contains(items.count),
              items.allSatisfy(historyItem) else { return nil }
        return items.count
    }

    private static func historyItem(_ item: [String: Any]) -> Bool {
        guard item["src"] as? String == "ao3", item["ctx"] as? String == "listing",
              let text = item["u"] as? String, text.utf16.count <= 128,
              text.range(of: "^https://archiveofourown\\.org/works/[1-9][0-9]{0,19}$", options: .regularExpression) != nil,
              (item["t"] as? String).map({ !$0.isEmpty && $0.utf16.count <= 1_000 }) ?? false else { return false }
        if let day = item["lv"] {
            guard let text = day as? String, text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { return false }
        }
        if let later = item["ml"] { guard later as? Bool == true, item["lv"] == nil else { return false } }
        return true
    }

    private static func identifier(_ value: Any?) -> String? {
        guard let value = value as? String, let uuid = UUID(uuidString: value),
              uuid.uuidString.lowercased() == value else { return nil }
        return value
    }
    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, abs(number.doubleValue) <= 9_007_199_254_740_991,
              number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.int64Value
    }
    private static func hexDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }
    private static func digest(_ bytes: Data) -> String { hex(SHA256.hash(data: bytes)) }
    private static func hex(_ digest: SHA256.Digest) -> String { digest.map { String(format: "%02x", $0) }.joined() }
}
