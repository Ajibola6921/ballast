import { afterEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { SESSION_AUDIENCE, SESSION_ISSUER, signSessionToken, verifySessionToken } from "../session-token.js";
import { createFakeDb } from "./fake-db.js";

const SECRET = "test-signing-key";
const ACCOUNT = "GABCDEFTESTACCOUNT";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session tokens", () => {
  it("round-trips the account and carries iss, aud, jti and an expiry", () => {
    const token = signSessionToken(ACCOUNT, SECRET);
    expect(verifySessionToken(token, SECRET)).toBe(ACCOUNT);

    const claims = jwt.decode(token, { complete: true })!;
    expect(claims.header.alg).toBe("HS256");
    expect(claims.payload).toMatchObject({ sub: ACCOUNT, iss: SESSION_ISSUER, aud: SESSION_AUDIENCE });
    expect((claims.payload as jwt.JwtPayload).jti).toEqual(expect.any(String));
    expect((claims.payload as jwt.JwtPayload).exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("gives every token its own jti", () => {
    const a = jwt.decode(signSessionToken(ACCOUNT, SECRET)) as jwt.JwtPayload;
    const b = jwt.decode(signSessionToken(ACCOUNT, SECRET)) as jwt.JwtPayload;
    expect(a.jti).not.toBe(b.jti);
  });

  it("rejects a token signed with another HMAC algorithm even under the right secret", () => {
    const token = jwt.sign({}, SECRET, {
      algorithm: "HS512",
      subject: ACCOUNT,
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    expect(() => verifySessionToken(token, SECRET)).toThrow();
  });

  it("rejects an unsigned (alg none) token", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: ACCOUNT, iss: SESSION_ISSUER, aud: SESSION_AUDIENCE })}.`;
    expect(() => verifySessionToken(token, SECRET)).toThrow();
  });

  it("rejects tokens with the wrong issuer or audience, or none", () => {
    const base = { algorithm: "HS256" as const, subject: ACCOUNT };
    expect(() => verifySessionToken(jwt.sign({}, SECRET, base), SECRET)).toThrow();
    expect(() =>
      verifySessionToken(jwt.sign({}, SECRET, { ...base, issuer: "someone-else", audience: SESSION_AUDIENCE }), SECRET),
    ).toThrow();
    expect(() =>
      verifySessionToken(jwt.sign({}, SECRET, { ...base, issuer: SESSION_ISSUER, audience: "other-service" }), SECRET),
    ).toThrow();
  });

  it("rejects an expired token", () => {
    const token = jwt.sign({}, SECRET, {
      algorithm: "HS256",
      subject: ACCOUNT,
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      expiresIn: -10,
    });
    expect(() => verifySessionToken(token, SECRET)).toThrow(/expired/);
  });
});

describe("dev-login in production", () => {
  const config: ApiConfig = {
    port: 0,
    jwtSigningSecret: SECRET,
    sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sep10HomeDomain: "localhost",
    sep10WebAuthDomain: "localhost",
    networkPassphrase: "Test SDF Network ; September 2015",
    webhookSecretKey: "00".repeat(32),
    apiKeySecretKey: "00".repeat(32),
    consoleOrigin: "http://localhost:5173",
  };

  it("refuses to start with ENABLE_DEV_LOGIN=true", () => {
    vi.stubEnv("ENABLE_DEV_LOGIN", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => buildServer({ config, db: createFakeDb(new Map()), contracts: {} as ContractClients })).toThrow(
      /dev-login/,
    );
  });
});
