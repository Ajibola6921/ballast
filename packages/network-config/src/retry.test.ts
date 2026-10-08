import { describe, expect, it, vi } from "vitest";
import { isTransientRpcError, withRpcRetry } from "./retry.js";

describe("isTransientRpcError", () => {
  it.each([
    new TypeError("fetch failed"),
    new Error("Account not found: GABC"),
    new Error("connect ETIMEDOUT 1.2.3.4:443"),
    new Error("status code 503"),
    new Error("contract-clients: network is busy, try submitting again"),
    Object.assign(new Error("request failed"), { cause: new Error("read ECONNRESET") }),
  ])("treats %s as transient", (err) => expect(isTransientRpcError(err)).toBe(true));

  it.each([
    new Error('contract-clients: simulation of "draw" failed: HostError: Error(Contract, #3)'),
    new Error("contract-clients: network rejected the transaction (txBadSeq)"),
    new Error("invalid XDR"),
  ])("treats %s as a real answer", (err) => expect(isTransientRpcError(err)).toBe(false));
});

describe("withRpcRetry", () => {
  it("retries a transient failure and returns the eventual result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockRejectedValueOnce(new Error("Account not found: G")).mockResolvedValue("ok");
    await expect(withRpcRetry(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a real answer", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("simulation of draw failed: Error(Contract, #3)"));
    await expect(withRpcRetry(fn, { baseDelayMs: 1 })).rejects.toThrow(/simulation/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts with the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(withRpcRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
