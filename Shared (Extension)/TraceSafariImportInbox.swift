import Foundation
import CoreFoundation
import CryptoKit

/// Cross-process, one-use transport. This type never reads credentials or makes
/// network requests. The containing app supplies its positively verified account
/// and current provider binding immediately before claiming.
final class TraceSafariImportInbox {
    static let contract = "trace-native-library-import-v1"
    static let maximumPayloadBytes = 524_288
    static let maximumItems = 250
    static let lifetime: TimeInterval = 600
    static let messageTypes: Set<String> = [
        "TRACE_IOS_IMPORT_PREPARE", "TRACE_IOS_IMPORT_STAGE", "TRACE_IOS_IMPORT_CANCEL"
    ]
    enum Failure: String, Error {
        case unsupported, invalid_request, provider_unavailable, provider_changed
        case account_changed, expired, replayed, conflict, busy, storage_unavailable
    }
    struct Expectation: Equatable, Sendable {
        let accountID: String
        let accountEpoch: Int64
        let apiOrigin: String
        let profileID: UUID?
        let providerBinding: TraceSafariProviderCodec.ImportBinding
    }
    struct CleanupIdentity: Equatable, Sendable {
        let handoffID: String
    }
    struct Pending: Equatable, Sendable {
        let handoffID: String
        let accountID: String
        let accountEpoch: Int64
        let apiOrigin: String
        let profileID: UUID?
        let providerBinding: TraceSafariProviderCodec.ImportBinding
        let expiresAt: Date
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
        var payloadBase64: String?
        var payloadSHA256: String?
        var payloadByteCount: Int?
        var pending: Pending {
            Pending(handoffID: handoffID, accountID: accountID, accountEpoch: accountEpoch,
                apiOrigin: apiOrigin, profileID: profileID, providerBinding: providerBinding,
                expiresAt: expiresAt)
        }
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
    private let fileURL: URL
    init(containerURL: URL) {
        fileURL = containerURL.appendingPathComponent("TraceNativeImportInboxV1.json")
    }

