import { describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
import { createFakeDb } from "./fake-db.js";

const config: ApiConfig = {
  port: 0, jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost", sep10WebAuthDomain: "localhost",
  networkPassphrase: "Test SDF Network ; September 2015",
  webhookSecretKey: "00".repeat(32), apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false, consoleOrigin: "http://localhost:5173",
};

// Three distinct parties: the line's lender and borrower, and a stranger who is nobody to it.
const LENDER = { partyId: "11111111-1111-4111-8111-111111111111", account: "GLENDER" };
const BORROWER = { partyId: "22222222-2222-4222-8222-222222222222", account: "GBORROWER" };
const STRANGER = { partyId: "33333333-3333-4333-8333-333333333333", account: "GSTRANGER" };
const LINE = "44444444-4444-4444-8444-444444444444";
const PLEDGE = "55555555-5555-4555-8555-555555555555";
const QUOTE = "66666666-6666-4666-8666-666666666666";
const TRADE = "77777777-7777-4777-8777-777777777777";

const bearer = (who: { account: string }) => ({ authorization: `Bearer ${signSessionToken(who.account, config.jwtSigningSecret)}` });
const chain = { txHash: () => "tx" } as unknown as ChainGateway;

function server(caller: { partyId: string; account: string }, extra: Array<[unknown, unknown[]]> = []) {
  const contracts = {
    creditLine: { draw: vi.fn(), repay: vi.fn(), ltv: vi.fn(), line: vi.fn() },
    pledgeVault: { pledge: vi.fn(), release: vi.fn() },
    exitDesk: { exit: vi.fn() },
    repoDvp: { acceptAndSettle: vi.fn(), unwind: vi.fn() },
  };
  const db = createFakeDb(
    new Map<unknown, unknown[]>([
      [schema.partyAccount, [{ partyId: caller.partyId, stellarAccount: caller.account, role: "x" }]],
      [schema.creditLine, [{ id: LINE, lenderId: LENDER.partyId, borrowerId: BORROWER.partyId, contractLineId: "3", status: "open", limitAmount: "1000" }]],
      [schema.asset, [{ id: "asset", code: "RWA1", contractC: "CASSET", haircutBaseBps: 500, haircutFxBps: 0 }]],
      [schema.priceSnapshot, [{ assetId: "asset", guardedValue: "1.0000000", status: "Ok", createdAt: new Date() }]],
      [schema.pledge, [{ id: PLEDGE, creditLineId: LINE, assetId: "asset", units: "10.0000000", status: "active" }]],
      [schema.exitQuote, [{ id: QUOTE, holderId: BORROWER.partyId, assetId: "asset", units: "1", status: "open", expiresAt: new Date(Date.now() + 60_000) }]],
      [schema.repoTrade, [{ id: TRADE, cashLenderId: LENDER.partyId, cashBorrowerId: BORROWER.partyId, status: "proposed", contractTradeId: "9" }]],
      ...extra,
    ]),
  );
  return { app: buildServer({ config, db, contracts: contracts as unknown as ContractClients, chain }), contracts };
}

const inject = (app: ReturnType<typeof server>["app"], method: "GET" | "POST" | "DELETE", url: string, who: { account: string }, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(who), payload: payload as object | undefined });

describe("positions", () => {
  it("lets a party read its own book and refuses anyone else's", async () => {
    const { app } = server(BORROWER);
    expect((await inject(app, "GET", `/v1/positions?party=${BORROWER.partyId}`, BORROWER)).statusCode).toBe(200);
    expect((await inject(app, "GET", `/v1/positions?party=${LENDER.partyId}`, BORROWER)).statusCode).toBe(403);
  });
});

