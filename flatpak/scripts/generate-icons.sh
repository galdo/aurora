#!/usr/bin/env bash
#
# generate-icons.sh
# -----------------
# Renders the Aurora Pulse application icon (squircle / rounded variant)
# into all sizes required by Linux desktop environments and the Flatpak
# build, and drops them into flatpak/icons/<size>x<size>/.
#
# Source of truth for the icon shape is the squircle PNG from assets/icons/.
# We re-render from a single high-resolution master so the rounded corners
# stay consistent across every size.
#
# Why not let the OS round the corners?
#   GNOME, KDE and the Flatpak software-center renderer do NOT apply a
#   universal icon mask the way Android or iOS do. App icons are rendered
#   1:1 from the PNG/SVG. Modern looking apps therefore bake the rounded
#   shape into the icon itself.
#
# Requirements:
#   * One of: ImageMagick (magick / convert), sips (preinstalled on macOS),
#             rsvg-convert (for the optional SVG → PNG fallback)
#
# Usage:
#   ./flatpak/scripts/generate-icons.sh           # uses the default master
#   ./flatpak/scripts/generate-icons.sh PATH      # use a custom master PNG
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MASTER="${1:-$REPO_ROOT/assets/icons/icon-squircle.png}"
OUT_DIR="$REPO_ROOT/flatpak/icons"
APP_ID="app.better_craft.aurorapulse"

SIZES=(16 24 32 48 64 96 128 192 256 384 512 1024)

if [[ ! -f "$MASTER" ]]; then
  echo "ERROR: master icon not found: $MASTER" >&2
  exit 1
fi

echo "Generating Aurora Pulse Linux icons"
echo "  master: $MASTER"
echo "  out:    $OUT_DIR"
echo

# Choose the best available rasterizer
RENDERER=""
if command -v magick >/dev/null 2>&1; then
  RENDERER="magick"
elif command -v convert >/dev/null 2>&1; then
  RENDERER="convert"
elif command -v sips >/dev/null 2>&1; then
  RENDERER="sips"
else
  echo "ERROR: no usable image tool found (need magick, convert or sips)" >&2
  exit 1
fi

echo "Using renderer: $RENDERER"
echo

render() {
  local size="$1"
  local target="$2"
  case "$RENDERER" in
    magick)
      magick "$MASTER" \
        -filter Lanczos \
        -resize "${size}x${size}" \
        -strip \
        -define png:color-type=6 \
        "$target"
      ;;
    convert)
      convert "$MASTER" \
        -filter Lanczos \
        -resize "${size}x${size}" \
        -strip \
        "$target"
      ;;
    sips)
      # sips writes alongside, then we move
      local tmp
      tmp="$(mktemp -t auroraicon).png"
      cp "$MASTER" "$tmp"
      sips -s format png -z "$size" "$size" "$tmp" \
           --out "$target" >/dev/null
      rm -f "$tmp"
      ;;
  esac
}

# Render PNGs for the hicolor sizes that GNOME / KDE / Flatpak look up
HICOLOR_SIZES=(16 24 32 48 64 96 128 192 256 384 512)
for size in "${HICOLOR_SIZES[@]}"; do
  dir="$OUT_DIR/${size}x${size}"
  mkdir -p "$dir"
  out="$dir/${APP_ID}.png"
  echo "  → ${size}x${size} -> $out"
  render "$size" "$out"
done

# A 1024x1024 copy is useful for stores / preview pages
mkdir -p "$OUT_DIR/1024x1024"
cp "$MASTER" "$OUT_DIR/1024x1024/${APP_ID}.png"
echo "  → 1024x1024 (copy of master)"

# Generate a "scalable" SVG wrapper around the largest PNG.
# A real vector SVG would be better, but a PNG-embedded SVG still wins
# over having no scalable icon at all (HiDPI displays get a sharper
# fallback target than rescaling 256px).
SCALABLE_DIR="$OUT_DIR/scalable/apps"
mkdir -p "$SCALABLE_DIR"
SCALABLE_SVG="$SCALABLE_DIR/${APP_ID}.svg"

base64_master="$(base64 < "$MASTER" | tr -d '\n')"
cat > "$SCALABLE_SVG" <<SVG
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="512" height="512" viewBox="0 0 512 512">
  <title>Aurora Pulse</title>
  <image x="0" y="0" width="512" height="512"
         preserveAspectRatio="xMidYMid meet"
         xlink:href="data:image/png;base64,${base64_master}"/>
</svg>
SVG

echo "  → scalable SVG -> $SCALABLE_SVG"
echo
echo "Done."
echo
echo "Hint: replace assets/icons/icon-squircle.png with a hand-drawn"
echo "vector SVG eventually (true scalable, smaller, sharper)."