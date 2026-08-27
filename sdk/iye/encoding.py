"""
iye.encoding — categorical/free-text column classification and encoding for
ingestion paths that bypass the browser.

frontend/src/canvas/upload/parseMatrix.ts already solves this problem for
browser-dropped CSV/JSON files: non-numeric columns are classified by
cardinality and encoded (one-hot or frequency) rather than dropped, with
only near-unique free text excluded. That client-side encoder is the
system of record and is NOT duplicated wholesale here — this module exists
only for the two ingestion paths that have no browser in the loop and so
never pass through parseMatrix.ts at all: a direct REST call to
POST /api/canvas/vectors with a raw `matrix` (see backend/app/api/main.py),
and `iye.show()` called straight from a Python script.

Kept numerically identical to parseMatrix.ts's classify/encode logic (same
cardinality thresholds, same one-hot/frequency formulas) so a categorical
column produces the same shape of result regardless of which path ingested
it — see docs/idealization_report.md, 2026-07-28 sprint.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from numpy.typing import NDArray

# ─── Constants (mirror parseMatrix.ts exactly) ────────────────────────────────

#: <= this many distinct values -> one-hot encoded.
ONEHOT_MAX_CARDINALITY = 20
#: Between ONEHOT_MAX_CARDINALITY and this -> frequency encoded. Above -> free text.
FREQUENCY_MAX_CARDINALITY = 1000

_FREETEXT_RATIO_MIN_ROWS = 20
_FREETEXT_UNIQUE_RATIO = 0.9

ColumnKind = Literal["numeric", "onehot", "frequency", "freetext"]


class RaggedMatrixError(ValueError):
    """Raised when input rows don't all have the same length."""


class NonFiniteValueError(RaggedMatrixError):
    """Raised when a column is syntactically all-numeric (every cell parses
    as a float) but at least one cell is non-finite (NaN/Infinity, or a
    literal like "1e400" that overflows float range). Deliberately a
    *separate* case from genuine categorical/free-text data: silently
    downgrading a corrupted numeric column to one-hot/frequency encoding
    (the pre-2026-08-27 behavior) hid the corruption instead of surfacing
    it. Subclasses RaggedMatrixError (itself a ValueError) so every
    existing `except RaggedMatrixError` call site — main.py's ingestion
    handler in particular — already catches this as a structured 422
    without needing its own new except clause."""


# ─── Shared helpers (mirror parseMatrix.ts's isFiniteNumberString / zScoreNormalize) ──


def _is_finite_number_string(s: str) -> bool:
    s = s.strip()
    if s == "":
        return False
    try:
        return math.isfinite(float(s))
    except ValueError:
        return False


def _parses_as_number(s: str) -> bool:
    """True iff s is syntactically a float — finite or not (inf/nan/an
    overflowing literal like "1e400" all parse successfully; only used to
    distinguish "this is corrupted numeric data" from "this is genuinely
    categorical/free-text data" in the classification step below."""
    s = s.strip()
    if s == "":
        return False
    try:
        float(s)
        return True
    except ValueError:
        return False


