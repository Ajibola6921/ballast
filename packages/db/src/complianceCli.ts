/**
 * Operator tool for the two manual compliance decisions. There is no API for these on purpose:
 * approving a party or clearing a sanctions hit is a person's judgement, and every use is written
 * to `audit_log` with who ran it.
 *
 *   pnpm --filter @ballast/db compliance kyb <partyId> <approved|pending|rejected> [provider] [ref]
 *   pnpm --filter @ballast/db compliance clear <partyId> <reviewer> <note...>
 *
 * `clear` records a reviewed, clear sanctions check for the party, which lifts a hold left by a
 * name/address match. A later hit would hold the party again.
 */
import { eq } from "drizzle-orm";
import { createDatabase } from "./client.js";
import * as schema from "./schema.js";

const KYB_STATUSES = ["approved", "pending", "rejected"] as const;

async function main(): Promise<void> {
  const [command, partyId, ...rest] = process.argv.slice(2);
  const db = createDatabase();
  const usage = "usage: compliance kyb <partyId> <approved|pending|rejected> [provider] [ref] | compliance clear <partyId> <reviewer> <note...>";
  if (!command || !partyId) throw new Error(usage);

  const [party] = await db.select().from(schema.party).where(eq(schema.party.id, partyId)).limit(1);
  if (!party) throw new Error(`no party ${partyId}`);

  if (command === "kyb") {
    const [status, provider, ref] = rest;
    if (!KYB_STATUSES.includes(status as (typeof KYB_STATUSES)[number])) throw new Error(usage);
    await db
      .update(schema.party)
      .set({ kybStatus: status, kybProvider: provider ?? party.kybProvider, kybRef: ref ?? party.kybRef })
      .where(eq(schema.party.id, partyId));
    await db.insert(schema.auditLog).values({
      actor: process.env.USER ?? "operator",
      action: "kyb.set",
      payload: { partyId, from: party.kybStatus, to: status, provider, ref },
    });
    console.log(`${party.legalName}: KYB ${party.kybStatus} -> ${status}`);
  } else if (command === "clear") {
    const [reviewer, ...note] = rest;
    if (!reviewer || note.length === 0) throw new Error(usage);
    await db.insert(schema.complianceCheck).values({
      partyId,
      kind: "sanctions",
      result: "clear",
      matches: [],
      listSource: `manual review by ${reviewer}: ${note.join(" ")}`,
    });
    await db.insert(schema.auditLog).values({
      actor: reviewer,
      action: "sanctions.cleared",
      payload: { partyId, note: note.join(" ") },
    });
    console.log(`${party.legalName}: sanctions hold cleared by ${reviewer}`);
  } else {
    throw new Error(usage);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
