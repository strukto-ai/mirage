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

import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import {
  canonicalType,
  ENC,
  MAX_PREVIEW_ROWS,
  renderSchema,
  renderTable,
  toCsv,
  grepRows,
  cutColumns,
  type SchemaField as CanonField,
} from './table.ts'

interface SchemaField {
  name: string
  type?: string
  num_children?: number
  repetition_type?: string
}

interface ParquetMetadata {
  num_rows: number | bigint
  row_groups: { num_rows: number | bigint; total_byte_size?: number | bigint }[]
  schema: SchemaField[]
  version?: number
  created_by?: string
}

function toArrayBuffer(raw: Uint8Array): ArrayBuffer {
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
}

function asNumber(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v
}

function fieldColumns(schema: readonly SchemaField[]): SchemaField[] {
  // First element is root; rest are leaf columns (simplified — no nested schemas).
  return schema.slice(1)
}

function canonFields(schema: readonly SchemaField[]): CanonField[] {
  return fieldColumns(schema).map((f) => ({
    name: f.name,
    type: canonicalType(f.type ?? 'UNKNOWN'),
  }))
}

function columnNames(schema: readonly SchemaField[]): string[] {
  return fieldColumns(schema).map((f) => f.name)
}

function readMeta(raw: Uint8Array): ParquetMetadata {
  return parquetMetadata(toArrayBuffer(raw)) as unknown as ParquetMetadata
}

async function readRows(
  raw: Uint8Array,
  rowStart = 0,
  rowEnd?: number,
): Promise<Record<string, unknown>[]> {
  const ab = toArrayBuffer(raw)
  const options: Record<string, unknown> = { file: ab }
  if (rowStart > 0) options.rowStart = rowStart
  if (rowEnd !== undefined) options.rowEnd = rowEnd
  const rows = (await parquetReadObjects(options as never)) as Record<string, unknown>[]
  return rows
}

export function describe(raw: Uint8Array): string {
  const meta = readMeta(raw)
  const fields = canonFields(meta.schema)
  const cols = fields.map((f) => `${f.name}: ${f.type}`).join(', ')
  return `parquet, ${String(asNumber(meta.num_rows))} rows, ${String(fields.length)} columns (${cols})`
}

export async function cat(raw: Uint8Array, maxRows = MAX_PREVIEW_ROWS): Promise<Uint8Array> {
  const meta = readMeta(raw)
  const numRows = asNumber(meta.num_rows)
  const previewCount = Math.min(numRows, maxRows)
  const rows = previewCount > 0 ? await readRows(raw, 0, previewCount) : []
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fieldColumns(meta.schema).length)}`,
    '',
    ...renderSchema(canonFields(meta.schema)),
    '',
    ...renderTable(rows, 'Preview', previewCount),
  ]
  return ENC.encode(lines.join('\n'))
}

export async function head(raw: Uint8Array, n = 10): Promise<Uint8Array> {
  const meta = readMeta(raw)
  const numRows = asNumber(meta.num_rows)
  const rowsNeeded = Math.min(n, numRows)
  const rows = rowsNeeded > 0 ? await readRows(raw, 0, rowsNeeded) : []
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fieldColumns(meta.schema).length)}`,
    '',
    ...renderSchema(canonFields(meta.schema)),
    '',
    ...renderTable(rows, `First ${String(rowsNeeded)}`, rowsNeeded),
  ]
  return ENC.encode(lines.join('\n'))
}

export async function tail(raw: Uint8Array, n = 10): Promise<Uint8Array> {
  const meta = readMeta(raw)
  const numRows = asNumber(meta.num_rows)
  const rowsNeeded = Math.min(n, numRows)
  const start = Math.max(0, numRows - rowsNeeded)
  const rows = rowsNeeded > 0 ? await readRows(raw, start, numRows) : []
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fieldColumns(meta.schema).length)}`,
    '',
    ...renderSchema(canonFields(meta.schema)),
    '',
    ...renderTable(rows, `Last ${String(rowsNeeded)}`, rowsNeeded),
  ]
  return ENC.encode(lines.join('\n'))
}

export function ls(
  raw: Uint8Array,
  meta: { size: number; modified: string | null; name: string },
): Uint8Array {
  const pq = readMeta(raw)
  const rows = asNumber(pq.num_rows)
  const cols = fieldColumns(pq.schema).length
  const line = `parquet\t${String(meta.size)}\t${String(rows)} rows\t${String(cols)} cols\t${meta.modified ?? ''}\t${meta.name}`
  return ENC.encode(line)
}

export function lsFallback(meta: {
  size: number
  modified: string | null
  name: string
}): Uint8Array {
  return ENC.encode(`parquet\t${String(meta.size)}\t\t\t${meta.modified ?? ''}\t${meta.name}`)
}

export function wc(raw: Uint8Array): number {
  return asNumber(readMeta(raw).num_rows)
}

export function stat(raw: Uint8Array): Uint8Array {
  const meta = readMeta(raw)
  const lines = [
    '# Parquet file',
    `rows: ${String(asNumber(meta.num_rows))}`,
    `columns: ${String(fieldColumns(meta.schema).length)}`,
    `row_groups: ${String(meta.row_groups.length)}`,
    meta.version !== undefined ? `format_version: ${String(meta.version)}` : '',
    meta.created_by !== undefined ? `created_by: ${meta.created_by}` : '',
    '',
    ...renderSchema(canonFields(meta.schema)),
    '',
  ]
  for (let i = 0; i < meta.row_groups.length; i++) {
    const rg = meta.row_groups[i]
    if (rg === undefined) continue
    lines.push(`## Row group ${String(i)}`)
    lines.push(`  rows: ${String(asNumber(rg.num_rows))}`)
    if (rg.total_byte_size !== undefined) {
      lines.push(`  total_byte_size: ${String(asNumber(rg.total_byte_size))}`)
    }
  }
  lines.push('')
  return ENC.encode(lines.join('\n'))
}

export async function grep(
  raw: Uint8Array,
  pattern: string,
  ignoreCase = false,
): Promise<Uint8Array> {
  const rows = await readRows(raw)
  return toCsv(grepRows(rows, pattern, ignoreCase))
}

export async function cut(raw: Uint8Array, columns: readonly string[]): Promise<Uint8Array> {
  const meta = readMeta(raw)
  const rows = await readRows(raw)
  return toCsv(cutColumns(rows, columnNames(meta.schema), columns))
}
