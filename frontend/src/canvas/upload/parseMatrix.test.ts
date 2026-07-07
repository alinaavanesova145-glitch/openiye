import { describe, expect, it } from 'vitest'
import {
  parseCsvMatrix,
  parseJsonMatrix,
  parseNpyMatrix,
  parseFile,
  detectFormat,
  REJECTED_NO_NUMERIC_DATA,
} from './parseMatrix'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Builds a minimal valid .npy v1.0 buffer (2D) for a given dtype. */
function buildNpyBuffer(
  rows: number[][],
  descr: '<f8' | '<f4' | '<i4',
  fortranOrder = false,
): ArrayBuffer {
  const rowCount = rows.length
  const dim = rows[0]?.length ?? 0
  const headerDict = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? 'True' : 'False'}, 'shape': (${String(rowCount)}, ${String(dim)}), }`

  // Pad header so (10 + headerLen) is a multiple of 64, per npy spec, ending in '\n'.
  const prefixLen = 10
  let header = headerDict
  const totalLenBeforePad = prefixLen + header.length + 1 // +1 for trailing \n
  const padding = (64 - (totalLenBeforePad % 64)) % 64
  header = header + ' '.repeat(padding) + '\n'

  const bytesPerElement = descr === '<f8' ? 8 : 4
  const dataBytes = rowCount * dim * bytesPerElement
  const buffer = new ArrayBuffer(prefixLen + header.length + dataBytes)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]
  bytes.set(magic, 0)
  bytes[6] = 1 // major version
  bytes[7] = 0 // minor version
  view.setUint16(8, header.length, true)
  for (let i = 0; i < header.length; i++) {
    bytes[prefixLen + i] = header.charCodeAt(i)
  }

  let offset = prefixLen + header.length
  for (const row of rows) {
    for (const val of row) {
      if (descr === '<f8') view.setFloat64(offset, val, true)
      else if (descr === '<f4') view.setFloat32(offset, val, true)
      else view.setInt32(offset, val, true)
      offset += bytesPerElement
    }
  }

  return buffer
}

// ─── detectFormat ─────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('detects csv/json/npy by extension, case-insensitively', () => {
    expect(detectFormat('data.csv')).toBe('csv')
    expect(detectFormat('DATA.CSV')).toBe('csv')
    expect(detectFormat('package.json')).toBe('json')
    expect(detectFormat('matrix.npy')).toBe('npy')
  })

  it('returns null for unsupported extensions (including the retired .bin)', () => {
    expect(detectFormat('dump.bin')).toBeNull()
    expect(detectFormat('noextension')).toBeNull()
  })
})

// ─── CSV ──────────────────────────────────────────────────────────────────────

describe('parseCsvMatrix', () => {
  it('parses a clean numeric CSV with a header row', async () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6\n7,8,9'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rows).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ])
      expect(outcome.matrix.dim).toBe(3)
      expect(outcome.matrix.droppedColumns).toBe(0)
      expect(outcome.matrix.droppedRows).toBe(0)
    }
  })

  it('parses a headerless fully-numeric CSV as all data rows', async () => {
    const csv = '1,2\n3,4'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rowCount).toBe(2)
    }
  })

  it('produces a "partial" outcome for a mixed CSV — drops the non-numeric column, reports exact counts', async () => {
    const csv = 'id,val_a,val_b,label,val_c,val_d\n' + 'x1,1.0,2.0,ok,3.0,4.0\n' + 'x2,5.0,6.0,bad,7.0,8.0'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      // 6 total columns (id, val_a, val_b, label, val_c, val_d); id and label are non-numeric.
      expect(outcome.matrix.totalColumns).toBe(6)
      expect(outcome.matrix.dim).toBe(4)
      expect(outcome.matrix.droppedColumns).toBe(2)
      expect(outcome.matrix.droppedRows).toBe(0)
      expect(outcome.matrix.rows).toEqual([
        [1.0, 2.0, 3.0, 4.0],
        [5.0, 6.0, 7.0, 8.0],
      ])
    }
  })

  it('drops ragged rows with the wrong cell count and reports the count', async () => {
    const csv = '1,2,3\n4,5,6\n7,8'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rowCount).toBe(2)
      expect(outcome.matrix.droppedRows).toBe(1)
    }
  })

  it('rejects an empty file', async () => {
    const outcome = await parseCsvMatrix('')
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('rejects a CSV with no numeric columns at all', async () => {
    const csv = 'name,label\nalice,ok\nbob,bad'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('yields to the event loop for large files (chunked, does not throw)', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `${String(i)},${String(i * 2)}`)
    const csv = rows.join('\n')
    const progressCalls: number[] = []
    const outcome = await parseCsvMatrix(csv, (parsed) => progressCalls.push(parsed))
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rowCount).toBe(5000)
    }
    expect(progressCalls.length).toBe(5000)
  })
})

// ─── JSON ─────────────────────────────────────────────────────────────────────

describe('parseJsonMatrix', () => {
  it('parses an array of arrays', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.dim).toBe(3)
      expect(outcome.matrix.rowCount).toBe(2)
    }
  })

  it('parses an array of flat numeric objects, dropping non-numeric fields column-wise', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        { x: 1, y: 2, label: 'ok' },
        { x: 3, y: 4, label: 'bad' },
      ]),
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.dim).toBe(2)
      expect(outcome.matrix.totalColumns).toBe(3)
      expect(outcome.matrix.droppedColumns).toBe(1)
      expect(outcome.matrix.rows).toEqual([
        [1, 2],
        [3, 4],
      ])
    }
  })

  it('rejects package.json-shaped input (a bare object, not an array)', () => {
    const packageJsonLike = JSON.stringify({
      name: 'iye-frontend',
      version: '0.1.0',
      private: true,
      scripts: { dev: 'vite', build: 'tsc && vite build' },
      dependencies: { react: '^18.3.1' },
    })
    const outcome = parseJsonMatrix(packageJsonLike)
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('rejects invalid JSON', () => {
    const outcome = parseJsonMatrix('{not valid json')
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('rejects an empty array', () => {
    const outcome = parseJsonMatrix('[]')
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('drops ragged sub-arrays and reports the count', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        [1, 2, 3],
        [4, 5],
        [6, 7, 8],
      ]),
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rowCount).toBe(2)
      expect(outcome.matrix.droppedRows).toBe(1)
    }
  })
})

// ─── NPY ──────────────────────────────────────────────────────────────────────

describe('parseNpyMatrix', () => {
  it('parses a float64 2D array', () => {
    const rows = [
      [1.5, 2.5],
      [3.5, 4.5],
      [5.5, 6.5],
    ]
    const buffer = buildNpyBuffer(rows, '<f8')
    const outcome = parseNpyMatrix(buffer)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rows).toEqual(rows)
      expect(outcome.matrix.dim).toBe(2)
      expect(outcome.matrix.rowCount).toBe(3)
    }
  })

  it('parses a float32 2D array', () => {
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
    ]
    const buffer = buildNpyBuffer(rows, '<f4')
    const outcome = parseNpyMatrix(buffer)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rows).toEqual(rows)
    }
  })

  it('parses an int32 2D array', () => {
    const rows = [
      [1, 2],
      [3, 4],
    ]
    const buffer = buildNpyBuffer(rows, '<i4')
    const outcome = parseNpyMatrix(buffer)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.rows).toEqual(rows)
    }
  })

  it('rejects a buffer with a bad magic number', () => {
    const buffer = new ArrayBuffer(20)
    const outcome = parseNpyMatrix(buffer)
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('rejects fortran-order arrays explicitly', () => {
    const buffer = buildNpyBuffer(
      [
        [1, 2],
        [3, 4],
      ],
      '<f8',
      true,
    )
    const outcome = parseNpyMatrix(buffer)
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toContain('fortran-order')
    }
  })
})

// ─── parseFile dispatch ────────────────────────────────────────────────────────

describe('parseFile', () => {
  it('dispatches .csv files to parseCsvMatrix', async () => {
    const file = new File(['1,2\n3,4'], 'data.csv', { type: 'text/csv' })
    const outcome = await parseFile(file)
    expect(outcome.kind).toBe('ok')
  })

  it('dispatches .json files to parseJsonMatrix', async () => {
    const file = new File(['[[1,2],[3,4]]'], 'data.json', { type: 'application/json' })
    const outcome = await parseFile(file)
    expect(outcome.kind).toBe('ok')
  })

  it('rejects a real package.json file dropped as-is', async () => {
    const file = new File(
      [JSON.stringify({ name: 'iye-frontend', version: '0.1.0', dependencies: { react: '^18.3.1' } })],
      'package.json',
      { type: 'application/json' },
    )
    const outcome = await parseFile(file)
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('rejects unsupported extensions (e.g. the retired .bin)', async () => {
    const file = new File([new ArrayBuffer(16)], 'dump.bin')
    const outcome = await parseFile(file)
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toContain('unsupported file type')
    }
  })
})
