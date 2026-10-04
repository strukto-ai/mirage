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

import type { SessionState } from '../../../session/session.ts'
import { builtinError, result } from '../shared.ts'
import { SIGNAL_NAMES } from '../timeout/constants.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { EXIT_EVENT, PSEUDO_SIGNALS, SIGNAL_MAX, USAGE } from './constants.ts'
import { TrapEvent } from './types.ts'

const DEC = new TextDecoder()

/**
 * What a signal spec names: EXIT, another signal bash knows (which mirage
 * cannot deliver), or nothing bash would accept. A name may carry `SIG`
 * and any case; a number is one too.
 */
export function eventOf(spec: string): TrapEvent | null {
  if (/^[0-9]+$/.test(spec)) {
    const number = Number(spec)
    if (number === 0) return TrapEvent.Exit
    return number <= SIGNAL_MAX ? TrapEvent.Other : null
  }
  const name = spec.toUpperCase()
  if (name === EXIT_EVENT) return TrapEvent.Exit
  if (PSEUDO_SIGNALS.has(name)) return TrapEvent.Other
  const base = name.startsWith('SIG') ? name.slice(3) : name
  if (base !== EXIT_EVENT && SIGNAL_NAMES.some(([known]) => known === base)) {
    return TrapEvent.Other
  }
  if (base.startsWith('RTMIN') || base.startsWith('RTMAX')) return TrapEvent.Other
  return null
}

/** One `trap -p` row, the action single-quoted the way bash does. */
export function listing(action: string): string {
  return `trap -- '${action.replaceAll("'", "'\\''")}' ${EXIT_EVENT}\n`
}

/**
 * Register, reset or list the shell's `EXIT` action.
 *
 * The action runs where the shell ends: at `exit` (in the frame that
 * called it), at the end of a child shell, or when an error ends the
 * shell. A line of a persistent session is not the end of its shell, so
 * it runs nothing there. Mirage delivers no signals, so any other event
 * bash knows is refused rather than accepted and never run.
 */
export function handleTrap(args: readonly string[], session: SessionState): Result {
  const words = [...args]
  let printing = false
  for (let word = words[0]; word?.startsWith('-') === true && word !== '-'; word = words[0]) {
    words.shift()
    if (word === '--') break
    for (const flag of word.slice(1)) {
      if (flag === 'p') printing = true
      else if (flag === 'l') {
        return result('trap', { exitCode: 2, stderr: 'mirage: trap: -l: not supported\n' })
      } else {
        const message = DEC.decode(builtinError('trap', `-${flag}: invalid option`))
        return result('trap', { exitCode: 2, stderr: message + USAGE })
      }
    }
  }
  const errors: string[] = []
  if (printing || words.length === 0) {
    const out: string[] = []
    for (const spec of words.length > 0 ? words : [EXIT_EVENT]) {
      const event = eventOf(spec)
      if (event === null) {
        errors.push(DEC.decode(builtinError('trap', `${spec}: invalid signal specification`)))
      } else if (event === TrapEvent.Exit && session.exitTrap !== null) {
        out.push(listing(session.exitTrap))
      }
    }
    const text = out.join('')
    return result('trap', {
      out: text !== '' ? new TextEncoder().encode(text) : null,
      exitCode: errors.length > 0 ? 1 : 0,
      stderr: errors.join(''),
    })
  }
  const [first = '', ...rest] = words
  if (rest.length === 0 && eventOf(first) === null) {
    return result('trap', { exitCode: 2, stderr: USAGE })
  }
  const action = rest.length === 0 ? '-' : first
  const specs = rest.length === 0 ? words : rest
  for (const spec of specs) {
    const event = eventOf(spec)
    if (event === null) {
      errors.push(DEC.decode(builtinError('trap', `${spec}: invalid signal specification`)))
    } else if (event === TrapEvent.Exit) {
      session.exitTrap = action === '-' ? null : action
      session.exitTrapInherited = false
    } else if (action !== '-') {
      errors.push(`mirage: trap: ${spec}: not supported\n`)
    }
  }
  return result('trap', { exitCode: errors.length > 0 ? 1 : 0, stderr: errors.join('') })
}

/** The `trap` arm. */
export function trapBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleTrap(call.argv.args, call.session))
}
