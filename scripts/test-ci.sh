#!/bin/bash

# Runs the same steps as .github/workflows/ci.yml, in the same order, and stops at the first failure.
# Usage: ./scripts/test-ci.sh            (uses the installed Chromium from PLAYWRIGHT_CHROMIUM_PATH if set)
set -euo pipefail

cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"

echo "PocketChest checks (CI order) in $(pwd)"
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run check:legacy
npm run test:unit
npm run test:worker
npm run test:contracts
npm run test:e2e
npm run build
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
npm run audit:high
echo "All CI steps passed."
