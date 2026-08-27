import { describe, expect, it } from 'vitest'
import {
  parseCsvMatrix,
  parseJsonMatrix,
  parseNpyMatrix,
  parseFile,
  detectFormat,
  REJECTED_NO_NUMERIC_DATA,
} from './parseMatrix'

const ONEHOT_SCALE_2 = 1 / Math.sqrt(2) // block-scale for a 2-category one-hot column

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
      expect(outcome.matrix.skippedFreeText).toBe(0)
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

  // CHANGED 2026-07-12 (Phase 1a): this fixture's non-numeric columns ('id',
  // 'label') are both low-cardinality (2 uniques each) — under the old
  // "any non-numeric column is dropped" rule they were discarded; now
  // bounded-cardinality categoricals are encoded and kept, per the product
  // principle that encoding is a legitimate view of data, not a degradation.
  // BEFORE: asserted totalColumns=6, dim=4, droppedColumns=2, rows equal to
  // just the 4 raw numeric columns. AFTER: asserts the columns are encoded
  // (dim=8: 4 normalized numeric + 2 one-hot dims each for 'id' and 'label'),
  // exact encoded values, and encoding summary counts. See the next test for
  // dedicated one-hot-value verification and further down for a genuine
  // free-text (skipped) column.
  it('encodes low-cardinality categorical columns in a mixed CSV instead of dropping them', async () => {
    const csv = 'id,val_a,val_b,label,val_c,val_d\n' + 'x1,1.0,2.0,ok,3.0,4.0\n' + 'x2,5.0,6.0,bad,7.0,8.0'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      const { encoding } = outcome.matrix
      expect(outcome.matrix.totalColumns).toBe(6)
      expect(encoding.numericColumns).toBe(4)
      expect(encoding.encodedCategoricalColumns).toBe(2)
      expect(encoding.encodedDims).toBe(4) // 2 categories each for 'id' and 'label'
      expect(encoding.skippedFreeText).toBe(0)
      expect(outcome.matrix.dim).toBe(8) // 4 numeric + 4 encoded
      expect(outcome.matrix.droppedRows).toBe(0)

      // id: sorted categories ['x1','x2'] → row0 one-hot [scale,0], row1 [0,scale]
      // label: sorted categories ['bad','ok'] → row0 (ok) [0,scale], row1 (bad) [scale,0]
      // val_a/val_b/val_c/val_d: z-score normalized once any encoding occurs (mixed pathway)
      const s = ONEHOT_SCALE_2
      const rows = outcome.matrix.rows
      expect(rows[0]).toEqual([s, 0, -1, -1, 0, s, -1, -1])
      expect(rows[1]).toEqual([0, s, 1, 1, s, 0, 1, 1])
    }
  })

  it('reports one-hot categories in the encoding summary, sorted deterministically', async () => {
    const csv = 'color,n\nred,1\nblue,2\ngreen,3\nred,4'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      const colorColumn = outcome.matrix.encoding.columns.find((c) => c.name === 'color')
      expect(colorColumn?.method).toBe('onehot')
      expect(colorColumn?.categories).toEqual(['blue', 'green', 'red'])
      expect(colorColumn?.outputDims).toBe(3)
    }
  })

  it('frequency-encodes a mid-cardinality categorical column (21-1000 uniques)', async () => {
    // 30 rows, a column with 25 distinct values (above the one-hot cutoff of
    // 20, below the frequency ceiling of 1000) plus one numeric column.
    const lines = ['cat,val']
    for (let i = 0; i < 30; i++) {
      lines.push(`cat_${String(i % 25)},${String(i)}`)
    }
    const outcome = await parseCsvMatrix(lines.join('\n'))
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      const catColumn = outcome.matrix.encoding.columns.find((c) => c.name === 'cat')
      expect(catColumn?.method).toBe('frequency')
      expect(catColumn?.outputDims).toBe(1)
      expect(outcome.matrix.encoding.encodedDims).toBe(1)
    }
  })

  it('skips a genuinely free-text (near-unique) column instead of encoding it', async () => {
    // 25 rows, a "comment" column where every value is unique — over the
    // near-unique ratio threshold (only applied once there are enough rows
    // to make the ratio meaningful) — plus a numeric column that IS kept.
    const lines = ['comment,val']
    for (let i = 0; i < 25; i++) {
      lines.push(`this is unique remark number ${String(i)},${String(i)}`)
    }
    const outcome = await parseCsvMatrix(lines.join('\n'))
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.encoding.skippedFreeText).toBe(1)
      expect(outcome.matrix.encoding.encodedCategoricalColumns).toBe(0)
      expect(outcome.matrix.dim).toBe(1) // only 'val' survives
    }
  })

  it('produces an "offer" outcome for a CSV with only encodable categorical columns (no numeric)', async () => {
    const csv = 'name,label\nalice,ok\nbob,bad'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('offer')
    if (outcome.kind === 'offer') {
      expect(outcome.matrix.encoding.numericColumns).toBe(0)
      expect(outcome.matrix.encoding.encodedCategoricalColumns).toBe(2)
      expect(outcome.matrix.dim).toBe(4) // 2 categories each for 'name' and 'label'
    }
  })

  it('rejects a CSV with no numeric columns and no encodable categorical structure either', async () => {
    // 25 rows, a single near-unique "name" column and nothing else usable.
    const lines = ['name']
    for (let i = 0; i < 25; i++) lines.push(`person_${String(i)}`)
    const outcome = await parseCsvMatrix(lines.join('\n'))
    expect(outcome).toEqual({ kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA })
  })

  it('parsing the same mixed file twice produces an identical feature matrix (determinism)', async () => {
    const csv = 'id,val_a,label,val_b\nx1,1.0,ok,2.0\nx2,3.0,bad,4.0\nx3,5.0,ok,6.0'
    const first = await parseCsvMatrix(csv)
    const second = await parseCsvMatrix(csv)
    expect(first).toEqual(second)
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

  // CHANGED 2026-07-12 (Phase 1b): this exact fixture ('name,label' with 2
  // low-cardinality columns and zero numeric ones) used to be REJECTED
  // outright. It now correctly produces an 'offer' instead — see
  // 'produces an "offer" outcome for a CSV with only encodable categorical
  // columns' above, which supersedes this test with the same fixture.
  // Genuine rejection (no numeric AND no encodable categorical structure)
  // is covered by 'rejects a CSV with no numeric columns and no encodable
  // categorical structure either' above.

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

  // CHANGED 2026-07-12 (Phase 1a): 'label' is low-cardinality (2 uniques) and
  // is now encoded (one-hot) rather than dropped — same rationale as the CSV
  // test above. BEFORE: asserted dim=2, totalColumns=3, droppedColumns=1,
  // rows equal to just [x,y]. AFTER: asserts the encoded dim (4) and exact
  // values (x/y z-scored once encoding occurs, label one-hot).
  it('encodes a low-cardinality field in an array of flat objects instead of dropping it', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        { x: 1, y: 2, label: 'ok' },
        { x: 3, y: 4, label: 'bad' },
      ]),
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.totalColumns).toBe(3)
      expect(outcome.matrix.encoding.numericColumns).toBe(2)
      expect(outcome.matrix.encoding.encodedCategoricalColumns).toBe(1)
      expect(outcome.matrix.dim).toBe(4)
      const s = ONEHOT_SCALE_2
      // Column order is sorted key order (label, x, y), not insertion order.
      // label sorted categories ['bad', 'ok'] → row0 'ok' → [0,s], row1 'bad' → [s,0]
      expect(outcome.matrix.rows).toEqual([
        [0, s, -1, -1],
        [s, 0, 1, 1],
      ])
    }
  })

  it('flattens nested objects to dotted-path columns up to the documented depth', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        { a: 1, meta: { b: 2, deep: { c: 3 } } },
        { a: 4, meta: { b: 5, deep: { c: 6 } } },
      ]),
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.encoding.columns).toEqual([])
      expect(outcome.matrix.totalColumns).toBe(3) // a, meta.b, meta.deep.c
      expect(outcome.matrix.dim).toBe(3)
      expect(outcome.matrix.rows).toEqual([
        [1, 2, 3],
        [4, 5, 6],
      ])
    }
  })

  it('preserves a JSON column literally named "__proto__" instead of silently dropping it (2026-08-27 sprint)', () => {
    // Bracket/computed-key syntax (not a literal `{__proto__: ...}` object
    // key), so JS actually creates the property being tested rather than
    // triggering the object-literal syntax's own special-cased prototype
    // assignment -- this way the string JSON.stringify produces, and what
    // JSON.parse (inside parseJsonMatrix) then reconstructs from it, both
    // genuinely contain an own "__proto__" data property, exactly like a
    // real uploaded JSON file with a column header spelled that way would.
    const rawJson = JSON.stringify([
      { ['__proto__']: 3.1, x: 1 },
      { ['__proto__']: 4.2, x: 2 },
    ])
    const outcome = parseJsonMatrix(rawJson)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.totalColumns).toBe(2)
      expect(outcome.matrix.encoding.featureNames).toContain('__proto__')
    }
  })

  it('treats objects nested beyond the max flatten depth as an opaque (skipped) leaf', () => {
    // depth: a=0, .l1=1, .l2=2, .l3=3 (still flattened, at the limit), .l4=4 (over the limit → opaque).
    // 25 rows (>= the near-unique ratio check's minimum) with a distinct
    // deep value per row, so the resulting stringified-JSON leaf is
    // genuinely near-unique and correctly classified as free text, not
    // accidentally one-hot-encoded by having too few rows to judge by ratio.
    const objs = Array.from({ length: 25 }, (_, i) => ({
      a: { l1: { l2: { l3: { l4: i } } } },
      keep: i * 10,
    }))
    const outcome = parseJsonMatrix(JSON.stringify(objs))
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.encoding.skippedFreeText).toBe(1)
      expect(outcome.matrix.dim).toBe(1) // only 'keep' survives
      expect(outcome.matrix.rows[0]).toEqual([0])
      expect(outcome.matrix.rows[24]).toEqual([240])
    }
  })

  it('produces an "offer" outcome for an array of objects with only categorical fields', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        { fruit: 'apple', color: 'red' },
        { fruit: 'pear', color: 'green' },
        { fruit: 'apple', color: 'green' },
      ]),
    )
    expect(outcome.kind).toBe('offer')
    if (outcome.kind === 'offer') {
      expect(outcome.matrix.encoding.numericColumns).toBe(0)
      expect(outcome.matrix.encoding.encodedCategoricalColumns).toBe(2)
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

// ─── EncodingSummary.featureNames (2026-07-31 sprint) ──────────────────────────
// One original-column name per FINAL output matrix column — threaded to the
// backend as MatrixUploadRequest.column_names so an anomaly can be attributed
// to a real field name instead of an opaque matrix column index.

describe('EncodingSummary.featureNames', () => {
  it('a pure-numeric CSV keeps one name per column, unchanged order', async () => {
    const csv = 'temperature,pressure\n1,2\n3,4'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.encoding.featureNames).toEqual(['temperature', 'pressure'])
    }
  })

  it('a one-hot-expanded column repeats its original name once per category dimension', async () => {
    const csv = 'color,n\nred,1\nblue,2\ngreen,3\nred,4'
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      // color -> 3 categories (blue, green, red) -> 3 repeated names, then n
      expect(outcome.matrix.encoding.featureNames).toEqual(['color', 'color', 'color', 'n'])
    }
  })

  it('a frequency-encoded column contributes exactly one name for its one output column', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => `cat_${String(i % 25)},${String(i)}`)
    const csv = `dept,n\n${rows.join('\n')}`
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.encoding.featureNames).toContain('dept')
      expect(outcome.matrix.encoding.featureNames.filter((n) => n === 'dept')).toHaveLength(1)
    }
  })

  it('a skipped free-text column contributes no name at all', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => `${String(i)},unique log line number ${String(i)}`)
    const csv = `n,notes\n${rows.join('\n')}`
    const outcome = await parseCsvMatrix(csv)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.encoding.featureNames).not.toContain('notes')
      expect(outcome.matrix.encoding.featureNames).toEqual(['n'])
    }
  })

  it('a bare array-of-arrays JSON payload has no headers, so featureNames is honestly empty', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.matrix.encoding.featureNames).toEqual([])
    }
  })

  it('an array of flat objects uses the object keys as feature names', () => {
    const outcome = parseJsonMatrix(
      JSON.stringify([
        { age: 25, region: 'west' },
        { age: 30, region: 'east' },
      ]),
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      // age (numeric) + region (2-category one-hot, repeated twice)
      expect(outcome.matrix.encoding.featureNames).toEqual(['age', 'region', 'region'])
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
