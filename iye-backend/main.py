import asyncio
import json
import time
import numpy as np
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import List, Dict, Any
from vector_engine import IYEMathEngine

app = FastAPI(title="iye spatial infrastructure pipeline", version="0.1.0")

# Enable wide-open CORS for our Next.js local environment dev loop
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # wide-open to allow dev server & MCP client connections
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = IYEMathEngine()

class JSONRPCRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: str | int | None = None
    method: str
    params: Dict[str, Any] = Field(default_factory=dict)

# Helper to generate mock coordinate fields inside the pipeline loop
def generate_synthetic_vector_field(num_vectors: int = 200) -> np.ndarray:
    """
    Generates a raw (N, 6) vector field matrix.
    [ox, oy, oz, vx, vy, vz]
    """
    t = time.time()
    indices = np.arange(num_vectors)
    
    # Grid positioning via parametric spiral logic
    ox = np.sin(indices * 0.1 + t * 0.5) * 5.0
    oy = (indices * 0.05) - 5.0
    oz = np.cos(indices * 0.1 + t * 0.5) * 5.0
    
    # Dynamic rotating rotational velocities
    vx = -np.cos(indices * 0.1 + t) * 2.0
    vy = np.sin(t * 0.2) * 1.0
    vz = np.sin(indices * 0.1 + t) * 2.0
    
    # Intentionally inject bad calculations every 60 frames to test our shield loop
    if int(t) % 6 == 0:
        vx[0:5] = np.nan
        vy[5:10] = np.inf
        vz[10:15] = 0.0  # Forces a zero-velocity state
        
    return np.column_stack([ox, oy, oz, vx, vy, vz])

@app.get("/stream/field")
async def stream_vector_field(request: Request):
    """
    Server-Sent Events (SSE) data pipeline.
    Sanitizes frames via vector_engine and streams continuous JSON vectors.
    """
    async def event_generator():
        while True:
            # Check for client disconnect to close resources cleanly
            if await request.is_disconnected():
                break

            # 1. Fetch raw geometric field coordinates
            raw_field = generate_synthetic_vector_field(num_vectors=150)
            
            # 2. Push matrix through our 4-pass mathematical shield
            sanitized_field, status = engine.sanitize_vector_field(raw_field)
            
            # 3. Format matrix array data payload into clear UI components
            vector_list = []
            for i in range(sanitized_field.shape[0]):
                row = sanitized_field[i]
                v_dir = row[3:6]
                vector_list.append({
                    "id": f"v_{i}",
                    "origin": [float(row[0]), float(row[1]), float(row[2])],
                    "direction": [float(v_dir[0]), float(v_dir[1]), float(v_dir[2])],
                    "magnitude": float(np.linalg.norm(v_dir))
                })

            payload = {
                "timestamp": int(time.time() * 1000),
                "status": status,
                "vectors": vector_list
            }

            # 4. Standard yield string for SSE data channels
            yield f"data: {json.dumps(payload)}\n\n"
            
            # Lock frame loop to a smooth execution speed (~30 fps)
            await asyncio.sleep(0.033)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/tool/field_stats")
async def mcp_field_stats_tool(payload: JSONRPCRequest):
    """
    Model Context Protocol (MCP) tool discovery endpoint.
    Processes JSON-RPC 2.0 requests issued natively by autonomous agents.
    """
    if payload.method != "field_stats":
        return {
            "jsonrpc": "2.0",
            "id": payload.id,
            "error": {"code": -32601, "message": "method not found"}
        }

    try:
        raw_coordinates = payload.params.get("field", [])
        if not raw_coordinates:
            return {
                "jsonrpc": "2.0",
                "id": payload.id,
                "result": {"count": 0, "status": "empty_payload"}
            }

        # Convert incoming nested array safely back into a validation matrix
        matrix = np.array(raw_coordinates, dtype=np.float32)
        
        # Pull math analytics directly from the engine
        analytics = engine.compute_field_analytics(matrix)

        return {
            "jsonrpc": "2.0",
            "id": payload.id,
            "result": analytics
        }
    except Exception as e:
        return {
            "jsonrpc": "2.0",
            "id": payload.id,
            "error": {"code": -32603, "message": f"internal engine error: {str(e)}"}
        }

if __name__ == "__main__":
    import uvicorn
    # Establish server runtime locally on dedicated application port 8787
    uvicorn.run("main:app", host="127.0.0.1", port=8787, reload=True) 
