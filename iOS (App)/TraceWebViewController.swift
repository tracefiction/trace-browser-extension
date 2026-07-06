//
//  TraceWebViewController.swift
//  iOS (App)
//
//  WKWebView shell: OAuth via ASWebAuthenticationSession; full-bleed web (no native nav bar).
//  Injects `window.__TRACE_NATIVE_SHELL__` and loads `?trace_app=1` for SPA detection.
//

import AuthenticationServices
import Security
import SafariServices
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
    private var traceLoadFailureView: UIView?
    private var activeTraceNavigationURL: URL?
    private var lastIntendedTraceURL: URL?
    private var failedTraceURL: URL?
    private lazy var billingCoordinator = TraceBillingCoordinator(
        apiBaseURL: Self.billingAPIBaseURL
    ) { [weak self] in
        guard let self else {
            throw TraceBillingFlowError.signInRequired
        }
        return try await self.fetchTraceShellAccessToken()
    }

    private var authSession: ASWebAuthenticationSession?
    private var activeAuthSessionID: UUID?
    private weak var activeAuthRecoveryAlert: UIAlertController?
    private weak var activeBillingPaywall: UIViewController?
    private var suppressBillingPaywallDidDismissResult = false

    private var apnsTokenObserver: NSObjectProtocol?

    private static let shellBackgroundColor = UIColor(
        red: 245 / 255,
        green: 241 / 255,
        blue: 232 / 255,
        alpha: 1
    )
    private static let shellTextColor = UIColor(red: 38 / 255, green: 32 / 255, blue: 26 / 255, alpha: 1)
    private static let shellMutedTextColor = UIColor(red: 104 / 255, green: 95 / 255, blue: 83 / 255, alpha: 1)
    private static let shellAccentColor = UIColor(red: 43 / 255, green: 91 / 255, blue: 78 / 255, alpha: 1)

    private enum TraceBillingFlowError: Error {
        case signInRequired
    }

    private enum TraceBillingOperation: String {
        case showPaywall
        case restore
        case manageSubscriptions
    }

    private enum TraceAuthRecoveryKind {
        case cancelled
        case failed
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

    private struct TracePushResultPayload: Encodable {
        let type = "TRACE_PUSH_RESULT"
        let status: String
        let message: String?
        let code: String?
    }

    private struct TraceAPNSTokenPayload: Encodable {
        let type = "TRACE_APNS_TOKEN"
        let token: String
        let environment: String
    }

    private struct TraceSafariExtensionStatePayload: Encodable {
        let type = "TRACE_IOS_EXTENSION_STATE"
        let nonce: String
        let enabled: Bool
        let settingsSupported: Bool
        let error: String?
    }

    private struct TraceSafariExtensionActionPayload: Encodable {
        let type: String
        let nonce: String
        let ok: Bool
        let error: String?
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
        config.userContentController.add(self, name: "traceDownload")
        config.userContentController.add(self, name: "traceSafariExtension")

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
        // The web UI is a bounded app surface. Keep the vertical scroll feel,
        // but do not let the WKWebView rubber-band sideways like a zoomed page.
        wv.scrollView.alwaysBounceHorizontal = false
        wv.scrollView.showsHorizontalScrollIndicator = false
        wv.scrollView.isDirectionalLockEnabled = true
        // WKWebView is backed by a UIScrollView. Avoid deferring the first tap
        // while the scroll view decides whether a touch is a scroll gesture.
        wv.scrollView.delaysContentTouches = false
        wv.scrollView.canCancelContentTouches = true
        wv.customUserAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 \(Self.webShellUserAgentToken)"
        webView = wv

        let container = UIView()
        // Matches archive `--bg-app` (#f5f1e8) for any frame before first paint; web paints full bleed.
        container.backgroundColor = Self.shellBackgroundColor
        wv.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: container.topAnchor),
            wv.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        let failureView = makeTraceLoadFailureView()
        failureView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(failureView)
        NSLayoutConstraint.activate([
            failureView.topAnchor.constraint(equalTo: container.topAnchor),
            failureView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            failureView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            failureView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        traceLoadFailureView = failureView

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
#if DEBUG
        if Self.shouldShowDebugLoadFailureView {
            if let url = Self.defaultTraceURL() {
                lastIntendedTraceURL = url
                showTraceLoadFailureView(for: url)
            }
        } else {
            loadDefaultOrigin()
        }
#else
        loadDefaultOrigin()
#endif
        Self.writeWidgetSharedWebOrigin()
        WidgetCenter.shared.reloadAllTimelines()
    }

    deinit {
        if let o = apnsTokenObserver {
            NotificationCenter.default.removeObserver(o)
        }
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "traceWidget")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "tracePush")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "traceBilling")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "traceDownload")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "traceSafariExtension")
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
    }

    /// Load a Trace web URL in the shell (e.g. notification deep link).
    func loadTraceURL(_ url: URL) {
        loadTraceURLRequest(url)
    }

    func handleSceneDidBecomeActive() {
        guard isViewLoaded else { return }
        primeWebViewInteractionAfterResume()
        DispatchQueue.main.async { [weak self] in
            self?.primeWebViewInteractionAfterResume()
            self?.installResumeClickFallback()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.primeWebViewInteractionAfterResume()
        }
    }

    private func primeWebViewInteractionAfterResume() {
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.isDirectionalLockEnabled = true
        webView.scrollView.delaysContentTouches = false
        webView.scrollView.canCancelContentTouches = true
        view.window?.makeKey()
        view.endEditing(true)
        webView.becomeFirstResponder()
    }

    private func installResumeClickFallback() {
        webView.evaluateJavaScript(
            """
            (function() {
              try {
                if (window.__traceResumeClickFallbackCleanup) {
                  try { window.__traceResumeClickFallbackCleanup(); } catch (e) {}
                }
                var done = false;
                var cleanups = [];
                var firstStartSeen = false;
                var firstStartTimer = null;
                var noClickAfterEndTimer = null;
                var listenerLifetimeTimer = null;
                var duplicateClickSuppressorTimer = null;
                var startTarget = null;
                var startPoint = null;
                var endTarget = null;
                var endPoint = null;
                var movedTooFar = false;
                var fallbackClickDispatched = false;
                var TAP_SLOP_PX = 14;
                var pointFromEvent = function(event) {
                  var source = event.touches && event.touches.length
                    ? event.touches[0]
                    : event.changedTouches && event.changedTouches.length
                      ? event.changedTouches[0]
                      : event;
                  var x = typeof source.clientX === 'number' ? source.clientX : null;
                  var y = typeof source.clientY === 'number' ? source.clientY : null;
                  return { x: x, y: y };
                };
                var distance = function(a, b) {
                  if (!a || !b || a.x === null || a.y === null || b.x === null || b.y === null) {
                    return 0;
                  }
                  var dx = b.x - a.x;
                  var dy = b.y - a.y;
                  return Math.sqrt(dx * dx + dy * dy);
                };
                var targetForPoint = function(point) {
                  if (point && point.x !== null && point.y !== null) {
                    return document.elementFromPoint(point.x, point.y);
                  }
                  return null;
                };
                var rememberStart = function(event) {
                  if (firstStartSeen) return;
                  firstStartSeen = true;
                  startTarget = event.target;
                  startPoint = pointFromEvent(event);
                  armNoCompletionTimer();
                };
                var rememberMove = function(event) {
                  if (!firstStartSeen || movedTooFar || !startPoint) return;
                  var point = pointFromEvent(event);
                  if (distance(startPoint, point) > TAP_SLOP_PX) {
                    movedTooFar = true;
                  }
                };
                var rememberEnd = function(event) {
                  endTarget = event.target;
                  endPoint = pointFromEvent(event);
                  if (distance(startPoint, endPoint) > TAP_SLOP_PX) {
                    movedTooFar = true;
                  }
                };
                var clickableFallbackTarget = function() {
                  var pointTarget = targetForPoint(endPoint);
                  var raw = pointTarget || endTarget || startTarget;
                  if (!raw || !(raw instanceof Element)) return null;
                  var direct = raw.closest(
                    'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="checkbox"],[data-card-interactive]'
                  );
                  return direct || raw;
                };
                var suppressLateNativeClick = function() {
                  var suppress = function(event) {
                    if (!fallbackClickDispatched || !event.isTrusted) return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                  };
                  window.addEventListener('click', suppress, { capture: true });
                  duplicateClickSuppressorTimer = setTimeout(function() {
                    window.removeEventListener('click', suppress, { capture: true });
                    duplicateClickSuppressorTimer = null;
                  }, 700);
                };
                var dispatchFallbackClick = function() {
                  if (done || fallbackClickDispatched) return;
                  if (!firstStartSeen || movedTooFar) {
                    cleanup();
                    return;
                  }
                  var target = clickableFallbackTarget();
                  if (!target) {
                    cleanup();
                    return;
                  }
                  fallbackClickDispatched = true;
                  suppressLateNativeClick();
                  var point = endPoint || startPoint || { x: 0, y: 0 };
                  var event = new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    clientX: point.x || 0,
                    clientY: point.y || 0
                  });
                  target.dispatchEvent(event);
                  done = true;
                  cleanup();
                };
                var armNoCompletionTimer = function() {
                  if (firstStartTimer !== null) return;
                  firstStartTimer = setTimeout(function() {
                    if (done) return;
                    cleanup();
                  }, 1200);
                };
                var armNoClickAfterEndTimer = function() {
                  if (noClickAfterEndTimer !== null) return;
                  noClickAfterEndTimer = setTimeout(function() {
                    if (done) return;
                    dispatchFallbackClick();
                  }, 140);
                };
                var logFirst = function(kind) {
                  return function(event) {
                    try {
                      if (done) return;
                      if (kind === 'touchstart' || kind === 'pointerdown') {
                        rememberStart(event);
                        return;
                      }
                      if (kind === 'touchmove' || kind === 'pointermove') {
                        rememberMove(event);
                        return;
                      }
                      if (kind === 'touchend' || kind === 'pointerup') {
                        rememberEnd(event);
                        if (firstStartSeen) {
                          armNoClickAfterEndTimer();
                        }
                        return;
                      }
                      if (kind === 'click' || kind === 'touchcancel' || kind === 'pointercancel') {
                        done = true;
                        cleanup();
                      }
                    } catch (e) {}
                  };
                };
                var add = function(type, handler) {
                  window.addEventListener(type, handler, { capture: true, passive: true });
                  cleanups.push(function() {
                    window.removeEventListener(type, handler, { capture: true });
                  });
                };
                var cleanup = function() {
                  if (firstStartTimer !== null) {
                    clearTimeout(firstStartTimer);
                    firstStartTimer = null;
                  }
                  if (noClickAfterEndTimer !== null) {
                    clearTimeout(noClickAfterEndTimer);
                    noClickAfterEndTimer = null;
                  }
                  if (listenerLifetimeTimer !== null) {
                    clearTimeout(listenerLifetimeTimer);
                    listenerLifetimeTimer = null;
                  }
                  while (cleanups.length) {
                    try { cleanups.pop()(); } catch (e) {}
                  }
                  if (window.__traceResumeClickFallbackCleanup === cleanup) {
                    window.__traceResumeClickFallbackCleanup = null;
                  }
                };
                window.__traceResumeClickFallbackCleanup = cleanup;
                add('touchstart', logFirst('touchstart'));
                add('touchmove', logFirst('touchmove'));
                add('touchend', logFirst('touchend'));
                add('touchcancel', logFirst('touchcancel'));
                add('pointerdown', logFirst('pointerdown'));
                add('pointermove', logFirst('pointermove'));
                add('pointerup', logFirst('pointerup'));
                add('pointercancel', logFirst('pointercancel'));
                add('click', logFirst('click'));
                listenerLifetimeTimer = setTimeout(function() {
                  if (done) return;
                  cleanup();
                }, 60000);
                if (document.activeElement instanceof HTMLElement) {
                  document.activeElement.blur();
                }
              } catch (e) {}
              return true;
            })();
            """,
            completionHandler: nil
        )
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
        if let presented = vc.presentedViewController,
           let found = findTraceWeb(in: presented) {
            return found
        }
        if let nav = vc as? UINavigationController, let top = nav.topViewController {
            return findTraceWeb(in: top)
        }
        if let tab = vc as? UITabBarController, let sel = tab.selectedViewController {
            return findTraceWeb(in: sel)
        }
        for child in vc.children {
            if let found = findTraceWeb(in: child) { return found }
        }
        return nil
    }

    func loadDefaultOrigin() {
        guard let url = Self.defaultTraceURL() else { return }
        loadTraceURLRequest(url)
    }

    /// Handles Auth0-style callbacks routed to `traceauth://…` (cold start / universal links).
    func handleAuthCallback(url: URL) {
        guard let target = Self.rewriteTraceAuthURL(url) else { return }
        loadTraceURLRequest(target)
    }

    /// Maps `traceauth://callback?…` → `{webAppHTTPSOrigin}/auth/callback?…`
    static func rewriteTraceAuthURL(_ url: URL) -> URL? {
        guard url.scheme?.lowercased() == "traceauth" else { return url }
        guard var parts = URLComponents(string: Self.webAppHTTPSOrigin) else { return nil }
        let callbackParts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var queryItems = callbackParts?.queryItems ?? []
        queryItems.removeAll { $0.name == "trace_app" }
        queryItems.append(URLQueryItem(name: "trace_app", value: "1"))

        parts.path = "/auth/callback"
        parts.queryItems = queryItems
        parts.fragment = callbackParts?.fragment
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
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if isMainFrame, url.scheme?.lowercased() == "blob" {
            activeTraceNavigationURL = nil
            decisionHandler(.cancel)
            presentDownloadFallbackAlert()
            return
        }
        if shouldOpenInAuthenticationSession(url), isMainFrame {
            decisionHandler(.cancel)
            startAuthenticationSession(startURL: url)
            return
        }
        if isMainFrame {
            if shouldOpenOutsideTraceShell(url) {
                activeTraceNavigationURL = nil
                decisionHandler(.cancel)
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                return
            }
            if traceAppHostsMatch(url) {
                activeTraceNavigationURL = url
                lastIntendedTraceURL = url
                hideTraceLoadFailureView()
            } else if isExternalWebURL(url) {
                activeTraceNavigationURL = nil
                decisionHandler(.cancel)
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                return
            } else {
                activeTraceNavigationURL = nil
            }
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard navigationResponse.isForMainFrame,
              let url = navigationResponse.response.url,
              traceAppHostsMatch(url)
        else {
            decisionHandler(.allow)
            return
        }

        if let response = navigationResponse.response as? HTTPURLResponse,
           (500...599).contains(response.statusCode) {
            activeTraceNavigationURL = nil
            lastIntendedTraceURL = url
            showTraceLoadFailureView(for: url)
            decisionHandler(.cancel)
            return
        }

        lastIntendedTraceURL = url
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, traceAppHostsMatch(url) else { return }
        activeTraceNavigationURL = nil
        lastIntendedTraceURL = url
        hideTraceLoadFailureView()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleTraceNavigationFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleTraceNavigationFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let url = webView.url ?? lastIntendedTraceURL,
              traceAppHostsMatch(url)
        else { return }
        activeTraceNavigationURL = nil
        lastIntendedTraceURL = url
        showTraceLoadFailureView(for: url)
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
            if shouldOpenOutsideTraceShell(url) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            } else if traceAppHostsMatch(url) {
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

    private func shouldOpenOutsideTraceShell(_ url: URL) -> Bool {
        guard traceAppHostsMatch(url) else { return false }
        let scheme = url.scheme?.lowercased()
        guard scheme == "http" || scheme == "https" else { return false }
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        return path == "setup" ||
            path == "apps" ||
            path == "shared/collections" ||
            path.hasPrefix("shared/collections/")
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

    private func isExternalWebURL(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    private func startAuthenticationSession(startURL: URL) {
        authSession?.cancel()
        activeAuthRecoveryAlert?.dismiss(animated: false)
        let sessionID = UUID()
        activeAuthSessionID = sessionID
        let session = ASWebAuthenticationSession(
            url: startURL,
            callbackURLScheme: "traceauth"
        ) { [weak self] callbackURL, error in
            guard let self = self else { return }
            guard self.activeAuthSessionID == sessionID else { return }
            self.authSession = nil
            self.activeAuthSessionID = nil

            if let error {
                self.handleAuthenticationSessionFailure(error, retryURL: startURL)
                return
            }

            guard let callbackURL = callbackURL,
                  let httpsURL = Self.rewriteTraceAuthURL(callbackURL)
            else {
                self.presentAuthRecoveryAlert(kind: .failed, retryURL: startURL)
                return
            }
            DispatchQueue.main.async {
                self.loadTraceURLRequest(httpsURL)
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        if session.start() != true {
            authSession = nil
            activeAuthSessionID = nil
            presentAuthRecoveryAlert(kind: .failed, retryURL: startURL)
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let w = view.window { return w }
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ??
            ASPresentationAnchor()
    }

    private func handleAuthenticationSessionFailure(_ error: Error, retryURL: URL) {
        let nsError = error as NSError
        let isUserCancelled =
            nsError.domain == ASWebAuthenticationSessionError.errorDomain &&
            nsError.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue
        presentAuthRecoveryAlert(
            kind: isUserCancelled ? .cancelled : .failed,
            retryURL: retryURL
        )
    }

    private func presentAuthRecoveryAlert(kind: TraceAuthRecoveryKind, retryURL: URL) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.activeAuthRecoveryAlert?.dismiss(animated: false)

            let title: String
            let message: String
            switch kind {
            case .cancelled:
                title = "Sign-in cancelled"
                message = "You can try again whenever you're ready."
            case .failed:
                title = "Sign-in didn't finish"
                message = "Trace couldn't complete sign-in. Check your connection and try again."
            }

            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addAction(
                UIAlertAction(title: "Try Again", style: .default) { [weak self] _ in
                    self?.startAuthenticationSession(startURL: retryURL)
                }
            )
            alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            self.activeAuthRecoveryAlert = alert
            let presenter = self.presentedViewController ?? self
            presenter.present(alert, animated: true)
        }
    }

    private static func defaultTraceURL() -> URL? {
        return traceURL(path: "/", queryItems: [URLQueryItem(name: "trace_app", value: "1")])
    }

    private static func supportURL() -> URL? {
        return traceURL(path: "/support")
    }

#if DEBUG
    private static var shouldShowDebugLoadFailureView: Bool {
        return ProcessInfo.processInfo.arguments.contains("--trace-show-load-failure")
    }
#endif

    private static func traceURL(path: String, queryItems: [URLQueryItem]? = nil) -> URL? {
        guard var components = URLComponents(string: webAppHTTPSOrigin) else { return nil }
        components.path = path.hasPrefix("/") ? path : "/\(path)"
        components.queryItems = queryItems
        return components.url
    }

    private func loadTraceURLRequest(_ url: URL) {
        if traceAppHostsMatch(url) {
            activeTraceNavigationURL = url
            lastIntendedTraceURL = url
            hideTraceLoadFailureView()
        }
        webView.load(URLRequest(url: url))
    }

    private func handleTraceNavigationFailure(_ error: Error) {
        if shouldIgnoreNavigationFailure(error) {
            return
        }

        let failedURL = failingURL(from: error)
        let recoveryURL: URL?
        if let activeTraceNavigationURL {
            recoveryURL = activeTraceNavigationURL
        } else if let failedURL, traceAppHostsMatch(failedURL) {
            recoveryURL = failedURL
        } else {
            recoveryURL = nil
        }

        guard let recoveryURL, traceAppHostsMatch(recoveryURL) else { return }
        activeTraceNavigationURL = nil
        lastIntendedTraceURL = recoveryURL
        showTraceLoadFailureView(for: recoveryURL)
    }

    private func shouldIgnoreNavigationFailure(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            return true
        }
        // WebKit reports policy-cancelled handoffs (including native auth/external opens) as code 102.
        if nsError.domain == "WebKitErrorDomain", nsError.code == 102 {
            return true
        }
        return false
    }

    private func failingURL(from error: Error) -> URL? {
        let nsError = error as NSError
        if let url = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
            return url
        }
        if let value = nsError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String {
            return URL(string: value)
        }
        if let url = nsError.userInfo["NSErrorFailingURLKey"] as? URL {
            return url
        }
        if let value = nsError.userInfo["NSErrorFailingURLStringKey"] as? String {
            return URL(string: value)
        }
        return nil
    }

    private func recoveryTargetURL() -> URL? {
        if let url = traceRecoveryURL(failedTraceURL) { return url }
        if let url = traceRecoveryURL(lastIntendedTraceURL) { return url }
        if let url = traceRecoveryURL(webView.url) { return url }
        return Self.defaultTraceURL()
    }

    private func traceRecoveryURL(_ url: URL?) -> URL? {
        guard let url, traceAppHostsMatch(url) else { return nil }
        return url
    }

    private func showTraceLoadFailureView(for url: URL) {
        failedTraceURL = url
        guard let traceLoadFailureView else { return }
        traceLoadFailureView.isHidden = false
        view.bringSubviewToFront(traceLoadFailureView)
    }

    private func hideTraceLoadFailureView() {
        failedTraceURL = nil
        traceLoadFailureView?.isHidden = true
    }

    private func makeTraceLoadFailureView() -> UIView {
        let overlay = UIView()
        overlay.backgroundColor = Self.shellBackgroundColor
        overlay.isHidden = true
        overlay.accessibilityIdentifier = "TraceLoadFailureView"

        let brandLabel = UILabel()
        brandLabel.text = "Trace"
        brandLabel.textColor = Self.shellAccentColor
        brandLabel.font = .systemFont(ofSize: 18, weight: .semibold)
        brandLabel.textAlignment = .center

        let titleLabel = UILabel()
        titleLabel.text = "Trace is having trouble loading."
        titleLabel.textColor = Self.shellTextColor
        titleLabel.font = .systemFont(ofSize: 24, weight: .bold)
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0

        let bodyLabel = UILabel()
        bodyLabel.text = "Check your connection, then try again."
        bodyLabel.textColor = Self.shellMutedTextColor
        bodyLabel.font = .systemFont(ofSize: 16, weight: .regular)
        bodyLabel.textAlignment = .center
        bodyLabel.numberOfLines = 0

        let copyStack = UIStackView(arrangedSubviews: [brandLabel, titleLabel, bodyLabel])
        copyStack.axis = .vertical
        copyStack.alignment = .fill
        copyStack.spacing = 10

        let retryButton = makeTraceLoadFailureButton(title: "Retry", prominence: .primary)
        retryButton.addTarget(self, action: #selector(retryTraceLoad), for: .touchUpInside)

        let safariButton = makeTraceLoadFailureButton(title: "Open in Safari", prominence: .secondary)
        safariButton.addTarget(self, action: #selector(openFailedTraceURLInSafari), for: .touchUpInside)

        let supportButton = makeTraceLoadFailureButton(title: "Support", prominence: .plain)
        supportButton.addTarget(self, action: #selector(openTraceSupportInSafari), for: .touchUpInside)

        let buttonStack = UIStackView(arrangedSubviews: [retryButton, safariButton, supportButton])
        buttonStack.axis = .vertical
        buttonStack.alignment = .fill
        buttonStack.spacing = 12

        let contentStack = UIStackView(arrangedSubviews: [copyStack, buttonStack])
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.axis = .vertical
        contentStack.alignment = .fill
        contentStack.spacing = 28
        overlay.addSubview(contentStack)

        let guide = overlay.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            contentStack.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            contentStack.centerYAnchor.constraint(equalTo: guide.centerYAnchor),
            contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: guide.leadingAnchor, constant: 28),
            contentStack.trailingAnchor.constraint(lessThanOrEqualTo: guide.trailingAnchor, constant: -28),
            contentStack.topAnchor.constraint(greaterThanOrEqualTo: guide.topAnchor, constant: 32),
            contentStack.bottomAnchor.constraint(lessThanOrEqualTo: guide.bottomAnchor, constant: -32),
            contentStack.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            retryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            safariButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            supportButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        return overlay
    }

    private enum TraceLoadFailureButtonProminence {
        case primary
        case secondary
        case plain
    }

    private func makeTraceLoadFailureButton(
        title: String,
        prominence: TraceLoadFailureButtonProminence
    ) -> UIButton {
        let button = UIButton(type: .system)
        var configuration: UIButton.Configuration
        switch prominence {
        case .primary:
            configuration = .filled()
            configuration.baseBackgroundColor = Self.shellAccentColor
            configuration.baseForegroundColor = .white
        case .secondary:
            configuration = .tinted()
            configuration.baseBackgroundColor = Self.shellAccentColor.withAlphaComponent(0.14)
            configuration.baseForegroundColor = Self.shellAccentColor
        case .plain:
            configuration = .plain()
            configuration.baseForegroundColor = Self.shellAccentColor
        }
        configuration.title = title
        configuration.cornerStyle = .medium
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 18, bottom: 12, trailing: 18)
        button.configuration = configuration
        button.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        button.titleLabel?.adjustsFontSizeToFitWidth = true
        button.titleLabel?.minimumScaleFactor = 0.8
        return button
    }

    @objc private func retryTraceLoad() {
        guard let url = recoveryTargetURL() else { return }
        loadTraceURLRequest(url)
    }

    @objc private func openFailedTraceURLInSafari() {
        guard let url = recoveryTargetURL() else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    @objc private func openTraceSupportInSafari() {
        guard let url = Self.supportURL() else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
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
        if message.name == "traceDownload" {
            handleTraceDownloadMessage(message)
            return
        }

        if message.name == "traceSafariExtension" {
            handleTraceSafariExtensionMessage(message)
            return
        }

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

    private enum TraceDownloadError: Error {
        case invalidRequest
        case invalidResponse
        case exportFailed
    }

    private enum TraceSafariExtensionBridgeError: Error {
        case invalidRequest
        case unsupportedUrl
        case tokenShareFailed
        case sharedStorageUnavailable
    }

    private static let safariExtensionBundleIdentifier = "com.tracefiction.trace.extension"
    private static let traceSharedAppGroup = "group.com.tracefiction.trace"
    private static let traceKeychainAccessGroup = "com.tracefiction.trace.shared"
    private static let traceAppleTeamIdentifierPrefix = "3GX59FLLT6."
    private static let traceAuthTokenService = "com.tracefiction.trace.auth"
    private static let traceAuthTokenAccount = "extension-token"
    private static let pendingFirstStoryDefaultsKey = "tracePendingFirstStoryUrlV1"
    private static let pendingFirstStoryExpiresAtDefaultsKey = "tracePendingFirstStoryExpiresAtV1"
    private static let pendingFirstStoryTTL: TimeInterval = 10 * 60

    private func handleTraceSafariExtensionMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let messageType = body["type"] as? String,
              let nonce = body["nonce"] as? String,
              !nonce.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return
        }

        switch messageType {
        case "TRACE_IOS_EXTENSION_STATE_REQUEST":
            handleTraceSafariExtensionStateRequest(nonce: nonce)
        case "TRACE_IOS_OPEN_EXTENSION_SETTINGS":
            handleTraceSafariExtensionSettingsRequest(nonce: nonce)
        case "TRACE_IOS_OPEN_STORY_URL":
            let url = body["url"] as? String
            handleTraceSafariStoryOpenRequest(nonce: nonce, rawURL: url)
        default:
            postSafariExtensionActionResult(
                type: "\(messageType)_RESPONSE",
                nonce: nonce,
                ok: false,
                error: "unknown_message_type"
            )
        }
    }

    private func handleTraceSafariExtensionStateRequest(nonce: String) {
        Task { [weak self] in
            guard let self else { return }
            _ = try? await self.storeCurrentTraceTokenForSafariExtension()

            await MainActor.run {
                guard #available(iOS 26.2, *) else {
                    self.postSafariExtensionState(
                        nonce: nonce,
                        enabled: false,
                        settingsSupported: false,
                        error: nil
                    )
                    return
                }

                SFSafariExtensionManager.getStateOfExtension(
                    withIdentifier: Self.safariExtensionBundleIdentifier
                ) { [weak self] state, error in
                    DispatchQueue.main.async {
                        self?.postSafariExtensionState(
                            nonce: nonce,
                            enabled: state?.isEnabled == true,
                            settingsSupported: true,
                            error: error == nil ? nil : "state_unavailable"
                        )
                    }
                }
            }
        }
    }

    private func handleTraceSafariExtensionSettingsRequest(nonce: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.storeCurrentTraceTokenForSafariExtension()
            } catch {
                await MainActor.run {
                    self.postSafariExtensionActionResult(
                        type: "TRACE_IOS_OPEN_EXTENSION_SETTINGS_RESPONSE",
                        nonce: nonce,
                        ok: false,
                        error: "token_share_failed"
                    )
                }
                return
            }

            await MainActor.run {
                guard #available(iOS 26.2, *) else {
                    self.postSafariExtensionActionResult(
                        type: "TRACE_IOS_OPEN_EXTENSION_SETTINGS_RESPONSE",
                        nonce: nonce,
                        ok: false,
                        error: "settings_unsupported"
                    )
                    return
                }

                SFSafariSettings.openExtensionsSettings(
                    forIdentifiers: [Self.safariExtensionBundleIdentifier]
                ) { [weak self] error in
                    DispatchQueue.main.async {
                        self?.postSafariExtensionActionResult(
                            type: "TRACE_IOS_OPEN_EXTENSION_SETTINGS_RESPONSE",
                            nonce: nonce,
                            ok: error == nil,
                            error: error == nil ? nil : "settings_open_failed"
                        )
                    }
                }
            }
        }
    }

    private func handleTraceSafariStoryOpenRequest(nonce: String, rawURL: String?) {
        Task { [weak self] in
            guard let self else { return }
            do {
                guard let url = Self.supportedFirstStoryURL(rawURL) else {
                    throw TraceSafariExtensionBridgeError.unsupportedUrl
                }
                try await self.storeCurrentTraceTokenForSafariExtension()
                try Self.storePendingFirstStoryURL(url)
                await MainActor.run {
                    UIApplication.shared.open(url, options: [:]) { [weak self] success in
                        if !success {
                            Self.clearPendingFirstStoryURL()
                        }
                        self?.postSafariExtensionActionResult(
                            type: "TRACE_IOS_OPEN_STORY_URL_RESPONSE",
                            nonce: nonce,
                            ok: success,
                            error: success ? nil : "open_failed"
                        )
                    }
                }
            } catch TraceSafariExtensionBridgeError.unsupportedUrl {
                await MainActor.run {
                    self.postSafariExtensionActionResult(
                        type: "TRACE_IOS_OPEN_STORY_URL_RESPONSE",
                        nonce: nonce,
                        ok: false,
                        error: "invalid_url"
                    )
                }
            } catch {
                await MainActor.run {
                    self.postSafariExtensionActionResult(
                        type: "TRACE_IOS_OPEN_STORY_URL_RESPONSE",
                        nonce: nonce,
                        ok: false,
                        error: "token_share_failed"
                    )
                }
            }
        }
    }

    private static func supportedFirstStoryURL(_ rawURL: String?) -> URL? {
        guard let rawURL,
              let url = URL(string: rawURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased()
        else {
            return nil
        }

        let pathParts = url.path.split(separator: "/").map(String.init)
        if isSupportedAO3Host(host) {
            guard pathParts.count == 2 || pathParts.count == 4,
                  pathParts.first == "works",
                  Int(pathParts[1]) != nil
            else {
                return nil
            }
            if pathParts.count == 4 {
                guard pathParts[2] == "chapters", Int(pathParts[3]) != nil else {
                    return nil
                }
            }
            return url
        }

        if (host == "www.fanfiction.net" || host == "m.fanfiction.net"),
           pathParts.count >= 2,
           pathParts[0] == "s",
           Int(pathParts[1]) != nil
        {
            if pathParts.count >= 3, Int(pathParts[2]) == nil {
                return nil
            }
            return url
        }

        return nil
    }

    private static func isSupportedAO3Host(_ host: String) -> Bool {
        host == "archiveofourown.org" ||
            host.hasSuffix(".archiveofourown.org") ||
            host == "archiveofourown.gay" ||
            host.hasSuffix(".archiveofourown.gay") ||
            host == "archive.transformativeworks.org" ||
            host == "ao3.org" ||
            host.hasSuffix(".ao3.org")
    }

    private static func pendingDefaults() -> UserDefaults? {
        UserDefaults(suiteName: traceSharedAppGroup)
    }

    private static func storePendingFirstStoryURL(_ url: URL) throws {
        guard let defaults = pendingDefaults() else {
            throw TraceSafariExtensionBridgeError.sharedStorageUnavailable
        }
        defaults.set(url.absoluteString, forKey: pendingFirstStoryDefaultsKey)
        defaults.set(
            Date().addingTimeInterval(pendingFirstStoryTTL).timeIntervalSince1970,
            forKey: pendingFirstStoryExpiresAtDefaultsKey
        )
    }

    private static func clearPendingFirstStoryURL() {
        guard let defaults = pendingDefaults() else { return }
        defaults.removeObject(forKey: pendingFirstStoryDefaultsKey)
        defaults.removeObject(forKey: pendingFirstStoryExpiresAtDefaultsKey)
    }

    @MainActor
    private func storeCurrentTraceTokenForSafariExtension() async throws {
        let token = try await fetchTraceShellAccessToken()
        try Self.storeSharedTraceToken(token)
    }

    private static func keychainAccessGroup() -> String {
        if let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
           !prefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return "\(prefix)\(traceKeychainAccessGroup)"
        }
        return "\(traceAppleTeamIdentifierPrefix)\(traceKeychainAccessGroup)"
    }

    private static func storeSharedTraceToken(_ token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8), !data.isEmpty else {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }

        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: traceAuthTokenService,
            kSecAttrAccount as String: traceAuthTokenAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup(),
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
    }

    @MainActor
    private func postSafariExtensionState(
        nonce: String,
        enabled: Bool,
        settingsSupported: Bool,
        error: String?
    ) {
        postTraceWebMessage(
            TraceSafariExtensionStatePayload(
                nonce: nonce,
                enabled: enabled,
                settingsSupported: settingsSupported,
                error: error
            )
        )
    }

    @MainActor
    private func postSafariExtensionActionResult(
        type: String,
        nonce: String,
        ok: Bool,
        error: String? = nil
    ) {
        postTraceWebMessage(
            TraceSafariExtensionActionPayload(
                type: type,
                nonce: nonce,
                ok: ok,
                error: error
            )
        )
    }

    private func handleTraceDownloadMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              (body["op"] as? String) == "exportAccount"
        else {
            presentDownloadFailureAlert(message: "Trace couldn't start the export.")
            return
        }

        let requestedFilename = body["filename"] as? String
        exportAccountToNativeShareSheet(filename: requestedFilename)
    }

    private func exportAccountToNativeShareSheet(filename: String?) {
        Task { [weak self] in
            guard let self else { return }

            do {
                let token = try await self.fetchTraceShellAccessToken()
                let fileURL = try await self.downloadAccountExport(
                    accessToken: token,
                    filename: filename
                )
                await MainActor.run {
                    self.presentNativeShareSheet(for: fileURL)
                }
            } catch {
                await MainActor.run {
                    let message =
                        error is TraceBillingFlowError
                        ? "Sign in again, then try exporting your data."
                        : "Trace couldn't prepare the export. Check your connection and try again."
                    self.presentDownloadFailureAlert(message: message)
                }
            }
        }
    }

    private func downloadAccountExport(accessToken: String, filename: String?) async throws -> URL {
        guard var components = URLComponents(
            url: Self.billingAPIBaseURL,
            resolvingAgainstBaseURL: false
        ) else {
            throw TraceDownloadError.invalidRequest
        }
        components.path = "/api/account/export"
        guard let url = components.url else {
            throw TraceDownloadError.invalidRequest
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/zip", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw TraceDownloadError.invalidResponse
        }
        guard (200...299).contains(http.statusCode), !data.isEmpty else {
            throw TraceDownloadError.exportFailed
        }

        let exportDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TraceExports", isDirectory: true)
        try FileManager.default.createDirectory(
            at: exportDirectory,
            withIntermediateDirectories: true
        )

        let safeFilename = sanitizedExportFilename(filename)
        let fileURL = exportDirectory.appendingPathComponent(safeFilename)
        try? FileManager.default.removeItem(at: fileURL)
        try data.write(to: fileURL, options: [.atomic])
        return fileURL
    }

    private func sanitizedExportFilename(_ filename: String?) -> String {
        let fallback = "trace-export-\(Self.exportDateString()).zip"
        guard let filename else { return fallback }

        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        let cleanedScalars = filename.unicodeScalars.map { scalar -> Character in
            allowed.contains(scalar) ? Character(scalar) : "-"
        }
        let cleaned = String(cleanedScalars)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".-_/ "))
        guard !cleaned.isEmpty else { return fallback }
        return cleaned.lowercased().hasSuffix(".zip") ? cleaned : "\(cleaned).zip"
    }

    private static func exportDateString() -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    @MainActor
    private func presentNativeShareSheet(for fileURL: URL) {
        let activity = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        let presenter = topPresenter()
        presenter.present(activity, animated: true)
    }

    @MainActor
    private func presentDownloadFallbackAlert() {
        presentDownloadFailureAlert(
            message: "This download needs the native export flow. Update Trace or open Trace in Safari, then try again."
        )
    }

    @MainActor
    private func presentDownloadFailureAlert(message: String) {
        let alert = UIAlertController(
            title: "Export unavailable",
            message: message,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .cancel))
        topPresenter().present(alert, animated: true)
    }

    @MainActor
    private func topPresenter() -> UIViewController {
        var presenter: UIViewController = self
        while let presented = presenter.presentedViewController {
            presenter = presented
        }
        return presenter
    }

    private func handleTracePushMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              (body["op"] as? String) == "requestPermissionAndRegister"
        else { return }

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            DispatchQueue.main.async {
                if error != nil {
                    self.postPushResult(
                        status: "error",
                        message: "Trace couldn't ask for notification permission.",
                        code: "permission_request_failed"
                    )
                    return
                }

                guard granted else {
                    self.postPushResult(
                        status: "denied",
                        message: "Notifications are turned off for Trace.",
                        code: "permission_denied"
                    )
                    return
                }

                self.postPushResult(
                    status: "granted",
                    message: "Notifications are allowed on this device.",
                    code: nil
                )
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func handleRemoteNotificationRegistrationFailure(_: Error) {
        postPushResult(
            status: "error",
            message: "Trace couldn't register this device for notifications.",
            code: "apns_registration_failed"
        )
    }

    private func forwardApnsTokenToWeb(_ data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        postTraceWebMessage(TraceAPNSTokenPayload(token: hex, environment: env))
    }

    private func postTraceWebMessage<T: Encodable>(_ payload: T) {
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8),
              let originData = try? JSONEncoder().encode(Self.webAppHTTPSOrigin),
              let originJson = String(data: originData, encoding: .utf8)
        else { return }

        let js = "window.postMessage(\(json), \(originJson));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    @MainActor
    private func postPushResult(status: String, message: String?, code: String?) {
        let payload = TracePushResultPayload(
            status: status,
            message: message,
            code: code
        )

        postTraceWebMessage(payload)
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
        case .manageSubscriptions:
            manageTraceBillingSubscriptions()
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
    private func manageTraceBillingSubscriptions() {
        guard let scene = view.window?.windowScene else {
            postBillingResult(
                status: "error",
                op: .manageSubscriptions,
                message: "Unable to open Apple subscription settings.",
                code: "scene_unavailable"
            )
            return
        }

        Task { [weak self] in
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                await MainActor.run {
                    self?.postBillingResult(status: "success", op: .manageSubscriptions)
                }
            } catch {
                await MainActor.run {
                    self?.postBillingResult(
                        status: "error",
                        op: .manageSubscriptions,
                        message: "Unable to open Apple subscription settings.",
                        code: "manage_subscriptions_unavailable"
                    )
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

        postTraceWebMessage(payload)
    }
}
