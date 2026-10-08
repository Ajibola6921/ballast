import type { FastifyInstance } from "fastify";
import type { Database } from "@ballast/db";
import { checkParty } from "./gate.js";
import type { SanctionsScreener } from "./screener.js";

interface GatedRoute {
  method: string;
  url: string;
  /** The other parties a request names (a borrower, a repo counterparty) that are screened too. */
  counterparties?: (body: Record<string, unknown>) => unknown[];
}

/**
 * Routes that take on risk or put a party's assets into the system. Repayments, releases,
 * withdrawals and unwinds are deliberately absent: a party must always be able to get out.
 */
export const GATED_ROUTES: GatedRoute[] = [
  { method: "POST", url: "/v1/credit-lines", counterparties: (b) => [b.borrowerId] },
  { method: "POST", url: "/v1/credit-lines/:id/fund" },
  { method: "POST", url: "/v1/credit-lines/:id/pledges" },
  { method: "POST", url: "/v1/credit-lines/:id/draws" },
  { method: "POST", url: "/v1/exit/quotes" },
  { method: "POST", url: "/v1/exit/quotes/:id/execute" },
  { method: "POST", url: "/v1/repo/proposals", counterparties: (b) => [b.cashBorrowerId] },
  { method: "POST", url: "/v1/repo/proposals/:id/accept" },
];

/**
 * Runs after authentication. Screens the caller, and any counterparty the request names, before
 * the route handler runs; a party on hold gets 403 (or 503 if the sanctions list cannot be
 * loaded, which blocks rather than waves through).
 */
export function registerCompliance(app: FastifyInstance, db: Database, screener: SanctionsScreener): void {
  app.addHook("preHandler", async (request, reply) => {
    const route = GATED_ROUTES.find((r) => r.method === request.method && r.url === request.routeOptions.url);
    if (!route || !request.partyId) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const partyIds = [
      ...new Set([request.partyId, ...(route.counterparties?.(body) ?? [])].filter((v): v is string => typeof v === "string")),
    ];
    for (const partyId of partyIds) {
      const hold = await checkParty(db, screener, partyId);
      if (hold) return reply.code(hold.status).send({ error: hold.error });
    }
  });
}
