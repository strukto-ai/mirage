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

import { byteView } from '../../../shell/bytes.ts'
import { IOResult } from '../../../io/types.ts'
import { openStream, type OpenStream } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused } from '../../../rs/scan.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { resolveSource, streamOutput } from '../utils/stream.ts'
import type { FlagValue } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { specOf } from '../../spec/builtins.ts'

/** tr's engine over its sets, or tr's refusal of its operands. Mirrors
 * Python's `tr_engine`. */
export async function trEngine(
  texts: readonly string[],
  bag: Record<string, FlagValue>,
): Promise<OpenStream | IOResult> {
  const fl = new FlagView(bag, specOf('tr'))
  try {
    return await openStream('tr', {
      operands: texts.map((text) => byteView(text)),
      delete: fl.asBool('delete'),
      squeeze: fl.asBool('squeeze_repeats'),
      complement: fl.asBool('C') || fl.asBool('complement'),
      truncate_set1: fl.asBool('truncate_set1'),
    })
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
}

export function trGeneric(
  engine: OpenStream,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const first = paths[0]
  const source = first === undefined ? resolveSource(ctx.stdin) : stream(first)
  return [streamOutput(engine, source, ctx.signal), new IOResult()]
}
