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

import { boundedDecimal } from '../../../../commands/builtin/utils/strtol.ts'
import { currentCaller, type RedirectResult } from '../../../../context/session_context.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import type { ProcessHandle } from '../../../../execution/process/handle.ts'
import type { SessionState } from '../../../session/session.ts'
import { builtinError, builtinUsage, result } from '../shared.ts'
import { SHELL_IGNORED_SIGNALS, SIGNALS } from '../../../../shell/constants.ts'
import { signalName, signalNumber } from '../../../../shell/signals.ts'
import { armSignals } from '../../traps.ts'
import type { BuiltinCall } from '../types.ts'
import { RUN_EVENTS, SIGNAL_MAX } from './constants.ts'
import { TrapEvent } from './types.ts'

/**
 * What a signal spec names: EXIT, ERR, RETURN or DEBUG, a signal's number, or
 * nothing bash would accept. A name may carry `SIG` and any case; a number is
 * one too.
 */
export function eventOf(spec: string): TrapEvent | number | null {
  if (/^[0-9]+$/.test(spec)) {
    const number = boundedDecimal(spec, BigInt(SIGNAL_MAX) + 1n)
    if (number === null) return null
    return number === 0n ? TrapEvent.Exit : Number(number)
  }
  const name = spec.toUpperCase()
  if ((Object.values(TrapEvent) as string[]).includes(name)) return name as TrapEvent
  const base = name.startsWith('SIG') ? name.slice(3) : name
  if ([...SIGNALS.values()].includes(base) || base.startsWith('RT')) return signalNumber(base)
  return null
}

/** One `trap -p` row, the action single-quoted the way bash does. */
export function listing(action: string, event: TrapEvent | number): string {
  const known = typeof event === 'number' ? signalName(event) : null
  const name = typeof event === 'number' ? (known === null ? String(event) : `SIG${known}`) : event
  return `trap -- '${action.replaceAll("'", "'\\''")}' ${name}\n`
}

/** The action a shell lists for an event or signal, null for none. */
function actionOf(session: SessionState, event: TrapEvent | number): string | null {
  if (typeof event === 'number') return session.signalTraps.get(event) ?? null
  if (event === TrapEvent.Debug) return null
  return session[RUN_EVENTS[event][0]]
}

/** What `trap -p` lists with no operand, in bash's order. */
function registered(session: SessionState): (TrapEvent | number)[] {
  return [
    TrapEvent.Exit,
    ...[...session.signalTraps.keys()].sort((a, b) => a - b),
    TrapEvent.Err,
    TrapEvent.Return,
  ]
}

/**
 * Drop the EXIT and signal actions a child shell lists as its parent's, as
 * its first registration does in bash; the signals its parent ignores stay
 * ignored. Mirrors Python's _own_traps.
 */
function ownTraps(session: SessionState): void {
  if (session.exitTrapInherited) {
    session.exitTrap = null
    session.exitTrapInherited = false
  }
  if (session.signalTrapsInherited) {
    session.signalTraps = new Map([...session.signalTraps].filter(([, action]) => action === ''))
    session.signalTrapsInherited = false
  }
}

/**
 * Register, reset or list the shell's actions.
 *
 * EXIT runs where the shell ends: at `exit` (in the frame that called it),
 * at the end of a child shell, or when an error ends the shell. A line of a
 * persistent session is not the end of its shell, so it runs nothing there.
 * ERR runs after a command fails where `set -e` would act, RETURN after a
 * function or a sourced file returns (`executor/traps.ts`). A signal's
 * action runs once the command running as it arrives (`kill`) has ended,
 * and an empty one ignores the signal; one ignored as the shell started
 * stays ignored, and KILL and STOP are listed and never caught, as bash's
 * are. DEBUG is refused rather than accepted and never run. `shell` is the
 * process the shell runs as, its frame's (`armSignals`).
 */
export function handleTrap(
  args: readonly string[],
  session: SessionState,
  shell: ProcessHandle | null = null,
): RedirectResult {
  const words = [...args]
  let printing = false
  for (let word = words[0]; word?.startsWith('-') === true && word !== '-'; word = words[0]) {
    words.shift()
    if (word === '--') break
    for (const flag of word.slice(1)) {
      if (flag === 'p') printing = true
      else if (flag === 'l') {
        return result('trap', {
          exitCode: 2,
          stderr: decodeText(builtinError('trap', '-l: not supported')),
        })
      } else {
        const message = decodeText(builtinError('trap', `-${flag}: invalid option`))
        return result('trap', { exitCode: 2, stderr: message + builtinUsage('trap') })
      }
    }
  }
  const errors: string[] = []
  if (printing || words.length === 0) {
    const out: string[] = []
    const named: [string, TrapEvent | number | null][] =
      words.length > 0
        ? words.map((spec) => [spec, eventOf(spec)])
        : registered(session).map((event) => [String(event), event])
    for (const [spec, event] of named) {
      if (event === null) {
        errors.push(decodeText(builtinError('trap', `${spec}: invalid signal specification`)))
        continue
      }
      const action = actionOf(session, event)
      if (action !== null) out.push(listing(action, event))
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
    return result('trap', { exitCode: 2, stderr: builtinUsage('trap') })
  }
  const action = rest.length === 0 ? '-' : first
  const specs = rest.length === 0 ? words : rest
  for (const spec of specs) {
    const event = eventOf(spec)
    if (event === null) {
      errors.push(decodeText(builtinError('trap', `${spec}: invalid signal specification`)))
    } else if (event === TrapEvent.Debug) {
      if (action !== '-') errors.push(decodeText(builtinError('trap', `${spec}: not supported`)))
    } else if (typeof event === 'number') {
      ownTraps(session)
      if (session.entryIgnored.has(event)) continue
      ownSignal(session, event)
      if (action === '-') session.signalTraps.delete(event)
      else session.signalTraps.set(event, action)
    } else {
      if (event === TrapEvent.Exit) ownTraps(session)
      const [field, scoped] = RUN_EVENTS[event]
      session[field] = action === '-' ? null : action
      session[scoped] = false
    }
  }
  armSignals(session, shell)
  return result('trap', { exitCode: errors.length > 0 ? 1 : 0, stderr: errors.join('') })
}

/**
 * Make a signal the shell traps, ignores or resets its own to answer: its
 * process stops ignoring the signal its parent's `trap ''` or its job made it
 * ignore, so the shell's action, ignore or default decides, as bash's child
 * resets one (`(trap - TERM; ...)`). The QUIT every shell's process ignores
 * stays ignored. Mirrors Python's _own_signal.
 *
 * @param session the shell registering.
 * @param signal the signal.
 */
function ownSignal(session: SessionState, signal: number): void {
  session.jobIgnored = new Set([...session.jobIgnored].filter((other) => other !== signal))
  const process = currentCaller().process
  if (process === null || SHELL_IGNORED_SIGNALS.has(signal)) return
  process.ignores = new Set([...process.ignores].filter((other) => other !== signal))
  process.programIgnores = new Set([...process.programIgnores].filter((other) => other !== signal))
}

/** The `trap` arm. */
export function trapBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return Promise.resolve(handleTrap(call.argv.args, call.context.session, call.context.frame.shell))
}
