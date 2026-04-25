//
//  TraceSubscriptionPaywallViewController.swift
//  iOS (App)
//
//  App Review 3.1.2: subscription title, period, price, included features, and
//  tappable Terms of Use (standard Apple EULA) + Privacy Policy links in the purchase flow.
//

import StoreKit
import UIKit

/// Legal URLs for the native shell; production policies live on the Trace site.
/// Terms of Use uses Apple’s standard Licensed Application EULA to match App Store description.
enum TraceAppStoreLegal {
    static let termsOfUseEULA = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    static let privacyPolicy = URL(string: "https://tracefiction.com/privacy")!
}

@MainActor
final class TraceSubscriptionPaywallViewController: UIViewController {
    private static let sharedFeaturesText = "All plans include unlimited library and all Pro features."

    private let products: [Product]
    private let productsByID: [String: Product]
    private let productIDsInDisplayOrder: [String]
    private let onSubscribe: (Product) -> Void
    private let onRestore: () -> Void
    private let onDismiss: () -> Void
    private let recommendedProductID: String?
    private var selectedProductID: String

    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let continueButton = UIButton(type: .system)
    private var planCardsByProductID: [String: UIControl] = [:]
    private var planCheckmarksByProductID: [String: UIImageView] = [:]

    init(
        products: [Product],
        onSubscribe: @escaping (Product) -> Void,
        onRestore: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.products = products
        var byID: [String: Product] = [:]
        for product in products {
            byID[product.id] = product
        }
        self.productsByID = byID
        self.productIDsInDisplayOrder = products.map(\.id)
        self.onSubscribe = onSubscribe
        self.onRestore = onRestore
        self.onDismiss = onDismiss
        self.recommendedProductID = Self.pickRecommendedProductID(products: products)
        self.selectedProductID = self.recommendedProductID ?? products.first?.id ?? ""
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.title = "Trace Pro"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close,
            target: self,
            action: #selector(closeTapped)
        )
        setUpLayout()
    }

    private func setUpLayout() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.delaysContentTouches = false
        scrollView.canCancelContentTouches = true
        view.addSubview(scrollView)

        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 16, left: 20, bottom: 24, right: 20)
        scrollView.addSubview(stack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor)
        ])

        addIntro()
        for product in products {
            addProductBlock(product)
        }
        addContinueButton()
        addAutoRenewalNotice()
        addRestoreButton()
        addLegalLinksRow()
        updateSelectedPlanUI()
    }

    private func addIntro() {
        let title = UILabel()
        title.text = "Upgrade to Trace Pro"
        title.font = UIFont.preferredFont(forTextStyle: .title1, compatibleWith: traitCollection)
        title.textColor = .label
        title.numberOfLines = 0
        title.adjustsFontForContentSizeCategory = true
        title.accessibilityTraits.insert(.header)

        let body = UILabel()
        body.text = Self.sharedFeaturesText
        body.font = UIFont.preferredFont(forTextStyle: .body, compatibleWith: traitCollection)
        body.textColor = .secondaryLabel
        body.numberOfLines = 0
        body.adjustsFontForContentSizeCategory = true

        stack.addArrangedSubview(title)
        stack.addArrangedSubview(body)
    }

    private func addProductBlock(_ product: Product) {
        let card = UIControl()
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 14
        card.layer.borderWidth = 2
        card.layer.borderColor = UIColor.separator.cgColor
        card.clipsToBounds = true
        card.accessibilityTraits.insert(.button)
        card.accessibilityHint = "Select this plan."
        card.addTarget(self, action: #selector(planTapped(_:)), for: .touchUpInside)
        card.accessibilityIdentifier = "trace_paywall_plan_\(product.id)"
        if let index = productIDsInDisplayOrder.firstIndex(of: product.id) {
            card.tag = index
        }

        let content = UIStackView()
        content.axis = .vertical
        content.spacing = 8
        content.isUserInteractionEnabled = false
        content.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
            content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14)
        ])

        let header = UIStackView()
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = 8

        let name = UILabel()
        name.text = product.displayName
        name.font = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: traitCollection)
        name.textColor = .label
        name.numberOfLines = 0
        name.adjustsFontForContentSizeCategory = true
        header.addArrangedSubview(name)

        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        header.addArrangedSubview(spacer)

        if product.id == recommendedProductID {
            let badge = UILabel()
            badge.text = "BEST VALUE"
            badge.font = UIFont.preferredFont(forTextStyle: .caption2, compatibleWith: traitCollection)
            badge.textColor = .systemBlue
            badge.numberOfLines = 1
            badge.adjustsFontForContentSizeCategory = true
            badge.accessibilityLabel = "Best value plan"
            header.addArrangedSubview(badge)
        }

        let checkmark = UIImageView(image: UIImage(systemName: "checkmark.circle.fill"))
        checkmark.tintColor = .systemBlue
        checkmark.contentMode = .scaleAspectFit
        checkmark.setContentHuggingPriority(.required, for: .horizontal)
        checkmark.setContentCompressionResistancePriority(.required, for: .horizontal)
        header.addArrangedSubview(checkmark)
        planCheckmarksByProductID[product.id] = checkmark

        let periodLine = UILabel()
        if let sub = product.subscription,
           let periodText = Self.formatSubscriptionPeriod(sub.subscriptionPeriod) {
            periodLine.text = "Length: \(periodText) (auto-renewing)"
        } else {
            periodLine.text = "Length: Auto-renewing subscription"
        }
        periodLine.font = UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traitCollection)
        periodLine.textColor = .secondaryLabel
        periodLine.numberOfLines = 0
        periodLine.adjustsFontForContentSizeCategory = true

        let priceLine = UILabel()
        if let price = Self.priceSummary(for: product) {
            priceLine.text = "Price: \(price)"
        } else {
            priceLine.text = "Price: \(product.displayPrice)"
        }
        priceLine.font = UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traitCollection)
        priceLine.textColor = .label
        priceLine.numberOfLines = 0
        priceLine.adjustsFontForContentSizeCategory = true

        content.addArrangedSubview(header)
        content.addArrangedSubview(periodLine)
        content.addArrangedSubview(priceLine)
        stack.addArrangedSubview(card)

        planCardsByProductID[product.id] = card
        card.accessibilityLabel = [
            product.displayName,
            periodLine.text,
            priceLine.text,
            Self.sharedFeaturesText
        ]
        .compactMap { $0 }
        .joined(separator: ". ")
    }

    private func addContinueButton() {
        continueButton.addTarget(self, action: #selector(continueTapped), for: .touchUpInside)
        continueButton.accessibilityHint = "Opens the App Store purchase sheet for the selected plan."
        stack.addArrangedSubview(continueButton)
    }

    @objc
    private func planTapped(_ sender: UIControl) {
        guard sender.tag >= 0, sender.tag < productIDsInDisplayOrder.count else { return }
        selectedProductID = productIDsInDisplayOrder[sender.tag]
        updateSelectedPlanUI()
    }

    @objc
    private func continueTapped() {
        guard let selected = productsByID[selectedProductID] else { return }
        onSubscribe(selected)
    }

    private func updateSelectedPlanUI() {
        for productID in productIDsInDisplayOrder {
            let isSelected = productID == selectedProductID
            if let card = planCardsByProductID[productID] {
                card.layer.borderColor = (isSelected ? UIColor.systemBlue : UIColor.separator).cgColor
                card.backgroundColor = isSelected
                    ? UIColor.systemBlue.withAlphaComponent(0.09)
                    : UIColor.secondarySystemBackground
                if isSelected {
                    card.accessibilityTraits.insert(.selected)
                } else {
                    card.accessibilityTraits.remove(.selected)
                }
            }
            planCheckmarksByProductID[productID]?.isHidden = !isSelected
        }

        guard let selected = productsByID[selectedProductID] else { return }
        var config = UIButton.Configuration.borderedProminent()
        config.title = "Continue"
        config.subtitle = selected.displayName
        config.buttonSize = .large
        config.cornerStyle = .large
        config.baseBackgroundColor = .systemBlue
        config.baseForegroundColor = .white
        continueButton.configuration = config
        continueButton.accessibilityLabel = "Continue with \(selected.displayName)"
    }

    private func addAutoRenewalNotice() {
        let note = UILabel()
        note.text = "Payment is charged to your Apple ID. Cancel anytime in Settings > Apple ID > Subscriptions."
        note.font = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traitCollection)
        note.textColor = .secondaryLabel
        note.numberOfLines = 0
        note.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(note)
    }

    private func addRestoreButton() {
        var config = UIButton.Configuration.plain()
        config.title = "Restore purchases"
        config.baseForegroundColor = .systemBlue
        let restore = UIAction { [weak self] _ in
            self?.onRestore()
        }
        let b = UIButton(configuration: config, primaryAction: restore)
        b.contentHorizontalAlignment = .leading
        b.accessibilityHint = "Restores a previously purchased subscription on this Apple ID."
        stack.addArrangedSubview(b)
    }

    private func addLegalLinksRow() {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 16
        row.alignment = .fill
        row.distribution = .fillEqually

        let terms = makeLinkButton(
            title: "Terms of Use",
            url: TraceAppStoreLegal.termsOfUseEULA
        )
        let privacy = makeLinkButton(
            title: "Privacy Policy",
            url: TraceAppStoreLegal.privacyPolicy
        )
        row.addArrangedSubview(terms)
        row.addArrangedSubview(privacy)
        stack.addArrangedSubview(row)
    }

    private func makeLinkButton(title: String, url: URL) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.title = title
        config.baseForegroundColor = .systemBlue
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attrs in
            var next = attrs
            next.underlineStyle = .single
            return next
        }
        let open = UIAction { _ in
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        let b = UIButton(configuration: config, primaryAction: open)
        b.contentHorizontalAlignment = .leading
        b.accessibilityHint = "Opens in Safari"
        if url == TraceAppStoreLegal.termsOfUseEULA {
            b.accessibilityIdentifier = "trace_paywall_eula"
        } else {
            b.accessibilityIdentifier = "trace_paywall_privacy"
        }
        return b
    }

    @objc
    private func closeTapped() {
        onDismiss()
    }

    private static func formatSubscriptionPeriod(_ period: Product.SubscriptionPeriod) -> String? {
        let v = period.value
        let unit: String
        switch period.unit {
        case .day: unit = v == 1 ? "1 day" : "\(v) days"
        case .week: unit = v == 1 ? "1 week" : "\(v) weeks"
        case .month: unit = v == 1 ? "1 month" : "\(v) months"
        case .year: unit = v == 1 ? "1 year" : "\(v) years"
        @unknown default: return nil
        }
        return unit
    }

    private static func pickRecommendedProductID(products: [Product]) -> String? {
        for product in products where product.id.lowercased().contains("year") {
            return product.id
        }

        var winner: Product?
        var winnerMonths: Int = 0
        for product in products {
            guard let sub = product.subscription else { continue }
            let months: Int
            switch sub.subscriptionPeriod.unit {
            case .year:
                months = sub.subscriptionPeriod.value * 12
            case .month:
                months = sub.subscriptionPeriod.value
            default:
                months = 0
            }
            if months > winnerMonths {
                winnerMonths = months
                winner = product
            }
        }
        return winner?.id
    }

    private static func priceSummary(for product: Product) -> String? {
        guard let sub = product.subscription,
              let periodText = formatSubscriptionPeriod(sub.subscriptionPeriod)
        else {
            return nil
        }

        let base = "\(product.displayPrice) / \(periodText)"
        guard let perUnit = perUnitSuffix(for: product) else {
            return base
        }
        return "\(base) (\(perUnit))"
    }

    private static func perUnitSuffix(for product: Product) -> String? {
        guard let sub = product.subscription else { return nil }

        switch sub.subscriptionPeriod.unit {
        case .year:
            let monthCount = sub.subscriptionPeriod.value * 12
            guard let monthly = formatDividedPrice(product: product, divisor: monthCount) else { return nil }
            return "~\(monthly)/month"
        case .month where sub.subscriptionPeriod.value > 1:
            guard let monthly = formatDividedPrice(product: product, divisor: sub.subscriptionPeriod.value) else { return nil }
            return "~\(monthly)/month"
        default:
            return nil
        }
    }

    private static func formatDividedPrice(product: Product, divisor: Int) -> String? {
        guard divisor > 0 else { return nil }

        let amount = NSDecimalNumber(decimal: product.price)
        let divisorAmount = NSDecimalNumber(value: divisor)
        let divided = amount.dividing(by: divisorAmount)
        if divided == .notANumber {
            return nil
        }
        return divided.decimalValue.formatted(product.priceFormatStyle)
    }
}
