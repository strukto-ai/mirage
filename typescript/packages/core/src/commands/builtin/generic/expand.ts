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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { openStreamSync, runStream } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused } from '../../../rs/scan.ts'
import { byteView } from '../../../shell/bytes.ts'

/**
 * expand's or unexpand's engine config, refused by the engine before any
 * operand is resolved: every `-t` and switch as typed, in typed order, since
 * `-t` accumulates across occurrences into one tab list. Mirrors Python's
 * `tabs_config`.
 */
export function tabsConfig(
  command: string,
  names: readonly string[],
  bag: Record<string, FlagValue>,
): Record<string, JsonValue> | IOResult {
  const fl = new FlagView(bag, specOf(command))
  const options: JsonValue[] = fl.texts(...names).map(([name, text]) => [name, byteView(text)])
  const config = { options }
  try {
    openStreamSync(command, config).close()
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    return refused(error)
  }
  return config
}

/** expand's engine config: `tabsConfig` over `-t` and `-i`. Mirrors Python's
 * `expand_config`. */
export function expandConfig(bag: Record<string, FlagValue>): Record<string, JsonValue> | IOResult {
  return tabsConfig('expand', ['tabs', 'initial'], bag)
}

/** Run expand or unexpand over resolved operands, one stream over all.
 * Mirrors Python's `tabs_generic`. */
export function tabsGeneric(
  command: string,
  config: Record<string, JsonValue>,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const io = new IOResult()
  const sources = paths.map((p) => reportedStream(stream(p), io, p, command))
  const source = paths.length > 0 ? asyncChain(sources) : (ctx.stdin ?? new Uint8Array())
  return [runStream(command, config, source, ctx.signal), io]
}

/** Run expand over resolved operands with `expandConfig`'s config. Mirrors
 * Python's `expand_generic`. */
export function expandGeneric(
  config: Record<string, JsonValue>,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  return tabsGeneric('expand', config, paths, ctx, stream)
}
