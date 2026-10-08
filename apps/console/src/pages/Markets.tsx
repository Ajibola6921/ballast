import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Market, type MarketReading, type MarketsResult } from "../lib/api.ts";
import { shortAddress } from "../lib/format.ts";

const REFRESH_MS = 60_000;
/** A reading older than this is shown as stale. Matches the PriceGuard's default 6h window. */
const STALE_AFTER_S = 6 * 3600;

const STATUS_CLASS: Record<string, string> = {
  Ok: "text-ok border-ok",
  Degraded: "text-fg border-fg",
  Halted: "text-accent border-accent",
};

function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(seconds / 3600);
  if (h < 48) return `${h}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function explorer(network: string): string {
  return network === "mainnet" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
}

function Reading({ label, reading }: { label: string; reading: MarketReading | null }) {
  const stale = reading !== null && reading.ageS > STALE_AFTER_S;
  return (
    <div className="bg-bg-raised p-3">
      <dt className="text-[10px] uppercase tracking-[0.15em] text-fg-dim">{label}</dt>
      {reading ? (
        <dd className="mt-1">
          <data value={reading.value} className="block text-lg tabular-nums">
            {Number(reading.value).toFixed(6)}
          </data>
          <span className={`text-[10px] uppercase tracking-[0.1em] ${stale ? "text-accent" : "text-fg-dim"}`}>
            {formatAge(reading.ageS)} old{stale ? " / STALE" : ""}
          </span>
        </dd>
      ) : (
        <dd className="mt-1 text-xs uppercase tracking-[0.1em] text-fg-dim">NO READING</dd>
      )}
    </div>
  );
}

function MarketRow({ market, network }: { market: Market; network: string }) {
  const status = market.guarded?.status ?? null;
  const headline = market.guarded?.value ?? market.sources.issuerNav?.value ?? market.sources.redstone?.value ?? null;
  const base = explorer(network);

  return (
    <article className="border border-line bg-bg">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="text-xs uppercase tracking-[0.15em]">
          [ {market.code} / {market.ccy} ]
        </h2>
        <span
          className={`border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
            status ? (STATUS_CLASS[status] ?? "border-line text-fg-dim") : "border-line text-fg-dim"
          }`}
        >
          {status ? `GUARD: ${status}` : "SHADOW / NOT ON-CHAIN"}
        </span>
      </header>

      <div className="grid gap-px bg-line md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]">
        <div className="bg-bg-raised p-3">
          <p className="text-[10px] uppercase tracking-[0.15em] text-fg-dim">
            {market.guarded ? "Guarded price (on-chain)" : "Latest reading"}
          </p>
          {headline ? (
            <data
              value={headline}
              className="mt-1 block text-[clamp(2rem,6vw,3.5rem)] font-bold leading-[0.95] tracking-tighter tabular-nums"
            >
              {Number(headline).toFixed(4)}
            </data>
          ) : (
            <p className="mt-2 text-sm uppercase text-fg-dim">NO DATA YET</p>
          )}
          <p className="mt-2 text-[10px] uppercase tracking-[0.1em] text-fg-dim">
            {market.guarded
              ? `PUBLISHED ${formatAge(market.guarded.ageS)} AGO`
              : "WATCHED OFF-CHAIN. NO GUARDED PRICE PUBLISHED."}
          </p>
        </div>

        <dl className="grid gap-px bg-line sm:grid-cols-3">
          <Reading label="Issuer NAV" reading={market.sources.issuerNav} />
          <Reading label="RedStone feed" reading={market.sources.redstone} />
          <div className="bg-bg-raised p-3">
            <dt className="text-[10px] uppercase tracking-[0.15em] text-fg-dim">Source spread</dt>
            <dd className="mt-1">
              {market.divergenceBps !== null ? (
                <>
                  <span
                    className={`block text-lg tabular-nums ${market.divergenceBps > market.priceBandBps ? "text-accent" : ""}`}
                  >
                    {market.divergenceBps} bps
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">
                    BAND {market.priceBandBps} bps
                  </span>
                </>
              ) : (
                <span className="text-xs uppercase tracking-[0.1em] text-fg-dim">
                  {market.sourceCount} OF 2 SOURCES
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[10px] uppercase tracking-[0.1em] text-fg-dim">
        <a
          className="hover:text-fg"
          href={`${base}/asset/${market.code}-${market.issuer}`}
          target="_blank"
          rel="noreferrer"
        >
          ISSUER {shortAddress(market.issuer)} &gt;&gt;&gt;
        </a>
        <a className="hover:text-fg" href={`${base}/contract/${market.contract}`} target="_blank" rel="noreferrer">
          SAC {shortAddress(market.contract)} &gt;&gt;&gt;
        </a>
        <span>SOURCE / {market.issuerCode.toUpperCase()}</span>
      </footer>
    </article>
  );
}

/**
 * Public, read-only price page. It shows only what the API read from real sources and the
 * PriceGuard contract; an asset with no on-chain price says so instead of showing a number.
 */
export function Markets() {
  const [data, setData] = useState<MarketsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await api.markets();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed to load");
      }
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="text-sm font-bold uppercase tracking-tighter">BALLAST</span>
        <div className="flex items-center gap-3 text-xs uppercase tracking-[0.1em] text-fg-dim">
          {data && <span>NET / {data.network}</span>}
          <Link to="/login" className="border border-line px-3 py-1.5 hover:text-fg">
            Operator access
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-[clamp(2.5rem,9vw,6rem)] font-bold uppercase leading-[0.9] tracking-[-0.04em]">
          Live RWA
          <br />
          price feed
        </h1>
        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-fg-dim">
          Tokenized treasury prices read from the issuer and from RedStone's on-chain oracle, then
          checked against each other by the PriceGuard contract. Nothing on this page is simulated.
        </p>

        <div className="mt-6 border border-line p-3 text-xs leading-relaxed">
          <p className="mb-1 uppercase tracking-[0.15em] text-fg-dim">[ Trust model ]</p>
          <p className="text-fg-dim">
            Issuers publish prices as plain data; none signs them. Ballast's publisher key signs what
            it read, so the on-chain signature means &quot;Ballast saw this value from the issuer's
            API&quot;, not &quot;the issuer attested it&quot;. Lending is not open: this page is the
            price layer only.
          </p>
        </div>

        {error && <p className="mt-6 text-xs text-accent">ERROR: {error}</p>}
        {!data && !error && <p className="mt-6 text-xs uppercase tracking-wider text-fg-dim">Loading...</p>}

        {data && (
          <>
            <div className="mt-8 flex flex-col gap-4">
              {data.markets.length === 0 && (
                <p className="border border-line p-3 text-xs uppercase tracking-wider text-fg-dim">
                  NO ASSETS ARE BEING TRACKED YET.
                </p>
              )}
              {data.markets.map((m) => (
                <MarketRow key={m.code} market={m} network={data.network} />
              ))}
            </div>
            <p className="mt-6 text-[10px] uppercase tracking-[0.1em] text-fg-dim">
              REFRESHES EVERY 60S / GENERATED {new Date(data.generatedAt).toISOString()}
              {data.priceGuardContract && <> / PRICEGUARD {shortAddress(data.priceGuardContract)}</>}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
