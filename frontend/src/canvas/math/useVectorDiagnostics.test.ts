import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVectorDiagnostics } from './useVectorDiagnostics'
import { NETWORK_ERROR_MESSAGE } from '@canvas/upload/dataSourceState'

// ─── Minimal WebSocket stub — useVectorDiagnostics pulls in useVectorStream,
// which opens a real WebSocket on mount. These tests only care about the
// REST ingestion path, so the stub just needs to not throw/hang. ──────────

class StubWebSocket {
  static instances: StubWebSocket[] = []
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    StubWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

beforeEach(() => {
  StubWebSocket.instances = []
  vi.stubGlobal('WebSocket', StubWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── fetch mock ─────────────────────────────────────────────────────────────

const VALID_FRAME_RESPONSE = {
  frame_id: 'abc123',
  timestamp: new Date().toISOString(),
  status: 'NOMINAL',
  point_count: 3,
  coordinates: [{ x: 1, y: 2, z: 3 }],
  cluster_labels: [0],
  anomaly_indices: [],
  explanation: 'all nominal',
  axis_mapping: null,
}

function mockFetchRoutedBy(canvasVectorsHandler: (init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/canvas/vectors')) return canvasVectorsHandler(init)
      if (url.includes('/api/health')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'healthy', llm: 'unknown' }), { status: 200 }),
        )
      }
      return Promise.reject(new TypeError('Failed to fetch (unexpected url in test)'))
    }),
  )
}

function makeNumericCsvFile(): File {
  return new File(['a,b,c\n1,2,3\n4,5,6\n'], 'clean.csv', { type: 'text/csv' })
}

describe('useVectorDiagnostics — error taxonomy', () => {
  it('a genuine transport failure (fetch throws TypeError) produces network_error, not rejected or a generic error', async () => {
    mockFetchRoutedBy(() => Promise.reject(new TypeError('Failed to fetch')))
    const { result } = renderHook(() => useVectorDiagnostics())

    await act(async () => {
      await result.current.ingestFile(makeNumericCsvFile())
    })

    await waitFor(() => {
      expect(result.current.dataSourceState.status).toBe('network_error')
    })
    if (result.current.dataSourceState.status === 'network_error') {
      expect(result.current.dataSourceState.reason).toBe(NETWORK_ERROR_MESSAGE)
    }
  })

  it('a reached-but-rejected backend response (500) produces error, with the status in the message — not "backend unreachable"', async () => {
    mockFetchRoutedBy(() => Promise.resolve(new Response('server exploded', { status: 500 })))
    const { result } = renderHook(() => useVectorDiagnostics())

    await act(async () => {
      await result.current.ingestFile(makeNumericCsvFile())
    })

    await waitFor(() => {
      expect(result.current.dataSourceState.status).toBe('error')
    })
    if (result.current.dataSourceState.status === 'error') {
      expect(result.current.dataSourceState.reason).toContain('500')
      expect(result.current.dataSourceState.reason).not.toContain('unreachable')
    }
  })

  it('a successful response produces loaded, never network_error or error', async () => {
    mockFetchRoutedBy(() =>
      Promise.resolve(new Response(JSON.stringify(VALID_FRAME_RESPONSE), { status: 200 })),
    )
    const { result } = renderHook(() => useVectorDiagnostics())

    await act(async () => {
      await result.current.ingestFile(makeNumericCsvFile())
    })

    await waitFor(() => {
      expect(result.current.dataSourceState.status).toBe('loaded')
    })
  })

  it('a content-validation rejection (package.json-shaped drop) never calls fetch at all', async () => {
    const canvasVectorsFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(VALID_FRAME_RESPONSE), { status: 200 })),
    )
    mockFetchRoutedBy(canvasVectorsFetch)
    const { result } = renderHook(() => useVectorDiagnostics())

    const packageJsonFile = new File(
      [JSON.stringify({ name: 'iye-frontend', version: '0.1.0' })],
      'package.json',
      { type: 'application/json' },
    )

    await act(async () => {
      await result.current.ingestFile(packageJsonFile)
    })

    await waitFor(() => {
      expect(result.current.dataSourceState.status).toBe('rejected')
    })
    expect(canvasVectorsFetch).not.toHaveBeenCalled()
  })

  it('retryIngest re-attempts the same file after a network_error, without needing it re-selected', async () => {
    let shouldFail = true
    mockFetchRoutedBy(() => {
      if (shouldFail) return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve(new Response(JSON.stringify(VALID_FRAME_RESPONSE), { status: 200 }))
    })
    const { result } = renderHook(() => useVectorDiagnostics())

    await act(async () => {
      await result.current.ingestFile(makeNumericCsvFile())
    })
    await waitFor(() => {
      expect(result.current.dataSourceState.status).toBe('network_error')
    })

    shouldFail = false
    await act(async () => {
      await result.current.retryIngest()
    })

    await waitFor(() => {
      expect(result.current.dataSourceState.status).toBe('loaded')
    })
  })

  it('retryIngest is a no-op when nothing is pending', async () => {
    mockFetchRoutedBy(() => Promise.resolve(new Response(JSON.stringify(VALID_FRAME_RESPONSE), { status: 200 })))
    const { result } = renderHook(() => useVectorDiagnostics())

    expect(result.current.dataSourceState.status).toBe('idle')
    await act(async () => {
      await result.current.retryIngest()
    })
    expect(result.current.dataSourceState.status).toBe('idle')
  })
})
