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
  formatOfferMessage,
  formatPartialMessage,
  type DataSourceState,
} from '@canvas/upload/dataSourceState'
import { THEME, pinkAlpha, whiteAlpha } from '@lib/theme'

// ─── Design Tokens ────────────────────────────────────────────────────────────
// 2026-08-01: base pink sourced from @lib/theme instead of a fourth
// independent hardcoded copy. The three pink-text opacity tiers
// (50/60/70%) are this panel's own hierarchy choice, preserved exactly —
// unifying the base color doesn't mean forcing every opacity to one value.

const COLORS = {
  pink: THEME.pink,
  pinkDim: THEME.pinkDim,
  pinkBorder: THEME.pinkBorder,
  pinkText60: pinkAlpha(0.6),
  pinkText50: pinkAlpha(0.5),
  pinkText70: pinkAlpha(0.7),
  textMuted: whiteAlpha(0.38),
} as const

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DataSourcePanelProps {
  state: DataSourceState
  onFile: (file: File) => void
  /** Confirms a pending `offer` — triggers the actual ingest. No-op if state
   *  isn't `offer` (caller should only wire this to the visible button). */
  onConfirmOffer?: () => void
  /** Dismisses a pending `offer` back to `idle` without ever ingesting. */
  onDismissOffer?: () => void
  /** Re-attempts a `network_error`'d ingest without re-selecting the file. */
  onRetry?: () => void
}

/** Shared styling for the panel's inline action buttons (offer's two,
 *  network_error's retry) — same visual language, kept in one place. */
const PanelButton: React.FC<{
  onClick: () => void
  variant?: 'primary' | 'muted'
  children: React.ReactNode
}> = ({ onClick, variant = 'primary', children }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation()
      onClick()
    }}
    style={{
      fontFamily: 'inherit',
      fontSize: 9,
      letterSpacing: '0.06em',
      textTransform: 'lowercase',
      color: variant === 'primary' ? COLORS.pink : COLORS.textMuted,
      background: variant === 'primary' ? COLORS.pinkDim : 'transparent',
      border: `1px solid ${COLORS.pinkBorder}`,
      borderRadius: 6,
      padding: '6px 12px',
      cursor: 'pointer',
    }}
  >
    {children}
  </button>
)

// ─── Status region (pure render from state — this is what Phase 2's tests target) ──

const StatusRegion: React.FC<{
  state: DataSourceState
  onConfirmOffer?: () => void
  onDismissOffer?: () => void
  onRetry?: () => void
}> = ({ state, onConfirmOffer, onDismissOffer, onRetry }) => {
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
      // Transport succeeded, the backend reached and rejected the request —
      // distinct copy and color tier from `network_error` below (never
      // "backend unreachable" here — it was reached).
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

    case 'network_error':
      // Transport-level failure — the backend was never reached. Distinct
      // from both `rejected` (a content decision, made without any network
      // call) and `error` (reached, then rejected). Carries a retry action
      // since there's nothing wrong with the file to fix.
      return (
        <div>
          <Filename name={state.filename} />
          <div
            style={{
              fontSize: 9,
              color: COLORS.pinkText70,
              letterSpacing: '0.06em',
              lineHeight: 1.5,
              marginBottom: 12,
            }}
          >
            {state.reason}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <PanelButton onClick={() => onRetry?.()}>retry</PanelButton>
          </div>
        </div>
      )

    case 'offer':
      // IYE never fabricates geometry from pure-text data without consent —
      // this state renders the offer, but ingestion only happens on click.
      return (
        <div>
          <Filename name={state.filename} />
          <div
            style={{
              fontSize: 9,
              color: COLORS.pinkText60,
              letterSpacing: '0.06em',
              marginBottom: 12,
            }}
          >
            {formatOfferMessage(state)}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <PanelButton onClick={() => onConfirmOffer?.()}>encode &amp; visualize</PanelButton>
            <PanelButton onClick={() => onDismissOffer?.()} variant="muted">
              dismiss
            </PanelButton>
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

export const DataSourcePanel: React.FC<DataSourcePanelProps> = ({
  state,
  onFile,
  onConfirmOffer,
  onDismissOffer,
  onRetry,
}) => {
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

        <StatusRegion
          state={state}
          onConfirmOffer={onConfirmOffer}
          onDismissOffer={onDismissOffer}
          onRetry={onRetry}
        />
      </div>
    </div>
  )
}

export default DataSourcePanel
