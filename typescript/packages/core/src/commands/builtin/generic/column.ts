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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function padRight(s: string, width: number): string {
  if (s.length >= width) return s
  return s + ' '.repeat(width - s.length)
}

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function tableFormat(text: string, separator: string | null, outputSep: string): string {
  const lines = splitLinesNoTrailing(text)
  if (lines.length === 0) return ''
  const rows: string[][] = []
  for (const line of lines) {
    if (separator !== null && separator !== '') {
      rows.push(line.split(separator))
    } else {
      rows.push(line.split(/\s+/).filter((s) => s !== ''))
    }
  }
  if (rows.length === 0) return ''
  let maxCols = 0
  for (const r of rows) {
    if (r.length > maxCols) maxCols = r.length
  }
  const widths = new Array(maxCols).fill(0) as number[]
  for (const row of rows) {
    for (let idx = 0; idx < row.length; idx++) {
      const cell = row[idx] ?? ''
      if (cell.length > (widths[idx] ?? 0)) widths[idx] = cell.length
    }
  }
  const out: string[] = []
  for (const row of rows) {
    const parts: string[] = []
    for (let idx = 0; idx < row.length; idx++) {
      const cell = row[idx] ?? ''
      if (idx < row.length - 1) parts.push(padRight(cell, widths[idx] ?? 0))
      else parts.push(cell)
    }
    out.push(parts.join(outputSep))
  }
  return out.join('\n') + '\n'
}

export async function columnGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('column'))
  const tMode = fl.asBool('t')
  const sFlag = (fl.asStr('s') ?? null)
  const oFlag = (fl.asStr('o') ?? '  ')
  let raw: Uint8Array
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    raw = await materialize(stream(first))
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    raw = stdinData ?? new Uint8Array(0)
  }
  const text = DEC.decode(raw)
  const output = tMode ? tableFormat(text, sFlag, oFlag) : text
  const result: ByteSource = ENC.encode(output)
  return [result, new IOResult()]
}
