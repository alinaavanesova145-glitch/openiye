"""
backend/tools/replay_calibration.py — Replay a captured JSONL telemetry file
through TemporalEngine and report the same gate metrics as
tests/audit_temporal_noise.py, plus per-channel percentile histograms to
guide threshold selection against a real distribution.

Run (from backend/): python -m tools.replay_calibration path/to/capture.jsonl

See docs/temporal_calibration.md for the full recalibration runbook
(capture -> replay -> read histograms -> adjust temporal_engine.py's
thresholds -> re-run gates).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterator

import numpy as np

from app.api.temporal_engine import (
    ACCELERATION_Z_THRESHOLD,
    DRIFT_Z_THRESHOLD,
    VELOCITY_Z_THRESHOLD,
    TemporalEngine,
)
from tools.calibration_metrics import CalibrationMetrics


def load_records(path: Path) -> Iterator[dict]:
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def replay(path: Path) -> CalibrationMetrics:
    # Instantiated exactly as main.py does (TemporalEngine() with no args) —
    # importing the same class from the same module, not copy-pasted
    # constructor args, so replay calibration can never silently drift from
    # what actually runs in production.
    engine = TemporalEngine()
    metrics = CalibrationMetrics(
        velocity_threshold=VELOCITY_Z_THRESHOLD,
        acceleration_threshold=ACCELERATION_Z_THRESHOLD,
        drift_threshold=DRIFT_Z_THRESHOLD,
    )

    for record in load_records(path):
        coordinates = np.array(record["coordinates"], dtype=np.float64)
        # timestamp is replayed as recorded — TemporalEngine derives dt from
        # it internally, so inter-frame timing semantics are preserved
        # exactly without any wall-clock sleep.
        temporal = engine.process_frame(
            coordinates=coordinates,
            timestamp=record["timestamp"],
            anomaly_indices=record.get("anomaly_indices", []),
            cluster_labels=record.get("cluster_labels"),
        )
        metrics.record(temporal)

    return metrics


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture_path", type=Path, help="Path to a captured JSONL file")
    args = parser.parse_args()

    if not args.capture_path.exists():
        print(f"error: {args.capture_path} does not exist", file=sys.stderr)
        return 1

    metrics = replay(args.capture_path)
    if metrics.n_frames == 0:
        print(f"error: {args.capture_path} contained no records", file=sys.stderr)
        return 1

    gate_pass = metrics.print_report()
    print()
    print(f"GATE {'PASS' if gate_pass else 'FAIL'} (hot-rate < 2%, per-channel exceedance < 3%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
