import os
import sys
from fastapi import FastAPI

# Ensure the SDK package is importable
_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_sdk_path = os.path.join(_project_root, "sdk")
if _sdk_path not in sys.path:
    sys.path.insert(0, _sdk_path)

from app.api.routes import inference, canvas, health

# Late import after path setup
from iye.server import ws_app, vector_stream_endpoint  # noqa: E402

app = FastAPI(
    title="IYE Backend API",
    description="DeepTech APIs, Vector math, and Core models",
    version="0.1.0",
)

# Include REST routers
app.include_router(health.router, prefix="/api/health", tags=["System"])
app.include_router(inference.router, prefix="/api/inference", tags=["Inference"])
app.include_router(canvas.router, prefix="/api/canvas", tags=["Canvas"])

# Mount WebSocket endpoint for live vector streaming
app.add_api_websocket_route("/ws/vectors", vector_stream_endpoint)

# TODO(security): In production, authenticate WebSocket connections
# and apply rate-limiting to prevent abuse.
