# IYE Idealization Pass — Final Report

Six commits on `main`, phase by phase, each gated before moving on:

```
8259676 fix: exclude HDBSCAN noise points from temporal velocity/drift centroid math   (pre-existing)
345e92c feat: add interactive 3D hover tooltips for anomaly beacons                     (pre-existing)
cb84670 audit: temporal engine statistical gates + calibration restoration             (Phase 0)
5b43d02 hardening: broadcast backpressure, narrative task lifecycle, ollama resilience  (Phase 1)
309ef7e test: frontend suite for WS protocol, pulse math, diagnostics                   (Phase 2)
38f35a6 feat: acceleration readout + tooltip narrative-pending state                    (Phase 3)
8c99827 chore: docs, protocol spec, lint/format baseline                                (Phase 4a)
908e327 style: apply ruff/prettier formatting                                          (Phase 4b)
```

## One correction to the brief before the numbers

Phase 0 framed the temporal engine's calibration as something "lost during
integration." That's not accurate: `temporal_engine.py` was built from
scratch two sessions before this pass, per an explicit "build it from
scratch" instruction — there was no earlier latching/hysteresis design to
restore. This report treats the request as "add real statistical
calibration," not "restore," and the numbers below are measured from the
engine as it actually existed at the start of this pass.

---

## Phase 0 — Statistical audit + calibration

Script: `backend/tests/audit_temporal_noise.py`. Full before/after detail
(including the exact root-cause analysis) is in
[`docs/temporal_calibration.md`](temporal_calibration.md); summary:

| Gate | Before | After | Threshold |
|---|---|---|---|
| Hot-regime frame rate (2000 nominal frames) | 9.35% | **1.20%** | < 2% |
| Distinct false latch events | 136 | **4** | (report only) |
| Velocity exceedance | 6.80% | **0.75%** | < 3% |
| Acceleration exceedance | 0.00% | **0.65%** | < 3% |
| Drift exceedance | 4.75% | **0.00%** | < 3% |
| Spike latches within debounce window | pass | pass | — |
| Releases within ~10 nominal frames after recovery | **fail** (still hot at frame 10) | **pass** (stable by frame 9) | — |
| Slow drift (140 frames) detected as `drift` | pass | pass | — |

Root causes found and fixed: absolute (non-normalized) thresholds;
`velocity = distance/dt` that blows up for any two frames arriving close in
time regardless of dt; a `drift_slope` baseline that was a plain rolling
mean computed *after* appending the frame under test (self-contamination,
and a single outlier stayed baked into the mean for up to 50 frames); no
hysteresis, so a single noisy frame could flip the regime label. Fixed with
sigma-normalized first/second differences, an EMA-smoothed noise-scale
estimate, a Theil-Sen (median-of-pairwise-slopes) robust drift trend, and
enter(2)/release(6)-frame hysteresis. Field names and `process_frame()`'s
signature are unchanged — only the internal computation.

## Phase 1 — Hot-path and protocol hardening

**Decoupling gate — verified by inspection**, `backend/app/api/main.py`:
```
260:    temporal_metrics = temporal_engine.process_frame(...)
...
284:    await hub.broadcast(payload)
...
290:        _spawn_narrative_task(frame_id, metrics_summary)
```
No `await` on `generate_anomaly_explanation` between the temporal engine
call and `hub.broadcast`. It only appears inside `_narrate` (line 176),
scheduled via `asyncio.create_task` *after* the broadcast, never awaited on
the request path. This was previously violated — the original code awaited
the Ollama call before building the payload at all, blocking every anomaly
response on the LLM round-trip (up to the 10s timeout). Anomaly frames now
broadcast immediately with `explanation: null`; the narrative arrives on its
own `{"type": "narrative", "id": ...}` message.

Other Phase 1 changes:
- `StreamHub.broadcast_text`: fans out to all clients concurrently
  (`asyncio.gather`) with a 2s per-client timeout — a slow/dead client is
  dropped as stale instead of stalling the others. Verified with a unit test
  using a fake WebSocket whose `send_text` never resolves
  (`test_broadcast_hub.py`): delivery to a healthy client completed in
  ~2.37s (bounded by the timeout), not the fake client's 7s hang.
- Narrative tasks: capped at 4 concurrent (semaphore), cancelled cleanly on
  shutdown via FastAPI's `lifespan` (replacing the deprecated `on_event`
  hook) — verified directly (`test_narrative_lifecycle.py`), not just by
  running the app and hoping.
