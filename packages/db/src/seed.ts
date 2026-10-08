/**
 * Seeds the rows `services/api` needs before anyone can log in or pledge anything, from a
 * `scripts/deploy.sh` output file (`.env.<network>-deploy`): one `party` + `party_account` each
 * for that deploy's lender and borrower, and an `asset` row for its test RWA whose parameters
 * match what `deploy.sh` configured on-chain. Idempotent — keyed on the Stellar account /
 * the asset's contract address, so re-running it against the same deploy changes nothing.
 *
 * There's no party-onboarding (KYB) or asset-listing API yet; until there is, this is how those
 * rows come to exist. Run via `scripts/dev-setup.sh`, or directly:
 *
 *   node --env-file=.env --env-file=.env.testnet-deploy --import tsx packages/db/src/seed.ts
 */
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "./client.js";
import * as schema from "./schema.js";

type PartyKind = (typeof schema.partyKindEnum.enumValues)[number];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`@ballast/db seed: ${name} is not set (expected from .env.<network>-deploy)`);
  }
  return value;
}

async function ensureParty(
  db: Database,
  kind: PartyKind,
  legalName: string,
  stellarAccount: string,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(schema.partyAccount)
    .where(eq(schema.partyAccount.stellarAccount, stellarAccount))
    .limit(1);
  if (existing) return existing.partyId;

  const [party] = await db
    .insert(schema.party)
    .values({ kind, legalName, kybStatus: "approved", kybProvider: "seed" })
    .returning();
  await db
    .insert(schema.partyAccount)
    .values({ partyId: party.id, stellarAccount, role: kind, verifiedAt: new Date() });
  return party.id;
}

async function ensureAsset(db: Database): Promise<string> {
  const contractC = requireEnv("RWA_SAC");
  const [existing] = await db
    .select()
    .from(schema.asset)
    .where(eq(schema.asset.contractC, contractC))
    .limit(1);
  if (existing) return existing.id;

  const [asset] = await db
    .insert(schema.asset)
    .values({
      code: process.env.RWA_CODE ?? "RWA1",
      issuerG: requireEnv("RWA_ISSUER"),
      // Which `IssuerNavAdapter` services/price-guard resolves for this asset. The test RWA is
      // priced as Etherfuse's real USTRY bond (ISSUER_NAV_SYMBOLS / REDSTONE_FEED_CONTRACT_IDS in
      // scripts/real-sources.env map RWA1 onto it).
      issuerCode: process.env.RWA_ISSUER_CODE ?? "etherfuse",
      contractC,
      standard: "classic_sac",
      yieldType: "accumulating",
      custodyMode: "escrow",
      ccy: "USD",
      redemptionLagDays: 1,
      navSchedule: "daily",
      priceBandBps: 50,
      dailyMoveBandBps: 100,
      haircutBaseBps: 500,
      haircutFxBps: 0,
    })
    .returning();
  return asset.id;
}

async function main() {
  const db = createDatabase();
  const lenderId = await ensureParty(db, "lender", "Seed Lender", requireEnv("LENDER"));
  const borrowerId = await ensureParty(db, "borrower", "Seed Borrower", requireEnv("BORROWER"));
  const assetId = await ensureAsset(db);
  console.log(JSON.stringify({ lenderId, borrowerId, assetId }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
