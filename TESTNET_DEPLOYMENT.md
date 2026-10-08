# Testnet deployment

All six contracts are deployed, initialized, configured and asset-registered on Stellar testnet, and
every end-to-end drill in `scripts/` has passed against this exact deployment with real signed,
submitted transactions and real prices. Nothing on it is mocked; the two tokens are test tokens this
repo issues (see "Test assets").

## Network

`testnet` (`https://soroban-testnet.stellar.org`, passphrase `Test SDF Network ; September 2015`).

## Current deployment (2026-10-08)

Deployed in full with `scripts/deploy.sh testnet`. Earlier deployments (2026-09-17 and three
intermediate ones made the same day while the contracts changed) are abandoned: each redeploy
regenerates the role keys, so they can no longer be administered.

`common` is a shared library, not a deployable contract, so it has no row below.

| Contract | Contract ID |
|---|---|
| `registry` | `CD5FBP5FB24KUGUI5B3Q3YITQRA6YKFOEZWOEAAJ252VZ3REOVCRXYY7` |
| `price-guard` | `CDZHCZHEFWD5ENWDHIRHUKGNRAMLPCXU3G3VYUACRTD34TUV2HRC4HF3` |
| `pledge-vault` | `CC63JA7ZYE2WLYD32Y55VH44QQ2KTPXFEF7OU7PXA3K45GM2C2Q3BWUF` |
| `credit-line` | `CCJABUP4DW632LJ6WHHW32DLNBNSV6W6GBPAWRAFVIHG6FWSRFW2OJXW` |
| `exit-desk` | `CC6C2NKW6VFHXXCM6RPSWTD6Y2PBEZK45S573XCCLAE3QC2AF6WF6FW6` |
| `repo-dvp` | `CBNIP4NSNHMYKWWSWIIABAZ7KLM2E7OX5HNLEZLXX2JUAFFXXDULWRFR` |

### Test assets

Issued fresh for this deploy. They are not real RWAs or real USDC.

| Asset | Classic issuer | SAC contract ID |
|---|---|---|
| `RWA1` | `GAXNUJKCMIFS2NAOHSDW47HFW63EELDHEEXKW23Z5IJ7RP5L5IPEXQSV` | `CBLP7TT2G4GZILL4FXKKLZJC73XCPDZEZJNCQLZVKKYE66X6VSIMYUB7` |
| `TUSD` | `GCTT6A6JJUFNO36MNFAYFRVNVNUYLVSIUE5JQI32R4FLI7V4LAVE25VG` | `CDTFUAZEGMRNEL2HGLNHCCUWMLJPXBVGVVDPSVCGJ4XHN5JP37JBSZHC` |

### Role addresses

| Role | Address |
|---|---|
| `admin` | `GASSLAAKTUJGXRVRLUVQDY6YONBAGVD6PAQSZZNPDWJX6PH5KVEHFV6J` |
| `pauser` | `GCDQOFCIB33VYETYBJDWH4AHYSY5IGVRE2S654ZGVP7Z7XKJRGEFWEBY` |
| `keeper` | `GA3KVWVISNVS2ZHZ2KOU4TXWNJZXXRUZQD57QZVQRTZUJATSXDZ4KOZV` |
| `price_publisher` | `GDLHSDDPKURDZGMOYB75FF67FPRJ4466EHAOHI7RN3H7COTFHFNSZ5B2` |
| `risk` | `GDVZHGNJJMNQQGJ5WXGZJXETMDG4D6B5JF3JKTQF2MJURDPM3POM4YAA` |

All generated fresh for this deploy via `stellar keys generate ... --fund` (testnet friendbot); these
are test keys with no real value, not production credentials.

## Real price data

`RWA1` is a token this repo issues, so it has no market of its own. It is priced as Etherfuse's real
**USTRY** bond from two independent real sources: Etherfuse's public price API (issuer NAV) and
RedStone's USTRY feed contract read from **mainnet** (RedStone publishes no RWA feeds on testnet).
`scripts/real-sources.env` holds that mapping.

