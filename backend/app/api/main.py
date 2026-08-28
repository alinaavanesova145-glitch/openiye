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
from typing import Any, List, Optional

import httpx
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

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
from iye import encoding as iye_encoding  # type: ignore # noqa: E402
from iye.server import Coordinate3D, FeatureAttribution, VectorFramePayload  # type: ignore # noqa: E402

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


# A freshly-pulled (or idle-unloaded) model's weights aren't in memory just
# because Ollama's HTTP server answers -- loading multiple GB is a separate,
# additive cost on top of generation time, and the interactive explain
# endpoint's 30s budget (EXPLAIN_LLM_TIMEOUT_SECONDS, calibrated from
# already-warm generation time alone) doesn't account for it. Left unfixed,
# a user's first-ever click reliably blew that budget on model-load time,
# producing "Local LLM is unreachable or timed out" on literally their first
# interaction -- while the sidebar's "llm · ready" badge, driven only by
# _startup_llm_healthcheck's /api/tags check above, told them it was ready.
LLM_WARMUP_PROMPT = "hi"
# Generous: this runs fully off the startup hot path (see lifespan below),
# so a slow model load only delays how soon the *first* real click would
# have been warm anyway -- never server startup, and never a user-facing
# request.
LLM_WARMUP_TIMEOUT_SECONDS = 120.0


async def _warm_up_llm() -> None:
    """Best-effort: issues one real, minimal /api/generate call so the model
    is resident in memory before any user-facing request, not just checked
    for HTTP reachability. Never raises -- Ollama being absent or slow here
    must not crash the app, same graceful-degradation discipline as every
    other LLM call in this module."""
    try:
        async with httpx.AsyncClient(timeout=LLM_WARMUP_TIMEOUT_SECONDS) as client:
            response = await client.post(
                OLLAMA_API_URL,
                json={"model": "llama3", "prompt": LLM_WARMUP_PROMPT, "stream": False},
            )
            _set_llm_status("ready" if response.status_code == 200 else "offline")
    except Exception as e:
        logger.info("LLM warm-up call didn't complete (Ollama may be absent): %s", e)
        _set_llm_status("offline")


LLM_FALLBACK_TEXT = "Telemetry Alert: Structural vector variance exceeded nominal Z-score boundary."


async def generate_anomaly_explanation(metrics_summary: str, timeout: float = 10.0) -> str:
    """Queries local LLaMA via Ollama to generate a crisp tactical explanation.

    `timeout` defaults to 10.0s (unchanged from before this sprint) for the
    fire-and-forget per-frame narrative path (_narrate), where a fallback
    string is an acceptable outcome for a passive broadcast nobody is
    actively waiting on. The on-demand per-point explain endpoint (2026-07-29
    sprint) passes a longer explicit timeout instead — a user who clicked a
    point IS actively waiting, and Ollama generation empirically takes
    ~15-22s on this hardware, comfortably past the old default.
    """
    prompt = (
        f"You are the IYE AI Core. Analyze these structural anomaly metrics: {metrics_summary}. "
        "In 2 sentences or less, provide a highly professional, technical engineering explanation "
        "of what structural variance or spatial drift caused this outlier. Be direct and concise."
    )
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
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
    return LLM_FALLBACK_TEXT

# ─── FastAPI Application ──────────────────────────────────────────────────────


_llm_warmup_task: "Optional[asyncio.Task]" = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _llm_warmup_task
    await _startup_llm_healthcheck()
    # Fire-and-forget, scheduled but deliberately never awaited here -- a
    # slow or absent Ollama must not delay startup (the health endpoint and
    # every route are already serving requests while this runs). Tracked
    # (not a bare asyncio.create_task) so shutdown can cancel it cleanly
    # instead of risking a "Task was destroyed but it is pending" warning,
    # same discipline as _pending_narrative_tasks below.
    _llm_warmup_task = asyncio.create_task(_warm_up_llm())
    yield
    await _cancel_pending_narratives()
    if _llm_warmup_task is not None and not _llm_warmup_task.done():
        _llm_warmup_task.cancel()
        await asyncio.gather(_llm_warmup_task, return_exceptions=True)


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

