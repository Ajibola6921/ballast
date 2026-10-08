/**
 * Seeds the real mainnet assets a shadow run watches (scripts/shadow-assets.json) into the `asset`
 * table. Each row's `contract_c` is the asset's Stellar Asset Contract id, derived from its
 * classic code + issuer, so it is the same id any contract would see on mainnet. Idempotent.
 *
 * Issuers and feed contracts in that file were checked against the issuer's own stellar.toml and
 * RedStone's repository on 2026-10-08. Spiko and Franklin are absent on purpose: Spiko's Stellar
 * issuer could not be confirmed from a stellar.toml, and Franklin has no public NAV API.
 *
 *   pnpm --filter @ballast/service-price-guard shadow:seed
 */
import { readFileSync } from "node:fs";
import { Asset } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { createDatabase, schema } from "@ballast/db";

const MAINNET = "Public Global Stellar Network ; September 2015";

interface ShadowAsset {
  code: string;
  issuer: string;
  issuerCode: string;
  ccy: string;
  feed: string;
}

const file = new URL("../../../scripts/shadow-assets.json", import.meta.url);
const assets = JSON.parse(readFileSync(file, "utf8")) as ShadowAsset[];
const db = createDatabase();

for (const a of assets) {
  const contractC = new Asset(a.code, a.issuer).contractId(MAINNET);
  const [existing] = await db.select().from(schema.asset).where(eq(schema.asset.contractC, contractC)).limit(1);
  if (existing) {
    console.log(`${a.code}: already seeded (${contractC})`);
    continue;
  }
  await db.insert(schema.asset).values({
    code: a.code,
    issuerG: a.issuer,
    issuerCode: a.issuerCode,
    contractC,
    standard: "classic_sac",
    yieldType: "accumulating",
    custodyMode: "escrow",
    ccy: a.ccy,
    redemptionLagDays: 1,
    navSchedule: "daily",
    priceBandBps: 50,
    dailyMoveBandBps: 100,
    haircutBaseBps: 500,
    haircutFxBps: 0,
  });
  console.log(`${a.code}: seeded (${contractC})`);
}
process.exit(0);