- The price publisher's Ed25519 key is registered as `RWA1`'s NAV attestor and `PriceGuard` requires
  the signature (`scripts/configure-nav-key.sh`). No issuer signs NAV, so the guarantee is that
  Ballast's publisher saw the value from the issuer's API, not issuer attestation.
- `max_staleness_s` is 21,600 (6h): RedStone's USTRY feed updates every 1-2 hours, so a 1h window made
  the guard report `Degraded` and refuse to lend.
- `PriceGuard` evaluates on every publish (see `contracts/AUDIT_NOTES.md`), and refuses readings
  dated more than 60s ahead of the ledger or with a non-positive price.

## End-to-end results on this deployment

All run with `pnpm dev` up and the services acting on their own.

- `scripts/e2e-smoke.sh testnet` **passed**: open, fund, pledge, a real signed NAV and oracle publish,
  `guarded_price` `Ok`, draw, repay, release, and the stranger-release rejection.
- `scripts/e2e-services.sh testnet` **passed**:
  - *Collateral rail*: SEP-10 login for both customers; open, fund, two pledges (counted at once,
    reported by the vault), draw 20 TUSD (LTV 1303 bps), repay, release; the lender then withdrew the
    repaid interest (2 stroops) and the undrawn funding (49.9999998 TUSD).
  - *Release-then-draw*: after releasing 40 of 100 RWA1, a draw the remaining 60 cannot support was
    refused, and a smaller supported draw went through (the race this guards is described in
    `contracts/AUDIT_NOTES.md`).
  - *Exit and repo*: an exit of 10 RWA1 for 10.7377 TUSD; a repo accepted by the borrower and unwound at
    maturity by `services/keeper` with nobody else signing.
- `scripts/e2e-liquidation.sh testnet` **passed**: a 60 TUSD draw, thresholds tightened under the real
  LTV, the keeper armed the breach, waited out the cure window and liquidated, sending 100 RWA1 to the
  lender; the lender then closed the line, and the contract booked debt 60.0000186 against collateral
  worth 107.6459 at the price frozen at liquidation, paying the borrower the 47.6458814 surplus in the
  same transaction; the lender withdrew the undrawn 20 TUSD.
- `scripts/e2e-repo-margin.sh testnet` **passed**: the keeper opened a margin call under tightened
  thresholds; the borrower cured it by adding 25 RWA1 through the API (the contract cleared the call in
  the same transaction); a second call was left uncured and, after the 90s cure window, the keeper
  defaulted the trade: the lender received 46.4486037 RWA1 (what covers the debt) and the borrower got
  78.5513963 RWA1 back.

Also checked live against the running stack: `payout-hop` and `issuer-gateway` answer 401 without the
internal token and listen only on 127.0.0.1; `payout-hop` answers 403 for a destination that is not an
approved anchor, an amount over the cap and a different USDC issuer. An actual forward to an anchor was
not run (the payout operator account holds no TUSD on this deployment).

Not exercised on a live network: the shortfall case (collateral worth less than the debt) needs a real
price fall to reach, so it is covered by contract unit tests only; issuer-lien and custodian-lien
custody modes need an issuer to place the lien; the anchor payout hop is not wired into the exit flow.

## Reproducing

```
scripts/deploy.sh testnet                    # builds and deploys all six contracts, writes .env.testnet-deploy
PG_DB=ballast_2 scripts/dev-setup.sh testnet # writes .env, creates the database, migrates and seeds
pnpm dev
scripts/e2e-smoke.sh testnet
scripts/e2e-services.sh testnet
scripts/e2e-liquidation.sh testnet
scripts/e2e-repo-margin.sh testnet
```

`scripts/redeploy-price-guard.sh` swaps just the `PriceGuard` on an existing deployment and points
everything that reads it at the new one.

A flaky route to the testnet RPC can make a `stellar` call report failure after its transaction landed
(the drop hit confirmation, not submission); the scripts retry, and a retry then hits the target
contract's own idempotency guard (`already initialized`), which surfaces as
`VM call trapped: UnreachableCodeReached` because Rust panic messages are stripped in the release wasm.
That means the step already succeeded: check the contract's state before assuming otherwise.
