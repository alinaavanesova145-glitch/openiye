import { lazy, Suspense } from 'react'
import type { FC } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

/**
 * Proves the React.lazy + Suspense mechanism App.tsx's ViewportPanel uses to
 * defer the heavy three.js/@react-three viewport behind a design-system
 * fallback ("initializing viewport…").
 *
 * Boundary of what this proves: the real VectorViewport can't mount under
 * jsdom (react-three-fiber's <Canvas> needs a real WebGL context and its own
 * reconciler — same boundary documented in VectorViewport.memo.test.tsx).
 * This test uses a dummy component with the exact same lazy()/Suspense
 * wiring shape as ViewportPanel to prove the mechanism itself: the fallback
 * renders while the import is pending, and the real content renders once it
 * resolves. Live-browser verification confirmed the actual bundle split
 * works (separate vendor-3d chunk, correct final render, no layout
 * regression) but could not reliably force-capture the transient fallback
 * frame itself against a real network-timed chunk — attempted with Playwright
 * route delays and CDP throttling, abandoned as flaky (see
 * docs/idealization_report.md for the attempt and why this test exists
 * instead).
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('React.lazy + Suspense fallback mechanism', () => {
  it('renders the fallback while the lazy import is pending, then the real content once resolved', async () => {
    const { promise, resolve } = deferred<{ default: FC }>()
    const LazyThing = lazy(() => promise)

    render(
      <Suspense fallback={<div>initializing viewport…</div>}>
        <LazyThing />
      </Suspense>,
    )

    expect(screen.getByText('initializing viewport…')).toBeInTheDocument()

    resolve({ default: () => <div>real viewport content</div> })

    await waitFor(() => {
      expect(screen.getByText('real viewport content')).toBeInTheDocument()
    })
    expect(screen.queryByText('initializing viewport…')).not.toBeInTheDocument()
  })
})
