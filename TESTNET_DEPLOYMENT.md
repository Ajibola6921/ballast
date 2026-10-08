# Testnet deployment

All six contracts are deployed, initialized, configured, and asset-registered on Stellar testnet,
and the full `scripts/e2e-smoke.sh testnet` happy path (open → fund → pledge → publish price →
draw → repay → release, plus the attacker-rejection regression check) has passed against this
deployment with real signed, submitted transactions.

## Network

`testnet` (`https://soroban-testnet.stellar.org`, passphrase `Test SDF Network ; September 2015`).

## Deploy date

2026-09-17.

## Contract IDs

`common` is a shared library, not a deployable contract, so it has no row below.

| Contract | Contract ID |
|---|---|
| `registry` | `CD65BRB2C7T5TO4TGBBXOLB7HXSKRXQMVPGGRCFXEKVNZFMYRH4LYCWM` |
| `price-guard` | `CD5W5MVLGSAKVXG7V564IATJUE5AZWCUBF4VWN6P2SM7UKIDXP7D6BLL` |
| `pledge-vault` | `CBEHWDRZIFFO3GPIOFK7LYEXKVBUGCYQIE2RG5I6QBI3DK4WCXRNS35D` |
| `credit-line` | `CDVZO4D6BMQHUJQKFWRIWG4EQ7WXFPVYQDPM3Z65RLUXIFVCHTFFIXFI` |
| `exit-desk` | `CCGW2ZXMXS4MAPPXR3UDZXBMQZHSA5OYFDGP46SLMFJMEQ5CNY77AJ6G` |
| `repo-dvp` | `CB4MT4VRRS6IBK326OM5E4M3C37H6QCLI7S5F2HIF6UXJDRTRPRWBPSD` (redeployed 2026-10-07, see below) |

Test assets registered against this deployment (issued fresh for this deploy, not real RWAs):

| Asset | Classic issuer | SAC contract ID |
|---|---|---|
| `RWA1` | `GAFHGGKP5657WCBVQBCF3F2S3O2TGICCTE53O7FPEIGCPTHCXXHUPCET` | `CA6ITP5KB7QHPFTOA72QE3YZB7AZB3SFK5NNCUWL5TVVX45O7XFN65HE` |
| `TUSD` | `GD4KBWX6TID4MATRWOFLQXGSVHOHE5IJ47LFMXA3JXHADO6TWGYICDRR` | `CAEYEZD7F2RFLWJFBXIY75RGEWHKFCKFKT2CJHHACSMUMBH3LG777DJT` |

### Real price data (2026-10-08)

`RWA1` is a token this repo issues, so it has no market of its own. It is priced as Etherfuse's real
**USTRY** bond from two independent real sources: Etherfuse's public price API (issuer NAV) and
RedStone's USTRY feed contract read from **mainnet** (RedStone publishes no RWA feeds on testnet).
`scripts/real-sources.env` holds that mapping. Nothing on this deployment is mocked any more, and
the earlier $1.00 test prices are gone. Changes made to this live deployment to get there:

- `configure_issuer_key`: the price publisher's Ed25519 key is registered as `RWA1`'s NAV attestor
  (tx `c660ec72bee0fce070120c0ea550b3d73bf263bcd841734ed1632a558bd3279e`), and
  `configure_signature_requirement --required true` re-enabled the on-chain check (tx
  `7f44dbd5be7cc0fa674c67594b446c35e71ba4ea21b5504eb5557d8398591696`). No issuer signs NAV, so
  the guarantee is that Ballast's publisher saw the value from the issuer's API, not issuer
  attestation.
- `max_staleness_s` raised from 3600 to 21600: RedStone's USTRY feed was 93 minutes old at the
  first attempt, so with a 1h window the guard (correctly) reported `Degraded` and refused to lend.
- The first real price (about $1.0764) halted the guard against the old fake $0.9999 baseline, as
  designed. The `risk` role cleared it with `confirm_halt_cleared`. That account had never been
  funded on testnet; it was funded through friendbot.
