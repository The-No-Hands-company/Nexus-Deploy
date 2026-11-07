#!/usr/bin/env bash
# Quality gate for Nexus-Deploy. Runs from any working directory.
set -euo pipefail
cd "$(dirname "$0")"

echo "nexus-deploy..."

# If node_modules lives on a noexec mount, stage executable esbuild copies in /tmp
# so tsx and vite can spawn them during typecheck/test runs.
if [ -z "${ESBUILD_BINARY_PATH:-}" ]; then
  ESBUILD_SRC="node_modules/@esbuild/linux-x64/bin/esbuild"
  if [ -f "$ESBUILD_SRC" ] && [ ! -x "$ESBUILD_SRC" ]; then
    TMP_TOOLS="${TMPDIR:-/tmp}/nexus-deploy-tools"
    mkdir -p "$TMP_TOOLS"
    cp "$ESBUILD_SRC" "$TMP_TOOLS/esbuild"
    chmod +x "$TMP_TOOLS/esbuild"
    export ESBUILD_BINARY_PATH="$TMP_TOOLS/esbuild"
  fi
fi

node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
node ./web/node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit
node --import tsx --test tests/*.test.ts

echo "PASS"
