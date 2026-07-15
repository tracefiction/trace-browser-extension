import XCTest

final class TraceInstalledLifecycleUITests: XCTestCase {
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")

    private var fixtureOrigin: URL {
        guard
            let raw = ProcessInfo.processInfo.environment["TRACE_IOS_FIXTURE_ORIGIN"],
            let url = URL(string: raw)
        else {
            XCTFail("TRACE_IOS_FIXTURE_ORIGIN is required")
            return URL(string: "http://127.0.0.1")!
        }
        return url
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        safari.launch()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 8))
        openFixturePage()
    }

    private func openFixturePage() {
        let address = safari.textFields["Address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText(fixtureOrigin.absoluteString)
        safari.keyboards.buttons["go"].tap()
        XCTAssertTrue(
            safari.staticTexts["Trace installed iOS fixture"].waitForExistence(timeout: 8)
        )
    }

    private func openTracePopup() {
        let pageMenu = safari.buttons["Page Menu"]
        XCTAssertTrue(pageMenu.waitForExistence(timeout: 5))
        pageMenu.tap()
        let highlightsNotNow = safari.buttons["Not Now"]
        if highlightsNotNow.waitForExistence(timeout: 1) {
            highlightsNotNow.tap()
        }

        let traceExtension = safari.cells["Trace"]
        if !traceExtension.waitForExistence(timeout: 1) {
            let manageExtensions = safari.cells["Manage Extensions"]
            XCTAssertTrue(manageExtensions.waitForExistence(timeout: 3))
            manageExtensions.tap()

            let traceSwitch = safari.switches["Trace"]
            XCTAssertTrue(traceSwitch.waitForExistence(timeout: 3))
            if (traceSwitch.value as? String) != "1" {
                traceSwitch.tap()
            }
            safari.buttons["Done"].tap()
        }
        XCTAssertTrue(traceExtension.waitForExistence(timeout: 5))
        XCTAssertTrue(traceExtension.isHittable)

        // Safari exposes the extension row to accessibility but ignores a
        // semantic `Cell.tap()`. Use the row's stable screen frame, not a
        // Mac-window coordinate, so Simulator size/position does not matter.
        let screen = safari.frame
        let row = traceExtension.frame
        let offset = CGVector(
            dx: row.midX / screen.width,
            dy: row.midY / screen.height
        )
        safari.coordinate(withNormalizedOffset: offset).tap()

        let allowForOneDay = safari.buttons["Allow for One Day"]
        if allowForOneDay.waitForExistence(timeout: 2) {
            allowForOneDay.tap()
        }
        XCTAssertTrue(
            waitForPopupState(
                [
                    "Connect Trace",
                    "Connected",
                    "Trace is temporarily offline",
                    "Reconnect Trace",
                    "Checking Trace",
                ],
                timeout: 8
            ),
            "Trace popup did not reach a recognized kernel state"
        )
    }

    private func waitForPopupState(_ labels: [String], timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if labels.contains(where: { safari.staticTexts[$0].exists }) {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        return false
    }

    private func control(_ mode: String) {
        let expectation = expectation(description: "fixture mode \(mode)")
        var request = URLRequest(url: fixtureOrigin.appending(path: "__control"))
        request.httpMethod = "POST"
        request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(mode.utf8)
        URLSession.shared.dataTask(with: request) { _, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
            expectation.fulfill()
        }.resume()
        wait(for: [expectation], timeout: 5)
    }

    private func relaunchSafari() {
        safari.terminate()
        safari.launch()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 8))
        openFixturePage()
    }

    func testSignedOutConnectWithoutAppCredentialFailsClosed() {
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
        XCTAssertTrue(
            safari.staticTexts.matching(
                NSPredicate(
                    format: "label CONTAINS %@",
                    "Signing in on tracefiction.com in Safari does not connect this extension"
                )
            ).firstMatch.exists
        )
        let connect = safari.links["Connect"]
        XCTAssertTrue(connect.exists)
        connect.tap()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 5))
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }

    func testResetSession() {
        openTracePopup()
        let disconnect = safari.buttons["Disconnect"]
        if disconnect.exists {
            disconnect.tap()
            XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        }
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }

    func testConnectRestartRetryAndDisconnect() {
        control("ok-a")
        openTracePopup()
        safari.links["Connect"].tap()
        XCTAssertTrue(safari.staticTexts["Connected"].waitForExistence(timeout: 8))

        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Connected"].waitForExistence(timeout: 8))

        control("unavailable")
        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(
            safari.staticTexts["Trace is temporarily offline"].waitForExistence(timeout: 8)
        )
        control("ok-a")
        safari.links["Retry"].tap()
        XCTAssertTrue(safari.staticTexts["Connected"].waitForExistence(timeout: 8))

        safari.buttons["Disconnect"].tap()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }

    func testLeaveReconnectRequiredForProviderChange() {
        control("ok-a")
        openTracePopup()
        safari.links["Connect"].tap()
        XCTAssertTrue(safari.staticTexts["Connected"].waitForExistence(timeout: 8))

        control("rejected")
        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.links["Reconnect"].exists)
    }

    func testReconnectWithChangedProvider() {
        control("ok-b")
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 6))
        safari.links["Reconnect"].tap()
        XCTAssertTrue(safari.staticTexts["Connected"].waitForExistence(timeout: 8))
    }

    func testLeaveReconnectRequiredForMissingProvider() {
        control("rejected")
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Connected"].waitForExistence(timeout: 6))
        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 8))
    }

    func testReconnectWithoutProviderFailsClosed() {
        control("ok-b")
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 6))
        safari.links["Reconnect"].tap()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }
}
