"""
iye — Python SDK entry point for the IYE 3D structural data anomaly engine.

Provides the public API:
    iye.show(data, axis_mapping=None)

Internally orchestrates:
    1. Dimensionality reduction (UMAP or zero-pad pass-through)
    2. Density-based clustering (HDBSCAN)
    3. Statistical anomaly detection (absolute Z-scores, 2.5σ threshold)
    4. Non-blocking WebSocket frame broadcast via StreamHub
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
import requests
from datetime import datetime, timezone
from typing import Any, Optional, Dict

import numpy as np
from numpy.typing import NDArray

from .server import Coordinate3D, StreamHub, VectorFramePayload, get_hub

logger = logging.getLogger("iye")

# ─── Configuration ─────────────────────────────────────────────────────────────

_ZSCORE_THRESHOLD: float = 2.5
_HDBSCAN_MIN_CLUSTER_SIZE: int = 5
_UMAP_COMPONENTS: int = 3
_UMAP_RANDOM_STATE: int = 42

# Minimum sample count required before attempting a real UMAP reduction.
# Empirically (see docs/idealization_report.md, 2026-07-16 sprint, Phase 1
# diagnosis), UMAP's failure mode for small n is *non-monotonic* and
# scipy/umap-internals-dependent: n_samples=1 succeeds, 2-4 raise (a bare
# `.max()` on a zero-size internal sparse-graph array, or a scipy.linalg.eigh
# "k >= N" TypeError depending on n), then 5+ succeeds again. That boundary
# isn't a stable contract to characterize precisely or test against long
# term. Rather than chase it, this reuses the same conservative "minimum
# meaningful sample count" already defined for HDBSCAN's min_cluster_size —
# confirmed safe for both in the same diagnosis pass.
MIN_SAMPLES_FOR_REDUCTION: int = _HDBSCAN_MIN_CLUSTER_SIZE

# ─── Dimensionality Reduction ─────────────────────────────────────────────────


def reduce_to_3d(data: NDArray[np.floating[Any]]) -> NDArray[np.float64]:
    """
    Safely reduce high-dimensional data to 3 components.

    - If features <= 3: zero-pad to exactly 3 columns (raw pass-through).
    - If features > 3 and n_samples >= MIN_SAMPLES_FOR_REDUCTION: apply UMAP
      with n_components=3, random_state=42.
    - If features > 3 but n_samples < MIN_SAMPLES_FOR_REDUCTION: UMAP's
      spectral embedding is not safe at this sample count (see
      MIN_SAMPLES_FOR_REDUCTION) — fall back to truncating to the first 3
      columns instead of a real reduction. This is a crude, arbitrary
      fallback (no PCA/feature-selection, just positional truncation) and
      callers that care should check the sample count themselves beforehand
      to surface that a fallback occurred (see
      backend/app/api/main.py's use of this same constant).

    Args:
        data: 2D array of shape (n_samples, n_features).

    Returns:
        2D array of shape (n_samples, 3).

    Raises:
        ValueError: if `data` isn't 2D, or has zero samples (n_samples == 0).
        Callers ingesting untrusted payloads should check for this rather
        than let it propagate — see backend/app/api/main.py's feature-matrix
        shape checks.
    """
    if data.ndim != 2:
        raise ValueError(
            f"reduce_to_3d expects a 2D array, got shape {data.shape}"
        )

    n_samples, n_features = data.shape

    if n_samples == 0:
        raise ValueError("reduce_to_3d requires at least 1 sample, got 0")

    if n_features == 3:
        return data.astype(np.float64, copy=True)

    if n_features < 3:
        # Zero-pad to 3 columns
        padded = np.zeros((n_samples, 3), dtype=np.float64)
        padded[:, :n_features] = data
        return padded

    if n_samples < MIN_SAMPLES_FOR_REDUCTION:
        # Too few samples for UMAP's spectral embedding to run safely —
        # truncate to the first 3 features instead of crashing.
        return data[:, :3].astype(np.float64, copy=True)

    # features > 3, enough samples → UMAP reduction
    import umap  # Lazy import for fast SDK load time

    reducer = umap.UMAP(
        n_components=_UMAP_COMPONENTS,
        random_state=_UMAP_RANDOM_STATE,
    )
    reduced: NDArray[np.float64] = reducer.fit_transform(data).astype(np.float64)
    return reduced


# ─── Clustering ────────────────────────────────────────────────────────────────


def cluster(coords: NDArray[np.float64]) -> NDArray[np.intp]:
    """
    Apply HDBSCAN density-based clustering to 3D coordinates.

    HDBSCAN itself raises for n_samples < 2 (0 samples: sklearn's own "at
    least 1 required"; exactly 1 sample: "k must be less than or equal to
    the number of training points" — there's no neighbor to define a
    distance to). 2-4 points already succeed and correctly return all-noise
    labels (below min_cluster_size). Fewer than 2 points is the same
    "nothing to cluster" case, just below HDBSCAN's own crash threshold
    instead of its min_cluster_size — so it gets the identical, well-defined
    answer HDBSCAN already gives for 2-4 points, without calling into
    HDBSCAN at all.

    Args:
        coords: 2D array of shape (n_samples, 3).

    Returns:
        1D integer array of cluster labels. -1 indicates noise.
    """
    if coords.shape[0] < 2:
        return np.full(coords.shape[0], -1, dtype=np.intp)

    import hdbscan  # Lazy import for fast SDK load time

    clusterer = hdbscan.HDBSCAN(min_cluster_size=_HDBSCAN_MIN_CLUSTER_SIZE)
    labels: NDArray[np.intp] = clusterer.fit_predict(coords)
    return labels


# ─── Anomaly Detection ────────────────────────────────────────────────────────


def compute_z_scores(coords: NDArray[np.float64]) -> NDArray[np.float64]:
    """
    Per-point, per-axis absolute Z-score magnitude — the same computation
    detect_anomalies uses internally to decide anomaly_indices, extracted so
    a caller can also get the *magnitudes* (not just the pass/fail
    threshold decision). Used by ingest_and_broadcast to populate the
    response's point_z_scores, which grounds both severity-based visual
    encoding and the per-point narrative explain endpoint (2026-07-29
    sprint) — see backend/app/api/main.py.

    Args:
        coords: 2D array of shape (n_samples, 3).

    Returns:
        2D array of shape (n_samples, 3) — absolute Z-score per axis.
    """
    means = np.mean(coords, axis=0)
    stds = np.std(coords, axis=0)
    # Guard against zero-std axes (constant columns) — treat as non-anomalous
    safe_stds = np.where(stds > 0.0, stds, 1.0)
    result: NDArray[np.float64] = np.abs((coords - means) / safe_stds)
    return result


def detect_anomalies(
    coords: NDArray[np.float64],
) -> tuple[list[int], str]:
    """
    Detect anomalous points using absolute Z-scores per axis.

    A point is flagged as anomalous if *any* of its 3 coordinate values
    exceeds the 2.5σ threshold (absolute Z-score).

    Args:
        coords: 2D array of shape (n_samples, 3).

    Returns:
        Tuple of (anomaly_indices, explanation_text).
    """
    axis_labels = ["x", "y", "z"]
    z_scores = compute_z_scores(coords)
    # A point is anomalous if any axis exceeds threshold
    anomalous_mask: NDArray[np.bool_] = np.any(
        z_scores > _ZSCORE_THRESHOLD, axis=1
    )
    anomaly_indices: list[int] = np.flatnonzero(anomalous_mask).tolist()

    # Build plain-English explanation
    if len(anomaly_indices) == 0:
        explanation = (
            f"all {coords.shape[0]} points are within nominal bounds "
            f"(< {_ZSCORE_THRESHOLD}σ on all axes)."
        )
    else:
        # Identify which axes triggered for the first few anomalous points
        detail_parts: list[str] = []
        for idx in anomaly_indices[:5]:
            triggered_axes = [
                axis_labels[a]
                for a in range(3)
                if z_scores[idx, a] > _ZSCORE_THRESHOLD
            ]
            max_z = float(np.max(z_scores[idx]))
            detail_parts.append(
                f"point {idx} deviates on {','.join(triggered_axes)} "
                f"(peak z={max_z:.2f})"
            )
        suffix = ""
        if len(anomaly_indices) > 5:
            suffix = f" (+{len(anomaly_indices) - 5} more)"
        explanation = (
            f"{len(anomaly_indices)}/{coords.shape[0]} points exceed "
            f"{_ZSCORE_THRESHOLD}σ threshold. {'; '.join(detail_parts)}{suffix}"
        )

    return anomaly_indices, explanation


# ─── Public API ────────────────────────────────────────────────────────────────

_CANDIDATE_PORTS = [8000, 8050, 8222]
_cached_active_port = None


def _post_to_active_backend(
    path: str,
    payload: Dict[str, Any],
    timeout: float = 2.0,
    accept_error_responses: bool = False,
) -> Optional["requests.Response"]:
    """Shared port-scanning POST logic — tries the cached working port
    first (if any), then each candidate in turn, caching whichever one
    responds for next time. Extracted from show() (2026-07-29 sprint) so
    explain_anomaly() doesn't duplicate the same connection dance.

    `accept_error_responses` controls what counts as "found the backend on
    this port, stop scanning": show()'s fire-and-forget ingest only ever
    cared about a clean 200 (unchanged default, exact pre-existing
    behavior); explain_anomaly() needs a reached-but-rejected 4xx response
    too — its structured `detail`/`stage` body is meaningful and worth
    returning to the caller, not indistinguishable from "nothing is
    listening on this port at all".

    Returns the response (whatever its status, once accepted), or None if
    every candidate port refused the connection outright.
    """
    global _cached_active_port

    ports = []
    if _cached_active_port is not None:
        ports.append(_cached_active_port)
    ports.extend([p for p in _CANDIDATE_PORTS if p != _cached_active_port])

    for port in ports:
        url = f"http://127.0.0.1:{port}{path}"
        try:
            response = requests.post(url, json=payload, timeout=timeout)
            if response.status_code == 200 or accept_error_responses:
                _cached_active_port = port
                return response
        except Exception:
            continue
    return None


def _as_row_list(matrix: Any) -> Optional[list]:
    """Best-effort coercion of `matrix` to a list-of-rows (each row itself a
    list) for iye.encoding.vectorize_matrix, without assuming any particular
    input container (plain nested lists/tuples, or a 2D numpy object array).
    Returns None when `matrix` isn't row/column-shaped — e.g. a flat 1D list
    of non-numeric values has no column structure to classify against."""
    try:
        rows = list(matrix)
    except TypeError:
        return None
    if not rows:
        return None
    normalized = []
    for row in rows:
        if isinstance(row, str) or not hasattr(row, "__iter__"):
            return None
        normalized.append(list(row))
    return normalized


def show(matrix: Any) -> None:
    """
    Ingest matrix metrics data, format it, scan local ports to detect the active
    IYE server, and POST it to /api/canvas/vectors.

    Non-numeric cells (categorical/text columns) are auto-encoded via
    iye.encoding — the same classify-and-encode pass the browser's
    parseMatrix.ts already runs on a dropped file, so a script calling
    show() with mixed data gets equivalent treatment instead of a silent
    failure (2026-07-28 sprint). Only attempted for row/column-shaped input
    (a list of lists/tuples) — a flat 1D list of non-numeric values has no
    column structure to classify against and is still rejected, logged.
    """
    global _cached_active_port

    import numpy as np
    encoding_summary_payload: Optional[Dict[str, int]] = None
    try:
        arr = np.asarray(matrix, dtype=np.float64)
    except (ValueError, TypeError) as e:
        rows = _as_row_list(matrix)
        if rows is None:
            logger.error(f"Failed to parse matrix input: {e}")
            return
        try:
            from . import encoding as iye_encoding
            encoded, summary = iye_encoding.vectorize_matrix(rows)
        except Exception as encode_err:
            logger.error(f"Failed to auto-encode non-numeric matrix input: {encode_err}")
            return
        arr = encoded
        encoding_summary_payload = summary.to_wire_dict()

    if arr.ndim == 1:
        # Default to 6D if divisible by 6, else 3, else length
        if len(arr) % 6 == 0:
            dim = 6
        elif len(arr) % 3 == 0:
            dim = 3
        else:
            dim = len(arr)
        flat_data = arr.tolist()
    elif arr.ndim == 2:
        dim = arr.shape[1]
        flat_data = arr.flatten().tolist()
    else:
        logger.error(f"show() expects 1D or 2D matrix, got shape {arr.shape}")
        return

    payload: Dict[str, Any] = {
        "data": flat_data,
        "dim": dim
    }
    if encoding_summary_payload is not None:
        payload["encoding_summary"] = encoding_summary_payload

    response = _post_to_active_backend("/api/canvas/vectors", payload)
    if response is not None:
        logger.info(f"Successfully streamed matrix data to active IYE engine on port {_cached_active_port}")
    else:
        logger.error(f"Failed to stream matrix data. IYE engine offline on ports {_CANDIDATE_PORTS}")


def explain_anomaly(
    point_index: int,
    coordinates: Dict[str, float],
    z_scores: Dict[str, float],
    cluster_label: int,
    axes_are_raw_features: bool = True,
    timeout: float = 30.0,
) -> Optional[str]:
    """
    Request an on-demand narrative explanation for a specific point from a
    headless Python workflow — the SDK-side counterpart to a browser user
    clicking an anomaly beacon (2026-07-29 sprint). Mirrors how encoding was
    wired into both the browser and iye.show() the prior sprint: same
    backend endpoint (POST /api/canvas/anomaly/explain), same port-scanning
    connection logic as show().

    Args:
        point_index: index of the point within its frame (for display only).
        coordinates: {"x": ..., "y": ..., "z": ...} — this point's 3D position.
        z_scores: {"x": ..., "y": ..., "z": ...} — this point's per-axis
            absolute Z-score magnitude (see iye.compute_z_scores).
        cluster_label: this point's HDBSCAN cluster label (-1 = noise).
        axes_are_raw_features: whether x/y/z are literal source features
            (true for <=3-feature data or the small-n truncation fallback)
            or an abstract UMAP embedding (false) — keeps the narrative
            honest about what a deviating axis actually means.
        timeout: request timeout in seconds. Defaults to 30s (not the 2s
            show() uses for its fire-and-forget ingest) because Ollama
            generation empirically takes ~15-22s and a script calling this
            is, by definition, waiting on the answer.

    Returns:
        The explanation string, or None if the backend was unreachable or
        returned a structured error (logged either way).
    """
    payload = {
        "point_index": point_index,
        "coordinates": coordinates,
        "z_scores": z_scores,
        "cluster_label": cluster_label,
        "axes_are_raw_features": axes_are_raw_features,
    }
    response = _post_to_active_backend(
        "/api/canvas/anomaly/explain", payload, timeout=timeout, accept_error_responses=True
    )
    if response is None:
        logger.error(f"Failed to get anomaly explanation. IYE engine offline on ports {_CANDIDATE_PORTS}")
        return None
    if response.status_code != 200:
        logger.error(f"Anomaly explanation request rejected: {response.text}")
        return None
    return response.json().get("explanation")


__all__ = [
    "show",
    "reduce_to_3d",
    "cluster",
    "detect_anomalies",
    "compute_z_scores",
    "explain_anomaly",
    "MIN_SAMPLES_FOR_REDUCTION",
]
