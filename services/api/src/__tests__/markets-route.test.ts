import { afterEach, describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost",
  sep10WebAuthDomain: "localhost",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  webhookHmacSecret: "test-webhook-secret",
  webhookSubscribers: [],
  institutionApiKeys: {},
  consoleOrigin: "http://localhost:5173",
};

const asset = (id: string, code: string, status = "active") => ({
  id,
  code,
  issuerG: "GISSUER",
  issuerCode: "etherfuse",
  contractC: `C${code}`,
  ccy: "USD",
  priceBandBps: 100,
  status,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /v1/public/markets", () => {
  it("is public and shows the latest reading per source with its age and the divergence between them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));

    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.asset, [asset("a1", "USTRY"), asset("a2", "OLD", "paused")]],
        [
          schema.priceObservation,
          [
            { assetId: "a1", source: "issuer_nav", value: "1.0764250", observedAt: new Date("2026-10-08T11:00:00Z") },
            { assetId: "a1", source: "issuer_nav", value: "1.0700000", observedAt: new Date("2026-10-07T11:00:00Z") },
            { assetId: "a1", source: "redstone", value: "1.0760000", observedAt: new Date("2026-10-08T10:30:00Z") },
          ],
        ],
        [schema.priceSnapshot, []],
      ]),
    );
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const res = await app.inject({ method: "GET", url: "/v1/public/markets" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markets).toHaveLength(1);
    const m = body.markets[0];
    expect(m.code).toBe("USTRY");
    expect(m.sources.issuerNav).toMatchObject({ value: "1.0764250", ageS: 3600 });
    expect(m.sources.redstone).toMatchObject({ value: "1.0760000", ageS: 5400 });
    expect(m.sourceCount).toBe(2);
    expect(m.divergenceBps).toBe(4);
  });

  it("returns guarded: null for an asset only watched in shadow mode, never a made-up price", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.asset, [asset("a1", "CETES")]],
        [
          schema.priceObservation,
          [{ assetId: "a1", source: "issuer_nav", value: "0.0657660", observedAt: new Date() }],
        ],
      ]),
    );
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const m = (await app.inject({ method: "GET", url: "/v1/public/markets" })).json().markets[0];

    expect(m.guarded).toBeNull();
    expect(m.sources.redstone).toBeNull();
    expect(m.sourceCount).toBe(1);
    expect(m.divergenceBps).toBeNull();
  });

  it("reports the on-chain guarded price and status when one is published", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.asset, [asset("a1", "USTRY")]],
        [
          schema.priceSnapshot,
          [
            { assetId: "a1", guardedValue: "1.0000000", status: "Ok", createdAt: new Date("2026-10-07T00:00:00Z") },
            { assetId: "a1", guardedValue: "1.0764250", status: "Degraded", createdAt: new Date("2026-10-08T00:00:00Z") },
          ],
        ],
      ]),
    );
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const m = (await app.inject({ method: "GET", url: "/v1/public/markets" })).json().markets[0];

    expect(m.guarded).toMatchObject({ value: "1.0764250", status: "Degraded" });
  });
});
