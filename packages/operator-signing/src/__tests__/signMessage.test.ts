import { describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { createRawSecretSigner } from "../localDevSigner.js";
import { VaultTransitSigner } from "../vaultTransitSigner.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

describe("signMessage", () => {
  it("local signer produces an Ed25519 signature the public key verifies", async () => {
    const keypair = Keypair.random();
    const signer = createRawSecretSigner(keypair.secret(), PASSPHRASE);
    const message = Buffer.from("CETES:1791447179:657660");

    const sig = await signer.signMessage(message);

    expect(sig).toHaveLength(64);
    expect(keypair.verify(message, sig)).toBe(true);
    expect(keypair.verify(Buffer.from("CETES:1791447179:657661"), sig)).toBe(false);
  });

  it("vault signer posts the raw message (not a hash) to Transit and returns the decoded signature", async () => {
    const keypair = Keypair.random();
    const message = Buffer.from("CETES:1791447179:657660");
    const signature = Buffer.from(keypair.sign(message));

    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/v1/transit/keys/price-publisher")) {
        return new Response(
          JSON.stringify({
            data: { latest_version: 1, keys: { "1": { public_key: Buffer.from(StrKey.decodeEd25519PublicKey(keypair.publicKey())).toString("base64") } } },
          }),
        );
      }
      expect(JSON.parse(init!.body!).input).toBe(message.toString("base64"));
      return new Response(JSON.stringify({ data: { signature: `vault:v1:${signature.toString("base64")}` } }));
    }) as unknown as typeof fetch;

    const signer = new VaultTransitSigner({
      vaultAddr: "https://vault.example",
      vaultToken: "t",
      keyName: "price-publisher",
      networkPassphrase: PASSPHRASE,
      fetchImpl,
    });

    const sig = await signer.signMessage(message);

    expect(sig.equals(signature)).toBe(true);
    expect(keypair.verify(message, sig)).toBe(true);
  });

  it("vault signer surfaces a Transit failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const signer = new VaultTransitSigner({
      vaultAddr: "https://vault.example",
      vaultToken: "t",
      keyName: "k",
      networkPassphrase: PASSPHRASE,
      fetchImpl,
    });
    await expect(signer.signMessage(Buffer.from("x"))).rejects.toThrow(/403/);
  });
});
