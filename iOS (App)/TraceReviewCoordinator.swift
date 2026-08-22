//
//  TraceReviewCoordinator.swift
//  iOS (App)
//

import StoreKit
import UIKit

@MainActor
final class TraceReviewCoordinator {
    private enum DefaultsKey {
        static let activityEntryIDs = "traceReviewActivityEntryIDsV2"
        static let activityDayKeys = "traceReviewActivityDayKeysV2"
        static let activityVersion = "traceReviewActivityVersionV2"
        static let lastRequestedVersion = "traceReviewLastRequestedVersionV2"
    }

    private static let maximumEntryIDLength = 200

    private let defaults: UserDefaults
    private let requestDelay: TimeInterval
    private let currentVersion: () -> String
    private let currentDayKey: () -> String
    private let windowScene: () -> UIWindowScene?
    private let requestReview: (UIWindowScene) -> Void

    private var isSceneActive = false
    private var isLibraryContext = false
    private var scheduledRequest: DispatchWorkItem?

    init(
        defaults: UserDefaults = .standard,
        requestDelay: TimeInterval = 2,
        currentVersion: @escaping () -> String = TraceReviewCoordinator.appVersion,
        currentDayKey: @escaping () -> String = TraceReviewCoordinator.localDayKey,
        windowScene: @escaping () -> UIWindowScene?,
        requestReview: @escaping (UIWindowScene) -> Void = TraceReviewCoordinator.requestSystemReview
    ) {
        self.defaults = defaults
        self.requestDelay = requestDelay
        self.currentVersion = currentVersion
        self.currentDayKey = currentDayKey
        self.windowScene = windowScene
        self.requestReview = requestReview
    }

    deinit {
        scheduledRequest?.cancel()
    }

    func sceneDidBecomeActive() {
        isSceneActive = true
        scheduleRequestIfEligible()
    }

    func sceneWillResignActive() {
        isSceneActive = false
        cancelScheduledRequest()
    }

    func recordSuccessfulLibraryActivity(entryID rawEntryID: String) {
        let entryID = rawEntryID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !entryID.isEmpty, entryID.count <= Self.maximumEntryIDLength else {
            return
        }

        var state = loadState()
        state.recordActivity(
            entryID: entryID,
            dayKey: currentDayKey(),
            version: currentVersion()
        )
        saveState(state)
        scheduleRequestIfEligible()
    }

    func updateContext(isLibrary: Bool) {
        isLibraryContext = isLibrary
        if isLibrary {
            scheduleRequestIfEligible()
        } else {
            cancelScheduledRequest()
        }
    }

    private func scheduleRequestIfEligible() {
        guard isEligible else { return }

        cancelScheduledRequest()
        let workItem = DispatchWorkItem { [weak self] in
            self?.requestIfStillEligible()
        }
        scheduledRequest = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + requestDelay, execute: workItem)
    }

    private func requestIfStillEligible() {
        scheduledRequest = nil
        guard isEligible,
              let windowScene = windowScene(),
              windowScene.activationState == .foregroundActive
        else {
            return
        }

        var state = loadState()
        state.markRequested(version: currentVersion())
        saveState(state)
        requestReview(windowScene)
    }

    private var isEligible: Bool {
        isSceneActive
            && isLibraryContext
            && loadState().isEligible(for: currentVersion())
    }

    private func loadState() -> TraceReviewEligibilityState {
        TraceReviewEligibilityState(
            activityEntryIDs: Set(
                defaults.stringArray(forKey: DefaultsKey.activityEntryIDs) ?? []
            ),
            activityDayKeys: Set(
                defaults.stringArray(forKey: DefaultsKey.activityDayKeys) ?? []
            ),
            activityVersion: defaults.string(forKey: DefaultsKey.activityVersion),
            lastRequestedVersion: defaults.string(forKey: DefaultsKey.lastRequestedVersion)
        )
    }

    private func saveState(_ state: TraceReviewEligibilityState) {
        defaults.set(
            Array(state.activityEntryIDs).sorted(),
            forKey: DefaultsKey.activityEntryIDs
        )
        defaults.set(
            Array(state.activityDayKeys).sorted(),
            forKey: DefaultsKey.activityDayKeys
        )
        defaults.set(state.activityVersion, forKey: DefaultsKey.activityVersion)
        defaults.set(
            state.lastRequestedVersion,
            forKey: DefaultsKey.lastRequestedVersion
        )
    }

    private func cancelScheduledRequest() {
        scheduledRequest?.cancel()
        scheduledRequest = nil
    }

    private static func appVersion() -> String {
        let value = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String
        let version = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let version, !version.isEmpty else { return "unknown" }
        return version
    }

    private static func localDayKey() -> String {
        let components = Calendar.autoupdatingCurrent.dateComponents(
            [.era, .year, .month, .day],
            from: Date()
        )
        return [components.era, components.year, components.month, components.day]
            .map { String($0 ?? 0) }
            .joined(separator: "-")
    }

    private static func requestSystemReview(in scene: UIWindowScene) {
        if #available(iOS 18.0, *) {
            AppStore.requestReview(in: scene)
        } else {
            SKStoreReviewController.requestReview(in: scene)
        }
    }
}
