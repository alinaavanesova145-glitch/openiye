import json

from fastapi.testclient import TestClient

from app.api.main import app

client = TestClient(app)


def test_temporal_engine_integration_three_sequential_frames():
    """
    POST 3 sequential 6D metrics frames while listening on /stream, and verify
    each response is 200 OK and the final broadcast carries non-null numeric
    temporal.velocity / temporal.composite_smoothed values.
    """
    with client.websocket_connect("/stream") as websocket:
        received = []
        for i in range(3):
            # Shift the centroid each frame so velocity/drift are non-zero.
            base = float(i) * 5.0
            data = [base + 1.0] * 6 * 16

            response = client.post("/api/canvas/vectors", json={"data": data, "dim": 6})
            assert response.status_code == 200

            raw = websocket.receive_text()
            received.append(json.loads(raw))

        assert len(received) == 3
        final = received[-1]

        assert final["type"] == "frame"
        assert final["temporal"] is not None

        temporal = final["temporal"]
        assert temporal["velocity"] is not None
        assert isinstance(temporal["velocity"], (int, float))
        assert temporal["composite_smoothed"] is not None
        assert isinstance(temporal["composite_smoothed"], (int, float))
