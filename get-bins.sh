#!/usr/bin/env bash
# Fetch the macOS binaries SoundSyncPro bundles -> bin/mac/
#   ffmpeg-arm64 / ffmpeg-x64 / ffprobe-arm64 / ffprobe-x64
# Static builds from ffmpeg.martin-riedl.de: native on Apple Silicon and Intel, no Rosetta.
# The panel picks the "-arm64" / "-x64" variant for the current CPU (see client/runtime.js).
# Run on a Mac.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/bin/mac"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$BIN"

for arch in arm64 amd64; do
  suffix="$arch"; [ "$arch" = amd64 ] && suffix=x64
  for tool in ffmpeg ffprobe; do
    echo "$tool ($suffix, martin-riedl.de)..."
    curl -fL --retry 3 -o "$TMP/$tool-$suffix.zip" \
      "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$arch/release/$tool.zip" \
      || { echo "download failed: $tool $arch"; exit 1; }
    unzip -q -o "$TMP/$tool-$suffix.zip" -d "$TMP/x-$tool-$suffix"
    cp "$TMP/x-$tool-$suffix/$tool" "$BIN/$tool-$suffix"
  done
done

chmod 755 "$BIN"/*
xattr -dr com.apple.quarantine "$BIN" 2>/dev/null || true
ls -lh "$BIN"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
"$BIN/ffmpeg-$ARCH" -version | head -1
