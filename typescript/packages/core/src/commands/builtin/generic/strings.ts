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
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { perOperand } from '../utils/operands.ts'
import { UINT_MAX, strtoul } from '../utils/strtol.ts'
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

// `-n` as binutils 2.44 scans it: strtoul at base 0, every byte. Mirrors
// Python's `_min_length`.
function minLength(text: string): bigint | null {
  const [value, rest] = strtoul(text)
  return rest === '' ? value : null
}

// binutils' set_string_min refusals, in the order it tests them. Mirrors
// Python's `_min_length_refusal`.
function minLengthRefusal(text: string, value: bigint | null): string {
  if (value === null) return `strings: invalid integer argument ${text}`
  if (value > UINT_MAX) return `strings: minimum string length is too big: ${text}`
  if (value === 0n) return `strings: minimum string length is too small: ${text}`
  return `strings: minimum string length ${text} is too big`
}

interface StringsFlags {
  readonly minLen: number
}

function parseFlags(bag: Record<string, FlagValue>): StringsFlags {
  const fl = new FlagView(bag, specOf('strings'))
  const minLen = fl.asNumber('n', minLength, minLengthRefusal, { low: 1n, high: UINT_MAX - 1n })
  return { minLen: minLen === undefined ? 4 : Number(minLen) }
}

export function stringsGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  // binutils strings never reads `-` as stdin; only /dev/stdin is.
  stream = stdinStream(stream, ctx.stdin, false, false)
  const { minLen } = parseFlags(ctx.flags)
  const io = new IOResult()
  const each = (source: ByteSource) => stringsStream(source, minLen)
  return [perOperand(paths, stream, ctx.stdin, io, 'strings', each), io]
}
