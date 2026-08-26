/**
 * App.upload-wiring.test.tsx (2026-08-28 sprint) — the integration test that
 * would have caught the bug this sprint's Phase 1 fixed: VectorViewport
 * called its own private useVectorStream() instead of receiving data as
 * props, so a REST file upload updated the sidebar but never reached the
 * canvas at all. See docs/idealization_report.md for the full writeup.
 *
 * The real VectorViewport can't mount under jsdom (react-three-fiber's
 * <Canvas> needs a real WebGL context — same documented boundary as
 * App.suspense.test.tsx and VectorViewport.memo.test.tsx), so this mocks
 * @canvas/VectorViewport's default export with a prop-capturing stand-in
 * and drives a real upload through the actual DataSourcePanel file input —
 * proving the wiring from "user drops a file" to "the canvas component's
 * props" end to end, without needing to render a single frame of WebGL.
 */
import { render, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { VectorViewportProps } from '@canvas/VectorViewport'
// vi.mock calls are hoisted above every import in this file (including this
// one) by vitest's transform, so App's lazy(() => import('@canvas/VectorViewport'))
// resolves to the mock below, not the real three.js-backed component.
import App from './App'

let capturedProps: VectorViewportProps | null = null

vi.mock('@canvas/VectorViewport', () => ({
  default: (props: VectorViewportProps) => {
    capturedProps = props
    return null
  },
}))

// ─── Minimal WebSocket stub — same shape as useVectorDiagnostics.test.ts's;
// this test only exercises the REST upload path, so it just needs to exist
// and never throw/hang. ──────────────────────────────────────────────────

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

const UPLOADED_FRAME_RESPONSE = {
  frame_id: 'uploaded-frame-1',
  timestamp: new Date().toISOString(),
  status: 'NOMINAL',
  point_count: 2,
  // Distinctive, easy-to-assert-on coordinates — nothing else in this test
  // produces these values, so finding them in the mock's captured props
  // proves they traveled all the way from the fetch response to the
  // component the real canvas would have rendered.
  coordinates: [
    { x: 111, y: 222, z: 333 },
    { x: 444, y: 555, z: 666 },
  ],
  cluster_labels: [0, 0],
  anomaly_indices: [],
  explanation: 'all nominal',
  axis_mapping: null,
}

function makeNumericCsvFile(): File {
  return new File(['a,b,c\n1,2,3\n4,5,6\n'], 'clean.csv', { type: 'text/csv' })
}

beforeEach(() => {
  capturedProps = null
  StubWebSocket.instances = []
  vi.stubGlobal('WebSocket', StubWebSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/api/canvas/vectors')) {
        return Promise.resolve(new Response(JSON.stringify(UPLOADED_FRAME_RESPONSE), { status: 200 }))
      }
      if (url.includes('/api/health')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'healthy', llm: 'unknown' }), { status: 200 }),
        )
      }
      return Promise.reject(new TypeError('Failed to fetch (unexpected url in test)'))
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App -> VectorViewport upload wiring', () => {
  it('a file dropped through DataSourcePanel reaches VectorViewport as props, not just the sidebar', async () => {
    const { container } = render(<App />)

    await waitFor(() => {
      expect(capturedProps).not.toBeNull()
    })
    // Before any upload: no real data yet, matches VectorViewport's own
    // "fall back to the mock frame" contract (empty positions).
    expect(capturedProps?.positions.length).toBe(0)

    const input = container.querySelector<HTMLInputElement>('#iye-file-input')
    expect(input).not.toBeNull()
    fireEvent.change(input as HTMLInputElement, { target: { files: [makeNumericCsvFile()] } })

    await waitFor(() => {
      expect(capturedProps?.positions.length).toBeGreaterThan(0)
    })

    // The exact uploaded coordinates, flattened — proves this is the real
    // upload response, not e.g. the mock/placeholder frame.
    expect(Array.from(capturedProps!.positions)).toEqual([111, 222, 333, 444, 555, 666])
    expect(capturedProps?.activeFrame?.frame_id).toBe('uploaded-frame-1')
  })
})
