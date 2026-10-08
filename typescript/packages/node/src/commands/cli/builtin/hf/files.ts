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

import type { CLIInvocation } from '@struktoai/mirage-core/commands/cli/types'
import type { CommandFnResult } from '@struktoai/mirage-core/commands/config'
import { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import { repoUrl } from '../../../../core/hf_hub/client.ts'
import { commit } from '../../../../core/hf_hub/commit.ts'
import { EMPTY_COMMIT_WARNING } from '../../../../core/hf_hub/constants.ts'
import { headCommit } from '../../../../core/hf_hub/repo.ts'
import { deletionsFor, fetchTree, repoFiles } from '../../../../core/hf_hub/tree.ts'
import type { HfConfig } from '../../../../core/hf_hub/config.ts'
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
export async function deleteCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id', 'patterns'])
  requireToken(inv, 'repo-files delete')
  const fl = new FlagView(inv.flags)
  const [repoId, ...patterns] = inv.texts
  const target = repoId ?? ''
  const accessor = hubFor(inv, target, repoTypeOf(fl), fl.asStr('revision'))
  const deletions = deletionsFor(repoFiles(await fetchTree(accessor)), patterns)
  const message = fl.asStr('commit_message')
  let url: string
  let stderr = ''
  const reply = await commit(accessor, {
    deletions,
    message:
      message === undefined || message === ''
        ? `Delete files ${patterns.join(' ')} with mirage`
        : message,
    description: fl.asStr('commit_description') ?? '',
    createPr: fl.asBool('create_pr'),
  })
  if (reply === undefined) {
    const home = repoUrl((inv.config as HfConfig).endpoint, accessor.repoType, target)
    url = `${home}/commit/${await headCommit(accessor)}`
    stderr = EMPTY_COMMIT_WARNING
  } else {
    url = typeof reply.commitUrl === 'string' ? reply.commitUrl : ''
  }

  return textOut(`Files correctly deleted from repo. Commit: ${url}.\n`, stderr)
}
