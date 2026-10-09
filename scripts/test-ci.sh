#!/bin/bash

# Runs the same checks as .github/workflows/ci.yml
# Usage: ./scripts/test-ci.sh

set -e

# Run from the project root (parent of the scripts directory)
cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"

echo "🧪 Running PocketChest checks (CI mode) in $(pwd)"

echo "📦 Installing dependencies..."
npm ci

echo "🔍 Type checking..."
npm run typecheck

echo "🧹 Linting..."
npm run lint
npm run format:check

echo "🧪 Running tests..."
npm test

echo "🏗️  Building frontend..."
npm run build

echo "📦 Verifying Worker bundle..."
npx wrangler deploy --dry-run --outdir .wrangler/dry-run

echo ""
echo "✅ All checks passed"
