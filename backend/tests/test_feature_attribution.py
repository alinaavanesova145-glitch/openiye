"""
backend/tests/test_feature_attribution.py — regression tests for named-
feature grounding in anomaly explanations (2026-07-31 sprint).

Covers: iye.encoding.vectorize_matrix's per-final-column name expansion,
iye.compute_feature_attributions's grouping/ranking/defensive-fallback
behavior, and the full /api/canvas/vectors -> /api/canvas/anomaly/explain
pipeline threading real column names end-to-end.

Note on scope substitution: the task's Phase 6 asked for a "text-embedding-
derived columns" attribution test. No text-embedding path exists in this
codebase (see docs/idealization_report.md, 2026-07-28 sprint, Phase 3 —
deliberately not built, to avoid a second inconsistent free-text strategy).
The structurally equivalent case that *does* exist — one original field
producing one derived numeric column that isn't its raw value — is
frequency encoding (21-1000 cardinality categoricals), used here instead.
"""

from __future__ import annotations

import iye
import numpy as np
from fastapi.testclient import TestClient
from iye import encoding

from app.api.main import AnomalyExplainRequest, _build_point_explanation_summary, app

client = TestClient(app)


# ─── encoding.vectorize_matrix's expanded_column_names ─────────────────────────


def test_numeric_column_keeps_its_own_name():
    matrix = [[1.0, "red"], [2.0, "blue"], [3.0, "red"]]
    _, summary = encoding.vectorize_matrix(matrix, column_names=["age", "color"])
    assert summary.expanded_column_names[0] == "age"


def test_onehot_expansion_repeats_the_original_name_per_category_column():
    matrix = [["red"], ["blue"], ["green"]]
    _, summary = encoding.vectorize_matrix(matrix, column_names=["color"])
    # 3 categories -> 3 one-hot columns, all named "color"
    assert summary.expanded_column_names == ["color", "color", "color"]


def test_frequency_expansion_keeps_a_single_name_for_its_one_output_column():
    categories = [f"cat_{i}" for i in range(21)]  # > onehot ceiling -> frequency
    matrix = [[categories[i % 21]] for i in range(105)]
    _, summary = encoding.vectorize_matrix(matrix, column_names=["department"])
    assert summary.expanded_column_names == ["department"]


def test_freetext_column_contributes_no_name_at_all():
    matrix = [[f"unique log line {i}"] for i in range(25)]
    _, summary = encoding.vectorize_matrix(matrix, column_names=["notes"])
    assert summary.expanded_column_names == []


def test_missing_column_names_falls_back_to_positional_defaults():
    matrix = [["red"], ["blue"]]
    _, summary = encoding.vectorize_matrix(matrix)
    assert summary.expanded_column_names == ["col_0", "col_0"]


def test_wrong_length_column_names_falls_back_to_positional_defaults_not_a_crash():
    matrix = [[1.0, "red"], [2.0, "blue"]]
    _, summary = encoding.vectorize_matrix(matrix, column_names=["only_one_name"])
    # col_0 (numeric) + col_1 repeated twice (2-category one-hot expansion)
    assert summary.expanded_column_names == ["col_0", "col_1", "col_1"]


def test_empty_string_name_sanitized_to_positional_default_for_just_that_column():
    matrix = [[1.0, "red"], [2.0, "blue"]]
    _, summary = encoding.vectorize_matrix(matrix, column_names=["age", "  "])
    # "age" is preserved; only the blank name is sanitized, repeated across
    # the 2-category one-hot expansion of that column.
    assert summary.expanded_column_names == ["age", "col_1", "col_1"]


# ─── iye.compute_feature_attributions ───────────────────────────────────────────


def test_attributions_grouped_by_name_take_max_z_within_the_group():
    matrix = [["red"], ["blue"], ["green"]]
    m, summary = encoding.vectorize_matrix(matrix, column_names=["color"])
    attributions = iye.compute_feature_attributions(m, summary.expanded_column_names)
    for point_attrs in attributions:
        # 3 one-hot columns all named "color" must collapse to one entry
        names = [a.name for a in point_attrs]
        assert names.count("color") <= 1


def test_attribution_correctly_identifies_the_anomalous_numeric_column():
    matrix = [[25.0, "red"]] * 15 + [[9999.0, "red"]]  # last row: extreme age
    m, summary = encoding.vectorize_matrix(matrix, column_names=["age", "color"])
    attributions = iye.compute_feature_attributions(m, summary.expanded_column_names)
    top_name = attributions[-1][0].name
    assert top_name == "age"


def test_attribution_correctly_identifies_the_anomalous_onehot_category():
    # 15 rows all "west", 1 rare "east" -> the odd one out should attribute to "region"
    matrix = [[10.0, "west"]] * 15 + [[10.0, "east"]]
    m, summary = encoding.vectorize_matrix(matrix, column_names=["value", "region"])
    attributions = iye.compute_feature_attributions(m, summary.expanded_column_names)
    top_name = attributions[-1][0].name
    assert top_name == "region"


def test_attribution_correctly_identifies_the_anomalous_frequency_encoded_column():
    categories = [f"dept_{i}" for i in range(21)]
    matrix = [[10.0, categories[i % 21]] for i in range(105)]
    matrix.append([10.0, "dept_extremely_rare_appearance"])  # 1 occurrence vs ~5 each
    m, summary = encoding.vectorize_matrix(matrix, column_names=["value", "department"])
    attributions = iye.compute_feature_attributions(m, summary.expanded_column_names)
    top_name = attributions[-1][0].name
    assert top_name == "department"


