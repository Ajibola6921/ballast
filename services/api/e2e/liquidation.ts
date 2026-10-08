/**
 * Drives a credit line all the way through liquidation. The borrower draws against healthy
 * collateral, then the risk admin tightens the line's margin thresholds until the real LTV is over
 * the liquidation level. Real market prices do not fall 38% on demand, so the breach is created by
 * moving the threshold, not the price, which stays whatever the live sources report. From there no
 * customer does anything: `services/margin-monitor` records the state change, and
 * `services/keeper` arms the breach, waits out the cure window, liquidates the line and sends the
 * collateral to the lender. The lender then closes the line, which books the outcome on-chain and
 * pays the borrower the surplus, and withdraws the funding that was never drawn.
 *
 * Run via `scripts/e2e-liquidation.sh`, which puts the original thresholds back on exit.
 */
import { execFileSync } from "node:child_process";
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

const CURE_WINDOW_S = 60;

/** Overwrites CreditLine's margin thresholds for the test asset (admin-only on-chain). */
function setThresholds(warningBps: number, marginCallBps: number, liquidationBps: number): void {
  execFileSync(
    "stellar",
    [
      "contract", "invoke", "--id", required("CREDIT_LINE_CID"), "--source", "admin",
      "--network", required("NETWORK"), "--", "configure_asset",
      "--admin", required("ADMIN"), "--asset", RWA_SAC, "--price_guard", required("PRICE_GUARD_CID"),
      "--usdc", required("USDC_SAC"), "--haircut_bps", "500",
      "--thresholds", JSON.stringify({ warning_bps: warningBps, margin_call_bps: marginCallBps, liquidation_bps: liquidationBps }),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

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

  step("Waiting for synced collateral and an Ok price, then drawing 60 TUSD (~59% LTV at USTRY's ~$1.08)");
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

  const ltv = line.ltvBps ?? 0;
  step(`Risk tightens the line's thresholds below its real LTV of ${ltv} bps (the price itself is unchanged)`);
  assert(ltv > 1500, `the line has a meaningful LTV to breach (got ${ltv} bps)`);
  setThresholds(ltv - 1200, ltv - 700, ltv - 200);

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

  step("Lender closes the liquidated line: the contract books the outcome at the price it confirmed");
  await act(lenderSession, lender, "POST", `${linePath}/close-liquidation`);
  line = await waitFor("the line to be closed", readLine, (l) => l.status === "closed");
  const outcome = line.liquidation;
  assert(outcome?.closed, "the contract recorded a closed liquidation");
  const debt = BigInt(outcome.debt);
  const recovered = BigInt(outcome.recovered);
  assert(debt >= 60n * UNIT && debt < 61n * UNIT, `debt at liquidation is the 60 TUSD drawn plus dust interest (got ${debt})`);
  // 100 RWA1 valued at the guarded price, no haircut: well above the 60 TUSD owed.
  assert(recovered > debt, `the collateral (${recovered}) covers the debt (${debt})`);
  assert(BigInt(outcome.surplus) === recovered - debt && BigInt(outcome.shortfall) === 0n, "surplus is exactly collateral minus debt");
  step(`  debt ${debt}, collateral ${recovered}, surplus paid to the borrower ${outcome.surplus}`);

  step("Lender withdraws the funding that was never drawn");
  const undrawn = BigInt(line.undrawn ?? "0");
  assert(undrawn === 20n * UNIT, `20 of the 80 TUSD funded was never drawn (got ${undrawn})`);
  await act(lenderSession, lender, "POST", `${linePath}/withdrawals`, { kind: "undrawn", amount: undrawn.toString() });
  line = await waitFor("the undrawn balance to reach zero", readLine, (l) => BigInt(l.undrawn ?? "1") === 0n);

  console.log(">>> Liquidation E2E passed.");
}

run(main);
