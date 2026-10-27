#!/usr/bin/env bash
# Fetch the macOS binaries SoundSyncPro bundles: ffmpeg + ffprobe  ->  bin/mac/
# Run on a Mac. Static builds from evermeet.cx (x86_64; Apple Silicon runs them via Rosetta).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/bin/mac"
TMP="$(mktemp -d)"
mkdir -p "$BIN"

for tool in ffmpeg ffprobe; do
  echo "$tool (evermeet.cx static)..."
  curl -L -o "$TMP/$tool.zip" "https://evermeet.cx/$tool/getrelease/zip"
  unzip -q -o "$TMP/$tool.zip" -d "$TMP/$tool" && cp "$TMP/$tool/$tool" "$BIN/$tool"
done

chmod 755 "$BIN"/*
xattr -dr com.apple.quarantine "$BIN" 2>/dev/null || true
rm -rf "$TMP"
ls -lh "$BIN"
"$BIN/ffmpeg" -version | head -1
