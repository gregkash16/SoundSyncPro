#!/usr/bin/env bash
# Build a signed macOS ZXP of this extension. Run ON A MAC (Adobe: sign on the target platform).
# Usage:  ./build-zxp.sh            (version from CSXS/manifest.xml)
#         ./build-zxp.sh 1.1.0      (bumps the manifest first)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HOME/.cep-tools"
SIGN="$TOOLS/ZXPSignCmd"
CERT="$TOOLS/cep-selfsigned.p12"
PWF="$TOOLS/cep-selfsigned.pw"
REQUIRED_BINS=(ffmpeg-arm64 ffmpeg-x64 ffprobe-arm64 ffprobe-x64)

mkdir -p "$TOOLS"
if [ ! -x "$SIGN" ]; then
  echo "Downloading ZXPSignCmd (macOS)..."
  curl -L -o "$SIGN" "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/macOS/ZXPSignCmd"
  chmod +x "$SIGN"
  xattr -d com.apple.quarantine "$SIGN" 2>/dev/null || true
fi
if [ ! -f "$CERT" ]; then
  PW="$(head -c 400 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24)"
  "$SIGN" -selfSignedCert US NY "CEP Panels" "CEP Panels" "$PW" "$CERT"
  printf '%s' "$PW" > "$PWF"
  echo "Created self-signed certificate $CERT"
fi
PW="$(cat "$PWF")"

MANIFEST="$ROOT/CSXS/manifest.xml"
NAME="$(sed -n 's/.*ExtensionBundleName="\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
if [ "${1:-}" != "" ]; then
  VERSION="$1"
  sed -i '' -e "s/ExtensionBundleVersion=\"[^\"]*\"/ExtensionBundleVersion=\"$VERSION\"/" \
            -e "s/\(<Extension Id=\"[^\"]*\" Version=\"\)[^\"]*\"/\1$VERSION\"/" "$MANIFEST"
  echo "Manifest bumped to $VERSION"
else
  VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
fi

for b in "${REQUIRED_BINS[@]}"; do
  [ -f "$ROOT/bin/mac/$b" ] || { echo "bin/mac/$b is missing - run ./get-bins.sh first"; exit 1; }
done

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/zxp-stage-XXXX")"
for d in CSXS client host; do cp -R "$ROOT/$d" "$STAGE/$d"; done
mkdir -p "$STAGE/bin"
cp -R "$ROOT/bin/mac" "$STAGE/bin/mac"
for f in README.md INSTALL.md; do [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/"; done
find "$STAGE" \( -name .DS_Store -o -name .gitkeep -o -name Thumbs.db -o -name '*.part' \) -delete
find "$STAGE/bin/mac" -type f -exec chmod 755 {} \;
find "$STAGE" -type l -delete   # Adobe: no symlinks inside a ZXP

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/$NAME-$VERSION-mac.zxp"
rm -f "$OUT"
echo "Signing $OUT ..."
if ! "$SIGN" -sign "$STAGE" "$OUT" "$CERT" "$PW" -tsa http://timestamp.digicert.com; then
  echo "Timestamp server failed; signing without timestamp."
  "$SIGN" -sign "$STAGE" "$OUT" "$CERT" "$PW"
fi
"$SIGN" -verify "$OUT"
rm -rf "$STAGE"
echo
echo "OK  $OUT  ($(du -m "$OUT" | cut -f1) MB)"
