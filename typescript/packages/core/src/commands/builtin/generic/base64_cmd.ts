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
import type { CommandFnResult, Context } from '../../config.ts'
import { resolveSource, stdinStat, stdinStream } from '../utils/stream.ts'
import { splitReadable } from '../utils/operands.ts'
import { xstrtoimax } from '../utils/strtol.ts'
import { INTMAX } from '../constants.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { runStream } from '../../../rs/stream.ts'
import { encodeText } from '../../../shell/bytes.ts'

// GNU base64's line length when -w names none.
const WRAP_WIDTH = 76

interface Base64Flags {
  readonly decode: boolean
  readonly wrap: number | null
  readonly ignoreGarbage: boolean
}

// base64's refusal of a -w value that is no number or negative. Mirrors
// Python's `_wrap_refusal`.
function wrapRefusal(text: string): string {
  return `base64: invalid wrap size: '${quoteText(text)}'`
}

function parseFlags(bag: Record<string, FlagValue>): Base64Flags {
  const fl = new FlagView(bag, specOf('base64'))
  // GNU 9.7 reads -w with xstrtoimax and takes a width past intmax_t as no
  // wrapping at all.
  const wrap = fl.asNumber('wrap', xstrtoimax, wrapRefusal, { low: 0n })
  return {
    decode: fl.asBool('D') || fl.asBool('decode'),
    wrap: wrap === undefined ? null : wrap > INTMAX ? 0 : Number(wrap),
    ignoreGarbage: fl.asBool('ignore_garbage'),
  }
}

async function* base64EncodeStream(
  source: AsyncIterable<Uint8Array>,
  wrap: number | null,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  yield* runStream('base64', { mode: 'encode', wrap: wrap ?? WRAP_WIDTH }, source, signal)
}

async function* base64DecodeStream(
  source: AsyncIterable<Uint8Array>,
  ignoreGarbage: boolean,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  // A refusal carries what decoded before the invalid input: record the
  // failure first, then pass that prefix on, as GNU 9.7 writes it.
  try {
    yield* runStream('base64', { mode: 'decode', ignore_garbage: ignoreGarbage }, source, signal)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    io.exitCode = 1
    io.stderr = encodeText(`${err.message}\n`)
    if (err.output.byteLength > 0) yield err.output
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
