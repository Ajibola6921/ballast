# services/price-guard

Reads real prices for every active asset, publishes them to the `PriceGuard` contract, and records what it
saw. It has no HTTP surface. Each cycle (default every minute) it fetches two independent readings per asset:

- **Issuer NAV** from the issuer's public API: Spiko (`public-api.spiko.io/v0`, USD share classes only;
  EUR and GBP classes are refused because there is no FX leg) and Etherfuse (`/lookup/tokens/cost/{symbol}`,
  already in USD, timestamp is the median of its FX providers' update times). Franklin has no public NAV
  API, so its assets get the feed alone and the contract reports them `Degraded`. An unknown issuer code
  skips that asset.
- **Independent feed** from the asset's RedStone feed contract (`read_price_data`, `decimals`), rescaled to
  the repo's 1e7 fixed point.

For each asset it inserts `price_observation` rows (`issuer_nav`, `redstone`), then, unless in shadow mode,
publishes both through `PriceGuardClient.publishNav` / `publishFeed`, reads back `guarded_price()` and
stores it in `price_snapshot`. The guarded value and status always come from the contract, never from
off-chain arithmetic. `Degraded` and `Halted` fire `price_degraded` / `price_halted` alerts. One failing
source or asset does not stop the others.

Issuers do not sign NAV, so the price-publisher key signs each NAV reading itself over
`<assetCode>:<ts>:<value>` (`navAttestor.ts`) and checks the signature against its own public key before
sending. `PriceGuard.publish_nav` verifies it on-chain against the key set by `configure_issuer_key`. This
attests "Ballast's publisher saw this value from the issuer API", not that the issuer vouched for it.

## Run

```
pnpm dev                                          # from the repo root, with every other service
pnpm --filter @ballast/service-price-guard dev    # this service only
pnpm --filter @ballast/service-price-guard smoke CETES:etherfuse USTBL:spiko   # read each source once, print, send nothing
pnpm --filter @ballast/service-price-guard shadow:seed   # seed the mainnet assets from scripts/shadow-assets.json
```

Shadow mode (`PRICE_GUARD_PUBLISH=false`) records real readings and alerts when NAV and feed differ by more
than the asset's `price_band_bps`, but sends nothing on-chain, writes no `price_snapshot` and needs no
contract or publisher key. `scripts/shadow-run.sh` drives it. `smoke` touches neither chain nor database.

## Environment

- `DATABASE_URL`, `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`.
- `STELLAR_SIMULATION_SOURCE`: funded account for read-only simulations (the RedStone reads, `guarded_price`).
- `PRICE_GUARD_CONTRACT_ID`: required unless shadow.
- `PRICE_GUARD_PUBLISH`: `false` for a shadow run; anything else publishes.
- `PRICE_GUARD_CRON`: cycle schedule, default `*/1 * * * *`.
- `PRICE_PUBLISHER_SIGNER_MODE` (`local`, `vault`, `kms-envelope`) and `PRICE_PUBLISHER_SECRET_KEY` (local
  mode); Vault and KMS variables are listed in `.env.example`.
- `REDSTONE_FEED_CONTRACT_IDS`: JSON `{assetCode: feedContractId}`. Required; the cycle throws without it.
- `REDSTONE_RPC_URL`, `REDSTONE_NETWORK_PASSPHRASE`: read RedStone from mainnet while publishing elsewhere.
- `ISSUER_NAV_SYMBOLS`: JSON `{assetCode: issuerSymbol}` for tokens whose code differs from the issuer's.
- `SPIKO_NAV_API_BASE_URL`, `ETHERFUSE_NAV_API_BASE_URL`: override the public endpoints (proxy or mirror).
- `ALERT_WEBHOOK_URL`, `ALERT_COOLDOWN_S`, `OPERATOR_MIN_XLM`: alert delivery; the publisher balance is
  checked at startup and every 30 minutes (not in shadow mode).

## Source map

- `src/index.ts`: asset loading (`asset` rows with status `active`), cron, balance check.
- `src/pipeline.ts`: `runPriceUpdateCycle`, the fetch, record, publish, read-back loop.
- `src/adapters/`: `spikoNavAdapter.ts`, `etherfuseNavAdapter.ts`, `redstoneAdapter.ts`, `registry.ts`,
  `liveNavShared.ts` (10s timeout, one retry on network error, none on HTTP error).
- `src/navAttestor.ts`, `src/navSignature.ts`: NAV message format and Ed25519 check; keep it identical to the contract's.
- `src/scaled.ts`: decimal string to and from 1e7 integers. `src/smoke.ts`, `src/seedShadow.ts`: the two scripts.

## Tests

`pnpm --filter @ballast/service-price-guard test` (vitest). `adapters.test.ts` checks each adapter
against responses recorded from the live endpoints on 2026-10-08 (`src/__fixtures__/`), plus registry
behaviour. `pipeline.test.ts` covers recording, attested publishing, NAV-failure fallback, Franklin,
`Halted` alerts, unknown issuers, a missing feed config, and shadow mode. Test doubles live only in `*.test.ts`
and `__fixtures__`; `src` has no mock mode.

## Does not

- Price EUR or GBP share classes, or Franklin NAV.
- Fill `price_snapshot.ledger`; it always writes `0`. A code comment says the indexer fills it in, but nothing in `services/indexer/src` references `price_snapshot`.
- Compute the guarded price or decide staleness: that is the contract's.
