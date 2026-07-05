/**
 * DiagnosticSidebar — Live diagnostic panel for the IYE anomaly engine.
 *
 * Renders a visual connectivity state dot, frame metadata, cluster
 * distribution, and the backend's plain-English explainability text.
 *
 * Design tokens:
 *   - Blush Pink (#ffb6c1) — healthy / nominal
 *   - Neon Magenta (#ff00ff) — anomaly detected
 *   - Bright Neon Pink/Red (#ff0055) — socket offline
 */

import React, { useMemo } from 'react'
import type { StreamState, VectorFrame } from '@canvas/math/useVectorStream'

// ─── Design Tokens ────────────────────────────────────────────────────────────

const COLORS = {
  black: '#000000',
  pink: '#ffb6c1',
  magenta: '#ff00ff',
  offline: '#ff0055',
  pinkDim: 'rgba(255, 182, 193, 0.12)',
  pinkBorder: 'rgba(255, 182, 193, 0.2)',
  pinkText: 'rgba(255, 182, 193, 0.6)',
  white10: 'rgba(255, 255, 255, 0.06)',
  white20: 'rgba(255, 255, 255, 0.12)',
  textPrimary: 'rgba(255, 255, 255, 0.88)',
  textMuted: 'rgba(255, 255, 255, 0.38)',
  divider: 'rgba(255, 182, 193, 0.08)',
} as const

const MONO_FONT = "'Courier New', Courier, monospace"

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DiagnosticSidebarProps {
  streamState: StreamState
  activeFrame: VectorFrame | null
  isLive: boolean
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Visual connectivity state dot with context-aware color and pulse animation.
 */
const ConnectivityDot: React.FC<{
  streamState: StreamState
  status: 'NOMINAL' | 'ANOMALY' | null
}> = ({ streamState, status }) => {
  const dotColor = useMemo(() => {
    if (streamState === 'disconnected' || streamState === 'error') {
      return COLORS.offline
    }
    if (status === 'ANOMALY') {
      return COLORS.magenta
    }
    return COLORS.pink
  }, [streamState, status])

  const label = useMemo(() => {
    if (streamState === 'connecting') return 'connecting...'
    if (streamState === 'disconnected') return 'stream · offline'
    if (streamState === 'error') return 'stream · error'
    if (status === 'ANOMALY') return 'stream · anomaly detected'
    return 'stream · nominal'
  }, [streamState, status])

  return (
    <div
      id="iye-connectivity-indicator"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 0',
        marginBottom: 20,
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: `0 0 10px ${dotColor}, 0 0 4px ${dotColor}`,
          animation: 'iye-pulse 2.4s ease-in-out infinite',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.16em',
          color: COLORS.textMuted,
          textTransform: 'lowercase',
          fontFamily: MONO_FONT,
        }}
      >
        {label}
      </span>
    </div>
  )
}

/**
 * Explanation block for system notes and frame diagnostic text.
 */
const ExplanationBlock: React.FC<{
  title: string
  content: string
}> = ({ title, content }) => (
  <div
    style={{
      background: COLORS.white10,
      border: `1px solid ${COLORS.white20}`,
      borderRadius: 8,
      padding: '14px 16px',
      marginBottom: 12,
    }}
  >
    <p
      style={{
        margin: '0 0 6px 0',
        fontSize: 9,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: COLORS.pinkText,
        fontFamily: MONO_FONT,
      }}
    >
      {title}
    </p>
    <p
      style={{
        margin: 0,
        fontSize: 11,
        color: COLORS.textMuted,
        lineHeight: 1.7,
        fontFamily: MONO_FONT,
        wordBreak: 'break-word',
      }}
    >
      {content}
    </p>
  </div>
)

/**
 * Frame metadata panel — renders point count, status, and cluster distribution.
 */
