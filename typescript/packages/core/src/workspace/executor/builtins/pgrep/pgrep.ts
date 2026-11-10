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

import { compilePattern } from '../../../../commands/builtin/grep_pattern.ts'
import { UsageError } from '../../../../commands/errors.ts'
import { SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import { versionLine } from '../../../../commands/spec/standard.ts'
import { currentCaller, type RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { type Process, shownMachine, shownPid } from '../../../../execution/process/types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { LineRegex } from '../../../../rs/regex.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { SIGTERM } from '../../../../shell/constants.ts'
import { signalNumber } from '../../../../shell/signals.ts'
import { systemNow } from '../../../../utils/clock.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { grantsOf, jobResult, sessionOf } from '../jobspec.ts'
import { signalOne } from '../kill/kill.ts'
import {
  type MachineScope,
  optionRefusal,
  permutedOptions,
  processScope,
  usagePage,
} from '../machine_view.ts'
import { NAME_WIDTH, processName, running } from './shared.ts'

const FOUND = 0
const NOT_FOUND = 1
const REFUSED = 2

// Every option a search's value lists number.
const NUMBERED: Readonly<Record<string, string>> = { P: 'parents', g: 'groups', s: 'sessions' }

type Flags = Record<string, string | boolean>

/** What a search selects. Mirrors Python's `Search`. */
interface Search {
  readonly matcher: LineRegex | null
  readonly full: boolean
  readonly inverse: boolean
  readonly newest: boolean
  readonly oldest: boolean
  readonly older: number | null
  readonly parents: ReadonlySet<number>
  readonly groups: ReadonlySet<number>
  readonly sessions: ReadonlySet<number>
  readonly states: string
}

interface Searched {
  readonly picked: Process[]
  readonly scope: MachineScope | null
  readonly flags: Flags
  readonly said: string
  readonly status: number
}

function tryAgain(name: string): string {
  return `Try \`${name} --help' for more information.\n`
}

function refused(flags: Flags, said: string): Searched {
  return { picked: [], scope: null, flags, said, status: REFUSED }
}

function numbers(name: string, text: string): [Set<number>, string] {
  const found = new Set<number>()
  for (const word of text.split(',')) {
    if (!/^[0-9]+$/.test(word)) return [new Set(), `${name}: not a number: ${word}\n`]
    found.add(Number(word))
  }
  return [found, '']
}

function matcherOf(
  name: string,
  pattern: string | null,
  ignoreCase: boolean,
  exact: boolean,
): [LineRegex | null, string] {
  if (pattern === null) return [null, '']
  try {
    return [compilePattern(pattern, ignoreCase, false, false, undefined, false, exact), '']
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return [null, `${name}: regex error: ${err.message.replace(/^grep: /, '')}\n`]
  }
}

/**
 * The processes a search picks, by pid: `shown` holds each visible process's
 * pid as the agent knows it, `leaders` each row's session leader as `ps`
 * reads its `sid`. Mirrors Python's `_selected`.
 */
async function selected(
  rows: readonly Process[],
  search: Search,
  shown: ReadonlyMap<number, number>,
  leaders: ReadonlyMap<number, number>,
  now: number,
): Promise<Process[]> {
  const picked: Process[] = []
  for (const info of rows) {
    const haystack = search.full ? info.command : processName(info)
    const parent = shown.get(info.parent ?? 0) ?? 0
    const leader = info.group || info.id.pid
    const group = shown.get(leader) ?? leader
    const head = leaders.get(info.id.pid) ?? leader
    const session = shown.get(head) ?? head
    const wanted =
      (search.matcher === null || (await search.matcher.matches(haystack))) &&
      (search.parents.size === 0 || search.parents.has(parent)) &&
      (search.groups.size === 0 || search.groups.has(group)) &&
      (search.sessions.size === 0 || search.sessions.has(session)) &&
      (search.states === '' || search.states.includes((info.shownState ?? 'S').charAt(0))) &&
      (search.older === null || now - info.startedAt >= search.older)
    if (wanted !== search.inverse) picked.push(info)
  }
  picked.sort((a, b) => shownPid(a) - shownPid(b))
  const byAge = (a: Process, b: Process): number => a.startedAt - b.startedAt || a.id.pid - b.id.pid
  const aged = [...picked].sort(byAge)
  const newest = aged.at(-1)
  const oldest = aged[0]
  if (search.newest && newest !== undefined) return [newest]
  if (search.oldest && oldest !== undefined) return [oldest]
  return picked
}

async function searchFor(
  name: string,
  words: readonly string[],
  jobTable: JobTable,
  session: SessionState | null,
): Promise<Searched> {
  const spec = SHELL_SPECS[name]
  if (spec === undefined) throw new Error(`no spec for ${name}`)
  const parse = permutedOptions(spec, words)
  const refusal = optionRefusal(name, parse)
  const flags = parse.flags
  if (refusal !== '') return refused(flags, refusal)
  if (flags.n === true && flags.o === true) return refused(flags, `\n${usagePage(name)}`)
  if (parse.operands.length > 1)
    return refused(flags, `${name}: only one pattern can be provided\n${tryAgain(name)}`)
  const lists: Record<string, Set<number>> = {}
  for (const [letter, field] of Object.entries(NUMBERED)) {
    const value = flags[letter]
    lists[field] = new Set()
    if (typeof value !== 'string') continue
    const [found, said] = numbers(name, value)
    if (said !== '') return refused(flags, said)
    lists[field] = found
  }
  let older: number | null = null
  if (typeof flags.O === 'string') {
    if (!/^[0-9]+$/.test(flags.O)) return refused(flags, `${name}: not a number: ${flags.O}\n`)
    older = Number(flags.O)
  }
  const states = typeof flags.r === 'string' ? flags.r : null
  const pattern = parse.operands[0] ?? null
  const parents = lists.parents ?? new Set<number>()
  const groups = lists.groups ?? new Set<number>()
  const sessions = lists.sessions ?? new Set<number>()
  if (
    pattern === null &&
    older === null &&
    states === null &&
    parents.size === 0 &&
    groups.size === 0 &&
    sessions.size === 0
  )
    return refused(flags, `${name}: no matching criteria specified\n${tryAgain(name)}`)
  const [matcher, bad] = matcherOf(name, pattern, flags.i === true, flags.x === true)
  if (bad !== '') return refused(flags, bad)
  const machine = typeof flags.machine === 'string' ? flags.machine : null
  const scope = processScope(jobTable.processes, machine)
  if (scope === null) return refused(flags, `${name}: ${machine ?? ''}: no such machine\n`)
  const full = flags.f === true
  const said =
    pattern !== null && !full && pattern.length > NAME_WIDTH
      ? `${name}: pattern that searches for process name longer than ${String(NAME_WIDTH)} ` +
        `characters will result in zero matches\n` +
        `Try \`${name} -f' option to match against the complete command line.\n`
      : ''
  const rows = await running(jobTable, session, scope)
  const sid = sessionOf(session)
  const seen = jobTable.processes.visible(sid, grantsOf(session))
  const shown = new Map(seen.map((info) => [info.id.pid, shownPid(info)]))
  const shell = session?.shellPid ?? null
  const leaders = new Map(
    rows.map((info) => [
      info.id.pid,
      info.sessionId === sid && shell !== null ? shell : info.group || info.id.pid,
    ]),
  )
  const caller = currentCaller().process?.record
  const group = caller === undefined ? null : caller.group || caller.id.pid
  const search: Search = {
    matcher,
    full,
    inverse: flags.v === true,
    newest: flags.n === true,
    oldest: flags.o === true,
    older,
    parents,
    groups: ownZero(groups, group === null ? null : (shown.get(group) ?? group)),
    sessions: ownZero(sessions, shell === null ? null : (shown.get(shell) ?? shell)),
    states: states ?? '',
  }
  const picked = await selected(rows, search, shown, leaders, systemNow())
  return { picked, scope, flags, said, status: 0 }
}

/** A `-g` or `-s` list with 0 read as the searcher's own group or session, as procps reads it. */
function ownZero(listed: ReadonlySet<number>, own: number | null): ReadonlySet<number> {
  if (!listed.has(0) || own === null) return listed
  return new Set([...listed].map((number) => (number === 0 ? own : number)))
}

function listed(picked: readonly Process[], flags: Flags, scope: MachineScope): string {
  if (flags.c === true) return `${String(picked.length)}\n`
  const row = (info: Process): string => {
    const pid = String(shownPid(info))
    if (flags.a === true) return `${pid} ${info.command}`
    if (flags.l === true) return `${pid} ${processName(info)}`
    return pid
  }
  if (typeof flags.d === 'string')
    return picked.length > 0 ? `${picked.map(row).join(flags.d)}\n` : ''
  return picked
    .map((info) => (scope.several ? `${row(info)}  ${shownMachine(info)}\n` : `${row(info)}\n`))
    .join('')
}

function standardAnswer(
  name: string,
  words: readonly string[],
  cmdStr: string,
): RedirectResult | null {
  const spec = SHELL_SPECS[name]
  if (spec === undefined) throw new Error(`no spec for ${name}`)
  const flags = permutedOptions(spec, words).flags
  const text = flags.h === true ? usagePage(name) : flags.V === true ? versionLine(name) : null
  if (text === null) return null
  return [encodeText(text), new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}

/**
 * Find processes by name or command line among those `ps` shows, so the
 * search neither sees Mirage's own wrappers on a machine nor misses another
 * machine. Mirrors Python's `handle_pgrep`.
 */
export async function handlePgrep(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const early = standardAnswer('pgrep', parts.slice(1), cmdStr)
  if (early !== null) return early
  const { picked, scope, flags, said, status } = await searchFor(
    'pgrep',
    parts.slice(1),
    jobTable,
    session,
  )
  if (scope === null) return jobResult(cmdStr, said, status)
  const code = picked.length > 0 ? FOUND : NOT_FOUND
  const err = said === '' ? null : encodeText(said)
  return [
    encodeText(listed(picked, flags, scope)),
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err ?? new Uint8Array() }),
  ]
}

/**
 * Signal the processes `pgrep` would find, the way `kill` does, on every
 * machine they run on. A first word `-NAME` or `-NUMBER` is the signal, as
 * `--signal` is. Mirrors Python's `handle_pkill`.
 */
export async function handlePkill(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  let words = parts.slice(1)
  const early = standardAnswer('pkill', words, cmdStr)
  if (early !== null) return early
  let signal = SIGTERM
  const first = words[0]
  if (first !== undefined && first.startsWith('-') && first.length > 1) {
    const number = signalNumber(first.slice(1))
    if (number !== null) {
      signal = number
      words = words.slice(1)
    }
  }
  const { picked, scope, flags, said, status } = await searchFor('pkill', words, jobTable, session)
  if (scope === null) return jobResult(cmdStr, said, status)
  if (typeof flags.signal === 'string') {
    const number = signalNumber(flags.signal)
    if (number === null)
      return jobResult(cmdStr, `pkill: Unknown signal "${flags.signal}".\n`, REFUSED)
    signal = number
  }
  const out: string[] = []
  const errors: string[] = said === '' ? [] : [said]
  let killed = 0
  const jobs = jobTable.listJobs(sessionOf(session))
  for (const info of picked) {
    let found: boolean | null
    try {
      found = await signalOne(jobTable, session, jobs, info.id.pid, signal)
    } catch (err) {
      if ((err as { code?: string }).code !== 'EPERM') throw err
      errors.push(`pkill: killing pid ${String(shownPid(info))} failed: Operation not permitted\n`)
      continue
    }
    if (found === true) {
      killed += 1
      if (flags.e === true)
        out.push(`${processName(info)} killed (pid ${String(shownPid(info))})\n`)
    }
  }
  if (flags.c === true) out.push(`${String(killed)}\n`)
  const code = killed > 0 ? FOUND : NOT_FOUND
  const err = errors.length === 0 ? null : encodeText(errors.join(''))
  return [
    encodeText(out.join('')),
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err ?? new Uint8Array() }),
  ]
}
