"""
backend/tools/calibration_metrics.py — Shared metric-accounting for temporal
engine calibration.

Used by both the synthetic audit (backend/tests/audit_temporal_noise.py) and
the real-telemetry replay (backend/tools/replay_calibration.py) so the two
can never disagree about how a metric (hot-regime rate, per-channel
exceedance, latch events, percentile histograms) is computed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

import numpy as np

HOT_REGIMES = {"spike", "velocity", "acceleration", "drift"}


@dataclass
class CalibrationMetrics:
    """Accumulates per-frame TemporalMetrics into audit/replay statistics."""

    velocity_threshold: float
    acceleration_threshold: float
    drift_threshold: float

    n_frames: int = 0
    hot_count: int = 0
    latch_events: int = 0
    exceed: Dict[str, int] = field(
        default_factory=lambda: {"velocity": 0, "acceleration": 0, "drift": 0}
    )
    velocities: List[float] = field(default_factory=list)
    accelerations: List[float] = field(default_factory=list)
    drifts: List[float] = field(default_factory=list)
    regimes: List[str] = field(default_factory=list)
    _prev_hot: bool = field(default=False, repr=False)

    def record(self, temporal) -> None:
        """Fold one frame's TemporalMetrics (velocity/acceleration/drift_slope/
        regime attributes) into the running statistics."""
        self.n_frames += 1
        regime = temporal.regime
        self.regimes.append(regime)

        hot = regime in HOT_REGIMES
        if hot:
            self.hot_count += 1
        if hot and not self._prev_hot:
            self.latch_events += 1
        self._prev_hot = hot

        if abs(temporal.velocity) > self.velocity_threshold:
            self.exceed["velocity"] += 1
        if abs(temporal.acceleration) > self.acceleration_threshold:
            self.exceed["acceleration"] += 1
        if abs(temporal.drift_slope) > self.drift_threshold:
            self.exceed["drift"] += 1

        self.velocities.append(temporal.velocity)
        self.accelerations.append(temporal.acceleration)
        self.drifts.append(temporal.drift_slope)

    @property
    def hot_rate(self) -> float:
        return self.hot_count / self.n_frames if self.n_frames else 0.0

    def exceedance_rate(self, channel: str) -> float:
        return self.exceed[channel] / self.n_frames if self.n_frames else 0.0

    @staticmethod
    def _percentiles(values: List[float]) -> Dict[str, float]:
        if not values:
            return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0}
        arr = np.abs(np.array(values))
        return {
            "p50": float(np.percentile(arr, 50)),
            "p95": float(np.percentile(arr, 95)),
            "p99": float(np.percentile(arr, 99)),
            "max": float(np.max(arr)),
        }

    def histograms(self) -> Dict[str, Dict[str, float]]:
        """Per-channel |value| percentile summary (p50/p95/p99/max) to guide
        threshold selection against a real distribution."""
        return {
            "velocity": self._percentiles(self.velocities),
            "acceleration": self._percentiles(self.accelerations),
            "drift": self._percentiles(self.drifts),
        }

    def print_report(self, gate_hot_rate: float = 0.02, gate_exceedance: float = 0.03) -> bool:
        """Prints the standard audit/replay report; returns whether the
        hot-rate + per-channel-exceedance gate passes."""
        print(f"frames processed: {self.n_frames}")
        print(
            f"latched ANOMALY (hot regime) frame rate: {self.hot_rate:.4f} "
            f"(gate < {gate_hot_rate})"
        )
        print(f"distinct false latch events: {self.latch_events}")
        for channel in ("velocity", "acceleration", "drift"):
            print(
                f"per-channel exceedance [{channel}]: {self.exceedance_rate(channel):.4f} "
                f"(gate < {gate_exceedance})"
            )

        print()
        print("per-channel percentile histograms (|value|):")
        for channel, summary in self.histograms().items():
            print(
                f"  {channel}: p50={summary['p50']:.3f} p95={summary['p95']:.3f} "
                f"p99={summary['p99']:.3f} max={summary['max']:.3f}"
            )

        return self.hot_rate < gate_hot_rate and all(
            self.exceedance_rate(c) < gate_exceedance for c in ("velocity", "acceleration", "drift")
        )
