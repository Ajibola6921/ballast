/**
 * Ballast never holds customer signing keys (PRD §9). The keeper, price publisher and payout hop
 * are the narrow exceptions — operator keys that in production resolve through a KMS (PRD §6.6,
 * §11). `KmsSigner` is that seam: every operator-signing implementation (local dev, HashiCorp
 * Vault Transit, AWS KMS envelope) implements it, and callers depend on nothing but this
 * interface, so swapping the implementation never touches call sites.
 */
export interface KmsSigner {
  /** Returns the operator's Stellar public key (G...), used as the tx source/caller address. */
  publicKey(): string;
  /** Signs an unsigned XDR envelope and returns the signed XDR. */
  sign(unsignedXdr: string): Promise<string>;
  /**
   * Returns a detached 64-byte Ed25519 signature over `message` made with the same operator key.
   * Used by price-guard's NAV relay: the on-chain `PriceGuard.publish_nav` verifies this key's
   * signature over the canonical NAV message (see `services/price-guard/src/navSignature.ts`).
   */
  signMessage(message: Uint8Array): Promise<Buffer>;
}

export interface SubmitResult {
  hash: string;
  status: string;
}
