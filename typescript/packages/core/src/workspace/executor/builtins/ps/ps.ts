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

import { UNKNOWN_NAME } from '../../../../commands/builtin/utils/identity.ts'
import { gnuStrftime } from '../../../../commands/builtin/utils/strftime.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import type { Process } from '../../../../execution/process/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { systemNow } from '../../../../utils/clock.ts'
import { LOCAL_ZONE, zoneFromEnv } from '../../../../utils/timezone.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { MAX_PID_OPERAND } from '../constants.ts'
import { jobResult, processView, sessionOf } from '../jobspec.ts'
import * as constants from './constants.ts'
import type { PsContext, PsOptions } from './types.ts'

/** One `-p` list, refused in procps's words. */
function psPids(value: string, option: string): number[] {
  const tokens = value.split(/[\s,]+/).filter((t) => t !== '')
  if (tokens.length === 0) throw new Error(`list of process IDs must follow ${option}`)
  return tokens.map((token) => {
    if (!/^[+-]?[0-9]+$/.test(token)) throw new Error('process ID list syntax error')
    const number = Number(token)
    if (number <= 0 || number > MAX_PID_OPERAND) throw new Error('process ID out of range')
    return number
  })
}

/** One `-o` list: `key` or `key=header`, refused in procps's words. */
function psColumns(value: string, option: string): [string, string][] {
  if (value.trim() === '') throw new Error(`format specification must follow ${option}`)
  const columns: [string, string][] = []
  for (const item of value.split(',')) {
    if (item.trim() === '') throw new Error('improper format list')
    for (const token of item.split(/\s+/).filter((t) => t !== '')) {
      const equal = token.indexOf('=')
      const key = equal < 0 ? token : token.slice(0, equal)
      const column = constants.COLUMNS[key]
      if (column === undefined) throw new Error(`unknown user-defined format specifier "${key}"`)
      columns.push([key, equal < 0 ? column[0] : token.slice(equal + 1)])
    }
  }
  return columns
}

/**
 * Parse the procps selection and output options a runner answers: SysV
 * letters after one dash, BSD letters with none, and the `--pid`/`--format`
 * long forms; `-p` and `-o` repeat and accumulate. `-f` and BSD `u`/`w`/`f`
 * pick a layout the managed rows do not have, so they leave the compact one.
 */
function parsePs(words: string[]): PsOptions {
  const pids = new Set<number>()
  const select = (picked: number[]) => {
    for (const pid of picked) pids.add(pid)
  }
  const columns: [string, string][] = []
  let all = false
  let at = 0
  while (at < words.length) {
    const word = words[at++] ?? ''
    if (word.startsWith('--')) {
      const equal = word.indexOf('=')
      const option = equal < 0 ? word : word.slice(0, equal)
      if (option !== '--pid' && option !== '--format') throw new Error('unknown gnu long option')
      const value = equal < 0 ? (words[at++] ?? '') : word.slice(equal + 1)
      if (option === '--pid') select(psPids(value, option))
      else for (const item of psColumns(value, option)) columns.push(item)
      continue
    }
    if (!word.startsWith('-')) {
      if (!/^[auxwf]+$/.test(word)) throw new Error('unsupported option (BSD syntax)')
      all ||= /[ax]/.test(word)
      continue
    }
    let letters = word.slice(1)
    while (letters !== '') {
      const flag = letters.charAt(0)
      letters = letters.slice(1)
      if (constants.ALL.has(flag)) {
        all = true
        continue
      }
      if (flag === 'f') continue
      if (flag !== 'p' && flag !== 'o') throw new Error('unsupported SysV option')
      const value = letters !== '' ? letters : (words[at++] ?? '')
      letters = ''
      if (flag === 'p') select(psPids(value, '-p'))
      else for (const item of psColumns(value, '-o')) columns.push(item)
    }
  }
  return { pids, all, columns }
}

/** One row in procps's layout: each column padded but the last. */
function psRow(keys: readonly string[], cells: readonly string[]): string {
  return keys
    .map((key, at) => {
      const [, width, right] = constants.COLUMNS[key] ?? ['', 0, false, '']
      const cell = cells[at] ?? ''
      if (right) return cell.padStart(width)
      return at === keys.length - 1 ? cell : cell.padEnd(width)
    })
    .join(' ')
}

/** procps's etime: `[[DD-]hh:]mm:ss`. */
function elapsed(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  if (days > 0) return `${String(days)}-${two(hours)}:${two(minutes)}:${two(secs)}`
  if (hours > 0) return `${two(hours)}:${two(minutes)}:${two(secs)}`
  return `${two(minutes)}:${two(secs)}`
}

/**
 * One start-time column, lstart, start, stime or bsdstart, in the layouts
 * measured from procps-ng 4.0.4's `ps -o` output: a day-old start prints its
 * date, a recent one its clock.
 */
