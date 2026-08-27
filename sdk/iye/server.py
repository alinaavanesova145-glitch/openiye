"""
iye.server — Pydantic wire-format contracts (Coordinate3D, FeatureAttribution,
VectorFramePayload, etc.) shared between this SDK and the shipped backend
(backend/app/api/main.py imports these directly). Those models ARE the
live contract and are used in production.

The StreamHub/get_hub/ws_app/vector_stream_endpoint broadcast
infrastructure below is NOT — it's a legacy, never-deployed alternative.
The actual shipped backend (backend/app/api/main.py) implements its own
separate StreamHub and /stream endpoint and never imports this module's
StreamHub, get_hub, or vector_stream_endpoint (confirmed via grep across
the whole repo, 2026-08-27 sprint audit — the only imports of this module
anywhere pull the Pydantic models above, never these). Kept in place
rather than deleted only because deleting working code with no
replacement mid-audit is a bigger, riskier change than documenting it —
worth an explicit follow-up decision on whether to delete it outright.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Literal, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

logger = logging.getLogger("iye.server")

# ─── Pydantic Contracts ───────────────────────────────────────────────────────


class Coordinate3D(BaseModel):
    """A single 3D point in the IYE coordinate space."""

    x: float
    y: float
    z: float


class FeatureAttribution(BaseModel):
    """A single named original field's deviation magnitude for one point
    (2026-07-31 sprint) — see iye.compute_feature_attributions. Grouped
    back from possibly-multiple encoded matrix columns (e.g. a one-hot
    field's several category columns) to the one human-readable field
    that actually produced them."""

    # max_length=200 (2026-08-27 sprint): `name` is echoed back by the
    # frontend from a prior frame and lands verbatim, unsanitized, inside
    # the Ollama narrative prompt (backend/app/api/main.py's
    # generate_anomaly_explanation). A legitimate column name is a handful
    # of words; capping it bounds both prompt-injection surface and
    # prompt-size amplification from a hand-crafted request to
    # /api/canvas/anomaly/explain (this endpoint takes no auth, so anyone
    # who can reach it can set this field to anything).
    name: str = Field(max_length=200)
    z_score: float


class VectorFramePayload(BaseModel):
    """
    The canonical frame payload streamed over WebSocket to the frontend canvas.

    Status toggles from NOMINAL → ANOMALY when any coordinate exceeds 2.5σ
    on any axis (absolute Z-score threshold).
    """

    frame_id: str = Field(..., description="Unique frame identifier (UUID4)")
    timestamp: str = Field(..., description="ISO 8601 emission timestamp")
    status: Literal["NOMINAL", "ANOMALY"] = Field(
        ..., description="Anomaly status derived from Z-score analysis"
    )
    point_count: int = Field(..., ge=0, description="Number of 3D coordinates")
    coordinates: list[Coordinate3D] = Field(
        ..., description="UMAP-reduced 3D coordinate array"
    )
    cluster_labels: list[int] = Field(
        ..., description="HDBSCAN cluster labels (-1 = noise)"
    )
    anomaly_indices: list[int] = Field(
        ..., description="Indices of points exceeding the 2.5σ threshold"
    )
    explanation: Optional[str] = Field(
        default=None,
        description="Plain-English explainability text (null while an async narrative is pending)",
    )
    axis_mapping: Optional[Dict[str, int]] = Field(
        default=None,
        description="Optional axis remapping for the frontend canvas",
    )
    id: Optional[str] = Field(
        default=None,
        description="Frame identifier for WS message correlation (mirrors frame_id)",
    )
    type: Literal["frame"] = Field(
        default="frame",
        description="WS message discriminator consumed by the frontend stream handler",
    )
    temporal: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Additive sliding-window temporal metrics (see temporal_engine.TemporalMetrics)",
    )
    encoding_summary: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Additive — echoed back only when the ingested matrix included "
            "encoded categorical columns (see backend/app/api/main.py's "
            "EncodingSummary and frontend parseMatrix.ts). Null for ordinary "
            "numeric-only frames."
        ),
    )
    reduction_note: Optional[str] = Field(
        default=None,
        description=(
            "Additive (2026-07-16 sprint) — non-null only when the sample "
            "count was too low for a real UMAP reduction and the backend "
            "fell back to truncating to the first 3 raw feature columns "
            "instead (see iye.reduce_to_3d's MIN_SAMPLES_FOR_REDUCTION). "
            "Null whenever a real reduction (or the <=3-feature passthrough) "
            "was used."
        ),
    )
    point_z_scores: list[list[float]] = Field(
        default_factory=list,
        description=(
            "Additive (2026-07-29 sprint) — one [x, y, z] absolute Z-score "
            "triple per point, parallel to `coordinates` (see "
            "iye.compute_z_scores). Grounds both severity-based visual "
            "encoding and POST /api/canvas/anomaly/explain's per-point "
            "narrative request — the frontend echoes a specific point's "
            "triple back in that request rather than the backend needing "
            "to look anything up server-side."
        ),
    )
    axes_are_raw_features: bool = Field(
        default=True,
        description=(
            "Additive (2026-07-29 sprint) — true when x/y/z map directly to "
            "original input dimensions (the <=3-feature passthrough case, "
            "or the small-n truncation fallback — see reduction_note), "
            "false only when a real UMAP embedding was used (x/y/z are then "
            "abstract embedded axes, not literal source features). Lets a "
            "narrative honestly say 'the Nth measured value' only when "
            "that's actually true, instead of fabricating meaning for an "
            "opaque UMAP axis."
        ),
    )
    point_feature_attributions: list[list[FeatureAttribution]] = Field(
        default_factory=list,
        description=(
            "Additive (2026-07-31 sprint) — per point, the top named "
            "original fields (not raw matrix/axis indices) by deviation "
            "magnitude, computed on the pre-reduction feature matrix so it "
            "stays meaningful even after a real UMAP embedding (see "
            "iye.compute_feature_attributions). An empty list for a given "
            "point means no real column names were available for this "
            "request — the explain endpoint falls back to the older "
            "axes_are_raw_features-based generic phrasing in that case, "
            "never a fabricated name."
        ),
    )


# ─── StreamHub ─────────────────────────────────────────────────────────────────


class StreamHub:
    """
    Thread-safe async broadcast hub for WebSocket vector frame streaming.

    Each connected WebSocket client is assigned its own asyncio.Queue.
    The broadcast() method pushes serialised frames to all active queues.
    """

    def __init__(self) -> None:
        self._clients: dict[WebSocket, asyncio.Queue[str]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> asyncio.Queue[str]:
        """Register a new WebSocket client and return its message queue."""
        await websocket.accept()
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
        async with self._lock:
            self._clients[websocket] = queue
        logger.info("client connected (%d active)", len(self._clients))
        return queue

    async def disconnect(self, websocket: WebSocket) -> None:
        """Remove a WebSocket client from the broadcast registry."""
        async with self._lock:
            self._clients.pop(websocket, None)
        logger.info("client disconnected (%d active)", len(self._clients))

    async def broadcast(self, payload: VectorFramePayload) -> None:
        """Push a serialised frame to every connected client's queue."""
        message = payload.model_dump_json()
        async with self._lock:
            stale: list[WebSocket] = []
            for ws, queue in self._clients.items():
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    # Drop oldest frame to prevent backpressure stalling
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    try:
                        queue.put_nowait(message)
                    except asyncio.QueueFull:
                        stale.append(ws)
            for ws in stale:
                self._clients.pop(ws, None)

    @property
    def client_count(self) -> int:
        return len(self._clients)


# ─── Singleton ─────────────────────────────────────────────────────────────────

_hub: Optional[StreamHub] = None


def get_hub() -> StreamHub:
    """Return the module-level StreamHub singleton (lazy init)."""
    global _hub  # noqa: PLW0603
    if _hub is None:
        _hub = StreamHub()
    return _hub


# ─── FastAPI WebSocket App ─────────────────────────────────────────────────────

ws_app = FastAPI(title="IYE WebSocket Streaming")


@ws_app.websocket("/ws/vectors")
async def vector_stream_endpoint(websocket: WebSocket) -> None:
    """
    Persistent WebSocket endpoint for streaming VectorFramePayload messages.

    Clients connect and receive frames as they are broadcast by the SDK's
    show() function. Clients may also send configuration messages to adjust
    axis mapping in real-time.
    """
    hub = get_hub()
    queue = await hub.connect(websocket)

    try:
        # Spawn a concurrent reader for incoming client configuration messages
        async def _read_client_messages() -> None:
            try:
                while True:
                    raw = await websocket.receive_text()
                    try:
                        msg = json.loads(raw)
                        if isinstance(msg, dict) and msg.get("type") == "configure":
                            logger.info("client config received: %s", msg)
                            # TODO(security): Validate and sanitise config
                            # before applying to pipeline state.
                    except (json.JSONDecodeError, TypeError):
                        logger.warning("invalid client message ignored")
            except WebSocketDisconnect:
                pass

        reader_task = asyncio.create_task(_read_client_messages())

        # Stream frames from the queue to the client
        while True:
            message = await queue.get()
            await websocket.send_text(message)

    except WebSocketDisconnect:
        pass
    finally:
        reader_task.cancel()
        await hub.disconnect(websocket)
