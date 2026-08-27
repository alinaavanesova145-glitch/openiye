/**
 * ErrorBoundary — the app had none anywhere (2026-08-27 sprint audit
 * finding). App.tsx only wrapped the lazy-loaded 3D viewport in
 * <Suspense>, which covers the loading state but not a render-phase
 * throw — an R3F error from malformed geometry that isn't already
 * guarded (e.g. ClusterHulls's own local try/catch only covers
 * ConvexGeometry construction, not later per-frame render-loop math on
 * NaN/degenerate buffer data), or simply the lazy chunk itself failing to
 * load on a flaky connection, unmounted the *entire* React tree with no
 * fallback UI — a silent white screen for both the 3D canvas and the
 * sidebar, with no recovery path for the person looking at it.
 *
 * A plain class component: React only supports error boundaries via
 * componentDidCatch/getDerivedStateFromError, no hook equivalent exists.
 */

import React from 'react'
import { THEME, whiteAlpha } from './theme'

interface Props {
  children: React.ReactNode
  /** Short label for what crashed, shown in the fallback UI so a report
   * back to the person who built this ("the canvas broke") is specific
   * rather than generic. */
  fallbackTitle: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Logged, not swallowed — same "never silently eaten" discipline the
    // backend's own except-Exception backstops already follow (see
    // app/api/main.py's ingest_and_broadcast). This project's eslint config
    // doesn't restrict console.error, so no disable directive is needed.
    console.error(`[ErrorBoundary] ${this.props.fallbackTitle} crashed:`, error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: THEME.bg,
            fontFamily: "'Courier New', Courier, monospace",
          }}
        >
          <div
            style={{
              maxWidth: 420,
              padding: '28px 32px',
              border: `1px solid ${THEME.pinkBorder}`,
              borderRadius: 8,
              background: 'rgba(0, 0, 0, 0.6)',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: THEME.pink,
                marginBottom: 12,
              }}
            >
              {this.props.fallbackTitle} hit an unexpected error
            </div>
            <p
              style={{
                margin: '0 0 16px 0',
                fontSize: 13,
                lineHeight: 1.6,
                color: whiteAlpha(0.85),
              }}
            >
              Something went wrong rendering this view. Reloading usually
              clears it — if it keeps happening with the same file, that&apos;s
              worth reporting.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                fontFamily: 'inherit',
                fontSize: 11,
                letterSpacing: '0.04em',
                color: THEME.pink,
                background: 'transparent',
                border: `1px solid ${THEME.pinkBorder}`,
                borderRadius: 4,
                padding: '8px 16px',
                cursor: 'pointer',
              }}
            >
              reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
