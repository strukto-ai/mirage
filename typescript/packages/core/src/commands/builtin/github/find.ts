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
import { find as githubFind } from '../../../core/github/find.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { findGeneric } from '../generic/find.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { metadataProvision } from './_provision.ts'
import { GITHUB_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GITHUB_IO)

async function findCommand(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  // The dispatcher hands a pattern over whole; the wrapper resolves it,
  // as python's does, before the walk names anything.
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  return findGeneric(resolved, texts, opts, (root, options) => githubFind(accessor, root, options))
}

export const GITHUB_FIND = command({
  name: 'find',
  resource: ResourceName.GITHUB,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
