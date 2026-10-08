import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Markets } from "../pages/Markets.tsx";
import type { Market, MarketsResult } from "../lib/api.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const market = (over: Partial<Market> = {}): Market => ({
  code: "USTRY",
  issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
  issuerCode: "etherfuse",
  contract: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
  ccy: "USD",
  priceBandBps: 50,
  guarded: null,
  sources: {
    issuerNav: { value: "1.0764340", observedAt: "2026-10-08T09:00:49Z", ageS: 600 },
    redstone: { value: "1.0760000", observedAt: "2026-10-08T08:17:20Z", ageS: 3200 },
  },
  sourceCount: 2,
  divergenceBps: 4,
  ...over,
});

function serve(result: Partial<MarketsResult> & { markets: Market[] }) {
  const body: MarketsResult = {
    network: "mainnet",
    priceGuardContract: null,
    generatedAt: "2026-10-08T12:00:00Z",
    ...result,
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <Markets />
    </MemoryRouter>,
  );

describe("Markets page", () => {
  it("says plainly that an asset has no on-chain price when only readings exist", async () => {
    serve({ markets: [market()] });
    renderPage();

    expect(await screen.findByText("SHADOW / NOT ON-CHAIN")).toBeTruthy();
    expect(screen.getByText(/NO GUARDED PRICE PUBLISHED/)).toBeTruthy();
    // The headline is the latest reading, labelled as such, never presented as the guarded price.
    expect(screen.getByText("Latest reading")).toBeTruthy();
    expect(screen.queryByText("Guarded price (on-chain)")).toBeNull();
  });

  it("shows the guarded price and the guard's status once one is published", async () => {
    serve({
      markets: [market({ guarded: { value: "1.0764250", status: "Ok", asOf: "2026-10-08T11:59:00Z", ageS: 60 } })],
    });
    renderPage();

    expect(await screen.findByText("GUARD: Ok")).toBeTruthy();
    expect(screen.getByText("Guarded price (on-chain)")).toBeTruthy();
    expect(screen.getByText("1.0764")).toBeTruthy();
  });

  it("flags a stale reading and a source spread beyond the band", async () => {
    serve({
      markets: [
        market({
          sources: {
            issuerNav: { value: "1.0764340", observedAt: "2026-10-07T00:00:00Z", ageS: 7 * 3600 },
            redstone: null,
          },
          sourceCount: 1,
          divergenceBps: null,
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText(/STALE/)).toBeTruthy();
    expect(screen.getByText("NO READING")).toBeTruthy();
    expect(screen.getByText("1 OF 2 SOURCES")).toBeTruthy();
  });

  it("states the trust model: Ballast signs the NAV, not the issuer", async () => {
    serve({ markets: [market()] });
    renderPage();
    expect(await screen.findByText(/none signs them/)).toBeTruthy();
    expect(screen.getByText(/Lending is not open/)).toBeTruthy();
  });

  it("shows an error, not an empty or invented table, when the API is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    renderPage();
    await waitFor(() => expect(screen.getByText(/ERROR: boom/)).toBeTruthy());
    expect(screen.queryByText(/USTRY/)).toBeNull();
  });

  it("links each asset to its issuer and contract on the explorer for the network", async () => {
    serve({ network: "mainnet", markets: [market()] });
    renderPage();
    await screen.findByText(/ISSUER/);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("https://stellar.expert/explorer/public/asset/USTRY-G"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("https://stellar.expert/explorer/public/contract/C"))).toBe(true);
  });
});
