"""
backend/tests/test_backend_vectorization.py — end-to-end regression tests
for the backend-side categorical/text auto-encoding path (2026-07-28
sprint).

Scope: requests to /api/canvas/vectors with no browser in the loop (a
direct API/curl call, or iye.show() from a script) that send a raw,
possibly non-numeric `matrix`. These now get the same classify-and-encode
pass frontend/src/canvas/upload/parseMatrix.ts already runs for browser
uploads, via iye.encoding.vectorize_matrix (see
backend/app/api/main.py's ingest_and_broadcast). A browser-originated
request — already numeric, already carrying its own client-computed
encoding_summary — is unaffected; see test_encoding_summary.py for that
path's tests.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.main import app

client = TestClient(app)


def test_pure_categorical_payload_ingests_successfully():
    matrix = [["red", "small"], ["blue", "large"], ["red", "small"], ["green", "medium"]]
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert body["point_count"] == 4
    assert body["encoding_summary"] == {
        "total_columns": 2,
        "numeric_columns": 0,
        "encoded_categorical_columns": 2,
        "encoded_dims": 6,  # 3 colors + 3 sizes, one-hot
        "skipped_free_text": 0,
    }


def test_free_text_log_column_excluded_not_rejected():
    """A numeric column alongside a near-unique 'log line' column — the
    text column is excluded (not encoded, not silently dropped without a
    trace), the numeric column ingests normally."""
    matrix = [[float(i), f"unique log line {i} happened"] for i in range(25)]
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert body["point_count"] == 25
    assert body["encoding_summary"]["numeric_columns"] == 1
    assert body["encoding_summary"]["skipped_free_text"] == 1
    assert body["encoding_summary"]["encoded_categorical_columns"] == 0


def test_mixed_numeric_categorical_text_payload_single_coherent_matrix():
    matrix = [
        [float(i), ["north", "south", "east"][i % 3], f"unique note {i}"]
        for i in range(25)
    ]
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert body["point_count"] == 25
    summary = body["encoding_summary"]
    assert summary["total_columns"] == 3
    assert summary["numeric_columns"] == 1
    assert summary["encoded_categorical_columns"] == 1  # the 3-value direction column
    assert summary["encoded_dims"] == 3  # one-hot over {north, south, east}
    assert summary["skipped_free_text"] == 1  # the near-unique note column


def test_high_cardinality_categorical_switches_to_frequency_no_dimensionality_blowup():
    """21 unique categories (one past the one-hot ceiling) must switch to
    frequency encoding — contributing exactly 1 output dim, not 21 — so a
    high-cardinality column can never make the feature matrix balloon."""
    categories = [f"category_{i}" for i in range(21)]
    matrix = [[float(i), categories[i % 21]] for i in range(105)]  # each category x5
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    summary = body["encoding_summary"]
    assert summary["encoded_categorical_columns"] == 1
    assert summary["encoded_dims"] == 1  # frequency: 1 dim, not 21


def test_all_columns_junk_falls_through_to_existing_422_feature_matrix_guardrail():
    """Every column is unclassifiable free text -> vectorize_matrix returns
    a zero-column matrix -> this must hit the *existing* zero-column 422
    from the stability sprint, not a new/different error path — confirming
    that guardrail was not weakened."""
    matrix = [[f"unique log line {i}", f"another unique value {i}"] for i in range(25)]
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "empty_or_invalid_payload"
    assert body["stage"] == "feature_matrix"


def test_already_numeric_matrix_takes_unaffected_fast_path():
    """Non-regression: a fully numeric matrix with no encoding_summary sent
    must behave exactly as before this sprint — encoding_summary stays
    null, vectorize_matrix is never invoked for it."""
    matrix = [[1.0, 2.0, 3.0]] * 16
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    assert response.json()["encoding_summary"] is None


def test_ragged_non_numeric_rows_still_422_ingestion():
    """The ragged-row guard applies before any classification/encoding is
    attempted, regardless of cell type."""
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": [["a", "b", "c"], ["d", "e"]]},
    )
    assert response.status_code == 422
    body = response.json()
    assert body["stage"] == "ingestion"
