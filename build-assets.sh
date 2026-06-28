#!/usr/bin/env bash
# Resize + convert the raw room photos to WebP and (re)build the image manifest.
# Reads the original photo folders in place (never modifies them); writes only
# into app/images/. Skips files whose source is unchanged since the last run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/app/images"
CACHE="$OUT/.build-cache"          # lines: key|sig|w|h  (sig = mtime-size of source)
MANIFEST="$OUT/manifest.json"
MAXDIM=1600
QUALITY=82

# The originals, read in place. Add room folders here as the miniature grows.
SOURCES=("$ROOT/Gold and green" "$ROOT/Snax room" "$ROOT/Yellow Room")

command -v magick >/dev/null || { echo "error: ImageMagick (magick) not found" >&2; exit 1; }
mkdir -p "$OUT"
touch "$CACHE"

# lowercase; collapse any run of non [a-z0-9_] into a single hyphen; trim hyphens.
slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_]+/-/g; s/^-+//; s/-+$//'
}

NEWCACHE="$(mktemp)"
ENTRIES="$(mktemp)"
trap 'rm -f "$NEWCACHE" "$ENTRIES"' EXIT

processed=0
skipped=0

for dir in "${SOURCES[@]}"; do
  [ -d "$dir" ] || { echo "warn: missing source folder: $dir" >&2; continue; }
  folder_slug="$(slugify "$(basename "$dir")")"

  while IFS= read -r src; do
    base="$(basename "$src")"
    name="${base%.*}"
    file_slug="$(slugify "$name")"
    # Avoid doubling the room name when the filename already carries it.
    case "$file_slug" in
      "$folder_slug"*) key="$file_slug" ;;
      *)               key="${folder_slug}-${file_slug}" ;;
    esac

    if grep -q "^${key}|" "$ENTRIES" 2>/dev/null; then
      echo "warn: duplicate key '$key' from $src (skipping)" >&2
      continue
    fi

    out="$OUT/$key.webp"
    sig="$(stat -f '%m-%z' "$src")"
    cached="$(grep -F "${key}|${sig}|" "$CACHE" 2>/dev/null | head -1 || true)"

    if [ -n "$cached" ] && [ -f "$out" ]; then
      w="$(printf '%s' "$cached" | cut -d'|' -f3)"
      h="$(printf '%s' "$cached" | cut -d'|' -f4)"
      skipped=$((skipped + 1))
    else
      magick "$src" -auto-orient -resize "${MAXDIM}x${MAXDIM}>" -strip -quality "$QUALITY" "$out"
      dims="$(magick identify -format '%w %h' "$out")"
      w="${dims% *}"; h="${dims#* }"
      processed=$((processed + 1))
    fi

    printf '%s|%s|%s|%s\n' "$key" "$sig" "$w" "$h" >> "$NEWCACHE"
    printf '%s|%s|%s|%s\n' "$key" "$key.webp" "$w" "$h" >> "$ENTRIES"
  done < <(find "$dir" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | sort)
done

mv "$NEWCACHE" "$CACHE"

# Build manifest.json from the entries (python for safe JSON generation).
python3 - "$ENTRIES" "$MANIFEST" <<'PY'
import sys, json
entries_path, manifest_path = sys.argv[1], sys.argv[2]
m = {}
with open(entries_path) as f:
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        key, file, w, h = line.split("|")
        m[key] = {"file": file, "w": int(w), "h": int(h)}
with open(manifest_path, "w") as f:
    json.dump(m, f, indent=2, sort_keys=True)
    f.write("\n")
print(f"manifest: {len(m)} images")
PY

echo "assets: $processed processed, $skipped skipped -> $OUT"
