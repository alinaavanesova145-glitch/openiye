"""
backend/tests/test_e2e_upload_narrative.py — proves batch (matrix) uploads
get the same anomaly-frame -> narrative treatment as any other ingestion.

Reuses the hermetic uvicorn-subprocess + stubbed-Ollama fixtures from
conftest.py (stub_ollama_port, live_backend) rather than duplicating the
scaffolding test_e2e_narrative.py already built. The only thing this test
adds is exercising the `matrix` (2D) request shape — the path
frontend/src/canvas/math/useVectorDiagnostics.ts's ingestFile now uses for
every file upload — instead of the flat `data`/`dim` shape.
"""

from __future__ import annotations

import asyncio
import json

import pytest
import requests
import websockets

from tests.conftest import CANNED_NARRATIVE


@pytest.mark.e2e
def test_batch_upload_with_outlier_yields_anomaly_frame_then_narrative(live_backend):
    port = live_backend

    async def _scenario():
        async with websockets.connect(f"ws://127.0.0.1:{port}/stream") as ws:
            # 3D bypasses UMAP -> deterministic; one row is a clear outlier.
            matrix = [[1.0, 1.0, 1.0]] * 15 + [[100.0, 100.0, 100.0]]
            response = requests.post(
                f"http://127.0.0.1:{port}/api/canvas/vectors",
                json={"matrix": matrix},
                timeout=10,
            )
            assert response.status_code == 200
            body = response.json()
            assert body["status"] == "ANOMALY"
            assert body["anomaly_indices"]
            frame_id = body["id"]

            frame_msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            assert frame_msg["type"] == "frame"
            assert frame_msg["status"] == "ANOMALY"
            assert frame_msg["explanation"] is None

            narrative_msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            assert narrative_msg["type"] == "narrative"
            assert narrative_msg["id"] == frame_id
            assert narrative_msg["explanation"] == CANNED_NARRATIVE

    asyncio.run(_scenario())
