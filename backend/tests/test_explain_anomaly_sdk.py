"""
backend/tests/test_explain_anomaly_sdk.py — regression tests for
iye.explain_anomaly(), the headless-Python counterpart to a browser user
clicking an anomaly beacon (2026-07-29 sprint). requests.post is
monkeypatched throughout — no live backend needed.
"""

from __future__ import annotations

import iye


class _FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


def _fake_post_factory(response_by_call):
    """Returns a fake requests.post that yields successive canned responses,
    one per call — lets a test simulate "first candidate port refuses,
    second one answers" without a real network."""
    calls = {"n": 0}

    def _fake_post(url, json, timeout):
        idx = min(calls["n"], len(response_by_call) - 1)
        calls["n"] += 1
        resp = response_by_call[idx]
        if resp is None:
            raise ConnectionError("refused")
        return resp

    return _fake_post


def test_explain_anomaly_returns_explanation_on_success(monkeypatch):
    monkeypatch.setattr(
        iye.requests,
        "post",
        _fake_post_factory([_FakeResponse(200, {"point_index": 7, "explanation": "drift on axis y"})]),
    )
    iye._cached_active_port = None

    result = iye.explain_anomaly(
        point_index=7,
        coordinates={"x": 1.0, "y": 2.0, "z": 3.0},
        z_scores={"x": 0.1, "y": 4.0, "z": 0.2},
        cluster_label=-1,
    )
    assert result == "drift on axis y"


def test_explain_anomaly_returns_none_and_logs_on_structured_error(monkeypatch):
    """A reached-but-rejected 422 (e.g. llm_unavailable) must not be
    mistaken for 'nothing is listening on this port' — it's a real answer
    from our own backend, just a negative one."""
    monkeypatch.setattr(
        iye.requests,
        "post",
        _fake_post_factory(
            [_FakeResponse(422, {"error": "explain_failed", "stage": "llm_unavailable"})]
        ),
    )
    iye._cached_active_port = None

    result = iye.explain_anomaly(
        point_index=7,
        coordinates={"x": 1.0, "y": 2.0, "z": 3.0},
        z_scores={"x": 0.1, "y": 4.0, "z": 0.2},
        cluster_label=-1,
    )
    assert result is None


def test_explain_anomaly_returns_none_when_every_port_refuses(monkeypatch):
    monkeypatch.setattr(iye.requests, "post", _fake_post_factory([None, None, None]))
    iye._cached_active_port = None

    result = iye.explain_anomaly(
        point_index=1,
        coordinates={"x": 0.0, "y": 0.0, "z": 0.0},
        z_scores={"x": 0.0, "y": 0.0, "z": 0.0},
        cluster_label=0,
    )
    assert result is None


def test_explain_anomaly_caches_the_responding_port_even_on_error_response(monkeypatch):
    """accept_error_responses=True means a 4xx still counts as 'found the
    backend' for port-caching purposes — proven by asserting the cache is
    populated, not just that the call returns None."""
    monkeypatch.setattr(
        iye.requests,
        "post",
        _fake_post_factory([_FakeResponse(422, {"error": "explain_failed"})]),
    )
    iye._cached_active_port = None

    iye.explain_anomaly(
        point_index=1,
        coordinates={"x": 0.0, "y": 0.0, "z": 0.0},
        z_scores={"x": 0.0, "y": 0.0, "z": 0.0},
        cluster_label=0,
    )
    assert iye._cached_active_port is not None


def test_show_still_only_accepts_200_not_error_responses(monkeypatch):
    """Non-regression: show()'s port-scan must keep its exact pre-2026-07-29
    behavior — a non-200 response is NOT treated as 'found the backend',
    unlike explain_anomaly()'s accept_error_responses=True."""
    monkeypatch.setattr(
        iye.requests,
        "post",
        _fake_post_factory(
            [
                _FakeResponse(422, {"error": "empty_or_invalid_payload"}),
                _FakeResponse(422, {"error": "empty_or_invalid_payload"}),
                _FakeResponse(422, {"error": "empty_or_invalid_payload"}),
            ]
        ),
    )
    iye._cached_active_port = None

    iye.show([[1.0, 2.0, 3.0]])

    assert iye._cached_active_port is None
