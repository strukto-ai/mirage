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

import type { GitHubAccessor } from '../../../accessor/github.ts'
import { du as githubDu, duAll as githubDuAll } from '../../../core/github/du.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GITHUB_CMD_OPS } from './ops.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { duGeneric } from '../generic/du.ts'

const resolveGlob = resolveGlobOf(GITHUB_CMD_OPS)

async function duCommand(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  return duGeneric(
    resolved,
    opts,
    (p) => githubDu(accessor, p),
    (p) => githubDuAll(accessor, p),
  )
}

export const GITHUB_DU = command({
  name: 'du',
  resource: ResourceName.GITHUB,
  spec: specOf('du'),
  fn: duCommand,
})
