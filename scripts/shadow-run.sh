#!/usr/bin/env bash
# Stage A shadow run: watch the REAL mainnet assets in scripts/shadow-assets.json with the real
# sources (Etherfuse price API + RedStone mainnet feeds) and publish nothing. Every minute
# services/price-guard records both readings in `price_observation` and alerts when issuer NAV and
# the oracle disagree by more than the asset's band. No contract, publisher key or funds involved.
#
# Usage:
#   DATABASE_URL=postgres://... scripts/shadow-run.sh
#
# Needs a Postgres reachable at DATABASE_URL (scripts/dev-setup.sh starts one named `ballast-pg`;
# `postgres://ballast:ballast@localhost:5432/ballast` matches it). Review the result with:
#   select a.code, o.source, o.value, o.observed_at
#   from price_observation o join asset a on a.id = o.asset_id order by o.observed_at desc limit 20;

set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?set DATABASE_URL to a Postgres with the Ballast schema (pnpm --filter @ballast/db migrate)}"

FEEDS=$(node -e '
  const assets = JSON.parse(require("fs").readFileSync("scripts/shadow-assets.json", "utf8"));
  console.log(JSON.stringify(Object.fromEntries(assets.map((a) => [a.code, a.feed]))));')

export PRICE_GUARD_PUBLISH=false
export NODE_OPTIONS=${NODE_OPTIONS:---network-family-autoselection-attempt-timeout=5000}
export STELLAR_NETWORK=mainnet
export STELLAR_RPC_URL=${STELLAR_RPC_URL:-https://mainnet.sorobanrpc.com}
export STELLAR_HORIZON_URL=${STELLAR_HORIZON_URL:-https://horizon.stellar.org}
export STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
# Any valid G-address: reads are simulated and never submitted, so it need not exist or hold funds.
export STELLAR_SIMULATION_SOURCE=${STELLAR_SIMULATION_SOURCE:-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN}
export REDSTONE_FEED_CONTRACT_IDS="$FEEDS"

pnpm --filter @ballast/db migrate
pnpm --filter @ballast/service-price-guard shadow:seed
exec pnpm --filter @ballast/service-price-guard dev
