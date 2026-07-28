import { memo, useEffect, useRef, useState, useMemo } from 'react'
import type { MutableRefObject } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Line, Html } from '@react-three/drei'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { useVectorStream, DEFAULT_TEMPORAL_METRICS, HOT_REGIMES } from './math/useVectorStream'
import type { TemporalMetrics, VectorCoordinate3D } from './math/useVectorStream'
import { useAnomalyExplain } from './math/useAnomalyExplain'
import type { AnomalyExplainState, ExplainablePoint } from './math/useAnomalyExplain'

// ─── Design Tokens ────────────────────────────────────────────────────────────

const COLORS = {
  pink: '#ffb6c1',
  cyan: '#5fd9e8',
  anomaly: '#ff2b3d',
  tracer: '#7fd8e6',
} as const

const BOUNDS_HALF_EXTENT = 2 // matches ViewportWireframe's boxGeometry args [4, 4, 4]

const EMPTY_NUMBER_ARRAY: number[] = []

// Beacon pulse ranges — escalating anomalies pulse faster and harder, decaying ones settle.
export const BASE_PULSE_HZ = 1.0
export const MAX_PULSE_HZ = 4.0
export const VELOCITY_FREQ_SCALE = 0.6
export const BASE_AMPLITUDE = 1.0
export const COMPOSITE_AMP_SCALE = 0.5

/** Pulse frequency (Hz) escalates with velocity, clamped to [BASE_PULSE_HZ, MAX_PULSE_HZ]. */
export function computeBeaconPulseFrequencyHz(velocity: number): number {
  return Math.min(
    MAX_PULSE_HZ,
    Math.max(BASE_PULSE_HZ, BASE_PULSE_HZ + velocity * VELOCITY_FREQ_SCALE),
  )
}

/** Pulse amplitude scales with composite_smoothed, floored at BASE_AMPLITUDE (no upper clamp). */
export function computeBeaconPulseAmplitude(compositeSmoothed: number): number {
  return Math.max(BASE_AMPLITUDE, BASE_AMPLITUDE + compositeSmoothed * COMPOSITE_AMP_SCALE)
}

// ─── Severity-based visual encoding ────────────────────────────────────────────
// Grounded in the point's own peak Z-score (backend's point_z_scores, additive
// 2026-07-29 sprint) — not a fabricated/arbitrary ranking. SEVERITY_Z_FLOOR
// matches the backend's own anomaly threshold (_ZSCORE_THRESHOLD=2.5 in
// sdk/iye): every beacon is already >= that, so severity measures *how much*
// past the threshold a point is, not whether it crossed it at all.

export const SEVERITY_Z_FLOOR = 2.5
export const SEVERITY_Z_CEIL = 6.0
const SEVERITY_MILD_COLOR = '#ffb020'

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** 0 (just past the anomaly threshold) .. 1 (extreme) — normalized severity
 *  from a point's peak Z-score across its 3 axes. */
export function computeSeverity(maxAbsZ: number): number {
  return clamp01((maxAbsZ - SEVERITY_Z_FLOOR) / (SEVERITY_Z_CEIL - SEVERITY_Z_FLOOR))
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const toHex = (c: number): string => Math.round(clamp01(c / 255) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** Amber (mild) -> the existing intense red (extreme), so the most
 *  anomalous points read as visually distinct at a glance. */
export function computeSeverityColor(maxAbsZ: number): string {
  const t = computeSeverity(maxAbsZ)
  const mild = hexToRgb(SEVERITY_MILD_COLOR)
  const extreme = hexToRgb(COLORS.anomaly)
  const lerped: [number, number, number] = [
    mild[0] + (extreme[0] - mild[0]) * t,
    mild[1] + (extreme[1] - mild[1]) * t,
    mild[2] + (extreme[2] - mild[2]) * t,
  ]
  return rgbToHex(lerped)
}

/** Up to 50% larger at extreme severity — multiplies the existing pulse scale. */
export function computeSeverityScale(maxAbsZ: number): number {
  return 1 + computeSeverity(maxAbsZ) * 0.5
}

function maxAbsAxis(v: VectorCoordinate3D): number {
  return Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z))
}

// ─── Mock Seed Data (only used before a real frame arrives) ──────────────────

