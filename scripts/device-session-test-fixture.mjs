import { randomBytes, randomUUID } from "node:crypto";

// Local installed-browser fixtures retain their existing account/race scenarios
// while requiring production's background-only scoped credential exchange.
export function deviceSessionFixture() {
  const grants = new Map();
  return async (request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (request.url === "/api/extension/device-sessions" && request.method === "POST") {
      if (!authorization.startsWith("Bearer kernel-")) {
        response.writeHead(401); response.end(); return true;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const { installationId, platform } = JSON.parse(body);
      if (platform !== "browser") throw Error("Expected browser device session");
      const credential = `trd_v1_${randomBytes(32).toString("base64url")}`;
      grants.set(`Bearer ${credential}`, authorization);
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "issued", credential,
        session: { id: randomUUID(), installationId, absoluteExpiresAt: "2099-01-01T00:00:00.000Z" } }));
      return true;
    }
    if (request.url === "/api/extension/session" && request.method === "DELETE") {
      const revoked = grants.delete(authorization);
      response.writeHead(revoked ? 200 : 401); response.end(); return true;
    }
    if (request.url.startsWith("/api/extension/")) {
      request.headers.authorization = grants.get(authorization) ?? "";
    }
    return false;
  };
}
