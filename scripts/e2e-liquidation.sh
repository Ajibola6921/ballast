#!/usr/bin/env bash
# End-to-end liquidation drill against the running stack: a borrower draws, the line's margin
# thresholds are tightened below its real LTV, and the services liquidate the line on their own
# (see services/api/e2e/liquidation.ts).
#
# Usage:
#   scripts/e2e-liquidation.sh [network]     # network defaults to `testnet`
#
# Prerequisites: `scripts/dev-setup.sh [network]` has been run and `pnpm dev` is up.
#
# The price is NOT touched - it stays whatever Etherfuse and RedStone report for USTRY. Real
# prices do not drop on demand, so the drill moves the liquidation threshold under the real LTV
# instead. That threshold is shared by every line on the asset, so other open lines see it too
# while the drill runs; the original thresholds are put back on exit, pass or fail.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-testnet}

set -a
# shellcheck source=/dev/null
source ".env.${NETWORK}-deploy"
# shellcheck source=/dev/null
source .env
set +a

log() { echo ">>> $*"; }

retry() {
  local -i attempt=1
  until "$@"; do
    if (( attempt >= 6 )); then echo "!!! command failed: $*" >&2; return 1; fi
    attempt+=1
    sleep 3
  done
}

restore() {
  log "Restoring CreditLine's margin thresholds (70% warning, 80% margin call, 90% liquidation)"
  retry stellar contract invoke --id "$CREDIT_LINE_CID" --source admin --network "$NETWORK" -- configure_asset \
    --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$PRICE_GUARD_CID" --usdc "$USDC_SAC" \
    --haircut_bps 500 --thresholds '{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}' >/dev/null
}
trap restore EXIT

LENDER_SECRET=$(stellar keys secret lender) \
BORROWER_SECRET=$(stellar keys secret borrower) \
API_URL="http://localhost:${API_PORT:-3000}" \
  pnpm --filter @ballast/service-api exec tsx e2e/liquidation.ts
