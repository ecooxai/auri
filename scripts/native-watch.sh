#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="$(printf '%s' "$ROOT_DIR" | shasum | cut -d' ' -f1)"
PID_FILE="${TMPDIR:-/tmp}/auri-native-watch-${PROJECT_ID}.pid"
SERVER_PID=""
WATCH_PID=""

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

# Also replace watchers started before this PID-file mechanism existed.
SOCKET_PATH="$HOME/.config/auri/command.sock"
if [[ -S "$SOCKET_PATH" ]]; then
  SOCKET_PID="$(lsof -t "$SOCKET_PATH" 2>/dev/null | head -n 1 || true)"
  if [[ "$SOCKET_PID" =~ ^[0-9]+$ ]] && kill -0 "$SOCKET_PID" 2>/dev/null; then
    ROOT_PID="$SOCKET_PID"
    CURRENT_PID="$SOCKET_PID"
    while [[ "$CURRENT_PID" =~ ^[0-9]+$ ]] && (( CURRENT_PID > 1 )); do
      COMMAND="$(ps -p "$CURRENT_PID" -o command= 2>/dev/null || true)"
      if [[ "$COMMAND" == *cargo-watch* ]]; then
        ROOT_PID="$CURRENT_PID"
        break
      fi
      CURRENT_PID="$(ps -p "$CURRENT_PID" -o ppid= 2>/dev/null | tr -d ' ' || true)"
    done
    echo "Stopping existing Auri process tree (PID $ROOT_PID)..."
    stop_pid "$ROOT_PID"
    for _ in {1..30}; do
      kill -0 "$SOCKET_PID" 2>/dev/null || break
      sleep 0.1
    done
  fi
fi

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing Auri native watcher (PID $OLD_PID)..."
    stop_pid "$OLD_PID"
    for _ in {1..30}; do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$PID_FILE"
fi

printf '%s\n' "$$" > "$PID_FILE"

cleanup() {
  trap - EXIT INT TERM
  [[ -n "$WATCH_PID" ]] && stop_pid "$WATCH_PID"
  [[ -n "$SERVER_PID" ]] && stop_pid "$SERVER_PID"
  if [[ -f "$PID_FILE" ]] && [[ "$(cat "$PID_FILE" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM

if ! curl --silent --fail --max-time 1 http://127.0.0.1:4173/ >/dev/null; then
  npm run dev > /tmp/auri-frontend.log 2>&1 &
  SERVER_PID=$!

  for _ in {1..30}; do
    if curl --silent --fail --max-time 1 http://127.0.0.1:4173/ >/dev/null; then
      break
    fi
    sleep 0.1
  done

  if ! curl --silent --fail --max-time 1 http://127.0.0.1:4173/ >/dev/null; then
    echo "Failed to start frontend server. See /tmp/auri-frontend.log" >&2
    exit 1
  fi
fi

echo "Watching Auri sources. Press Ctrl+C to stop."

cargo watch \
  --workdir src-tauri \
  --watch . \
  --watch ../src \
  --watch ../index.html \
  --watch ../styles.css \
  --ignore 'target/**' \
  --shell 'cargo run --bin auri-desktop' &
WATCH_PID=$!
wait "$WATCH_PID"
