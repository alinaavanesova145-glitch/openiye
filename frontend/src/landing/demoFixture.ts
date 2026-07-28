/**
 * demoFixture — self-contained sample dataset for the landing page's live
 * demo widget (2026-07-30 sprint).
 *
 * NOT live data and NOT a live LLM call — see docs/idealization_report.md,
 * 2026-07-30 sprint, for the full reasoning. This is bundled/static so the
 * demo works instantly on page load with zero network requests, per the
 * architectural constraint that the real backend is LAN-bound and must
 * never be exposed to public landing-page visitors.
 *
 * Scenario: three-sensor industrial equipment telemetry (temperature,
 * vibration, pressure) across two equipment lines, with three illustrative
 * fault signatures. Deliberately exactly 3 dimensions — the real pipeline's
 * reduce_to_3d treats <=3-feature data as a raw passthrough (no UMAP), so
 * x/y/z here are literal (client-side-normalized) sensor readings, the same
 * "axes_are_raw_features" case the real product's narrative grounding
 * already knows how to describe honestly. See DEMO_NARRATIVES below for
 * why the narrative text itself stays scoped to that same generic
 * axis-based phrasing rather than naming sensors by name — the real
 * /api/canvas/anomaly/explain endpoint doesn't thread column names into
 * its prompt today, and this demo does not overstate what the shipped
 * product actually says.
 */

export interface DemoPoint {
  index: number
  position: readonly [number, number, number]
  zScores: { x: number; y: number; z: number }
  clusterLabel: number
}

export const DEMO_DATASET_LABEL = 'Industrial Equipment Telemetry — Line A / Line B'
export const DEMO_AXIS_CAPTION = 'axes: temperature (x) · vibration (y) · pressure (z), sensor-normalized'

// ─── Nominal points — two equipment lines, tight normal-operation clusters ─────

const LINE_A_CLUSTER = 0
const LINE_B_CLUSTER = 1

const LINE_A_POINTS: DemoPoint[] = [
  { index: 0, position: [-0.95, -0.28, 0.42], zScores: { x: 0.31, y: 0.18, z: 0.24 }, clusterLabel: LINE_A_CLUSTER },
  { index: 1, position: [-1.08, -0.35, 0.5], zScores: { x: 0.42, y: 0.29, z: 0.35 }, clusterLabel: LINE_A_CLUSTER },
  { index: 2, position: [-0.82, -0.19, 0.31], zScores: { x: 0.2, y: 0.11, z: 0.15 }, clusterLabel: LINE_A_CLUSTER },
  { index: 3, position: [-0.99, -0.41, 0.47], zScores: { x: 0.35, y: 0.44, z: 0.28 }, clusterLabel: LINE_A_CLUSTER },
  { index: 4, position: [-1.02, -0.22, 0.36], zScores: { x: 0.38, y: 0.15, z: 0.2 }, clusterLabel: LINE_A_CLUSTER },
  { index: 5, position: [-0.88, -0.31, 0.55], zScores: { x: 0.24, y: 0.26, z: 0.46 }, clusterLabel: LINE_A_CLUSTER },
  { index: 6, position: [-1.12, -0.27, 0.39], zScores: { x: 0.51, y: 0.21, z: 0.19 }, clusterLabel: LINE_A_CLUSTER },
  { index: 7, position: [-0.91, -0.44, 0.43], zScores: { x: 0.28, y: 0.5, z: 0.25 }, clusterLabel: LINE_A_CLUSTER },
  { index: 8, position: [-0.97, -0.16, 0.33], zScores: { x: 0.33, y: 0.08, z: 0.17 }, clusterLabel: LINE_A_CLUSTER },
  { index: 9, position: [-1.05, -0.33, 0.48], zScores: { x: 0.45, y: 0.31, z: 0.31 }, clusterLabel: LINE_A_CLUSTER },
  { index: 10, position: [-0.86, -0.25, 0.4], zScores: { x: 0.22, y: 0.19, z: 0.23 }, clusterLabel: LINE_A_CLUSTER },
  { index: 11, position: [-1.0, -0.3, 0.44], zScores: { x: 0.37, y: 0.24, z: 0.27 }, clusterLabel: LINE_A_CLUSTER },
]

