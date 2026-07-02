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

const ENC = new TextEncoder()

const ARITH_OPS = new Set(['+', '-', '*', '/', '%'])
const CMP_OPS = new Set(['=', '!=', '<', '>', '<=', '>='])

function parseIntStrict(s: string): number | null {
  if (!/^-?\d+$/.test(s)) return null
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

function exprEval(args: string[]): [string, number] {
  if (args.length === 3 && args[1] === ':') {
    const [str, , pattern] = args as [string, string, string]
    // Python `re.match` is anchored at the start. Mirror that.
    const re = new RegExp('^(?:' + pattern + ')')
    const m = re.exec(str)
    let result: string
    if (m === null) {
      result = ''
    } else if (m.length > 1 && m[1] !== undefined) {
      result = m[1]
    } else {
      result = String(m[0].length)
    }
    const exitCode = result === '' || result === '0' ? 1 : 0
    return [result, exitCode]
  }
  if (args.length === 3 && typeof args[1] === 'string' && ARITH_OPS.has(args[1])) {
    const a = parseIntStrict(args[0] ?? '')
    const b = parseIntStrict(args[2] ?? '')
    if (a === null || b === null) return ['', 2]
    let val: number
    switch (args[1]) {
      case '+':
        val = a + b
        break
      case '-':
        val = a - b
        break
      case '*':
        val = a * b
        break
      case '/':
        val = Math.trunc(a / b)
        break
      default:
        val = a % b
        break
    }
    const result = String(val)
    const exitCode = result === '0' ? 1 : 0
    return [result, exitCode]
  }
  if (args.length === 3 && typeof args[1] === 'string' && CMP_OPS.has(args[1])) {
    const [left, op, right] = args as [string, string, string]
    const l = parseIntStrict(left)
    const r = parseIntStrict(right)
    let cmp: boolean
    if (l !== null && r !== null) {
      switch (op) {
        case '=':
          cmp = l === r
          break
        case '!=':
          cmp = l !== r
          break
        case '<':
          cmp = l < r
          break
        case '>':
          cmp = l > r
          break
        case '<=':
          cmp = l <= r
          break
        case '>=':
          cmp = l >= r
          break
        default:
          cmp = false
          break
      }
    } else {
      switch (op) {
        case '=':
          cmp = left === right
          break
        case '!=':
          cmp = left !== right
          break
        case '<':
          cmp = left < right
          break
        case '>':
          cmp = left > right
          break
        case '<=':
          cmp = left <= right
          break
        case '>=':
          cmp = left >= right
          break
        default:
          cmp = false
          break
      }
    }
    const val = cmp ? 1 : 0
    const result = String(val)
    const exitCode = result === '0' ? 1 : 0
    return [result, exitCode]
  }
  return ['', 2]
}

function exprCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  _opts: CommandOpts,
): CommandFnResult {
  if (texts.length === 0) {
    return [ENC.encode('\n'), new IOResult({ exitCode: 2 })]
  }
  const [result, exitCode] = exprEval(texts)
  return [ENC.encode(result + '\n'), new IOResult({ exitCode })]
}

export const GENERAL_EXPR = command({
  name: 'expr',
  resource: null,
  spec: specOf('expr'),
  fn: exprCommand,
  provision: pureProvision,
})
