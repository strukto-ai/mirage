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
import { stdinStream } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { runStream } from '../../../rs/stream.ts'
import { readTabStops, tabConfig, type TabStops } from './expand.ts'

const ENC = new TextEncoder()

interface UnexpandFlags {
  readonly tabs: TabStops
  readonly allSpaces: boolean
}

// Read unexpand's flags once, refusing a tab list GNU refuses: the stderr text
// in its place. A tab list implies -a, and --first-only overrides both (GNU
// 9.7). Mirrors Python's parse_flags.
function parseFlags(bag: Record<string, FlagValue>): UnexpandFlags | string {
  const fl = new FlagView(bag, specOf('unexpand'))
  const lists = fl.asList('tabs')
  const tabs = readTabStops(lists, 'unexpand')
  if (typeof tabs === 'string') return tabs
  return {
    tabs,
    allSpaces: (fl.asBool('all') || lists.length > 0) && !fl.asBool('first_only'),
  }
}

export function unexpandGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const io = new IOResult()
  const sources = paths.map((p) => reportedStream(stream(p), io, p, 'unexpand'))
  const config = { tabs: tabConfig(parsed.tabs), all: parsed.allSpaces }
  const source = paths.length > 0 ? asyncChain(sources) : (ctx.stdin ?? new Uint8Array())
  return [runStream('unexpand', config, source, ctx.signal), io]
}
