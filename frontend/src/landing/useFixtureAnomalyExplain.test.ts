import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFixtureAnomalyExplain } from './useFixtureAnomalyExplain'
import { DEMO_ANOMALY_INDICES, DEMO_FEATURE_ATTRIBUTIONS, DEMO_NARRATIVES, DEMO_POINTS } from './demoFixture'
import type { ExplainablePoint } from '@canvas/math/useAnomalyExplain'

function pointFor(index: number): ExplainablePoint {
  const p = DEMO_POINTS.find((d) => d.index === index)
  if (!p) throw new Error(`no fixture point at index ${String(index)}`)
  return {
    pointIndex: p.index,
    coordinates: { x: p.position[0], y: p.position[1], z: p.position[2] },
    zScores: p.zScores,
    clusterLabel: p.clusterLabel,
    axesAreRawFeatures: true,
    featureAttributions: DEMO_FEATURE_ATTRIBUTIONS[p.index] ?? [],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useFixtureAnomalyExplain', () => {
  it('starts idle and transitions to loading immediately on explainPoint', () => {
    const { result } = renderHook(() => useFixtureAnomalyExplain())
    expect(result.current.explainState.status).toBe('idle')

    act(() => {
      result.current.explainPoint(pointFor(DEMO_ANOMALY_INDICES[0]))
    })

    expect(result.current.explainState).toEqual({
      status: 'loading',
      pointIndex: DEMO_ANOMALY_INDICES[0],
    })
  })

  it('resolves to the exact pre-generated narrative for a known anomaly point, with no network call', () => {
    const { result } = renderHook(() => useFixtureAnomalyExplain())
    const idx = DEMO_ANOMALY_INDICES[0]

    act(() => {
      result.current.explainPoint(pointFor(idx))
      vi.runAllTimers()
    })

    expect(result.current.explainState).toEqual({
      status: 'success',
      pointIndex: idx,
      explanation: DEMO_NARRATIVES[idx],
    })
  })

  it('resolves every documented anomaly index to a non-empty narrative', () => {
    for (const idx of DEMO_ANOMALY_INDICES) {
      const { result } = renderHook(() => useFixtureAnomalyExplain())
      act(() => {
        result.current.explainPoint(pointFor(idx))
        vi.runAllTimers()
      })
      expect(result.current.explainState.status).toBe('success')
      if (result.current.explainState.status === 'success') {
        expect(result.current.explainState.explanation.length).toBeGreaterThan(20)
      }
    }
  })

  it('a point index with no fixture narrative resolves to an error, never a silent blank state', () => {
    const { result } = renderHook(() => useFixtureAnomalyExplain())
    act(() => {
      result.current.explainPoint({
        pointIndex: 999,
        coordinates: { x: 0, y: 0, z: 0 },
        zScores: { x: 0, y: 0, z: 0 },
        clusterLabel: -1,
        axesAreRawFeatures: true,
        featureAttributions: [],
      })
      vi.runAllTimers()
    })
    expect(result.current.explainState.status).toBe('error')
  })

  it('dismiss returns to idle and ignores a stale in-flight resolution', () => {
    const { result } = renderHook(() => useFixtureAnomalyExplain())
    const idx = DEMO_ANOMALY_INDICES[0]

    act(() => {
      result.current.explainPoint(pointFor(idx))
    })
    expect(result.current.explainState.status).toBe('loading')

    act(() => {
      result.current.dismiss()
    })
    expect(result.current.explainState).toEqual({ status: 'idle' })

    // Let the (dismissed) simulated delay fully elapse — must not resurrect the panel.
    act(() => {
      vi.runAllTimers()
    })
    expect(result.current.explainState).toEqual({ status: 'idle' })
  })

  it('clicking a second point supersedes the first', () => {
    const { result } = renderHook(() => useFixtureAnomalyExplain())
    const [first, second] = DEMO_ANOMALY_INDICES

    act(() => {
      result.current.explainPoint(pointFor(first))
    })
    act(() => {
      result.current.explainPoint(pointFor(second))
    })
    expect(result.current.explainState).toEqual({ status: 'loading', pointIndex: second })

    act(() => {
      vi.runAllTimers()
    })
    expect(result.current.explainState).toEqual({
      status: 'success',
      pointIndex: second,
      explanation: DEMO_NARRATIVES[second],
    })
  })
})
