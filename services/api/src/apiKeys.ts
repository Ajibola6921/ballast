/**
 * Institution API-key auth (PRD §9: "API key + HMAC for institutions").
 *
 * A request carries `x-api-key` (the public key id), `x-timestamp` (unix seconds), `x-nonce`
 * (single use) and `x-signature`: hex HMAC-SHA256, under the key's secret, of
 *
 *   v1 \n <timestamp> \n <nonce> \n <METHOD> \n <path and query as sent> \n <sha256 hex of raw body>
 *
 * The method, path and query are signed so a captured signature cannot be reused on another
 * endpoint, and the raw body bytes are hashed (not a re-serialised copy) so any byte change breaks
 * it. The timestamp bounds the replay window; the nonce, remembered in `api_key_nonce`, closes it.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { decryptSecret } from "./webhooks/secretBox.js";

export const TIMESTAMP_TOLERANCE_S = 300;
/** Nonces are kept longer than the tolerance window, so none can be reused while still valid. */
export const NONCE_RETENTION_S = 2 * TIMESTAMP_TOLERANCE_S;
const NONCE_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;

export function newKeyId(): string {
  return `bk_${randomBytes(16).toString("hex")}`;
}

export function newKeySecret(): string {
  return randomBytes(32).toString("hex");
}

export function canonicalRequest(args: {
  timestamp: string;
  nonce: string;
  method: string;
  url: string;
  rawBody: Buffer | string;
}): string {
  const bodyHash = createHash("sha256").update(args.rawBody).digest("hex");
  return ["v1", args.timestamp, args.nonce, args.method.toUpperCase(), args.url, bodyHash].join("\n");
}

/** What a client runs to sign a request. Exported so tests and client docs share one definition. */
export function signRequest(secret: string, args: Parameters<typeof canonicalRequest>[0]): string {
  return createHmac("sha256", secret).update(canonicalRequest(args)).digest("hex");
}

export type ApiKeyFailure =
  | "unknown_key"
  | "revoked"
  | "bad_timestamp"
  | "stale_timestamp"
  | "bad_nonce"
  | "bad_signature"
  | "replayed";

export type ApiKeyResult =
  | { ok: true; partyId: string; stellarAccount: string; keyId: string }
  | { ok: false; reason: ApiKeyFailure };

export interface SignedRequest {
  keyId: string;
  signature: string;
  timestamp: string | undefined;
  nonce: string | undefined;
  method: string;
  url: string;
  rawBody: Buffer;
}

export async function verifyApiKeyRequest(
  db: Database,
  secretKey: string,
  req: SignedRequest,
  nowMs: number = Date.now(),
): Promise<ApiKeyResult> {
  const [key] = await db
    .select()
    .from(schema.partyApiKey)
    .where(eq(schema.partyApiKey.keyId, req.keyId))
    .limit(1);
  if (!key) return { ok: false, reason: "unknown_key" };
  if (key.status !== "active") return { ok: false, reason: "revoked" };

  if (typeof req.timestamp !== "string" || !/^\d+$/.test(req.timestamp)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowMs / 1000 - Number(req.timestamp)) > TIMESTAMP_TOLERANCE_S) return { ok: false, reason: "stale_timestamp" };
  if (typeof req.nonce !== "string" || !NONCE_FORMAT.test(req.nonce)) return { ok: false, reason: "bad_nonce" };

  const expected = Buffer.from(
    signRequest(decryptSecret(key.secretCiphertext, secretKey), {
      timestamp: req.timestamp,
      nonce: req.nonce,
      method: req.method,
      url: req.url,
      rawBody: req.rawBody,
    }),
    "hex",
  );
  const given = Buffer.from(req.signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };

  // Only a correctly signed request may use up a nonce, so an attacker cannot burn a victim's.
  const fresh = await db
    .insert(schema.apiKeyNonce)
    .values({ keyId: key.keyId, nonce: req.nonce })
    .onConflictDoNothing()
    .returning({ nonce: schema.apiKeyNonce.nonce });
  if (fresh.length === 0) return { ok: false, reason: "replayed" };

  await db
    .update(schema.partyApiKey)
    .set({ lastUsedAt: new Date(nowMs) })
    .where(eq(schema.partyApiKey.id, key.id));
  return { ok: true, partyId: key.partyId, stellarAccount: key.stellarAccount, keyId: key.keyId };
}

export async function purgeExpiredNonces(db: Database, nowMs: number = Date.now()): Promise<void> {
  await db
    .delete(schema.apiKeyNonce)
    .where(lt(schema.apiKeyNonce.createdAt, new Date(nowMs - NONCE_RETENTION_S * 1000)));
}

/** Fixed-window counter, in memory (per API instance). */
export class RateWindow {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; false once `key` has exceeded the limit in the current window. */
  hit(key: string, nowMs: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(nowMs);
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  /** Hits recorded for `key` in the current window, without recording another. */
  count(key: string, nowMs: number = Date.now()): number {
    const entry = this.hits.get(key);
    return entry && entry.resetAt > nowMs ? entry.count : 0;
  }

  private sweep(nowMs: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= nowMs) this.hits.delete(k);
  }
}

