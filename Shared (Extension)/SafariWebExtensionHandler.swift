//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//

import Foundation
import SafariServices
import Security
import os.log

/// Handles `browser.runtime.sendNativeMessage` from the Web Extension.
/// MV3 background logic stays in JavaScript; this layer demonstrates structured native handling for review.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let log = OSLog(
        subsystem: Bundle.main.bundleIdentifier ?? "com.tracefiction.safari.extension",
        category: "NativeMessage"
    )

    private static let traceAuthUpdate = "TRACE_AUTH_UPDATE"
    private static let traceAutoTrack = "TRACE_AUTO_TRACK"
    private static let traceMetadataBroadcast = "TRACE_METADATA_BROADCAST"
    private static let traceIosAuthTokenRequest = "TRACE_IOS_AUTH_TOKEN_REQUEST"
    private static let traceIosPendingFirstStoryGet = "TRACE_IOS_PENDING_FIRST_STORY_GET"
    private static let traceIosPendingFirstStoryClear = "TRACE_IOS_PENDING_FIRST_STORY_CLEAR"
    private static let traceIosExtensionHeartbeat = "TRACE_IOS_EXTENSION_HEARTBEAT"
    private static let traceSharedAppGroup = "group.com.tracefiction.trace"
    private static let traceKeychainAccessGroup = "com.tracefiction.trace.shared"
    private static let traceAppleTeamIdentifierPrefix = "3GX59FLLT6."
    private static let traceAuthTokenService = "com.tracefiction.trace.auth"
    private static let traceAuthTokenAccount = "extension-provider-v2"
    private static let traceProviderRecordVersion = 2

    private struct TraceSafariProviderRecord: Codable {
        let version: Int
        let kind: String?
        let token: String?
        let sessionId: String?
        let credential: String?
        let expiresAt: String?
    }

    private enum SharedTraceCredential {
        case ready(
            credential: String,
            kind: String,
            sessionId: String?,
            expiresAt: String?
        )
        case missing
        case unavailable
    }
#if DEBUG && targetEnvironment(simulator)
    /// Simulator-only input for the installed Safari lifecycle harness. The
    /// real app/extension boundary remains the shared Keychain item above;
    /// Release builds do not contain this key or branch.
    private static let traceSimulatorProviderCredentialKey =
        "traceDebugSimulatorProviderCredential"
    private static let traceSimulatorMissingProviderFixture =
        "trace-provider-fixture-missing-v1"
    private static let traceSimulatorProviderRequestCountKey =
        "traceDebugSimulatorProviderRequestCount"
    private static let traceSimulatorProviderRequestResultKey =
        "traceDebugSimulatorProviderRequestResult"
