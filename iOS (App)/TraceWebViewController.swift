//
//  TraceWebViewController.swift
//  iOS (App)
//
//  WKWebView shell: OAuth via ASWebAuthenticationSession; full-bleed web (no native nav bar).
//  Injects `window.__TRACE_NATIVE_SHELL__` and loads `?trace_app=1` for SPA detection.
//

import AuthenticationServices
import StoreKit
import UIKit
import UserNotifications
import WebKit
import WidgetKit

final class TraceWebViewController: UIViewController, WKNavigationDelegate,
    WKUIDelegate, WKScriptMessageHandler, ASWebAuthenticationPresentationContextProviding,
    UIAdaptivePresentationControllerDelegate
{
    /// HTTPS origin only (no query) — used for auth callback rewrite, default load, and `postMessage` target.
#if DEBUG
    /// Same value as TRACE_WEB_ORIGIN in repo root .env — run `npm run build` to regenerate TraceWebOrigin.generated.swift.
    private static let webAppHTTPSOriginDebug = TraceWebOriginGenerated.httpsOrigin
#endif
    static var webAppHTTPSOrigin: String {
#if DEBUG
        return webAppHTTPSOriginDebug
#else
        return "https://tracefiction.com"
#endif
    }

    /// Must match `WEB_SHELL_UA` in `client/src/auth/auth-return.ts`.
    static let webShellUserAgentToken = "TraceFictionWebShell/1"

    private var webView: WKWebView!
    private lazy var billingCoordinator = TraceBillingCoordinator(
        apiBaseURL: Self.billingAPIBaseURL
    ) { [weak self] in
        guard let self else {
            throw TraceBillingFlowError.signInRequired
        }
        return try await self.fetchTraceShellAccessToken()
    }

    private var authSession: ASWebAuthenticationSession?
    private weak var activeBillingPaywall: UIViewController?
    private var suppressBillingPaywallDidDismissResult = false

    private var apnsTokenObserver: NSObjectProtocol?

    private enum TraceBillingFlowError: Error {
        case signInRequired
    }

    private enum TraceBillingOperation: String {
        case showPaywall
        case restore
    }

    private struct TraceBillingResultPayload: Encodable {
        let type = "TRACE_BILLING_RESULT"
        let status: String
        let op: String?
        let message: String?
        let code: String?
        let pro: Bool?
        let proExpiresAt: String?

        enum CodingKeys: String, CodingKey {
            case type
            case status
            case op
            case message
            case code
            case pro
            case proExpiresAt = "pro_expires_at"
        }
    }

    private static var billingAPIBaseURL: URL {
        if let configured = configuredBillingAPIBaseURLOverride {
            return configured
        }

#if DEBUG
        if let host = URL(string: webAppHTTPSOrigin)?.host?.lowercased(),
           host == "localhost" || host == "127.0.0.1" {
            return URL(string: "http://localhost:3001")!
        }
#endif
        return URL(string: "https://api.tracefiction.com")!
    }

    private static var configuredBillingAPIBaseURLOverride: URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "TRACE_API_BASE_URL") as? String else {
            return nil
        }

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              (scheme == "https" || scheme == "http")
        else {
            return nil
        }

        return url
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let injectShellFlag = """
        (function() {
          try {
            Object.defineProperty(window, '__TRACE_NATIVE_SHELL__', { value: true, writable: false, configurable: false });
          } catch (e) {}
        })();
        """
        let shellScript = WKUserScript(
            source: injectShellFlag,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(shellScript)
        config.userContentController.add(self, name: "traceWidget")
        config.userContentController.add(self, name: "tracePush")
        config.userContentController.add(self, name: "traceBilling")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        // Edge-to-edge: safe areas are handled in CSS (`viewport-fit=cover`, `env(safe-area-inset-*)`).
        // Pinning to `safeAreaLayoutGuide` left black strips beside curved display edges.
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        // Bottom nav and other `<a href>` controls are still links; long-press otherwise shows system link preview / “Open in Browser”.
        wv.allowsLinkPreview = false
        // App shell: disable pinch zoom (layout is fixed; accidental zoom is confusing).
        wv.scrollView.minimumZoomScale = 1.0
        wv.scrollView.maximumZoomScale = 1.0
        wv.scrollView.pinchGestureRecognizer?.isEnabled = false
        wv.customUserAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 \(Self.webShellUserAgentToken)"
        webView = wv

        let container = UIView()
        // Matches archive `--bg-app` (#f5f1e8) for any frame before first paint; web paints full bleed.
        container.backgroundColor = UIColor(red: 245 / 255, green: 241 / 255, blue: 232 / 255, alpha: 1)
        wv.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: container.topAnchor),
            wv.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationController?.setNavigationBarHidden(true, animated: false)
        apnsTokenObserver = NotificationCenter.default.addObserver(
            forName: .traceApnsDeviceTokenReceived,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let data = note.object as? Data else { return }
            self?.forwardApnsTokenToWeb(data)
        }
        loadDefaultOrigin()
        Self.writeWidgetSharedWebOrigin()
        WidgetCenter.shared.reloadAllTimelines()
    }

    deinit {
        if let o = apnsTokenObserver {
            NotificationCenter.default.removeObserver(o)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
    }

    /// Load a Trace web URL in the shell (e.g. notification deep link).
    func loadTraceURL(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    static func findInKeyWindow() -> TraceWebViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes {
            guard let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { continue }
            if let found = findTraceWeb(in: root) { return found }
        }
        return nil
    }

    private static func findTraceWeb(in vc: UIViewController) -> TraceWebViewController? {
        if let t = vc as? TraceWebViewController { return t }
        if let nav = vc as? UINavigationController, let top = nav.topViewController {
            return findTraceWeb(in: top)
        }
        if let tab = vc as? UITabBarController, let sel = tab.selectedViewController {
            return findTraceWeb(in: sel)
        }
        return nil
    }

    func loadDefaultOrigin() {
        guard let base = URL(string: Self.webAppHTTPSOrigin),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return }
        if components.path.isEmpty { components.path = "/" }
        components.queryItems = [URLQueryItem(name: "trace_app", value: "1")]
        guard let url = components.url else { return }
        webView.load(URLRequest(url: url))
    }

    /// Handles Auth0-style callbacks routed to `traceauth://…` (cold start / universal links).
    func handleAuthCallback(url: URL) {
        guard let target = Self.rewriteTraceAuthURL(url) else { return }
        webView.load(URLRequest(url: target))
    }

    /// Maps `traceauth://callback?…` → `{webAppHTTPSOrigin}/auth/callback?…`
    static func rewriteTraceAuthURL(_ url: URL) -> URL? {
        guard url.scheme?.lowercased() == "traceauth" else { return url }
        var parts = URLComponents()
        parts.scheme = "https"
        parts.host = URL(string: Self.webAppHTTPSOrigin)?.host ?? "tracefiction.com"
        parts.path = "/auth/callback"
        parts.query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.query
        return parts.url
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if shouldOpenInAuthenticationSession(url),
           (navigationAction.targetFrame?.isMainFrame ?? true) {
            decisionHandler(.cancel)
            startAuthenticationSession(startURL: url)
            return
        }
        decisionHandler(.allow)
    }

    /// `target=_blank` — return `nil` and load externally or in this web view (no second WKWebView).
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if shouldOpenInAuthenticationSession(url) {
            startAuthenticationSession(startURL: url)
            return nil
        }
        if url.scheme == "http" || url.scheme == "https" {
            if traceAppHostsMatch(url) {
                webView.load(navigationAction.request)
            } else {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
        }
        return nil
    }

    private func traceAppHostsMatch(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        if host == "tracefiction.com" || host == "www.tracefiction.com" { return true }
        if let appHost = URL(string: Self.webAppHTTPSOrigin)?.host?.lowercased(), host == appHost {
            return true
        }
        return false
    }

    private func shouldOpenInAuthenticationSession(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }

        if host == "accounts.google.com" { return true }
        if host == "oauth2.googleapis.com" { return true }

        if host.hasSuffix(".auth0.com"), url.path.contains("/authorize") {
            return true
        }

        return false
    }

    private func startAuthenticationSession(startURL: URL) {
        authSession?.cancel()
        let session = ASWebAuthenticationSession(
            url: startURL,
            callbackURLScheme: "traceauth"
        ) { [weak self] callbackURL, error in
            guard let self = self else { return }
            self.authSession = nil
            guard error == nil,
                  let callbackURL = callbackURL,
                  let httpsURL = Self.rewriteTraceAuthURL(callbackURL)
            else { return }
            self.webView.load(URLRequest(url: httpsURL))
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        session.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let w = view.window { return w }
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }!
    }

    // MARK: - Widget bridge (WKScriptMessageHandler)

    private static let widgetAppGroup = "group.com.tracefiction.trace"
    private static let widgetDefaultsKey = "currentlyReading"
    /// Written so WidgetKit `widgetURL` matches DEBUG vs release shell (`TraceWebOrigin.generated.swift` / prod).
    private static let widgetWebOriginKey = "widgetWebOrigin"

    private static func writeWidgetSharedWebOrigin() {
        guard let defaults = UserDefaults(suiteName: widgetAppGroup) else { return }
        defaults.set(webAppHTTPSOrigin, forKey: widgetWebOriginKey)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == "tracePush" {
            handleTracePushMessage(message)
            return
        }

        if message.name == "traceBilling" {
            handleTraceBillingMessage(message)
            return
        }

        guard message.name == "traceWidget",
              let body = message.body as? [String: Any]
        else { return }

        guard let defaults = UserDefaults(suiteName: Self.widgetAppGroup) else { return }
        Self.writeWidgetSharedWebOrigin()
        if let data = try? JSONSerialization.data(withJSONObject: body) {
            defaults.set(data, forKey: Self.widgetDefaultsKey)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func handleTracePushMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              (body["op"] as? String) == "requestPermissionAndRegister"
        else { return }

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    private func forwardApnsTokenToWeb(_ data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        let origin = Self.webAppHTTPSOrigin
        let js = "window.postMessage({ type: 'TRACE_APNS_TOKEN', token: '\(hex)', environment: '\(env)' }, '\(origin)');"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func handleTraceBillingMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let opRaw = body["op"] as? String,
              let op = TraceBillingOperation(rawValue: opRaw)
        else {
            postBillingResult(
                status: "error",
                op: nil,
                message: "Invalid billing request from web app.",
                code: "invalid_request"
            )
            return
        }

        switch op {
        case .showPaywall:
            presentTraceBillingPaywall()
        case .restore:
            restoreTraceBillingPurchases()
        }
    }

    @MainActor
    private func presentTraceBillingPaywall() {
        Task { [weak self] in
            guard let self else { return }

            do {
                let products = try await billingCoordinator.fetchProducts()
                await MainActor.run {
                    self.presentBillingPicker(products: products)
                }
            } catch {
                await MainActor.run {
                    self.postBillingResult(
                        status: "error",
                        op: .showPaywall,
                        message: "Unable to load App Store subscription options.",
                        code: "products_unavailable"
                    )
                }
            }
        }
    }

    @MainActor
    private func presentBillingPicker(products: [Product]) {
        guard activeBillingPaywall == nil else { return }

        guard !products.isEmpty else {
            postBillingResult(
                status: "error",
                op: .showPaywall,
                message: "No App Store products are available right now.",
                code: "products_unavailable"
            )
            return
        }

        let paywall = TraceSubscriptionPaywallViewController(
            products: products,
            onSubscribe: { [weak self] product in
                self?.dismissBillingPaywall(sendCancelledResult: false) {
                    self?.purchaseTraceBillingProduct(product)
                }
            },
            onRestore: { [weak self] in
                self?.dismissBillingPaywall(sendCancelledResult: false) {
                    self?.restoreTraceBillingPurchases()
                }
            },
            onDismiss: { [weak self] in
                self?.dismissBillingPaywall(sendCancelledResult: true)
            }
        )

        let nav = UINavigationController(rootViewController: paywall)
        nav.modalPresentationStyle = .pageSheet
        nav.presentationController?.delegate = self
        if let sheet = nav.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        activeBillingPaywall = nav
        suppressBillingPaywallDidDismissResult = false
        present(nav, animated: true)
    }

    @MainActor
    private func dismissBillingPaywall(sendCancelledResult: Bool, completion: (() -> Void)? = nil) {
        guard let paywall = activeBillingPaywall else {
            if sendCancelledResult {
                postBillingResult(status: "cancelled", op: .showPaywall)
            }
            completion?()
            return
        }

        suppressBillingPaywallDidDismissResult = true
        paywall.dismiss(animated: true) { [weak self] in
            guard let self else { return }
            self.activeBillingPaywall = nil
            self.suppressBillingPaywallDidDismissResult = false
            if sendCancelledResult {
                self.postBillingResult(status: "cancelled", op: .showPaywall)
            }
            completion?()
        }
    }

    @MainActor
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard let paywall = activeBillingPaywall,
              presentationController.presentedViewController === paywall
        else {
            return
        }

        activeBillingPaywall = nil
        let shouldSuppress = suppressBillingPaywallDidDismissResult
        suppressBillingPaywallDidDismissResult = false
        if !shouldSuppress {
            postBillingResult(status: "cancelled", op: .showPaywall)
        }
    }

    @MainActor
    private func purchaseTraceBillingProduct(_ product: Product) {
        Task { [weak self] in
            guard let self else { return }

            do {
                let result = try await billingCoordinator.purchase(product: product)
                await MainActor.run {
                    self.postBillingResult(
                        status: "success",
                        op: .showPaywall,
                        pro: result.pro,
                        proExpiresAt: result.proExpiresAt
                    )
                }
            } catch {
                await MainActor.run {
                    self.postMappedBillingError(error, for: .showPaywall)
                }
            }
        }
    }

    @MainActor
    private func restoreTraceBillingPurchases() {
        Task { [weak self] in
            guard let self else { return }

            do {
                let result = try await billingCoordinator.restore()
                await MainActor.run {
                    self.postBillingResult(
                        status: "success",
                        op: .restore,
                        pro: result.pro,
                        proExpiresAt: result.proExpiresAt
                    )
                }
            } catch {
                await MainActor.run {
                    self.postMappedBillingError(error, for: .restore)
                }
            }
        }
    }

    @MainActor
    private func fetchTraceShellAccessToken() async throws -> String {
        do {
            let js = """
            if (typeof window.__traceShellGetAccessToken !== 'function') {
                throw new Error('missing_access_token_bridge');
            }
            const payload = await window.__traceShellGetAccessToken();
            if (!payload || typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
                throw new Error('missing_access_token');
            }
            return payload.accessToken;
            """
            let value = try await webView.callAsyncJavaScript(
                js,
                arguments: [:],
                in: nil,
                contentWorld: .page
            )
            guard let token = value as? String, !token.isEmpty else {
                throw TraceBillingFlowError.signInRequired
            }
            return token
        } catch {
            throw TraceBillingFlowError.signInRequired
        }
    }

    @MainActor
    private func postMappedBillingError(_ error: Error, for op: TraceBillingOperation) {
        if error is TraceBillingFlowError {
            postBillingResult(
                status: "error",
                op: op,
                message: "Sign in again to complete purchase verification.",
                code: "sign_in_required"
            )
            return
        }

        if let billingError = error as? TraceBillingCoordinator.BillingError {
            switch billingError {
            case .purchaseCancelled:
                postBillingResult(status: "cancelled", op: op)
            case .purchasePending:
                postBillingResult(
                    status: "error",
                    op: op,
                    message: "Purchase is pending approval. Try again in a moment.",
                    code: "purchase_pending"
                )
            case .productsUnavailable:
                postBillingResult(
                    status: "error",
                    op: op,
                    message: "Unable to load App Store products right now.",
                    code: "products_unavailable"
                )
            case .unverifiedTransaction:
                postBillingResult(
                    status: "error",
                    op: op,
                    message: "Apple could not verify this transaction on device.",
                    code: "transaction_unverified"
                )
            case .noRestorablePurchase:
                postBillingResult(
                    status: "error",
                    op: op,
                    message: "No active Apple subscription found to restore.",
                    code: "no_restorable_purchase"
                )
            case let .verifyRejected(code, _):
                postBillingResult(
                    status: "error",
                    op: op,
                    message: "Purchase verification failed on the server.",
                    code: code
                )
            case .verifyTransportFailed, .invalidVerifyResponse:
                postBillingResult(
                    status: "error",
                    op: op,
                    message: "Could not verify purchase right now. Please try again.",
                    code: "verify_unavailable"
                )
            }
            return
        }

        postBillingResult(
            status: "error",
            op: op,
            message: "Something went wrong while processing Apple billing.",
            code: "billing_unknown"
        )
    }

    @MainActor
    private func postBillingResult(
        status: String,
        op: TraceBillingOperation?,
        message: String? = nil,
        code: String? = nil,
        pro: Bool? = nil,
        proExpiresAt: String? = nil
    ) {
        let payload = TraceBillingResultPayload(
            status: status,
            op: op?.rawValue,
            message: message,
            code: code,
            pro: pro,
            proExpiresAt: proExpiresAt
        )

        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }

        let origin = Self.webAppHTTPSOrigin
        let js = "window.postMessage(\(json), '\(origin)');"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
}
