#!/usr/bin/env bash
# Build better-sqlite3 native binaries for multiple Electron versions.
#
# Populates packages/vscode/native/ with per-ABI binaries so the runtime
# loader (native-loader.ts) can select the correct one for the current editor.
#
# Usage: ./scripts/build-native.sh
# Run from packages/vscode/ or use: pnpm build:native
#
# Prerequisites: pnpm install (to get better-sqlite3 and @electron/rebuild)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VSCODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$VSCODE_DIR"

# ── Electron version → ABI mapping ──
# Update these when adding support for new editor Electron versions.
# To find an editor's ABI: open its DevTools console and run:
#   console.log(process.versions.modules)
# Or use: ./scripts/detect-abi.sh
#
# These values MUST be verified before updating. See:
#   docs/release-lifecycle/native-binary-bundling.md
#
# Format: "electron_version:abi" (one per line, no associative arrays -- bash 3 compat)
ELECTRON_ABIS="
30.0.0:123
32.0.0:128
34.0.0:132
35.0.0:133
37.0.0:136
39.0.0:140
40.0.0:143
41.0.0:145
42.0.0:146
43.0.0:148
"

# Plain Node.js extension hosts (code-server, VS Code Remote server, WSL), one per Node major.
# Prebuilt binaries are downloaded rather than compiled.
NODE_ABIS="
22.0.0:127
24.0.0:137
"
# ─────────────────────────────────────

# Verify better-sqlite3 is installed
if [ ! -d "node_modules/better-sqlite3" ]; then
  echo "ERROR: better-sqlite3 not found. Run 'pnpm install' first."
  exit 1
fi

# Clean previous builds
rm -rf native
ARCH="${npm_config_arch:-$(node -p process.arch)}"
BS3_DIR="$(cd node_modules/better-sqlite3 && pwd -P)"
PREBUILD="$(node -p "require.resolve('prebuild-install/bin.js', { paths: [process.argv[1]] })" "$BS3_DIR")"

# The binary for this machine's Node.js. Fetched rather than copied: node_modules may hold an
# Electron build left by an earlier electron-rebuild.
fetch_host_node_binary() {
  (cd "$BS3_DIR" && node "$PREBUILD" --runtime node --target "$(node -p process.versions.node)" --arch "$ARCH" --force)
}

echo "==> Fetching Node.js $(node -v) binary (fallback for Node hosts without a matching node-<abi>)..."
fetch_host_node_binary
mkdir -p native/node
cp "$BS3_DIR/build/Release/better_sqlite3.node" native/node/
for ENTRY in $NODE_ABIS; do
  NODE_VERSION="${ENTRY%%:*}"
  ABI="${ENTRY##*:}"
  echo "==> Fetching prebuilt binary for Node.js $NODE_VERSION (ABI $ABI, $ARCH)..."
  (cd "$BS3_DIR" && node "$PREBUILD" --runtime node --target "$NODE_VERSION" --arch "$ARCH" --force)
  mkdir -p "native/node-${ABI}"
  cp "$BS3_DIR/build/Release/better_sqlite3.node" "native/node-${ABI}/"
done

for ENTRY in $ELECTRON_ABIS; do
  ELECTRON_VERSION="${ENTRY%%:*}"
  ABI="${ENTRY##*:}"
  echo "==> Building for Electron $ELECTRON_VERSION (ABI $ABI)..."
  npx electron-rebuild -f -w better-sqlite3 -v "$ELECTRON_VERSION" 2>&1 | tail -1
  mkdir -p "native/electron-${ABI}"
  cp node_modules/better-sqlite3/build/Release/better_sqlite3.node "native/electron-${ABI}/"
done

# electron-rebuild overwrites the node_modules binary: put this machine's Node.js build back
# for local dev and tests.
echo "==> Restoring Node.js binary for local dev..."
fetch_host_node_binary

echo ""
echo "=== Native binaries built ==="
find native -name "better_sqlite3.node" | sort | while IFS= read -r f; do
  echo "  $f ($(file -b "$f" | head -c 80))"
done
echo ""
echo "Directory structure:"
find native -type f | sort | sed 's/^/  /'
