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

import type { LinearAccessor } from '../../../accessor/linear.ts'
import { issueUpdate, resolveIssueId } from '../../../core/linear/_client.ts'
import { normalizeIssue } from '../../../core/linear/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--issue_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--issue_key', valueKind: OperandKind.TEXT }),
    new Option({ long: '--priority', valueKind: OperandKind.TEXT }),
  ],
})

async function linearIssueSetPriorityCommand(
  accessor: LinearAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const issueId = await resolveIssueId(
    accessor.transport,
    typeof opts.flags.issue_id === 'string' ? opts.flags.issue_id : null,
    typeof opts.flags.issue_key === 'string' ? opts.flags.issue_key : null,
  )
  const priorityRaw = opts.flags.priority
  if (typeof priorityRaw !== 'string' || priorityRaw === '') {
    throw new Error('--priority is required')
  }
  const priority = Number.parseInt(priorityRaw, 10)
  if (!Number.isFinite(priority)) throw new Error(`invalid priority: ${priorityRaw}`)
  const issue = await issueUpdate(accessor.transport, { issueId, priority })
  return [ENC.encode(JSON.stringify(normalizeIssue(issue))), new IOResult()]
}

export const LINEAR_ISSUE_SET_PRIORITY = command({
  name: 'linear issue set-priority',
  resource: ResourceName.LINEAR,
  spec: SPEC,
  fn: linearIssueSetPriorityCommand,
  write: true,
})
