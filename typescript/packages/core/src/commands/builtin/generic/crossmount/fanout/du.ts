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

import { humanSize } from '../../../utils/formatting.ts'
import type { OperandRun } from '../types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function formatSize(size: number, human: boolean): string {
  return human ? humanSize(size) : String(size)
}

function humanizeRow(line: string): string {
  const tab = line.indexOf('\t')
  if (tab < 0) return line
  return `${humanSize(Number(line.slice(0, tab)))}\t${line.slice(tab + 1)}`
}

// Strip each run's own total row and emit one global total. Every native run
// receives `-c` so glob operands total natively; the per-run totals (always
// the last row) are removed and re-summed.
//
// `runFanout` forces the native runs to report exact bytes even under `-h`,
// and the sizes are humanized here instead. Summing each run's already
// humanized total would round twice, so two 1500-byte operands read back as
// 1536 each and report `3.0K` where one mount says `2.9K`. Per-run totals
// cannot be replaced by summing the rows either: without `-a` a run prints a
// row per directory, and those nest.
export function duTotal(results: OperandRun[], human: boolean): Uint8Array {
  const kept: string[] = []
  let total = 0
  for (const run of results) {
    let body = DEC.decode(run.data)
      .split('\n')
      .filter((l) => l !== '')
    const last = body.at(-1)
    if (last?.endsWith('\ttotal') === true) {
      total += Number(last.slice(0, last.lastIndexOf('\t')))
      body = body.slice(0, -1)
    }
    kept.push(...(human ? body.map(humanizeRow) : body))
  }
  kept.push(`${formatSize(total, human)}\ttotal`)
  return ENC.encode(kept.join('\n') + '\n')
}
