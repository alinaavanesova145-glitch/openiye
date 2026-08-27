"""
backend/tests/test_temporal_engine_regimes.py — regime-classification
coverage for TemporalEngine (2026-08-30 sprint; see docs/idealization_report.md,
2026-08-29 sprint's "Remaining known gaps" #2).

Before this sprint, `test_temporal_engine_integration.py` had exactly one
test, feeding three sequential frames against the *default* maxlen (50) —
mathematically incapable of ever leaving the "warmup" branch
(window_fill = len(centroids)/maxlen never reaches 1.0 with only 3 frames
against 50). None of `_update_regime`'s actual spike/velocity/acceleration/
drift classification or its enter/release hysteresis had ever run under
test.

Every sequence below was derived empirically first (searching for step
sizes that land in a specific regime's threshold band), not hand-derived
from the sigma-normalization formulas — the same "reproduce before
asserting" discipline this project already applies elsewhere. Frames use
a FIXED relative point-cloud shape (translated, not resampled, per frame)
so sigma_hat — and therefore the velocity/acceleration/drift
normalization — is exactly reproducible frame to frame, instead of
carrying independent-random-sample noise that would make threshold-
adjacent sequences flaky.

TemporalEngine's `maxlen` constructor parameter (independent of the
module's WINDOW_MAXLEN=50 default) is what makes any of this practical to
test at all — it lets window_fill reach 1.0 (exiting "warmup") after a
handful of frames instead of 50.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np

from app.api.temporal_engine import (
    ACCELERATION_Z_THRESHOLD,
    DRIFT_Z_THRESHOLD,
    ENTER_DEBOUNCE,
    RELEASE_DEBOUNCE,
    VELOCITY_Z_SPIKE_THRESHOLD,
    VELOCITY_Z_THRESHOLD,
    TemporalEngine,
)

# Fixed relative point-cloud shape, translated (not resampled) per frame —
# see module docstring above for why. 20 points, tight spread so
# thresholds land at small, easy-to-read step sizes.
_SHAPE = np.random.default_rng(42).normal(0, 0.01, size=(20, 3))
_T0 = datetime(2026, 1, 1)


def _feed(engine: TemporalEngine, centers, dt: float = 1.0):
    """Feeds one frame per center (a 3-sequence), all points sharing the
    same cluster label (0) so none are excluded as HDBSCAN noise. Returns
    the list of regimes, one per frame, in order."""
    regimes = []
    for i, center in enumerate(centers):
        ts = (_T0 + timedelta(seconds=i * dt)).isoformat()
        coords = np.asarray(center, dtype=float) + _SHAPE
        metrics = engine.process_frame(
            coordinates=coords,
            timestamp=ts,
            anomaly_indices=[],
            cluster_labels=[0] * len(_SHAPE),
        )
        regimes.append(metrics.regime)
    return regimes


class TestWarmup:
    def test_stays_in_warmup_until_the_window_is_full(self):
        engine = TemporalEngine(maxlen=5)
        regimes = _feed(engine, [[0, 0, 0]] * 4)
        assert regimes == ["warmup"] * 4

    def test_exits_warmup_on_the_frame_the_window_fills(self):
        engine = TemporalEngine(maxlen=5)
        regimes = _feed(engine, [[0, 0, 0]] * 5)
        assert regimes[:4] == ["warmup"] * 4
        assert regimes[4] != "warmup"

    def test_a_hot_reading_during_warmup_never_latches_a_regime(self):
        # A huge jump while the window is still short of full (4 frames
        # against maxlen=5 -> window_fill=0.8) is still "warmup" per
        # _update_regime's own precondition (window_fill < 1.0 short-
        # circuits before the threshold checks even run) -- confirms
        # warmup isn't just "usually stable," it's an unconditional gate.
        engine = TemporalEngine(maxlen=5)
        regimes = _feed(engine, [[0, 0, 0]] * 3 + [[500, 0, 0]])
        assert regimes[-1] == "warmup"


class TestRegimeClassification:
    """Each sequence isolates exactly one candidate regime -- confirmed
    empirically that the OTHER metrics stay under their own thresholds at
    the chosen step size, so a wrong classification here means the
    priority order (spike > acceleration > velocity > drift > stable) or
    a threshold comparison actually broke, not an ambiguous fixture."""

    def test_stable_when_nothing_exceeds_any_threshold(self):
        engine = TemporalEngine(maxlen=5)
        regimes = _feed(engine, [[0, 0, 0]] * 7)
        assert regimes[-1] == "stable"

    def test_velocity_regime(self):
        # Constant-velocity straight-line motion: step size empirically
        # tuned so velocity lands in (VELOCITY_Z_THRESHOLD,
        # VELOCITY_Z_SPIKE_THRESHOLD] and acceleration stays ~0 (equal
        # steps -> zero second difference).
        engine = TemporalEngine(maxlen=5)
        step = 0.013
        centers = [[0, 0, 0]] * 5 + [[step, 0, 0], [step * 2, 0, 0]]
        metrics_log = []
        for i, c in enumerate(centers):
            ts = (_T0 + timedelta(seconds=i)).isoformat()
            m = engine.process_frame(
                coordinates=np.asarray(c, dtype=float) + _SHAPE,
                timestamp=ts,
                anomaly_indices=[],
                cluster_labels=[0] * len(_SHAPE),
            )
            metrics_log.append(m)

        last = metrics_log[-1]
        assert last.regime == "velocity"
        assert VELOCITY_Z_THRESHOLD < last.velocity <= VELOCITY_Z_SPIKE_THRESHOLD
        assert last.acceleration <= ACCELERATION_Z_THRESHOLD

    def test_spike_regime(self):
        # A single, large, one-off jump -- velocity blows past even the
        # spike threshold; acceleration is irrelevant once spike's own
        # (higher-priority) condition is met.
        engine = TemporalEngine(maxlen=5)
        centers = [[0, 0, 0]] * 5 + [[100, 0, 0], [200, 0, 0]]
        regimes = _feed(engine, centers)
        assert regimes[-1] == "spike"

    def test_acceleration_regime(self):
        # Zigzag: alternating direction each frame keeps any single
        # frame's velocity moderate (well under the spike threshold) while
        # the second difference (direction reversal) is large.
        engine = TemporalEngine(maxlen=5)
        step = 0.007
        centers = [[0, 0, 0]] * 5 + [[step, 0, 0], [-step, 0, 0], [step, 0, 0]]
        metrics_log = []
        for i, c in enumerate(centers):
            ts = (_T0 + timedelta(seconds=i)).isoformat()
            m = engine.process_frame(
                coordinates=np.asarray(c, dtype=float) + _SHAPE,
                timestamp=ts,
                anomaly_indices=[],
                cluster_labels=[0] * len(_SHAPE),
            )
            metrics_log.append(m)

        last = metrics_log[-1]
        assert last.regime == "acceleration"
        assert last.velocity <= VELOCITY_Z_SPIKE_THRESHOLD
        assert last.acceleration > ACCELERATION_Z_THRESHOLD

    def test_drift_regime(self):
        # A slow, sustained, monotonic trend -- each individual step is
        # far too small to trip velocity/acceleration, but Theil-Sen sees
        # a real trend across the whole (now-full) window.
        # MIN_TREND_POINTS=8 requires maxlen>=8 for drift to ever compute.
        engine = TemporalEngine(maxlen=8)
        step = 0.003
        centers = [[i * step, 0, 0] for i in range(10)]
        metrics_log = []
        for i, c in enumerate(centers):
            ts = (_T0 + timedelta(seconds=i)).isoformat()
            m = engine.process_frame(
                coordinates=np.asarray(c, dtype=float) + _SHAPE,
                timestamp=ts,
                anomaly_indices=[],
                cluster_labels=[0] * len(_SHAPE),
            )
            metrics_log.append(m)

        last = metrics_log[-1]
        assert last.regime == "drift"
        assert last.velocity <= VELOCITY_Z_THRESHOLD
        assert last.acceleration <= ACCELERATION_Z_THRESHOLD
        assert last.drift_slope > DRIFT_Z_THRESHOLD


class TestHysteresis:
    def test_enter_debounce_requires_consecutive_hot_frames_to_latch(self):
        # A single hot (spike-magnitude) frame must NOT latch -- confirms
        # ENTER_DEBOUNCE is a real >=2 requirement, not effectively 1.
        assert ENTER_DEBOUNCE == 2
        engine = TemporalEngine(maxlen=5)
        regimes = _feed(engine, [[0, 0, 0]] * 5 + [[100, 0, 0]])
        assert regimes[-1] == "stable"  # not "spike" yet -- only 1 hot frame

        # The very next hot frame (2nd consecutive) does latch it.
        second = _feed(engine, [[200, 0, 0]])
        assert second[-1] == "spike"

    def test_release_debounce_requires_sustained_nominal_frames(self):
        # Latch "velocity", then hold position constant (a stable-
        # candidate reading) and confirm the regime stays latched for
        # RELEASE_DEBOUNCE-1 frames and only actually releases on the
        # RELEASE_DEBOUNCE-th.
        assert RELEASE_DEBOUNCE == 6
        engine = TemporalEngine(maxlen=5)
        step = 0.013
        latch_regimes = _feed(
            engine, [[0, 0, 0]] * 5 + [[step, 0, 0], [step * 2, 0, 0]]
        )
        assert latch_regimes[-1] == "velocity"

        hold_regimes = _feed(engine, [[step * 2, 0, 0]] * RELEASE_DEBOUNCE)
        # Still latched for the first RELEASE_DEBOUNCE-1 nominal frames...
        assert hold_regimes[: RELEASE_DEBOUNCE - 1] == ["velocity"] * (RELEASE_DEBOUNCE - 1)
        # ...and only releases on the RELEASE_DEBOUNCE-th.
        assert hold_regimes[RELEASE_DEBOUNCE - 1] == "stable"

    def test_a_new_hot_streak_after_release_needs_its_own_full_debounce(self):
        # Confirms _hot_streak/_cold_streak are properly reset on release,
        # not left in some state that would let a second latch happen
        # faster than the first.
        engine = TemporalEngine(maxlen=5)
        step = 0.013
        _feed(engine, [[0, 0, 0]] * 5 + [[step, 0, 0], [step * 2, 0, 0]])  # latch
        _feed(engine, [[step * 2, 0, 0]] * RELEASE_DEBOUNCE)  # release back to stable

        # One more hot frame (a fresh jump) should NOT immediately re-latch.
        regimes = _feed(engine, [[step * 2 + 100, 0, 0]])
        assert regimes[-1] == "stable"


class TestCentroidNoiseExclusion:
    def test_hdbscan_noise_points_dont_drag_the_tracked_centroid(self):
        # A far-away point labeled -1 (HDBSCAN noise) must not pull the
        # centroid the velocity/drift signal is based on.
        engine = TemporalEngine(maxlen=5)
        engine.process_frame(
            coordinates=np.array([[0.0, 0.0, 0.0]] * 4),
            timestamp=_T0.isoformat(),
            anomaly_indices=[],
            cluster_labels=[0, 0, 0, 0],
        )
        coords = np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [-0.01, 0.0, 0.0], [1000.0, 1000.0, 1000.0]])
        metrics = engine.process_frame(
            coordinates=coords,
            timestamp=(_T0 + timedelta(seconds=1)).isoformat(),
            anomaly_indices=[3],
            cluster_labels=[0, 0, 0, -1],
        )
        assert metrics.velocity == 0.0

    def test_without_cluster_labels_all_points_count_toward_the_centroid(self):
        # Same data, no cluster_labels supplied at all -- the (undocumented
        # as noise) outlier point now legitimately drags the centroid,
        # confirming the exclusion above is actually conditional on
        # cluster_labels being provided, not always-on.
        engine = TemporalEngine(maxlen=5)
        engine.process_frame(
            coordinates=np.array([[0.0, 0.0, 0.0]] * 4),
            timestamp=_T0.isoformat(),
            anomaly_indices=[],
            cluster_labels=None,
        )
        coords = np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [-0.01, 0.0, 0.0], [1000.0, 1000.0, 1000.0]])
        metrics = engine.process_frame(
            coordinates=coords,
            timestamp=(_T0 + timedelta(seconds=1)).isoformat(),
            anomaly_indices=[3],
            cluster_labels=None,
        )
        assert metrics.velocity > 0.0
