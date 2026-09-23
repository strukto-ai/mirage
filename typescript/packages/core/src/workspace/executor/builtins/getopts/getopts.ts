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

import { IOResult } from '../../../../io/types.ts'
import type { CallStack } from '../../../../shell/call_stack.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { ReadonlyVariableError } from '../../../session/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { isValidName, requireView } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'

async function getoptsFinish(
  session: SessionState,
  view: SessionView,
  name: string,
  optValue: string,
  optarg: string | null,
  newOptind: number,
  newPos: number,
  exitCode: number,
  stderr: Uint8Array | null = null,
): Promise<Result> {
  // The name is assigned last, exactly as bash does: OPTIND/OPTARG and
  // the hidden cursor still advance, but a bad destination fails the
  // write and turns the call into a status-1 error. Writes go through
  // the session view, so a preSession policy or a readonly OPTARG /
  // OPTIND refuses here too.
  try {
    if (!isValidName(name)) {
      stderr = new TextEncoder().encode(`bash: getopts: \`${name}': not a valid identifier\n`)
      exitCode = 1
    } else if (session.readonlyVars.has(name)) {
      stderr = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
      exitCode = 1
    } else {
      await view.set(name, optValue)
    }
    if (optarg === null) await view.unset('OPTARG')
    else await view.set('OPTARG', optarg)
    await view.set('OPTIND', String(newOptind))
  } catch (err) {
    if (err instanceof ReadonlyVariableError) {
      stderr = new TextEncoder().encode(`bash: ${err.varName}: readonly variable\n`)
      exitCode = 1
    } else if (err instanceof PolicyDenied) {
      stderr = new TextEncoder().encode(`${err.message}\n`)
      exitCode = 1
    } else {
      throw err
    }
  }
  session.getoptsPos = newPos
  session.getoptsOptind = newOptind
  const io = new IOResult(stderr === null ? { exitCode } : { exitCode, stderr })
  const node =
    stderr === null
      ? new ExecutionNode({ command: 'getopts', exitCode })
      : new ExecutionNode({ command: 'getopts', exitCode, stderr })
  return [null, io, node]
}

/** Parse one option per call, with bash's getopts semantics. */
export async function handleGetopts(
  args: readonly string[],
  session: SessionState,
  callStack: CallStack | null = null,
  state: SessionView | null = null,
): Promise<Result> {
  if (args.length < 2) {
    const err = new TextEncoder().encode('getopts: usage: getopts optstring name [arg]\n')
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'getopts', exitCode: 2, stderr: err }),
    ]
  }
  const view = requireView(state)
  const optstring = args[0] ?? ''
  const name = args[1] ?? ''
  let params: readonly string[]
  if (args.length > 2) params = args.slice(2)
  else if (callStack !== null && callStack.getAllPositional().length > 0)
    params = callStack.getAllPositional()
  else params = session.positionalArgs
  const silent = optstring.startsWith(':')
  const verbose = !silent && (session.env.OPTERR ?? '1') !== '0'
  const parsed = Number.parseInt(session.env.OPTIND ?? '1', 10)
  let optind = Number.isNaN(parsed) ? 1 : parsed
  // Bash treats a nonpositive OPTIND as a restart at argument 1.
  const restart = optind < 1
  if (restart) optind = 1
  if (restart || session.getoptsOptind !== optind) session.getoptsPos = 0
  let pos = session.getoptsPos

  if (optind > params.length) {
    return getoptsFinish(session, view, name, '?', null, optind, 0, 1)
  }
  const word = params[optind - 1] ?? ''
  // A stale cursor left past the end of the current word (a shorter or
  // reused argument) restarts the scan rather than reading undefined.
  if (pos >= word.length) pos = 0
  if (pos === 0) {
    if (!word.startsWith('-') || word === '-') {
      return getoptsFinish(session, view, name, '?', null, optind, 0, 1)
    }
    if (word === '--') return getoptsFinish(session, view, name, '?', null, optind + 1, 0, 1)
    pos = 1
  }

  const letter = word[pos] ?? ''
  const rest = word.slice(pos + 1)
  const idx = optstring.indexOf(letter)
  const isValid = letter !== ':' && idx !== -1
  const takesArg = isValid && idx + 1 < optstring.length && optstring[idx + 1] === ':'
  const enc = new TextEncoder()

  if (!isValid) {
    const [afterOptind, afterPos] = rest ? [optind, pos + 1] : [optind + 1, 0]
    if (silent) return getoptsFinish(session, view, name, '?', letter, afterOptind, afterPos, 0)
    const err = verbose ? enc.encode(`bash: illegal option -- ${letter}\n`) : null
    return getoptsFinish(session, view, name, '?', null, afterOptind, afterPos, 0, err)
  }

  if (!takesArg) {
    const [afterOptind, afterPos] = rest ? [optind, pos + 1] : [optind + 1, 0]
    return getoptsFinish(session, view, name, letter, null, afterOptind, afterPos, 0)
  }

  if (rest) return getoptsFinish(session, view, name, letter, rest, optind + 1, 0, 0)
  if (optind < params.length) {
    return getoptsFinish(session, view, name, letter, params[optind] ?? '', optind + 2, 0, 0)
  }
  if (silent) return getoptsFinish(session, view, name, ':', letter, optind + 1, 0, 0)
  const err = verbose ? enc.encode(`bash: option requires an argument -- ${letter}\n`) : null
  return getoptsFinish(session, view, name, '?', null, optind + 1, 0, 0, err)
}

/** The `getopts` arm. */
export async function getoptsBuiltin(call: BuiltinCall): Promise<Result> {
  return handleGetopts(
    [...call.argv.args],
    call.session,
    call.callStack,
    sessionView(call.session, call.registry.policies),
  )
}
