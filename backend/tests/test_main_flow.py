from fastapi.testclient import TestClient
from app.api.main import app
import numpy as np

client = TestClient(app)

def test_main_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"

def test_main_vectors_nominal_6d():
    # 16 samples of 6D metrics vectors
    data = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0] * 16
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 6})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "NOMINAL"
    assert payload["point_count"] == 16
    assert len(payload["coordinates"]) == 16
    
    # Verify coordinates are 3D
    coord = payload["coordinates"][0]
    assert "x" in coord
    assert "y" in coord
    assert "z" in coord

def test_main_vectors_anomaly_3d():
    # 15 samples of 3D nominal metrics, and 1 massive outlier 3D vector (bypasses UMAP)
    data = [1.0, 1.0, 1.0] * 15 + [100.0, 100.0, 100.0]
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 3})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ANOMALY"
    assert payload["point_count"] == 16
    assert 15 in payload["anomaly_indices"]
    assert len(payload["anomaly_indices"]) == 1

def test_main_vectors_reduction_6d():
    # Verify that UMAP reduces 6D space to 3D space successfully
    data = [1.0, 1.0, 1.0, 2.0, 2.0, 2.0] * 16
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 6})
    assert response.status_code == 200
    payload = response.json()
    assert payload["point_count"] == 16
    assert len(payload["coordinates"]) == 16
    assert len(payload["coordinates"][0]) == 3  # Reduced to 3D

def test_main_websocket_stream():
    with client.websocket_connect("/stream") as websocket:
        # Check connection is active and can keepalive
        websocket.send_text('{"type": "configure", "axisMapping": {"x": 0}}')