function buildMockFrame() {
  const pointCount = 150
  const positions = new Float32Array(pointCount * 3)
  const clusterLabels: number[] = []
  const clusterCenters = [-1.2, 0, 1.2]

  for (let i = 0; i < pointCount; i++) {
    const cluster = i % clusterCenters.length
    positions[i * 3] = clusterCenters[cluster] + (Math.random() - 0.5) * 1.4
    positions[i * 3 + 1] = (Math.random() - 0.5) * 1.4
    positions[i * 3 + 2] = (Math.random() - 0.5) * 1.4
    clusterLabels.push(cluster)
  }

  return { positions, anomalyIndices: [12, 47, 88], clusterLabels }
}

// ─── Instanced Core Geometry (nominal nodes) ─────────────────────────────────

interface CoreNodesProps {
  positions: Float32Array
  nominalIndices: number[]
  clusterLabels: number[]
}

const InstancedCoreNodes = memo(function InstancedCoreNodes({
  positions,
  nominalIndices,
  clusterLabels,
}: CoreNodesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const count = nominalIndices.length || 1

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    const dummy = new THREE.Object3D()
    const pink = new THREE.Color(COLORS.pink)
    const cyan = new THREE.Color(COLORS.cyan)

    nominalIndices.forEach((idx, i) => {
      dummy.position.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2])
      dummy.rotation.set(idx * 0.37, idx * 0.61, 0)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)

      const cluster = clusterLabels[idx] ?? -1
      mesh.setColorAt(i, cluster >= 0 && cluster % 2 === 1 ? cyan : pink)
    })

    mesh.count = nominalIndices.length
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [positions, nominalIndices, clusterLabels])

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      key={count}
      frustumCulled={false}
    >
      <octahedronGeometry args={[0.055, 0]} />
      <meshBasicMaterial transparent opacity={0.55} vertexColors depthWrite={false} />
    </instancedMesh>
  )
})

// ─── Dynamic Volumetric Cluster Hulls ─────────────────────────────────────────

interface HullsProps {
  positions: Float32Array
  clusterLabels: number[]
}

interface HullEntry {
  key: number
  geometry: THREE.BufferGeometry
  edges: THREE.BufferGeometry
  color: string
}

const ClusterHulls = memo(function ClusterHulls({ positions, clusterLabels }: HullsProps) {
  const hulls = useMemo<HullEntry[]>(() => {
    const groups = new Map<number, THREE.Vector3[]>()
    for (let i = 0; i < clusterLabels.length; i++) {
      const label = clusterLabels[i]
      if (label < 0) continue // HDBSCAN noise — no hull
      const pts = groups.get(label) ?? []
      pts.push(new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]))
      groups.set(label, pts)
    }

    const entries: HullEntry[] = []
    let toggle = 0
    groups.forEach((pts, label) => {
      if (pts.length < 4) return // need >=4 non-coplanar points for a hull
      try {
        const geometry = new ConvexGeometry(pts)
        const edges = new THREE.EdgesGeometry(geometry)
        entries.push({
          key: label,
          geometry,
          edges,
          color: toggle++ % 2 === 0 ? COLORS.pink : COLORS.cyan,
        })
      } catch {
        // Degenerate (coplanar) cluster point set — skip hull rendering
      }
    })
    return entries
  }, [positions, clusterLabels])

  useEffect(() => {
    return () => {
      hulls.forEach((hull) => {
        hull.geometry.dispose()
        hull.edges.dispose()
      })
    }
  }, [hulls])

  return (
    <>
      {hulls.map((hull) => (
        <group key={hull.key}>
          <mesh geometry={hull.geometry}>
            <meshBasicMaterial
              color={hull.color}
              transparent
              opacity={0.07}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <lineSegments geometry={hull.edges}>
            <lineBasicMaterial color={hull.color} transparent opacity={0.35} />
          </lineSegments>
        </group>
      ))}
    </>
  )
})

// ─── Vector Tracer Lines (network web) ────────────────────────────────────────

interface TracerProps {
  positions: Float32Array
  nominalIndices: number[]
  clusterLabels: number[]
}

