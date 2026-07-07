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
import { parseFile, MAX_UPLOAD_BYTES } from '@canvas/upload/parseMatrix'
import { IDLE_DATA_SOURCE_STATE, type DataSourceState } from '@canvas/upload/dataSourceState'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result shape returned by the unified diagnostics hook. */
export interface VectorDiagnosticsResult {
  /** The active frame shown on the canvas (live takes priority over REST). */
  activeFrame: VectorFrame | null
  /** Current WebSocket connection state. */
  streamState: StreamState
  /** Parse a dropped/selected file and, if valid, ingest it through the same
   *  detection pipeline the live stream uses. */
  ingestFile: (file: File) => Promise<void>
  /** Send live axis remapping configuration to the backend stream. */
  configureStream: (config: StreamConfig) => void
  /** True when the canvas is driven by the live WebSocket stream. */
  isLive: boolean
  /** The most recent REST-uploaded frame, if any. */
  restFrame: VectorFrame | null
  /** Explicit DATA SOURCE panel state — see dataSourceState.ts. */
  dataSourceState: DataSourceState
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVectorDiagnostics(): VectorDiagnosticsResult {
  const { streamState, liveFrame, configureStream, activePort } = useVectorStream()

  const [restFrame, setRestFrame] = useState<VectorFrame | null>(null)
  const [dataSourceState, setDataSourceState] = useState<DataSourceState>(IDLE_DATA_SOURCE_STATE)

  // ── REST ingestion — same batch route the SDK/live stream uses ──────────
  // MatrixUploadRequest.matrix (a 2D array) is sent directly rather than
  // hand-flattened into `data`/`dim`; this is the path the backend schema
  // already supported but the frontend never used (see idealization_report.md,
  // 2026-07-07 sprint, Phase 1).

  const postMatrix = useCallback(
    async (rows: number[][]): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${String(activePort)}/api/canvas/vectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matrix: rows }),
      })

      if (!response.ok) {
        throw new Error(`REST upload failed: ${String(response.status)}`)
      }

      const frame: unknown = await response.json()

      // Validate the response matches VectorFrame structure, then normalize:
      // the REST endpoint predates the temporal engine and won't send `id`/
      // `temporal`, so fill in safe defaults rather than let consumers (e.g.
      // DiagnosticSidebar reading frame.temporal.window_fill) crash on undefined.
      // (The live WS frame carrying the real temporal/narrative data arrives
      // separately and takes rendering priority once it does — see isLive.)
      if (isValidVectorFrame(frame)) {
        const normalized: VectorFrame = {
          ...frame,
          id: frame.frame_id,
          temporal: DEFAULT_TEMPORAL_METRICS,
        }
        setRestFrame(normalized)
      }
    },
    [activePort],
  )

  // ── File ingestion orchestration: size cap → parse → ingest ─────────────

  const ingestFile = useCallback(
    async (file: File): Promise<void> => {
      if (file.size > MAX_UPLOAD_BYTES) {
        const limitMb = (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)
        const sizeMb = (file.size / (1024 * 1024)).toFixed(1)
        setDataSourceState({
          status: 'rejected',
          filename: file.name,
          reason: `file exceeds ${limitMb}mb limit · ${sizeMb}mb`,
        })
        return
      }

      setDataSourceState({ status: 'parsing', filename: file.name })

      const outcome = await parseFile(file)
      if (outcome.kind === 'rejected') {
        setDataSourceState({ status: 'rejected', filename: file.name, reason: outcome.reason })
        return
      }

      const { rows, rowCount, dim, totalColumns, droppedColumns, droppedRows } = outcome.matrix

      try {
        await postMatrix(rows)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'unknown error'
        console.error(`ingestFile: backend ingest failed: ${errorMessage}`)
        setDataSourceState({
          status: 'error',
          filename: file.name,
          reason: 'ingest failed · backend unreachable',
        })
        return
      }

      if (droppedColumns > 0 || droppedRows > 0) {
        setDataSourceState({
          status: 'partial',
          filename: file.name,
          rowCount,
          dim,
          totalColumns,
          droppedColumns,
          droppedRows,
        })
      } else {
        setDataSourceState({ status: 'loaded', filename: file.name, rowCount, dim })
      }
    },
    [postMatrix],
  )

  // ── Data priority: live stream > REST upload ────────────────────────────

  const isLive = liveFrame !== null && streamState === 'connected'
  const activeFrame = useMemo<VectorFrame | null>(
    () => (isLive ? liveFrame : restFrame),
    [isLive, liveFrame, restFrame],
  )

  return {
    activeFrame,
    streamState,
    ingestFile,
    configureStream,
    isLive,
    restFrame,
    dataSourceState,
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
