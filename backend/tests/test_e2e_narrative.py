"""
backend/tests/test_e2e_narrative.py — Hermetic end-to-end proof of the
narrative decoupling contract.

Approach taken: a real uvicorn subprocess on an ephemeral port, not
Starlette's TestClient. TestClient was tried first and hangs indefinitely —
each TestClient call runs the ASGI app on a short-lived event loop that is
torn down as soon as the HTTP response returns, before the fire-and-forget
asyncio.create_task narrative task ever gets scheduled (documented in
test_schema_compat.py's history; see git blame). A real uvicorn process has
one persistent event loop for its whole lifetime, so the background task
runs exactly as it does in production — this test proves the real behavior
instead of working around a test-harness limitation.

Hermetic: the Ollama endpoint is stubbed with a tiny stdlib http.server on
its own ephemeral port, and OLLAMA_API_URL is pointed at it via env var
(backend/app/api/main.py reads this env var, defaulting to the real Ollama
address). This test passes with no Ollama installed.

Marked @pytest.mark.e2e — slower than the rest of the suite (subprocess
startup + health poll). Run everything except it with: pytest -m "not e2e"

stub_ollama_port/live_backend fixtures live in conftest.py — shared with
test_e2e_upload_narrative.py rather than duplicated.
"""

from __future__ import annotations

import asyncio
import json

import pytest
import requests
import websockets

from tests.conftest import CANNED_NARRATIVE


@pytest.mark.e2e
def test_anomaly_narrative_delivery_over_real_websocket(live_backend):
    """
    POSTs an anomaly-triggering payload against a real running backend and
    asserts the two-message sequence: (a) an immediate `frame` WS message
    with explanation=None, then (b) a `narrative` message with the matching
    id and the (stubbed) LLaMA text.
    """
    port = live_backend

    async def _scenario():
        async with websockets.connect(f"ws://127.0.0.1:{port}/stream") as ws:
            data = [1.0, 1.0, 1.0] * 15 + [100.0, 100.0, 100.0]  # 3D bypasses UMAP -> deterministic
            response = requests.post(
                f"http://127.0.0.1:{port}/api/canvas/vectors",
                json={"data": data, "dim": 3},
                timeout=10,
            )
            assert response.status_code == 200
            frame_id = response.json()["id"]

            frame_msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            assert frame_msg["type"] == "frame"
            assert frame_msg["status"] == "ANOMALY"
            assert frame_msg["explanation"] is None

            narrative_msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            assert narrative_msg["type"] == "narrative"
            assert narrative_msg["id"] == frame_id
            assert narrative_msg["explanation"] == CANNED_NARRATIVE

    asyncio.run(_scenario())
