import Foundation

@main
enum TraceReviewEligibilityContract {
    static func main() {
        var state = TraceReviewEligibilityState()

        state.recordActivity(entryID: "entry-1", dayKey: "day-1", version: "1.0")
        state.recordActivity(entryID: "entry-2", dayKey: "day-1", version: "1.0")
        state.recordActivity(entryID: "entry-3", dayKey: "day-1", version: "1.0")
        precondition(!state.isEligible(for: "1.0"), "one-day activity must not qualify")

        state.recordActivity(entryID: "entry-3", dayKey: "day-2", version: "1.0")
        precondition(state.isEligible(for: "1.0"), "three stories across two days should qualify")

        state.markRequested(version: "1.0")
        precondition(!state.isEligible(for: "1.0"), "a version may only request once")
        state.recordActivity(entryID: "entry-4", dayKey: "day-3", version: "1.0")
        precondition(!state.isEligible(for: "1.0"), "more activity must not requalify the same version")

        state.recordActivity(entryID: "entry-1", dayKey: "day-4", version: "1.1")
        precondition(!state.isEligible(for: "1.1"), "a new version starts a fresh batch")
        state.recordActivity(entryID: "entry-2", dayKey: "day-4", version: "1.1")
        state.recordActivity(entryID: "entry-3", dayKey: "day-5", version: "1.1")
        precondition(state.isEligible(for: "1.1"), "a new version may qualify independently")

        print("Trace review eligibility contract passed")
    }
}
