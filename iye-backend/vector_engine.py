"""
iye-backend/vector_engine.py
────────────────────────────
IYE Math Engine — pure-NumPy, stateless, production-hardened.

Design contract
───────────────
All public functions are stateless: no global mutation, no side-effects.
sanitize_vector_field() is the single authority on field hygiene and MUST
be called exactly once per stream frame before any downstream consumer
sees the data.
"""

from __future__ import annotations

import math
from typing import Union

import numpy as np


# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

MAGNITUDE_CEILING: float = 1.0e6   # pass-3 clamp ceiling
EPSILON_NUDGE:     float = 1.0e-6  # pass-4 null-vector correction


# ──────────────────────────────────────────────────────────────────────────────
# Engine
# ──────────────────────────────────────────────────────────────────────────────

class IYEMathEngine:
    """
    Stateless, NumPy-backed vector field math engine.

    All methods are @staticmethod — instantiate for namespace convenience only.
    """

    # ── Core sanitation ───────────────────────────────────────────────────────

    @staticmethod
    def sanitize_vector_field(
        matrix: Union[np.ndarray, list],
    ) -> tuple[np.ndarray, bool]:
        """
        Execute the mandatory 4-pass, non-destructive healing pipeline.
        Dynamically supports both (N, 3) and (N, 6) vector fields.

        Parameters
        ----------
        matrix : array_like, shape (N, 3) or (N, 6)
            Raw vector field coordinates. Any rank-1 input of length 3 or 6 is
            silently promoted to shape (1, D).

        Returns
        -------
        healed : np.ndarray, dtype=float32, shape (N, D)
            Fully sanitised field — finite, clamped, and non-degenerate.
        was_healed : bool
            True when at least one pass performed a mutation.
        """
        was_healed = False

        # ── PASS 1 — dtype coercion ──────────────────────────────────────────
        matrix = np.array(matrix, copy=True)
        if matrix.ndim == 1:
            matrix = matrix.reshape(1, -1)
        if matrix.shape[-1] not in (3, 6):
            raise ValueError(
                f"Expected (N, 3) or (N, 6) vector field; got shape {matrix.shape}."
            )
        matrix = matrix.astype(np.float32, copy=False)

        # ── PASS 2 — finite sweep (NaN / Inf / -Inf → 0.0) ──────────────────
        bad_mask = ~np.isfinite(matrix)
        if bad_mask.any():
            matrix[bad_mask] = 0.0
            was_healed = True

        # ── PASS 3 — magnitude clamp (sign-preserving on vector slice) ───────
        norms = np.linalg.norm(matrix[:, -3:], axis=1, keepdims=True)       # (N, 1)
        over_ceiling = (norms > MAGNITUDE_CEILING).squeeze(axis=1)  # (N,)
        if over_ceiling.any():
            scale = MAGNITUDE_CEILING / norms[over_ceiling]          # (k, 1)
            matrix[over_ceiling, -3:] *= scale
            was_healed = True

        # ── PASS 4 — null-vector guard (ε-nudge on vx slice component) ───────
        null_mask = (np.abs(matrix[:, -3:]).sum(axis=1) == 0.0)             # (N,)
        if null_mask.any():
            matrix[null_mask, -3] = EPSILON_NUDGE
            was_healed = True

        return matrix, was_healed

    # ── Field statistics (used by /tool/field_stats) ──────────────────────────

    @staticmethod
    def compute_field_stats(matrix: np.ndarray) -> dict:
        """
        Compute aggregate statistics on a sanitised (N, 3) or (N, 6) field.

        Returns a flat, JSON-serialisable dict with:
            num_vectors, centroid_x/y/z,
            min_x/y/z, max_x/y/z,
            mean_magnitude, max_magnitude
        """
        m = matrix.astype(np.float64)  # promote for precision in stats
        vel = m[:, -3:]
        centroid = vel.mean(axis=0)
        mins = vel.min(axis=0)
        maxs = vel.max(axis=0)
        magnitudes = np.linalg.norm(vel, axis=1)

        return {
            "num_vectors":    int(m.shape[0]),
            "centroid_x":     float(centroid[0]),
            "centroid_y":     float(centroid[1]),
            "centroid_z":     float(centroid[2]),
            "min_x":          float(mins[0]),
            "min_y":          float(mins[1]),
            "min_z":          float(mins[2]),
            "max_x":          float(maxs[0]),
            "max_y":          float(maxs[1]),
            "max_z":          float(maxs[2]),
            "mean_magnitude": float(magnitudes.mean()),
            "max_magnitude":  float(magnitudes.max()),
        }

    @staticmethod
    def compute_field_analytics(matrix: np.ndarray) -> dict:
        """
        Compute aggregate analytics for the MCP `/tool/field_stats` endpoint.
        Suppports both (N, 3) and (N, 6) field layouts.
        """
        stats = IYEMathEngine.compute_field_stats(matrix)
        stats["count"] = stats["num_vectors"]
        stats["status"] = "nominal"
        return stats

    # ── Raw field generation (used by the SSE stream as the "sensor") ─────────

    @staticmethod
    def generate_raw_field(n: int = 256, seed: int | None = None) -> np.ndarray:
        """
        Produce a synthetic raw vector field of shape (n, 3).

        Intentionally injects noise, spikes, and degenerate rows so that the
        sanitise pipeline is exercised on every real stream frame.
        """
        rng = np.random.default_rng(seed)

        # base field — sinusoidal with noise
        t = np.linspace(0, 2 * math.pi, n, dtype=np.float32)
        field = np.column_stack([
            np.sin(t) + rng.normal(0, 0.05, n).astype(np.float32),
            np.cos(t) + rng.normal(0, 0.05, n).astype(np.float32),
            np.sin(2 * t) * 0.5 + rng.normal(0, 0.02, n).astype(np.float32),
        ])

        # deliberate corruption (5 % of rows)
        corrupt_idx = rng.choice(n, size=max(1, n // 20), replace=False)
        for i, idx in enumerate(corrupt_idx):
            kind = i % 4
            if kind == 0:
                field[idx] = np.nan          # NaN row
            elif kind == 1:
                field[idx] = np.inf          # Inf row
            elif kind == 2:
                field[idx, 0] = 1.5e7        # magnitude spike
            else:
                field[idx] = 0.0             # null vector

        return field


# ──────────────────────────────────────────────────────────────────────────────
# Standalone 17-point verification battery
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    # Force UTF-8 output on Windows when the terminal supports it;
    # fall back silently so the script never crashes on encoding alone.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        pass

    engine = IYEMathEngine()
    sanitize = engine.sanitize_vector_field
    passed = 0

    def _assert(condition: bool, label: str) -> None:
        global passed
        if not condition:
            print(f"  [FAIL] {label}", file=sys.stderr)
            sys.exit(1)
        print(f"  [PASS] {label}")
        passed += 1

    print("\n== IYE Math Engine -- 17-Point Assertion Battery ==\n")

    # ── Test 1: all-NaN input → all-finite output ─────────────────────────────
    inp = np.full((8, 3), np.nan)
    out, healed = sanitize(inp)
    _assert(np.all(np.isfinite(out)), "T01: all-NaN → all-finite")
    _assert(healed,                   "T01: all-NaN → healed flag True")

    # ── Test 2: all-Inf input ─────────────────────────────────────────────────
    inp = np.full((4, 3), np.inf)
    out, healed = sanitize(inp)
    _assert(np.all(np.isfinite(out)), "T02: all-Inf → all-finite")

    # ── Test 3: all-(-Inf) input ──────────────────────────────────────────────
    inp = np.full((4, 3), -np.inf)
    out, healed = sanitize(inp)
    _assert(np.all(np.isfinite(out)), "T03: all-(-Inf) → all-finite")

    # ── Test 4: dtype coercion from int64 ─────────────────────────────────────
    inp = np.ones((5, 3), dtype=np.int64)
    out, _ = sanitize(inp)
    _assert(out.dtype == np.float32, "T04: int64 input → float32 output")

    # ── Test 5: dtype coercion from float64 ───────────────────────────────────
    inp = np.ones((5, 3), dtype=np.float64)
    out, _ = sanitize(inp)
    _assert(out.dtype == np.float32, "T05: float64 input → float32 output")

    # ── Test 6: magnitude clamp applied ───────────────────────────────────────
    inp = np.zeros((3, 3), dtype=np.float32)
    inp[1] = [2.0e7, 0.0, 0.0]   # exceeds ceiling
    out, healed = sanitize(inp)
    norm_spiked = float(np.linalg.norm(out[1]))
    _assert(abs(norm_spiked - MAGNITUDE_CEILING) < 1.0,
            "T06: magnitude spike clamped to MAGNITUDE_CEILING")
    _assert(healed, "T06: healed flag True on spike")

    # ── Test 7: sign preservation in clamp ────────────────────────────────────
    inp = np.zeros((1, 3), dtype=np.float32)
    inp[0] = [-3.0e7, 0.0, 0.0]  # negative spike
    out, _ = sanitize(inp)
    _assert(out[0, 0] < 0, "T07: sign preserved during magnitude clamp")

    # ── Test 8: all-zero row → epsilon nudge ─────────────────────────────────
    inp = np.zeros((4, 3), dtype=np.float32)
    out, healed = sanitize(inp)
    _assert(np.all(out[:, 0] == EPSILON_NUDGE),
            "T08: all-zero rows nudged to epsilon on vx")
    _assert(healed, "T08: healed flag True on null vectors")

    # ── Test 9: epsilon nudge only on vx, not vy/vz ──────────────────────────
    inp = np.zeros((1, 3), dtype=np.float32)
    out, _ = sanitize(inp)
    _assert(out[0, 1] == 0.0 and out[0, 2] == 0.0,
            "T09: vy and vz remain 0.0 after epsilon nudge")

    # ── Test 10: clean input passes through unmodified ────────────────────────
    inp_clean = np.array([[1.0, 2.0, 3.0],
                           [4.0, 5.0, 6.0]], dtype=np.float32)
    out, healed = sanitize(inp_clean)
    _assert(not healed,          "T10: clean input → healed flag False")
    _assert(np.allclose(out, inp_clean),
            "T10: clean input → data unchanged")

    # ── Test 11: integer overflow (Python int) ────────────────────────────────
    inp = np.array([[10**18, 10**18, 10**18]], dtype=np.float64)
    out, healed = sanitize(inp)
    _assert(np.all(np.isfinite(out)), "T11: int-overflow row → finite")

    # ── Test 12: mixed valid/corrupt rows ─────────────────────────────────────
    inp = np.array([[1.0,  2.0,  3.0],
                    [np.nan, 0.0, 0.0],
                    [5.0, 5.0, 5.0],
                    [0.0, 0.0, 0.0]], dtype=np.float32)
    out, healed = sanitize(inp)
    _assert(np.isfinite(out[1, 0]),   "T12: NaN in mixed row → healed to finite")
    _assert(np.isclose(out[3, 0], EPSILON_NUDGE),
            "T12: null row in mixed field → nudged")
    _assert(healed, "T12: mixed input → healed flag True")

    # ── Test 13: rank-1 input (single vector) promoted ────────────────────────
    inp = np.array([1.0, 2.0, 3.0])
    out, _ = sanitize(inp)
    _assert(out.shape == (1, 3), "T13: rank-1 input promoted to (1,3)")

    # ── Test 14: single-coordinate Inf spike ─────────────────────────────────
    inp = np.array([[0.0, np.inf, 0.0]], dtype=np.float32)
    out, healed = sanitize(inp)
    _assert(np.isfinite(out[0, 1]), "T14: single inf coordinate → finite")

    # ── Test 15: large clean field (stress) ──────────────────────────────────
    rng = np.random.default_rng(42)
    inp = rng.standard_normal((100_000, 3)).astype(np.float32)
    out, healed = sanitize(inp)
    _assert(np.all(np.isfinite(out)),
            "T15: large clean field (100k vectors) → all finite")
    _assert(not healed, "T15: large clean field → healed flag False")

    # ── Test 16: all rows exceed ceiling ──────────────────────────────────────
    inp = np.full((10, 3), 1.0e9, dtype=np.float32)
    out, healed = sanitize(inp)
    norms = np.linalg.norm(out, axis=1)
    _assert(np.all(norms <= MAGNITUDE_CEILING + 1.0),
            "T16: all spike rows clamped ≤ MAGNITUDE_CEILING")
    _assert(healed, "T16: all-spike field → healed flag True")

    # ── Test 17: output is always a new array (non-destructive) ──────────────
    inp = np.array([[np.nan, np.nan, np.nan]], dtype=np.float32)
    original_val = inp[0, 0]
    out, _ = sanitize(inp)
    _assert(np.isnan(inp[0, 0]),
            "T17: input array not mutated (non-destructive contract)")

    print(f"\n[OK] All {passed}/17 assertions passed. Engine is green.\n")
