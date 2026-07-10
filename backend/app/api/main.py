"""
backend/app/api/main.py — Canonical IYE FastAPI Application

This is the single authoritative ASGI entry point for all IYE backend services.

Launch commands (run from the project root with venv active):
  # Using the main.py wrapper:
  PORT=8050 python backend/main.py

  # Or directly via uvicorn:
  PYTHONPATH=./backend backend/.venv/bin/uvicorn app.api.main:app --host 127.0.0.1 --port 8050 --reload
"""

import asyncio
import json
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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

from app.api.capture import capture_frame  # noqa: E402
from app.api.temporal_engine import TemporalEngine  # noqa: E402

# ─── Logger ───────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("iye.api")

# ─── Cognitive AI Core (local LLaMA via Ollama) ──────────────────────────────

OLLAMA_API_URL = os.environ.get("OLLAMA_API_URL", "http://localhost:11434/api/generate")

# Cheap, coarse-grained LLM availability signal for the frontend's `llm`
# indicator — set once at startup (a single lightweight GET) and thereafter
# updated for free from the real outcome of every generate_anomaly_explanation
# call (success -> ready, failure -> offline). Never polled per-frame.
_llm_status: str = "unknown"  # "unknown" | "ready" | "offline"


def _set_llm_status(status: str) -> None:
    global _llm_status
    _llm_status = status


async def _startup_llm_healthcheck() -> None:
    base = OLLAMA_API_URL.rsplit("/api/", 1)[0]
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"{base}/api/tags")
            _set_llm_status("ready" if response.status_code == 200 else "offline")
    except Exception:
        _set_llm_status("offline")


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
                _set_llm_status("ready")
                return response.json().get("response", "").strip()
    except Exception as e:
        logger.warning("LLaMA inference failed, falling back to basic telemetry: %s", e)
    _set_llm_status("offline")
    return "Telemetry Alert: Structural vector variance exceeded nominal Z-score boundary."

# ─── FastAPI Application ──────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await _startup_llm_healthcheck()
    yield
    await _cancel_pending_narratives()


