#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="$(printf '%s' "$ROOT_DIR" | shasum | cut -d' ' -f1)"
INSTANCE_ID="${AURI_INSTANCE_ID:-watch-${PROJECT_ID:0:12}-$$}"
RUN_DIR="${TMPDIR:-/tmp}/auri-native-watch-${PROJECT_ID}-$$"
SERVER_PID=""
WATCH_PID=""

mkdir -p "$RUN_DIR"

stop_pid() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  local child
  while read -r child; do
    [[ -n "$child" ]] && stop_pid "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  [[ -n "$WATCH_PID" ]] && stop_pid "$WATCH_PID"
  [[ -n "$SERVER_PID" ]] && stop_pid "$SERVER_PID"
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT INT TERM

if [[ -z "${AURI_DEV_PORT:-}" ]]; then
  AURI_DEV_PORT="$(node - <<'NODE'
const net = require("node:net");
const server = net.createServer();
server.unref();
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
  server.close();
});
NODE
)"
fi

export AURI_DEV_PORT
export AURI_DIST_DIR="$RUN_DIR/dist"
DEV_URL="http://127.0.0.1:${AURI_DEV_PORT}/?auri-instance=${INSTANCE_ID}"
export TAURI_CONFIG="$(node scripts/launch-config.mjs "$INSTANCE_ID" "$DEV_URL" "auri-dev")"
FRONTEND_LOG="$RUN_DIR/frontend.log"

npm run dev:web > "$FRONTEND_LOG" 2>&1 &
SERVER_PID=$!

for _ in {1..100}; do
  if curl --silent --fail --max-time 1 "http://127.0.0.1:${AURI_DEV_PORT}/" >/dev/null; then
    break
  fi
  sleep 0.1
done

if ! curl --silent --fail --max-time 1 "http://127.0.0.1:${AURI_DEV_PORT}/" >/dev/null; then
  echo "Failed to start isolated frontend server. See $FRONTEND_LOG" >&2
  exit 1
fi

echo "Watching Auri sources as independent instance $INSTANCE_ID on port $AURI_DEV_PORT."
echo "Press Ctrl+C to stop only this watcher and its app process."

cargo watch \
  --workdir src-tauri \
  --watch . \
  --watch ../src \
  --watch ../index.html \
  --watch ../styles.css \
  --ignore 'target/**' \
  --shell 'cargo run --bin auri-dev' &
WATCH_PID=$!
wait "$WATCH_PID"
