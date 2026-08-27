/**
 * ErrorBoundary.test.tsx (2026-08-27 sprint) — the app previously had no
 * error boundary anywhere, so any render-phase throw white-screened the
 * whole tree with no recovery UI (see ErrorBoundary.tsx's own docstring).
 * These tests prove the boundary actually catches, renders a fallback
 * instead of propagating, and lets a sibling subtree keep working.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Bomb(): never {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary fallbackTitle="test panel">
        <div>all good</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('all good')).toBeInTheDocument()
  })

  it('catches a render-phase throw and shows the fallback instead of propagating', () => {
    // React logs the caught error to the console by default even though
    // the boundary handles it — silence that expected noise for this test.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary fallbackTitle="3D viewport">
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/3D viewport hit an unexpected error/)).toBeInTheDocument()
    expect(screen.getByText('reload')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })

  it('an independent sibling ErrorBoundary is unaffected by another one catching', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <div>
        <ErrorBoundary fallbackTitle="broken panel">
          <Bomb />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="healthy panel">
          <div>still rendering</div>
        </ErrorBoundary>
      </div>,
    )
    expect(screen.getByText(/broken panel hit an unexpected error/)).toBeInTheDocument()
    expect(screen.getByText('still rendering')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })
})
