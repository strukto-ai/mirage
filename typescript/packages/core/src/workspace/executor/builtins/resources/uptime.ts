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
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import type { MachineResources } from '../../../../execution/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { jobResult } from '../jobspec.ts'
import {
  machineScope,
  optionRefusal,
  readMachines,
  usagePage,
  withMachine,
} from '../machine_view.ts'
import * as constants from './constants.ts'

function plural(count: number): string {
  return count === 1 ? '' : 's'
}

/** How long a machine has been up, as `uptime` and `top` say it. */
export function upText(seconds: number): string {
  const whole = Math.trunc(seconds)
  const days = Math.floor(whole / 86400)
  const hours = Math.floor((whole % 86400) / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const clock =
    hours > 0
      ? `${String(hours).padStart(2)}:${String(minutes).padStart(2, '0')}`
      : `${String(minutes)} min`
  return days > 0 ? `${String(days)} day${plural(days)}, ${clock}` : clock
}

/** What `uptime` and `top`'s first line share. */
export function summary(row: MachineResources): string {
  const [one, five, fifteen] = row.load
  return (
    `${row.clock} up ${upText(row.upSeconds)},  ` +
    `${String(row.users)} user${plural(row.users)},  ` +
    `load average: ${one.toFixed(2)}, ${five.toFixed(2)}, ${fifteen.toFixed(2)}`
  )
}

/** `uptime -p`: each part of the time that is not zero, and the minutes always. */
export function pretty(seconds: number): string {
  let left = Math.trunc(seconds)
  const parts: string[] = []
  for (const [name, size] of constants.PRETTY_UNITS) {
    const amount = Math.floor(left / size)
    left %= size
    if (amount > 0) parts.push(`${String(amount)} ${name}${plural(amount)}`)
  }
  const minutes = Math.floor(left / 60)
  parts.push(`${String(minutes)} minute${plural(minutes)}`)
  return `up ${parts.join(', ')}`
}

/** `uptime -s`: when the machine booted, on its own clock. */
export function since(row: MachineResources): string {
  const sign = row.offset.startsWith('-') ? -1 : 1
  const digits = row.offset.replace(/^[+-]/, '')
  const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60
  const local = new Date((Math.trunc(row.epoch - row.upSeconds) + offset) * 1000)
  return local.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Say how long the machines a line can use have been up and how loaded they
 * are; several print a line each with the machine at its end. `-s` outranks
 * `-p`. Mirrors Python's `handle_uptime`.
 */
export async function handleUptime(
  jobTable: JobTable,
  parts: string[],
  _session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const spec = SHELL_SPECS.uptime
  const parse = parseShellOptions(spec, parts.slice(1))
  const refusal = optionRefusal('uptime', parse)
  if (refusal !== '') return jobResult(cmdStr, refusal, 1)
  if (parse.operands.length > 0) return jobResult(cmdStr, `\n${usagePage('uptime')}`, 1)
  const answer = (text: string): RedirectResult => [
    encodeText(text),
    new IOResult(),
    new ExecutionNode({ command: cmdStr, exitCode: 0 }),
  ]
  if (parse.flags.h === true) return answer(usagePage('uptime'))
  if (parse.flags.V === true) return answer(versionLine('uptime'))
  const name = parse.flags.machine
  const named = typeof name === 'string' ? name : null
  const processes = jobTable.processes
  const scope = machineScope(processes, named)
  if (scope === null) return jobResult(cmdStr, `uptime: ${named ?? ''}: no such machine\n`, 1)
  const [rows, errors] = await readMachines(processes, scope, 'uptime')
  const lines = rows.map((row) => {
    const text =
      parse.flags.s === true
        ? since(row)
        : parse.flags.p === true
          ? pretty(row.upSeconds)
          : ` ${summary(row)}`
    return scope.several ? withMachine(text, row.machine) : text
  })
  const code = errors === '' ? 0 : 1
  const err = errors === '' ? null : encodeText(errors)
  return [
    encodeText(lines.map((line) => `${line}\n`).join('')),
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err ?? new Uint8Array() }),
  ]
}
