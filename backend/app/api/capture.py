"""
backend/app/api/capture.py — Opt-in telemetry capture for temporal engine
recalibration.

When IYE_CAPTURE_PATH is set (read once, at import time — zero per-frame
overhead when unset beyond a None check), every call to capture_frame()
appends one JSON line to that path containing exactly what
TemporalEngine.process_frame() consumes: the raw, pre-processing input for
one ingested frame.

JSONL schema (one object per line):
    {
        "timestamp": str,                 # ISO 8601 — same value passed to process_frame
        "coordinates": [[x, y, z], ...],   # raw 3D coordinates (pre noise-exclusion)
        "anomaly_indices": [int, ...],     # indices into coordinates flagged by the Z-score check
        "cluster_labels": [int, ...]       # HDBSCAN labels, one per coordinate (-1 = noise)
    }

Replay this file with `python -m tools.replay_calibration path/to/capture.jsonl`
— see docs/temporal_calibration.md for the full recalibration runbook.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Sequence

import numpy as np

_CAPTURE_PATH = os.environ.get("IYE_CAPTURE_PATH")
_lock = threading.Lock()


def is_capture_enabled() -> bool:
    return _CAPTURE_PATH is not None


def capture_frame(
    coordinates: np.ndarray,
    timestamp: str,
    anomaly_indices: Sequence[int],
    cluster_labels: Sequence[int],
) -> None:
    """Append one JSONL record. No file I/O at all when IYE_CAPTURE_PATH is unset."""
    if _CAPTURE_PATH is None:
        return

    record = {
        "timestamp": timestamp,
        "coordinates": coordinates.tolist() if hasattr(coordinates, "tolist") else list(coordinates),
        "anomaly_indices": list(anomaly_indices),
        "cluster_labels": list(cluster_labels),
    }
    line = json.dumps(record)
    with _lock:
        with open(_CAPTURE_PATH, "a") as f:
            f.write(line + "\n")
