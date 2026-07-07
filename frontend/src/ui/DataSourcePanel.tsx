/**
 * DataSourcePanel — the DATA SOURCE drop zone, driven entirely by an
 * explicit DataSourceState (idle/parsing/rejected/partial/loaded/error).
 *
 * Replaces the old silent-failure FileDropZone (see docs/idealization_report.md,
 * 2026-07-07 sprint, Phase 0/2): every outcome of a drop is now rendered,
 * the previous scene is left alone on rejection/error (no state carried
 * here implies no canvas change), and nothing is ever silently swallowed.
 *
 * Design system: blush-pink opacity tiers only, lowercase, hairline
 * borders — no magenta anywhere in this panel (magenta is reserved for
 * status: "ANOMALY" elsewhere, never for an upload error/rejection).
 */

import React, { useCallback, useRef, useState } from 'react'
import {
  formatLoadedMessage,
  formatPartialMessage,
  type DataSourceState,
} from '@canvas/upload/dataSourceState'

// ─── Design Tokens ────────────────────────────────────────────────────────────

const COLORS = {
  pink: '#ffb6c1',
  pinkDim: 'rgba(255, 182, 193, 0.12)',
  pinkBorder: 'rgba(255, 182, 193, 0.2)',
  pinkText60: 'rgba(255, 182, 193, 0.6)',
  pinkText50: 'rgba(255, 182, 193, 0.5)',
  pinkText70: 'rgba(255, 182, 193, 0.7)',
  textMuted: 'rgba(255, 255, 255, 0.38)',
} as const

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DataSourcePanelProps {
  state: DataSourceState
  onFile: (file: File) => void
}

// ─── Status region (pure render from state — this is what Phase 2's tests target) ──

const StatusRegion: React.FC<{ state: DataSourceState }> = ({ state }) => {
  switch (state.status) {
    case 'idle':
      return (
        <div>
          <div style={{ fontSize: 18, marginBottom: 8, opacity: 0.4, color: COLORS.pink }}>↓</div>
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
            <span style={{ opacity: 0.5 }}>json · csv · npy</span>
          </div>
        </div>
      )

    case 'parsing':
      return (
        <div>
          <Filename name={state.filename} />
          <div style={{ fontSize: 9, color: COLORS.pinkText60, letterSpacing: '0.08em' }}>
            parsing…{typeof state.progress === 'number' ? ` ${String(Math.round(state.progress * 100))}%` : ''}
          </div>
        </div>
      )

    case 'rejected':
      return (
        <div>
          <Filename name={state.filename} />
          <div
            style={{
              fontSize: 9,
              color: COLORS.pinkText70,
              letterSpacing: '0.06em',
              lineHeight: 1.5,
            }}
          >
            {state.reason}
          </div>
        </div>
      )

    case 'partial':
      return (
        <div>
          <Filename name={state.filename} />
          <div style={{ fontSize: 9, color: COLORS.pinkText50, letterSpacing: '0.06em' }}>
            {formatPartialMessage(state)}
          </div>
        </div>
      )

    case 'loaded':
      return (
        <div>
          <Filename name={state.filename} />
          <div style={{ fontSize: 9, color: COLORS.pinkText60, letterSpacing: '0.06em' }}>
            {formatLoadedMessage(state)}
          </div>
        </div>
      )

    case 'error':
      return (
        <div>
          <Filename name={state.filename} />
          <div
            style={{
              fontSize: 9,
              color: COLORS.pinkText70,
              letterSpacing: '0.06em',
              lineHeight: 1.5,
            }}
          >
            {state.reason}
          </div>
        </div>
      )
  }
}

const Filename: React.FC<{ name: string }> = ({ name }) => (
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
    {name}
  </div>
)

// ─── Main component ────────────────────────────────────────────────────────────

export const DataSourcePanel: React.FC<DataSourcePanelProps> = ({ state, onFile }) => {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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
      if (file) onFile(file)
    },
    [onFile],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) onFile(file)
    },
    [onFile],
  )

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
          accept=".json,.csv,.npy"
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />

        <StatusRegion state={state} />
      </div>
    </div>
  )
}

export default DataSourcePanel
