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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { charWidth, leadWidth } from '../../../io/async_line_iterator.ts'
import { utf8Locale } from '../../../shell/bytes.ts'
import { quoteText } from '../../quote.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const BAD_CHARACTER = ENC.encode(
  'colrm: fgetwc() failed: Invalid or incomplete multibyte or wide character\n',
)
const LONGEST_COLUMN = (1n << 63n) - 1n
const TAB_STOP = 8

function columnArgument(word: string, which: string): [number | null, Uint8Array] {
  if (!/^[0-9]+$/.test(word)) {
    return [null, ENC.encode(`colrm: ${which} argument: '${quoteText(word)}'\n`)]
  }
  if (BigInt(word) > LONGEST_COLUMN) {
    const line = `colrm: ${which} argument: '${quoteText(word)}': Numerical result out of range\n`
    return [null, ENC.encode(line)]
  }
  return [Number(word), new Uint8Array()]
}

function advance(column: number, first: number): number {
  if (first === 0x09) return Math.floor((column + TAB_STOP) / TAB_STOP) * TAB_STOP
  if (first === 0x08) return Math.max(column - 1, 0)
  return column + (first >= 0x20 && first !== 0x7f ? 1 : 0)
}

// Where one line's characters stand against the columns removed.
class Line {
  column = 0
  phase = 0

  constructor(
    private readonly start: number,
    private readonly stop: number | null,
  ) {}

  reset(): void {
    this.column = 0
    this.phase = 0
  }

  // How many spaces to print before the character, and whether it prints.
  take(first: number): [number, boolean] {
    if (this.phase === 2) return [0, true]
    const after = advance(this.column, first)
    if (this.phase === 0) {
      if (after <= this.start - 1) {
        this.column = after
        return [0, true]
      }
      const padding = Math.max(this.start - 1 - this.column, 0)
      this.column = after
      this.phase = 1
      return [padding + this.pastStop(), false]
    }
    this.column = after
    return [this.pastStop(), false]
  }

  private pastStop(): number {
    if (this.stop === null || this.column < this.stop) return 0
    this.phase = 2
    return this.column - this.stop
  }
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

export async function* removed(
  source: AsyncIterable<Uint8Array>,
  start: number,
  stop: number | null,
  utf8: boolean,
  io: IOResult,
): AsyncGenerator<Uint8Array> {
  const line = new Line(start, stop)
  let held: Uint8Array = new Uint8Array()
  for await (const chunk of source) {
    const data = new Uint8Array(held.byteLength + chunk.byteLength)
    data.set(held)
    data.set(chunk, held.byteLength)
    const out: number[] = []
    let at = 0
    while (at < data.byteLength) {
      const first = data[at] ?? 0
      let size = 1
      if (first >= 0x80) {
        if (!utf8) size = 0
        else {
          size = charWidth(data, at)
          if (at + size === data.byteLength && size < leadWidth(first)) break
          if (!isValidUtf8(data.subarray(at, at + size))) size = 0
        }
      }
      if (size === 0) {
        io.exitCode = 1
        io.stderr = BAD_CHARACTER
        if (out.length > 0) yield Uint8Array.from(out)
        return
      }
      const end = at + size
      if (first === 0x0a) {
        line.reset()
        out.push(first)
      } else if (start === 0) {
        for (let i = at; i < end; i++) out.push(data[i] ?? 0)
      } else {
        const [spaces, prints] = line.take(first)
        for (let i = 0; i < spaces; i++) out.push(0x20)
        if (prints) for (let i = at; i < end; i++) out.push(data[i] ?? 0)
      }
      at = end
    }
    held = data.slice(at)
    if (out.length > 0) yield Uint8Array.from(out)
  }
}

// Remove columns from standard input: a start and an optional stop, both from
// 1, a start of 0 removing nothing. Pinned against util-linux 2.41.5.
function colrm(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  let start = 0
  let stop: number | null = null
  const [firstWord, secondWord] = texts
  if (firstWord !== undefined) {
    const [value, said] = columnArgument(firstWord, 'first')
    if (value === null) return [null, new IOResult({ exitCode: 1, stderr: said })]
    start = value
  }
  if (secondWord !== undefined) {
    const [value, said] = columnArgument(secondWord, 'second')
    if (value === null) return [null, new IOResult({ exitCode: 1, stderr: said })]
    stop = value
  }
  const io = new IOResult()
  return [removed(resolveSource(ctx.stdin), start, stop, utf8Locale(ctx.env), io), io]
}

export const GENERAL_COLRM = command({ name: 'colrm', vfs: null, spec: specOf('colrm'), fn: colrm })
