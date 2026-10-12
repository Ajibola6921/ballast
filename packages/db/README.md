# @ballast/db

The Postgres layer shared by every service that stores state: the Drizzle schema, the migrations, a
database client, the double-entry journal helpers, and two operator scripts (seed and compliance).
Private workspace package; consumers read it from `dist/`.

## Exports

- `createDatabase(connectionString?)` and the `Database` type: a Drizzle client over `postgres`. It
  defaults to `DATABASE_URL` and throws if neither is set.
- `schema` (namespace): every table and enum from `src/schema.ts` (asset, party, credit_line, draw,
  repayment, liquidation, repo_trade, journal_entry, audit_log, tx_intent, chain_event,
  compliance_check, payout_forward, party_api_key, webhook_subscription and so on). Money columns are
  `numeric(32,7)`, which come back as decimal strings; convert with `@ballast/domain-types`.
- `recordDoubleEntry(db, args)`: books one event as a balanced debit and credit pair of
  `journal_entry` rows inside one transaction. This is the only sanctioned way to book an event.
- `recordJournalEntry(db, args)`: inserts a single leg. It rejects a row that is both or neither of
  debit and credit. Also exports `DbOrTx`, `JournalEntryArgs` and `DoubleEntryArgs`.

## Who imports it

`services/api`, `services/price-guard`, `services/indexer`, `services/margin-monitor`,
`services/keeper`, `services/issuer-gateway`, `services/payout-hop` and `services/ledger`
(`services/ledger/src/journal.ts` only re-exports the journal helpers from here).

## Build and test

`pnpm --filter @ballast/db build`, `typecheck` and `test` (there are no tests yet; vitest runs with
`--passWithNoTests`). Scripts, all of which read `../../.env` if it exists:

- `migrate` applies the committed migrations in `migrations/` to `DATABASE_URL`.
- `migrate:generate` runs `drizzle-kit generate` against `src/schema.ts`.
- `seed` creates the lender and borrower parties and the test RWA from a deploy output file
  (`LENDER`, `BORROWER`, `RWA_SAC`, `RWA_ISSUER`); it is idempotent. `scripts/dev-setup.sh` runs it.
- `compliance kyb <partyId> <approved|pending|rejected> [provider] [ref]` and
  `compliance clear <partyId> <reviewer> <note...>` make the manual KYB and sanctions decisions. Both
  write to `audit_log`.

## Gotchas

- A change to `src/schema.ts` needs `pnpm --filter @ballast/db migrate:generate`, and the new `.sql`
  file plus the `migrations/meta` journal and snapshot must be committed with it. Then run
  `pnpm --filter @ballast/db migrate` to apply it. Generating and applying are separate commands.
- Rebuilding `dist/` restarts any `pnpm dev` service, because they run under `tsx watch`. Do not
  rebuild during an e2e drill.
- Never insert a lone `journal_entry` row by hand; use `recordDoubleEntry`.
- A new contract deployment gets a fresh database (`PG_DB=ballast_N scripts/dev-setup.sh testnet`).
