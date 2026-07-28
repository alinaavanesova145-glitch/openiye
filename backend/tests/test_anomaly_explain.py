"""
backend/tests/test_anomaly_explain.py — regression tests for the on-demand
per-point narrative endpoint (2026-07-29 sprint).

Distinct from test_e2e_narrative.py's coverage of the automatic,
fire-and-forget, first-anomaly-only per-frame narrative: this endpoint is a
direct request/response a user actively waits on after clicking a specific
point, grounded in that point's own coordinates/z-scores/cluster membership
rather than the frame's first anomalous point.
"""

from __future__ import annotations

import json

import pytest
import requests
from fastapi.testclient import TestClient

import app.api.main as main_module
from app.api.main import _build_point_explanation_summary, app
from tests.conftest import received_prompts

client = TestClient(app)


def _valid_explain_request(**overrides):
    body = {
        "point_index": 15,
        "coordinates": {"x": 100.0, "y": 100.0, "z": 100.0},
        "z_scores": {"x": 3.87, "y": 3.87, "z": 3.87},
        "cluster_label": -1,
        "axes_are_raw_features": True,
    }
    body.update(overrides)
    return body


# ─── point_z_scores / axes_are_raw_features on the vectors response ───────────


def test_vectors_response_includes_point_z_scores_parallel_to_coordinates():
    matrix = [[1.0, 2.0, 3.0]] * 15 + [[100.0, 100.0, 100.0]]
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert len(body["point_z_scores"]) == len(body["coordinates"]) == 16
    assert all(len(triple) == 3 for triple in body["point_z_scores"])
    # The outlier point should have a much larger z-score than a nominal one.
    assert body["point_z_scores"][15][0] > body["point_z_scores"][0][0]


def test_axes_are_raw_features_true_for_passthrough():
    matrix = [[1.0, 2.0, 3.0]] * 16
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    assert response.json()["axes_are_raw_features"] is True


def test_axes_are_raw_features_true_for_small_n_truncation_fallback():
    matrix = [[float(i + j) for j in range(6)] for i in range(2)]  # n=2, 6 features
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert body["reduction_note"] is not None
    assert body["axes_are_raw_features"] is True


def test_axes_are_raw_features_false_for_real_umap_reduction():
    matrix = [[float(i + j) for j in range(6)] for i in range(5)]  # n=5, real UMAP
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert body["reduction_note"] is None
    assert body["axes_are_raw_features"] is False


# ─── Request validation ─────────────────────────────────────────────────────────


def test_explain_negative_point_index_rejected():
    response = client.post("/api/canvas/anomaly/explain", json=_valid_explain_request(point_index=-1))
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "explain_failed"
    assert body["stage"] == "validation"


def test_explain_malformed_request_missing_fields_rejected():
    response = client.post("/api/canvas/anomaly/explain", json={"point_index": 1})
    assert response.status_code == 422


# ─── LLM failure modes ───────────────────────────────────────────────────────────


def test_explain_llm_unreachable_returns_structured_error(monkeypatch):
    """No stub Ollama running and OLLAMA_API_URL pointed at a closed port —
    guarantees a deterministic connection failure regardless of whether a
    real Ollama happens to be running elsewhere on the test machine."""
    monkeypatch.setattr(main_module, "OLLAMA_API_URL", "http://127.0.0.1:1/api/generate")
    response = client.post("/api/canvas/anomaly/explain", json=_valid_explain_request())
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "explain_failed"
    assert body["stage"] == "llm_unavailable"


def test_explain_llm_timeout_returns_structured_error(monkeypatch):
    """A stub server that responds slower than the (monkeypatched-tiny)
    timeout must produce the same structured llm_unavailable error, proving
    the timeout path — not just connection-refused — is handled."""
    import http.server
    import socket
    import threading
    import time as time_module

    def _find_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    class _SlowHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            time_module.sleep(0.5)
            body = json.dumps({"response": "too slow"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    port = _find_free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), _SlowHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setattr(main_module, "OLLAMA_API_URL", f"http://127.0.0.1:{port}/api/generate")
        monkeypatch.setattr(main_module, "EXPLAIN_LLM_TIMEOUT_SECONDS", 0.05)
        response = client.post("/api/canvas/anomaly/explain", json=_valid_explain_request())
        assert response.status_code == 422
        assert response.json()["stage"] == "llm_unavailable"
    finally:
        server.shutdown()
        thread.join(timeout=5)


# ─── Prompt grounding (unit-level, no LLM needed) ────────────────────────────────


def test_prompt_grounding_names_raw_feature_axis_when_true():
    req = main_module.AnomalyExplainRequest(**_valid_explain_request(axes_are_raw_features=True))
    summary = _build_point_explanation_summary(req)
    assert "raw measured feature" in summary
    assert "UMAP" not in summary


def test_prompt_grounding_describes_embedding_axis_when_false():
    req = main_module.AnomalyExplainRequest(**_valid_explain_request(axes_are_raw_features=False))
    summary = _build_point_explanation_summary(req)
    assert "UMAP-reduced dimension" in summary
    assert "raw measured feature" not in summary


def test_prompt_grounding_cites_cluster_membership():
    noise_req = main_module.AnomalyExplainRequest(**_valid_explain_request(cluster_label=-1))
    assert "noise" in _build_point_explanation_summary(noise_req)

    clustered_req = main_module.AnomalyExplainRequest(**_valid_explain_request(cluster_label=3))
    assert "cluster 3" in _build_point_explanation_summary(clustered_req)


def test_prompt_grounding_identifies_dominant_deviating_axis():
    req = main_module.AnomalyExplainRequest(
        **_valid_explain_request(z_scores={"x": 0.5, "y": 4.2, "z": 1.0})
    )
    summary = _build_point_explanation_summary(req)
    assert "y-axis" in summary
    assert "4.20" in summary


# ─── End-to-end success path (hermetic: real uvicorn + stubbed Ollama) ──────────


@pytest.mark.e2e
def test_explain_success_returns_point_specific_explanation(live_backend):
    port = live_backend
    response = requests.post(
        f"http://127.0.0.1:{port}/api/canvas/anomaly/explain",
        json=_valid_explain_request(),
        timeout=10,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["point_index"] == 15
    assert isinstance(body["explanation"], str) and len(body["explanation"]) > 0


@pytest.mark.e2e
def test_explain_prompt_is_grounded_in_this_points_specific_signal(live_backend):
    """Hermetic proof the *actual* prompt sent to Ollama (captured by the
    stub server) cites this point's real coordinates/z-scores/cluster, not
    generic filler. Unlike the per-frame narrative, this endpoint returns
    its explanation directly in the HTTP response — no WS broadcast, no
    connected client needed to observe it."""
    port = live_backend
    response = requests.post(
        f"http://127.0.0.1:{port}/api/canvas/anomaly/explain",
        json=_valid_explain_request(point_index=42, cluster_label=2),
        timeout=10,
    )
    assert response.status_code == 200

    assert len(received_prompts) == 1
    prompt = received_prompts[0]
    assert "point #42" in prompt
    assert "cluster 2" in prompt
    assert "100.000" in prompt  # the coordinate value from _valid_explain_request
