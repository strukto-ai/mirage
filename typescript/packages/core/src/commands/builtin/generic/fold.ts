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
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { perOperand } from '../utils/operands.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { runStream } from '../../../rs/stream.ts'

// GNU fold's line width when -w names none.
const WIDTH = 80

type Count = 'columns' | 'characters' | 'bytes'

export interface FoldFlags {
  readonly width: number
  readonly breakSpaces: boolean
  readonly count: Count
}

/**
 * fold's options, -w read by mirage-rs before any operand is resolved: the
 * flags, or fold's refusal of a -w. Mirrors Python's `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): FoldFlags | IOResult {
  const fl = new FlagView(bag, specOf('fold'))
  let width
  try {
    width = scan('fold', fl.texts('width')).width
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  // The later of -b and -c wins, as in GNU 9.10.
  let count: Count = 'columns'
  for (const name of fl.typedOrder('bytes', 'characters')) {
    count = name === 'bytes' ? 'bytes' : 'characters'
  }
  // A width past 2**53 is past any line, so the nearest double serves.
  return {
    width: typeof width === 'number' ? width : WIDTH,
    breakSpaces: fl.asBool('spaces'),
    count,
  }
}

// Each operand is folded on its own, from column 0. Mirrors Python's
// fold_generic.
export function foldGeneric(
  parsed: FoldFlags,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const { width, breakSpaces, count } = parsed
  const config = { width, spaces: breakSpaces, count }
  const io = new IOResult()
  const each = (source: ByteSource) => runStream('fold', config, source, ctx.signal)
  return [perOperand(paths, stream, ctx.stdin, io, 'fold', each), io]
}
