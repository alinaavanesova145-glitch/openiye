import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVectorDiagnostics } from './useVectorDiagnostics'
import { NETWORK_ERROR_MESSAGE, UPLOAD_TIMEOUT_MESSAGE } from '@canvas/upload/dataSourceState'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

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

  it('sends column_names (2026-07-31 sprint) so the backend can attribute anomalies to real field names', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null }
    mockFetchRoutedBy((init) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify(VALID_FRAME_RESPONSE), { status: 200 }))
    })
    const { result } = renderHook(() => useVectorDiagnostics())

    await act(async () => {
      await result.current.ingestFile(makeNumericCsvFile())
    })

    await waitFor(() => {
      expect(result.current.dataSourceState.status).toBe('loaded')
    })
    expect(captured.body).not.toBeNull()
    expect(captured.body?.column_names).toEqual(['a', 'b', 'c'])
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

// ─── Concurrent-upload race safety (2026-08-28 sprint) ─────────────────────
// Before this sprint, ingestFile -> attemptIngest -> postMatrix had no
// generation counter and no AbortController: dropping a second file before
// the first settled meant whichever fetch happened to resolve *last* won
// unconditionally, silently reverting the canvas to stale data if the
// earlier upload's response arrived after the later one's.

function makeFrameResponse(frameId: string, x: number): Response {
  return new Response(
    JSON.stringify({
      frame_id: frameId,
      timestamp: new Date().toISOString(),
      status: 'NOMINAL',
      point_count: 1,
      coordinates: [{ x, y: 0, z: 0 }],
      cluster_labels: [0],
      anomaly_indices: [],
      explanation: null,
      axis_mapping: null,
    }),
    { status: 200 },
  )
}

function makeCsvFile(name: string): File {
  return new File(['a,b,c\n1,2,3\n4,5,6\n'], name, { type: 'text/csv' })
}

/** Real fetch() rejects with an AbortError the moment its signal aborts,
 *  even if the underlying request never otherwise settles — the mock fetch
 *  in these tests is a bare deferred promise with nothing wired to the
 *  signal by default, so cancelIngest/the upload timeout (both of which
 *  work by calling AbortController.abort()) would just hang forever
 *  against it without this. */
function rejectOnAbort(signal: AbortSignal | null | undefined, promise: Promise<Response>): Promise<Response> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject)
  })
}

describe('useVectorDiagnostics — concurrent upload race safety', () => {
  it('drop A then B before A settles: B wins, and A resolving late is discarded', async () => {
    const deferredA = deferred<Response>()
    const deferredB = deferred<Response>()
    let canvasVectorsCalls = 0
    mockFetchRoutedBy(() => {
      canvasVectorsCalls += 1
      return canvasVectorsCalls === 1 ? deferredA.promise : deferredB.promise
    })

    const { result } = renderHook(() => useVectorDiagnostics())

    act(() => {
      void result.current.ingestFile(makeCsvFile('a.csv'))
    })
    await waitFor(() => expect(canvasVectorsCalls).toBe(1))

    act(() => {
      void result.current.ingestFile(makeCsvFile('b.csv'))
    })
    await waitFor(() => expect(canvasVectorsCalls).toBe(2))

    // B (the newer upload) settles first.
    await act(async () => {
      deferredB.resolve(makeFrameResponse('frame-b', 222))
      await deferredB.promise
    })
    await waitFor(() => expect(result.current.dataSourceState.status).toBe('loaded'))
    expect(result.current.restFrame?.frame_id).toBe('frame-b')

    // A (superseded, discarded) resolves late -- must NOT revert state to A.
    await act(async () => {
      deferredA.resolve(makeFrameResponse('frame-a', 111))
      await deferredA.promise
    })
    expect(result.current.restFrame?.frame_id).toBe('frame-b')
    expect(result.current.dataSourceState.status).toBe('loaded')
  })

  it('cancelIngest aborts the in-flight request and returns the panel to idle, not an error', async () => {
    const deferredResponse = deferred<Response>()
    let fetchCalls = 0
    mockFetchRoutedBy((init) => {
      fetchCalls += 1
      return rejectOnAbort(init?.signal, deferredResponse.promise)
    })
    const { result } = renderHook(() => useVectorDiagnostics())

    act(() => {
      void result.current.ingestFile(makeCsvFile('slow.csv'))
    })
    // Wait for the actual network POST, not just 'parsing' — ingestFile
    // sets 'parsing' for the (uncancellable, purely local) client-side
    // parse phase too, before an AbortController even exists to cancel.
    await waitFor(() => expect(fetchCalls).toBe(1))

    act(() => {
      result.current.cancelIngest()
    })

    await waitFor(() => expect(result.current.dataSourceState.status).toBe('idle'))
    expect(result.current.restFrame).toBeNull()
  })

  it('a request that never responds times out into network_error, with retry armed', async () => {
    vi.useFakeTimers()
    const deferredResponse = deferred<Response>()
    let fetchCalls = 0
    mockFetchRoutedBy((init) => {
      fetchCalls += 1
      return rejectOnAbort(init?.signal, deferredResponse.promise)
    })
    const { result } = renderHook(() => useVectorDiagnostics())

    await act(async () => {
      void result.current.ingestFile(makeCsvFile('hung.csv'))
      // Let the client-side CSV parse actually reach the network POST
      // before fast-forwarding — the 30s upload timer only starts once
      // that POST is issued, not from ingestFile's own initial 'parsing'.
      await vi.waitFor(() => expect(fetchCalls).toBe(1))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(result.current.dataSourceState.status).toBe('network_error')
    if (result.current.dataSourceState.status === 'network_error') {
      expect(result.current.dataSourceState.reason).toBe(UPLOAD_TIMEOUT_MESSAGE)
    }

    // retry is armed, exactly like any other network_error.
    mockFetchRoutedBy(() => Promise.resolve(makeFrameResponse('frame-retry', 999)))
    await act(async () => {
      await result.current.retryIngest()
    })
    expect(result.current.dataSourceState.status).toBe('loaded')
    vi.useRealTimers()
  })
})
