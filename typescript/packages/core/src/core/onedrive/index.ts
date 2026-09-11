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

import type { OneDriveAccessor } from '../../accessor/onedrive.ts'
import {
  invalidateAfterUnlink,
  invalidateAfterWrite,
  invalidateAncestors,
  invalidateSubtree,
} from '../../cache/context.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { startBasename } from '../../commands/builtin/find_eval.ts'
import { record, startOp } from '../../observe/context.ts'
import type { FindOptions } from '../../resource/base.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent, enotempty } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { GraphError, graphDelete, graphGet } from '../msgraph/client.ts'
import {
  asNumber,
  copyTree,
  createChildFolder,
  driveRootEmpty,
  duTreeEntries,
  duTreeTotal,
  findItems,
  folderChildCount,
  makeExists,
  makeTruncate,
  readItem,
  readdirItems,
  renameReplace,
  statItem,
  streamItem,
  writeItem,
} from '../msgraph/drive.ts'

function directoryPath(path: PathSpec): PathSpec {
  return path.pattern !== null ? path.dir : path
}

function virtualKey(path: PathSpec): string {
  const target = directoryPath(path)
  const prefix = mountPrefixOf(target.virtual, target.resourcePath)
  return target.resourcePath !== ''
    ? `${prefix}/${target.resourcePath}`
    : prefix !== ''
      ? prefix
      : '/'
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: OneDrive accessor.
 *   path: the path to read.
 *   _index: unused; Graph resolves the item from the path itself.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: OneDriveAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  return readItem(
    accessor.config,
    accessor.loc(path.resourcePath),
    path.virtual,
    path.resourcePath,
    'onedrive',
    options?.offset ?? 0,
    options?.size ?? null,
  )
}

export async function* stream(
  accessor: OneDriveAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield* streamItem(
    accessor.config,
    accessor.loc(path.resourcePath),
    path.virtual,
    path.resourcePath,
    'onedrive',
  )
}

export async function readdir(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const target = directoryPath(path)
  const key = virtualKey(path)
  if (index !== undefined) {
    const cached = await index.listDir(key)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }
  const prefix = mountPrefixOf(target.virtual, target.resourcePath)
  return readdirItems(
    accessor.config,
    accessor.loc(target.resourcePath),
    index,
    prefix,
    target.resourcePath,
    key,
    target,
  )
}

export async function stat(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  if (path.resourcePath === '') {
    try {
      const item = await graphGet(accessor.config, accessor.loc('').item())
      // The root's `size` is Graph's aggregate subtree storage number, not
      // rendered content length: expose it as extra, like every other
      // folder (see entryStat).
      return new FileStat({
        name: '/',
        type: FileType.DIRECTORY,
        modified: typeof item.lastModifiedDateTime === 'string' ? item.lastModifiedDateTime : null,
        extra: { size_bytes: asNumber(item.size), child_count: folderChildCount(item) },
      })
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) throw enoent(path)
      throw error
    }
  }
  return statItem(accessor.config, accessor.loc(path.resourcePath), path, virtualKey(path), index)
}

export async function write(
  accessor: OneDriveAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const timer = startOp()
  await writeItem(accessor.config, accessor.loc(path.resourcePath), data)
  record('write', path.resourcePath, 'onedrive', data.length, timer)
  await invalidateAfterWrite(path)
}

export async function create(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  await write(accessor, path, new Uint8Array())
}

async function createDir(accessor: OneDriveAccessor, path: string): Promise<void> {
  const parent = parentPath(path)
  await createChildFolder(accessor.config, accessor.loc(parent).item('/children'), baseName(path))
}

export async function mkdir(
  accessor: OneDriveAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const key = path.resourcePath
  if (key === '') return
  if (parents) {
    const parts = key.split('/')
    for (let index = 1; index <= parts.length; index++) {
      await createDir(accessor, parts.slice(0, index).join('/'))
    }
  } else {
    await createDir(accessor, key)
  }
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}

export async function unlink(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  try {
    await graphDelete(accessor.config, accessor.loc(path.resourcePath).item())
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) throw enoent(path)
    throw error
  }
  await invalidateAfterUnlink(path)
}

export async function rmR(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  if (path.resourcePath === '') return
  await graphDelete(accessor.config, accessor.loc(path.resourcePath).item())
  await invalidateSubtree(path)
}

/**
 * Remove an empty folder.
 *
 * A Graph `DELETE /drives/{id}/items/{item}` removes a folder and
 * everything under it, so this is the same request `rmR` sends and the
 * emptiness check is the only thing separating them. Aliasing the two --
 * which this was -- destroyed the whole subtree for every caller that does
 * not pre-check emptiness itself, and the command builders are the only
 * callers that do: FUSE, `ws.fs` and the sandbox runtimes all reach the op
 * directly.
 */
export async function rmdir(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  if (path.resourcePath === '') return
  const loc = accessor.loc(path.resourcePath)
  if (!(await driveRootEmpty(accessor.config, loc))) throw enotempty(path)
  await graphDelete(accessor.config, loc.item())
  await invalidateAfterUnlink(path)
}

export const exists = makeExists<OneDriveAccessor>(stat)

export async function rename(
  accessor: OneDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  await renameReplace(
    accessor.config,
    accessor.loc(src.resourcePath),
    accessor.loc(dst.resourcePath),
  )
  await invalidateSubtree(dst)
  await invalidateSubtree(src)
}

export async function copy(
  accessor: OneDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  await copyTree(accessor.config, accessor.loc(src.resourcePath), accessor.loc(dst.resourcePath))
  await invalidateAfterWrite(dst)
}

export const truncate = makeTruncate<OneDriveAccessor>(read, write)

export async function du(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<number> {
  try {
    const info = await stat(accessor, path, index)
    if (info.type !== FileType.DIRECTORY) return info.size ?? 0
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  return duTreeTotal(accessor.config, accessor.loc(path.resourcePath))
}

export async function duEntries(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<[[string, number][], number]> {
  try {
    const info = await stat(accessor, path, index)
    if (info.type !== FileType.DIRECTORY) return [[], info.size ?? 0]
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  return duTreeEntries(accessor.config, accessor.loc(path.resourcePath))
}

export async function find(
  accessor: OneDriveAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  return findItems(
    accessor.config,
    accessor.loc(path.resourcePath),
    startBasename(path.virtual),
    async () => (await stat(accessor, path)).type === FileType.DIRECTORY,
    options,
  )
}
