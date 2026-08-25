import React, { Suspense, lazy, useCallback } from 'react'
import { useVectorDiagnostics } from '@canvas/math/useVectorDiagnostics'
import { DiagnosticSidebar } from '@/ui/DiagnosticSidebar'
import { DataSourcePanel } from '@/ui/DataSourcePanel'
import { IS_PUBLIC_HOST } from '@lib/apiConfig'
import { THEME, pinkAlpha } from '@lib/theme'
import type { StreamState } from '@canvas/math/useVectorStream'

// Lazy-loaded so the shell (sidebar, terminal panel, layout) paints before
// the three.js/@react-three 3D engine — the vast majority of the bundle —
// finishes downloading. See vite.config.ts's manualChunks for the vendor split.
const VectorViewport = lazy(() => import('@canvas/VectorViewport'))

// ─── Constants ────────────────────────────────────────────────────────────────
// 2026-08-01: sourced from @lib/theme, the shared token module, instead of
// a locally hand-rolled palette — see theme.ts's docstring. `bg` was
// previously a literal `#000000`; now the same pitch-black-with-depth
// `#0a0a0d` the landing page uses (WCAG-verified, see docs/idealization_report.md,
// 2026-07-30 sprint). pinkDim/pinkText/white10/white20/textMuted were
// unused dead tokens, dropped rather than migrated. pinkBorder uses
// THEME's own named constant (shared with landing.css and
// DiagnosticSidebar.tsx at the exact same value); divider uses the raw
// pinkAlpha() helper since it's this file's own bespoke opacity choice,
// not a value reused anywhere else.

const COLORS = {
  bg: THEME.bg,
  pink: THEME.pink,
  pinkBorder: THEME.pinkBorder,
  textPrimary: 'rgba(255, 255, 255, 0.88)',
  divider: pinkAlpha(0.08),
} as const

// ─── Viewport Panel ───────────────────────────────────────────────────────────

const ViewportFallback: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: COLORS.bg,
    }}
  >
    <span
      style={{
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 11,
        letterSpacing: '0.2em',
        textTransform: 'lowercase',
        color: 'rgba(255, 182, 193, 0.35)',
      }}
    >
      initializing viewport…
    </span>
  </div>
)

/** Pure — the actual decision of whether to show the notice, extracted so
 *  it's unit-testable without mounting PublicHostNotice or ViewportPanel
 *  (which pulls in the lazy-loaded VectorViewport/Canvas — see
 *  VectorViewport.memo.test.tsx for why that can't run under jsdom).
 *  Never shows for a real LAN/local-dev session, and never shows once a
 *  connection actually succeeds even on a public host (e.g. VITE_WS_BASE
 *  was overridden to point somewhere real). */
export function shouldShowPublicHostNotice(isPublicHost: boolean, streamState: StreamState): boolean {
  return isPublicHost && streamState !== 'connected'
}

// Public-deployment notice (2026-08-01 sprint) — the operational canvas
// requires a LAN-local backend that will never be reachable from a public
// host like openiye.pages.dev; the WS hook would otherwise just retry
// forever with no explanation, which reads as "broken", not "expected".
// Shown only when the page itself was loaded from outside the private
// network the backend's own CORS policy would ever accept a request from
// (see @lib/apiConfig's IS_PUBLIC_HOST) AND the stream isn't connected —
// never blocks the real LAN/local-dev case, and never claims to fix the
// connection, only explains it honestly.
export const PublicHostNotice: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      zIndex: 20,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      background: 'rgba(0, 0, 0, 0.72)',
      backdropFilter: 'blur(2px)',
    }}
  >
    <div
      style={{
        maxWidth: 360,
        padding: '24px 28px',
        border: `1px solid ${COLORS.pinkBorder}`,
        borderRadius: 8,
        background: 'rgba(0, 0, 0, 0.6)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: 10,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: COLORS.pink,
          marginBottom: 12,
        }}
      >
        local network required
      </div>
      <p
        style={{
          margin: '0 0 16px 0',
          fontSize: 13,
          lineHeight: 1.6,
          color: COLORS.textPrimary,
        }}
      >
        This view connects to the IYE engine running on your local network —
        it can&rsquo;t reach one from the public internet, by design. Nothing
        is broken; there&rsquo;s just no backend to find from here.
      </p>
      <a
        href="/landing.html"
        style={{
          fontSize: 11,
          letterSpacing: '0.04em',
          color: COLORS.pink,
          textDecoration: 'underline',
        }}
      >
        see the live interactive demo instead
      </a>
    </div>
  </div>
)

