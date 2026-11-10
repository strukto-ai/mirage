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

import { HOSTNAME } from '../../../../commands/builtin/constants.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { jobResult } from '../jobspec.ts'
import { machineNamed, machineScope, readMachines, rowsResult } from '../machine_view.ts'

/**
 * Print the workspace's name and each machine's, on a workspace that runs
 * programs on any, one name a line and the workspace's first. Mirrors Python's
 * `handle_hostname`.
 */
export async function handleHostname(
  jobTable: JobTable,
  parts: string[],
  _session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const named = machineNamed(parts.slice(1))
  const processes = jobTable.processes
  const scope = machineScope(processes, named, true)
  if (scope === null) return jobResult(cmdStr, `hostname: ${named ?? ''}: no such machine\n`, 1)
  const [rows, errors] = await readMachines(processes, scope, 'hostname')
  const names = [...(scope.workspace ? [HOSTNAME] : []), ...rows.map((row) => row.hostname)]
  return rowsResult(cmdStr, names, errors)
}
