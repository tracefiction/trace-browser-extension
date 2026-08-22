//
//  TraceWebViewController.swift
//  iOS (App)
//
//  WKWebView shell: OAuth via ASWebAuthenticationSession; full-bleed web (no native nav bar).
//  Injects `window.__TRACE_NATIVE_SHELL__` and loads `?trace_app=1` for SPA detection.
//

import AuthenticationServices
import os.log
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
        if TraceWebOriginGenerated.allowReleaseExperimentOrigin {
            return TraceWebOriginGenerated.httpsOrigin
        }
        return "https://tracefiction.com"
#endif
    }

    /// Must match `WEB_SHELL_UA` in `client/src/auth/auth-return.ts`.
    static let webShellUserAgentToken = "TraceFictionWebShell/1"

    private static let productionWebHosts: Set<String> = [
        "tracefiction.com",
        "www.tracefiction.com",
    ]
    private static let verifiedHTTPSAuthCallbackHost = "www.tracefiction.com"
    private static let verifiedHTTPSAuthCallbackPath = "/auth/callback"

    private static var httpsAuthCallbackURL: URL? {
        guard #available(iOS 17.4, *) else { return nil }
        guard let origin = URL(string: webAppHTTPSOrigin),
              origin.scheme?.lowercased() == "https",
              let host = origin.host?.lowercased()
        else {
            return nil
        }

        let usesProductionWebOrigin = productionWebHosts.contains(host)
#if DEBUG
        // Local and ordinary preview Debug builds keep the custom-scheme
        // transport. Only a release build produced by the exact reviewed dev
        // preview command may borrow Trace's verified HTTPS callback.
        let usesReviewedReleasePreview = false
#else
        let usesReviewedReleasePreview =
            TraceWebOriginGenerated.allowReleaseExperimentOrigin
#endif
        guard usesProductionWebOrigin || usesReviewedReleasePreview else {
            return nil
        }
        return URL(
            string: "https://\(verifiedHTTPSAuthCallbackHost)\(verifiedHTTPSAuthCallbackPath)"
        )
    }

    private static var nativeAppMetadataJSON: String {
#if DEBUG
        let releaseChannel = "debug"
#else
        let releaseChannel = "app_store"
#endif
        var metadata: [String: Any] = ["releaseChannel": releaseChannel]
        if let callbackURL = httpsAuthCallbackURL {
            metadata["httpsAuthCallbackURL"] = callbackURL.absoluteString
        }
        if let version = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String, !version.isEmpty {
            metadata["version"] = version
        }
        if let build = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String, !build.isEmpty {
            metadata["build"] = build
        }
        guard JSONSerialization.isValidJSONObject(metadata),
              let data = try? JSONSerialization.data(withJSONObject: metadata),
              let json = String(data: data, encoding: .utf8)
        else {
            return #"{"releaseChannel":"unknown"}"#
        }
        return json
    }

    private var webView: WKWebView!
    private var traceLoadFailureView: UIView?
    private var activeTraceNavigationURL: URL?
    private var lastIntendedTraceURL: URL?
    private var failedTraceURL: URL?
#if DEBUG && targetEnvironment(simulator)
    private var traceSimulatorFailNextProviderClear = false
