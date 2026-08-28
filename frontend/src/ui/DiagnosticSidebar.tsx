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
import type { LlmStatus } from '@canvas/math/useVectorDiagnostics'
import { THEME, pinkAlpha, whiteAlpha } from '@lib/theme'

// ─── Design Tokens ────────────────────────────────────────────────────────────
// 2026-08-01: base pink/background sourced from @lib/theme instead of a
// third independent hardcoded copy. `magenta`/`offline` stay local — they're
// this sidebar's own status-specific accents (anomaly / socket-offline),
// not part of the shared base palette reused elsewhere.

// Exported so theme.contrast.test.ts can check these exact values (the
// real ones every render uses), not a hand-copied duplicate that could
// silently drift from what's actually in use.
export const COLORS = {
  bg: THEME.bg,
  pink: THEME.pink,
  magenta: '#ff00ff',
  offline: '#ff0055',
  pinkDim: THEME.pinkDim,
  pinkBorder: THEME.pinkBorder,
  pinkText: pinkAlpha(0.6),
  white10: whiteAlpha(0.06),
  white20: whiteAlpha(0.12),
  textPrimary: whiteAlpha(0.88),
  // 2026-08-28: was whiteAlpha(0.38) — measured 3.51:1 against #0a0a0d,
  // under WCAG AA's 4.5:1 floor for normal text, despite being real body
  // text here (frame-metadata values, connectivity/LLM status labels),
  // not decorative. 0.47 clears it at 4.82:1 — see
  // theme.contrast.test.ts.
  textMuted: whiteAlpha(0.47),
  divider: pinkAlpha(0.08),
} as const

