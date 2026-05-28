#!/bin/sh
# Compile the macOS system-audio helper (atelier-systemaudio.swift) if
# we're on macOS and swiftc is available. Silent no-op on every other
# platform — atelier still works there, just without the ScreenCaptureKit
# path for `--system-audio` (Linux uses PulseAudio monitor sources,
# Windows uses dshow loopback drivers — neither needs Swift).
#
# Called from the `build:macos-helper` npm script. Safe to run repeatedly
# (skips when the binary is already up to date).

set -e

# Only macOS has ScreenCaptureKit + swiftc.
if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[macos-helper] swiftc not found — skipping. Install Xcode Command Line Tools to enable --system-audio on macOS."
  exit 0
fi

# Resolve paths relative to this script so it works regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$PKG_DIR/macos-helper/atelier-systemaudio.swift"
PLIST="$PKG_DIR/macos-helper/Info.plist"
OUT_DIR="$PKG_DIR/dist/macos-helper"
OUT="$OUT_DIR/systemaudio"

if [ ! -f "$SRC" ]; then
  echo "[macos-helper] source missing at $SRC — skipping."
  exit 0
fi

# Up-to-date check: skip if output is newer than source + plist.
if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ] && [ "$OUT" -nt "$PLIST" ]; then
  exit 0
fi

mkdir -p "$OUT_DIR"
echo "[macos-helper] compiling $SRC → $OUT"
swiftc -O \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
  -o "$OUT" \
  "$SRC"
echo "[macos-helper] built $(ls -lh "$OUT" | awk '{print $5}')"
