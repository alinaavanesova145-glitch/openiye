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

import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '@lib/apiConfig'
import type { FeatureAttribution, VectorCoordinate3D } from './useVectorStream'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExplainablePoint {
  pointIndex: number
  coordinates: VectorCoordinate3D
  zScores: VectorCoordinate3D
  clusterLabel: number
  axesAreRawFeatures: boolean
  /** Additive (2026-07-31 sprint) — top named original fields driving this
   *  point's anomaly, from the frame that produced it (see
   *  VectorFrame.point_feature_attributions). Empty when no real column
   *  names were available at ingestion — the backend then falls back to
   *  the older axis-based phrasing, unchanged. */
  featureAttributions: FeatureAttribution[]
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

// A user actively waiting on a specific point deserves a bound on "how
// long could this possibly hang," same reasoning as
// useVectorDiagnostics.ts's UPLOAD_TIMEOUT_MS (2026-08-28 sprint — this
// fetch had no timeout at all before). A few seconds of buffer over the
// backend's own EXPLAIN_LLM_TIMEOUT_SECONDS=30s budget for this exact
// endpoint, so the frontend doesn't give up right as the backend's own
// timeout-driven fallback would have arrived.
const EXPLAIN_TIMEOUT_MS = 35000
const EXPLAIN_TIMEOUT_MESSAGE = 'no response within 35s · the local LLM may be slow or hung · try again'

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
  // The in-flight explain request's AbortController, if any — aborted
  // when a newer click supersedes it, dismiss() closes the panel, or the
  // EXPLAIN_TIMEOUT_MS timer fires. dismiss() already bumps the
  // generation counter itself, so a dismiss-triggered abort is caught by
  // the plain generation check below without needing its own reason —
  // only a timeout needs to be told apart from a genuine network/server
  // failure, since it's the one case that must still produce a visible
  // result within the *same* (not-yet-superseded-or-dismissed) generation.
  const abortControllerRef = useRef<AbortController | null>(null)
  const abortedByTimeoutRef = useRef(false)

  // (2026-08-27 sprint, finding #5) Neither this hook nor
  // useFixtureAnomalyExplain previously canceled an in-flight request on
  // unmount — only on being superseded by a newer click. Navigating away
  // mid-request (closing the panel via a route change, not just dismiss())
  // let the fetch run to completion in the background: a wasted real LLM
  // call on the backend, and a setExplainState call racing an unmounted
  // component. Aborting here is a no-op if nothing is in flight.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  const explainPoint = useCallback((point: ExplainablePoint) => {
    abortControllerRef.current?.abort() // supersede whatever was in flight
    const controller = new AbortController()
    abortControllerRef.current = controller
    abortedByTimeoutRef.current = false
    const generation = ++requestGenerationRef.current
    setExplainState({ status: 'loading', pointIndex: point.pointIndex })

    const timeoutId = setTimeout(() => {
      abortedByTimeoutRef.current = true
      controller.abort()
    }, EXPLAIN_TIMEOUT_MS)

    const body = {
      point_index: point.pointIndex,
      coordinates: point.coordinates,
      z_scores: point.zScores,
      cluster_label: point.clusterLabel,
      axes_are_raw_features: point.axesAreRawFeatures,
      feature_attributions: point.featureAttributions,
    }

    fetch(`${API_BASE}/api/canvas/anomaly/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(async (response) => {
        clearTimeout(timeoutId)
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
        clearTimeout(timeoutId)
        if (requestGenerationRef.current !== generation) return // superseded or dismissed
        setExplainState({
          status: 'error',
          pointIndex: point.pointIndex,
          reason: abortedByTimeoutRef.current ? EXPLAIN_TIMEOUT_MESSAGE : classifyExplainFailure(err),
        })
      })
  }, [])

  const dismiss = useCallback(() => {
    requestGenerationRef.current++ // invalidate any in-flight request
    abortControllerRef.current?.abort() // and actually tear it down, not just ignore its result
    setExplainState({ status: 'idle' })
  }, [])

  return { explainState, explainPoint, dismiss }
}
