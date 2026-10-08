import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "./config.js";
import { verifySessionToken } from "./session-token.js";
import { RateWindow, verifyApiKeyRequest } from "./apiKeys.js";

declare module "fastify" {
  interface FastifyRequest {
    partyId: string;
    stellarAccount: string | null;
    /** Raw request body bytes, kept so signed-request auth hashes exactly what was sent. */
    rawBody?: Buffer;
    /** How the caller authenticated; key-management routes accept only a session. */
    authMethod?: "session" | "api_key";
  }
  // `@fastify/rate-limit` augments `FastifyContextConfig` with its own `rateLimit` field, which
  // turns it from an effectively-open type into a closed one — route configs using this app's
  // own `public` convention (see `buildAuthHook` below) need to be declared here too, or every
  // `{ config: { public: true } }` route option becomes a TS excess-property error.
  interface FastifyContextConfig {
    public?: boolean;
  }
}

/**
 * Auth per PRD §9: "SEP-10 JWT for Stellar accounts; API key + HMAC for institutions."
 *
 * SEP-10 is real: `routes/auth.ts` issues a genuine challenge transaction (via
 * `@stellar/stellar-sdk`'s `WebAuth.buildChallengeTx`), the wallet signs it with the account's
 * own Stellar key, and `WebAuth.verifyChallengeTxSigners` verifies that signature before a JWT is
 * minted. This hook only verifies the resulting JWT — signed with `jwtSigningSecret` (HMAC), a
 * secret distinct from the SEP-10 server keypair — and never re-derives Stellar-key proof itself.
 *
 * The JWT is expected to carry a `sub` claim equal to the caller's Stellar G-address, matching
 * SEP-10 JWT convention; we then resolve `partyId` from the `party_account` table.
 *
 * The institution path (`x-api-key` + `x-timestamp` + `x-nonce` + `x-signature`) is verified in
 * `apiKeys.ts` against a key stored in `party_api_key`: the signature covers the method, path,
 * query and a hash of the raw body, the timestamp bounds replay and each nonce is single use.
 * Keys are created, listed and revoked by the party through `routes/api-keys.ts`.
 */
const FAILURES_PER_MINUTE = 30;
const REQUESTS_PER_KEY_PER_MINUTE = 1000;

export function buildAuthHook(config: ApiConfig, db: Database) {
  const failures = new RateWindow(FAILURES_PER_MINUTE, 60_000);
  const perKey = new RateWindow(REQUESTS_PER_KEY_PER_MINUTE, 60_000);
  const failureCount = (ip: string) => failures.count(ip);
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Routes registered with `{ config: { public: true } }` (health check, public asset/price
    // listings) skip auth entirely.
    if ((request.routeOptions.config as { public?: boolean } | undefined)?.public) {
      return;
    }

    const authHeader = request.headers.authorization;
    const apiKey = request.headers["x-api-key"];
    const signature = request.headers["x-signature"];
    const timestampHeader = request.headers["x-timestamp"];

    if (typeof apiKey === "string" && typeof signature === "string") {
      // Bound the cost of guessing: too many failed attempts from one address are refused outright.
      if (failureCount(request.ip) > FAILURES_PER_MINUTE) {
        return reply.code(429).send({ error: "too many failed authentication attempts" });
      }
      const result = await verifyApiKeyRequest(db, config.apiKeySecretKey, {
        keyId: apiKey,
        signature,
        timestamp: typeof timestampHeader === "string" ? timestampHeader : undefined,
        nonce: typeof request.headers["x-nonce"] === "string" ? request.headers["x-nonce"] : undefined,
        method: request.method,
        url: request.url,
        rawBody: request.rawBody ?? Buffer.alloc(0),
      });
      if (!result.ok) {
        failures.hit(request.ip);
        return reply.code(401).send({ error: `api key authentication failed: ${result.reason}` });
      }
      if (!perKey.hit(result.keyId)) {
        return reply.code(429).send({ error: "api key rate limit exceeded" });
      }
      request.partyId = result.partyId;
      request.stellarAccount = result.stellarAccount;
      request.authMethod = "api_key";
      return;
    }

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length);
      let stellarAccount: string;
      try {
        stellarAccount = verifySessionToken(token, config.jwtSigningSecret);
      } catch {
        return reply.code(401).send({ error: "invalid or expired token" });
      }
      const [account] = await db
        .select()
        .from(schema.partyAccount)
        .where(eq(schema.partyAccount.stellarAccount, stellarAccount))
        .limit(1);
      if (!account) {
        return reply.code(401).send({ error: "stellar account not linked to a known party" });
      }
      request.partyId = account.partyId;
      request.stellarAccount = stellarAccount;
      request.authMethod = "session";
      return;
    }

    return reply.code(401).send({ error: "missing bearer token or api key/signature" });
  };
}

export function registerAuth(app: FastifyInstance, config: ApiConfig, db: Database): void {
  app.decorateRequest("partyId", "");
  app.decorateRequest("stellarAccount", null);
  // Deviation from the task spec's literal "onRequest hook" wording: the institution HMAC check
  // needs the parsed JSON body, which isn't available yet in Fastify's `onRequest` phase (it
  // runs before body parsing). `preHandler` is the earliest phase where `request.body` exists.
  app.addHook("preHandler", buildAuthHook(config, db));
}
