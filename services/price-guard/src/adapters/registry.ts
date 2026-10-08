/**
 * Resolves this service's two adapter kinds (`IndependentFeedAdapter`, `IssuerNavAdapter`). There
 * is no mock mode: every adapter reads a real source. An unknown issuer code throws; an issuer
 * with no NAV API (Franklin) returns `undefined`, so its assets are priced from the independent
 * feed alone and the on-chain guard reports them `Degraded` rather than being fed a made-up NAV.
 */
import type { IndependentFeedAdapter, IssuerNavAdapter } from "./types.js";
import { RedstoneAdapter, loadRedstoneFeedContractIds } from "./redstoneAdapter.js";
import { SpikoNavAdapter } from "./spikoNavAdapter.js";
import { EtherfuseNavAdapter } from "./etherfuseNavAdapter.js";

/**
 * `ISSUER_NAV_SYMBOLS` — JSON map `assetCode -> issuer symbol`, for assets whose on-chain code is
 * not the symbol the issuer's API uses. A testnet token `RWA1` priced like Etherfuse's real USTRY
 * bond is `{"RWA1":"USTRY"}`. Unmapped assets use their own code.
 */
export function loadIssuerNavSymbols(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.ISSUER_NAV_SYMBOLS) return {};
  try {
    return JSON.parse(env.ISSUER_NAV_SYMBOLS);
  } catch {
    throw new Error("price-guard: ISSUER_NAV_SYMBOLS is not valid JSON");
  }
}

function withSymbols(adapter: IssuerNavAdapter, symbols: Record<string, string>): IssuerNavAdapter {
  return { fetchNav: (assetCode) => adapter.fetchNav(symbols[assetCode] ?? assetCode) };
}

/** Issuer codes with no machine-readable NAV source we can call. */
const NO_NAV_API = new Set(["franklin"]);

export function getIssuerNavAdapter(
  issuerCode: string,
  env: NodeJS.ProcessEnv = process.env,
): IssuerNavAdapter | undefined {
  const code = issuerCode.toLowerCase();
  if (NO_NAV_API.has(code)) {
    return undefined;
  }
  const symbols = loadIssuerNavSymbols(env);
  switch (code) {
    case "spiko":
      return withSymbols(new SpikoNavAdapter(env.SPIKO_NAV_API_BASE_URL || undefined), symbols);
    case "etherfuse":
      return withSymbols(new EtherfuseNavAdapter(env.ETHERFUSE_NAV_API_BASE_URL || undefined), symbols);
    default:
      throw new Error(`price-guard: no issuer NAV adapter for issuer code "${issuerCode}"`);
  }
}

export function getIndependentFeedAdapter(env: NodeJS.ProcessEnv = process.env): IndependentFeedAdapter {
  const feeds = loadRedstoneFeedContractIds(env);
  if (Object.keys(feeds).length === 0) {
    throw new Error("price-guard: REDSTONE_FEED_CONTRACT_IDS is not configured");
  }
  return new RedstoneAdapter(feeds, env);
}
