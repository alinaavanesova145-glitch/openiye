/**
 * useVectorStream — Persistent WebSocket hook for live IYE vector frame streaming
 * with automated multi-port fallbacks to handle macOS host conflicts.
 *
 * Connects directly to the explicit local backend pipeline instance at ws://127.0.0.1:8050/stream.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export type StreamState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface VectorCoordinate3D {
  x: number
  y: number
  z: number
}

/**
 * Regime classification produced by the backend's stateful sliding-window
 * detector (temporal_engine.SlidingWindowDetector). "warmup" covers frames
 * emitted before the window has filled and before any temporal data exists.
 */
export type Regime =
  | 'warmup' | 'stable' | 'spike' | 'velocity' | 'acceleration' | 'drift'

export interface TemporalMetrics {
  z_max: number
  z_per_dim: number[]
  velocity: number
  acceleration: number
  drift_slope: number
  composite: number
  composite_smoothed: number
  regime: Regime
  window_fill: number   // 0..1
  dominant_dim: number
}

/** Neutral placeholder used until the backend's temporal engine ships real data. */
export const DEFAULT_TEMPORAL_METRICS: TemporalMetrics = {
  z_max: 0,
  z_per_dim: [],
  velocity: 0,
  acceleration: 0,
  drift_slope: 0,
  composite: 0,
  composite_smoothed: 0,
  regime: 'warmup',
  window_fill: 0,
  dominant_dim: -1,
}

export const HOT_REGIMES: ReadonlySet<Regime> = new Set(['spike', 'velocity', 'acceleration', 'drift'])

export interface VectorFrame {
  frame_id: string
  id: string
  timestamp: string
  status: 'NOMINAL' | 'ANOMALY'
  point_count: number
  coordinates: VectorCoordinate3D[]
  cluster_labels: number[]
  anomaly_indices: number[]
  explanation: string | null
  axis_mapping: Record<string, number> | null
  temporal: TemporalMetrics
}

export interface NarrativeHistoryEntry {
  id: string
  explanation: string
}

export interface StreamConfig {
  axisMapping?: Record<string, number>
}

export interface VectorStreamResult {
  streamState: StreamState
  liveFrame: VectorFrame | null
  positions: Float32Array
  anomalyIndices: number[]
  configureStream: (config: StreamConfig) => void
  activePort: number
  /**
   * Latest temporal metrics, updated by direct mutation (no re-render).
   * Read this inside useFrame for beacon pulse animation — subscribing to
   * `liveFrame.temporal` instead would re-render the whole canvas tree on
   * every tick.
   */
  temporalRef: MutableRefObject<TemporalMetrics>
  /** Narrative texts that arrived after the frame they explained was replaced. */
  narrativeHistory: NarrativeHistoryEntry[]
}

// ─── Temporal payload validation ──────────────────────────────────────────────

