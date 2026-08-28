/**
 * VectorViewport.tactical-field.test.tsx (2026-08-28 sprint) — real
 * react-three-fiber mount tests via @react-three/test-renderer.
 *
 * Before this sprint, InstancedCoreNodes/ClusterHulls/TracerLines/
 * AnomalyBeacons/TacticalVectorField were never mounted by any test — only
 * pure functions extracted from them were covered (see
 * VectorViewport.severity.test.ts, .pulse.test.ts, .cluster-color.test.ts).
 * The default-exported VectorViewport itself still can't be mounted this
 * way: it renders react-three-fiber's own <Canvas>, which needs a real
 * WebGL context @react-three/test-renderer doesn't provide (it replaces
 * the *content* a Canvas would host, not Canvas itself) — see
 * VectorViewport.props-wiring.test.tsx for how that outer layer is
 * covered instead, by swapping Canvas for a plain passthrough.
 */
import { describe, expect, it, vi } from 'vitest'
import ReactThreeTestRenderer, { type ReactThreeTest } from '@react-three/test-renderer'
import type { Mesh, Object3D } from 'three'
import { TacticalVectorField, isClusterCyan } from './VectorViewport'
import type { TacticalFieldProps } from './VectorViewport'
import { DEFAULT_TEMPORAL_METRICS } from './math/useVectorStream'
import { THEME } from '@lib/theme'

function isInstancedMesh(o: Object3D): boolean {
  return Boolean((o as unknown as { isInstancedMesh?: boolean }).isInstancedMesh)
}

const BASE_TOOLTIP_INFO: TacticalFieldProps['tooltipInfo'] = {
  temporal: DEFAULT_TEMPORAL_METRICS,
  explanation: null,
  status: 'NOMINAL',
  axesAreRawFeatures: true,
}

function baseProps(overrides: Partial<TacticalFieldProps> = {}): TacticalFieldProps {
  return {
    positions: new Float32Array(0),
    anomalyIndices: [],
    clusterLabels: [],
    pointZScores: [],
    pointFeatureAttributions: [],
    temporalRef: { current: DEFAULT_TEMPORAL_METRICS },
    tooltipInfo: BASE_TOOLTIP_INFO,
    selectedPointIndex: null,
    onExplainRequest: () => {},
    ...overrides,
  }
}

describe('TacticalVectorField — instance counts', () => {
  it('renders nothing when positions is empty (no data yet)', async () => {
    const renderer = await ReactThreeTestRenderer.create(<TacticalVectorField {...baseProps()} />)
    expect(renderer.toGraph()).toEqual([])
    await renderer.unmount()
  })

  it('the instanced core mesh count matches the nominal (non-anomalous) point count', async () => {
    // 4 points total, point 2 flagged anomalous -> 3 nominal instances.
    const positions = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField
        {...baseProps({
          positions,
          anomalyIndices: [2],
          clusterLabels: [0, 0, 0, 0],
        })}
      />,
    )
    const instanced = renderer.scene.find((node) => isInstancedMesh(node.instance))
    expect((instanced.instance as unknown as { count: number }).count).toBe(3)
    await renderer.unmount()
  })
})

describe('TacticalVectorField — instanced mesh pre-allocation (Phase 7 perf fix)', () => {
  it('the same InstancedMesh instance survives a nominal-count change within capacity (no remount)', async () => {
    // 2 nominal points, 0 anomalous.
    const positionsA = new Float32Array([0, 0, 0, 1, 1, 1])
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField {...baseProps({ positions: positionsA, clusterLabels: [0, 0] })} />,
    )
    const meshBefore = renderer.scene.find((node) => isInstancedMesh(node.instance)).instance
    expect((meshBefore as unknown as { count: number }).count).toBe(2)

    // 3 nominal points now (one more point, still well within capacity) —
    // the pre-fix `key={count}` would have forced a full unmount/remount
    // here, tearing down and reallocating the GPU buffer for a change
    // this ordinary (e.g. one anomaly resolving back to nominal).
    const positionsB = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2])
    await renderer.update(
      <TacticalVectorField {...baseProps({ positions: positionsB, clusterLabels: [0, 0, 0] })} />,
    )
    const meshAfter = renderer.scene.find((node) => isInstancedMesh(node.instance)).instance

    expect(meshAfter).toBe(meshBefore) // same underlying THREE object — no remount
    expect((meshAfter as unknown as { count: number }).count).toBe(3)
    await renderer.unmount()
  })
})

