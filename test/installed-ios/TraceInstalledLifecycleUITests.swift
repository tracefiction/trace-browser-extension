import XCTest

final class TraceInstalledLifecycleUITests: XCTestCase {
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    private let traceApp = XCUIApplication(bundleIdentifier: "com.tracefiction.trace")

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
    }

    private func launchSafariFixture() {
        activateSafariPage()
        XCTAssertTrue(
            safari.staticTexts["Trace installed iOS fixture"].waitForExistence(timeout: 8)
        )
        XCTAssertTrue(
            safari.staticTexts["Browser-only Trace session is signed in."].waitForExistence(timeout: 5)
        )
    }

    private func activateSafariPage() {
        if safari.state == .notRunning {
            safari.launch()
        } else {
            safari.activate()
        }
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 8))
    }

    private func restartSafariPage() {
        safari.terminate()
        safari.launch()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 8))
    }

    private func launchTraceApp(
        seedStaleProvider: Bool = false,
        failProviderClear: Bool = false
    ) {
        traceApp.terminate()
        traceApp.launchEnvironment = [
            "traceDebugSeedStaleProvider": seedStaleProvider ? "true" : "false",
            "traceDebugFailProviderClear": failProviderClear ? "true" : "false",
        ]
        traceApp.launch()
        XCTAssertTrue(traceApp.wait(for: .runningForeground, timeout: 8))
        XCTAssertTrue(
            traceApp.staticTexts["Trace installed app fixture"].waitForExistence(timeout: 8)
        )
    }

    private func openTracePopup() {
        let traceExtension = safari.cells["Trace"]
        var menuReady = false
        for _ in 0..<3 where !menuReady {
            let pageMenu = safari.buttons["Page Menu"]
            XCTAssertTrue(pageMenu.waitForExistence(timeout: 5))
            pageMenu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let highlightsNotNow = safari.buttons["Not Now"]
            if highlightsNotNow.waitForExistence(timeout: 1) {
                highlightsNotNow.tap()
            }

            if traceExtension.waitForExistence(timeout: 3) {
                menuReady = true
                break
            }
            let manageExtensions = safari.cells["Manage Extensions"]
            if manageExtensions.waitForExistence(timeout: 2) {
                manageExtensions.tap()
                let traceSwitch = safari.switches["Trace"]
                XCTAssertTrue(traceSwitch.waitForExistence(timeout: 3))
                if (traceSwitch.value as? String) != "1" {
                    traceSwitch.tap()
                }
                safari.buttons["Done"].tap()
                menuReady = traceExtension.waitForExistence(timeout: 5)
            }
        }
        guard menuReady else {
            XCTFail("Safari never presented Trace or Manage Extensions in the page menu")
            return
        }
        XCTAssertTrue(waitForHittable(traceExtension, timeout: 5))

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
                    "CONNECTED",
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

    private func waitForPopupConnected(timeout: TimeInterval = 8) -> Bool {
        // The first-story projection uses the connection badge while later
        // projections also use "Connected" as the sheet heading. Safari may
        // expose the badge's visually uppercased text to accessibility.
        waitForPopupState(["Connected", "CONNECTED"], timeout: timeout)
    }

    private func waitForHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if element.exists && element.isHittable {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        return false
    }

    private func waitForTextContaining(
        _ fragment: String,
        in application: XCUIApplication,
        timeout: TimeInterval = 8
    ) -> XCUIElement {
        let element = application.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", fragment)
        ).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout))
        return element
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
        restartSafariPage()
        XCTAssertTrue(
            safari.staticTexts["Trace installed iOS fixture"].waitForExistence(timeout: 8)
        )
    }

    func testBrowserOnlySignInCannotConnectWithoutAppProvider() {
        launchSafariFixture()
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

    func testOpenTraceAppFromPopup() {
        launchSafariFixture()
        openTracePopup()
        let openApp = safari.links["Open Trace app"]
        XCTAssertTrue(openApp.waitForExistence(timeout: 5))
        openApp.tap()

        let openConfirmation = safari.buttons["Open"]
        if openConfirmation.waitForExistence(timeout: 2) {
            openConfirmation.tap()
        }

        XCTAssertTrue(traceApp.wait(for: .runningForeground, timeout: 8))
        XCTAssertTrue(
            traceApp.staticTexts["Trace installed app fixture"].waitForExistence(timeout: 8)
        )
        _ = waitForTextContaining(
            "/setup?setupPath=ios-app#first-story-setup",
            in: traceApp
        )
        XCTAssertNotEqual(safari.state, .runningForeground)

        launchSafariFixture()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }

    func testResetSession() {
        launchSafariFixture()
        openTracePopup()
        let disconnect = safari.buttons["Disconnect"]
        if disconnect.exists {
            disconnect.tap()
            XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        }
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }

    func testConnectRestartRetryAndDisconnect() {
        launchSafariFixture()
        control("ok-a")
        openTracePopup()
        safari.links["Connect"].tap()
        XCTAssertTrue(waitForPopupConnected())

        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(waitForPopupConnected())

        control("unavailable")
        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(
            safari.staticTexts["Trace is temporarily offline"].waitForExistence(timeout: 8)
        )
        control("ok-a")
        safari.links["Retry"].tap()
        XCTAssertTrue(waitForPopupConnected())

        safari.buttons["Disconnect"].tap()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }

    func testReturnAfterAppSignInRequiresExplicitConnect() {
        launchSafariFixture()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].exists)
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
        safari.links["Connect"].tap()
        XCTAssertTrue(waitForPopupConnected())
    }

    func testConnectAndSaveFromInstalledArchiveSender() {
        activateSafariPage()
        openTracePopup()

        // Reopen the work after Safari grants the extension site access so
        // the installed collector and DEBUG-only driver load together.
        restartSafariPage()
        XCTAssertTrue(
            safari.staticTexts["Installed Connect-and-save driver ready"]
                .waitForExistence(timeout: 20)
        )
        let connectAndSave = safari.buttons["Connect and save"]
        XCTAssertTrue(connectAndSave.waitForExistence(timeout: 15))
        let safariFrame = safari.frame
        let actionFrame = connectAndSave.frame
        safari.coordinate(withNormalizedOffset: CGVector(
            dx: actionFrame.midX / safariFrame.width,
            dy: actionFrame.midY / safariFrame.height
        )).tap()
        XCTAssertTrue(
            safari.staticTexts["Installed result: connected / saved"]
                .waitForExistence(timeout: 15)
        )
        XCTAssertTrue(safari.buttons["Saved"].exists)
    }

    func testLeaveReconnectRequiredForProviderChange() {
        launchSafariFixture()
        control("ok-a")
        openTracePopup()
        safari.links["Connect"].tap()
        XCTAssertTrue(waitForPopupConnected())

        control("rejected")
        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.links["Reconnect"].exists)
    }

    func testReconnectWithSameProvider() {
        launchSafariFixture()
        control("ok-a")
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 6))
        safari.links["Reconnect"].tap()
        XCTAssertTrue(waitForPopupConnected())
    }

    func testReconnectWithChangedProvider() {
        launchSafariFixture()
        control("ok-b")
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 6))
        safari.links["Reconnect"].tap()
        XCTAssertTrue(waitForPopupConnected())
    }

    func testLeaveReconnectRequiredForMissingProvider() {
        launchSafariFixture()
        control("rejected")
        openTracePopup()
        XCTAssertTrue(waitForPopupConnected(timeout: 6))
        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 8))
    }

    func testReconnectWithoutProviderFailsClosed() {
        launchSafariFixture()
        control("ok-b")
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 6))
        safari.links["Reconnect"].tap()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }

    func testConnectedSessionAfterAppSignOutNeedsReconnectOnRejection() {
        launchSafariFixture()
        control("ok-a")
        openTracePopup()
        XCTAssertTrue(waitForPopupConnected())
        control("rejected")
        relaunchSafari()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Reconnect Trace"].waitForExistence(timeout: 8))
    }

    func testAppSignedOutColdStartClearsStaleProvider() {
        launchTraceApp(seedStaleProvider: true)
        _ = waitForTextContaining("Bootstrap probe complete", in: traceApp)
    }

    func testAppSignInWritesProvider() {
        launchTraceApp()
        _ = waitForTextContaining("Provider ready", in: traceApp)
    }

    func testAppSignOutClearsProvider() {
        launchTraceApp()
        _ = waitForTextContaining("Provider ready", in: traceApp)
        traceApp.buttons["App sign out"].tap()
        _ = waitForTextContaining("Signed out and provider cleared", in: traceApp)
    }

    func testAppClearFailureBlocksSignOut() {
        launchTraceApp(failProviderClear: true)
        _ = waitForTextContaining("Provider ready", in: traceApp)
        traceApp.buttons["App sign out"].tap()
        _ = waitForTextContaining("Sign out blocked: provider_clear_failed", in: traceApp)
        _ = waitForTextContaining("Still signed in", in: traceApp)
        let retry = traceApp.buttons["Retry provider cleanup"]
        XCTAssertTrue(retry.exists)
        retry.tap()
        _ = waitForTextContaining("Signed out and provider cleared", in: traceApp)
    }

    func testAppResumeDoesNotAmbientlyConnect() {
        launchTraceApp()
        _ = waitForTextContaining("Provider ready", in: traceApp)
        launchSafariFixture()
        openTracePopup()
        XCTAssertTrue(safari.staticTexts["Connect Trace"].waitForExistence(timeout: 8))
        XCTAssertTrue(safari.staticTexts["NOT LINKED"].exists)
    }
}
