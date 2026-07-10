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

---

# 2026-07-07 — Sprint: upload-to-insight (file pipeline, error states, narrative surfacing)

## Phase 0 — Upload path trace (as found, before this sprint)

**The reported bug**: dropping `package.json` into the DATA SOURCE panel produced
no visible reaction — no error, no state change, the previously-rendered scene
stayed exactly as it was.

**What the code actually did, traced end to end:**

1. `FileDropZone` (`frontend/src/App.tsx`) never inspected the file's
   extension or content at all. `processFile` read *any* dropped file with
   `FileReader.readAsArrayBuffer`, then did:
   ```ts
   onFileData(new Float32Array(buffer))
   ```
   This reinterprets the file's raw bytes as IEEE-754 32-bit floats,
   unconditionally — regardless of whether the file was `.csv`, `.json`,
   `.npy`, or `.bin`. There was, and is (before this sprint), **no CSV
   parser, no JSON parser, and no NPY parser anywhere in the frontend**
   (verified by grep — the only `JSON.parse` calls in the whole `canvas/`
   tree are for WebSocket *message* framing in `useVectorStream.ts`, unrelated
   to file content). The `accept=".json,.csv,.npy,.bin"` on the file input
   and the "json · csv · npy · bin" label text were UI copy with nothing
   behind them.
2. `new Float32Array(buffer)` **throws a synchronous `RangeError`** if the
   source `ArrayBuffer`'s byte length is not a multiple of 4 — and it throws
   *inside* `FileReader.onload`, a callback with no surrounding `try`/`catch`
   anywhere in the call chain. An uncaught exception thrown inside a
   `FileReader` event handler is reported to the browser console and
   otherwise swallowed — `onFileData` (and therefore `processVectors`) is
   never invoked. This is almost certainly exactly what happened with
   `package.json`: nothing ran, nothing changed, because the crash happened
   before any application code got a chance to react.
3. Even in the (less common) case where a dropped text file's byte length
   happens to be a multiple of 4, the result is not "no numeric data" — it's
   *garbage* numeric data (ASCII bytes bit-reinterpreted as floats, mostly
   large magnitudes, subnormals, or `NaN`). That garbage was then handed to
   `processVectors`, which POSTs it to `/api/canvas/vectors` with **no
   `dim` field at all** — silently relying on the backend's `dim=6` default.
   If the garbage float count isn't divisible by 6, the backend correctly
   responds `400`. But `processVectors`'s catch block only does
   `console.error(...)`; `isProcessing` is reset and nothing else changes —
   this is the second, independent way to reach "no error, no state change."
4. There is no `rejected`/`error`/`partial` UI state anywhere in this path.
   `FileDropZone` only ever tracked `droppedFile` (name/size for display) and
   `isDragging` — cosmetic state, not pipeline state. `useVectorDiagnostics`
   does track `isProcessing`, but nothing renders it.

**Does uploaded data reach the backend pipeline (UMAP → HDBSCAN → Z-score →
`TemporalEngine` → narrative) at all, when it does succeed?** Yes — and this
was the one genuinely correct part of the existing design. `processVectors`
already POSTs to the same `/api/canvas/vectors` route the SDK/live stream
uses; `ingest_and_broadcast` runs the identical pipeline regardless of
caller and ends with `await hub.broadcast(payload)`, fanning the resulting
frame out to *every* connected `/stream` client. Because the frontend
already holds an open `/stream` WebSocket connection at all times (opened
unconditionally on mount, independent of any upload), a successful REST
upload's resulting frame arrives back at the very same browser tab as a
normal WS `frame` message — carrying the real `TemporalEngine` output and,
if `status: "ANOMALY"`, followed by an async `narrative` message exactly
like any other anomaly. `useVectorDiagnostics`'s own `restFrame` state (built
from the raw REST response, with `temporal` overwritten by
`DEFAULT_TEMPORAL_METRICS`) is effectively shadowed the moment that WS frame
lands, because `isLive = liveFrame !== null && streamState === 'connected'`
flips true and `activeFrame = isLive ? liveFrame : restFrame` prefers it.
**Conclusion**: the "uploaded datasets never produce narratives" symptom in
the bug report is very likely a *downstream consequence* of finding #1-#3
above, not a separate narrative-routing bug — no upload has ever actually
delivered valid numeric data to the backend to exercise that path. This
sprint's Phase 3 gate re-verifies this conclusion live rather than assuming
it.

**One more thing found while tracing, noted but not fixed this sprint**
(out of scope — not the reported bug, not blocking it): `VectorViewport.tsx`
calls `useVectorStream()` directly and independently from
`useVectorDiagnostics` (which also calls `useVectorStream()` internally for
the sidebar) — two separate WebSocket connections to `/stream` per page
load, each with its own reconnect/backoff state. Both receive the same
server-side broadcasts, so this doesn't currently cause incorrect behavior,
just an unnecessary duplicate connection. Flagged as a future cleanup, not
touched here per "no rewrites of working code."

## Phase 1 — Real parsers + full pipeline routing

New file `frontend/src/canvas/upload/parseMatrix.ts` — dependency-free,
pure-function parsers, each returning a `ParseOutcome` (`{kind:'ok', matrix}`
or `{kind:'rejected', reason}`):
- `parseCsvMatrix` — splits lines/commas, detects an optional non-numeric
  header row, keeps only columns that are numeric across *every* row
  (drops the rest), drops malformed/ragged rows, reports exact
  `droppedColumns`/`droppedRows` counts. Chunked: yields to the event loop
  every 2000 rows via a `setTimeout(0)` boundary so a large CSV cannot
  freeze the UI thread.
- `parseJsonMatrix` — accepts an array of arrays or an array of flat numeric
  objects; for objects, keeps only keys numeric across every row (same
  column-drop semantics as CSV). A bare object (exactly what `package.json`
  is) fails the `Array.isArray` check immediately and is `rejected`.
