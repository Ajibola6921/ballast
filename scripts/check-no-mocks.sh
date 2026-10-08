#!/usr/bin/env bash
# Fails if mock data or mock modes have crept back into code that ships. Prices, NAV, issuer
# responses and oracle readings must come from real sources; fakes belong in tests and fixtures only
# (CONTRIBUTING.md). The patterns name the things that used to exist, so this is a tripwire for the
# specific regressions, not a ban on the word.
#
#   scripts/check-no-mocks.sh        # run by CI

set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='PRICE_GUARD_MODE|ISSUER_GATEWAY_MODE|MOCK_PRICE_FILE|MOCK_ISSUER|\.mock-prices|[Mm]ock(Redstone|Issuer|Spiko|Etherfuse|Franklin|Price|Nav|Oracle)|(PRICE|ISSUER|ORACLE)_(MODE|SOURCE)=mock'

hits=$(
  grep -rnE "$PATTERN" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.sh' \
    --include='*.json' --include='*.env' --include='*.example' --include='*.yml' --include='*.yaml' \
    apps/*/src services/*/src packages/*/src scripts deploy .env.example docker-compose.yml 2>/dev/null \
    | grep -vE '(\.test\.|__tests__|__fixtures__|/e2e/|check-no-mocks\.sh)' || true
)

if [[ -n "$hits" ]]; then
  echo "!!! mock data or a mock mode is back in shipped code:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "no mock data or mock modes in shipped code"
