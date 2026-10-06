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

import { mountKey, mountPrefixOf, mountedPath } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'
import { PathSpec } from '../../types.ts'
import { eexist, enoent, enotdir } from '../../errors/fs.ts'
import { createFolder, listFolderItems } from './api.ts'
import { BoxApiError } from './client.ts'
import { pathParts, resolveChain } from './resolve.ts'

async function invalidateLevels(path: PathSpec, count: number): Promise<void> {
  // `mkdir -p a/b/c` creates several levels; invalidate each one's parent
  // listing (not just the final target's) so a cached ancestor listing from
  // an earlier command re-fetches and sees the new folders. Box resolves ids
  // through those listings, so a stale ancestor hides new children.
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const segments = rstripVirtual(path.virtual).split('/')
  for (let i = 0; i < count; i++) {
    const depth = segments.length - count + i + 1
    const levelVirtual = segments.slice(0, depth).join('/') || '/'
    await invalidateAfterWrite(PathSpec.fromStrPath(levelVirtual, mountKey(levelVirtual, prefix)))
  }
}

export function rstripVirtual(virtual: string): string {
  let end = virtual.length
  while (end > 1 && virtual.charCodeAt(end - 1) === 47) end--
  return virtual.slice(0, end)
}

export async function mkdir(accessor: BoxAccessor, path: PathSpec, parents = false): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) return
  const tm = accessor.tokenManager
  if (parents) {
    let curId = accessor.rootFolderId
    for (const [i, name] of parts.entries()) {
      const children = await listFolderItems(tm, curId)
      const match = children.find((c) => c.name === name)
      if (match !== undefined) {
        if (match.type !== 'folder') {
          // `mkdir -p` passes only a directory at the operand and names the
          // file it stops at above it, as GNU does.
          if (i === parts.length - 1) throw eexist(path)
          throw enotdir(mountedPath(path, `/${parts.slice(0, i + 1).join('/')}`))
        }
        curId = match.id
      } else {
        const created = await createFolder(tm, curId, name)
        curId = created.id
      }
    }
    await invalidateLevels(path, parts.length)
  } else {
    const chain = await resolveChain(accessor, parts.slice(0, -1))
    // A level that resolved but is a file is ENOTDIR, the parent itself
    // included; one that is not there at all is ENOENT, as mkdir(2) tells
    // them apart.
    const last = chain[chain.length - 1]
    if (last !== undefined && last.type !== 'folder') throw enotdir(path.virtual)
    if (chain.length < parts.length - 1) throw enoent(path.virtual)
    const parentId = last?.id ?? accessor.rootFolderId
    // Box 409s a name already taken, by a file or a folder: EEXIST, named
    // here because BoxApiError carries no errno.
    try {
      await createFolder(tm, parentId, parts[parts.length - 1] ?? '')
    } catch (error) {
      if (error instanceof BoxApiError && error.status === 409) throw eexist(path)
      throw error
    }
    await invalidateAfterWrite(path)
  }
}