describe("a stranger cannot act on a line that is not theirs", () => {
  it("cannot read it, and is told it does not exist", async () => {
    const { app } = server(STRANGER);
    const res = await inject(app, "GET", `/v1/credit-lines/${LINE}`, STRANGER);
    expect(res.statusCode).toBe(404);
  });

  it("both of the line's own parties can read it", async () => {
    for (const who of [LENDER, BORROWER]) {
      const { app } = server(who);
      expect((await inject(app, "GET", `/v1/credit-lines/${LINE}`, who)).statusCode).toBe(200);
    }
  });

  it.each([
    ["pledge", "POST", `/v1/credit-lines/${LINE}/pledges`, { assetId: "88888888-8888-4888-8888-888888888888", units: "100", custodyMode: "escrow" }],
    ["release", "DELETE", `/v1/credit-lines/${LINE}/pledges/${PLEDGE}`, undefined],
    ["draw", "POST", `/v1/credit-lines/${LINE}/draws`, { amount: "100", to: "GSOMEWHERE" }],
    ["repay", "POST", `/v1/credit-lines/${LINE}/repayments`, { amount: "100" }],
  ] as const)("cannot %s on someone else's behalf, and no transaction is built", async (_name, method, url, payload) => {
    const { app, contracts } = server(STRANGER);
    const res = await inject(app, method, url, STRANGER, payload);
    expect(res.statusCode).toBe(403);
    for (const client of Object.values(contracts)) for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
  });

  it("the lender cannot pledge, draw or repay for the borrower either", async () => {
    const { app } = server(LENDER);
    for (const [method, url, payload] of [
      ["POST", `/v1/credit-lines/${LINE}/draws`, { amount: "1", to: "G" }],
      ["POST", `/v1/credit-lines/${LINE}/repayments`, { amount: "1" }],
    ] as const) {
      expect((await inject(app, method, url, LENDER, payload)).statusCode).toBe(403);
    }
  });
});

describe("exit and repo", () => {
  it("only the holder can execute a quote, and others are told it does not exist", async () => {
    const { app, contracts } = server(STRANGER);
    const res = await inject(app, "POST", `/v1/exit/quotes/${QUOTE}/execute`, STRANGER, { minUsdcOut: "1", to: "GSTRANGER" });
    expect(res.statusCode).toBe(404);
    expect(contracts.exitDesk.exit).not.toHaveBeenCalled();
  });

  it("only the cash borrower can accept a proposal", async () => {
    for (const who of [LENDER, STRANGER]) {
      const { app, contracts } = server(who);
      const res = await inject(app, "POST", `/v1/repo/proposals/${TRADE}/accept`, who);
      expect(res.statusCode).toBe(403);
      expect(contracts.repoDvp.acceptAndSettle).not.toHaveBeenCalled();
    }
  });

  it("only the two parties to a trade can unwind it", async () => {
    const { app, contracts } = server(STRANGER, [[schema.repoTrade, [{ id: TRADE, cashLenderId: LENDER.partyId, cashBorrowerId: BORROWER.partyId, status: "settled", contractTradeId: "9" }]]]);
    const res = await inject(app, "POST", `/v1/repo/trades/${TRADE}/unwind`, STRANGER);
    expect(res.statusCode).toBe(404);
    expect(contracts.repoDvp.unwind).not.toHaveBeenCalled();
  });
});

describe("daily report", () => {
  it("contains only the caller's lines, not other parties' draws and liquidations", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const mine = { creditLineId: LINE, amount: "5" };
    const theirs = { creditLineId: "99999999-9999-4999-8999-999999999999", amount: "7" };
    const { app } = server(LENDER, [
      [schema.draw, [mine, theirs]],
      [schema.repayment, [theirs]],
      [schema.liquidation, [theirs, { creditLineId: LINE, units: "1" }]],
      [schema.marginEvent, [theirs]],
    ]);
    const body = (await inject(app, "GET", `/v1/reports/daily?date=${day}`, LENDER)).json();
    expect(body.draws).toEqual([mine]);
    expect(body.repayments).toEqual([]);
    expect(body.liquidations).toHaveLength(1);
    expect(body.marginEvents).toEqual([]);
  });
});
