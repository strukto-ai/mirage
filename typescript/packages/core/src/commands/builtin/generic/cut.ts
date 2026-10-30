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

import { stdinStat, stdinStream } from '../utils/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { OutputStream } from '../../../io/stream.ts'
import type { FileStat, JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { closeStream, openStream, openStreamSync } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused } from '../../../rs/scan.ts'
import { byteView } from '../../../shell/bytes.ts'
import { resolveSource, streamOutput } from '../utils/stream.ts'
import { operandsIo, reportedStream, splitReadable } from '../utils/operands.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

export const OPTIONS: readonly string[] = [
  'bytes',
  'characters',
  'fields',
  'F',
  'delimiter',
  'no_partial',
  'complement',
  'only_delimited',
  'args_O',
  'output_delimiter',
  'w',
  'whitespace_delimited',
  'zero_terminated',
]

/**
 * cut's engine config, refused by the engine before any operand is resolved:
 * every option as typed, in typed order, a switch as the empty text. A
 * `--whitespace-delimited` without `=` goes as null, since
 * `--whitespace-delimited=` reads as a prefix of `trimmed`. Mirrors Python's
 * `cut_config`.
 */
export function cutConfig(bag: Record<string, FlagValue>): Record<string, JsonValue> | IOResult {
  const fl = new FlagView(bag, specOf('cut'))
  const options: JsonValue[] = fl
    .occurrences(...OPTIONS)
    .filter(([, value]) => value !== false)
    .map(([name, value]) => [
      name,
      value !== true ? byteView(String(value)) : name === 'whitespace_delimited' ? null : '',
    ])
  const config = { options }
  try {
    openStreamSync('cut', config).close()
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    return refused(error)
  }
  return config
}

/** Run cut over resolved operands with `cutConfig`'s config, read before the
 * operands were. Mirrors Python's `cut_generic`. */
export async function cutGeneric(
  config: Record<string, JsonValue>,
  paths: PathSpec[],
  ctx: Context,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stat: (path: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const engine = await openStream('cut', config)
  if (paths.length > 0) {
    let inspected: Awaited<ReturnType<typeof splitReadable>>
    try {
      inspected = await splitReadable(paths, stdinStat(stat), 'cut')
    } catch (error) {
      engine.close()
      throw error
    }
    const [ok, err] = inspected
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') {
      engine.close()
      return [null, io]
    }
    async function* outputs(): AsyncIterable<Uint8Array> {
      try {
        for (const [index, operand] of ok.entries()) {
          const current = index === 0 ? engine : await openStream('cut', config)
          try {
            yield* reportedStream(
              streamOutput(current, stream(operand), ctx.signal),
              io,
              operand,
              'cut',
            )
          } finally {
            await closeStream(current)
          }
        }
      } finally {
        await closeStream(engine)
      }
    }
    const out: ByteSource = new OutputStream(outputs()[Symbol.asyncIterator](), () =>
      closeStream(engine),
    )
    return [out, io]
  }
  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(ctx.stdin)
  } catch (error) {
    engine.close()
    const message = error instanceof Error ? error.message : String(error)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${message}\n`) })]
  }
  return [streamOutput(engine, source, ctx.signal), new IOResult()]
}
