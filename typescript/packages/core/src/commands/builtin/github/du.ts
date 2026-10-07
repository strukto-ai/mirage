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

import { invocationIo } from '../generic_bind/factory.ts'

import type { GitHubAccessor } from '../../../accessor/github.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { pathsScoped } from '../../../ops/namespace_view.ts'
import type { NamespaceView } from '../../../ops/types.ts'
import { IO } from './io.ts'
import { ensureTree } from '../../../core/github/tree.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { DEFAULT_MAX_DU_ENTRIES, duGeneric } from '../generic/du.ts'
import { WalkBudget, walkEntries, walkSize } from '../generic_bind/builders/du.ts'
import type { DuEntries } from '../../../vfs/types.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

/**
 * Every blob and every directory at or under `path`, and the blobs' sum.
 *
 * Read off the git tree rather than the index: the tree is keyed
 * repo-relative, which is the space these comparisons are in, so both come
 * back mount-relative. A blob of unknown size counts 0, as the walked du
 * counts any file. A directory comes back on its own because one holding no
 * blob (only a submodule, which the tree drops) still gets du's 0 row.
 */
function subtree(accessor: GitHubAccessor, path: PathSpec): [DuEntries, string[]] {
  const key = stripSlash(path.vfsPath)
  const prefix = key === '' ? '' : `${key}/`
  const blobs: [string, number][] = []
  const directories: string[] = []
  let total = 0
  for (const [p, entry] of Object.entries(accessor.tree)) {
    if (p !== key && !p.startsWith(prefix)) continue
    if (entry.type === 'blob') {
      blobs.push([`/${p}`, entry.size ?? 0])
      total += entry.size ?? 0
    } else {
      directories.push(`/${p}`)
    }
  }
  blobs.sort((a, b) => compareCodePoints(a[0], b[0]))
  return [[blobs, total], directories]
}

/** Whether du walks the subtree through the command guards rather than
 * summing the tree it already holds: a truncated tree names only some paths,
 * and under a hide or a path rule the raw sum would count what the session
 * cannot see and never report a refused directory. Mirrors Python's
 * `_walked`. */
function walked(accessor: GitHubAccessor, ns: NamespaceView | undefined, path: PathSpec): boolean {
  return accessor.truncated || pathsScoped(ns, [path])
}

async function du(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  // Sizes come from accessor.tree, so the first callback brings it live,
  // after du has validated its flags: an invalid line must cost no fetch.
  // Once per line, so one du reads one tree.
  let probe: Promise<void> | undefined
  const live = (): Promise<void> => (probe ??= ensureTree(accessor, idx, opts.mountPrefix ?? ''))
  const budget = new WalkBudget(IO.maxDuEntries ?? DEFAULT_MAX_DU_ENTRIES)
  return duGeneric(
    paths,
    opts,
    async (targets) => {
      await live()
      return resolveGlobOf(invocationIo(IO, opts))(accessor, targets, idx)
    },
    async (p) => {
      await live()
      return IO.stat(accessor, p, idx)
    },
    // A truncated tree names only some paths and is never refetched, so it
    // is walked folder by folder, as a backend with no tree would be; so is
    // a subtree under a hide or a path rule (`walked`).
    async (p) => {
      await live()
      if (walked(accessor, opts.ns, p))
        return walkSize(invocationIo(IO, opts), accessor, idx, budget, p)
      return subtree(accessor, p)[0][1]
    },
    async (p) => {
      await live()
      if (walked(accessor, opts.ns, p))
        return walkEntries(invocationIo(IO, opts), accessor, idx, budget, p)
      const [entries, directories] = subtree(accessor, p)
      const mount = mountPrefixOf(p.virtual, p.vfsPath)
      budget.directories.push(...directories.map((d) => `${mount}${d}`))
      return entries
    },
    () => budget.hit,
    () => budget.unreadable,
    () => budget.directories,
  )
}

export const GITHUB_DU = command({
  name: 'du',
  vfs: VFSName.GITHUB,
  spec: specOf('du'),
  fn: du,
})
