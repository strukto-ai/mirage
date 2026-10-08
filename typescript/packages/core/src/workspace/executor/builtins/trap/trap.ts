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
import { EXIT_EVENT, PSEUDO_SIGNALS, RUN_EVENTS, SIGNAL_MAX, USAGE } from './constants.ts'
import { TrapEvent } from './types.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'

/**
 * What a signal spec names: EXIT, ERR or RETURN, another signal bash knows
 * (which mirage cannot deliver), or nothing bash would accept. A name may
 * carry `SIG` and any case; a number is one too.
 */
export function eventOf(spec: string): TrapEvent | null {
  if (/^[0-9]+$/.test(spec)) {
    const number = Number(spec)
    if (number === 0) return TrapEvent.Exit
    return number <= SIGNAL_MAX ? TrapEvent.Other : null
  }
  const name = spec.toUpperCase()
  if ((RUN_EVENTS as readonly string[]).includes(name)) return name as TrapEvent
  if (PSEUDO_SIGNALS.has(name)) return TrapEvent.Other
  const base = name.startsWith('SIG') ? name.slice(3) : name
  if (base !== EXIT_EVENT && SIGNAL_NAMES.some(([known]) => known === base)) {
    return TrapEvent.Other
  }
  if (base.startsWith('RTMIN') || base.startsWith('RTMAX')) return TrapEvent.Other
  return null
}

/** One `trap -p` row, the action single-quoted the way bash does. */
export function listing(action: string, event: TrapEvent): string {
  return `trap -- '${action.replaceAll("'", "'\\''")}' ${event}\n`
}

/** The action registered for one of the events mirage runs. */
function trapAction(session: SessionState, event: TrapEvent): string | null {
  if (event === TrapEvent.Exit) return session.exitTrap
  if (event === TrapEvent.Err) return session.errTrap
  return session.returnTrap
}

/** Set (or with `-` reset) one event's action in this scope. */
function setTrap(session: SessionState, event: TrapEvent, action: string): void {
  const value = action === '-' ? null : action
  if (event === TrapEvent.Exit) {
    session.exitTrap = value
    session.exitTrapInherited = false
  } else if (event === TrapEvent.Err) {
    session.errTrap = value
    session.errTrapHidden = false
  } else {
    session.returnTrap = value
    session.returnTrapHidden = false
  }
}

/**
 * Register, reset or list the shell's `EXIT`, `ERR` and `RETURN` actions.
 *
 * EXIT runs where the shell ends: at `exit` (in the frame that called it),
 * at the end of a child shell, or when an error ends the shell. A line of a
 * persistent session is not the end of its shell, so it runs nothing there.
 * ERR runs after a command fails where `set -e` would act, RETURN after a
 * function or a sourced file returns (`executor/traps.ts`). Mirage delivers
 * no signals, so any other event bash knows is refused rather than accepted
 * and never run.
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
        const message = decodeText(builtinError('trap', `-${flag}: invalid option`))
        return result('trap', { exitCode: 2, stderr: message + USAGE })
      }
    }
  }
  const errors: string[] = []
  if (printing || words.length === 0) {
    const out: string[] = []
    for (const spec of words.length > 0 ? words : RUN_EVENTS) {
      const event = eventOf(spec)
      if (event === null) {
        errors.push(decodeText(builtinError('trap', `${spec}: invalid signal specification`)))
      } else if (event !== TrapEvent.Other) {
        const action = trapAction(session, event)
        if (action !== null) out.push(listing(action, event))
      }
    }
    const text = out.join('')
    return result('trap', {
      out: text !== '' ? encodeText(text) : null,
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
      errors.push(decodeText(builtinError('trap', `${spec}: invalid signal specification`)))
    } else if (event !== TrapEvent.Other) {
      setTrap(session, event, action)
    } else if (action !== '-') {
      errors.push(`mirage: trap: ${spec}: not supported\n`)
    }
  }
  return result('trap', { exitCode: errors.length > 0 ? 1 : 0, stderr: errors.join('') })
}

/** The `trap` arm. */
export function trapBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleTrap(call.argv.args, call.context.session))
}
