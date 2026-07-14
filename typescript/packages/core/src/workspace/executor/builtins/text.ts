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

import { interpretEscapes } from '../../../commands/builtin/utils/escapes.ts'
import { ECHO_OPTION } from '../../../commands/spec/shell.ts'
import { IOResult } from '../../../io/types.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

/**
 * Print arguments, honoring GNU echo's option rules.
 *
 * GNU echo is not getopt: options are LEADING words matching `-[neE]+`
 * only. The first word that does not match (including `-x` or a
 * repeated `hi -n`) ends option parsing and prints literally. Within
 * clusters the last of -e/-E wins; -n sticks.
 */
export function handleEcho(args: string[]): Result {
  let noNewline = false
  let escapes = false
  let idx = 0
  for (const word of args) {
    if (!ECHO_OPTION.test(word)) break
    for (const ch of word.slice(1)) {
      if (ch === 'n') noNewline = true
      else if (ch === 'e') escapes = true
      else escapes = false
    }
    idx += 1
  }
  let text = args.slice(idx).join(' ')
  if (escapes) text = interpretEscapes(text)
  if (!noNewline) text += '\n'
  const out = new TextEncoder().encode(text)
  return [out, new IOResult(), new ExecutionNode({ command: 'echo', exitCode: 0 })]
}

export function handlePrintf(args: string[]): Result {
  if (args.length === 0) {
    return [new Uint8Array(), new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
  }
  let fmt = args[0] ?? ''
  fmt = fmt.replaceAll('\\n', '\n').replaceAll('\\t', '\t')
  let result = fmt
  if (args.length > 1) {
    try {
      result = applyPrintf(fmt, args.slice(1))
    } catch {
      result = fmt
    }
  }
  const out = new TextEncoder().encode(result)
  return [out, new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
}

function applyPrintf(fmt: string, values: string[]): string {
  let argIdx = 0
  return fmt.replace(/%[sd]/g, (match) => {
    const v = values[argIdx++] ?? ''
    if (match === '%s') return v
    const n = Number(v)
    return Number.isFinite(n) ? String(Math.trunc(n)) : v
  })
}

/**
 * `read VAR1 [VAR2 ...]` — read one line from stdin and assign to env vars.
 * Mirrors Python's `mirage.workspace.executor.builtins.handle_read`.
 *
 * Mirrors POSIX behavior:
 *   - Single var: assign whole line.
 *   - Multiple vars: split on whitespace, last var gets the remainder.
 *   - No stdin / EOF: assign all vars to "" and exit 1.
 */
