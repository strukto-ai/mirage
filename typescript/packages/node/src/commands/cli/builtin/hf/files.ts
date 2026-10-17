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

import type { CommandFnResult, Context } from '@struktoai/mirage-core/commands/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import type { HfAccountAccessor } from '../../../../accessor/hf_hub.ts'
import { repoUrl } from '../../../../core/hf_hub/client.ts'
import { commit } from '../../../../core/hf_hub/commit.ts'
import { EMPTY_COMMIT_WARNING } from '../../../../core/hf_hub/constants.ts'
import { headCommit } from '../../../../core/hf_hub/repo.ts'
import { deletionsFor, fetchTree, repoFiles } from '../../../../core/hf_hub/tree.ts'
import { hubFor, repoTypeOf, requireOperands, requireToken, textOut } from './accessor.ts'

/**
 * Delete the files a set of glob patterns matches, in one commit.
 *
 * huggingface_hub's `delete_files`: the patterns match the repository's
 * listing (`*` crosses `/`, a trailing `/` names a folder), so `**` deletes
 * every file and a pattern matching nothing deletes nothing. A line that
 * matches nothing makes no commit, warns the way upstream's `create_commit`
 * does, and names the commit the revision already points at.
 */
export async function deleteCmd(
  accessor: HfAccountAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  requireOperands(texts, ['repo_id', 'patterns'])
  requireToken(accessor, 'repo-files delete')
  const fl = new FlagView(ctx.flags)
  const [repoId, ...patterns] = texts
  const target = repoId ?? ''
  const hub = hubFor(accessor, target, repoTypeOf(fl), fl.asStr('revision'))
  const deletions = deletionsFor(repoFiles(await fetchTree(hub)), patterns)
  const message = fl.asStr('commit_message')
  let url: string
  let stderr = ''
  const reply = await commit(hub, {
    deletions,
    message:
      message === undefined || message === ''
        ? `Delete files ${patterns.join(' ')} with mirage`
        : message,
    description: fl.asStr('commit_description') ?? '',
    createPr: fl.asBool('create_pr'),
  })
  if (reply === undefined) {
    const home = repoUrl(hub.endpoint, hub.repoType, target)
    url = `${home}/commit/${await headCommit(hub)}`
    stderr = EMPTY_COMMIT_WARNING
  } else {
    url = typeof reply.commitUrl === 'string' ? reply.commitUrl : ''
  }

  return textOut(`Files correctly deleted from repo. Commit: ${url}.\n`, stderr)
}
