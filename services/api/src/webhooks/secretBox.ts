/**
 * AES-256-GCM for the per-subscription signing secrets stored in `webhook_subscription`. The
 * secret has to be recoverable (it signs every delivery), so it can't be hashed; encrypting it
 * with a key that lives only in the API's environment keeps a leaked database dump from handing
 * out working signing secrets.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_HEX = /^[0-9a-fA-F]{64}$/;

export function isValidSecretKey(keyHex: string): boolean {
  return KEY_HEX.test(keyHex);
}

function keyBuffer(keyHex: string): Buffer {
  if (!isValidSecretKey(keyHex)) throw new Error("WEBHOOK_SECRET_KEY must be 32 bytes as 64 hex characters");
  return Buffer.from(keyHex, "hex");
}

/** Returns `iv.tag.ciphertext`, each base64. */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(boxed: string, keyHex: string): string {
  const [iv, tag, ciphertext] = boxed.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ciphertext) throw new Error("malformed webhook secret");
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