#endif
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
        let archiveBrowseHosts: [String]
        // Build-20 capability: the web shell should guide one active-tab save
        // before the Safari popup offers a durable optional host grant.
        let earnedPermissionOnboarding: Bool
        let error: String?
        let queriedIdentifier: String?
        let embeddedExtensionIdentifiers: [String]?
        // Heartbeat written by SafariWebExtensionHandler when a content script
        // actually runs — the only signal iOS exposes that the site permission
        // was granted. Timestamps are epoch milliseconds; web decides staleness.
        let lastArchiveRunAt: Double?
        let lastArchiveSaveAt: Double?
        let lastRunByHost: [String: Double]?
        // Raw `permissions.getAll()` snapshot: diagnostic only, not proof of
        // current Safari Website Access.
        let grantedOrigins: [String]?
        let permissionSnapshotAt: Double?
        let heartbeatUpdatedAt: Double?
        let lastRunHandoffId: String?
        let lastRunHandoffAt: Double?
    }

    private struct TraceSafariExtensionHeartbeat {
        let lastRunByHost: [String: Double]
        let lastSaveByHost: [String: Double]
        let grantedOrigins: [String]?
        let permissionSnapshotAt: Double?
        let updatedAt: Double?
        let lastRunHandoffId: String?
        let lastRunHandoffAt: Double?

        private static func latest(in byHost: [String: Double]) -> Double? {
            byHost
                .filter { $0.key != "unknown" }
                .values
                .max()
        }

        var lastArchiveRunAt: Double? {
            Self.latest(in: lastRunByHost)
        }

        var lastArchiveSaveAt: Double? {
            Self.latest(in: lastSaveByHost)
        }
    }

    private struct TraceSafariExtensionStateQueryResult {
        let identifier: String
        let enabled: Bool
        let errorCode: String?
    }

    private struct TraceSafariExtensionActionPayload: Encodable {
        let type: String
        let nonce: String
        let ok: Bool
        let error: String?
        let handoffId: String?
    }

    private struct TraceSafariAuthProviderMetadataPayload: Encodable {
        let kind: String
        let sessionId: String
        let expiresAt: String
    }

    private struct TraceSafariAuthProviderStatusPayload: Encodable {
        let type = "TRACE_IOS_AUTH_PROVIDER_STATUS_RESPONSE"
        let nonce: String
        let ok: Bool
        let protocolVersion: Int
        let installationId: String
        let provider: TraceSafariAuthProviderMetadataPayload?
    }

    private static var billingAPIBaseURL: URL {
        // The exact earned-permission preview keeps its web shell, extension,
        // and native API calls in one development environment. Ordinary
        // Release builds remain pinned to the production build setting below.
        if TraceWebOriginGenerated.allowReleaseExperimentOrigin,
           let previewURL = URL(string: TraceWebOriginGenerated.apiOrigin) {
            return previewURL
        }

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
            Object.defineProperty(window, '__TRACE_NATIVE_APP__', { value: Object.freeze(\(Self.nativeAppMetadataJSON)), writable: false, configurable: false });
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
#if DEBUG && targetEnvironment(simulator)
        let traceSimulatorSeededStaleProvider =
            ProcessInfo.processInfo.environment["traceDebugSeedStaleProvider"] == "true"
        let traceSimulatorSeededLegacyRawProvider =
            ProcessInfo.processInfo.environment["traceDebugSeedLegacyRawProvider"] == "true"
        if traceSimulatorSeededStaleProvider {
            UserDefaults.standard.set(
                "stale-v2-provider",
                forKey: Self.traceSimulatorProviderV2Key
            )
            UserDefaults.standard.set(
                "stale-retired-provider",
                forKey: Self.traceSimulatorRetiredProviderKey
            )
        }
        if traceSimulatorSeededLegacyRawProvider {
            UserDefaults.standard.set(
                Data(
                    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0cmFjZS12MC02LTAifQ.signature_fixture"
                        .utf8
                ),
                forKey: Self.traceSimulatorProviderV2Key
            )
        }
#endif
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

    /// Handles fixed custom-scheme routes delivered by iOS.
    func handleAuthCallback(url: URL) {
        guard let target = Self.rewriteTraceAuthURL(url) else { return }
        loadTraceURLRequest(target)
    }

    /// Maps the fixed onboarding route or either supported auth callback
    /// transport back into the configured Trace web origin.
    static func rewriteTraceAuthURL(_ url: URL) -> URL? {
        guard var parts = URLComponents(string: Self.webAppHTTPSOrigin) else { return nil }
        guard let callbackParts = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }

        let scheme = url.scheme?.lowercased()
        if scheme == "traceauth", url.host?.lowercased() == "open" {
            let queryItems = callbackParts.queryItems ?? []
            guard callbackParts.path.isEmpty,
                  callbackParts.fragment == nil,
                  callbackParts.user == nil,
                  callbackParts.password == nil,
                  callbackParts.port == nil,
                  queryItems.count == 1,
                  queryItems[0].name == "destination",
                  queryItems[0].value == "extension-connect"
            else {
                return nil
            }
            parts.path = "/setup"
            parts.queryItems = [URLQueryItem(name: "setupPath", value: "ios-app")]
            parts.fragment = "first-story-setup"
            return parts.url
        }

        if scheme == "traceauth" {
            guard url.host?.lowercased() == "callback",
                  callbackParts.path.isEmpty,
                  callbackParts.user == nil,
                  callbackParts.password == nil,
                  callbackParts.port == nil
            else {
                return nil
            }
        } else if scheme == "https" {
            guard isVerifiedHTTPSAuthCallback(url) else { return nil }
        } else {
            return nil
        }

        var queryItems = callbackParts.queryItems ?? []
        queryItems.removeAll { $0.name == "trace_app" }
        queryItems.append(URLQueryItem(name: "trace_app", value: "1"))

        parts.path = "/auth/callback"
        parts.queryItems = queryItems
        parts.fragment = callbackParts.fragment
        return parts.url
    }

    private static func isVerifiedHTTPSAuthCallback(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            return false
        }
        return parts.scheme?.lowercased() == "https" &&
            parts.host?.lowercased() == verifiedHTTPSAuthCallbackHost &&
            parts.path == verifiedHTTPSAuthCallbackPath &&
            parts.user == nil &&
            parts.password == nil &&
            parts.port == nil
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
#if DEBUG
        if let uiTestHost = Self.onboardingUITestURL?.host?.lowercased(), host == uiTestHost {
            return true
        }
