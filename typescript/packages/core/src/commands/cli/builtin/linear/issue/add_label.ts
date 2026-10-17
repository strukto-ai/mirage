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
import { getIssue, issueUpdate } from '../../../../../core/linear/client.ts'
import { normalizeIssue, toJsonBytes } from '../../../../../core/linear/normalize.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import { firstText, resolveIssue, resolveLabelId } from '../util.ts'

export async function addLabel(
  accessor: LinearAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const issueId = await resolveIssue(accessor, firstText(texts, 'issue key'))
  const issue = await getIssue(accessor.transport, issueId)
  const team = issue.team
  const rawTeamId =
    team !== null && typeof team === 'object' ? (team as Record<string, unknown>).id : undefined
  const teamId = typeof rawTeamId === 'string' ? rawTeamId : ''
  const labelId = await resolveLabelId(accessor, teamId, fl.asStr('label'), fl.asStr('label_name'))
  const labels = issue.labels
  const nodes =
    labels !== null && typeof labels === 'object'
      ? ((labels as Record<string, unknown>).nodes as Record<string, unknown>[] | undefined)
      : undefined
  const existing: string[] = []
  for (const node of nodes ?? []) {
    if (typeof node.id === 'string') existing.push(node.id)
  }
  if (!existing.includes(labelId)) existing.push(labelId)
  const updated = await issueUpdate(accessor.transport, { issueId, labelIds: existing })
  return [toJsonBytes(normalizeIssue(updated)), new IOResult()]
}
