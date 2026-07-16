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

import { tableFromIPC, type Table } from 'apache-arrow'
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

function readTable(raw: Uint8Array): Table {
  return tableFromIPC(raw) as unknown as Table
}

function schemaFields(table: Table): SchemaField[] {
  return table.schema.fields.map((f) => ({ name: f.name, type: canonicalType(String(f.type)) }))
}

function tableRows(table: Table, start = 0, end?: number): Record<string, unknown>[] {
  const rows = table.toArray() as Record<string, unknown>[]
  return end !== undefined ? rows.slice(start, end) : rows.slice(start)
}

export function describe(raw: Uint8Array): string {
  const table = readTable(raw)
  const fields = schemaFields(table)
  const cols = fields.map((f) => `${f.name}: ${f.type}`).join(', ')
  return `feather, ${String(table.numRows)} rows, ${String(fields.length)} columns (${cols})`
}

export function cat(raw: Uint8Array, maxRows = MAX_PREVIEW_ROWS): Uint8Array {
  const table = readTable(raw)
  const numRows = table.numRows
  const previewCount = Math.min(numRows, maxRows)
  const rows = tableRows(table, 0, previewCount)
  const fields = schemaFields(table)
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
    ...renderTable(rows, 'Preview', previewCount),
  ]
  return ENC.encode(lines.join('\n'))
}

export function head(raw: Uint8Array, n = 10): Uint8Array {
  const table = readTable(raw)
  const numRows = table.numRows
  const rowsNeeded = Math.min(n, numRows)
  const rows = tableRows(table, 0, rowsNeeded)
  const fields = schemaFields(table)
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
    ...renderTable(rows, `First ${String(rowsNeeded)}`, rowsNeeded),
  ]
  return ENC.encode(lines.join('\n'))
}

export function tail(raw: Uint8Array, n = 10): Uint8Array {
  const table = readTable(raw)
  const numRows = table.numRows
  const rowsNeeded = Math.min(n, numRows)
  const start = Math.max(0, numRows - rowsNeeded)
  const rows = tableRows(table, start, numRows)
  const fields = schemaFields(table)
  const lines = [
    `# Rows: ${String(numRows)}, Columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
    ...renderTable(rows, `Last ${String(rowsNeeded)}`, rowsNeeded),
  ]
  return ENC.encode(lines.join('\n'))
}

export function wc(raw: Uint8Array): number {
  return readTable(raw).numRows
}

export function ls(
  raw: Uint8Array,
  meta: { size: number; modified: string | null; name: string },
): Uint8Array {
  const table = readTable(raw)
  const rows = table.numRows
  const cols = schemaFields(table).length
  const line = `feather\t${String(meta.size)}\t${String(rows)} rows\t${String(cols)} cols\t${meta.modified ?? ''}\t${meta.name}`
  return ENC.encode(line)
}

export function lsFallback(meta: {
  size: number
  modified: string | null
  name: string
}): Uint8Array {
  return ENC.encode(`feather\t${String(meta.size)}\t\t\t${meta.modified ?? ''}\t${meta.name}`)
}

export function stat(raw: Uint8Array): Uint8Array {
  const table = readTable(raw)
  const fields = schemaFields(table)
  const lines = [
    '# Feather file',
    `rows: ${String(table.numRows)}`,
    `columns: ${String(fields.length)}`,
    '',
    ...renderSchema(fields),
    '',
  ]
  return ENC.encode(lines.join('\n'))
}

export function grep(raw: Uint8Array, pattern: string, ignoreCase = false): Uint8Array {
  const rows = tableRows(readTable(raw))
  return toCsv(grepRows(rows, pattern, ignoreCase))
}

export function cut(raw: Uint8Array, columns: readonly string[]): Uint8Array {
  const table = readTable(raw)
  const schemaNames = schemaFields(table).map((f) => f.name)
  const rows = tableRows(table)
  return toCsv(cutColumns(rows, schemaNames, columns))
}
