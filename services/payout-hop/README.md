# services/payout-hop

Pays an anchor from the operator's own Stellar account. A Soroban contract cannot attach the memo an
anchor needs, so the money goes in two legs: contract -> operator G-account (done elsewhere), then this
service sends operator G-account -> anchor G-account as a classic USDC payment with the memo.

It moves real funds, so treat it as the most sensitive service in the repo.

## Endpoint

`POST /internal/payout-hop/forward`, JSON body:

| field | meaning |
|---|---|
| `fromContractPayoutTxHash` | hash of the first leg; the idempotency key |
| `toAnchorAccount` | anchor G-address |
| `amount` | whole number as a string, in 7-decimal fixed point (`"10000000"` = 1 USDC) |
| `memo` | 1-64 chars in the schema; the policy then requires a text memo of at most 28 bytes, or digits fitting a `MEMO_ID` |
| `usdcAssetAddress` | the USDC issuer's **G-address** (not the SAC `C...` id); must equal `PAYOUT_HOP_USDC_ISSUER` |
| `quoteId` | optional `exit_quote` uuid |

Answers `200 { hash, status }`, `400` bad body, `401` no or wrong token, `403` refused by policy, `409`
this first-leg hash was already requested, `502` submission failed.

## Security

- Every request needs `x-internal-token` equal to `INTERNAL_API_TOKEN` (at least 32 characters, compared
  in constant time). The service will not start without it.
- It binds to `127.0.0.1` unless `PAYOUT_HOP_HOST` is set.
- The caller does not decide where money goes. A payout is refused unless the destination is in
  `PAYOUT_HOP_ALLOWED_DESTINATIONS`, the asset is `PAYOUT_HOP_USDC_ISSUER`'s USDC, the amount is positive
  and at most `PAYOUT_HOP_MAX_AMOUNT` whole USDC (default 5000), and the memo fits. Startup fails if the
  issuer or destination list is missing or contains an invalid G-address.
- Each first-leg hash is claimed in `payout_forward` before anything is sent, so retries and duplicates
  pay once. A payout marked `failed` can be requested again.
- The key comes from `@ballast/operator-signing`. `PAYOUT_HOP_SIGNER_MODE` is `local` (default; reads
  `PAYOUT_HOP_SECRET_KEY`, and is refused when `NODE_ENV=production`), `vault` or `kms-envelope`.

## Run

```
pnpm --filter @ballast/service-payout-hop dev      # tsx watch, loads the repo-root .env
pnpm --filter @ballast/service-payout-hop build && pnpm --filter @ballast/service-payout-hop start
```

`pnpm dev` at the root also starts it, and it exits at startup if the variables below are missing.
`scripts/dev-setup.sh` fills them in, using the test lender and borrower as the "anchors".

## Environment

| variable | purpose |
|---|---|
| `INTERNAL_API_TOKEN` | shared secret for the header above |
| `PAYOUT_HOP_PORT` (3002), `PAYOUT_HOP_HOST` (127.0.0.1) | listen address |
| `PAYOUT_HOP_USDC_ISSUER` | USDC issuer G-address |
| `PAYOUT_HOP_ALLOWED_DESTINATIONS` | comma-separated anchor G-addresses |
| `PAYOUT_HOP_MAX_AMOUNT` | per-payout cap, whole USDC (default 5000) |
| `PAYOUT_HOP_SIGNER_MODE`, `PAYOUT_HOP_SECRET_KEY`, `VAULT_*`, `PAYOUT_HOP_VAULT_KEY_NAME`, `AWS_REGION`, `PAYOUT_HOP_KMS_KEY_ID`, `PAYOUT_HOP_WRAPPED_SECRET` | operator signer |
| `DATABASE_URL`, `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE` | database and network |

## Source map

- `src/index.ts`: Fastify server, request schema, status mapping.
- `src/hop.ts`: `PayoutPolicy`, `forwardPayout` (claim, build payment, submit, record).
- `src/signer.ts`: `PayoutSigner` seam and the RPC-backed `OperatorPayoutSigner`.

## What it writes

`payout_forward` (claim, then `sent` with the tx hash, or `failed`); `exit_fill` (only when `quoteId` is
given); and two balanced `journal_entry` rows (`usdc_cash` debit, `operator:payout_hop` credit).

## Tests

`pnpm --filter @ballast/service-payout-hop test` (vitest; fake signer and database, no network). Covers
401 without the token, 400 on malformed bodies, 403 on a refused destination, each policy rule including
the cap boundary, text and numeric memos, pay-once on repeats, retry after failure, an `ERROR` status
treated as failed, and `loadPayoutPolicy` validation.

## Known limits

- **Not wired in.** Nothing in `services/api` or elsewhere calls this endpoint; the exit-execute flow
  does not use it, and `TESTNET_DEPLOYMENT.md` says the same. A real forward has not been run on a network.
- Only `ERROR` from `sendTransaction` is treated as failure. `PENDING` is recorded as `sent` without
  waiting for the ledger to confirm it.
- If the process dies after claiming but before finishing, the row stays `claimed` and later requests
  get `409` until someone resolves it by hand.
- The hop does not check that the first leg actually landed; it trusts the caller.
