/**
 * parseMatrix — dependency-free parsers turning a dropped file's raw content
 * into a rectangular numeric matrix, or an honest rejection reason.
 *
 * Replaces the previous "reinterpret every file's raw bytes as Float32"
 * behavior (see docs/idealization_report.md, 2026-07-07 sprint, Phase 0) —
 * these parsers actually read the declared file format.
 *
 * Categorical columns (bounded-cardinality strings) are encoded rather than
 * dropped — see docs/idealization_report.md, 2026-07-12 sprint, Phase 1 for
 * the full rationale. Only genuinely unusable columns (near-unique free
 * text, or files with nothing numeric/categorical at all) are skipped or
 * rejected outright.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type EncodingMethod = 'onehot' | 'frequency'

export interface EncodedColumnInfo {
  name: string
  method: EncodingMethod
  /** Sorted category list — present for 'onehot' only. */
  categories?: string[]
  outputDims: number
}

export interface EncodingSummary {
  totalColumns: number
  numericColumns: number
  encodedCategoricalColumns: number
  encodedDims: number
  skippedFreeText: number
  columns: EncodedColumnInfo[]
}

export interface ParsedMatrix {
  /** Rectangular numeric matrix, row-major: rows[i][j]. Includes encoded
   *  categorical dims alongside numeric ones — see `encoding` for the split. */
  rows: number[][]
  rowCount: number
  /** Final column count: numeric + encoded categorical dims. */
  dim: number
  /** Number of columns present in the source before encoding/skipping. */
  totalColumns: number
  /** Non-numeric columns skipped as unencodable free text (near-unique or
   *  over the frequency-encoding cardinality ceiling). */
  skippedFreeText: number
  droppedRows: number
  encoding: EncodingSummary
}

export type ParseOutcome =
  | { kind: 'ok'; matrix: ParsedMatrix }
  /** Zero numeric columns, but encodable categorical structure was found —
   *  the matrix is already computed; ingestion requires explicit user
   *  confirmation (see dataSourceState.ts's `offer` state). */
  | { kind: 'offer'; matrix: ParsedMatrix }
  | { kind: 'rejected'; reason: string }

export type ParseProgress = (rowsParsed: number, totalRows: number) => void

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB

/** Rows processed per chunk before yielding back to the main thread. */
export const CSV_CHUNK_ROWS = 2000

/** ≤ this many distinct values → one-hot encoded. */
export const ONEHOT_MAX_CARDINALITY = 20
/** Between ONEHOT_MAX_CARDINALITY and this → frequency encoded. Above → free text. */
export const FREQUENCY_MAX_CARDINALITY = 1000
/** Nested JSON objects flatten to dotted paths up to this depth; deeper
 *  structures (and arrays) become opaque stringified leaves. */
export const MAX_JSON_FLATTEN_DEPTH = 3

const FREETEXT_RATIO_MIN_ROWS = 20
const FREETEXT_UNIQUE_RATIO = 0.9

export const REJECTED_NO_NUMERIC_DATA =
  'no numeric vectors found · expected rows of numbers · json / csv / npy'

// ─── Shared helpers ─────────────────────────────────────────────────────────

function isFiniteNumberString(s: string): boolean {
  if (s.trim() === '') return false
  return Number.isFinite(Number(s))
}

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function zScoreNormalize(values: number[]): number[] {
  const n = values.length
  if (n === 0) return values
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)
  if (std === 0) return values.map(() => 0)
  return values.map((v) => (v - mean) / std)
}

// ─── Categorical classification & encoding ─────────────────────────────────

type ColumnKind = 'numeric' | 'onehot' | 'frequency' | 'freetext'

/**
 * Cardinality-based classification for a column already known not to be
 * numeric. Near-unique columns (almost every value distinct) are treated as
 * free text and skipped — but only once there are enough rows to make that
 * ratio meaningful; small samples fall back to the absolute cutoffs alone.
 */
