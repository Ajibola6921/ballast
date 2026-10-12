# @ballast/domain-types

Plain TypeScript types and a few pure functions that describe Ballast's domain: prices, assets,
credit lines, margin states, exits, repos and webhook events. No runtime dependencies. Several
pieces deliberately mirror the Rust in `contracts/common`.

## Exports

- Money: `scaledToDecimalString(raw)` and `decimalStringToScaled(decimal)` convert between on-chain
  7-decimal bigints and the decimal strings Postgres `numeric` columns return. Skipping them is off by
  a factor of 1e7.
- Prices: `PRICE_SCALE` (10^7), `PriceStatus`, `GuardedPrice`, `PriceSourceReading`,
  `isUsableForNewRisk`, `isUsableForLiquidation` (both true only for status `Ok`).
- Risk: `BPS_DENOMINATOR`, `collateralValue(units, price, haircutBps)` and `ltvBps(debt, value)`.
- Margin: `MarginState`, `MarginThresholds`, `classifyMargin(ltvBps, thresholds)`, `LiquidationRoute`,
  `CustodyMode`, `PauseScope`.
- Shapes: `AssetConfig`, `AssetStandard`, `YieldType`, `CreditLineView`, `PledgePosition`,
  `ExitQuote`, `ExitFill`, `RepoTrade`, `RepoMarginCall`, `RepoKind`.
- Webhooks: `WebhookEvent`, `WebhookPayload`, and `DELIVERABLE_WEBHOOK_EVENTS`, the subset the
  outbox actually emits today (the rest of `WebhookEvent` is reserved and not offered for
  subscription).

## Who imports it

`@ballast/db`, `@ballast/contract-clients`, `services/api`, `services/price-guard`,
`services/margin-monitor`, `services/keeper`, `services/payout-hop` and `services/ledger`. It is also
a declared dependency of `services/indexer` and `services/issuer-gateway`.

## Build and test

`pnpm --filter @ballast/domain-types build`, `typecheck` and `test`. There are no tests yet; vitest
runs with `--passWithNoTests`.

## Gotchas

- `price.ts` and `risk.ts` are hand-kept copies of `ballast-common::price` and `ballast-common::risk`
  in `contracts/common`. There is no codegen, so a change on one side needs the matching edit on the
  other.
- `scaledToDecimalString` throws on negative input; `decimalStringToScaled` accepts a leading minus.
- Adding an event to `DELIVERABLE_WEBHOOK_EVENTS` promises subscribers it can arrive, so add it only
  once something emits it.
- Rebuilding `dist/` restarts `pnpm dev` services (they run under `tsx watch`).
