import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth.tsx";
import { api, type AssetSummary, type BuiltTx, type RepoKind, type RepoTradeRow } from "../lib/api.ts";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";
import { Field, INPUT } from "../components/Field.tsx";
import { XdrOutput } from "../components/XdrOutput.tsx";
import { bpsToPercent, formatDecimalString, toScaled } from "../lib/format.ts";

const STATUS_TONE: Record<string, string> = {
  proposed: "text-fg border-fg",
  settled: "text-ok border-ok",
  unwound: "text-fg-dim border-line",
  failed: "text-accent border-accent",
};

/**
 * Bilateral repo. The cash lender proposes terms; the cash borrower accepts, which swaps
 * collateral for cash in one transaction; at maturity the cash comes back with interest and the
 * collateral is returned — by either party from here, or by the keeper if neither does.
 */
export function RepoView() {
  const { session } = useAuth();
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [trades, setTrades] = useState<RepoTradeRow[]>([]);
  const [tx, setTx] = useState<BuiltTx | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    if (!session) return;
    try {
      const [{ assets }, positions] = await Promise.all([
        api.assets(session.token),
        api.positions(session.token, session.partyId),
      ]);
      setAssets(assets);
      setTrades(positions.repoTrades);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load trades");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.partyId]);

  if (!session) return null;

  async function build(tradeId: string, fn: () => Promise<BuiltTx>) {
    setBusyId(tradeId);
    setError(null);
    try {
      setTx(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not build the transaction");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ProposeForm assets={assets} onBuilt={setTx} />

      {error && <p className="text-xs text-accent">ERROR: {error}</p>}
      {tx && (
        <XdrOutput
          key={tx.txHash}
          tx={tx}
          onDismiss={() => {
            setTx(null);
            reload();
          }}
        />
      )}

      <Panel title="Trades">
        {loading && <p className="text-xs text-fg-dim">LOADING...</p>}
        {!loading && trades.length === 0 && <p className="text-xs text-fg-dim">No repo trades on this account.</p>}
        <div className="flex flex-col divide-y divide-line">
          {[...trades].reverse().map((trade) => {
            const isBorrower = trade.cashBorrowerId === session.partyId;
            const matured = new Date(trade.maturityAt).getTime() <= Date.now();
            const code = assets.find((a) => a.id === trade.assetId)?.code ?? "UNITS";
            return (
              <div
                key={trade.id}
                className="grid grid-cols-1 gap-2 py-3 text-xs sm:grid-cols-[1.2fr_1fr_1fr_1.2fr_auto] sm:items-center"
              >
                <span className="text-fg-dim">
                  TRADE / {trade.id.slice(0, 8)}
                  <br />
                  <span className="text-fg">{isBorrower ? "YOU BORROW CASH" : "YOU LEND CASH"}</span>
                </span>
                <span>
                  CASH <span className="text-fg">{formatDecimalString(trade.cashAmount)}</span>
                  <br />
                  RATE <span className="text-fg">{bpsToPercent(trade.rateBps)}</span>
                </span>
                <span>
                  COLLATERAL
                  <br />
                  <span className="text-fg">
                    {formatDecimalString(trade.units)} {code}
                  </span>
                </span>
                <span>
                  {trade.kind.toUpperCase()} / MATURES
                  <br />
                  <time dateTime={trade.maturityAt} className={matured ? "text-fg" : "text-fg-dim"}>
                    {new Date(trade.maturityAt).toLocaleString()}
                  </time>
                </span>
                <div className="flex items-center gap-2 sm:justify-end">
                  <span
                    className={`border px-2 py-0.5 uppercase tracking-wider ${STATUS_TONE[trade.status] ?? "text-fg-dim border-line"}`}
                  >
                    {trade.status === "proposed" && !trade.contractTradeId ? "unsigned" : trade.status}
                  </span>
                  {trade.status === "proposed" && isBorrower && trade.contractTradeId && !matured && (
                    <Button
                      disabled={busyId === trade.id}
                      onClick={() => build(trade.id, () => api.repoAccept(session.token, trade.id))}
                    >
                      Accept
                    </Button>
                  )}
                  {trade.status === "settled" && matured && (
                    <Button
                      disabled={busyId === trade.id}
                      onClick={() => build(trade.id, () => api.repoUnwind(session.token, trade.id))}
                    >
                      Unwind
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

const KINDS: RepoKind[] = ["intraday", "overnight", "term", "open"];

function ProposeForm({ assets, onBuilt }: { assets: AssetSummary[]; onBuilt: (tx: BuiltTx) => void }) {
  const { session } = useAuth();
  const [borrower, setBorrower] = useState("");
  const [assetId, setAssetId] = useState("");
  const [units, setUnits] = useState("");
  const [cash, setCash] = useState("");
  const [ratePct, setRatePct] = useState("5");
  const [kind, setKind] = useState<RepoKind>("intraday");
  const [termHours, setTermHours] = useState("8");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asset = assets.find((a) => a.id === assetId) ?? assets[0];
  const rateBps = Math.round(Number(ratePct) * 100);
  const termMs = Math.round(Number(termHours) * 3_600_000);
  const valid = Boolean(asset && borrower.trim() && units && cash && rateBps >= 0 && termMs > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !asset) return;
    setBusy(true);
    setError(null);
    try {
      const party = await api.partyByAccount(session.token, borrower.trim());
      onBuilt(
        await api.repoPropose(session.token, {
          cashLenderId: session.partyId,
          cashBorrowerId: party.partyId,
          assetId: asset.id,
          units: toScaled(units),
          cashAmount: toScaled(cash),
          rateBps,
          kind,
          maturityAt: new Date(Date.now() + termMs).toISOString(),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not build the proposal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Propose repo / you lend cash">
      <form onSubmit={submit} className="grid grid-cols-1 gap-2 sm:grid-cols-6">
        <Field label="Cash borrower account" className="sm:col-span-3">
          <input
            value={borrower}
            onChange={(e) => setBorrower(e.target.value)}
            placeholder="G..."
            spellCheck={false}
            className={INPUT}
          />
        </Field>
        <Field label="Collateral asset" className="sm:col-span-2">
          <select value={asset?.id ?? ""} onChange={(e) => setAssetId(e.target.value)} className={INPUT}>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as RepoKind)} className={INPUT}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Collateral units" className="sm:col-span-2">
          <input value={units} onChange={(e) => setUnits(e.target.value)} placeholder="1000.00" inputMode="decimal" className={INPUT} />
        </Field>
        <Field label="Cash amount" className="sm:col-span-2">
          <input value={cash} onChange={(e) => setCash(e.target.value)} placeholder="900.00" inputMode="decimal" className={INPUT} />
        </Field>
        <Field label="Rate %">
          <input value={ratePct} onChange={(e) => setRatePct(e.target.value)} inputMode="decimal" className={INPUT} />
        </Field>
        <Field label="Term h">
          <input value={termHours} onChange={(e) => setTermHours(e.target.value)} inputMode="decimal" className={INPUT} />
        </Field>
        <div className="sm:col-span-6">
          <Button type="submit" disabled={busy || !valid}>
            {busy ? "BUILDING..." : "BUILD PROPOSAL TX"}
          </Button>
        </div>
      </form>
      <p className="mt-2 text-xs text-fg-dim">
        /// Signing the proposal authorizes the contract to pay the cash out of your wallet when the borrower accepts.
      </p>
      {error && <p className="mt-2 text-xs text-accent">ERROR: {error}</p>}
    </Panel>
  );
}
