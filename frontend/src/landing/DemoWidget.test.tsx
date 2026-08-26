/**
 * DemoWidget.test.tsx (2026-08-28 sprint) — DemoWidget.tsx itself had no
 * test file: LandingApp.test.tsx mocks it away entirely (documented
 * there as covering LandingApp's own content, not DemoWidget's), and
 * useFixtureAnomalyExplain.test.ts/demoFixture.test.ts cover the hook and
 * static data DemoWidget consumes, but never the component's own render
 * logic (the label/badge/caption copy, buildStaticSceneData's derivation
 * from DEMO_POINTS, the narrative-panel wiring).
 *
 * Same documented boundary as VectorViewport.props-wiring.test.tsx: the
 * real <Canvas> needs a real WebGL context jsdom can't provide, so it's
 * mocked to render nothing — every assertion here targets the plain HTML
 * DemoWidget renders alongside the canvas, never the 3D content itself
 * (that's the real TacticalVectorField, already covered by
 * VectorViewport.tactical-field.test.tsx since DemoWidget uses the exact
 * same component, not a reimplementation).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>()
  return { ...actual, Canvas: () => <div data-testid="mock-canvas" />, useFrame: () => {} }
})

import DemoWidget from './DemoWidget'
import { DEMO_DATASET_LABEL, DEMO_AXIS_CAPTION } from './demoFixture'

describe('DemoWidget', () => {
  it('renders the live-demo badge and the dataset label/axis caption from demoFixture', () => {
    render(<DemoWidget />)
    expect(screen.getByText('live interactive demo — sample data')).toBeInTheDocument()
    expect(screen.getByText(`${DEMO_DATASET_LABEL} · ${DEMO_AXIS_CAPTION}`)).toBeInTheDocument()
  })

  it('renders the interaction hint', () => {
    render(<DemoWidget />)
    expect(
      screen.getByText('drag to rotate · click a flagged point for its explanation'),
    ).toBeInTheDocument()
  })

  it('does not crash building the scene data from DEMO_POINTS (positions/clusterLabels/z-scores/attributions all line up)', () => {
    // A mismatch between DEMO_POINTS and DEMO_FEATURE_ATTRIBUTIONS's
    // indices, or a malformed position/zScores shape, would throw inside
    // buildStaticSceneData or the Canvas subtree during render.
    expect(() => render(<DemoWidget />)).not.toThrow()
  })

  it('starts with no narrative panel open (idle explain state)', () => {
    render(<DemoWidget />)
    expect(screen.queryByText(/POINT #/)).not.toBeInTheDocument()
  })
})
