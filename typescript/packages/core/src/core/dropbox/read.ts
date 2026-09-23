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
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { PathSpec } from '../../types.ts'
import { DropboxApiError, dropboxDownload, dropboxDownloadStream } from './client.ts'
import { readdir } from './readdir.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { windowFor } from '../../utils/ranges.ts'

function dropboxPathFromVirtual(root: string, virtualKey: string, prefix: string): string {
  let key = virtualKey
  if (prefix !== '' && key.startsWith(prefix)) key = key.slice(prefix.length)
  key = stripSlash(key)
  return key === '' ? root : `${root}/${key}`
}

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: Dropbox accessor.
 *   path: the path to read.
 *   index: listing cache, consulted for the entry.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: DropboxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const window = windowFor(options?.offset ?? 0, options?.size ?? null)
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  if (key === '') throw eisdir(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`

  const dropboxPath = dropboxPathFromVirtual(accessor.rootPath, virtualKey, prefix)
  if (index === undefined) {
    // Index-less callers (the ops factory's emulated truncate) download
    // directly; the API 409s on missing paths and folders.
    try {
      return await dropboxDownload(accessor.tokenManager, dropboxPath, window)
    } catch (err) {
      if (err instanceof DropboxApiError && err.status === 409) throw enoent(path.virtual)
      throw err
    }
  }
  const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  const entry = await entryOrWarm(
    index,
    virtualKey,
    parentKey !== virtualKey
      ? () => readdir(accessor, PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)), index)
      : null,
  )
  if (entry === null) throw enoent(path.virtual)
  if (entry.resourceType === 'dropbox/folder') throw eisdir(path.virtual)
  return dropboxDownload(accessor.tokenManager, dropboxPath, window)
}

export async function* stream(
  accessor: DropboxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  if (key === '') throw eisdir(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`

  const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  const entry =
    index === undefined
      ? null
      : await entryOrWarm(
          index,
          virtualKey,
          parentKey !== virtualKey
            ? () =>
                readdir(
                  accessor,
                  PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)),
                  index,
                )
            : null,
        )
  if (entry === null) throw enoent(path.virtual)
  if (entry.resourceType === 'dropbox/folder') throw eisdir(path.virtual)
  const dropboxPath = dropboxPathFromVirtual(accessor.rootPath, virtualKey, prefix)
  for await (const chunk of dropboxDownloadStream(accessor.tokenManager, dropboxPath)) {
    yield chunk
  }
}
