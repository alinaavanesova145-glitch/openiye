/**
 * theme — canonical IYE color tokens (2026-08-01 sprint).
 *
 * Before this sprint, the same pitch-black/blush-pink palette was
 * hand-rolled independently in four places (App.tsx, VectorViewport.tsx,
 * DiagnosticSidebar.tsx, DataSourcePanel.tsx) plus a fifth, slightly
 * different version in landing.css's own `:root` block — each free to
 * drift from the others with no signal when it did. This module is now
 * the single source of truth for anything needing a real color VALUE in
 * JS/TSX.
 *
 * react-three-fiber material props (`<meshBasicMaterial color={...}>`)
 * cannot resolve CSS custom properties — Three.js's color parser never
 * touches the DOM's CSS cascade, so `VectorViewport.tsx`'s beacon/hull/
 * tracer colors need an actual hex string here, not `var(--iye-pink)`.
 * That's why this is a plain TS module and not just CSS custom
 * properties: it has to work in both worlds.
 *
 * `frontend/src/index.css`'s `:root` custom properties hold the exact
 * same literal values for plain-CSS contexts (landing.css, and
 * index.css's own global html/body/scrollbar rules) — kept in sync by
 * hand across the CSS/JS boundary (CSS can't import from TS), with
 * `theme.consistency.test.ts` asserting the two never drift apart.
 */

/** Pitch-black-with-depth, not pure #000 — WCAG-contrast-verified against
 *  --iye-pink at 11.97:1 (see docs/idealization_report.md, 2026-07-30
 *  sprint, for the full ratio table). Used everywhere a background used
 *  to be pure `#000000`. */
const BG = '#0a0a0d'
const BG_RAISED = '#111116'
const PINK_RGB = '255, 182, 193'
const PINK = '#ffb6c1'
const CYAN = '#5fd9e8'
/** Data-viz accents — semantically distinct from marketing/UI chrome
 *  (severity/anomaly signal color, tracer-line color), but still
 *  centralized here rather than re-hardcoded per file. */
const ANOMALY = '#ff2b3d'
const TRACER = '#7fd8e6'
const WHITE_RGB = '255, 255, 255'

/** `rgba(255, 182, 193, alpha)` without re-typing the RGB triplet at every
 *  call site — each UI surface still picks its own alpha for its own
 *  visual weight (a dim divider vs. a legible border are different
 *  design choices, not a value that should be forced to one number). */
export function pinkAlpha(alpha: number): string {
  return `rgba(${PINK_RGB}, ${alpha})`
}

/** `rgba(255, 255, 255, alpha)` — same rationale as pinkAlpha. */
export function whiteAlpha(alpha: number): string {
  return `rgba(${WHITE_RGB}, ${alpha})`
}

// ─── WCAG contrast (2026-08-28 sprint) ─────────────────────────────────────
// Two text colors (DataSourcePanel's old pinkText50, DiagnosticSidebar's
// and DataSourcePanel's old textMuted) turned out to measure under WCAG
// AA's 4.5:1 normal-text floor against this theme's #0a0a0d background —
// found by an audit, not eyeballed, and fixed the same way: a real
// relative-luminance calculation, not a guess. Exported so
// theme.contrast.test.ts can check the actual token values every UI
// surface uses, not a hand-copied duplicate number that could drift from
// what's really in use.

type RGB = readonly [number, number, number]

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** Parses `#rrggbb` or `rgba(r, g, b, a)` (the only two shapes this module
 *  ever produces) into an [r,g,b,a] tuple. Throws on anything else — a
 *  contrast check on a color shape this module doesn't produce is a bug in
 *  the caller, not something to silently approximate. */
function parseColor(color: string): readonly [number, number, number, number] {
  const hexMatch = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (hexMatch) {
    return [parseInt(hexMatch[1], 16), parseInt(hexMatch[2], 16), parseInt(hexMatch[3], 16), 1]
  }
  const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color)
  if (rgbaMatch) {
    return [
      Number(rgbaMatch[1]),
      Number(rgbaMatch[2]),
      Number(rgbaMatch[3]),
      rgbaMatch[4] === undefined ? 1 : Number(rgbaMatch[4]),
    ]
  }
  throw new Error(`contrastRatio: unrecognized color format "${color}"`)
}

/** Alpha-composites `fg` over the OPAQUE `bg`, then returns the WCAG 2.x
 *  contrast ratio between the result and `bg` — the real check for "is
 *  this legible," not a guess. `bg` must itself be fully opaque (every
 *  background this theme defines is). */
export function contrastRatio(fg: string, bg: string): number {
  const [br, bg_, bb, ba] = parseColor(bg)
  if (ba !== 1) throw new Error('contrastRatio: bg must be fully opaque')
  const [fr, fgc, fb, fa] = parseColor(fg)
  const composited: RGB = [
    fa * fr + (1 - fa) * br,
    fa * fgc + (1 - fa) * bg_,
    fa * fb + (1 - fa) * bb,
  ]
  const l1 = relativeLuminance(composited)
  const l2 = relativeLuminance([br, bg_, bb])
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export const THEME = {
  bg: BG,
  bgRaised: BG_RAISED,
  pink: PINK,
  cyan: CYAN,
  anomaly: ANOMALY,
  tracer: TRACER,
  // Genuinely shared across 3+ surfaces (landing.css, App.tsx,
  // DiagnosticSidebar.tsx) at the same alpha — promoted to named constants
  // so that agreement is explicit and enforced, not three independent
  // `pinkAlpha(0.22)` calls that happen to use the same number today.
  // Per-surface bespoke opacities (DataSourcePanel's 50/60/70% text tiers,
  // landing's own text/textMuted/textFaint hierarchy) intentionally stay
  // as direct pinkAlpha()/whiteAlpha() calls at their own call site — not
  // every opacity choice is meant to converge to one shared value.
  pinkDim: pinkAlpha(0.12),
  pinkBorder: pinkAlpha(0.22),
} as const
