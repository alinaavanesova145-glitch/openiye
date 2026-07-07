"""
backend/tests/conftest.py — shared hermetic e2e fixtures.

`stub_ollama_port` and `live_backend` were originally written in
test_e2e_narrative.py; extracted here so any e2e test module can reuse the
same real-uvicorn-subprocess + stubbed-Ollama machinery instead of
duplicating it (see test_e2e_upload_narrative.py).
"""

from __future__ import annotations

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
