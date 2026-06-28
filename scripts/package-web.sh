#!/usr/bin/env bash
# Zip the static game for itch.io: index.html at the zip root, editor excluded.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/treasure-factory-web.zip"
mkdir -p "$ROOT/dist"
rm -f "$OUT"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/app/." "$STAGE/"
rm -f "$STAGE/editor.html" "$STAGE/editor.js"
rm -f "$STAGE/images/.build-cache"

( cd "$STAGE" && zip -r -q "$OUT" . -x '.*' '*/.*' )
echo "Wrote $OUT"
unzip -l "$OUT" | sed -n '1,8p'
