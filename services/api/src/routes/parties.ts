import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { StrKey } from "@stellar/stellar-sdk";
import { schema, type Database } from "@ballast/db";

/**
 * Counterparty lookup by Stellar account. A lender opening a credit line knows the borrower's
 * G-address, not Ballast's internal `party.id` — this resolves one to the other (and confirms
 * the counterparty is actually onboarded) so `POST /v1/credit-lines` can keep taking party ids.
 */
export function registerPartyRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { account: string } }>("/v1/parties/by-account/:account", async (request, reply) => {
    const { account } = request.params;
    if (!StrKey.isValidEd25519PublicKey(account)) {
      return reply.code(400).send({ error: "invalid Stellar account (G...)" });
    }
    const [link] = await db
      .select()
      .from(schema.partyAccount)
      .where(eq(schema.partyAccount.stellarAccount, account))
      .limit(1);
    if (!link) return reply.code(404).send({ error: "no onboarded party for that account" });

    const [party] = await db.select().from(schema.party).where(eq(schema.party.id, link.partyId)).limit(1);
    return { partyId: link.partyId, stellarAccount: account, kind: party?.kind ?? link.role, legalName: party?.legalName ?? null };
  });
}
