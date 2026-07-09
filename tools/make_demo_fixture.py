"""
tools/make_demo_fixture.py — generates demo/sample_telemetry.csv and
demo/sample_telemetry_mixed.csv.

Stdlib-only (random + csv), no numpy dependency, so it's runnable with any
Python 3 interpreter, not just the backend's venv:

    python3 tools/make_demo_fixture.py

sample_telemetry.csv: 196 nominal rows (6 numeric dims, gauss(0, 1))
followed by 4 planted outlier rows (magnitude 2000). These exact parameters
— seed, counts, magnitude — were empirically chosen, not arbitrary: the
backend's UMAP-reduced Z-score anomaly check is sensitive to sample size and
random draw (UMAP is topology- not distance-preserving), so a small/weak
outlier set can silently fail to cross the 2.5-sigma threshold. This
configuration was verified (docs/idealization_report.md, 2026-07-07 sprint,
Phase 1 gate note) to deterministically flag the planted rows as anomalous
when POSTed through the real /api/canvas/vectors pipeline.

sample_telemetry_mixed.csv (2026-07-12 sprint, Phase 1a): the same numeric
shape plus one low-cardinality categorical column ('status':
'nominal'/'critical', perfectly correlated with the planted outliers) —
exercises the frontend's automatic categorical encoding (parseMatrix.ts's
buildFeatureMatrix) instead of the old drop-non-numeric-columns behavior.

Parameters differ from the numeric-only fixture and were re-derived
empirically, not reused blindly: once 'status' is one-hot encoded, the
*numeric* columns also get z-score normalized (buildFeatureMatrix's
"mixed pathway" — see parseMatrix.ts), which is scale-invariant, so
OUTLIER_MAGNITUDE stops mattering at all (confirmed: 2000/5000/20000/100000
all produced the same result for a fixed seed). What DOES matter is outlier
*count*: 4 outliers (the numeric-only fixture's count) was unreliable across
seeds once normalized (worked ~40% of seeds tried); 8 was 100% reliable
across every seed tried (5/5). A second categorical column ('region',
uncorrelated with the outlier/nominal split) was tried and made detection
*less* reliable — an uninformative one-hot block dilutes UMAP's neighbor
graph — so the mixed fixture intentionally has only the one, correlated,
categorical column.
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

MIXED_N_OUTLIERS = 8

HEADER = [f"metric_{i + 1}" for i in range(DIM)]
MIXED_HEADER = [*HEADER, "status"]

_repo_root = Path(__file__).resolve().parent.parent
OUTPUT_PATH = _repo_root / "demo" / "sample_telemetry.csv"
MIXED_OUTPUT_PATH = _repo_root / "demo" / "sample_telemetry_mixed.csv"


def generate_rows() -> list[list[float]]:
    rng = random.Random(SEED)
    rows: list[list[float]] = []
    for _ in range(N_NOMINAL):
        rows.append([rng.gauss(0, 1) for _ in range(DIM)])
    for _ in range(N_OUTLIERS):
        rows.append([OUTLIER_MAGNITUDE + rng.gauss(0, 1) for _ in range(DIM)])
    return rows


def generate_mixed_rows() -> list[list[object]]:
    rng = random.Random(SEED)
    rows: list[list[object]] = []
    for _ in range(N_NOMINAL):
        numeric = [rng.gauss(0, 1) for _ in range(DIM)]
        rows.append([*numeric, "nominal"])
    for _ in range(MIXED_N_OUTLIERS):
        numeric = [OUTLIER_MAGNITUDE + rng.gauss(0, 1) for _ in range(DIM)]
        rows.append([*numeric, "critical"])
    return rows


def write_csv(header: list[str], rows: list[list[object]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        for row in rows:
            writer.writerow(f"{v:.4f}" if isinstance(v, float) else v for v in row)


def main() -> None:
    rows = generate_rows()
    write_csv(HEADER, rows, OUTPUT_PATH)  # type: ignore[arg-type]
    print(
        f"wrote {len(rows)} rows ({N_NOMINAL} nominal + {N_OUTLIERS} planted "
        f"outliers) x {DIM} dims to {OUTPUT_PATH}"
    )

    mixed_rows = generate_mixed_rows()
    write_csv(MIXED_HEADER, mixed_rows, MIXED_OUTPUT_PATH)
    print(
        f"wrote {len(mixed_rows)} rows ({N_NOMINAL} nominal + {MIXED_N_OUTLIERS} planted "
        f"outliers) x {DIM} numeric + 1 categorical dims to {MIXED_OUTPUT_PATH}"
    )


if __name__ == "__main__":
    main()
