"""
backend/app/api/temporal_engine.py — Stateful temporal feature engine.

Tracks a sliding window (deque, maxlen=50) of per-frame centroids and derives
velocity, acceleration, drift, and an EMA-smoothed composite anomaly score
across consecutive /api/canvas/vectors ingestions.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Deque, List, Optional

import numpy as np

WINDOW_MAXLEN = 50
EMA_ALPHA = 0.3
ZSCORE_CLAMP = 10.0

VELOCITY_SPIKE_THRESHOLD = 3.0
VELOCITY_THRESHOLD = 1.0
ACCELERATION_THRESHOLD = 1.5
DRIFT_THRESHOLD = 0.75


@dataclass
class TemporalMetrics:
    z_max: float
    z_per_dim: List[float]
    velocity: float
    acceleration: float
    drift_slope: float
    composite: float
    composite_smoothed: float
    regime: str
    window_fill: float
    dominant_dim: int

    def model_dump(self) -> dict:
        return {
            "z_max": self.z_max,
            "z_per_dim": self.z_per_dim,
            "velocity": self.velocity,
            "acceleration": self.acceleration,
            "drift_slope": self.drift_slope,
            "composite": self.composite,
            "composite_smoothed": self.composite_smoothed,
            "regime": self.regime,
            "window_fill": self.window_fill,
            "dominant_dim": self.dominant_dim,
        }


def _parse_timestamp(timestamp: str) -> float:
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return datetime.now().timestamp()


class TemporalEngine:
    """Stateful sliding-window feature engine for one logical vector stream."""

    def __init__(self, maxlen: int = WINDOW_MAXLEN) -> None:
        self._lock = threading.RLock()
        self._maxlen = maxlen
        self._centroids: Deque[np.ndarray] = deque(maxlen=maxlen)
        self._times: Deque[float] = deque(maxlen=maxlen)
        self._last_velocity: float = 0.0
        self._composite_smoothed: Optional[float] = None

    def process_frame(
        self,
        coordinates: np.ndarray,
        timestamp: str,
        anomaly_indices: List[int],
        cluster_labels: Optional[List[int]] = None,
    ) -> TemporalMetrics:
        """Fold one frame's coordinates into the sliding window and derive metrics."""
        with self._lock:
            n_points = coordinates.shape[0] if coordinates.size else 0

            # Centroid tracking excludes HDBSCAN noise (-1) so a handful of stray
            # outlier points can't drag the whole-frame velocity/drift signal.
            if cluster_labels is not None and n_points:
                labels_arr = np.asarray(cluster_labels)
                mask = labels_arr != -1
                clustered_coords = coordinates[mask] if mask.any() else coordinates
            else:
                clustered_coords = coordinates

            centroid = clustered_coords.mean(axis=0) if clustered_coords.shape[0] else np.zeros(3)
            now = _parse_timestamp(timestamp)

            # Velocity: centroid displacement per unit time since the previous frame.
            if self._centroids:
                dt = max(now - self._times[-1], 1e-6)
                displacement = float(np.linalg.norm(centroid - self._centroids[-1]))
                velocity = displacement / dt
            else:
                velocity = 0.0

            acceleration = velocity - self._last_velocity
            self._last_velocity = velocity

            self._centroids.append(centroid)
            self._times.append(now)

            # Drift: displacement from the rolling window's own baseline average.
            baseline = np.mean(np.stack(self._centroids), axis=0)
            drift_slope = float(np.linalg.norm(centroid - baseline))

            # Per-axis z-scores of this frame's own point cloud.
            if n_points > 1:
                means = coordinates.mean(axis=0)
                stds = coordinates.std(axis=0)
                safe_stds = np.where(stds > 0.0, stds, 1.0)
                z_scores = np.abs((coordinates - means) / safe_stds)
                z_per_dim = z_scores.max(axis=0).tolist()
                dominant_dim = int(np.argmax(z_scores.max(axis=0)))
                z_max = float(np.max(z_scores))
            else:
                z_per_dim = [0.0, 0.0, 0.0]
                dominant_dim = -1
                z_max = 0.0

            # Composite raw anomaly score: flagged-point ratio + clamped z_max.
            anomaly_ratio = (len(anomaly_indices) / n_points) if n_points else 0.0
            composite = anomaly_ratio * 3.0 + (min(z_max, ZSCORE_CLAMP) / ZSCORE_CLAMP) * 2.0

            if self._composite_smoothed is None:
                self._composite_smoothed = composite
            else:
                self._composite_smoothed = (
                    EMA_ALPHA * composite + (1 - EMA_ALPHA) * self._composite_smoothed
                )

            window_fill = min(1.0, len(self._centroids) / self._maxlen)
            regime = self._classify_regime(window_fill, velocity, acceleration, drift_slope)

            return TemporalMetrics(
                z_max=z_max,
                z_per_dim=z_per_dim,
                velocity=velocity,
                acceleration=acceleration,
                drift_slope=drift_slope,
                composite=composite,
                composite_smoothed=self._composite_smoothed,
                regime=regime,
                window_fill=window_fill,
                dominant_dim=dominant_dim,
            )

    @staticmethod
    def _classify_regime(
        window_fill: float,
        velocity: float,
        acceleration: float,
        drift_slope: float,
    ) -> str:
        if window_fill < 1.0:
            return "warmup"
        if abs(acceleration) > ACCELERATION_THRESHOLD:
            return "acceleration"
        if velocity > VELOCITY_SPIKE_THRESHOLD:
            return "spike"
        if velocity > VELOCITY_THRESHOLD:
            return "velocity"
        if drift_slope > DRIFT_THRESHOLD:
            return "drift"
        return "stable"