#endif
    private static let pendingFirstStoryDefaultsKey = "tracePendingFirstStoryUrlV1"
    private static let pendingFirstStoryExpiresAtDefaultsKey = "tracePendingFirstStoryExpiresAtV1"
    private static let pendingFirstStoryV2DefaultsKey = "tracePendingFirstStoryV2"
    private static let extensionHeartbeatDefaultsKey = "traceExtensionHeartbeatV1"
    private static let providerHealthDefaultsKey = "traceExtensionProviderHealthV1"

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let rawMessage: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            rawMessage = request?.userInfo?[SFExtensionMessageKey]
        } else {
            rawMessage = request?.userInfo?["message"]
        }

        let payload = Self.coerceToStringKeyedDictionary(rawMessage)
        let reportedType = (payload?["type"] as? String) ?? "(none)"

        os_log(
            "Incoming native message type=%{public}@ profile=%{public}@",
            log: Self.log,
            type: .info,
            reportedType,
            profile?.uuidString ?? "none"
        )

        let responseBody: [String: Any]
        if let payload, let messageType = payload["type"] as? String {
            switch messageType {
            case Self.traceIosAuthTokenRequest:
                let credential = Self.readSharedTraceCredential()
                Self.recordProviderReadHealth(credential)
#if DEBUG && targetEnvironment(simulator)
                Self.recordSimulatorProviderRequest(credential)
#endif
                switch credential {
                case .ready(let credential, let kind, let sessionId, let expiresAt):
                    os_log(
                        "Shared credential read succeeded kind=%{public}@",
                        log: Self.log,
                        type: .info,
                        kind
                    )
                    var ready: [String: Any] = [
                        "type": Self.traceIosAuthTokenRequest,
                        "ok": true,
                        "protocolVersion": 3,
                        "credential": credential,
                        // Keep token additive during the 0.6.0 -> 0.6.1 binary
                        // transition. New runtime code reads credential/kind.
                        "token": credential,
                        "credentialKind": kind,
                    ]
                    if let sessionId { ready["sessionId"] = sessionId }
                    if let expiresAt { ready["expiresAt"] = expiresAt }
                    responseBody = ready
                case .missing:
                    os_log(
                        "Shared credential is missing",
                        log: Self.log,
                        type: .info
                    )
                    responseBody = [
                        "type": Self.traceIosAuthTokenRequest,
                        "ok": false,
                        "error": "missing_token",
                    ]
                case .unavailable:
                    os_log(
                        "Shared credential is unavailable",
                        log: Self.log,
                        type: .error
                    )
                    responseBody = [
                        "type": Self.traceIosAuthTokenRequest,
                        "ok": false,
                        "error": "provider_unavailable",
                    ]
                }

            case Self.traceIosPendingFirstStoryGet:
                responseBody = Self.pendingFirstStoryResponse()

            case Self.traceIosPendingFirstStoryClear:
                let expectedHandoffId = Self.sanitizedHandoffId(payload["handoffId"])
                let cleared = Self.clearPendingFirstStory(
                    expectedHandoffId: expectedHandoffId
                )
                responseBody = [
                    "type": Self.traceIosPendingFirstStoryClear,
                    "ok": true,
                    "cleared": cleared,
                ]

            case Self.traceIosExtensionHeartbeat:
                responseBody = Self.storeExtensionHeartbeat(payload)

            case Self.traceAuthUpdate:
                let token = payload["token"] as? String
                let hasToken = token.map { !$0.isEmpty } ?? false
                os_log(
                    "TRACE_AUTH_UPDATE: auth update received (token present: %{public}@)",
                    log: Self.log,
                    type: .info,
                    hasToken ? "yes" : "no"
                )
                responseBody = [
                    "type": "TRACE_AUTH_UPDATE_ACK",
                    "status": "received",
                ]

            case Self.traceAutoTrack:
                os_log("TRACE_AUTO_TRACK: track event received", log: Self.log, type: .info)
                responseBody = [
                    "type": "TRACE_AUTO_TRACK_ACK",
                    "status": "received",
                ]

            case Self.traceMetadataBroadcast:
                os_log(
                    "TRACE_METADATA_BROADCAST: metadata broadcast received",
                    log: Self.log,
                    type: .info
                )
                responseBody = [
                    "type": "TRACE_METADATA_BROADCAST_ACK",
                    "status": "received",
                ]

            default:
                os_log(
                    "Unknown native message type: %{public}@",
                    log: Self.log,
                    type: .default,
                    messageType
                )
                responseBody = [
                    "type": "error",
                    "status": "error",
                    "error": "unknown_message_type",
                    "receivedType": messageType,
                ]
            }
        } else {
            os_log(
                "Native message has no dictionary payload or missing string \"type\" key",
                log: Self.log,
                type: .default
            )
            responseBody = [
                "type": "error",
                "status": "error",
                "error": "invalid_payload",
            ]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: responseBody]
        } else {
            response.userInfo = ["message": responseBody]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// Normalizes Obj-C bridged dictionaries so `type` / `token` lookups are reliable.
    private static func coerceToStringKeyedDictionary(_ value: Any?) -> [String: Any]? {
        guard let value else { return nil }
        if let dict = value as? [String: Any] {
            return dict
        }
        guard let dict = value as? [AnyHashable: Any] else { return nil }
        var out: [String: Any] = [:]
        out.reserveCapacity(dict.count)
        for (key, val) in dict {
            guard let stringKey = key as? String else { continue }
            out[stringKey] = val
        }
        return out
    }

    private static func keychainAccessGroup() -> String? {
        if let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
           !prefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return "\(prefix)\(traceKeychainAccessGroup)"
        }
        return "\(traceAppleTeamIdentifierPrefix)\(traceKeychainAccessGroup)"
    }

    private static func readSharedTraceCredential() -> SharedTraceCredential {
#if DEBUG && targetEnvironment(simulator)
        if let fixture = UserDefaults.standard.string(
            forKey: traceSimulatorProviderCredentialKey
        ) {
            let trimmed = fixture.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed == traceSimulatorMissingProviderFixture {
                return .missing
            }
            if !trimmed.isEmpty {
                return .ready(
                    credential: trimmed,
                    kind: trimmed.hasPrefix("trd_v1_")
                        ? "device_session"
                        : "access_token",
                    sessionId: nil,
                    expiresAt: nil
                )
            }
        }
#endif

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: traceAuthTokenService,
            kSecAttrAccount as String: traceAuthTokenAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup = keychainAccessGroup() {
            query[kSecAttrAccessGroup as String] = accessGroup
        }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return .missing
        }
        guard status == errSecSuccess, let data = item as? Data else {
            os_log(
                "Shared provider read unavailable status=%{public}d",
                log: log,
                type: .error,
                status
            )
            return .unavailable
        }
        guard let record = try? JSONDecoder().decode(
            TraceSafariProviderRecord.self,
            from: data
        ) else {
            os_log(
                "Shared provider record decode failed",
                log: log,
                type: .error
            )
            return .unavailable
        }

        if record.version == 1, let token = record.token {
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty
                ? .unavailable
                : .ready(
                    credential: trimmed,
                    kind: "access_token",
                    sessionId: nil,
                    expiresAt: nil
                )
        }
        guard record.version == traceProviderRecordVersion,
              record.kind == "device_session",
              let rawSessionId = record.sessionId,
              let expiresAt = record.expiresAt,
              let rawCredential = record.credential,
              let provider = TraceSafariProviderCodec.deviceSession(
                  sessionId: rawSessionId,
                  credential: rawCredential,
                  expiresAt: expiresAt
              )
        else {
            os_log(
                "Shared provider record validation failed",
                log: log,
                type: .error
            )
            return .unavailable
        }
        return .ready(
            credential: provider.credential,
            kind: "device_session",
            sessionId: provider.sessionId,
            expiresAt: provider.expiresAt
        )
    }

