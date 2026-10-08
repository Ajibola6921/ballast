#!/usr/bin/env bash
# End-to-end liquidation drill against the running stack: a borrower draws, the price collapses,
# and the services liquidate the line on their own (see services/api/e2e/liquidation.ts).
#
# Usage:
#   scripts/e2e-liquidation.sh [network]     # network defaults to `testnet`
#
# Prerequisites: `scripts/dev-setup.sh [network]` has been run and `pnpm dev` is up, with
# PRICE_GUARD_MODE=mock (the price move is injected through MOCK_PRICE_FILE).
#
# This deliberately disturbs shared state for a few minutes: it widens PriceGuard's daily-move
# band for the test asset (a one-step 38% drop would otherwise *halt* the price - which is the
# guard doing its job - instead of moving it) and drops the mock price. Both are put back on
# exit, pass or fail. Every other open line on the deployment sees the same price while it runs.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-testnet}

set -a
# shellcheck source=/dev/null
source ".env.${NETWORK}-deploy"
# shellcheck source=/dev/null
source .env
set +a

[[ "${PRICE_GUARD_MODE:-mock}" == "mock" ]] || { echo "!!! needs PRICE_GUARD_MODE=mock" >&2; exit 1; }
[[ -n "${MOCK_PRICE_FILE:-}" ]] || { echo "!!! MOCK_PRICE_FILE is not set in .env (re-run dev-setup.sh)" >&2; exit 1; }

log() { echo ">>> $*"; }

retry() {
  local -i attempt=1
  until "$@"; do
    if (( attempt >= 6 )); then echo "!!! command failed: $*" >&2; return 1; fi
    attempt+=1
    sleep 3
  done
}

set_band() {
  retry stellar contract invoke --id "$PRICE_GUARD_CID" --source admin --network "$NETWORK" -- configure_asset \
    --admin "$ADMIN" --asset "$RWA_SAC" --band_bps 50 --daily_move_band_bps "$1" --max_staleness_s 3600 >/dev/null
}

guarded_price() {
  # Sent as a real transaction on purpose: PriceGuard only moves its "last good" baseline when
  # guarded_price runs on-chain, and the band below is measured against that baseline.
  retry stellar contract invoke --id "$PRICE_GUARD_CID" --source admin --network "$NETWORK" --send=yes -- \
    guarded_price --asset "$RWA_SAC" 2>/dev/null
}

restore() {
  log "Restoring the mock price and PriceGuard's 1% daily-move band"
  rm -f "$MOCK_PRICE_FILE"
  # Wait for price-guard to publish ~$1 again and for the contract to adopt it as its baseline
  # *before* narrowing the band - narrowing first would make the recovery itself trip a halt.
  for _ in $(seq 1 30); do
    if guarded_price | grep -q '"status":"Ok","ts":[0-9]*,"value":"\(99\|100\)'; then break; fi
    sleep 10
  done
  set_band 100
}
trap restore EXIT

log "Widening PriceGuard's daily-move band for the drill"
set_band 9000

LENDER_SECRET=$(stellar keys secret lender) \
BORROWER_SECRET=$(stellar keys secret borrower) \
API_URL="http://localhost:${API_PORT:-3000}" \
  pnpm --filter @ballast/service-api exec tsx e2e/liquidation.ts
