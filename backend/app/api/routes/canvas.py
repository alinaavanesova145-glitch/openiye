"""
app/api/routes/canvas.py — supplementary canvas routes mounted at
/api/canvas alongside app/api/main.py's own direct routes.

Only /mesh lives here now. This module used to also define POST /vectors,
duplicating app/api/main.py's own @app.post("/api/canvas/vectors") handler
at the same path -- Starlette matches routes in registration order and
main.py's direct handler is registered first (module load, before this
router is included), so that duplicate was permanently unreachable dead
code: no ragged-row/non-numeric-column/finite-value validation, a
different default dim (3 vs main.py's 6), and a bare HTTPException
instead of the real handler's structured 422 contract. Removed rather
than fixed in place, since main.py's handler is the real, tested,
maintained one (2026-08-27 sprint; see docs/fullstack_audit_2026-08-27.md).
"""

from typing import List

from fastapi import APIRouter
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
