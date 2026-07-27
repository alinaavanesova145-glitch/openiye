"""
backend/tests/test_encoding_module.py — unit tests for iye.encoding
(2026-07-28 sprint).

iye.encoding is a Python port of frontend/src/canvas/upload/parseMatrix.ts's
column classification and encoding, used only by ingestion paths that have
no browser in the loop to run parseMatrix.ts itself (a direct REST call to
/api/canvas/vectors, or iye.show() from a script) — see
test_backend_vectorization.py for the endpoint-level integration tests.
These tests exercise the module directly: classification tier boundaries,
one-hot/frequency encoding math, and the ragged-row guard.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from iye import encoding

# ─── Column classification tier boundaries ─────────────────────────────────────


def test_low_cardinality_column_classified_onehot():
    """20 unique categories (the onehot ceiling), each repeated 5x so the
    near-unique ratio guard doesn't misfire."""
    categories = [f"cat_{i}" for i in range(encoding.ONEHOT_MAX_CARDINALITY)]
    values = categories * 5
    kind = encoding._classify_non_numeric_column(values)
    assert kind == "onehot"


def test_cardinality_just_above_onehot_ceiling_switches_to_frequency():
    """21 unique categories — one past the onehot ceiling — switches
    strategy to frequency encoding, confirming the cutoff is enforced."""
    categories = [f"cat_{i}" for i in range(encoding.ONEHOT_MAX_CARDINALITY + 1)]
    values = categories * 5
    kind = encoding._classify_non_numeric_column(values)
    assert kind == "frequency"


def test_cardinality_at_frequency_ceiling_still_frequency():
    categories = [f"cat_{i}" for i in range(encoding.FREQUENCY_MAX_CARDINALITY)]
    values = categories * 2
    kind = encoding._classify_non_numeric_column(values)
    assert kind == "frequency"


def test_cardinality_just_above_frequency_ceiling_is_freetext():
    """One past the frequency ceiling is excluded outright, regardless of
    repetition ratio — the absolute ceiling is checked before the
    near-unique ratio heuristic."""
    categories = [f"cat_{i}" for i in range(encoding.FREQUENCY_MAX_CARDINALITY + 1)]
    values = categories * 2
    kind = encoding._classify_non_numeric_column(values)
    assert kind == "freetext"


def test_near_unique_column_with_enough_rows_is_freetext():
    """25 rows, every value distinct — log-line-like free text, not a
    bounded category set — excluded rather than encoded."""
    values = [f"log line number {i} happened" for i in range(25)]
    kind = encoding._classify_non_numeric_column(values)
    assert kind == "freetext"


def test_small_sample_near_unique_column_falls_back_to_onehot():
    """Fewer than FREETEXT_RATIO_MIN_ROWS (20) rows — too small a sample to
    trust the near-unique ratio, so the absolute cardinality cutoff alone
    decides; 5 distinct values in 5 rows is still <= the onehot ceiling."""
    values = [f"val_{i}" for i in range(5)]
    kind = encoding._classify_non_numeric_column(values)
    assert kind == "onehot"


def test_all_empty_column_is_freetext():
    kind = encoding._classify_non_numeric_column(["", "", ""])
    assert kind == "freetext"


# ─── One-hot encoding ───────────────────────────────────────────────────────────


def test_onehot_scale_is_inverse_sqrt_of_category_count():
    rows, categories = encoding._encode_onehot(["red", "blue", "green"])
    assert categories == ["blue", "green", "red"]  # sorted
    scale = 1 / math.sqrt(3)
    assert rows[0] == pytest.approx([0.0, 0.0, scale])  # "red"
    assert rows[1] == pytest.approx([scale, 0.0, 0.0])  # "blue"
    assert rows[2] == pytest.approx([0.0, scale, 0.0])  # "green"


