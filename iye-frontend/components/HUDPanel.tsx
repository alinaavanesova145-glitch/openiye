'use client';

/**
 * iye-frontend/components/HUDPanel.tsx
 * ─────────────────────────────────────
 * Floating semi-transparent telemetry overlay.
 *
 * Typography contract: all user-visible strings are strictly lowercase.
 *
 * Displays:
 *   • active vectors count
 *   • current renderer tier
 *   • stream status (live / mock / healed)
 *   • last update timestamp
 *
 * Floating action button triggers useMCPTool('field_stats').invoke()
 * with the current frame's vector set, showing how external agents
 * interact with the IYE engine.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Activity,
  Cpu,
  Radio,
  BarChart3,
  ChevronUp,
  ChevronDown,
  Loader,
  AlertTriangle,
  CheckCircle2,
  Zap,
} from 'lucide-react';
import { useMCPTool, FieldStatsResult } from '../hooks/useMCPTool';
import { FieldFrame } from '../hooks/useVectorField';
import { RendererTier } from './VectorCanvas';

// ── Design tokens ─────────────────────────────────────────────────────────────

const HUD_BG     = 'rgba(0, 0, 0, 0.6)';
const HUD_BORDER = 'rgba(232, 197, 200, 0.12)';
const BLUSH      = '#e8c5c8';
const CORAL      = '#ff2a6d';
const SLATE      = '#8898AA';
const DIM        = '#445566';

// ── Sub-components ────────────────────────────────────────────────────────────

function TelemetryRow({
  icon: Icon,
  label,
  value,
  valueColor = BLUSH,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; color?: string }>;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="flex items-center gap-2" style={{ color: SLATE }}>
        <Icon size={12} strokeWidth={1.5} color={SLATE} />
        <span style={{ fontSize: 11, letterSpacing: '0.08em', color: SLATE }}>
          {label}
        </span>
      </div>
      <span
        style={{
          fontSize:      11,
          fontFamily:    'ui-monospace, monospace',
          letterSpacing: '0.06em',
          color:         valueColor,
          fontWeight:    500,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StatBlock({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      className="flex flex-col gap-0.5 px-3 py-2 rounded"
      style={{ background: 'rgba(232, 197, 200, 0.06)', border: `1px solid ${HUD_BORDER}` }}
    >
      <span style={{ fontSize: 9, color: DIM, letterSpacing: '0.1em', textTransform: 'lowercase' }}>
        {label}
      </span>
      <span style={{ fontSize: 12, color: BLUSH, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>
        {typeof value === 'number' ? value.toFixed(4) : value}
      </span>
    </div>
  );
}

// ── Tier badge ────────────────────────────────────────────────────────────────

const TIER_LABELS: Record<RendererTier, string> = {
  webgpu:     'webgpu  ★',
  webgl2:     'webgl2',
  webgl1:     'webgl1  ⚠',
  detecting:  'detecting…',
};

const TIER_COLORS: Record<RendererTier, string> = {
  webgpu:    BLUSH,
  webgl2:    BLUSH,
  webgl1:    CORAL,
  detecting: SLATE,
};

// ── Main component ────────────────────────────────────────────────────────────

interface HUDPanelProps {
  frame:         FieldFrame | null;
  rendererTier:  RendererTier;
  streamStatus:  'connecting' | 'live' | 'healed' | 'mock';
}

export default function HUDPanel({
  frame,
  rendererTier,
  streamStatus,
}: HUDPanelProps) {
  const [collapsed,    setCollapsed]    = useState(false);
  const [statsVisible, setStatsVisible] = useState(false);
  const mountedRef = useRef(true);

  // Consume our exact custom useMCPTool state structure
  const { invokeTool, toolResult, isLoading: statsLoading, toolError: statsError } = useMCPTool<FieldStatsResult>();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Derive display values
  const activeVectors = frame?.vectors?.length ?? 0;
  
  // Format stream status description
  const isHealed = frame && (frame.status === 'healed' || streamStatus === 'healed');
  
  let streamStatusLabel = 'connecting…';
  if (!frame) {
    streamStatusLabel = 'awaiting stream';
  } else {
    if (isHealed) {
      streamStatusLabel = 'healed';
    } else if (streamStatus === 'live') {
      streamStatusLabel = 'nominal — live';
    } else if (streamStatus === 'mock') {
      streamStatusLabel = 'nominal — mock';
    }
  }

  const statusColor =
    !frame      ? DIM   :
    isHealed    ? CORAL :
    streamStatus === 'live' ? BLUSH : CORAL;

  const lastUpdated = frame
    ? new Date(frame.timestamp).toLocaleTimeString('en-US', {
        hour12:      false,
        hour:        '2-digit',
        minute:      '2-digit',
        second:      '2-digit',
      })
    : '—';

  // ── MCP tool invocation ─────────────────────────────────────────────────
  const handleFieldStats = useCallback(async () => {
    if (!frame?.vectors?.length) return;

    // Take up to 64 vectors to keep payload lean, flat pack [ox, oy, oz, vx, vy, vz]
    const sample = frame.vectors.slice(0, 64).map(v => [
      ...v.origin,
      ...v.direction
    ]);

    // Send payload under the 'field' parameter key conforming to exact custom hook API
    await invokeTool({ field: sample });

    if (mountedRef.current) {
      setStatsVisible(true);
    }
  }, [frame, invokeTool]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Main HUD panel ─────────────────────────────────────────────── */}
      <div
        className="absolute top-4 right-4 flex flex-col animate-fade-in hud-panel-blush"
        style={{
          width:          260,
          borderRadius:   12,
          boxShadow:      '0 8px 32px rgba(0,0,0,0.45)',
          overflow:       'hidden',
          zIndex:         10,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
          style={{ borderBottom: collapsed ? 'none' : `1px solid ${HUD_BORDER}` }}
          onClick={() => setCollapsed((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <Zap size={13} color={BLUSH} strokeWidth={1.8} />
            <span style={{ fontSize: 11, color: BLUSH, letterSpacing: '0.14em', fontWeight: 600 }}>
              iye telemetry
            </span>
          </div>
          {collapsed
            ? <ChevronDown size={13} color={DIM} />
            : <ChevronUp   size={13} color={DIM} />}
        </div>

        {/* Body */}
        {!collapsed && (
          <div className="flex flex-col px-4 py-3 gap-0.5">
            <TelemetryRow
              icon={Activity}
              label="active vectors"
              value={activeVectors.toLocaleString()}
            />
            <TelemetryRow
              icon={Cpu}
              label="renderer tier"
              value={TIER_LABELS[rendererTier]}
              valueColor={TIER_COLORS[rendererTier]}
            />
            <TelemetryRow
              icon={Radio}
              label="stream status"
              value={streamStatusLabel}
              valueColor={statusColor}
            />
            <TelemetryRow
              icon={Activity}
              label="last frame"
              value={lastUpdated}
              valueColor={SLATE}
            />

            {/* Divider */}
            <div style={{ height: 1, background: HUD_BORDER, margin: '8px 0' }} />

            {/* MCP action button */}
            <button
              onClick={handleFieldStats}
              disabled={statsLoading || !frame}
              className="flex items-center justify-center gap-2 w-full py-2 rounded-lg transition-all"
              style={{
                background:    statsLoading
                  ? 'rgba(232, 197, 200, 0.08)'
                  : 'rgba(232, 197, 200, 0.14)',
                border:        `1px solid ${statsLoading ? DIM : BLUSH}40`,
                cursor:        statsLoading || !frame ? 'not-allowed' : 'pointer',
                color:         statsLoading ? SLATE : BLUSH,
                fontSize:      11,
                letterSpacing: '0.1em',
                fontWeight:    500,
                outline:       'none',
              }}
            >
              {statsLoading ? (
                <>
                  <Loader size={11} strokeWidth={2} color={SLATE} className="animate-spin" />
                  computing…
                </>
              ) : (
                <>
                  <BarChart3 size={11} strokeWidth={1.8} color={BLUSH} />
                  run field_stats
                </>
              )}
            </button>

            {/* Error state */}
            {statsError && (
              <div
                className="flex items-center gap-2 mt-2 px-2 py-1.5 rounded"
                style={{ background: 'rgba(255, 42, 109, 0.10)', border: '1px solid rgba(255, 42, 109, 0.25)' }}
              >
                <AlertTriangle size={10} color={CORAL} />
                <span style={{ fontSize: 10, color: CORAL, letterSpacing: '0.06em' }}>
                  {statsError.slice(0, 60)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Stats result panel ──────────────────────────────────────────── */}
      {statsVisible && toolResult && (
        <div
          className="absolute top-4 left-4 flex flex-col animate-fade-in hud-panel-blush"
          style={{
            width:          280,
            borderRadius:   12,
            boxShadow:      '0 8px 32px rgba(0,0,0,0.45)',
            overflow:       'hidden',
            zIndex:         10,
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: `1px solid ${HUD_BORDER}` }}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 size={12} color={BLUSH} strokeWidth={1.8} />
              <span style={{ fontSize: 11, color: BLUSH, letterSpacing: '0.14em', fontWeight: 600 }}>
                field_stats result
              </span>
            </div>
            <button
              onClick={() => setStatsVisible(false)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: DIM, fontSize: 14, lineHeight: 1, padding: '0 2px',
              }}
            >
              ×
            </button>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-2 p-4">
            <StatBlock label="num vectors"    value={toolResult.num_vectors} />
            <StatBlock label="mean magnitude" value={toolResult.mean_magnitude} />
            <StatBlock label="max magnitude"  value={toolResult.max_magnitude} />
            <StatBlock label="centroid x"     value={toolResult.centroid_x} />
            <StatBlock label="centroid y"     value={toolResult.centroid_y} />
            <StatBlock label="centroid z"     value={toolResult.centroid_z} />
          </div>

          {/* Bounds row */}
          <div
            className="flex gap-2 px-4 pb-4 justify-between"
            style={{ fontSize: 10, color: DIM, fontFamily: 'ui-monospace, monospace', letterSpacing: '0.06em' }}
          >
            <span>x [{toolResult.min_x.toFixed(3)}, {toolResult.max_x.toFixed(3)}]</span>
            <span>·</span>
            <span>y [{toolResult.min_y.toFixed(3)}, {toolResult.max_y.toFixed(3)}]</span>
          </div>
        </div>
      )}

      {/* ── IYE wordmark ────────────────────────────────────────────────── */}
      <div
        className="absolute bottom-4 right-4"
        style={{
          fontSize:      10,
          letterSpacing: '0.3em',
          color:         DIM,
          userSelect:    'none',
          fontWeight:    300,
        }}
      >
        iye systems
      </div>
    </>
  );
}