const LINE_B_POINTS: DemoPoint[] = [
  { index: 12, position: [0.84, 0.52, -0.28], zScores: { x: 0.27, y: 0.33, z: 0.21 }, clusterLabel: LINE_B_CLUSTER },
  { index: 13, position: [0.91, 0.46, -0.34], zScores: { x: 0.39, y: 0.22, z: 0.32 }, clusterLabel: LINE_B_CLUSTER },
  { index: 14, position: [0.76, 0.58, -0.22], zScores: { x: 0.18, y: 0.41, z: 0.14 }, clusterLabel: LINE_B_CLUSTER },
  { index: 15, position: [0.88, 0.49, -0.31], zScores: { x: 0.34, y: 0.28, z: 0.26 }, clusterLabel: LINE_B_CLUSTER },
  { index: 16, position: [0.95, 0.61, -0.25], zScores: { x: 0.47, y: 0.48, z: 0.18 }, clusterLabel: LINE_B_CLUSTER },
  { index: 17, position: [0.79, 0.44, -0.36], zScores: { x: 0.21, y: 0.19, z: 0.36 }, clusterLabel: LINE_B_CLUSTER },
  { index: 18, position: [0.86, 0.55, -0.29], zScores: { x: 0.3, y: 0.37, z: 0.22 }, clusterLabel: LINE_B_CLUSTER },
  { index: 19, position: [0.93, 0.41, -0.23], zScores: { x: 0.43, y: 0.14, z: 0.15 }, clusterLabel: LINE_B_CLUSTER },
  { index: 20, position: [0.81, 0.53, -0.33], zScores: { x: 0.24, y: 0.35, z: 0.29 }, clusterLabel: LINE_B_CLUSTER },
  { index: 21, position: [0.9, 0.48, -0.27], zScores: { x: 0.36, y: 0.25, z: 0.2 }, clusterLabel: LINE_B_CLUSTER },
  { index: 22, position: [0.77, 0.5, -0.31], zScores: { x: 0.19, y: 0.3, z: 0.26 }, clusterLabel: LINE_B_CLUSTER },
  { index: 23, position: [0.87, 0.57, -0.24], zScores: { x: 0.32, y: 0.4, z: 0.16 }, clusterLabel: LINE_B_CLUSTER },
]

// ─── Anomalies — three distinct, illustrative fault signatures ────────────────

const ANOMALY_POINTS: DemoPoint[] = [
  {
    index: 24,
    position: [2.65, 2.05, 0.48],
    zScores: { x: 4.35, y: 3.82, z: 0.61 },
    clusterLabel: -1,
  },
  {
    index: 25,
    position: [0.28, -0.18, 3.15],
    zScores: { x: 0.52, y: 0.44, z: 4.61 },
    clusterLabel: -1,
  },
  {
    index: 26,
    position: [-2.75, -2.35, -2.05],
    zScores: { x: 3.94, y: 3.58, z: 3.41 },
    clusterLabel: -1,
  },
]

export const DEMO_POINTS: DemoPoint[] = [...LINE_A_POINTS, ...LINE_B_POINTS, ...ANOMALY_POINTS]

export const DEMO_ANOMALY_INDICES: number[] = ANOMALY_POINTS.map((p) => p.index)

// ─── Pre-generated narratives ───────────────────────────────────────────────────
// Written to match the real /api/canvas/anomaly/explain endpoint's actual
// grounding scope: dominant deviating axis + magnitude + cluster/noise
// status. Deliberately generic about *which* axis ("the x-axis", not
// "temperature") because the real endpoint doesn't thread column names
// into its prompt yet — this demo does not claim a capability the shipped
// product doesn't have. See DEMO_AXIS_CAPTION above for how axis meaning
// is conveyed honestly, as plain UI copy rather than attributed AI text.

export const DEMO_NARRATIVES: Record<number, string> = {
  24: 'Deviates most on the x-axis (a raw measured feature), peak |z|=4.35σ, with a strong secondary elevation on the y-axis (|z|=3.82). Joint deviation across two axes at this magnitude is consistent with a developing mechanical fault rather than routine variance — this point is flagged as noise (not part of any dense cluster), typical of an isolated equipment issue rather than a shift affecting the whole fleet.',
  25: 'Deviates most on the z-axis (a raw measured feature), peak |z|=4.61σ, while the other two axes remain within nominal range. A single-axis spike this far outside normal bounds, with no other reading affected, points to a localized event on that one measurement channel — this point is flagged as noise (not part of any dense cluster).',
  26: 'Deviates on all three axes simultaneously (peak |z|=3.94σ on the x-axis), a broad, low-magnitude-per-axis-but-multi-axis pattern distinct from the other two flagged points. This kind of uniform deviation across every measured dimension is often a sign the unit is reporting from an unexpected operating state rather than a single failing component — this point is flagged as noise (not part of any dense cluster).',
}