def test_onehot_empty_value_gets_all_zero_row():
    rows, categories = encoding._encode_onehot(["a", "", "b"])
    assert rows[1] == [0.0] * len(categories)


# ─── Frequency encoding ─────────────────────────────────────────────────────────


def test_frequency_encoding_is_zscore_of_value_proportions():
    values = ["a", "a", "a", "b"]
    result = encoding._encode_frequency(values)
    # raw proportions: a=0.75 (x3), b=0.25 (x1) -> z-scored
    assert result[0] == pytest.approx(result[1])
    assert result[0] == pytest.approx(result[2])
    assert result[0] != pytest.approx(result[3])


# ─── vectorize_matrix orchestration ─────────────────────────────────────────────


def test_pure_categorical_matrix_shape_and_summary():
    matrix = [["red", "small"], ["blue", "large"], ["red", "small"], ["green", "medium"]]
    m, summary = encoding.vectorize_matrix(matrix)
    assert m.shape == (4, 6)  # 3 colors + 3 sizes
    assert summary.to_wire_dict() == {
        "total_columns": 2,
        "numeric_columns": 0,
        "encoded_categorical_columns": 2,
        "encoded_dims": 6,
        "skipped_free_text": 0,
    }


def test_mixed_numeric_categorical_matrix_single_coherent_matrix():
    matrix = [[1.0, "red"], [2.0, "blue"], [3.0, "red"], [4.0, "green"]]
    m, summary = encoding.vectorize_matrix(matrix)
    assert m.shape == (4, 4)  # 1 numeric (z-scored) + 3 categories
    assert summary.numeric_columns == 1
    assert summary.encoded_categorical_columns == 1
    assert summary.encoded_dims == 3
    assert np.all(np.isfinite(m))


def test_freetext_column_excluded_not_crashing():
    matrix = [[float(i), f"unique log line {i}"] for i in range(25)]
    m, summary = encoding.vectorize_matrix(matrix)
    assert m.shape == (25, 1)  # only the numeric column survives
    assert summary.skipped_free_text == 1
    assert summary.numeric_columns == 1


def test_all_columns_freetext_yields_zero_dim_matrix_not_a_crash():
    """Every column excluded -> dim 0. The caller (ingest_and_broadcast)
    is responsible for turning that into the existing zero-column 422 —
    this module itself must not raise for it."""
    matrix = [[f"unique log line {i}", f"another unique value {i}"] for i in range(25)]
    m, summary = encoding.vectorize_matrix(matrix)
    assert m.shape == (25, 0)
    assert summary.skipped_free_text == 2


def test_ragged_rows_raise_ragged_matrix_error():
    with pytest.raises(encoding.RaggedMatrixError):
        encoding.vectorize_matrix([[1, 2, 3], [1, 2]])


def test_empty_matrix_raises_ragged_matrix_error():
    with pytest.raises(encoding.RaggedMatrixError):
        encoding.vectorize_matrix([])


def test_boolean_column_treated_as_categorical_not_raw_zero_one():
    """Mirrors parseMatrix.ts's valueToCell: booleans become 'true'/'false'
    strings and go through the same classify/encode path as any other
    categorical column, rather than being silently cast to 0.0/1.0."""
    matrix = [[True], [False], [True]]
    assert not encoding.is_fully_numeric(matrix)
    m, summary = encoding.vectorize_matrix(matrix)
    assert summary.encoded_categorical_columns == 1
    assert m.shape == (3, 2)  # one-hot over {"false", "true"}


# ─── is_fully_numeric fast-path detector ────────────────────────────────────────


def test_is_fully_numeric_true_for_plain_numbers():
    assert encoding.is_fully_numeric([[1, 2], [3.5, 4]])


def test_is_fully_numeric_false_for_any_string_cell():
    assert not encoding.is_fully_numeric([[1, "a"], [3, 4]])


def test_is_fully_numeric_false_for_bool_cell():
    assert not encoding.is_fully_numeric([[1, True]])
