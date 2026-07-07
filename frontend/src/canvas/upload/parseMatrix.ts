/**
 * parseMatrix — dependency-free parsers turning a dropped file's raw content
 * into a rectangular numeric matrix, or an honest rejection reason.
 *
 * Replaces the previous "reinterpret every file's raw bytes as Float32"
 * behavior (see docs/idealization_report.md, 2026-07-07 sprint, Phase 0) —
 * these parsers actually read the declared file format.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedMatrix {
  /** Rectangular numeric matrix, row-major: rows[i][j]. */
  rows: number[][]
  rowCount: number
  /** Number of columns actually kept (after dropping non-numeric ones). */
  dim: number
  /** Number of columns present in the source before any were dropped. */
  totalColumns: number
  droppedColumns: number
  droppedRows: number
}

export type ParseOutcome = { kind: 'ok'; matrix: ParsedMatrix } | { kind: 'rejected'; reason: string }

export type ParseProgress = (rowsParsed: number, totalRows: number) => void

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB

/** Rows processed per chunk before yielding back to the main thread. */
export const CSV_CHUNK_ROWS = 2000

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

// ─── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Column-wise numeric filter: a column is kept only if every rectangular
 * (correct cell-count) row parses as a finite number in that position.
 * Ragged rows (wrong cell count) are dropped entirely, not padded.
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
  const dataStart = !firstRowNumeric && rawRows.length > 1 ? 1 : 0
  const dataRows = rawRows.slice(dataStart)

  if (dataRows.length === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  const rectangularRows = dataRows.filter((r) => r.length === totalColumns)
  const droppedRows = dataRows.length - rectangularRows.length

  const keepColumn: boolean[] = []
  for (let c = 0; c < totalColumns; c++) {
    keepColumn.push(rectangularRows.every((r) => isFiniteNumberString(r[c])))
  }
  const dim = keepColumn.filter(Boolean).length
  const droppedColumns = totalColumns - dim

  if (dim === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  const rows: number[][] = []
  const total = rectangularRows.length
  for (let i = 0; i < rectangularRows.length; i++) {
    const r = rectangularRows[i]
    const kept: number[] = []
    for (let c = 0; c < totalColumns; c++) {
      if (keepColumn[c]) kept.push(Number(r[c]))
    }
    rows.push(kept)
    onProgress?.(i + 1, total)
    if ((i + 1) % CSV_CHUNK_ROWS === 0) await yieldToMainThread()
  }

  if (rows.length === 0) {
    return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
  }

  return {
    kind: 'ok',
    matrix: { rows, rowCount: rows.length, dim, totalColumns, droppedColumns, droppedRows },
  }
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

/**
 * Accepts an array of arrays (uniform-length numeric rows) or an array of
 * flat objects (numeric fields kept column-wise, same drop semantics as
 * CSV). Anything that isn't a non-empty array — including a bare object,
 * which is exactly what a package.json is — is rejected immediately.
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
        droppedColumns: 0,
        droppedRows,
      },
    }
  }

  if (typeof parsed[0] === 'object' && parsed[0] !== null) {
    const objs = parsed as Record<string, unknown>[]
    const allKeys = Array.from(new Set(objs.flatMap((o) => Object.keys(o))))
    const totalColumns = allKeys.length
    const keepKeys = allKeys.filter((k) =>
      objs.every((o) => typeof o[k] === 'number' && Number.isFinite(o[k] as number)),
    )
    const droppedColumns = totalColumns - keepKeys.length

    if (keepKeys.length === 0) {
      return { kind: 'rejected', reason: REJECTED_NO_NUMERIC_DATA }
    }

    const rows = objs.map((o) => keepKeys.map((k) => o[k] as number))
    return {
      kind: 'ok',
      matrix: {
        rows,
        rowCount: rows.length,
        dim: keepKeys.length,
        totalColumns,
        droppedColumns,
        droppedRows: 0,
      },
    }
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
 * non-2D shapes are rejected explicitly rather than mis-read.
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
    matrix: { rows, rowCount, dim, totalColumns: dim, droppedColumns: 0, droppedRows: 0 },
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
