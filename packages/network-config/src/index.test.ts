import { describe, expect, it } from "vitest";
import { loadNetworkConfig } from "./index.js";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const env = (over: Record<string, string>) => ({
  STELLAR_RPC_URL: "https://rpc.example",
  STELLAR_HORIZON_URL: "https://horizon.example",
  STELLAR_NETWORK_PASSPHRASE: TESTNET,
  STELLAR_NETWORK: "testnet",
  ...over,
});

describe("loadNetworkConfig", () => {
  it("accepts a name that matches its passphrase", () => {
    expect(loadNetworkConfig(env({})).network).toBe("testnet");
    expect(loadNetworkConfig(env({ STELLAR_NETWORK: "mainnet", STELLAR_NETWORK_PASSPHRASE: MAINNET })).network).toBe("mainnet");
  });

  it("refuses to sign for mainnet on a testnet passphrase, and the reverse", () => {
    expect(() => loadNetworkConfig(env({ STELLAR_NETWORK: "mainnet" }))).toThrow(/STELLAR_NETWORK=mainnet but/);
    expect(() => loadNetworkConfig(env({ STELLAR_NETWORK_PASSPHRASE: MAINNET }))).toThrow(/STELLAR_NETWORK=testnet but/);
  });

  it("refuses a local network that carries a public network's passphrase", () => {
    expect(() => loadNetworkConfig(env({ STELLAR_NETWORK: "local", STELLAR_NETWORK_PASSPHRASE: MAINNET }))).toThrow(/local/);
    expect(loadNetworkConfig(env({ STELLAR_NETWORK: "local", STELLAR_NETWORK_PASSPHRASE: "Standalone Network ; February 2017" })).network).toBe("local");
  });

  it("refuses an unknown network name instead of passing it through", () => {
    expect(() => loadNetworkConfig(env({ STELLAR_NETWORK: "futurenet" }))).toThrow(/not one of/);
  });

  it("defaults to local when unset", () => {
    const { STELLAR_NETWORK: _omit, ...rest } = env({ STELLAR_NETWORK_PASSPHRASE: "Standalone Network ; February 2017" });
    expect(loadNetworkConfig(rest).network).toBe("local");
  });

  it("lists every missing variable at once", () => {
    expect(() => loadNetworkConfig({})).toThrow(/STELLAR_RPC_URL, STELLAR_HORIZON_URL, STELLAR_NETWORK_PASSPHRASE/);
  });
});
