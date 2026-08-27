/**
 * useFixtureAnomalyExplain — drop-in fixture-backed replacement for
 * useAnomalyExplain (2026-07-30 sprint), used only by the landing page's
 * self-contained demo widget.
 *
 * Implements the exact same AnomalyExplainResult interface (explainState /
 * explainPoint / dismiss) as the real hook, so TacticalVectorField and
 * PointNarrativePanel — the real product's own rendering/interaction
 * components — work completely unmodified here. Only the data source
 * differs: a static lookup instead of a fetch to the LAN-bound backend.
 *
 * The short setTimeout delay simulates the "generating…" moment a real
 * Ollama call has, purely for interaction feel — it is not, and must never
 * be presented as, a live model call. See demoFixture.ts's docstring.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AnomalyExplainResult,
  AnomalyExplainState,
  ExplainablePoint,
} from '@canvas/math/useAnomalyExplain'
import { DEMO_NARRATIVES } from './demoFixture'

const SIMULATED_GENERATION_DELAY_MS = 900

export function useFixtureAnomalyExplain(): AnomalyExplainResult {
  const [explainState, setExplainState] = useState<AnomalyExplainState>({ status: 'idle' })
  // Same stale-response guard as the real hook: a second click before the
  // first's simulated delay elapses must supersede it, not race it.
  const requestGenerationRef = useRef(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // (2026-08-27 sprint, finding #5) Mirrors the real hook's unmount
  // cleanup: without this, the simulated-delay timeout fires after
  // unmount and calls setExplainState on a component that's gone.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
    }
  }, [])

  const explainPoint = useCallback((point: ExplainablePoint) => {
    const generation = ++requestGenerationRef.current
    setExplainState({ status: 'loading', pointIndex: point.pointIndex })

    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      if (requestGenerationRef.current !== generation) return // superseded
      const explanation = DEMO_NARRATIVES[point.pointIndex]
      if (explanation === undefined) {
        setExplainState({
          status: 'error',
          pointIndex: point.pointIndex,
          reason: 'no sample narrative available for this point',
        })
        return
      }
      setExplainState({ status: 'success', pointIndex: point.pointIndex, explanation })
    }, SIMULATED_GENERATION_DELAY_MS)
  }, [])

  const dismiss = useCallback(() => {
    requestGenerationRef.current++
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
    setExplainState({ status: 'idle' })
  }, [])

  return { explainState, explainPoint, dismiss }
}
