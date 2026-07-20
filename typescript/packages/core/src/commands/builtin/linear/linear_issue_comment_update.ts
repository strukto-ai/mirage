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
import { commentUpdate } from '../../../core/linear/_client.ts'
import { normalizeComment } from '../../../core/linear/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'
import { resolveTextInput } from './_input.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--comment_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--body', valueKind: OperandKind.TEXT }),
    new Option({ long: '--body_file', valueKind: OperandKind.PATH }),
  ],
})

async function linearIssueCommentUpdateCommand(
  accessor: LinearAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const commentId = opts.flags.comment_id
  if (typeof commentId !== 'string' || commentId === '') {
    throw new Error('--comment_id is required')
  }
  const inlineBody = typeof opts.flags.body === 'string' ? opts.flags.body : null
  const bodyFile = typeof opts.flags.body_file === 'string' ? opts.flags.body_file : null
  const body = await resolveTextInput(accessor.transport, {
    inlineText: inlineBody,
    filePath: bodyFile,
    stdin: opts.stdin,
    errorMessage: 'comment body is required',
  })
  const comment = await commentUpdate(accessor.transport, commentId, body)
  const issueField = comment.issue
  const issueId =
    issueField !== null && typeof issueField === 'object'
      ? (((issueField as Record<string, unknown>).id as string | undefined) ?? '')
      : ''
  const issueKey =
    issueField !== null && typeof issueField === 'object'
      ? (((issueField as Record<string, unknown>).identifier as string | undefined) ?? null)
      : null
  return [ENC.encode(JSON.stringify(normalizeComment(comment, issueId, issueKey))), new IOResult()]
}

export const LINEAR_ISSUE_COMMENT_UPDATE = command({
  name: 'linear comment update',
  resource: ResourceName.LINEAR,
  spec: SPEC,
  fn: linearIssueCommentUpdateCommand,
  write: true,
})
