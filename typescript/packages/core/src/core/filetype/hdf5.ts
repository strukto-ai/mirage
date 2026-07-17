// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import {
  canonicalType,
  cutColumns,
  ENC,
  grepRows,
  MAX_PREVIEW_ROWS,
  renderSchema,
  renderTable,
  toCsv,
  type SchemaField,
} from './table.ts'

interface H5Group {
  keys(): string[]
  get(name: string): H5Group | H5Dataset
  type: string
}

interface H5Dataset {
  type: 'Dataset'
  shape: number[]
  dtype: string
  value: unknown
}

interface H5File extends H5Group {
  close(): void
}

interface H5Wasm {
  ready: Promise<void>
  FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void }
  File: new (path: string, mode: string) => H5File
}

let h5wasmPromise: Promise<H5Wasm> | null = null

async function loadH5Wasm(): Promise<H5Wasm> {
  h5wasmPromise ??= import('h5wasm').then(async (m: unknown) => {
    // h5wasm namespace has FS, File, Group etc. at the module level.
    // The default export has only a subset (no FS).
    const mod = m as H5Wasm
    await mod.ready
    return mod
  })
  return h5wasmPromise
}

function isDataset(v: H5Group | H5Dataset): v is H5Dataset {
  return v.type === 'Dataset'
}

interface Frame {
  columns: string[]
  dtypes: string[]
  rows: Record<string, unknown>[]
}

function decodeString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder().decode(v).replace(/\0+$/, '')
  return String(v)
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (
    v instanceof Int8Array ||
    v instanceof Uint8Array ||
    v instanceof Int16Array ||
    v instanceof Uint16Array ||
    v instanceof Int32Array ||
    v instanceof Uint32Array ||
    v instanceof Float32Array ||
    v instanceof Float64Array ||
    v instanceof BigInt64Array ||
    v instanceof BigUint64Array
  ) {
    return Array.from(v as ArrayLike<unknown>)
  }
  return [v]
}

function reshape2D(flat: unknown[], rows: number, cols: number): unknown[][] {
  const out: unknown[][] = []
  for (let r = 0; r < rows; r++) {
    const row: unknown[] = []
    for (let c = 0; c < cols; c++) row.push(flat[r * cols + c])
    out.push(row)
  }
  return out
}

// Pandas stores `object` (string) columns in HDF5 as a pickled numpy array.
// h5wasm surfaces that as a single `Uint8Array` with `dtype="unknown"`. Python
// round-trips via `pandas.read_hdf`; JS has no pandas equivalent, so we scan
// the pickle stream for SHORT_BINUNICODE / BINUNICODE / BINUNICODE8 opcodes,
// pull out every embedded UTF-8 string, then return the last N where N is the
// expected row count — those are the user data values. The earlier strings are
// class paths ("numpy._core.multiarray", "_reconstruct", dtype specs, etc.).
function extractPickledStrings(bytes: Uint8Array, expectedCount: number): string[] | null {
  if (bytes.byteLength < 2 || bytes[0] !== 0x80) return null
  const dec = new TextDecoder()
  const out: string[] = []
  let i = 2 // skip PROTO opcode + version byte
  while (i < bytes.byteLength) {
    const op = bytes[i]
    if (op === undefined) break
    if (op === 0x8c) {
      // SHORT_BINUNICODE: 1-byte length
      const len = bytes[i + 1] ?? 0
      const start = i + 2
      const end = start + len
      if (end > bytes.byteLength) break
      out.push(dec.decode(bytes.subarray(start, end)))
      i = end
      continue
    }
    if (op === 0x8d) {
      // BINUNICODE8: 8-byte little-endian length
      const view = new DataView(bytes.buffer, bytes.byteOffset + i + 1, 8)
      const len = Number(view.getBigUint64(0, true))
      const start = i + 9
      const end = start + len
      if (end > bytes.byteLength) break
      out.push(dec.decode(bytes.subarray(start, end)))
      i = end
      continue
    }
    if (op === 0x8e) {
      // BINBYTES / BINUNICODE: 4-byte little-endian length
      const view = new DataView(bytes.buffer, bytes.byteOffset + i + 1, 4)
      const len = view.getUint32(0, true)
      const start = i + 5
      const end = start + len
      if (end > bytes.byteLength) break
      out.push(dec.decode(bytes.subarray(start, end)))
      i = end
      continue
    }
    i += 1
  }
  if (out.length < expectedCount) return null
  return out.slice(out.length - expectedCount)
}

