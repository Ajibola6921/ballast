/**
 * Live read-only smoke test: calls each real source once and prints what it returned. Sends
 * nothing on-chain and touches no database, so it is safe against mainnet.
 *
 *   STELLAR_RPC_URL=https://mainnet.sorobanrpc.com \
 *   STELLAR_HORIZON_URL=https://horizon.stellar.org \
 *   STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" \
 *   STELLAR_SIMULATION_SOURCE=<any existing mainnet account> \
 *   REDSTONE_FEED_CONTRACT_IDS='{"CETES":"C..."}' \
 *   pnpm --filter @ballast/service-price-guard smoke CETES:etherfuse USTBL:spiko
 *
 * Each argument is `ASSET_CODE:issuerCode`. Compare the printed values by hand against
 * app.redstone.finance, Spiko's site and Etherfuse's site. With `--json` it prints one JSON object
 * `{ nav: {value, ts} | null, feed: {value, ts} | null }` (scaled integers as strings) for the
 * single target instead, which scripts/e2e-smoke.sh uses to publish real readings.
 */
import { scaledToDecimalString } from "./scaled.js";
import { getIndependentFeedAdapter, getIssuerNavAdapter } from "./adapters/registry.js";

const json = process.argv.includes("--json");
const targets = process.argv.slice(2).filter((a) => a !== "--json").map((arg) => {
  const [code, issuerCode] = arg.split(":");
  if (!code || !issuerCode) throw new Error(`bad target "${arg}", expected ASSET_CODE:issuerCode`);
  return { code, issuerCode };
});
if (targets.length === 0) throw new Error("usage: smoke ASSET_CODE:issuerCode [...]");

function describe(label: string, reading: { value: bigint; ts: number }): string {
  const ageMin = Math.round((Date.now() / 1000 - reading.ts) / 60);
  return `${label.padEnd(12)} $${scaledToDecimalString(reading.value)}  updated ${new Date(reading.ts * 1000).toISOString()} (${ageMin} min ago)`;
}

if (json) {
  if (targets.length !== 1) throw new Error("--json takes exactly one target");
  const { code, issuerCode } = targets[0];
  const nav = await getIssuerNavAdapter(issuerCode)?.fetchNav(code);
  const feed = await getIndependentFeedAdapter().fetchPrice(code);
  const out = (r?: { value: bigint; ts: number }) => (r ? { value: r.value.toString(), ts: r.ts } : null);
  console.log(JSON.stringify({ nav: out(nav), feed: out(feed) }));
  process.exit(0);
}

let failed = false;
for (const { code, issuerCode } of targets) {
  console.log(`\n${code} (${issuerCode})`);
  const readings: Record<string, { value: bigint; ts: number }> = {};

  const nav = getIssuerNavAdapter(issuerCode);
  if (!nav) {
    console.log("  issuer NAV   none (no public NAV API for this issuer)");
  } else {
    try {
      readings.issuer = await nav.fetchNav(code);
      console.log("  " + describe("issuer NAV", readings.issuer));
    } catch (err) {
      failed = true;
      console.log(`  issuer NAV   FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  try {
    readings.feed = await getIndependentFeedAdapter().fetchPrice(code);
    console.log("  " + describe("RedStone", readings.feed));
  } catch (err) {
    failed = true;
    console.log(`  RedStone     FAILED: ${err instanceof Error ? err.message : err}`);
  }

  if (readings.issuer && readings.feed) {
    const diff = readings.issuer.value > readings.feed.value ? readings.issuer.value - readings.feed.value : readings.feed.value - readings.issuer.value;
    console.log(`  divergence   ${Number((diff * 10_000n) / readings.issuer.value)} bps`);
  }
}
process.exit(failed ? 1 : 0);
