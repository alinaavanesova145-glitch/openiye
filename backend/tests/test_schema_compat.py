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


# The "narrative arrives as a separate WS message" gap noted above is now
# covered by an automated, hermetic end-to-end test — see
# tests/test_e2e_narrative.py (real uvicorn subprocess, stubbed Ollama;
# TestClient can't observe this behavior, see that file's docstring for why).
