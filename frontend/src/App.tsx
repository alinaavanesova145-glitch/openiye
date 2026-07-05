import React, { Suspense, lazy, useState, useCallback, useRef } from 'react'
import { useVectorDiagnostics } from '@canvas/math/useVectorDiagnostics'
import { DiagnosticSidebar } from '@/ui/DiagnosticSidebar'

// Lazy-loaded so the shell (sidebar, terminal panel, layout) paints before
// the three.js/@react-three 3D engine — the vast majority of the bundle —
// finishes downloading. See vite.config.ts's manualChunks for the vendor split.
const VectorViewport = lazy(() => import('@canvas/VectorViewport'))

// ─── Types ────────────────────────────────────────────────────────────────────

interface DroppedFile {
  name: string
  size: number
  lastModified: number
}

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

// ─── File Drop Zone ───────────────────────────────────────────────────────────

interface FileDropZoneProps {
  onFileData: (data: Float32Array) => void
}

const FileDropZone: React.FC<FileDropZoneProps> = ({ onFileData }) => {
  const [isDragging, setIsDragging] = useState(false)
  const [droppedFile, setDroppedFile] = useState<DroppedFile | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback(
    (file: File) => {
      setDroppedFile({ name: file.name, size: file.size, lastModified: file.lastModified })

      const reader = new FileReader()
      reader.onload = () => {
        const buffer = reader.result
        if (buffer instanceof ArrayBuffer) {
          onFileData(new Float32Array(buffer))
        }
      }
      reader.readAsArrayBuffer(file)
    },
    [onFileData],
  )

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) {
        processFile(file)
      }
    },
    [processFile],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        processFile(file)
      }
    },
    [processFile],
  )

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${String(bytes)} b`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kb`
    return `${(bytes / (1024 * 1024)).toFixed(1)} mb`
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <p
        style={{
          margin: '0 0 10px 0',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: COLORS.textMuted,
        }}
      >
        data source
      </p>

      <div
        id="iye-file-drop-zone"
        role="button"
        tabIndex={0}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        style={{
          border: `1px dashed ${isDragging ? COLORS.pink : COLORS.pinkBorder}`,
          borderRadius: 8,
          padding: '20px 16px',
          textAlign: 'center',
          cursor: 'pointer',
          background: isDragging ? COLORS.pinkDim : 'transparent',
          transition: 'all 0.18s ease',
          outline: 'none',
        }}
      >
        <input
          ref={inputRef}
          id="iye-file-input"
          type="file"
          accept=".json,.csv,.npy,.bin"
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />

        {droppedFile ? (
          <div>
            <div
              style={{
                fontSize: 11,
                color: COLORS.pink,
                marginBottom: 4,
                fontWeight: 500,
                letterSpacing: '0.04em',
                wordBreak: 'break-all',
              }}
            >
              {droppedFile.name}
            </div>
            <div style={{ fontSize: 9, color: COLORS.textMuted, letterSpacing: '0.08em' }}>
              {formatBytes(droppedFile.size)}
            </div>
          </div>
        ) : (
          <div>
            <div
              style={{
                fontSize: 18,
                marginBottom: 8,
                opacity: 0.4,
                color: COLORS.pink,
              }}
            >
              ↓
            </div>
            <div
              style={{
                fontSize: 10,
                color: COLORS.textMuted,
                letterSpacing: '0.08em',
                lineHeight: 1.6,
              }}
            >
              drop file or click
              <br />
              <span style={{ opacity: 0.5 }}>json · csv · npy · bin</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

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
  const { activeFrame, streamState, processVectors, isLive } = useVectorDiagnostics()

  const handleFileData = useCallback(
    (data: Float32Array) => {
      void processVectors(data)
    },
    [processVectors],
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
            <FileDropZone onFileData={handleFileData} />
          </div>

          {/* Diagnostic sidebar fills the rest */}
          <DiagnosticSidebar streamState={streamState} activeFrame={activeFrame} isLive={isLive} />
        </div>
      </div>
    </>
  )
}

export default App