app = FastAPI(
    title="IYE Anomaly Detection Engine",
    description=(
        "Real-time 3D structural data anomaly detection platform. "
        "Provides UMAP/HDBSCAN vector processing, WebSocket streaming, "
        "and REST ingestion for the IYE canvas."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# DEV-ONLY CORS. Matches the Vite dev server (port 3000) on localhost, its
# loopback IP, and the RFC 1918 private-LAN ranges (10.0.0.0/8,
# 172.16.0.0/12, 192.168.0.0/16) — see docs/idealization_report.md,
# 2026-07-14 sprint, Phase 2: the app used to be unreachable from any
# machine that opened it via the host's LAN IP instead of localhost.
# A real deployment must replace this regex with an explicit origin
# allowlist (`allow_origins=[...]`, no regex, no private-IP ranges) —
# this permissive pattern is only appropriate because dev machines on a
# private LAN are the only realistic caller during local development.
DEV_CORS_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost"
    r"|127\.0\.0\.1"
    r"|10(?:\.\d{1,3}){3}"
    r"|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}"
    r"|192\.168(?:\.\d{1,3}){2}"
    r"):3000$"
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=DEV_CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── StreamHub ────────────────────────────────────────────────────────────────

BROADCAST_SEND_TIMEOUT = 2.0  # seconds — a slow/dead client can't stall the others


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

    async def _send_with_timeout(self, websocket: WebSocket, message: str) -> bool:
        try:
            await asyncio.wait_for(websocket.send_text(message), timeout=BROADCAST_SEND_TIMEOUT)
            return True
        except Exception:
            return False

    async def broadcast_text(self, message: str) -> None:
        """Fan a pre-serialized message out to every client concurrently, each
        with its own timeout, so one slow/dead socket can't stall the rest."""
        async with self._lock:
            connections = list(self.active_connections)
        if not connections:
            return
        results = await asyncio.gather(*(self._send_with_timeout(ws, message) for ws in connections))
        stale = {ws for ws, ok in zip(connections, results) if not ok}
        if stale:
            async with self._lock:
                self.active_connections = [c for c in self.active_connections if c not in stale]
            logger.info("WS dropped %d stale client(s) (active=%d)", len(stale), len(self.active_connections))

    async def broadcast(self, payload: VectorFramePayload) -> None:
        # Pydantic's model_dump_json returns a single-serialized string
        await self.broadcast_text(payload.model_dump_json())

    async def broadcast_narrative(self, frame_id: str, explanation: str) -> None:
        """Broadcast the async LLaMA narrative as its own small message, keyed
        by frame id, so the frontend can merge it into the frame it explains."""
        await self.broadcast_text(json.dumps({"type": "narrative", "id": frame_id, "explanation": explanation}))


hub = StreamHub()
temporal_engine = TemporalEngine()

# ─── Narrative task lifecycle (decoupled from the broadcast hot path) ───────

NARRATIVE_CONCURRENCY_LIMIT = 4
_narrate_semaphore = asyncio.Semaphore(NARRATIVE_CONCURRENCY_LIMIT)
_pending_narrative_tasks: "set[asyncio.Task]" = set()


async def _narrate(frame_id: str, metrics_summary: str) -> None:
    """Generate the LLaMA narrative and broadcast it separately. Scheduled via
    asyncio.create_task — never awaited on the ingestion/broadcast hot path."""
    async with _narrate_semaphore:
        text = await generate_anomaly_explanation(metrics_summary)
    await hub.broadcast_narrative(frame_id, text)


def _spawn_narrative_task(frame_id: str, metrics_summary: str) -> None:
    task = asyncio.create_task(_narrate(frame_id, metrics_summary))
    _pending_narrative_tasks.add(task)
    task.add_done_callback(_pending_narrative_tasks.discard)


async def _cancel_pending_narratives() -> None:
    """Cancel and await any in-flight narrative tasks so shutdown never logs
    'Task was destroyed but it is pending'. Called from the app's lifespan."""
    tasks = list(_pending_narrative_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

# ─── Pydantic Schemas ─────────────────────────────────────────────────────────

class EncodingSummary(BaseModel):
    """Additive, optional — rides an upload request/response only when the
    frontend actually encoded categorical columns (see parseMatrix.ts's
    buildFeatureMatrix). Lets the narrative prompt and the response payload
    both know some dimensions are encoded categories, not raw measurements."""
    total_columns: int
    numeric_columns: int
    encoded_categorical_columns: int
    encoded_dims: int
    skipped_free_text: int


class MatrixUploadRequest(BaseModel):
    """Flat-float or nested-float matrix payload for ingestion."""
    # Optional (not required) so a `matrix`-only request validates — the two
    # input modes are alternatives, per the docstring, not both-required.
    # Additive/backward-compatible: existing callers already send `data`.
    data: Optional[List[float]] = None
    dim: Optional[int] = 6          # feature dimension, default 6D metrics matrix
    matrix: Optional[List[List[float]]] = None
    encoding_summary: Optional[EncodingSummary] = None

# ─── REST Routes ──────────────────────────────────────────────────────────────

@app.get("/api/health", tags=["System"])
async def health_check():
    return {
        "status": "healthy",
        "service": "iye-backend-engine",
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "llm": _llm_status,
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

    # Decoupling gate: no await on the Ollama routine happens on this hot path.
    # Anomaly frames broadcast with explanation=None immediately; the LLaMA
    # narrative is generated by a fire-and-forget task and arrives later as
    # its own {"type": "narrative", "id": ...} WS message.
    if anomaly_idx:
        expl = None
    else:
        expl = "System nominal. All structural vectors within standard deviation thresholds."

    frame_id  = str(uuid.uuid4())
    timestamp = datetime.now(tz=timezone.utc).isoformat()

    # Opt-in recalibration capture (IYE_CAPTURE_PATH) — exactly the raw input
    # TemporalEngine.process_frame consumes below. No-op (zero file I/O) when unset.
    capture_frame(
        coordinates=coords,
        timestamp=timestamp,
        anomaly_indices=anomaly_idx,
        cluster_labels=labels.tolist(),
    )

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
        encoding_summary = request.encoding_summary.model_dump() if request.encoding_summary else None,
    )

    # Broadcast cleanly to our explicit stream endpoint
    await hub.broadcast(payload)

    if anomaly_idx:
        metrics_summary = str(data_2d[anomaly_idx[0]].tolist())
        if request.encoding_summary is not None:
            enc = request.encoding_summary
            metrics_summary += (
                f" (Note: {enc.encoded_categorical_columns} of the {enc.total_columns} "
                f"source column(s) are encoded categorical features — {enc.encoded_dims} "
                f"of this vector's dimensions are encoded categories, not raw measurements.)"
            )
        _spawn_narrative_task(frame_id, metrics_summary)

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
    from app.api.routes import canvas, inference  # noqa: E402
    from app.api.routes import health as route_health

    app.include_router(route_health.router, prefix="/api/health",         tags=["System"])
    app.include_router(inference.router,    prefix="/api/inference",       tags=["Inference"])
    app.include_router(canvas.router,       prefix="/api/canvas",          tags=["Canvas"])

except ImportError as _e:
    logger.warning("Legacy routers unavailable: %s", _e)
