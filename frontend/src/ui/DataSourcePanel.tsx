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
// independent hardcoded copy. The pink-text opacity tiers are this panel's
// own hierarchy choice, preserved exactly — unifying the base color
// doesn't mean forcing every opacity to one value.
//
// 2026-08-28: pinkText50 (0.5) and the original textMuted (whiteAlpha 0.38)
// both measured under WCAG AA's 4.5:1 normal-text floor against #0a0a0d
// (3.63:1 and 3.51:1 respectively — see
// VectorViewport.contrast.test.ts/theme.contrast.test.ts) despite being
// real body-text colors here (drop-zone hints, the 'partial' status
// message), not decorative. textMuted raised to 0.47 (4.82:1). pinkText50
// as a distinct tier below pinkText60 is gone entirely: the AA floor for
// this hue only clears at alpha ~0.577, which leaves no meaningful gap
// below pinkText60's existing 0.6 (4.78:1) for a dimmer-but-still-legal
// tier to live in — so the one call site that used it now uses
// pinkText60 directly instead of a same-looking constant under a
// different, now-misleading name.

// Exported so theme.contrast.test.ts can check these exact values (the
// real ones every render uses), not a hand-copied duplicate that could
// silently drift from what's actually in use.
export const COLORS = {
  pink: THEME.pink,
  pinkDim: THEME.pinkDim,
  pinkBorder: THEME.pinkBorder,
  pinkText60: pinkAlpha(0.6),
  pinkText70: pinkAlpha(0.7),
  textMuted: whiteAlpha(0.47),
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
  /** Aborts an in-flight ingest — the drop zone's only way out of `parsing`
   *  besides waiting for the request to settle or time out (2026-08-28
   *  sprint; see useVectorDiagnostics.ts's cancelIngest). */
  onCancel?: () => void
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
  onCancel?: () => void
}> = ({ state, onConfirmOffer, onDismissOffer, onRetry, onCancel }) => {
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
          <div style={{ fontSize: 9, color: COLORS.pinkText60, letterSpacing: '0.08em', marginBottom: 12 }}>
            parsing…{typeof state.progress === 'number' ? ` ${String(Math.round(state.progress * 100))}%` : ''}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <PanelButton onClick={() => onCancel?.()} variant="muted">
              cancel
            </PanelButton>
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
          <div style={{ fontSize: 9, color: COLORS.pinkText60, letterSpacing: '0.06em' }}>
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
  onCancel,
}) => {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // A request is already in flight — the zone doesn't accept a new drop
  // while busy (2026-08-28 sprint). This is a UX gate, not the actual
  // correctness guarantee: useVectorDiagnostics.ts's generation-guard +
  // AbortController is what makes a second upload win even if this gate
  // were somehow bypassed (e.g. a fast double-drop event landing before
  // React re-renders 'parsing').
  const isBusy = state.status === 'parsing'

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      if (!isBusy) setIsDragging(true)
    },
    [isBusy],
  )

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragging(false)
      if (isBusy) return
      const file = e.dataTransfer.files[0]
      if (file) onFile(file)
    },
    [isBusy, onFile],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // Reset the input's value (2026-08-28 sprint) — a browser's <input
      // type="file"> only fires 'change' when its value actually changes,
      // so re-selecting the exact same filename via click-to-browse (drag-
      // and-drop is unaffected — it never goes through this input at all)
      // fired no event and silently did nothing. Reset unconditionally,
      // even when busy/no file chosen, so a cancelled file-picker dialog
      // doesn't leave a stale value blocking the next identical selection.
      e.target.value = ''
      if (file && !isBusy) onFile(file)
    },
    [isBusy, onFile],
  )

  const openFileDialog = useCallback(() => {
    if (!isBusy) inputRef.current?.click()
  }, [isBusy])

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
        tabIndex={isBusy ? -1 : 0}
        aria-disabled={isBusy}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={openFileDialog}
        onKeyDown={(e) => {
          // WAI-ARIA APG for custom button roles: Space is as much an
          // activation key as Enter (2026-08-28 sprint — this only
          // handled Enter before). preventDefault on Space specifically
          // matters: without it, a focused custom "button" div lets Space
          // fall through to its default browser behavior, scrolling the
          // page, instead of opening the file dialog.
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openFileDialog()
          }
        }}
        style={{
          border: `1px dashed ${isDragging ? COLORS.pink : COLORS.pinkBorder}`,
          borderRadius: 8,
          padding: '20px 16px',
          textAlign: 'center',
          cursor: isBusy ? 'default' : 'pointer',
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
          disabled={isBusy}
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />

        {/* role="status" (2026-08-28 sprint) — announces upload
            success/failure/offer-confirmation and stream disconnect/
            reconnect to screen-reader users, who otherwise get no signal
            at all when this region's content changes. Implies
            aria-live="polite"/aria-atomic="true" per the ARIA spec;
            stated explicitly too for older AT compatibility. */}
        <div role="status" aria-live="polite">
          <StatusRegion
            state={state}
            onConfirmOffer={onConfirmOffer}
            onDismissOffer={onDismissOffer}
            onRetry={onRetry}
            onCancel={onCancel}
          />
        </div>
      </div>
    </div>
  )
}

export default DataSourcePanel
