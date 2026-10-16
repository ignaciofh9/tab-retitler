#!/bin/sh
# Renders the extension icons from the SVGs in src/ with headless Chrome,
# then scales them with macOS's sips. Writes tab-retitler/icons/.
#
#   store-assets/render-icons.sh
#
# icon.svg        128 px store icon: 96 px artwork with 16 px padding
# icon-full.svg   48 px toolbar icon
# icon-small.svg  16 and 32 px: simplified so it stays crisp
set -e
cd "$(dirname "$0")/src"
SRC="$(pwd)"
ICONS="$SRC/../../tab-retitler/icons"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

for name in icon icon-full icon-small; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --user-data-dir="$PROFILE" --window-size=512,512 \
    --screenshot="$SRC/$name-512.png" "file://$SRC/render.html#$name.svg" >/dev/null 2>&1
done

mkdir -p "$ICONS"
sips -z 128 128 "$SRC/icon-512.png" --out "$ICONS/icon-128.png" >/dev/null
sips -z 48 48 "$SRC/icon-full-512.png" --out "$ICONS/icon-48.png" >/dev/null
sips -z 32 32 "$SRC/icon-small-512.png" --out "$ICONS/icon-32.png" >/dev/null
sips -z 16 16 "$SRC/icon-small-512.png" --out "$ICONS/icon-16.png" >/dev/null
echo "Wrote $(ls "$ICONS" | wc -l | tr -d ' ') icons to tab-retitler/icons/"
