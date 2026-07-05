"""
backend/tests/audit_temporal_noise.py — Statistical audit script (not a pytest).

Feeds the live TemporalEngine, instantiated exactly as main.py does, synthetic
nominal Gaussian traffic, a hard spike, and a slow linear drift, and reports
the false-positive / detection statistics from the Phase 0 audit gates.

Metric accounting (hot-rate, exceedance, latch events, percentile histograms)
lives in tools/calibration_metrics.py, shared with tools/replay_calibration.py
so the synthetic audit and the real-telemetry replay can never disagree about
how a metric is computed.

Assumptions (documented since they scale velocity/acceleration directly):
  - 16 points per frame, matching the existing pytest fixtures.
  - 1.0s between frames (a plausible telemetry cadence; not measured from
    production since none exists yet).
  - Per-axis coordinate noise sigma=1.0, matching a normalized UMAP-reduced
    coordinate space.
  - A couple of points per frame land on HDBSCAN label -1 even in nominal
    data (matches what was observed against the live pipeline).

Run: backend/.venv/bin/python backend/tests/audit_temporal_noise.py
"""

import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.api.temporal_engine import (  # noqa: E402
    ACCELERATION_Z_THRESHOLD,
    DRIFT_Z_THRESHOLD,
    VELOCITY_Z_THRESHOLD,
    TemporalEngine,
)
from tools.calibration_metrics import HOT_REGIMES, CalibrationMetrics  # noqa: E402

N_POINTS = 16
DT_SECONDS = 1.0
NOISE_SIGMA = 1.0
SEED = 42


def make_frame(rng, center, sigma=NOISE_SIGMA, n_points=N_POINTS, noise_labels=2):
    coords = rng.normal(loc=center, scale=sigma, size=(n_points, 3))
    labels = [0] * n_points
    for i in rng.choice(n_points, size=min(noise_labels, n_points), replace=False):
        labels[i] = -1
    return coords, labels


def iso(t):
    return t.isoformat()


def new_metrics() -> CalibrationMetrics:
    return CalibrationMetrics(
        velocity_threshold=VELOCITY_Z_THRESHOLD,
        acceleration_threshold=ACCELERATION_Z_THRESHOLD,
        drift_threshold=DRIFT_Z_THRESHOLD,
    )


def run_nominal(engine, rng, n_frames, t0):
    metrics = new_metrics()
    t = t0
    for _ in range(n_frames):
        coords, labels = make_frame(rng, center=np.zeros(3))
        t = t + timedelta(seconds=DT_SECONDS)
        m = engine.process_frame(
            coordinates=coords, timestamp=iso(t), anomaly_indices=[], cluster_labels=labels
        )
        metrics.record(m)
    return metrics, t


def main():
    rng = np.random.default_rng(SEED)
    t0 = datetime.now(timezone.utc)

    print("=== Gate 1: 2000 nominal Gaussian frames ===")
    engine1 = TemporalEngine()
    metrics1, _ = run_nominal(engine1, rng, 2000, t0)
    gate1_pass = metrics1.print_report()
    print(f"GATE 1 {'PASS' if gate1_pass else 'FAIL'}")

    print()
    print("=== Gate 2: hard spike (6 frames) + recovery ===")
    engine2 = TemporalEngine()
    _, t_after_warmup = run_nominal(engine2, rng, 60, t0)
    t = t_after_warmup
    spike_regimes = []
    spike_metrics = []
    for _ in range(6):
        coords, labels = make_frame(rng, center=np.array([30.0, 0.0, 0.0]))
        t = t + timedelta(seconds=DT_SECONDS)
        m = engine2.process_frame(
            coordinates=coords,
            timestamp=iso(t),
            anomaly_indices=list(range(N_POINTS)),
            cluster_labels=labels,
        )
        spike_regimes.append(m.regime)
        spike_metrics.append(m)
    latched_within_window = any(r in HOT_REGIMES for r in spike_regimes)
    print(f"regimes during spike: {spike_regimes}")
    print(f"peak velocity during spike: {max(m.velocity for m in spike_metrics):.3f}")
    print(f"GATE 2a (latches within debounce window) {'PASS' if latched_within_window else 'FAIL'}")

    recovery_regimes = []
    for _ in range(10):
        coords, labels = make_frame(rng, center=np.zeros(3))
        t = t + timedelta(seconds=DT_SECONDS)
        m = engine2.process_frame(coordinates=coords, timestamp=iso(t), anomaly_indices=[], cluster_labels=labels)
        recovery_regimes.append(m.regime)
    released = recovery_regimes[-1] not in HOT_REGIMES
    print(f"regimes during recovery: {recovery_regimes}")
    print(f"GATE 2b (releases within ~10 nominal frames) {'PASS' if released else 'FAIL'}")

    print()
    print("=== Gate 3: slow linear drift over 140 frames ===")
    engine3 = TemporalEngine()
    _, t_after_warmup3 = run_nominal(engine3, rng, 60, t0)
    t = t_after_warmup3
    drift_regimes = []
    last_metrics = None
    for i in range(140):
        center = np.array([0.0, i * 0.08, 0.0])
        coords, labels = make_frame(rng, center=center, sigma=0.3)
        t = t + timedelta(seconds=DT_SECONDS)
        m = engine3.process_frame(coordinates=coords, timestamp=iso(t), anomaly_indices=[], cluster_labels=labels)
        drift_regimes.append(m.regime)
        last_metrics = m
    detected_drift = "drift" in drift_regimes[-20:]
    print(f"final regime: {last_metrics.regime}, drift_slope={last_metrics.drift_slope:.3f}")
    print(f"last 20 regimes: {drift_regimes[-20:]}")
    print(f"GATE 3 (drift regime detected in final 20 frames) {'PASS' if detected_drift else 'FAIL'}")


if __name__ == "__main__":
    main()
