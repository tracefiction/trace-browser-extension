//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//

import SafariServices
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

        let responseBody: [String: String]
        if let payload, let messageType = payload["type"] as? String {
            switch messageType {
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
}
