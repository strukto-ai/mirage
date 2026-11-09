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

import { shellVoice } from '../../../../shell/voice.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { CallStack } from '../../../../shell/call_stack.ts'
import { FUNCNAME } from '../../../../shell/constants.ts'
import type { EvaluationContext } from '../../../evaluation.ts'
import { runOnShell } from '../../../expand/node.ts'
import type { ExecuteFn } from '../../../expand/types.ts'
import { deciding } from '../../../session/state.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { flagHelp } from '../help/help.ts'
import { builtinUsage, fail, written } from '../shared.ts'
import type { BuiltinCall } from '../types.ts'

/**
 * Read `unset`'s options, unset its operands on the shell, then drop the
 * functions and the host's own state the operands named.
 */
export async function handleUnset(
  args: readonly string[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<RedirectResult> {
  if (args[0] === '--help') {
    const answered = flagHelp('unset')
    if (answered !== null) return answered
  }
  const letters = new Set<string>()
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-') && args[i] !== '-') {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (/^-[vfn]+$/.test(tok)) {
      for (const letter of tok.slice(1)) letters.add(letter)
      i += 1
      continue
    }
    return fail(
      'unset',
      `${shellVoice()}unset: ${tok}: invalid option\n${builtinUsage('unset')}`,
      2,
    )
  }
  if (letters.has('f') && letters.has('v')) {
    return fail(
      'unset',
      `${shellVoice()}unset: cannot simultaneously unset a function and a variable\n`,
    )
  }
  const session = context.session
  const operands = args.slice(i)
  const [pieces, status, functions, tracked] = (await runOnShell(
    (shell) =>
      shell.unsetNames(
        [...letters].sort(compareCodePoints).join(''),
        operands,
        operands.filter((name) => name in session.functions),
        operands.filter((name) => session.readonlyFunctions.has(name)),
        deciding(),
      ),
    context,
    executeFn,
    callStack,
  )) as readonly [
    readonly (readonly [boolean, Uint8Array])[],
    number,
    readonly string[],
    readonly string[],
  ]
  for (const name of functions) session.removeFunction(name)
  if (tracked.includes('OPTIND')) session.getoptsOptind = null
  if (tracked.includes(FUNCNAME)) session.functionNames = null
  return written('unset', pieces, status)
}

/** The `unset` arm. */
export function unsetBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return handleUnset([...call.argv.args], call.context, call.executeFn, call.callStack)
}
