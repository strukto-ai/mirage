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

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
}

export function parseSize(text: string): number {
  const last = text.at(-1) ?? ''
  const unit = SIZE_UNITS[last]
  if (unit !== undefined) return Math.round(parseFloat(text.slice(0, -1)) * unit)
  return parseInt(text, 10)
}

function formatSize(size: number, human: boolean): string {
  return human ? humanSize(size) : String(size)
}

// Strip each run's own total row and emit one global total. Every native run
// receives `-c` so glob operands total natively; the per-run totals (always
// the last row) are removed and re-summed.
export function duTotal(results: OperandRun[], human: boolean): Uint8Array {
  const kept: string[] = []
  let total = 0
  for (const run of results) {
    let body = DEC.decode(run.data)
      .split('\n')
      .filter((l) => l !== '')
    const last = body.at(-1)
    if (last?.endsWith('\ttotal') === true) {
      total += parseSize(last.slice(0, last.lastIndexOf('\t')))
      body = body.slice(0, -1)
    }
    kept.push(...body)
  }
  kept.push(`${formatSize(total, human)}\ttotal`)
  return ENC.encode(kept.join('\n') + '\n')
}
