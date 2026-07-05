# IYE `/stream` WebSocket Protocol

Endpoint: `ws://127.0.0.1:8050/stream`. Every message is a single JSON object
carrying a `type` discriminator. Two message types exist today: `frame` and
`narrative`. Frontend parsing lives in
[`frontend/src/canvas/math/useVectorStream.ts`](../frontend/src/canvas/math/useVectorStream.ts);
the backend produces both from
[`backend/app/api/main.py`](../backend/app/api/main.py) (`ingest_and_broadcast`)
using the schema defined in
[`sdk/iye/server.py`](../sdk/iye/server.py) (`VectorFramePayload`).

## `frame`

Emitted once per `/api/canvas/vectors` ingestion, immediately — it never waits
on the LLaMA/Ollama call (see "Decoupling" below).

```json
{
  "frame_id": "2b6706d6-c847-4eb3-bd93-e9a3f1463e59",
  "id": "2b6706d6-c847-4eb3-bd93-e9a3f1463e59",
  "type": "frame",
  "timestamp": "2026-07-05T11:12:32.811995+00:00",
  "status": "NOMINAL",
  "point_count": 16,
  "coordinates": [
    { "x": 37.87, "y": 24.55, "z": 23.90 }
  ],
  "cluster_labels": [-1, 0, 0, 1],
  "anomaly_indices": [],
  "explanation": null,
  "axis_mapping": null,
  "temporal": {
    "z_max": 1.90,
    "z_per_dim": [1.77, 1.76, 1.90],
    "velocity": 0.20,
    "acceleration": 0.20,
    "drift_slope": 24.32,
    "composite": 0.38,
    "composite_smoothed": 0.37,
    "regime": "warmup",
    "window_fill": 0.04,
    "dominant_dim": 2
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `frame_id` | string | UUID4. Kept for backward compatibility — pre-temporal-engine consumers read this. |
| `id` | string | Mirrors `frame_id`. New consumers (and `narrative` correlation) should use this. |
| `type` | `"frame"` | Discriminator. Absent in the pre-temporal-engine contract — treat its absence as a legacy payload. |
| `timestamp` | string | ISO 8601, UTC. |
| `status` | `"NOMINAL"` \| `"ANOMALY"` | From `iye.detect_anomalies` — a per-frame 2.5σ Z-score check on the UMAP-reduced 3D coordinates. Independent of `temporal.regime`. |
| `point_count` | number | Number of entries in `coordinates`. |
| `coordinates` | `{x,y,z}[]` | UMAP-reduced (or pass-through, if input was already ≤3D) 3D points. |
| `cluster_labels` | number[] | HDBSCAN labels, one per coordinate. `-1` = noise. |
| `anomaly_indices` | number[] | Indices into `coordinates`/`cluster_labels` flagged by the Z-score check. |
| `explanation` | string \| null | **`null` immediately on an anomaly frame** — the LLaMA narrative is generated asynchronously and arrives later as its own `narrative` message. Non-null static string on nominal frames (`"System nominal. ..."`). |
| `axis_mapping` | object \| null | Reserved for client-side axis remapping; not currently populated by the backend. |
| `temporal` | object | See `TemporalMetrics` below. Always present, even in `warmup`. |

### `temporal` (`TemporalMetrics`)

Produced by `backend/app/api/temporal_engine.py`'s `TemporalEngine`, a
stateful sliding-window (`deque(maxlen=50)`) detector — one instance per
backend process, shared across all ingested frames (there is currently no
per-stream/per-client isolation).

| Field | Type | Notes |
|---|---|---|
| `z_max` | number | Max absolute per-axis Z-score of *this frame's own* point cloud (spatial outlier signal, unrelated to centroid tracking). |
| `z_per_dim` | number[] | Per-axis (x, y, z) max Z-score. |
| `velocity` | number | First difference of the (noise-label-excluded) centroid, normalized by the noise scale of a first difference of two independent centroid estimates (`σ_centroid·√2`). Dimensionless "sigma units" — not a raw distance/time rate. |
| `acceleration` | number | Second difference of the centroid, normalized by `σ_centroid·√6`. |
| `drift_slope` | number | Theil-Sen (median-of-pairwise-slopes) trend magnitude over the window, scaled by the window's time span and normalized into the same sigma units as `velocity`. Robust to a minority of outlier frames — see `docs/temporal_calibration.md`. |
| `composite` | number | Raw per-frame anomaly score: `anomaly_ratio*3 + min(z_max,10)/10*2`. |
| `composite_smoothed` | number | EMA (`alpha=0.3`) of `composite` — filters momentary noise spikes. |
| `regime` | string | One of `warmup`, `stable`, `spike`, `velocity`, `acceleration`, `drift`. Latched with enter/release hysteresis (2 frames to enter, 6 to release) — a single noisy frame can't flip it. `warmup` until the 50-frame window fills. |
| `window_fill` | number | `0..1`, fraction of the 50-frame window currently populated. |
| `dominant_dim` | number | Axis index (0/1/2) with the highest per-frame Z-score, or `-1` if undefined. |

## `narrative`

Emitted asynchronously, after a `frame` with `status: "ANOMALY"` — generated
by a fire-and-forget task (capped at 4 concurrent, semaphore-guarded) that
queries local LLaMA via Ollama and falls back to a deterministic string on
any failure/timeout.

```json
{
  "type": "narrative",
  "id": "2b6706d6-c847-4eb3-bd93-e9a3f1463e59",
  "explanation": "Structural vector variance exceeded nominal Z-score boundary at the origin node."
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"narrative"` | Discriminator. |
| `id` | string | Matches the `frame.id` this narrative explains. |
| `explanation` | string | LLaMA-generated text, or the deterministic fallback string if Ollama is unreachable/times out/errors. |

**Correlation contract:** a client should match `narrative.id` against the
`id` of the frame currently displayed. If a newer frame has already replaced
it by the time the narrative arrives (a real possibility — narratives are not
guaranteed to arrive before the next frame), the narrative must not be
dropped silently; surface it elsewhere (the frontend's
`narrativeHistory`, capped at the last 20 entries).

## Decoupling

The `frame` broadcast is never blocked on the Ollama HTTP call. Verified by
inspection: `hub.broadcast(payload)` runs immediately after building the
frame payload; `generate_anomaly_explanation` (the Ollama call) is only
`await`-ed inside `_narrate`, which is scheduled via `asyncio.create_task`
*after* the broadcast, not awaited on the request path.

## Legacy / pre-temporal-engine payloads

`VectorFramePayload` predates `id`/`type`/`temporal` — those three fields are
additive with defaults (`id: null`, `type: "frame"`, `temporal: null`) so an
older consumer that only reads `frame_id`/`status`/`coordinates`/etc. and
ignores unknown fields still parses today's payload unmodified. See
`backend/tests/test_schema_compat.py` for the enforcement test.
