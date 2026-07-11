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

const ENC = new TextEncoder()

export const MAX_PREVIEW_ROWS = 20

export interface SchemaField {
  name: string
  type: string
}

export function renderSchema(fields: readonly SchemaField[]): string[] {
  const lines = ['## Schema']
  for (const field of fields) lines.push(`  ${field.name}: ${field.type}`)
  return lines
}

export function renderTable(
  rows: readonly Record<string, unknown>[],
  label: string,
  count: number,
): string[] {
  const lines = [`## ${label} (${String(count)} rows)`, '']
  if (rows.length === 0) {
    lines.push('(empty)')
    lines.push('')
    return lines
  }
  const cols = Object.keys(rows[0] ?? {})
  const widths: Record<string, number> = {}
  for (const c of cols) widths[c] = c.length
  const rendered: string[][] = []
  for (const row of rows) {
    const cells = cols.map((c) => formatCell(row[c]))
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i] ?? ''
      const cell = cells[i] ?? ''
      widths[col] = Math.max(widths[col] ?? 0, cell.length)
    }
    rendered.push(cells)
  }
  lines.push(cols.map((c) => c.padStart(widths[c] ?? 0)).join(' '))
  for (const cells of rendered) {
    lines.push(
      cells
        .map((cell, i) => {
          const col = cols[i] ?? ''
          return cell.padStart(widths[col] ?? 0)
        })
        .join(' '),
    )
  }
  lines.push('')
  return lines
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return `<${String(v.byteLength)}B>`
  return JSON.stringify(v)
}

export function toCsv(rows: readonly Record<string, unknown>[]): Uint8Array {
  if (rows.length === 0) return new Uint8Array(0)
  const cols = Object.keys(rows[0] ?? {})
  const lines = [cols.join(',')]
  for (const row of rows) lines.push(cols.map((c) => csvEscape(row[c])).join(','))
  return ENC.encode(lines.join('\n') + '\n')
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'bigint' ? String(v) : typeof v === 'string' ? v : JSON.stringify(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function grepRows(
  rows: readonly Record<string, unknown>[],
  pattern: string,
  ignoreCase: boolean,
): Record<string, unknown>[] {
  const re = new RegExp(pattern, ignoreCase ? 'i' : '')
  return rows.filter((row) => Object.values(row).some((v) => typeof v === 'string' && re.test(v)))
}

export function cutColumns(
  rows: readonly Record<string, unknown>[],
  schemaNames: readonly string[],
  columns: readonly string[],
): Record<string, unknown>[] {
  for (const col of columns) {
    if (!schemaNames.includes(col)) throw new Error(`column not found: ${col}`)
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const c of columns) out[c] = row[c]
    return out
  })
}

export { ENC }
