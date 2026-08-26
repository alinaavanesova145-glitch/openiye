/**
 * useVectorDiagnostics — Unified diagnostics hook merging REST file-upload
 * and live WebSocket stream data paths.
 *
 * Data priority contract: if a live streaming frame (liveFrame) is present
 * and the WebSocket is connected, it takes visual priority on the canvas
 * over manual file-drop uploads.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import {
  useVectorStream,
  DEFAULT_TEMPORAL_METRICS,
  type VectorFrame,
  type StreamState,
  type StreamConfig,
  type TemporalMetrics,
  type VectorCoordinate3D,
  type FeatureAttribution,
  type NarrativeHistoryEntry,
} from './useVectorStream'
import { parseFile, detectFormat, MAX_UPLOAD_BYTES, type EncodingSummary } from '@canvas/upload/parseMatrix'
import { API_BASE } from '@lib/apiConfig'
import {
  IDLE_DATA_SOURCE_STATE,
  NETWORK_ERROR_MESSAGE,
  UPLOAD_TIMEOUT_MESSAGE,
  type DataSourceState,
} from '@canvas/upload/dataSourceState'

/** A hung/slow backend response otherwise left 'parsing' stuck forever with
 *  no way out (2026-08-28 sprint) — matches the on-demand explain
 *  endpoint's own 30s budget (EXPLAIN_LLM_TIMEOUT_SECONDS in
 *  backend/app/api/main.py), a precedent for "a user actively waiting on
 *  an upload deserves a similarly generous window," not an arbitrary
 *  separate number. */
const UPLOAD_TIMEOUT_MS = 30000

/**
 * Thrown by postMatrix specifically when the backend was reached but
 * returned a non-2xx response — distinct from a network-transport failure
 * (fetch() throws a plain TypeError for those; see classifyIngestFailure).
 */
class ServerIngestError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`REST upload failed: ${String(status)}`)
    this.name = 'ServerIngestError'
    this.status = status
  }
}

/**
 * Error taxonomy (2026-07-14 sprint, Phase 1). Root cause of the reported
 * bug: postMatrix's `throw new Error(...)` for a non-ok response and
 * fetch()'s own TypeError for a genuine transport failure (connection
 * refused, CORS block, DNS failure) both used to be caught by the exact
 * same generic `catch` in ingestFile/confirmOffer and collapsed into one
 * `error` state with one fixed "backend unreachable" message — accurate
 * wording for the transport case, actively misleading for the
 * reached-but-rejected case. `fetch()` throwing TypeError specifically for
 * network-level failures is standard Fetch API behavior; checking
 * `instanceof TypeError` right after a fetch()-wrapping try/catch is the
 * reliable signal here, since nothing else in postMatrix's body throws that
 * type.
 */
function classifyIngestFailure(err: unknown): { status: 'network_error' | 'error'; reason: string } {
  if (err instanceof TypeError) {
    return { status: 'network_error', reason: NETWORK_ERROR_MESSAGE }
  }
  if (err instanceof ServerIngestError) {
    return {
      status: 'error',
      reason: `ingest failed · server rejected the request (status ${String(err.status)})`,
    }
  }
  return { status: 'error', reason: 'ingest failed · unexpected error' }
}

/** Everything needed to either retry a failed ingest or settle the panel
 *  into partial/loaded once it succeeds. */
interface PendingIngest {
  origin: 'ingest' | 'offer'
  filename: string
  rows: number[][]
  rowCount: number
  dim: number
  totalColumns: number
  skippedFreeText: number
  droppedRows: number
  encoding: EncodingSummary
}

/** `offer` always settles to `loaded` (unchanged from the 2026-07-12
 *  sprint's confirmOffer behavior) since reaching `offer` already implies
 *  zero numeric columns; `ingest` follows the same partial-vs-loaded rule
 *  ingestFile always used. Shared so a successful retry settles identically
 *  to a first-try success, regardless of which path it originated from. */
