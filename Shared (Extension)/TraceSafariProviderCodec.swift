import Foundation

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