function parseTemporalMetrics(raw: unknown): TemporalMetrics {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_TEMPORAL_METRICS
  const t = raw as Record<string, unknown>

  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)
  const regimeCandidates: Regime[] = ['warmup', 'stable', 'spike', 'velocity', 'acceleration', 'drift']
  const regime = regimeCandidates.includes(t.regime as Regime) ? (t.regime as Regime) : 'warmup'

  return {
    z_max: num(t.z_max, 0),
    z_per_dim: Array.isArray(t.z_per_dim) ? (t.z_per_dim as unknown[]).filter((v): v is number => typeof v === 'number') : [],
    velocity: num(t.velocity, 0),
    acceleration: num(t.acceleration, 0),
    drift_slope: num(t.drift_slope, 0),
    composite: num(t.composite, 0),
    composite_smoothed: num(t.composite_smoothed, 0),
    regime,
    window_fill: num(t.window_fill, 0),
    dominant_dim: num(t.dominant_dim, -1),
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PORTS = [8050, 8000, 8222]
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
const JITTER_FACTOR = 0.3

// ─── Validation & Parsing ─────────────────────────────────────────────────────

function parseInboundPayload(data: unknown): { coordinates: number[]; anomalyIndices: number[] } {
  const result = { coordinates: [] as number[], anomalyIndices: [] as number[] }
  if (!data) return result

  if (Array.isArray(data)) {
    if (data.length > 0 && Array.isArray(data[0])) {
      const nested = data as unknown[][]
      for (const item of nested) {
        if (Array.isArray(item)) {
          for (const val of item) {
            if (typeof val === 'number') {
              result.coordinates.push(val)
            }
          }
        }
      }
    } else {
      const flat = data as unknown[]
      for (const val of flat) {
        if (typeof val === 'number') {
          result.coordinates.push(val)
        }
      }
    }
    return result
  }

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>

    if (Array.isArray(obj.anomaly_indices)) {
      const indices = obj.anomaly_indices as unknown[]
      for (const idx of indices) {
        if (typeof idx === 'number') {
          result.anomalyIndices.push(idx)
        }
      }
    }

    if (Array.isArray(obj.coordinates)) {
      const coords = obj.coordinates as unknown[]
      for (const item of coords) {
        if (Array.isArray(item)) {
          for (const val of item) {
            if (typeof val === 'number') {
              result.coordinates.push(val)
            }
          }
        } else if (typeof item === 'object' && item !== null) {
          const pt = item as Record<string, unknown>
          if (typeof pt.x === 'number' && typeof pt.y === 'number' && typeof pt.z === 'number') {
            result.coordinates.push(pt.x, pt.y, pt.z)
          }
        }
      }
      return result
    }

    if (Array.isArray(obj.points)) {
      const pts = obj.points as unknown[]
      for (const item of pts) {
        if (Array.isArray(item)) {
          for (const val of item) {
            if (typeof val === 'number') {
              result.coordinates.push(val)
            }
          }
        } else if (typeof item === 'number') {
          result.coordinates.push(item)
        }
      }
      return result
    }

    if (Array.isArray(obj.vectors)) {
      const vecs = obj.vectors as unknown[]
      for (const item of vecs) {
        if (typeof item === 'object' && item !== null) {
          const vt = item as Record<string, unknown>
          if (typeof vt.x === 'number' && typeof vt.y === 'number' && typeof vt.z === 'number') {
            result.coordinates.push(vt.x, vt.y, vt.z)
          }
        }
      }
      return result
    }
  }

  return result
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const NARRATIVE_HISTORY_LIMIT = 20

export function useVectorStream(): VectorStreamResult {
  const [streamState, setStreamState] = useState<StreamState>('disconnected')
  const [liveFrame, setLiveFrame] = useState<VectorFrame | null>(null)
  const [positions, setPositions] = useState<Float32Array>(() => new Float32Array(0))
  const [anomalyIndices, setAnomalyIndices] = useState<number[]>([])
  const [activePort, setActivePort] = useState<number>(PORTS[0])
  const [narrativeHistory, setNarrativeHistory] = useState<NarrativeHistoryEntry[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backoffRef = useRef<number>(0)
  const mountedRef = useRef<boolean>(true)

  const wasConnectedRef = useRef<boolean>(false)

  // Mutated directly on every "frame" message — read from useFrame for beacon
  // pulse animation so temporal ticks never trigger a canvas re-render.
  const temporalRef = useRef<TemporalMetrics>(DEFAULT_TEMPORAL_METRICS)

  // ── Connection logic ────────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onmessage = null
      wsRef.current.onerror = null
      wsRef.current.onclose = null
      if (wsRef.current.readyState < WebSocket.CLOSING) {
        wsRef.current.close()
      }
    }

    setStreamState('connecting')

    // Bypassing proxy definitions: pointing directly to the known running FastAPI layer
    const wsUrl = "ws://127.0.0.1:8050/stream"

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mountedRef.current) return
        setStreamState('connected')
        wasConnectedRef.current = true
        backoffRef.current = 0
        setActivePort(8050)
      }

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return
        try {
          // Unpack outer JSON framing layer
          let parsed: unknown = JSON.parse(String(event.data))

          // Defend against a double-serialized payload (still a raw string after one decode)
          if (typeof parsed === 'string') {
            parsed = JSON.parse(parsed)
          }

          if (typeof parsed === 'object' && parsed !== null && 'type' in (parsed as Record<string, unknown>)) {
            const msg = parsed as Record<string, unknown>

            // ── Narrative message: async LLaMA/Ollama explanation for an anomaly frame ──
            if (msg.type === 'narrative') {
              const narrId = typeof msg.id === 'string' ? msg.id : null
              const narrText = typeof msg.explanation === 'string' ? msg.explanation : ''

              let matchedCurrentFrame = false
              setLiveFrame((prev) => {
                if (prev && narrId !== null && prev.id === narrId) {
                  matchedCurrentFrame = true
                  return { ...prev, explanation: narrText }
                }
                return prev
              })

              // A newer frame may have already replaced the one this narrative explains —
              // never drop it silently, surface it in the terminal's history instead.
              if (!matchedCurrentFrame) {
                setNarrativeHistory((prev) => [
                  ...prev.slice(-(NARRATIVE_HISTORY_LIMIT - 1)),
                  { id: narrId ?? 'unknown', explanation: narrText },
                ])
              }
              return
            }

            // ── Frame message: stateful temporal detector output + spatial coordinates ──
            if (msg.type === 'frame') {
              const { coordinates, anomalyIndices: parsedAnomalies } = parseInboundPayload(msg)
              if (coordinates.length === 0) return

              const posArray = new Float32Array(coordinates)
              setPositions(posArray)
              setAnomalyIndices(parsedAnomalies)

              const coordsObjects: VectorCoordinate3D[] = []
              for (let i = 0; i < coordinates.length / 3; i++) {
                coordsObjects.push({
                  x: coordinates[i * 3],
                  y: coordinates[i * 3 + 1],
                  z: coordinates[i * 3 + 2],
                })
              }

              const id = typeof msg.id === 'string' ? msg.id : Math.random().toString(36).substring(2, 15)
              const status = msg.status === 'ANOMALY' ? 'ANOMALY' : 'NOMINAL'
              const temporal = parseTemporalMetrics(msg.temporal)
              const explanation = typeof msg.explanation === 'string' ? msg.explanation : null

              // Mutate directly — no setState — so beacon pulse reads the latest
              // temporal signal every animation frame without re-rendering the canvas.
              temporalRef.current = temporal

              const frame: VectorFrame = {
                frame_id: id,
                id,
                timestamp: typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString(),
                status,
                point_count: coordsObjects.length,
                coordinates: coordsObjects,
                cluster_labels: Array.isArray(msg.cluster_labels) ? (msg.cluster_labels as number[]) : [],
                anomaly_indices: parsedAnomalies,
                explanation,
                axis_mapping: null,
                temporal,
              }
              setLiveFrame(frame)
              return
            }
          }

          // ── Legacy path: untyped payloads (pre-temporal-engine backend / fixtures) ──
          const { coordinates, anomalyIndices: parsedAnomalies } = parseInboundPayload(parsed)
          if (coordinates.length > 0) {
            const posArray = new Float32Array(coordinates)
            setPositions(posArray)
            setAnomalyIndices(parsedAnomalies)

            const coordsObjects: VectorCoordinate3D[] = []
            for (let i = 0; i < coordinates.length / 3; i++) {
              coordsObjects.push({
                x: coordinates[i * 3],
                y: coordinates[i * 3 + 1],
                z: coordinates[i * 3 + 2],
              })
            }

            const obj = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : {}

            const frameId = typeof obj.frame_id === 'string' ? obj.frame_id : Math.random().toString(36).substring(2, 15)
            const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString()
            const status = obj.status === 'ANOMALY' ? 'ANOMALY' : 'NOMINAL'

            temporalRef.current = DEFAULT_TEMPORAL_METRICS

            const synthesizedFrame: VectorFrame = {
              frame_id: frameId,
              id: frameId,
              timestamp,
              status,
              point_count: coordsObjects.length,
              coordinates: coordsObjects,
              cluster_labels: Array.isArray(obj.cluster_labels) ? (obj.cluster_labels as number[]) : [],
              anomaly_indices: parsedAnomalies,
              explanation: typeof obj.explanation === 'string' ? obj.explanation : null,
              axis_mapping: null,
              temporal: DEFAULT_TEMPORAL_METRICS,
            }
            setLiveFrame(synthesizedFrame)
          }
        } catch {
          // Drop malformed messages safely
        }
      }

      ws.onerror = () => {
        if (!mountedRef.current) return
        setStreamState('error')
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        setStreamState('disconnected')
        scheduleReconnect()
      }
    } catch (err) {
      scheduleReconnect()
    }
  }, [])

  // ── Exponential backoff reconnection ────────────────────────────────────

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return

    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
    }

    const attempt = backoffRef.current
    const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS)
    const jitter = delay * JITTER_FACTOR * (Math.random() * 2 - 1)
    const actualDelay = Math.max(0, delay + jitter)

    backoffRef.current = attempt + 1

    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        connect()
      }
    }, actualDelay)
  }, [connect])

  // ── Configure stream (send axis remapping to server) ────────────────────

  const configureStream = useCallback((config: StreamConfig) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({ type: 'configure', ...config })
      ws.send(message)
    }
  }, [])

  // ── Lifecycle ───────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false

      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      const ws = wsRef.current
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        if (ws.readyState < WebSocket.CLOSING) {
          ws.close()
        }
        wsRef.current = null
      }
    }
  }, [connect])

  return {
    streamState,
    liveFrame,
    positions,
    anomalyIndices,
    configureStream,
    activePort,
    temporalRef,
    narrativeHistory,
  }
}