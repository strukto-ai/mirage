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
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import { ByteSpool } from '../../../../io/spool.ts'
import { StreamRefusal } from '../../../../rs/errors.ts'
import {
  closeStream,
  openStream,
  serveRequests,
  type OpenStream,
  type RequestHost,
} from '../../../../rs/stream.ts'
import { byteView, utf8Locale } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'
import { resolveSource, stdinStream } from '../../utils/stream.ts'
import { reportedStream } from '../../utils/operands.ts'

const ENC = new TextEncoder()

/** Each input reversed in turn: held whole, which the engine reads back a
 * block at a time and has written out a record at a time. Running out of
 * memory ends the run, exit 1. Mirrors Python's _reversed. */
async function* reversed(
  engine: OpenStream,
  sources: readonly ByteSource[],
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const errors = new ByteSpool()
  let spool = new ByteSpool()
  const host: RequestHost = {
    errors,
    async serve(request) {
      const [offset, size] = [Number(request.offset), Number(request.size)]
      if (request.op === 'emit') return { reply: {}, output: spool.stream(offset, size) }
      return { reply: {}, data: await spool.read(offset, size) }
    },
  }
  try {
    for (const source of sources) {
      spool = new ByteSpool()
      try {
        await spool.fill(source)
        engine.begin({ size: spool.size })
        yield* serveRequests(engine, host, signal)
      } finally {
        await spool.close()
      }
      if (engine.status() !== 0) break
    }
  } finally {
    if (engine.status() !== 0) {
      io.exitCode = 1
      io.stderr = concat([await materialize(io.stderr), await materialize(await errors.output())])
    }
    await errors.close()
    await closeStream(engine)
  }
}

const tac: CommandFn = async (_accessor, paths, _texts, ctx) => {
  // Operands resolve first: nothing may throw between opening the engine and
  // handing it to the output that closes it.
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  const fl = new FlagView(ctx.flags, specOf('tac'))
  const separator = fl.asStr('separator')
  let engine: OpenStream
  try {
    engine = await openStream('tac', {
      separator: separator === undefined ? null : byteView(separator),
      before: fl.asBool('before'),
      regex: fl.asBool('regex'),
      utf8: utf8Locale(ctx.env),
    })
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${err.message}\n`) })]
  }
  const stream = stdinStream(dirAwareStream(files, ctx), ctx.stdin)
  const io = new IOResult()
  const sources =
    resolved.length > 0
      ? resolved.map((path) => reportedStream(stream(path), io, path, 'tac'))
      : [resolveSource(ctx.stdin)]
  return [reversed(engine, sources, io, ctx.signal), io]
}

export const BUILDER: GenericCommand = {
  name: 'tac',
  read: true,
  fn: tac,
}
