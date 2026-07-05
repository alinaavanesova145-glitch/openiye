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

# ─── Dimensionality Reduction ─────────────────────────────────────────────────


def reduce_to_3d(data: NDArray[np.floating[Any]]) -> NDArray[np.float64]:
    """
    Safely reduce high-dimensional data to 3 components.

    - If features <= 3: zero-pad to exactly 3 columns (raw pass-through).
    - If features > 3:  apply UMAP with n_components=3, random_state=42.

    Args:
        data: 2D array of shape (n_samples, n_features).

    Returns:
        2D array of shape (n_samples, 3).
    """
    if data.ndim != 2:
        raise ValueError(
            f"reduce_to_3d expects a 2D array, got shape {data.shape}"
        )

    n_samples, n_features = data.shape

    if n_features == 3:
        return data.astype(np.float64, copy=True)

    if n_features < 3:
        # Zero-pad to 3 columns
        padded = np.zeros((n_samples, 3), dtype=np.float64)
        padded[:, :n_features] = data
        return padded

    # features > 3 → UMAP reduction
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

    Args:
        coords: 2D array of shape (n_samples, 3).

    Returns:
        1D integer array of cluster labels. -1 indicates noise.
    """
    import hdbscan  # Lazy import for fast SDK load time

    clusterer = hdbscan.HDBSCAN(min_cluster_size=_HDBSCAN_MIN_CLUSTER_SIZE)
    labels: NDArray[np.intp] = clusterer.fit_predict(coords)
    return labels


# ─── Anomaly Detection ────────────────────────────────────────────────────────


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
    means = np.mean(coords, axis=0)
    stds = np.std(coords, axis=0)

    # Guard against zero-std axes (constant columns) — treat as non-anomalous
    safe_stds = np.where(stds > 0.0, stds, 1.0)

    z_scores = np.abs((coords - means) / safe_stds)
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

def show(matrix: Any) -> None:
    """
    Ingest matrix metrics data, format it, scan local ports to detect the active 
    IYE server, and POST it to /api/canvas/vectors.
    """
    global _cached_active_port

    import numpy as np
    try:
        arr = np.asarray(matrix, dtype=np.float64)
    except Exception as e:
        logger.error(f"Failed to parse matrix input: {e}")
        return

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

    payload = {
        "data": flat_data,
        "dim": dim
    }

    # Order ports trying the cached working port first
    ports = []
    if _cached_active_port is not None:
        ports.append(_cached_active_port)
    ports.extend([p for p in _CANDIDATE_PORTS if p != _cached_active_port])

    success = False
    for port in ports:
        url = f"http://127.0.0.1:{port}/api/canvas/vectors"
        try:
            response = requests.post(url, json=payload, timeout=2.0)
            if response.status_code == 200:
                _cached_active_port = port
                logger.info(f"Successfully streamed matrix data to active IYE engine on port {port}")
                success = True
                break
        except Exception:
            continue

    if not success:
        logger.error(f"Failed to stream matrix data. IYE engine offline on ports {_CANDIDATE_PORTS}")


__all__ = [
    "show",
    "reduce_to_3d",
    "cluster",
    "detect_anomalies",
]
