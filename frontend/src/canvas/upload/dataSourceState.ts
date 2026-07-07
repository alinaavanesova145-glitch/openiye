/**
 * DataSourceState — explicit state machine for the DATA SOURCE panel.
 *
 * Replaces the old silent-failure path (see docs/idealization_report.md,
 * 2026-07-07 sprint, Phase 0) where a rejected/errored upload produced no
 * visible change at all. Every state below is renderable on its own.
 */

export type DataSourceState =
  | { status: 'idle' }
  | { status: 'parsing'; filename: string }
  | { status: 'rejected'; filename: string; reason: string }
  | {
      status: 'partial'
      filename: string
      rowCount: number
      dim: number
      totalColumns: number
      droppedColumns: number
      droppedRows: number
    }
  | { status: 'loaded'; filename: string; rowCount: number; dim: number }
  | { status: 'error'; filename: string; reason: string }

export const IDLE_DATA_SOURCE_STATE: DataSourceState = { status: 'idle' }

/** `loaded X of Y columns · N non-numeric skipped[, M rows skipped]`. */
export function formatPartialMessage(state: Extract<DataSourceState, { status: 'partial' }>): string {
  const parts = [`loaded ${String(state.dim)} of ${String(state.totalColumns)} columns`]
  const skips: string[] = []
  if (state.droppedColumns > 0) {
    skips.push(`${String(state.droppedColumns)} non-numeric skipped`)
  }
  if (state.droppedRows > 0) {
    skips.push(`${String(state.droppedRows)} row${state.droppedRows === 1 ? '' : 's'} skipped`)
  }
  return skips.length > 0 ? `${parts[0]} · ${skips.join(' · ')}` : parts[0]
}

/** `N rows · M dims · clustered`. */
export function formatLoadedMessage(state: Extract<DataSourceState, { status: 'loaded' }>): string {
  return `${String(state.rowCount)} rows · ${String(state.dim)} dims · clustered`
}
