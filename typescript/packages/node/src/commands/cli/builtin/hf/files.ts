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
import { commit } from '../../../../core/hf_hub/commit.ts'
import { DEFAULT_COMMIT_MESSAGE } from '../../../../core/hf_hub/constants.ts'
import { hubFor, repoTypeOf, requireOperands, requireToken, textOut } from './accessor.ts'

/**
 * Delete files or folders from a repository, in one commit.
 *
 * A pattern ending in `/` is a folder, which the Hub deletes under its own
 * key: sending one as a file deletion reports that no file by that name
 * exists.
 */
export async function deleteCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id', 'patterns'])
  requireToken(inv, 'repo-files delete')
  const fl = new FlagView(inv.flags)
  const [repoId, ...patterns] = inv.texts
  const files = patterns.filter((p) => !p.endsWith('/'))
  const folders = patterns.filter((p) => p.endsWith('/')).map((p) => p.replace(/\/+$/, ''))
  const target = repoId ?? ''
  const accessor = hubFor(inv, target, repoTypeOf(fl), fl.asStr('revision'))
  await commit(accessor, {
    deletions: files,
    folders,
    message: fl.asStr('commit_message') ?? DEFAULT_COMMIT_MESSAGE,
    description: fl.asStr('commit_description') ?? '',
    createPr: fl.asBool('create_pr'),
  })
  return textOut(patterns.map((p) => `Deleted ${p} from ${target}\n`).join(''))
}
