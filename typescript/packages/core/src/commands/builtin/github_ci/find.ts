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

import type { GitHubCIAccessor } from '../../../accessor/github_ci.ts'
import { walkFind } from '../../../core/generic/find.ts'
import { isCrossRunRoot, resolveGlob } from '../../../core/github_ci/glob.ts'
import { isDirName, readdir as ciReaddir } from '../../../core/github_ci/readdir.ts'
import { stat as ciStat } from '../../../core/github_ci/stat.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { findGeneric } from '../generic/find.ts'
import { metadataProvision } from './provision.ts'

async function findCommand(
  accessor: GitHubCIAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlob(accessor, paths, idx) : []
  // The wrapper only exists for the cross-run guard: walking every run
  // would fetch every run's logs. Filtering is the shared generic walk.
  return findGeneric(resolved, texts, opts, (root, options) => {
    if (isCrossRunRoot(root)) {
      throw new Error(
        'find: recursive search across runs is disabled; target a specific run (e.g. /ci/runs/<run>)',
      )
    }
    return walkFind(
      root,
      {
        readdir: (spec, i) => ciReaddir(accessor, spec, i),
        stat: (spec, i) => ciStat(accessor, spec, i),
        isDirName: (child) => isDirName(child),
      },
      options,
      idx,
    )
  })
}

export const GITHUB_CI_FIND = command({
  name: 'find',
  resource: ResourceName.GITHUB_CI,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
