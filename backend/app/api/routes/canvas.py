import uuid
from datetime import datetime, timezone
from typing import List, Optional

# Ensure iye is importable
import iye
import numpy as np
from fastapi import APIRouter, HTTPException
from iye.server import Coordinate3D as IYECoordinate3D
from iye.server import VectorFramePayload
from pydantic import BaseModel

router = APIRouter()

class Coordinate3D(BaseModel):
    x: float
    y: float
    z: float

class MeshData(BaseModel):
    id: str
    vertices: List[Coordinate3D]
    faces: List[List[int]]

class VectorUploadRequest(BaseModel):
    data: List[float]
    dim: Optional[int] = None

@router.get("/mesh", response_model=MeshData)
async def get_canvas_mesh():
    # Return dummy vector dataset for the canvas rendering
    return {
        "id": "root-mesh",
        "vertices": [
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 1.0, "y": 0.0, "z": 0.0},
            {"x": 0.0, "y": 1.0, "z": 0.0}
        ],
        "faces": [[0, 1, 2]]
    }

@router.post("/vectors", response_model=VectorFramePayload)
async def process_vectors(request: VectorUploadRequest):
    if not request.data:
        raise HTTPException(status_code=400, detail="Empty data list")

    d = request.dim or 3
    if len(request.data) % d != 0:
        raise HTTPException(
            status_code=400,
            detail=f"Data array size ({len(request.data)}) is not a multiple of dimension {d}"
        )

    n_samples = len(request.data) // d
    data_2d = np.array(request.data, dtype=np.float64).reshape(n_samples, d)

    # 1. Dimensionality reduction
    coords = iye.reduce_to_3d(data_2d)

    # 2. Clustering
    labels = iye.cluster(coords)

    # 3. Anomaly detection
    anomaly_indices, explanation = iye.detect_anomalies(coords)

    # 4. Build payload
    status = "ANOMALY" if len(anomaly_indices) > 0 else "NOMINAL"
    coordinates = [
        IYECoordinate3D(x=float(row[0]), y=float(row[1]), z=float(row[2]))
        for row in coords
    ]

    return VectorFramePayload(
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
