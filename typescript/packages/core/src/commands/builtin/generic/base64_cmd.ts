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
import { IOResult } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import { encodeBase64 } from '../../../utils/base64.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { resolveSource, stdinStat, stdinStream } from '../utils/stream.ts'
import { splitReadable } from '../utils/operands.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { chunks } from '../../../io/cooperative.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

interface Base64Flags {
  readonly decode: boolean
  readonly wrap: number | null
  readonly ignoreGarbage: boolean
}

function parseFlags(bag: Record<string, FlagValue>): Base64Flags {
  const fl = new FlagView(bag, specOf('base64'))
  const wrapValue = fl.asStr('wrap')
  return {
    decode: fl.asBool('D') || fl.asBool('decode'),
    wrap: typeof wrapValue === 'string' ? Number.parseInt(wrapValue, 10) : null,
    ignoreGarbage: fl.asBool('ignore_garbage'),
  }
}

async function* base64EncodeStream(
  source: AsyncIterable<Uint8Array>,
  wrap: number | null,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const width = wrap ?? 76
  let pending: Uint8Array = new Uint8Array()
  let column = 0
  const stream = chunks(source, signal)
  try {
    for (;;) {
      const chunk = await stream.next()
      const data = concat([pending, chunk.value ?? new Uint8Array()])
      const size = chunk.done === true ? data.length : Math.floor(data.length / 3) * 3
      const encoded = encodeBase64(data.subarray(0, size))
      pending = data.slice(size)
      const output: string[] = []
      let offset = 0
      while (offset < encoded.length) {
        const take = width ? Math.min(encoded.length - offset, width - column) : encoded.length
        output.push(encoded.slice(offset, offset + take))
        offset += take
        column += take
        if (width && column === width) {
          output.push('\n')
          column = 0
        }
      }
      if (output.length > 0) yield encodeText(output.join(''))
      if (chunk.done === true) break
    }
    if (width && column) yield encodeText('\n')
  } finally {
    await stream.return?.()
  }
}

async function* base64DecodeStream(
  source: AsyncIterable<Uint8Array>,
  ignoreGarbage: boolean,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  // GNU coreutils 9.7 accepts unpadded tails and concatenated padded
  // blocks. Decode as bytes arrive so an invalid suffix keeps its prefix.
  let digits = 0
  let value = 0
  let padding = false
  for await (const chunk of chunks(source, signal)) {
    const output: number[] = []
    let failed = false
    for (const byte of chunk) {
      const digit = ALPHABET.indexOf(String.fromCharCode(byte))
      if (byte === 10 || (ignoreGarbage && digit < 0 && byte !== 61)) continue
      if (padding) {
        if (byte !== 61) {
          failed = true
          break
        }
        padding = false
      } else if (digit >= 0) {
        value = (value << 6) | digit
        digits += 1
        if (digits >= 2) output.push((value >> (2 * (4 - digits))) & 255)
        if (digits === 4) {
          digits = 0
          value = 0
        }
      } else if (byte === 61 && (digits === 2 || digits === 3)) {
        if (value & ((1 << (2 * (4 - digits))) - 1)) {
          failed = true
          break
        }
        padding = digits === 2
        digits = 0
        value = 0
      } else {
        failed = true
        break
      }
    }
    if (failed) {
      io.exitCode = 1
      io.stderr = encodeText('base64: invalid input\n')
    }
    if (output.length > 0) yield Uint8Array.from(output)
    if (failed) return
  }
  if (padding || digits === 1 || (digits && value & ((1 << (2 * (4 - digits))) - 1))) {
    io.exitCode = 1
    io.stderr = encodeText('base64: invalid input\n')
  }
}

// The operand is stat'ed before the lazy encode starts, so a missing or
// unreadable one is reported in base64's own words (`base64: nope: No such
// file or directory`) instead of surfacing mid-drain. Mirrors Python's
// base64_generic.
export async function base64Generic(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  if (paths.length > 1) throw extraOperandError(CommandName.BASE64, paths[1]?.rawPath ?? '')
  if (paths.length === 1) {
    const [, err] = await splitReadable(paths, stdinStat(stat), 'base64')
    if (err !== '') return [null, new IOResult({ exitCode: 1, stderr: encodeText(err) })]
  }
  const parsed = parseFlags(ctx.flags)
  if (parsed.wrap !== null && parsed.wrap < 0) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: encodeText(`base64: invalid wrap size: '${String(parsed.wrap)}'\n`),
      }),
    ]
  }
  let source: AsyncIterable<Uint8Array>
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    source = stream(first)
  } else {
    source = resolveSource(ctx.stdin)
  }
  const io = new IOResult()
  const out = parsed.decode
    ? base64DecodeStream(source, parsed.ignoreGarbage, io, ctx.signal)
    : base64EncodeStream(source, parsed.wrap, ctx.signal)
  return [out, io]
}
