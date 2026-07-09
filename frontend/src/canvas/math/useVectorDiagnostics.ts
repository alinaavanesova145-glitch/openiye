/**
 * useVectorDiagnostics — Unified diagnostics hook merging REST file-upload
 * and live WebSocket stream data paths.
 *
 * Data priority contract: if a live streaming frame (liveFrame) is present
 * and the WebSocket is connected, it takes visual priority on the canvas
 * over manual file-drop uploads.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  useVectorStream,
  DEFAULT_TEMPORAL_METRICS,
  type VectorFrame,
  type StreamState,
  type StreamConfig,
} from './useVectorStream'
import { parseFile, detectFormat, MAX_UPLOAD_BYTES, type EncodingSummary } from '@canvas/upload/parseMatrix'
import { IDLE_DATA_SOURCE_STATE, type DataSourceState } from '@canvas/upload/dataSourceState'

/** Wire shape for MatrixUploadRequest.encoding_summary (additive, snake_case
 *  to match the rest of the WS/REST payload convention). See docs/protocol.md. */
function toWireEncodingSummary(encoding: EncodingSummary) {
  return {
    total_columns: encoding.totalColumns,
    numeric_columns: encoding.numericColumns,
    encoded_categorical_columns: encoding.encodedCategoricalColumns,
    encoded_dims: encoding.encodedDims,
    skipped_free_text: encoding.skippedFreeText,
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Coarse-grained LLM availability from /api/health — refreshed at mount and
 *  after each anomaly narrative resolves, never polled per-frame or on a
 *  timer. See docs/idealization_report.md, Phase 3. */
export type LlmStatus = 'unknown' | 'ready' | 'offline'

/** Result shape returned by the unified diagnostics hook. */
export interface VectorDiagnosticsResult {
  /** The active frame shown on the canvas (live takes priority over REST). */
  activeFrame: VectorFrame | null
  /** Current WebSocket connection state. */
  streamState: StreamState
  /** Parse a dropped/selected file and, if valid, ingest it through the same
   *  detection pipeline the live stream uses. */
  ingestFile: (file: File) => Promise<void>
  /** Confirms a pending `offer` state (zero-numeric-columns, encodable
   *  categorical file) — only now does the ingest/visualize actually run. */
  confirmOffer: () => Promise<void>
  /** Dismisses a pending `offer` back to `idle` without ever ingesting. */
  dismissOffer: () => void
  /** Send live axis remapping configuration to the backend stream. */
  configureStream: (config: StreamConfig) => void
  /** True when the canvas is driven by the live WebSocket stream. */
  isLive: boolean
  /** The most recent REST-uploaded frame, if any. */
  restFrame: VectorFrame | null
  /** Explicit DATA SOURCE panel state — see dataSourceState.ts. */
  dataSourceState: DataSourceState
  /** Ollama availability, per the backend's own startup healthcheck. */
  llmStatus: LlmStatus
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVectorDiagnostics(): VectorDiagnosticsResult {
  const { streamState, liveFrame, configureStream, activePort } = useVectorStream()

  const [restFrame, setRestFrame] = useState<VectorFrame | null>(null)
  const [dataSourceState, setDataSourceState] = useState<DataSourceState>(IDLE_DATA_SOURCE_STATE)
  const [llmStatus, setLlmStatus] = useState<LlmStatus>('unknown')

  const refreshLlmStatus = useCallback(
    (signal?: { cancelled: boolean }) => {
      fetch(`http://127.0.0.1:${String(activePort)}/api/health`)
        .then((res) => res.json())
        .then((body: unknown) => {
          if (signal?.cancelled) return
          const status =
            typeof body === 'object' && body !== null && (body as Record<string, unknown>).llm
          setLlmStatus(status === 'ready' || status === 'offline' ? status : 'unknown')
        })
        .catch(() => {
          if (!signal?.cancelled) setLlmStatus('unknown')
        })
    },
    [activePort],
  )

  // Checked once at mount, and again — event-driven, not on a timer — every
  // time an anomaly frame's explanation actually resolves (real or
  // fallback), mirroring exactly when the backend itself last touched
  // Ollama. Never polled per-frame or on an interval.
  useEffect(() => {
    const signal = { cancelled: false }
    refreshLlmStatus(signal)
    return () => {
      signal.cancelled = true
    }
  }, [refreshLlmStatus])

  const narrativeResolutionKey =
    liveFrame?.status === 'ANOMALY' && liveFrame.explanation !== null
      ? `${liveFrame.id}:${liveFrame.explanation}`
      : null

  useEffect(() => {
    if (narrativeResolutionKey === null) return
    const signal = { cancelled: false }
    refreshLlmStatus(signal)
    return () => {
      signal.cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the resolution event itself, not refreshLlmStatus's identity
  }, [narrativeResolutionKey])

  // ── REST ingestion — same batch route the SDK/live stream uses ──────────
  // MatrixUploadRequest.matrix (a 2D array) is sent directly rather than
  // hand-flattened into `data`/`dim`; this is the path the backend schema
  // already supported but the frontend never used (see idealization_report.md,
  // 2026-07-07 sprint, Phase 1).

  const postMatrix = useCallback(
    async (rows: number[][], encoding?: EncodingSummary): Promise<void> => {
      const body: Record<string, unknown> = { matrix: rows }
      // Only sent when categorical encoding actually happened — omitted
      // entirely for a pure-numeric upload, so that request shape is
      // byte-for-byte unchanged from before this field existed.
      if (encoding && encoding.encodedCategoricalColumns > 0) {
        body.encoding_summary = toWireEncodingSummary(encoding)
      }
      const response = await fetch(`http://127.0.0.1:${String(activePort)}/api/canvas/vectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
  // A zero-numeric-columns file with encodable categorical structure stops
  // at `offer` — nothing is ingested/visualized until the user explicitly
  // confirms (see confirmOffer/dismissOffer below). IYE never fabricates
  // geometry from pure-text data without consent.

  const pendingOfferRef = useRef<{ filename: string; rows: number[][]; encoding: EncodingSummary } | null>(
    null,
  )

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

      // Real (not simulated) progress for the chunked CSV path only — JSON.parse
      // and the NPY byte-reader are atomic, so there's no honest percentage to
      // report for them; they stay a bare "parsing…".
      const onProgress =
        detectFormat(file.name) === 'csv'
          ? (rowsParsed: number, totalRows: number): void => {
              setDataSourceState({
                status: 'parsing',
                filename: file.name,
                progress: totalRows > 0 ? rowsParsed / totalRows : undefined,
              })
            }
          : undefined

      const outcome = await parseFile(file, onProgress)
      if (outcome.kind === 'rejected') {
        setDataSourceState({ status: 'rejected', filename: file.name, reason: outcome.reason })
        return
      }

      if (outcome.kind === 'offer') {
        pendingOfferRef.current = {
          filename: file.name,
          rows: outcome.matrix.rows,
          encoding: outcome.matrix.encoding,
        }
        setDataSourceState({
          status: 'offer',
          filename: file.name,
          rowCount: outcome.matrix.rowCount,
          dim: outcome.matrix.dim,
          encoding: outcome.matrix.encoding,
        })
        return
      }

      const { rows, rowCount, dim, totalColumns, skippedFreeText, droppedRows, encoding } = outcome.matrix

      try {
        await postMatrix(rows, encoding)
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

      // Encoding categoricals is a normal, labeled outcome, not a degradation
      // — `partial` fires only on genuine information loss (free text
      // skipped, ragged rows dropped), never merely because encoding happened.
      if (skippedFreeText > 0 || droppedRows > 0) {
        setDataSourceState({
          status: 'partial',
          filename: file.name,
          rowCount,
          dim,
          totalColumns,
          skippedFreeText,
          droppedRows,
          encoding,
        })
      } else {
        setDataSourceState({ status: 'loaded', filename: file.name, rowCount, dim, encoding })
      }
    },
    [postMatrix],
  )

  const confirmOffer = useCallback(async (): Promise<void> => {
    const pending = pendingOfferRef.current
    if (!pending) return
    const { filename, rows, encoding } = pending
    pendingOfferRef.current = null

    try {
      await postMatrix(rows, encoding)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'unknown error'
      console.error(`confirmOffer: backend ingest failed: ${errorMessage}`)
      setDataSourceState({ status: 'error', filename, reason: 'ingest failed · backend unreachable' })
      return
    }

    setDataSourceState({
      status: 'loaded',
      filename,
      rowCount: rows.length,
      dim: encoding.encodedDims,
      encoding,
    })
  }, [postMatrix])

  const dismissOffer = useCallback((): void => {
    pendingOfferRef.current = null
    setDataSourceState(IDLE_DATA_SOURCE_STATE)
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
    ingestFile,
    confirmOffer,
    dismissOffer,
    configureStream,
    isLive,
    restFrame,
    dataSourceState,
    llmStatus,
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
