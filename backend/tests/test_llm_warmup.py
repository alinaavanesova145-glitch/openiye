"""
backend/tests/test_llm_warmup.py — regression tests for the startup LLM
model warm-up (2026-08-30 sprint, Finding 3).

Before this sprint, `_startup_llm_healthcheck` only hit Ollama's `/api/tags`
-- confirming its HTTP server answers, never that a model was actually
loaded into memory. Loading a freshly-pulled (or idle-unloaded) model is a
separate, additive multi-GB cost on top of generation time, so a user's
first-ever click after `ollama pull` reliably blew the interactive explain
endpoint's 30s budget (EXPLAIN_LLM_TIMEOUT_SECONDS) purely on model-load
time -- on literally their first interaction, while the sidebar's "llm ·
ready" badge said otherwise. `_warm_up_llm` issues one real, minimal
/api/generate call from the app's startup lifespan, fire-and-forget, so the
model is resident in memory before any user-facing request in the common
case, without ever delaying server startup or crashing if Ollama is absent.
"""

from __future__ import annotations

import json

import pytest
import requests
from fastapi.testclient import TestClient

import app.api.main as main_module
from app.api.main import _warm_up_llm, app
from tests.conftest import received_prompts

client = TestClient(app)


# ─── Unit-level: _warm_up_llm in isolation ────────────────────────────────────


def test_warm_up_llm_success_sets_status_ready(monkeypatch, stub_ollama_port):
    monkeypatch.setattr(main_module, "OLLAMA_API_URL", f"http://127.0.0.1:{stub_ollama_port}/api/generate")
    monkeypatch.setattr(main_module, "_llm_status", "unknown")

    import asyncio

    asyncio.run(_warm_up_llm())

    assert main_module._llm_status == "ready"
    assert len(received_prompts) == 1
    assert received_prompts[0] == main_module.LLM_WARMUP_PROMPT


def test_warm_up_llm_sends_a_minimal_prompt_not_the_full_narrative_prompt(monkeypatch, stub_ollama_port):
    """The warm-up call's whole point is to be cheap and fast to generate --
    it must not reuse generate_anomaly_explanation's much longer analysis
    prompt, which would defeat "short" and could itself run long."""
    monkeypatch.setattr(main_module, "OLLAMA_API_URL", f"http://127.0.0.1:{stub_ollama_port}/api/generate")

    import asyncio

    asyncio.run(_warm_up_llm())

    assert received_prompts[0] == "hi"
    assert "structural anomaly" not in received_prompts[0].lower()


def test_warm_up_llm_unreachable_sets_status_offline_and_never_raises(monkeypatch):
    """A closed port -- Ollama simply isn't running. Must degrade silently,
    exactly like generate_anomaly_explanation's own failure handling; a
    startup-time background task that raises would be a much worse bug than
    the one it's fixing."""
    monkeypatch.setattr(main_module, "OLLAMA_API_URL", "http://127.0.0.1:1/api/generate")
    monkeypatch.setattr(main_module, "_llm_status", "unknown")

    import asyncio

    asyncio.run(_warm_up_llm())  # must not raise

    assert main_module._llm_status == "offline"


def test_warm_up_llm_timeout_sets_status_offline_and_never_raises(monkeypatch):
    """A stub server slower than the (monkeypatched-tiny) warm-up timeout --
    proves the timeout path specifically, not just connection-refused."""
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
        monkeypatch.setattr(main_module, "LLM_WARMUP_TIMEOUT_SECONDS", 0.05)
        monkeypatch.setattr(main_module, "_llm_status", "unknown")

        import asyncio

        asyncio.run(_warm_up_llm())  # must not raise

        assert main_module._llm_status == "offline"
    finally:
        server.shutdown()
        thread.join(timeout=5)


# ─── Existing 422 llm_unavailable contract on the explain endpoint is unchanged ──


def test_explain_endpoint_still_returns_structured_422_when_llm_unavailable(monkeypatch):
    """The warm-up addition is purely additive -- it must not weaken or
    replace the honest-failure contract the explain endpoint already had
    (see test_anomaly_explain.py::test_explain_llm_unreachable_returns_
    structured_error, which this mirrors)."""
    monkeypatch.setattr(main_module, "OLLAMA_API_URL", "http://127.0.0.1:1/api/generate")
    response = client.post(
        "/api/canvas/anomaly/explain",
        json={
            "point_index": 0,
            "coordinates": {"x": 1.0, "y": 1.0, "z": 1.0},
            "z_scores": {"x": 3.0, "y": 3.0, "z": 3.0},
            "cluster_label": -1,
        },
    )
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "explain_failed"
    assert body["stage"] == "llm_unavailable"


# ─── End-to-end: the warm-up actually fires on real server startup ─────────────


@pytest.mark.e2e
def test_llm_warmup_fires_automatically_on_startup_with_no_explain_request_sent(live_backend):
    """Hermetic proof the warm-up call reaches "Ollama" (the stub server)
    entirely on its own during startup -- no /api/canvas/anomaly/explain
    request is ever sent in this test. Polls briefly: the warm-up task is
    scheduled but deliberately not awaited during startup (must not delay
    it), so it may still be in flight by the moment live_backend's own
    /api/health poll first succeeds."""
    port = live_backend
    deadline_iterations = 50
    for _ in range(deadline_iterations):
        if received_prompts:
            break
        import time

        time.sleep(0.2)

    assert received_prompts, (
        "expected the startup warm-up task to have called /api/generate on "
        "its own, with no explain request ever sent by this test"
    )
    assert received_prompts[0] == "hi"

    # The server was already accepting requests well before that -- proves
    # the warm-up ran off the startup hot path, not blocking it.
    health = requests.get(f"http://127.0.0.1:{port}/api/health", timeout=5)
    assert health.status_code == 200
