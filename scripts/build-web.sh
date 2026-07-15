#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/web/dist"
WASM_PATH="$ROOT_DIR/target/wasm32-unknown-unknown/wasm-release/celluar_automata.wasm"

if ! rustup target list --installed | grep -qx 'wasm32-unknown-unknown'; then
  echo "Missing Rust WASM target. Run: rustup target add wasm32-unknown-unknown" >&2
  exit 1
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "Missing wasm-bindgen CLI. Install the version from Cargo.lock." >&2
  echo "Run: cargo install --locked wasm-bindgen-cli --version 0.2.126" >&2
  exit 1
fi

cd "$ROOT_DIR"
cargo build --locked --target wasm32-unknown-unknown --profile wasm-release

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
cp "$ROOT_DIR/web/index.html" "$ROOT_DIR/web/style.css" "$DIST_DIR/"

wasm-bindgen \
  --target web \
  --no-typescript \
  --out-name cellular_automata \
  --out-dir "$DIST_DIR" \
  "$WASM_PATH"

echo "Web build written to $DIST_DIR"
