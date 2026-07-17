#!/bin/bash
# Prebuilt Vercel deploy: build on YOUR machine, upload only artifacts.
# Cloud builds recompile the whole Rust dependency tree from scratch on a
# small builder (~6-10 minutes, plus per-account queue time); this flow
# deploys in seconds. Git-push auto-builds are disabled in vercel.json
# ("git": {"deploymentEnabled": false}) — this script IS the deploy path.
#
#   scripts/deploy-prebuilt.sh             # production
#   scripts/deploy-prebuilt.sh --preview   # preview deploy
#
# One-time setup:
#   npm i -g vercel && vercel login && vercel link
#   cargo install cargo-zigbuild     # cross-compiles for Lambda's glibc
#   pip install ziglang              # zig toolchain (or install zig any way)
#
# Full guide: https://nextrs-docs.vercel.app/docs/deploy-prebuilt
set -euo pipefail
cd "$(dirname "$0")/.."

[ "${1:-}" = "--preview" ] && FLAGS=() || FLAGS=(--prod)

vercel pull --yes --environment=production > /dev/null
vercel build "${FLAGS[@]}"

# Refuse to ship if the Rust function silently failed to build (the classic
# missing-cargo-zigbuild failure: everything green, no binary in the output).
if ! find .vercel/output/functions -name '*.func' -type d 2>/dev/null | grep -q .; then
  echo "ERROR: no function in .vercel/output — is cargo-zigbuild installed and zig reachable?" >&2
  exit 1
fi

vercel deploy --prebuilt "${FLAGS[@]}"
