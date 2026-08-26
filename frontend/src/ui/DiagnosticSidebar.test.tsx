import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { VectorFrame } from '@canvas/math/useVectorStream'
import { DiagnosticSidebar } from './DiagnosticSidebar'

function makeFrame(overrides: Partial<VectorFrame> = {}): VectorFrame {
  return {
    frame_id: 'abcdef1234567890',
    id: 'abcdef1234567890',
    timestamp: new Date().toISOString(),
    status: 'NOMINAL',
    point_count: 16,
    coordinates: [],
    cluster_labels: [0, 0, -1],
    anomaly_indices: [],
    explanation: 'all nominal',
    axis_mapping: null,
    temporal: {
      z_max: 1.8888,
      z_per_dim: [],
      velocity: 0.1234,
      acceleration: 0,
      drift_slope: 2.71828,
      composite: 0,
      composite_smoothed: 0,
      regime: 'stable',
      window_fill: 0.75,
      dominant_dim: -1,
    },
    point_z_scores: [],
    axes_are_raw_features: true,
    point_feature_attributions: [],
    ...overrides,
  }
}

describe('DiagnosticSidebar', () => {
  it('renders window_fill, z_max, velocity, acceleration, and drift_slope with the expected formatting', () => {
    render(
      <DiagnosticSidebar
        streamState="connected"
        activeFrame={makeFrame({
          temporal: {
            z_max: 1.8888,
            z_per_dim: [],
            velocity: 0.1234,
            acceleration: -0.4567,
            drift_slope: 2.71828,
            composite: 0,
            composite_smoothed: 0,
            regime: 'stable',
            window_fill: 0.75,
            dominant_dim: -1,
          },
        })}
        isLive
      />,
    )

    expect(screen.getByText('75%')).toBeInTheDocument() // window_fill * 100, 0 decimals
    expect(screen.getByText('1.89')).toBeInTheDocument() // z_max, 2 decimals
    expect(screen.getByText('0.12')).toBeInTheDocument() // velocity, 2 decimals
    expect(screen.getByText('-0.46')).toBeInTheDocument() // acceleration, 2 decimals (signed)
    expect(screen.getByText('2.72')).toBeInTheDocument() // drift_slope, 2 decimals
  })

  it('shows an "analyzing…" placeholder for an ANOMALY frame with a null explanation', () => {
    render(
      <DiagnosticSidebar
        streamState="connected"
        activeFrame={makeFrame({ status: 'ANOMALY', explanation: null })}
        isLive
      />,
    )
    expect(screen.getByText('analyzing…')).toBeInTheDocument()
  })

  it('renders no analysis block for a NOMINAL frame with a null explanation', () => {
    render(
      <DiagnosticSidebar
        streamState="connected"
        activeFrame={makeFrame({ explanation: null })}
        isLive
      />,
    )
    expect(screen.queryByText('analyzing…')).not.toBeInTheDocument()
  })

  it('renders the pre-connection state without an active frame', () => {
    render(<DiagnosticSidebar streamState="connecting" activeFrame={null} isLive={false} />)
    expect(screen.getByText('connecting...')).toBeInTheDocument()
  })

  it('reflects offline status when the stream is disconnected', () => {
    render(<DiagnosticSidebar streamState="disconnected" activeFrame={null} isLive={false} />)
    expect(screen.getByText('stream · offline')).toBeInTheDocument()
  })

  it('defaults the llm indicator to "checking…" when llmStatus is omitted', () => {
    render(<DiagnosticSidebar streamState="connected" activeFrame={null} isLive={false} />)
    expect(screen.getByText('llm · checking…')).toBeInTheDocument()
  })

  it('shows "llm · ready" when the backend healthcheck reports ready', () => {
    render(
      <DiagnosticSidebar streamState="connected" activeFrame={null} isLive={false} llmStatus="ready" />,
    )
    expect(screen.getByText('llm · ready')).toBeInTheDocument()
  })

  it('shows the fallback-narratives message when Ollama is offline', () => {
    render(
      <DiagnosticSidebar
        streamState="connected"
        activeFrame={null}
        isLive={false}
        llmStatus="offline"
      />,
    )
    expect(screen.getByText('llm · offline · fallback narratives')).toBeInTheDocument()
  })

  // NEW 2026-08-28 — neither indicator announced its own changes to
  // screen-reader users (a disconnect, a reconnect, an anomaly) before
  // this sprint added role="status" to both.
  it('the connectivity and llm indicators are both live regions (role="status")', () => {
    render(
      <DiagnosticSidebar
        streamState="connected"
        activeFrame={null}
        isLive={false}
        llmStatus="ready"
      />,
    )
    const statusRegions = screen.getAllByRole('status')
    const ids = statusRegions.map((el) => el.id)
    expect(ids).toContain('iye-connectivity-indicator')
    expect(ids).toContain('iye-llm-indicator')
  })
})
