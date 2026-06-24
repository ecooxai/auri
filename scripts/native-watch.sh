#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Tauri loads the frontend from this development URL.
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

exec cargo watch \
  --workdir src-tauri \
  --watch . \
  --watch ../src \
  --watch ../index.html \
  --watch ../styles.css \
  --ignore 'target/**' \
  --shell 'cargo run --bin auri-desktop'
