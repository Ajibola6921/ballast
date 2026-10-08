import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("@ballast/operator-signing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/operator-signing")>();
  return { ...actual, submitSignedTx: submitMock };
});

const { runRepoMarginJob } = await import("./repoMargin.js");

function makeDb(rows: Map<unknown, unknown[]>) {
  const inserted: Array<{ table: unknown; values: any }> = [];
  const updated: Array<{ table: unknown; set: any }> = [];
  const chain = (data: unknown[]): any => {
    const promise: any = Promise.resolve(data);
    promise.where = () => chain(data);
    return promise;
  };
  const db = {
    select: () => ({ from: (table: unknown) => chain(rows.get(table) ?? []) }),
    insert: (table: unknown) => ({ values: async (values: unknown) => { inserted.push({ table, values }); } }),
    update: (table: unknown) => ({ set: (set: unknown) => ({ where: async () => { updated.push({ table, set }); } }) }),
  } as any;
  return { db, inserted, updated };
}

const signer = {
  publicKey: vi.fn().mockReturnValue("GKEEPER"),
  sign: vi.fn().mockImplementation(async (xdr: string) => `signed:${xdr}`),
};

const NOW = new Date("2026-10-08T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const TRADE = { id: "trade-1", status: "settled", contractTradeId: "7" };
const fixtures = (trade: object = TRADE) => new Map<unknown, unknown[]>([[schema.repoTrade, [trade]]]);

type Chain = { status?: string; pendingMarginCall?: boolean; cureDeadline?: number | null; marginCallAmount?: bigint };
function client(view: object, chain: Chain, after?: Chain) {
  const trade = vi.fn();
  trade.mockResolvedValueOnce({ status: "Settled", pendingMarginCall: false, cureDeadline: null, marginCallAmount: 0n, ...chain });
  if (after) trade.mockResolvedValueOnce({ status: "Settled", ...after });
  return {
    trade,
    marginView: vi.fn().mockResolvedValue({ priceOk: true, state: "Healthy", ...view }),
    callMargin: vi.fn().mockResolvedValue("call-xdr"),
    defaultClose: vi.fn().mockResolvedValue("default-xdr"),
  };
}

const run = (db: any, c: ReturnType<typeof client>) => runRepoMarginJob(db, c as any, signer as any, NOW);

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue({ hash: "hash-1", status: "SUCCESS" });
  process.env.STELLAR_RPC_URL = "http://localhost:8000/soroban/rpc";
  process.env.STELLAR_HORIZON_URL = "http://localhost:8000";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
});

describe("runRepoMarginJob", () => {
  it("submits nothing for a healthy trade with no call open", async () => {
    const { db } = makeDb(fixtures());
    const c = client({ state: "Healthy" }, {});
    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("opens a margin call when a settled trade falls into the call band, and books it", async () => {
    const { db, inserted } = makeDb(fixtures());
    const c = client(
      { state: "MarginCall" },
      {},
      { pendingMarginCall: true, marginCallAmount: 50_000_000n, cureDeadline: NOW_S + 86_400 },
    );

    expect(await run(db, c)).toEqual({ processed: 1, skipped: 0, errors: [] });
    expect(c.callMargin).toHaveBeenCalledWith("GKEEPER", 7n);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe(schema.repoMarginCall);
    expect(inserted[0].values).toMatchObject({ tradeId: "trade-1", amount: "5.0000000", ccy: "USDC" });
    expect(inserted[0].values.dueAt).toEqual(new Date((NOW_S + 86_400) * 1000));
  });

  it("clears an open call when the price has recovered, and marks it cured", async () => {
    const { db, updated, inserted } = makeDb(fixtures());
    const c = client(
      { state: "Healthy" },
      { pendingMarginCall: true, cureDeadline: NOW_S + 3_600 },
      { pendingMarginCall: false, cureDeadline: null },
    );

    expect(await run(db, c)).toEqual({ processed: 1, skipped: 0, errors: [] });
    expect(c.callMargin).toHaveBeenCalledTimes(1);
    expect(c.defaultClose).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(updated).toContainEqual({ table: schema.repoMarginCall, set: { curedAt: NOW } });
  });

  it("closes the trade out when the cure window is over and the position is still in the band", async () => {
    const { db, updated } = makeDb(fixtures());
    const c = client({ state: "MarginCall" }, { pendingMarginCall: true, cureDeadline: NOW_S - 1 });

    expect(await run(db, c)).toEqual({ processed: 1, skipped: 0, errors: [] });
    expect(c.defaultClose).toHaveBeenCalledWith("GKEEPER", 7n);
    expect(updated).toContainEqual({ table: schema.repoTrade, set: { status: "defaulted" } });
  });

  it("leaves a call alone while the borrower is still inside the cure window", async () => {
    const { db } = makeDb(fixtures());
    const c = client({ state: "Liquidation" }, { pendingMarginCall: true, cureDeadline: NOW_S + 60 });
    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("does not act on a price the guard does not stand behind", async () => {
    const { db } = makeDb(fixtures());
    const c = client({ priceOk: false, state: "Healthy" }, { pendingMarginCall: true, cureDeadline: NOW_S - 1 });
    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("books a default that happened on-chain, and ignores a trade that already unwound", async () => {
    const defaulted = makeDb(fixtures());
    await run(defaulted.db, client({}, { status: "Defaulted" }));
    expect(defaulted.updated).toContainEqual({ table: schema.repoTrade, set: { status: "defaulted" } });

    const unwound = makeDb(fixtures());
    expect(await run(unwound.db, client({}, { status: "Unwound" }))).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(unwound.updated).toHaveLength(0);
  });

  it("skips a trade that never reached the chain through the API", async () => {
    const { db } = makeDb(fixtures({ ...TRADE, contractTradeId: null }));
    const c = client({}, {});
    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(c.trade).not.toHaveBeenCalled();
  });

  it("records an error and books nothing when a submission fails", async () => {
    const { db, inserted } = makeDb(fixtures());
    const c = client({ state: "MarginCall" }, {});
    submitMock.mockRejectedValue(new Error("rpc down"));

    const result = await run(db, c);

    expect(result.errors).toEqual([{ id: "trade-1", message: "rpc down" }]);
    expect(inserted).toHaveLength(0);
  });
});
