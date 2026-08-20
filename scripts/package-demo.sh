#!/usr/bin/env bash
# Zip the free itch.io browser demo: like package-web.sh, but images/ and the
# manifest are pruned to the nodes scene.json actually references, so the
# teaser loads fast and does not ship the whole photo archive.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/treasure-factory-demo.zip"
mkdir -p "$ROOT/dist"
rm -f "$OUT"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/app/." "$STAGE/"
rm -f "$STAGE/editor.html" "$STAGE/editor.js"
rm -f "$STAGE/images/.build-cache"

python3 - "$STAGE" <<'EOF'
import json, os, sys
stage = sys.argv[1]
scene = json.load(open(os.path.join(stage, 'scene.json')))
keep = {n['image'] for n in scene.get('nodes', [])}
mpath = os.path.join(stage, 'images', 'manifest.json')
manifest = json.load(open(mpath))
pruned = {k: v for k, v in manifest.items() if k in keep}
missing = keep - set(pruned)
if missing:
    sys.exit(f'scene.json references images not in the manifest: {sorted(missing)}')
files = {v['file'] for v in pruned.values()}
for f in os.listdir(os.path.join(stage, 'images')):
    if f != 'manifest.json' and f not in files:
        os.remove(os.path.join(stage, 'images', f))
json.dump(pruned, open(mpath, 'w'), indent=1)
print(f'demo keeps {len(pruned)} of {len(manifest)} images')
EOF

( cd "$STAGE" && zip -r -q "$OUT" . -x '.*' '*/.*' )
echo "Wrote $OUT"
unzip -l "$OUT" | tail -3
