"""
backend/tests/test_api.py — smoke tests against the REAL, live app object.

Used to import `from app.api import app` -- a second, separate FastAPI
app that app/api/__init__.py built but nothing ever launched (boot.sh and
backend/main.py both serve app.api.main:app). These tests were therefore
unknowingly exercising a dead handler's behavior instead of the live
one's: the dead /api/health returned a different, smaller payload, and
the dead /api/canvas/vectors defaulted `dim` to 3 instead of the live
handler's 6, silently changing what "16 flat floats" means. Repointed at
the real app and adjusted for its actual (documented, deliberate) shape
-- see docs/fullstack_audit_2026-08-27.md, 2026-08-27 sprint.
"""

from fastapi.testclient import TestClient

from app.api.main import app

client = TestClient(app)

def test_health_endpoint():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "iye-backend-engine"
    assert "timestamp" in data
    assert "llm" in data

def test_canvas_endpoint():
    response = client.get("/api/canvas/mesh")
    assert response.status_code == 200
    data = response.json()
    assert "vertices" in data
    assert len(data["vertices"]) == 3

def test_inference_endpoint():
    response = client.post("/api/inference", json={"data": [1.0, 2.0, 3.0]})
    assert response.status_code == 200
    data = response.json()
    assert data["prediction"] == [1.5, 3.0, 4.5]
    assert data["confidence"] == 0.99

def test_vector_upload_nominal():
    # 6 points near [1.0, 1.0, 1.0]. dim explicit (the real handler
    # defaults to 6, not 3 -- see main.py's MatrixUploadRequest) so this
    # keeps testing "6 separate 3D points" as originally intended.
    data = [1.0, 1.0, 1.0] * 6
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 3})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "NOMINAL"
    assert payload["point_count"] == 6
    assert len(payload["coordinates"]) == 6
    assert len(payload["anomaly_indices"]) == 0

def test_vector_upload_anomaly():
    # 16 points: 15 near [1.0, 1.0, 1.0] and 1 huge outlier [100.0, 100.0, 100.0]
    data = [1.0, 1.0, 1.0] * 15 + [100.0, 100.0, 100.0]
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 3})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ANOMALY"
    assert payload["point_count"] == 16
    assert 15 in payload["anomaly_indices"]  # 16th point is index 15
    assert len(payload["anomaly_indices"]) == 1
