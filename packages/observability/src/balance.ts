import type { Alerter } from "./metrics.js";

/** Below this many XLM an operator account is about to be unable to pay fees. */
export const DEFAULT_MIN_XLM = 20;

/**
 * XLM balance of `account` per Horizon, or 0 when the account does not exist on the network (an
 * unfunded operator is exactly the case to alert on). Throws on any other failure, so a Horizon
 * outage is not reported as an empty wallet.
 */
export async function nativeBalanceXlm(
  horizonUrl: string,
  account: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl(`${horizonUrl.replace(/\/+$/, "")}/accounts/${account}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`Horizon responded ${res.status} for ${account}`);
  const body = (await res.json()) as { balances: Array<{ asset_type: string; balance: string }> };
  const native = body.balances.find((b) => b.asset_type === "native");
  return native ? Number(native.balance) : 0;
}

/**
 * Fires `operator_balance_low` when an operator account (keeper, price publisher, payout hop) is
 * running short of XLM for fees. The keeper and publisher sign every transaction they send, so a
 * dry account silently stops margin calls, liquidations and price updates. Returns the balance, or
 * null if Horizon could not be reached (the failure is logged, not alerted as a low balance).
 */
export async function checkOperatorBalance(
  alerter: Alerter,
  args: { horizonUrl: string; account: string; label: string; minXlm?: number; fetchImpl?: typeof fetch },
): Promise<number | null> {
  const minXlm = args.minXlm ?? Number(process.env.OPERATOR_MIN_XLM ?? DEFAULT_MIN_XLM);
  let balance: number;
  try {
    balance = await nativeBalanceXlm(args.horizonUrl, args.account, args.fetchImpl);
  } catch (err) {
    console.error(`[balance] could not read ${args.label} balance: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (balance < minXlm) {
    alerter.fire("operator_balance_low", {
      account: args.account,
      code: args.label,
      balanceXlm: balance,
      minXlm,
      reason: `${args.label} account ${args.account} has ${balance} XLM (alert below ${minXlm})`,
    });
  }
  return balance;
}
