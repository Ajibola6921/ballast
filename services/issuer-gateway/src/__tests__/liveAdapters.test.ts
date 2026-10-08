import { afterEach, describe, expect, it, vi } from "vitest";
import { SpikoAdapter } from "../adapters/spikoAdapter.js";
import { EtherfuseAdapter } from "../adapters/etherfuseAdapter.js";
import { FranklinAdapter } from "../adapters/franklinAdapter.js";
import { getAdapter } from "../registry.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live issuer adapters: construction fails fast on missing config", () => {
  it("SpikoAdapter throws when baseUrl is empty", () => {
    expect(() => new SpikoAdapter("", "key")).toThrow(/missing required config/);
  });

  it("SpikoAdapter throws when apiKey is empty", () => {
    expect(() => new SpikoAdapter("https://api.spiko.example", "")).toThrow(/missing required config/);
  });

  it("EtherfuseAdapter and FranklinAdapter also fail fast", () => {
    expect(() => new EtherfuseAdapter("", "")).toThrow(/missing required config/);
    expect(() => new FranklinAdapter("", "")).toThrow(/missing required config/);
  });
});

describe("live issuer adapters: bespoke back-office REST calls", () => {
  it("requestAuthorization POSTs to /v1/authorizations with bearer auth and JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { approved: true, ref: "spiko-auth-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SpikoAdapter("https://api.spiko.example", "test-key");
    const result = await adapter.requestAuthorization("EUTBL", "GHOLDER");

    expect(result).toEqual({ approved: true, ref: "spiko-auth-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.spiko.example/v1/authorizations");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ assetCode: "EUTBL", holderAddress: "GHOLDER" });
  });

  it("requestLienFreeze POSTs to /v1/liens with units stringified", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { lienRef: "etherfuse-lien-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EtherfuseAdapter("https://api.etherfuse.example", "test-key");
    const result = await adapter.requestLienFreeze("CETES", "GHOLDER", 1_000_000n);

    expect(result).toEqual({ lienRef: "etherfuse-lien-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.etherfuse.example/v1/liens");
    expect(JSON.parse(init.body)).toEqual({ assetCode: "CETES", holderAddress: "GHOLDER", units: "1000000" });
  });

  it("requestLienRelease DELETEs /v1/liens/{lienRef}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new FranklinAdapter("https://api.franklin.example", "test-key");
    await adapter.requestLienRelease("BENJI", "franklin-lien-abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.franklin.example/v1/liens/franklin-lien-abc");
    expect(init.method).toBe("DELETE");
  });

  it("requestRedemption POSTs to /v1/redemptions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { redemptionRef: "franklin-redeem-1", expectedSettlementAt: 123 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new FranklinAdapter("https://api.franklin.example", "test-key");
    const result = await adapter.requestRedemption("BENJI", 500_000n, "GDEST");

    expect(result).toEqual({ redemptionRef: "franklin-redeem-1", expectedSettlementAt: 123 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.franklin.example/v1/redemptions");
    expect(JSON.parse(init.body)).toEqual({ assetCode: "BENJI", units: "500000", destination: "GDEST" });
  });

  it("throws an Error including status and body text on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("insufficient permissions", { status: 403, statusText: "Forbidden" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SpikoAdapter("https://api.spiko.example", "test-key");

    await expect(adapter.requestAuthorization("EUTBL", "GHOLDER")).rejects.toThrow(
      /403.*insufficient permissions/s,
    );
  });
});

describe("live issuer adapters: SEP-8 approval-server protocol mapping", () => {
  it("POSTs { tx } to the approval server URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: "success", tx: "AAAA" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SpikoAdapter("https://api.spiko.example", "test-key");
    await adapter.requestSep8Approval("EUTBL", "AAAA");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.spiko.example/sep8");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ tx: "AAAA" });
  });

  it("uses the configured *_SEP8_APPROVAL_SERVER_URL override instead of the {baseUrl}/sep8 fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: "success", tx: "AAAA" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SpikoAdapter(
      "https://api.spiko.example",
      "test-key",
      "https://approve.spiko.example/sep8-custom",
    );
    await adapter.requestSep8Approval("EUTBL", "AAAA");

    expect(fetchMock.mock.calls[0][0]).toBe("https://approve.spiko.example/sep8-custom");
  });

  it("maps status=success to approved:true with approvedTxXdr", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "success", tx: "TX_OK" })));
    const adapter = new SpikoAdapter("https://api.spiko.example", "test-key");

    await expect(adapter.requestSep8Approval("EUTBL", "TX_IN")).resolves.toEqual({
      approved: true,
      approvedTxXdr: "TX_OK",
    });
  });

  it("maps status=revised to approved:false with approvedTxXdr and reason=message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { status: "revised", tx: "TX_REVISED", message: "fee bumped" }),
      ),
    );
    const adapter = new EtherfuseAdapter("https://api.etherfuse.example", "test-key");

    await expect(adapter.requestSep8Approval("CETES", "TX_IN")).resolves.toEqual({
      approved: false,
      approvedTxXdr: "TX_REVISED",
      reason: "fee bumped",
    });
  });

  it("maps status=rejected to approved:false with reason=error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { status: "rejected", error: "holder not KYC'd" })),
    );
    const adapter = new FranklinAdapter("https://api.franklin.example", "test-key");

    await expect(adapter.requestSep8Approval("BENJI", "TX_IN")).resolves.toEqual({
      approved: false,
      reason: "holder not KYC'd",
    });
  });

  it("maps status=pending to approved:false with pending.retryAfterS=timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "pending", timeout: 60 })));
    const adapter = new SpikoAdapter("https://api.spiko.example", "test-key");

    await expect(adapter.requestSep8Approval("EUTBL", "TX_IN")).resolves.toEqual({
      approved: false,
      pending: { retryAfterS: 60 },
    });
  });
});

describe("registry.getAdapter", () => {
  it("constructs the requested issuer's adapter from env and resolves it by issuer code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { approved: true, ref: "r1" })));

    const env = {
      SPIKO_API_BASE_URL: "https://api.spiko.example",
      SPIKO_API_KEY: "spiko-key",
    } as unknown as NodeJS.ProcessEnv;

    const adapter = getAdapter("spiko", env);
    expect(adapter).toBeInstanceOf(SpikoAdapter);
    await expect(adapter.requestAuthorization("EUTBL", "GHOLDER")).resolves.toEqual({
      approved: true,
      ref: "r1",
    });
  });

  it("does not require other issuers to be configured", () => {
    const env = { ETHERFUSE_API_BASE_URL: "https://e.example", ETHERFUSE_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
    expect(getAdapter("etherfuse", env)).toBeInstanceOf(EtherfuseAdapter);
  });

  it("throws a clear error rather than approving when an issuer is not configured", () => {
    expect(() => getAdapter("spiko", {} as NodeJS.ProcessEnv)).toThrow(/missing required config/);
  });

  it("throws for an unknown issuer code", () => {
    expect(() => getAdapter("nobody", {} as NodeJS.ProcessEnv)).toThrow(/no adapter registered/);
  });
});