#if DEBUG && targetEnvironment(simulator)
    /// Redacted proof that an installed Connect actually crossed the native
    /// provider boundary. Never persist the credential or any account data.
    private static func recordSimulatorProviderRequest(
        _ credential: SharedTraceCredential
    ) {
        let defaults = UserDefaults.standard
        let requestCount = defaults.integer(forKey: traceSimulatorProviderRequestCountKey)
        defaults.set(requestCount + 1, forKey: traceSimulatorProviderRequestCountKey)
        let result: String
        switch credential {
        case .ready:
            result = "present"
        case .missing:
            result = "missing"
        case .unavailable:
            result = "unavailable"
        }
        defaults.set(
            result,
            forKey: traceSimulatorProviderRequestResultKey
        )
    }
#endif

    private static func pendingDefaults() -> UserDefaults? {
        UserDefaults(suiteName: traceSharedAppGroup)
    }

    /// Redacted, durable proof of the extension-side provider boundary. This
    /// deliberately records no credential, account, session, story, or URL.
    private static func recordProviderReadHealth(
        _ credential: SharedTraceCredential
    ) {
        let state: String
        switch credential {
        case .ready:
            state = "ready"
        case .missing:
            state = "missing"
        case .unavailable:
            state = "unavailable"
        }
        pendingDefaults()?.set(
            [
                "state": state,
                "updatedAt": Date().timeIntervalSince1970 * 1000,
            ],
            forKey: providerHealthDefaultsKey
        )
    }

    /// Persists the background script's "content script ran on host X" signal.
    /// The containing app reads this to verify the Safari site-permission grant,
    /// which iOS offers no direct API for.
    private static func storeExtensionHeartbeat(_ payload: [String: Any]) -> [String: Any] {
        guard let defaults = pendingDefaults() else {
            return [
                "type": traceIosExtensionHeartbeat,
                "ok": false,
                "error": "shared_storage_unavailable",
            ]
        }

        let hostKindRaw = (payload["hostKind"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let hostKind = hostKindRaw.isEmpty ? "unknown" : String(hostKindRaw.prefix(32))

        // Background sends epoch milliseconds; fall back to "now" if absent.
        let reportedAtMs: Double
        if let at = payload["at"] as? Double, at > 0 {
            reportedAtMs = at
        } else if let at = payload["at"] as? Int, at > 0 {
            reportedAtMs = Double(at)
        } else {
            reportedAtMs = Date().timeIntervalSince1970 * 1000
        }

        var heartbeat =
            defaults.dictionary(forKey: extensionHeartbeatDefaultsKey) ?? [:]

        // A permissions snapshot is deliberately separate from a run receipt.
        // `getAll()` is diagnostic metadata collected by extension JavaScript;
        // it must not delay or overwrite proof that a content script ran.
        let permissionSnapshot = (payload["permissionSnapshot"] as? Bool) == true
        if permissionSnapshot {
            if let grantedOrigins = payload["grantedOrigins"] as? [String] {
                heartbeat["grantedOrigins"] = Array(
                    grantedOrigins
                        .map { String($0.prefix(256)) }
                        .prefix(64)
                )
            }
            heartbeat["permissionSnapshotAt"] = reportedAtMs
            heartbeat["updatedAt"] = Date().timeIntervalSince1970 * 1000
            defaults.set(heartbeat, forKey: extensionHeartbeatDefaultsKey)
            return [
                "type": traceIosExtensionHeartbeat,
                "ok": true,
            ]
        }

        var lastRunByHost =
            heartbeat["lastRunByHost"] as? [String: Double] ?? [:]
        lastRunByHost[hostKind] = reportedAtMs
        heartbeat["lastRunByHost"] = lastRunByHost

        if let handoffId = sanitizedHandoffId(payload["handoffId"]) {
            heartbeat["lastRunHandoffId"] = handoffId
            heartbeat["lastRunHandoffAt"] = reportedAtMs
        }

        // Only server-confirmed save actions may make the app claim a story
        // landed. Keep the native boundary strict even though the background
        // already filters action kinds before it sends this heartbeat.
        let action = (payload["action"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if action == "track" || action == "quick_add" {
            var lastSaveByHost =
                heartbeat["lastSaveByHost"] as? [String: Double] ?? [:]
            lastSaveByHost[hostKind] = reportedAtMs
            heartbeat["lastSaveByHost"] = lastSaveByHost
        }

        // Backward-compatible handling for extension builds that included the
        // snapshot on their main heartbeat before the separate-message split.
        if let grantedOrigins = payload["grantedOrigins"] as? [String] {
            heartbeat["grantedOrigins"] = Array(
                grantedOrigins
                    .map { String($0.prefix(256)) }
                    .prefix(64)
            )
        }
        heartbeat["updatedAt"] = Date().timeIntervalSince1970 * 1000

        defaults.set(heartbeat, forKey: extensionHeartbeatDefaultsKey)

        return [
            "type": traceIosExtensionHeartbeat,
            "ok": true,
        ]
    }

    private static func sanitizedHandoffId(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 128,
              trimmed.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
        else {
            return nil
        }
        return trimmed
    }

    @discardableResult
    private static func clearPendingFirstStory(
        expectedHandoffId: String? = nil
    ) -> Bool {
        guard let defaults = pendingDefaults() else { return false }
        if let expectedHandoffId {
            guard
                let pending = defaults.dictionary(forKey: pendingFirstStoryV2DefaultsKey),
                sanitizedHandoffId(pending["handoffId"]) == expectedHandoffId
            else {
                return false
            }
        }
        defaults.removeObject(forKey: pendingFirstStoryDefaultsKey)
        defaults.removeObject(forKey: pendingFirstStoryExpiresAtDefaultsKey)
        defaults.removeObject(forKey: pendingFirstStoryV2DefaultsKey)
        return true
    }

    private static func pendingFirstStoryResponse() -> [String: Any] {
        guard let defaults = pendingDefaults() else {
            return [
                "type": traceIosPendingFirstStoryGet,
                "ok": false,
                "error": "shared_storage_unavailable",
            ]
        }

        if let pending = defaults.dictionary(forKey: pendingFirstStoryV2DefaultsKey) {
            let expiresAt = (pending["expiresAt"] as? NSNumber)?.doubleValue ?? 0
            if expiresAt > 0, Date().timeIntervalSince1970 > expiresAt {
                clearPendingFirstStory()
                return [
                    "type": traceIosPendingFirstStoryGet,
                    "ok": true,
                    "url": "",
                    "expired": true,
                ]
            }

            guard let mode = pending["mode"] as? String,
                  (mode == "story" || mode == "browse")
            else {
                clearPendingFirstStory()
                return [
                    "type": traceIosPendingFirstStoryGet,
                    "ok": true,
                    "url": "",
                ]
            }

            var response: [String: Any] = [
                "type": traceIosPendingFirstStoryGet,
                "ok": true,
                "url": (pending["url"] as? String) ?? "",
                "mode": mode,
                "expiresAt": expiresAt,
            ]
            if let handoffId = sanitizedHandoffId(pending["handoffId"]) {
                response["handoffId"] = handoffId
            }
            if let hostKind = pending["hostKind"] as? String,
               hostKind == "ao3" || hostKind == "ffn"
            {
                response["hostKind"] = hostKind
            }
            return response
        }

        let expiresAt = defaults.double(forKey: pendingFirstStoryExpiresAtDefaultsKey)
        if expiresAt > 0, Date().timeIntervalSince1970 > expiresAt {
            clearPendingFirstStory()
            return [
                "type": traceIosPendingFirstStoryGet,
                "ok": true,
                "url": "",
                "expired": true,
            ]
        }

        guard let url = defaults.string(forKey: pendingFirstStoryDefaultsKey),
              !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return [
                "type": traceIosPendingFirstStoryGet,
                "ok": true,
                "url": "",
            ]
        }

        return [
            "type": traceIosPendingFirstStoryGet,
            "ok": true,
            "url": url,
            "expiresAt": expiresAt,
        ]
    }
}