- `VectorFramePayload.explanation` widened `str` → `Optional[str]`
  (additive relaxation, not a removal) so the null-until-narrative-arrives
  state is representable; the frontend's REST type guard was updated to
  match.
- Schema tests confirm additive fields (`id`/`type`/`temporal`) are present
  and that a Pydantic model shaped like the pre-temporal-engine contract
  (`extra="ignore"`) still validates today's payload.

**Known gap, reported honestly**: an end-to-end "narrative arrives as a
separate WS message" test was attempted via Starlette's `TestClient`
(`websocket_connect` + `post`) and hangs indefinitely — each `TestClient`
call runs the ASGI app on a short-lived event loop torn down as soon as the
HTTP response returns, before the fire-and-forget `asyncio.create_task`
narrative task ever gets scheduled. This is a `TestClient` artifact, not a
production bug: verified manually against a real running `uvicorn` process
with a real `websockets` client —
```
POST status 200
frame_id 25996cde-...
frame message: frame explanation= None
narrative message: {'type': 'narrative', 'id': '25996cde-...', 'explanation': 'Telemetry Alert: ...'}
```
The comment explaining this is left in `test_schema_compat.py` in place of
the hanging test, rather than deleting the evidence of the attempt.

## Phase 2 — Frontend test suite

Set up Vitest + `@testing-library/react` (jsdom). 24 tests added (27 total
by the end of Phase 3):
- `useVectorStream.test.ts` (10): a scripted mock `WebSocket` drives
  connection status transitions, frame updates, narrative matched-id merge,
  stale-id → `narrativeHistory`, out-of-order delivery (narrative before any
  frame), malformed JSON, and reconnect-with-backoff.
- `VectorViewport.pulse.test.ts` (9, later 12): extracted
  `computeBeaconPulseFrequencyHz`/`computeBeaconPulseAmplitude` into pure
  exported functions and tested their clamps/monotonicity.
- `DiagnosticSidebar.test.tsx` (5): renders a fixture frame and asserts the
  temporal readouts format correctly.

**Writing the narrative-merge test caught a real bug**, not a false alarm:
```ts
setLiveFrame((prev) => {
  if (prev && narrId !== null && prev.id === narrId) {
    matchedCurrentFrame = true   // <- this closure flag
    return { ...prev, explanation: narrText }
  }
  return prev
})
if (!matchedCurrentFrame) { ... }   // <- read immediately after, same tick
```
React's `setState` updater form is not guaranteed to run synchronously —
`matchedCurrentFrame` was read before React ever called the updater, so it
was always `false`, and *every* narrative (matched or not) was leaking into
`narrativeHistory` in addition to being merged correctly. Fixed with a
`liveFrameRef` mirrored synchronously on every frame update, so the
match decision no longer depends on `setState` timing.

## Phase 3 — UI gaps closed

- `acceleration` readout added to `DiagnosticSidebar` (2 decimals, same
  style as the other four), with a test.
- Extracted the tooltip/terminal "analyzing…" fallback into a shared pure
  function `resolveExplanationDisplay(status, explanation)`, unit-tested for
  the NOMINAL / pending / resolved cases (3 tests).
- Verified by inspection that `AnomalyBeacon`'s `useFrame` callback never
  references `hovered`/`setHovered` — only the `onPointerOver`/
  `onPointerOut` handlers do — so the tooltip's `<Html>` DOM only
  mounts/unmounts on actual pointer events, not on every animation tick.
  (Full R3F/WebGL render-count testing would need `@react-three/test-renderer`,
  not installed; this is inspection-based verification, same method as the
  Phase 1 decoupling check, not a jsdom-executed test.)

## Phase 4 — Docs, DX, consistency

**Created**: `README.md` (rewritten), `docs/protocol.md`, `boot.sh`
(verified: starts both services, health-checked both ports, cleans up on
exit), `frontend/.eslintrc.cjs`, `frontend/.prettierrc.json`,
`frontend/.prettierignore`, `backend/pyproject.toml` `[tool.ruff]` section.

**Deleted (grep-verified unreferenced)**:
- `backend/app/main.py` — an orphaned pre-refactor duplicate of
  `app/api/main.py` (matches the old StreamHub/no-TemporalEngine shape).
  `backend/main.py`'s uvicorn wrapper targets `app.api.main:app`, not this
  file; no test or doc referenced it.
