//
//  TraceReviewEligibility.swift
//  iOS (App)
//

import Foundation

struct TraceReviewEligibilityState: Equatable {
    private(set) var activityEntryIDs: Set<String> = []
    private(set) var activityDayKeys: Set<String> = []
    private(set) var activityVersion: String?
    private(set) var lastRequestedVersion: String?

    mutating func recordActivity(
        entryID: String,
        dayKey: String,
        version: String
    ) {
        guard lastRequestedVersion != version else { return }

        if activityVersion != version {
            activityEntryIDs.removeAll()
            activityDayKeys.removeAll()
            activityVersion = version
        }

        activityEntryIDs.insert(entryID)
        activityDayKeys.insert(dayKey)
    }

    func isEligible(
        for version: String,
        requiredDistinctEntries: Int = 3,
        requiredDistinctDays: Int = 2
    ) -> Bool {
        lastRequestedVersion != version
            && activityVersion == version
            && activityEntryIDs.count >= requiredDistinctEntries
            && activityDayKeys.count >= requiredDistinctDays
    }

    mutating func markRequested(version: String) {
        lastRequestedVersion = version
        activityEntryIDs.removeAll()
        activityDayKeys.removeAll()
        activityVersion = nil
    }
}
