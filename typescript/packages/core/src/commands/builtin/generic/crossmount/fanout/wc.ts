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

import { formatWcLines, type WcRow } from '../../wc.ts'
import type { OperandRun } from '../types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function parseWcRow(line: string, columns: number): WcRow {
  const parts = line.trim().split(/\s+/)
  const values = parts.slice(0, columns).map((v) => parseInt(v, 10))
  const label = parts.slice(columns).join(' ')
  return { values, label: label === '' ? null : label }
}

// Re-total per-operand wc rows with one shared column width. Each native run
// right-aligns its own rows, so the runs cannot simply concatenate: rows are
// re-parsed and the whole report (plus the global `total` row, where max line
// length maxes instead of summing) is reformatted by the same wc formatter
// the single-mount command uses.
export function combineWc(
  results: OperandRun[],
  flagKwargs: Record<string, string | boolean | string[]>,
): Uint8Array {
  const single =
    flagKwargs.args_l === true ||
    flagKwargs.w === true ||
    flagKwargs.c === true ||
    flagKwargs.m === true ||
    flagKwargs.L === true
  const columns = single ? 1 : 3
  const maxMode = flagKwargs.L === true
  const rows: WcRow[] = []
  for (const run of results) {
    let body = DEC.decode(run.data)
      .split('\n')
      .filter((l) => l !== '')
    if (body.length > 1) body = body.slice(0, -1)
    for (const line of body) rows.push(parseWcRow(line, columns))
  }
  if (rows.length === 0) return new Uint8Array()
  const total: number[] = new Array<number>(columns).fill(0)
  for (const row of rows) {
    for (let i = 0; i < columns; i++) {
      const v = row.values[i] ?? 0
      total[i] = maxMode ? Math.max(total[i] ?? 0, v) : (total[i] ?? 0) + v
    }
  }
  const lines = formatWcLines([...rows, { values: total, label: 'total' }])
  return ENC.encode(lines.join('\n') + '\n')
}
