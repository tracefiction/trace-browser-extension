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
    private static let traceSharedAppGroup = "group.com.tracefiction.trace"
    private static let traceKeychainAccessGroup = "com.tracefiction.trace.shared"
    private static let traceAppleTeamIdentifierPrefix = "3GX59FLLT6."
    private static let traceAuthTokenService = "com.tracefiction.trace.auth"
    private static let traceAuthTokenAccount = "extension-token"
    private static let pendingFirstStoryDefaultsKey = "tracePendingFirstStoryUrlV1"
    private static let pendingFirstStoryExpiresAtDefaultsKey = "tracePendingFirstStoryExpiresAtV1"

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
                if let token = Self.readSharedTraceToken(), !token.isEmpty {
                    responseBody = [
                        "type": Self.traceIosAuthTokenRequest,
                        "ok": true,
                        "token": token,
                    ]
                } else {
                    responseBody = [
                        "type": Self.traceIosAuthTokenRequest,
                        "ok": false,
                        "error": "missing_token",
                    ]
                }

            case Self.traceIosPendingFirstStoryGet:
                responseBody = Self.pendingFirstStoryResponse()

            case Self.traceIosPendingFirstStoryClear:
                Self.clearPendingFirstStory()
                responseBody = [
                    "type": Self.traceIosPendingFirstStoryClear,
                    "ok": true,
                ]

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

    private static func readSharedTraceToken() -> String? {
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
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func pendingDefaults() -> UserDefaults? {
        UserDefaults(suiteName: traceSharedAppGroup)
    }

    private static func clearPendingFirstStory() {
        guard let defaults = pendingDefaults() else { return }
        defaults.removeObject(forKey: pendingFirstStoryDefaultsKey)
        defaults.removeObject(forKey: pendingFirstStoryExpiresAtDefaultsKey)
    }

    private static func pendingFirstStoryResponse() -> [String: Any] {
        guard let defaults = pendingDefaults() else {
            return [
                "type": traceIosPendingFirstStoryGet,
                "ok": false,
                "error": "shared_storage_unavailable",
            ]
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