function settleDataSourceState(pending: PendingIngest): DataSourceState {
  const { filename, rowCount, dim, encoding } = pending
  if (pending.origin === 'offer') {
    return { status: 'loaded', filename, rowCount, dim, encoding }
  }
  if (pending.skippedFreeText > 0 || pending.droppedRows > 0) {
    return {
      status: 'partial',
      filename,
      rowCount,
      dim,
      totalColumns: pending.totalColumns,
      skippedFreeText: pending.skippedFreeText,
      droppedRows: pending.droppedRows,
      encoding,
    }
  }
  return { status: 'loaded', filename, rowCount, dim, encoding }
}

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
  /** Re-attempts the last ingest that failed with `network_error`. No-op if
   *  nothing is pending. */
  retryIngest: () => Promise<void>
  /** Aborts whichever ingest request is currently in flight, returning the
   *  panel to idle. No-op if nothing is in flight. */
  cancelIngest: () => void
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
  /** Flattened [x,y,z,...] positions for `activeFrame` — live or REST,
   *  whichever `activeFrame` currently resolves to. The single source
   *  VectorViewport renders from; see the module docstring. */
  activePositions: Float32Array
  /** `activeFrame.anomaly_indices`, or [] before any frame exists. */
  activeAnomalyIndices: number[]
  /** `activeFrame.cluster_labels`, or [] before any frame exists. */
  activeClusterLabels: number[]
  /** `activeFrame.point_z_scores`, or [] before any frame exists. */
  activePointZScores: VectorCoordinate3D[]
  /** `activeFrame.point_feature_attributions`, or [] before any frame exists. */
  activePointFeatureAttributions: FeatureAttribution[][]
  /** Latest temporal metrics ref, passed through from useVectorStream — see
   *  that hook's own doc comment for why this is a ref, not state. Only
   *  ever mutated by the live WS path; a REST-only session simply never
   *  advances past DEFAULT_TEMPORAL_METRICS, which is the correct "no
   *  live temporal signal exists for this" reading. */
  temporalRef: MutableRefObject<TemporalMetrics>
  /** Narrative texts that arrived after the frame they explained was
   *  already replaced — passed through from useVectorStream. */
  narrativeHistory: NarrativeHistoryEntry[]
}

