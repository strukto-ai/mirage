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
import { resolveTextInput } from './_input.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--issue_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--issue_key', valueKind: OperandKind.TEXT }),
    new Option({ long: '--title', valueKind: OperandKind.TEXT }),
    new Option({ long: '--description', valueKind: OperandKind.TEXT }),
    new Option({ long: '--description_file', valueKind: OperandKind.PATH }),
  ],
})

async function linearIssueUpdateCommand(
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
  const title = typeof opts.flags.title === 'string' ? opts.flags.title : null
  const inlineDesc = typeof opts.flags.description === 'string' ? opts.flags.description : null
  const descFile =
    typeof opts.flags.description_file === 'string' ? opts.flags.description_file : null
  let description: string | undefined
  if (inlineDesc !== null || descFile !== null || opts.stdin !== null) {
    description = await resolveTextInput(accessor.transport, {
      inlineText: inlineDesc,
      filePath: descFile,
      stdin: opts.stdin,
      errorMessage: 'description is required',
    })
  }
  const issue = await issueUpdate(accessor.transport, {
    issueId,
    ...(title !== null ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  })
  return [ENC.encode(JSON.stringify(normalizeIssue(issue))), new IOResult()]
}

export const LINEAR_ISSUE_UPDATE = command({
  name: 'linear issue update',
  resource: ResourceName.LINEAR,
  spec: SPEC,
  fn: linearIssueUpdateCommand,
  write: true,
})
