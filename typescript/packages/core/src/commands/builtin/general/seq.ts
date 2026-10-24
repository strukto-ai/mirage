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

import type { JsonValue, PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { openStream, type OpenStream } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { byteView } from '../../../shell/bytes.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { UsageError } from '../../errors.ts'
import { CommandName } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { streamOutput } from '../utils/stream.ts'

async function seq(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  if (texts.length === 0) throw missingOperandError(CommandName.SEQ, null)
  if (texts.length > 3) throw extraOperandError(CommandName.SEQ, texts[3] ?? '')
  const fl = new FlagView(ctx.flags, specOf('seq'))
  const typed = fl.asStr('format') ?? null
  const config: Record<string, JsonValue> = {
    operands: texts.map((text) => byteView(text)),
    format: typed === null ? null : byteView(typed),
    equal_width: fl.asBool('equal_width'),
    separator: byteView(fl.asStr('separator') ?? '\n'),
  }
  let engine: OpenStream
  try {
    engine = await openStream('seq', config)
  } catch (err) {
    if (err instanceof StreamRefusal) throw new UsageError(err.message, 1)
    throw err
  }
  return [streamOutput(engine, new Uint8Array(0), ctx.signal), new IOResult()]
}

export const GENERAL_SEQ = command({
  name: 'seq',
  vfs: null,
  spec: specOf('seq'),
  fn: seq,
})