const MONO_FONT = "'Courier New', Courier, monospace"

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DiagnosticSidebarProps {
  streamState: StreamState
  activeFrame: VectorFrame | null
  isLive: boolean
  llmStatus?: LlmStatus
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Visual connectivity state dot with context-aware color and pulse animation.
 * `role="status"` (2026-08-28 sprint) announces label changes (disconnect/
 * reconnect, anomaly detected) to screen-reader users, who otherwise had
 * no signal at all that this text had changed.
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
      role="status"
      aria-live="polite"
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
 * `llm` availability indicator, next to the `stream` connectivity dot.
 * Reflects a coarse-grained backend healthcheck (startup + real-usage
 * outcomes) — never polled per-frame, see useVectorDiagnostics.ts.
 */
const LlmIndicator: React.FC<{ llmStatus: LlmStatus }> = ({ llmStatus }) => {
  const dotColor = llmStatus === 'offline' ? COLORS.offline : COLORS.pink
  const label =
    llmStatus === 'ready'
      ? 'llm · ready'
      : llmStatus === 'offline'
        ? 'llm · offline · fallback narratives'
        : 'llm · checking…'

  return (
    <div
      id="iye-llm-indicator"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 0 20px 0',
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor,
          opacity: llmStatus === 'unknown' ? 0.4 : 1,
          boxShadow: llmStatus === 'unknown' ? 'none' : `0 0 10px ${dotColor}, 0 0 4px ${dotColor}`,
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

// ─── Plain-English frame summary (2026-08-30 sprint, Finding 4) ──────────────
// window_fill/z_max/velocity/acceleration/drift_slope/cluster-shorthand are
// raw technical outputs with zero interpretation for a non-technical viewer
// — "there should be an explaining layer for people so everyone
// understands" (Alina). Deterministic and template-based on purpose: always
// available the instant a frame arrives, with no dependency on Ollama being
// up at all — unlike the LLM narrative in ExplanationBlock's "analysis"
// card below, which this is additive to, not a replacement for.

/** Short hover/glance explanation for each raw temporal-metric label in the
 *  grid below — a term like "drift_slope" means nothing on sight to a
 *  non-technical viewer. */
export const METRIC_TOOLTIPS: Record<'window_fill' | 'z_max' | 'velocity' | 'acceleration' | 'drift_slope', string> = {
  window_fill: 'How much recent history the detector has gathered so far — 100% means it has a full baseline to compare against.',
  z_max: 'How far the single most unusual point is from what counts as normal, in standard deviations.',
  velocity: 'How fast the overall pattern is changing from one frame to the next.',
  acceleration: 'Whether that rate of change is itself speeding up or slowing down.',
  drift_slope: 'The direction and steepness of a slow, sustained trend across recent frames, as opposed to a one-off blip.',
}

/** One or two plain-English sentences translating a frame's raw
 *  anomaly-count and temporal-regime numbers into something a non-technical
 *  viewer can understand at a glance, without needing to know what
 *  "z_max" or "drift_slope" mean. Pure and deterministic — never touches
 *  the network, so it's exactly as available as the numbers it explains. */
export function summarizeFrameForHumans(frame: VectorFrame): string {
  const anomalyCount = frame.anomaly_indices.length
  const pointClause =
    anomalyCount === 0
      ? 'No unusual points right now — every reading is within its normal range.'
      : anomalyCount === 1
        ? '1 point is unusual right now.'
        : `${String(anomalyCount)} points are unusual right now.`

  const temporal = frame.temporal
  let trendClause: string
  if (temporal.regime === 'warmup' || temporal.window_fill < 1) {
    trendClause = 'Still gathering enough history to judge the trend with confidence.'
  } else if (temporal.regime === 'spike') {
    trendClause = 'This looks like a sudden, sharp spike compared to recent frames.'
  } else if (temporal.regime === 'velocity') {
    trendClause = 'The pattern is moving noticeably faster than usual.'
  } else if (temporal.regime === 'acceleration') {
    trendClause = 'That speed of change is itself accelerating.'
  } else if (temporal.regime === 'drift') {
    trendClause = `The whole pattern has been gradually drifting ${temporal.drift_slope >= 0 ? 'upward' : 'downward'} over recent frames.`
  } else {
    trendClause = 'The pattern has been stable for the last several frames.'
  }

  return `${pointClause} ${trendClause}`
}

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
          color: COLORS.bg,
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

        <span style={{ color: COLORS.pinkText }} title={METRIC_TOOLTIPS.window_fill}>
          window_fill
        </span>
        <span>{(frame.temporal.window_fill * 100).toFixed(0)}%</span>

        <span style={{ color: COLORS.pinkText }} title={METRIC_TOOLTIPS.z_max}>
          z_max
        </span>
        <span>{frame.temporal.z_max.toFixed(2)}</span>

        <span style={{ color: COLORS.pinkText }} title={METRIC_TOOLTIPS.velocity}>
          velocity
        </span>
        <span>{frame.temporal.velocity.toFixed(2)}</span>

        <span style={{ color: COLORS.pinkText }} title={METRIC_TOOLTIPS.acceleration}>
          acceleration
        </span>
        <span>{frame.temporal.acceleration.toFixed(2)}</span>

        <span style={{ color: COLORS.pinkText }} title={METRIC_TOOLTIPS.drift_slope}>
          drift_slope
        </span>
        <span>{frame.temporal.drift_slope.toFixed(2)}</span>

        <span style={{ color: COLORS.pinkText }}>frame</span>
        <span style={{ fontSize: 8, opacity: 0.6 }}>{frame.frame_id.slice(0, 8)}</span>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const DiagnosticSidebar: React.FC<DiagnosticSidebarProps> = ({
  streamState,
  activeFrame,
  isLive,
  llmStatus = 'unknown',
}) => {
  return (
    <div
      id="iye-diagnostic-sidebar"
      style={{
        // Sizing (width, min/max clamp, border) is the parent panel's job —
        // see App.tsx's sidebar wrapper. This box only needs to fill that
        // parent and provide its own scroll region.
        width: '100%',
        flex: 1,
        minHeight: 0, // lets this flex child actually shrink to enable overflow-y:auto
        background: COLORS.bg,
        display: 'flex',
        flexDirection: 'column',
        padding: '32px 24px',
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
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
      <ConnectivityDot streamState={streamState} status={activeFrame?.status ?? null} />
      <LlmIndicator llmStatus={llmStatus} />

      {/* ── Active frame metadata ────────────────────────────────────── */}
      {activeFrame && <FrameMetadata frame={activeFrame} />}

      {/* ── Plain-English summary (2026-08-30 sprint, Finding 4) ─────────
          Deterministic, template-based, never dependent on the LLM being
          up — see summarizeFrameForHumans above. Distinct from "analysis"
          below, which is the LLM-generated narrative when one exists. */}
      {activeFrame && (
        <ExplanationBlock title="in plain terms" content={summarizeFrameForHumans(activeFrame)} />
      )}

      {/* ── Explainability text ──────────────────────────────────────── */}
      {activeFrame && (activeFrame.explanation !== null || activeFrame.status === 'ANOMALY') && (
        <ExplanationBlock title="analysis" content={activeFrame.explanation ?? 'analyzing…'} />
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