function classifyNonNumericColumn(values: string[]): ColumnKind {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== '')
  const uniqueCount = new Set(nonEmpty).size
  const rowCount = values.length

  if (uniqueCount === 0) return 'freetext'
  if (uniqueCount > FREQUENCY_MAX_CARDINALITY) return 'freetext'
  if (rowCount >= FREETEXT_RATIO_MIN_ROWS && uniqueCount / rowCount > FREETEXT_UNIQUE_RATIO) {
    return 'freetext'
  }
  if (uniqueCount <= ONEHOT_MAX_CARDINALITY) return 'onehot'
  return 'frequency'
}

/**
 * One-hot via a stable sorted-category map (deterministic — no hashing, no
 * seed needed). Block-scaled by 1/sqrt(categoryCount) so this column's
 * *total* contribution to Euclidean distance (summed across its expanded
 * dims) is comparable to a single unit-variance dimension, not N times
 * larger merely because it expanded into N one-hot columns.
 */
function encodeOneHot(values: string[]): { rows: number[][]; categories: string[] } {
  const trimmed = values.map((v) => v.trim())
  const categories = Array.from(new Set(trimmed.filter((v) => v !== ''))).sort()
  const n = categories.length
  const scale = n > 0 ? 1 / Math.sqrt(n) : 1
  const rows: number[][] = trimmed.map((v) => {
    const row = new Array<number>(n).fill(0)
    const idx = categories.indexOf(v)
    if (idx >= 0) row[idx] = scale
    return row
  })
  return { rows, categories }
}

/** Frequency (proportion of rows sharing this value), then z-score
 *  normalized like any other single numeric-derived column. Deterministic —
 *  a pure function of the data, no hashing/seed involved. */