- `frontend/src/canvas/Scene.tsx`, `canvas/index.ts`, `canvas/math/matrix.ts`,
  `canvas/math/useCoordinateTransform.ts` — a self-contained dead cluster
  (a barrel file and the scene it exported, from before `VectorViewport.tsx`
  became the real canvas). Confirmed via grep across the whole frontend
  tree, not just `src/canvas`; the production bundle size was byte-identical
  before/after deletion, consistent with them never having been imported.
- No leftover mock-data override loops found this pass — the one that
  existed (`VectorViewport.tsx`'s "TACTICAL OVERRIDE" block that discarded
  real WS data in favor of random points) was already removed in an earlier
  session, before this idealization pass began.

**Fixed while setting up lint** (small, lint-driven, not scope creep):
- `App.tsx`: `ViewportPanel` received an `activeFrame: any` prop it never
  used — removed the prop and the `any`.
- `useVectorDiagnostics.ts`: `processVectors`'s `useCallback` closed over
  `activePort` with an empty dependency array — a real staleness bug (a
  REST upload after a port fallback would keep hitting the original port
  forever). Added `activePort` to the deps.
- `backend/app/api/__init__.py`: removed an unused `ws_app` import.
- Added `httpx` as an explicit backend dependency (`pyproject.toml` +
  `requirements.txt`) — `main.py` imports it directly for the Ollama call,
  but it was only ever present transitively via FastAPI's test client. A
  clean install without test extras would have failed at runtime.
- `react/no-unknown-property` disabled in ESLint config, with a comment:
  react-three-fiber's custom JSX elements/props (`<mesh>`, `args`, `attach`,
  ...) read as false positives under plain `eslint-plugin-react`, which
  doesn't know about R3F's reconciler.
- Two targeted `eslint-disable` comments (not blanket rule suppressions),
  each with an inline reason: (1) `connect`/`scheduleReconnect` in
  `useVectorStream.ts` are intentionally mutually recursive — adding the
  "missing" dependency would create a re-creation cycle instead of fixing
  anything; (2) the literal `//` in `VectorViewport.tsx`'s HUD-style
  "POINTS: {n} // STREAM: {state}" display text is not a stray JS comment.

**Mechanical formatting** (`ruff check --fix`, `prettier --write`) committed
separately (`908e327`) from all of the above — verified tsc/eslint/vitest/
build/pytest all green both before and after, plus a live browser check that
`VectorViewport`'s canvas (880 changed lines, pure reformatting) renders
identically.

---

## Verification summary (current `main`)

| Check | Result |
|---|---|
| `pytest tests/` (backend) | 21 passed |
| `ruff check .` (backend) | All checks passed |
| `tsc --noEmit` (frontend) | clean |
| `eslint . --max-warnings 0` (frontend) | clean |
| `vitest run` (frontend) | 27 passed |
| `vite build` (frontend) | clean |
| `boot.sh` | starts both services, both health-checked |

## Remaining known gaps (deliberately not touched, and why)

1. **No automated end-to-end narrative-delivery test.** Covered by manual
   verification against a live server instead (Phase 1). Building one
   properly would mean either spinning up a real `uvicorn` subprocess per
   test (heavier machinery than justified for one assertion) or adopting a
   different WS-testing library — a real option, just out of scope for
   "small and surgical."
2. **Canvas components aren't memoized.** `temporalRef` avoids re-rendering
   from 60fps *temporal ticks*, but `VectorViewport`'s component tree
   (`InstancedCoreNodes`, `ClusterHulls`, `AnomalyBeacon`, etc.) still
   re-renders on every WS `frame` message because none of them are wrapped
   in `React.memo`. Not a correctness bug — R3F's `useFrame` animation is
   independent of React's render cycle — but it's unrealized performance
   headroom under a high frame-arrival rate.
3. **`TemporalEngine` calibration is synthetic, not measured.** Thresholds
   are derived from a documented synthetic nominal model (fixed Gaussian
   sigma, fixed 1.0s cadence, 16 points/frame) because no production
   telemetry exists yet. Flagged explicitly in `docs/temporal_calibration.md`
   as needing re-validation once real traffic shape is known.
4. **1MB frontend bundle**, unchanged by this pass — Vite's own build
   warning about chunk size. Code-splitting wasn't in scope for any phase
   here.
5. **`react/no-unknown-property` is off repo-wide**, not scoped to
   `canvas/`. Given nearly everything under `frontend/src/canvas/` uses R3F
   JSX, a directory-scoped override would have added config complexity for
   little practical gain — but a stray real unknown-DOM-property typo
   outside the canvas tree would now go uncaught.

