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

import { SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import { versionLine } from '../../../../commands/spec/standard.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import type { ProcessHandle } from '../../../../execution/process/handle.ts'
import { type Process, shownPid } from '../../../../execution/process/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { RegexError } from '../../../../rs/errors.ts'
import { posixRegex } from '../../../../rs/regex.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { SIGRTMAX, SIGTERM } from '../../../../shell/constants.ts'
import { signalNumber } from '../../../../shell/signals.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { grantsOf, jobResult, scanningWhile, sessionOf } from '../jobspec.ts'
import { signalOne } from '../kill/kill.ts'
import { optionRefusal, permutedOptions, processScope, usagePage } from '../machine_view.ts'
import { NAME_WIDTH, processName, programOf, running } from './shared.ts'

const SIGNAL_NAMES =
  'HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT\n' +
  'CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH POLL PWR SYS\n'

// Capital letters that are options, not the start of a signal's name.
const CAPITAL_OPTIONS: ReadonlySet<string> = new Set(['I', 'V', 'Z'])

/** A first word that names a signal, and the words after it. */
function leadingSignal(words: readonly string[]): [number | null, string, string[]] {
  const first = words[0]
  if (first === undefined || !first.startsWith('-') || first.length < 2)
    return [null, '', [...words]]
  const body = first.slice(1)
  if (/^[0-9]+$/.test(body)) return [Number(body), '', words.slice(1)]
  if (!/^[A-Z]/.test(body) || CAPITAL_OPTIONS.has(body)) return [null, '', [...words]]
  const number = signalNumber(body)
  if (number === null) return [null, body.replace(/^SIG/, ''), words.slice(1)]
  return [number, '', words.slice(1)]
}

/** The processes a name selects; null for a pattern that does not compile. */
async function picksOf(
  name: string,
  rows: readonly Process[],
  exact: boolean,
  ignoreCase: boolean,
  regexp: boolean,
): Promise<Process[] | null> {
  if (regexp) {
    let matcher
    try {
      matcher = posixRegex(name, true, 'posix', ignoreCase)
    } catch (err) {
      if (!(err instanceof RegexError)) throw err
      return null
    }
    const picks: Process[] = []
    for (const info of rows) if (await matcher.matches(processName(info))) picks.push(info)
    return picks
  }
  const folded = (text: string): string => (ignoreCase ? text.toLowerCase() : text)
  const wanted = folded(name)
  const fullName = (info: Process): string => folded(programOf(info))
  if (exact) return rows.filter((info) => fullName(info) === wanted)
  return rows.filter((info) => fullName(info).slice(0, NAME_WIDTH) === wanted.slice(0, NAME_WIDTH))
}

/**
 * Signal every process with one of the given names among those `ps` shows, on
 * every machine they run on, the way `kill` does. Answers 0 only when each
 * name found a process. A first word `-NAME` or `-NUMBER` is the signal, as
 * `-s` is. Mirrors Python's `handle_killall`.
 */
export async function handleKillall(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const leading = leadingSignal(parts.slice(1))
  let unknown = leading[1]
  const spec = SHELL_SPECS.killall
  const parse = permutedOptions(spec, leading[2])
  const flags = parse.flags
  const answer = (text: string): RedirectResult => [
    encodeText(text),
    new IOResult(),
    new ExecutionNode({ command: cmdStr, exitCode: 0 }),
  ]
  if (flags.l === true) return answer(SIGNAL_NAMES)
  if (flags.V === true) return answer(versionLine('killall'))
  if (flags.help === true) return jobResult(cmdStr, usagePage('killall'), 0)
  if (
    optionRefusal('killall', parse, false) !== '' ||
    (parse.operands.length === 0 && unknown === '')
  )
    return jobResult(cmdStr, usagePage('killall'), 1)
  let signal = leading[0] ?? SIGTERM
  if (typeof flags.s === 'string') {
    const number = /^[0-9]+$/.test(flags.s) ? Number(flags.s) : signalNumber(flags.s)
    if (number === null) unknown = flags.s.replace(/^SIG/, '')
    else signal = number
  }
  if (unknown !== '')
    return jobResult(cmdStr, `${unknown}: unknown signal; killall -l lists signals.\n`, 1)
  const machine = typeof flags.machine === 'string' ? flags.machine : null
  const processes = jobTable.processes
  const scope = processScope(processes, machine)
  if (scope === null) return jobResult(cmdStr, `killall: ${machine ?? ''}: no such machine\n`, 1)
  const rows = await running(jobTable, session, scope)
  const sid = sessionOf(session)
  const jobs = jobTable.listJobs(sid)
  const quiet = flags.q === true
  const errors: string[] = []
  let missed = false
  const gone: ProcessHandle[] = []
  for (const name of parse.operands) {
    const picks = await picksOf(name, rows, flags.e === true, flags.I === true, flags.r === true)
    if (picks === null) return jobResult(cmdStr, `killall: Bad regular expression: ${name}\n`, 1)
    let killed = 0
    for (const info of picks) {
      const pid = String(shownPid(info))
      if (signal > SIGRTMAX) {
        if (!quiet) errors.push(`${processName(info)}(${pid}): Invalid argument\n`)
        continue
      }
      let handle: ReturnType<typeof processes.target>
      let found: boolean | null
      try {
        handle = processes.target(info.id.pid, sid, grantsOf(session))
        found = await signalOne(jobTable, session, jobs, info.id.pid, signal)
      } catch (err) {
        if ((err as { code?: string }).code !== 'EPERM') throw err
        if (!quiet) errors.push(`${processName(info)}(${pid}): Operation not permitted\n`)
        continue
      }
      if (found === true) {
        killed += 1
        if (handle !== null) gone.push(handle)
        if (flags.v === true)
          errors.push(`Killed ${processName(info)}(${pid}) with signal ${String(signal)}\n`)
      }
    }
    if (killed === 0) {
      missed = true
      if (!quiet) errors.push(`${name}: no process found\n`)
    }
  }
  if (flags.w === true && gone.length > 0)
    await scanningWhile(processes, Promise.all(gone.map((handle) => handle.task)))
  const code = missed ? 1 : 0
  const err = errors.length === 0 ? null : encodeText(errors.join(''))
  return [
    new Uint8Array(),
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err ?? new Uint8Array() }),
  ]
}