const TracerLines = memo(function TracerLines({
  positions,
  nominalIndices,
  clusterLabels,
}: TracerProps) {
  const geometryRef = useRef<THREE.BufferGeometry>(null)

  const segmentPositions = useMemo(() => {
    const centroids = new Map<number, { x: number; y: number; z: number; n: number }>()
    for (const idx of nominalIndices) {
      const label = clusterLabels[idx] ?? -1
      if (label < 0) continue
      const c = centroids.get(label) ?? { x: 0, y: 0, z: 0, n: 0 }
      c.x += positions[idx * 3]
      c.y += positions[idx * 3 + 1]
      c.z += positions[idx * 3 + 2]
      c.n += 1
      centroids.set(label, c)
    }

    const segs = new Float32Array(nominalIndices.length * 6)
    nominalIndices.forEach((idx, i) => {
      const px = positions[idx * 3]
      const py = positions[idx * 3 + 1]
      const pz = positions[idx * 3 + 2]
      const label = clusterLabels[idx] ?? -1
      const c = label >= 0 ? centroids.get(label) : undefined
      const tx = c ? c.x / c.n : 0
      const ty = c ? c.y / c.n : 0
      const tz = c ? c.z / c.n : 0

      segs[i * 6] = px
      segs[i * 6 + 1] = py
      segs[i * 6 + 2] = pz
      segs[i * 6 + 3] = tx
      segs[i * 6 + 4] = ty
      segs[i * 6 + 5] = tz
    })
    return segs
  }, [positions, nominalIndices, clusterLabels])

  useEffect(() => {
    const geo = geometryRef.current
    if (!geo || segmentPositions.length === 0) return
    geo.setAttribute('position', new THREE.BufferAttribute(segmentPositions, 3))
    geo.attributes.position.needsUpdate = true
    geo.computeBoundingSphere()
  }, [segmentPositions])

  if (segmentPositions.length === 0) return null

  return (
    <lineSegments>
      <bufferGeometry ref={geometryRef} />
      <lineBasicMaterial color={COLORS.tracer} transparent opacity={0.12} />
    </lineSegments>
  )
})

// ─── Pulsing Anomaly Beacons ───────────────────────────────────────────────────

/** Snapshot of frame-level (not per-point) data shown in a beacon's hover tooltip. */
export interface BeaconTooltipInfo {
  temporal: TemporalMetrics
  explanation: string | null
  status: 'NOMINAL' | 'ANOMALY'
  /** Additive (2026-07-29 sprint) — passed through to the per-point explain
   *  request; see VectorFrame.axes_are_raw_features. */
  axesAreRawFeatures: boolean
}

/** Tooltip text while the narrative is still pending vs. resolved (or a nominal frame). */
export function resolveExplanationDisplay(
  status: 'NOMINAL' | 'ANOMALY',
  explanation: string | null,
): string | null {
  if (status !== 'ANOMALY') return null
  return explanation ?? 'analyzing…'
}

interface AnomalyBeaconProps {
  position: readonly [number, number, number]
  anomalyIndex: number
  temporalRef: MutableRefObject<TemporalMetrics>
  tooltipInfo: BeaconTooltipInfo
  /** This point's own peak Z-score across axes (backend's point_z_scores,
   *  additive 2026-07-29 sprint) — drives severity color/size, independent
   *  of the frame-level temporal stats above. */
  pointZScore: VectorCoordinate3D
  clusterLabel: number
  isSelected: boolean
  onExplainRequest: (point: ExplainablePoint) => void
}

