/**
 * DataSourceState — explicit state machine for the DATA SOURCE panel.
 *
 * Replaces the old silent-failure path (see docs/idealization_report.md,
 * 2026-07-07 sprint, Phase 0) where a rejected/errored upload produced no
 * visible change at all. Every state below is renderable on its own.
 *
 * `offer` (added 2026-07-12 sprint, Phase 1b): a zero-numeric-columns file
 * with encodable categorical structure never auto-visualizes — IYE doesn't
 * fabricate geometry from pure-text data without consent. The user must
 * explicitly click through.
 */

import type { EncodingSummary } from './parseMatrix'
export type { EncodingSummary }

export type DataSourceState =
  | { status: 'idle' }
  | { status: 'parsing'; filename: string; progress?: number }
  | { status: 'rejected'; filename: string; reason: string }
  | {
      status: 'partial'
      filename: string
      rowCount: number
      dim: number
      totalColumns: number
      skippedFreeText: number
      droppedRows: number
      encoding: EncodingSummary
    }
  | { status: 'loaded'; filename: string; rowCount: number; dim: number; encoding: EncodingSummary }
  /** Transport succeeded, the backend received the request and rejected it
   *  (non-2xx) — distinct from `network_error` (never reached the backend
   *  at all). See docs/idealization_report.md, 2026-07-14 sprint, Phase 1. */
  | { status: 'error'; filename: string; reason: string }
  /** Transport-level failure — fetch/XHR exception (TypeError), CORS block,
   *  or connection refused. The backend was never reached, so this must
   *  never share copy with `rejected` (a content-validation outcome) or
   *  `error` (a reached-but-rejected outcome). Carries a retry action. */
  | { status: 'network_error'; filename: string; reason: string }
  | {
      status: 'offer'
      filename: string
      rowCount: number
      dim: number
      encoding: EncodingSummary
    }

export const IDLE_DATA_SOURCE_STATE: DataSourceState = { status: 'idle' }

/** `network_error`'s fixed copy — a transport failure has nothing
 *  file-specific to report, unlike `rejected`/`error`'s per-file reasons. */
export const NETWORK_ERROR_MESSAGE = 'backend unreachable · verify api on port 8050 · retry'

/** True when a state's encoding facts should mention categorical encoding at all. */
function hasEncodedCategoricals(encoding: EncodingSummary): boolean {
  return encoding.encodedCategoricalColumns > 0
}

/** `loaded X of Y columns · N encoded categorical · M skipped (free text)[, K rows skipped]`. */
export function formatPartialMessage(state: Extract<DataSourceState, { status: 'partial' }>): string {
  const parts = [`loaded ${String(state.dim)} of ${String(state.totalColumns)} columns`]
  const skips: string[] = []
  if (hasEncodedCategoricals(state.encoding)) {
    skips.push(`${String(state.encoding.encodedCategoricalColumns)} encoded categorical`)
  }
  if (state.skippedFreeText > 0) {
    skips.push(`${String(state.skippedFreeText)} skipped (free text)`)
  }
  if (state.droppedRows > 0) {
    skips.push(`${String(state.droppedRows)} row${state.droppedRows === 1 ? '' : 's'} skipped`)
  }
  return skips.length > 0 ? `${parts[0]} · ${skips.join(' · ')}` : parts[0]
}

/**
 * `N rows · M dims · clustered`, with an encoding clause when categoricals
 * were encoded. A `loaded` state can only have `numericColumns === 0` by
 * having come through a confirmed `offer` (the ok/loaded path otherwise
 * always requires at least one numeric column) — in that case the message
 * is explicitly labeled per the product principle: this is not raw
 * measurement data, and must never be presented as if it were.
 */
export function formatLoadedMessage(state: Extract<DataSourceState, { status: 'loaded' }>): string {
  const base = `${String(state.rowCount)} rows · ${String(state.dim)} dims · clustered`
  if (state.encoding.numericColumns === 0) {
    return `${base} · ${ENCODED_ONLY_LABEL}`
  }
  if (!hasEncodedCategoricals(state.encoding)) return base
  return `${base} · ${String(state.encoding.numericColumns)} numeric · ${String(state.encoding.encodedCategoricalColumns)} encoded categorical`
}

/** `no numeric columns · N categorical fields detected`. */
export function formatOfferMessage(state: Extract<DataSourceState, { status: 'offer' }>): string {
  return `no numeric columns · ${String(state.encoding.encodedCategoricalColumns)} categorical fields detected`
}

/** Shown once an `offer` has been confirmed — the explicit label the
 *  product principle requires: this is not raw measurement data. */
export const ENCODED_ONLY_LABEL = 'visualizing encoded categories · not raw measurements'