- `parseNpyMatrix` — hand-rolled `.npy` header parser (magic bytes, version,
  header dict regex for `descr`/`fortran_order`/`shape`), supporting the
  common little-endian numeric dtypes (`f8`,`f4`,`i8`,`i4`,`i2`,`i1`,`u8`,
  `u4`,`u2`,`u1`). Rejects Fortran-order arrays and non-2D shapes explicitly
  rather than mis-parsing them.
- `parseFile(file)` dispatches on extension; anything else (including now
  `.bin`, see below) is `rejected: "unsupported file type"`.

**`.bin` dropped from the accepted list.** There was never a defined `.bin`
schema anywhere in the codebase — it was raw-bytes-as-float32 by accident,
which is exactly bug #1 above. Removed from `accept=` and the UI copy in
`App.tsx` rather than keep advertising a format with no real parser behind
it.

**Chunked, not a Web Worker.** The brief allowed either. A dedicated Worker
would need Vite's worker-bundling path exercised in a real browser to trust
(this sprint already has three other browser-verified surfaces), and the
pure parse functions need to stay directly unit-testable without a Worker
message-passing shim. Chunked `setTimeout(0)` yielding satisfies "the UI
thread never freezes" for the realistic file sizes this app targets (the
25 MB cap below), stays fully synchronous-per-chunk and testable, and is
called out here as a deliberate scope choice, not an oversight.

**Size cap**: `MAX_UPLOAD_BYTES = 25 MB`, checked against `File.size` before
any read/parse begins — produces an immediate `rejected`-flavored state with
an explicit "file exceeds 25mb limit" message (Phase 2).

**Wiring**: `useVectorDiagnostics` (`processVectors` renamed `postMatrix`,
now internal; `ingestFile` is the new public entry point) takes the parsed
`rows: number[][]` matrix directly and POSTs `{ matrix: rows }` — using
`MatrixUploadRequest.matrix`, the 2D path the schema already supported but
the frontend never used, instead of hand-flattening into `data`/`dim` (which
is how the missing-`dim` bug above happened in the first place). This is the
same `ingest_and_broadcast` batch path every other caller uses — no
detection code changed.

**One small backend fix, discovered live, not anticipated in the plan**:
`MatrixUploadRequest.data: List[float]` had no default, making it a
*required* field — so a `{matrix: [...]}`-only request (no `data` key at
all) failed Pydantic validation with a `422` before the handler body (which
already correctly branches on `request.matrix is not None`) ever ran. Caught
by the Phase 1 live gate below, not by any existing test — nothing had ever
actually sent a `matrix`-only request before. Fixed by widening
`data: List[float]` → `Optional[List[float]] = None`
(`backend/app/api/main.py`), the same kind of additive/backward-compatible
relaxation as the earlier idealization pass's `explanation: str → Optional[str]`
change — every existing caller already sends `data`, so nothing that worked
before is affected; grepped all test files for `canvas/vectors` calls to
confirm none rely on `data` being required.

## Phase 2 — Honest data-source states

`DataSourceState` (new, `frontend/src/canvas/upload/dataSourceState.ts`) is a
tagged union: `idle | parsing | rejected | partial | loaded | error`, owned
by `useVectorDiagnostics` and threaded down as a prop. The old inline
`FileDropZone` in `App.tsx` was replaced by a new, dedicated
`frontend/src/ui/DataSourcePanel.tsx` (same extraction pattern as
`DiagnosticSidebar.tsx` — its own file, its own test file) — purely
presentational, rendering each variant from props alone. All new text is
blush-tier (`rgba(255,182,193,*)`), lowercase, hairline borders — no magenta
anywhere in this component (magenta stays reserved for `status: "ANOMALY"`
elsewhere; a dedicated test asserts no state's rendered output contains
magenta). `rejected` and `error` render their message at ~70% blush per spec
(`rgba(255,182,193,0.7)`); `partial` at 50%, `loaded`/`parsing` at 60%,
distinguishing "clean success" from "success with a caveat" from "failure"
by tier alone, no new hue introduced.

`parsing` also carries an optional `progress` (0–1) — genuinely wired from
`parseCsvMatrix`'s chunk callback (`useVectorDiagnostics.ingestFile` passes
`onProgress` only for the `.csv` path), rendered as `parsing… NN%`. `.json`/
`.npy` parsing is atomic (`JSON.parse`, one pass over the byte buffer) —
those show a bare `parsing…` rather than a fabricated percentage.

## Phase 3 — Narrative surfacing + `llm` status indicator

Confirmed live (see gate below) that Phase 0's conclusion held: once real
data reaches the backend, uploaded-anomaly narratives arrive over the
existing WS `narrative` message exactly like streamed ones — no narrative
routing changes were needed.

`llm` status indicator: added next to the existing `stream` dot in
`DiagnosticSidebar`. Backend tracks a module-level `_llm_status`
(`"unknown"|"ready"|"offline"`), set once at startup via a single cheap
`GET {ollama_base}/api/tags` inside the `lifespan` startup hook, and
thereafter updated for free from the *real* outcome of every
`generate_anomaly_explanation` call (success → `ready`, exception → `offline`)
— zero additional pings, never probed per-frame, exactly as instructed.
Exposed additively on `/api/health` as `"llm"` (documented in `docs/protocol.md`'s
new REST section). Frontend (`useVectorDiagnostics.ts`) fetches `/api/health`
at mount, and again — event-driven, not a timer — every time an anomaly
frame's explanation actually resolves (`narrativeResolutionKey`, keyed on
`${liveFrame.id}:${liveFrame.explanation}`), so the indicator doesn't go
stale for the rest of the session after the very first narrative attempt;
found necessary live (see gate below) when a real Ollama request exceeded
the 10s timeout mid-verification and the indicator needed to reflect that.

Backend test: `test_e2e_upload_narrative.py` reuses the hermetic
uvicorn-subprocess + stubbed-Ollama fixtures, extracted from
`test_e2e_narrative.py` into a new `conftest.py` (`stub_ollama_port`,
`live_backend`, `CANNED_NARRATIVE`) rather than duplicated, per the
instruction to reuse existing machinery. Asserts a `matrix`-shaped
(upload-style) POST with a planted outlier yields `status: ANOMALY` then a
correlated `narrative` message — the exact path uploads take.

