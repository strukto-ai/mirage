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

import type { LinearAccessor } from '../../../../../accessor/linear.ts'
import { issueUpdate } from '../../../../../core/linear/client.ts'
import { normalizeIssue, toJsonBytes } from '../../../../../core/linear/normalize.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import { firstText, resolveIssue, textOrStdin } from '../util.ts'

export async function update(
  accessor: LinearAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const issueId = await resolveIssue(accessor, firstText(texts, 'issue key'))
  let description: string | null = null
  if (fl.asStr('description') !== undefined || ctx.stdin !== null) {
    description = await textOrStdin(fl.asStr('description'), ctx.stdin, 'description is required')
  }
  const issue = await issueUpdate(accessor.transport, {
    issueId,
    title: fl.asStr('title') ?? null,
    description,
  })
  return [toJsonBytes(normalizeIssue(issue)), new IOResult()]
}
