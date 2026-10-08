import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { settleIntent } from "../intents.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
import { createFakeDb } from "./fake-db.js";

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost",
  sep10WebAuthDomain: "localhost",
  networkPassphrase: "Test SDF Network ; September 2015",
  webhookSecretKey: "00".repeat(32),
  apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false,
  consoleOrigin: "http://localhost:5173",
};

const LENDER = { partyId: "44444444-4444-4444-4444-444444444444", account: "GLENDERACCOUNT" };
const LINE_ID = "55555555-5555-5555-5555-555555555555";
const chain = { txHash: () => "tx-hash" } as unknown as ChainGateway;
const bearer = (account: string) => ({ authorization: `Bearer ${signSessionToken(account, config.jwtSigningSecret)}` });

function server(opts: { caller?: { partyId: string; account: string }; line?: Record<string, unknown>; creditLine?: Record<string, unknown> }) {
  const caller = opts.caller ?? LENDER;
  const creditLine = {
    withdrawUndrawn: vi.fn().mockResolvedValue("xdr-undrawn"),
    withdrawInterest: vi.fn().mockResolvedValue("xdr-interest"),
    closeLiquidated: vi.fn().mockResolvedValue("xdr-close"),
    ...opts.creditLine,
  };
  const db = createFakeDb(
    new Map<unknown, unknown[]>([
      [schema.partyAccount, [{ partyId: caller.partyId, stellarAccount: caller.account, role: "lender" }]],
      [
        schema.creditLine,
        [{ id: LINE_ID, lenderId: LENDER.partyId, borrowerId: "borrower-party", contractLineId: "7", status: "open", ...opts.line }],
      ],
    ]),
  );
  const app = buildServer({ config, db, contracts: { creditLine } as unknown as ContractClients, chain });
  return { app, creditLine, caller };
}

describe("POST /v1/credit-lines/:id/withdrawals", () => {
  it("builds a withdraw_undrawn transaction for the lender", async () => {
    const { app, creditLine } = server({});
    const res = await app.inject({
      method: "POST", url: `/v1/credit-lines/${LINE_ID}/withdrawals`, headers: bearer(LENDER.account),
      payload: { kind: "undrawn", amount: "500000000" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ xdr: "xdr-undrawn", txHash: "tx-hash" });
    expect(creditLine.withdrawUndrawn).toHaveBeenCalledWith(LENDER.account, 7n, 500000000n);
    expect(creditLine.withdrawInterest).not.toHaveBeenCalled();
  });

  it("builds a withdraw_interest transaction when asked for interest", async () => {
    const { app, creditLine } = server({});
    const res = await app.inject({
      method: "POST", url: `/v1/credit-lines/${LINE_ID}/withdrawals`, headers: bearer(LENDER.account),
      payload: { kind: "interest", amount: "1000" },
    });
    expect(res.statusCode).toBe(201);
    expect(creditLine.withdrawInterest).toHaveBeenCalledWith(LENDER.account, 7n, 1000n);
  });

  it("refuses anyone who is not the line's lender", async () => {
    const { app, creditLine } = server({ caller: { partyId: "borrower-party", account: "GBORROWER" } });
    const res = await app.inject({
      method: "POST", url: `/v1/credit-lines/${LINE_ID}/withdrawals`, headers: bearer("GBORROWER"),
      payload: { kind: "undrawn", amount: "1" },
    });
    expect(res.statusCode).toBe(403);
    expect(creditLine.withdrawUndrawn).not.toHaveBeenCalled();
  });

  it("refuses a line that has not settled on-chain", async () => {
    const { app } = server({ line: { contractLineId: null } });
    const res = await app.inject({
      method: "POST", url: `/v1/credit-lines/${LINE_ID}/withdrawals`, headers: bearer(LENDER.account),
      payload: { kind: "undrawn", amount: "1" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /v1/credit-lines/:id/close-liquidation", () => {
  it("builds the close transaction for the lender of a liquidating line", async () => {
    const { app, creditLine } = server({ line: { status: "liquidating" } });
    const res = await app.inject({ method: "POST", url: `/v1/credit-lines/${LINE_ID}/close-liquidation`, headers: bearer(LENDER.account) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ xdr: "xdr-close" });
    expect(creditLine.closeLiquidated).toHaveBeenCalledWith(LENDER.account, 7n);
  });

  it.each(["open", "closed"])("refuses a line that is %s", async (status) => {
    const { app, creditLine } = server({ line: { status } });
    const res = await app.inject({ method: "POST", url: `/v1/credit-lines/${LINE_ID}/close-liquidation`, headers: bearer(LENDER.account) });
    expect(res.statusCode).toBe(409);
    expect(creditLine.closeLiquidated).not.toHaveBeenCalled();
  });

  it("refuses anyone but the lender", async () => {
    const { app, creditLine } = server({ caller: { partyId: "borrower-party", account: "GBORROWER" }, line: { status: "liquidating" } });
    const res = await app.inject({ method: "POST", url: `/v1/credit-lines/${LINE_ID}/close-liquidation`, headers: bearer("GBORROWER") });
    expect(res.statusCode).toBe(403);
    expect(creditLine.closeLiquidated).not.toHaveBeenCalled();
  });
});

describe("settling a close_liquidated transaction", () => {
  it("books the recorded proceeds and shortfall and closes the line", async () => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];
    const tables = new Map<unknown, unknown[]>([
      [schema.creditLine, [{ id: LINE_ID, contractLineId: "7" }]],
      [schema.liquidation, [{ id: "liq-1", creditLineId: LINE_ID, txHashes: ["keeper-tx"], startedAt: new Date() }]],
    ]);
    const chainable = (rows: unknown[]) => {
      const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
      p.where = () => chainable(rows);
      p.orderBy = () => chainable(rows);
      p.limit = () => chainable(rows);
      return p;
    };
    const db = {
      select: () => ({ from: (t: unknown) => chainable(tables.get(t) ?? []) }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          updates.push({ table, set });
          return { where: () => Object.assign(Promise.resolve([]), { returning: async () => [{}] }) };
        },
      }),
    } as unknown as Database;
    const liquidationRecord = vi.fn().mockResolvedValue({ debt: 6000000000n, recovered: 5000000000n, surplus: 0n, shortfall: 1000000000n, closed: true });

    const settleChain = { outcome: async () => ({ status: "SUCCESS", ledger: 123, returnValue: undefined }) } as unknown as ChainGateway;
    const intent = {
      txHash: "close-tx", kind: "credit_line.close_liquidated", refId: LINE_ID, partyId: "p", payload: null,
      status: "pending", ledger: null, error: null, createdAt: new Date(), settledAt: null,
    };

    const outcome = await settleIntent(db, settleChain, { creditLine: { liquidationRecord } } as unknown as ContractClients, intent);
    expect(outcome.status).toBe("settled");

    const liq = updates.find((u) => u.table === schema.liquidation)!;
    expect(liq.set).toMatchObject({ proceeds: "500.0000000", shortfall: "100.0000000", txHashes: ["keeper-tx", "close-tx"] });
    const line = updates.find((u) => u.table === schema.creditLine)!;
    expect(line.set).toMatchObject({ status: "closed" });
    expect(liquidationRecord).toHaveBeenCalledWith(7n);
  });
});