function encodeFrequency(values: string[]): number[] {
  const trimmed = values.map((v) => v.trim())
  const counts = new Map<string, number>()
  for (const v of trimmed) {
    if (v === '') continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const total = trimmed.filter((v) => v !== '').length || 1
  const raw = trimmed.map((v) => (v === '' ? 0 : (counts.get(v) ?? 0) / total))
  return zScoreNormalize(raw)
}

interface FeatureMatrixResult {
  rows: number[][]
  dim: number
  numericColumns: number
  encoding: EncodingSummary
}

/**
 * Shared column classify+encode core for CSV and JSON (array-of-objects).
 * `columnCells[c]` holds one raw string cell per row for column `c` — every
 * column array must have the same length (`rowCount`).
 */
function buildFeatureMatrix(
  columnNames: string[],
  columnCells: string[][],
  rowCount: number,
): FeatureMatrixResult {
  const totalColumns = columnNames.length
  const kinds: ColumnKind[] = columnCells.map((cells) =>
    cells.every((c) => isFiniteNumberString(c)) ? 'numeric' : classifyNonNumericColumn(cells),
  )

  const numericColumns = kinds.filter((k) => k === 'numeric').length
  const encodedCategoricalColumns = kinds.filter((k) => k === 'onehot' || k === 'frequency').length
  const skippedFreeText = kinds.filter((k) => k === 'freetext').length
  // Only normalize raw numeric columns when they're actually sharing a
  // feature vector with encoded categoricals — a pure-numeric file's
  // values reach the backend exactly as before (backward compatible).
  const mixedPathway = encodedCategoricalColumns > 0

  const outputColumns: number[][] = [] // column-major; each entry has length rowCount
  const encodedColumnInfos: EncodedColumnInfo[] = []

  for (let c = 0; c < totalColumns; c++) {
    const kind = kinds[c]
    const cells = columnCells[c]
    if (kind === 'numeric') {
      const raw = cells.map((v) => Number(v))
      outputColumns.push(mixedPathway ? zScoreNormalize(raw) : raw)
    } else if (kind === 'onehot') {
      const { rows, categories } = encodeOneHot(cells)
      const n = categories.length
      for (let k = 0; k < n; k++) {
        outputColumns.push(rows.map((row) => row[k]))
      }
      encodedColumnInfos.push({ name: columnNames[c], method: 'onehot', categories, outputDims: n })
    } else if (kind === 'frequency') {
      outputColumns.push(encodeFrequency(cells))
      encodedColumnInfos.push({ name: columnNames[c], method: 'frequency', outputDims: 1 })
    }
    // 'freetext' columns contribute nothing.
  }

  const dim = outputColumns.length
  const rows: number[][] = []
  for (let r = 0; r < rowCount; r++) {
    rows.push(outputColumns.map((col) => col[r]))
  }

  const encodedDims = encodedColumnInfos.reduce((sum, c) => sum + c.outputDims, 0)

  return {
    rows,
    dim,
    numericColumns,
    encoding: {
      totalColumns,
      numericColumns,
      encodedCategoricalColumns,
      encodedDims,
      skippedFreeText,
      columns: encodedColumnInfos,
    },
  }
}

/** Shared 'ok' vs 'offer' vs 'rejected' decision once a feature matrix has
 *  been built, given the original column/row accounting. */
function classifyOutcome(
  built: FeatureMatrixResult,
  totalColumns: number,
  droppedRows: number,
): ParseOutcome {
  if (built.dim === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  const matrix: ParsedMatrix = {
    rows: built.rows,
    rowCount: built.rows.length,
    dim: built.dim,
    totalColumns,
    skippedFreeText: built.encoding.skippedFreeText,
    droppedRows,
    encoding: built.encoding,
  }

  if (built.numericColumns === 0) {
    if (built.encoding.encodedCategoricalColumns === 0) {
      return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
    }
    return { kind: 'offer', matrix }
  }

  return { kind: 'ok', matrix }
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Numeric columns are kept as before. Non-numeric columns are no longer
 * simply dropped: bounded-cardinality ones are encoded (one-hot or
 * frequency, see buildFeatureMatrix); only near-unique/free-text columns
 * are skipped. Ragged rows (wrong cell count) are still dropped entirely.
 *
 * Chunked: yields to the event loop every CSV_CHUNK_ROWS rows so a large
 * file's parse can't freeze the UI thread.
 */
export async function parseCsvMatrix(text: string, onProgress?: ParseProgress): Promise<ParseOutcome> {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  const rawRows = lines.map((l) => l.split(',').map((c) => c.trim()))
  const totalColumns = rawRows[0].length

  // An optional non-numeric header row is skipped; a fully-numeric first
  // row is treated as data (no header present).
  const firstRowNumeric = rawRows[0].every((c) => isFiniteNumberString(c))
  const hasHeader = !firstRowNumeric && rawRows.length > 1
  const dataStart = hasHeader ? 1 : 0
  const dataRows = rawRows.slice(dataStart)
  const columnNames = hasHeader
    ? rawRows[0]
    : Array.from({ length: totalColumns }, (_, i) => `col_${String(i)}`)

  if (dataRows.length === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  const rectangularRows = dataRows.filter((r) => r.length === totalColumns)
  const droppedRows = dataRows.length - rectangularRows.length
  if (rectangularRows.length === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  const columnCells: string[][] = Array.from({ length: totalColumns }, (_, c) =>
    rectangularRows.map((r) => r[c]),
  )

  const total = rectangularRows.length
  for (let i = 0; i < total; i++) {
    onProgress?.(i + 1, total)
    if ((i + 1) % CSV_CHUNK_ROWS === 0) await yieldToMainThread()
  }
  await yieldToMainThread() // one more yield before the synchronous classify/encode pass below

  const built = buildFeatureMatrix(columnNames, columnCells, rectangularRows.length)
  return classifyOutcome(built, totalColumns, droppedRows)
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

/**
 * Flattens a nested object to dotted-path keys up to MAX_JSON_FLATTEN_DEPTH.
 * Arrays (at any depth) and objects beyond the depth limit become opaque
 * stringified leaves rather than being recursed into further — a documented
 * simplification, not a general-purpose JSON normalizer.
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix = '',
  depth = 0,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value)
    if (isPlainObject && depth < MAX_JSON_FLATTEN_DEPTH) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, path, depth + 1))
    } else if (isPlainObject || Array.isArray(value)) {
      result[path] = JSON.stringify(value)
    } else {
      result[path] = value
    }
  }
  return result
}

function valueToCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/**
 * Accepts an array of arrays (uniform-length numeric rows — unchanged, no
 * column names to classify categoricals against) or an array of flat/nested
 * objects (numeric fields kept, bounded-cardinality string fields encoded,
 * same rules as CSV). Anything that isn't a non-empty array — including a
 * bare object, which is exactly what a package.json is — is rejected
 * immediately.
 */
export function parseJsonMatrix(text: string): ParseOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  if (Array.isArray(parsed[0])) {
    const rawRows = parsed as unknown[][]
    const totalColumns = rawRows[0].length
    const rectangular = rawRows.filter(
      (r): r is number[] =>
        Array.isArray(r) &&
        r.length === totalColumns &&
        r.every((v) => typeof v === 'number' && Number.isFinite(v)),
    )
    const droppedRows = rawRows.length - rectangular.length

    if (rectangular.length === 0 || totalColumns === 0) {
      return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
    }

    return {
      kind: 'ok',
      matrix: {
        rows: rectangular,
        rowCount: rectangular.length,
        dim: totalColumns,
        totalColumns,
        skippedFreeText: 0,
        droppedRows,
        encoding: {
          totalColumns,
          numericColumns: totalColumns,
          encodedCategoricalColumns: 0,
          encodedDims: 0,
          skippedFreeText: 0,
          columns: [],
        },
      },
    }
  }

  if (typeof parsed[0] === 'object' && parsed[0] !== null) {
    const objs = (parsed as Record<string, unknown>[]).map((o) => flattenObject(o))
    const allKeys = Array.from(new Set(objs.flatMap((o) => Object.keys(o)))).sort()
    const totalColumns = allKeys.length

    if (totalColumns === 0) {
      return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
    }

    const columnCells: string[][] = allKeys.map((k) => objs.map((o) => valueToCell(o[k])))
    const built = buildFeatureMatrix(allKeys, columnCells, objs.length)
    return classifyOutcome(built, totalColumns, 0)
  }

  return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
}

// ─── NPY ──────────────────────────────────────────────────────────────────────

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] // \x93NUMPY

interface NpyDtype {
  bytesPerElement: number
  read: (view: DataView, byteOffset: number) => number
}

const NPY_DTYPES: Record<string, NpyDtype> = {
  '<f8': { bytesPerElement: 8, read: (v, o) => v.getFloat64(o, true) },
  '<f4': { bytesPerElement: 4, read: (v, o) => v.getFloat32(o, true) },
  '<i8': { bytesPerElement: 8, read: (v, o) => Number(v.getBigInt64(o, true)) },
  '<i4': { bytesPerElement: 4, read: (v, o) => v.getInt32(o, true) },
  '<i2': { bytesPerElement: 2, read: (v, o) => v.getInt16(o, true) },
  '<i1': { bytesPerElement: 1, read: (v, o) => v.getInt8(o) },
  '|i1': { bytesPerElement: 1, read: (v, o) => v.getInt8(o) },
  '<u8': { bytesPerElement: 8, read: (v, o) => Number(v.getBigUint64(o, true)) },
  '<u4': { bytesPerElement: 4, read: (v, o) => v.getUint32(o, true) },
  '<u2': { bytesPerElement: 2, read: (v, o) => v.getUint16(o, true) },
  '<u1': { bytesPerElement: 1, read: (v, o) => v.getUint8(o) },
  '|u1': { bytesPerElement: 1, read: (v, o) => v.getUint8(o) },
}

/**
 * Minimal .npy parser: magic bytes + version + header dict (regex-parsed,
 * not a full Python literal evaluator — sufficient for numpy's own
 * save() output). Only 2D, C-order arrays are accepted; Fortran-order and
 * non-2D shapes are rejected explicitly rather than mis-read. No categorical
 * concept applies here — .npy arrays are homogeneous numeric by definition.
 */
export function parseNpyMatrix(buffer: ArrayBuffer): ParseOutcome {
  const rejected: ParseOutcome = { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }

  if (buffer.byteLength < 10) return rejected
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (bytes[i] !== NPY_MAGIC[i]) return rejected
  }

  const majorVersion = bytes[6]
  const headerLenBytes = majorVersion === 1 ? 2 : 4
  const headerLenOffset = 8
  const view = new DataView(buffer)
  const headerLen =
    headerLenBytes === 2 ? view.getUint16(headerLenOffset, true) : view.getUint32(headerLenOffset, true)
  const headerStart = headerLenOffset + headerLenBytes

  if (headerStart + headerLen > buffer.byteLength) return rejected

  const headerStr = new TextDecoder('ascii').decode(bytes.subarray(headerStart, headerStart + headerLen))

  const descrMatch = /'descr':\s*'([^']+)'/.exec(headerStr)
  const fortranMatch = /'fortran_order':\s*(True|False)/.exec(headerStr)
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(headerStr)
  if (!descrMatch || !fortranMatch || !shapeMatch) return rejected

  const dtype = NPY_DTYPES[descrMatch[1]]
  if (!dtype) {
    return { kind: 'rejected', reason: `unsupported npy dtype · ${descrMatch[1]}` }
  }
  if (fortranMatch[1] === 'True') {
    return { kind: 'rejected', reason: 'unsupported npy layout · fortran-order arrays are not supported' }
  }

  const shape = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10))

  if (shape.length !== 2 || shape.some((n) => !Number.isFinite(n) || n <= 0)) {
    return {
      kind: 'rejected',
      reason: `expected a 2d numeric array · got shape [${shape.join(', ')}]`,
    }
  }

  const [rowCount, dim] = shape
  const dataStart = headerStart + headerLen
  const expectedBytes = rowCount * dim * dtype.bytesPerElement
  if (dataStart + expectedBytes > buffer.byteLength) return rejected

  const rows: number[][] = []
  let offset = dataStart
  for (let r = 0; r < rowCount; r++) {
    const row: number[] = []
    for (let c = 0; c < dim; c++) {
      row.push(dtype.read(view, offset))
      offset += dtype.bytesPerElement
    }
    rows.push(row)
  }

  return {
    kind: 'ok',
    matrix: {
      rows,
      rowCount,
      dim,
      totalColumns: dim,
      skippedFreeText: 0,
      droppedRows: 0,
      encoding: {
        totalColumns: dim,
        numericColumns: dim,
        encodedCategoricalColumns: 0,
        encodedDims: 0,
        skippedFreeText: 0,
        columns: [],
      },
    },
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export function detectFormat(filename: string): 'csv' | 'json' | 'npy' | null {
  const name = filename.toLowerCase()
  if (name.endsWith('.csv')) return 'csv'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.npy')) return 'npy'
  return null
}

/**
 * Parses a dropped/selected File based on its extension. Callers should
 * check size against MAX_UPLOAD_BYTES before invoking this (kept separate
 * so the size-limit message can be produced without ever reading the file).
 */
export async function parseFile(file: File, onProgress?: ParseProgress): Promise<ParseOutcome> {
  const format = detectFormat(file.name)
  if (format === 'csv') {
    return parseCsvMatrix(await file.text(), onProgress)
  }
  if (format === 'json') {
    return parseJsonMatrix(await file.text())
  }
  if (format === 'npy') {
    return parseNpyMatrix(await file.arrayBuffer())
  }
  return { kind: 'rejected', reason: 'unsupported file type · expected json / csv / npy' }
}
