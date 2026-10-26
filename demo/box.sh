#!/usr/bin/env bash
# The demo box: code-server with Ophan, serving the sample app at http://127.0.0.1:8091.
#   demo/box.sh build                 build the image (run demo/prepare.sh first)
#   demo/box.sh up                    start it with a fresh copy of the sample app
#   demo/box.sh reset [cache|empty]   fresh sample app; "cache" restores the pre-analyzed database
#   demo/box.sh analyze-cache         analyze the sample app and its fixed variant into demo/out/cache
#   demo/box.sh down
# ANTHROPIC_API_KEY is passed from your environment at run time; it is never baked into the image.
set -euo pipefail
cd "$(dirname "$0")"
NAME=ophan-demo
IMAGE=ophan-demo:local
WS=/home/coder/acme-api
CACHE="$PWD/out/cache"

run() { docker exec -u coder "$NAME" bash -lc "$1"; }

fresh() {
  run "rm -rf $WS && cp -R /opt/acme-api $WS"
}

# Applies demo/fix.json to the workspace, exactly as the rig types it.
apply_fix() {
  node -e '
    const fix = require("./fix.json");
    let s = require("fs").readFileSync(0, "utf8");
    for (const l of fix.lines) { if (!s.includes(l.from)) throw new Error("fix.json does not match: " + l.from); s = s.replace(l.from, l.to); }
    process.stdout.write(s);
  ' < "sample-app/$(node -p 'require("./fix.json").file')" \
  | docker exec -i -u coder "$NAME" bash -c "cat > $WS/$(node -p 'require("./fix.json").file')"
}

case "${1:-}" in
  build)
    docker build -t "$IMAGE" .
    ;;
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --hostname ophan -p 127.0.0.1:8091:8080 \
      -e ANTHROPIC_API_KEY -e OPHAN_MODEL \
      "$IMAGE" --auth none --disable-telemetry --disable-update-check --disable-workspace-trust "$WS" >/dev/null
    fresh
    until curl -sf http://127.0.0.1:8091/healthz >/dev/null; do sleep 1; done
    echo "box up: http://127.0.0.1:8091/?folder=$WS"
    ;;
  reset)
    # code-server keeps each closed browser's extension host alive for hours waiting for a
    # reconnect, each with its own Ophan watcher: restart so every take starts with one.
    docker restart "$NAME" >/dev/null
    until curl -sf http://127.0.0.1:8091/healthz >/dev/null; do sleep 1; done
    fresh
    if [ "${2:-cache}" = "cache" ]; then
      docker cp "$CACHE/index.db" "$NAME:/tmp/index.db"
      docker exec -u root "$NAME" chown coder:coder /tmp/index.db   # docker cp writes as root
      run "mkdir -p $WS/.ophan && mv /tmp/index.db $WS/.ophan/index.db"
    fi
    ;;
  analyze-cache)
    : "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
    fresh
    run "cd $WS && npx @ophan/cli analyze"
    # Graph and architecture docs describe the code as the clips start: before the fix.
    run "cd $WS && npx @ophan/cli graph --summarize | tail -4"
    apply_fix
    run "cd $WS && npx @ophan/cli analyze"
    mkdir -p "$CACHE"
    docker cp "$NAME:$WS/.ophan/index.db" "$CACHE/index.db"
    fresh
    echo "cache: $CACHE/index.db"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null
    ;;
  *)
    sed -n '2,8p' "$0"; exit 1
    ;;
esac
