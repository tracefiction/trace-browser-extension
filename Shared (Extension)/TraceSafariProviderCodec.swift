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
    static let attemptKey = "traceNativeOnboardingAttemptV1"
    static let receiptKey = "traceNativeOnboardingSaveV1"
    static let previousAttemptKey = "traceNativeOnboardingPreviousAttemptV1"
    struct Attempt: Codable, Equatable {
        let id: String
        let accountID: String
        let apiOrigin: String
        let provider: TraceSafariProviderCodec.ImportBinding
        let startedAt: Double
        let expiresAt: Double
        func valid() -> Bool {
            UUID(uuidString: id) != nil && !accountID.isEmpty && accountID.utf8.count <= 256 &&
            apiOrigin == "https://api.tracefiction.com" && UUID(uuidString: provider.sessionID) != nil &&
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
        func valid(now: Double) -> Bool {
            attempt.valid() && context.attemptID == attempt.id &&
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
    static func handle(_ payload: [String: Any], defaults: UserDefaults,
                       provider: TraceSafariProviderCodec.ImportBinding?, now: Double) -> [String: Any] {
        let current = decode(Attempt.self, data: defaults.data(forKey: attemptKey))
        let previous = decode(Attempt.self, data: defaults.data(forKey: previousAttemptKey))
        let contextID = (payload["context"] as? [String: Any])?["attemptID"] as? String
        let preparing = payload["type"] as? String == "TRACE_IOS_SAVE_PREPARE"
        let selected = preparing || contextID == current?.id ? current : previous
        guard let attempt = selected, preparing || contextID == attempt.id,
              attempt.valid(), now <= attempt.expiresAt + 86_400_000, attempt.provider == provider,
              payload["accountID"] as? String == attempt.accountID,
              payload["apiOrigin"] as? String == attempt.apiOrigin else { return ["ok": false] }
        if payload["type"] as? String == "TRACE_IOS_SAVE_PREPARE" {
            guard now >= attempt.startedAt, now <= attempt.expiresAt else { return ["ok": false] }
            return ["ok": true, "context": ["attemptID": attempt.id,
                "operationID": UUID().uuidString.lowercased(), "initiatedAt": now]]
        }
        guard let raw = payload["context"] as? [String: Any],
              let bytes = try? JSONSerialization.data(withJSONObject: raw),
              let context = decode(Context.self, data: bytes),
              let entryID = payload["entryID"] as? String,
              let workKey = payload["workKey"] as? String,
              let source = payload["source"] as? String else { return ["ok": false] }
        let save = Save(attempt: attempt, context: context, entryID: entryID,
            workKey: workKey, confirmedAt: now, source: source)
        guard save.valid(now: now), let data = try? JSONEncoder().encode(save) else { return ["ok": false] }
        // Retain the first confirmed record for this attempt, even if another
        // story is saved while the containing app is suspended.
        if let prior = decode(Save.self, data: defaults.data(forKey: receiptKey)),
           prior.attempt == attempt, prior.valid(now: now) { return ["ok": true] }
        defaults.set(data, forKey: receiptKey)
        return ["ok": defaults.data(forKey: receiptKey) == data]
    }
}