const EMPTY_POSITIONS = new Float32Array(0)
const EMPTY_NUMBER_ARRAY: number[] = []
const EMPTY_Z_SCORE_ARRAY: VectorCoordinate3D[] = []
const EMPTY_FEATURE_ATTRIBUTIONS_ARRAY: FeatureAttribution[][] = []

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVectorDiagnostics(): VectorDiagnosticsResult {
  // The single useVectorStream() instance for the whole app (2026-08-28
  // sprint) — previously VectorViewport also called this hook directly,
  // opening a second independent WebSocket connection per tab and leaving
  // the canvas with no way to ever see a REST-uploaded frame at all (see
  // docs/idealization_report.md for the full writeup). Everything the
  // canvas needs — positions, temporalRef, narrativeHistory — now flows
  // out of this hook instead.
  const { streamState, liveFrame, configureStream, positions: streamPositions, temporalRef, narrativeHistory } =
    useVectorStream()

  const [restFrame, setRestFrame] = useState<VectorFrame | null>(null)
  const [dataSourceState, setDataSourceState] = useState<DataSourceState>(IDLE_DATA_SOURCE_STATE)
  const [llmStatus, setLlmStatus] = useState<LlmStatus>('unknown')

  const refreshLlmStatus = useCallback((signal?: { cancelled: boolean }) => {
    fetch(`${API_BASE}/api/health`)
      .then((res) => res.json())
      .then((body: unknown) => {
        if (signal?.cancelled) return
        const status = typeof body === 'object' && body !== null && (body as Record<string, unknown>).llm
        setLlmStatus(status === 'ready' || status === 'offline' ? status : 'unknown')
      })
      .catch(() => {
        if (!signal?.cancelled) setLlmStatus('unknown')
      })
  }, [])

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
    async (
      rows: number[][],
      encoding: EncodingSummary | undefined,
      signal: AbortSignal,
    ): Promise<VectorFrame | null> => {
      const body: Record<string, unknown> = { matrix: rows }
      // Only sent when categorical encoding actually happened — omitted
      // entirely for a pure-numeric upload, so that request shape is
      // byte-for-byte unchanged from before this field existed.
      if (encoding && encoding.encodedCategoricalColumns > 0) {
        body.encoding_summary = toWireEncodingSummary(encoding)
      }
      // One name per final matrix column (2026-07-31 sprint) — lets the
      // backend attribute an anomaly back to a real field name instead of
      // an opaque axis. Omitted when there's nothing real to send (e.g. a
      // headerless NPY upload, or a bare array-of-arrays JSON file), so the
      // backend's existing axis-based fallback applies exactly as before.
      if (encoding && encoding.featureNames.length > 0) {
        body.column_names = encoding.featureNames
      }
      const response = await fetch(`${API_BASE}/api/canvas/vectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })

      if (!response.ok) {
        throw new ServerIngestError(response.status)
      }

      const frame: unknown = await response.json()

      // Validate the response matches VectorFrame structure, then normalize:
      // the REST endpoint predates the temporal engine and won't send `id`/
      // `temporal`, so fill in safe defaults rather than let consumers (e.g.
      // DiagnosticSidebar reading frame.temporal.window_fill) crash on undefined.
      // (The live WS frame carrying the real temporal/narrative data arrives
      // separately and takes rendering priority once it does — see isLive.)
      //
      // Deliberately doesn't call setRestFrame itself (2026-08-28 sprint) —
      // it used to, unconditionally, which bypassed attemptIngest's
      // generation guard entirely: a superseded request's late response
      // could still silently overwrite restFrame with stale data even
      // though the *visible* dataSourceState correctly stayed on the newer
      // upload. Returning the frame and letting attemptIngest apply it
      // (after re-checking the generation) closes that gap.
      return isValidVectorFrame(frame)
        ? { ...frame, id: frame.frame_id, temporal: DEFAULT_TEMPORAL_METRICS }
        : null
    },
    [],
  )

  // ── File ingestion orchestration: size cap → parse → ingest ─────────────
  // A zero-numeric-columns file with encodable categorical structure stops
  // at `offer` — nothing is ingested/visualized until the user explicitly
  // confirms (see confirmOffer/dismissOffer below). IYE never fabricates
  // geometry from pure-text data without consent.

  const pendingOfferRef = useRef<{ filename: string; rows: number[][]; encoding: EncodingSummary } | null>(
    null,
  )
  // Populated on every network_error (from either origin below) so `retry`
  // can re-POST without asking the user to re-select/re-drop the file.
  const pendingRetryRef = useRef<PendingIngest | null>(null)

  // ── Race-safety for concurrent uploads (2026-08-28 sprint) ───────────────
  // Mirrors useAnomalyExplain.ts's requestGenerationRef pattern, plus an
  // AbortController this hook needs that the click-to-explain hook doesn't:
  // dropping file B before file A settles must make B win unconditionally —
  // including actually tearing down A's in-flight request, not just
  // ignoring its eventual response — and 'parsing' needs a real way out
  // (cancel, or a timeout) instead of hanging forever on a hung backend.
  const requestGenerationRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  // Set immediately before calling abort() so the resulting catch handler
  // can tell *why* the request was aborted — fetch's AbortError itself
  // doesn't distinguish supersede/user-cancel/timeout, and each needs
  // different handling (silently ignore / return to idle / surface a
  // timeout-flavored network_error).
  const abortReasonRef = useRef<'cancel' | 'timeout' | null>(null)

  /** Shared by ingestFile and confirmOffer/retryIngest: POSTs, and on
   *  failure classifies + records a retry candidate + sets the right state.
   *  Returns true on success. A new call supersedes (aborts) any call
   *  already in flight. */
  const attemptIngest = useCallback(
    async (pending: PendingIngest): Promise<boolean> => {
      abortControllerRef.current?.abort() // supersede whatever was in flight
      const controller = new AbortController()
      abortControllerRef.current = controller
      abortReasonRef.current = null
      const generation = ++requestGenerationRef.current

      const timeoutId = setTimeout(() => {
        abortReasonRef.current = 'timeout'
        controller.abort()
      }, UPLOAD_TIMEOUT_MS)

      let normalizedFrame: VectorFrame | null
      try {
        normalizedFrame = await postMatrix(pending.rows, pending.encoding, controller.signal)
      } catch (err) {
        clearTimeout(timeoutId)
        if (requestGenerationRef.current !== generation) return false // superseded — the newer request owns state now
        if (abortReasonRef.current === 'cancel') {
          pendingRetryRef.current = null
          setDataSourceState(IDLE_DATA_SOURCE_STATE)
          return false
        }
        const { status, reason } =
          abortReasonRef.current === 'timeout'
            ? { status: 'network_error' as const, reason: UPLOAD_TIMEOUT_MESSAGE }
            : classifyIngestFailure(err)
        console.error(`ingest failed (${status}): ${err instanceof Error ? err.message : 'unknown error'}`)
        pendingRetryRef.current = status === 'network_error' ? pending : null
        setDataSourceState({ status, filename: pending.filename, reason })
        return false
      }
      clearTimeout(timeoutId)
      if (requestGenerationRef.current !== generation) return false // superseded — the newer request owns state now
      if (normalizedFrame) setRestFrame(normalizedFrame)
      pendingRetryRef.current = null
      setDataSourceState(settleDataSourceState(pending))
      return true
    },
    [postMatrix],
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
      await attemptIngest({
        origin: 'ingest',
        filename: file.name,
        rows,
        rowCount,
        dim,
        totalColumns,
        skippedFreeText,
        droppedRows,
        encoding,
      })
    },
    [attemptIngest],
  )

  const confirmOffer = useCallback(async (): Promise<void> => {
    const pending = pendingOfferRef.current
    if (!pending) return
    pendingOfferRef.current = null
    await attemptIngest({
      origin: 'offer',
      filename: pending.filename,
      rows: pending.rows,
      rowCount: pending.rows.length,
      dim: pending.encoding.encodedDims,
      totalColumns: pending.encoding.totalColumns,
      skippedFreeText: pending.encoding.skippedFreeText,
      droppedRows: 0,
      encoding: pending.encoding,
    })
  }, [attemptIngest])

  const dismissOffer = useCallback((): void => {
    pendingOfferRef.current = null
    setDataSourceState(IDLE_DATA_SOURCE_STATE)
  }, [])

  /** Re-attempts the last ingest that failed with `network_error`, without
   *  requiring the user to re-select the file. No-op if nothing is pending
   *  (e.g. called after a different state already superseded it). */
  const retryIngest = useCallback(async (): Promise<void> => {
    const pending = pendingRetryRef.current
    if (!pending) return
    setDataSourceState({ status: 'parsing', filename: pending.filename })
    await attemptIngest(pending)
  }, [attemptIngest])

  /** Aborts whichever ingest request is currently in flight (the network
   *  POST specifically — client-side file parsing isn't cancellable this
   *  way, but it's local and bounded by MAX_UPLOAD_BYTES, not the "hung
   *  forever" risk this exists for). No-op if nothing is in flight. Returns
   *  the panel to idle rather than surfacing an error — a user-initiated
   *  cancel isn't a failure. */
  const cancelIngest = useCallback((): void => {
    abortReasonRef.current = 'cancel'
    abortControllerRef.current?.abort()
  }, [])

  // ── Data priority: live stream > REST upload ────────────────────────────

  const isLive = liveFrame !== null && streamState === 'connected'
  const activeFrame = useMemo<VectorFrame | null>(
    () => (isLive ? liveFrame : restFrame),
    [isLive, liveFrame, restFrame],
  )

  // ── Canvas-facing derived data ───────────────────────────────────────────
  // Everything VectorViewport renders, resolved from activeFrame so the
  // canvas always shows whatever the rest of the app is showing — live or
  // uploaded. Only `positions` needs the isLive branch: VectorFrame carries
  // coordinates as {x,y,z}[], not a flat Float32Array, and useVectorStream's
  // own `positions` is already reference-stable across unchanged live
  // frames (see that hook's "Referential stability" section) — recomputing
  // it here from liveFrame.coordinates on every frame message would defeat
  // that. cluster_labels/anomaly_indices/point_z_scores/
  // point_feature_attributions don't have that problem: they're plain
  // fields already embedded (and already stable, live-side) on VectorFrame
  // itself, live or REST, so reading them straight off activeFrame is both
  // correct and doesn't cost anything extra.
  const restPositions = useMemo<Float32Array>(() => {
    if (!restFrame || restFrame.coordinates.length === 0) return EMPTY_POSITIONS
    const arr = new Float32Array(restFrame.coordinates.length * 3)
    restFrame.coordinates.forEach((c: VectorCoordinate3D, i: number) => {
      arr[i * 3] = c.x
      arr[i * 3 + 1] = c.y
      arr[i * 3 + 2] = c.z
    })
    return arr
  }, [restFrame])

  const activePositions = isLive ? streamPositions : restPositions
  const activeAnomalyIndices = activeFrame?.anomaly_indices ?? EMPTY_NUMBER_ARRAY
  const activeClusterLabels = activeFrame?.cluster_labels ?? EMPTY_NUMBER_ARRAY
  const activePointZScores = activeFrame?.point_z_scores ?? EMPTY_Z_SCORE_ARRAY
  const activePointFeatureAttributions =
    activeFrame?.point_feature_attributions ?? EMPTY_FEATURE_ATTRIBUTIONS_ARRAY

  return {
    activeFrame,
    streamState,
    ingestFile,
    confirmOffer,
    dismissOffer,
    retryIngest,
    cancelIngest,
    configureStream,
    isLive,
    restFrame,
    dataSourceState,
    llmStatus,
    activePositions,
    activeAnomalyIndices,
    activeClusterLabels,
    activePointZScores,
    activePointFeatureAttributions,
    temporalRef,
    narrativeHistory,
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
