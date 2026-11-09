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
import { currentCaller, type RedirectResult } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { shownMachine, shownPid, type Process } from '../../../../execution/process/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { ProcessId } from '../../../../execution/types.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { systemNow } from '../../../../utils/clock.ts'
import { LOCAL_ZONE, zoneFromEnv } from '../../../../utils/timezone.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { MAX_PID_OPERAND } from '../constants.ts'
import { grantsOf, jobResult, sessionOf } from '../jobspec.ts'
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
 * letters after one dash, BSD letters with none, and the
 * `--pid`/`--format`/`--forest` long forms; `-p` and `-o` repeat and
 * accumulate. BSD `f` and `--forest` draw the forest; `-f` and BSD `u`/`w`
 * pick a layout the processes do not have, so they leave the plain one.
 */
function parsePs(words: string[]): PsOptions {
  const pids = new Set<number>()
  const select = (picked: number[]) => {
    for (const pid of picked) pids.add(pid)
  }
  const columns: [string, string][] = []
  let all = false
  let forest = false
  let at = 0
  while (at < words.length) {
    const word = words[at++] ?? ''
    if (word === '--forest') {
      forest = true
      continue
    }
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
      forest ||= word.includes('f')
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
  return { pids, all, columns, forest }
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
  const clock = (days > 0 || hours > 0 ? [hours, minutes, secs] : [minutes, secs])
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
  return days > 0 ? `${String(days)}-${clock}` : clock
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
 * One -o cell for a process. The owner columns print the workspace user and
 * the session's profile, names in the id columns too, as `id` does, and `-`
 * where nobody claimed one or the runner is another session's, whose profile
 * this one cannot name. A runner of the calling session belongs to the
 * session `$$` leads; another session's to its own group. The machine column
 * names the machine a program runs on, `mirage` for a process that is
 * Mirage's own, and each pid column shows what the agent knows it by: a
 * program's pid on its machine. `branch` is what a forest draws before its
 * command.
 */
function psCell(key: string, info: Process, ctx: PsContext, branch: string): string {
  const fact = constants.COLUMNS[key]?.[3] ?? ''
  const fixed = constants.FIXED[fact]
  if (fixed !== undefined) return fixed
  if (fact === 'machine') return shownMachine(info)
  const session =
    info.sessionId === ctx.sessionId && ctx.shellPid !== null
      ? ctx.shellPid
      : info.group || info.id.pid
  if (fact === 'pid') return String(shownPid(info))
  // What outlives its parent is init's, as on any machine.
  if (fact === 'ppid') {
    if (info.parent) return String(ctx.shown.get(info.parent) ?? 1)
    return info.machinePid !== null ? '1' : '0'
  }
  if (fact === 'pgid') {
    const group = info.group || info.id.pid
    return String(ctx.shown.get(group) ?? group)
  }
  if (fact === 'sid') return String(ctx.shown.get(session) ?? session)
  if (fact === 'stat' || fact === 'state') {
    const state =
      info.shownState ??
      (info.id.pid === ctx.running && info.state === 'running' ? 'R' : constants.STATES[info.state])
    return state + (fact === 'stat' && info.id.pid === session ? 's' : '')
  }
  if (fact === 'comm') {
    const head = info.command.split(/\s+/).find((w) => w !== '') ?? ''
    return branch + (head.split('/').pop() ?? '').slice(0, 15)
  }
  if (fact === 'user' || fact === 'group') {
    return (info.sessionId === ctx.sessionId ? ctx.group : null) ?? UNKNOWN_NAME
  }
  const age = Math.max(0, Math.floor(ctx.now - info.startedAt))
  if (fact === 'etime') return elapsed(age)
  if (fact === 'etimes') return String(age)
  if (['lstart', 'start', 'stime', 'bsdstart'].includes(fact)) return started(fact, info, ctx)
  return branch + info.command
}

/**
 * The rows as procps draws a forest: each process under its parent,
 * siblings by pid, a process whose parent is not listed a root; each with
 * what goes before its command. Mirrors Python's `_forest`.
 */
/**
 * The processes as bash runs them. A background pipeline's stages are its
 * shell's children, with nothing between them, and `ps` is a program of its
 * own: run last on a line, the shell replaced itself with it; run before more
 * of the line, it is the shell's child. Answers the processes to list and the
 * one to show running. Mirrors Python's `_as_bash_runs_them`.
 */
function asBashRunsThem(
  listed: readonly Process[],
  own: string,
  running: Process | null,
  nextPid: number,
): [readonly Process[], Process | null] {
  const jobs = new Map(
    listed
      .filter((info) => (info.stages?.length ?? 0) > 0)
      .map((info) => [info.id.pid, info.parent]),
  )
  const rows = listed
    .filter((info) => (info.stages?.length ?? 0) === 0)
    .map((info) => {
      const above = info.parent === null ? undefined : jobs.get(info.parent)
      return above === undefined ? info : { ...info, parent: above }
    })
  if (running === null || !/[;&|\n]/.test(running.command)) return [rows, running]
  if (running.command.replace(/["']/g, '').trimEnd().endsWith(own)) {
    const shown = { ...running, command: own }
    return [rows.map((row) => (row.id.pid === shown.id.pid ? shown : row)), shown]
  }
  const child = {
    ...running,
    id: new ProcessId(running.id.workspaceId, nextPid),
    parent: running.id.pid,
    command: own,
  }
  return [[...rows, child], child]
}

function forest(rows: readonly Process[]): [Process, string][] {
  const listed = new Set(rows.map((info) => info.id.pid))
  const children = new Map<number | null, Process[]>()
  for (const info of [...rows].sort((a, b) => a.id.pid - b.id.pid)) {
    const above = info.parent !== null && listed.has(info.parent) ? info.parent : null
    children.set(above, [...(children.get(above) ?? []), info])
  }
  const drawn: [Process, string][] = []
  const walk = (parent: number | null, trail: string): void => {
    const kids = children.get(parent) ?? []
    kids.forEach((kid, at) => {
      const later = at < kids.length - 1
      drawn.push([kid, parent === null ? '' : trail + constants.BRANCH])
      walk(kid.id.pid, parent === null ? '' : trail + (later ? constants.BAR : constants.GAP))
    })
  }
  walk(null, '')
  return drawn
}

/**
 * List processes with procps's selection and `-o` columns. The machines are
 * scanned first, so what a program started there shows as processes of its
 * own. Without `-o` the columns are `PID MACHINE CMD`
 * (`constants.PLAIN`); `-o` lays out procps-ng 4.0.4's columns, every key a
 * process can answer (`constants.COLUMNS`), `machine` among them;
 * a header row prints unless every header is empty. BSD `f` and `--forest`
 * draw each command under its parent's. A `-p` number is a pid as `ps` shows
 * it. Selecting nothing (`-p` of an absent PID) exits 1, as
 * procps does, and an option error is procps's message and usage. A process
 * has no CPU, RSS or TTY accounting, and ps never broadens the profile's
 * view.
 *
 * The daemon running the line holds the workspace's lease, so its processes
 * are every one the workspace has.
 */
export async function handlePs(
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
    return jobResult(cmdStr, `error: ${(err as Error).message}\n${constants.USAGE}`, 1)
  }
  const sid = sessionOf(session)
  await jobTable.processes.scan()
  const every = options.all || options.pids.size === 0
  const [listed, running] = asBashRunsThem(
    jobTable.processes.visible(sid, grantsOf(session)),
    cmdStr,
    currentCaller().process?.record ?? null,
    jobTable.processes.lastPid + 1,
  )
  const rows = listed.filter((info) => every || options.pids.has(shownPid(info)))
  const columns = options.columns.length > 0 ? options.columns : constants.PLAIN
  const keys = columns.map(([key]) => key)
  const ctx: PsContext = {
    now: systemNow(),
    zone: (session !== null ? zoneFromEnv(session.env) : null) ?? LOCAL_ZONE,
    group: session?.profile ?? null,
    sessionId: sid,
    shellPid: session?.shellPid ?? null,
    running: running?.id.pid ?? null,
    shown: new Map(listed.map((info) => [info.id.pid, shownPid(info)])),
  }
  const drawn: [Process, string][] = options.forest
    ? forest(rows)
    : [...rows].sort((a, b) => a.id.pid - b.id.pid).map((info) => [info, ''])
  const lines = drawn.map(([info, branch]) =>
    psRow(
      keys,
      keys.map((key) => psCell(key, info, ctx, branch)),
    ),
  )
  if (columns.some(([, header]) => header !== ''))
    lines.unshift(
      psRow(
        keys,
        columns.map(([, header]) => header),
      ),
    )
  const code = rows.length > 0 ? 0 : 1
  const out = encodeText(lines.length > 0 ? lines.join('\n') + '\n' : '')
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: cmdStr, exitCode: code }),
  ]
}