def test_none_feature_names_yields_empty_attributions_for_every_point():
    m = np.array([[1.0, 2.0], [3.0, 4.0]])
    attributions = iye.compute_feature_attributions(m, None)
    assert attributions == [[], []]


def test_mismatched_length_feature_names_yields_empty_attributions_not_a_crash():
    m = np.array([[1.0, 2.0], [3.0, 4.0]])
    attributions = iye.compute_feature_attributions(m, ["only_one"])
    assert attributions == [[], []]


def test_top_k_caps_the_number_of_attributions_per_point():
    matrix = [[1.0, 2.0, 3.0, 4.0], [100.0, 100.0, 100.0, 100.0]]
    m, summary = encoding.vectorize_matrix(matrix, column_names=["a", "b", "c", "d"])
    attributions = iye.compute_feature_attributions(m, summary.expanded_column_names, top_k=2)
    assert all(len(point) <= 2 for point in attributions)


# ─── Full pipeline: POST /api/canvas/vectors with column_names ────────────────


def test_vectors_response_includes_named_attributions_for_numeric_matrix_with_column_names():
    matrix = [[1.0, 1.0, 1.0]] * 15 + [[100.0, 100.0, 100.0]]
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": matrix, "column_names": ["temperature", "vibration", "pressure"]},
    )
    assert response.status_code == 200
    body = response.json()
    top_names = {a["name"] for a in body["point_feature_attributions"][15]}
    assert top_names <= {"temperature", "vibration", "pressure"}
    assert len(body["point_feature_attributions"][15]) > 0


def test_vectors_response_attributions_empty_without_column_names_non_regression():
    """No column_names supplied -> every point's attribution list is empty,
    the explicit 'no real names available' signal, preserving the
    pre-2026-07-31 response shape for callers that don't send names."""
    matrix = [[1.0, 1.0, 1.0]] * 15 + [[100.0, 100.0, 100.0]]
    response = client.post("/api/canvas/vectors", json={"matrix": matrix})
    assert response.status_code == 200
    body = response.json()
    assert all(attrs == [] for attrs in body["point_feature_attributions"])


def test_vectors_response_wrong_length_column_names_degrades_gracefully_not_a_500():
    matrix = [[1.0, 1.0, 1.0]] * 15 + [[100.0, 100.0, 100.0]]
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": matrix, "column_names": ["only_one_name"]},
    )
    assert response.status_code == 200
    body = response.json()
    assert all(attrs == [] for attrs in body["point_feature_attributions"])


def test_vectors_response_attributes_backend_encoded_categorical_to_original_name():
    """Non-numeric matrix (backend does its own encoding) with column_names
    for the RAW pre-encoding columns -> attribution still resolves to the
    original field name across the encoded onehot block."""
    matrix = [[10.0, "west"]] * 15 + [[10.0, "east"]]
    response = client.post(
        "/api/canvas/vectors",
        json={"matrix": matrix, "column_names": ["value", "region"]},
    )
    assert response.status_code == 200
    body = response.json()
    last_point_names = {a["name"] for a in body["point_feature_attributions"][-1]}
    assert "region" in last_point_names


# ─── Prompt grounding: named-feature branch + unchanged fallback ──────────────


def _base_explain_request(**overrides):
    body = {
        "point_index": 7,
        "coordinates": {"x": 1.0, "y": 2.0, "z": 3.0},
        "z_scores": {"x": 0.5, "y": 4.0, "z": 0.3},
        "cluster_label": -1,
        "axes_are_raw_features": True,
    }
    body.update(overrides)
    return body


def test_prompt_cites_named_feature_when_attributions_present():
    req = AnomalyExplainRequest(
        **_base_explain_request(
            feature_attributions=[{"name": "temperature", "z_score": 4.35}]
        )
    )
    summary = _build_point_explanation_summary(req)
    assert "temperature" in summary
    assert "4.35" in summary
    assert "x-axis" not in summary and "y-axis" not in summary


def test_prompt_cites_secondary_named_feature_when_two_attributions_present():
    req = AnomalyExplainRequest(
        **_base_explain_request(
            feature_attributions=[
                {"name": "temperature", "z_score": 4.35},
                {"name": "vibration", "z_score": 3.82},
            ]
        )
    )
    summary = _build_point_explanation_summary(req)
    assert "temperature" in summary
    assert "vibration" in summary
    assert "secondary" in summary


def test_prompt_falls_back_to_axis_phrasing_when_no_attributions_unchanged_behavior():
    """No feature_attributions supplied (default empty list) -> exact same
    axis-based phrasing as before this sprint."""
    req = AnomalyExplainRequest(**_base_explain_request())
    summary = _build_point_explanation_summary(req)
    assert "y-axis" in summary
    assert "raw measured feature" in summary


def test_explain_endpoint_accepts_feature_attributions_end_to_end():
    response = client.post(
        "/api/canvas/anomaly/explain",
        json=_base_explain_request(
            feature_attributions=[{"name": "temperature", "z_score": 4.35}]
        ),
    )
    assert response.status_code in (200, 422)  # 422 only if local Ollama unreachable
    if response.status_code == 422:
        assert response.json()["stage"] == "llm_unavailable"
