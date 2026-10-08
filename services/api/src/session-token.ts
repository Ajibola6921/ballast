/**
 * The one place this service mints and verifies its own session JWTs, so the algorithm and claims
 * can't drift between the SEP-10 route, the dev-login route and the auth hook.
 *
 * The algorithm is pinned on both sides: `jsonwebtoken` otherwise accepts whatever `alg` the token
 * header names for a symmetric secret (HS256/384/512), and a token's own header must never choose
 * how it is checked. `iss` and `aud` bind a token to this service, and `jti` makes each token
 * individually identifiable (for logs now, and for a revocation list later).
 */
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

export const SESSION_ALGORITHM = "HS256" as const;
export const SESSION_ISSUER = "ballast-api";
export const SESSION_AUDIENCE = "ballast-api";
const SESSION_TTL = "12h";

export function signSessionToken(stellarAccount: string, secret: string): string {
  return jwt.sign({}, secret, {
    algorithm: SESSION_ALGORITHM,
    subject: stellarAccount,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
    jwtid: randomUUID(),
    expiresIn: SESSION_TTL,
  });
}

/** Returns the Stellar account the token was issued to; throws if the token is invalid in any way. */
export function verifySessionToken(token: string, secret: string): string {
  const decoded = jwt.verify(token, secret, {
    algorithms: [SESSION_ALGORITHM],
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  });
  if (typeof decoded === "string" || !decoded.sub) throw new Error("token has no sub claim");
  return decoded.sub;
}
