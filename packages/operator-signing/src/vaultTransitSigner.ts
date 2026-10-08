/**
 * KmsSigner backed by HashiCorp Vault's Transit secrets engine (PRD §11's KMS seam). The
 * operator's Ed25519 private key never leaves Vault and is never read into this process: this
 * class only ever sends the transaction's 32-byte signature-base hash to Vault's
 * `/transit/sign/{key_name}` endpoint and gets a detached signature back.
 *
 * Configured via the shared `VAULT_ADDR` + `VAULT_TOKEN` env vars and a per-role
 * `${ROLE_ENV_PREFIX}_VAULT_KEY_NAME` naming the Transit key (see `factory.ts`).
 */
import { Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { KmsSigner } from "./types.js";
import { VaultAuth, vaultFetch } from "./vaultClient.js";

interface VaultTransitKeyResponse {
  data: {
    latest_version: number;
    keys: Record<string, { public_key: string }>;
  };
}

interface VaultTransitSignResponse {
  data: {
    signature: string;
  };
}

export interface VaultTransitSignerOptions {
  vaultAddr: string;
  /** A pre-issued token (never renewed). Prefer AppRole credentials for a long-running service. */
  vaultToken?: string;
  /** AppRole credentials; the signer logs in, renews the token and logs in again if it is rejected. */
  roleId?: string;
  secretId?: string;
  namespace?: string;
  keyName: string;
  networkPassphrase: string;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Base delay between retries; overridable for tests. */
  retryDelayMs?: number;
}

/** Vault Transit signatures come back as `"vault:v<version>:<base64>"` — strip that prefix. */
function stripVaultSignaturePrefix(signature: string): string {
  const match = /^vault:v\d+:(.+)$/.exec(signature);
  if (!match) {
    throw new Error(`operator-signing: unexpected Vault Transit signature format: "${signature}"`);
  }
  return match[1];
}

export class VaultTransitSigner implements KmsSigner {
  private readonly auth: VaultAuth;
  private readonly retryDelayMs: number | undefined;
  private readonly keyName: string;
  private readonly networkPassphrase: string;
  private readonly fetchImpl: typeof fetch;
  private cachedPublicKey: string | undefined;

  constructor(options: VaultTransitSignerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs;
    this.auth = new VaultAuth({
      vaultAddr: options.vaultAddr,
      token: options.vaultToken,
      roleId: options.roleId,
      secretId: options.secretId,
      namespace: options.namespace,
      fetchImpl: this.fetchImpl,
    });
    this.keyName = options.keyName;
    this.networkPassphrase = options.networkPassphrase;
  }

  /**
   * Fetches and caches the Transit key's public key, converted to a Stellar G-address.
   * `createOperatorSigner()` awaits this once at startup so `publicKey()` can stay synchronous
   * (matching the `KmsSigner` interface) for the rest of this signer's lifetime.
   */
  async resolvePublicKey(): Promise<string> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }
    const res = await this.call(`/v1/transit/keys/${this.keyName}`);
    if (!res.ok) {
      throw new Error(
        `operator-signing: Vault Transit key lookup failed for "${this.keyName}": ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as VaultTransitKeyResponse;
    const latest = body.data.keys[String(body.data.latest_version)];
    if (!latest?.public_key) {
      throw new Error(
        `operator-signing: Vault Transit key "${this.keyName}" has no public key at its latest version (${body.data.latest_version})`,
      );
    }
    const rawPublicKey = Buffer.from(latest.public_key, "base64");
    this.cachedPublicKey = StrKey.encodeEd25519PublicKey(rawPublicKey);
    return this.cachedPublicKey;
  }

  publicKey(): string {
    if (!this.cachedPublicKey) {
      throw new Error(
        "operator-signing: VaultTransitSigner.publicKey() called before resolvePublicKey() — " +
          "createOperatorSigner() resolves it for you, so this only happens if VaultTransitSigner is constructed directly.",
      );
    }
    return this.cachedPublicKey;
  }

  private call(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    return vaultFetch(this.auth, path, init, this.fetchImpl, { retryDelayMs: this.retryDelayMs });
  }

  /** Posts `input` (raw bytes) to Vault Transit and returns the detached signature, base64. */
  private async transitSign(input: Uint8Array): Promise<string> {
    const res = await this.call(`/v1/transit/sign/${this.keyName}`, {
      method: "POST",
      body: JSON.stringify({ input: Buffer.from(input).toString("base64") }),
    });
    if (!res.ok) {
      throw new Error(
        `operator-signing: Vault Transit sign failed for "${this.keyName}": ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as VaultTransitSignResponse;
    return stripVaultSignaturePrefix(body.data.signature);
  }

  /**
   * Checks a signature Vault returned against the public key this signer reports. A mismatch
   * (a rotated key, the wrong key name, a corrupted response) would otherwise surface only as an
   * on-chain rejection after the transaction was already sent.
   */
  private verified(message: Uint8Array, signatureBase64: string): Buffer {
    const signature = Buffer.from(signatureBase64, "base64");
    if (!Keypair.fromPublicKey(this.publicKey()).verify(Buffer.from(message), signature)) {
      throw new Error(
        `operator-signing: Vault Transit key "${this.keyName}" returned a signature that does not verify against ${this.publicKey()}`,
      );
    }
    return signature;
  }

  async sign(unsignedXdr: string): Promise<string> {
    const publicKey = await this.resolvePublicKey();
    const tx = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    const hash = tx.hash();
    tx.addSignature(publicKey, this.verified(hash, await this.transitSign(hash)).toString("base64"));
    return tx.toXDR();
  }

  async signMessage(message: Uint8Array): Promise<Buffer> {
    await this.resolvePublicKey();
    return this.verified(message, await this.transitSign(message));
  }
}
