import { describe, expect, it, vi } from "vitest";
import { checkOperatorBalance, nativeBalanceXlm } from "../balance.js";

const horizon = (status: number, balances?: Array<{ asset_type: string; balance: string }>) =>
  vi.fn(async () => new Response(balances ? JSON.stringify({ balances }) : "x", { status })) as unknown as typeof fetch;
const xlm = (balance: string) => [{ asset_type: "credit_alphanum4", balance: "999" }, { asset_type: "native", balance }];

describe("nativeBalanceXlm", () => {
  it("reads the native balance among the account's assets", async () => {
    expect(await nativeBalanceXlm("https://h/", "GA", horizon(200, xlm("12.5")))).toBe(12.5);
  });

  it("treats a missing account as empty, but a Horizon outage as an error", async () => {
    expect(await nativeBalanceXlm("https://h", "GA", horizon(404))).toBe(0);
    await expect(nativeBalanceXlm("https://h", "GA", horizon(503))).rejects.toThrow(/503/);
  });
});

describe("checkOperatorBalance", () => {
  it("alerts below the minimum and says which account", async () => {
    const alerter = { fire: vi.fn() };
    const balance = await checkOperatorBalance(alerter, { horizonUrl: "https://h", account: "GKEEPER", label: "keeper", minXlm: 20, fetchImpl: horizon(200, xlm("3")) });
    expect(balance).toBe(3);
    expect(alerter.fire).toHaveBeenCalledWith("operator_balance_low", expect.objectContaining({ account: "GKEEPER", code: "keeper", balanceXlm: 3, minXlm: 20 }));
  });

  it("stays quiet at or above the minimum", async () => {
    const alerter = { fire: vi.fn() };
    await checkOperatorBalance(alerter, { horizonUrl: "https://h", account: "GA", label: "keeper", minXlm: 20, fetchImpl: horizon(200, xlm("20")) });
    expect(alerter.fire).not.toHaveBeenCalled();
  });

  it("alerts for an unfunded account", async () => {
    const alerter = { fire: vi.fn() };
    await checkOperatorBalance(alerter, { horizonUrl: "https://h", account: "GA", label: "price-publisher", minXlm: 20, fetchImpl: horizon(404) });
    expect(alerter.fire).toHaveBeenCalledWith("operator_balance_low", expect.objectContaining({ balanceXlm: 0 }));
  });

  it("does not report a Horizon outage as a low balance", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alerter = { fire: vi.fn() };
    expect(await checkOperatorBalance(alerter, { horizonUrl: "https://h", account: "GA", label: "keeper", fetchImpl: horizon(500) })).toBeNull();
    expect(alerter.fire).not.toHaveBeenCalled();
  });
});
