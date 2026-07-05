"""
backend/app/api/temporal_engine.py — Stateful temporal feature engine.

Tracks a sliding window (deque, maxlen=50) of per-frame centroids and derives
velocity, acceleration, drift, and an EMA-smoothed composite anomaly score
across consecutive /api/canvas/vectors ingestions.

Calibration (see docs/temporal_calibration.md for the empirical audit):
  - velocity/acceleration are first/second differences of the centroid,
    normalized by the theoretical noise scale of a first/second difference
    of independent centroid estimates (sigma_centroid*sqrt(2), *sqrt(6)).
    This makes them dimensionless "sigma units" independent of coordinate
    scale, point count, and frame arrival cadence.
  - drift is a Theil-Sen (median-of-pairwise-slopes) trend estimate over the
    window, robust to a minority of outlier frames — unlike a plain rolling
    mean, which self-contaminates on the very frame it's supposed to judge.
  - regime uses enter/release hysteresis (debounce) so a single noisy frame
    can't latch a hot regime, and a latched regime only releases after a
    sustained run of nominal frames.
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

# Sigma-normalized regime thresholds — see docs/temporal_calibration.md for
# the empirical derivation against 2000 frames of nominal Gaussian traffic.
# Set near the empirical p99 of nominal velocity/acceleration_z (~3.6), not the
# naive chi-3 theoretical value (3.0): estimating sigma from a single ~16-point
# frame is itself noisy, which fattens the tails beyond the ideal distribution.
VELOCITY_Z_THRESHOLD = 3.7
VELOCITY_Z_SPIKE_THRESHOLD = 6.0
ACCELERATION_Z_THRESHOLD = 3.7
DRIFT_Z_THRESHOLD = 3.0

ENTER_DEBOUNCE = 2      # consecutive exceeding frames required to latch a hot regime
RELEASE_DEBOUNCE = 6    # consecutive nominal frames required to release the latch
MIN_TREND_POINTS = 8    # minimum window depth before a drift trend is trusted
SIGMA_EMA_ALPHA = 0.15  # smooths the per-frame noise-scale estimate across frames;
                        # a single frame's std (n~16) is itself noisy enough to
                        # fatten the tails of velocity_z/acceleration_z otherwise


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


def _theil_sen_slope_1d(times: np.ndarray, values: np.ndarray) -> float:
    """Median of all pairwise slopes — a trend estimate with a ~29% breakdown
    point, so a minority of outlier frames can't drag it like a mean/OLS fit
    would. Exact (not sampled): window sizes here are capped at 50, i.e. at
    most 1225 pairs."""
    n = len(values)
    if n < 2:
        return 0.0
    slopes: List[float] = []
    for i in range(n - 1):
        dt = times[i + 1:] - times[i]
        dv = values[i + 1:] - values[i]
        valid = np.abs(dt) > 1e-9
        if np.any(valid):
            slopes.extend((dv[valid] / dt[valid]).tolist())
    if not slopes:
        return 0.0
    return float(np.median(slopes))


class TemporalEngine:
    """Stateful sliding-window feature engine for one logical vector stream."""

    def __init__(self, maxlen: int = WINDOW_MAXLEN) -> None:
        self._lock = threading.RLock()
        self._maxlen = maxlen
        self._centroids: Deque[np.ndarray] = deque(maxlen=maxlen)
        self._times: Deque[float] = deque(maxlen=maxlen)
        self._composite_smoothed: Optional[float] = None
        self._sigma_ema: Optional[float] = None
        self._hot_streak: int = 0
        self._cold_streak: int = 0
        self._latched_regime: Optional[str] = None

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

            # Per-axis z-scores of this frame's own point cloud (unrelated to
            # centroid tracking — a spatial-outlier signal for the raw cloud).
            if n_points > 1:
                means = coordinates.mean(axis=0)
                stds = coordinates.std(axis=0)
                safe_stds = np.where(stds > 0.0, stds, 1.0)
                z_scores = np.abs((coordinates - means) / safe_stds)
                z_per_dim = z_scores.max(axis=0).tolist()
                dominant_dim = int(np.argmax(z_scores.max(axis=0)))
                z_max = float(np.max(z_scores))
                sigma_hat = float(np.mean(stds))
            else:
                z_per_dim = [0.0, 0.0, 0.0]
                dominant_dim = -1
                z_max = 0.0
                sigma_hat = 1.0

            # A single frame's std (n~16) is a noisy estimate of the true noise
            # scale; smoothing it across frames keeps velocity_z/acceleration_z
            # from developing fat tails purely from denominator estimation noise.
            if self._sigma_ema is None:
                self._sigma_ema = sigma_hat
            else:
                self._sigma_ema = SIGMA_EMA_ALPHA * sigma_hat + (1 - SIGMA_EMA_ALPHA) * self._sigma_ema

            n_effective = clustered_coords.shape[0] if clustered_coords.shape[0] else max(n_points, 1)
            sem = max(self._sigma_ema / np.sqrt(n_effective), 1e-6)  # centroid standard error

            prev_centroids = list(self._centroids)

            # Velocity: first difference of centroid position, normalized by the
            # noise scale of a first difference of two independent estimates.
            if len(prev_centroids) >= 1:
                velocity_raw = float(np.linalg.norm(centroid - prev_centroids[-1]))
            else:
                velocity_raw = 0.0
            velocity = velocity_raw / (sem * np.sqrt(2.0))

            # Acceleration: second difference of centroid position, normalized by
            # the noise scale of a second difference of three independent estimates.
            if len(prev_centroids) >= 2:
                second_diff = centroid - 2.0 * prev_centroids[-1] + prev_centroids[-2]
                acceleration_raw = float(np.linalg.norm(second_diff))
            else:
                acceleration_raw = 0.0
            acceleration = acceleration_raw / (sem * np.sqrt(6.0))

            self._centroids.append(centroid)
            self._times.append(now)

            # Drift: Theil-Sen trend slope over the window, scaled by the window's
            # time span and normalized into the same sigma units as velocity.
            if len(self._centroids) >= MIN_TREND_POINTS:
                times_arr = np.array(self._times)
                coords_arr = np.stack(self._centroids)
                slope_vec = np.array([
                    _theil_sen_slope_1d(times_arr, coords_arr[:, axis])
                    for axis in range(coords_arr.shape[1])
                ])
                drift_raw = float(np.linalg.norm(slope_vec))
                window_span = max(now - self._times[0], 1e-6)
            else:
                drift_raw = 0.0
                window_span = 0.0
            drift_slope = (drift_raw * window_span) / (sem * np.sqrt(2.0))

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
            regime = self._update_regime(window_fill, velocity, acceleration, drift_slope)

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

    def _update_regime(
        self,
        window_fill: float,
        velocity: float,
        acceleration: float,
        drift_slope: float,
    ) -> str:
        if window_fill < 1.0:
            self._hot_streak = 0
            self._cold_streak = 0
            self._latched_regime = None
            return "warmup"

        if velocity > VELOCITY_Z_SPIKE_THRESHOLD:
            candidate = "spike"
        elif acceleration > ACCELERATION_Z_THRESHOLD:
            candidate = "acceleration"
        elif velocity > VELOCITY_Z_THRESHOLD:
            candidate = "velocity"
        elif drift_slope > DRIFT_Z_THRESHOLD:
            candidate = "drift"
        else:
            candidate = "stable"

        if candidate != "stable":
            self._hot_streak += 1
            self._cold_streak = 0
            if self._hot_streak >= ENTER_DEBOUNCE:
                self._latched_regime = candidate
        else:
            self._cold_streak += 1
            self._hot_streak = 0
            if self._latched_regime is not None and self._cold_streak >= RELEASE_DEBOUNCE:
                self._latched_regime = None

        return self._latched_regime if self._latched_regime is not None else "stable"
