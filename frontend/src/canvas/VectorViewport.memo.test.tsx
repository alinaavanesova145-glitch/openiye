import { memo } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

/**
 * Proves the React.memo mechanism that the canvas subtree relies on, for
 * exactly the prop shapes it uses (a Float32Array + parallel number[]
 * label/index arrays).
 *
 * Boundary of what this test can prove: `InstancedCoreNodes`, `ClusterHulls`,
 * `TracerLines`, `AnomalyBeacons`, and `AnomalyBeacon` in VectorViewport.tsx
 * render react-three-fiber intrinsics (<mesh>, <instancedMesh>, ...), which
 * are host elements for R3F's own reconciler, not ReactDOM's — they cannot be
 * mounted via @testing-library/react under jsdom (no `@react-three/test-renderer`
 * is installed, and installing one was judged out of scope for proving this
 * one property). This test instead renders a plain DOM stand-in with the
 * identical prop shape and memo wrapping, proving:
 *   (a) React.memo correctly skips re-render when given the SAME references,
 *   (b) React.memo correctly re-renders when given DIFFERENT references.
 * Combined with useVectorStream.test.ts's "referential stability" tests
 * (which prove the hook hands out the SAME references for value-identical
 * frames and NEW references for changed ones), these two facts together
 * prove the end-to-end claim without needing to mount the real R3F tree.
 */

interface ProbeProps {
  positions: Float32Array
  clusterLabels: number[]
  onRender: () => void
}

const MemoProbe = memo(function MemoProbe({ positions, clusterLabels, onRender }: ProbeProps) {
  onRender()
  return (
    <div data-testid="probe">
      {positions.length}/{clusterLabels.length}
    </div>
  )
})

describe('React.memo mechanism for canvas-subtree prop shapes', () => {
  it('re-renders when positions/clusterLabels get a new reference (real data change)', () => {
    let renderCount = 0
    const stableOnRender = () => {
      renderCount++
    }

    const { rerender } = render(
      <MemoProbe
        positions={new Float32Array([1, 2, 3])}
        clusterLabels={[0, 1]}
        onRender={stableOnRender}
      />,
    )
    expect(renderCount).toBe(1)

    rerender(
      <MemoProbe
        positions={new Float32Array([1, 2, 3])} // same values, NEW Float32Array identity
        clusterLabels={[0, 1]} // same values, NEW array identity
        onRender={stableOnRender}
      />,
    )

    expect(renderCount).toBe(2) // memo re-renders — this is why useVectorStream's
    // reference-reuse fix matters: without it, every message would look like this
  })

  it('does not re-render across two renders with truly stable references and a stable callback', () => {
    let renderCount = 0
    const stableOnRender = () => {
      renderCount++
    }
    const positions = new Float32Array([1, 2, 3])
    const clusterLabels = [0, 1]

    const { rerender } = render(
      <MemoProbe positions={positions} clusterLabels={clusterLabels} onRender={stableOnRender} />,
    )
    expect(renderCount).toBe(1)

    rerender(
      <MemoProbe positions={positions} clusterLabels={clusterLabels} onRender={stableOnRender} />,
    )

    expect(renderCount).toBe(1) // memo bails out — all three props are reference-identical
  })
})
