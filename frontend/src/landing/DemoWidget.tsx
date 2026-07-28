/**
 * DemoWidget — the landing page's self-contained live demo (2026-07-30
 * sprint). Renders the exact same TacticalVectorField/PointNarrativePanel
 * components the real product's canvas uses, fed by demoFixture.ts's
 * static data and useFixtureAnomalyExplain's static narrative lookup
 * instead of a live WebSocket/backend — see both files' docstrings for why.
 */

import { useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { TacticalVectorField, PointNarrativePanel } from '@canvas/VectorViewport'
import type { BeaconTooltipInfo } from '@canvas/VectorViewport'
import { DEFAULT_TEMPORAL_METRICS } from '@canvas/math/useVectorStream'
import type { TemporalMetrics } from '@canvas/math/useVectorStream'
import { useFixtureAnomalyExplain } from './useFixtureAnomalyExplain'
import { DEMO_ANOMALY_INDICES, DEMO_AXIS_CAPTION, DEMO_DATASET_LABEL, DEMO_POINTS } from './demoFixture'

function buildStaticSceneData() {
  const positions = new Float32Array(DEMO_POINTS.length * 3)
  const clusterLabels: number[] = []
  const pointZScores = DEMO_POINTS.map((p) => p.zScores)
  DEMO_POINTS.forEach((p, i) => {
    positions[i * 3] = p.position[0]
    positions[i * 3 + 1] = p.position[1]
    positions[i * 3 + 2] = p.position[2]
    clusterLabels.push(p.clusterLabel)
  })
  return { positions, clusterLabels, pointZScores }
}

// Frame-level tooltip info the real live stream would normally supply —
// the demo has no frame-level narrative/temporal signal, only per-point
// data, so this stays neutral. axesAreRawFeatures: true is accurate for
// this fixture (see demoFixture.ts — exactly 3 dimensions).
const STATIC_TOOLTIP_INFO: BeaconTooltipInfo = {
  temporal: DEFAULT_TEMPORAL_METRICS,
  explanation: null,
  status: 'NOMINAL',
  axesAreRawFeatures: true,
}

export default function DemoWidget() {
  const { positions, clusterLabels, pointZScores } = useMemo(buildStaticSceneData, [])
  const temporalRef = useRef<TemporalMetrics>(DEFAULT_TEMPORAL_METRICS)
  const { explainState, explainPoint, dismiss } = useFixtureAnomalyExplain()

  const selectedPointIndex = explainState.status === 'idle' ? null : explainState.pointIndex

  return (
    <div className="demo-widget">
      <div className="demo-widget-label">
        <span className="demo-widget-badge">live interactive demo — sample data</span>
        <span className="demo-widget-caption">
          {DEMO_DATASET_LABEL} · {DEMO_AXIS_CAPTION}
        </span>
      </div>
      <div className="demo-widget-canvas">
        <Canvas camera={{ position: [3, 3, 5] }}>
          <ambientLight intensity={0.3} />
          <pointLight position={[10, 10, 10]} intensity={0.7} />
          <TacticalVectorField
            positions={positions}
            anomalyIndices={DEMO_ANOMALY_INDICES}
            clusterLabels={clusterLabels}
            pointZScores={pointZScores}
            temporalRef={temporalRef}
            tooltipInfo={STATIC_TOOLTIP_INFO}
            selectedPointIndex={selectedPointIndex}
            onExplainRequest={explainPoint}
          />
          <OrbitControls enableZoom={true} makeDefault />
        </Canvas>
        <p className="demo-widget-hint">drag to rotate · click a flagged point for its explanation</p>
        <PointNarrativePanel explainState={explainState} dismiss={dismiss} />
      </div>
    </div>
  )
}
