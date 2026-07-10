#!/usr/bin/env bash
# boot.sh — start the IYE backend (port 8050) and frontend (port 3000) together.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  echo "Stopping IYE services..."
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Non-fatal: IYE degrades gracefully to fallback narrative text when Ollama
# is unreachable, so this only warns rather than aborting the boot.
if curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "llm ready — Ollama reachable on :11434"
else
  echo "llm offline — narratives will use fallback text"
fi

echo "Starting IYE backend on :8050 (all interfaces, so LAN access works)..."
(
  cd "$ROOT_DIR"
  # 0.0.0.0, not 127.0.0.1: the frontend's own host-derived addressing
  # (frontend/src/lib/apiConfig.ts) lets a LAN device reach this backend at
  # the host machine's LAN IP — but only if the backend is actually
  # listening on that interface, not just loopback. See
  # docs/idealization_report.md, 2026-07-14 sprint, Phase 2.
  PYTHONPATH=./backend "$ROOT_DIR/backend/.venv/bin/uvicorn" app.api.main:app --host 0.0.0.0 --port 8050 --reload
) &
BACKEND_PID=$!

echo "Starting IYE frontend on :3000..."
(
  cd "$ROOT_DIR/frontend"
  npm run dev
) &
FRONTEND_PID=$!

wait
