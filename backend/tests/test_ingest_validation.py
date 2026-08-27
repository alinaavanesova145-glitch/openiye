"""
backend/tests/test_ingest_validation.py — regression tests for the
empty/malformed/degenerate-payload crash fixed in the 2026-07-16 sprint.

Root cause chain (see docs/idealization_report.md for the full diagnosis):
1. Ragged `matrix` rows -> np.array(..., dtype=float64) raised an uncaught
   ValueError ("inhomogeneous shape").
2. A zero-column matrix (e.g. [[], []]) silently zero-padded into fabricated
   (0,0,0) geometry instead of being rejected.
3. UMAP's spectral embedding crashes for small-but-nonzero sample counts
   (empirically non-monotonic: n=1 fine, n=2-4 raise, n=5+ fine) when
   n_features > 3 — e.g. `graph.data.max()` on a zero-size internal array.
4. HDBSCAN raises for n_samples < 2 (0: sklearn's own "min 1 required";
   1: "k must be less than or equal to the number of training points").

Every one of these used to surface as a raw 500 with a Python traceback.
This suite asserts the *specific* structured 422 contract (or documented
fallback), not just "doesn't crash".
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.main import app

client = TestClient(app)


def _assert_structured_422(response, expected_stage: str):
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "empty_or_invalid_payload"
    assert body["status"] == 422
    assert body["stage"] == expected_stage
    assert isinstance(body["detail"], str) and len(body["detail"]) > 0
    return body


# ─── Phase 1 bug #1: ragged matrix rows (np.array ValueError, uncaught) ───────


def test_ragged_matrix_rows_returns_structured_422_not_500():
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [[1, 2, 3, 4, 5, 6], [7, 8]]},
    )
    _assert_structured_422(response, "ingestion")


def test_ragged_matrix_rows_of_wildly_different_shapes():
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [[1, 2, 3], [4, 5, 6, 7, 8, 9], [1]]},
    )
    _assert_structured_422(response, "ingestion")


# ─── Phase 1 bug #2: zero-column matrix (was silent fabricated geometry) ──────


def test_zero_column_matrix_rejected_not_fabricated():
    """Every row present but empty — previously zero-padded into fake
    (0,0,0) points with a 200 OK. Must now be rejected outright."""
    response = client.post("/api/canvas/vectors", json={"matrix": [[], []]})
    _assert_structured_422(response, "feature_matrix")


def test_single_zero_column_row_rejected():
    response = client.post("/api/canvas/vectors", json={"matrix": [[]]})
    _assert_structured_422(response, "feature_matrix")


# ─── Empty payload — the "headers only / truly empty file" equivalent ────────
# (CSV/JSON parsing happens client-side; the backend's equivalent of an
# empty upload is an empty matrix/data field reaching this endpoint.)


def test_empty_json_object_rejected():
    response = client.post("/api/canvas/vectors", json={})
    _assert_structured_422(response, "ingestion")


def test_empty_matrix_list_rejected():
    response = client.post("/api/canvas/vectors", json={"matrix": []})
    _assert_structured_422(response, "ingestion")


def test_empty_flat_data_list_rejected():
    response = client.post("/api/canvas/vectors", json={"data": []})
    _assert_structured_422(response, "ingestion")


def test_flat_data_not_a_multiple_of_dim_rejected():
    response = client.post("/api/canvas/vectors", json={"data": [1, 2, 3], "dim": 6})
    body = _assert_structured_422(response, "ingestion")
    assert "dim=6" in body["detail"]


# ─── Non-numeric values — now auto-encoded, not rejected ──────────────────────
# UPDATED 2026-07-28 sprint. Before this sprint, MatrixUploadRequest.matrix
# was typed List[List[float]], so FastAPI/Pydantic rejected non-float
# elements with their own automatic 422 before this route's code ever ran —
# the previous version of this test (quoted below) asserted exactly that.
# `matrix` is now List[List[Any]]: a request with no browser in the loop
# (direct API/curl call, or iye.show() from a script) gets the same
# classify-and-encode pass frontend/src/canvas/upload/parseMatrix.ts already
# runs for browser uploads, via iye.encoding.vectorize_matrix — see
# backend/app/api/main.py's ingest_and_broadcast and docs/idealization_report.md,
# 2026-07-28 sprint. Non-numeric values are no longer an error case at all
# for this endpoint; they're a supported input that produces a 200 with a
# computed encoding_summary.
#
# BEFORE (this exact test, prior to this sprint):
#     def test_non_numeric_matrix_values_rejected_by_pydantic_before_reaching_our_code():
#         response = client.post("/api/canvas/vectors", json={"matrix": [["a", "b", "c"]]})
#         assert response.status_code == 422
#         body = response.json()
#         assert "detail" in body
#         assert isinstance(body["detail"], list)
#         assert any("matrix" in str(err.get("loc", [])) for err in body["detail"])
#
# AFTER (below): the same request now succeeds and auto-encodes.


def test_non_numeric_matrix_values_now_auto_encoded_not_rejected():
    """1 row x 3 columns, each cell a distinct single-row string column —
    every column has exactly one category, so each one-hot-encodes to a
    single dim with scale 1/sqrt(1) = 1.0."""
    response = client.post("/api/canvas/vectors", json={"matrix": [["a", "b", "c"]]})
    assert response.status_code == 200
    body = response.json()
    assert body["point_count"] == 1
    assert body["coordinates"][0] == {"x": 1.0, "y": 1.0, "z": 1.0}
    assert body["encoding_summary"] == {
        "total_columns": 3,
        "numeric_columns": 0,
        "encoded_categorical_columns": 3,
        "encoded_dims": 3,
        "skipped_free_text": 0,
    }


# ─── Phase 1 bugs #3/#4: degenerate-but-nonzero sample counts ─────────────────
# Single-row / small-sample edge cases — the exact UMAP/HDBSCAN crashes.


def test_single_row_with_more_than_3_features_falls_back_not_crashes():
    """n_samples=1: reduce_to_3d succeeds on its own, but the (1,3) result
    used to crash inside cluster() ("k must be <= number of training
    points"). Must now succeed with an all-noise label and a reduction_note
    explaining the truncation fallback."""
    response = client.post("/api/canvas/vectors", json={"matrix": [[1, 2, 3, 4, 5, 6]]})
    assert response.status_code == 200
    body = response.json()
    assert body["point_count"] == 1
    assert body["cluster_labels"] == [-1]
    assert body["reduction_note"] is not None
    assert "1 sample" in body["reduction_note"]


def test_two_rows_six_features_the_exact_reported_umap_crash():
    """This is the precise scenario from the bug report: UMAP's spectral
    embedding calls graph.data.max() on a zero-size array for n_samples=2,
    n_features=6. Must now fall back to truncation instead of a 500."""
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["point_count"] == 2
    assert body["cluster_labels"] == [-1, -1]
    assert body["reduction_note"] is not None
    # Truncation fallback: coordinates are the first 3 raw columns, not a
    # real UMAP embedding.
    assert body["coordinates"][0] == {"x": 1.0, "y": 2.0, "z": 3.0}
    assert body["coordinates"][1] == {"x": 7.0, "y": 8.0, "z": 9.0}


def test_three_and_four_rows_six_features_also_fall_back_not_crash():
    for n in (3, 4):
        matrix = [[float(i + j) for j in range(6)] for i in range(n)]
        response = client.post("/api/canvas/vectors", json={"matrix": matrix})
        assert response.status_code == 200, f"n_samples={n} should not crash"
        body = response.json()
        assert body["reduction_note"] is not None, f"n_samples={n} should note the fallback"


def test_five_rows_six_features_uses_real_umap_no_fallback_note():
    """Non-regression: MIN_SAMPLES_FOR_REDUCTION's boundary (5) must not
    over-trigger the fallback for a sample count that's actually safe."""
    matrix = [[float(i + j) for j in range(6)] for i in range(5)]
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert body["reduction_note"] is None


def test_two_rows_three_features_bypasses_umap_entirely_no_fallback_note():
    """n_features == 3 is a pure passthrough (no UMAP involved at all,
    regardless of n_samples) — must not get a reduction_note either, since
    no reduction was skipped (none was ever going to happen)."""
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [[1, 2, 3], [4, 5, 6]]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["reduction_note"] is None
    assert body["cluster_labels"] == [-1, -1]


# ─── 2026-08-27 sprint: non-finite (NaN/Infinity) values in a payload ────────
#
# Python's json module parses the non-standard-but-permitted literals NaN /
# Infinity / -Infinity as real float('nan')/inf values by default (both
# stdlib json and Starlette/FastAPI's request parsing accept them) -- a
# payload containing them used to sail straight past every existing check
# (isinstance(v, float) happily accepts NaN/inf as "already numeric") into
# UMAP/HDBSCAN/z-score math, silently masking real anomalies on that axis
# and serializing as JSON `null` against a contract that promises numbers.


def _post_raw_json(path: str, raw_body: str):
    """httpx's TestClient (used via the `json=` kwarg) refuses to encode
    NaN/Infinity client-side (`allow_nan=False`) -- but that's a test-client
    restriction, not the real world: stdlib json.loads (what FastAPI/
    Starlette actually parses incoming request bodies with) accepts those
    non-standard-but-permitted literals by default, so a real attacker (or
    a non-Python HTTP client) can send them just fine. Posting the raw
    bytes directly reproduces what a real client can actually do."""
    return client.post(
        path,
        content=raw_body.encode("utf-8"),
        headers={"content-type": "application/json"},
    )


def test_flat_data_containing_nan_rejected_not_silently_corrupted():
    response = _post_raw_json(
        "/api/canvas/vectors",
        '{"data": [1.0, 2.0, 3.0, 1.0, 2.0, NaN], "dim": 3}',
    )
    _assert_structured_422(response, "ingestion")


def test_flat_data_containing_infinity_rejected():
    response = _post_raw_json(
        "/api/canvas/vectors",
        '{"data": [1.0, 2.0, 3.0, 1.0, 2.0, Infinity], "dim": 3}',
    )
    _assert_structured_422(response, "ingestion")


def test_matrix_of_all_finite_numbers_via_the_fully_numeric_fast_path_still_works():
    """Sanity check that the new finite guard doesn't false-positive on
    ordinary, entirely-finite data taking the fully-numeric fast path."""
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [[1.0, 2.0, 3.0]] * 5},
    )
    assert response.status_code == 200


# ─── 2026-08-27 sprint: request size limits ─────────────────────────────────
#
# Nothing previously bounded payload size -- a pathological request went
# straight into np.array().reshape() and then UMAP/HDBSCAN with no cap.


def test_oversized_flat_data_rejected_by_field_length_cap():
    response = client.post(
        "/api/canvas/vectors",
        json={"data": [1.0] * 500_001, "dim": 3},
    )
    assert response.status_code == 422  # Pydantic's own validation-error shape


def test_oversized_matrix_row_count_rejected():
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [[1.0, 2.0, 3.0]] * 50_001},
    )
    assert response.status_code == 422


def test_pathologically_wide_single_row_rejected():
    """One row with far more columns than any real dataset would have --
    row-count caps alone wouldn't catch this."""
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [[1.0] * 5_001, [1.0] * 5_001]},
    )
    assert response.status_code == 422
