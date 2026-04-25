import Foundation
import StoreKit

@MainActor
final class TraceBillingCoordinator {
    enum BillingError: Error {
        case productsUnavailable
        case purchaseCancelled
        case purchasePending
        case unverifiedTransaction
        case noRestorablePurchase
        case verifyRejected(code: String, statusCode: Int)
        case verifyTransportFailed
        case invalidVerifyResponse
    }

    struct VerifyResult {
        let pro: Bool
        let proExpiresAt: String?
    }

    private struct VerifyRequest: Encodable {
        let signedTransaction: String
    }

    private struct VerifyResponse: Decodable {
        let pro: Bool
        let proExpiresAt: String?

        enum CodingKeys: String, CodingKey {
            case pro
            case proExpiresAt = "pro_expires_at"
        }
    }

    private struct VerifyErrorResponse: Decodable {
        let error: String?
    }

    static let productIDs = ["monthlypro", "traceproyearly"]

    private let apiBaseURL: URL
    private let session: URLSession
    private let tokenProvider: () async throws -> String
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(
        apiBaseURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping () async throws -> String
    ) {
        self.apiBaseURL = apiBaseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    func fetchProducts() async throws -> [Product] {
        let products = try await Product.products(for: Self.productIDs)
        guard !products.isEmpty else {
            throw BillingError.productsUnavailable
        }

        let order = Dictionary(
            uniqueKeysWithValues: Self.productIDs.enumerated().map { ($1, $0) }
        )
        return products.sorted { lhs, rhs in
            (order[lhs.id] ?? Int.max) < (order[rhs.id] ?? Int.max)
        }
    }

    func purchase(product: Product) async throws -> VerifyResult {
        let result = try await product.purchase()
        switch result {
        case .success(let verification):
            let transaction = try Self.verifiedTransaction(from: verification)
            let verified = try await verifyAndBind(verification: verification)
            await transaction.finish()
            return verified
        case .pending:
            throw BillingError.purchasePending
        case .userCancelled:
            throw BillingError.purchaseCancelled
        @unknown default:
            throw BillingError.verifyTransportFailed
        }
    }

    func restore() async throws -> VerifyResult {
        do {
            try await AppStore.sync()
        } catch {
            if Self.isUserCancelled(error) {
                throw BillingError.purchaseCancelled
            }
            throw error
        }

        var selected: (verification: VerificationResult<Transaction>, transaction: Transaction)?
        for await entitlement in Transaction.currentEntitlements {
            guard case .verified(let transaction) = entitlement else { continue }
            guard Self.productIDs.contains(transaction.productID) else { continue }
            guard transaction.revocationDate == nil else { continue }
            if let expirationDate = transaction.expirationDate, expirationDate <= Date() {
                continue
            }

            if let existing = selected {
                if transaction.purchaseDate > existing.transaction.purchaseDate {
                    selected = (entitlement, transaction)
                }
            } else {
                selected = (entitlement, transaction)
            }
        }

        guard let selected else {
            throw BillingError.noRestorablePurchase
        }

        return try await verifyAndBind(verification: selected.verification)
    }

    private func verifyAndBind(
        verification: VerificationResult<Transaction>
    ) async throws -> VerifyResult {
        let signedTransaction = verification.jwsRepresentation
        guard !signedTransaction.isEmpty else {
            throw BillingError.invalidVerifyResponse
        }
        return try await verifyAndBind(signedTransaction: signedTransaction)
    }

    private func verifyAndBind(signedTransaction: String) async throws -> VerifyResult {
        let token = try await tokenProvider()
        let endpoint = apiBaseURL.appendingPathComponent("api/billing/apple/verify")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try encoder.encode(
            VerifyRequest(signedTransaction: signedTransaction)
        )

        let payload: Data
        let response: URLResponse
        do {
            (payload, response) = try await session.data(for: request)
        } catch {
            throw BillingError.verifyTransportFailed
        }

        guard let http = response as? HTTPURLResponse else {
            throw BillingError.verifyTransportFailed
        }

        guard (200...299).contains(http.statusCode) else {
            let code = (try? decoder.decode(VerifyErrorResponse.self, from: payload).error)
                ?? "apple_verify_failed"
            throw BillingError.verifyRejected(code: code, statusCode: http.statusCode)
        }

        guard let decoded = try? decoder.decode(VerifyResponse.self, from: payload) else {
            throw BillingError.invalidVerifyResponse
        }

        return VerifyResult(pro: decoded.pro, proExpiresAt: decoded.proExpiresAt)
    }

    private static func verifiedTransaction(
        from result: VerificationResult<Transaction>
    ) throws -> Transaction {
        switch result {
        case .verified(let transaction):
            return transaction
        case .unverified:
            throw BillingError.unverifiedTransaction
        }
    }

    private static func isUserCancelled(_ error: Error) -> Bool {
        if let storeKitError = error as? StoreKitError,
           case .userCancelled = storeKitError {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == SKErrorDomain &&
            nsError.code == SKError.Code.paymentCancelled.rawValue
    }
}
