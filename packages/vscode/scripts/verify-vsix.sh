#!/usr/bin/env bash
# Verify a VSIX contains the expected native binaries.
#
# Unpacks the VSIX and checks for the native/ directory structure with
# per-Electron-ABI better_sqlite3.node files.
#
# Usage: ./scripts/verify-vsix.sh path/to/extension.vsix
# Or:    pnpm verify:vsix path/to/extension.vsix
set -euo pipefail

VSIX="${1:?Usage: $0 <path-to-vsix>}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> Inspecting: $VSIX"
echo "    Size: $(du -sh "$VSIX" | cut -f1)"
unzip -q -o "$VSIX" -d "$WORK"

echo ""
echo "=== Native binaries ==="
BINARIES=$(find "$WORK" -name "better_sqlite3.node" 2>/dev/null || true)
if [ -z "$BINARIES" ]; then
  echo "  ERROR: No native binaries found!"
  exit 1
fi

while IFS= read -r f; do
  REL="${f#"$WORK"/extension/}"
  echo "  $REL"
  echo "    $(file -b "$f" | head -c 100)"
done <<< "$BINARIES"

echo ""
echo "=== Bundled ABI directories ==="
NATIVE_DIR="$WORK/extension/native"
if [ -d "$NATIVE_DIR" ]; then
  ls -1 "$NATIVE_DIR" | sed 's/^/  /'
  COUNT=$(find "$NATIVE_DIR" -name "better_sqlite3.node" | wc -l | tr -d ' ')
  echo ""
  echo "  Total: $COUNT native binary/binaries in native/"
  if [ "$COUNT" -lt 7 ]; then
    echo "  WARNING: Expected at least 7 (6 Electron ABIs + 1 Node.js)"
  else
    echo "  OK"
  fi
else
  echo "  WARNING: No native/ directory found in VSIX"
  echo "  The extension may still work via node_modules/better-sqlite3/build/"
fi

echo ""
echo "=== VSIX contents summary ==="
echo "  Total files: $(find "$WORK" -type f | wc -l | tr -d ' ')"
echo "  Total size (unpacked): $(du -sh "$WORK" | cut -f1)"
