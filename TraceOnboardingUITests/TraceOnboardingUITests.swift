import XCTest

final class TraceOnboardingUITests: XCTestCase {
    private func launchApp(expectedArchiveHost: String) -> XCUIApplication {
        let fixtureURL = ProcessInfo.processInfo.environment["TRACE_ONBOARDING_UI_TEST_URL"] ??
            "http://127.0.0.1:5174/setup?setupPath=ios-app&setupAuth=authenticated&iosExtensionState=granted&trace_app=1#first-story-setup"

        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["--trace-onboarding-ui-test-url", fixtureURL]
        app.launchEnvironment["TRACE_UI_TEST_EXPECTED_ARCHIVE_HOST"] = expectedArchiveHost
        app.launch()
        return app
    }

    func testCapableShellOffersBothArchivesWithoutURLField() throws {
        let app = launchApp(expectedArchiveHost: "ao3")

        XCTAssertTrue(app.staticTexts["Open a story."].waitForExistence(timeout: 15))
        app.staticTexts["Open a story."].tap()
        XCTAssertTrue(app.buttons["Open AO3"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Open FanFiction.net"].exists)
        XCTAssertFalse(app.textFields.firstMatch.exists)

        app.buttons["Open AO3"].tap()

        XCTAssertTrue(
            app.staticTexts["Come back after you open a story."].waitForExistence(timeout: 5),
            "The web UI should receive the successful AO3 V2 bridge response."
        )
    }

    func testFanFictionNetChoiceSendsFFNHostToNativeBridge() throws {
        let app = launchApp(expectedArchiveHost: "ffn")

        XCTAssertTrue(app.staticTexts["Open a story."].waitForExistence(timeout: 15))
        app.staticTexts["Open a story."].tap()
        XCTAssertTrue(app.buttons["Open FanFiction.net"].waitForExistence(timeout: 15))
        app.buttons["Open FanFiction.net"].tap()

        let awaiting = app.staticTexts["Come back after you open a story."]
        if !awaiting.waitForExistence(timeout: 5) {
            let nativeError = app.staticTexts["Trace could not open FanFiction.net. Try again."].exists
            let stillOnStoryScreen = app.staticTexts["Open a story."].exists
            XCTFail(
                "FFN bridge did not reach awaiting state (nativeError=\(nativeError), stillOnStoryScreen=\(stillOnStoryScreen))."
            )
        }
    }
}
