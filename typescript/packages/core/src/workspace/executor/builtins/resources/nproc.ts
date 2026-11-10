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

import { threadLimit } from '../../../../commands/builtin/utils/threads.ts'
import { quoteText } from '../../../../commands/quote.ts'
import { specOf } from '../../../../commands/spec/builtins.ts'
import { parseShellOptions } from '../../../../commands/spec/shell.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { CPUS } from '../../../../commands/builtin/constants.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { WORKSPACE_MACHINE } from '../../../../execution/process/constants.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { jobResult } from '../jobspec.ts'
import { machineScope, optionRefusal, readMachines, rowsResult } from '../machine_view.ts'

/**
 * Print the processors of the workspace and the machines a line can use, on a
 * workspace that runs programs on any: one bare number for one, as a script
 * expects, and a row each, its number first, for several. Never added up, as
 * one program cannot use another machine's processors. Mirrors Python's
 * `handle_nproc`.
 */
export async function handleNproc(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const parse = parseShellOptions(specOf('nproc'), parts.slice(1))
  const refusal = optionRefusal('nproc', parse, false)
  if (refusal !== '')
    return jobResult(cmdStr, `${refusal}Try 'nproc --help' for more information.\n`, 1)
  const ignore = parse.flags.ignore
  if (typeof ignore === 'string' && !/^[0-9]+$/.test(ignore))
    return jobResult(cmdStr, `nproc: invalid number: '${quoteText(ignore)}'\n`, 1)
  const extra = parse.operands[0]
  if (extra !== undefined)
    return jobResult(
      cmdStr,
      `nproc: extra operand '${quoteText(extra)}'\nTry 'nproc --help' for more information.\n`,
      1,
    )
  const name = parse.flags.machine
  const named = typeof name === 'string' ? name : null
  const processes = jobTable.processes
  const scope = machineScope(processes, named, true)
  if (scope === null) return jobResult(cmdStr, `nproc: ${named ?? ''}: no such machine\n`, 1)
  const [rows, errors] = await readMachines(processes, scope, 'nproc')
  const env = session?.env ?? {}
  const every = parse.flags.all === true
  const figures: [string, number, number][] = rows.map((row) => [
    row.machine,
    row.cpus,
    row.allCpus,
  ])
  if (scope.workspace) figures.unshift([WORKSPACE_MACHINE, CPUS, CPUS])
  const counts = figures.map(([, usable, whole]) =>
    Math.max(
      1,
      (every ? whole : threadLimit(env, usable)) - Number(typeof ignore === 'string' ? ignore : 0),
    ),
  )
  const width = Math.max(0, ...counts.map((count) => String(count).length))
  const lines = counts.map((count, at) =>
    scope.several ? `${String(count).padStart(width)}  ${figures[at]?.[0] ?? ''}` : String(count),
  )
  return rowsResult(cmdStr, lines, errors)
}
