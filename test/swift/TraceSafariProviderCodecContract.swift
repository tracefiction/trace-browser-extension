import Foundation

@main
struct TraceSafariProviderCodecContract {
    static func main() {
        require(
            TraceSafariProviderCodec.parseISO8601Date(
                "2027-08-02T00:00:00.000Z"
            ) != nil,
            "API fractional-seconds timestamp must parse"
        )
        require(
            TraceSafariProviderCodec.parseISO8601Date(
                "2027-08-02T00:00:00Z"
            ) != nil,
            "non-fractional ISO-8601 timestamp must parse"
        )
        require(
            TraceSafariProviderCodec.parseISO8601Date("not-a-date") == nil,
            "malformed timestamp must fail closed"
        )

        let credential = "trd_v1_" + String(repeating: "A", count: 43)
        let session = TraceSafariProviderCodec.deviceSession(
            sessionId: "8A0EAD75-6A99-4380-A175-BB97331F48E7",
            credential: "  \(credential)  ",
            expiresAt: "2027-08-02T00:00:00.000Z"
        )
        require(session?.sessionId == "8a0ead75-6a99-4380-a175-bb97331f48e7", "UUID must normalize")
        require(session?.credential == credential, "credential must trim and validate")
        require(
            TraceSafariProviderCodec.deviceSession(
                sessionId: "not-a-uuid",
                credential: credential,
                expiresAt: "2027-08-02T00:00:00.000Z"
            ) == nil,
            "malformed session ID must fail closed"
        )
        require(
            TraceSafariProviderCodec.deviceSession(
                sessionId: "8a0ead75-6a99-4380-a175-bb97331f48e7",
                credential: "trd_v1_too-short",
                expiresAt: "2027-08-02T00:00:00.000Z"
            ) == nil,
            "malformed credential must fail closed"
        )

        let legacy = Data(
            "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0cmFjZS12MC02LTAifQ.signature_fixture".utf8
        )
        require(
            TraceSafariProviderCodec.isLegacyV060RawAccessToken(legacy),
            "known three-segment v0.6.0 provider must be replaceable"
        )
        require(
            !TraceSafariProviderCodec.isLegacyV060RawAccessToken(Data("corrupt".utf8)),
            "arbitrary corrupt data must remain unavailable"
        )

        print("TraceSafariProviderCodec contract passed")
    }

    private static func require(
        _ condition: @autoclosure () -> Bool,
        _ message: String
    ) {
        guard condition() else {
            fputs("TraceSafariProviderCodec contract failed: \(message)\n", stderr)
            exit(1)
        }
    }
}