    /// Exact keys and bounded messages are checked before inspecting payloads.
    /// `configuredAPIOrigin` is immutable paired-package configuration, never a
    /// defaults value or a value accepted from this message.
    func handle(message: [String: Any], profileID: UUID?,
                currentProviderBinding: (Date) -> TraceSafariProviderCodec.ImportBinding?,
                configuredAPIOrigin: String, now: Date) -> [String: Any] {
        let type = message["type"] as? String ?? "TRACE_IOS_IMPORT_PREPARE"
        func failure(_ error: Failure) -> [String: Any] {
            ["type": Self.messageTypes.contains(type) ? type : "TRACE_IOS_IMPORT_PREPARE",
             "protocolVersion": 1, "ok": false, "error": error.rawValue]
        }
        do {
            let allowed: Set<String> = type == "TRACE_IOS_IMPORT_PREPARE"
                ? ["type", "protocolVersion", "requestID", "requestIssuedAtMs", "accountID", "accountEpoch", "apiOrigin"]
                : type == "TRACE_IOS_IMPORT_STAGE"
                    ? ["type", "protocolVersion", "requestID", "handoffID", "payloadBase64"]
                    : ["type", "protocolVersion", "requestID", "handoffID"]
            guard Set(message.keys) == allowed,
                  (message["payloadBase64"] as? String)?.utf8.count ?? 0 <= 699_052,
                  (message["accountID"] as? String)?.utf8.count ?? 0 <= 256,
                  Self.messageTypes.contains(type), Self.integer(message["protocolVersion"]) == 1,
                  let requestID = Self.identifier(message["requestID"]),
                  JSONSerialization.isValidJSONObject(message),
                  let size = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes]).count,
                  size <= 704 * 1_024,
                  Self.validOrigin(configuredAPIOrigin) else { throw Failure.invalid_request }
            return try coordinated(now: now) { document, now in
                do {
                    let providerBinding = currentProviderBinding(now)
                    let terminal = document.terminal.contains { $0.requestID == requestID }
                    if terminal { throw Failure.replayed }
                    if type == "TRACE_IOS_IMPORT_PREPARE" {
                        guard Set(message.keys) == Set(["type", "protocolVersion", "requestID",
                            "requestIssuedAtMs", "accountID", "accountEpoch", "apiOrigin"]),
                            let issued = Self.integer(message["requestIssuedAtMs"]),
                            let epoch = Self.integer(message["accountEpoch"]), epoch >= 0,
                            let account = message["accountID"] as? String,
                            !account.isEmpty, account.utf8.count <= 256,
                            let origin = message["apiOrigin"] as? String,
                            origin == configuredAPIOrigin else { throw Failure.invalid_request }
                        let issuedDate = Date(timeIntervalSince1970: Double(issued) / 1_000)
                        guard issuedDate > now.addingTimeInterval(-Self.lifetime),
                              issuedDate <= now.addingTimeInterval(30) else { throw Failure.expired }
                        guard let providerBinding else { throw Failure.provider_unavailable }
                        if let entry = document.entry {
                            guard entry.requestID == requestID else { throw Failure.busy }
                            guard entry.profileID == profileID,
                                  entry.providerBinding == providerBinding else { throw Failure.provider_changed }
                            guard entry.accountID == account, entry.accountEpoch == epoch,
                                  entry.apiOrigin == origin, entry.requestIssuedAtMs == issued else { throw Failure.conflict }
                            return Self.ack(type: type, entry: entry, prepared: true)
                        }
                        guard document.terminal.count < 64 else { throw Failure.busy }
                        let entry = Entry(state: "prepared", requestID: requestID,
                            handoffID: UUID().uuidString.lowercased(), requestIssuedAtMs: issued,
                            createdAt: now, expiresAt: now.addingTimeInterval(Self.lifetime),
                            accountID: account, accountEpoch: epoch, apiOrigin: origin,
                            profileID: profileID, providerBinding: providerBinding)
                        document.entry = entry
                        return Self.ack(type: type, entry: entry, prepared: true)
                    }
                    let expectedKeys: Set<String> = type == "TRACE_IOS_IMPORT_STAGE"
                        ? ["type", "protocolVersion", "requestID", "handoffID", "payloadBase64"]
                        : ["type", "protocolVersion", "requestID", "handoffID"]
                    guard Set(message.keys) == expectedKeys,
                          let handoffID = Self.identifier(message["handoffID"]) else { throw Failure.invalid_request }
                    if document.terminal.contains(where: { $0.handoffID == handoffID }) { throw Failure.replayed }
                    guard var entry = document.entry,
                          entry.requestID == requestID, entry.handoffID == handoffID else { throw Failure.expired }
                    guard entry.profileID == profileID else { throw Failure.provider_changed }
                    if type == "TRACE_IOS_IMPORT_CANCEL" {
                        Self.finish(&document, entry: entry)
                        return ["type": type, "protocolVersion": 1, "ok": true, "state": "cancelled"]
                    }
                    guard let providerBinding else { throw Failure.provider_unavailable }
                    guard entry.providerBinding == providerBinding,
                          entry.apiOrigin == configuredAPIOrigin else {
                        Self.finish(&document, entry: entry)
                        throw Failure.provider_changed
                    }
                    guard let encoded = message["payloadBase64"] as? String,
                          let bytes = Self.payload(encoded) else { throw Failure.invalid_request }
                    let digest = Self.digest(bytes)
                    if entry.state == "staged" {
                        guard entry.payloadSHA256 == digest, entry.payloadByteCount == bytes.count else { throw Failure.conflict }
                    } else {
                        entry.state = "staged"
                        entry.payloadBase64 = encoded
                        entry.payloadSHA256 = digest
                        entry.payloadByteCount = bytes.count
                        document.entry = entry
                    }
                    return Self.ack(type: type, entry: entry, prepared: false)
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

    func claim(handoffID: String, expecting expected: Expectation, now: Date,
               currentProviderBinding: (Date) -> TraceSafariProviderCodec.ImportBinding?) throws -> Data {
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
            guard let encoded = entry.payloadBase64, let bytes = Self.payload(encoded),
                  bytes.count == entry.payloadByteCount, Self.digest(bytes) == entry.payloadSHA256 else { throw Failure.invalid_request }
            Self.finish(&document, entry: entry)
            return bytes
        }
    }

    /// Freeze the native departure cutoff before the first capture attempt.
    /// Retrying an unavailable read must not capture a later prepared entry.
    /// After capture succeeds, retain and purge only that exact ID.
    /// Includes prepared and expired serialized entries, so departure can
    /// remove private bytes even when delivery is no longer allowed.
    /// Uses the same native wall-clock model as the inbox lifetime.
    func captureCleanup(accountID: String, apiOrigin: String,
                        createdNoLaterThan: Date, now: Date) throws -> CleanupIdentity? {
        guard !accountID.isEmpty, accountID.utf8.count <= 256,
              Self.validOrigin(apiOrigin) else { throw Failure.invalid_request }
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
            Self.finish(&document, entry: entry)
            return true
        }
    }

