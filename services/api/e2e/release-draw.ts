/**
 * Regression drill for the release-then-draw race. A borrower who releases collateral and
 * immediately draws must be judged against the collateral that is left, not the collateral the
 * credit line counted a moment ago. Before the vault reported every change to the credit line in
 * the same transaction, the figure only moved when the keeper's sync job ran, and this draw went
 * through, leaving the lender funding a line whose real LTV was far past liquidation.
 *
 *  1. open and fund a line; pledge 60 RWA1 and then 40 more (two pledges)
 *  2. draw 20 TUSD (about 20% LTV)
 *  3. release the 40: the remaining 60 still cover the debt, so the vault allows it
 *  4. draw another 40 straight away: against the 60 units left that is about 98% LTV, so it must fail
 *  5. a draw the remaining collateral does support (10) still works
 *
 * Run via `scripts/e2e-services.sh`.
 */
import { UNIT, act, assert, borrower, call, lender, login, run, seededAsset, step, units, waitFor, type Built, type LineDetail } from "./lib.js";

async function main() {
  const lenderSession = await login(lender);
  const borrowerSession = await login(borrower);
  const asset = await waitFor("an Ok price", seededAsset, (a) => a.price?.status === "Ok");

  step("Lender opens and funds a line; borrower pledges 60 and then 40 RWA1");
  const opened = await act<Built & { creditLineId: string }>(lenderSession, lender, "POST", "/v1/credit-lines", {
    lenderId: lenderSession.partyId,
    borrowerId: borrowerSession.partyId,
    loanCcy: "TUSD",
    limit: units(1000),
    rateBps: 700,
    feeBps: 0,
    cureWindowS: 86_400,
    asset: asset.contractC,
    agreementHash: "00".repeat(32),
  });
  const linePath = `/v1/credit-lines/${opened.creditLineId}`;
  const readLine = () => call<LineDetail>("GET", linePath, borrowerSession.token);
  await act(lenderSession, lender, "POST", `${linePath}/fund`, { amount: units(100) });
  const pledge = (n: number) =>
    act<Built & { pledgeId: string }>(borrowerSession, borrower, "POST", `${linePath}/pledges`, {
      assetId: asset.id,
      units: units(n),
      custodyMode: "escrow",
    });
  await pledge(60);
  const second = await pledge(40);

  // Nothing waits on the keeper: the vault reports each change to the credit line itself.
  step("Both pledges count at once (reported by the vault, not by a periodic sync)");
  let line = await readLine();
  const price = Number(asset.price?.value);
  const fullValue = BigInt(Math.round(100 * price * 0.95 * Number(UNIT)));
  const counted = BigInt(line.collateralValue ?? "0");
  assert(counted > (fullValue * 99n) / 100n, `100 RWA1 are counted straight away (got ${counted}, expected about ${fullValue})`);

  await act(borrowerSession, borrower, "POST", `${linePath}/draws`, { amount: units(20), to: borrower.publicKey() });

  step("Borrower releases the 40 RWA1, then tries to draw 40 TUSD in the next breath");
  await act(borrowerSession, borrower, "DELETE", `${linePath}/pledges/${second.pledgeId}`);
  line = await readLine();
  const left = BigInt(line.collateralValue ?? "0");
  assert(left < (fullValue * 65n) / 100n, `the credit line already sees only the 60 RWA1 left (got ${left})`);

  let drewAnyway = false;
  try {
    await act(borrowerSession, borrower, "POST", `${linePath}/draws`, { amount: units(40), to: borrower.publicKey() });
    drewAnyway = true;
  } catch {
    // Refused at build time or on submission: either way the draw did not happen.
  }
  assert(!drewAnyway, "a draw the remaining collateral cannot support is refused");
  line = await readLine();
  assert(BigInt(line.drawn) < 21n * UNIT, `debt is still about 20 TUSD (got ${line.drawn})`);

  step("A draw the remaining collateral does support still works");
  await act(borrowerSession, borrower, "POST", `${linePath}/draws`, { amount: units(10), to: borrower.publicKey() });
  line = await readLine();
  assert(BigInt(line.drawn) >= 30n * UNIT, `debt is now about 30 TUSD (got ${line.drawn})`);

  console.log(">>> Release-then-draw E2E passed.");
}

run(main);
