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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { chainOutput, closeStream, openStream, type OpenStream } from '../../../rs/stream.ts'
import { byteView, utf8Locale } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'
import { stdinStream } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

// The options mirage-rs validates as GNU does, each occurrence in the order
// the line typed them.
const OPTIONS = [
  'starting_line_number',
  'line_increment',
  'number_width',
  'join_blank_lines',
  'body_numbering',
  'footer_numbering',
  'header_numbering',
  'number_format',
]

// nl's options as typed: every occurrence of the ones GNU validates, in the
// order the line typed them, for the engine to validate and resolve. Mirrors
// Python's NlFlags.
interface NlFlags {
  readonly options: readonly (readonly [string, string])[]
  readonly separator: string
  readonly delimiter: string
  readonly noRenumber: boolean
}

function parseFlags(bag: Record<string, FlagValue>): NlFlags {
  const fl = new FlagView(bag, specOf('nl'))
  return {
    options: fl
      .typedOrder(...OPTIONS)
      .flatMap((dest) => fl.asList(dest).map((raw) => [dest, raw] as const)),
    separator: fl.asStr('number_separator', '\t'),
    delimiter: fl.asStr('section_delimiter', '\\:'),
    noRenumber: fl.asBool('no_renumber'),
  }
}

/**
 * The inputs numbered: a refused option prints its refusal, and a counter
 * that overflows ends the run, both exit 1. Mirrors Python's _numbered.
 */
async function* numbered(
  config: Readonly<Record<string, JsonValue>>,
  sources: readonly ByteSource[],
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let stream: OpenStream
  try {
    stream = await openStream('nl', config)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    io.exitCode = 1
    io.stderr = ENC.encode(`${err.message}\n`)
    return
  }
  try {
    yield* chainOutput(stream, sources, signal)
  } finally {
    if (stream.status() !== 0) {
      io.exitCode = 1
      io.stderr = concat([await materialize(io.stderr), stream.takeStderr()])
    }
    await closeStream(stream)
  }
}

// nl over every operand, numbering on across them. Mirrors Python's
// nl_generic.
export function nlGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  const config = {
    options: parsed.options.map(([dest, raw]) => [dest, byteView(raw)]),
    separator: byteView(parsed.separator),
    delimiter: byteView(parsed.delimiter),
    no_renumber: parsed.noRenumber,
    utf8: utf8Locale(ctx.env),
    inputs: Math.max(1, paths.length),
  }
  const io = new IOResult()
  const sources =
    paths.length === 0
      ? [ctx.stdin ?? new Uint8Array()]
      : paths.map((p) => reportedStream(stream(p), io, p, 'nl'))
  return [numbered(config, sources, io, ctx.signal), io]
}
