#!/usr/bin/env bash
# Packages this checkout for the demo box: the CLI as an npm tarball and the extension as a
# linux VSIX (for the box's CPU) carrying better-sqlite3 binaries for code-server's Node.
#   demo/prepare.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/demo/out/build"
ARCH="$(docker version --format '{{.Server.Arch}}')"   # arm64 on Apple Silicon, amd64 elsewhere
[ "$ARCH" = "amd64" ] && ARCH=x64
rm -rf "$OUT" && mkdir -p "$OUT"

pnpm build
pnpm notices >/dev/null

# CLI tarball
(cd packages/cli && pnpm pack --pack-destination "$OUT" >/dev/null)
mv "$OUT"/ophan-cli-*.tgz "$OUT/ophan-cli.tgz"

# Extension: copy, swap in linux native binaries for Node 22 and 24 hosts, package.
STAGE="$OUT/vscode"
rsync -a --exclude node_modules --exclude native --exclude '*.vsix' packages/vscode/ "$STAGE/"
BS3="$(cd packages/vscode/node_modules/better-sqlite3 && pwd -P)"
PREBUILD="$(node -p "require.resolve('prebuild-install/bin.js', { paths: [process.argv[1]] })" "$BS3")"
for ENTRY in 22.0.0:127 24.0.0:137; do
  TMP="$(mktemp -d)"
  cp "$BS3/package.json" "$TMP/"
  (cd "$TMP" && node "$PREBUILD" --runtime node --target "${ENTRY%%:*}" --platform linux --arch "$ARCH" --force >/dev/null 2>&1)
  mkdir -p "$STAGE/native/node-${ENTRY##*:}"
  cp "$TMP/build/Release/better_sqlite3.node" "$STAGE/native/node-${ENTRY##*:}/"
  rm -rf "$TMP"
done
(cd "$STAGE" && npx -y @vscode/vsce package --target "linux-$ARCH" --no-dependencies -o "$OUT/ophan.vsix" >/dev/null)
file "$STAGE"/native/*/better_sqlite3.node
ls -la "$OUT"
