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
import { StreamRefusal } from '../../../../rs/errors.ts'
import {
  closeStream,
  openStream,
  runStream,
  streamOutputChunks,
  type OpenStream,
} from '../../../../rs/stream.ts'
import { byteView, fromByteView } from '../../../../shell/bytes.ts'
import { stdinStream } from '../../utils/stream.ts'
import { perOperand } from '../../utils/operands.ts'

import { OutputStream } from '../../../../io/stream.ts'

const strings: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const minLen = new FlagView(ctx.flags, specOf('strings')).asText('n')
  const config = { min_len: minLen === undefined ? null : byteView(minLen) }
  // The engine refuses -n before any operand is touched, as binutils does.
  let engine: OpenStream
  try {
    engine = await openStream('strings', config)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return [null, new IOResult({ exitCode: 1, stderr: fromByteView(`${err.message}\n`) })]
  }
  try {
    const files = commandFiles(ctx, paths)
    const resolved = await resolveOrEmpty(files, paths)
    const stream = stdinStream(dirAwareStream(files, ctx), ctx.stdin, false, false)
    const io = new IOResult()
    let used = false
    const each = (source: ByteSource): AsyncIterable<Uint8Array> => {
      if (used) return runStream('strings', config, source, ctx.signal)
      used = true
      return streamOutputChunks(engine, source, ctx.signal)
    }
    const produced = perOperand(resolved, stream, ctx.stdin, io, 'strings', each)[
      Symbol.asyncIterator
    ]()
    return [
      new OutputStream(produced, async () => {
        await produced.return?.()
        await closeStream(engine)
      }),
      io,
    ]
  } catch (error) {
    await closeStream(engine)
    throw error
  }
}

export const BUILDER: GenericCommand = {
  name: 'strings',
  read: true,
  fn: strings,
}
