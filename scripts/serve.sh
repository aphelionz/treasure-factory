#!/usr/bin/env bash
# Serve the static game over http://localhost so fetch() of scene.json works
# (browsers block fetch of local files under file://).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-8080}"
echo "Serving app/ at http://localhost:${PORT}  (player: /  editor: /editor.html)"
exec python3 -m http.server "$PORT" --directory "$ROOT/app"
