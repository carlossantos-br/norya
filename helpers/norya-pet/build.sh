#!/bin/bash
# Compila e assina o norya-pet (Mach-O puro, sem .app) com swiftc, sem Xcode.
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

SDK="$(xcrun --sdk macosx --show-sdk-path)"
IDENTITY="$(bash "$HERE/../ensure-signing-identity.sh")"
OUT="build/norya-pet"

mkdir -p build
rm -f "$OUT"
swiftc -O -swift-version 5 -sdk "$SDK" -target arm64-apple-macos14 \
  src/*.swift -o "$OUT" -framework AppKit -framework ImageIO
codesign --force --sign "$IDENTITY" --options runtime "$OUT"
echo "==> Pronto: $HERE/$OUT"