describe('TacticalVectorField — cluster hull color stability (regression for the 2026-08-28 fix)', () => {
  // Two clusters, 4 non-coplanar points each — enough for ConvexGeometry
  // to succeed for both, so both hulls actually render.
  const positions = new Float32Array([
    // cluster 0 (tetrahedron)
    0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
    // cluster 1 (tetrahedron, offset)
    10, 10, 10, 11, 10, 10, 10, 11, 10, 10, 10, 11,
  ])
  const clusterLabels = [0, 0, 0, 0, 1, 1, 1, 1]

  it('renders one hull group per real cluster, colored by isClusterCyan(label) — not iteration order', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField {...baseProps({ positions, clusterLabels })} />,
    )
    const groups = renderer.scene.findAllByType('Group')
    expect(groups).toHaveLength(2) // one per cluster

    const expectedHex = (label: number) =>
      (isClusterCyan(label) ? THEME.cyan : THEME.pink).replace('#', '').toLowerCase()

    for (const [i, label] of [0, 1].entries()) {
      const hullMesh = groups[i].findByType('Mesh')
      const material = (hullMesh.instance as Mesh).material as unknown as { color: { getHexString: () => string } }
      expect(material.color.getHexString()).toBe(expectedHex(label))
    }
    await renderer.unmount()
  })

  it('hull color is identical across two renders regardless of Map iteration/insertion order', async () => {
    // Same clusters, points interleaved in the OPPOSITE order (cluster 1's
    // points appear first this time) — a stable-by-label color rule must
    // still produce the same color per label; the old toggle++ bug would
    // have flipped them here.
    const interleaved = new Float32Array([
      10, 10, 10, 11, 10, 10, 10, 11, 10, 10, 10, 11, // cluster 1 first
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, // cluster 0 second
    ])
    const interleavedLabels = [1, 1, 1, 1, 0, 0, 0, 0]

    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField {...baseProps({ positions: interleaved, clusterLabels: interleavedLabels })} />,
    )
    const groups = renderer.scene.findAllByType('Group')
    expect(groups).toHaveLength(2)

    const colorsByAppearance = groups.map((g) => {
      const mesh = g.findByType('Mesh')
      const material = (mesh.instance as Mesh).material as unknown as { color: { getHexString: () => string } }
      return material.color.getHexString()
    })

    // Cluster 1 (odd -> cyan) rendered first this time, cluster 0 (even ->
    // pink) second — still cyan-then-pink, exactly the opposite of what a
    // pure insertion-order toggle would produce.
    expect(colorsByAppearance[0]).toBe(THEME.cyan.replace('#', '').toLowerCase())
    expect(colorsByAppearance[1]).toBe(THEME.pink.replace('#', '').toLowerCase())
    await renderer.unmount()
  })
})

describe('TacticalVectorField — anomaly beacon mount/unmount', () => {
  const positions = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2])
  const clusterLabels = [0, 0, 0]

  function findBeaconMeshes(scene: ReactThreeTest.ReactThreeTestInstance) {
    return scene.findAll(
      (node) => (node.instance as unknown as { geometry?: { type?: string } }).geometry?.type === 'IcosahedronGeometry',
    )
  }

  it('mounts one beacon per anomaly index', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField
        {...baseProps({ positions, clusterLabels, anomalyIndices: [0, 1] })}
      />,
    )
    expect(findBeaconMeshes(renderer.scene)).toHaveLength(2)
    await renderer.unmount()
  })

  it('unmounts beacons whose anomaly index no longer appears in the next frame', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField {...baseProps({ positions, clusterLabels, anomalyIndices: [0, 1, 2] })} />,
    )
    expect(findBeaconMeshes(renderer.scene)).toHaveLength(3)

    await renderer.update(
      <TacticalVectorField {...baseProps({ positions, clusterLabels, anomalyIndices: [1] })} />,
    )
    expect(findBeaconMeshes(renderer.scene)).toHaveLength(1)
    await renderer.unmount()
  })

  it('renders zero beacons when nothing is anomalous', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField {...baseProps({ positions, clusterLabels, anomalyIndices: [] })} />,
    )
    expect(findBeaconMeshes(renderer.scene)).toHaveLength(0)
    await renderer.unmount()
  })
})

