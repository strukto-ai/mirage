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

import type { ByteSource } from '../../../../../io/types.ts'
import { formatCountRows, parseFlags, type WcRow } from '../../wc.ts'
import type { OperandRun } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

function parseWcRow(line: string, columns: number): WcRow {
  const parts = line.trim().split(/\s+/)
  const values = parts.slice(0, columns).map((v) => parseInt(v, 10))
  const label = parts.slice(columns).join(' ')
  return { values, label: label === '' ? null : label }
}

// Re-total per-operand wc rows with one shared column width. Each native run
// right-aligns its own rows against its own widest count, so the runs cannot
// simply concatenate: rows are re-parsed and the whole report is reformatted
// by the same formatter the single-mount command uses, which is also what
// applies `--total`. `runFanout` forces the native runs to `--total=never`,
// so every line read here is a file row and the grand total below is the only
// one the report can carry.
export function combineWc(
  results: OperandRun[],
  flagKwargs: Record<string, FlagValue>,
): ByteSource | null {
  const parsed = parseFlags(flagKwargs)
  if (typeof parsed === 'string') return null
  const single =
    parsed.lines || parsed.words || parsed.bytes || parsed.chars || parsed.maxLineLength
  const columns = single ? 1 : 3
  const rows: WcRow[] = []
  const total: number[] = new Array<number>(columns).fill(0)
  for (const run of results) {
    for (const line of DEC.decode(run.data).split('\n')) {
      if (line === '') continue
      const row = parseWcRow(line, columns)
      rows.push(row)
      for (let i = 0; i < columns; i++) {
        const v = row.values[i] ?? 0
        total[i] = parsed.maxLineLength ? Math.max(total[i] ?? 0, v) : (total[i] ?? 0) + v
      }
    }
  }
  // GNU decides the auto total on the operands *given*, not on the rows that
  // resolved, so a missing operand still gets a total row. There are always at
  // least two scopes here, and a glob operand can expand to more.
  return formatCountRows(rows, total, Math.max(rows.length, results.length), parsed.total)
}
