//
//  TraceReviewEligibility.swift
//  iOS (App)
//

import Foundation

struct TraceReviewEligibilityState: Equatable {
    private(set) var pendingVersion: String?
    private(set) var lastRequestedVersion: String?
    private(set) var lastObservedActivityTimestamp: TimeInterval?

    @discardableResult
    mutating func recordDirectActivity(version: String) -> Bool {
        guard lastRequestedVersion != version, pendingVersion != version else {
            return false
        }
        pendingVersion = version
        return true
    }

    @discardableResult
    mutating func observeServerActivity(
        timestamp: TimeInterval,
        now: TimeInterval,
        maximumAge: TimeInterval,
        maximumFutureSkew: TimeInterval,
        version: String
    ) -> Bool {
        guard timestamp.isFinite, timestamp > 0 else { return false }
        guard lastObservedActivityTimestamp.map({ timestamp > $0 }) ?? true else {
            return false
        }

        // Consume every newer marker, including stale or implausibly future
        // values, so a refresh or app-version change can never replay it.
        lastObservedActivityTimestamp = timestamp

        guard timestamp <= now + maximumFutureSkew,
              now - timestamp <= maximumAge
        else {
            return false
        }
        return recordDirectActivity(version: version)
    }

    func isEligible(for version: String) -> Bool {
        lastRequestedVersion != version
            && pendingVersion == version
    }

    mutating func markRequested(version: String) {
        lastRequestedVersion = version
        pendingVersion = nil
    }
}
