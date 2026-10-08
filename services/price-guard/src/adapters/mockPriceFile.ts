/**
 * MOCK-mode only. Lets something outside this process move the price the mock adapters report,
 * so a margin call or liquidation can be rehearsed end to end without a real market move:
 * `MOCK_PRICE_FILE` names a JSON file mapping asset code to a decimal price, e.g.
 * `{"RWA1":"0.62"}`, re-read on every fetch. No file, no entry, or an unreadable file all mean
 * "use the adapter's built-in base price". The live adapters never look at this.
 */
import { readFileSync } from "node:fs";
import { decimalStringToScaled } from "../scaled.js";

export function mockBasePrice(
  assetCode: string,
  fallback: bigint,
  env: NodeJS.ProcessEnv = process.env,
): bigint {
  const path = env.MOCK_PRICE_FILE;
  if (!path) return fallback;
  try {
    const overrides = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    const price = overrides[assetCode];
    return price === undefined ? fallback : decimalStringToScaled(String(price));
  } catch {
    return fallback;
  }
}