function readPandasHdf5(group: H5Group): Frame | null {
  const keys = group.keys()
  if (!keys.includes('axis0')) return null
  const axis0 = group.get('axis0') as H5Dataset
  const columns = asArray(axis0.value).map(decodeString)
  const dtypes: string[] = new Array<string>(columns.length).fill('?')
  const columnData: Record<string, unknown[]> = {}
  let numRows = 0

  let blockIdx = 0
  // Discover row count from a non-pickled block first — pickled object blocks
  // report shape=[1] instead of the real row count.
  const axis1Keys = keys.includes('axis1') ? asArray((group.get('axis1') as H5Dataset).value) : []
  numRows = axis1Keys.length
  while (keys.includes(`block${String(blockIdx)}_items`)) {
    const items = group.get(`block${String(blockIdx)}_items`) as H5Dataset
    const values = group.get(`block${String(blockIdx)}_values`) as H5Dataset
    const colNames = asArray(items.value).map(decodeString)

    // Pandas pickled object column: dtype="unknown", value is a single
    // Uint8Array pickle blob. Unpack by scanning for embedded strings.
    const rawVal = values.value
    const rawArr = Array.isArray(rawVal) ? rawVal : null
    const pickled =
      values.dtype === 'unknown' &&
      rawArr !== null &&
      rawArr.length === 1 &&
      rawArr[0] instanceof Uint8Array
        ? extractPickledStrings(rawArr[0], numRows * colNames.length)
        : null

    if (pickled !== null) {
      // One block may pack multiple object columns; the extracted strings are
      // laid out column-major like the numeric blocks (row-major reshape with
      // cols = colNames.length).
      const matrix = reshape2D(pickled, numRows, colNames.length)
      for (let c = 0; c < colNames.length; c++) {
        const name = colNames[c]
        if (name === undefined) continue
        const colValues: unknown[] = []
        for (let r = 0; r < numRows; r++) {
          const row = matrix[r] ?? []
          colValues.push(row[c])
        }
        columnData[name] = colValues
        const idx = columns.indexOf(name)
        if (idx >= 0) dtypes[idx] = 'str'
      }
      blockIdx += 1
      continue
    }

    const shape = values.shape
    const rowCount = shape[0] ?? 0
    const colCount = shape[1] ?? colNames.length
    numRows = Math.max(numRows, rowCount)
    const flat = asArray(values.value)
    const matrix = reshape2D(flat, rowCount, colCount)
    for (let c = 0; c < colNames.length; c++) {
      const name = colNames[c]
      if (name === undefined) continue
      const colValues: unknown[] = []
      for (let r = 0; r < rowCount; r++) {
        const row = matrix[r] ?? []
        colValues.push(row[c])
      }
      columnData[name] = colValues
      const idx = columns.indexOf(name)
      if (idx >= 0) dtypes[idx] = values.dtype
    }
    blockIdx += 1
  }

  if (Object.keys(columnData).length === 0) return null

  const rows: Record<string, unknown>[] = []
  for (let r = 0; r < numRows; r++) {
    const row: Record<string, unknown> = {}
    for (const c of columns) {
      const arr = columnData[c]
      if (arr !== undefined) row[c] = arr[r]
    }
    rows.push(row)
  }
  return { columns, dtypes, rows }
}

function readGeneric(group: H5Group): Frame {
  const keys = group.keys()
  if (keys.length === 0) throw new Error('no datasets found in HDF5 file')
  const first = keys[0]
  if (first === undefined) throw new Error('no datasets found in HDF5 file')
  const item = group.get(first)
  if (!isDataset(item)) {
    if (item.type === 'Group') {
      const pandas = readPandasHdf5(item)
      if (pandas !== null) return pandas
    }
    throw new Error('unsupported HDF5 dataset structure')
  }
  const shape = item.shape
  const rowCount = shape[0] ?? 0
  const colCount = shape[1] ?? 1
  const columns = Array.from({ length: colCount }, (_, i) => `col${String(i)}`)
  const flat = asArray(item.value)
  const matrix = shape.length === 2 ? reshape2D(flat, rowCount, colCount) : flat.map((v) => [v])
  const rows: Record<string, unknown>[] = []
  for (let r = 0; r < rowCount; r++) {
    const row: Record<string, unknown> = {}
    for (let c = 0; c < colCount; c++) {
      const col = columns[c]
      if (col === undefined) continue
      row[col] = (matrix[r] ?? [])[c]
    }
    rows.push(row)
  }
  return { columns, dtypes: columns.map(() => item.dtype), rows }
}

let tmpCounter = 0

