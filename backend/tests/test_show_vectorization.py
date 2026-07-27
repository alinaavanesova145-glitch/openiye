"""
backend/tests/test_show_vectorization.py — regression tests for
iye.show()'s non-numeric auto-encoding fallback (2026-07-28 sprint).

Before this sprint, show() silently logged and returned on any non-numeric
matrix (np.asarray(..., dtype=float64) failing). It now falls back to
iye.encoding.vectorize_matrix for row/column-shaped input, matching the
same auto-encoding a browser upload or a direct API call gets — see
test_backend_vectorization.py for the REST-endpoint equivalent.

requests.post is monkeypatched throughout — these tests assert on what
show() would have sent, without needing a live backend.
"""

from __future__ import annotations

import iye


class _FakeResponse:
    status_code = 200


def _capture_post(captured):
    def _fake_post(url, json, timeout):
        captured["url"] = url
        captured["json"] = json
        return _FakeResponse()

    return _fake_post


def test_show_encodes_pure_categorical_matrix_before_posting(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(iye.requests, "post", _capture_post(captured))
    iye._cached_active_port = None

    iye.show([["red", "small"], ["blue", "large"], ["red", "small"], ["green", "medium"]])

    assert captured, "show() never called requests.post"
    body = captured["json"]
    assert body["dim"] == 6
    assert len(body["data"]) == 4 * 6
    assert body["encoding_summary"] == {
        "total_columns": 2,
        "numeric_columns": 0,
        "encoded_categorical_columns": 2,
        "encoded_dims": 6,
        "skipped_free_text": 0,
    }


def test_show_still_takes_unaffected_fast_path_for_numeric_matrix(monkeypatch):
    """Non-regression: a plain numeric matrix must behave exactly as
    before — no encoding_summary key at all in the posted payload."""
    captured: dict = {}
    monkeypatch.setattr(iye.requests, "post", _capture_post(captured))
    iye._cached_active_port = None

    iye.show([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])

    assert captured, "show() never called requests.post"
    body = captured["json"]
    assert body["dim"] == 3
    assert body["data"] == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    assert "encoding_summary" not in body


def test_show_flat_non_numeric_list_has_no_column_structure_logs_and_skips(monkeypatch):
    """A flat 1D list of strings has no row/column structure to classify
    against — still rejected (logged), not silently mis-encoded."""
    captured: dict = {}
    monkeypatch.setattr(iye.requests, "post", _capture_post(captured))
    iye._cached_active_port = None

    iye.show(["not", "a", "matrix"])

    assert not captured, "show() should not have posted anything"
