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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { pureProvision } from '../generic_bind/provision.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()

function formatWithPrintf(fmt: string, value: number): string {
  // Minimal %-format: supports %d, %i (integer), %f (float with precision),
  // %g, %s, width/padding like %03d. Covers the cases Python `fmt % v` does
  // for seq's -f flag. Unknown specifiers pass through the value as-is.
  return fmt.replace(
    /%(-?)(0?)(\d+)?(?:\.(\d+))?([diouxefgs%])/g,
    (_match: string, ...groups: string[]) => {
      const minus = groups[0] ?? ''
      const zero = groups[1] ?? ''
      const width = groups[2]
      const prec = groups[3]
      const conv = groups[4] ?? ''
      if (conv === '%') return '%'
      let out: string
      if (conv === 'd' || conv === 'i' || conv === 'o' || conv === 'u' || conv === 'x') {
        const intVal = Math.trunc(value)
        out =
          conv === 'o' ? intVal.toString(8) : conv === 'x' ? intVal.toString(16) : String(intVal)
      } else if (conv === 'e' || conv === 'f' || conv === 'g') {
        const p = prec !== undefined ? Number.parseInt(prec, 10) : 6
        out =
          conv === 'e'
            ? value.toExponential(p)
            : conv === 'g'
              ? value.toPrecision(p)
              : value.toFixed(p)
      } else {
        out = String(value)
      }
      if (width !== undefined) {
        const w = Number.parseInt(width, 10)
        if (out.length < w) {
          const pad = zero === '0' && minus !== '-' ? '0' : ' '
          const padded = pad.repeat(w - out.length)
          out = minus === '-' ? out + padded : padded + out
        }
      }
      return out
    },
  )
}

function seqGenerate(
  texts: string[],
  separator: string,
  width: string | null,
  fmt: string | null,
): string {
  const nums = texts.map((t) => Number.parseFloat(t))
  let first: number
  let step: number
  let last: number
  if (nums.length === 1) {
    first = 1
    step = 1
    last = Math.trunc(nums[0] ?? 0)
  } else if (nums.length === 2) {
    first = Math.trunc(nums[0] ?? 0)
    step = 1
    last = Math.trunc(nums[1] ?? 0)
  } else {
    first = Math.trunc(nums[0] ?? 0)
    step = Math.trunc(nums[1] ?? 1)
    last = Math.trunc(nums[2] ?? 0)
  }
  const values: number[] = []
  let cur = first
  if (step > 0) {
    while (cur <= last) {
      values.push(cur)
      cur += step
    }
  } else if (step < 0) {
    while (cur >= last) {
      values.push(cur)
      cur += step
    }
  }
  let parts: string[]
  if (fmt !== null) {
    parts = values.map((v) => formatWithPrintf(fmt, v))
  } else if (width !== null) {
    const maxAbs = values.length > 0 ? Math.max(...values.map((v) => Math.abs(v))) : 0
    const w = values.length > 0 ? String(maxAbs).length : 1
    parts = values.map((v) => String(v).padStart(w, '0'))
  } else {
    parts = values.map((v) => String(v))
  }
  return parts.join(separator) + '\n'
}

function seqCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  if (texts.length > 3) throw extraOperandError(CommandName.SEQ, texts[3] ?? '')
  const s = typeof opts.flags.s === 'string' ? opts.flags.s : null
  const w = typeof opts.flags.w === 'string' ? opts.flags.w : opts.flags.w === true ? '' : null
  const f = typeof opts.flags.f === 'string' ? opts.flags.f : null
  const separator = s ?? '\n'
  const result = seqGenerate(texts, separator, w, f)
  return [ENC.encode(result), new IOResult()]
}

export const GENERAL_SEQ = command({
  name: 'seq',
  resource: null,
  spec: specOf('seq'),
  fn: seqCommand,
  provision: pureProvision,
})
