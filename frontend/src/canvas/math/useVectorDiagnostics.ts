/**
 * useVectorDiagnostics — Unified diagnostics hook merging REST file-upload
 * and live WebSocket stream data paths.
 *
 * Data priority contract: if a live streaming frame (liveFrame) is present
 * and the WebSocket is connected, it takes visual priority on the canvas
 * over manual file-drop uploads.
 */

import { useState, useCallback, useMemo } from 'react'
import {
  useVectorStream,
  DEFAULT_TEMPORAL_METRICS,
  type VectorFrame,
  type StreamState,
  type StreamConfig,
} from './useVectorStream'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result shape returned by the unified diagnostics hook. */
export interface VectorDiagnosticsResult {
  /** The active frame shown on the canvas (live takes priority over REST). */
  activeFrame: VectorFrame | null
  /** Current WebSocket connection state. */
  streamState: StreamState
  /** Process a file-uploaded raw data buffer into a VectorFrame via REST. */
  processVectors: (rawData: Float32Array) => Promise<void>
  /** Send live axis remapping configuration to the backend stream. */
  configureStream: (config: StreamConfig) => void
  /** True when the canvas is driven by the live WebSocket stream. */
  isLive: boolean
  /** The most recent REST-uploaded frame, if any. */
  restFrame: VectorFrame | null
  /** True while a REST upload is in progress. */
  isProcessing: boolean
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVectorDiagnostics(): VectorDiagnosticsResult {
  const { streamState, liveFrame, configureStream, activePort } = useVectorStream()

  const [restFrame, setRestFrame] = useState<VectorFrame | null>(null)
  const [isProcessing, setIsProcessing] = useState<boolean>(false)

  // ── REST file-upload processing ─────────────────────────────────────────

  const processVectors = useCallback(async (rawData: Float32Array) => {
    setIsProcessing(true)
    try {
      // Convert Float32Array to a nested array of numbers for the JSON payload.
      // The backend expects a flat array and will reshape it.
      const dataArray: number[] = Array.from(rawData)

      const response = await fetch(`http://127.0.0.1:${activePort}/api/canvas/vectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataArray }),
      })

      if (!response.ok) {
        throw new Error(`REST upload failed: ${response.status}`)
      }

      const frame: unknown = await response.json()

      // Validate the response matches VectorFrame structure, then normalize:
      // the REST endpoint predates the temporal engine and won't send `id`/
      // `temporal`, so fill in safe defaults rather than let consumers (e.g.
      // DiagnosticSidebar reading frame.temporal.window_fill) crash on undefined.
      if (isValidVectorFrame(frame)) {
        const normalized: VectorFrame = {
          ...frame,
          id: frame.frame_id,
          temporal: DEFAULT_TEMPORAL_METRICS,
        }
        setRestFrame(normalized)
      }
    } catch (err) {
      // Log the error class but not raw user data
      const errorMessage = err instanceof Error ? err.message : 'unknown error'
      console.error(`processVectors failed: ${errorMessage}`)
    } finally {
      setIsProcessing(false)
    }
  }, [])

  // ── Data priority: live stream > REST upload ────────────────────────────

  const isLive = liveFrame !== null && streamState === 'connected'
  const activeFrame = useMemo<VectorFrame | null>(
    () => (isLive ? liveFrame : restFrame),
    [isLive, liveFrame, restFrame],
  )

  return {
    activeFrame,
    streamState,
    processVectors,
    configureStream,
    isLive,
    restFrame,
    isProcessing,
  }
}

// ─── Validation (shared with useVectorStream) ─────────────────────────────────

function isValidVectorFrame(data: unknown): data is VectorFrame {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>

  return (
    typeof obj.frame_id === 'string' &&
    typeof obj.timestamp === 'string' &&
    (obj.status === 'NOMINAL' || obj.status === 'ANOMALY') &&
    typeof obj.point_count === 'number' &&
    Array.isArray(obj.coordinates) &&
    Array.isArray(obj.cluster_labels) &&
    Array.isArray(obj.anomaly_indices) &&
    (obj.explanation === null || typeof obj.explanation === 'string')
  )
}
