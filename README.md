# IYE Anomaly Detection Engine

Real-time 3D structural-data anomaly detection. A FastAPI backend reduces
incoming metric vectors to 3D (UMAP), clusters them (HDBSCAN), flags outliers
by Z-score, tracks a stateful sliding-window "temporal" signal (velocity /
acceleration / drift / EMA-smoothed composite) across frames, and streams
everything over WebSocket to a React Three Fiber canvas. Anomalies get an
async, local-LLM-generated (Ollama/LLaMA) plain-English explanation that
arrives on its own message so it never blocks the live stream.

## Architecture

```
 REST POST /api/canvas/vectors
        │
        ▼
 ┌───────────────┐   ┌────────────────┐   ┌──────────────────┐
 │ UMAP reduce   │──▶│ HDBSCAN        │──▶│ Z-score anomaly  │
 │ (N-D → 3D)    │   │ clustering     │   │ detection (2.5σ) │
 └───────────────┘   └────────────────┘   └─────────┬────────┘
                                                      │
                     ┌────────────────────────────────┘
                     ▼
        ┌─────────────────────────┐
        │ TemporalEngine          │   sliding window, deque(maxlen=50)
        │ velocity / acceleration │   sigma-normalized, Theil-Sen drift,
        │ / drift / composite_smd │   enter/release hysteresis on regime
        └───────────┬─────────────┘
                     ▼
        ┌─────────────────────────┐
        │ StreamHub.broadcast     │   immediate — never awaits Ollama
        └───────────┬─────────────┘
                     │  ws://127.0.0.1:8050/stream
                     │  {"type":"frame", ...}
                     ▼
        ┌─────────────────────────┐        (anomaly only, async,
        │ React Three Fiber canvas│         fire-and-forget)
        │ instanced nodes, cluster│              │
        │ hulls, tracers, pulsing │◀─────────────┘
        │ anomaly beacons         │  {"type":"narrative", "id":..., "explanation":...}
        └─────────────────────────┘
```

See [`docs/protocol.md`](docs/protocol.md) for the exact `frame`/`narrative`
JSON shapes, and [`docs/temporal_calibration.md`](docs/temporal_calibration.md)
for how the temporal engine's thresholds were derived.

## Ports

| Service | Port |
|---|---|
| Backend (FastAPI/uvicorn) | `8050` |
| Frontend (Vite dev server) | `3000` |

## Running locally

```bash
./boot.sh
```

Starts both services and stops them together on Ctrl-C. Equivalent to
running these two commands in separate terminals:

```bash
# Backend
PYTHONPATH=./backend backend/.venv/bin/uvicorn app.api.main:app --host 127.0.0.1 --port 8050 --reload

# Frontend
cd frontend && npm run dev
```

Requires `backend/.venv` already set up (`pip install -e backend -e sdk` or
equivalent) and `frontend/node_modules` installed (`npm install`).

## Tests

```bash
# Backend (pytest)
cd backend && .venv/bin/python -m pytest tests/ -q

# Backend statistical audit (not a pytest — a standalone report)
cd backend && .venv/bin/python tests/audit_temporal_noise.py

# Frontend (vitest)
cd frontend && npm test
```

## Structure

- `backend/` — FastAPI app (`app/api/main.py`), the temporal engine
  (`app/api/temporal_engine.py`), pytest suite.
- `frontend/` — Vite + React + React Three Fiber canvas, Vitest suite.
- `sdk/` — `iye` Python package: the WebSocket payload schema
  (`iye/server.py`) and the UMAP/HDBSCAN/Z-score pipeline (`iye/__init__.py`).
- `docs/` — protocol spec, temporal engine calibration notes, this file's
  companion docs.