describe('TracerLines — skip HDBSCAN noise points (regression, 2026-08-30 sprint, Finding 2)', () => {
  // idx 0/2 are in cluster 0; idx 1/3 are noise (clusterLabel -1). Before the
  // fix, noise points fell through to an undefined centroid and drew a
  // tracer segment straight to the scene origin -- not a meaningful point.
  const positions = new Float32Array([
    0, 0, 0, // idx 0 -- cluster 0
    50, 50, 50, // idx 1 -- noise
    1, 1, 1, // idx 2 -- cluster 0
    -50, -50, -50, // idx 3 -- noise
  ])
  const clusterLabels = [0, -1, 0, -1]

  function findTracerLineSegments(scene: ReactThreeTest.ReactThreeTestInstance) {
    return scene.findAll((node) =>
      Boolean((node.instance as unknown as { isLineSegments?: boolean }).isLineSegments),
    )
  }

  it('draws one segment per non-noise point only -- none for the two noise-labeled points', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField {...baseProps({ positions, clusterLabels })} />,
    )
    const lineSegmentsNodes = findTracerLineSegments(renderer.scene)
    expect(lineSegmentsNodes).toHaveLength(1)
    const geometry = (
      lineSegmentsNodes[0].instance as unknown as {
        geometry: { attributes: { position: { count: number } } }
      }
    ).geometry
    // 2 non-noise points (idx 0, 2) -> 2 segments -> 4 endpoint vertices.
    // Pre-fix this would have been 4 points -> 8 vertices, two of them
    // sitting at the scene origin.
    expect(geometry.attributes.position.count).toBe(4)
    await renderer.unmount()
  })

  it('renders no tracer lines at all when every point is noise', async () => {
    const allNoisePositions = new Float32Array([0, 0, 0, 1, 1, 1])
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField
        {...baseProps({ positions: allNoisePositions, clusterLabels: [-1, -1] })}
      />,
    )
    expect(findTracerLineSegments(renderer.scene)).toHaveLength(0)
    await renderer.unmount()
  })
})

describe('AnomalyBeacon — mock data is non-interactive (regression, 2026-08-30 sprint, Finding 1)', () => {
  const positions = new Float32Array([0, 0, 0, 1, 1, 1])
  const clusterLabels = [0, 0]

  function findBeaconMesh(scene: ReactThreeTest.ReactThreeTestInstance) {
    return scene.find(
      (node) =>
        (node.instance as unknown as { geometry?: { type?: string } }).geometry?.type ===
        'IcosahedronGeometry',
    )
  }

  it('clicking a mock beacon does not dispatch an explain request', async () => {
    const onExplainRequest = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField
        {...baseProps({
          positions,
          clusterLabels,
          anomalyIndices: [0],
          onExplainRequest,
          isMockData: true,
        })}
      />,
    )
    const beacon = findBeaconMesh(renderer.scene)
    await renderer.fireEvent(beacon, 'click', {})
    expect(onExplainRequest).not.toHaveBeenCalled()
    await renderer.unmount()
  })

  it('clicking a real (non-mock) beacon still dispatches the explain request as before', async () => {
    const onExplainRequest = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <TacticalVectorField
        {...baseProps({
          positions,
          clusterLabels,
          anomalyIndices: [0],
          onExplainRequest,
          isMockData: false,
        })}
      />,
    )
    const beacon = findBeaconMesh(renderer.scene)
    await renderer.fireEvent(beacon, 'click', {})
    expect(onExplainRequest).toHaveBeenCalledTimes(1)
    await renderer.unmount()
  })
})
