from fastapi.testclient import TestClient
from app.api import app

client = TestClient(app)

def test_health_endpoint():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "service": "iye-backend"
    }

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
    # 6 points near [1.0, 1.0, 1.0]
    data = [1.0, 1.0, 1.0] * 6
    response = client.post("/api/canvas/vectors", json={"data": data})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "NOMINAL"
    assert payload["point_count"] == 6
    assert len(payload["coordinates"]) == 6
    assert len(payload["anomaly_indices"]) == 0

def test_vector_upload_anomaly():
    # 16 points: 15 near [1.0, 1.0, 1.0] and 1 huge outlier [100.0, 100.0, 100.0]
    data = [1.0, 1.0, 1.0] * 15 + [100.0, 100.0, 100.0]
    response = client.post("/api/canvas/vectors", json={"data": data})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ANOMALY"
    assert payload["point_count"] == 16
    assert 15 in payload["anomaly_indices"]  # 16th point is index 15
    assert len(payload["anomaly_indices"]) == 1
