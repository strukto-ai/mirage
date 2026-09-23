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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { readTree } from './readdir.ts'
import type { Accessor } from '../../accessor/base.ts'
import { buildTree, emitStartPath, keep, startBasename } from '../../commands/builtin/find_eval.ts'
import type { FindOptions } from '../../vfs/base.ts'
import type { PathSpec } from '../../types.ts'
import * as kp from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { FindHints, ObjectStoreDriver } from './driver.ts'

export type FindFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  options?: FindOptions,
  index?: IndexCacheStore,
) => Promise<string[]>

/** Build the recursive predicate walk over one driver. */
export function makeFind<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): FindFn<A> {
  return async function find(accessor, path, options = {}, index) {
    const startName = startBasename(path.virtual)
    const kpfx = driver.keyPrefixOf(accessor)
    const pfx = kp.applyDir(kpfx, path.mountPath)
    const rootKey = rstripSlash('/' + kp.strip(kpfx, pfx)) || '/'
    const baseDepth = rootKey === '/' ? 0 : (rootKey.match(/\//g) ?? []).length
    const results: string[] = []
    const seenDirs = new Set<string>()
    const seen = { descendant: false, marker: false }
    const empty = options.empty === true
    // Narrowing beyond the prefix is only sound when directories cannot
    // appear in the output (-type f): implicit directories are synthesized
    // client-side from key paths, so any server-side file exclusion would
    // also drop the evidence for a matching parent directory.
    const pushdown =
      options.tree === undefined &&
      options.nameExclude === undefined &&
      options.orNames === undefined &&
      options.pathPattern === undefined &&
      !empty &&
      options.type === 'f'
    const tree =
      options.tree ??
      buildTree({
        name: options.name,
        iname: options.iname,
        pathPattern: options.pathPattern,
        type: options.type,
        nameExclude: options.nameExclude,
        orNames: options.orNames,
        empty: options.empty,
      })
    const hints: FindHints = {
      name: options.name ?? null,
      iname: options.iname ?? null,
      type: options.type ?? null,
      minSize: options.minSize ?? null,
      maxSize: options.maxSize ?? null,
      pushdown,
    }
    const [rows, exists] = await readTree(driver, accessor, path, index, hints)
    seen.descendant = exists
    for (const treeEntry of rows) {
      const key = treeEntry.key
      if (key === pfx) {
        seen.marker = true
        continue
      }
      seen.descendant = true
      const isDir = key.endsWith('/')
      const normKey = isDir ? key.slice(0, -1) : key
      const fullPath = '/' + kp.strip(kpfx, normKey)
      const size = treeEntry.size ?? 0
      if (isDir) {
        if (seenDirs.has(fullPath)) continue
        seenDirs.add(fullPath)
      }
      const entries: [string, 'f' | 'd'][] = [[fullPath, isDir ? 'd' : 'f']]
      // Implicit directories exist only as key prefixes; synthesize the
      // parent chain so find agrees with readdir on externally-populated
      // buckets.
      let parent = fullPath.slice(0, fullPath.lastIndexOf('/')) || '/'
      while (parent !== rootKey && parent !== '/') {
        if (!seenDirs.has(parent)) {
          seenDirs.add(parent)
          entries.push([parent, 'd'])
        }
        parent = parent.slice(0, parent.lastIndexOf('/')) || '/'
      }
      for (const [ep, kind] of entries) {
        const entryName = ep.split('/').pop() ?? ''
        const depth = (ep.match(/\//g) ?? []).length - baseDepth
        if (
          options.maxDepth !== null &&
          options.maxDepth !== undefined &&
          depth > options.maxDepth
        ) {
          continue
        }
        const isEmpty = !empty ? null : kind === 'd' ? false : size === 0
        if (!keep({ key: ep, name: entryName, kind, depth, isEmpty }, tree, options.minDepth)) {
          continue
        }
        if (options.minSize != null || options.maxSize != null) {
          // Directories count as size 0 for -size (deliberate GNU divergence).
          const effective = kind === 'd' ? 0 : size
          if (options.minSize != null && effective < options.minSize) continue
          if (options.maxSize != null && effective > options.maxSize) continue
        }
        results.push(ep)
      }
    }
    if (seen.descendant || seen.marker) {
      emitStartPath(results, rootKey, startName, {
        kind: 'd',
        isEmpty: empty ? !seen.descendant : null,
        exists: true,
        tree,
        maxDepth: options.maxDepth,
        minDepth: options.minDepth,
        minSize: options.minSize,
        maxSize: options.maxSize,
      })
    }
    // A file key and a synthesized directory can name the same path
    // (`data/a` alongside `data/a/b.txt`), which these stores allow and a
    // filesystem does not; find prints such a path once.
    return [...new Set(results)].sort(compareCodePoints)
  }
}
