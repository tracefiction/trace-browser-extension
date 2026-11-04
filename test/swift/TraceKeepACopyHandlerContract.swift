import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    guard condition() else { fatalError("line \(line): \(message)") }
}

/// Keep a Copy through SafariWebExtensionHandler's own dispatch: every
/// `KEEP_COPY_*` type reaches the mailbox (none is an unknown type), any
/// other type is left to the handler's other routes, and each Safari
/// profile holds AO3's lease as itself.
@main struct TraceKeepACopyHandlerContract {
    static func main() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("keep-a-copy-handler-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let box = TraceKeepACopyMailbox(folder: folder)
        box.publish(.init(enabled: true, works: [.init(workId: "5", reason: "locked", have: nil, pace: "reader")]))
        let one = UUID(), two = UUID()
        func send(_ type: String, _ fields: [String: Any] = [:], profile: UUID? = one) -> [String: Any]? {
            SafariWebExtensionHandler.keepACopyResponse(fields.merging(["type": type, "protocolVersion": 1]) { $1 },
                                                        type: type, profileID: profile, mailbox: box)
        }
        let id = UUID().uuidString.lowercased()
        let fields: [String: [String: Any]] = [
            "KEEP_COPY_QUEUE_GET": ["waiting": 0],
            "KEEP_COPY_AO3_LOCK": ["seconds": 60],
            "KEEP_COPY_AO3_UNLOCK": [:],
            "KEEP_COPY_BEGIN": ["transferId": id, "workId": "5", "updatedAt": "1", "format": "epub", "byteLength": 10,
                                "sha256": String(repeating: "a", count: 64), "partBytes": 262_144, "partCount": 1],
            "KEEP_COPY_PART": ["transferId": id, "index": 0, "base64": Data(count: 10).base64EncodedString()],
            "KEEP_COPY_END": ["transferId": id],
            "KEEP_COPY_ABORT": ["transferId": id, "reason": "tab_lost"],
            "KEEP_COPY_SKIPPED": ["workId": "5", "code": "gone"],
        ]
        require(Set(fields.keys) == TraceKeepACopyMailbox.messageTypes, "every Keep a Copy type is covered here")
        for type in TraceKeepACopyMailbox.messageTypes {
            let answer = send(type, fields[type] ?? [:])
            require(answer != nil, "\(type) is routed")
            require(answer?["error"] as? String != "unknown_message_type" && answer?["error"] as? String != "unsupported"
                    && answer?["error"] as? String != "invalid_request", "\(type) is answered as itself: \(String(describing: answer))")
        }
        require(send("TRACE_IOS_IMPORT_PREPARE") == nil, "other types keep their own routes")
        // Two profiles: two holders.
        require(send("KEEP_COPY_AO3_LOCK", ["seconds": 60], profile: one)?["granted"] as? Bool == true, "profile one has AO3")
        require(send("KEEP_COPY_AO3_LOCK", ["seconds": 60], profile: two)?["granted"] as? Bool == false, "profile two waits")
        _ = send("KEEP_COPY_AO3_UNLOCK", profile: two)
        require(send("KEEP_COPY_AO3_LOCK", ["seconds": 60], profile: two)?["granted"] as? Bool == false, "and can't free one's lease")
        _ = send("KEEP_COPY_AO3_UNLOCK", profile: one)
        require(send("KEEP_COPY_AO3_LOCK", ["seconds": 60], profile: two)?["granted"] as? Bool == true, "until one gives it back")
        print("Keep a Copy handler dispatch contract passed")
    }
}
