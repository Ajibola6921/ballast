import { describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { KmsEnvelopeSigner } from "../kmsEnvelopeSigner.js";
import { createOperatorSigner } from "../factory.js";
import { VaultAuth, vaultFetch } from "../vaultClient.js";
import { VaultTransitSigner } from "../vaultTransitSigner.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const ADDR = "https://vault.example";

const login = (token: string, lease = 3600, renewable = true) =>
  new Response(JSON.stringify({ auth: { client_token: token, lease_duration: lease, renewable } }));

/** A fetch whose answers are decided per URL, recording every call. */
function router(handlers: Record<string, (init: RequestInit, n: number) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const counts: Record<string, number> = {};
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace(ADDR, "");
    calls.push({ url: path, init });
    counts[path] = (counts[path] ?? 0) + 1;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected request ${path}`);
    return handler(init, counts[path]);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const tokenOf = (init: RequestInit) => (init.headers as Record<string, string>)["X-Vault-Token"];

describe("VaultAuth", () => {
  it("logs in with AppRole on first use and sends that token", async () => {
    const { fetchImpl, calls } = router({ "/v1/auth/approle/login": () => login("tok-1") });
    const auth = new VaultAuth({ vaultAddr: ADDR, roleId: "r", secretId: "s", fetchImpl });

    const headers = await auth.authHeaders();

    expect(headers["X-Vault-Token"]).toBe("tok-1");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ role_id: "r", secret_id: "s" });
  });

  it("renews the token once two thirds of the lease has passed, and not before", async () => {
    let now = 0;
    const { fetchImpl, calls } = router({
      "/v1/auth/approle/login": () => login("tok-1", 900),
      "/v1/auth/token/renew-self": (init) => (tokenOf(init) === "tok-1" ? login("tok-1", 900) : new Response("no", { status: 403 })),
    });
    const auth = new VaultAuth({ vaultAddr: ADDR, roleId: "r", secretId: "s", fetchImpl, now: () => now });

    await auth.authHeaders();
    now = 599_000; // just inside 2/3 of 900s
    await auth.authHeaders();
    expect(calls.map((c) => c.url)).toEqual(["/v1/auth/approle/login"]);

    now = 601_000;
    await auth.authHeaders();
    expect(calls.map((c) => c.url)).toEqual(["/v1/auth/approle/login", "/v1/auth/token/renew-self"]);
  });

  it("falls back to a fresh login when renewal is refused", async () => {
    let now = 0;
    let logins = 0;
    const { fetchImpl } = router({
      "/v1/auth/approle/login": () => login(`tok-${++logins}`, 900),
      "/v1/auth/token/renew-self": () => new Response("expired", { status: 403 }),
    });
    const auth = new VaultAuth({ vaultAddr: ADDR, roleId: "r", secretId: "s", fetchImpl, now: () => now });

    await auth.authHeaders();
    now = 700_000;

    expect((await auth.authHeaders())["X-Vault-Token"]).toBe("tok-2");
  });

  it("shares one login between concurrent callers", async () => {
    const { fetchImpl, calls } = router({ "/v1/auth/approle/login": () => login("tok-1") });
    const auth = new VaultAuth({ vaultAddr: ADDR, roleId: "r", secretId: "s", fetchImpl });

    await Promise.all([auth.authHeaders(), auth.authHeaders(), auth.authHeaders()]);

    expect(calls).toHaveLength(1);
  });

  it("sends the namespace header when one is configured", async () => {
    const { fetchImpl } = router({});
    const auth = new VaultAuth({ vaultAddr: ADDR, token: "t", namespace: "ballast", fetchImpl });
    expect((await auth.authHeaders())["X-Vault-Namespace"]).toBe("ballast");
  });

  it("refuses to be built with no credentials at all", () => {
    expect(() => new VaultAuth({ vaultAddr: ADDR })).toThrow(/token or an AppRole/);
  });

  it("reports a failed login with Vault's status", async () => {
    const { fetchImpl } = router({ "/v1/auth/approle/login": () => new Response("invalid secret id", { status: 400 }) });
    const auth = new VaultAuth({ vaultAddr: ADDR, roleId: "r", secretId: "bad", fetchImpl });
    await expect(auth.authHeaders()).rejects.toThrow(/AppRole login failed: 400/);
  });
});

describe("vaultFetch", () => {
  const staticAuth = (fetchImpl: typeof fetch) => new VaultAuth({ vaultAddr: ADDR, token: "t", fetchImpl });

  it("retries a 503 and a dropped connection, then succeeds", async () => {
    let n = 0;
    const { fetchImpl } = router({
      "/v1/x": () => {
        n++;
        if (n === 1) return new Response("unavailable", { status: 503 });
        if (n === 2) throw new Error("ECONNRESET");
        return new Response("ok");
      },
    });
    const res = await vaultFetch(staticAuth(fetchImpl), "/v1/x", {}, fetchImpl, { retryDelayMs: 1 });
    expect(await res.text()).toBe("ok");
    expect(n).toBe(3);
  });

  it("after three attempts hands back the last response so the caller can report Vault's own error", async () => {
    const { fetchImpl, calls } = router({ "/v1/x": () => new Response("storage backend down", { status: 500 }) });
    const res = await vaultFetch(staticAuth(fetchImpl), "/v1/x", {}, fetchImpl, { retryDelayMs: 1 });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("storage backend down");
    expect(calls).toHaveLength(3);
  });

  it("throws once every attempt has failed to connect", async () => {
    const { fetchImpl, calls } = router({ "/v1/x": () => { throw new Error("ECONNREFUSED"); } });
    await expect(vaultFetch(staticAuth(fetchImpl), "/v1/x", {}, fetchImpl, { retryDelayMs: 1 })).rejects.toThrow(
      /failed after 3 attempts.*ECONNREFUSED/,
    );
    expect(calls).toHaveLength(3);
  });

  it("does not retry a client error such as a missing key", async () => {
    const { fetchImpl, calls } = router({ "/v1/x": () => new Response("no such key", { status: 404 }) });
    const res = await vaultFetch(staticAuth(fetchImpl), "/v1/x", {}, fetchImpl, { retryDelayMs: 1 });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("sets a timeout signal on every request", async () => {
    const { fetchImpl, calls } = router({ "/v1/x": () => new Response("ok") });
    await vaultFetch(staticAuth(fetchImpl), "/v1/x", {}, fetchImpl);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("logs in again and retries once when Vault rejects the token (AppRole)", async () => {
    let logins = 0;
    const { fetchImpl, calls } = router({
      "/v1/auth/approle/login": () => login(`tok-${++logins}`),
      "/v1/x": (init) => (tokenOf(init) === "tok-1" ? new Response("permission denied", { status: 403 }) : new Response("ok")),
    });
    const auth = new VaultAuth({ vaultAddr: ADDR, roleId: "r", secretId: "s", fetchImpl });

    const res = await vaultFetch(auth, "/v1/x", {}, fetchImpl, { retryDelayMs: 1 });

    expect(await res.text()).toBe("ok");
    expect(logins).toBe(2);
    expect(calls.filter((c) => c.url === "/v1/x").map((c) => tokenOf(c.init))).toEqual(["tok-1", "tok-2"]);
  });

  it("surfaces a 403 for a static token, which cannot be refreshed", async () => {
    const { fetchImpl, calls } = router({ "/v1/x": () => new Response("permission denied", { status: 403 }) });
    const res = await vaultFetch(staticAuth(fetchImpl), "/v1/x", {}, fetchImpl, { retryDelayMs: 1 });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

describe("VaultTransitSigner", () => {
  const publicKeyB64 = (kp: Keypair) => Buffer.from(StrKey.decodeEd25519PublicKey(kp.publicKey())).toString("base64");
  const keyResponse = (kp: Keypair) =>
    new Response(JSON.stringify({ data: { latest_version: 1, keys: { "1": { public_key: publicKeyB64(kp) } } } }));

  it("signs with an AppRole-issued token end to end", async () => {
    const kp = Keypair.random();
    const message = Buffer.from("USTRY:1791447179:10764250");
    const { fetchImpl, calls } = router({
      "/v1/auth/approle/login": () => login("tok-1"),
      "/v1/transit/keys/pp": () => keyResponse(kp),
      "/v1/transit/sign/pp": () => new Response(JSON.stringify({ data: { signature: `vault:v1:${Buffer.from(kp.sign(message)).toString("base64")}` } })),
    });
    const signer = new VaultTransitSigner({ vaultAddr: ADDR, roleId: "r", secretId: "s", keyName: "pp", networkPassphrase: PASSPHRASE, fetchImpl, retryDelayMs: 1 });

    const sig = await signer.signMessage(message);

    expect(kp.verify(message, sig)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["/v1/auth/approle/login", "/v1/transit/keys/pp", "/v1/transit/sign/pp"]);
  });

  it("refuses a signature that does not verify against the key's public key", async () => {
    const kp = Keypair.random();
    const wrong = Keypair.random();
    const message = Buffer.from("USTRY:1:1");
    const { fetchImpl } = router({
      "/v1/transit/keys/pp": () => keyResponse(kp),
      "/v1/transit/sign/pp": () => new Response(JSON.stringify({ data: { signature: `vault:v1:${Buffer.from(wrong.sign(message)).toString("base64")}` } })),
    });
    const signer = new VaultTransitSigner({ vaultAddr: ADDR, vaultToken: "t", keyName: "pp", networkPassphrase: PASSPHRASE, fetchImpl, retryDelayMs: 1 });

    await expect(signer.signMessage(message)).rejects.toThrow(/does not verify/);
  });
});

describe("KmsEnvelopeSigner", () => {
  it("signs with the unwrapped key and zeroes the plaintext KMS returned", async () => {
    const kp = Keypair.random();
    const plaintext = new Uint8Array(Buffer.from(kp.secret(), "utf8"));
    const kmsClient = { send: vi.fn(async () => ({ Plaintext: plaintext })), destroy: vi.fn() };

    const signer = await KmsEnvelopeSigner.create({
      awsRegion: "eu-west-1", kmsKeyId: "alias/ballast", wrappedSecretBase64: "AAAA", networkPassphrase: PASSPHRASE,
      kmsClient: kmsClient as never,
    });

    expect(signer.publicKey()).toBe(kp.publicKey());
    expect(kp.verify(Buffer.from("m"), await signer.signMessage(Buffer.from("m")))).toBe(true);
    expect(plaintext.every((b) => b === 0)).toBe(true);
  });

  it("fails clearly when KMS returns nothing", async () => {
    const kmsClient = { send: vi.fn(async () => ({})), destroy: vi.fn() };
    await expect(
      KmsEnvelopeSigner.create({ awsRegion: "r", kmsKeyId: "k", wrappedSecretBase64: "AAAA", networkPassphrase: PASSPHRASE, kmsClient: kmsClient as never }),
    ).rejects.toThrow(/returned no plaintext/);
  });
});

describe("createOperatorSigner", () => {
  it("rejects an unknown mode and a vault mode with no credentials", async () => {
    await expect(createOperatorSigner("keeper", PASSPHRASE, { KEEPER_SIGNER_MODE: "hsm" })).rejects.toThrow(/unknown KEEPER_SIGNER_MODE/);
    await expect(
      createOperatorSigner("keeper", PASSPHRASE, { KEEPER_SIGNER_MODE: "vault", VAULT_ADDR: ADDR, KEEPER_VAULT_KEY_NAME: "k" }),
    ).rejects.toThrow(/VAULT_TOKEN/);
  });

  it("refuses the raw-secret local mode in production", async () => {
    const kp = Keypair.random();
    await expect(
      createOperatorSigner("keeper", PASSPHRASE, { NODE_ENV: "production", KEEPER_SECRET_KEY: kp.secret() }),
    ).rejects.toThrow(/refused when NODE_ENV=production/);
  });

  it("uses AppRole when role credentials are set, and needs a token otherwise", async () => {
    const env = { KEEPER_SIGNER_MODE: "vault", VAULT_ADDR: ADDR, KEEPER_VAULT_KEY_NAME: "k" };
    // With AppRole configured the factory goes to Vault to log in (unreachable here), not to a missing-token error.
    await expect(
      createOperatorSigner("keeper", PASSPHRASE, { ...env, VAULT_ROLE_ID: "r", VAULT_SECRET_ID: "s", VAULT_ADDR: "http://127.0.0.1:1" }),
    ).rejects.not.toThrow(/VAULT_TOKEN/);
  });

  it("builds a local signer by default, from the role's secret", async () => {
    const kp = Keypair.random();
    const signer = await createOperatorSigner("price-publisher", PASSPHRASE, { PRICE_PUBLISHER_SECRET_KEY: kp.secret() });
    expect(signer.publicKey()).toBe(kp.publicKey());
  });
});
