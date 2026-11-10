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

import { currentCaller } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { WORKSPACE_MACHINE } from '../../../../execution/process/constants.ts'
import { type Process, shownMachine } from '../../../../execution/process/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { grantsOf, sessionOf } from '../jobspec.ts'
import type { MachineScope } from '../machine_view.ts'

// The longest process name a process's `comm` holds.
export const NAME_WIDTH = 15

/** The basename of the program a process runs. */
export function programOf(info: Process): string {
  const head = info.command.split(/\s+/).find((word) => word !== '') ?? ''
  return head.slice(head.lastIndexOf('/') + 1)
}

/** A process's name, as the kernel keeps it. Mirrors Python's `process_name`. */
export function processName(info: Process): string {
  return programOf(info).slice(0, NAME_WIDTH)
}

/**
 * The processes a search picks from, on the machines looked at first: those
 * `ps` shows, running, on a machine in `scope` or, unless a machine was
 * named, Mirage's own, without the one searching and the shells it runs
 * under, whose lines hold no program's name. Mirrors Python's `running`.
 */
export async function running(
  jobTable: JobTable,
  session: SessionState | null,
  scope: MachineScope,
): Promise<Process[]> {
  const processes = jobTable.processes
  await processes.scan()
  const caller = currentCaller().process?.record
  const own = new Set(caller === undefined ? [] : [caller.id.pid, ...caller.ancestors])
  return processes
    .visible(sessionOf(session), grantsOf(session))
    .filter(
      (info) =>
        (info.stages === undefined || info.stages.length === 0) &&
        !own.has(info.id.pid) &&
        info.state === 'running' &&
        (scope.ids.includes(shownMachine(info)) ||
          (!scope.picked && shownMachine(info) === WORKSPACE_MACHINE)),
    )
}
