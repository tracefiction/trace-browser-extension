//
//  SceneDelegate.swift
//  iOS (App)
//

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }
        let window = UIWindow(windowScene: windowScene)

        let traceVC = TraceWebViewController()
        let nav = UINavigationController(rootViewController: traceVC)
        nav.navigationBar.prefersLargeTitles = false
        nav.setNavigationBarHidden(true, animated: false)

        window.rootViewController = nav
        self.window = window
        window.makeKeyAndVisible()

        if let url = connectionOptions.urlContexts.first?.url {
            traceVC.handleAuthCallback(url: url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        traceWebViewController(from: window)?.handleAuthCallback(url: url)
    }

    private func traceWebViewController(from window: UIWindow?) -> TraceWebViewController? {
        if let nav = window?.rootViewController as? UINavigationController {
            return nav.topViewController as? TraceWebViewController
        }
        return window?.rootViewController as? TraceWebViewController
    }
}