# ─── Structured ingest-validation errors ──────────────────────────────────────
# 2026-07-16 sprint: transport succeeded but the payload has nothing usable
# (empty, malformed, or degenerate after parsing/filtering) gets a flat,
# structured 422 — never a raw 500 with a Python traceback. Plain
# HTTPException(detail=...) always nests under an extra {"detail": ...}
# wrapper in FastAPI's default handling, which doesn't match the flat
# contract below, hence a dedicated exception + handler pair instead.


class IngestValidationError(Exception):
    """Raised anywhere in the ingestion → feature-matrix pipeline when the
    payload has nothing usable to work with. `stage` identifies which part
    of the pipeline made that call: ingestion (raw payload → array),
    feature_matrix (array shape/size checks), or vectorization (the
    UMAP/HDBSCAN/Z-score calls themselves, as a last-resort backstop for
    anything the earlier precondition checks didn't anticipate)."""

    def __init__(self, detail: str, stage: str) -> None:
        super().__init__(detail)
        self.detail = detail
        self.stage = stage


@app.exception_handler(IngestValidationError)
async def _ingest_validation_error_handler(_request, exc: IngestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "error": "empty_or_invalid_payload",
            "status": 422,
            "detail": exc.detail,
            "stage": exc.stage,
        },
    )


# ─── Structured anomaly-explain errors ─────────────────────────────────────────
# 2026-07-29 sprint: same flat-envelope pattern as IngestValidationError above,
# for the /api/canvas/anomaly/explain endpoint's distinct failure domain —
# a malformed request (stage="validation") or the LLM being unreachable/timing
# out (stage="llm_unavailable"). Kept as its own exception/handler pair
# (rather than reusing IngestValidationError) because "empty_or_invalid_payload"
# doesn't describe an LLM failure — the JSON *shape* is identical, matching
# the established convention, but the `error` tag and status semantics are
# specific to this endpoint.


class AnomalyExplainError(Exception):
    """Raised by /api/canvas/anomaly/explain when the request is malformed
    (stage="validation") or the local LLM couldn't produce an explanation
    (stage="llm_unavailable" — unreachable, non-200, or timed out)."""

    def __init__(self, detail: str, stage: str) -> None:
        super().__init__(detail)
        self.detail = detail
        self.stage = stage


