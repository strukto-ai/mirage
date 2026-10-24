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

import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, dirAwareStream, resolveOrEmpty } from '../files.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { JsonValue } from '../../../../types.ts'
import { StreamRefusal } from '../../../../rs/errors.ts'
import { chainOutput, closeStream, openStream, type OpenStream } from '../../../../rs/stream.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { stdinStream } from '../../utils/stream.ts'
import { reportedStream } from '../../utils/operands.ts'

const ENC = new TextEncoder()

/** Each input's printable runs; a refused -n prints its refusal, exit 1. */
async function* scanned(
  config: Readonly<Record<string, JsonValue>>,
  sources: readonly ByteSource[],
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let engine: OpenStream
  try {
    engine = await openStream('strings', config)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    io.exitCode = 1
    io.stderr = ENC.encode(`${err.message}\n`)
    return
  }
  try {
    yield* chainOutput(engine, sources, signal)
  } finally {
    await closeStream(engine)
  }
}

const strings: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  const minLen = new FlagView(ctx.flags, specOf('strings')).asText('n')
  const config = {
    min_len: minLen === undefined ? null : byteView(minLen),
    inputs: Math.max(1, resolved.length),
  }
  // binutils strings never reads `-` as stdin; only /dev/stdin is.
  const stream = stdinStream(dirAwareStream(files, ctx), ctx.stdin, false, false)
  const io = new IOResult()
  const sources =
    resolved.length > 0
      ? resolved.map((path) => reportedStream(stream(path), io, path, 'strings'))
      : [ctx.stdin ?? new Uint8Array()]
  return [scanned(config, sources, io, ctx.signal), io]
}

export const BUILDER: GenericCommand = {
  name: 'strings',
  read: true,
  fn: strings,
}
