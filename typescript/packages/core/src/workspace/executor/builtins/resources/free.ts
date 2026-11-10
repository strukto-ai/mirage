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

import { parseShellOptions, SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import { versionLine } from '../../../../commands/spec/standard.ts'
import { CPUS } from '../../../../commands/builtin/constants.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { WORKSPACE_MACHINE } from '../../../../execution/process/constants.ts'
import type { ProcessTable } from '../../../../execution/process/table.ts'
import type { MachineResources } from '../../../../execution/types.ts'
import { type MemoryBudget, memoryBudget } from '../../../../io/memory.ts'
import { IOResult, OutputState } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { sleep } from '../../../../utils/abort.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { jobResult } from '../jobspec.ts'
import {
  MACHINE_HEADER,
  machineScope,
  type MachineScope,
  optionRefusal,
  readMachines,
  tellOnce,
  usagePage,
  withMachine,
} from '../machine_view.ts'
import * as constants from './constants.ts'

/** How `free` prints. Mirrors Python's `FreeOptions`. */
interface FreeOptions {
  readonly power: number
  readonly si: boolean
  readonly human: boolean
  readonly wide: boolean
  readonly total: boolean
  readonly committed: boolean
  readonly lohi: boolean
  readonly line: boolean
  readonly blank?: boolean
}

/** One decimal, an exact tie going to the even digit as printf rounds it. */
export function oneDecimal(value: number): string {
  const tenths = value * 10
  const below = Math.floor(tenths)
  if (tenths - below === 0.5 && below % 2 === 0) return (below / 10).toFixed(1)
  return value.toFixed(1)
}

/**
 * A size as `free -h` prints it: the smallest unit that fits in three
 * characters, with one decimal if that fits and the whole number, cut short,
 * if only that does. Mirrors Python's `human_size`.
 */
export function humanSize(size: number, si: boolean): string {
  const base = si ? 1000 : 1024
  if (size < base) return `${String(size)}B`
  const tail = si ? '' : 'i'
  for (let power = 1; power <= constants.HUMAN_UNITS.length; power++) {
    const unit = constants.HUMAN_UNITS[power - 1] ?? ''
    const text = oneDecimal(size / base ** power)
    if (text.length <= constants.HUMAN_DIGITS) return `${text}${unit}${tail}`
    const whole = String(Math.floor(size / base ** power))
    if (whole.length <= constants.HUMAN_DIGITS) return `${whole}${unit}${tail}`
  }
  return String(Math.floor(size / base ** constants.HUMAN_UNITS.length))
}

function cell(size: number | null, options: FreeOptions): string {
  if (size === null || options.blank === true) return constants.NO_FIGURE
  if (options.human) return humanSize(size, options.si)
  return String(Math.floor(size / (options.si ? 1000 : 1024) ** options.power))
}

function row(label: string, cells: readonly string[]): string {
  return (
    label.padEnd(constants.FREE_LABEL_WIDTH) +
    cells
      .map((value, at) =>
        value.padStart(at === 0 ? constants.FREE_FIRST_WIDTH : constants.FREE_WIDTH),
      )
      .join('')
  )
}

function header(options: FreeOptions): string {
  return row('', [
    'total',
    'used',
    'free',
    'shared',
    ...(options.wide ? ['buffers', 'cache'] : ['buff/cache']),
    'available',
  ])
}

function both(first: number | null, second: number | null): number | null {
  if (first === null && second === null) return null
  return (first ?? 0) + (second ?? 0)
}

function table(res: MachineResources, options: FreeOptions): string[] {
  const used = res.memTotal - res.memAvailable
  const swapUsed = res.swapTotal - res.swapFree
  const cells = (...sizes: (number | null)[]): string[] => sizes.map((size) => cell(size, options))
  const cached = options.wide ? [res.buffers, res.cached] : [both(res.buffers, res.cached)]
  const rows = [
    row('Mem:', cells(res.memTotal, used, res.memFree, res.shared, ...cached, res.memAvailable)),
  ]
  if (options.lohi) {
    const lowTotal = res.lowTotal ?? res.memTotal
    const lowFree = res.lowFree ?? res.memFree
    const highTotal = res.highTotal ?? 0
    const highFree = res.highFree ?? 0
    rows.push(row('Low:', cells(lowTotal, lowTotal - lowFree, lowFree)))
    rows.push(row('High:', cells(highTotal, highTotal - highFree, highFree)))
  }
  rows.push(row('Swap:', cells(res.swapTotal, swapUsed, res.swapFree)))
  if (options.total)
    rows.push(
      row(
        'Total:',
        cells(res.memTotal + res.swapTotal, used + swapUsed, res.memFree + res.swapFree),
      ),
    )
  if (options.committed) {
    const limit = res.commitLimit
    const committed = res.committed
    rows.push(
      row(
        'Comm:',
        cells(limit, committed, limit === null || committed === null ? null : limit - committed),
      ),
    )
  }
  return rows
}

function oneLine(res: MachineResources, options: FreeOptions): string {
  const width = constants.FREE_WIDTH - 1
  const pad = (size: number | null): string => cell(size, options).padStart(width)
  return (
    `SwapUse ${pad(res.swapTotal - res.swapFree)} CachUse ${pad(both(res.buffers, res.cached))}  ` +
    `MemUse ${pad(res.memTotal - res.memAvailable)} MemFree ${pad(res.memFree)} `
  )
}

/**
 * The workspace's own row: its `max_memory`, what it holds of that and what is
 * left, and never a figure of the server it runs on. With no `max_memory` it
 * has no size to say (`shown`). Mirrors Python's `_workspace_row`.
 */
function workspaceRow(memory: MemoryBudget | null): MachineResources {
  const limit = memory?.limit ?? 0
  const room = memory?.room() ?? 0
  return {
    machine: WORKSPACE_MACHINE,
    cpus: CPUS,
    allCpus: CPUS,
    epoch: 0,
    clock: '',
    offset: '',
    upSeconds: 0,
    load: [0, 0, 0],
    users: 0,
    memTotal: limit,
    memFree: room,
    memAvailable: room,
    swapTotal: 0,
    swapFree: 0,
    shared: null,
    buffers: null,
    cached: null,
    commitLimit: null,
    committed: null,
    lowTotal: null,
    lowFree: null,
    highTotal: null,
    highFree: null,
    tasks: null,
    cpu: null,
    hostname: '',
    cpuInfo: '',
  }
}

/**
 * How one machine's figures print: the workspace's as `-` when it has no
 * `max_memory`. Mirrors Python's `_shown`.
 */
function shown(res: MachineResources, options: FreeOptions): FreeOptions {
  return res.machine === WORKSPACE_MACHINE && res.memTotal === 0
    ? { ...options, blank: true }
    : options
}

/** What the scope holds now, the workspace first where it answers. Mirrors Python's `_read`. */
async function read(
  processes: ProcessTable,
  scope: MachineScope,
  memory: MemoryBudget | null,
): Promise<[MachineResources[], string]> {
  const [rows, errors] = await readMachines(processes, scope, 'free')
  return [scope.workspace ? [workspaceRow(memory), ...rows] : [...rows], errors]
}

function render(rows: readonly MachineResources[], options: FreeOptions, many: boolean): string {
  if (options.line)
    return rows
      .map(
        (res) =>
          `${many ? withMachine(oneLine(res, shown(res, options)), res.machine) : oneLine(res, shown(res, options))}\n`,
      )
      .join('')
  const top = header(options)
  const lines = [many ? `${top}  ${MACHINE_HEADER}` : top]
  for (const res of rows)
    for (const line of table(res, shown(res, options)))
      lines.push(many ? withMachine(line, res.machine, top.length) : line)
  return lines.map((line) => `${line}\n`).join('')
}

async function* passes(
  first: string,
  processes: ProcessTable,
  scope: MachineScope,
  memory: MemoryBudget | null,
  options: FreeOptions,
  count: number | null,
  delay: number,
  io: IOResult,
  node: ExecutionNode,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  try {
    yield encodeText(first)
    let done = 1
    while (count === null || done < count) {
      await sleep(delay * 1000, signal)
      const [rows, errors] = await read(processes, scope, memory)
      if (errors !== '') await tellOnce(io, node, errors)
      yield encodeText(`\n${render(rows, options, scope.several)}`)
      done += 1
    }
  } finally {
    io.output?.finish()
  }
}

function freeOptions(
  units: readonly string[],
  flags: Record<string, string | boolean>,
): FreeOptions {
  const [power, si] = constants.FREE_UNITS[units[0] ?? ''] ?? [1, false]
  return {
    power,
    si: si || flags.si === true,
    human: flags.h === true,
    wide: flags.w === true,
    total: flags.t === true,
    committed: flags.v === true,
    lohi: flags.l === true,
    line: flags.L === true,
  }
}

function readDelay(text: string): [number, string] {
  const seconds = Number(text)
  if (text.trim() === '' || Number.isNaN(seconds))
    return [0, `free: seconds argument failed: '${text}': Invalid argument\n`]
  if (seconds <= 0) return [0, `free: seconds argument \`${text}' is not positive number\n`]
  return [seconds, '']
}

function readCount(text: string): [number, string] {
  if (!/^[0-9]+$/.test(text)) return [0, `free: failed to parse count argument: '${text}'\n`]
  if (Number(text) < 1)
    return [0, `free: failed to parse count argument: '${text}': Numerical result out of range\n`]
  return [Number(text), '']
}

/**
 * Print the memory of the machines a line can use, in procps's columns,
 * `machineScope` choosing which; several print a row each with a `MACHINE`
 * column on the right, and are never added up. The workspace answers too, in
 * any workspace, with its `max_memory`. Mirrors Python's `handle_free`.
 */
export async function handleFree(
  jobTable: JobTable,
  parts: string[],
  _session: SessionState | null = null,
  _view: SessionView | null = null,
  signal?: AbortSignal,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const spec = SHELL_SPECS.free
  const parse = parseShellOptions(spec, parts.slice(1))
  const refusal = optionRefusal('free', parse)
  if (refusal !== '') return jobResult(cmdStr, refusal, 1)
  if (parse.operands.length > 0) return jobResult(cmdStr, `\n${usagePage('free')}`, 1)
  const answer = (text: string): RedirectResult => [
    encodeText(text),
    new IOResult(),
    new ExecutionNode({ command: cmdStr, exitCode: 0 }),
  ]
  if (parse.flags.help === true) return answer(usagePage('free'))
  if (parse.flags.V === true) return answer(versionLine('free'))
  const units = parse.given.map(([key]) => key).filter((key) => key in constants.FREE_UNITS)
  if (units.length > 1)
    return jobResult(cmdStr, "free: Multiple unit options don't make sense.\n", 1)
  let delay = constants.FREE_DELAY_SECONDS
  let count: number | null = 1
  if (typeof parse.flags.s === 'string') {
    const [seconds, said] = readDelay(parse.flags.s)
    if (said !== '') return jobResult(cmdStr, said, 1)
    delay = seconds
    count = null
  }
  if (typeof parse.flags.c === 'string') {
    const [times, said] = readCount(parse.flags.c)
    if (said !== '') return jobResult(cmdStr, said, 1)
    count = times
  }
  const name = parse.flags.machine
  const named = typeof name === 'string' ? name : null
  const processes = jobTable.processes
  const scope = machineScope(processes, named, true)
  if (scope === null) return jobResult(cmdStr, `free: ${named ?? ''}: no such machine\n`, 1)
  const options = freeOptions(units, parse.flags)
  const memory = memoryBudget()
  const [rows, errors] = await read(processes, scope, memory)
  const text = rows.length > 0 ? render(rows, options, scope.several) : ''
  const code = errors === '' ? 0 : 1
  const err = errors === '' ? null : encodeText(errors)
  const io = new IOResult({ exitCode: code, stderr: err })
  const node = new ExecutionNode({
    command: cmdStr,
    exitCode: code,
    stderr: err ?? new Uint8Array(),
  })
  if (count === 1) return [encodeText(text), io, node]
  io.output = new OutputState()
  const out = passes(text, processes, scope, memory, options, count, delay, io, node, signal)
  return [out, io, node]
}
