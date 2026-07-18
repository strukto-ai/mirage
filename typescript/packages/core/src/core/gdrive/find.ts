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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { buildTree, emitStartPath, keep, startBasename } from '../../commands/builtin/findEval.ts'
import type { FindOptions } from '../../resource/base.ts'
import type { PathSpec } from '../../types.ts'
import { isFolder, resolveKey } from './resolve.ts'
import { iterTree } from './tree.ts'

async function dirExists(accessor: GDriveAccessor, path: PathSpec): Promise<boolean> {
  if (path.resourcePath === '') return true
  const node = await resolveKey(accessor, path.resourcePath)
  return node !== null && isFolder(node)
}

// find over a Drive subtree, mirroring the python core find. -mtime is a
// deliberate no-op on remote drive backends (accepted and ignored),
// matching onedrive/sharepoint.
export async function find(
  accessor: GDriveAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const base = path.resourcePath
  const startName = startBasename(path.virtual)
  const results: string[] = []
  let sawDescendant = false
  const empty = options.empty === true
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
  try {
    for await (const [rel, item, isDir] of iterTree(accessor, path)) {
      const relative = base !== '' ? rel.slice(base.length).replace(/^\//, '') : rel
      const depth = (relative.match(/\//g) ?? []).length + 1
      if (options.maxDepth !== null && options.maxDepth !== undefined && depth > options.maxDepth) {
        continue
      }
      sawDescendant = true
      const entryName = rel.split('/').pop() ?? ''
      const fullPath = '/' + rel
      const size = parseInt(item.size ?? '0', 10)
      const isEmpty = !empty ? null : isDir ? false : size === 0
      if (
        !keep(
          { key: fullPath, name: entryName, kind: isDir ? 'd' : 'f', depth, isEmpty },
          tree,
          options.minDepth,
        )
      ) {
        continue
      }
      if (options.minSize != null || options.maxSize != null) {
        // Directories count as size 0 for -size (deliberate GNU divergence).
        const effective = isDir ? 0 : size
        if (options.minSize != null && effective < options.minSize) continue
        if (options.maxSize != null && effective > options.maxSize) continue
      }
      results.push(fullPath)
    }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    sawDescendant = false
  }
  const exists = sawDescendant || (await dirExists(accessor, path))
  if (exists) {
    const rootKey = base !== '' ? '/' + base : '/'
    emitStartPath(results, rootKey, startName, {
      kind: 'd',
      isEmpty: empty ? false : null,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
      minSize: options.minSize,
      maxSize: options.maxSize,
    })
  }
  return results.sort()
}
