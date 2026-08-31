//
//  TraceReviewCoordinator.swift
//  iOS (App)
//

import StoreKit
import UIKit

@MainActor
final class TraceReviewCoordinator {
    private enum DefaultsKey {
        static let pendingVersion = "traceReviewPendingVersionV3"
        static let lastRequestedVersion = "traceReviewLastRequestedVersionV3"
        static let lastObservedActivityTimestamp =
            "traceReviewLastObservedActivityTimestampV3"
    }

    private static let maximumEntryIDLength = 200
    private static let maximumObservedActivityAge: TimeInterval = 7 * 24 * 60 * 60
    private static let maximumObservedActivityFutureSkew: TimeInterval = 5 * 60

    private let defaults: UserDefaults
    private let requestDelay: TimeInterval
    private let currentVersion: () -> String
    private let now: () -> Date
    private let windowScene: () -> UIWindowScene?
    private let requestReview: (UIWindowScene) -> Void

    private var isSceneActive = false
    private var isLibraryContext = false
    private var scheduledRequest: DispatchWorkItem?

    init(
        defaults: UserDefaults = .standard,
        requestDelay: TimeInterval = 2,
        currentVersion: @escaping () -> String = TraceReviewCoordinator.appVersion,
        now: @escaping () -> Date = Date.init,
        windowScene: @escaping () -> UIWindowScene?,
        requestReview: @escaping (UIWindowScene) -> Void = TraceReviewCoordinator.requestSystemReview
    ) {
        self.defaults = defaults
        self.requestDelay = requestDelay
        self.currentVersion = currentVersion
        self.now = now
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
        let changed = state.recordDirectActivity(version: currentVersion())
        saveState(state)
        if changed {
            scheduleRequestIfEligible()
        }
    }

    func observeSuccessfulLibraryActivity(at rawTimestamp: String) {
        guard let observedAt = Self.parseActivityTimestamp(rawTimestamp) else {
            return
        }

        var state = loadState()
        let changed = state.observeServerActivity(
            timestamp: observedAt.timeIntervalSince1970,
            now: now().timeIntervalSince1970,
            maximumAge: Self.maximumObservedActivityAge,
            maximumFutureSkew: Self.maximumObservedActivityFutureSkew,
            version: currentVersion()
        )
        saveState(state)
        if changed {
            scheduleRequestIfEligible()
        }
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
            pendingVersion: defaults.string(forKey: DefaultsKey.pendingVersion),
            lastRequestedVersion: defaults.string(forKey: DefaultsKey.lastRequestedVersion),
            lastObservedActivityTimestamp: defaults.object(
                forKey: DefaultsKey.lastObservedActivityTimestamp
            ) as? TimeInterval
        )
    }

    private func saveState(_ state: TraceReviewEligibilityState) {
        defaults.set(state.pendingVersion, forKey: DefaultsKey.pendingVersion)
        defaults.set(
            state.lastRequestedVersion,
            forKey: DefaultsKey.lastRequestedVersion
        )
        defaults.set(
            state.lastObservedActivityTimestamp,
            forKey: DefaultsKey.lastObservedActivityTimestamp
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

    private static func parseActivityTimestamp(_ value: String) -> Date? {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }

        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: normalized) {
            return date
        }

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: normalized)
    }

    private static func requestSystemReview(in scene: UIWindowScene) {
        if #available(iOS 18.0, *) {
            AppStore.requestReview(in: scene)
        } else {
            SKStoreReviewController.requestReview(in: scene)
        }
    }
}
