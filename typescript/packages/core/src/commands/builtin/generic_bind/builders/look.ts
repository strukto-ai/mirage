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
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { extraOperandError, usageHint } from '../../../spec/usage.ts'
import { CommandName } from '../../../spec/types.ts'
import { UsageError } from '../../../errors.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { JsonValue } from '../../../../types.ts'
import { runStream } from '../../../../rs/stream.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { reportedStream } from '../../utils/operands.ts'

/** The lines that start with the prefix; one makes the exit 0. Mirrors
 * Python's _matched. */
async function* matched(
  source: ByteSource,
  config: Readonly<Record<string, JsonValue>>,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  for await (const chunk of runStream('look', config, source, signal)) {
    io.exitCode = 0
    yield chunk
  }
}

const look: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  if (resolved.length > 1) throw extraOperandError(CommandName.LOOK, resolved[1]?.rawPath ?? '')
  // util-linux 2.41 answers a missing prefix with its usage refusal.
  if (texts.length === 0) throw new UsageError(`look: bad usage\n${usageHint('look')}`, 1)
  const config = {
    prefix: byteView(texts[0] ?? ''),
    fold: new FlagView(ctx.flags, specOf('look')).asBool('f'),
  }
  const io = new IOResult({ exitCode: 1 })
  const path = resolved[0]
  const source = path === undefined ? (ctx.stdin ?? new Uint8Array()) : files.read(path)
  const output = matched(source, config, io, ctx.signal)
  return [path === undefined ? output : reportedStream(output, io, path, 'look'), io]
}

export const BUILDER: GenericCommand = {
  name: 'look',
  read: true,
  fn: look,
}
