# @ballast/contract-clients

Typed TypeScript clients for the six Soroban contracts (registry, price-guard, pledge-vault,
credit-line, exit-desk, repo-dvp). This package never signs. State-changing methods return an
unsigned, simulated and resource-prepared transaction envelope as base64 XDR; the caller signs it
(a customer's wallet, or an operator signer from `@ballast/operator-signing`). Read methods simulate
and decode the result.

## Exports

- `RegistryClient`, `PriceGuardClient`, `PledgeVaultClient`, `CreditLineClient`, `ExitDeskClient`,
  `RepoDvpClient`: one method per contract entrypoint, plus the on-chain view types they return
  (`OnChainAssetConfig`, `OnChainLine`, `LtvView`, `OnChainRepoTrade` and so on). Each is built with
  `{ network, contractId }`.
- `BaseContractClient`, `ContractClientConfig`: the base class; `invoke` builds an unsigned tx and
  `read` simulates.
- `buildUnsignedTx`, `simulateRead`, `UNSIGNED_TX_TIMEOUT_S` (300 s validity of an unsigned envelope),
  `resolveSimulationSource`, `resolvePokeSource`.
- `sendSignedTx`, `getTxOutcome`, `txHashOf`, `TxOutcome`: submit a signed envelope, read its
  `SUCCESS`, `FAILED` or `NOT_FOUND` outcome, and compute its hash.
- ScVal helpers: `scAddress`, `scI128`, `scU32`, `scU64`, `scSymbol`, `scBool`, `scBytes`,
  `scStruct`, `enumToScVal`, `normalizeContractValue`.

## Who imports it

`services/api`, `services/price-guard`, `services/margin-monitor` and `services/keeper`.

## Build and test

`pnpm --filter @ballast/contract-clients build`, `typecheck` and `test`. Tests live in
`src/__tests__/`, one file per client, and stub `rpc.Server` (see `support.ts`), so nothing touches a
network.

## Gotchas

- Every RPC call (`getAccount`, `prepareTransaction`, `simulateTransaction`, `sendTransaction`,
  `getTransaction`) goes through `withRpcRetry` from `@ballast/network-config`, so a transient
  failure (dropped connection, 429/5xx, `Account not found`) is retried with backoff, while a
  contract panic or rejected transaction surfaces immediately.
- Read methods need `STELLAR_SIMULATION_SOURCE` set to any valid G-address. `poke` falls back to
  `STELLAR_POKE_SOURCE`, then to that. Simulation uses a sequence-0 account, so the source need not
  exist.
- Amounts are raw 7-decimal bigints. Convert Postgres `numeric` strings with `@ballast/domain-types`.
- `NOT_FOUND` from `getTxOutcome` means either not closed yet or past the RPC's retention window;
  callers decide how long to keep asking.
- Rebuilding `dist/` restarts `pnpm dev` services (they run under `tsx watch`).
