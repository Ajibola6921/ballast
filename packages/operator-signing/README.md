# @ballast/operator-signing

Operator key handling for the three services that hold a signing key: `keeper`, `price-guard` (the
price publisher) and `payout-hop`. Ballast never holds customer keys; these are the narrow
exceptions. Callers depend on one interface, `KmsSigner`, and a factory picks the backend from the
environment.

## Exports

- `KmsSigner`: `publicKey()`, `sign(unsignedXdr)` returning signed XDR, and `signMessage(bytes)`
  returning a detached Ed25519 signature (used for price-guard's NAV attestation).
- `createOperatorSigner(role, networkPassphrase, env?)`: async; `role` is `keeper`,
  `price-publisher` or `payout-hop`. Reads `<ROLE>_SIGNER_MODE` (`KEEPER`, `PRICE_PUBLISHER`,
  `PAYOUT_HOP`), default `local`.
- `submitSignedTx(rpcUrl, passphrase, signedXdr, pollMs?, maxAttempts?)`: sends a signed envelope and
  polls until it succeeds; throws on rejection, on-chain failure or timeout (30 polls at 1 s).
- Backends: `LocalDevSecretKeySigner` / `createRawSecretSigner`, `VaultTransitSigner`,
  `KmsEnvelopeSigner`, and `VaultAuth` (token handling for Vault).

## Signer modes

- `local`: raw secret from `<ROLE>_SECRET_KEY`. Refused when `NODE_ENV=production`.
- `vault`: HashiCorp Vault Transit. Needs `VAULT_ADDR` and `<ROLE>_VAULT_KEY_NAME`, plus either
  AppRole (`VAULT_ROLE_ID` + `VAULT_SECRET_ID`) or a fixed `VAULT_TOKEN`; `VAULT_NAMESPACE` is
  optional. The private key never leaves Vault.
- `kms-envelope`: AWS KMS. Needs `AWS_REGION`, `<ROLE>_KMS_KEY_ID` and `<ROLE>_WRAPPED_SECRET`
  (base64 KMS ciphertext of the secret). The secret is unwrapped once at startup and signed with
  in-process, so it sits in memory; prefer `vault`.

## Who imports it

`services/keeper`, `services/price-guard` and `services/payout-hop`.

## Build and test

`pnpm --filter @ballast/operator-signing build`, `typecheck` and `test` (`src/__tests__/` covers the
Vault auth lifecycle, retries, the factory and the KMS unwrap with mocked clients).

## Gotchas

- AppRole logs in on first use, renews the token at two thirds of its lease, and logs in again if
  renewal fails or Vault answers 401/403. A static `VAULT_TOKEN` cannot be refreshed, so the signer
  fails once it expires. Vault calls time out after 10 s and retry up to 3 times on network errors,
  429 and 5xx.
- The Vault signer verifies every signature against its public key before returning it, so a rotated
  or wrong key fails locally rather than as an on-chain rejection.
- Submission goes through `withRpcRetry` from `@ballast/network-config`, so transient RPC failures
  are retried.
- Rebuilding `dist/` restarts `pnpm dev` services (they run under `tsx watch`).
