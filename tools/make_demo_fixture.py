"""
tools/make_demo_fixture.py — generates demo/sample_telemetry.csv.

Stdlib-only (random + csv), no numpy dependency, so it's runnable with any
Python 3 interpreter, not just the backend's venv:

    python3 tools/make_demo_fixture.py

Produces 196 nominal rows (6 numeric dims, gauss(0, 1)) followed by 4 planted
outlier rows (magnitude 2000). These exact parameters — seed, counts,
magnitude — were empirically chosen, not arbitrary: the backend's
UMAP-reduced Z-score anomaly check is sensitive to sample size and random
draw (UMAP is topology- not distance-preserving), so a small/weak outlier
set can silently fail to cross the 2.5-sigma threshold. This configuration
was verified (docs/idealization_report.md, 2026-07-07 sprint, Phase 1 gate
note) to deterministically flag the planted rows as anomalous when POSTed
through the real /api/canvas/vectors pipeline.
"""

from __future__ import annotations

import csv
import random
from pathlib import Path

SEED = 42
N_NOMINAL = 196
N_OUTLIERS = 4
OUTLIER_MAGNITUDE = 2000.0
DIM = 6

HEADER = [f"metric_{i + 1}" for i in range(DIM)]

_repo_root = Path(__file__).resolve().parent.parent
OUTPUT_PATH = _repo_root / "demo" / "sample_telemetry.csv"


def generate_rows() -> list[list[float]]:
    rng = random.Random(SEED)
    rows: list[list[float]] = []
    for _ in range(N_NOMINAL):
        rows.append([rng.gauss(0, 1) for _ in range(DIM)])
    for _ in range(N_OUTLIERS):
        rows.append([OUTLIER_MAGNITUDE + rng.gauss(0, 1) for _ in range(DIM)])
    return rows


def write_csv(rows: list[list[float]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(HEADER)
        for row in rows:
            writer.writerow(f"{v:.4f}" for v in row)


def main() -> None:
    rows = generate_rows()
    write_csv(rows, OUTPUT_PATH)
    print(
        f"wrote {len(rows)} rows ({N_NOMINAL} nominal + {N_OUTLIERS} planted "
        f"outliers) x {DIM} dims to {OUTPUT_PATH}"
    )


if __name__ == "__main__":
    main()
