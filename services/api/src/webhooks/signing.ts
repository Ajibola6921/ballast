/**
 * Delivery signatures. The header is `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`.
 * Signing the timestamp together with the body lets a subscriber reject a captured request that is
 * replayed later: verify the HMAC, then check `t` is within a few minutes of now.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_S = 300;

export function signWebhook(secret: string, timestampS: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampS}.${body}`).digest("hex");
  return `t=${timestampS},v1=${mac}`;
}

/** What a subscriber runs on receipt. Exported here so the docs and tests share one definition. */
export function verifyWebhook(secret: string, header: string, body: string, nowS: number): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(signWebhook(secret, t, body).split("v1=")[1], "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
