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
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { chunks } from '../../../io/cooperative.ts'

async function* stringsStream(source: ByteSource, minLen: number): AsyncIterable<Uint8Array> {
  let prefix: number[] = []
  let printing = false
  for await (const data of chunks(source)) {
    const output: number[] = []
    for (const byte of data) {
      if (byte >= 32 && byte <= 126) {
        if (printing) output.push(byte)
        else {
          prefix.push(byte)
          if (prefix.length >= minLen) {
            for (const byte of prefix) output.push(byte)
            prefix = []
            printing = true
          }
        }
      } else {
        if (printing) output.push(10)
        prefix = []
        printing = false
      }
    }
    if (output.length > 0) yield new Uint8Array(output)
  }
  if (printing) yield new Uint8Array([10])
}

interface StringsFlags {
  readonly minLen: number
}

function parseFlags(bag: Record<string, FlagValue>): StringsFlags {
  const fl = new FlagView(bag, specOf('strings'))
  return { minLen: fl.asInt('n') ?? 4 }
}

export function stringsGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  // binutils strings never reads `-` as stdin; only /dev/stdin is.
  stream = stdinStream(stream, opts.stdin, false, false)
  const { minLen } = parseFlags(opts.flags)
  const io = new IOResult()
  const sources = paths.map((p) =>
    reportedStream(stringsStream(stream(p), minLen), io, p, 'strings'),
  )
  return [
    paths.length > 0 ? asyncChain(sources) : stringsStream(opts.stdin ?? new Uint8Array(), minLen),
    io,
  ]
}
