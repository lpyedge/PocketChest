#!/bin/bash

# Deterministic source snapshot, mirroring the CWI scheme (fixed mtimes, fixed
# permissions, sorted entries):
#
#   1. wipe dist/ and npm run build -> dist/ (the static frontend the Worker serves)
#   2. stage wrangler.jsonc + package.json + package-lock.json + LICENSE +
#      src/worker/** + dist/** (release artifacts excluded) with normalized
#      mtimes/permissions, then zip sorted -> dist/releases/<name>-<version>.zip
#
# Unzip anywhere, then `npm ci && wrangler deploy`. The layout inside the zip
# matches what wrangler.jsonc expects (entry src/worker/index.ts, assets dist/).
#
# Note: `vite build` empties dist/, so this script always builds first and writes
# the zip afterwards; a later bare `npm run build` removes dist/releases/ again,
# and while present the zip is served as an ordinary static asset.
#
# Usage: ./scripts/package.sh   (or: npm run package)
set -euo pipefail

cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"

command -v zip >/dev/null || { echo "package.sh needs the 'zip' command." >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "package.sh needs the 'sha256sum' command." >&2; exit 1; }

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
ARCHIVE="${NAME}-${VERSION}.zip"
OUT="dist/releases/${ARCHIVE}"

echo "Packaging ${NAME} ${VERSION} in $(pwd)"
rm -rf dist
npm run build
mkdir -p dist/releases

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

# Top-level files that make the release deployable.
for file in wrangler.jsonc package.json package-lock.json LICENSE; do
	[ -f "${file}" ] || { echo "package.sh needs ./${file}: build it first." >&2; exit 1; }
	cp --parents "${file}" "${STAGE}/"
done
# The Worker source wrangler bundles at deploy time.
cp --parents -r src/worker "${STAGE}/"
# The built frontend the Worker serves; release artifacts of a previous run excluded.
find dist -type f ! -name '*.zip' -exec cp --parents -t "${STAGE}" {} +

# Normalize for determinism (CWI uses 2020-01-01 / 0644 the same way).
find "${STAGE}" -exec touch -h -d '2020-01-01T00:00:00Z' {} +
find "${STAGE}" -type f -exec chmod 644 {} +

TMP_ZIP="$(mktemp -u --suffix=.zip)"
trap 'rm -rf "${STAGE}" "${TMP_ZIP}"' EXIT
(
	cd "${STAGE}"
	find dist src wrangler.jsonc package.json package-lock.json LICENSE -type f | LC_ALL=C sort | zip -X -9 -q "${TMP_ZIP}" -@
)
STAGED_COUNT="$(cd "${STAGE}" && find . -type f | wc -l)"
ZIPPED_COUNT="$(zipinfo -1 "${TMP_ZIP}" | wc -l)"
[ "${STAGED_COUNT}" -eq "${ZIPPED_COUNT}" ] || { echo "package.sh: zip holds ${ZIPPED_COUNT} files, staged ${STAGED_COUNT}." >&2; exit 1; }
mv "${TMP_ZIP}" "${OUT}"
trap 'rm -rf "${STAGE}"' EXIT

echo "Wrote ${OUT} ($(sha256sum "${OUT}" | cut -d' ' -f1 | head -c 12)...)"
