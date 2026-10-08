/**
 * Drives the collateral rail end to end through the running stack — `services/api` for every
 * action, `services/price-guard` for the price and `services/keeper` for the collateral sync —
 * rather than calling the contracts directly the way `scripts/e2e-smoke.sh` does.
 *
 * It plays both customers. Each one logs in with real SEP-10, asks the API for unsigned XDR,
 * signs it locally with its own key (the API never sees a secret), and hands it back to
 * `POST /v1/tx/submit` (see `lib.ts`). Run it via `scripts/e2e-services.sh`.
 */
import {
  RWA_SAC,
  UNIT,
  act,
  assert,
  borrower,
  call,
  lender,
  login,
  run,
  seededAsset,
  step,
  waitFor,
  type Built,
  type LineDetail,
} from "./lib.js";

async function main() {
  step("SEP-10 login as lender and borrower");
  const lenderSession = await login(lender);
  const borrowerSession = await login(borrower);

  const asset = await seededAsset();

  const counterparty = await call<{ partyId: string }>(
    "GET",
    `/v1/parties/by-account/${borrower.publicKey()}`,
    lenderSession.token,
  );
  assert(counterparty.partyId === borrowerSession.partyId, "borrower lookup resolves the borrower's party");

  step("Lender opens a 1,000 TUSD line at 7% APR");
  const opened = await act<Built & { creditLineId: string }>(lenderSession, lender, "POST", "/v1/credit-lines", {
    lenderId: lenderSession.partyId,
    borrowerId: borrowerSession.partyId,
    loanCcy: "TUSD",
    limit: (1000n * UNIT).toString(),
    rateBps: 700,
    feeBps: 0,
    cureWindowS: 86400,
    asset: RWA_SAC,
    agreementHash: "00".repeat(32),
  });
  const linePath = `/v1/credit-lines/${opened.creditLineId}`;
  const readLine = () => call<LineDetail>("GET", linePath, borrowerSession.token);

  let line = await readLine();
  assert(line.contractLineId !== null && line.status === "open", "open settled: line has an on-chain id");
  step(`  on-chain line id = ${line.contractLineId}`);

  step("Lender funds it with 50 TUSD");
  await act(lenderSession, lender, "POST", `${linePath}/fund`, { amount: (50n * UNIT).toString() });
  line = await readLine();
  assert(line.funded === (50n * UNIT).toString(), `funded is 50 TUSD on-chain (got ${line.funded})`);

  step("Borrower pledges 100 RWA1, then another 50");
  const first = await act<Built & { pledgeId: string }>(borrowerSession, borrower, "POST", `${linePath}/pledges`, {
    assetId: asset.id,
    units: (100n * UNIT).toString(),
    custodyMode: "escrow",
  });
  const second = await act<Built & { pledgeId: string }>(borrowerSession, borrower, "POST", `${linePath}/pledges`, {
    assetId: asset.id,
    units: (50n * UNIT).toString(),
    custodyMode: "escrow",
  });

  step("Waiting for services/keeper to sync collateral and services/price-guard to publish an Ok price");
  line = await waitFor(
    "synced collateral and an Ok price",
    readLine,
    // 150 RWA1 at ~$1 with a 5% haircut is ~142.5; anything over 140 means both pledges counted.
    (l) => l.priceStatus === "Ok" && BigInt(l.collateralValue ?? "0") > 140n * UNIT,
  );
  step(`  collateral value = ${line.collateralValue}, price = ${line.priceStatus}`);
  const collateralBefore = BigInt(line.collateralValue ?? "0"); // 150 RWA1 at the live price

  step("Borrower draws 20 TUSD");
  await act(borrowerSession, borrower, "POST", `${linePath}/draws`, {
    amount: (20n * UNIT).toString(),
    to: borrower.publicKey(),
  });
  line = await readLine();
  assert(BigInt(line.drawn) >= 20n * UNIT, `debt is at least 20 TUSD after the draw (got ${line.drawn})`);
  assert(line.marginState === "Healthy", `line is Healthy after the draw (got ${line.marginState})`);
  step(`  debt = ${line.drawn}, ltv = ${line.ltvBps} bps, ${line.marginState}`);

  step("Borrower repays 20 TUSD");
  await act(borrowerSession, borrower, "POST", `${linePath}/repayments`, { amount: (20n * UNIT).toString() });
  line = await readLine();
  // Interest is paid first, so the few stroops accrued since the draw are still owed as principal.
  assert(BigInt(line.drawn) < UNIT / 100n, `only interest dust is left after repaying (got ${line.drawn})`);

  step("Borrower releases the 50 RWA1 pledge");
  await act(borrowerSession, borrower, "DELETE", `${linePath}/pledges/${second.pledgeId}`);

  step("Checking the books");
  const positions = await call<{ pledges: Array<{ id: string; status: string }> }>(
    "GET",
    `/v1/positions?party=${borrowerSession.partyId}`,
    borrowerSession.token,
  );
  const statusOf = (id: string) => positions.pledges.find((p) => p.id === id)?.status;
  assert(statusOf(first.pledgeId) === "active", "first pledge is active");
  assert(statusOf(second.pledgeId) === "released", "second pledge is released");

  const today = new Date().toISOString().slice(0, 10);
  const report = await call<{
    draws: Array<{ creditLineId: string; amount: string }>;
    repayments: Array<{ creditLineId: string; principal: string; interest: string }>;
  }>("GET", `/v1/reports/daily?date=${today}`, lenderSession.token);
  const draws = report.draws.filter((d) => d.creditLineId === opened.creditLineId);
  const repayments = report.repayments.filter((r) => r.creditLineId === opened.creditLineId);
  assert(draws.length === 1 && Number(draws[0].amount) === 20, "one 20 TUSD draw is booked");
  assert(repayments.length === 1, "one repayment is booked");
  assert(
    Math.abs(Number(repayments[0].principal) + Number(repayments[0].interest) - 20) < 1e-6,
    "repayment principal + interest add up to the 20 TUSD paid",
  );
  step(`  repayment booked as principal ${repayments[0].principal} + interest ${repayments[0].interest}`);

  step("Waiting for the keeper to sync the release (100 RWA1 left)");
  line = await waitFor(
    "collateral to drop after the release",
    readLine,
    // 100 of the 150 RWA1 remain: about two thirds of the value, with room for the price to tick.
    (l) => BigInt(l.collateralValue ?? "0") < (collateralBefore * 70n) / 100n,
  );
  step(`  collateral value = ${line.collateralValue}`);

  step("Lender takes the repaid interest and the undrawn funding back out");
  const readAsLender = () => call<LineDetail>("GET", linePath, lenderSession.token);
  line = await readAsLender();
  const interest = BigInt(line.claimableInterest ?? "0");
  const undrawn = BigInt(line.undrawn ?? "0");
  assert(interest > 0n, `the interest the borrower paid is claimable (got ${interest})`);
  // The 20 repaid paid the interest first, so a few stroops of principal are still out on loan.
  assert(
    undrawn > 50n * UNIT - UNIT / 100n && undrawn <= 50n * UNIT,
    `the funded 50 TUSD is undrawn again, less the dust of principal still owed (got ${undrawn})`,
  );
  await act(lenderSession, lender, "POST", `${linePath}/withdrawals`, { kind: "interest", amount: interest.toString() });
  await act(lenderSession, lender, "POST", `${linePath}/withdrawals`, { kind: "undrawn", amount: undrawn.toString() });
  line = await waitFor(
    "nothing left to withdraw",
    readAsLender,
    (l) => BigInt(l.undrawn ?? "1") === 0n && BigInt(l.claimableInterest ?? "1") === 0n,
  );
  step(`  withdrew ${interest} interest and ${undrawn} principal`);

  console.log(">>> Services E2E passed.");
}

run(main);
