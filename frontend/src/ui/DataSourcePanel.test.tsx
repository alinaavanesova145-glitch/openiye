import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DataSourceState, EncodingSummary } from '@canvas/upload/dataSourceState'
import { DataSourcePanel } from './DataSourcePanel'

function noEncoding(totalColumns: number): EncodingSummary {
  return {
    totalColumns,
    numericColumns: totalColumns,
    encodedCategoricalColumns: 0,
    encodedDims: 0,
    skippedFreeText: 0,
    columns: [],
  }
}

describe('DataSourcePanel', () => {
  it('renders the idle drop-target copy', () => {
    render(<DataSourcePanel state={{ status: 'idle' }} onFile={vi.fn()} />)
    expect(screen.getByText('drop file or click')).toBeInTheDocument()
    expect(screen.getByText('json · csv · npy')).toBeInTheDocument()
  })

  it('renders the parsing state with filename and a progress percentage', () => {
    render(
      <DataSourcePanel
        state={{ status: 'parsing', filename: 'sample_telemetry.csv', progress: 0.42 }}
        onFile={vi.fn()}
      />,
    )
    expect(screen.getByText('sample_telemetry.csv')).toBeInTheDocument()
    expect(screen.getByText('parsing… 42%')).toBeInTheDocument()
  })

  it('renders the parsing state without a percentage when progress is unknown (JSON/NPY)', () => {
    render(<DataSourcePanel state={{ status: 'parsing', filename: 'data.json' }} onFile={vi.fn()} />)
    expect(screen.getByText('parsing…')).toBeInTheDocument()
  })

  it('renders the rejected state for a package.json-shaped drop — the reported bug fix', () => {
    const state: DataSourceState = {
      status: 'rejected',
      filename: 'package.json',
      reason: 'no numeric vectors found · expected rows of numbers · json / csv / npy',
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(
      screen.getByText('no numeric vectors found · expected rows of numbers · json / csv / npy'),
    ).toBeInTheDocument()
  })

  it('renders the rejected state at 70% blush opacity, never magenta', () => {
    const state: DataSourceState = { status: 'rejected', filename: 'x.csv', reason: 'nope' }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    const reasonEl = screen.getByText('nope')
    expect(reasonEl).toHaveStyle({ color: 'rgba(255, 182, 193, 0.7)' })
  })

  // CHANGED 2026-07-12 (Phase 1a): `partial`'s fields were renamed
  // (`droppedColumns` → `skippedFreeText`, plus a required `encoding`
  // summary) because non-numeric columns are no longer simply "dropped" —
  // bounded-cardinality ones are encoded now. BEFORE: fixture had
  // `droppedColumns: 2` and asserted the message "loaded 4 of 6 columns · 2
  // non-numeric skipped". AFTER: fixture has `skippedFreeText: 2` (these 2
  // are genuinely unencodable free text, not just "non-numeric"), message
  // wording updated to "2 skipped (free text)" to match — still the same
  // honest-disclosure intent, just accurate about *why* they were skipped.
  it('renders the partial state with exact skipped-free-text counts', () => {
    const state: DataSourceState = {
      status: 'partial',
      filename: 'mixed.csv',
      rowCount: 150,
      dim: 4,
      totalColumns: 6,
      skippedFreeText: 2,
      droppedRows: 0,
      encoding: noEncoding(6),
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(screen.getByText('mixed.csv')).toBeInTheDocument()
    expect(screen.getByText('loaded 4 of 6 columns · 2 skipped (free text)')).toBeInTheDocument()
  })

  it('renders the partial state with both skipped-free-text and dropped rows', () => {
    const state: DataSourceState = {
      status: 'partial',
      filename: 'messy.csv',
      rowCount: 100,
      dim: 4,
      totalColumns: 6,
      skippedFreeText: 2,
      droppedRows: 3,
      encoding: noEncoding(6),
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(
      screen.getByText('loaded 4 of 6 columns · 2 skipped (free text) · 3 rows skipped'),
    ).toBeInTheDocument()
  })

  it('renders the partial state with encoding facts alongside skipped free text', () => {
    const encoding: EncodingSummary = {
      totalColumns: 9,
      numericColumns: 4,
      encodedCategoricalColumns: 3,
      encodedDims: 7,
      skippedFreeText: 2,
      columns: [],
    }
    const state: DataSourceState = {
      status: 'partial',
      filename: 'mixed_wide.csv',
      rowCount: 150,
      dim: 11,
      totalColumns: 9,
      skippedFreeText: 2,
      droppedRows: 0,
      encoding,
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(
      screen.getByText(
        'loaded 11 of 9 columns · 3 encoded categorical · 2 skipped (free text)',
      ),
    ).toBeInTheDocument()
  })

  // CHANGED 2026-07-12: `loaded` now requires an `encoding` summary too
  // (always present, `numericColumns: totalColumns` etc. for a pure-numeric
  // file — see `noEncoding` helper above). Message text is unchanged for the
  // pure-numeric case.
  it('renders the loaded state with pipeline confirmation', () => {
    const state: DataSourceState = {
      status: 'loaded',
      filename: 'clean.csv',
      rowCount: 150,
      dim: 6,
      encoding: noEncoding(6),
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(screen.getByText('clean.csv')).toBeInTheDocument()
    expect(screen.getByText('150 rows · 6 dims · clustered')).toBeInTheDocument()
  })

  it('renders the loaded state with encoding facts for a mixed upload', () => {
    const encoding: EncodingSummary = {
      totalColumns: 9,
      numericColumns: 4,
      encodedCategoricalColumns: 5,
      encodedDims: 10,
      skippedFreeText: 0,
      columns: [],
    }
    const state: DataSourceState = {
      status: 'loaded',
      filename: 'mixed_wide.csv',
      rowCount: 150,
      dim: 14,
      encoding,
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(
      screen.getByText('150 rows · 14 dims · clustered · 4 numeric · 5 encoded categorical'),
    ).toBeInTheDocument()
  })

  it('labels an encoded-only visualization explicitly as not raw measurements', () => {
    const encoding: EncodingSummary = {
      totalColumns: 3,
      numericColumns: 0,
      encodedCategoricalColumns: 3,
      encodedDims: 8,
      skippedFreeText: 0,
      columns: [],
    }
    const state: DataSourceState = {
      status: 'loaded',
      filename: 'categories_only.json',
      rowCount: 40,
      dim: 8,
      encoding,
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(
      screen.getByText('40 rows · 8 dims · clustered · visualizing encoded categories · not raw measurements'),
    ).toBeInTheDocument()
  })

  it('renders the error state distinctly from rejected', () => {
    const state: DataSourceState = {
      status: 'error',
      filename: 'clean.csv',
      reason: 'ingest failed · backend unreachable',
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(screen.getByText('ingest failed · backend unreachable')).toBeInTheDocument()
  })

  // NEW 2026-07-12 (Phase 1b): `offer` — a zero-numeric-columns file with
  // encodable categorical structure never auto-visualizes.
  describe('offer state', () => {
    const offerState: DataSourceState = {
      status: 'offer',
      filename: 'survey.csv',
      rowCount: 40,
      dim: 14,
      encoding: {
        totalColumns: 3,
        numericColumns: 0,
        encodedCategoricalColumns: 3,
        encodedDims: 14,
        skippedFreeText: 0,
        columns: [],
      },
    }

    it('renders the offer copy with the categorical field count, and does not auto-ingest', () => {
      const onFile = vi.fn()
      render(<DataSourcePanel state={offerState} onFile={onFile} onConfirmOffer={vi.fn()} />)
      expect(screen.getByText('survey.csv')).toBeInTheDocument()
      expect(screen.getByText('no numeric columns · 3 categorical fields detected')).toBeInTheDocument()
      expect(screen.getByText('encode & visualize')).toBeInTheDocument()
      expect(screen.getByText('dismiss')).toBeInTheDocument()
      expect(onFile).not.toHaveBeenCalled()
    })

    it('clicking "encode & visualize" triggers onConfirmOffer, not the file picker', () => {
      const onConfirmOffer = vi.fn()
      const onFile = vi.fn()
      render(<DataSourcePanel state={offerState} onFile={onFile} onConfirmOffer={onConfirmOffer} />)
      fireEvent.click(screen.getByText('encode & visualize'))
      expect(onConfirmOffer).toHaveBeenCalledOnce()
      expect(onFile).not.toHaveBeenCalled()
    })

    it('clicking "dismiss" triggers onDismissOffer, not the file picker', () => {
      const onDismissOffer = vi.fn()
      const onFile = vi.fn()
      render(<DataSourcePanel state={offerState} onFile={onFile} onDismissOffer={onDismissOffer} />)
      fireEvent.click(screen.getByText('dismiss'))
      expect(onDismissOffer).toHaveBeenCalledOnce()
      expect(onFile).not.toHaveBeenCalled()
    })
  })

  it('never renders magenta anywhere in the panel, for any state', () => {
    const states: DataSourceState[] = [
      { status: 'idle' },
      { status: 'parsing', filename: 'a.csv' },
      { status: 'rejected', filename: 'a.csv', reason: 'bad' },
      {
        status: 'partial',
        filename: 'a.csv',
        rowCount: 1,
        dim: 1,
        totalColumns: 2,
        skippedFreeText: 1,
        droppedRows: 0,
        encoding: noEncoding(2),
      },
      { status: 'loaded', filename: 'a.csv', rowCount: 1, dim: 1, encoding: noEncoding(1) },
      { status: 'error', filename: 'a.csv', reason: 'bad' },
      {
        status: 'offer',
        filename: 'a.csv',
        rowCount: 1,
        dim: 1,
        encoding: {
          totalColumns: 1,
          numericColumns: 0,
          encodedCategoricalColumns: 1,
          encodedDims: 1,
          skippedFreeText: 0,
          columns: [],
        },
      },
    ]
    for (const state of states) {
      const { container, unmount } = render(<DataSourcePanel state={state} onFile={vi.fn()} />)
      expect(container.innerHTML.toLowerCase()).not.toContain('#ff00ff')
      expect(container.innerHTML.toLowerCase()).not.toContain('magenta')
      unmount()
    }
  })
})
