# Seed issues

Drafts for the first issues to open, each found while documenting the repo. Create them with the issue
templates and the labels in `labels.yml`, then delete this file. Each is real and verifiable today.

## good first issue

1. **List the missing env vars in `.env.example`.** The code reads `KEEPER_REPO_MARGIN_CRON`,
   `KEEPER_BALANCE_CRON`, `PRICE_GUARD_CRON`, `MARGIN_MONITOR_POLL_MS`, `INDEXER_POLL_INTERVAL_MS`,
   `INDEXER_LAG_ALERT_SECONDS`, `LEDGER_RECONCILIATION_CRON`, `ISSUER_GATEWAY_PORT`/`HOST` and
   `PAYOUT_HOP_PORT`/`HOST`, but `.env.example` does not list them. Add each with a comment.
   `area:services`, `documentation`
2. **Fix the stale comment in `services/price-guard/src/navSignature.ts`.** Its header says
   `pipeline.ts` checks the NAV signature; `navAttestor.ts` (`attestNav`) does. `area:services`
3. **Fix the stale header in `packages/operator-signing/src/vaultTransitSigner.ts`.** It says Vault is
   configured with `VAULT_ADDR` + `VAULT_TOKEN`; AppRole is supported and preferred. `area:packages`
4. **Drop unused `@ballast/domain-types` dependencies** from `services/indexer` and
   `services/issuer-gateway`, which declare it but import nothing from it. `area:services`
5. **Say why `ALLOW_LOCAL_DEV_SIGNER` has no effect through the factory.** `localDevSigner.ts` says it
   permits `local` mode under `NODE_ENV=production`, but `createOperatorSigner` throws first. Either fix
   the comment or the behaviour (the comment is the safer fix). `area:packages`, `security-adjacent`

## help wanted

6. **Run `cargo fmt` and add `cargo fmt --check` and `cargo clippy -- -D warnings` to CI.** `fmt --check`
   reports about 54 diffs on `main`. Do the formatting in its own PR. `area:contracts`, `area:infra`
7. **Wire a linter.** `pnpm lint` is `echo 'no lint configured'` in most packages. `area:infra`
8. **Fill `price_snapshot.ledger`.** `services/price-guard/src/pipeline.ts` writes `0` with a comment
   saying the indexer will fill it; nothing in `services/indexer` touches `price_snapshot`.
   `area:services`
9. **Move `margin-monitor` onto `chain_event`.** It polls `CreditLine.ltv`; its source comment calls that
   a stand-in for the indexer's event stream. `chain_event` has no live consumer except `services/ledger`.
   `area:services`
10. **`payout-hop` edge cases.** A `PENDING` network status is recorded as `sent` without waiting for
    confirmation, and a crash after the claim leaves the row `claimed`, so later requests get `409`.
    Add confirmation polling and a recovery path. `area:services`, `security-adjacent`
11. **`issuer-gateway` audit trail.** It writes its `audit_log` row only after the adapter call
    succeeds, so failed calls leave no audit row, and an unknown or unconfigured issuer returns a bare
    `500`. Log failures and return a `4xx`/`503` with a reason. `area:services`, `security-adjacent`
12. **Sync haircuts, thresholds and spreads from `Registry`.** The other contracts hold admin-set copies
    today (`configure_asset` on each), as their module docs say. `area:contracts`, `security-adjacent`
13. **Test the shortfall case on a live network.** Collateral worth less than the debt is covered only by
    unit tests. Needs a price fall, so design a drill that tightens bands or uses a dedicated asset.
    `area:contracts`, `needs-testnet`
14. **Backfill in `services/indexer`.** The backfill is a stub. `area:services`
