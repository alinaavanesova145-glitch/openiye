"""
backend/tests/test_encoding_summary.py — additive encoding_summary field
(2026-07-12 sprint, Phase 1c).

The backend never computes encoding itself — categorical encoding happens
entirely client-side (frontend/src/canvas/upload/parseMatrix.ts). The
backend's only job is to (a) accept the optional encoding_summary on
ingestion, (b) echo it back on the response payload unchanged, and (c) fold
a note into the anomaly narrative prompt so the LLaMA text can say the data
includes encoded categories, not raw measurements.
"""

from __future__ import annotations

import asyncio
import json

import pytest
import requests
import websockets
from fastapi.testclient import TestClient

from app.api.main import app
from tests.conftest import received_prompts

client = TestClient(app)

SAMPLE_ENCODING_SUMMARY = {
    "total_columns": 6,
    "numeric_columns": 4,
    "encoded_categorical_columns": 2,
    "encoded_dims": 4,
    "skipped_free_text": 0,
}


def test_encoding_summary_is_null_when_not_sent():
    """Backward compatible: a plain matrix upload (no encoding_summary key at
    all) gets a null encoding_summary back, exactly as before this field
    existed."""
    matrix = [[1.0, 1.0, 1.0]] * 16
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    assert response.json()["encoding_summary"] is None


def test_encoding_summary_is_echoed_back_unchanged():
    matrix = [[1.0, 1.0, 1.0]] * 16
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": matrix, "encoding_summary": SAMPLE_ENCODING_SUMMARY},
    )
    assert response.status_code == 200
    assert response.json()["encoding_summary"] == SAMPLE_ENCODING_SUMMARY


def test_encoding_summary_rejects_malformed_shape():
    """Additive field is still validated — a request with the wrong shape
    for encoding_summary 422s rather than being silently accepted."""
    matrix = [[1.0, 1.0, 1.0]] * 16
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": matrix, "encoding_summary": {"total_columns": "not-a-number"}},
    )
    assert response.status_code == 422


@pytest.mark.e2e
def test_narrative_prompt_mentions_encoding_when_summary_present(live_backend):
    """Hermetic end-to-end: an anomaly frame ingested with encoding_summary
    must produce a narrative whose *prompt* (captured by the stubbed Ollama
    server) mentions the encoded-categorical note — proving the backend
    actually threads the summary into the LLM prompt, not just the response
    payload."""
    port = live_backend

    async def _scenario():
        async with websockets.connect(f"ws://127.0.0.1:{port}/stream") as ws:
            matrix = [[1.0, 1.0, 1.0]] * 15 + [[100.0, 100.0, 100.0]]  # 3D bypasses UMAP
            response = requests.post(
                f"http://127.0.0.1:{port}/api/canvas/vectors",
                json={"matrix": matrix, "encoding_summary": SAMPLE_ENCODING_SUMMARY},
                timeout=10,
            )
            assert response.status_code == 200
            body = response.json()
            assert body["status"] == "ANOMALY"
            assert body["encoding_summary"] == SAMPLE_ENCODING_SUMMARY

            frame_msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            assert frame_msg["type"] == "frame"

            narrative_msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            assert narrative_msg["type"] == "narrative"

        assert len(received_prompts) == 1
        prompt = received_prompts[0]
        assert "2 of the 6 source column(s) are encoded categorical" in prompt
        assert "4 of this vector's dimensions are encoded categories, not raw measurements" in prompt

    asyncio.run(_scenario())
