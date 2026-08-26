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
import { describe, expect, it } from 'vitest'
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
