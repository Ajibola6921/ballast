# @ballast/network-config

Stellar network settings read from the environment, plus two small helpers every service shares: a
retry wrapper for Soroban RPC calls and the shared-secret check for internal-only services.

## Exports

- `loadNetworkConfig(env?)`: reads `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`,
  `STELLAR_NETWORK_PASSPHRASE`, optional `STELLAR_NETWORK` (`local`, `testnet`, `mainnet`; default
  `local`) and the `*_CONTRACT_ID` variables. It lists every missing variable at once.
- `requireContractId(config, key)`: the contract id for `registry`, `priceGuard`, `pledgeVault`,
  `creditLine`, `exitDesk`, `repoDvp` or `usdcSac`, or a clear error if it is not deployed yet.
- Types: `NetworkConfig`, `ContractIds`, `StellarNetworkName`.
- `withRpcRetry(fn, { attempts = 4, baseDelayMs = 400 })` and `isTransientRpcError(err)`: retry with
  exponential backoff, only for transient failures (dropped connections, 429/5xx, `TRY_AGAIN_LATER`,
  `Account not found`). A contract panic or rejected transaction surfaces at once.
- `loadInternalToken(env?)`, `requireInternalToken(app, token)`, `internalBindHost(name, env?)`,
  `INTERNAL_TOKEN_HEADER` (`x-internal-token`): `INTERNAL_API_TOKEN` must be at least 32 characters;
  the hook rejects any request without it using a constant-time compare; the bind host is
  `127.0.0.1` unless `<NAME>_HOST` is set.

## Who imports it

`@ballast/contract-clients` and `@ballast/operator-signing` (for `withRpcRetry`); `services/api`,
`price-guard`, `indexer`, `margin-monitor`, `keeper`, `issuer-gateway` and `payout-hop` for the
config. Only `payout-hop` and `issuer-gateway` use the internal-auth helpers.

## Build and test

`pnpm --filter @ballast/network-config build`, `typecheck` and `test` (vitest covers config
validation, retry and internal auth).

## Gotchas

- A `testnet` or `mainnet` name with the wrong passphrase is refused, and `local` with a public
  passphrase is refused, so a service cannot sign for the wrong network by accident.
- An unknown `STELLAR_NETWORK` is an error, not a passthrough.
- `requireInternalToken` takes a structural `HookHost`, so the package does not depend on Fastify;
  register it before any route.
- The retry is safe for resending a signed transaction (the network returns the original hash), but
  do not wrap calls that are not idempotent.
- Rebuilding `dist/` restarts `pnpm dev` services.
