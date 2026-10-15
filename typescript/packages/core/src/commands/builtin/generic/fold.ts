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
import { stdinStream } from '../utils/stream.ts'
import { perOperand } from '../utils/operands.ts'
import { mapStream } from '../utils/lines.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

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

function foldRecord(
  line: Uint8Array,
  width: number,
  breakSpaces: boolean,
  countBytes: boolean,
): Uint8Array {
  return countBytes
    ? foldBytes(line, width)
    : ENC.encode(foldLine(DEC.decode(line), width, breakSpaces))
}

export function foldGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, opts.stdin)
  const { width, breakSpaces, countBytes } = parseFlags(opts.flags)
  const io = new IOResult()
  const transform = (line: Uint8Array): Uint8Array =>
    foldRecord(line, width, breakSpaces, countBytes)
  const each = (source: ByteSource) => mapStream(source, transform)
  return [perOperand(paths, stream, opts.stdin, io, 'fold', each), io]
}
