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
import { parseShellOptions, SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import { currentCaller, type RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { WORKSPACE_MACHINE } from '../../../../execution/process/constants.ts'
import {
  type Process,
  type ProcessUsage,
  shownMachine,
  shownPid,
} from '../../../../execution/process/types.ts'
import type { CpuShares, MachineResources, TaskCounts } from '../../../../execution/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { sleep } from '../../../../utils/abort.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { grantsOf, jobResult, sessionOf } from '../jobspec.ts'
import {
  MACHINE_HEADER,
  machineScope,
  type MachineScope,
  optionRefusal,
  readMachines,
  usagePage,
  withMachine,
} from '../machine_view.ts'
import { STATES } from '../ps/constants.ts'
import * as constants from './constants.ts'
import { oneDecimal } from './free.ts'
import { summary } from './uptime.ts'

/** How `top` prints. Mirrors Python's `TopOptions`. */
interface TopOptions {
  readonly iterations: number | null
  readonly delay: number
  readonly full: boolean
  readonly width: number
  readonly scale: string
  readonly sort: string
  readonly pids: ReadonlySet<number>
  readonly narrowed: boolean
}

const NO_USAGE: ProcessUsage = { cpuSeconds: 0, cpuPercent: 0, memoryPercent: 0, rss: 0, vsz: 0 }

function count(value: number): string {
  return String(value).padStart(3)
}

function tasksLine(tasks: TaskCounts | null): string {
  const seen = tasks ?? { total: 0, running: 0, sleeping: 0, stopped: 0, zombie: 0 }
  return (
    `Tasks: ${count(seen.total)} total, ${count(seen.running)} running, ` +
    `${count(seen.sleeping)} sleeping, ${count(seen.stopped)} stopped, ` +
    `${count(seen.zombie)} zombie`
  )
}

function share(value: number | null): string {
  return (value === null ? '-' : oneDecimal(value)).padStart(5)
}

function cpuLine(cpu: CpuShares | null): string {
  const seen: CpuShares = cpu ?? {
    user: 0,
    system: 0,
    idle: 100,
    nice: 0,
    wait: 0,
    hardware: 0,
    software: 0,
    stolen: 0,
  }
  return (
    `%Cpu(s):${share(seen.user)} us,${share(seen.system)} sy,${share(seen.nice)} ni,` +
    `${share(seen.idle)} id,${share(seen.wait)} wa,${share(seen.hardware)} hi,` +
    `${share(seen.software)} si,${share(seen.stolen)} st `
  )
}

function figure(value: number): string {
  return oneDecimal(value).padStart(9)
}

function memoryLines(row: MachineResources, scale: string): string[] {
  const [name, unit] = constants.TOP_SCALES[scale] ?? ['MiB', 1024 ** 2]
  const used = (row.memTotal - row.memAvailable) / unit
  const cache = ((row.buffers ?? 0) + (row.cached ?? 0)) / unit
  const swapUsed = (row.swapTotal - row.swapFree) / unit
  return [
    `${name} Mem :${figure(row.memTotal / unit)} total,${figure(row.memFree / unit)} free,` +
      `${figure(used)} used,${figure(cache)} buff/cache     `,
    `${name} Swap:${figure(row.swapTotal / unit)} total,${figure(row.swapFree / unit)} free,` +
      `${figure(swapUsed)} used.${figure(row.memAvailable / unit)} avail Mem `,
  ]
}

function block(row: MachineResources, scale: string): string[] {
  return [
    `top - ${summary(row)}`,
    tasksLine(row.tasks),
    cpuLine(row.cpu),
    ...memoryLines(row, scale),
  ]
}

function cpuClock(seconds: number): string {
  const hundredths = Math.trunc(seconds * 100)
  const minutes = Math.floor(hundredths / 6000)
  const rest = hundredths % 6000
  const whole = String(Math.floor(rest / 100)).padStart(2, '0')
  return `${String(minutes)}:${whole}.${String(rest % 100).padStart(2, '0')}`
}

function kib(size: number, width: number): string {
  let text = String(size)
  if (text.length <= width) return text
  for (const [power, unit] of [
    [1, 'm'],
    [2, 'g'],
    [3, 't'],
  ] as const) {
    text = `${oneDecimal(size / 1024 ** power)}${unit}`
    if (text.length <= width) return text
  }
  return text
}

function usageOf(info: Process): ProcessUsage {
  return info.usage ?? NO_USAGE
}

function ordered(rows: readonly Process[], field: string): Process[] {
  const keys: Record<string, (info: Process) => number | string> = {
    PID: shownPid,
    USER: (info) => info.sessionId,
    VIRT: (info) => usageOf(info).vsz,
    RES: (info) => usageOf(info).rss,
    '%CPU': (info) => usageOf(info).cpuPercent,
    '%MEM': (info) => usageOf(info).memoryPercent,
    'TIME+': (info) => usageOf(info).cpuSeconds,
    COMMAND: (info) => info.command,
  }
  const key = keys[field] ?? shownPid
  const sign = constants.TOP_SORT_FIELDS[field] === true ? -1 : 1
  return [...rows]
    .sort((a, b) => shownPid(a) - shownPid(b))
    .sort((a, b) => {
      const left = key(a)
      const right = key(b)
      return left < right ? -sign : left > right ? sign : 0
    })
}

function commandOf(info: Process, full: boolean): string {
  if (full) return info.command
  const head = info.command.split(/\s+/).find((word) => word !== '') ?? ''
  return head.slice(head.lastIndexOf('/') + 1)
}

function table(
  rows: readonly Process[],
  options: TopOptions,
  many: boolean,
  owner: string | null,
): string[] {
  const width = Math.max(MACHINE_HEADER.length, ...rows.map((info) => shownMachine(info).length))
  const place = many ? `${MACHINE_HEADER.padEnd(width)} ` : ''
  const lines = [
    `${'PID'.padStart(5)} ${'USER'.padEnd(8)} ${'PR'.padStart(3)} ${'NI'.padStart(3)} ` +
      `${'VIRT'.padStart(7)} ${'RES'.padStart(6)} ${'SHR'.padStart(6)} S ${'%CPU'.padStart(5)} ` +
      `${'%MEM'.padStart(5)} ${'TIME+'.padStart(9)} ${place}COMMAND`,
  ]
  for (const info of ordered(rows, options.sort)) {
    const usage = info.usage ?? NO_USAGE
    const state = info.shownState ?? STATES[info.state]
    const where = many ? `${shownMachine(info).padEnd(width)} ` : ''
    const line =
      `${String(shownPid(info)).padStart(5)} ${(owner ?? UNKNOWN_NAME).padEnd(8)} ${'20'.padStart(3)} ` +
      `${'0'.padStart(3)} ${kib(usage.vsz, 7).padStart(7)} ${kib(usage.rss, 6).padStart(6)} ` +
      `${'0'.padStart(6)} ${state} ${oneDecimal(usage.cpuPercent).padStart(5)} ` +
      `${oneDecimal(usage.memoryPercent).padStart(5)} ${cpuClock(usage.cpuSeconds).padStart(9)} ${where}`
    let command = commandOf(info, options.full)
    const room = options.width - line.length
    if (room > 1 && command.length > room) command = `${command.slice(0, room - 1)}+`
    lines.push(line + command)
  }
  return lines
}

async function frameOf(
  jobTable: JobTable,
  session: SessionState | null,
  scope: MachineScope,
  options: TopOptions,
): Promise<[string, string]> {
  const processes = jobTable.processes
  const [machines, errors] = await readMachines(processes, scope, 'top', true)
  await processes.scan()
  const own = currentCaller().process?.record.id.pid ?? null
  const rows = processes
    .visible(sessionOf(session), grantsOf(session))
    .filter(
      (info) =>
        (info.stages === undefined || info.stages.length === 0) &&
        info.id.pid !== own &&
        (scope.ids.includes(shownMachine(info)) || shownMachine(info) === WORKSPACE_MACHINE) &&
        (options.pids.size === 0 || options.pids.has(shownPid(info))),
    )
  const lines: string[] = []
  for (const row of machines)
    for (const line of block(row, options.scale))
      lines.push(scope.several ? withMachine(line, row.machine) : line)
  lines.push('')
  lines.push(...table(rows, options, scope.several, session?.profile ?? null))
  const shown =
    options.narrowed && !scope.several ? lines.map((line) => line.slice(0, options.width)) : lines
  return [shown.map((line) => `${line}\n`).join(''), errors]
}

async function* framesOf(
  first: string,
  jobTable: JobTable,
  session: SessionState | null,
  scope: MachineScope,
  options: TopOptions,
): AsyncIterable<Uint8Array> {
  yield encodeText(first)
  let done = 1
  while (options.iterations === null || done < options.iterations) {
    await sleep(options.delay * 1000)
    const [text] = await frameOf(jobTable, session, scope, options)
    yield encodeText(`\n${text}`)
    done += 1
  }
}

function readOptions(flags: Record<string, string | boolean>): [TopOptions | null, string] {
  let iterations: number | null = null
  if (typeof flags.n === 'string') {
    if (!/^[0-9]+$/.test(flags.n) || Number(flags.n) < 1)
      return [null, `top: bad iterations argument '${flags.n}'\n`]
    iterations = Number(flags.n)
  }
  let delay = constants.TOP_DELAY_SECONDS
  if (typeof flags.d === 'string') {
    delay = Number(flags.d)
    if (flags.d.trim() === '' || Number.isNaN(delay))
      return [null, `top: bad delay interval '${flags.d}'\n`]
    if (delay < 0) return [null, 'top: -d requires positive argument\n']
  }
  let width: number = constants.TOP_WIDTH
  if (typeof flags.w === 'string') {
    if (!/^[0-9]+$/.test(flags.w)) return [null, `top: bad width arg '${flags.w}'\n`]
    width = Number(flags.w)
  }
  let scale = 'm'
  if (typeof flags.E === 'string') {
    scale = flags.E
    if (!(scale in constants.TOP_SCALES)) return [null, `top: bad memory scaling arg '${scale}'\n`]
  }
  let sort = '%CPU'
  if (typeof flags.o === 'string') {
    sort = flags.o.replace(/^[+-]+/, '')
    if (!(sort in constants.TOP_SORT_FIELDS))
      return [null, `top: unrecognized field name '${sort}'\n`]
  }
  const pids = new Set<number>()
  if (typeof flags.p === 'string')
    for (const word of flags.p.split(',')) {
      if (!/^[0-9]+$/.test(word)) return [null, `top: bad pid '${word}'\n`]
      pids.add(Number(word))
    }
  return [
    {
      iterations,
      delay,
      full: flags.c === true,
      width,
      scale,
      sort,
      pids,
      narrowed: typeof flags.w === 'string',
    },
    '',
  ]
}

/**
 * Show how busy the machines a line can use are, in `top`'s batch layout: the
 * processors are read twice a moment apart, as one read says nothing of now.
 * Several machines print their summary lines one after another, each ending
 * in the machine, and a `MACHINE` column in the process table. Without `-b`
 * it refuses as `top` does without a terminal. Mirrors Python's `handle_top`.
 */
export async function handleTop(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const spec = SHELL_SPECS.top
  const parse = parseShellOptions(spec, parts.slice(1))
  const refusal = optionRefusal('top', parse, false)
  if (refusal !== '') return jobResult(cmdStr, refusal, 1)
  if (parse.flags.h === true)
    return [
      encodeText(usagePage('top')),
      new IOResult(),
      new ExecutionNode({ command: cmdStr, exitCode: 0 }),
    ]
  const extra = parse.operands[0]
  if (extra !== undefined) return jobResult(cmdStr, `top: unknown option '${extra}'\n`, 1)
  const [options, said] = readOptions(parse.flags)
  if (options === null) return jobResult(cmdStr, said, 1)
  if (parse.flags.b !== true) return jobResult(cmdStr, 'top: failed tty get\n', 1)
  const name = parse.flags.machine
  const named = typeof name === 'string' ? name : null
  const scope = machineScope(jobTable.processes, named)
  if (scope === null) return jobResult(cmdStr, `top: ${named ?? ''}: no such machine\n`, 1)
  const [text, errors] = await frameOf(jobTable, session, scope, options)
  const code = errors === '' ? 0 : 1
  const err = errors === '' ? null : encodeText(errors)
  const out: ByteSource =
    options.iterations === 1 ? encodeText(text) : framesOf(text, jobTable, session, scope, options)
  return [
    out,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err ?? new Uint8Array() }),
  ]
}