    private static func finish(_ document: inout Document, entry: Entry) {
        document.terminal.append(Tombstone(requestID: entry.requestID,
            handoffID: entry.handoffID, expiresAt: max(entry.expiresAt,
                Date(timeIntervalSince1970: Double(entry.requestIssuedAtMs) / 1_000).addingTimeInterval(lifetime))))
        document.entry = nil
    }
    private static func ack(type: String, entry: Entry, prepared: Bool) -> [String: Any] {
        var result: [String: Any] = ["type": type, "protocolVersion": 1, "ok": true,
            "state": prepared ? "prepared" : "ready_to_open", "handoffID": entry.handoffID,
            "expiresAtMs": Int64(entry.expiresAt.timeIntervalSince1970 * 1_000)]
        if prepared { result["maximumPayloadBytes"] = maximumPayloadBytes; result["maximumItems"] = maximumItems }
        return result
    }
    private func coordinated<T>(now: Date, persist: Bool = true, _ operation: (inout Document, Date) throws -> T) throws -> T {
        let started = ProcessInfo.processInfo.systemUptime
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        coordinator.coordinate(writingItemAt: fileURL, options: .forMerging, error: &coordinationError) { url in
            result = Result {
                let currentTime = now.addingTimeInterval(ProcessInfo.processInfo.systemUptime - started)
                var document: Document
                if FileManager.default.fileExists(atPath: url.path) {
                    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                    guard let size = attributes[.size] as? NSNumber, size.intValue <= 1_048_576 else { throw Failure.storage_unavailable }
                    document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: url))
                    guard document.version == 1, document.terminal.count <= 64,
                          document.entry == nil || document.terminal.count < 64 else { throw Failure.storage_unavailable }
                } else { document = Document(version: 1, entry: nil, terminal: []) }
                if persist {
                    if let entry = document.entry, entry.expiresAt <= currentTime {
                        Self.finish(&document, entry: entry)
                    }
                    document.terminal.removeAll { $0.expiresAt <= currentTime }
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
    static func validOrigin(_ value: String) -> Bool {
        guard let url = URLComponents(string: value), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.port == nil,
              url.path.isEmpty, url.query == nil, url.fragment == nil,
              url.string == value else { return false }
        return true
    }
    private static func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    private static func payload(_ encoded: String) -> Data? {
        guard !encoded.isEmpty, encoded.utf8.count <= 699_052,
              let bytes = Data(base64Encoded: encoded), bytes.count <= maximumPayloadBytes,
              bytes.base64EncodedString() == encoded, String(data: bytes, encoding: .utf8) != nil,
              let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(json.keys) == Set(["s", "at", "items"]),
              let site = source(json["s"]), let at = json["at"] as? String,
              !at.isEmpty, at.utf16.count <= 128,
              let items = json["items"] as? [[String: Any]], (1...maximumItems).contains(items.count),
              items.allSatisfy({ source($0["src"]) == site && workURL($0["u"], site: site) }) else { return nil }
        return bytes
    }
    private static func source(_ value: Any?) -> String? {
        guard let source = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return nil }
        if ["ao3", "archiveofourown.org", "archiveofourown.gay", "archive.transformativeworks.org"].contains(source) { return "ao3" }
        if ["ffn", "fanfiction.net"].contains(source) { return "ffn" }
        return nil
    }
    private static func workURL(_ value: Any?, site: String) -> Bool {
        guard let value = value as? String, value.utf16.count <= 4_096,
              let url = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.user == nil, url.password == nil, url.port == nil,
              let host = url.host?.lowercased() else { return false }
        if site == "ffn" {
            return ["www.fanfiction.net", "m.fanfiction.net"].contains(host) &&
                url.path.range(of: "^/s/[1-9][0-9]{0,19}(?:/[1-9][0-9]{0,9})?(?:/|$)", options: .regularExpression) != nil
        }
        let accepted = ["archiveofourown.org", "archiveofourown.gay", "ao3.org"].contains { host == $0 || host.hasSuffix("." + $0) }
            || host == "archive.transformativeworks.org"
        return accepted && url.path.range(of: "^/works/[1-9][0-9]{0,19}(?:/chapters/[1-9][0-9]{0,19})?/?$", options: .regularExpression) != nil
    }
}
