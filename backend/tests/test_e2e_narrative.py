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
"""

from __future__ import annotations

import asyncio
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time

import pytest
import requests
import websockets

CANNED_NARRATIVE = "Stubbed narrative: structural drift detected on axis 2."


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _StubOllamaHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server's required method name)
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)  # drain the request body; content is irrelevant to the stub
        body = json.dumps({"response": CANNED_NARRATIVE}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 (silence default stderr access log)
        pass


@pytest.fixture()
def stub_ollama_port():
    port = _find_free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), _StubOllamaHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        thread.join(timeout=5)


@pytest.fixture()
def live_backend(stub_ollama_port):
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../backend
    backend_port = _find_free_port()

    env = os.environ.copy()
    env["PYTHONPATH"] = backend_dir
    env["OLLAMA_API_URL"] = f"http://127.0.0.1:{stub_ollama_port}/api/generate"

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(backend_port),
        ],
        cwd=backend_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    base_url = f"http://127.0.0.1:{backend_port}"
    deadline = time.time() + 15
    healthy = False
    while time.time() < deadline:
        if proc.poll() is not None:
            break  # process died — stop polling, fall through to the failure report
        try:
            r = requests.get(f"{base_url}/api/health", timeout=1)
            if r.status_code == 200:
                healthy = True
                break
        except requests.exceptions.RequestException:
            pass
        time.sleep(0.2)

    if not healthy:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        output = proc.stdout.read() if proc.stdout else ""
        pytest.fail(f"backend subprocess never became healthy on port {backend_port}:\n{output}")

    try:
        yield backend_port
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


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