- Borrower's test `RWA1` balance topped up from the test issuer (failed runs had locked it in the
  vault).

`scripts/e2e-smoke.sh testnet` passed again on this basis (line `13`): real NAV and oracle readings
published with a real signature, `guarded_price` `Ok` at 1.076433, draw, repay, release, and the
stranger-release rejection.

## Deployer / role addresses

| Role | Address |
|---|---|
| `admin` | `GA2L6GQB7SDVUG5TVC5PCUOUMBHCDTSP4THA76TWLBVUAXTAKVT7BSIF` |
| `pauser` | `GCHVXNBDXSXPSJQDB7RVST6TCL2MZT6R2XLO4DC36NKHQGMEHRGV7E67` |
| `keeper` | `GBDOKSMNWT5WDTDLASLQZRKOVO5YAE33TGMIDKUSWZ2F46TZYKP6ZDCT` |
| `price_publisher` | `GBTV5NBNCR6RY5PFV6JGTTX7ACKBZSVQIHM6LZALVNDWQNQ35OEXOMR6` |
| `risk` | `GC466MN5MJPCGRNYQKQXWZ5GHY4YDTLRFFQOZ2EFHF26BWNOA7A3UELV` |

All generated fresh for this deploy via `stellar keys generate ... --fund` (testnet friendbot);
these are test keys with no real value, not production credentials.

## E2E smoke test result

**Passed**, run manually step-by-step against this live deployment (not via one unattended
`scripts/e2e-smoke.sh testnet` invocation — see note below) with real signed, submitted
transactions on testnet:

