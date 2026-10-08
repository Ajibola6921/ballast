import { describe, expect, it, vi } from "vitest";
import { INTERNAL_TOKEN_HEADER, internalBindHost, loadInternalToken, requireInternalToken, type HookHost } from "./internalAuth.js";

const TOKEN = "t".repeat(40);

function hook(token: string) {
  let handler!: Parameters<HookHost["addHook"]>[1];
  const app: HookHost = { addHook: (_name, fn) => void (handler = fn) };
  requireInternalToken(app, token);
  const send = vi.fn();
  const code = vi.fn((_status: number) => ({ send }));
  const reply = { code };
  const call = async (headers: Record<string, unknown>) => {
    send.mockClear();
    code.mockClear();
    await handler({ headers }, reply);
    return { rejected: code.mock.calls.length > 0, status: code.mock.calls[0]?.[0] };
  };
  return { call };
}

describe("requireInternalToken", () => {
  it("lets a request with the token through and refuses everything else", async () => {
    const { call } = hook(TOKEN);
    expect(await call({ [INTERNAL_TOKEN_HEADER]: TOKEN })).toEqual({ rejected: false, status: undefined });
    for (const headers of [{}, { [INTERNAL_TOKEN_HEADER]: "" }, { [INTERNAL_TOKEN_HEADER]: TOKEN + "x" }, { [INTERNAL_TOKEN_HEADER]: TOKEN.slice(1) }, { [INTERNAL_TOKEN_HEADER]: ["a", TOKEN] }]) {
      expect(await call(headers)).toEqual({ rejected: true, status: 401 });
    }
  });

  it("refuses to be set up with a short token", () => {
    expect(() => requireInternalToken({ addHook: () => {} }, "short")).toThrow(/too short/);
  });
});

describe("loadInternalToken", () => {
  it("requires a long enough INTERNAL_API_TOKEN", () => {
    expect(loadInternalToken({ INTERNAL_API_TOKEN: TOKEN })).toBe(TOKEN);
    expect(() => loadInternalToken({})).toThrow(/INTERNAL_API_TOKEN/);
    expect(() => loadInternalToken({ INTERNAL_API_TOKEN: "short" })).toThrow(/at least 32/);
  });
});

describe("internalBindHost", () => {
  it("is loopback unless the service's own *_HOST says otherwise", () => {
    expect(internalBindHost("payout-hop", {})).toBe("127.0.0.1");
    expect(internalBindHost("payout-hop", { PAYOUT_HOP_HOST: "10.0.0.5" })).toBe("10.0.0.5");
    expect(internalBindHost("issuer-gateway", { ISSUER_GATEWAY_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});
