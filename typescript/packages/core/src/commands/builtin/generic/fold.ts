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
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync, stdinStream } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'
import { mapLines } from '../utils/lines.ts'
import { concat } from '../../../io/cachable_iterator.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function foldLine(line: string, width: number, breakSpaces: boolean): string {
  if (line.length <= width) return line
  const parts: string[] = []
  let rest = line
  while (rest.length > width) {
    if (breakSpaces) {
      const idx = rest.lastIndexOf(' ', width - 1)
      if (idx > 0) {
        parts.push(rest.slice(0, idx + 1))
        rest = rest.slice(idx + 1)
      } else {
        parts.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
    } else {
      parts.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
  }
  if (rest !== '') parts.push(rest)
  return parts.join('\n')
}

function foldBytes(data: Uint8Array, width: number): Uint8Array {
  const output: number[] = []
  let column = 0
  for (const byte of data) {
    if (byte === 0x0a) {
      output.push(byte)
      column = 0
      continue
    }
    if (column === width) {
      output.push(0x0a)
      column = 0
    }
    output.push(byte)
    column += 1
  }
  return new Uint8Array(output)
}

interface FoldFlags {
  readonly width: number
  readonly breakSpaces: boolean
  readonly countBytes: boolean
}

function parseFlags(bag: Record<string, FlagValue>): FoldFlags {
  const fl = new FlagView(bag, specOf('fold'))
  const widthValue = fl.asStr('width')
  return {
    width: typeof widthValue === 'string' ? Number.parseInt(widthValue, 10) : 80,
    breakSpaces: fl.asBool('spaces'),
    countBytes: fl.asBool('bytes'),
  }
}

export async function foldGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  const { width, breakSpaces, countBytes } = parseFlags(opts.flags)
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still fold (GNU fold).
    const [ok, err] = await readOperands(paths, stream, 'fold')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    if (countBytes) return [concat(ok.map((operand) => foldBytes(operand.data, width))), io]
    // GNU folds each file on its own, a column fresh at its start, and writes
    // a newline only where the file had one: `ab` then `cd` fold to `abcd`,
    // not to two lines. Mirrors Python's fold.
    const result: ByteSource = ENC.encode(
      ok
        .map((o) => mapLines(DEC.decode(o.data), (line) => foldLine(line, width, breakSpaces)))
        .join(''),
    )
    return [result, io]
  }
  const stdinData = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
  if (countBytes) return [foldBytes(stdinData, width), new IOResult()]
  const text = mapLines(DEC.decode(stdinData), (line) => foldLine(line, width, breakSpaces))
  return [ENC.encode(text), new IOResult()]
}
