import os
import sys
import json
import uuid
import logging
import asyncio
from datetime import datetime, timezone
from typing import List, Optional, Dict, Literal

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Ensure the SDK and backend directories are in sys.path
_app_dir = os.path.dirname(os.path.abspath(__file__))
_backend_dir = os.path.dirname(_app_dir)
_project_root = os.path.dirname(_backend_dir)

if _project_root not in sys.path:
    sys.path.insert(0, _project_root)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)
if os.path.join(_project_root, "sdk") not in sys.path:
    sys.path.insert(0, os.path.join(_project_root, "sdk"))

# Lazy import the SDK packages
import iye
from iye.server import Coordinate3D, VectorFramePayload

# Configure logger
logger = logging.getLogger("iye.backend")
logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="IYE Anomaly Detection Engine",
    description="High-performance vector canvas anomaly detection server",
    version="1.0.0"
)

# Un-capped CORS policy allowing connection from local dev hosts
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── StreamHub Implementation ──────────────────────────────────────────────────

class StreamHub:
    """Thread-safe WebSocket broadcast hub managing active streaming clients."""
    def __init__(self) -> None:
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        logger.info(f"Client connected. Active channels: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        logger.info(f"Client disconnected. Active channels: {len(self.active_connections)}")

    async def broadcast(self, payload: VectorFramePayload) -> None:
        message = payload.model_dump_json()
        async with self._lock:
            disconnected_clients: List[WebSocket] = []
            for ws in self.active_connections:
                try:
                    await ws.send_text(message)
                except Exception:
                    disconnected_clients.append(ws)
            
            for ws in disconnected_clients:
                if ws in self.active_connections:
                    self.active_connections.remove(ws)

hub = StreamHub()

# ─── Pydantic Requests ────────────────────────────────────────────────────────

class MatrixUploadRequest(BaseModel):
    # Support flat floats list or nested list of floats
    data: List[float]
    dim: Optional[int] = 6  # Default to 6D metrics matrix
    matrix: Optional[List[List[float]]] = None

# ─── REST Heartbeat & Routes ──────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "iye-backend-engine",
        "timestamp": datetime.now(tz=timezone.utc).isoformat()
    }

@app.post("/api/canvas/vectors", response_model=VectorFramePayload)
async def process_and_broadcast_vectors(request: MatrixUploadRequest):
    """
    Accepts 6D metrics matrix, reduces it via UMAP, runs clustering,
    checks for anomalies, and immediately broadcasts to active WS clients.
    """
    matrix_data: Optional[List[List[float]]] = request.matrix
    
    if matrix_data is None:
        if not request.data:
            raise HTTPException(status_code=400, detail="No matrix data provided")
        
        # Determine features size
        d = request.dim or 6
        if len(request.data) % d != 0:
            raise HTTPException(
                status_code=400,
                detail=f"Flat data size ({len(request.data)}) must be a multiple of feature dimension {d}"
            )
        
        n_samples = len(request.data) // d
        data_2d = np.array(request.data, dtype=np.float64).reshape(n_samples, d)
    else:
        # Convert nested list directly
        data_2d = np.array(matrix_data, dtype=np.float64)
        if data_2d.ndim != 2:
            raise HTTPException(status_code=400, detail="Matrix must be 2D")
        
    n_samples, n_features = data_2d.shape
    if n_samples == 0:
        raise HTTPException(status_code=400, detail="Empty sample set")

    # 1. Dimensionality reduction (handles 6D metric space -> 3D)
    coords = iye.reduce_to_3d(data_2d)

    # 2. HDBSCAN Clustering
    labels = iye.cluster(coords)

    # 3. Z-score Anomaly Detection
    anomaly_indices, explanation = iye.detect_anomalies(coords)

    status = "ANOMALY" if len(anomaly_indices) > 0 else "NOMINAL"
    coordinates = [
        Coordinate3D(x=float(row[0]), y=float(row[1]), z=float(row[2]))
        for row in coords
    ]

    payload = VectorFramePayload(
        frame_id=str(uuid.uuid4()),
        timestamp=datetime.now(tz=timezone.utc).isoformat(),
        status=status,
        point_count=coords.shape[0],
        coordinates=coordinates,
        cluster_labels=labels.tolist(),
        anomaly_indices=anomaly_indices,
        explanation=explanation,
        axis_mapping=None
    )

    # Immediately broadcast to all active WS channels
    await hub.broadcast(payload)
    return payload

# ─── WebSocket Streaming Endpoint ──────────────────────────────────────────────

@app.websocket("/stream")
async def stream_endpoint(websocket: WebSocket) -> None:
    """Dedicated live WebSocket vector stream connection endpoint."""
    await hub.connect(websocket)
    try:
        while True:
            # Keep connection alive and parse optional client configs
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                if isinstance(msg, dict) and msg.get("type") == "configure":
                    logger.info(f"Received WebSocket stream config: {msg}")
            except (json.JSONDecodeError, TypeError):
                pass
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(websocket)

# Include existing API routers if necessary to maintain full compatibility
try:
    from app.api.routes import inference, health as route_health
    app.include_router(route_health.router, prefix="/api/health-legacy", tags=["Legacy"])
    app.include_router(inference.router, prefix="/api/inference", tags=["Inference"])
except ImportError:
    pass
