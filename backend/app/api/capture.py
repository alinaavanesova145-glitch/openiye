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

# A long-running LAN session with this feature enabled appends one line per
# ingested frame forever, with no natural end — left alone, the file grows
# unboundedly (2026-08-29 sprint finding). Rotates like a standard
# single-backup log: once the active file would exceed this, it's renamed to
# `<path>.1` (clobbering any previous `.1`) and a fresh file starts at
# `<path>`. Bounds total disk usage for this feature to ~2x this constant.
# 100 MB is generous for a JSONL of small per-frame records (a handful of KB
# each even for a large point cloud) while still being a real, enforced cap
# instead of none at all.
MAX_CAPTURE_FILE_BYTES = 100 * 1024 * 1024


def is_capture_enabled() -> bool:
    return _CAPTURE_PATH is not None


def _rotate_if_needed(path: str) -> None:
    """Renames `path` -> `path.1` (overwriting any existing `path.1`) if
    `path` already meets or exceeds MAX_CAPTURE_FILE_BYTES. Must be called
    with `_lock` held — sizing a file and then writing to it isn't atomic
    on its own. A no-op if `path` doesn't exist yet (first-ever write)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    if size < MAX_CAPTURE_FILE_BYTES:
        return
    os.replace(path, path + ".1")  # atomic rename on POSIX; overwrites path.1 if present


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
        _rotate_if_needed(_CAPTURE_PATH)
        with open(_CAPTURE_PATH, "a") as f:
            f.write(line + "\n")
