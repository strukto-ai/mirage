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

import { CPUS } from '../../../../commands/builtin/constants.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { WORKSPACE_MACHINE } from '../../../../execution/process/constants.ts'
import type { MachineResources } from '../../../../execution/types.ts'
import { NOT_FOUND_STATUS } from '../../../../shell/constants.ts'
import { shellVoice } from '../../../../shell/voice.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { jobResult } from '../jobspec.ts'
import { machineNamed, machineScope, readMachines, rowsResult } from '../machine_view.ts'
import { LSCPU_VALUE_COLUMN, LSCPU_WIDE_ROWS, NO_FIGURE } from './constants.ts'

const CPUS_LABEL = 'CPU(s):'

// What the workspace can say of itself, in `lscpu`'s order: `od` and Python's
// `sys.byteorder` read bytes little-endian on every host.
const WORKSPACE_ROWS: ReadonlyMap<string, string> = new Map([
  ['Byte Order:', 'Little Endian'],
  [CPUS_LABEL, String(CPUS)],
])

/** `lscpu`'s rows, by label, less those too wide for a table. */
function fields(info: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of info.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0 || LSCPU_WIDE_ROWS.some((row) => line.startsWith(row))) continue
    found.set(line.slice(0, colon + 1), line.slice(colon + 1).trim())
  }
  return found
}

/**
 * Every label of the columns, each machine's in its own order and one a machine
 * alone has placed after the row it follows there.
 */
function labels(columns: readonly ReadonlyMap<string, string>[]): string[] {
  const found: string[] = []
  for (const column of columns) {
    let at = 0
    for (const label of column.keys()) {
      const known = found.indexOf(label)
      if (known >= 0) {
        at = known + 1
      } else {
        found.splice(at, 0, label)
        at += 1
      }
    }
  }
  return found
}

/**
 * One row a field and one column a machine, the workspace first with what it
 * can say of itself and `-` for the rest, as it is no computer.
 */
function table(rows: readonly MachineResources[]): string[] {
  const heads = [WORKSPACE_MACHINE, ...rows.map((row) => row.machine)]
  const columns = [WORKSPACE_ROWS, ...rows.map((row) => fields(row.cpuInfo))]
  const found = labels(columns.slice(1))
  const body = (found.length > 0 ? found : [...WORKSPACE_ROWS.keys()]).map((label) => [
    label,
    ...columns.map((column) => column.get(label) ?? NO_FIGURE),
  ])
  const every = [['', ...heads], ...body]
  const widths = heads.map((_, at) => Math.max(...every.map((row) => (row[at] ?? '').length)))
  return every.map((row) =>
    [...widths.map((width, at) => (row[at] ?? '').padEnd(width)), row.at(-1) ?? '']
      .join('  ')
      .trimEnd(),
  )
}

/**
 * Print what the machines' processors are, on a workspace that runs programs
 * on any: `lscpu` as a machine prints it for one, as a script expects, and for
 * several a table with a column each. Any other option is the program's own.
 * Mirrors Python's `handle_lscpu`.
 */
export async function handleLscpu(
  jobTable: JobTable,
  parts: string[],
  _session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const named = machineNamed(parts.slice(1))
  const processes = jobTable.processes
  const scope = machineScope(processes, named, true)
  if (scope === null) return jobResult(cmdStr, `lscpu: ${named ?? ''}: no such machine\n`, 1)
  const [rows, errors] = await readMachines(processes, scope, 'lscpu')
  if (scope.several) return rowsResult(cmdStr, table(rows), errors)
  if (scope.workspace) {
    const lines = [...WORKSPACE_ROWS].map(
      ([label, value]) => `${label.padEnd(LSCPU_VALUE_COLUMN)}${value}`,
    )
    return rowsResult(cmdStr, lines, errors)
  }
  const info = rows[0]?.cpuInfo
  if (info === '')
    return jobResult(cmdStr, `${shellVoice()}lscpu: command not found\n`, NOT_FOUND_STATUS)
  return rowsResult(cmdStr, (info ?? '').split('\n').slice(0, -1), errors)
}
