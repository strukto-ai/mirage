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
import {
  issueUpdate,
  type LinearTransport,
  listTeams,
  resolveIssueId,
} from '../../../core/linear/_client.ts'
import { normalizeIssue } from '../../../core/linear/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'
import { enoent } from '../../../utils/errors.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--issue_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--issue_key', valueKind: OperandKind.TEXT }),
    new Option({ long: '--state_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--state_name', valueKind: OperandKind.TEXT }),
  ],
})

async function resolveStateId(
  transport: LinearTransport,
  stateId: string | null,
  stateName: string | null,
): Promise<string> {
  if (stateId !== null && stateId !== '') return stateId
  if (stateName === null || stateName === '') {
    throw new Error('state id or state name is required')
  }
  const teams = await listTeams(transport)
  for (const team of teams) {
    const states = team.states
    const nodes =
      states !== null && typeof states === 'object'
        ? ((states as Record<string, unknown>).nodes as Record<string, unknown>[] | undefined)
        : undefined
    if (nodes === undefined) continue
    for (const state of nodes) {
      if (state.name === stateName) {
        const id = state.id
        if (typeof id === 'string') return id
      }
    }
  }
  throw enoent(stateName)
}

async function linearIssueTransitionCommand(
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
  const stateId = await resolveStateId(
    accessor.transport,
    typeof opts.flags.state_id === 'string' ? opts.flags.state_id : null,
    typeof opts.flags.state_name === 'string' ? opts.flags.state_name : null,
  )
  const issue = await issueUpdate(accessor.transport, { issueId, stateId })
  return [ENC.encode(JSON.stringify(normalizeIssue(issue))), new IOResult()]
}

export const LINEAR_ISSUE_TRANSITION = command({
  name: 'linear issue transition',
  resource: ResourceName.LINEAR,
  spec: SPEC,
  fn: linearIssueTransitionCommand,
  write: true,
})
