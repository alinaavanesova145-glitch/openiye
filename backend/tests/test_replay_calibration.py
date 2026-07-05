"""Tests for tools/replay_calibration.py."""

import json
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

from tools.replay_calibration import main, replay

HOT_REGIMES = {"spike", "velocity", "acceleration", "drift"}


def _iso(t):
    return t.isoformat()


def _write_jsonl(path, records):
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def _make_nominal_records(n_frames, seed=42, n_points=16, sigma=1.0):
    """Mirrors audit_temporal_noise.py's make_frame/run_nominal exactly (same
    seed, same generation order) so the replay's measured hot rate can be
    compared directly against the synthetic audit's."""
    rng = np.random.default_rng(seed)
    t = datetime.now(timezone.utc)
    records = []
    for _ in range(n_frames):
        coords = rng.normal(loc=np.zeros(3), scale=sigma, size=(n_points, 3))
        labels = [0] * n_points
        for i in rng.choice(n_points, size=2, replace=False):
            labels[i] = -1
        t = t + timedelta(seconds=1.0)
        records.append(
            {
                "timestamp": _iso(t),
                "coordinates": coords.tolist(),
                "anomaly_indices": [],
                "cluster_labels": labels,
            }
        )
    return records


def test_replay_pure_nominal_fixture_matches_synthetic_audit_hot_rate(tmp_path):
    """GATE: replay of a pure-nominal fixture reports a hot rate consistent
    with the synthetic audit (audit_temporal_noise.py's Gate 1, seed=42:
    measured hot rate 1.20% at n=2000) within +/-1 percentage point."""
    records = _make_nominal_records(2000)
    capture_path = tmp_path / "nominal.jsonl"
    _write_jsonl(capture_path, records)

    metrics = replay(capture_path)

    assert metrics.n_frames == 2000
    assert abs(metrics.hot_rate - 0.012) <= 0.01


def test_replay_detects_an_injected_spike(tmp_path):
    """A tiny fixture — enough nominal frames to clear warmup, then a hard
    spike — must be detected as a hot regime, not silently missed."""
    rng = np.random.default_rng(7)
    t = datetime.now(timezone.utc)
    records = []

    for _ in range(60):  # fill the 50-frame window past warmup
        coords = rng.normal(loc=np.zeros(3), scale=1.0, size=(16, 3))
        t = t + timedelta(seconds=1.0)
        records.append(
            {
                "timestamp": _iso(t),
                "coordinates": coords.tolist(),
                "anomaly_indices": [],
                "cluster_labels": [0] * 16,
            }
        )

    for _ in range(6):  # inject a hard spike
        coords = rng.normal(loc=np.array([30.0, 0.0, 0.0]), scale=1.0, size=(16, 3))
        t = t + timedelta(seconds=1.0)
        records.append(
            {
                "timestamp": _iso(t),
                "coordinates": coords.tolist(),
                "anomaly_indices": list(range(16)),
                "cluster_labels": [0] * 16,
            }
        )

    capture_path = tmp_path / "spike.jsonl"
    _write_jsonl(capture_path, records)

    metrics = replay(capture_path)

    assert metrics.n_frames == 66
    assert metrics.latch_events >= 1
    assert any(r in HOT_REGIMES for r in metrics.regimes[-6:])


def test_replay_errors_cleanly_on_missing_file(tmp_path, capsys):
    missing = tmp_path / "does_not_exist.jsonl"
    old_argv = sys.argv
    sys.argv = ["replay_calibration.py", str(missing)]
    try:
        exit_code = main()
    finally:
        sys.argv = old_argv
    assert exit_code == 1
    assert "does not exist" in capsys.readouterr().err


def test_replay_errors_cleanly_on_empty_file(tmp_path, capsys):
    empty_path = tmp_path / "empty.jsonl"
    empty_path.write_text("")
    old_argv = sys.argv
    sys.argv = ["replay_calibration.py", str(empty_path)]
    try:
        exit_code = main()
    finally:
        sys.argv = old_argv
    assert exit_code == 1
    assert "no records" in capsys.readouterr().err
