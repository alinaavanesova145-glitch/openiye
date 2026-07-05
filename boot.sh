#!/usr/bin/env bash
# boot.sh — start the IYE backend (port 8050) and frontend (port 3000) together.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  echo "Stopping IYE services..."
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting IYE backend on :8050..."
(
  cd "$ROOT_DIR"
  PYTHONPATH=./backend "$ROOT_DIR/backend/.venv/bin/uvicorn" app.api.main:app --host 127.0.0.1 --port 8050 --reload
) &
BACKEND_PID=$!

echo "Starting IYE frontend on :3000..."
(
  cd "$ROOT_DIR/frontend"
  npm run dev
) &
FRONTEND_PID=$!

wait
