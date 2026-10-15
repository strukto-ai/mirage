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
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { mapStream } from '../utils/lines.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

function unexpandLine(line: string, tabsize: number, allSpaces: boolean): string {
  if (allSpaces) {
    const result: string[] = []
    let i = 0
    while (i < line.length) {
      let count = 0
      while (i + count < line.length && line[i + count] === ' ') count += 1
      if (count >= tabsize) {
        const tabs = Math.floor(count / tabsize)
        const remainder = count % tabsize
        result.push('\t'.repeat(tabs) + ' '.repeat(remainder))
        i += count
      } else if (count > 0) {
        result.push(' '.repeat(count))
        i += count
      } else {
        result.push(line[i] ?? '')
        i += 1
      }
    }
    return result.join('')
  }
  let leading = 0
  while (leading < line.length && line[leading] === ' ') leading += 1
  if (leading >= tabsize) {
    const tabs = Math.floor(leading / tabsize)
    const remainder = leading % tabsize
    return '\t'.repeat(tabs) + ' '.repeat(remainder) + line.slice(leading)
  }
  return line
}

interface UnexpandFlags {
  readonly tabsize: number
  readonly allSpaces: boolean
  readonly firstOnly: boolean
}

function parseFlags(bag: Record<string, FlagValue>): UnexpandFlags {
  const fl = new FlagView(bag, specOf('unexpand'))
  const tabsValue = fl.asStr('tabs')
  return {
    tabsize: tabsValue === undefined ? 8 : Number.parseInt(tabsValue, 10),
    allSpaces: fl.asBool('all'),
    firstOnly: fl.asBool('first_only'),
  }
}

function unexpandRecord(line: Uint8Array, tabsize: number, allSpaces: boolean): Uint8Array {
  return ENC.encode(unexpandLine(DEC.decode(line), tabsize, allSpaces))
}

export function unexpandGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, opts.stdin)
  const parsed = parseFlags(opts.flags)
  const tabsize = parsed.tabsize
  const allSpaces = parsed.allSpaces && !parsed.firstOnly
  const io = new IOResult()
  const sources = paths.map((p) => reportedStream(stream(p), io, p, 'unexpand'))
  const transform = (line: Uint8Array): Uint8Array => unexpandRecord(line, tabsize, allSpaces)
  const output = mapStream(
    paths.length > 0 ? asyncChain(sources) : (opts.stdin ?? new Uint8Array()),
    transform,
  )
  return [output, io]
}
