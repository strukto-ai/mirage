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
import { size as githubDu, entries as githubDuAll } from '../../../core/github/du/index.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GITHUB_IO } from './io.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { IOResult } from '../../../io/types.ts'
import { runDu } from '../generic/du.ts'

const resolveGlob = resolveGlobOf(GITHUB_IO)

async function duCommand(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  const out = await runDu(
    paths,
    opts,
    (targets) => resolveGlob(accessor, targets, idx),
    (p) => GITHUB_IO.stat(accessor, p, idx),
    (p) => githubDu(accessor, p, idx),
    (p) => githubDuAll(accessor, p, idx),
  )
  return [out.stdout, new IOResult({ stderr: out.stderr, exitCode: out.exitCode })]
}

export const GITHUB_DU = command({
  name: 'du',
  resource: ResourceName.GITHUB,
  spec: specOf('du'),
  fn: duCommand,
})