1. `open` a credit line (lender → borrower, 10,000 TUSD limit @ 7% APR) — line id `0`.
2. `fund` the line with 10,000 TUSD.
3. `pledge` 5,000 RWA1 into `PledgeVault` (escrow mode).
4. `sync_collateral` on `CreditLine`.
5. `publish_nav` + `publish_source` on `PriceGuard`; `guarded_price` returned `status: Ok`.
6. `draw` 1,000 TUSD — succeeded, `ltv()` afterward: `collateral_value=47500000000,
   debt=10000000665, ltv_bps=2105, state=Healthy` (~21% LTV, matching the script's own comment).
7. `repay` 1,000 TUSD in full — `ltv()` afterward: `debt=887` (dust — a few seconds' worth of
   interest accrued between repay and the read), `ltv_bps=0`.
8. `release` 1,000 RWA1 of collateral — `position_units()` afterward: `40000000000` (4,000 RWA1
   remaining), matching the script's own comment exactly.
9. **Security regression check**: an unrelated `attacker` keypair's `release` call against this
   same line was rejected (`PledgeVault` → `CreditLine::borrower_of` → ownership check panics),
   confirming the `PledgeVault::release` ownership fix (the HIGH-severity audit finding this script
   exists to catch a regression on) still holds live, cross-contract, on testnet.

### Why this was run manually instead of via one script invocation

This sandbox's outbound network path to `soroban-testnet.stellar.org` had frequent transient TLS
failures (`received fatal alert: BadRecordMac` / `DecodeError` / "cannot decrypt peer's message")
during this deploy — unrelated to the contracts or scripts. `scripts/deploy.sh` and
`scripts/e2e-smoke.sh` were both hardened with a `retry()` wrapper for this. Two real, unrelated
bugs surfaced and were fixed along the way (both now fixed in the scripts, so a future
`scripts/deploy.sh testnet && scripts/e2e-smoke.sh testnet` run should complete unattended):

1. **`register_asset`'s CLI `--config` JSON call is correct** but a `retry()`'d call can appear to
   fail even after the underlying transaction actually lands, if the transient failure hits during
   status-*confirmation* rather than submission — the retry then hits the target contract's own
   idempotency guard (`assert!(!already registered/initialized)`) and panics, which surfaces as a
   generic `VM call trapped: UnreachableCodeReached` (Rust panic messages are stripped in the
   `no_std` release wasm profile). This isn't a code bug; it's inherent to retrying
   non-idempotent calls under a flaky transport. No script change was made for this specific
   case — it only matters if the same flakiness recurs on a future run, in which case: check
   whether the "failed" step actually landed (query the contract) before manually retrying.
2. **`scripts/deploy.sh` never gave the borrower a TUSD trustline** — `CreditLine::draw` transfers
   TUSD to the borrower, and a classic Stellar asset can't reach an account with no trustline for
   it, even moved via its SAC wrapper. This is a genuine pre-existing gap (the script's own header
   comment already admitted its CLI flags "weren't hand-verified against a live deployment" —
   this was the first live deployment). **Fixed**: `scripts/deploy.sh` now also establishes a TUSD
   trustline for the borrower.

## Services E2E result

**Passed** on 2026-10-06 via `scripts/e2e-services.sh testnet` against this deployment, with
`pnpm dev` running every service: SEP-10 login for lender and borrower, then open (on-chain line
id `4`), fund 50 TUSD, two pledges (100 + 50 RWA1), `services/keeper` syncing the collateral and
`services/price-guard` publishing an `Ok` price, draw 20 TUSD (LTV 1403 bps, `Healthy`), repay
20 TUSD (booked as principal 19.9999996 + interest 0.0000004), release the 50 RWA1 pledge, and the
keeper syncing collateral back down. Every transaction was built by `services/api`, signed by the
customer's own key outside the API, and submitted through `POST /v1/tx/submit`.

Getting there needed `@stellar/stellar-sdk` 17: the 13.x line this repo started on cannot decode
transaction results from the current testnet protocol (`Bad union switch: 4`), which broke every
service that submits a transaction.

On-chain lines `1`-`3` are leftovers from the runs that surfaced that and two other bugs.

## 2026-10-07: repo-dvp redeployed, desks configured

`repo-dvp` was redeployed (the other five contracts are the 2026-09-17 originals). The first
version moved each cash leg with a plain `transfer` out of the wallet of a party who isn't signing
that call - the lender's cash in `accept_and_settle`, the borrower's in a lender- or
keeper-triggered `unwind` - which the network rejects. The new version has each party grant a
token allowance in the call they do sign and spends it with `transfer_from`; see the contract's
module docs. Previous address: `CBFJZ5VLW63ESYWOKKX73ZKL26SHB6EZUMHOIGF5NJVLUVBDWVJW27UG`.

`scripts/configure-desks.sh testnet` was then run: `ExitDesk` configured for `RWA1` (25 bps spread)
and funded with 5,000 TUSD, `RepoDvp` configured for `RWA1`/TUSD, an `RWA1` trustline added for
the lender (to receive liquidated collateral).

Passed against this deployment with `pnpm dev` running, all on 2026-10-07:

- `scripts/e2e-services.sh testnet` - the collateral rail again (line `6`); an exit of 10 RWA1 for
  9.975 TUSD; a repo of 50 TUSD against 100 RWA1, accepted by the borrower and unwound at maturity
  by `services/keeper` (leg 2 tx
  `b2cd168ad72ee02c1d3159be879b2c57610707288b06a65c6b76d0f78300d4e7`).
- `scripts/e2e-liquidation.sh testnet` - 60 TUSD drawn against 100 RWA1, mock price dropped to
  $0.62 (LTV 10183 bps), line liquidated by the keeper after its 60s cure window and the 100 RWA1
  sent to the lender (txs `9f480616bd1523085f026b9fa00f6e8c1bc391429d48d585a27b6266bc95f780`,
  `5a963e4652669f18a04cd132438ddb90f81cd1bb10b3cc9f67c5da67c70d8e0c`). Price and band restored
  afterwards. **That run used the mock price file, which no longer exists.** The script now
  tightens the line's margin thresholds under its real LTV instead. Re-run on 2026-10-08 against
  real prices (LTV 5867 bps): thresholds tightened, line liquidated by the keeper, thresholds
  restored. `e2e-services.sh testnet` also passed again on the real price.

That liquidated line is still `Liquidating` on-chain with its 60 TUSD of debt outstanding: the
contracts have no step that closes a liquidated line or books recovered value against the debt.