## Three highest-value next steps

1. **Wrap the canvas subtree in `React.memo`** (gap #2) — the most direct
   way to make good on the ref-based design's actual performance promise
   under a fast live stream, and it's a small, mechanical change now that
   the components' prop shapes are stable.
2. **Re-run `audit_temporal_noise.py` against real telemetry** as soon as
   any exists, and update the thresholds in `temporal_engine.py` +
   `docs/temporal_calibration.md` accordingly (gap #3) — the current
   calibration is honest about being synthetic, but it's the single biggest
   risk to the anomaly-detection quality claims in production.
3. **Solve the end-to-end narrative-delivery test gap properly** (gap #1) —
   either a lightweight real-subprocess integration test or adopting an
   async-native WS test client, so the decoupling behavior has automated
   coverage instead of relying on a manual transcript in this report.

---

# 2026-07-05 — Follow-up sprint: performance headroom, calibration harness, e2e closure

Four commits on `main`, each phase gated green, closing gaps #1, #2, #4 and
recommended step #1 from the section above:

```
39e0087 perf: memoize canvas subtree with stable prop identities + render-count proof
527b26d feat: telemetry capture mode + replay calibration harness with shared metrics core
8ab0d54 test: hermetic end-to-end narrative delivery over real websocket
4ab26b6 perf: vendor-split three/r3f + lazy viewport behind design-system fallback
```

**Precondition note**: this sprint's precondition ("git status clean, main in
sync with origin/main") initially failed — the 7 commits from the section
above were still local, unpushed. Stopped and asked before touching
anything; pushed on explicit instruction, then proceeded.

## Phase 1 — Canvas render headroom (closes gap #2)

**Root cause found before any component wrapping**: every WS `frame` message
legitimately carries a new `timestamp`/`temporal` payload, but
`setPositions`/`setAnomalyIndices` handed out a fresh `Float32Array`/array
identity on *every* message regardless of whether `coordinates`/
`cluster_labels`/`anomaly_indices` actually changed. Wrapping components in
`React.memo` first would have been a no-op — memo's shallow comparison
would see a "different" prop every time. Fixed in `useVectorStream.ts`
first (a `numberArrayEqual` reuse-on-equality check, cached via refs), *then*
wrapped `InstancedCoreNodes`, `ClusterHulls`, `TracerLines`, `AnomalyBeacons`,
`AnomalyBeacon` in `React.memo`, plus fixed the two remaining unstable
props that would have defeated the wrap anyway: `VectorViewport`'s
`tooltipInfo` (fresh object literal every render → `useMemo`'d on `liveFrame`
identity) and each beacon's `[x,y,z]` position tuple (fresh array literal
per beacon per render → memoized alongside the filtered anomaly list).

`onPointerOver`/`onPointerOut` were deliberately left as plain inline
closures per the phase's own instruction ("useCallback only where they
currently break memoization") — they're attached to `AnomalyBeacon`'s own
JSX, not passed to a further memoized child, so wrapping them would change
nothing.

**Proof, not claim** — two layers, with the jsdom/R3F boundary stated
explicitly rather than glossed over:
- `useVectorStream.test.ts` (+2 tests, 12 total): the hook reuses
  `positions`/`anomalyIndices`/`liveFrame.cluster_labels` references across
  two value-identical frames, and produces new references when values
  actually change.
- `VectorViewport.memo.test.tsx` (2 tests, new file): proves the
  `React.memo` mechanism itself (skip on same references, re-render on new
  ones) using a jsdom-safe DOM stand-in with the identical prop shapes
  (`Float32Array` + parallel `number[]`). The real R3F components
  (`<mesh>`, `<instancedMesh>`, ...) cannot mount under jsdom — no
  `@react-three/test-renderer` is installed, judged out of scope for
  proving this one property. Documented in both the test file and here.

Manually verified against a live mock WS server: canvas renders identically
(hulls, tracers, beacon), hover tooltip still works after the memoization.

**Frontend suite**: 27 → 31 tests (4 new).

## Phase 2 — Real-telemetry capture & replay harness (closes gap #3)

- `backend/app/api/capture.py`: `IYE_CAPTURE_PATH` env var read once at
  import time (zero file I/O when unset beyond a `None` check). Verified
  manually: 3 POSTs with the env var set produced exactly 3 well-formed
  JSONL lines matching the documented schema.
- `backend/tools/replay_calibration.py`: replays a capture through
  `TemporalEngine()` — imported from the same module `main.py` uses, no
  copy-pasted constructor args — using recorded timestamps for `dt` (no
  wall-clock sleep). Reports the same gate metrics as
  `audit_temporal_noise.py` plus p50/p95/p99/max histograms per channel.
- `backend/tools/calibration_metrics.py`: the metric-accounting core
  (`CalibrationMetrics`) extracted out of `audit_temporal_noise.py` and
  shared by both tools. **Verified the refactor was behavior-preserving**:
  re-ran the audit before/after — byte-identical numbers (1.20% hot rate,
  4 latch events, 0.75%/0.65%/0.00% per-channel exceedance, all three gates
  still PASS).
- Tests (`test_replay_calibration.py`, 4 new): a fixture built with the
  audit's exact seed (42) and generation order reproduces its hot rate
  *exactly* — `0.0120`, not just "within tolerance" — because it's the same
  deterministic RNG sequence through the same engine. A fixture with an
  injected spike is correctly detected (`latch_events >= 1`, a hot regime
  in the final 6 frames). Missing/empty capture files fail cleanly with a
  clear stderr message, not a traceback.
- `docs/temporal_calibration.md` got the full recalibration runbook
  (capture → replay → read histograms → adjust thresholds → re-run both
  gates).

**Backend suite**: 21 → 25 tests (4 new), `ruff check .` clean throughout.

## Phase 3 — Hermetic end-to-end narrative test (closes gap #1)

Took the preferred approach: a real `uvicorn` subprocess on an ephemeral
port (found via a bind-to-0 socket probe), health-polled via `/api/health`
(15s deadline), a real `websockets` client against the real `/stream`
endpoint. `OLLAMA_API_URL` was made overridable via env var (defaulted to
the real address — additive, non-breaking) and pointed at a tiny stdlib
`http.server` stub on its own ephemeral port returning a canned completion
— the test passes with **no Ollama installed**.

This directly supersedes the TestClient attempt from the section above:
same root cause identified there (TestClient tears down its event loop
before the fire-and-forget `asyncio.create_task` narrative task ever gets
scheduled) now has a real fix instead of a documented limitation — a real
`uvicorn` process has one persistent event loop for its whole lifetime,
matching production exactly.

**Flake check**: ran 3 consecutive times, 3/3 passed, ~1.6–1.8s each.

Marked `@pytest.mark.e2e` (registered in `pyproject.toml`), included in the
default `pytest` run, skippable via `pytest -m "not e2e"`. Removed the old
explanatory comment from `test_schema_compat.py`, replaced with a pointer
to this test.

**Backend suite**: 25 → 26 tests (1 new, but it's the one that mattered).

## Phase 4 — Bundle split (closes gap #4)

`vite.config.ts`: `manualChunks` isolates `three` + `@react-three/*` into a
named `vendor-3d` chunk; `App.tsx`'s `VectorViewport` is now
`React.lazy()`-loaded behind a `Suspense` boundary whose fallback follows
the frozen design system exactly (pitch black, lowercase Courier New,
`rgba(255,182,193,0.35)` — the same blush-pink-at-low-opacity value already
used elsewhere in that file, no new color introduced).

| | Before | After |
|---|---|---|
| Initial JS | 1,018.11 kB / 282.55 kB gzip (one bundle) | **18.51 kB / 6.16 kB gzip** (`index-*.js`) |
| Lazy viewport chunk | — | 8.13 kB / 3.07 kB gzip (`VectorViewport-*.js`) |
| Lazy vendor chunk | — | 993.33 kB / 275.19 kB gzip (`vendor-3d-*.js`) |
| Build warnings | 1 (chunk size) | 0 |

Initial bundle gate (**< 300 kB gzipped**): passed by a wide margin (6.16 kB).
`chunkSizeWarningLimit` was raised specifically for `vendor-3d`, since its
size is now deliberate and already isolated from the initial load path —
not silencing a real problem, acknowledging a solved one.

**Honest gap**: the manual check ("confirm the lazy boundary doesn't flash
or break the 70/30 layout") was only partially achievable via automated
browser capture. Live-preview screenshots confirmed the *final* rendered
state is pixel-identical to before (hulls, tracers, beacons, hover tooltip,
70/30 split all intact) and that `vendor-3d` is genuinely requested as a
separate network resource. But the *transient* Suspense fallback frame
itself resisted reliable automated capture: Vite emits a
`<link rel="modulepreload">` hint for `vendor-3d` in `index.html`, causing
the browser to start fetching it in parallel immediately, and repeated
attempts to force-delay it (Playwright route interception with 1.2–3s
artificial delays, CDP network throttling to 500kbps/200ms latency, 50ms-
granularity polling) never caught the fallback text rendered — the real
component appeared to mount before any delayed response should have
resolved, which was not fully root-caused in the time available. Rather
than ship an unreliable/flaky browser test or just assert "it probably
works," `App.suspense.test.tsx` proves the underlying `React.lazy`/
`Suspense` mechanism directly in jsdom with a manually-deferred dummy
import — same "prove the mechanism, document the render boundary" pattern
as `VectorViewport.memo.test.tsx` in Phase 1. The wiring in `App.tsx` is a
textbook-correct, standard use of both APIs; what's unproven automatically
is specifically the *timing interaction* with Vite's modulepreload
optimization on a real network, not the React mechanism itself.

**Frontend suite**: 31 → 32 tests (1 new).

## Full verification, this sprint's final state

| Check | Result |
|---|---|
| `pytest tests/` (backend, includes the new e2e test) | 26 passed |
| `ruff check .` (backend) | All checks passed |
| `tsc --noEmit` (frontend) | clean |
| `eslint . --max-warnings 0` (frontend) | clean |
| `vitest run` (frontend) | 32 passed |
| `vite build` (frontend) | clean, 0 warnings |
| Manual: live mock-WS canvas render + hover tooltip | confirmed identical |
| Manual: production preview bundle load + layout | confirmed identical |

## Files touched this sprint

**Created**: `frontend/src/canvas/VectorViewport.memo.test.tsx`,
`backend/app/api/capture.py`, `backend/tools/__init__.py`,
`backend/tools/calibration_metrics.py`, `backend/tools/replay_calibration.py`,
`backend/tests/test_replay_calibration.py`,
`backend/tests/test_e2e_narrative.py`, `frontend/src/App.suspense.test.tsx`.

**Modified**: `frontend/src/canvas/math/useVectorStream.ts` (+test file),
`frontend/src/canvas/VectorViewport.tsx`, `backend/tests/audit_temporal_noise.py`
(refactored onto the shared metrics core, verified behavior-preserving),
`backend/app/api/main.py` (capture wiring + `OLLAMA_API_URL` env override),
`backend/pyproject.toml` (`e2e` marker, `websockets` dev dependency),
`backend/tests/test_schema_compat.py` (stale comment removed),
`docs/temporal_calibration.md` (recalibration runbook),
`frontend/vite.config.ts`, `frontend/src/App.tsx`.

## Remaining known gaps (deliberately not touched, and why)

1. **The Suspense fallback's interaction with Vite's modulepreload
   optimization is unproven under real network timing** (see Phase 4 above)
   — the mechanism is proven in isolation, the code is standard/correct by
   inspection, but the specific browser-timing question wasn't fully
   root-caused. Next step if revisited: try Playwright's
   `context.route` at the `browserContext` level before any page exists, or
   disable modulepreload via a Vite plugin option to test the "cold" path
   directly.
2. **`TemporalEngine` calibration is still synthetic.** The capture/replay
   harness now exists specifically to close this the moment real telemetry
   is available — see the runbook in `docs/temporal_calibration.md`. Until
   then, the thresholds remain a documented estimate, not a measurement.
3. **The e2e test only covers the anomaly/narrative path**, not e.g.
   concurrent-narrative-storm behavior against the semaphore cap (Phase 1
   of the earlier idealization pass unit-tested the semaphore's existence
   and the cancellation lifecycle, but not an end-to-end multi-anomaly
   burst). Judged out of scope for "closing gap #1" specifically, which was
   about the single-narrative decoupling contract.
4. **Bundle size**: `vendor-3d` itself (993 kB / 275 kB gzip) is unchanged
   and un-shrunk — the gate was about the *initial* bundle, not this
   library's absolute size. Further reduction would mean a different 3D
   library or a lighter subset of three.js/drei, out of scope here.

## Commits ready for review

```
39e0087 perf: memoize canvas subtree with stable prop identities + render-count proof
527b26d feat: telemetry capture mode + replay calibration harness with shared metrics core
8ab0d54 test: hermetic end-to-end narrative delivery over real websocket
4ab26b6 perf: vendor-split three/r3f + lazy viewport behind design-system fallback
```

All local on `main`, not pushed, per instruction.
