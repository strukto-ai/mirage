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
import { byteView } from '../../../shell/bytes.ts'

export interface FmtFlags {
  readonly width: number | null
  readonly goal: number | null
  readonly prefix: string | null
  readonly splitOnly: boolean
  readonly tagged: boolean
  readonly crown: boolean
  readonly uniform: boolean
}

/**
 * fmt's options, -w and -g read by mirage-rs before any operand is resolved:
 * the flags, or fmt's refusal of a width. Mirrors Python's `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): FmtFlags | IOResult {
  const fl = new FlagView(bag, specOf('fmt'))
  let values
  try {
    values = scan('fmt', fl.texts('width', 'goal'))
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const { width, goal } = values
  return {
    width: typeof width === 'number' ? width : null,
    goal: typeof goal === 'number' ? goal : null,
    prefix: fl.asStr('prefix') ?? null,
    splitOnly: fl.asBool('split_only'),
    tagged: fl.asBool('tagged_paragraph'),
    crown: fl.asBool('crown_margin'),
    uniform: fl.asBool('uniform_spacing'),
  }
}

// Each operand is reflowed on its own. Mirrors Python's fmt_generic.
export function fmtGeneric(
  parsed: FmtFlags,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
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
