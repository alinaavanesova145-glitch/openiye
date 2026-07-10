"""
backend/tests/test_cors_lan_access.py — dev-only LAN-aware CORS
(2026-07-14 sprint, Phase 2).

Root cause this closes: the app was unreachable when opened via the host
machine's LAN IP (e.g. http://192.168.1.4:3000) instead of localhost — both
because the frontend hardcoded `127.0.0.1` in its request URLs (fixed
separately, frontend/src/lib/apiConfig.ts) and because, had that been fixed
alone, the backend's CORS policy still needed to actually permit a LAN
origin's cross-origin requests.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.main import app

client = TestClient(app)


def _cors_allowed(origin: str) -> bool:
    response = client.get("/api/health", headers={"Origin": origin})
    assert response.status_code == 200
    return response.headers.get("access-control-allow-origin") == origin


def test_localhost_origin_allowed():
    assert _cors_allowed("http://localhost:3000")


def test_loopback_ip_origin_allowed():
    assert _cors_allowed("http://127.0.0.1:3000")


def test_private_lan_192_168_origin_allowed():
    assert _cors_allowed("http://192.168.1.4:3000")


def test_private_lan_10_x_origin_allowed():
    assert _cors_allowed("http://10.0.0.5:3000")


def test_private_lan_172_16_31_origin_allowed():
    assert _cors_allowed("http://172.20.0.5:3000")


def test_private_lan_172_outside_16_31_range_rejected():
    # 172.32.x.x is outside the 172.16.0.0/12 private range — must not match.
    assert not _cors_allowed("http://172.32.0.5:3000")


def test_wrong_port_rejected():
    assert not _cors_allowed("http://192.168.1.4:4000")


def test_public_internet_origin_rejected():
    assert not _cors_allowed("http://evil.example.com:3000")
