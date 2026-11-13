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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { runStream } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveSource } from '../utils/stream.ts'
import { byteView, fromByteView, utf8Locale } from '../../../shell/bytes.ts'

async function* removed(
  source: AsyncIterable<Uint8Array>,
  args: string[],
  utf8: boolean,
  io: IOResult,
): AsyncGenerator<Uint8Array> {
  try {
    yield* runStream('colrm', { args, utf8 }, source)
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    io.exitCode = error.status
    const message = fromByteView(error.message)
    io.stderr = new Uint8Array(message.length + 1)
    io.stderr.set(message)
    io.stderr[message.length] = 10
    if (error.output.length) yield error.output
  }
}

function colrm(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const io = new IOResult()
  return [
    removed(
      resolveSource(ctx.stdin),
      texts.map((text) => byteView(text)),
      utf8Locale(ctx.env),
      io,
    ),
    io,
  ]
}

export const GENERAL_COLRM = command({ name: 'colrm', vfs: null, spec: specOf('colrm'), fn: colrm })
