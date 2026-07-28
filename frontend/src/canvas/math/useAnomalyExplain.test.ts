import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAnomalyExplain, type ExplainablePoint } from './useAnomalyExplain'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SAMPLE_POINT: ExplainablePoint = {
  pointIndex: 7,
  coordinates: { x: 1, y: 2, z: 3 },
  zScores: { x: 0.1, y: 4.2, z: 0.3 },
  clusterLabel: -1,
  axesAreRawFeatures: true,
}

function mockFetch(handler: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(handler))
}

describe('useAnomalyExplain', () => {
  it('starts idle and transitions to loading immediately on explainPoint', () => {
    mockFetch(() => new Promise(() => {})) // never resolves — just checking the sync loading transition
    const { result } = renderHook(() => useAnomalyExplain())

    expect(result.current.explainState.status).toBe('idle')

    act(() => {
      result.current.explainPoint(SAMPLE_POINT)
    })

    expect(result.current.explainState).toEqual({ status: 'loading', pointIndex: 7 })
  })

  it('a successful response renders the point-specific explanation', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ point_index: 7, explanation: 'drift on axis y' }), {
          status: 200,
        }),
      ),
    )
    const { result } = renderHook(() => useAnomalyExplain())

    act(() => {
      result.current.explainPoint(SAMPLE_POINT)
    })

    await waitFor(() => {
      expect(result.current.explainState.status).toBe('success')
    })
    expect(result.current.explainState).toEqual({
      status: 'success',
      pointIndex: 7,
      explanation: 'drift on axis y',
    })
  })

  it('a genuine transport failure (fetch throws TypeError) produces an unreachable-backend error, never a silent blank state', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const { result } = renderHook(() => useAnomalyExplain())

    act(() => {
      result.current.explainPoint(SAMPLE_POINT)
    })

    await waitFor(() => {
      expect(result.current.explainState.status).toBe('error')
    })
    if (result.current.explainState.status === 'error') {
      expect(result.current.explainState.reason).toContain('unreachable')
    }
  })

  it('a structured 422 (llm_unavailable) surfaces the backend detail message, not a generic error', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'explain_failed',
            status: 422,
            detail: 'Local LLM is unreachable or timed out — no narrative could be generated',
            stage: 'llm_unavailable',
          }),
          { status: 422 },
        ),
      ),
    )
    const { result } = renderHook(() => useAnomalyExplain())

    act(() => {
      result.current.explainPoint(SAMPLE_POINT)
    })

    await waitFor(() => {
      expect(result.current.explainState.status).toBe('error')
    })
    if (result.current.explainState.status === 'error') {
      expect(result.current.explainState.reason).toContain('unreachable or timed out')
    }
  })

  it('dismiss returns to idle and ignores a stale in-flight response', async () => {
    let resolveFetch: ((r: Response) => void) | null = null
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const { result } = renderHook(() => useAnomalyExplain())

    act(() => {
      result.current.explainPoint(SAMPLE_POINT)
    })
    expect(result.current.explainState.status).toBe('loading')

    act(() => {
      result.current.dismiss()
    })
    expect(result.current.explainState).toEqual({ status: 'idle' })

    // The stale request finally resolves — must NOT resurrect the panel.
    await act(async () => {
      resolveFetch?.(
        new Response(JSON.stringify({ point_index: 7, explanation: 'too late' }), { status: 200 }),
      )
      await Promise.resolve()
    })
    expect(result.current.explainState).toEqual({ status: 'idle' })
  })

  it('clicking a second point supersedes the first — only the latest result is shown', async () => {
    const resolvers: Array<(r: Response) => void> = []
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const { result } = renderHook(() => useAnomalyExplain())

    act(() => {
      result.current.explainPoint(SAMPLE_POINT)
    })
    act(() => {
      result.current.explainPoint({ ...SAMPLE_POINT, pointIndex: 9 })
    })
    expect(result.current.explainState).toEqual({ status: 'loading', pointIndex: 9 })

    // The FIRST (stale) request resolves after the second click — ignored.
    await act(async () => {
      resolvers[0](
        new Response(JSON.stringify({ point_index: 7, explanation: 'stale answer' }), {
          status: 200,
        }),
      )
      await Promise.resolve()
    })
    expect(result.current.explainState).toEqual({ status: 'loading', pointIndex: 9 })

    await act(async () => {
      resolvers[1](
        new Response(JSON.stringify({ point_index: 9, explanation: 'fresh answer' }), {
          status: 200,
        }),
      )
    })
    await waitFor(() => {
      expect(result.current.explainState).toEqual({
        status: 'success',
        pointIndex: 9,
        explanation: 'fresh answer',
      })
    })
  })
})