const ViewportPanel: React.FC<{ streamState: StreamState }> = ({ streamState }) => (
  <div
    style={{
      flex: 1,
      height: '100vh',
      position: 'relative',
      overflow: 'hidden',
      background: COLORS.bg,
    }}
  >
    <Suspense fallback={<ViewportFallback />}>
      <VectorViewport />
    </Suspense>

    {/* Minimal top-left label */}
    <div
      style={{
        position: 'absolute',
        top: 20,
        left: 20,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.24em',
          color: 'rgba(255, 182, 193, 0.35)',
          textTransform: 'uppercase',
        }}
      >
        vector viewport
      </span>
    </div>

    {shouldShowPublicHostNotice(IS_PUBLIC_HOST, streamState) && <PublicHostNotice />}
  </div>
)

// ─── Global Keyframes (injected once) ─────────────────────────────────────────

const GlobalStyles: React.FC = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; }

    html, body, #root {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--iye-bg);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    /* Hairline blush scrollbar — never a default gray OS scrollbar on the
       black field. Chosen over fully-hidden because the sidebar has no
       other affordance signaling "more content below" once RENDER LOOP
       scrolls out of view. */
    * { scrollbar-width: thin; scrollbar-color: rgba(255,182,193,0.25) transparent; }
    ::-webkit-scrollbar { width: 3px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,182,193,0.25); border-radius: 3px; }
    ::-webkit-scrollbar-button { display: none; height: 0; width: 0; }

    @keyframes iye-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 8px #ffb6c1; }
      50%       { opacity: 0.4; box-shadow: 0 0 3px #ffb6c1; }
    }
  `}</style>
)

// ─── Root App ─────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const {
    activeFrame,
    streamState,
    ingestFile,
    confirmOffer,
    dismissOffer,
    retryIngest,
    isLive,
    dataSourceState,
    llmStatus,
  } = useVectorDiagnostics()

  const handleFile = useCallback(
    (file: File) => {
      void ingestFile(file)
    },
    [ingestFile],
  )

  const handleConfirmOffer = useCallback(() => {
    void confirmOffer()
  }, [confirmOffer])

  const handleRetry = useCallback(() => {
    void retryIngest()
  }, [retryIngest])

  return (
    <>
      <GlobalStyles />
      <div
        id="iye-app-root"
        style={{
          display: 'flex',
          flexDirection: 'row',
          width: '100vw',
          height: '100vh',
          background: COLORS.bg,
          overflow: 'hidden',
        }}
      >
        {/* Left: 3D Vector Viewport (70%) */}
        <ViewportPanel streamState={streamState} />

        {/* Right: Diagnostic Sidebar (30%, clamped 320-480px) */}
        <div
          style={{
            width: '30%',
            minWidth: 320,
            maxWidth: 480,
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: COLORS.bg,
            borderLeft: `1px solid ${COLORS.divider}`,
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          {/* File drop zone sits above the diagnostic panel */}
          <div style={{ padding: '32px 24px 0 24px' }}>
            <DataSourcePanel
              state={dataSourceState}
              onFile={handleFile}
              onConfirmOffer={handleConfirmOffer}
              onDismissOffer={dismissOffer}
              onRetry={handleRetry}
            />
          </div>

          {/* Diagnostic sidebar fills the rest */}
          <DiagnosticSidebar
            streamState={streamState}
            activeFrame={activeFrame}
            isLive={isLive}
            llmStatus={llmStatus}
          />
        </div>
      </div>
    </>
  )
}

export default App
