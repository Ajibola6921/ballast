/**
 * Drives a credit line all the way through liquidation. The borrower draws against healthy
 * collateral, the (mock) price then falls far enough to put the line over the liquidation
 * threshold, and from there no customer does anything: `services/price-guard` publishes the new
 * price, `services/margin-monitor` records the state change, and `services/keeper` arms the
 * breach, waits out the cure window, liquidates the line and sends the collateral to the lender.
 *
 * Run via `scripts/e2e-liquidation.sh`, which widens the price guard's daily-move band first (a
 * 38% one-step drop would otherwise halt the price rather than move it) and puts it back after.
 */
import { writeFileSync } from "node:fs";
import {
  RWA_SAC,
  UNIT,
  act,
  assert,
  borrower,
  call,
  lender,
  login,
  required,
  run,
  seededAsset,
  step,
  units,
  waitFor,
  type Built,
  type LineDetail,
} from "./lib.js";

const MOCK_PRICE_FILE = required("MOCK_PRICE_FILE");
const CURE_WINDOW_S = 60;

async function main() {
  const lenderSession = await login(lender);
  const borrowerSession = await login(borrower);
  const asset = await seededAsset();

  step(`Lender opens and funds a line with a ${CURE_WINDOW_S}s cure window; borrower pledges 100 RWA1`);
  const opened = await act<Built & { creditLineId: string }>(lenderSession, lender, "POST", "/v1/credit-lines", {
    lenderId: lenderSession.partyId,
    borrowerId: borrowerSession.partyId,
    loanCcy: "TUSD",
    limit: units(1000),
    rateBps: 700,
    feeBps: 0,
    cureWindowS: CURE_WINDOW_S,
    asset: RWA_SAC,
    agreementHash: "00".repeat(32),
  });
  const linePath = `/v1/credit-lines/${opened.creditLineId}`;
  const readLine = () => call<LineDetail>("GET", linePath, borrowerSession.token);

  await act(lenderSession, lender, "POST", `${linePath}/fund`, { amount: units(80) });
  const pledge = await act<Built & { pledgeId: string }>(borrowerSession, borrower, "POST", `${linePath}/pledges`, {
    assetId: asset.id,
    units: units(100),
    custodyMode: "escrow",
  });

  step("Waiting for synced collateral and an Ok price, then drawing 60 TUSD (~63% LTV)");
  await waitFor(
    "synced collateral and an Ok price",
    readLine,
    (l) => l.priceStatus === "Ok" && BigInt(l.collateralValue ?? "0") > 90n * UNIT,
  );
  await act(borrowerSession, borrower, "POST", `${linePath}/draws`, {
    amount: units(60),
    to: borrower.publicKey(),
  });
  let line = await readLine();
  assert(line.marginState === "Healthy", `line is Healthy after the draw (got ${line.marginState})`);

  step("Price falls to $0.62: 100 RWA1 is now worth ~58.9 after the haircut, against 60 of debt");
  writeFileSync(MOCK_PRICE_FILE, JSON.stringify({ [asset.code]: "0.62" }));

  line = await waitFor(
    "the contract to see a liquidation-level LTV",
    readLine,
    (l) => l.marginState === "Liquidation" && l.priceStatus === "Ok",
  );
  step(`  ltv = ${line.ltvBps} bps, ${line.marginState}`);

  step("Waiting for services/keeper to arm the breach, sit out the cure window, and liquidate");
  line = await waitFor("the line to be liquidated", readLine, (l) => l.status === "liquidating", 10 * 60_000);

  step("Checking the books");
  const positions = await call<{ pledges: Array<{ id: string; status: string }> }>(
    "GET",
    `/v1/positions?party=${borrowerSession.partyId}`,
    borrowerSession.token,
  );
  const pledgeStatus = positions.pledges.find((p) => p.id === pledge.pledgeId)?.status;
  assert(pledgeStatus === "liquidated", `pledge is liquidated (got ${pledgeStatus})`);

  const today = new Date().toISOString().slice(0, 10);
  const report = await call<{
    liquidations: Array<{ creditLineId: string; units: string; route: string; txHashes: string[] }>;
    marginEvents: Array<{ creditLineId: string; toState: string }>;
  }>("GET", `/v1/reports/daily?date=${today}`, lenderSession.token);
  const liquidation = report.liquidations.find((l) => l.creditLineId === opened.creditLineId);
  assert(liquidation, "a liquidation is booked for the line");
  assert(Number(liquidation.units) === 100 && liquidation.route === "transfer", "it moved all 100 RWA1 by transfer");
  assert(liquidation.txHashes.length === 2, "it records both the CreditLine and the PledgeVault transaction");
  assert(
    report.marginEvents.some((e) => e.creditLineId === opened.creditLineId && e.toState === "Liquidation"),
    "margin-monitor recorded the move into Liquidation",
  );
  step(`  liquidated ${liquidation.units} RWA1 to the lender; txs ${liquidation.txHashes.join(", ")}`);

  console.log(">>> Liquidation E2E passed.");
}

run(main);
