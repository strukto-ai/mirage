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
import { getIssue, issueUpdate, resolveIssueId } from '../../../core/linear/_client.ts'
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
    new Option({ long: '--label_id', valueKind: OperandKind.TEXT }),
  ],
})

async function linearIssueAddLabelCommand(
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
  const labelId = opts.flags.label_id
  if (typeof labelId !== 'string' || labelId === '') {
    throw new Error('--label_id is required')
  }
  const issue = await getIssue(accessor.transport, issueId)
  const labels = issue.labels
  const nodes =
    labels !== null && typeof labels === 'object'
      ? ((labels as Record<string, unknown>).nodes as Record<string, unknown>[] | undefined)
      : undefined
  const existing: string[] = []
  if (nodes !== undefined) {
    for (const n of nodes) {
      const id = n.id
      if (typeof id === 'string') existing.push(id)
    }
  }
  if (!existing.includes(labelId)) existing.push(labelId)
  const updated = await issueUpdate(accessor.transport, { issueId, labelIds: existing })
  return [ENC.encode(JSON.stringify(normalizeIssue(updated))), new IOResult()]
}

export const LINEAR_ISSUE_ADD_LABEL = command({
  name: 'linear issue add-label',
  resource: ResourceName.LINEAR,
  spec: SPEC,
  fn: linearIssueAddLabelCommand,
  write: true,
})
