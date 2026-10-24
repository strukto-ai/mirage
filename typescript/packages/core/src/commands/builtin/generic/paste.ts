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

import { isStdin, neverOpened } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult } from '../../../io/types.ts'
import { type JsonValue, PathSpec } from '../../../types.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { closeStream, mergeOutput, openStream } from '../../../rs/stream.ts'
import { byteView } from '../../../shell/bytes.ts'

const ENC = new TextEncoder()

export function pasteGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const fl = new FlagView(ctx.flags, specOf('paste'))
  const config: Record<string, JsonValue> = {
    delimiters: byteView(fl.asStr('delimiters', '\t')),
    serial: fl.asBool('serial'),
    zero_terminated: fl.asBool('zero_terminated'),
  }
  const shared = new AsyncLineIterator(ctx.stdin ?? new Uint8Array())
  const operands = paths.length === 0 ? [PathSpec.fromStrPath('-')] : paths
  const inputs = operands.map(
    (p) => [p, isStdin(p) ? shared : new AsyncLineIterator(stream(p))] as const,
  )
  const io = new IOResult()
  return [pasteStream(inputs, config, io), io]
}

/**
 * Open every operand, as GNU does before it reads, then paste them. A failed
 * read is reported, exit 1, and its operand reads as ended; one that never
 * opened ends the run before any line is written, and under -s is left out.
 * Mirrors Python's _paste_stream.
 */
async function* pasteStream(
  inputs: readonly (readonly [PathSpec, AsyncLineIterator])[],
  config: Record<string, JsonValue>,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  const errors: string[] = []
  const report = (path: PathSpec, error: unknown): void => {
    if (!isFsError(error)) throw error
    errors.push(fsErrorLine('paste', path, error))
    io.stderr = ENC.encode(errors.join(''))
    io.exitCode = 1
  }
  try {
    const opened: (readonly [PathSpec, AsyncLineIterator])[] = []
    for (const [path, reader] of inputs) {
      try {
        if (!isStdin(path)) await reader.peek()
      } catch (error) {
        report(path, error)
        if (neverOpened(reader, path, error)) {
          if (config.serial !== true) return
          continue
        }
      }
      opened.push([path, reader])
    }
    const sources = [...new Set(opened.map(([, reader]) => reader))]
    const names = new Map([...opened].reverse().map(([path, reader]) => [reader, path]))
    config.inputs = opened.map(([, reader]) => sources.indexOf(reader))
    const pull = async (index: number): Promise<Uint8Array | null> => {
      const reader = sources[index]
      if (reader === undefined) return null
      try {
        return await reader.readChunk()
      } catch (error) {
        report(names.get(reader) ?? PathSpec.fromStrPath('-'), error)
        return null
      }
    }
    const stream = await openStream('paste', config)
    try {
      yield* mergeOutput(stream, pull)
    } finally {
      await closeStream(stream)
    }
  } finally {
    for (const reader of new Set(inputs.map(([, reader]) => reader))) await reader.discard()
  }
}
