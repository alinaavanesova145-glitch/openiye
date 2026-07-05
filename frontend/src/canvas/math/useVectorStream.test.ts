import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVectorStream } from './useVectorStream'

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  url: string
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  triggerMessage(data: unknown) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    this.onmessage?.({ data: payload })
  }

  triggerError() {
    this.onerror?.()
  }

  triggerClose() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
}

function makeFrameMessage(overrides: {
  id?: string
  velocity?: number
  composite_smoothed?: number
  explanation?: string | null
  status?: 'NOMINAL' | 'ANOMALY'
} = {}) {
  return {
    type: 'frame',
    id: overrides.id ?? 'frame-default',
    status: overrides.status ?? 'NOMINAL',
    timestamp: new Date().toISOString(),
    coordinates: [{ x: 1, y: 2, z: 3 }],
    cluster_labels: [0],
    anomaly_indices: [],
    explanation: overrides.explanation ?? null,
    temporal: {
      z_max: 0,
      z_per_dim: [],
      velocity: overrides.velocity ?? 0,
      acceleration: 0,
      drift_slope: 0,
      composite: 0,
      composite_smoothed: overrides.composite_smoothed ?? 0,
      regime: 'stable',
      window_fill: 1,
      dominant_dim: -1,
    },
  }
}

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useVectorStream — connection status', () => {
  it('starts connecting, then reflects connected once the socket opens', () => {
    const { result } = renderHook(() => useVectorStream())
    expect(result.current.streamState).toBe('connecting')

    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())

    expect(result.current.streamState).toBe('connected')
  })

  it('reflects error status when the socket errors', () => {
    const { result } = renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerError())
    expect(result.current.streamState).toBe('error')
  })

  it('reflects disconnected status when the socket closes', () => {
    const { result } = renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())
    act(() => ws.triggerClose())
    expect(result.current.streamState).toBe('disconnected')
  })
})

describe('useVectorStream — frame messages', () => {
  it('updates liveFrame/positions and mutates temporalRef within the same render as the state update', () => {
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount++
      return useVectorStream()
    })
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())

    const rendersBeforeFrame = renderCount
    act(() => {
      ws.triggerMessage(makeFrameMessage({ id: 'f1', velocity: 5, composite_smoothed: 2 }))
    })

    // One combined render for the whole frame update — mutating temporalRef
    // does not add a render of its own on top of the state update.
    expect(renderCount).toBe(rendersBeforeFrame + 1)
    expect(result.current.liveFrame?.id).toBe('f1')
    expect(result.current.positions.length).toBe(3)
    expect(result.current.temporalRef.current.velocity).toBe(5)
    expect(result.current.temporalRef.current.composite_smoothed).toBe(2)
  })

  it('ignores a frame message with no coordinates', () => {
    const { result } = renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'frame', id: 'empty', coordinates: [] }))
    expect(result.current.liveFrame).toBeNull()
  })
})

describe('useVectorStream — narrative messages', () => {
  it('merges a narrative into liveFrame when the id matches', () => {
    const { result } = renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage(makeFrameMessage({ id: 'f1', explanation: null })))
    expect(result.current.liveFrame?.explanation).toBeNull()

    act(() => ws.triggerMessage({ type: 'narrative', id: 'f1', explanation: 'it broke' }))

    expect(result.current.liveFrame?.explanation).toBe('it broke')
    expect(result.current.narrativeHistory).toHaveLength(0)
  })

  it('routes a stale-id narrative into narrativeHistory instead of dropping it', () => {
    const { result } = renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage(makeFrameMessage({ id: 'f1', explanation: null })))
    act(() => ws.triggerMessage(makeFrameMessage({ id: 'f2', explanation: null }))) // f1 replaced

    act(() => ws.triggerMessage({ type: 'narrative', id: 'f1', explanation: 'stale explanation' }))

    expect(result.current.liveFrame?.explanation).not.toBe('stale explanation')
    expect(result.current.narrativeHistory).toEqual([{ id: 'f1', explanation: 'stale explanation' }])
  })

  it('surfaces a narrative that arrives before any frame (out-of-order delivery)', () => {
    const { result } = renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())

    act(() => ws.triggerMessage({ type: 'narrative', id: 'f0', explanation: 'early narrative' }))

    expect(result.current.liveFrame).toBeNull()
    expect(result.current.narrativeHistory).toEqual([{ id: 'f0', explanation: 'early narrative' }])
  })
})

describe('useVectorStream — resilience', () => {
  it('drops malformed JSON without throwing or changing state', () => {
    const { result } = renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())

    expect(() => {
      act(() => ws.triggerMessage('{not valid json'))
    }).not.toThrow()
    expect(result.current.liveFrame).toBeNull()
  })

  it('reconnects with backoff after the socket closes', () => {
    vi.useFakeTimers()
    renderHook(() => useVectorStream())
    const ws = MockWebSocket.instances[0]
    act(() => ws.triggerOpen())
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => ws.triggerClose())
    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(MockWebSocket.instances.length).toBeGreaterThan(1)
  })
})
