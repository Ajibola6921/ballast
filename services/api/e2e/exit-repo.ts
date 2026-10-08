/**
 * Drives the exit desk and the repo desk end to end through the running stack.
 *
 *  - Exit: the holder asks for a quote, executes it, and receives USDC for RWA in one transaction.
 *  - Repo: the cash lender proposes, the cash borrower accepts (leg 1, atomic DvP), and nobody
 *    touches it again — `services/keeper` unwinds leg 2 at maturity on the allowance the borrower
 *    granted at settlement.
 */
import { act, assert, borrower, call, lender, login, run, seededAsset, step, units, waitFor, type Built } from "./lib.js";

interface Positions {
  exitQuotes: Array<{ id: string; status: string; usdcOut: string }>;
  repoTrades: Array<{ id: string; status: string; contractTradeId: string | null; leg1Tx: string | null; leg2Tx: string | null }>;
}

async function main() {
  step("SEP-10 login as lender and borrower");
  const lenderSession = await login(lender);
  const borrowerSession = await login(borrower);
  const positions = () =>
    call<Positions>("GET", `/v1/positions?party=${borrowerSession.partyId}`, borrowerSession.token);

  step("Waiting for an Ok price (the desks refuse to quote or settle on anything else)");
  const asset = await waitFor("an Ok price", seededAsset, (a) => a.price?.status === "Ok");

  // --- Exit desk ---------------------------------------------------------------------------
  step("Holder asks the exit desk to quote 10 RWA1");
  const quote = await call<{ id: string; usdcOut: string; spreadBps: number }>(
    "POST",
    "/v1/exit/quotes",
    borrowerSession.token,
    { assetId: asset.id, units: units(10) },
  );
  const usdcOut = BigInt(quote.usdcOut);
  // ~$1 less a 25bps spread on 10 units: a little under 10 USDC, never more.
  assert(usdcOut > BigInt(units(9)) && usdcOut < BigInt(units(10)), `quote is just under 10 USDC (got ${usdcOut})`);
  step(`  quote: ${usdcOut} stroops USDC at ${quote.spreadBps} bps spread`);

  step("Holder executes the quote");
  await act(borrowerSession, borrower, "POST", `/v1/exit/quotes/${quote.id}/execute`, {
    // Tolerate the price ticking between quote and execution, but not by more than 1%.
    minUsdcOut: ((usdcOut * 99n) / 100n).toString(),
    to: borrower.publicKey(),
  });
  const filled = (await positions()).exitQuotes.find((q) => q.id === quote.id);
  assert(filled?.status === "filled", `exit quote is filled (got ${filled?.status})`);

  // --- Repo --------------------------------------------------------------------------------
  const maturityAt = new Date(Date.now() + 150_000).toISOString();
  step("Cash lender proposes a repo: 50 TUSD against 100 RWA1 at 5%, maturing in 2.5 minutes");
  const proposed = await act<Built & { tradeId: string }>(lenderSession, lender, "POST", "/v1/repo/proposals", {
    cashLenderId: lenderSession.partyId,
    cashBorrowerId: borrowerSession.partyId,
    assetId: asset.id,
    units: units(100),
    cashAmount: units(50),
    rateBps: 500,
    kind: "intraday",
    maturityAt,
    agreementHash: "00".repeat(32),
  });
  const trade = async () => (await positions()).repoTrades.find((t) => t.id === proposed.tradeId);
  assert((await trade())?.contractTradeId != null, "proposal settled: trade has an on-chain id");

  step("Cash borrower accepts: collateral in, cash out, one transaction");
  await act(borrowerSession, borrower, "POST", `/v1/repo/proposals/${proposed.tradeId}/accept`);
  const settled = await trade();
  assert(settled?.status === "settled" && settled.leg1Tx, `trade is settled with a leg-1 tx (got ${settled?.status})`);

  step("Waiting for maturity and for services/keeper to unwind leg 2");
  const unwound = await waitFor("the keeper to unwind the repo", trade, (t) => t?.status === "unwound", 8 * 60_000);
  assert(unwound?.leg2Tx, "unwound trade records its leg-2 tx");
  step(`  leg 2 tx = ${unwound.leg2Tx}`);

  console.log(">>> Exit + repo E2E passed.");
}

run(main);
