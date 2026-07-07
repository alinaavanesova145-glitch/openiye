import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DataSourceState } from '@canvas/upload/dataSourceState'
import { DataSourcePanel } from './DataSourcePanel'

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

  it('renders the partial state with exact dropped-column counts', () => {
    const state: DataSourceState = {
      status: 'partial',
      filename: 'mixed.csv',
      rowCount: 150,
      dim: 4,
      totalColumns: 6,
      droppedColumns: 2,
      droppedRows: 0,
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(screen.getByText('mixed.csv')).toBeInTheDocument()
    expect(screen.getByText('loaded 4 of 6 columns · 2 non-numeric skipped')).toBeInTheDocument()
  })

  it('renders the partial state with both dropped columns and dropped rows', () => {
    const state: DataSourceState = {
      status: 'partial',
      filename: 'messy.csv',
      rowCount: 100,
      dim: 4,
      totalColumns: 6,
      droppedColumns: 2,
      droppedRows: 3,
    }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(
      screen.getByText('loaded 4 of 6 columns · 2 non-numeric skipped · 3 rows skipped'),
    ).toBeInTheDocument()
  })

  it('renders the loaded state with pipeline confirmation', () => {
    const state: DataSourceState = { status: 'loaded', filename: 'clean.csv', rowCount: 150, dim: 6 }
    render(<DataSourcePanel state={state} onFile={vi.fn()} />)
    expect(screen.getByText('clean.csv')).toBeInTheDocument()
    expect(screen.getByText('150 rows · 6 dims · clustered')).toBeInTheDocument()
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

  it('never renders magenta anywhere in the panel, for any state', () => {
    const states: DataSourceState[] = [
      { status: 'idle' },
      { status: 'parsing', filename: 'a.csv' },
      { status: 'rejected', filename: 'a.csv', reason: 'bad' },
      { status: 'partial', filename: 'a.csv', rowCount: 1, dim: 1, totalColumns: 2, droppedColumns: 1, droppedRows: 0 },
      { status: 'loaded', filename: 'a.csv', rowCount: 1, dim: 1 },
      { status: 'error', filename: 'a.csv', reason: 'bad' },
    ]
    for (const state of states) {
      const { container, unmount } = render(<DataSourcePanel state={state} onFile={vi.fn()} />)
      expect(container.innerHTML.toLowerCase()).not.toContain('#ff00ff')
      expect(container.innerHTML.toLowerCase()).not.toContain('magenta')
      unmount()
    }
  })
})
