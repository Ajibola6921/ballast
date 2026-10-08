/**
 * Authentication for the services that are meant to be called only by other Ballast services
 * (`payout-hop` moves the operator's USDC, `issuer-gateway` asks issuers for liens and redemptions).
 * They used to listen on every interface with no authentication, so anything that could reach the
 * port could make the operator pay anyone. Now every request must carry a shared secret, compared
 * in constant time, and the default bind address is loopback.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-internal-token";
const MIN_TOKEN_LENGTH = 32;

/** The slice of a Fastify instance this needs, so this package does not depend on Fastify. */
export interface HookHost {
  addHook(
    name: "onRequest",
    handler: (
      request: { headers: Record<string, unknown> },
      reply: { code(status: number): { send(body: unknown): unknown } },
    ) => Promise<unknown> | unknown,
  ): unknown;
}

/** Reads `INTERNAL_API_TOKEN`; throws unless it is set and long enough to resist guessing. */
export function loadInternalToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.INTERNAL_API_TOKEN;
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `INTERNAL_API_TOKEN must be set to a secret of at least ${MIN_TOKEN_LENGTH} characters (openssl rand -hex 32)`,
    );
  }
  return token;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Refuses every request that does not carry the token. Register before any route. */
export function requireInternalToken(app: HookHost, token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) throw new Error("internal token is too short");
  const expected = digest(token);
  app.addHook("onRequest", async (request, reply) => {
    const given = request.headers[INTERNAL_TOKEN_HEADER];
    // Hashing both sides first makes the comparison constant-time whatever the lengths are.
    if (typeof given !== "string" || !timingSafeEqual(digest(given), expected)) {
      return reply.code(401).send({ error: "missing or invalid internal token" });
    }
  });
}

/** Where an internal service listens: loopback unless `<NAME>_HOST` says otherwise. */
export function internalBindHost(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[`${name.toUpperCase().replace(/-/g, "_")}_HOST`] || "127.0.0.1";
}