function started(fact: string, info: Process, ctx: PsContext): string {
  const start = new Date(info.startedAt * 1000)
  if (fact === 'lstart') return gnuStrftime(start, '%a %b %e %H:%M:%S %Y', ctx.zone)
  const old = ctx.now - info.startedAt > 86400
  if (fact === 'start') return gnuStrftime(start, old ? '  %b %d' : '%H:%M:%S', ctx.zone)
  if (fact === 'bsdstart') return gnuStrftime(start, old ? '%b %e' : '%H:%M', ctx.zone)
  const now = ctx.zone.parts(new Date(ctx.now * 1000))
  const then = ctx.zone.parts(start)
  if (now.year !== then.year) return gnuStrftime(start, '%Y', ctx.zone)
  if (now.month !== then.month || now.day !== then.day) {
    return gnuStrftime(start, '%b%d', ctx.zone)
  }
  return gnuStrftime(start, '%H:%M', ctx.zone)
}

/**
 * One -o cell for a managed runner. The owner columns print the workspace user
 * and the session's profile, names in the id columns too, as `id` does, and
 * `-` where nobody claimed one or the runner is another session's, whose
 * profile this one cannot name. A runner of the calling session belongs to the
 * session `$$` leads; another session's to its own group.
 */
function psCell(key: string, info: Process, ctx: PsContext): string {
  const fact = constants.COLUMNS[key]?.[3] ?? ''
  const fixed = constants.FIXED[fact]
  if (fixed !== undefined) return fixed
  const session =
    info.sessionId === ctx.sessionId && ctx.shellPid !== null
      ? ctx.shellPid
      : info.group || info.id.pid
  if (fact === 'pid') return String(info.id.pid)
  if (fact === 'ppid') return info.parent ? String(info.parent) : '0'
  if (fact === 'pgid') return String(info.group || info.id.pid)
  if (fact === 'sid') return String(session)
  if (fact === 'stat' || fact === 'state') {
    return constants.STATES[info.state] + (fact === 'stat' && info.id.pid === session ? 's' : '')
  }
  if (fact === 'comm') {
    const head = info.command.split(/\s+/).find((w) => w !== '') ?? ''
    return (head.split('/').pop() ?? '').slice(0, 15)
  }
  if (fact === 'user' || fact === 'group') {
    return (info.sessionId === ctx.sessionId ? ctx.group : null) ?? UNKNOWN_NAME
  }
  const age = Math.max(0, Math.floor(ctx.now - info.startedAt))
  if (fact === 'etime') return elapsed(age)
  if (fact === 'etimes') return String(age)
  if (['lstart', 'start', 'stime', 'bsdstart'].includes(fact)) return started(fact, info, ctx)
  return info.command
}

/**
 * Where a process's program runs, as `ps` names it: `host PID` for a host
 * program, its machine (`docker:tools`) for another's.
 */
function runWhere(info: Process): string {
  if (info.machinePid !== null) return `host ${String(info.machinePid.pid)}`
  return info.machine.toString()
}

/**
 * List managed runners with procps's selection and `-o` columns. A runner
 * has no CPU, RSS or TTY accounting, so without `-o` the rows stay mirage's
 * compact `PID<TAB>COMMAND` and never broaden the profile's view. `-o` lays
 * out procps-ng 4.0.4's columns, every key a runner can answer (constants.COLUMNS);
 * a header row prints unless every header is empty. Selecting nothing (`-p`
 * of an absent PID) exits 1, as procps does, and an option error is
 * procps's message and usage.
 *
 * The daemon running the line holds the workspace's lease, so its runners
 * are every one the workspace has. In the compact rows a runner that is a
 * program a runtime runs is followed by where it runs, a host program by its
 * host PID and another by its machine, as `-<TAB>└ where`.
 */
export function handlePs(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  let options: PsOptions
  try {
    options = parsePs(parts.slice(1))
  } catch (err) {
    return Promise.resolve(
      jobResult(cmdStr, `error: ${(err as Error).message}\n${constants.USAGE}`, 1),
    )
  }
  const sid = sessionOf(session)
  const processes = processView(jobTable, session)
  const every = options.all || options.pids.size === 0
  const rows = processes.list().filter((info) => every || options.pids.has(info.id.pid))
  let lines: string[]
  if (options.columns.length > 0) {
    const keys = options.columns.map(([key]) => key)
    const ctx: PsContext = {
      now: systemNow(),
      zone: (session !== null ? zoneFromEnv(session.env) : null) ?? LOCAL_ZONE,
      group: session?.profile ?? null,
      sessionId: sid,
      shellPid: session?.shellPid ?? null,
    }
    lines = rows.map((info) =>
      psRow(
        keys,
        keys.map((key) => psCell(key, info, ctx)),
      ),
    )
    if (options.columns.some(([, header]) => header !== ''))
      lines.unshift(
        psRow(
          keys,
          options.columns.map(([, header]) => header),
        ),
      )
  } else {
    lines = rows.flatMap((info) => [
      `${String(info.id.pid)}\t${info.command}`,
      ...(info.runtime !== null ? [`-\t└ ${runWhere(info)}`] : []),
    ])
  }
  const code = rows.length > 0 ? 0 : 1
  const out = encodeText(lines.length > 0 ? lines.join('\n') + '\n' : '')
  return Promise.resolve([
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: cmdStr, exitCode: code }),
  ])
}
