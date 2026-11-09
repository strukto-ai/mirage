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

import {
  SIGNAL_DESCRIPTIONS,
  SIGNALS,
  SIGRTMAX,
  SIGRTMIN,
  SIGTERM,
  UNREPORTED_SIGNALS,
} from './constants.ts'

const NUMBER = /^\s*\+?([0-9]+)$/
const RTMIN = /^RTMIN\+([0-9]+)$/
const RTMAX = /^RTMAX-([0-9]+)$/

// The realtime numbers named from RTMIN in `kill -l`; the rest are named
// from RTMAX.
const RTMIN_NAMED = 15

/**
 * The name bash's `kill -l` gives a signal, without `SIG`: null for a number
 * it names nothing (32 and 33). Mirrors Python's signal_name.
 */
export function signalName(number: number): string | null {
  const known = SIGNALS.get(number)
  if (known !== undefined) return known
  if (number < SIGRTMIN || number > SIGRTMAX) return null
  if (number === SIGRTMIN) return 'RTMIN'
  if (number === SIGRTMAX) return 'RTMAX'
  if (number - SIGRTMIN <= RTMIN_NAMED) return `RTMIN+${String(number - SIGRTMIN)}`
  return `RTMAX-${String(SIGRTMAX - number)}`
}

/**
 * The signal a bash sigspec names, null if it names none. Measured on bash
 * 5.2: a number may lead with blanks and `+` and names any signal up to 64;
 * a name is read in any case, with or without `SIG`, `EXIT` is 0, `RTMIN+n`
 * reaches up to RTMAX and `RTMAX-n` is only the names `kill -l` lists.
 * Mirrors Python's signal_number.
 */
export function signalNumber(spec: string): number | null {
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(spec)) return null
  const number = NUMBER.exec(spec)
  if (number !== null) {
    const value = Number(number[1])
    return value <= SIGRTMAX ? value : null
  }
  let name = spec.toUpperCase()
  if (name.startsWith('SIG')) name = name.slice(3)
  if (name === 'EXIT') return 0
  for (const [value, known] of SIGNALS) if (known === name) return value
  if (name === 'RTMIN') return SIGRTMIN
  if (name === 'RTMAX') return SIGRTMAX
  const above = RTMIN.exec(name)
  if (above !== null && Number(above[1]) <= SIGRTMAX - SIGRTMIN) return SIGRTMIN + Number(above[1])
  const below = RTMAX.exec(name)
  if (below !== null) {
    const value = SIGRTMAX - Number(below[1])
    return signalName(value) === name ? value : null
  }
  return null
}

/**
 * What `kill -l` prints for one operand: a number's name (one of 128 plus a
 * signal names that signal, as a `$?` does), empty for a number naming
 * nothing (32 and 33), a name's number; null for a word that names no
 * signal. Mirrors Python's listed_signal.
 */
export function listedSignal(word: string): string | null {
  // eslint-disable-next-line no-control-regex
  const number = /^[\x00-\x7f]*$/.test(word) ? NUMBER.exec(word) : null
  if (number === null) {
    const value = signalNumber(word)
    return value === null ? null : String(value)
  }
  let value = Number(number[1])
  if (value > 128 && value <= 128 + SIGRTMAX) value -= 128
  else if (value > SIGRTMAX) return null
  return value === 0 ? 'EXIT' : (signalName(value) ?? '')
}

/**
 * How bash's report line names a signal that ended a command, null for one
 * whose default never ends a process. Mirrors Python's signal_description.
 */
export function signalDescription(number: number): string | null {
  const known = SIGNAL_DESCRIPTIONS.get(number)
  if (known !== undefined) return known
  if (number >= SIGRTMIN && number <= SIGRTMAX)
    return `Real-time signal ${String(number - SIGRTMIN)}`
  return null
}

/**
 * bash's `kill -l` listing: every named signal as `N) SIGNAME`, five to a
 * line, a tab after each but the fifth. Mirrors Python's signal_table.
 */
export function signalTable(): string {
  const entries: string[] = []
  for (let number = 1; number <= SIGRTMAX; number++) {
    const name = signalName(number)
    if (name !== null) entries.push(`${String(number).padStart(2)}) SIG${name}`)
  }
  const lines: string[] = []
  for (let start = 0; start < entries.length; start += 5)
    lines.push(entries.slice(start, start + 5).join('\t'))
  return lines.join('\n') + (entries.length % 5 !== 0 ? '\t' : '') + '\n'
}

/**
 * How bash's report names how a process ended: the signal's description,
 * `Done` or `Exit N`. Mirrors Python's _process_status.
 */
export function processStatus(code: number, signal: number | null): string {
  if (signal !== null) {
    const described = signalDescription(signal)
    if (described !== null) return described
  }
  return code === 0 ? 'Done' : `Exit ${String(code)}`
}

/**
 * Whether bash's report of a job lists its processes: a signal other than
 * INT, PIPE and TERM ended its last one (null for an exit). Mirrors Python's
 * signal_reported.
 */
export function signalReported(signal: number | null): boolean {
  return signal !== null && !UNREPORTED_SIGNALS.has(signal) && signal !== SIGTERM
}

/**
 * bash's report of a job a signal ended, one line per process: the first
 * after the shell's voice, the rest indented after a `|`, each status the
 * process before gave left blank. Empty unless a signal ended the last
 * process; INT and PIPE end it unreported, and TERM as `Terminated` alone in
 * the foreground and unreported behind it. Each process is its pid, exit
 * status, the signal that ended it (null for an exit) and command. Mirrors
 * Python's signal_report.
 */
export function signalReport(
  voice: string,
  processes: readonly (readonly [number, number, number | null, string])[],
  foreground: boolean,
): string {
  const signal = processes[processes.length - 1]?.[2] ?? null
  if (signal === SIGTERM) return foreground ? 'Terminated\n' : ''
  if (!signalReported(signal)) return ''
  const lines: string[] = []
  let before: string | null = null
  for (const [pid, code, ended, command] of processes) {
    const status = processStatus(code, ended)
    const id = String(pid).padStart(5)
    if (before === null) lines.push(`${voice}${id} ${status.padEnd(24)}${command}`)
    else if (status === before) lines.push(`     ${id} ${''.padEnd(22)}| ${command}`)
    else lines.push(`     ${id} ${status.padEnd(24)}| ${command}`)
    before = status
  }
  return `${lines.join('\n')}\n`
}
