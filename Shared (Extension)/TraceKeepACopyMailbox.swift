import CryptoKit
import Foundation

/// What the Trace app and the Safari extension's native-message handler
/// share for Keep a Copy, in the app group's `KeepACopy/` folder. The
/// handler runs in the extension's process, so everything passes through
/// files (`docs/keep-a-copy-native-protocol.md` in trace-browser-extension):
///
/// - `ExtensionQueue.json` (the app): whether Keep a Copy is on, the works
///   the extension fetches in the reader's AO3 tab, and the app's AO3 stop.
/// - `Stop.json` (both): the one AO3 stop both honour, the later one winning.
/// - `Transfers/<transferId>/` (the handler): a file arriving in parts,
///   appended straight to disk, never held whole in memory.
/// - `Received/<workId>-<updatedAt>.epub` (the handler): a whole file whose
///   byte count and SHA-256 matched. The app takes each into its copy.
/// - `Completed.json` (the handler): transfers answered `saved: true`, so a
///   repeat is answered the same way.
/// - `Skipped/` (the handler): `KEEP_COPY_SKIPPED` reports, one file each.
/// - `AO3Lease.json` (both): who may send AO3 a request now. Each side
///   takes the lease for one request and gives it back, so the app and the
///   extension never ask AO3 at the same time.
///
/// Every change to these files is made under one `flock` on `mailbox.lock`,
/// so the handler and the app's off switch never interleave.
///
/// Foundation and CryptoKit only: the same file builds into the app and the
/// Safari extension.
nonisolated struct TraceKeepACopyMailbox: Sendable {
    static let suiteName = "group.com.tracefiction.trace"
    static let protocolVersion = 1
    static let maxWorks = 100
    static let maxFileBytes = 50 * 1_024 * 1_024
    static let partBytes = 262_144
    static let maxPartBase64 = 349_528
    /// The native-message inbox's cap, the JSON envelope included.
    static let maxMessageBytes = 524_288
    /// A transfer with no message this long is discarded.
    static let transferLifetime: TimeInterval = 30 * 60
    static let completedLifetime: TimeInterval = 7 * 24 * 60 * 60
    /// The longest one request may hold AO3.
    static let maxLeaseSeconds: TimeInterval = 330
    /// Stops that are AO3's answer, the only ones shared.
    static let ao3StopReasons: Set<String> = ["challenge", "forbidden", "slow_down", "wrong_host"]

    struct Work: Codable, Equatable, Sendable {
        let workId: String
        /// `locked` or `refused`.
        let reason: String
        /// The `updated_at` of the copy the app holds, or nil.
        let have: String?
        /// `reader` or `check`.
        let pace: String
    }

    struct Queue: Codable, Equatable, Sendable {
        var v = 1
        let enabled: Bool
        var format = "epub"
        let works: [Work]
        /// The app's AO3 stop (ms since 1970), while it lasts.
        var stoppedUntil: Int64? = nil
        var stopReason: String? = nil
    }

    /// One AO3 stop, as either side met it.
    struct Stop: Codable, Equatable, Sendable {
        /// ms since 1970.
        let until: Int64
        let reason: String
    }

    struct Delivery: Equatable, Sendable {
        let file: URL
        let workID: String
        let updatedAt: String
    }

    struct Skip: Codable, Equatable, Sendable {
        let workId: String
        let code: String
    }

    let folder: URL

    init(folder: URL) { self.folder = folder }

    init?(container: URL? = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName)) {
        guard let container else { return nil }
        folder = container.appendingPathComponent("KeepACopy", isDirectory: true)
    }

    private var queueFile: URL { folder.appendingPathComponent("ExtensionQueue.json") }
    private var stopFile: URL { folder.appendingPathComponent("Stop.json") }
    private var receivedFolder: URL { folder.appendingPathComponent("Received", isDirectory: true) }
    private var transfersFolder: URL { folder.appendingPathComponent("Transfers", isDirectory: true) }
    private var completedFile: URL { folder.appendingPathComponent("Completed.json") }
    private var skippedFolder: URL { folder.appendingPathComponent("Skipped", isDirectory: true) }
    private var leaseFile: URL { folder.appendingPathComponent("AO3Lease.json") }

    /// One process, or one thread, changes the mailbox at a time. Never nested.
    private func exclusively<T>(_ body: () -> T) -> T {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let fd = open(folder.appendingPathComponent("mailbox.lock").path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return body() }
        defer { close(fd) }
        flock(fd, LOCK_EX)
        defer { flock(fd, LOCK_UN) }
        return body()
    }

    static func validWork(_ workID: String) -> Bool { workID.range(of: #"^[1-9][0-9]{0,19}$"#, options: .regularExpression) != nil }
    static func validUpdatedAt(_ value: String) -> Bool { value.range(of: #"^[0-9]{1,12}$"#, options: .regularExpression) != nil }

    private func read<T: Decodable>(_ type: T.Type, _ file: URL) -> T? {
        (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(type, from: $0) }
    }

    private func write<T: Encodable>(_ value: T, _ file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: The app's side

    /// Replaces the list the handler answers from. Off lists nothing.
    func publish(_ queue: Queue) { exclusively { publishUnlocked(queue) } }

    private func publishUnlocked(_ queue: Queue) {
        let bounded = Queue(enabled: queue.enabled, works: queue.enabled ? Array(queue.works.prefix(Self.maxWorks)) : [],
                        stoppedUntil: queue.enabled ? queue.stoppedUntil : nil, stopReason: queue.enabled ? queue.stopReason : nil)
        guard read(Queue.self, queueFile) != bounded else { return }
        try? write(bounded, queueFile)
    }

    /// Off: the extension is told so, and nothing it handed over or is
    /// handing over stays. (The app's own state is the app's to forget.)
    func switchOff() {
        exclusively {
            publishUnlocked(Queue(enabled: false, works: []))
            for item in [receivedFolder, transfersFolder, skippedFolder, completedFile, stopFile, leaseFile] {
                try? FileManager.default.removeItem(at: item)
            }
        }
    }

    /// Whole files the extension handed over, oldest first. Each stays until
    /// the app has kept or refused it (the app deletes it either way).
    func received() -> [Delivery] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: receivedFolder.path)) ?? []
        return names.sorted().compactMap { name -> Delivery? in
            let file = receivedFolder.appendingPathComponent(name)
            let parts = name.hasSuffix(".epub") ? name.dropLast(5).split(separator: "-").map(String.init) : []
            guard parts.count == 2, Self.validWork(parts[0]), Self.validUpdatedAt(parts[1]) else {
                // Not the handler's: nothing the app will read.
                if !name.hasPrefix(".") { try? FileManager.default.removeItem(at: file) }
                return nil
            }
            return .init(file: file, workID: parts[0], updatedAt: parts[1])
        }
    }

    /// Each report is its own file, taken (deleted) only once read: one the
    /// handler writes meanwhile waits for the next take. The latest per work wins.
    func takeSkipped() -> [Skip] {
        exclusively {
            var latest: [String: Skip] = [:]
            for name in ((try? FileManager.default.contentsOfDirectory(atPath: skippedFolder.path)) ?? []).sorted() where name.hasSuffix(".json") {
                let file = skippedFolder.appendingPathComponent(name)
                if let skip = read(Skip.self, file) { latest[skip.workId] = skip }
                try? FileManager.default.removeItem(at: file)
            }
            return latest.values.sorted { $0.workId < $1.workId }
        }
    }

    /// The later of the app's and the extension's stops, while it lasts.
    func sharedStop(now: Date) -> Stop? {
        guard let stop = read(Stop.self, stopFile), stop.until > Self.ms(now) else { return nil }
        return stop
    }

    /// Records a stop if it is AO3's and ends later than the one already shared.
    func shareStop(_ stop: Stop) { exclusively { shareStopUnlocked(stop) } }

    private func shareStopUnlocked(_ stop: Stop) {
        guard Self.ao3StopReasons.contains(stop.reason) else { return }
        if let current = read(Stop.self, stopFile), current.until >= stop.until { return }
        try? write(stop, stopFile)
    }

    private struct Lease: Codable { let holder: String; let until: Int64 }

    /// Takes AO3 for one request of at most `seconds`: granted unless the
    /// other side holds it now. Returns when the current lease ends, or nil
    /// when granted.
    func takeAO3(holder: String, seconds: TimeInterval, now: Date = Date()) -> Int64? {
        exclusively { takeAO3Unlocked(holder: holder, seconds: seconds, now: now) }
    }

    private func takeAO3Unlocked(holder: String, seconds: TimeInterval, now: Date) -> Int64? {
        if let lease = read(Lease.self, leaseFile), lease.holder != holder, lease.until > Self.ms(now) { return lease.until }
        let until = Self.ms(now) + Int64(min(Self.maxLeaseSeconds, max(1, seconds)) * 1_000)
        guard (try? write(Lease(holder: holder, until: until), leaseFile)) != nil else { return Self.ms(now) + 1_000 }
        return nil
    }

    /// The request is over: AO3 is free for the other side.
    func releaseAO3(holder: String) { exclusively { releaseAO3Unlocked(holder: holder) } }

    private func releaseAO3Unlocked(holder: String) {
        if read(Lease.self, leaseFile)?.holder == holder { try? FileManager.default.removeItem(at: leaseFile) }
    }

    static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1_000).rounded()) }

    // MARK: The handler's side

    /// One `KEEP_COPY_*` message, answered as the protocol says. Never
    /// throws; every refusal is `{ok: false, error}`.
    func handle(_ message: [String: Any], now: Date = Date()) -> [String: Any] {
        exclusively { handleUnlocked(message, now: now) }
    }

    private func handleUnlocked(_ message: [String: Any], now: Date) -> [String: Any] {
        func refuse(_ error: String) -> [String: Any] { ["ok": false, "error": error] }
        guard (try? JSONSerialization.data(withJSONObject: message).count).map({ $0 <= Self.maxMessageBytes }) == true else {
            return refuse("too_large")
        }
        guard (message["protocolVersion"] as? NSNumber)?.intValue == Self.protocolVersion,
              let type = message["type"] as? String else { return refuse("unsupported") }
        func keys(_ allowed: Set<String>) -> Bool { Set(message.keys).isSubset(of: allowed.union(["type", "protocolVersion"])) }
        clearStale(now: now)
        // Off (or never on): nothing more is taken in.
        let enabled = read(Queue.self, queueFile)?.enabled == true
        switch type {
        case "KEEP_COPY_QUEUE_GET":
            guard keys(["waiting", "stopped"]) else { return refuse("invalid_request") }
            if let stopped = message["stopped"] as? [String: Any], let until = (stopped["until"] as? NSNumber)?.int64Value,
               until > Self.ms(now), let code = stopped["code"] as? String, code.count <= 40 {
                // AO3 stopped the extension: the app waits it out too.
                shareStopUnlocked(.init(until: min(until, Self.ms(now) + 24 * 60 * 60 * 1_000), reason: code))
            }
            return queueAnswer(now: now)
        case "KEEP_COPY_AO3_LOCK":
            guard keys(["seconds"]), let seconds = (message["seconds"] as? NSNumber)?.doubleValue, seconds > 0 else { return refuse("invalid_request") }
            guard enabled else { return refuse("disabled") }
            if let busyUntil = takeAO3Unlocked(holder: "extension", seconds: seconds, now: now) {
                return ["ok": true, "granted": false, "until": busyUntil]
            }
            return ["ok": true, "granted": true]
        case "KEEP_COPY_AO3_UNLOCK":
            guard keys([]) else { return refuse("invalid_request") }
            releaseAO3Unlocked(holder: "extension")
            return ["ok": true]
        case "KEEP_COPY_BEGIN":
            guard keys(["transferId", "workId", "updatedAt", "format", "byteLength", "sha256", "fileName", "partBytes", "partCount"]),
                  let id = transferID(message), let workID = message["workId"] as? String, Self.validWork(workID),
                  let updatedAt = message["updatedAt"] as? String, Self.validUpdatedAt(updatedAt),
                  message["format"] as? String == "epub",
                  let length = (message["byteLength"] as? NSNumber)?.intValue, (1...Self.maxFileBytes).contains(length),
                  let sha = message["sha256"] as? String, sha.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
                  (message["fileName"] as? String).map({ $0.utf8.count <= 1_024 }) ?? true,
                  (message["partBytes"] as? NSNumber)?.intValue == Self.partBytes,
                  (message["partCount"] as? NSNumber)?.intValue == Self.partCount(length) else { return refuse("invalid_request") }
            if isCompleted(id) { return saved(id) }
            guard enabled else { return refuse("disabled") }
            let meta = Transfer(transferId: id, workId: workID, updatedAt: updatedAt, byteLength: length, sha256: sha,
                                partCount: Self.partCount(length), nextIndex: 0, touchedAt: Self.ms(now))
            if var held = transfer(id) {
                guard held.sameFile(as: meta) else { return refuse("conflict") }
                held.touchedAt = Self.ms(now)
                try? write(held, metaFile(id))
                return acked(id, held.nextIndex)
            }
            guard listed(workID) else { return refuse("not_listed") }
            // A newer transfer of the same work replaces an unfinished one.
            for other in openTransfers() where other.workId == workID { discard(other.transferId) }
            do {
                // The record first, so a folder without one is never a transfer in the making.
                try write(meta, metaFile(id))
                guard FileManager.default.createFile(atPath: dataFile(id).path, contents: nil,
                                                     attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
                else { throw CocoaError(.fileWriteUnknown) }
            } catch { discard(id); return refuse("storage_unavailable") }
            return acked(id, 0)
        case "KEEP_COPY_PART":
            guard keys(["transferId", "index", "base64"]), let id = transferID(message),
                  let index = (message["index"] as? NSNumber)?.intValue, index >= 0,
                  let base64 = message["base64"] as? String, base64.utf8.count <= Self.maxPartBase64 else { return refuse("invalid_request") }
            if isCompleted(id) { return saved(id) }
            guard enabled else { return refuse("disabled") }
            guard var held = transfer(id) else { return refuse("unknown_transfer") }
            held.touchedAt = Self.ms(now)
            // Only the next part is kept; a repeat or a gap is answered with the one wanted.
            if index == held.nextIndex, index < held.partCount {
                let expected = index == held.partCount - 1 ? held.byteLength - Self.partBytes * (held.partCount - 1) : Self.partBytes
                guard let bytes = Data(base64Encoded: base64), bytes.count == expected else { return refuse("invalid_part") }
                do {
                    let handle = try FileHandle(forWritingTo: dataFile(id))
                    defer { try? handle.close() }
                    // Truncated to the parts acknowledged, so a write cut short is never kept.
                    try handle.truncate(atOffset: UInt64(index * Self.partBytes))
                    try handle.seekToEnd()
                    try handle.write(contentsOf: bytes)
                } catch { return refuse("storage_unavailable") }
                held.nextIndex += 1
            }
            try? write(held, metaFile(id))
            return acked(id, held.nextIndex)
        case "KEEP_COPY_END":
            guard keys(["transferId"]), let id = transferID(message) else { return refuse("invalid_request") }
            if isCompleted(id) { return saved(id) }
            guard enabled else { discard(id); return refuse("disabled") }
            guard let held = transfer(id) else { return refuse("unknown_transfer") }
            guard held.nextIndex == held.partCount else { return refuse("incomplete") }
            let file = dataFile(id)
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
            guard size == held.byteLength, Self.sha256(of: file) == held.sha256 else {
                discard(id)
                return refuse("checksum_mismatch")
            }
            guard listed(held.workId) else { discard(id); return refuse("not_listed") }
            do {
                try FileManager.default.createDirectory(at: receivedFolder, withIntermediateDirectories: true)
                let target = receivedFolder.appendingPathComponent("\(held.workId)-\(held.updatedAt).epub")
                if FileManager.default.fileExists(atPath: target.path) { _ = try FileManager.default.replaceItemAt(target, withItemAt: file) }
                else { try FileManager.default.moveItem(at: file, to: target) }
            } catch { return refuse("storage_unavailable") }
            complete(id, now: now)
            discard(id)
            return saved(id)
        case "KEEP_COPY_ABORT":
            guard keys(["transferId", "reason"]), let id = transferID(message) else { return refuse("invalid_request") }
            if isCompleted(id) { return saved(id) }
            discard(id)
            return ["ok": true]
        case "KEEP_COPY_SKIPPED":
            guard keys(["workId", "code"]), let workID = message["workId"] as? String, Self.validWork(workID),
                  let code = message["code"] as? String, code.range(of: #"^[a-z_]{1,20}$"#, options: .regularExpression) != nil
            else { return refuse("invalid_request") }
            noteSkipped(workID: workID, code: code, now: now)
            return ["ok": true]
        default:
            return refuse("unsupported")
        }
    }

    /// `KEEP_COPY_QUEUE_GET`'s answer. Before the app has written a list, off.
    func queueAnswer(now: Date = Date()) -> [String: Any] {
        guard let queue = read(Queue.self, queueFile), queue.enabled else { return ["ok": true, "enabled": false, "works": [Any]()] }
        var answer: [String: Any] = ["ok": true, "enabled": true, "format": queue.format, "works": queue.works.map { work -> [String: Any] in
            var item: [String: Any] = ["workId": work.workId, "reason": work.reason, "pace": work.pace]
            item["have"] = work.have ?? NSNull()
            return item
        }]
        let appStop = queue.stoppedUntil.map { Stop(until: $0, reason: queue.stopReason ?? "forbidden") }
        if let stop = [appStop, sharedStop(now: now)].compactMap({ $0 }).filter({ $0.until > Self.ms(now) }).max(by: { $0.until < $1.until }) {
            answer["stoppedUntil"] = stop.until
            answer["stopReason"] = stop.reason
        }
        return answer
    }

    /// `KEEP_COPY_SKIPPED`: one file per report, oldest name first.
    private func noteSkipped(workID: String, code: String, now: Date) {
        // The system-wide uptime orders reports written in the same millisecond.
        let name = String(format: "%015lld-%020llu-", Self.ms(now), DispatchTime.now().uptimeNanoseconds) + UUID().uuidString + ".json"
        try? write(Skip(workId: workID, code: code), skippedFolder.appendingPathComponent(name))
    }

    static func partCount(_ length: Int) -> Int { max(1, (length + partBytes - 1) / partBytes) }

    /// Streams the file through SHA-256 a part at a time.
    static func sha256(of file: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try? handle.read(upToCount: partBytes), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Transfers

    private struct Transfer: Codable, Equatable {
        let transferId: String
        let workId: String
        let updatedAt: String
        let byteLength: Int
        let sha256: String
        let partCount: Int
        var nextIndex: Int
        var touchedAt: Int64
        func sameFile(as other: Transfer) -> Bool {
            workId == other.workId && updatedAt == other.updatedAt && byteLength == other.byteLength && sha256 == other.sha256
        }
    }

    private struct Completed: Codable { let transferId: String; let at: Int64 }

    private func transferID(_ message: [String: Any]) -> String? {
        guard let id = message["transferId"] as? String, let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else { return nil }
        return id
    }
    private func transferFolder(_ id: String) -> URL { transfersFolder.appendingPathComponent(id, isDirectory: true) }
    private func metaFile(_ id: String) -> URL { transferFolder(id).appendingPathComponent("transfer.json") }
    private func dataFile(_ id: String) -> URL { transferFolder(id).appendingPathComponent("file.epub") }
    private func transfer(_ id: String) -> Transfer? { read(Transfer.self, metaFile(id)) }
    private func discard(_ id: String) { try? FileManager.default.removeItem(at: transferFolder(id)) }
    private func listed(_ workID: String) -> Bool {
        guard let queue = read(Queue.self, queueFile), queue.enabled else { return false }
        return queue.works.contains { $0.workId == workID }
    }
    private func openTransfers() -> [Transfer] {
        ((try? FileManager.default.contentsOfDirectory(atPath: transfersFolder.path)) ?? []).compactMap(transfer)
    }
    private func isCompleted(_ id: String) -> Bool { (read([Completed].self, completedFile) ?? []).contains { $0.transferId == id } }
    private func complete(_ id: String, now: Date) {
        let kept = (read([Completed].self, completedFile) ?? []).filter { Self.ms(now) - $0.at < Int64(Self.completedLifetime * 1_000) }
        try? write(Array((kept + [.init(transferId: id, at: Self.ms(now))]).suffix(500)), completedFile)
    }
    private func acked(_ id: String, _ next: Int) -> [String: Any] { ["ok": true, "transferId": id, "nextIndex": next] }
    private func saved(_ id: String) -> [String: Any] { ["ok": true, "transferId": id, "saved": true] }

    /// Transfers with no message for 30 minutes, and anything in the folder
    /// that isn't one, once it is a minute old.
    private func clearStale(now: Date) {
        for name in (try? FileManager.default.contentsOfDirectory(atPath: transfersFolder.path)) ?? [] {
            let created = (try? transferFolder(name).resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            if now.timeIntervalSince(created) < 60, now >= created { continue }
            let held = transfer(name)
            if held.map({ Self.ms(now) - $0.touchedAt >= Int64(Self.transferLifetime * 1_000) }) ?? true { discard(name) }
        }
    }
}
