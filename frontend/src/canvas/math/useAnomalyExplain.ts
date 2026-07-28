/**
 * useAnomalyExplain — on-demand, per-point narrative explanation
 * (2026-07-29 sprint).
 *
 * Distinct from the frame-level `explanation`/`narrativeHistory` already
 * carried by useVectorStream: that's an automatic, fire-and-forget
 * narrative for only the *first* anomalous point in a frame, broadcast to
 * every connected client over the shared /stream WebSocket. This hook is a
 * direct request/response for whichever *specific* point a user clicks —
 * reusing that broadcast channel would leak one user's clicked-point
 * explanation to every other browser tab watching the same stream (see
 * docs/idealization_report.md, 2026-07-29 sprint, Phase 1 audit), so this
 * is a plain REST POST instead, mirroring useVectorDiagnostics.ts's
 * postMatrix/error-taxonomy pattern.
 */

import { useCallback, useRef, useState } from 'react'
import { API_BASE } from '@lib/apiConfig'
import type { VectorCoordinate3D } from './useVectorStream'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExplainablePoint {
  pointIndex: number
  coordinates: VectorCoordinate3D
  zScores: VectorCoordinate3D
  clusterLabel: number
  axesAreRawFeatures: boolean
}

export type AnomalyExplainState =
  | { status: 'idle' }
  | { status: 'loading'; pointIndex: number }
  | { status: 'success'; pointIndex: number; explanation: string }
  | { status: 'error'; pointIndex: number; reason: string }

export interface AnomalyExplainResult {
  explainState: AnomalyExplainState
  /** Triggers an explain request for this point. A second click on a
   *  different point while one is already loading cancels the stale one
   *  (its response, if it ever arrives, is ignored). */
  explainPoint: (point: ExplainablePoint) => void
  /** Returns to 'idle' — closes the narrative panel. */
  dismiss: () => void
}

// ─── Error taxonomy (mirrors useVectorDiagnostics.ts's classifyIngestFailure) ──

class ServerExplainError extends Error {
  readonly status: number
  readonly detail: string | null
  constructor(status: number, detail: string | null) {
    super(`explain request failed: ${String(status)}`)
    this.name = 'ServerExplainError'
    this.status = status
    this.detail = detail
  }
}

function classifyExplainFailure(err: unknown): string {
  if (err instanceof TypeError) {
    return 'backend unreachable · check the server is running'
  }
  if (err instanceof ServerExplainError) {
    return err.detail ?? `server rejected the request (status ${String(err.status)})`
  }
  return 'unexpected error generating explanation'
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAnomalyExplain(): AnomalyExplainResult {
  const [explainState, setExplainState] = useState<AnomalyExplainState>({ status: 'idle' })
  // Guards against a stale response (from a previously clicked point)
  // landing after a newer click has already moved on — only the request
  // matching the current generation is allowed to update state.
  const requestGenerationRef = useRef(0)

  const explainPoint = useCallback((point: ExplainablePoint) => {
    const generation = ++requestGenerationRef.current
    setExplainState({ status: 'loading', pointIndex: point.pointIndex })

    const body = {
      point_index: point.pointIndex,
      coordinates: point.coordinates,
      z_scores: point.zScores,
      cluster_label: point.clusterLabel,
      axes_are_raw_features: point.axesAreRawFeatures,
    }

    fetch(`${API_BASE}/api/canvas/anomaly/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (response) => {
        if (!response.ok) {
          const errorBody: unknown = await response.json().catch(() => null)
          const detail =
            errorBody && typeof errorBody === 'object' && 'detail' in errorBody
              ? String((errorBody as Record<string, unknown>).detail)
              : null
          throw new ServerExplainError(response.status, detail)
        }
        const parsed: unknown = await response.json()
        const explanation =
          parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).explanation === 'string'
            ? (parsed as { explanation: string }).explanation
            : null
        if (requestGenerationRef.current !== generation) return // superseded by a newer click
        if (explanation === null) {
          setExplainState({
            status: 'error',
            pointIndex: point.pointIndex,
            reason: 'malformed response from server',
          })
          return
        }
        setExplainState({ status: 'success', pointIndex: point.pointIndex, explanation })
      })
      .catch((err: unknown) => {
        if (requestGenerationRef.current !== generation) return // superseded by a newer click
        setExplainState({
          status: 'error',
          pointIndex: point.pointIndex,
          reason: classifyExplainFailure(err),
        })
      })
  }, [])

  const dismiss = useCallback(() => {
    requestGenerationRef.current++ // invalidate any in-flight request
    setExplainState({ status: 'idle' })
  }, [])

  return { explainState, explainPoint, dismiss }
}
