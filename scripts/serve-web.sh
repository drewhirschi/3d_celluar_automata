#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8080}"

if [[ ! -f "$ROOT_DIR/web/dist/index.html" ]]; then
  "$ROOT_DIR/scripts/build-web.sh"
fi

echo "Serving http://127.0.0.1:$PORT"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT_DIR/web/dist"
