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
import { ERANGE_REASON, ULONG_MAX, unsignedDecimal } from '../utils/strtol.ts'
import { quoteText } from '../../quote.ts'
import { runStream } from '../../../rs/stream.ts'

// GNU fold's line width when -w names none.
const WIDTH = 80n

// GNU 9.7 takes -w as a decimal from 1 to 2**64 - 10, so 0 and anything past
// this are out of range.
const WIDTH_MAX = ULONG_MAX - 9n

type Count = 'columns' | 'characters' | 'bytes'

// fold's refusal of a -w value, the range clause only for a number. Mirrors
// Python's `_width_refusal`.
function widthRefusal(text: string, value: bigint | null): string {
  const reason = value === null ? '' : `: ${ERANGE_REASON}`
  return `fold: invalid number of columns: '${quoteText(text)}'${reason}`
}

interface FoldFlags {
  readonly width: bigint
  readonly breakSpaces: boolean
  readonly count: Count
}

function parseFlags(bag: Record<string, FlagValue>): FoldFlags {
  const fl = new FlagView(bag, specOf('fold'))
  const width = fl.asNumber('width', unsignedDecimal, widthRefusal, { low: 1n, high: WIDTH_MAX })
  // The later of -b and -c wins, as in GNU 9.10.
  let count: Count = 'columns'
  for (const name of fl.typedOrder('bytes', 'characters')) {
    count = name === 'bytes' ? 'bytes' : 'characters'
  }
  return { width: width ?? WIDTH, breakSpaces: fl.asBool('spaces'), count }
}

// Each operand is folded on its own, from column 0. Mirrors Python's
// fold_generic.
export function foldGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const { width, breakSpaces, count } = parseFlags(ctx.flags)
  // A width past 2**53 is past any line, so the nearest double serves.
  const config = { width: Number(width), spaces: breakSpaces, count }
  const io = new IOResult()
  const each = (source: ByteSource) => runStream('fold', config, source, ctx.signal)
  return [perOperand(paths, stream, ctx.stdin, io, 'fold', each), io]
}
