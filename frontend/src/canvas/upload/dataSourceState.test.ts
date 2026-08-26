/**
 * dataSourceState.test.ts (2026-08-28 sprint) — the DATA SOURCE panel's
 * user-facing status messages had real branching logic (encoded-
 * categoricals clause, skipped-free-text clause, dropped-rows clause,
 * singular/plural, the encoded-only special case) and no test file at
 * all before this sprint.
 */
import { describe, expect, it } from 'vitest'
import type { EncodingSummary } from './parseMatrix'
import {
  ENCODED_ONLY_LABEL,
  IDLE_DATA_SOURCE_STATE,
  NETWORK_ERROR_MESSAGE,
  UPLOAD_TIMEOUT_MESSAGE,
  formatLoadedMessage,
  formatOfferMessage,
  formatPartialMessage,
  type DataSourceState,
} from './dataSourceState'

function encoding(overrides: Partial<EncodingSummary> = {}): EncodingSummary {
  return {
    totalColumns: 6,
    numericColumns: 6,
    encodedCategoricalColumns: 0,
    encodedDims: 0,
    skippedFreeText: 0,
    columns: [],
    featureNames: [],
    ...overrides,
  }
}

describe('IDLE_DATA_SOURCE_STATE / message constants', () => {
  it('IDLE_DATA_SOURCE_STATE is the idle status with no extra fields', () => {
    expect(IDLE_DATA_SOURCE_STATE).toEqual({ status: 'idle' })
  })

  it('NETWORK_ERROR_MESSAGE and UPLOAD_TIMEOUT_MESSAGE never share wording', () => {
    // network_error legitimately covers both causes (see
    // useVectorDiagnostics.ts's classifyIngestFailure/attemptIngest), but
    // "unreachable" would be actively wrong for a timeout -- the backend
    // may be up, just slow/hung.
    expect(NETWORK_ERROR_MESSAGE).toContain('unreachable')
    expect(UPLOAD_TIMEOUT_MESSAGE).not.toContain('unreachable')
    expect(UPLOAD_TIMEOUT_MESSAGE).toContain('timed out')
  })
})

describe('formatPartialMessage', () => {
  const base: Extract<DataSourceState, { status: 'partial' }> = {
    status: 'partial',
    filename: 'mixed.csv',
    rowCount: 150,
    dim: 4,
    totalColumns: 6,
    skippedFreeText: 0,
    droppedRows: 0,
    encoding: encoding({ totalColumns: 6, numericColumns: 4 }),
  }

  it('bare column count when nothing was encoded/skipped/dropped', () => {
    expect(formatPartialMessage(base)).toBe('loaded 4 of 6 columns')
  })

  it('adds an encoded-categorical clause when the encoding actually encoded something', () => {
    const state = {
      ...base,
      encoding: encoding({ totalColumns: 6, numericColumns: 4, encodedCategoricalColumns: 2 }),
    }
    expect(formatPartialMessage(state)).toBe('loaded 4 of 6 columns · 2 encoded categorical')
  })

  it('adds a skipped-free-text clause when > 0', () => {
    const state = { ...base, skippedFreeText: 3 }
    expect(formatPartialMessage(state)).toBe('loaded 4 of 6 columns · 3 skipped (free text)')
  })

  it('singularizes "1 row skipped" but pluralizes "2 rows skipped"', () => {
    expect(formatPartialMessage({ ...base, droppedRows: 1 })).toBe('loaded 4 of 6 columns · 1 row skipped')
    expect(formatPartialMessage({ ...base, droppedRows: 2 })).toBe('loaded 4 of 6 columns · 2 rows skipped')
  })

  it('joins all three clauses, in order, when all apply at once', () => {
    const state = {
      ...base,
      skippedFreeText: 2,
      droppedRows: 3,
      encoding: encoding({ totalColumns: 6, numericColumns: 4, encodedCategoricalColumns: 1 }),
    }
    expect(formatPartialMessage(state)).toBe(
      'loaded 4 of 6 columns · 1 encoded categorical · 2 skipped (free text) · 3 rows skipped',
    )
  })
})

describe('formatLoadedMessage', () => {
  const base: Extract<DataSourceState, { status: 'loaded' }> = {
    status: 'loaded',
    filename: 'clean.csv',
    rowCount: 150,
    dim: 6,
    encoding: encoding({ totalColumns: 6, numericColumns: 6 }),
  }

  it('bare pipeline confirmation for a pure-numeric upload', () => {
    expect(formatLoadedMessage(base)).toBe('150 rows · 6 dims · clustered')
  })

  it('adds numeric/encoded-categorical counts for a mixed upload', () => {
    const state = {
      ...base,
      dim: 14,
      encoding: encoding({ totalColumns: 9, numericColumns: 4, encodedCategoricalColumns: 5 }),
    }
    expect(formatLoadedMessage(state)).toBe(
      '150 rows · 14 dims · clustered · 4 numeric · 5 encoded categorical',
    )
  })

  it('labels a zero-numeric-columns (offer-confirmed) upload explicitly as not raw measurements', () => {
    const state = {
      ...base,
      encoding: encoding({ totalColumns: 3, numericColumns: 0, encodedCategoricalColumns: 3 }),
    }
    expect(formatLoadedMessage(state)).toBe(`150 rows · 6 dims · clustered · ${ENCODED_ONLY_LABEL}`)
    // The zero-numeric special case wins even when it technically also has
    // encoded categoricals -- never both clauses at once (would read as a
    // contradiction: "not raw measurements" and "N numeric" together).
    expect(formatLoadedMessage(state)).not.toContain('numeric ·')
  })
})

describe('formatOfferMessage', () => {
  it('reports the categorical field count for a not-yet-confirmed offer', () => {
    const state: Extract<DataSourceState, { status: 'offer' }> = {
      status: 'offer',
      filename: 'survey.csv',
      rowCount: 40,
      dim: 14,
      encoding: encoding({ totalColumns: 3, numericColumns: 0, encodedCategoricalColumns: 3 }),
    }
    expect(formatOfferMessage(state)).toBe('no numeric columns · 3 categorical fields detected')
  })
})
