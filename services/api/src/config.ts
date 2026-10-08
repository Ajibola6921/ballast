/**
 * Env-var driven config for services/api. Kept in one place so the rest of the service reads
 * typed config instead of `process.env` directly (mirrors the pattern in
 * `@ballast/network-config`).
 */
import { loadNetworkConfig } from "@ballast/network-config";

export interface ApiConfig {
  port: number;
  /** HMAC secret used to sign/verify the app's own session JWTs (`{ sub: G-address }`). Not a
   * SEP-10 signing key — SEP-10 challenge transactions are signed by `sep10ServerSecret`, a real
   * Stellar keypair, per `routes/auth.ts`. */
  jwtSigningSecret: string;
  /** Real Stellar keypair secret (`S...`) the SEP-10 challenge transactions are built/signed
   * with. Distinct from `jwtSigningSecret` on purpose — one authenticates Stellar accounts via
   * SEP-10, the other signs this app's own session tokens. */
  sep10ServerSecret: string;
  /** Fully qualified domain name of the service requiring authentication (SEP-10 `home_domain`). */
  sep10HomeDomain: string;
  /** Fully qualified domain name of the service issuing the challenge (SEP-10 `web_auth_domain`). */
  sep10WebAuthDomain: string;
  /** Stellar network passphrase, needed to build/verify SEP-10 challenge transactions. Sourced
   * through `@ballast/network-config` so it stays in sync with the rest of the service's Stellar
   * config instead of being a second, independently-configured copy. */
  networkPassphrase: string;
  /** 32-byte key (64 hex chars) that encrypts webhook signing secrets at rest. Webhook
   * subscriptions are refused (503) while it is unset. */
  webhookSecretKey: string;
  /** 32-byte key (64 hex chars) that encrypts institution API-key signing secrets at rest. API
   * keys cannot be created or used while it is unset. */
  apiKeySecretKey: string;
  /** Origin allowed to call this API from a browser (the console app). Passed straight to
   * `@fastify/cors`'s `origin` option — never `*`. */
  consoleOrigin: string;
}

/**
 * Secrets that must be real, non-empty values before this service is safe to run in production.
 * Left unset, they're fine in dev/test (`buildServer()`'s injectable `config` option already lets
 * tests bypass this function entirely) but would otherwise let the service boot with a blank JWT
 * secret, a blank SEP-10 signing key, a blank webhook secret key, or a wide-open CORS origin.
 * Mirrors the `REQUIRED` + `.filter` + one combined thrown-error-message pattern in
 * `packages/network-config/src/index.ts`.
 */
const PRODUCTION_REQUIRED = [
  "SEP10_SERVER_SECRET",
  "JWT_SIGNING_SECRET",
  "WEBHOOK_SECRET_KEY",
  "API_KEY_SECRET_KEY",
  "CONSOLE_ORIGIN",
] as const;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  if (env.NODE_ENV === "production") {
    const missing = PRODUCTION_REQUIRED.filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(`services/api: missing required env vars in production: ${missing.join(", ")}`);
    }
  }

  for (const name of ["WEBHOOK_SECRET_KEY", "API_KEY_SECRET_KEY"] as const) {
    if (env[name] && !/^[0-9a-fA-F]{64}$/.test(env[name]!)) {
      throw new Error(`services/api: ${name} must be 32 bytes as 64 hex characters`);
    }
  }

  return {
    port: env.API_PORT ? Number(env.API_PORT) : 3000,
    jwtSigningSecret: env.JWT_SIGNING_SECRET ?? "",
    sep10ServerSecret: env.SEP10_SERVER_SECRET ?? "",
    sep10HomeDomain: env.SEP10_HOME_DOMAIN ?? "localhost",
    sep10WebAuthDomain: env.SEP10_WEB_AUTH_DOMAIN ?? env.SEP10_HOME_DOMAIN ?? "localhost",
    networkPassphrase: loadNetworkConfig(env).networkPassphrase,
    webhookSecretKey: env.WEBHOOK_SECRET_KEY ?? "",
    apiKeySecretKey: env.API_KEY_SECRET_KEY ?? "",
    consoleOrigin: env.CONSOLE_ORIGIN ?? "http://localhost:5173",
  };
}
