/**
 * DiagnosticSidebar.summary.test.ts (2026-08-30 sprint, Finding 4) —
 * regression coverage for summarizeFrameForHumans, the deterministic,
 * template-based plain-English translation of a frame's raw temporal
 * metrics (window_fill/z_max/velocity/acceleration/drift_slope/regime).
 * Pure-function tests, no React render — see DiagnosticSidebar.test.tsx for
 * the rendered "in plain terms" block and jargon-tooltip coverage.
 */
import { describe, expect, it } from 'vitest'
import type { VectorFrame } from '@canvas/math/useVectorStream'
import { DEFAULT_TEMPORAL_METRICS } from '@canvas/math/useVectorStream'
import { summarizeFrameForHumans } from './DiagnosticSidebar'

function makeFrame(overrides: Partial<VectorFrame> = {}): VectorFrame {
  return {
    frame_id: 'f1',
    id: 'f1',
    timestamp: new Date().toISOString(),
    status: 'NOMINAL',
    point_count: 16,
    coordinates: [],
    cluster_labels: [],
    anomaly_indices: [],
    explanation: null,
    axis_mapping: null,
    temporal: DEFAULT_TEMPORAL_METRICS,
    point_z_scores: [],
    axes_are_raw_features: true,
    point_feature_attributions: [],
    ...overrides,
  }
}

describe('summarizeFrameForHumans', () => {
  it('a nominal, fully-warmed-up, stable frame reads as boring on purpose', () => {
    const frame = makeFrame({
      anomaly_indices: [],
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'stable', window_fill: 1 },
    })
    const summary = summarizeFrameForHumans(frame)
    expect(summary).toMatch(/no unusual points/i)
    expect(summary).toMatch(/stable/i)
  })

  it('an anomaly frame states how many points are unusual, using singular phrasing for exactly one', () => {
    const frame = makeFrame({
      status: 'ANOMALY',
      anomaly_indices: [7],
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'spike', window_fill: 1 },
    })
    const summary = summarizeFrameForHumans(frame)
    expect(summary).toMatch(/1 point is unusual/i)
    expect(summary).not.toMatch(/1 points/i)
    expect(summary).toMatch(/spike/i)
  })

  it('an anomaly frame with multiple anomalies uses plural phrasing and states the count', () => {
    const frame = makeFrame({
      status: 'ANOMALY',
      anomaly_indices: [1, 2, 3],
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'stable', window_fill: 1 },
    })
    const summary = summarizeFrameForHumans(frame)
    expect(summary).toMatch(/3 points are unusual/i)
  })

  it('a frame with no anomalies but a nonzero, positive drift_slope still surfaces the drift trend', () => {
    // The exact scenario called out explicitly in the 2026-08-30 sprint
    // findings: nothing is flagged anomalous *yet*, but the underlying
    // pattern is quietly trending -- this must not read as "everything is
    // fine, nothing to see here".
    const frame = makeFrame({
      status: 'NOMINAL',
      anomaly_indices: [],
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'drift', drift_slope: 1.42, window_fill: 1 },
    })
    const summary = summarizeFrameForHumans(frame)
    expect(summary).toMatch(/no unusual points/i)
    expect(summary).toMatch(/drifting upward/i)
  })

  it('a negative drift_slope is described as drifting downward, not upward', () => {
    const frame = makeFrame({
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'drift', drift_slope: -0.8, window_fill: 1 },
    })
    const summary = summarizeFrameForHumans(frame)
    expect(summary).toMatch(/drifting downward/i)
    expect(summary).not.toMatch(/drifting upward/i)
  })

  it('a still-warming-up window says so instead of overclaiming a trend', () => {
    const frame = makeFrame({
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'warmup', window_fill: 0.4 },
    })
    const summary = summarizeFrameForHumans(frame)
    expect(summary).toMatch(/gathering enough history/i)
  })

  it('velocity and acceleration regimes each get their own distinct wording', () => {
    const velocityFrame = makeFrame({
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'velocity', window_fill: 1 },
    })
    const accelerationFrame = makeFrame({
      temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'acceleration', window_fill: 1 },
    })
    expect(summarizeFrameForHumans(velocityFrame)).toMatch(/faster than usual/i)
    expect(summarizeFrameForHumans(accelerationFrame)).toMatch(/accelerating/i)
  })
})