#endif
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
        // /setup stays in the shell: the iOS activation wizard needs the
        // native bridge (extension state, settings deep link, heartbeat).
        return path == "apps" ||
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
        let completionHandler: ASWebAuthenticationSession.CompletionHandler = {
            [weak self] callbackURL, error in
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

        let session: ASWebAuthenticationSession
        if #available(iOS 17.4, *),
           let callback = Self.httpsAuthenticationCallback(for: startURL) {
            session = ASWebAuthenticationSession(
                url: startURL,
                callback: callback,
                completionHandler: completionHandler
            )
        } else {
            session = ASWebAuthenticationSession(
                url: startURL,
                callbackURLScheme: "traceauth",
                completionHandler: completionHandler
            )
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

    @available(iOS 17.4, *)
    private static func httpsAuthenticationCallback(
        for startURL: URL
    ) -> ASWebAuthenticationSession.Callback? {
        guard let callbackURL = httpsAuthCallbackURL,
              let authorizeParts = URLComponents(
                url: startURL,
                resolvingAgainstBaseURL: false
              )
        else {
            return nil
        }

        let redirectItems = (authorizeParts.queryItems ?? []).filter {
            $0.name == "redirect_uri"
        }
        guard redirectItems.count == 1,
              redirectItems[0].value == callbackURL.absoluteString
        else {
            return nil
        }

        return .https(
            host: verifiedHTTPSAuthCallbackHost,
            path: verifiedHTTPSAuthCallbackPath
        )
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
#if DEBUG
        if let uiTestURL = onboardingUITestURL {
            return uiTestURL
        }
#endif
        return traceURL(path: "/", queryItems: [URLQueryItem(name: "trace_app", value: "1")])
    }

    private static func supportURL() -> URL? {
        return traceURL(path: "/support")
    }

#if DEBUG
    private static var onboardingUITestURL: URL? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--trace-onboarding-ui-test-url"),
              arguments.indices.contains(flagIndex + 1),
              let url = URL(string: arguments[flagIndex + 1]),
              let host = url.host?.lowercased(),
              host == "localhost" || host == "127.0.0.1"
        else {
            return nil
        }
        return url
    }

    private static var isOnboardingUITest: Bool {
        onboardingUITestURL != nil
    }

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

    private enum TraceSafariPendingFirstStoryMode: String {
        case story
        case browse
    }

    private enum TraceSafariArchiveHostKind: String {
        case ao3
        case ffn

        var mobileHomeURL: URL {
            switch self {
            case .ao3:
                return URL(string: "https://archiveofourown.org/")!
            case .ffn:
                return URL(string: "https://m.fanfiction.net/")!
            }
        }
    }

    private static let safariExtensionBundleIdentifier = "com.tracefiction.trace.extension"
    private static let safariBridgeLog = OSLog(
        subsystem: Bundle.main.bundleIdentifier ?? "com.tracefiction.trace",
        category: "SafariBridge"
    )
    private static let traceSharedAppGroup = "group.com.tracefiction.trace"
    private static let traceKeychainAccessGroup = "com.tracefiction.trace.shared"
    private static let traceAppleTeamIdentifierPrefix = "3GX59FLLT6."
    private static let traceAuthTokenService = "com.tracefiction.trace.auth"
    private static let traceAuthTokenAccount = "extension-provider-v2"
    private static let retiredTraceAuthTokenAccount = "extension-token"
    private static let traceLegacyProviderProtocolVersion = 2
    private static let traceDeviceProviderProtocolVersion = 3
    private static let traceProviderRecordVersion = 2
    private static let traceInstallationIdDefaultsKey = "traceInstallationIdV1"
    private static let appProviderHealthDefaultsKey = "traceAppProviderHealthV1"

    private struct TraceSafariProviderRecord: Codable {
        let version: Int
        let kind: String?
        let token: String?
        let sessionId: String?
        let credential: String?
        let expiresAt: String?

        static func legacyAccessToken(_ token: String) -> TraceSafariProviderRecord {
            TraceSafariProviderRecord(
                version: 1,
                kind: nil,
                token: token,
                sessionId: nil,
                credential: nil,
                expiresAt: nil
            )
        }

        static func deviceSession(
            sessionId: String,
            credential: String,
            expiresAt: String
        ) -> TraceSafariProviderRecord {
            TraceSafariProviderRecord(
                version: TraceWebViewController.traceProviderRecordVersion,
                kind: "device_session",
                token: nil,
                sessionId: sessionId,
                credential: credential,
                expiresAt: expiresAt
            )
        }
    }
#if DEBUG && targetEnvironment(simulator)
    private static let traceSimulatorProviderV2Key =
        "traceDebugSimulatorAppProviderV2"
    private static let traceSimulatorRetiredProviderKey =
        "traceDebugSimulatorAppProviderRetired"
#endif
    private static let pendingFirstStoryDefaultsKey = "tracePendingFirstStoryUrlV1"
    private static let pendingFirstStoryExpiresAtDefaultsKey = "tracePendingFirstStoryExpiresAtV1"
    private static let pendingFirstStoryV2DefaultsKey = "tracePendingFirstStoryV2"
    private static let pendingFirstStoryTTL: TimeInterval = 10 * 60
    /// Written by SafariWebExtensionHandler (extension process); read-only here.
    private static let extensionHeartbeatDefaultsKey = "traceExtensionHeartbeatV1"

    private func handleTraceSafariExtensionMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let messageType = body["type"] as? String,
              let nonce = body["nonce"] as? String,
              !nonce.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return
        }

        switch messageType {
        case "TRACE_IOS_AUTH_TOKEN_UPDATE":
            os_log(
                "Credential provider update requested protocol=%{public}d",
                log: Self.safariBridgeLog,
                type: .info,
                body["protocolVersion"] as? Int ?? -1
            )
            let protocolVersion = body["protocolVersion"] as? Int
            if protocolVersion == Self.traceLegacyProviderProtocolVersion {
                handleTraceSafariAuthTokenUpdate(
                    nonce: nonce,
                    token: body["token"] as? String
                )
                return
            }
            guard protocolVersion == Self.traceDeviceProviderProtocolVersion,
                  let provider = body["provider"] as? [String: Any]
            else {
                postSafariExtensionActionResult(
                    type: "TRACE_IOS_AUTH_TOKEN_UPDATE_RESPONSE",
                    nonce: nonce,
                    ok: false,
                    error: "unsupported_protocol"
                )
                return
            }
            handleTraceSafariDeviceSessionUpdate(
                nonce: nonce,
                provider: provider
            )
        case "TRACE_IOS_AUTH_TOKEN_CLEAR":
            guard body["protocolVersion"] as? Int == Self.traceLegacyProviderProtocolVersion
                    || body["protocolVersion"] as? Int == Self.traceDeviceProviderProtocolVersion
            else {
                postSafariExtensionActionResult(
                    type: "TRACE_IOS_AUTH_TOKEN_CLEAR_RESPONSE",
                    nonce: nonce,
                    ok: false,
                    error: "unsupported_protocol"
                )
                return
            }
            handleTraceSafariAuthTokenClear(nonce: nonce)
        case "TRACE_IOS_AUTH_PROVIDER_STATUS_REQUEST":
            guard body["protocolVersion"] as? Int == Self.traceDeviceProviderProtocolVersion else {
                postSafariExtensionActionResult(
                    type: "TRACE_IOS_AUTH_PROVIDER_STATUS_RESPONSE",
                    nonce: nonce,
                    ok: false,
                    error: "unsupported_protocol"
                )
                return
            }
            handleTraceSafariAuthProviderStatus(nonce: nonce)
        case "TRACE_IOS_EXTENSION_STATE_REQUEST":
            handleTraceSafariExtensionStateRequest(nonce: nonce)
        case "TRACE_IOS_OPEN_EXTENSION_SETTINGS":
            handleTraceSafariExtensionSettingsRequest(nonce: nonce)
        case "TRACE_IOS_OPEN_STORY_URL":
            let url = body["url"] as? String
            handleTraceSafariStoryOpenRequest(
                nonce: nonce,
                rawURL: url,
                handoffId: Self.sanitizedHandoffId(body["handoffId"])
            )
        case "TRACE_IOS_OPEN_ARCHIVE_HOME":
            handleTraceSafariArchiveHomeOpenRequest(
                nonce: nonce,
                handoffId: Self.sanitizedHandoffId(body["handoffId"]),
                hostKind: .ao3,
                responseType: "TRACE_IOS_OPEN_ARCHIVE_HOME_RESPONSE"
            )
        case "TRACE_IOS_OPEN_ARCHIVE_HOME_V2":
            guard let rawHostKind = body["hostKind"] as? String,
                  let hostKind = TraceSafariArchiveHostKind(rawValue: rawHostKind)
            else {
                postSafariExtensionActionResult(
                    type: "TRACE_IOS_OPEN_ARCHIVE_HOME_V2_RESPONSE",
                    nonce: nonce,
                    ok: false,
                    error: "invalid_host"
                )
                return
            }
            handleTraceSafariArchiveHomeOpenRequest(
                nonce: nonce,
                handoffId: Self.sanitizedHandoffId(body["handoffId"]),
                hostKind: hostKind,
                responseType: "TRACE_IOS_OPEN_ARCHIVE_HOME_V2_RESPONSE"
            )
        default:
            postSafariExtensionActionResult(
                type: "\(messageType)_RESPONSE",
                nonce: nonce,
                ok: false,
                error: "unknown_message_type"
            )
        }
    }

    private func handleTraceSafariAuthTokenUpdate(nonce: String, token: String?) {
        do {
            guard let token else {
                throw TraceSafariExtensionBridgeError.tokenShareFailed
            }
            try Self.storeSharedTraceToken(token)
            Self.recordAppProviderHealth(state: "ready")
#if DEBUG && targetEnvironment(simulator)
            traceSimulatorFailNextProviderClear =
                ProcessInfo.processInfo.environment["traceDebugFailProviderClear"] == "true"
#endif
            postSafariExtensionActionResult(
                type: "TRACE_IOS_AUTH_TOKEN_UPDATE_RESPONSE",
                nonce: nonce,
                ok: true
            )
        } catch {
            Self.recordAppProviderHealth(state: "write_failed")
            postSafariExtensionActionResult(
                type: "TRACE_IOS_AUTH_TOKEN_UPDATE_RESPONSE",
                nonce: nonce,
                ok: false,
                error: "provider_update_failed"
            )
        }
    }

    private func handleTraceSafariDeviceSessionUpdate(
        nonce: String,
        provider: [String: Any]
    ) {
        do {
            guard provider["version"] as? Int == Self.traceProviderRecordVersion,
                  provider["kind"] as? String == "device_session",
                  let rawSessionId = provider["sessionId"] as? String,
                  let rawCredential = provider["credential"] as? String,
                  let expiresAt = provider["expiresAt"] as? String,
                  let validated = TraceSafariProviderCodec.deviceSession(
                      sessionId: rawSessionId,
                      credential: rawCredential,
                      expiresAt: expiresAt
                  )
            else {
                throw TraceSafariExtensionBridgeError.tokenShareFailed
            }

            try Self.writeSharedProviderRecord(
                .deviceSession(
                    sessionId: validated.sessionId,
                    credential: validated.credential,
                    expiresAt: validated.expiresAt
                )
            )
#if DEBUG && targetEnvironment(simulator)
            traceSimulatorFailNextProviderClear =
                ProcessInfo.processInfo.environment["traceDebugFailProviderClear"] == "true"
#endif
            Self.recordAppProviderHealth(state: "ready")
            os_log(
                "Device credential provider write succeeded",
                log: Self.safariBridgeLog,
                type: .info
            )
            postSafariExtensionActionResult(
                type: "TRACE_IOS_AUTH_TOKEN_UPDATE_RESPONSE",
                nonce: nonce,
                ok: true
            )
        } catch {
            Self.recordAppProviderHealth(state: "write_failed")
            os_log(
                "Device credential provider write failed",
                log: Self.safariBridgeLog,
                type: .error
            )
            postSafariExtensionActionResult(
                type: "TRACE_IOS_AUTH_TOKEN_UPDATE_RESPONSE",
                nonce: nonce,
                ok: false,
                error: "provider_update_failed"
            )
        }
    }

    private func handleTraceSafariAuthProviderStatus(nonce: String) {
        do {
            let installationId = Self.traceInstallationId()
            let record = try Self.readSharedProviderRecord()
            var provider: TraceSafariAuthProviderMetadataPayload?
            if let record,
               record.version == Self.traceProviderRecordVersion,
               record.kind == "device_session",
               let rawSessionId = record.sessionId,
               let rawCredential = record.credential,
               let expiresAt = record.expiresAt,
               let validated = TraceSafariProviderCodec.deviceSession(
                   sessionId: rawSessionId,
                   credential: rawCredential,
                   expiresAt: expiresAt
               )
            {
                provider = TraceSafariAuthProviderMetadataPayload(
                    kind: "device_session",
                    sessionId: validated.sessionId,
                    expiresAt: validated.expiresAt
                )
            }
            os_log(
                "Credential provider status succeeded provider=%{public}@",
                log: Self.safariBridgeLog,
                type: .info,
                provider == nil ? "missing" : "ready"
            )
            Self.recordAppProviderHealth(
                state: provider == nil ? "missing" : "ready"
            )
            postTraceWebMessage(
                TraceSafariAuthProviderStatusPayload(
                    nonce: nonce,
                    ok: true,
                    protocolVersion: Self.traceDeviceProviderProtocolVersion,
                    installationId: installationId,
                    provider: provider
                )
            )
        } catch {
            Self.recordAppProviderHealth(state: "unavailable")
            os_log(
                "Credential provider status failed",
                log: Self.safariBridgeLog,
                type: .error
            )
            postSafariExtensionActionResult(
                type: "TRACE_IOS_AUTH_PROVIDER_STATUS_RESPONSE",
                nonce: nonce,
                ok: false,
                error: "provider_unavailable"
            )
        }
    }

    private func handleTraceSafariAuthTokenClear(nonce: String) {
        do {
            try clearSharedProviderForWebShell()
            Self.recordAppProviderHealth(state: "signed_out")
            postSafariExtensionActionResult(
                type: "TRACE_IOS_AUTH_TOKEN_CLEAR_RESPONSE",
                nonce: nonce,
                ok: true
            )
        } catch {
            Self.recordAppProviderHealth(state: "clear_failed")
            postSafariExtensionActionResult(
                type: "TRACE_IOS_AUTH_TOKEN_CLEAR_RESPONSE",
                nonce: nonce,
                ok: false,
                error: "provider_clear_failed"
            )
        }
    }

    private func clearSharedProviderForWebShell() throws {
#if DEBUG && targetEnvironment(simulator)
        if traceSimulatorFailNextProviderClear {
            traceSimulatorFailNextProviderClear = false
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
#endif
        try Self.clearSharedTraceTokens()
    }

    private func handleTraceSafariExtensionStateRequest(nonce: String) {
        Task { [weak self] in
            guard let self else { return }

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

                let identifiers = Self.safariExtensionCandidateIdentifiers()
                self.querySafariExtensionStates(for: identifiers) { [weak self] results in
                    guard let self else { return }

                    let selected =
                        results.first(where: { $0.enabled }) ??
                        results.first(where: { $0.errorCode == nil }) ??
                        results.first
                    let errorCode: String?
                    if let selected {
                        errorCode = selected.errorCode
                    } else {
                        errorCode = "extension_identifier_missing"
                    }

                    NSLog(
                        "[Trace] Safari extension state candidates=%@ results=%@ selected=%@ enabled=%@ error=%@",
                        identifiers.joined(separator: ","),
                        results.map { "\($0.identifier):enabled=\($0.enabled):error=\($0.errorCode ?? "none")" }.joined(separator: ","),
                        selected?.identifier ?? "none",
                        selected?.enabled == true ? "true" : "false",
                        errorCode ?? "none"
                    )

                    self.postSafariExtensionState(
                        nonce: nonce,
                        enabled: selected?.enabled == true,
                        settingsSupported: true,
                        error: errorCode,
                        queriedIdentifier: selected?.identifier,
                        embeddedExtensionIdentifiers: identifiers
                    )
                }
            }
        }
    }

    @available(iOS 26.2, *)
    private func querySafariExtensionStates(
        for identifiers: [String],
        completion: @escaping ([TraceSafariExtensionStateQueryResult]) -> Void
    ) {
        var remaining = Array(identifiers)
        var results: [TraceSafariExtensionStateQueryResult] = []

        func queryNext() {
            guard !remaining.isEmpty else {
                completion(results)
                return
            }

            let identifier = remaining.removeFirst()
            SFSafariExtensionManager.getStateOfExtension(withIdentifier: identifier) { state, error in
                DispatchQueue.main.async {
                    let errorCode: String?
                    if error != nil {
                        errorCode = "state_unavailable"
                    } else if state == nil {
                        errorCode = "state_missing"
                    } else {
                        errorCode = nil
                    }
                    results.append(
                        TraceSafariExtensionStateQueryResult(
                            identifier: identifier,
                            enabled: state?.isEnabled == true,
                            errorCode: errorCode
                        )
                    )
                    if state?.isEnabled == true {
                        completion(results)
                    } else {
                        queryNext()
                    }
                }
            }
        }

        queryNext()
    }

    private func handleTraceSafariExtensionSettingsRequest(nonce: String) {
        guard #available(iOS 26.2, *) else {
            postSafariExtensionActionResult(
                type: "TRACE_IOS_OPEN_EXTENSION_SETTINGS_RESPONSE",
                nonce: nonce,
                ok: false,
                error: "settings_unsupported"
            )
            return
        }

        // Opening system settings is independent of extension authentication.
        // Keep this call directly coupled to the reader's tap.
        SFSafariSettings.openExtensionsSettings(
            forIdentifiers: Self.safariExtensionSettingsIdentifiers()
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

    private func handleTraceSafariStoryOpenRequest(
        nonce: String,
        rawURL: String?,
        handoffId: String?
    ) {
        Task { [weak self] in
            guard let self else { return }
            do {
                guard let url = Self.supportedFirstStoryURL(rawURL) else {
                    throw TraceSafariExtensionBridgeError.unsupportedUrl
                }
                try Self.storePendingFirstStory(
                    mode: .story,
                    url: url,
                    handoffId: handoffId
                )
                await MainActor.run {
                    UIApplication.shared.open(url, options: [:]) { [weak self] success in
                        if !success {
                            Self.clearPendingFirstStoryURL()
                        }
                        self?.postSafariExtensionActionResult(
                            type: "TRACE_IOS_OPEN_STORY_URL_RESPONSE",
                            nonce: nonce,
                            ok: success,
                            error: success ? nil : "open_failed",
                            handoffId: success ? handoffId : nil
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
                        error: "handoff_store_failed"
                    )
                }
            }
        }
    }

    /// Opens one fixed supported archive home. This is intentionally not a
    /// generic browser launcher: the pending record is constrained to the
    /// selected host and is consumed only after a supported story is reached.
    private func handleTraceSafariArchiveHomeOpenRequest(
        nonce: String,
        handoffId: String?,
        hostKind: TraceSafariArchiveHostKind,
        responseType: String
    ) {
#if DEBUG
        if Self.isOnboardingUITest {
            let expectedHost = ProcessInfo.processInfo.environment["TRACE_UI_TEST_EXPECTED_ARCHIVE_HOST"]
            let matchesExpectation = expectedHost == hostKind.rawValue
            postSafariExtensionActionResult(
                type: responseType,
                nonce: nonce,
                ok: matchesExpectation,
                error: matchesExpectation ? nil : "ui_test_unexpected_host",
                handoffId: matchesExpectation ? handoffId : nil
            )
            return
        }
#endif
        Task { [weak self] in
            guard let self else { return }
            let url = hostKind.mobileHomeURL
            os_log(
                "Opening archive home host=%{public}@ destination=%{public}@",
                log: Self.safariBridgeLog,
                type: .info,
                hostKind.rawValue,
                url.absoluteString
            )
            do {
                try Self.storePendingFirstStory(
                    mode: .browse,
                    url: nil,
                    handoffId: handoffId,
                    browseHostKind: hostKind
                )
                await MainActor.run {
                    UIApplication.shared.open(url, options: [:]) { [weak self] success in
                        os_log(
                            "Archive home open completed host=%{public}@ destination=%{public}@ success=%{public}@",
                            log: Self.safariBridgeLog,
                            type: success ? .info : .error,
                            hostKind.rawValue,
                            url.absoluteString,
                            success ? "yes" : "no"
                        )
                        if !success {
                            Self.clearPendingFirstStoryURL()
                        }
                        self?.postSafariExtensionActionResult(
                            type: responseType,
                            nonce: nonce,
                            ok: success,
                            error: success ? nil : "open_failed",
                            handoffId: success ? handoffId : nil
                        )
                    }
                }
            } catch {
                await MainActor.run {
                    self.postSafariExtensionActionResult(
                        type: responseType,
                        nonce: nonce,
                        ok: false,
                        error: "handoff_store_failed"
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

    /// Privacy-safe provider health shared only with this app group. It gives
    /// support and release QA a durable boundary result without exposing a
    /// credential, account identifier, session identifier, story, or URL.
    private static func recordAppProviderHealth(state: String) {
        pendingDefaults()?.set(
            [
                "state": state,
                "updatedAt": Date().timeIntervalSince1970 * 1000,
            ],
            forKey: appProviderHealthDefaultsKey
        )
    }

    private static func safariExtensionCandidateIdentifiers() -> [String] {
        var identifiers = embeddedSafariExtensionBundleIdentifiers()
        identifiers.append(safariExtensionBundleIdentifier)

        var seen = Set<String>()
        return identifiers.filter { identifier in
            seen.insert(identifier).inserted
        }
    }

    /// Settings must receive only identifiers that are actually embedded in
    /// this build. Passing a retired probe identifier alongside the installed
    /// extension can make Safari reject the entire open-settings request.
    private static func safariExtensionSettingsIdentifiers() -> [String] {
        let embeddedIdentifiers = embeddedSafariExtensionBundleIdentifiers()
        return embeddedIdentifiers.isEmpty
            ? [safariExtensionBundleIdentifier]
            : embeddedIdentifiers
    }

    private static func embeddedSafariExtensionBundleIdentifiers() -> [String] {
        guard let plugInsURL = Bundle.main.builtInPlugInsURL,
              let plugInURLs = try? FileManager.default.contentsOfDirectory(
                at: plugInsURL,
                includingPropertiesForKeys: nil
              )
        else {
            return []
        }

        return plugInURLs.compactMap { url in
            guard url.pathExtension == "appex",
                  let bundle = Bundle(url: url),
                  let identifier = bundle.bundleIdentifier,
                  let extensionInfo = bundle.object(forInfoDictionaryKey: "NSExtension") as? [String: Any],
                  extensionInfo["NSExtensionPointIdentifier"] as? String == "com.apple.Safari.web-extension"
            else {
                return nil
            }
            return identifier
        }.sorted()
    }

    private static func storePendingFirstStory(
        mode: TraceSafariPendingFirstStoryMode,
        url: URL?,
        handoffId: String?,
        browseHostKind: TraceSafariArchiveHostKind? = nil
    ) throws {
        guard let defaults = pendingDefaults() else {
            throw TraceSafariExtensionBridgeError.sharedStorageUnavailable
        }
        let hostKind: String
        switch mode {
        case .story:
            guard let url, let inferredHostKind = archiveHostKind(for: url) else {
                throw TraceSafariExtensionBridgeError.unsupportedUrl
            }
            hostKind = inferredHostKind
            // Keep V1 during rollout so an already-installed older extension
            // can still complete a direct story handoff.
            defaults.set(url.absoluteString, forKey: pendingFirstStoryDefaultsKey)
            defaults.set(
                Date().addingTimeInterval(pendingFirstStoryTTL).timeIntervalSince1970,
                forKey: pendingFirstStoryExpiresAtDefaultsKey
            )
        case .browse:
            guard let browseHostKind else {
                throw TraceSafariExtensionBridgeError.unsupportedUrl
            }
            hostKind = browseHostKind.rawValue
            // An old direct handoff must not be replayed while the reader is
            // browsing AO3 home with the new protocol.
            defaults.removeObject(forKey: pendingFirstStoryDefaultsKey)
            defaults.removeObject(forKey: pendingFirstStoryExpiresAtDefaultsKey)
        }

        let expiresAt = Date().addingTimeInterval(pendingFirstStoryTTL).timeIntervalSince1970
        var pending: [String: Any] = [
            "mode": mode.rawValue,
            "hostKind": hostKind,
            "expiresAt": expiresAt,
        ]
        if let url {
            pending["url"] = url.absoluteString
        }
        if let handoffId,
           let sanitizedHandoffId = sanitizedHandoffId(handoffId)
        {
            pending["handoffId"] = sanitizedHandoffId
        }
        defaults.set(pending, forKey: pendingFirstStoryV2DefaultsKey)
    }

    private static func clearPendingFirstStoryURL() {
        guard let defaults = pendingDefaults() else { return }
        defaults.removeObject(forKey: pendingFirstStoryDefaultsKey)
        defaults.removeObject(forKey: pendingFirstStoryExpiresAtDefaultsKey)
        defaults.removeObject(forKey: pendingFirstStoryV2DefaultsKey)
    }

    private static func archiveHostKind(for url: URL) -> String? {
        guard let host = url.host?.lowercased() else { return nil }
        if isSupportedAO3Host(host) { return "ao3" }
        if host == "www.fanfiction.net" || host == "m.fanfiction.net" {
            return "ffn"
        }
        return nil
    }

    private static func sanitizedHandoffId(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 128,
              trimmed.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
        else {
            return nil
        }
        return trimmed
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
        guard !trimmed.isEmpty else {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
        try writeSharedProviderRecord(.legacyAccessToken(trimmed))
    }

    private static func traceInstallationId() -> String {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: traceInstallationIdDefaultsKey),
           let uuid = UUID(uuidString: existing)
        {
            return uuid.uuidString.lowercased()
        }
        let created = UUID().uuidString.lowercased()
        defaults.set(created, forKey: traceInstallationIdDefaultsKey)
        return created
    }

    private static func readSharedProviderRecord() throws -> TraceSafariProviderRecord? {
#if DEBUG && targetEnvironment(simulator)
        guard let data = UserDefaults.standard.data(
            forKey: traceSimulatorProviderV2Key
        ) else {
            return nil
        }
#else
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: traceAuthTokenService,
            kSecAttrAccount as String: traceAuthTokenAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup(),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            os_log(
                "Shared provider read failed status=%{public}d",
                log: safariBridgeLog,
                type: .error,
                status
            )
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
#endif
        if let record = try? JSONDecoder().decode(
            TraceSafariProviderRecord.self,
            from: data
        ) {
            return record
        }
        if TraceSafariProviderCodec.isLegacyV060RawAccessToken(data) {
            os_log(
                "Legacy v0.6.0 provider detected; awaiting device-session replacement",
                log: safariBridgeLog,
                type: .info
            )
            return nil
        }
        throw TraceSafariExtensionBridgeError.tokenShareFailed
    }

    private static func writeSharedProviderRecord(
        _ record: TraceSafariProviderRecord
    ) throws {
        let data: Data
        do {
            data = try JSONEncoder().encode(record)
        } catch {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
#if DEBUG && targetEnvironment(simulator)
        UserDefaults.standard.set(data, forKey: traceSimulatorProviderV2Key)
        guard UserDefaults.standard.data(forKey: traceSimulatorProviderV2Key) == data else {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
#else
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: traceAuthTokenService,
            kSecAttrAccount as String: traceAuthTokenAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup(),
        ]
        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            os_log(
                "Shared provider update failed status=%{public}d",
                log: safariBridgeLog,
                type: .error,
                updateStatus
            )
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            os_log(
                "Shared provider add failed status=%{public}d",
                log: safariBridgeLog,
                type: .error,
                addStatus
            )
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
#endif
    }

    private static func clearSharedTraceTokens() throws {
#if DEBUG && targetEnvironment(simulator)
        UserDefaults.standard.removeObject(forKey: traceSimulatorProviderV2Key)
        UserDefaults.standard.removeObject(forKey: traceSimulatorRetiredProviderKey)
        guard UserDefaults.standard.object(forKey: traceSimulatorProviderV2Key) == nil,
              UserDefaults.standard.object(forKey: traceSimulatorRetiredProviderKey) == nil
        else {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
#else
        try deleteSharedTraceToken(account: traceAuthTokenAccount)
        try clearRetiredSharedTraceToken()
#endif
    }

    private static func clearRetiredSharedTraceToken() throws {
#if DEBUG && targetEnvironment(simulator)
        UserDefaults.standard.removeObject(forKey: traceSimulatorRetiredProviderKey)
        guard UserDefaults.standard.object(
            forKey: traceSimulatorRetiredProviderKey
        ) == nil else {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
#else
        try deleteSharedTraceToken(account: retiredTraceAuthTokenAccount)
#endif
    }

#if !DEBUG || !targetEnvironment(simulator)
    private static func deleteSharedTraceToken(account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: traceAuthTokenService,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: keychainAccessGroup(),
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw TraceSafariExtensionBridgeError.tokenShareFailed
        }
    }
#endif

    private static func readExtensionHeartbeat() -> TraceSafariExtensionHeartbeat? {
        guard let defaults = pendingDefaults(),
              let raw = defaults.dictionary(forKey: extensionHeartbeatDefaultsKey)
        else {
            return nil
        }

        func readHostTimestamps(_ value: Any?) -> [String: Double] {
            var out: [String: Double] = [:]
            guard let rawHosts = value as? [String: Any] else { return out }
            for (host, entry) in rawHosts {
                if let at = entry as? Double, at > 0 {
                    out[host] = at
                } else if let at = entry as? Int, at > 0 {
                    out[host] = Double(at)
                }
            }
            return out
        }

        func readEpochMillis(_ value: Any?) -> Double? {
            if let at = value as? Double, at > 0 { return at }
            if let at = value as? Int, at > 0 { return Double(at) }
            return nil
        }

        let lastRunByHost = readHostTimestamps(raw["lastRunByHost"])
        guard !lastRunByHost.isEmpty else { return nil }

        return TraceSafariExtensionHeartbeat(
            lastRunByHost: lastRunByHost,
            lastSaveByHost: readHostTimestamps(raw["lastSaveByHost"]),
            grantedOrigins: raw["grantedOrigins"] as? [String],
            permissionSnapshotAt: readEpochMillis(raw["permissionSnapshotAt"]),
            updatedAt: readEpochMillis(raw["updatedAt"]),
            lastRunHandoffId: sanitizedHandoffId(raw["lastRunHandoffId"]),
            lastRunHandoffAt: readEpochMillis(raw["lastRunHandoffAt"])
        )
    }

    @MainActor
    private func postSafariExtensionState(
        nonce: String,
        enabled: Bool,
        settingsSupported: Bool,
        error: String?,
        queriedIdentifier: String? = nil,
        embeddedExtensionIdentifiers: [String]? = nil
    ) {
        let heartbeat = Self.readExtensionHeartbeat()
        postTraceWebMessage(
            TraceSafariExtensionStatePayload(
                nonce: nonce,
                enabled: enabled,
                settingsSupported: settingsSupported,
                archiveBrowseHosts: [
                    TraceSafariArchiveHostKind.ao3.rawValue,
                    TraceSafariArchiveHostKind.ffn.rawValue,
                ],
                earnedPermissionOnboarding:
                    TraceWebOriginGenerated.earnedPermissionOnboardingEnabled,
                error: error,
                queriedIdentifier: queriedIdentifier,
                embeddedExtensionIdentifiers: embeddedExtensionIdentifiers,
                lastArchiveRunAt: heartbeat?.lastArchiveRunAt,
                lastArchiveSaveAt: heartbeat?.lastArchiveSaveAt,
                lastRunByHost: heartbeat?.lastRunByHost,
                grantedOrigins: heartbeat?.grantedOrigins,
                permissionSnapshotAt: heartbeat?.permissionSnapshotAt,
                heartbeatUpdatedAt: heartbeat?.updatedAt,
                lastRunHandoffId: heartbeat?.lastRunHandoffId,
                lastRunHandoffAt: heartbeat?.lastRunHandoffAt
            )
        )
    }

    @MainActor
    private func postSafariExtensionActionResult(
        type: String,
        nonce: String,
        ok: Bool,
        error: String? = nil,
        handoffId: String? = nil
    ) {
        postTraceWebMessage(
            TraceSafariExtensionActionPayload(
                type: type,
                nonce: nonce,
                ok: ok,
                error: error,
                handoffId: handoffId
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
              let originData = try? JSONEncoder().encode(currentWebMessageTargetOrigin()),
              let originJson = String(data: originData, encoding: .utf8)
        else { return }

        let js = "window.postMessage(\(json), \(originJson));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func currentWebMessageTargetOrigin() -> String {
        guard let url = webView.url,
              let scheme = url.scheme?.lowercased(),
              let host = url.host,
              traceAppHostsMatch(url)
        else {
            return Self.webAppHTTPSOrigin
        }

#if DEBUG
        let schemeIsAllowed = scheme == "https" || (Self.isOnboardingUITest && scheme == "http")
#else
        let schemeIsAllowed = scheme == "https"
#endif
        guard schemeIsAllowed else { return Self.webAppHTTPSOrigin }

        var origin = "\(scheme)://\(host)"
        if let port = url.port {
            origin += ":\(port)"
        }
        return origin
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