const AnomalyBeacon = memo(function AnomalyBeacon({
  position,
  anomalyIndex,
  temporalRef,
  tooltipInfo,
  pointZScore,
  clusterLabel,
  isSelected,
  onExplainRequest,
}: AnomalyBeaconProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const materialRef = useRef<THREE.MeshBasicMaterial>(null)
  const phase = useRef(Math.random() * Math.PI * 2).current
  const [hovered, setHovered] = useState(false)

  const severity = maxAbsAxis(pointZScore)
  const severityColor = computeSeverityColor(severity)
  const severityScale = computeSeverityScale(severity)

  useFrame(({ clock }) => {
    // Escalating anomalies (high velocity / composite_smoothed) pulse faster and
    // harder; decaying ones settle back toward the base rate. Read from a ref
    // (not React state) so per-tick temporal updates never re-render the canvas.
    const temporal = temporalRef.current
    const freqHz = computeBeaconPulseFrequencyHz(temporal.velocity)
    const amplitude = computeBeaconPulseAmplitude(temporal.composite_smoothed)

    const t = clock.getElapsedTime() * freqHz * (2 * Math.PI) + phase
    const pulse = 1 + Math.sin(t) * 0.4 * amplitude

    if (meshRef.current) {
      meshRef.current.scale.setScalar(pulse * 0.1 * severityScale)
      meshRef.current.rotation.x += 0.03
      meshRef.current.rotation.y += 0.045
      meshRef.current.position.set(
        position[0] + Math.sin(t * 2.3) * 0.015 * amplitude,
        position[1] + Math.cos(t * 2.7) * 0.015 * amplitude,
        position[2] + Math.sin(t * 3.1) * 0.015 * amplitude,
      )
    }
    if (materialRef.current) {
      materialRef.current.opacity = Math.min(
        1,
        Math.max(0.15, 0.55 + Math.sin(t * 1.6) * 0.35 * amplitude),
      )
    }
  })

  return (
    <group>
      <mesh
        ref={meshRef}
        position={position}
        onPointerOver={(e) => {
          e.stopPropagation()
          setHovered(true)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={(e) => {
          e.stopPropagation()
          setHovered(false)
          document.body.style.cursor = 'auto'
        }}
        onClick={(e) => {
          e.stopPropagation()
          onExplainRequest({
            pointIndex: anomalyIndex,
            coordinates: { x: position[0], y: position[1], z: position[2] },
            zScores: pointZScore,
            clusterLabel,
            axesAreRawFeatures: tooltipInfo.axesAreRawFeatures,
          })
        }}
      >
        <icosahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          ref={materialRef}
          color={isSelected ? COLORS.tracer : severityColor}
          transparent
          opacity={0.9}
        />
        {hovered && (
          <Html position={[0, 1.8, 0]} center distanceFactor={9} style={{ pointerEvents: 'none' }}>
            <div className="beacon-tooltip">
              <div className="beacon-tooltip-header">
                <span>ANOMALY #{anomalyIndex}</span>
                <span
                  className="regime-tag"
                  style={{
                    color: HOT_REGIMES.has(tooltipInfo.temporal.regime)
                      ? COLORS.anomaly
                      : COLORS.pink,
                  }}
                >
                  {tooltipInfo.temporal.regime}
                </span>
              </div>
              <div className="beacon-tooltip-row">
                <span>status</span>
                <span>{tooltipInfo.status}</span>
              </div>
              <div className="beacon-tooltip-row">
                <span>velocity</span>
                <span>{tooltipInfo.temporal.velocity.toFixed(2)}</span>
              </div>
              <div className="beacon-tooltip-row">
                <span>composite_smoothed</span>
                <span>{tooltipInfo.temporal.composite_smoothed.toFixed(2)}</span>
              </div>
              <div className="beacon-tooltip-row">
                <span>z_max</span>
                <span>{tooltipInfo.temporal.z_max.toFixed(2)}</span>
              </div>
              {resolveExplanationDisplay(tooltipInfo.status, tooltipInfo.explanation) !== null && (
                <p className="beacon-tooltip-explanation">
                  {resolveExplanationDisplay(tooltipInfo.status, tooltipInfo.explanation)}
                </p>
              )}
              <p className="beacon-tooltip-hint">click for this point&rsquo;s narrative</p>
            </div>
          </Html>
        )}
      </mesh>
      <Line
        points={[
          [position[0], BOUNDS_HALF_EXTENT, position[2]],
          [position[0], -BOUNDS_HALF_EXTENT, position[2]],
        ]}
        color={COLORS.anomaly}
        transparent
        opacity={0.3}
        lineWidth={1}
      />
    </group>
  )
})

interface BeaconsProps {
  positions: Float32Array
  anomalyIndices: number[]
  clusterLabels: number[]
  pointZScores: VectorCoordinate3D[]
  temporalRef: MutableRefObject<TemporalMetrics>
  tooltipInfo: BeaconTooltipInfo
  selectedPointIndex: number | null
  onExplainRequest: (point: ExplainablePoint) => void
}

const EMPTY_Z_SCORE: VectorCoordinate3D = { x: 0, y: 0, z: 0 }

const AnomalyBeacons = memo(function AnomalyBeacons({
  positions,
  anomalyIndices,
  clusterLabels,
  pointZScores,
  temporalRef,
  tooltipInfo,
  selectedPointIndex,
  onExplainRequest,
}: BeaconsProps) {
  const pointCount = positions.length / 3
  const validIndices = useMemo(
    () => anomalyIndices.filter((idx) => idx >= 0 && idx < pointCount),
    [anomalyIndices, pointCount],
  )

  // Stable per-beacon position tuples — without this, AnomalyBeacon would get
  // a brand-new [x,y,z] array literal identity every render regardless of
  // whether positions/validIndices actually changed, defeating its memo.
  const beaconPositions = useMemo(
    () =>
      validIndices.map(
        (idx): [number, number, number] => [
          positions[idx * 3],
          positions[idx * 3 + 1],
          positions[idx * 3 + 2],
        ],
      ),
    [positions, validIndices],
  )

  return (
    <>
      {validIndices.map((idx, i) => (
        <AnomalyBeacon
          key={idx}
          position={beaconPositions[i]}
          anomalyIndex={idx}
          temporalRef={temporalRef}
          tooltipInfo={tooltipInfo}
          pointZScore={pointZScores[idx] ?? EMPTY_Z_SCORE}
          clusterLabel={clusterLabels[idx] ?? -1}
          isSelected={selectedPointIndex === idx}
          onExplainRequest={onExplainRequest}
        />
      ))}
    </>
  )
})

// ─── Composed Tactical Field ───────────────────────────────────────────────────

export interface TacticalFieldProps {
  positions: Float32Array
  anomalyIndices: number[]
  clusterLabels: number[]
  pointZScores: VectorCoordinate3D[]
  temporalRef: MutableRefObject<TemporalMetrics>
  tooltipInfo: BeaconTooltipInfo
  selectedPointIndex: number | null
  onExplainRequest: (point: ExplainablePoint) => void
}

/** Exported (2026-07-30 sprint) so the marketing landing page's fixture-data
 *  demo widget can render the exact same beacon/hull/tracer/severity/click
 *  interaction the real product uses, rather than a re-implementation that
 *  would inevitably drift out of visual sync over time. */
export const TacticalVectorField = memo(function TacticalVectorField({
  positions,
  anomalyIndices,
  clusterLabels,
  pointZScores,
  temporalRef,
  tooltipInfo,
  selectedPointIndex,
  onExplainRequest,
}: TacticalFieldProps) {
  const anomalySet = useMemo(() => new Set(anomalyIndices), [anomalyIndices])
  const nominalIndices = useMemo(() => {
    const count = positions.length / 3
    const arr: number[] = []
    for (let i = 0; i < count; i++) {
      if (!anomalySet.has(i)) arr.push(i)
    }
    return arr
  }, [positions, anomalySet])

  if (positions.length === 0) return null

  return (
    <>
      <InstancedCoreNodes
        positions={positions}
        nominalIndices={nominalIndices}
        clusterLabels={clusterLabels}
      />
      <ClusterHulls positions={positions} clusterLabels={clusterLabels} />
      <TracerLines
        positions={positions}
        nominalIndices={nominalIndices}
        clusterLabels={clusterLabels}
      />
      <AnomalyBeacons
        positions={positions}
        anomalyIndices={anomalyIndices}
        clusterLabels={clusterLabels}
        pointZScores={pointZScores}
        temporalRef={temporalRef}
        tooltipInfo={tooltipInfo}
        selectedPointIndex={selectedPointIndex}
        onExplainRequest={onExplainRequest}
      />
    </>
  )
})

// Bounding box wireframe for spatial reference
function ViewportWireframe() {
  return (
    <mesh>
      <boxGeometry args={[4, 4, 4]} />
      <meshBasicMaterial color="#ffffff" wireframe={true} transparent={true} opacity={0.15} />
    </mesh>
  )
}

// ─── Per-point Narrative Panel ─────────────────────────────────────────────────

export interface PointNarrativePanelProps {
  explainState: AnomalyExplainState
  dismiss: () => void
}

/** Exported (2026-07-30 sprint, alongside TacticalVectorField) so the
 *  landing page's fixture demo shares the exact click → narrative panel UI
 *  the real product uses, rather than a parallel re-implementation. */
export function PointNarrativePanel({ explainState, dismiss }: PointNarrativePanelProps) {
  if (explainState.status === 'idle') return null
  return (
    // Per-point narrative panel — a user actively clicked a specific
    // beacon; distinct from any passive frame-level card. Keyed on
    // pointIndex so switching between points remounts (and re-animates)
    // rather than jarringly mutating in place.
    <div
      key={explainState.pointIndex}
      className={`point-narrative-panel point-narrative-panel--${explainState.status}`}
    >
      <div className="status-header">
        <span>POINT #{explainState.pointIndex}</span>
        <button
          type="button"
          className="point-narrative-dismiss"
          onClick={dismiss}
          aria-label="dismiss narrative"
        >
          ×
        </button>
      </div>
      {explainState.status === 'loading' && (
        <p className="point-narrative-status">generating explanation…</p>
      )}
      {explainState.status === 'success' && (
        <p className="explanation-text">{explainState.explanation}</p>
      )}
      {explainState.status === 'error' && <p className="point-narrative-error">{explainState.reason}</p>}
    </div>
  )
}

// ─── Main Viewport ────────────────────────────────────────────────────────────

const EMPTY_Z_SCORE_ARRAY: VectorCoordinate3D[] = []

export default function VectorViewport() {
  const { positions, anomalyIndices, streamState, liveFrame, temporalRef, narrativeHistory } =
    useVectorStream()
  const [mockFrame] = useState(buildMockFrame)
  const { explainState, explainPoint, dismiss } = useAnomalyExplain()

  const hasLiveData = positions.length > 0
  const activePositions = hasLiveData ? positions : mockFrame.positions
  const activeAnomalyIndices = hasLiveData ? anomalyIndices : mockFrame.anomalyIndices
  const activeClusterLabels = hasLiveData
    ? (liveFrame?.cluster_labels ?? EMPTY_NUMBER_ARRAY)
    : mockFrame.clusterLabels
  const activePointZScores = hasLiveData ? (liveFrame?.point_z_scores ?? EMPTY_Z_SCORE_ARRAY) : EMPTY_Z_SCORE_ARRAY

  const pointCount = activePositions.length / 3
  const regime = liveFrame?.temporal.regime ?? DEFAULT_TEMPORAL_METRICS.regime
  const regimeColor = HOT_REGIMES.has(regime) ? COLORS.anomaly : COLORS.pink

  const selectedPointIndex = explainState.status === 'idle' ? null : explainState.pointIndex

  // Keyed on liveFrame's identity (which only changes when a new frame message
  // or a matching narrative arrives) so AnomalyBeacon's memo isn't defeated by
  // a fresh tooltipInfo object on every unrelated VectorViewport render.
  const tooltipInfo = useMemo<BeaconTooltipInfo>(
    () => ({
      temporal: liveFrame?.temporal ?? DEFAULT_TEMPORAL_METRICS,
      explanation: liveFrame?.explanation ?? null,
      status: liveFrame?.status ?? 'NOMINAL',
      axesAreRawFeatures: liveFrame?.axes_are_raw_features ?? true,
    }),
    [liveFrame],
  )

  return (
    <div
      style={{ width: '100%', height: '100%', backgroundColor: '#000000', position: 'relative' }}
    >
      {/* Minimalist Tech Stats Indicator Overlay */}
      <div
        style={{
          position: 'absolute',
          top: 20,
          left: 20,
          color: '#ffb6c1',
          fontFamily: 'monospace',
          fontSize: '12px',
          zIndex: 10,
          letterSpacing: '1px',
          pointerEvents: 'none',
        }}
      >
        {/* eslint-disable-next-line react/jsx-no-comment-textnodes -- "//" is
                    literal HUD-style display text here, not a stray JS comment */}
        VECTOR VIEWPORT // POINTS: {pointCount} // STREAM: {streamState}
      </div>

      <Canvas camera={{ position: [3, 3, 5] }}>
        <ambientLight intensity={0.3} />
        <pointLight position={[10, 10, 10]} intensity={0.7} />
        <ViewportWireframe />
        <TacticalVectorField
          positions={activePositions}
          anomalyIndices={activeAnomalyIndices}
          clusterLabels={activeClusterLabels}
          pointZScores={activePointZScores}
          temporalRef={temporalRef}
          tooltipInfo={tooltipInfo}
          selectedPointIndex={selectedPointIndex}
          onExplainRequest={explainPoint}
        />
        <OrbitControls enableZoom={true} makeDefault />
      </Canvas>

      {liveFrame && (
        <div className="tactical-terminal-card">
          <div className="status-header">
            <span>AI CORE ANALYSIS</span>
            <span className="regime-tag" style={{ color: regimeColor }}>
              {regime}
            </span>
          </div>
          {resolveExplanationDisplay(liveFrame.status, liveFrame.explanation) !== null && (
            <p className="explanation-text">
              {resolveExplanationDisplay(liveFrame.status, liveFrame.explanation)}
            </p>
          )}
          {/* Narratives whose frame was already replaced by the time they arrived —
                        surfaced here instead of being dropped silently. */}
          {narrativeHistory.length > 0 && (
            <div className="narrative-history">
              {narrativeHistory
                .slice(-3)
                .reverse()
                .map((entry, i) => (
                  <p key={`${entry.id}-${i}`} className="narrative-history-entry">
                    {entry.explanation}
                  </p>
                ))}
            </div>
          )}
        </div>
      )}

      <PointNarrativePanel explainState={explainState} dismiss={dismiss} />
    </div>
  )
}