def _cell_to_str(v: Any) -> str:
    """Mirrors parseMatrix.ts's valueToCell: bools become 'true'/'false'
    strings (so a boolean column is classified/encoded as categorical, not
    silently cast to 0.0/1.0), None/null becomes an empty (freetext-neutral)
    cell, everything else via str()."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _zscore(values: list[float]) -> list[float]:
    """numpy-backed rather than pure-Python summation: a pure-Python
    `sum((v - mean) ** 2 ...)` raises an uncaught OverflowError once a
    value's square exceeds ~1.8e308 (real-world reachable — e.g. any
    column with values around 1e200), which used to propagate out of
    vectorize_matrix as an unhandled 500. numpy's float64 arithmetic
    doesn't raise on overflow; it produces inf/nan instead, which we
    explicitly check for and reject below rather than silently returning
    a poisoned z-score to every downstream consumer."""
    n = len(values)
    if n == 0:
        return values
    arr = np.asarray(values, dtype=np.float64)
    # Squaring anything past ~1.34e154 overflows float64 range during
    # variance computation, even though every individual value here is
    # itself perfectly finite (each already passed _is_finite_number_string
    # to get this far). Verified this is reachable, not theoretical: a
    # column of [1e200, 2e200, 3e200, 4.0] doesn't raise anything and
    # doesn't produce inf/nan either — mean and std both silently overflow
    # to inf, and (finite - inf) / inf silently evaluates to +/-0.0 for
    # every row, which passes an isfinite() check while being numeric
    # garbage (every point collapses to the same fake "zero deviation").
    # Caught here, before that can happen, rather than after.
    if np.any(np.abs(arr) > 1e150):
        raise NonFiniteValueError(
            "column values are too large in magnitude to normalize "
            "without numeric overflow during variance computation"
        )
    std = arr.std()
    if std == 0:
        return [0.0] * n
    result = (arr - arr.mean()) / std
    if not np.all(np.isfinite(result)):
        raise NonFiniteValueError(
            "column values are too large to normalize without numeric "
            "overflow (z-score computation produced a non-finite result)"
        )
    return result.tolist()


# ─── Categorical classification & encoding ─────────────────────────────────────


def _classify_non_numeric_column(values: list[str]) -> ColumnKind:
    """Cardinality-based classification for a column already known not to be
    numeric. Near-unique columns (almost every value distinct) are treated as
    free text and skipped — but only once there are enough rows to make that
    ratio meaningful; small samples fall back to the absolute cutoffs alone."""
    non_empty = [v.strip() for v in values if v.strip() != ""]
    unique_count = len(set(non_empty))
    row_count = len(values)

    if unique_count == 0:
        return "freetext"
    if unique_count > FREQUENCY_MAX_CARDINALITY:
        return "freetext"
    if row_count >= _FREETEXT_RATIO_MIN_ROWS and unique_count / row_count > _FREETEXT_UNIQUE_RATIO:
        return "freetext"
    if unique_count <= ONEHOT_MAX_CARDINALITY:
        return "onehot"
    return "frequency"


def _encode_onehot(values: list[str]) -> tuple[list[list[float]], list[str]]:
    """Stable sorted-category map (deterministic — no hashing, no seed).
    Block-scaled by 1/sqrt(categoryCount) so this column's *total*
    contribution to Euclidean distance (summed across its expanded dims) is
    comparable to a single unit-variance dimension, not N times larger
    merely because it expanded into N one-hot columns."""
    trimmed = [v.strip() for v in values]
    categories = sorted({v for v in trimmed if v != ""})
    n = len(categories)
    scale = 1.0 / math.sqrt(n) if n > 0 else 1.0
    index = {c: i for i, c in enumerate(categories)}
    rows: list[list[float]] = []
    for v in trimmed:
        row = [0.0] * n
        idx = index.get(v)
        if idx is not None:
            row[idx] = scale
        rows.append(row)
    return rows, categories


def _encode_frequency(values: list[str]) -> list[float]:
    """Frequency (proportion of rows sharing this value), then z-score
    normalized like any other single numeric-derived column. Deterministic —
    a pure function of the data, no hashing/seed involved."""
    trimmed = [v.strip() for v in values]
    counts: dict[str, int] = {}
    for v in trimmed:
        if v == "":
            continue
        counts[v] = counts.get(v, 0) + 1
    total = sum(1 for v in trimmed if v != "") or 1
    raw = [0.0 if v == "" else counts.get(v, 0) / total for v in trimmed]
    return _zscore(raw)


# ─── Response contract ─────────────────────────────────────────────────────────


@dataclass
class EncodedColumnInfo:
    name: str
    method: Literal["onehot", "frequency"]
    output_dims: int
    categories: list[str] | None = None


@dataclass
class EncodingSummary:
    total_columns: int
    numeric_columns: int
    encoded_categorical_columns: int
    encoded_dims: int
    skipped_free_text: int
    columns: list[EncodedColumnInfo] = field(default_factory=list)
    #: One original-field name per FINAL output matrix column (2026-07-31
    #: sprint) — a one-hot-expanded field's N output columns all repeat
    #: that field's name; a 'freetext' column contributes none (it produced
    #: no output columns at all). Used to attribute an anomaly back to the
    #: human-readable field that actually drove it, not an opaque matrix
    #: column index — see iye.compute_feature_attributions.
    expanded_column_names: list[str] = field(default_factory=list)

    def to_wire_dict(self) -> dict[str, int]:
        """Aggregate-only shape matching the existing encoding_summary wire
        contract (backend/app/api/main.py's EncodingSummary Pydantic model,
        established 2026-07-12 sprint) — per-column detail (categories,
        method) is intentionally not part of that contract."""
        return {
            "total_columns": self.total_columns,
            "numeric_columns": self.numeric_columns,
            "encoded_categorical_columns": self.encoded_categorical_columns,
            "encoded_dims": self.encoded_dims,
            "skipped_free_text": self.skipped_free_text,
        }


# ─── Orchestrator (mirrors parseMatrix.ts's buildFeatureMatrix) ────────────────


def vectorize_matrix(
    raw_rows: list[list[Any]],
    column_names: list[str] | None = None,
) -> tuple[NDArray[np.float64], EncodingSummary]:
    """
    Classify and encode a raw (possibly mixed numeric/categorical/free-text)
    matrix into a purely numeric feature matrix, mirroring
    frontend/src/canvas/upload/parseMatrix.ts's buildFeatureMatrix so
    non-browser callers (direct REST API, iye.show()) get the same
    auto-encoding behavior a browser-dropped CSV/JSON file already gets.

    Note on the frontend's 'offer' outcome (zero numeric columns, but
    encodable categorical structure found): the browser path requires
    explicit user confirmation before proceeding, because a human is in the
    loop to click confirm. There is no human in the loop for a direct API
    call or an `iye.show()` script — so that case is treated as an
    automatic accept here, not a rejection: it still counts as "usable
    data" (this function only returns a zero-column result, which the
    caller then rejects via the *existing* empty/zero-size guardrails, when
    literally every column is unclassifiable free text).

    Args:
        raw_rows: row-major raw cells — every row must have the same length.
        column_names: optional per-column names for EncodedColumnInfo; when
            omitted, positional names ("col_0", "col_1", ...) are used, same
            fallback as parseMatrix.ts's headerless-CSV case.

    Returns:
        (matrix, summary) — matrix has shape (len(raw_rows), dim), where dim
        may be 0 if every column was excluded as free text (the caller's
        existing zero-column check handles that case).

    Raises:
        RaggedMatrixError: if raw_rows is empty, or rows don't all have the
        same length.
    """
    if not raw_rows:
        raise RaggedMatrixError("matrix has no rows")

    row_count = len(raw_rows)
    total_columns = len(raw_rows[0])
    for row in raw_rows:
        if len(row) != total_columns:
            raise RaggedMatrixError(
                f"'matrix' rows must all have the same length "
                f"(expected {total_columns}, got {len(row)})"
            )

    if column_names is None or len(column_names) != total_columns:
        # Missing, or the wrong length to safely index against this
        # matrix's actual column count — degrade to positional defaults
        # rather than crash or misalign names to the wrong columns.
        column_names = [f"col_{i}" for i in range(total_columns)]
    else:
        # Sanitize individual malformed entries (empty/whitespace-only)
        # without discarding the otherwise-valid names around them.
        column_names = [
            name if name and name.strip() else f"col_{i}" for i, name in enumerate(column_names)
        ]

    column_cells: list[list[str]] = [
        [_cell_to_str(raw_rows[r][c]) for r in range(row_count)] for c in range(total_columns)
    ]

    kinds: list[ColumnKind] = []
    for cells in column_cells:
        if all(_is_finite_number_string(v) for v in cells):
            kinds.append("numeric")
        elif all(_parses_as_number(v) for v in cells):
            # Every cell is syntactically a number, so this is corrupted
            # numeric data (NaN/Infinity/overflow), not categorical data —
            # raise instead of silently one-hot/frequency-encoding numbers
            # as opaque categories (2026-08-27 sprint; see NonFiniteValueError).
            bad = next(v for v in cells if not _is_finite_number_string(v))
            raise NonFiniteValueError(
                f"column contains a non-finite numeric value ({bad!r}) — "
                "refusing to silently treat it as categorical data"
            )
        else:
            kinds.append(_classify_non_numeric_column(cells))

    numeric_columns = sum(1 for k in kinds if k == "numeric")
    encoded_categorical_columns = sum(1 for k in kinds if k in ("onehot", "frequency"))
    skipped_free_text = sum(1 for k in kinds if k == "freetext")
    # Only normalize raw numeric columns when they're actually sharing a
    # feature vector with encoded categoricals — a pure-numeric matrix's
    # values are handled by the caller's existing fast path instead and
    # never reach this function, but this mirrors parseMatrix.ts exactly.
    mixed_pathway = encoded_categorical_columns > 0

    output_columns: list[list[float]] = []
    encoded_column_infos: list[EncodedColumnInfo] = []
    expanded_column_names: list[str] = []

    for c in range(total_columns):
        kind = kinds[c]
        cells = column_cells[c]
        if kind == "numeric":
            raw = [float(v) for v in cells]
            output_columns.append(_zscore(raw) if mixed_pathway else raw)
            expanded_column_names.append(column_names[c])
        elif kind == "onehot":
            rows, categories = _encode_onehot(cells)
            n = len(categories)
            for k in range(n):
                output_columns.append([row[k] for row in rows])
                expanded_column_names.append(column_names[c])
            encoded_column_infos.append(
                EncodedColumnInfo(name=column_names[c], method="onehot", categories=categories, output_dims=n)
            )
        elif kind == "frequency":
            output_columns.append(_encode_frequency(cells))
            expanded_column_names.append(column_names[c])
            encoded_column_infos.append(
                EncodedColumnInfo(name=column_names[c], method="frequency", output_dims=1)
            )
        # 'freetext' columns contribute nothing — no output column, no name.

    dim = len(output_columns)
    matrix = np.zeros((row_count, dim), dtype=np.float64)
    for j, col in enumerate(output_columns):
        matrix[:, j] = col

    encoded_dims = sum(info.output_dims for info in encoded_column_infos)

    summary = EncodingSummary(
        total_columns=total_columns,
        numeric_columns=numeric_columns,
        encoded_categorical_columns=encoded_categorical_columns,
        encoded_dims=encoded_dims,
        skipped_free_text=skipped_free_text,
        columns=encoded_column_infos,
        expanded_column_names=expanded_column_names,
    )
    return matrix, summary


def is_fully_numeric(raw_rows: list[list[Any]]) -> bool:
    """True iff every cell is already a real number (bool excluded — see
    _cell_to_str) — the fast path that skips this module entirely and
    behaves exactly as before it existed."""
    return all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for row in raw_rows for v in row
    )
