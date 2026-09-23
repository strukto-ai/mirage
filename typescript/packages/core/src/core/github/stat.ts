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
import type { GitHubAccessor } from '../../accessor/github.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdirUnlocked as coreReaddir } from './readdir.ts'
import { withIndexLock } from '../../cache/index/lock.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { enoent, isEnoent } from '../../utils/errors.ts'

function stripPrefix(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return p
}

export async function stat(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const p = stripPrefix(path)
  const trimmed = stripSlash(p)
  if (trimmed === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }
  if (index === undefined) throw enoent(path)
  const ikey = `${rstripSlash(prefix)}/${trimmed}`
  return withIndexLock(index, rstripSlash(prefix) || '/', async () => {
    // Entries survive invalidation and replacement listings. Only the
    // parent's current listing establishes freshness and membership.
    const parentPath = ikey.slice(0, ikey.lastIndexOf('/')) || '/'
    let children: string[]
    try {
      children = await coreReaddir(
        accessor,
        new PathSpec({
          virtual: parentPath,
          directory: parentPath,
          resolved: false,
          vfsPath: mountKey(parentPath, prefix),
        }),
        index,
      )
    } catch (error) {
      if (isEnoent(error)) throw enoent(path)
      throw error
    }
    if (!children.includes(ikey)) throw enoent(path)
    const result = await index.get(ikey)
    if (result.entry === undefined || result.entry === null) throw enoent(path)
    if (result.entry.resourceType === 'folder') {
      return new FileStat({ name: result.entry.name, type: FileType.DIRECTORY })
    }
    return new FileStat({
      name: result.entry.name,
      size: result.entry.size,
      type: FileType.FILE,
      content: contentTypeForPath(result.entry.name),
      fingerprint: result.entry.id,
      extra: { sha: result.entry.id },
    })
  })
}
