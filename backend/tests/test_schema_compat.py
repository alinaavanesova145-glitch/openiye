from typing import Dict, List, Literal, Optional

from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.api.main import app

client = TestClient(app)


class LegacyVectorFramePayload(BaseModel):
    """
    Mirrors the pre-temporal-engine payload shape. Extra fields introduced by
    the id/type/temporal rollout must not break a consumer built against this
    older contract.
    """

    model_config = {"extra": "ignore"}

    frame_id: str
    timestamp: str
    status: Literal["NOMINAL", "ANOMALY"]
    point_count: int
    coordinates: list
    cluster_labels: List[int]
    anomaly_indices: List[int]
    explanation: Optional[str] = None
    axis_mapping: Optional[Dict[str, int]] = None


def test_payload_has_additive_temporal_fields():
    data = [1.0] * 6 * 16
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 6})
    assert response.status_code == 200
    payload = response.json()

    assert isinstance(payload.get("id"), str)
    assert payload["type"] == "frame"
    assert isinstance(payload.get("temporal"), dict)
    for key in ("velocity", "acceleration", "drift_slope", "composite_smoothed", "regime", "window_fill", "z_max"):
        assert key in payload["temporal"]


def test_legacy_consumer_still_parses_todays_payload():
    """A pydantic model shaped like the pre-temporal-engine contract, with
    extra='ignore', must still validate against today's payload."""
    data = [1.0] * 6 * 16
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 6})
    assert response.status_code == 200
    legacy = LegacyVectorFramePayload.model_validate(response.json())
    assert legacy.status == "NOMINAL"
    assert legacy.point_count == 16


def test_anomaly_frame_explanation_is_null_until_narrative_arrives():
    """Decoupling gate: the synchronous HTTP/broadcast response must not
    block on the Ollama call — explanation is null immediately on the
    anomaly frame; the narrative arrives later on a separate WS message."""
    data = [1.0, 1.0, 1.0] * 15 + [100.0, 100.0, 100.0]  # 3D bypasses UMAP -> deterministic
    response = client.post("/api/canvas/vectors", json={"data": data, "dim": 3})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ANOMALY"
    assert payload["explanation"] is None


# NOTE: an end-to-end "narrative arrives as a separate WS message" test was
# attempted here using client.websocket_connect() + client.post(), but it
# hangs indefinitely under Starlette's TestClient: each TestClient call runs
# the ASGI app on a short-lived event loop that is torn down as soon as the
# HTTP response is returned, before the fire-and-forget asyncio.create_task
# narrative task ever gets scheduled. This is a TestClient artifact, not a
# production bug — verified manually against a real running uvicorn process
# with a real `websockets` client: the frame broadcasts immediately with
# explanation=None, and the {"type": "narrative", "id": ...} message follows
# shortly after (see docs/idealization_report.md for the transcript).
