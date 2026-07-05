"""
backend/app/api/main.py — Canonical IYE FastAPI Application

This is the single authoritative ASGI entry point for all IYE backend services.

Launch commands (run from the project root with venv active):
  # Using the main.py wrapper:
  PORT=8050 python backend/main.py

  # Or directly via uvicorn:
  PYTHONPATH=./backend backend/.venv/bin/uvicorn app.api.main:app --host 127.0.0.1 --port 8050 --reload
"""

import os
import sys
import json
import uuid
import logging
import asyncio
from datetime import datetime, timezone
from typing import List, Optional

import httpx
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─── Robust sys.path Setup ────────────────────────────────────────────────────
# Resolves correctly whether uvicorn is invoked from the project root,
# the backend/ directory, or any subdirectory.

_this_file   = os.path.abspath(__file__)          # .../backend/app/api/main.py
_api_dir     = os.path.dirname(_this_file)         # .../backend/app/api
_app_dir     = os.path.dirname(_api_dir)           # .../backend/app
_backend_dir = os.path.dirname(_app_dir)           # .../backend
_project_root = os.path.dirname(_backend_dir)      # .../openiye.com

for _p in [_project_root, _backend_dir, os.path.join(_project_root, "sdk")]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

# ─── SDK Imports (after path setup) ──────────────────────────────────────────

import iye  # type: ignore # noqa: E402
from iye.server import Coordinate3D, VectorFramePayload  # type: ignore # noqa: E402
from app.api.temporal_engine import TemporalEngine  # noqa: E402
# ─── Logger ───────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("iye.api")

# ─── Cognitive AI Core (local LLaMA via Ollama) ──────────────────────────────

OLLAMA_API_URL = "http://localhost:11434/api/generate"


async def generate_anomaly_explanation(metrics_summary: str) -> str:
    """Queries local LLaMA via Ollama to generate a crisp tactical explanation."""
    prompt = (
        f"You are the IYE AI Core. Analyze these structural anomaly metrics: {metrics_summary}. "
        "In 2 sentences or less, provide a highly professional, technical engineering explanation "
        "of what structural variance or spatial drift caused this outlier. Be direct and concise."
    )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                OLLAMA_API_URL,
                json={"model": "llama3", "prompt": prompt, "stream": False}
            )
            if response.status_code == 200:
                return response.json().get("response", "").strip()
    except Exception as e:
        logger.warning("LLaMA inference failed, falling back to basic telemetry: %s", e)
    return "Telemetry Alert: Structural vector variance exceeded nominal Z-score boundary."

# ─── FastAPI Application ──────────────────────────────────────────────────────