const FrameMetadata: React.FC<{ frame: VectorFrame }> = ({ frame }) => {
  const clusterDistribution = useMemo(() => {
    const counts = new Map<number, number>()
    for (const label of frame.cluster_labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const parts: string[] = []
    const sortedKeys = Array.from(counts.keys()).sort((a, b) => a - b)
    for (const key of sortedKeys) {
      const count = counts.get(key)
      if (key === -1) {
        parts.push(`noise: ${String(count)}`)
      } else {
        parts.push(`c${String(key)}: ${String(count)}`)
      }
    }
    return parts.join(' · ')
  }, [frame.cluster_labels])

  const statusColor = frame.status === 'ANOMALY' ? COLORS.magenta : COLORS.pink

  return (
    <div style={{ marginBottom: 16 }}>
      <p
        style={{
          margin: '0 0 12px 0',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: COLORS.textMuted,
          fontFamily: MONO_FONT,
        }}
      >
        active frame
      </p>

      {/* Status badge */}
      <div
        style={{
          display: 'inline-block',
          padding: '3px 10px',
          borderRadius: 4,
          fontSize: 9,
          letterSpacing: '0.14em',
          fontWeight: 600,
          color: COLORS.black,
          background: statusColor,
          marginBottom: 12,
          fontFamily: MONO_FONT,
        }}
      >
        {frame.status}
      </div>

      {/* Metadata grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 12px',
          fontSize: 10,
          fontFamily: MONO_FONT,
          color: COLORS.textMuted,
          marginBottom: 12,
        }}
      >
        <span style={{ color: COLORS.pinkText }}>points</span>
        <span>{frame.point_count}</span>

        <span style={{ color: COLORS.pinkText }}>anomalies</span>
        <span>
          {frame.anomaly_indices.length}
          {frame.anomaly_indices.length > 0 && (
            <span style={{ color: COLORS.magenta, marginLeft: 4 }}>
              [{frame.anomaly_indices.slice(0, 8).join(', ')}
              {frame.anomaly_indices.length > 8 ? '...' : ''}]
            </span>
          )}
        </span>

        <span style={{ color: COLORS.pinkText }}>clusters</span>
        <span>{clusterDistribution}</span>

        <span style={{ color: COLORS.pinkText }}>window_fill</span>
        <span>{(frame.temporal.window_fill * 100).toFixed(0)}%</span>

        <span style={{ color: COLORS.pinkText }}>z_max</span>
        <span>{frame.temporal.z_max.toFixed(2)}</span>

        <span style={{ color: COLORS.pinkText }}>velocity</span>
        <span>{frame.temporal.velocity.toFixed(2)}</span>

        <span style={{ color: COLORS.pinkText }}>drift_slope</span>
        <span>{frame.temporal.drift_slope.toFixed(2)}</span>

        <span style={{ color: COLORS.pinkText }}>frame</span>
        <span style={{ fontSize: 8, opacity: 0.6 }}>
          {frame.frame_id.slice(0, 8)}
        </span>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const DiagnosticSidebar: React.FC<DiagnosticSidebarProps> = ({
  streamState,
  activeFrame,
  isLive,
}) => {
  return (
    <div
      id="iye-diagnostic-sidebar"
      style={{
        width: '30%',
        minWidth: 240,
        maxWidth: 360,
        height: '100vh',
        background: COLORS.black,
        borderLeft: `1px solid ${COLORS.divider}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '32px 24px',
        boxSizing: 'border-box',
        flexShrink: 0,
        overflowY: 'auto',
        fontFamily: MONO_FONT,
      }}
    >
      {/* ── Brand header ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 8,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: COLORS.pinkDim,
              border: `1px solid ${COLORS.pinkBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: COLORS.pink,
                opacity: 0.9,
              }}
            />
          </div>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '0.12em',
              color: COLORS.textPrimary,
              textTransform: 'lowercase',
              fontFamily: MONO_FONT,
            }}
          >
            iye
          </span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 10,
            letterSpacing: '0.18em',
            color: COLORS.textMuted,
            textTransform: 'uppercase',
            fontFamily: MONO_FONT,
          }}
        >
          vector canvas · {isLive ? 'live' : 'dev'}
        </p>
      </div>

      {/* ── Connectivity indicator ───────────────────────────────────── */}
      <ConnectivityDot
        streamState={streamState}
        status={activeFrame?.status ?? null}
      />

      {/* ── Active frame metadata ────────────────────────────────────── */}
      {activeFrame && <FrameMetadata frame={activeFrame} />}

      {/* ── Explainability text ──────────────────────────────────────── */}
      {activeFrame && (activeFrame.explanation !== null || activeFrame.status === 'ANOMALY') && (
        <ExplanationBlock
          title="analysis"
          content={activeFrame.explanation ?? 'analyzing…'}
        />
      )}

      {/* ── System notes ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: 8 }}>
        <p
          style={{
            margin: '0 0 12px 0',
            fontSize: 9,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: COLORS.textMuted,
            fontFamily: MONO_FONT,
          }}
        >
          system notes
        </p>

        <ExplanationBlock
          title="coordinate space"
          content="right-handed xyz · units: normalized · origin: scene center"
        />
        <ExplanationBlock
          title="pipeline"
          content="umap reduction → hdbscan clustering → z-score anomaly detection → websocket broadcast"
        />
        <ExplanationBlock
          title="render loop"
          content="requestAnimationFrame · 60fps target · hot-reload on source change"
        />
      </div>

      {/* ── Bottom status ────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 0',
          borderTop: `1px solid ${COLORS.divider}`,
          marginTop: 'auto',
        }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: COLORS.pink,
            boxShadow: `0 0 8px ${COLORS.pink}`,
            animation: 'iye-pulse 2.4s ease-in-out infinite',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 9,
            letterSpacing: '0.16em',
            color: COLORS.textMuted,
            textTransform: 'lowercase',
            fontFamily: MONO_FONT,
          }}
        >
          canvas · rendering
        </span>
      </div>
    </div>
  )
}

export default DiagnosticSidebar