## Phase 4 — Demo fixture

`demo/sample_telemetry.csv`: 200 rows × 6 numeric dims, seeded
(`random.seed(1729)`), 4 planted outlier rows, generated by
`tools/make_demo_fixture.py` (stdlib-only, no numpy dependency, reproducible
via `python3 tools/make_demo_fixture.py`).

## Gate results

| Gate | Result |
|---|---|
| Phase 1 — valid numeric CSV rebuilds scene with new points/clusters | **PASS** — real Playwright drive against the live app: 150 mock points → 200 uploaded points, `vector canvas · LIVE`, multiple HDBSCAN clusters (`noise:59 · c0:7 · c1:69 · c2:9 · c3:31 · c4:13 · c5:12`) |
| Phase 1 — outlier rows produce anomaly beacons | **PASS** — same run, 4 planted outlier rows (magnitude 2000, seed 42) → `status: ANOMALY`, sidebar shows `anomaly_indices: [197,198,199]` (3 of 4 crossed the 2.5σ threshold this draw — a property of the pre-existing UMAP/Z-score pipeline, not of this sprint's upload code, see note below), magenta `stream · anomaly detected` |
| Phase 2 — `package.json`-shaped input → `rejected` | **PASS** — `parseMatrix.test.ts` (unit) + live Playwright drive of the *real* repo `package.json` into the running app: panel shows `package.json` / `no numeric vectors found · expected rows of numbers · json / csv / npy`, zero console errors, previous scene (150 mock points) untouched |
| Phase 2 — mixed CSV → `partial` with correct counts | **PASS** — `DataSourcePanel.test.tsx`: `loaded 4 of 6 columns · 2 non-numeric skipped` for a 2-non-numeric-column fixture |
| Phase 3 — backend test: batch upload with outlier → anomaly frame → narrative | **PASS** — `test_e2e_upload_narrative.py` (27th backend test), real uvicorn subprocess + stubbed Ollama, reused `conftest.py` fixtures |
| Phase 3 — manual: drop CSV → beacons → `analyzing…` → narrative in tooltip + terminal | **PASS** (with one honest gap, see below) |
| Phase 4 — demo fixture reliably triggers `ANOMALY` through the real pipeline | **PASS** — `demo/sample_telemetry.csv` (the actual committed, 4-decimal-rounded file, not just the in-memory data) fed through `iye.reduce_to_3d`/`cluster`/`detect_anomalies` directly: `anomaly_indices: [197, 198, 199]` |

**Phase 3 manual gate, in detail.** Live Playwright drive against the running
app with a *real* Ollama (llama3, installed this environment per an earlier
session — see the "local llm setup" README section): dropped a 200-row/4-outlier
CSV → `ANOMALY` status + `stream · anomaly detected` → bottom terminal panel
("AI CORE ANALYSIS") showed `analyzing…` → narrative resolved in both the
terminal panel and the sidebar's `ANALYSIS` block
("Telemetry Alert: Structural vector variance exceeded nominal Z-score
boundary."). The resolved text is the **deterministic fallback**, not a real
LLaMA completion — consistent with the already-documented finding that this
hardware's realistic-prompt generation latency (~15-22s) exceeds the app's
hardcoded 10s httpx timeout (see the Ollama setup session's final report).
This is a hardware/timeout fact, not a defect introduced by this sprint — the
mechanism (frame → analyzing… → narrative, correlated by id, rendered in two
places from the one shared `resolveExplanationDisplay` function) is proven
correctly end to end regardless of which text wins the race.

**Gap, stated honestly**: did not capture an automated screenshot of the
mouse-hover 3D beacon tooltip specifically (its trigger area is a handful of
screen pixels on a projected 3D point — the same category of hard-to-force
timing/targeting issue noted for the Suspense fallback in the prior sprint).
The terminal panel is the always-visible instantiation of the identical
shared `resolveExplanationDisplay` function the hover tooltip also calls
(unit-tested directly in `VectorViewport.pulse.test.ts` since the prior
sprint) — so the *logic* is covered by both an automated unit test and this
live run; only the specific hover-triggered `<Html>` mount wasn't captured
pixel-by-pixel in this pass.

**`llm` indicator, live-verified through both states**: showed `llm · ready`
immediately at boot (real startup healthcheck against the running Ollama),
then flipped to `llm · offline · fallback narratives` — correctly reflecting
that the just-completed narrative attempt used the fallback — without any
polling loop; the frontend re-checks `/api/health` only at mount and again
each time an anomaly frame's explanation actually resolves (see
`useVectorDiagnostics.ts`'s `narrativeResolutionKey` effect), mirroring
exactly when the backend itself last touched Ollama.

**Note on anomaly-triggering reliability** (found while building the Phase 1
gate, relevant to Phase 4's demo fixture too): the existing
`iye.reduce_to_3d`/`iye.detect_anomalies` pipeline's Z-score check operates
on the *UMAP-reduced* 3D coordinates, and UMAP is topology- not
distance-preserving — so whether a small planted-outlier cluster actually
crosses the 2.5σ threshold in the reduced space is sensitive to sample size
and the specific random draw, not just the outliers' raw magnitude. Verified
empirically (30 nominal + 1 outlier, then + 5 outliers at various
magnitudes): unreliable below ~100 nominal points; `seed=42, n_nominal=196,
n_outliers=4, outlier_magnitude=2000` reliably and deterministically
triggers (confirmed 3 consecutive identical runs). This is a pre-existing
property of `sdk/iye/__init__.py`, untouched this sprint — noted here so the
Phase 4 demo fixture's parameters aren't mistaken for arbitrary.

## Full verification, this sprint's final state

| Check | Result |
|---|---|
| `pytest tests/` (backend, includes both new e2e tests) | 27 passed |
| `ruff check .` (backend) | All checks passed |
| `tsc --noEmit` (frontend) | clean |
| `eslint . --max-warnings 0` (frontend) | clean |
| `vitest run` (frontend) | 69 passed |
| `vite build` (frontend) | clean, 0 warnings |
| Manual: live Playwright — `package.json` → `rejected`, previous scene untouched | confirmed |
| Manual: live Playwright — valid CSV with outliers → scene rebuild + `ANOMALY` + narrative | confirmed |
| Manual: `demo/sample_telemetry.csv` → deterministic `ANOMALY` via direct pipeline call | confirmed |

## Files touched this sprint

**Created**: `frontend/src/canvas/upload/parseMatrix.ts` (+ test),
`frontend/src/canvas/upload/dataSourceState.ts`,
`frontend/src/ui/DataSourcePanel.tsx` (+ test), `backend/tests/conftest.py`,
`backend/tests/test_e2e_upload_narrative.py`, `demo/sample_telemetry.csv`,
`tools/make_demo_fixture.py`.

**Modified**: `frontend/src/App.tsx` (old inline `FileDropZone` removed,
replaced by `DataSourcePanel`), `frontend/src/canvas/math/useVectorDiagnostics.ts`
(`processVectors` → `postMatrix` + `ingestFile`; added `llmStatus` +
`narrativeResolutionKey` refresh), `frontend/src/ui/DiagnosticSidebar.tsx`
(+test) (`llm` indicator), `frontend/src/test/setup.ts` (jsdom
`Blob.text`/`arrayBuffer` polyfill), `backend/app/api/main.py`
(`MatrixUploadRequest.data` made optional; `_llm_status` +
`_startup_llm_healthcheck`; `/api/health` gets `llm`),
`backend/tests/test_e2e_narrative.py` (fixtures extracted to `conftest.py`),
`docs/protocol.md` (new `/api/health` REST section), `README.md` (local LLM
setup section from the prior task, plus the demo-fixture two-liner this
sprint).

## Remaining known gaps (deliberately not touched, and why)

1. **Two independent WebSocket connections per page load** (`VectorViewport.tsx`'s
   own `useVectorStream()` call, separate from `useVectorDiagnostics`'s
   internal one) — found while tracing Phase 0, both receive the same
   broadcasts so it isn't a correctness bug, just wasted duplication.
   Untouched per "no rewrites of working code" — a real consolidation
   candidate for a future pass, not this one.
2. **The hover-triggered 3D beacon tooltip's transient `analyzing…` state
   wasn't captured in an automated screenshot** (Phase 3) — same category of
   hard-to-force pixel/timing target as the prior sprint's Suspense-fallback
   gap. The underlying display logic (`resolveExplanationDisplay`) is
   unit-tested and the terminal panel (same function, always-visible) was
   confirmed live; only the specific hover-mount pixel capture is unproven.
3. **CSV parsing is comma-split, not full RFC 4180** — no quoted-field or
   embedded-comma support. Fine for the numeric-only inputs this pipeline
   targets (quoted fields would only ever contain non-numeric data, which
   gets dropped as a non-numeric column anyway), but worth naming so it
   isn't assumed to be a general-purpose CSV parser.
4. **The Z-score anomaly check's sensitivity to sample size/random draw**
   (documented above) is a pre-existing property of `sdk/iye/__init__.py`,
   not something this sprint touched or was asked to fix — flagged because
   it directly shaped the demo fixture's parameters and is worth knowing
   before anyone tunes "outlier magnitude" expecting a simple monotonic
   relationship with detection.
5. **`MatrixUploadRequest.data` relaxation was reactive, not planned** — found
   via the Phase 1 live gate, not anticipated in the brief. Backward-compatible
   and narrow (one field, one line), but worth an explicit callout since it's
   the one schema change in a sprint that otherwise touched no detection code.

## Commits ready for review

```
b9011b5 docs: current upload path trace
718691b feat: file uploads flow through full detection + narrative pipeline
e85dea8 feat: explicit data-source states — no more silent upload failures
11479f5 feat: narratives for uploaded data + llm status indicator
96a7484 feat: seeded demo fixture + generator script
```

All local on `main`, not pushed, per instruction. (Two unrelated commits —
`b805cfe` local Ollama setup and `3b316a0` the prior sprint's report — sit
between the last push and this sprint's first commit; not part of this
sprint's work, left as-is.)

---

# 2026-07-10 — Sidebar layout fixes: 30% width spec + scrollable overflow

Layout-only, one commit. No data-flow/hook/backend changes.

## Root causes

**Bug 1 — sidebar far narrower than 30%.** Two independent, stacked
mistakes:
1. `App.tsx`'s outer sidebar wrapper clamped the 30% width to
   `minWidth: 240, maxWidth: 360` — already tighter than the spec's
   intended `320`–`480`.
2. `DiagnosticSidebar.tsx`'s own root `<div>` — nested *inside* that
   already-clamped wrapper — set its **own** `width: '30%'`. Since it's a
   flex child of the wrapper, that 30% resolved against the wrapper's
   already-narrow box (≈360px), not the viewport, producing an inner box
   roughly 30% × 360px ≈ 108px wide. The dead strip in the bug report was
   the gap between that ~108px inner box's right edge and the outer
   wrapper's actual (correctly-positioned) right edge.

**Bug 2 — RENDER LOOP clipped, unreachable.** `DiagnosticSidebar.tsx`'s
root also set its own `height: '100vh'` while living *below* the
`DataSourcePanel` in the same column-flex outer wrapper — so total content
height (`DataSourcePanel`'s box + a full second 100vh box) exceeded the
wrapper's actual 100vh, and the parent app shell (`#iye-app-root`) has
`overflow: hidden`. That ancestor-level hard clip is what actually ate the
bottom of the sidebar — `DiagnosticSidebar`'s own `overflow-y: auto` on the
same over-tall box never got a chance to matter, since the clipping
happened one level up, not inside its own box.

## Fix

- `App.tsx`: sidebar wrapper clamp corrected to `min-width: 320px`,
  `max-width: 480px` (still `width: 30%` in between); added
  `overflow: hidden` on this wrapper so it stays a fixed-height flex
  column and never itself grows past `100vh`.
- `DiagnosticSidebar.tsx`: removed its own `width`/`min-width`/`max-width`
  and redundant `border-left` entirely — sizing and the visual boundary
  are the parent wrapper's job alone now. Changed `height: 100vh` →
  `flex: 1` (fills whatever vertical space the wrapper has left after
  `DataSourcePanel`) plus `min-height: 0` — the standard flexbox-scroll fix:
  a flex item's default `min-height: auto` lets it grow to fit its content
  regardless of the flex container's size, which is exactly what was
  defeating `overflow-y: auto` before. Added explicit `overflow-x: hidden`
  alongside the existing `overflow-y: auto`.
- Scrollbar: kept the existing hairline-blush-thumb approach (already
  established in `GlobalStyles`) over fully-hidden, since the sidebar has
  no other affordance signaling "more content below" once RENDER LOOP
  scrolls out of view — a hidden scrollbar would make the cut-content bug
  merely invisible instead of fixed. Tightened values to spec exactly:
  3px width (was 4px), `rgba(255,182,193,0.25)` thumb (was 0.2), explicit
  `::-webkit-scrollbar-button { display: none }`, and added
  `scrollbar-width: thin` / `scrollbar-color` for Firefox parity — no new
  color introduced, reusing the existing blush rgba value.

## Verification

Live Playwright drive against the running stack at three widths (full-page
screenshots in `docs/screenshots/2026-07-10-sidebar-layout/`):

| Width | Sidebar box | Canvas box | Right edge flush? |
|---|---|---|---|
| 1280 | `x=897, width=383` (expected ≈384) | `width=896` | yes (897+383=1280) |
| 1680 | `x=1201, width=479` (clamped to 480) | `width=1200` | yes (1201+479=1680) |
| 2560 | `x=2081, width=479` (clamped to 480) | `width=2080` | yes (2081+479=2560) |

[`width-1280.png`](screenshots/2026-07-10-sidebar-layout/width-1280.png),
[`width-1680.png`](screenshots/2026-07-10-sidebar-layout/width-1680.png),
[`width-2560.png`](screenshots/2026-07-10-sidebar-layout/width-2560.png) —
all three show the sidebar filling its clamped share with no dead strip,
and `SYSTEM NOTES` card text unwrapped (the "pipeline" card in particular
was tightly wrapped before, now reads on 1–2 clean lines at every width).

**Scroll fix, forced under a genuine overflow** (620px viewport height, not
just the incidental case where content already fit): confirmed
`sidebar.scrollHeight (591) > sidebar.clientHeight (428)` before scrolling,
i.e. a real overflow, not a coincidence. After
`el.scrollTop = el.scrollHeight`, RENDER LOOP's bounding box
(`y=461.75, height=13.5`) sits fully inside the 620px viewport — verified
both by screenshot and the programmatic bounds check requested.
[`scroll-before.png`](screenshots/2026-07-10-sidebar-layout/scroll-before.png)
shows RENDER LOOP clipped at the bottom edge (the reported bug, reproduced);
[`scroll-after.png`](screenshots/2026-07-10-sidebar-layout/scroll-after.png)
shows it fully visible with the `canvas · rendering` footer below it, after
scrolling the sidebar's own container (not `body`).

**Canvas resize path — verified, not assumed.** `VectorViewport.tsx`'s
`<Canvas camera={{ position: [3, 3, 5] }}>` has no hardcoded width/height —
R3F sizes it to its parent (`ViewportPanel`, `flex: 1`) via its own
`ResizeObserver`, unmodified by this sprint. Confirmed live: after a
**live** resize (same page, no reload) from 1280→1680, the `<canvas>`
element's own bounding box became exactly `{width: 1200, height: 900}` —
precisely the container's `1680 - 480` remainder, with no rounding drift.
[`canvas-after-live-resize.png`](screenshots/2026-07-10-sidebar-layout/canvas-after-live-resize.png)
shows the wireframe reference cube proportionally identical to its
appearance at the other two widths — no stretching or letterboxing at any
tested size.

**Hover-tooltip positioning — partially verified, gap stated honestly.**
The tooltip's own code (`<Html position={[0, 1.8, 0]} center distanceFactor={9}>`
in `VectorViewport.tsx`) was not touched by this sprint, and its correctness
depends entirely on R3F's camera aspect ratio being derived from the
correct canvas size — which the measurement above confirms directly.
However, an automated Playwright hover specifically *landing* on a
beacon's few-pixel hit target was not achieved this pass: three
approaches were tried (a coarse full-canvas grid scan, a finer grid scan,
and precise coordinates read off an earlier screenshot) without a hit,
`buildMockFrame`'s point positions are randomized per page load
(`Math.random()` jitter), so coordinates read from one screenshot don't
transfer to a later page instance. This is the same category of
hard-to-force pixel/timing target flagged as an honest gap in the prior
sprint's Suspense-fallback verification — not a sign the tooltip is broken,
just that this specific interaction wasn't captured pixel-by-pixel
automatically.

**Unrelated pre-existing issue found, explicitly out of scope, not
touched.** While chasing the hover target using a real CSV upload (the
demo fixture from the prior sprint), the uploaded dataset's point
cloud/cluster hulls/beacons did not render at all — only the static
reference wireframe box was visible, despite the sidebar correctly
reporting `points: 200`, `status: ANOMALY`, and the right cluster/anomaly
counts. **Confirmed via `git stash` that this reproduces identically on
the pre-fix code** — it is not a regression introduced by this sprint's
CSS changes. Per this sprint's explicit scope boundary ("if you find
yourself editing... any canvas child's logic... stop"), this was not
investigated further or fixed here; flagged for a future pass. The
default mock frame (150 points, used for the width/canvas-resize
verification above) renders normally and was unaffected.

## Full verification

| Check | Result |
|---|---|
| `pytest tests/` (backend, untouched, run to prove it) | 27 passed |
| `ruff check .` (backend) | All checks passed |
| `tsc --noEmit` (frontend) | clean |
| `eslint . --max-warnings 0` (frontend) | clean |
| `vitest run` (frontend) | 69 passed, no assertions needed updating — no existing test asserted sidebar width/height/overflow geometry |
| `vite build` (frontend) | clean, 0 warnings |

## Files touched

`frontend/src/App.tsx` (sidebar wrapper clamp + overflow, scrollbar CSS),
`frontend/src/ui/DiagnosticSidebar.tsx` (removed redundant width/height/border,
flex + min-height fix), `docs/screenshots/2026-07-10-sidebar-layout/*.png`
(new, verification evidence), `docs/idealization_report.md` (this section).

## Commit

```
fix: sidebar honors 30% panel spec with clamped width + scrollable overflow
```

Local on `main`, not pushed, per instruction.

---

# 2026-07-12 — Sprint: categorical encoding + sidebar layout re-check

## Phases 2/3 — audited, found already fixed, no code touched

This sprint's brief re-described the exact sidebar-width and scroll bugs
from the **previous** sprint (2026-07-10, commit `f48d740`, immediately
above). Before writing any code, I checked the current state of
`App.tsx`/`DiagnosticSidebar.tsx` against that prior fix and confirmed it
was already in place (`minWidth: 320, maxWidth: 480` on the sidebar wrapper;
`flex: 1, minHeight: 0, overflowY: 'auto'` on `DiagnosticSidebar`'s own
root). Rather than re-apply a no-op "fix" or silently skip the phases, I
re-ran the exact live verification the brief asked for, with fresh
screenshots, to produce current evidence rather than reusing the prior
sprint's:

| Width | Sidebar box | Canvas box | Right edge flush? |
|---|---|---|---|
| 1280 | `x=897, width=383` | `width=896` | yes |
| 1680 | `x=1201, width=479` | `width=1200` | yes |
| 2560 | `x=2081, width=479` | `width=2080` | yes |

Scroll, forced under a genuine overflow (1280×620 viewport):
`scrollHeight=591 > clientHeight=428` confirmed before scrolling; after
`el.scrollTop = el.scrollHeight`, RENDER LOOP's box was fully within the
620px viewport (programmatic check, not just visual).

Screenshots: [`docs/screenshots/2026-07-12-sidebar-audit/`](screenshots/2026-07-12-sidebar-audit/)
(`width-1280.png`, `width-1680.png`, `width-2560.png`, `scroll-after.png`).

**No commit for Phases 2/3** — there was nothing to change. Creating a
commit with an empty or redundant diff would violate "surgical changes
only, no rewrites of working code." This is stated here explicitly rather
than silently, per the same honesty principle the rest of this report holds
product behavior to.

## Phase 1 — Categorical encoding

### The bug this replaces

Before this sprint, any non-numeric column — regardless of whether it was a
genuine free-text field or a clean, bounded-cardinality label like
`status: nominal/critical` — was dropped entirely (see the 2026-07-07
sprint's Phase 0/1). A mixed file lost real structure; a pure-categorical
file was rejected outright even when it was perfectly good data. This
sprint replaces "drop everything non-numeric" with two honest, deliberate
modes: automatic encoding when numeric data is also present (nothing to
consent to — the numeric visualization was always going to happen), and an
explicit opt-in when a file is *only* categorical (visualizing it at all is
a choice IYE shouldn't make silently).

### Classification rules (as implemented)

For each non-numeric column (`parseMatrix.ts`'s `classifyNonNumericColumn`):

| Condition | Classification |
|---|---|
| Zero non-empty values | `freetext` (skipped) |
| `uniqueCount > 1000` | `freetext` (skipped) — `FREQUENCY_MAX_CARDINALITY` |
| `rowCount >= 20 AND uniqueCount/rowCount > 0.9` | `freetext` (skipped) — the near-unique ratio check |
| `uniqueCount <= 20` | `onehot` — `ONEHOT_MAX_CARDINALITY` |
| otherwise (21–1000 uniques) | `frequency` |

The near-unique ratio check only applies once there are ≥20 rows —
otherwise a genuinely small categorical column (e.g. 2 rows, 2 categories)
would be misjudged as "free text" purely for having no repeats yet. This
is a real, deliberate threshold choice, not an approximation: it directly
determined which existing tests changed behavior (see below) and shaped the
demo fixture's row counts.

**Encoding methods:**
- **One-hot** (≤20 categories): a stable *sorted* category list (no
  hashing, no seed) → deterministic by construction. Block-scaled by
  `1/√(categoryCount)` so a column's *total* contribution to Euclidean
  distance (summed across its expanded dims) is comparable to one
  unit-variance dimension, not N times larger merely because it expanded
  into N columns — a real risk given a 15-category one-hot column would
  otherwise contribute ~15× the distance-weight of an average numeric
  column, silently letting cardinality (not signal) dominate UMAP's
  neighbor graph.
- **Frequency** (21–1000 categories): each value replaced by its proportion
  of rows sharing it, then z-score normalized like any numeric column.
  Chosen over feature hashing specifically to avoid needing a seed at all
  — determinism follows from the encoding being a pure function of the
  data, not from careful seed management.
- **Normalization**: raw numeric columns are z-score normalized **only
  when** the file also has at least one encoded categorical column (the
  "mixed pathway"). A pure-numeric upload is byte-for-byte unaffected by
  this sprint — the existing pipeline's numeric handling is untouched.
  Once any encoding happens, though, *all* columns (numeric and encoded)
  get normalized together, because leaving raw numeric columns at their
  natural scale next to bounded [0, 1/√n] one-hot values would just move
  the "which magnitude dominates" problem from categorical-vs-categorical
  to categorical-vs-numeric instead of solving it.

### JSON nested-object flattening

Objects flatten to dotted-path keys up to depth 3 (`MAX_JSON_FLATTEN_DEPTH`);
`a.b.c` at exactly depth 3 still flattens, `a.b.c.d` (depth 4) does not —
the depth-3 object becomes an opaque leaf, stringified via `JSON.stringify`
and then classified like any other string column (in practice this makes a
deeply-nested field with materially different content per row read as
near-unique → skipped as free text, which is what happened in testing).
Arrays are *never* recursed into, at any depth — also stringified as opaque
leaves — a documented simplification (`parseMatrix.ts`'s `flattenObject`),
not a general-purpose JSON normalizer.

### Offer flow (Phase 1b)

A file with zero numeric columns but ≥1 encodable categorical column stops
at a new `offer` panel state — the encoded matrix is computed eagerly
(cheap, deterministic), but `useVectorDiagnostics.ts`'s `ingestFile` does
**not** POST it. It's held in a ref (`pendingOfferRef`) until the user
clicks "encode & visualize" (`confirmOffer`) or "dismiss" (`dismissOffer`,
clears the ref, returns to `idle`, POSTs nothing, ingests nothing). Verified
live (see gate below) that dismissing produces zero network activity and
zero canvas change — the product principle holds: IYE does not fabricate
geometry from pure-text data without consent, and this is enforced at the
code level (no POST call exists on that path), not just by convention.

Once confirmed, the resulting `loaded` state is unconditionally labeled
`visualizing encoded categories · not raw measurements` whenever
`encoding.numericColumns === 0` — derived directly from the encoding summary
rather than a separate "came from an offer" flag, since reaching `loaded`
with zero numeric columns is only possible via a confirmed offer in the
first place.

### `partial` no longer means "encoding happened"

A meaningful state-machine redefinition: previously `partial` fired
whenever *any* non-numeric column was dropped. Now that bounded-cardinality
categoricals are encoded rather than dropped, encoding is a normal, labeled
*success* outcome — `partial` fires only on genuine information loss
(`skippedFreeText > 0` or `droppedRows > 0`), never merely because
categorical encoding occurred. A clean mixed file (all columns either
numeric or encodable) now reaches `loaded`, with the encoding facts folded
into that message instead.

### `encoding_summary` — additive protocol field (Phase 1c)

The backend never computes encoding itself; it only accepts, echoes, and
narrates what the frontend's parser already determined:

- `MatrixUploadRequest.encoding_summary` (backend/app/api/main.py): new
  optional `EncodingSummary` submodel, `None` by default — a pure-numeric
  upload's request body is unchanged from before this field existed (no
  `encoding_summary` key sent at all).
- `VectorFramePayload.encoding_summary` (sdk/iye/server.py): additive,
  `None` unless the request carried one; echoed back verbatim.
- Anomaly narrative prompt (`ingest_and_broadcast`): when
  `encoding_summary` is present, the `metrics_summary` string fed to
  `generate_anomaly_explanation` gets a note appended — *"N of the M source
  column(s) are encoded categorical features — K of this vector's
  dimensions are encoded categories, not raw measurements."* — verified via
  a hermetic e2e test capturing the actual prompt the (stubbed) Ollama
  server received, not just the response payload.
- Documented additively in `docs/protocol.md` (new `encoding_summary`
  subsection under `frame`, plus a short new REST section for the request
  side) in the same commit, per directive #3.

## Existing test changes — quoted, not silently altered

Per directive #2, every changed assertion is quoted here with the reason;
nothing was deleted to make a test pass.

**`parseMatrix.test.ts`**, `'produces a "partial" outcome for a mixed CSV — drops the non-numeric column, reports exact counts'`:
- BEFORE: `id`/`label` (2 non-numeric columns, 2 rows) asserted
  `totalColumns=6, dim=4, droppedColumns=2`, rows equal to just the 4 raw
  numeric values.
- AFTER (renamed `'encodes low-cardinality categorical columns in a mixed CSV instead of dropping them'`):
  both columns are low-cardinality (2 uniques each) and are now one-hot
  encoded, not dropped — asserts `dim=8`, `encoding.encodedCategoricalColumns=2`,
  exact encoded row values (one-hot block-scaled by `1/√2`, numeric columns
  z-score normalized since encoding occurred).
- Reason: this is exactly the new intended behavior (Phase 1a), not a
  regression — the old assertion described the bug this sprint fixes.

**`parseMatrix.test.ts`**, `'rejects a CSV with no numeric columns at all'`:
- BEFORE: `name,label\nalice,ok\nbob,bad` (0 numeric, 2 low-cardinality
  categorical columns) asserted `{kind: 'rejected'}`.
- AFTER: this exact fixture is superseded by
  `'produces an "offer" outcome for a CSV with only encodable categorical columns (no numeric)'`,
  asserting `{kind: 'offer'}` instead. A new, separate test with a genuinely
  unusable fixture (25 rows, single near-unique column) now covers the
  actual rejected path.
- Reason: this is Phase 1b's whole point — zero-numeric-but-categorical
  files are no longer silently rejected, they're offered.

**`parseMatrix.test.ts`**, `'parses an array of flat numeric objects, dropping non-numeric fields column-wise'`:
- BEFORE: `label` (2 uniques) asserted `dim=2, droppedColumns=1`, rows
  equal to just `[x, y]`.
- AFTER (renamed `'encodes a low-cardinality field in an array of flat objects instead of dropping it'`):
  asserts `dim=4` (x, y z-scored + label one-hot), exact values. Same
  reasoning as the CSV case above.

**`DataSourcePanel.test.tsx`**, `partial`/`loaded` fixtures:
- BEFORE: `droppedColumns: 2` field, message text "... 2 non-numeric skipped".
- AFTER: `skippedFreeText: 2` field (renamed — these are genuinely
  unencodable, not just "non-numeric" anymore) plus a required `encoding`
  summary; message text "... 2 skipped (free text)".
- Reason: the field rename reflects that most non-numeric columns are no
  longer dropped at all; the ones that still are get skipped specifically
  *because* they're free text, and the copy now says so.

## Gate results

| Gate | Result |
|---|---|
| Mixed CSV → matrix width and column accounting exact | **PASS** — `parseMatrix.test.ts` unit tests + live: `sample_telemetry_mixed.csv` (204 rows, 6 numeric + 1 categorical) → `dim=8`, `"204 rows · 8 dims · clustered · 6 numeric · 1 encoded categorical"`, `status: ANOMALY`, all 8 planted outliers flagged |
| Pure-categorical JSON → offer eligibility flag, no pipeline run without confirmation | **PASS** — live: `pure_categorical.json` (10 rows, 3 categorical fields, 0 numeric) → `offer` state, zero network POST until "encode & visualize" clicked; "dismiss" → `idle`, zero POST, zero canvas change |
| Confirmed offer → explicitly labeled visualization | **PASS** — live: `"10 rows · 11 dims · clustered · visualizing encoded categories · not raw measurements"` |
| Prose/binary file → rejected | **PASS** — live: `prose.txt` → `"unsupported file type · expected json / csv / npy"` (rejected at the extension check, previous scene untouched) |
| Determinism (same file parsed twice → identical matrix) | **PASS** — `parseMatrix.test.ts`: `parseCsvMatrix(csv)` called twice on the same input, deep-equal outcomes (no hashing/seed anywhere in the encoding path) |
| Backend: encoding_summary echoed back unchanged / null when absent | **PASS** — `test_encoding_summary.py` (TestClient, 3 tests) |
| Backend: narrative prompt mentions encoding when summary present | **PASS** — `test_encoding_summary.py` (hermetic e2e, captures the actual prompt sent to stubbed Ollama) |
| Existing frontend/backend suites still green | **PASS** — no assertion deleted to force a pass; 3 tests updated with reasons quoted above |

Screenshots: [`docs/screenshots/2026-07-12-encoding/`](screenshots/2026-07-12-encoding/)
(`1-mixed-csv-loaded.png`, `2a-offer-state.png`, `2b-offer-confirmed-labeled.png`,
`2c-offer-dismissed.png`, `3-prose-rejected.png`).

## Full verification

| Check | Result |
|---|---|
| `pytest tests/` (backend) | 31 passed (27 → 31: `test_encoding_summary.py`, 4 new) |
| `ruff check .` (backend, incl. `tools/make_demo_fixture.py`) | All checks passed |
| `tsc --noEmit` (frontend) | clean |
| `eslint . --max-warnings 0` (frontend) | clean |
| `vitest run` (frontend) | 83 passed (69 → 83: 14 net new/changed across `parseMatrix.test.ts` + `DataSourcePanel.test.tsx`) |
| `vite build` (frontend) | clean, 0 warnings |

## Demo fixture

`tools/make_demo_fixture.py` now also generates
`demo/sample_telemetry_mixed.csv` (204 rows: 196 nominal + 8 planted
outliers, 6 numeric dims + 1 categorical `status` column). Parameters were
**re-derived empirically, not reused** from the numeric-only fixture:

- `OUTLIER_MAGNITUDE` turned out not to matter at all once encoding
  triggers z-score normalization — z-scoring is scale-invariant, confirmed
  by testing 2000/5000/20000/100000 against the real pipeline and getting
  identical results for a fixed seed.
- What *does* matter is outlier count: 4 outliers (the numeric-only
  fixture's count) was unreliable post-normalization (~40% of seeds
  tried); 8 was 100% reliable (5/5 seeds tried, all 8 planted rows
  flagged).
- A second categorical column (`region`, uncorrelated with the
  outlier/nominal split) was tried and *reduced* reliability — an
  uninformative one-hot block dilutes UMAP's neighbor graph — so the
  fixture intentionally has only the one correlated categorical column.

Verified against the real pipeline (not just computed): parsed via the
actual `parseCsvMatrix` (through `tsx`, not a Python reimplementation) and
POSTed to a running backend — `status: ANOMALY`, all 8 outlier rows
flagged.

## Files touched this sprint

**Created**: `backend/tests/test_encoding_summary.py`,
`demo/sample_telemetry_mixed.csv`,
`docs/screenshots/2026-07-12-sidebar-audit/*.png`,
`docs/screenshots/2026-07-12-encoding/*.png`.

**Modified**: `frontend/src/canvas/upload/parseMatrix.ts` (classification,
one-hot/frequency encoding, JSON flattening, `offer` outcome),
`frontend/src/canvas/upload/dataSourceState.ts` (+test — `offer` state,
`skippedFreeText` rename, encoding-aware messages), `frontend/src/ui/DataSourcePanel.tsx`
(+test — offer rendering, confirm/dismiss buttons), `frontend/src/canvas/math/useVectorDiagnostics.ts`
(`confirmOffer`/`dismissOffer`, `encoding_summary` wire mapping),
`frontend/src/App.tsx` (wired offer handlers), `backend/app/api/main.py`
(`EncodingSummary` model, narrative prompt note), `sdk/iye/server.py`
(additive `encoding_summary` field), `backend/tests/conftest.py`
(`received_prompts` capture, additive), `tools/make_demo_fixture.py`
(mixed fixture generator), `docs/protocol.md`, `README.md`.

## Remaining known gaps (deliberately not touched, and why)

1. **Feature hashing was not implemented** — frequency encoding was chosen
   instead for the 21–1000 cardinality band (see rationale above). The
   spec allowed either; hashing remains a reasonable future option if a
   real dataset's frequency distribution turns out to be uninformative
   (e.g., near-uniform category frequencies).
2. **Array-of-arrays JSON stays numeric-only** — no column names exist to
   classify categoricals against in that shape, so this sprint left it
   exactly as before. Only CSV and array-of-objects JSON get categorical
   encoding.
3. **CSV parsing is still comma-split, not full RFC 4180** (a pre-existing,
   previously-documented gap, unchanged this sprint) — quoted fields with
   embedded commas aren't supported. Irrelevant to categorical
   classification itself (a malformed row is still dropped as ragged
   before classification runs).
4. **The unrelated upload-rendering gap noted in the prior sprint** (dropped
   data's point cloud/beacons don't visually render, though the sidebar
   reports correct counts) **is still present**, confirmed again during
   this sprint's live gates (see the mixed-CSV screenshot: a beacon dot
   renders but the full point cloud/hulls don't). Out of scope per this
   sprint's own boundaries too (categorical encoding and sidebar layout,
   not canvas rendering) — flagged again so it isn't lost between sprints.

## Commits ready for review

```
be746fc feat: categorical encoding — automatic for mixed data, opt-in for pure-text, always labeled
```

(No commit for Phases 2/3 — audited and found already fixed by the prior
sprint's `f48d740`; nothing to commit.)

All local on `main`, not pushed, per instruction.
