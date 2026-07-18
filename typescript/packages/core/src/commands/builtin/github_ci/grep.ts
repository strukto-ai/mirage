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
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GITHUB_CI_CMD_OPS } from './ops.ts'
import { stream as ciStream } from '../../../core/github_ci/read.ts'
import { isCrossRunRoot, readdir as ciReaddir } from '../../../core/github_ci/readdir.ts'
import { stat as ciStat } from '../../../core/github_ci/stat.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { grepGeneric } from '../generic/grep.ts'

const resolveGlob = resolveGlobOf(GITHUB_CI_CMD_OPS)

const ENC = new TextEncoder()

const CROSS_RUN_MSG =
  'grep: recursive search across runs is disabled; ' +
  'target a specific run (e.g. /ci/runs/<run>/jobs)'

async function grepCommand(
  accessor: GitHubCIAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const recursive = opts.flags.r === true || opts.flags.R === true
  if (recursive && resolved.some((p) => isCrossRunRoot(p))) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(CROSS_RUN_MSG) })]
  }
  const stat = (p: PathSpec): Promise<FileStat> => ciStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    ciReaddir(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    ciStream(accessor, p, opts.index ?? undefined),
  )
}

export const GITHUB_CI_GREP = command({
  name: 'grep',
  resource: ResourceName.GITHUB_CI,
  spec: specOf('grep'),
  fn: grepCommand,
})