async function readFrame(raw: Uint8Array): Promise<Frame> {
  const h5 = await loadH5Wasm()
  const name = `__hdf5_${String(tmpCounter++)}.h5`
  h5.FS.writeFile(name, raw)
  const file = new h5.File(name, 'r')
  try {
    const keys = file.keys()
    if (keys.length === 0) throw new Error('no datasets found in HDF5 file')
    // Try pandas layout first
    const first = keys[0]
    if (first === undefined) throw new Error('no datasets found in HDF5 file')
    const item = file.get(first)
    if (item.type === 'Group') {
      const pandas = readPandasHdf5(item)
      if (pandas !== null) return pandas
      return readGeneric(item)
    }
    return readGeneric(file)
  } finally {
    file.close()
    try {
      h5.FS.unlink(name)
    } catch {
      // best-effort
    }
  }
}

// Translate numpy dtype codes (returned by h5wasm) to the friendly names
// Python's h5py/pandas stack prints. Byte-order prefixes (`<`, `>`, `=`, `|`)
// are stripped before the lookup.
const DTYPE_NAMES: Record<string, string> = {
  b: 'int8',
  B: 'uint8',
  h: 'int16',
  H: 'uint16',
  i: 'int32',
  I: 'uint32',
  l: 'int32',
  L: 'uint32',
  q: 'int64',
  Q: 'uint64',
  e: 'float16',
  f: 'float32',
  d: 'float64',
  g: 'float128',
  '?': 'bool',
  O: 'object',
}

function friendlyDtype(code: string | undefined): string {
  if (code === undefined || code === '') return '?'
  const stripped = code.replace(/^[<>=|]/, '')
  if (stripped.startsWith('S')) return 'bytes'
  if (stripped.startsWith('U')) return 'str'
  const mapped = DTYPE_NAMES[stripped]
  if (mapped !== undefined) return mapped
  return code
}

function fieldsFromFrame(frame: Frame): SchemaField[] {
  return frame.columns.map((c, i) => ({
    name: c,
    type: canonicalType(friendlyDtype(frame.dtypes[i])),
  }))
}

export async function describe(raw: Uint8Array): Promise<string> {
  const frame = await readFrame(raw)
  const fields = fieldsFromFrame(frame)
  const cols = fields.map((f) => `${f.name}: ${f.type}`).join(', ')
  return `hdf5, ${String(frame.rows.length)} rows, ${String(fields.length)} columns (${cols})`
}

export async function cat(raw: Uint8Array, maxRows = MAX_PREVIEW_ROWS): Promise<Uint8Array> {
  const frame = await readFrame(raw)
  const numRows = frame.rows.length
  const previewCount = Math.min(numRows, maxRows)
  const rows = frame.rows.slice(0, previewCount)
  const fields = fieldsFromFrame(frame)
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
    ...renderTable(rows, 'Preview', previewCount),
  ]
  return ENC.encode(lines.join('\n'))
}

export async function head(raw: Uint8Array, n = 10): Promise<Uint8Array> {
  const frame = await readFrame(raw)
  const numRows = frame.rows.length
  const rowsNeeded = Math.min(n, numRows)
  const rows = frame.rows.slice(0, rowsNeeded)
  const fields = fieldsFromFrame(frame)
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
    ...renderTable(rows, `First ${String(rowsNeeded)}`, rowsNeeded),
  ]
  return ENC.encode(lines.join('\n'))
}

export async function tail(raw: Uint8Array, n = 10): Promise<Uint8Array> {
  const frame = await readFrame(raw)
  const numRows = frame.rows.length
  const rowsNeeded = Math.min(n, numRows)
  const rows = frame.rows.slice(Math.max(0, numRows - rowsNeeded))
  const fields = fieldsFromFrame(frame)
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
    ...renderTable(rows, `Last ${String(rowsNeeded)}`, rowsNeeded),
  ]
  return ENC.encode(lines.join('\n'))
}

export async function wc(raw: Uint8Array): Promise<number> {
  const frame = await readFrame(raw)
  return frame.rows.length
}

export async function stat(raw: Uint8Array): Promise<Uint8Array> {
  const frame = await readFrame(raw)
  const fields = fieldsFromFrame(frame)
  const lines = [
    '# HDF5 file',
    `rows: ${String(frame.rows.length)}`,
    `columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
  ]
  return ENC.encode(lines.join('\n'))
}

export async function grep(
  raw: Uint8Array,
  pattern: string,
  ignoreCase = false,
): Promise<Uint8Array> {
  const frame = await readFrame(raw)
  return toCsv(grepRows(frame.rows, pattern, ignoreCase))
}

export async function cut(raw: Uint8Array, columns: readonly string[]): Promise<Uint8Array> {
  const frame = await readFrame(raw)
  return toCsv(cutColumns(frame.rows, frame.columns, columns))
}