app = FastAPI(
    title="IYE Anomaly Detection Engine",
    description=(
        "Real-time 3D structural data anomaly detection platform. "
        "Provides UMAP/HDBSCAN vector processing, WebSocket streaming, "
        "and REST ingestion for the IYE canvas."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # Permit local Vite dev server on any port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── StreamHub ────────────────────────────────────────────────────────────────

class StreamHub:
    """Thread-safe broadcast hub for all active /stream WebSocket clients."""

    def __init__(self) -> None:
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        logger.info("WS client connected  (active=%d)", len(self.active_connections))

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self.active_connections = [
                ws for ws in self.active_connections if ws is not websocket
            ]
        logger.info("WS client disconnected (active=%d)", len(self.active_connections))

    async def broadcast(self, payload: VectorFramePayload) -> None:
        # Pydantic's model_dump_json returns a single-serialized string
        message = payload.model_dump_json()
        stale: List[WebSocket] = []
        async with self._lock:
            for ws in self.active_connections:
                try:
                    await ws.send_text(message)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                self.active_connections = [c for c in self.active_connections if c is not ws]


hub = StreamHub()
temporal_engine = TemporalEngine()

# ─── Pydantic Schemas ─────────────────────────────────────────────────────────

class MatrixUploadRequest(BaseModel):
    """Flat-float or nested-float matrix payload for ingestion."""
    data: List[float]
    dim: Optional[int] = 6          # feature dimension, default 6D metrics matrix
    matrix: Optional[List[List[float]]] = None

# ─── REST Routes ──────────────────────────────────────────────────────────────

@app.get("/api/health", tags=["System"])
async def health_check():
    return {
        "status": "healthy",
        "service": "iye-backend-engine",
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
    }


@app.post("/api/canvas/vectors", response_model=VectorFramePayload, tags=["Canvas"])
async def ingest_and_broadcast(request: MatrixUploadRequest):
    """
    Ingest a 6D metrics matrix, reduce to 3D via UMAP, cluster via HDBSCAN,
    flag anomalies using Z-scores, then broadcast the frame to all /stream clients.
    """
    if request.matrix is not None:
        data_2d = np.array(request.matrix, dtype=np.float64)
        if data_2d.ndim != 2:
            raise HTTPException(status_code=400, detail="'matrix' must be a 2-D array")
    else:
        if not request.data:
            raise HTTPException(status_code=400, detail="No matrix data provided")
        d = request.dim or 6
        if len(request.data) % d != 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Flat data length ({len(request.data)}) "
                    f"is not a multiple of dim={d}"
                ),
            )
        n_samples = len(request.data) // d
        data_2d = np.array(request.data, dtype=np.float64).reshape(n_samples, d)

    if data_2d.shape[0] == 0:
        raise HTTPException(status_code=400, detail="Empty sample set")

    # Pipeline: reduce → cluster → detect anomalies
    coords            = iye.reduce_to_3d(data_2d)
    labels            = iye.cluster(coords)
    anomaly_idx, expl = iye.detect_anomalies(coords)

    if anomaly_idx:
        metrics_summary = str(data_2d[anomaly_idx[0]].tolist())
        expl = await generate_anomaly_explanation(metrics_summary)
    else:
        expl = "System nominal. All structural vectors within standard deviation thresholds."

    frame_id  = str(uuid.uuid4())
    timestamp = datetime.now(tz=timezone.utc).isoformat()

    # Stateful sliding-window temporal features (velocity, acceleration, drift,
    # EMA-smoothed composite anomaly score) — additive, rides in payload.temporal.
    temporal_metrics = temporal_engine.process_frame(
        coordinates=coords,
        timestamp=timestamp,
        anomaly_indices=anomaly_idx,
        cluster_labels=labels.tolist(),
    )

    status = "ANOMALY" if anomaly_idx else "NOMINAL"
    payload = VectorFramePayload(
        frame_id      = frame_id,
        id            = frame_id,
        timestamp     = timestamp,
        status        = status,
        point_count   = coords.shape[0],
        coordinates   = [
            Coordinate3D(x=float(r[0]), y=float(r[1]), z=float(r[2])) for r in coords
        ],
        cluster_labels  = labels.tolist(),
        anomaly_indices = anomaly_idx,
        explanation     = expl,
        axis_mapping    = None,
        temporal        = temporal_metrics.model_dump(),
    )

    # Broadcast cleanly to our explicit stream endpoint
    await hub.broadcast(payload)
    return payload

# ─── WebSocket Stream ─────────────────────────────────────────────────────────

@app.websocket("/stream")
async def stream_endpoint(websocket: WebSocket) -> None:
    """Persistent WebSocket channel. Receives live VectorFramePayload broadcasts."""
    await hub.connect(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                if isinstance(msg, dict) and msg.get("type") == "configure":
                    logger.info("WS config received: %s", msg)
            except (json.JSONDecodeError, TypeError):
                pass
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(websocket)

# ─── Legacy Router Compatibility ──────────────────────────────────────────────

try:
    from app.api.routes import inference, canvas, health as route_health  # noqa: E402

    app.include_router(route_health.router, prefix="/api/health",         tags=["System"])
    app.include_router(inference.router,    prefix="/api/inference",       tags=["Inference"])
    app.include_router(canvas.router,       prefix="/api/canvas",          tags=["Canvas"])

except ImportError as _e:
    logger.warning("Legacy routers unavailable: %s", _e)