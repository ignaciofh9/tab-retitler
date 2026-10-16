#!/bin/sh
# Builds the Chrome Web Store package into dist/: the extension folder minus
# test-only files, checked so nothing it refers to is missing.
#
#   ./build.sh
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
VERSION="$(python3 -c 'import json; print(json.load(open("tab-retitler/manifest.json"))["version"])')"
OUT="$ROOT/dist/tab-retitler-$VERSION.zip"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

cp -R tab-retitler/. "$BUILD/"
find "$BUILD" -name '.*' -exec rm -rf {} +

# preview-shim.js only lets options.html open as a plain web page for testing.
rm -f "$BUILD/preview-shim.js"
python3 - "$BUILD/options.html" <<'EOF'
import sys
path = sys.argv[1]
html = open(path).read()
html = "".join(line for line in html.splitlines(keepends=True) if "preview-shim.js" not in line)
open(path, "w").write(html)
EOF

# Every file the manifest and the page load must be in the package.
python3 - "$BUILD" <<'EOF'
import json, os, re, sys
build = sys.argv[1]
m = json.load(open(os.path.join(build, "manifest.json")))
needed = set(m["icons"].values()) | set(m["action"]["default_icon"].values())
needed |= {m["background"]["service_worker"], m["options_ui"]["page"], m["side_panel"]["default_path"]}
html = open(os.path.join(build, "options.html")).read()
needed |= set(re.findall(r'(?:src|href)="([^"#:]+)"', html))
missing = sorted(f for f in needed if not os.path.exists(os.path.join(build, f)))
if missing:
    sys.exit("Missing from the package: " + ", ".join(missing))
if "preview-shim" in html:
    sys.exit("options.html still loads preview-shim.js")
print(f"Checked {len(needed)} files the extension loads.")
EOF

mkdir -p "$ROOT/dist"
rm -f "$OUT"
(cd "$BUILD" && zip -r -X -q "$OUT" .)
echo "Built $OUT ($(du -k "$OUT" | cut -f1) KB)"
