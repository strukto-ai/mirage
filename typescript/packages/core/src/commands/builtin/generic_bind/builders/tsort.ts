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
import { commandFiles, resolveOrEmpty } from '../files.ts'
import { extraOperandError } from '../../../spec/usage.ts'
import { CommandName } from '../../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import { chainOutput, closeStream, openStream } from '../../../../rs/stream.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'
import { stdinStream } from '../../utils/stream.ts'

/** The names in order; a loop, an odd token or a graph past what the engine
 * holds makes the exit 1. Mirrors Python's _ordered. */
async function* ordered(
  name: string,
  source: ByteSource,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const engine = await openStream('tsort', { name: byteView(name) })
  try {
    yield* chainOutput(engine, [source], signal)
  } finally {
    if (engine.status() !== 0) {
      io.exitCode = 1
      io.stderr = concat([await materialize(io.stderr), engine.takeStderr()])
    }
    await closeStream(engine)
  }
}

const tsort: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  if (resolved.length > 1) throw extraOperandError(CommandName.TSORT, resolved[1]?.rawPath ?? '')
  const first = resolved[0]
  const source =
    first === undefined
      ? (ctx.stdin ?? new Uint8Array())
      : stdinStream(files.read, ctx.stdin)(first)
  const io = new IOResult()
  return [ordered(first?.rawPath ?? '-', source, io, ctx.signal), io]
}

export const BUILDER: GenericCommand = {
  name: 'tsort',
  read: true,
  fn: tsort,
}