@app.exception_handler(AnomalyExplainError)
async def _anomaly_explain_error_handler(_request, exc: AnomalyExplainError):
    return JSONResponse(
        status_code=422,
        content={
            "error": "explain_failed",
            "status": 422,
            "detail": exc.detail,
            "stage": exc.stage,
        },
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
# 2026-08-27 sprint: the semaphore above only ever bounded how many
# narrative calls run *concurrently* -- nothing bounded how many could
# *queue up* behind it. Each Ollama call takes ~15-22s (see
# generate_anomaly_explanation's own comment), so a burst of
# anomaly-triggering uploads (trivial to produce -- one outlier point per
# frame) piles tasks into _pending_narrative_tasks faster than 4-at-a-time
# can drain them, with no auth or rate limit anywhere to throttle the
# burst itself. MAX_PENDING_NARRATIVE_TASKS is a backstop on the queue
# depth, not a replacement for real rate limiting (see
# docs/fullstack_audit_2026-08-27.md) -- a request whose narrative gets
# dropped this way still gets its anomaly frame broadcast immediately and
# normally; it just doesn't get an LLM narrative for that one frame.
MAX_PENDING_NARRATIVE_TASKS = 16
_narrate_semaphore = asyncio.Semaphore(NARRATIVE_CONCURRENCY_LIMIT)
_pending_narrative_tasks: "set[asyncio.Task]" = set()


async def _narrate(frame_id: str, metrics_summary: str) -> None:
    """Generate the LLaMA narrative and broadcast it separately. Scheduled via
    asyncio.create_task — never awaited on the ingestion/broadcast hot path."""
    async with _narrate_semaphore:
        text = await generate_anomaly_explanation(metrics_summary)
    await hub.broadcast_narrative(frame_id, text)


def _spawn_narrative_task(frame_id: str, metrics_summary: str) -> None:
    if len(_pending_narrative_tasks) >= MAX_PENDING_NARRATIVE_TASKS:
        logger.warning(
            "Dropping narrative request for frame %s: %d narrative tasks "
            "already queued/running (cap=%d) — the frame itself was still "
            "broadcast normally, it just won't get an LLM narrative.",
            frame_id, len(_pending_narrative_tasks), MAX_PENDING_NARRATIVE_TASKS,
        )
        return
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
    """Flat-float or nested matrix payload for ingestion.

    `matrix` accepts mixed cell types (not just float) — 2026-07-28 sprint:
    a direct API/curl caller or an `iye.show()` script has no browser in
    the loop to pre-encode categorical/text columns the way
    frontend/src/canvas/upload/parseMatrix.ts does, so the backend now
    detects non-numeric cells itself and routes them through
    iye.encoding.vectorize_matrix (see ingest_and_broadcast). A fully
    numeric matrix (the common case — browser uploads are already encoded
    by the time they arrive) is unaffected: it takes the exact same fast
    path as before this sprint.
    """
    # Optional (not required) so a `matrix`-only request validates — the two
    # input modes are alternatives, per the docstring, not both-required.
    # Additive/backward-compatible: existing callers already send `data`.
    # max_length bounds (2026-08-27 sprint): nothing previously capped
    # request size, so a multi-million-element payload sailed past every
    # existing check (non-empty, ragged-row, divisibility) straight into
    # np.array().reshape() and then UMAP/HDBSCAN -- unbounded memory/CPU
    # per request, with no auth to throttle who can send one. The caps
    # below are generous for this tool's actual use case (interactive
    # local-network telemetry, not big-data batch ingestion) while
    # ruling out the pathological case.
    data: Optional[List[float]] = Field(default=None, max_length=500_000)
    dim: Optional[int] = 6          # feature dimension, default 6D metrics matrix
    matrix: Optional[List[List[Any]]] = Field(default=None, max_length=50_000)
    encoding_summary: Optional[EncodingSummary] = None
    # One name per column of `matrix` AS SUBMITTED (2026-07-31 sprint) —
    # already-post-encoding names for a browser-pre-encoded numeric matrix,
    # or pre-encoding raw-column names for a non-numeric matrix the backend
    # will encode itself (passed straight through to
    # iye.encoding.vectorize_matrix, which expands them per output column).
    # Optional; a length mismatch against the actual matrix is treated as
    # absent rather than rejected — naming is a narrative-quality feature,
    # not worth failing ingestion over. See ingest_and_broadcast.
    column_names: Optional[List[str]] = Field(default=None, max_length=2_000)

    @field_validator("matrix")
    @classmethod
    def _cap_row_width(cls, v):
        """Row-count is capped by max_length above; a single pathologically
        wide row (e.g. one row, a million columns) would sail through that
        cap untouched, so width gets its own bound here."""
        if v is not None:
            for row in v:
                if len(row) > 5_000:
                    raise ValueError(
                        f"'matrix' rows may have at most 5000 columns, got {len(row)}"
                    )
        return v


class AnomalyExplainRequest(BaseModel):
    """Request body for POST /api/canvas/anomaly/explain (2026-07-29 sprint).

    Stateless by design: the backend keeps no server-side frame/point cache
    (frames are broadcast-only), and the product already supports a live,
    continuously-streamed use case (repeated iye.show() calls) where "the
    uploaded file" isn't even a coherent concept to look up — so the
    frontend echoes back exactly the point data it already has from the
    frame that produced it, rather than the backend needing to remember
    anything between requests.
    """
    point_index: int
    coordinates: Coordinate3D
    z_scores: Coordinate3D
    cluster_label: int
    axes_are_raw_features: bool = True
    # Additive (2026-07-31 sprint) — top named original fields driving this
    # point's anomaly, already ranked by the frame that produced it (see
    # VectorFramePayload.point_feature_attributions). Empty when no real
    # column names were available at ingestion — the prompt then falls
    # back to the pre-existing axes_are_raw_features-based generic phrasing
    # below, unchanged.
    feature_attributions: List[FeatureAttribution] = Field(default_factory=list)


class AnomalyExplainResponse(BaseModel):
    point_index: int
    explanation: str


# ─── Narrative grounding ───────────────────────────────────────────────────────

# On-demand explain requests are actively awaited by a user who just clicked
# a point — worth a much longer budget than the passive fire-and-forget
# per-frame narrative's 10s default (see generate_anomaly_explanation).
# Ollama generation empirically takes ~15-22s on this hardware.
EXPLAIN_LLM_TIMEOUT_SECONDS = 30.0


def _build_point_explanation_summary(req: AnomalyExplainRequest) -> str:
    """Grounds the LLM prompt in this specific point's actual computed
    signal — cluster membership, plus a deviation description that prefers
    real named fields when available (2026-07-31 sprint) and otherwise
    falls back to the original axis-based phrasing unchanged. Never
    fabricates a name: axis-based phrasing only claims "a raw measured
    feature" when axes_are_raw_features says that's literally true, and
    named-field phrasing only fires when the frame that produced this
    point actually had real column names to attribute to."""
    cluster_desc = (
        "flagged as noise (not part of any dense cluster)"
        if req.cluster_label < 0
        else f"a member of cluster {req.cluster_label}"
    )

    if req.feature_attributions:
        top = req.feature_attributions[:2]
        if len(top) == 1:
            deviation_desc = f"Primarily driven by the {top[0].name} feature, peak |z|={abs(top[0].z_score):.2f}."
        else:
            deviation_desc = (
                f"Primarily driven by the {top[0].name} feature (|z|={abs(top[0].z_score):.2f}), "
                f"with a secondary contribution from {top[1].name} (|z|={abs(top[1].z_score):.2f})."
            )
        return f"point #{req.point_index}. {deviation_desc} This point is {cluster_desc}."

    # Fallback: no real column names were available for this frame — same
    # generic axis-based grounding as before this sprint, unchanged.
    axis_labels = ["x", "y", "z"]
    coords = [req.coordinates.x, req.coordinates.y, req.coordinates.z]
    zs = [req.z_scores.x, req.z_scores.y, req.z_scores.z]
    dominant = max(range(3), key=lambda i: abs(zs[i]))

    if req.axes_are_raw_features:
        axis_desc = f"the {axis_labels[dominant]}-axis (a raw measured feature)"
    else:
        axis_desc = f"embedding axis {axis_labels[dominant]} (a UMAP-reduced dimension, not a single raw feature)"

    return (
        f"point #{req.point_index} at coordinates "
        f"({coords[0]:.3f}, {coords[1]:.3f}, {coords[2]:.3f}), "
        f"z-scores ({zs[0]:.2f}, {zs[1]:.2f}, {zs[2]:.2f}) on (x, y, z). "
        f"Deviates most on {axis_desc}, peak |z|={abs(zs[dominant]):.2f}. "
        f"This point is {cluster_desc}."
    )


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
    # Populated only when this request's matrix contained non-numeric cells
    # and we (not the browser's parseMatrix.ts) did the encoding ourselves —
    # see the `else` branch below and Phase A of the 2026-07-28 sprint.
    computed_encoding_summary: Optional[dict] = None
    # One name per FINAL feature-matrix column, used to attribute an
    # anomaly back to a real field name (2026-07-31 sprint) — stays None
    # (never an auto-generated "col_N" placeholder) unless the caller
    # actually supplied real names, so a request with no names gets the
    # honest generic axis-based explain fallback, not a fake-looking label.
    feature_names_for_attribution: Optional[List[str]] = None

    if request.matrix is not None:
        row_lengths = {len(row) for row in request.matrix}
        if len(row_lengths) > 1:
            # Ragged rows (inconsistent lengths) — checked explicitly up
            # front because vectorize_matrix (below) needs a rectangular
            # column structure to classify columns at all.
            raise IngestValidationError(
                detail=(
                    f"'matrix' rows must all have the same length "
                    f"(got lengths {sorted(row_lengths)})"
                ),
                stage="ingestion",
            )
        if iye_encoding.is_fully_numeric(request.matrix):
            # Fast path, unchanged from before this sprint: a browser
            # upload has already been encoded client-side by the time it
            # gets here, so every cell is already a real number. Names, if
            # supplied, are already one-per-final-column (the browser did
            # any encoding/expansion, so no further mapping is needed).
            data_2d = np.array(request.matrix, dtype=np.float64)
            feature_names_for_attribution = request.column_names
        else:
            # No browser in the loop for this request (direct API/curl call,
            # or iye.show() called straight from a script) — parseMatrix.ts
            # never ran, so do the same classify-and-encode pass here.
            try:
                data_2d, summary = iye_encoding.vectorize_matrix(
                    request.matrix, column_names=request.column_names
                )
            except iye_encoding.RaggedMatrixError as e:
                raise IngestValidationError(detail=str(e), stage="ingestion") from e
            computed_encoding_summary = summary.to_wire_dict()
            # Only trust vectorize_matrix's expanded names when the caller
            # actually supplied real ones — it always returns *some* name
            # per column, falling back to "col_N" placeholders internally,
            # which would make a misleadingly specific-looking narrative.
            if request.column_names is not None:
                feature_names_for_attribution = summary.expanded_column_names
        if data_2d.ndim != 2:
            raise IngestValidationError(
                detail="'matrix' must be a 2-D array", stage="ingestion"
            )
    else:
        if not request.data:
            raise IngestValidationError(
                detail="No matrix data provided", stage="ingestion"
            )
        d = request.dim or 6
        if len(request.data) % d != 0:
            raise IngestValidationError(
                detail=(
                    f"Flat data length ({len(request.data)}) "
                    f"is not a multiple of dim={d}"
                ),
                stage="ingestion",
            )
        n_samples = len(request.data) // d
        data_2d = np.array(request.data, dtype=np.float64).reshape(n_samples, d)

    if data_2d.shape[0] == 0:
        raise IngestValidationError(
            detail="Uploaded payload contained no rows (empty sample set)",
            stage="feature_matrix",
        )
    if data_2d.shape[1] == 0:
        # Every row parsed but has zero columns (e.g. `"matrix": [[], []]`) —
        # previously silently zero-padded into fabricated (0,0,0) geometry;
        # this is exactly as "nothing usable" as zero rows.
        raise IngestValidationError(
            detail="Uploaded payload contained no numeric columns after parsing",
            stage="feature_matrix",
        )
    if not np.all(np.isfinite(data_2d)):
        # 2026-08-27 sprint: catches two real, distinct ways a NaN/Infinity
        # can reach here without ever failing vectorize_matrix's own guard
        # (that guard only runs on the mixed-type `matrix` path, and only
        # protects string cells) --
        #   1. the "fully numeric" fast path (`is_fully_numeric` above):
        #      Python's json module parses the non-standard-but-permitted
        #      literals NaN/Infinity/-Infinity as real float('nan')/inf
        #      values, which `isinstance(v, float)` happily accepts as
        #      "already numeric", skipping vectorize_matrix entirely;
        #   2. the flat `data` field, reshaped straight into an array below
        #      with no validation at all.
        # Left unguarded, a NaN silently makes np.mean/np.std NaN for that
        # whole axis, so `z_scores > threshold` (a NaN comparison) is
        # always False under IEEE 754 -- a real anomaly can be masked
        # entirely with no error, and the value serializes to JSON `null`
        # against a frontend contract that promises `x: number`.
        raise IngestValidationError(
            detail="Uploaded payload contains non-finite values (NaN/Infinity), which is not supported",
            stage="ingestion",
        )

    n_samples, n_features = data_2d.shape
    reduction_note = None
    if n_features > 3 and n_samples < iye.MIN_SAMPLES_FOR_REDUCTION:
        reduction_note = (
            f"UMAP reduction skipped: {n_samples} sample(s) is below the "
            f"minimum of {iye.MIN_SAMPLES_FOR_REDUCTION} required for a "
            f"stable reduction — coordinates are the first 3 raw feature "
            f"columns (truncated), not a real dimensionality reduction."
        )
    # x/y/z are literal source features whenever no real UMAP embedding
    # happened — the <=3-feature passthrough, or the small-n truncation
    # fallback above. Only a real UMAP reduction produces abstract embedded
    # axes. Grounds the per-point explain endpoint's honesty about what a
    # coordinate axis actually means — see VectorFramePayload.axes_are_raw_features.
    axes_are_raw_features = n_features <= 3 or reduction_note is not None

    # Pipeline: reduce → cluster → detect anomalies. The precondition checks
    # above and inside reduce_to_3d/cluster handle every *known* degenerate
    # shape without raising; this try/except is a narrow defense-in-depth
    # backstop for anything genuinely unanticipated (e.g. a future numpy/umap/
    # hdbscan version introducing a new edge case) — logged in full server-side
    # so the real cause stays visible, never silently swallowed, but the
    # client still gets a structured, actionable 422 instead of a raw 500.
    try:
        coords            = iye.reduce_to_3d(data_2d)
        labels            = iye.cluster(coords)
        anomaly_idx, expl = iye.detect_anomalies(coords)
        point_z_scores    = iye.compute_z_scores(coords).tolist()
        # Computed on data_2d (pre-reduction) — deliberately not on coords
        # (post-reduction): after a real UMAP embedding, an output axis is
        # a nonlinear mix of every input column, so there is no principled
        # "axis 2 is column 3" mapping, but a per-original-column Z-score
        # is always well-defined regardless of whether reduction happened.
        point_feature_attributions = [
            [{"name": a.name, "z_score": a.z_score} for a in point_attrs]
            for point_attrs in iye.compute_feature_attributions(data_2d, feature_names_for_attribution)
        ]
    except Exception as e:
        # 2026-08-27 sprint: the raw exception text used to go straight
        # into the client-facing 422 detail (str(e) can include internal
        # file paths, numpy/UMAP/HDBSCAN version-specific message text,
        # or the raw shape/dtype of internal arrays) -- logged in full
        # server-side as before, but the response now carries a generic
        # message so an anonymous, unauthenticated caller (this endpoint
        # has no auth) can't use error text to fingerprint internals.
        logger.exception(
            "Unexpected failure in reduce/cluster/detect_anomalies for a "
            "%s-shaped payload", data_2d.shape
        )
        raise IngestValidationError(
            detail="Vectorization failed unexpectedly for this payload's shape/values",
            stage="vectorization",
        ) from e

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
    # TemporalEngine.process_frame consumes below. No-op (zero file I/O) when
    # unset. Run via asyncio.to_thread (2026-08-27 sprint): capture_frame does
    # synchronous, lock-held disk I/O (open/write/flush) — called inline, that
    # blocks the *entire* event loop, including the /stream broadcast fan-out
    # and every other concurrent request, for the write duration on every
    # single ingested frame whenever this feature is enabled.
    await asyncio.to_thread(
        capture_frame,
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

    # Prefer the browser's own encoding_summary (parseMatrix.ts already ran)
    # when present; otherwise fall back to what we computed ourselves above
    # for a non-browser caller. Never both — a request only ever takes one
    # of the two paths.
    encoding_summary_dict = (
        request.encoding_summary.model_dump() if request.encoding_summary else computed_encoding_summary
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
        encoding_summary = encoding_summary_dict,
        reduction_note   = reduction_note,
        point_z_scores   = point_z_scores,
        axes_are_raw_features = axes_are_raw_features,
        point_feature_attributions = point_feature_attributions,
    )

    # Broadcast cleanly to our explicit stream endpoint
    await hub.broadcast(payload)

    if anomaly_idx:
        metrics_summary = str(data_2d[anomaly_idx[0]].tolist())
        if encoding_summary_dict is not None:
            enc = encoding_summary_dict
            metrics_summary += (
                f" (Note: {enc['encoded_categorical_columns']} of the {enc['total_columns']} "
                f"source column(s) are encoded categorical features — {enc['encoded_dims']} "
                f"of this vector's dimensions are encoded categories, not raw measurements.)"
            )
        _spawn_narrative_task(frame_id, metrics_summary)

    return payload


@app.post(
    "/api/canvas/anomaly/explain",
    response_model=AnomalyExplainResponse,
    tags=["Canvas"],
)
async def explain_anomaly_point(request: AnomalyExplainRequest):
    """
    On-demand, per-point narrative explanation (2026-07-29 sprint) — distinct
    from the automatic, fire-and-forget, first-anomaly-only narrative
    ingest_and_broadcast spawns per frame. A user clicked *this specific
    point*; they're actively waiting for an answer, not looking for a passive
    broadcast, so this is a direct request/response, not something pushed
    over the shared /stream WebSocket (which fans out to every connected
    client — reusing it here would leak one user's clicked-point explanation
    to every other browser tab watching the same stream).
    """
    if request.point_index < 0:
        raise AnomalyExplainError(
            detail=f"point_index must be >= 0, got {request.point_index}",
            stage="validation",
        )

    metrics_summary = _build_point_explanation_summary(request)
    try:
        explanation = await generate_anomaly_explanation(
            metrics_summary, timeout=EXPLAIN_LLM_TIMEOUT_SECONDS
        )
    except Exception as e:
        # generate_anomaly_explanation already catches its own httpx
        # exceptions internally and returns a fallback string — this is a
        # backstop for anything genuinely unanticipated, same discipline as
        # ingest_and_broadcast's vectorization try/except.
        logger.exception("Unexpected failure generating point explanation")
        raise AnomalyExplainError(
            # Generic detail (2026-08-27 sprint) -- see the matching fix in
            # ingest_and_broadcast above for why str(e) doesn't belong in a
            # response to an unauthenticated caller; full text stays in the
            # server log via logger.exception above.
            detail="Narrative generation failed unexpectedly",
            stage="llm_unavailable",
        ) from e

    if explanation == LLM_FALLBACK_TEXT:
        # generate_anomaly_explanation never raises on an Ollama failure —
        # it degrades to this fixed fallback string so the fire-and-forget
        # per-frame narrative path never crashes a background task. This
        # endpoint's caller is actively waiting on a specific answer, so
        # that same fallback is surfaced here as a structured error instead
        # of silently returning generic text disguised as a real answer.
        # Compared against the exact string (not the racy, global, multi-
        # request _llm_status flag, which could be stale or updated by a
        # concurrent frame's unrelated narrative task) so this check is
        # scoped to exactly what this request itself got back.
        raise AnomalyExplainError(
            detail="Local LLM is unreachable or timed out — no narrative could be generated",
            stage="llm_unavailable",
        )

    return AnomalyExplainResponse(point_index=request.point_index, explanation=explanation)

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

# ─── Supplementary Routers ─────────────────────────────────────────────────
#
# 2026-08-27 sprint: this used to also register app.api.routes.health here,
# under the same "/api/health" prefix as this file's own @app.get("/api/health")
# handler above (registered first, at module load, since decorators run
# top-to-bottom in source order) -- Starlette matches routes in registration
# order and stops at the first match, so that duplicate health handler was
# permanently unreachable dead code. Worse: tests/test_api.py was built
# against app.api.__init__'s separate, never-launched FastAPI app (a second
# dead app object, now removed) and so was unknowingly asserting on that
# dead handler's response shape instead of this live one's -- fixed
# alongside this. canvas/inference stay: their routes (/api/canvas/mesh,
# /api/inference) aren't shadowed by anything in this file.
try:
    from app.api.routes import canvas, inference  # noqa: E402

    app.include_router(inference.router, prefix="/api/inference", tags=["Inference"])
    app.include_router(canvas.router,    prefix="/api/canvas",    tags=["Canvas"])

except ImportError as _e:
    logger.warning("Supplementary routers unavailable: %s", _e)
