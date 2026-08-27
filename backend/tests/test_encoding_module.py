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


# ─── Non-finite numeric values (2026-08-27 sprint) ──────────────────────────
#
# Before this sprint, a column where every cell parsed as a number but one
# was non-finite (an overflowing literal like "1e400", or a magnitude that
# overflows during _zscore's variance computation) was silently downgraded
# to categorical one-hot/frequency encoding, with no warning anywhere. Now
# it raises NonFiniteValueError (a RaggedMatrixError subclass, so every
# existing `except encoding.RaggedMatrixError` call site already handles
# it as a structured error) instead of corrupting the column silently.


def test_single_overflowing_literal_raises_instead_of_reclassifying_column():
    with pytest.raises(encoding.NonFiniteValueError):
        encoding.vectorize_matrix([[1.0], [2.0], [3.0], [1e400]])


def test_non_finite_value_error_is_a_ragged_matrix_error():
    """So callers that only catch RaggedMatrixError (e.g. main.py's
    ingestion handler) already handle this new case for free."""
    assert issubclass(encoding.NonFiniteValueError, encoding.RaggedMatrixError)


def test_extreme_magnitude_column_mixed_with_categorical_raises_cleanly():
    """Each individual value (~1e200) is itself finite, but squaring it
    during _zscore's variance computation overflows float64 range —
    previously an uncaught OverflowError (propagated as a raw unhandled
    500 through the backend); now a clean NonFiniteValueError."""
    with pytest.raises(encoding.NonFiniteValueError):
        encoding.vectorize_matrix(
            [[1e200, "red"], [2e200, "blue"], [3e200, "red"], [4.0, "green"]]
        )


def test_genuine_categorical_column_containing_the_word_nan_is_unaffected():
    """A real categorical value that happens to be the text "nan" among
    otherwise-ordinary words must NOT trip the non-finite guard — only a
    column where *every* cell is syntactically numeric is affected."""
    m, summary = encoding.vectorize_matrix(
        [[1.0, "nan"], [2.0, "apple"], [3.0, "banana"], [4.0, "cherry"]]
    )
    assert m.shape == (4, 5)
    assert summary.numeric_columns == 1
    assert summary.encoded_categorical_columns == 1


def test_ordinary_mixed_numeric_and_categorical_still_works():
    m, summary = encoding.vectorize_matrix(
        [[1.0, "red"], [2.0, "blue"], [3.0, "red"], [4.0, "green"]]
    )
    assert m.shape == (4, 4)
    assert summary.numeric_columns == 1


def test_zscore_rejects_extreme_magnitude_before_silently_returning_zeros():
    """Direct unit test of the _zscore helper itself: without the magnitude
    guard, mean/std both silently overflow to inf and (finite - inf) / inf
    evaluates to +/-0.0 for every element — a finite-looking result that is
    actually numeric garbage (every point reads as "zero deviation").
    Confirms that failure mode is caught before it can happen."""
    with pytest.raises(encoding.NonFiniteValueError):
        encoding._zscore([1e200, 2e200, 3e200, 4.0])


def test_zscore_normal_values_unaffected():
    result = encoding._zscore([1.0, 2.0, 3.0, 4.0])
    assert all(math.isfinite(v) for v in result)
    assert np.isclose(sum(result), 0.0, atol=1e-9)


# ─── Packaging: iye must be importable without fastapi (2026-08-27 sprint) ──


def test_import_iye_does_not_require_fastapi():
    """sdk/iye/__init__.py used to unconditionally `from .server import ...`
    at module load, and iye/server.py imports fastapi unconditionally --
    so `import iye` failed in a clean env with only sdk/setup.py's declared
    dependencies (fastapi was never one of them), even for a pure client
    script that only ever calls iye.show()/iye.explain_anomaly() and has
    no reason to need fastapi at all. That unused import (nothing in
    __init__.py actually referenced Coordinate3D/StreamHub/VectorFramePayload/
    get_hub) is now removed. This test simulates fastapi being absent by
    poisoning sys.modules in a fresh subprocess, so it fails the way a real
    fastapi-less install would if the regression reappears."""
    import os
    import subprocess
    import sys as _sys

    sdk_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "sdk"))
    script = (
        "import sys; sys.modules['fastapi'] = None; "
        f"sys.path.insert(0, {sdk_path!r}); "
        "import iye; assert callable(iye.show); print('OK')"
    )
    result = subprocess.run([_sys.executable, "-c", script], capture_output=True, text=True)
    assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
    assert "OK" in result.stdout
