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
import type { FlagValue } from '../../spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream, streamOutput } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { openStream } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'

interface ExpandFlags {
  readonly tabs: readonly string[]
  readonly initialOnly: boolean
}

export function parseFlags(bag: Record<string, FlagValue>): ExpandFlags {
  const fl = new FlagView(bag, specOf('expand'))
  const tabs = fl.asList('tabs')
  return { tabs, initialOnly: fl.asBool('initial') }
}

export async function expandGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  let engine
  try {
    engine = await openStream('expand', {
      tabs: [...parsed.tabs],
      initial_only: parsed.initialOnly,
    })
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    return [
      null,
      new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(`${error.message}\n`) }),
    ]
  }
  const io = new IOResult()
  const sources = paths.map((p) => reportedStream(stream(p), io, p, 'expand'))
  const source = paths.length > 0 ? asyncChain(sources) : (ctx.stdin ?? new Uint8Array())
  return [streamOutput(engine, source, ctx.signal), io]
}
