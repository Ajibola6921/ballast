## What and why

<!-- What does this change, and why? Link the issue it closes: "Closes #123". -->

## Surfaces touched

<!-- Tick what applies. See CONTRIBUTING.md "Per-surface checks". -->

- [ ] `contracts/`
- [ ] `services/` or `packages/`
- [ ] `apps/console/`
- [ ] `packages/db` schema (migration committed)
- [ ] `scripts/` or `deploy/`
- [ ] Docs only

## Checks run

- [ ] `pnpm build && pnpm typecheck && pnpm test` (TypeScript changes)
- [ ] `cd contracts && cargo test --workspace` (contract changes)
- [ ] `scripts/e2e-*.sh` against a running stack (on-chain behaviour or `services/api` route changes), or say below why not

<!-- Paste anything notable from the runs, or say what you could not run and why. -->

## Checklist

- [ ] No mock or fake data added outside `*.test.ts` / `__fixtures__/`
- [ ] No secret, key or credential hardcoded; new config is in `.env.example` with a comment
- [ ] Docs updated if behaviour, setup or env vars changed
- [ ] If this touches `CreditLine`, `PledgeVault`, `RepoDvP` or `PriceGuard`, the reasoning is in the description and `contracts/AUDIT_NOTES.md` is updated if an assumption changed
