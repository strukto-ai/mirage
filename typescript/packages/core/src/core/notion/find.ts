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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { type FileStat, FileType, PathSpec } from '../../types.ts'
import type { NotionStatAccessor } from './stat.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import { stripSlash } from '../../utils/slash.ts'
import { buildTree, keep, startBasename } from '../../commands/builtin/findEval.ts'

async function collect(
  accessor: NotionStatAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  out: [string, FileStat][],
): Promise<void> {
  const fileStat = await stat(accessor, path, index)
  out.push([path.virtual, fileStat])
  if (fileStat.type !== FileType.DIRECTORY) return
  for (const entry of await readdir(accessor, path, index)) {
    const child = new PathSpec({
      virtual: entry,
      directory: entry,
      resolved: false,
      resourcePath: mountKey(entry, mountPrefixOf(path.virtual, path.resourcePath)),
    })
    await collect(accessor, child, index, out)
  }
}

export async function find(
  accessor: NotionStatAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  const startName = startBasename(path.virtual)
  const stripped = stripSlash(path.mountPath)
  const base = stripped !== '' ? `/${stripped}` : '/'
  const baseDepth = base === '/' ? 0 : (base.match(/\//g) ?? []).length
  const collected: [string, FileStat][] = []
  await collect(accessor, path, index, collected)
  const results: string[] = []
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
  for (const [entryPath, fileStat] of collected) {
    let rel = entryPath
    if (
      mountPrefixOf(path.virtual, path.resourcePath) !== '' &&
      rel.startsWith(mountPrefixOf(path.virtual, path.resourcePath))
    ) {
      rel = rel.slice(mountPrefixOf(path.virtual, path.resourcePath).length) || '/'
    }
    const relStripped = stripSlash(rel)
    rel = relStripped !== '' ? `/${relStripped}` : '/'
    const isDir = fileStat.type === FileType.DIRECTORY
    const entryName = rel === base ? startName : (rel.split('/').pop() ?? rel)
    const depth = rel === base ? 0 : (rel.match(/\//g) ?? []).length - baseDepth
    if (options.maxDepth !== undefined && options.maxDepth !== null && depth > options.maxDepth) {
      continue
    }
    if (
      !keep({ key: rel, name: entryName, kind: isDir ? 'd' : 'f', depth }, tree, options.minDepth)
    ) {
      continue
    }
    if (options.minSize != null || options.maxSize != null) {
      // Directories count as size 0 for -size (deliberate GNU divergence).
      const size = isDir ? 0 : (fileStat.size ?? 0)
      if (options.minSize != null && size < options.minSize) continue
      if (options.maxSize != null && size > options.maxSize) continue
    }
    results.push(rel)
  }
  return results.sort()
}
