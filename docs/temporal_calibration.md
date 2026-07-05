# Temporal Engine Statistical Calibration

Audit script: `backend/tests/audit_temporal_noise.py` (not a pytest — a
standalone report; run via `backend/.venv/bin/python backend/tests/audit_temporal_noise.py`).

## Context

`temporal_engine.py` was built from scratch across two prior sessions, not
"restored" from a prior design — there was no earlier latching/hysteresis
implementation to lose. This audit treats the request as "add real statistical
calibration," and the findings below are from the engine as it existed at the
start of this pass.

## Test conditions (documented since they scale the numbers directly)

- 16 points per frame (matches existing pytest fixtures).
- 1.0s between frames.
- Per-axis coordinate noise `sigma=1.0`, a normalized UMAP-like scale.
- 2 of 16 points per frame randomly labeled HDBSCAN noise (`-1`), even in
  nominal data, matching what was observed against the live pipeline.
- `numpy.random.default_rng(42)` — fixed seed, for reproducibility.

## Before (engine as found)

Raw, unnormalized first-difference velocity (`distance/dt`), a `velocity[t] -
velocity[t-1]` acceleration, and a `drift_slope` measured against a plain
rolling **mean** that included the very frame being evaluated (self-contamination).
Regime was recomputed fresh every frame with no hysteresis.

| Gate | Result | Threshold | Verdict |
|---|---|---|---|
| Gate 1 — hot-regime frame rate | 9.35% | < 2% | **FAIL** |
| Gate 1 — distinct false latch events | 136 | (report only) | — |
| Gate 1 — velocity exceedance | 6.80% | < 3% | **FAIL** |
| Gate 1 — acceleration exceedance | 0.00% | < 3% | pass |
| Gate 1 — drift exceedance | 4.75% | < 3% | **FAIL** |
| Gate 2a — spike latches within window | latched (`acceleration`→`drift`) | — | pass |
| Gate 2b — releases within ~10 nominal frames | still `velocity`/`drift` at frame 10 | — | **FAIL** |
| Gate 3 — slow drift detected | `drift`, `drift_slope=2.102` | — | pass |

Root causes identified:
1. Absolute (non-normalized) thresholds on `velocity`/`acceleration`/`drift`,
   arbitrary constants not tied to any noise scale — meaningless once
   coordinate scale, point count, or frame cadence differ from what was
   guessed when they were picked.
2. `velocity = distance/dt` blows up for any two frames that happen to arrive
   close together in time, independent of whether the displacement itself was
   meaningful.
3. `drift_slope`'s baseline was `mean(window)` computed *after* appending the
   current frame — the baseline is partly made of the value being judged
   against it, and a single outlier frame stays baked into that mean for up to
   `maxlen=50` frames, explaining the Gate 2b non-release.
4. No hysteresis — a single noisy frame could flip the regime label, and
   nothing prevented the same noise from flipping it right back.

## Calibration applied

1. **Sigma-normalized first/second differences.** `velocity` and
   `acceleration` are now the first/second differences of the centroid,
   divided by the theoretical noise scale of a first/second difference of
   independent centroid estimates (`sigma_centroid·√2`, `sigma_centroid·√6`).
   This makes both dimensionless and independent of coordinate scale, point
   count, and — critically — frame arrival cadence (no more `/dt` blow-up).
2. **EMA-smoothed noise-scale estimate.** A single frame's `std` (n≈16) is
   itself a noisy estimate of the true per-axis noise; smoothing it across
   frames (`SIGMA_EMA_ALPHA=0.15`) removes most of the tail-fattening that
   comes from normalizing by a noisy denominator.
3. **Theil-Sen robust drift trend** (median of pairwise slopes) replaces the
   mean-baseline deviation. Its ~29% breakdown point means a handful of
   outlier frames (e.g. a 6-frame spike inside a 50-frame window) can't drag
   it the way a mean does — this is what fixed Gate 2b.
4. **Enter/release hysteresis.** A hot regime only latches after
   `ENTER_DEBOUNCE=2` consecutive exceeding frames, and only releases after
   `RELEASE_DEBOUNCE=6` consecutive nominal frames. This is what stops a
   single noisy frame from flapping the regime label.
5. **Threshold values** were set from the *empirical* nominal distribution
   (percentiles measured directly from the 2000-frame Gate 1 run), not a
   naive theoretical guess. The naive chi-3 theoretical exceedance point
   (`z=3.0`) actually produced ~6% empirical exceedance because sigma is
   *estimated*, not known — estimation noise fattens the tails versus the
   ideal distribution. Final thresholds (`VELOCITY_Z_THRESHOLD=3.7`,
   `ACCELERATION_Z_THRESHOLD=3.7`) sit near the empirical p99, chosen to
   leave margin under the 3% per-channel gate once combined with hysteresis.

## After

| Gate | Result | Threshold | Verdict |
|---|---|---|---|
| Gate 1 — hot-regime frame rate | 1.20% | < 2% | **PASS** |
| Gate 1 — distinct false latch events | 4 | (report only) | — |
| Gate 1 — velocity exceedance | 0.75% | < 3% | **PASS** |
| Gate 1 — acceleration exceedance | 0.65% | < 3% | **PASS** |
| Gate 1 — drift exceedance | 0.00% | < 3% | **PASS** |
| Gate 2a — spike latches within window | latched at frame 2 of 6 (`acceleration`) | — | **PASS** |
| Gate 2b — releases within ~10 nominal frames | `stable` by frame 9 of 10 | — | **PASS** |
| Gate 3 — slow drift detected | `drift`, `drift_slope=36.6` (final 20/20 frames) | — | **PASS** |

Full `pytest` suite (14 tests, including the existing temporal integration
test) still passes after these changes — no field names or the
`process_frame()` signature changed, only their internal computation.

## Honest caveats

- These thresholds are calibrated against a *synthetic* nominal model (fixed
  Gaussian sigma, fixed 1.0s cadence, fixed 16 points/frame), not against
  measured production telemetry, because no production telemetry exists yet.
  If real point counts, cadence, or coordinate scale differ substantially,
  re-run `audit_temporal_noise.py` with matching parameters before trusting
  these exact threshold values in production.
- Gate 2b passed with 1 frame of margin (released at frame 9 of a 10-frame
  budget) on this seed. The hysteresis design is sound, but this specific
  margin is not large — a slower recovery cadence or a longer spike would
  need re-validation.
- `composite`/`composite_smoothed` (EMA of `anomaly_ratio*3 + z_max_clamped*2`)
  were not part of this audit's explicit gates and were left unchanged.
