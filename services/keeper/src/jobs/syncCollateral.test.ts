import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("@ballast/operator-signing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/operator-signing")>();
  return { ...actual, submitSignedTx: submitMock };
});

const { runSyncCollateralJob } = await import("./syncCollateral.js");

function makeDb(creditLines: unknown[]) {
  return {
    select: () => ({ from: () => ({ where: vi.fn().mockResolvedValue(creditLines) }) }),
  } as any;
}

const signer = {
  publicKey: vi.fn().mockReturnValue("GKEEPER"),
  sign: vi.fn().mockImplementation(async (xdr: string) => `signed:${xdr}`),
};

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue({ hash: "hash-1", status: "SUCCESS" });
  process.env.STELLAR_RPC_URL = "http://localhost:8000/soroban/rpc";
  process.env.STELLAR_HORIZON_URL = "http://localhost:8000";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
});

const ASSET = "CASSET";
const vault = (units: bigint) => ({ positionUnits: vi.fn().mockResolvedValue(units) });
const line = (over: object = {}) => ({ id: "line-1", contractLineId: "1", ...over });

describe("runSyncCollateralJob", () => {
  it("does nothing when there are no open credit lines", async () => {
    const creditLineClient = { syncCollateral: vi.fn() };

    const result = await runSyncCollateralJob(makeDb([]), creditLineClient as any, vault(0n) as any, signer as any);

    expect(creditLineClient.syncCollateral).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 0, errors: [] });
  });

  it("repairs drift by pushing the vault's own figure, never one derived from Postgres", async () => {
    const creditLineClient = {
      line: vi.fn().mockResolvedValue({ pledgedUnits: 0n, asset: ASSET }),
      syncCollateral: vi.fn().mockResolvedValue("unsigned-xdr"),
    };
    const v = vault(10_000_000_000n);

    const result = await runSyncCollateralJob(makeDb([line()]), creditLineClient as any, v as any, signer as any);

    expect(v.positionUnits).toHaveBeenCalledWith(1n, ASSET);
    expect(creditLineClient.syncCollateral).toHaveBeenCalledWith("GKEEPER", 1n, 10_000_000_000n);
    expect(result).toEqual({ processed: 1, skipped: 0, errors: [] });
  });

  it("also corrects the other way, when the credit line counts more than the vault holds", async () => {
    const creditLineClient = {
      line: vi.fn().mockResolvedValue({ pledgedUnits: 10_000_000_000n, asset: ASSET }),
      syncCollateral: vi.fn().mockResolvedValue("unsigned-xdr"),
    };

    await runSyncCollateralJob(makeDb([line()]), creditLineClient as any, vault(4_000_000_000n) as any, signer as any);

    expect(creditLineClient.syncCollateral).toHaveBeenCalledWith("GKEEPER", 1n, 4_000_000_000n);
  });

  it("submits nothing when the two already agree", async () => {
    const creditLineClient = {
      line: vi.fn().mockResolvedValue({ pledgedUnits: 10_000_000_000n, asset: ASSET }),
      syncCollateral: vi.fn(),
    };

    const result = await runSyncCollateralJob(makeDb([line()]), creditLineClient as any, vault(10_000_000_000n) as any, signer as any);

    expect(creditLineClient.syncCollateral).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 1, errors: [] });
  });

  it("skips lines with no on-chain contract_line_id yet", async () => {
    const creditLineClient = { syncCollateral: vi.fn() };

    const result = await runSyncCollateralJob(
      makeDb([line({ contractLineId: null })]), creditLineClient as any, vault(0n) as any, signer as any,
    );

    expect(creditLineClient.syncCollateral).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 1, errors: [] });
  });

  it("records an error and keeps going when a call fails", async () => {
    const creditLineClient = {
      line: vi.fn().mockResolvedValue({ pledgedUnits: 5n, asset: ASSET }),
      syncCollateral: vi.fn().mockRejectedValue(new Error("simulation failed")),
    };

    const result = await runSyncCollateralJob(makeDb([line()]), creditLineClient as any, vault(0n) as any, signer as any);

    expect(result.processed).toBe(0);
    expect(result.errors).toEqual([{ id: "line-1", message: "simulation failed" }]);
  });
});
