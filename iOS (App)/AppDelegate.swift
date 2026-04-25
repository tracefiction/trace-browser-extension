//
//  AppDelegate.swift
//  iOS (App)
//

import UIKit
import UserNotifications

extension Notification.Name {
    /// Posted with `deviceToken` (`Data`) when APNs registration succeeds.
    static let traceApnsDeviceTokenReceived = Notification.Name("traceApnsDeviceTokenReceived")
}

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .traceApnsDeviceTokenReceived, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[Trace] APNs registration failed: \(error.localizedDescription)")
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        let userInfo = response.notification.request.content.userInfo
        guard let trace = userInfo["trace"] as? [String: Any],
              let path = trace["path"] as? String,
              path.hasPrefix("/")
        else { return }

        let base = TraceWebViewController.webAppHTTPSOrigin
        var parts = URLComponents(string: base + path)
        parts?.queryItems = [URLQueryItem(name: "trace_app", value: "1")]
        guard let url = parts?.url else { return }

        DispatchQueue.main.async {
            TraceWebViewController.findInKeyWindow()?.loadTraceURL(url)
        }
    }
}
