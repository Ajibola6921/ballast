import { useState } from "react";
import { signTransaction } from "@stellar/freighter-api";
import { api, type BuiltTx, type TxResult } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import { shortAddress } from "../lib/format.ts";
import { Button } from "./Button.tsx";

type Phase = "ready" | "signing" | "submitting" | "pending" | "settled" | "failed";

const PHASE_LABEL: Record<Phase, string> = {
  ready: "UNSIGNED TRANSACTION READY",
  signing: "AWAITING WALLET SIGNATURE",
  submitting: "SUBMITTED / AWAITING LEDGER CLOSE",
  pending: "SUBMITTED / NOT CLOSED YET",
  settled: "SETTLED ON-CHAIN",
  failed: "FAILED ON-CHAIN",
};

/**
 * Ballast never holds customer signing keys (PRD §9) - every state-changing API call returns
 * unsigned XDR. This panel is where it gets signed and sent: Freighter signs the envelope in the
 * extension, the signed envelope goes back to `POST /v1/tx/submit`, and the API reports how it
 * ended. The raw XDR stays visible and copyable for anyone who would rather sign it elsewhere
 * (`stellar tx sign`); no secret key is ever handled in this browser.
 */
export function XdrOutput({ tx, onDismiss }: { tx: BuiltTx; onDismiss: () => void }) {
  const { session } = useAuth();
  const [phase, setPhase] = useState<Phase>("ready");
  const [result, setResult] = useState<TxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function apply(next: TxResult) {
    setResult(next);
    setPhase(next.status);
  }

  async function signAndSubmit() {
    if (!session) return;
    setError(null);
    setPhase("signing");
    try {
      const signed = await signTransaction(tx.xdr, {
        address: session.stellarAccount,
        networkPassphrase: import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE,
      });
      if (signed.error) throw new Error(signed.error.message ?? "wallet declined to sign");
      setPhase("submitting");
      apply(await api.submitTx(session.token, signed.signedTxXdr));
    } catch (err) {
      setError(err instanceof Error ? err.message : "signing failed");
      setPhase("ready");
    }
  }

  async function recheck() {
    if (!session) return;
    setError(null);
    try {
      apply(await api.settleTx(session.token, tx.txHash));
    } catch (err) {
      setError(err instanceof Error ? err.message : "status check failed");
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(tx.xdr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const busy = phase === "signing" || phase === "submitting";
  const tone = phase === "failed" ? "border-accent text-accent" : "border-ok text-ok";

  return (
    <div className={`border bg-bg p-3 ${tone.split(" ")[0]}`} aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-3">
        <output className={`text-xs uppercase tracking-[0.15em] ${tone.split(" ")[1]}`}>
          &gt;&gt;&gt; {PHASE_LABEL[phase]}
        </output>
        <button onClick={onDismiss} className="text-xs text-fg-dim hover:text-fg" aria-label="Dismiss">
          [ X ]
        </button>
      </div>

      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs uppercase tracking-wider">
        <dt className="text-fg-dim">TX</dt>
        <dd className="truncate text-fg">
          <samp>{shortAddress(tx.txHash)}</samp>
        </dd>
        {result?.ledger != null && (
          <>
            <dt className="text-fg-dim">LEDGER</dt>
            <dd className="text-fg">
              <samp>{result.ledger}</samp>
            </dd>
          </>
        )}
      </dl>

      {phase === "ready" && (
        <textarea
          readOnly
          value={tx.xdr}
          rows={3}
          aria-label="Unsigned transaction XDR"
          className="mb-2 w-full resize-none border border-line bg-bg-raised p-2 text-xs text-fg-dim"
        />
      )}

      {error && <p className="mb-2 text-xs text-accent">ERROR: {error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-dim">
          {phase === "settled" && "Books updated. Dismiss to refresh positions."}
          {phase === "failed" && "The network rejected this transaction; nothing moved."}
          {phase === "pending" && "Sent, but no verdict yet. Check again in a few seconds."}
          {(phase === "ready" || busy) && "Signed in your wallet. Your key never reaches Ballast."}
        </p>
        <div className="flex gap-2">
          {phase === "ready" && <Button onClick={copy}>{copied ? "COPIED" : "COPY XDR"}</Button>}
          {(phase === "ready" || busy) && (
            <Button onClick={signAndSubmit} disabled={busy}>
              {busy ? "WORKING..." : "SIGN + SUBMIT"}
            </Button>
          )}
          {phase === "pending" && <Button onClick={recheck}>CHECK STATUS</Button>}
          {(phase === "settled" || phase === "failed") && <Button onClick={onDismiss}>DONE</Button>}
        </div>
      </div>
    </div>
  );
}
