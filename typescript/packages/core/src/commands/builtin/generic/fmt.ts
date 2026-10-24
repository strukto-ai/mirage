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
import { EOVERFLOW_REASON, ERANGE_REASON, unsignedDecimal } from '../utils/strtol.ts'
import { quoteText } from '../../quote.ts'
import { runStream } from '../../../rs/stream.ts'
import { byteView } from '../../../shell/bytes.ts'

const DEFAULT_WIDTH = 75
// GNU 9.7 refuses a -w past 2500.
const WIDEST = 2500

interface FmtFlags {
  readonly width: number | null
  readonly goal: number | null
  readonly prefix: string | null
  readonly splitOnly: boolean
  readonly tagged: boolean
  readonly crown: boolean
  readonly uniform: boolean
}

// fmt's refusal of a -w value, past its range a range error. Mirrors Python's
// `_width_refusal`.
function widthRefusal(text: string, value: bigint | null): string {
  const reason = value === null ? '' : `: ${ERANGE_REASON}`
  return `fmt: invalid width: '${quoteText(text)}'${reason}`
}

// fmt's refusal of a -g value, past the width too large. Mirrors Python's
// `_goal_refusal`.
function goalRefusal(text: string, value: bigint | null): string {
  const reason = value === null ? '' : `: ${EOVERFLOW_REASON}`
  return `fmt: invalid width: '${quoteText(text)}'${reason}`
}

function parseFlags(bag: Record<string, FlagValue>): FmtFlags {
  const fl = new FlagView(bag, specOf('fmt'))
  // GNU 9.7 takes -w as a decimal from 0 to 2500, then -g as one from 0 to
  // that width.
  const width = fl.asNumber('width', unsignedDecimal, widthRefusal, {
    low: 0n,
    high: BigInt(WIDEST),
  })
  const goal = fl.asNumber('goal', unsignedDecimal, goalRefusal, {
    low: 0n,
    high: width ?? BigInt(DEFAULT_WIDTH),
  })
  return {
    width: width === undefined ? null : Number(width),
    goal: goal === undefined ? null : Number(goal),
    prefix: fl.asStr('prefix') ?? null,
    splitOnly: fl.asBool('split_only'),
    tagged: fl.asBool('tagged_paragraph'),
    crown: fl.asBool('crown_margin'),
    uniform: fl.asBool('uniform_spacing'),
  }
}

// Each operand is reflowed on its own. Mirrors Python's fmt_generic.
export function fmtGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  const config = {
    width: parsed.width,
    goal: parsed.goal,
    prefix: parsed.prefix === null ? null : byteView(parsed.prefix),
    split_only: parsed.splitOnly,
    tagged: parsed.tagged,
    crown: parsed.crown,
    uniform: parsed.uniform,
  }
  const io = new IOResult()
  const each = (source: ByteSource) => runStream('fmt', config, source, ctx.signal)
  return [perOperand(paths, stream, ctx.stdin, io, 'fmt', each), io]
}
