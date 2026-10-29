import CryptoKit
import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    guard condition() else { fatalError("line \(line): \(message)") }
}

private func epub(_ size: Int = 4_096) -> Data {
    var data = Data([0x50, 0x4B, 0x03, 0x04]) + Data(count: 26)
    data += Data("mimetype".utf8) + Data("application/epub+zip".utf8)
    return data + Data(count: max(0, size - data.count))
}

/// Keep a Copy's native messages (docs/keep-a-copy-native-protocol.md), as
/// the Safari handler answers them through the app group's mailbox.
@main struct TraceKeepACopyMailboxContract {
    static func main() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("keep-a-copy-mailbox-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        mailbox(folder)
        print("Keep a Copy mailbox contract passed")
    }

    static func mailbox(_ folder: URL) {
        let box = TraceKeepACopyMailbox(folder: folder.appendingPathComponent("mailbox-\(UUID().uuidString)"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func send(_ type: String, _ fields: [String: Any]) -> [String: Any] {
            box.handle(fields.merging(["type": type, "protocolVersion": 1]) { $1 }, now: now)
        }
        let none = send("KEEP_COPY_QUEUE_GET", ["waiting": 0, "stopped": NSNull()])
        require(none["ok"] as? Bool == true && none["enabled"] as? Bool == false && (none["works"] as? [Any])?.isEmpty == true,
                "before the app writes a list: off, with ok")
        box.publish(.init(enabled: true, works: [.init(workId: "5", reason: "locked", have: nil, pace: "reader")],
                          stoppedUntil: TraceKeepACopyMailbox.ms(now) + 60_000, stopReason: "challenge"))
        let queue = send("KEEP_COPY_QUEUE_GET", ["waiting": 1, "stopped": ["code": "forbidden", "until": TraceKeepACopyMailbox.ms(now) + 120_000]])
        require(((queue["works"] as? [[String: Any]])?.first?["workId"] as? String) == "5" && queue["ok"] as? Bool == true, "the list")
        require(queue["stoppedUntil"] as? Int64 == TraceKeepACopyMailbox.ms(now) + 120_000 && queue["stopReason"] as? String == "forbidden",
                "the later of the two stops is the one both keep")
        require(box.sharedStop(now: now)?.reason == "forbidden", "the extension's stop is shared with the app")
        // A file in two parts, straight to disk.
        var bytes = epub(TraceKeepACopyMailbox.partBytes + 1_000)
        let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let id = UUID().uuidString.lowercased()
        let begin: [String: Any] = ["transferId": id, "workId": "5", "updatedAt": "12", "format": "epub", "byteLength": bytes.count,
                                    "sha256": sha, "fileName": "AO3/F/T – A (5).epub", "partBytes": TraceKeepACopyMailbox.partBytes, "partCount": 2]
        var unlisted = begin; unlisted["workId"] = "6"; unlisted["transferId"] = UUID().uuidString.lowercased()
        require(send("KEEP_COPY_BEGIN", unlisted)["error"] as? String == "not_listed", "only a listed work")
        require(send("KEEP_COPY_BEGIN", begin)["nextIndex"] as? Int == 0, "a new transfer")
        let first = bytes.prefix(TraceKeepACopyMailbox.partBytes).base64EncodedString()
        let second = bytes.suffix(1_000).base64EncodedString()
        require(send("KEEP_COPY_PART", ["transferId": id, "index": 1, "base64": second])["nextIndex"] as? Int == 0, "a gap asks again")
        require(send("KEEP_COPY_PART", ["transferId": id, "index": 0, "base64": first])["nextIndex"] as? Int == 1, "part 0")
        require(send("KEEP_COPY_PART", ["transferId": id, "index": 0, "base64": first])["nextIndex"] as? Int == 1, "a repeat isn't stored twice")
        require(send("KEEP_COPY_BEGIN", begin)["nextIndex"] as? Int == 1, "a repeated BEGIN resumes")
        require(send("KEEP_COPY_END", ["transferId": id])["error"] as? String == "incomplete", "not yet whole")
        require(send("KEEP_COPY_PART", ["transferId": id, "index": 1, "base64": second])["nextIndex"] as? Int == 2, "part 1")
        require(send("KEEP_COPY_END", ["transferId": id])["saved"] as? Bool == true, "saved")
        for (type, fields) in [("KEEP_COPY_END", ["transferId": id]), ("KEEP_COPY_BEGIN", begin),
                               ("KEEP_COPY_PART", ["transferId": id, "index": 0, "base64": first] as [String: Any])] {
            require(send(type, fields)["saved"] as? Bool == true, "any repeat of a completed transfer: saved (\(type))")
        }
        let delivered = box.received()
        require(delivered.map { "\($0.workID)-\($0.updatedAt)" } == ["5-12"] && (try? Data(contentsOf: delivered[0].file)) == bytes,
                "the whole file, byte for byte")
        // A wrong digest is discarded.
        let bad = UUID().uuidString.lowercased()
        var wrong = begin; wrong["transferId"] = bad; wrong["sha256"] = String(repeating: "0", count: 64)
        _ = send("KEEP_COPY_BEGIN", wrong)
        _ = send("KEEP_COPY_PART", ["transferId": bad, "index": 0, "base64": first])
        _ = send("KEEP_COPY_PART", ["transferId": bad, "index": 1, "base64": second])
        require(send("KEEP_COPY_END", ["transferId": bad])["error"] as? String == "checksum_mismatch", "a mismatch")
        require(send("KEEP_COPY_PART", ["transferId": bad, "index": 0, "base64": first])["error"] as? String == "unknown_transfer", "and gone")
        // Abort, size caps, strict fields.
        let aborted = UUID().uuidString.lowercased()
        var third = begin; third["transferId"] = aborted
        _ = send("KEEP_COPY_BEGIN", third)
        require(send("KEEP_COPY_ABORT", ["transferId": aborted, "reason": "tab_lost"])["ok"] as? Bool == true, "aborted")
        require(send("KEEP_COPY_PART", ["transferId": aborted, "index": 0, "base64": first])["error"] as? String == "unknown_transfer", "parts gone")
        bytes = Data(count: 600_000)
        require(send("KEEP_COPY_PART", ["transferId": aborted, "index": 0, "base64": bytes.base64EncodedString()])["error"] as? String == "too_large",
                "over the 512 KiB inbox")
        require(send("KEEP_COPY_END", ["transferId": id, "extra": 1])["error"] as? String == "invalid_request", "unknown fields")
        require(box.handle(["type": "KEEP_COPY_END", "protocolVersion": 2, "transferId": id], now: now)["error"] as? String == "unsupported", "v2")
        // A transfer left 30 minutes is discarded.
        let stale = UUID().uuidString.lowercased()
        var fourth = begin; fourth["transferId"] = stale
        _ = send("KEEP_COPY_BEGIN", fourth)
        _ = box.handle(["type": "KEEP_COPY_QUEUE_GET", "protocolVersion": 1, "waiting": 0], now: now.addingTimeInterval(31 * 60))
        require(send("KEEP_COPY_PART", ["transferId": stale, "index": 0, "base64": first])["error"] as? String == "unknown_transfer", "stale")
        require(send("KEEP_COPY_SKIPPED", ["workId": "5", "code": "gone"])["ok"] as? Bool == true
                && box.takeSkipped() == [.init(workId: "5", code: "gone")] && box.takeSkipped().isEmpty, "skips, taken once")
        box.switchOff()
        let off = send("KEEP_COPY_QUEUE_GET", ["waiting": 0])
        require(off["enabled"] as? Bool == false && box.received().isEmpty && box.sharedStop(now: now) == nil, "off clears every hand-off")
    }

}
