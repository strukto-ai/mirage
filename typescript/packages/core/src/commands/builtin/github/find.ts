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
import { pathsScoped } from '../../../view/namespace_view.ts'
import { find as githubFind } from '../../../core/github/find.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { findGeneric } from '../generic/find.ts'
import { withCommandGuards, withPolicyGuard } from '../generic_bind/adapter.ts'
import { findWalk } from '../generic_bind/builders/find.ts'
import { resolveGlobOf, mountIo } from '../generic_bind/index.ts'
import { ensureTree } from '../../../core/github/tree.ts'

async function find(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  await ensureTree(accessor, opts.index ?? undefined, opts.mountPrefix ?? '')
  // The dispatcher hands a pattern over whole; the wrapper resolves it,
  // as python's does, before the walk names anything.
  const resolved = await resolveGlobOf(mountIo(opts))(accessor, paths, opts.index ?? undefined)
  // The native find classifies on the raw tree, so under hidden paths or a
  // path rule it would answer for entries the session cannot see; the walk
  // classifies through the guarded readdir/stat, the fork the factory
  // builder takes. A truncated tree names only some paths and is never
  // refetched, so it takes the same folder-by-folder walk.
  if (accessor.truncated || pathsScoped(opts.ns, resolved)) {
    return findWalk(
      withCommandGuards(withPolicyGuard(mountIo(opts))),
      accessor,
      resolved,
      texts,
      opts,
    )
  }
  return findGeneric(resolved, texts, opts, (root, options) => githubFind(accessor, root, options))
}

export const GITHUB_FIND = command({
  name: 'find',
  vfs: VFSName.GITHUB,
  spec: specOf('find'),
  fn: find,
})
