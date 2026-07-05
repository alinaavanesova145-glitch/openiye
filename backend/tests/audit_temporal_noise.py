"""
backend/tests/audit_temporal_noise.py — Statistical audit script (not a pytest).

Feeds the live TemporalEngine, instantiated exactly as main.py does, synthetic
nominal Gaussian traffic, a hard spike, and a slow linear drift, and reports
the false-positive / detection statistics from the Phase 0 audit gates.

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

N_POINTS = 16
DT_SECONDS = 1.0
NOISE_SIGMA = 1.0
SEED = 42

HOT_REGIMES = {"spike", "velocity", "acceleration", "drift"}


def make_frame(rng, center, sigma=NOISE_SIGMA, n_points=N_POINTS, noise_labels=2):
    coords = rng.normal(loc=center, scale=sigma, size=(n_points, 3))
    labels = [0] * n_points
    for i in rng.choice(n_points, size=min(noise_labels, n_points), replace=False):
        labels[i] = -1
    return coords, labels


def iso(t):
    return t.isoformat()


def run_nominal(engine, rng, n_frames, t0):
    hot_count = 0
    exceed = {"velocity": 0, "acceleration": 0, "drift": 0}
    regimes = []
    t = t0
    for _ in range(n_frames):
        coords, labels = make_frame(rng, center=np.zeros(3))
        t = t + timedelta(seconds=DT_SECONDS)
        m = engine.process_frame(coordinates=coords, timestamp=iso(t), anomaly_indices=[], cluster_labels=labels)
        regimes.append(m.regime)
        if m.regime in HOT_REGIMES:
            hot_count += 1
        if abs(m.velocity) > VELOCITY_Z_THRESHOLD:
            exceed["velocity"] += 1
        if abs(m.acceleration) > ACCELERATION_Z_THRESHOLD:
            exceed["acceleration"] += 1
        if abs(m.drift_slope) > DRIFT_Z_THRESHOLD:
            exceed["drift"] += 1
    return hot_count, exceed, regimes, t


def count_distinct_latch_events(regimes):
    events = 0
    prev_hot = False
    for r in regimes:
        hot = r in HOT_REGIMES
        if hot and not prev_hot:
            events += 1
        prev_hot = hot
    return events


def main():
    rng = np.random.default_rng(SEED)
    t0 = datetime.now(timezone.utc)

    print("=== Gate 1: 2000 nominal Gaussian frames ===")
    engine1 = TemporalEngine()
    hot_count, exceed, regimes, _ = run_nominal(engine1, rng, 2000, t0)
    hot_rate = hot_count / 2000
    latch_events = count_distinct_latch_events(regimes)
    print(f"latched ANOMALY (hot regime) frame rate: {hot_rate:.4f} (gate < 0.02)")
    print(f"distinct false latch events: {latch_events}")
    for k, v in exceed.items():
        print(f"per-channel exceedance [{k}]: {v / 2000:.4f} (gate < 0.03)")
    gate1_pass = hot_rate < 0.02 and all(v / 2000 < 0.03 for v in exceed.values())
    print(f"GATE 1 {'PASS' if gate1_pass else 'FAIL'}")

    print()
    print("=== Gate 2: hard spike (6 frames) + recovery ===")
    engine2 = TemporalEngine()
    _, _, _, t_after_warmup = run_nominal(engine2, rng, 60, t0)
    t = t_after_warmup
    spike_regimes = []
    spike_metrics = []
    for _ in range(6):
        coords, labels = make_frame(rng, center=np.array([30.0, 0.0, 0.0]))
        t = t + timedelta(seconds=DT_SECONDS)
        m = engine2.process_frame(
            coordinates=coords, timestamp=iso(t), anomaly_indices=list(range(N_POINTS)), cluster_labels=labels
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
    _, _, _, t_after_warmup3 = run_nominal(engine3, rng, 60, t0)
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
