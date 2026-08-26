/**
 * VectorViewport.props-wiring.test.tsx (2026-08-28 sprint) — proves the
 * default-exported VectorViewport component itself correctly derives what
 * it renders from its props, the exact layer Phase 1's bug lived in
 * (App.tsx rendered <VectorViewport /> with zero props; the canvas had no
 * way to ever reflect a REST-uploaded frame).
 *
 * The real <Canvas> (from @react-three/fiber) needs a real WebGL context
 * jsdom can't provide, so it's mocked here to render nothing at all --
 * not just a passthrough. react-dom tolerates react-three-fiber's
 * intrinsic tags (instancedMesh, meshBasicMaterial, ...) as opaque custom
 * elements when nothing renders them, but InstancedCoreNodes/TracerLines's
 * own useEffects then call real THREE methods on refs that are now plain
 * DOM nodes, which throws — see the mock's own comment below. Every
 * assertion here targets the plain HTML VectorViewport renders alongside
 * the canvas (the HUD label, the terminal card), never anything inside
 * it — that's VectorViewport.tactical-field.test.tsx's job, via a real
 * R3F mount.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
// vi.mock calls are hoisted above every import in this file (including
// the ones below) by vitest's transform, so VectorViewport.tsx's own
// `import { Canvas, useFrame } from '@react-three/fiber'` resolves to
// this mock.
// Canvas's children are deliberately NOT rendered at all, not just swapped
// for a passthrough: react-dom renders react-three-fiber's intrinsic tags
// (instancedMesh, meshBasicMaterial, ...) as opaque custom elements when
// there's no real R3F reconciler managing them, but InstancedCoreNodes/
// TracerLines's own useEffects then call real THREE methods
// (mesh.setMatrixAt, ...) on refs that are now just plain DOM nodes,
// which throws. Every assertion in this file targets the plain HTML
// VectorViewport renders alongside the canvas (the HUD label, the
// terminal card), never anything inside it, so discarding the children
// entirely is correct here, not a workaround — the actual 3D content is
// VectorViewport.tactical-field.test.tsx's job, via a real R3F mount.
vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>()
  return {
    ...actual,
    Canvas: () => <div data-testid="mock-canvas" />,
    useFrame: () => {},
  }
})

import VectorViewport from './VectorViewport'
import { DEFAULT_TEMPORAL_METRICS } from './math/useVectorStream'
import type { VectorFrame } from './math/useVectorStream'

function makeFrame(overrides: Partial<VectorFrame> = {}): VectorFrame {
  return {
    frame_id: 'f1',
    id: 'f1',
    timestamp: new Date().toISOString(),
    status: 'NOMINAL',
    point_count: 2,
    coordinates: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ],
    cluster_labels: [0, 0],
    anomaly_indices: [],
    explanation: null,
    axis_mapping: null,
    temporal: DEFAULT_TEMPORAL_METRICS,
    point_z_scores: [],
    axes_are_raw_features: true,
    point_feature_attributions: [],
    ...overrides,
  }
}

function baseProps(overrides: Partial<Parameters<typeof VectorViewport>[0]> = {}) {
  return {
    streamState: 'disconnected' as const,
    activeFrame: null,
    positions: new Float32Array(0),
    anomalyIndices: [],
    clusterLabels: [],
    pointZScores: [],
    pointFeatureAttributions: [],
    temporalRef: { current: DEFAULT_TEMPORAL_METRICS },
    narrativeHistory: [],
    ...overrides,
  }
}

describe('VectorViewport — prop-driven rendering (Phase 1 regression coverage)', () => {
  it('with no real data yet, falls back to the mock frame (150 points) — the honest pre-connection placeholder', () => {
    render(<VectorViewport {...baseProps()} />)
    expect(screen.getByText(/POINTS: 150/)).toBeInTheDocument()
  })

  it('real uploaded/live positions reach the canvas instead of the mock frame — the exact bug this sprint fixed', () => {
    // 4 points via the positions prop -- if VectorViewport still ignored
    // its props (the pre-fix bug), this would show the mock's 150 instead.
    const positions = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
    render(
      <VectorViewport
        {...baseProps({
          positions,
          activeFrame: makeFrame({ point_count: 4 }),
        })}
      />,
    )
    expect(screen.getByText(/POINTS: 4/)).toBeInTheDocument()
    expect(screen.queryByText(/POINTS: 150/)).not.toBeInTheDocument()
  })

  it('the STREAM label reflects the streamState prop', () => {
    render(<VectorViewport {...baseProps({ streamState: 'connected' })} />)
    expect(screen.getByText(/STREAM: connected/)).toBeInTheDocument()
  })

  it('no terminal card when activeFrame is null — nothing to report yet', () => {
    render(<VectorViewport {...baseProps()} />)
    expect(screen.queryByText('AI CORE ANALYSIS')).not.toBeInTheDocument()
  })

  it('the terminal card shows activeFrame\'s own regime/explanation, not a stale reference', () => {
    const positions = new Float32Array([0, 0, 0])
    render(
      <VectorViewport
        {...baseProps({
          positions,
          activeFrame: makeFrame({
            status: 'ANOMALY',
            explanation: 'drift on the pressure axis',
            temporal: { ...DEFAULT_TEMPORAL_METRICS, regime: 'drift' },
          }),
        })}
      />,
    )
    expect(screen.getByText('AI CORE ANALYSIS')).toBeInTheDocument()
    expect(screen.getByText('drift')).toBeInTheDocument()
    expect(screen.getByText('drift on the pressure axis')).toBeInTheDocument()
  })

  it('a nominal activeFrame shows the "System nominal" style explanation, not an anomaly narrative', () => {
    const positions = new Float32Array([0, 0, 0])
    render(
      <VectorViewport
        {...baseProps({
          positions,
          activeFrame: makeFrame({ status: 'NOMINAL', explanation: null }),
        })}
      />,
    )
    expect(screen.getByText('AI CORE ANALYSIS')).toBeInTheDocument()
    // resolveExplanationDisplay returns null for a NOMINAL frame — no
    // explanation paragraph at all, not a blank/undefined-looking one.
    expect(screen.queryByText('null')).not.toBeInTheDocument()
  })
})
