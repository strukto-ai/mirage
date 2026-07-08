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

import { Cmd, type OperandRun } from '../types.ts'

const ENC = new TextEncoder()

// grep-style: an error (2) dominates, then any match wins (0), then no-match
// (1). Everything else: worst operand wins.
export function combinedExit(cmdName: Cmd, codes: number[]): number {
  if (cmdName === Cmd.GREP || cmdName === Cmd.RG) {
    if (codes.some((c) => c > 1)) return Math.max(...codes)
    if (codes.includes(0)) return 0
    return codes.length > 0 ? Math.max(...codes) : 0
  }
  return codes.length > 0 ? Math.max(...codes) : 0
}

export function concatRuns(results: OperandRun[]): Uint8Array {
  const nonEmpty = results.map((r) => r.data).filter((d) => d.byteLength > 0)
  const size = nonEmpty.reduce((n, d) => n + d.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const d of nonEmpty) {
    out.set(d, offset)
    offset += d.byteLength
  }
  return out
}

export function joinRunsWithBlankLine(results: OperandRun[]): Uint8Array {
  const parts = results.map((r) => r.data).filter((d) => d.byteLength > 0)
  const sep = ENC.encode('\n')
  const size =
    parts.reduce((n, d) => n + d.byteLength, 0) + sep.byteLength * Math.max(0, parts.length - 1)
  const out = new Uint8Array(size)
  let offset = 0
  parts.forEach((d, i) => {
    if (i > 0) {
      out.set(sep, offset)
      offset += sep.byteLength
    }
    out.set(d, offset)
    offset += d.byteLength
  })
  return out
}
