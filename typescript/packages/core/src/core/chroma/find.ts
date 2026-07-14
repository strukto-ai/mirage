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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { PathSpec } from '../../types.ts'
import {
  buildTree,
  type FindEntry,
  keep,
  type PredNode,
  startBasename,
  treeHasType,
} from '../../commands/builtin/findEval.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../utils/slash.ts'
import { modifiedTs } from '../generic/find.ts'
import { resolvePath } from './path.ts'
import { stat } from './stat.ts'
import { walk } from './walk.ts'

function relativeDepth(item: string, root: string): number {
  const rootNorm = rstripSlash(root) !== '' ? rstripSlash(root) : '/'
  const itemNorm = rstripSlash(item) !== '' ? rstripSlash(item) : '/'
  if (itemNorm === rootNorm) return 0
  let relative: string
  if (rootNorm === '/') {
    relative = stripSlash(itemNorm)
  } else {
    relative = itemNorm.startsWith(rootNorm) ? itemNorm.slice(rootNorm.length) : itemNorm
    relative = lstripSlash(relative)
  }
  if (relative === '') return 0
  return relative.split('/').length
}

async function matches(
  accessor: ChromaAccessor,
  item: string,
  prefix: string,
  index: IndexCacheStore | undefined,
  root: string,
  options: FindOptions,
  tree: PredNode,
  needsKind: boolean,
  startName: string,
): Promise<boolean> {
  const rootNorm = rstripSlash(root) !== '' ? rstripSlash(root) : '/'
  const itemNorm = rstripSlash(item) !== '' ? rstripSlash(item) : '/'
  const itemName = itemNorm === rootNorm ? startName : (rstripSlash(item).split('/').pop() ?? '')
  const spec = PathSpec.fromStrPath(item, mountKey(item, prefix))
  let kind: 'd' | 'f' = 'f'
  if (needsKind) {
    const resolved = await resolvePath(accessor, spec, index)
    kind = resolved.isDir ? 'd' : 'f'
  }
  const entry: FindEntry = {
    key: item,
    name: itemName,
    kind,
    depth: relativeDepth(item, root),
  }
  if (!keep(entry, tree, options.minDepth)) return false
  // Directories count as size 0 for -size (deliberate GNU divergence).
  if (options.minSize != null || options.maxSize != null) {
    let size = 0
    if (kind === 'f') {
      const itemStat = await stat(accessor, spec, index)
      // Sizeless rendered files count as size 0, same as dirs and the FUSE
      // view (CLAUDE.md find -size rules); never drop them.
      size = itemStat.size ?? 0
    }
    if (options.minSize != null && size < options.minSize) return false
    if (options.maxSize != null && size > options.maxSize) return false
  }
  if (options.mtimeMin != null || options.mtimeMax != null) {
    const itemStat = await stat(accessor, spec, index)
    const modTs = modifiedTs(itemStat.modified)
    if (modTs === null) return false
    if (options.mtimeMin != null && modTs < options.mtimeMin) return false
    if (options.mtimeMax != null && modTs > options.mtimeMax) return false
  }
  return true
}

export async function find(
  accessor: ChromaAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  if (index === undefined) {
    throw new Error('find: missing index')
  }
  const results = await walk(accessor, path, index, {
    includeRoot: true,
    maxDepth: options.maxDepth ?? null,
    stripPrefix: true,
  })
  const tree =
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: options.type,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
    })
  const needsKind = treeHasType(tree) || options.minSize != null || options.maxSize != null
  const startName = startBasename(path.virtual)
  const filtered: string[] = []
  for (const item of results) {
    if (
      await matches(
        accessor,
        item,
        mountPrefixOf(path.virtual, path.resourcePath),
        index,
        path.mountPath,
        options,
        tree,
        needsKind,
        startName,
      )
    ) {
      filtered.push(item)
    }
  }
  return filtered.sort()
}
