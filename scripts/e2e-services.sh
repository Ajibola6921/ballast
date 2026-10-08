#!/usr/bin/env bash
# End-to-end test of the running stack (API + price-guard + keeper + Postgres + a live network).
# Collateral rail: open -> fund -> pledge -> draw -> repay -> release. Exit desk: quote ->
# execute. Repo: propose -> accept -> keeper unwinds at maturity. Every customer transaction is
# built by services/api, signed here with the lender's/borrower's own key, and submitted back
# through the API. (Liquidation has its own script, e2e-liquidation.sh - it moves the price.)
#
# Usage:
#   scripts/e2e-services.sh [network]     # network defaults to `testnet`
#
# Prerequisites: `scripts/dev-setup.sh [network]` has been run and `pnpm dev` is up. Unlike
# `e2e-smoke.sh`, which calls the contracts directly, this exercises the services themselves -
# see scripts/README.md.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-testnet}

set -a
# shellcheck source=/dev/null
source ".env.${NETWORK}-deploy"
# shellcheck source=/dev/null
source .env
set +a

# The customers' keys stay in the stellar CLI's identity store; they're handed to the test
# processes only, never to any service.
export LENDER_SECRET BORROWER_SECRET API_URL
LENDER_SECRET=$(stellar keys secret lender)
BORROWER_SECRET=$(stellar keys secret borrower)
API_URL="http://localhost:${API_PORT:-3000}"

pnpm --filter @ballast/service-api exec tsx e2e/collateral-rail.ts
pnpm --filter @ballast/service-api exec tsx e2e/exit-repo.ts
