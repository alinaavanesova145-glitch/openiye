import React, { Suspense, lazy, useCallback } from 'react'
import { useVectorDiagnostics } from '@canvas/math/useVectorDiagnostics'
import { DiagnosticSidebar } from '@/ui/DiagnosticSidebar'
import { DataSourcePanel } from '@/ui/DataSourcePanel'

// Lazy-loaded so the shell (sidebar, terminal panel, layout) paints before
// the three.js/@react-three 3D engine — the vast majority of the bundle —
// finishes downloading. See vite.config.ts's manualChunks for the vendor split.
const VectorViewport = lazy(() => import('@canvas/VectorViewport'))

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = {
  black: '#000000',
  pink: '#ffb6c1',
  pinkDim: 'rgba(255, 182, 193, 0.12)',
  pinkBorder: 'rgba(255, 182, 193, 0.2)',
  pinkText: 'rgba(255, 182, 193, 0.6)',
  white10: 'rgba(255, 255, 255, 0.06)',
  white20: 'rgba(255, 255, 255, 0.12)',
  textPrimary: 'rgba(255, 255, 255, 0.88)',
  textMuted: 'rgba(255, 255, 255, 0.38)',
  divider: 'rgba(255, 182, 193, 0.08)',
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
      background: COLORS.black,
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

const ViewportPanel: React.FC = () => (
  <div
    style={{
      flex: 1,
      height: '100vh',
      position: 'relative',
      overflow: 'hidden',
      background: COLORS.black,
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
      background: #000000;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,182,193,0.2); border-radius: 4px; }

    @keyframes iye-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 8px #ffb6c1; }
      50%       { opacity: 0.4; box-shadow: 0 0 3px #ffb6c1; }
    }
  `}</style>
)

// ─── Root App ─────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const { activeFrame, streamState, ingestFile, isLive, dataSourceState, llmStatus } =
    useVectorDiagnostics()

  const handleFile = useCallback(
    (file: File) => {
      void ingestFile(file)
    },
    [ingestFile],
  )

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
          background: COLORS.black,
          overflow: 'hidden',
        }}
      >
        {/* Left: 3D Vector Viewport (70%) */}
        <ViewportPanel />

        {/* Right: Diagnostic Sidebar (30%) */}
        <div
          style={{
            width: '30%',
            minWidth: 240,
            maxWidth: 360,
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: COLORS.black,
            borderLeft: `1px solid ${COLORS.divider}`,
            flexShrink: 0,
          }}
        >
          {/* File drop zone sits above the diagnostic panel */}
          <div style={{ padding: '32px 24px 0 24px' }}>
            <DataSourcePanel state={dataSourceState} onFile={handleFile} />
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
