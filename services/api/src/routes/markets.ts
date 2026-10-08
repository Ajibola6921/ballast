/**
 * Public, read-only view of every asset's live price state: the contract's guarded price (when
 * one has been published on-chain) next to the latest raw reading from each independent source.
 * Everything here is read from `price_snapshot` / `price_observation`, which the price-guard
 * service fills from real sources only — nothing on this route is computed or defaulted for show.
 *
 * An asset watched in shadow mode (`PRICE_GUARD_PUBLISH=false`) has observations but no snapshot;
 * it is returned with `guarded: null` so the page can say plainly that nothing is on-chain yet.
 */
import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";

/** The most recent observations are enough: price-guard stores one row per distinct reading. */
const OBSERVATION_WINDOW = 2000;

type Observation = typeof schema.priceObservation.$inferSelect;
type Snapshot = typeof schema.priceSnapshot.$inferSelect;

function latestBy<T>(
  rows: T[],
  key: (row: T) => string,
  time: (row: T) => Date,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    const existing = out.get(k);
    if (!existing || time(row) > time(existing)) out.set(k, row);
  }
  return out;
}

function divergenceBps(a: string, b: string): number | null {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0) return null;
  return Math.round((Math.abs(x - y) / x) * 10_000);
}

export function registerMarketRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/public/markets", { config: { public: true } }, async () => {
    const now = Date.now();
    const assets = await db.select().from(schema.asset);
    const snapshots = (await db.select().from(schema.priceSnapshot)) as Snapshot[];
    const observations = (await db
      .select()
      .from(schema.priceObservation)
      .orderBy(desc(schema.priceObservation.observedAt))
      .limit(OBSERVATION_WINDOW)) as Observation[];

    const latestSnapshot = latestBy(snapshots, (s) => s.assetId, (s) => s.createdAt);
    const latestObservation = latestBy(observations, (o) => `${o.assetId}:${o.source}`, (o) => o.observedAt);

    const reading = (assetId: string, source: string) => {
      const o = latestObservation.get(`${assetId}:${source}`);
      return o
        ? { value: o.value, observedAt: o.observedAt, ageS: Math.max(0, Math.round((now - o.observedAt.getTime()) / 1000)) }
        : null;
    };

    return {
      network: process.env.STELLAR_NETWORK ?? "local",
      priceGuardContract: process.env.PRICE_GUARD_CONTRACT_ID || null,
      generatedAt: new Date(now),
      markets: assets
        .filter((a) => a.status === "active")
        .map((a) => {
          const issuerNav = reading(a.id, "issuer_nav");
          const redstone = reading(a.id, "redstone");
          const snap = latestSnapshot.get(a.id);
          return {
            code: a.code,
            issuer: a.issuerG,
            issuerCode: a.issuerCode,
            contract: a.contractC,
            ccy: a.ccy,
            priceBandBps: a.priceBandBps,
            guarded: snap
              ? {
                  value: snap.guardedValue,
                  status: snap.status,
                  asOf: snap.createdAt,
                  ageS: Math.max(0, Math.round((now - snap.createdAt.getTime()) / 1000)),
                }
              : null,
            sources: { issuerNav, redstone },
            sourceCount: [issuerNav, redstone].filter(Boolean).length,
            divergenceBps: issuerNav && redstone ? divergenceBps(issuerNav.value, redstone.value) : null,
          };
        }),
    };
  });
}
