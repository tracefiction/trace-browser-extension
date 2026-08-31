import Foundation

@main
enum TraceReviewEligibilityContract {
    static func main() {
        var state = TraceReviewEligibilityState()
        let now: TimeInterval = 2_000_000
        let week: TimeInterval = 7 * 24 * 60 * 60

        precondition(
            state.recordDirectActivity(version: "1.0"),
            "one successful direct edit should qualify"
        )
        precondition(state.isEligible(for: "1.0"), "direct activity should be pending")
        precondition(
            !state.recordDirectActivity(version: "1.0"),
            "repeated direct messages must not create another opportunity"
        )

        state.markRequested(version: "1.0")
        precondition(!state.isEligible(for: "1.0"), "a version may only request once")
        state.recordDirectActivity(version: "1.0")
        precondition(!state.isEligible(for: "1.0"), "more activity must not requalify the same version")

        precondition(
            state.observeServerActivity(
                timestamp: now - 60,
                now: now,
                maximumAge: week,
                maximumFutureSkew: 300,
                version: "1.1"
            ),
            "a fresh server marker should qualify a new version"
        )
        precondition(state.isEligible(for: "1.1"), "fresh marker should be pending")
        state.markRequested(version: "1.1")

        precondition(
            !state.observeServerActivity(
                timestamp: now - 60,
                now: now + week,
                maximumAge: week,
                maximumFutureSkew: 300,
                version: "1.2"
            ),
            "the same marker must not replay in a later version"
        )
        precondition(!state.isEligible(for: "1.2"), "replayed marker must stay ineligible")

        var staleState = TraceReviewEligibilityState()
        precondition(
            !staleState.observeServerActivity(
                timestamp: now - week - 1,
                now: now,
                maximumAge: week,
                maximumFutureSkew: 300,
                version: "1.2"
            ),
            "stale activity must be consumed without prompting"
        )
        precondition(
            !staleState.observeServerActivity(
                timestamp: now - week - 1,
                now: now,
                maximumAge: week,
                maximumFutureSkew: 300,
                version: "1.2"
            ),
            "a consumed stale marker must not replay"
        )

        var futureState = TraceReviewEligibilityState()
        precondition(
            !futureState.observeServerActivity(
                timestamp: now + 301,
                now: now,
                maximumAge: week,
                maximumFutureSkew: 300,
                version: "1.2"
            ),
            "implausibly future activity must not prompt"
        )

        precondition(
            futureState.observeServerActivity(
                timestamp: now + 302,
                now: now + 600,
                maximumAge: week,
                maximumFutureSkew: 300,
                version: "1.2"
            ),
            "a newer marker within clock skew should qualify"
        )
        precondition(futureState.isEligible(for: "1.2"), "new marker should be pending")

        print("Trace review eligibility contract passed")
    }
}
