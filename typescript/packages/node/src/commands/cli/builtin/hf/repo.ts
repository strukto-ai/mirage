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
import { UsageError } from '@struktoai/mirage-core/commands/errors'
import { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import { materialize } from '@struktoai/mirage-core/io/types'
import { createRepo, createTag, deleteTag, listTags } from '../../../../core/hf_hub/admin.ts'
import { repoUrl } from '../../../../core/hf_hub/client.ts'
import { hfEndpoint, type HfConfig } from '../../../../core/hf_hub/config.ts'
import { DEFAULT_REVISION } from '../../../../core/hf_hub/constants.ts'
import { repoTypeOf, requireOperands, requireToken, textOut } from './accessor.ts'

/** Create a repository on the Hub. */
export async function createCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id'])
  requireToken(inv, 'repo create')
  const fl = new FlagView(inv.flags)
  const config = inv.config as HfConfig
  const repoId = inv.texts[0] ?? ''
  const repoType = repoTypeOf(fl)
  const sdk = fl.asStr('space_sdk')
  if (repoType === 'space' && (sdk === undefined || sdk === '')) {
    throw new UsageError(
      'creating a space requires --space_sdk (gradio, streamlit, docker or static)',
    )
  }
  const result = await createRepo(config, repoId, {
    repoType,
    private: fl.asBool('private'),
    spaceSdk: sdk,
    existOk: fl.asBool('exist_ok'),
    resourceGroupId: fl.asStr('resource_group_id'),
  })
  const url = result.url
  return textOut(
    typeof url === 'string' ? `${url}\n` : `${repoUrl(hfEndpoint(config), repoType, repoId)}\n`,
  )
}

/** Tag a revision of a repository. */
export async function tagCreateCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id', 'tag'])
  requireToken(inv, 'repo tag create')
  const fl = new FlagView(inv.flags)
  const repoId = inv.texts[0] ?? ''
  const tag = inv.texts[1] ?? ''
  await createTag(
    inv.config as HfConfig,
    repoId,
    tag,
    repoTypeOf(fl),
    fl.asStr('revision') ?? DEFAULT_REVISION,
    fl.asStr('message'),
  )
  return textOut(`Tag ${tag} created on ${repoId}\n`)
}

/** List a repository's tags. */
export async function tagListCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id'])
  const fl = new FlagView(inv.flags)
  const tags = await listTags(inv.config as HfConfig, inv.texts[0] ?? '', repoTypeOf(fl))
  return textOut(tags.map((name) => `${name}\n`).join(''))
}

/**
 * Whether the line agreed to a destructive action.
 *
 * Upstream asks on stdin and takes `-y` to skip the question, so both routes
 * are honored: `-y` short-circuits, and otherwise the piped answer is read the
 * way `input()` would read it. A line with nothing piped is the case upstream
 * cannot reach, since a workspace has no terminal to fall back to, and it
 * declines rather than assuming yes.
 */
async function confirmed(inv: CLIInvocation): Promise<boolean> {
  if (new FlagView(inv.flags).asBool('yes')) return true
  if (inv.stdin === null) return false
  const answer = new TextDecoder().decode(await materialize(inv.stdin))
  const trimmed = answer.trim().toLowerCase()
  return trimmed === 'y' || trimmed === 'yes'
}

/**
 * Delete a tag from a repository.
 *
 * Upstream asks for confirmation before deleting; a workspace has no terminal,
 * so the answer arrives either as `-y` or on stdin.
 */
export async function tagDeleteCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id', 'tag'])
  requireToken(inv, 'repo tag delete')
  const fl = new FlagView(inv.flags)
  const repoId = inv.texts[0] ?? ''
  const tag = inv.texts[1] ?? ''
  if (!(await confirmed(inv))) {
    throw new UsageError(
      `deleting tag ${tag} needs -y, or y on stdin: there is no terminal to confirm on`,
    )
  }
  await deleteTag(inv.config as HfConfig, repoId, tag, repoTypeOf(fl))
  return textOut(`Tag ${tag} deleted on ${repoId}\n`)
}
